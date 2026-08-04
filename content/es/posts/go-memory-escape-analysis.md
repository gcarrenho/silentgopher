---
title: "Gestión de Memoria en Go: El Viaje al Ensamblador y el Escape Analysis"
subtitle: "Stack, Heap y Escape Analysis"
date: 2026-08-04
author: "@SilentGopher"
description: "Un recorrido práctico por Stack vs Heap en Go, cómo funciona Escape Analysis, cómo inspeccionar decisiones del compilador con -gcflags='-m' y cómo conectarlas con el ensamblador generado."
image: "/images/posts/go-memory-escape-analysis/memoryManagement.jpg"
tags: ["Go", "Go Runtime", "Compiler", "Performance", "Escape Analysis", "Assembly"]
draft: false
---

> Dos funciones casi idénticas pueden producir comportamientos de memoria muy distintos en Go. La diferencia, muchas veces, no está en lo que escribiste, sino en lo que el compilador puede probar.

<!--more-->

Cuando en una code review alguien dice "esto se fue al heap", suele describir el síntoma, no el mecanismo.

El mecanismo se llama **Escape Analysis**.

El compilador de Go está evaluando continuamente una pregunta concreta: ¿este valor puede vivir dentro del frame actual del stack, o necesita sobrevivir más allá de la función que lo creó? Si no puede demostrar seguridad en stack, lo promueve al heap.

Este artículo está planteado como laboratorio guiado. Vamos a:

1. construir un modelo mental correcto de stack vs heap en Go,
2. inspeccionar decisiones reales del compilador con `-gcflags="-m"`,
3. leer el ensamblador justo lo necesario para conectar causa y efecto,
4. medir impacto con benchmarks,
5. y cerrar con reglas prácticas para código de producción.

> **Nota de serie:** esta es la Parte 1 de una serie de tres artículos sobre internals de Go. La Parte 2 cubre el scheduler GMP y la Parte 3 cubre interfaces, tablas de métodos y de-virtualización.

---

## Stack vs Heap en Go: el modelo que realmente importa

Cada goroutine tiene su propio stack. Ese stack contiene parámetros, variables locales, temporales y metadata de ejecución.

El punto importante no es repetir "stack rápido, heap lento". Esa explicación es demasiado superficial.

El punto central es **lifetime**.

- Un valor puede quedarse en stack si su vida útil está acotada, de forma demostrable, al frame actual.
- Un valor debe ir al heap si puede sobrevivir ese frame, o si el compilador no puede demostrar que no lo hará.

¿Por qué importa cuándo algo va al heap?

Porque puede implicar:

- más presión sobre el garbage collector,
- peor localidad de memoria,
- más indirección,
- y más `allocs/op` en rutas calientes.

Ahora, hay una trampa común: no toda asignación en heap es un bug. Si perseguís "cero escapes" sin medir, podés terminar reemplazando código claro por código frágil sin ganancia real.

La pregunta correcta no es "¿cómo evito todo escape?" La pregunta correcta es: **¿qué escapes son materialmente costosos en este workload?**

---

## Qué hace realmente Escape Analysis

Escape Analysis es un análisis estático y conservador del compilador.

Conservador significa que el compilador no necesita probar que un valor escapará. Le alcanza con no poder probar que es seguro mantenerlo en stack.

Ese detalle explica gran parte de los resultados que parecen "sorprendentes".

Regla mental útil:

1. Si el compilador puede razonar completamente sobre el lifetime de un valor, puede dejarlo en stack.
2. Si el valor se retorna por referencia, se captura, se comparte, se boxea o cruza un contexto de lifetime incierto, es candidato a heap.
3. Si falta evidencia, el compilador prioriza corrección semántica por encima del optimismo.

Por eso Escape Analysis está íntimamente ligado a inlining, conversiones a interfaz, closures y fronteras de goroutine.

---

## Primer experimento: retornar por valor vs retornar puntero

