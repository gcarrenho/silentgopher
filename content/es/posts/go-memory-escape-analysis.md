---
title: "Gestión de Memoria en Go: El Viaje al Ensamblador y el Escape Analysis"
subtitle: "Stack, Heap y Escape Analysis"
date: 2026-08-04
author: "@SilentGopher"
description: "Un recorrido práctico por stack vs heap en Go, cómo funciona escape analysis, cómo inspeccionar decisiones del compilador con -gcflags='-m' y cómo conectarlas con el ensamblador generado."
image: "/images/posts/go-memory-escape-analysis/memoryManagement.jpg"
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

![Comparación entre stack frame y heap object, mostrando una variable local en el frame actual y un puntero que escapa hacia heap](/images/posts/go-memory-escape-analysis/stackFrameVsHeap.png)

_Figura: un valor puede vivir en stack mientras su lifetime quede acotado al frame actual. Cuando ese lifetime se extiende o deja de ser demostrable, el compilador necesita materializarlo fuera del frame._

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

### Mapa Mental del Pipeline de Lifetime

![Pipeline de lifetime de una variable en el compilador de Go, desde código fuente hasta ensamblador, con decisión de escape analysis hacia stack o heap](/images/posts/go-memory-escape-analysis/memory-scape.png)

_Figura: pipeline conceptual de escape analysis. Si el compilador puede demostrar que el valor muere dentro del frame actual, queda en stack; si no puede demostrarlo, el valor se promueve a heap._

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

![Comparación entre retornar un struct por valor y retornar un puntero, mostrando el caso sin escape y el caso promovido a heap con runtime.newobject](/images/posts/go-memory-escape-analysis/returnValueVsPointer.png)

_Figura: retornar por valor mantiene el dato acotado al frame o lo copia al caller; retornar un puntero obliga a preservar el objeto más allá del retorno y vuelve mucho más probable la promoción a heap._

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

![Mapa radial de triggers comunes de escape: puntero retornado, captura por closure, boxing de interfaz, handoff a goroutine y lifetime incierto en el callee](/images/posts/go-memory-escape-analysis/triggersCommonScape.png)

_Figura: los escapes más comunes no son casos aislados. Suelen aparecer cuando el compilador pierde visibilidad completa del lifetime o cuando el valor realmente necesita sobrevivir al frame actual._

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

![Comparación del análisis con y sin inlining, mostrando cómo más contexto permite una prueba más fuerte y evita escapes innecesarios](/images/posts/go-memory-escape-analysis/inliningAnalisis.png)

_Figura: inlining no es solo una optimización de velocidad. También puede cambiar la calidad de la prueba que el compilador hace sobre el lifetime de un valor._

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

## Cierre

Escape analysis no es una bolsa de trucos para complacer al compilador. Es un modelo para razonar sobre el lifetime de los valores.

Una vez que entendés ese modelo, la asignación en heap deja de sentirse mágica. Podés inspeccionarla, explicarla y decidir si realmente importa.

En la Parte 2 vamos a cambiar de pregunta. Vamos a dejar de preguntar dónde viven los valores y pasar a preguntar quién consigue ejecutar trabajo en Go: el runtime scheduler.

---

## Navegacion de la Serie

- [Indice de la Serie](/posts/go-runtime-series-index)
- Siguiente: [Parte 2 - Concurrencia en Go: La Anatomia Interna del Scheduler GMP](/posts/go-scheduler-gmp)