Arranquemos con el ejemplo mínimo útil.

```go
package main

type user struct {
	id   int
	name string
}

func buildUserValue(id int, name string) user {
	u := user{id: id, name: name}
	return u
}

func buildUserPointer(id int, name string) *user {
	u := user{id: id, name: name}
	return &u
}

func main() {
	_ = buildUserValue(1, "gopher")
	_ = buildUserPointer(2, "runtime")
}
```

Compilá con:

```bash
go build -gcflags="-m" main.go
```

Luego con más detalle:

```bash
go build -gcflags="-m -m" main.go
```

Qué deberías esperar conceptualmente:

- el retorno por valor en `buildUserValue` puede mantenerse stack-friendly,
- el `u` local de `buildUserPointer` necesita sobrevivir al frame porque se retorna su dirección,
- por eso el compilador reporta que `u` se mueve al heap.

Primera lección importante: en Go, devolver `*T` no es solo una decisión de API. Muchas veces es una declaración de lifetime.

---

## Cómo leer `-gcflags="-m"` sin autoengañarte

El reporte de escape es valioso, pero se malinterpreta seguido.

Mensajes típicos:

- `moved to heap: x`
- `x escapes to heap`
- `does not escape`
- `can inline ...`

El último importa mucho: Escape Analysis e inlining interactúan. Si una función se inlinea, el compilador gana contexto y eso puede cambiar el resultado.

Por eso conviene comparar ambas vistas:

```bash
go build -gcflags="-m" main.go
go build -gcflags="-m -l" main.go
```

La flag `-l` desactiva inlining. Si cambia el diagnóstico, no es ruido: es el compilador diciéndote que cambió la prueba.

---

## Closures: estado que sobrevive a la función

Veamos una captura clásica.

```go
package main

func counter() func() int {
	n := 0
	return func() int {
		n++
		return n
	}
}

func main() {
	next := counter()
	_, _ = next(), next()
}
```

Inspeccioná con:

```bash
go build -gcflags="-m -m" main.go
```

¿Por qué `n` suele escapar acá?

Porque la closure retornada sigue usando `n` después de que `counter` terminó. Esa variable ya no pertenece solo al bloque léxico donde nació; pertenece a un entorno con vida más larga.

Cuando retornás closures, la pregunta clave no es "¿creé un function value?". La pregunta clave es: **¿qué estado capturó y cuánto tiempo debe vivir ese estado?**

---

## Conversiones a interfaz y presión oculta de asignaciones

Las interfaces son otra fuente típica de confusión.

Considerá:

```go
package main

import "fmt"

type point struct {
	x int
	y int
}

func printAny(v any) {
	fmt.Println(v)
}

func main() {
	p := point{x: 10, y: 20}
	printAny(p)
}
```

Ahora inspeccioná:

```bash
go build -gcflags="-m -m" main.go
```

Matiz importante: no toda conversión a interfaz implica heap allocation. Pero la conversión a interfaz es un punto donde el compilador puede necesitar boxing o preservación distinta del valor.

Por eso `fmt.Println` puede distorsionar microbenchmarks. No solo imprime: también fuerza conversión a `...any`.

Si benchmarkeás una función sensible a asignaciones y metés prints adentro, podés terminar midiendo otra cosa.

---

## Cruce de fronteras de goroutine

Un puntero que se entrega a otra goroutine es otra señal fuerte de lifetime extendido.

```go
package main

func worker(data *int) {
	_ = *data
}

func main() {
	n := 42
	go worker(&n)
}
```

Desde la perspectiva del compilador, una vez que `&n` cruza hacia otra goroutine, ya no está claramente confinado al frame actual. Puede ser leído luego de que el flujo local avance.

Esto no significa que todo escape vinculado a concurrencia sea evitable. Significa que concurrencia cambia ownership y lifetime, y el compilador actúa en consecuencia.

---

## Vista en ensamblador: buscar `runtime.newobject`

El diagnóstico textual es útil. El ensamblador te muestra la consecuencia material.

Generalo con:

```bash
go build -gcflags="-S" main.go
```

o con:

```bash
go tool compile -S main.go
```

No hace falta dominar ensamblador para sacar valor. Empezá por buscar:

1. tamaño del frame,
2. tomas de dirección,
3. llamadas al runtime,
4. aparición de `CALL runtime.newobject(SB)`.

Cuando un valor local migra al heap, `runtime.newobject` suele aparecer como señal clara.

En el caso de retorno por puntero, la forma del código generado suele parecerse más a "alocar objeto, inicializar campos, retornar puntero" que a "reservar slot en stack y copiar valor de retorno".

---

## Inlining cambia la prueba

Escape Analysis no vive aislado. Se beneficia del contexto que inlining aporta.

Ejemplo:

```go
package main

type pair struct {
	a int
	b int
}

func makePair(a, b int) pair {
	return pair{a: a, b: b}
}

func sum() int {
	p := makePair(10, 20)
	return p.a + p.b
}

func main() {
	_ = sum()
}
```

Compará:

```bash
go build -gcflags="-m" main.go
go build -gcflags="-m -l" main.go
```

Cuando la helper se inlinea, el compilador puede razonar sobre construcción y uso en el mismo contexto. Sin inlining, la prueba puede volverse más conservadora.

No siempre cambia stack vs heap, pero cuando cambia, deja una lección clave: los límites de abstracción afectan lo que el compilador puede demostrar.

---

## Medí, no adivines

El último paso es transformar teoría en números.

Creá `main_test.go` con:

```go
package main

import "testing"

func BenchmarkBuildUserValue(b *testing.B) {
	for i := 0; i < b.N; i++ {
		_ = buildUserValue(i, "gopher")
	}
}

func BenchmarkBuildUserPointer(b *testing.B) {
	for i := 0; i < b.N; i++ {
		_ = buildUserPointer(i, "gopher")
	}
}
```

Ejecutá:

```bash
go test -bench=. -benchmem
```

Importa más la forma del resultado que un nanosegundo exacto:

- `ns/op`
- `B/op`
- `allocs/op`

Si la versión con puntero asigna más en una ruta caliente, ahí hay evidencia accionable.

Si la diferencia es irrelevante para tu workload, probablemente la mejor optimización sea mantener la API más clara.

---

## Heurísticas prácticas para producción

Cuando encontrás asignaciones sospechosas en Go, seguí este orden:

1. perfilá o benchmarkeá primero,
2. identificá la ruta caliente,
3. inspeccioná con `-gcflags="-m -m"`,
4. compará con y sin inlining (`-l`),
5. bajá a ensamblador solo en el núcleo crítico,
6. cambiá código solo si el costo medido justifica la pérdida de claridad.

Errores comunes:

1. tratar toda asignación en heap como bug,
2. ignorar impacto de interfaces y closures en benchmarks,
3. leer output del compilador sin considerar inlining.

---

## Especificación de ilustraciones

### 1. Pipeline de lifetime de variable

Diagrama de flujo de izquierda a derecha:

- código fuente Go,
- frontend del compilador,
- SSA / representación intermedia,
- decisión de escape,
- colocación stack o heap,
- ensamblador generado.

Nodo central en rombo: "¿el compilador puede probar que el valor muere en el frame actual?".

### 2. Stack frame vs objeto en heap

Mostrar stack de una goroutine con tres frames. Resaltar frame actual y una variable local. Dibujar un puntero que escapa hacia un objeto en heap, etiquetando lifetime acotado vs lifetime extendido.

### 3. Retorno por valor vs retorno por puntero

Comparativa en dos columnas:

- izquierda: struct local retornado por valor,
- derecha: struct local cuya dirección se retorna y se promueve al heap.

Bajo cada columna, un fragmento pseudo-assembly; en la derecha, destacar `runtime.newobject`.

### 4. Mapa de triggers de escape

Mapa radial con cinco nodos:

- puntero retornado,
- captura por closure,
- boxing por interfaz,
- handoff a goroutine,
- callee con lifetime incierto.

Cada nodo con una línea de explicación.

### 5. Efecto del inlining sobre el análisis

Visual en dos pistas:

- sin inlining: menor contexto, prueba más conservadora,
- con inlining: mayor contexto, prueba más fuerte.

Énfasis visual en "visibilidad del compilador", no en velocidad.

---

## Cierre

Escape Analysis no es un set de trucos para "ganarle" al compilador. Es un modelo para razonar sobre lifetime.

Cuando entendés ese modelo, el heap deja de ser magia: podés inspeccionarlo, explicarlo y decidir si importa.

En la Parte 2 cambiamos de pregunta. Dejamos de mirar dónde viven los datos y pasamos a cómo el runtime decide quién ejecuta trabajo en Go: el scheduler GMP.
---
title: "Gestión de Memoria en Go: El Viaje al Ensamblador y el Escape Analysis"
subtitle: "Stack, Heap y Escape Analysis"
date: 2026-06-13
author: "@SilentGopher"
description: "Un recorrido práctico por stack vs heap en Go, cómo funciona escape analysis, cómo inspeccionar decisiones del compilador con -gcflags='-m' y cómo conectarlas con el ensamblador generado."
tags: ["Go", "Go Runtime", "Compiler", "Performance", "Escape Analysis", "Assembly"]
draft: false
---

> Dos funciones que se ven casi iguales pueden producir comportamientos de memoria muy distintos en Go. La diferencia muchas veces no está en lo que escribiste, sino en lo que el compilador puede demostrar.

<!--more-->

Cuando alguien dice que un valor "se fue al heap", normalmente está describiendo el síntoma, no el mecanismo.

El mecanismo es **escape analysis**.

El compilador de Go está haciendo una pregunta muy precisa de forma constante: ¿este valor puede vivir dentro del lifetime del frame actual, o necesita sobrevivir a la función que lo creó? Si no puede probar que el stack es seguro, promueve el valor al heap.

Este artículo está pensado como un laboratorio guiado. Vamos a:

1. construir un modelo mental sólido de stack vs heap en Go,
2. inspeccionar decisiones reales del compilador con `-gcflags="-m"`,
3. leer el ensamblador justo lo suficiente para conectar causa y efecto,
4. medir el impacto con benchmarks,
5. y cerrar con reglas prácticas para producción.

> **Nota de serie:** esta es la Parte 1 de una serie de tres artículos sobre internos de Go. La Parte 2 cubre el scheduler GMP y la Parte 3 cubre interfaces, tablas de métodos y de-virtualización.

---

## Stack vs Heap en Go: El Modelo Que Realmente Importa

Cada goroutine tiene su propio stack. Ese stack guarda parámetros, variables locales, valores temporales y metadata asociada con la cadena actual de llamadas.

El detalle importante no es simplemente que el stack sea "rápido" y el heap sea "lento". Esa explicación es demasiado superficial.

Lo que realmente importa es el **lifetime**.

- Un valor puede quedarse en el stack si su lifetime está acotado de forma demostrable al frame actual.
- Un valor debe moverse al heap si puede sobrevivir a ese frame, o si el compilador no puede demostrar que no lo hará.

¿Por qué nos importa cuándo un valor va al heap?

Porque una asignación en heap puede implicar:

- más presión sobre el garbage collector,
- peor localidad de memoria,
- más pointer chasing,
- y normalmente más `allocs/op` en paths calientes.

Pero hay una trampa importante: que algo vaya al heap no significa automáticamente que haya un bug. Si tratás cada escape como un fracaso, terminás reescribiendo código claro en código frágil sin una mejora medible.

La pregunta correcta no es "¿cómo evito todos los escapes?". La pregunta correcta es: **¿qué escapes son materialmente relevantes en esta carga de trabajo?**

---

## Qué Está Haciendo Realmente Escape Analysis

Escape analysis es un análisis estático y conservador que realiza el compilador.

Conservador significa que el compilador no necesita demostrar que un valor va a escapar. Le alcanza con no poder demostrar que ese valor es stack-safe.

Ese único detalle explica muchos resultados que a primera vista parecen extraños.

Una regla mental útil es esta:

1. Si el compilador puede razonar completamente sobre el lifetime del valor, puede dejarlo en el stack.
2. Si el valor se retorna por referencia, se captura, se comparte, se boxea o se pasa a un contexto de lifetime incierto, se vuelve candidato a heap.
3. Si al compilador le falta evidencia, elige corrección antes que optimismo.

Por eso escape analysis está profundamente relacionado con inlining, conversiones a interfaces, closures y límites entre goroutines. Todos esos features amplían o dificultan la visibilidad del compilador sobre el lifetime.

---

## Primer Experimento: Retornar por Valor vs Retornar un Puntero

Arranquemos con el programa más pequeño que igual sirve para aprender algo.

```go
package main

type user struct {
	id   int
	name string
}

func buildUserValue(id int, name string) user {
	u := user{id: id, name: name}
	return u
}

func buildUserPointer(id int, name string) *user {
	u := user{id: id, name: name}
	return &u
}

func main() {
	_ = buildUserValue(1, "gopher")
	_ = buildUserPointer(2, "runtime")
}
```

Compilalo con:

```bash
go build -gcflags="-m" main.go
```

Y después aumentá la verbosidad:

```bash
go build -gcflags="-m -m" main.go
```

Qué deberías esperar conceptualmente:

- el valor retornado por `buildUserValue` puede seguir siendo amigable con el stack,
- el `u` local dentro de `buildUserPointer` debe sobrevivir al frame porque su dirección se retorna,
- así que el compilador reportará que `u` se mueve al heap.

La primera lección importante es esta: en Go, retornar `*T` no es solo una decisión de API. Muchas veces también es una declaración sobre lifetime.

---

## Cómo Leer `-gcflags="-m"` Sin Mentirte

El reporte de escape es útil, pero la gente lo sobrerinterpreta todo el tiempo.

Mensajes típicos que vas a ver:

- `moved to heap: x`
- `x escapes to heap`
- `does not escape`
- `can inline ...`

El último importa porque escape analysis e inlining interactúan. Si una función se inlinea, el compilador gana contexto, y eso puede cambiar el resultado del análisis.

Por eso un workflow serio compara ambas versiones:

```bash
go build -gcflags="-m" main.go
go build -gcflags="-m -l" main.go
```

La flag `-l` desactiva el inlining. Si el diagnóstico cambia, eso no es ruido: es el compilador diciéndote que el contexto cambió la prueba.

---

## Closures: Lifetime Que Sobrevive a la Función

Ahora miremos una captura clásica.

```go
package main

func counter() func() int {
	n := 0
	return func() int {
		n++
		return n
	}
}

func main() {
	next := counter()
	_, _ = next(), next()
}
```

Compilalo otra vez con:

```bash
go build -gcflags="-m -m" main.go
```

¿Por qué `n` suele escapar acá?

Porque la closure retornada sigue usándolo después de que `counter` ya terminó. La variable ya no pertenece solo al bloque léxico donde fue declarada. Ahora pertenece a un entorno con lifetime más largo que el runtime tiene que preservar.

Siempre que retornes una closure, la pregunta correcta no es "¿creé un valor función?". La pregunta correcta es: **¿qué estado capturó esa función y cuánto tiempo tiene que vivir ahora ese estado?**

---

## Conversiones a Interfaces y Presión de Asignación Oculta

Los valores de interfaz son otra fuente habitual de confusión.

Considerá esto:

```go
package main

import "fmt"

type point struct {
	x int
	y int
}

func printAny(v any) {
	fmt.Println(v)
}

func main() {
	p := point{x: 10, y: 20}
	printAny(p)
}
```

Ahora inspeccionalo:

```bash
go build -gcflags="-m -m" main.go
```

El matiz importante es que no toda conversión a interfaz implica heap allocation, pero sí es un punto donde el compilador puede necesitar boxear un valor o preservarlo de forma distinta a una llamada estática simple.

Por eso `fmt.Println` puede distorsionar microbenchmarks. No solo imprime: también fuerza valores a pasar por `...any` y por la maquinaria de conversión a interfaces.

Si estás benchmarkeando una función pequeña y sensible a asignaciones, imprimir dentro del benchmark puede dominar completamente la señal que creías estar midiendo.

---

## Cruzando Límites de Goroutine

Un puntero que se entrega a otra goroutine es otra señal fuerte de lifetime extendido.

```go
package main

func worker(data *int) {
	_ = *data
}

func main() {
	n := 42
	go worker(&n)
}
```

Desde la perspectiva del compilador, una vez que `&n` se entrega a una goroutine, el valor deja de estar claramente confinado al frame actual. Puede ser leído después de que el punto de ejecución avance, posiblemente después de que ese frame ya no debería existir.

Esto no significa que todos los escapes relacionados con concurrencia sean evitables. Significa que la concurrencia cambia ownership y lifetime, y el compilador responde en consecuencia.

---

## La Vista del Ensamblador: Buscar `runtime.newobject`

Los diagnósticos del compilador están bien. El ensamblador es mejor cuando querés ver dónde se materializan esos diagnósticos.

Generá ensamblador con cualquiera de estos comandos:

```bash
go build -gcflags="-S" main.go
```

o:

```bash
go tool compile -S main.go
```

No necesitás convertirte en experto en ensamblador para sacar valor. Empezá buscando algunos patrones:

1. el tamaño del stack frame,
2. si se están tomando direcciones,
3. si la función llama helpers del runtime,
4. y especialmente si aparece `CALL runtime.newobject(SB)`.

Cuando un valor local se mueve al heap, `runtime.newobject` es una de las señales más concretas que vas a encontrar.

En el ejemplo de `buildUserPointer`, la estructura del código generado suele parecerse mucho más a "alocar objeto, inicializar campos, retornar puntero" que a "reservar slot en stack y retornar una copia por valor".

Ese es el puente entre el reporte de alto nivel y la consecuencia a nivel máquina.

---

## Inlining Cambia la Prueba

Escape analysis no vive aislado del resto del pipeline. Se beneficia de simplificación y contexto.

Considerá este helper pequeño:

```go
package main

type pair struct {
	a int
	b int
}

func makePair(a, b int) pair {
	return pair{a: a, b: b}
}

func sum() int {
	p := makePair(10, 20)
	return p.a + p.b
}

func main() {
	_ = sum()
}
```

Probá ambas variantes:

```bash
go build -gcflags="-m" main.go
go build -gcflags="-m -l" main.go
```

Cuando el helper se inlinea, el compilador puede razonar directamente sobre la construcción y el uso de `pair` dentro de `sum`. Sin inlining, la prueba puede volverse más conservadora.

Eso no siempre cambia una decisión de stack vs heap, pero cuando lo hace, enseña una lección importante: analizar lifetime es más fácil cuando desaparecen los límites de abstracción.

Por eso helpers diminutos en paths calientes pueden benchmarkear distinto según si se inlinean o no.

---

## Medí, No Adivines

El último paso es convertir teoría en números.

Creá un benchmark así:

```go
package main

import "testing"

func BenchmarkBuildUserValue(b *testing.B) {
	for i := 0; i < b.N; i++ {
		_ = buildUserValue(i, "gopher")
	}
}

func BenchmarkBuildUserPointer(b *testing.B) {
	for i := 0; i < b.N; i++ {
		_ = buildUserPointer(i, "gopher")
	}
}
```

Ejecutalo con:

```bash
go test -bench=. -benchmem
```

Lo importante no es el nanosegundo exacto en tu máquina. Lo importante es la forma del resultado:

- `ns/op`
- `B/op`
- `allocs/op`

Si la versión que retorna puntero asigna más y lo hace dentro de un hot loop, ahora sí tenés evidencia accionable.

Si la diferencia es irrelevante en tu carga real, la optimización correcta puede ser conservar la API más clara.

---

## Heurísticas Prácticas para Código de Producción

Cuando ves un perfil de asignaciones sospechoso en Go, seguí este orden:

1. profileá o benchmarkeá primero,
2. identificá el hot path,
3. inspeccioná con `-gcflags="-m -m"`,
4. compará con y sin inlining usando `-l`,
5. mirá ensamblador solo en los slices críticos más pequeños,
6. cambiá código únicamente si el costo medido justifica la pérdida de abstracción o legibilidad.

Hay tres errores comunes que vale la pena nombrar explícitamente:

1. Tratar toda asignación en heap como si fuera un bug.
2. Ignorar conversiones a interfaces y closures dentro de benchmarks.
3. Leer el output del compilador sin considerar el inlining.

---

## Brief de Ilustraciones para Diseño

### 1. Pipeline de Lifetime de una Variable

Dibujar un flujo de izquierda a derecha con estas etapas:

- código fuente Go,
- frontend del compilador,
- SSA / representación intermedia,
- decisión de escape analysis,
- ubicación en stack o heap,
- ensamblador generado.

El nodo central debe ser un rombo con la pregunta: "¿el compilador puede demostrar que el valor muere con el frame actual?"

Si la respuesta es sí, va a stack. Si no, va a heap.

### 2. Stack Frame vs Heap Object

Mostrar el stack de una goroutine con tres frames apilados. Resaltar el frame actual y una variable local dentro de él. Después, dibujar un puntero escapando hacia un objeto en heap a la derecha. Etiquetar el stack como lifetime acotado al frame y el heap como lifetime extendido.

### 3. Return by Value vs Return by Pointer

Hacer una comparación de dos columnas:

- izquierda: struct local retornado por valor, sin promoción a heap,
- derecha: struct local cuya dirección se retorna, promovido a heap.

Debajo de cada lado, agregar una tira corta de pseudo-assembly. En el lado derecho debe aparecer claramente `runtime.newobject`.

### 4. Mapa de Triggers Comunes de Escape

Crear un mapa radial con cinco nodos:

- puntero retornado,
- captura por closure,
- boxing de interfaz,
- handoff a goroutine,
- lifetime incierto en el callee.

Cada nodo debe incluir una línea que explique por qué extiende o vuelve opaco el lifetime.

### 5. Inlining Cambia el Análisis

Mostrar la misma helper function analizada en dos caminos:

- sin inlining: menos contexto, prueba más conservadora,
- con inlining: contexto del call site completo, prueba más fuerte.

El énfasis visual debe estar en la visibilidad del compilador, no en la velocidad.

---

## Cierre

Escape analysis no es una bolsa de trucos para complacer al compilador. Es un modelo para razonar sobre el lifetime de los valores.

Una vez que entendés ese modelo, la asignación en heap deja de sentirse mágica. Podés inspeccionarla, explicarla y decidir si realmente importa.

En la Parte 2 vamos a cambiar de pregunta. Vamos a dejar de preguntar dónde viven los valores y pasar a preguntar quién consigue ejecutar trabajo en Go: el runtime scheduler.

---

## Navegacion de la Serie

- [Indice de la Serie](/posts/go-runtime-series-index)
- Siguiente: [Parte 2 - Concurrencia en Go: La Anatomia Interna del Scheduler GMP](/posts/go-scheduler-gmp)