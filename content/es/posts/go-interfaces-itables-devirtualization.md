---
title: "Interfaces en Go: iTable, Layout Interno y De-virtualización"
subtitle: "iface, eface, Dispatch y De-virtualización"
date: 2026-06-15
author: "@SilentGopher"
description: "Un análisis práctico de internals de interfaces en Go: representación iface y eface, resolución de métodos en runtime, costos ocultos y optimizaciones del compilador mediante de-virtualización."
image: "/images/posts/go-interfaces-itables-devirtualization/cover.svg"
tags: ["Go", "Go Runtime", "Interfaces", "Compiler", "Performance", "Assembly"]
draft: false
---

> Las interfaces hacen que el diseño sea flexible. El runtime y el compilador pagan ese costo, salvo cuando pueden demostrar que no hace falta.

<!--more-->

Un valor interfaz en Go no es una idea abstracta fuera del runtime. Tiene una representación concreta en memoria, un mecanismo concreto de dispatch y, en rutas calientes, un costo medible.

Eso importa por dos motivos.

Primero, las interfaces están en todas partes del Go idiomático: límites de paquete, testing, adapters y APIs.

Segundo, las llamadas vía interfaz pueden volverse un impuesto de performance silencioso si no entendés qué están haciendo runtime y compilador.

Este artículo se centra en tres preguntas:

1. ¿cómo se representa internamente un valor interfaz?
2. ¿cómo se resuelven métodos en runtime?
3. ¿cuándo puede el compilador reemplazar dispatch dinámico por llamada directa?

Vamos a usar código, output del compilador, benchmarks y ensamblador para hacerlo visible.

> **Nota de serie:** esta es la Parte 3 de la serie de internals de Go. La Parte 1 cubrió memoria y Escape Analysis. La Parte 2 cubrió scheduler GMP.

---

## Dos formas internas: `eface` e `iface`

A alto nivel, Go distingue dos shapes importantes para valores interfaz.

### Empty interface: `eface`

La interfaz vacía (`any`) conceptualmente contiene:

- puntero a metadata de tipo,
- puntero a datos subyacentes.

No necesita tabla de métodos porque no hay métodos que resolver.

### Non-empty interface: `iface`

Una interfaz no vacía conceptualmente contiene:

- puntero a metadata de dispatch,
- puntero a datos subyacentes.

Esa metadata de dispatch incluye la información necesaria para resolver métodos dinámicamente.

Los detalles exactos de structs internos pueden cambiar entre versiones de Go, pero el modelo mental se mantiene: **una interfaz combina datos con metadata guiada por tipo para dispatch**.

Eso explica por qué convertir un valor concreto a interfaz no es semánticamente gratis.

---

## El dispatch dinámico más simple posible

Ejemplo mínimo:

```go
package main

import "fmt"

type Speaker interface {
	Speak() string
}

type Dog struct{}

func (Dog) Speak() string {
	return "woof"
}

func say(s Speaker) string {
	return s.Speak()
}

func main() {
	var s Speaker = Dog{}
	fmt.Println(say(s))
}
```

A nivel fuente parece trivial.

Pero `say` no conoce estáticamente el tipo concreto detrás de `Speaker`. Debe resolver el target usando metadata de interfaz en runtime.

Esa es la esencia del dispatch dinámico en Go.

---

## De dónde sale el costo

El costo de interfaces rara vez es un evento dramático único. Suele venir de la combinación de varios efectos:

1. conversión a interfaz,
2. posible boxing/asignación en ciertos contextos,
3. llamada indirecta en lugar de directa,
4. menor libertad de optimización cuando el compilador no recupera el tipo concreto.

El último punto suele subestimarse.

Los compiladores optimizan mejor con certidumbre. Una llamada directa a método concreto es más fácil de inlinear y simplificar que una llamada que debe pasar por metadata de dispatch.

---

## `iface` vs `eface` en práctica

Programa simple para inspección:

```go
package main

import "fmt"

type Speaker interface {
	Speak() string
}

type Cat struct{}

func (Cat) Speak() string {
	return "meow"
}

func takeAny(v any) {
	fmt.Println(v)
}

func takeSpeaker(s Speaker) {
	fmt.Println(s.Speak())
}

func main() {
	c := Cat{}
	takeAny(c)
	takeSpeaker(c)
}
```

Inspeccioná con:

```bash
go build -gcflags="-m -m" main.go
```

Puede haber diferencias de diagnóstico según versión, pero la distinción conceptual es estable:

- `takeAny` necesita tipo + data,
- `takeSpeaker` necesita metadata apta para dispatch de métodos.

Esa diferencia se vuelve relevante en rutas de alto volumen.

---

## Dispatch dinámico en ensamblador

Comparemos llamada directa vs llamada vía interfaz.

```go
package main

type Adder struct{}

func (Adder) Add(a, b int) int {
	return a + b
}

type AdderAPI interface {
	Add(a, b int) int
}

func direct(a Adder) int {
	return a.Add(10, 20)
}

func viaInterface(a AdderAPI) int {
	return a.Add(10, 20)
}

func main() {
	_ = direct(Adder{})
	_ = viaInterface(Adder{})
}
```

Generá ensamblador:

```bash
go build -gcflags="-S" main.go
```

Qué mirar conceptualmente:

- `direct` puede terminar como llamada directa o inlining total,
- `viaInterface` suele requerir carga de target desde metadata de dispatch,
- esa indirección puede limitar optimizaciones posteriores.

No necesitás memorizar instrucciones exactas; necesitás detectar si el target está resuelto estáticamente o no.

---

## De-virtualización: cuando el compilador recupera certidumbre

La optimización más interesante en este tema es la de-virtualización.

Ocurre cuando el compilador puede probar el tipo concreto detrás de una llamada por interfaz. Si la prueba es sólida, reemplaza dispatch indirecto por llamada directa, habilitando optimizaciones adicionales como inlining.

Ejemplo:

```go
package main

type Runner interface {
	Run() int
}

type Job struct{}

func (Job) Run() int {
	return 42
}

func execute(r Runner) int {
	return r.Run()
}

func main() {
	job := Job{}
	_ = execute(job)
}
```

Inspeccioná con:

```bash
go build -gcflags="-m -m" main.go
```

Y después:

```bash
go build -gcflags="-S" main.go
```

En versiones recientes de Go podés ver pistas de optimización en output textual. Pero la evidencia final está en el código generado: si hay target único demostrable, el camino puede volverse más estático.

---

## Benchmark: llamada directa vs llamada por interfaz

Para ver costo en números:

```go
package main

import "testing"

type Adder struct{}

func (Adder) Add(a, b int) int {
	return a + b
}

type AdderAPI interface {
	Add(a, b int) int
}

func direct(a Adder) int {
	return a.Add(10, 20)
}

func viaInterface(a AdderAPI) int {
	return a.Add(10, 20)
}

func BenchmarkDirect(b *testing.B) {
	a := Adder{}
	var result int
	for i := 0; i < b.N; i++ {
		result = direct(a)
	}
	_ = result
}

func BenchmarkViaInterface(b *testing.B) {
	var a AdderAPI = Adder{}
	var result int
	for i := 0; i < b.N; i++ {
		result = viaInterface(a)
	}
	_ = result
}
```

Ejecutá:

```bash
go test -bench=. -benchmem
```

Posibles resultados:

- la versión directa gana,
- la versión con interfaz pierde por dispatch indirecto,
- o la diferencia es mínima porque el compilador pudo optimizar más de lo esperado.

Ese tercer caso es clave: por eso los consejos de performance con interfaces deben ser evidence-driven.

---

## Donde interfaces y Escape Analysis se encuentran

Interfaces no solo afectan dispatch. También pueden influir en comportamiento de asignación.

Ejemplo:

```go
package main

import "fmt"

type payload struct {
	a int
	b int
	c int
}

func logValue(v any) {
	fmt.Println(v)
}

func main() {
	p := payload{a: 1, b: 2, c: 3}
	logValue(p)
}
```

Inspeccioná con:

```bash
go build -gcflags="-m -m" main.go
```

La moraleja no es "interfaces siempre alocan". La moraleja es que convertir a interfaz agrega una capa más de análisis para el compilador, y eso puede volverlo más conservador en ciertos contextos.

Por eso interfaces viven en la frontera entre diseño y performance.

---

## Cuándo te debería importar

En muchas aplicaciones, el overhead de interfaces es irrelevante frente a red, base de datos, serialización o complejidad de negocio.

Pero conviene mirar más de cerca en:

1. loops calientes CPU-bound,
2. métodos diminutos invocados millones de veces,
3. rutas sensibles a asignaciones,
4. librerías base donde el costo se multiplica en toda la aplicación.

Esto no es un argumento contra interfaces. Es un argumento a favor de colocarlas deliberadamente.

Una regla útil: interfaces en boundaries, concretos en el interior caliente cuando la medición lo justifique.

---

## Workflow práctico de inspección

Si sospechás que dispatch por interfaz pesa materialmente:

1. benchmarkeá versión concreta vs interfaz,
2. inspeccioná con `-gcflags="-m -m"` para escape y pistas de optimización,
3. inspeccioná con `-gcflags="-S"` para ver si el dispatch es indirecto,
4. simplificá shape de código para observar si aparece de-virtualización,
5. mantené la abstracción si la diferencia no es significativa.

Errores comunes:

1. asumir que toda interfaz es cara,
2. asumir que el compilador no optimiza llamadas por interfaz,
3. destruir buen diseño sin benchmark que lo justifique.

---

## Especificación de ilustraciones

### 1. Layout `eface` vs `iface`

Diagrama side-by-side:

- `eface`: type pointer + data pointer,
- `iface`: dispatch metadata / method table pointer + data pointer.

Objetivo: mostrar por qué interfaces no vacías necesitan un nivel extra.

### 2. Flujo de dispatch dinámico

Flujo:

valor interfaz -> metadata de dispatch -> dirección de método concreto -> ejecución.

Al lado, flujo directo:

valor concreto -> llamada directa.

La comparación visual debe hacer evidente la indirección extra.

### 3. Transformación por de-virtualización

Panel antes/después:

- antes: `r.Run()` con lookup dinámico,
- después: compilador prueba tipo concreto y emite llamada directa a `Job.Run`.

Énfasis en recuperación de certidumbre por parte del compilador.

### 4. Mapa de superficie de costo

Mapa con cuatro nodos:

- conversión a interfaz,
- boxing/representación,
- llamada indirecta,
- optimizaciones bloqueadas.

Cada nodo con una línea de cuándo pesa.

### 5. Tarjeta de lectura de benchmark

Mini visual para interpretar `ns/op`, `B/op`, `allocs/op` comparando llamada directa vs interfaz.

---

## Cierre

Las interfaces en Go no son lentas por ser "alto nivel". Son costosas solo cuando runtime y compilador deben preservar dinamismo que no puede eliminarse.

Cuando entendés `eface`, `iface`, dispatch y de-virtualización, podés decidir mejor dónde usar interfaces y dónde conviene mantener concrete paths.

Ese es el hilo conductor de toda la serie: Go se siente simple en superficie, pero su performance está determinada por decisiones concretas de compilador y runtime que podés inspeccionar directamente.

---

## Navegacion de la Serie

- [Indice de la Serie](/posts/go-runtime-series-index)
- Anterior: [Parte 2 - Concurrencia en Go: La Anatomia Interna del Scheduler GMP](/posts/go-scheduler-gmp)
---
title: "Interfaces en Go: iTables, iface, eface y De-virtualización"
subtitle: "Layout de Interfaces y Dynamic Dispatch"
date: 2026-06-15
author: "@SilentGopher"
description: "Una mirada interna a las interfaces de Go, incluyendo iface, eface, tablas de métodos, dynamic dispatch y las optimizaciones del compilador detrás de la de-virtualización."
tags: ["Go", "Go Runtime", "Interfaces", "Compiler", "Performance", "Assembly"]
draft: false
---

> Las interfaces vuelven flexible al código. El runtime y el compilador pagan la cuenta, salvo que puedan demostrar que no hace falta.

<!--more-->

Las interfaces de Go son una de las mejores decisiones de diseño del lenguaje. Permiten que las APIs dependan de comportamiento en lugar de tipos concretos, y esa es exactamente la razón por la que aparecen por todas partes en código idiomático. Pero esa abstracción no es gratis. Cada valor de interfaz tiene una representación en runtime, cada llamada de método tiene una ruta de dispatch, y cada conversión a interfaz le da al compilador una cosa más sobre la que razonar.

Este artículo es la tercera parte de la serie:

- [Parte 1: Stack vs Heap, Escape Analysis y Ensamblador](/posts/go-memory-escape-analysis)
- [Parte 2: Por Dentro del Scheduler GMP](/posts/go-scheduler-gmp)

Nos vamos a enfocar en tres preguntas:

1. ¿Cómo se ve un valor de interfaz en memoria?
2. ¿Cómo se resuelven los métodos en tiempo de ejecución?
3. ¿Cuándo puede el compilador reemplazar un dynamic dispatch por una llamada directa?

---

## Dos Formas de Valores de Interfaz: `eface` e `iface`

Internamente, Go distingue entre dos grandes clases de valores de interfaz.

- `eface` es la representación interna de la empty interface, hoy escrita normalmente como `any`.
- `iface` es la representación de una interfaz no vacía, es decir, una que trae métodos consigo.

Conceptualmente, una empty interface necesita dos cosas:

1. un puntero a metadata de tipo,
2. un puntero a los datos subyacentes.

Una interfaz no vacía necesita una capa más: información de resolución de métodos. En la práctica, eso significa un puntero a metadata que describe tanto al tipo concreto como a la forma en que satisface la interfaz objetivo.

Nunca deberías depender de structs internos del runtime en código de producción. Pero para aprender, es muy útil reflejar esa forma con `unsafe`.

---

## Inspeccionando el Layout de Interfaces con `unsafe`

Usá este programa:

```go
package main

import (
	"fmt"
	"unsafe"
)

type eface struct {
	typ  unsafe.Pointer
	data unsafe.Pointer
}

type iface struct {
	tab  unsafe.Pointer
	data unsafe.Pointer
}

type Stringer interface {
	String() string
}

type user struct {
	name string
}

func (u user) String() string {
	return u.name
}

func main() {
	u := user{name: "gopher"}

	var a any = u
	var s Stringer = u

	ea := *(*eface)(unsafe.Pointer(&a))
	is := *(*iface)(unsafe.Pointer(&s))

	fmt.Printf("any      -> typ=%p data=%p\n", ea.typ, ea.data)
	fmt.Printf("Stringer -> tab=%p data=%p\n", is.tab, is.data)
}
```

Ejecutalo con:

```bash
go run main.go
```

Las direcciones exactas no importan. Lo importante es la forma:

- `any` guarda tipo más datos,
- una interfaz no vacía guarda metadata de tabla de métodos más datos.

Esa indirección extra es una de las razones por las que el method dispatch a través de interfaces tiene un perfil de runtime distinto al de una llamada directa.

---

## Method Dispatch a Través de una Interfaz

Considerá este ejemplo:

```go
package main

import "fmt"

type Shape interface {
	Area() int
}

type Square struct {
	side int
}

func (s Square) Area() int {
	return s.side * s.side
}

func printArea(shape Shape) {
	fmt.Println(shape.Area())
}

func main() {
	printArea(Square{side: 12})
}
```

A nivel de source, `shape.Area()` se ve como una llamada de método normal. Internamente, no es lo mismo que `square.Area()` sobre un valor concreto.

Con un valor concreto, el compilador puede emitir una llamada directa o inlinear el método si conviene.

Con un valor de interfaz, el runtime necesita:

1. identificar el tipo concreto detrás de la interfaz,
2. encontrar la implementación correcta del método a través de la metadata de la interfaz,
3. ejecutar la llamada usando ese target resuelto.

Ese costo de dynamic dispatch suele ser pequeño, pero en hot loops es medible.

---

## Comparando Direct Calls vs Interface Calls

Creá un benchmark corto:

```go
package main

import "testing"

type Adder interface {
	Add(int, int) int
}

type calculator struct{}

func (calculator) Add(a, b int) int {
	return a + b
}

func addDirect(c calculator, a, b int) int {
	return c.Add(a, b)
}

func addInterface(a Adder, x, y int) int {
	return a.Add(x, y)
}

func BenchmarkDirectCall(b *testing.B) {
	c := calculator{}
	var result int
	for i := 0; i < b.N; i++ {
		result = addDirect(c, i, i)
	}
	_ = result
}

func BenchmarkInterfaceCall(b *testing.B) {
	var a Adder = calculator{}
	var result int
	for i := 0; i < b.N; i++ {
		result = addInterface(a, i, i)
	}
	_ = result
}
```

Corré:

```bash
go test -bench=. -benchmem
```

Lo que normalmente vas a ver no es una diferencia dramática en asignaciones, sino una diferencia pequeña en throughput por el dynamic dispatch y por la menor libertad de optimización del compilador.

La lección importante no es "no uses interfaces". La lección es que toda abstracción tiene una representación, y toda representación tiene un modelo de costo.

---

## Donde Escape Analysis se Encuentra con las Interfaces

Las conversiones a interfaz muchas veces interactúan con el comportamiento de asignación. Considerá este ejemplo:

```go
package main

import "fmt"

type payload struct {
	a int
	b int
}

func logValue(v any) {
	fmt.Println(v)
}

func main() {
	p := payload{a: 1, b: 2}
	logValue(p)
}
```

Inspeccionalo con:

```bash
go build -gcflags="-m -m" main.go
```

Según el contexto exacto y la versión de Go, el compilador puede reportar comportamiento de escape alrededor de la conversión a interfaz o del camino de formatting. El punto no es que las interfaces siempre asignen. No lo hacen. El punto es que cruzar hacia una interfaz le quita parte de la información al compilador y puede volverlo más conservador.

Eso se vuelve especialmente visible en logging, formatting y capas genéricas de plumbing que aceptan `any`.

---

## De-virtualización: Cuando el Compilador Vuelve Estático lo Dinámico

La optimización más interesante en este terreno es la de-virtualización.

La de-virtualización ocurre cuando el compilador puede demostrar el tipo concreto detrás de una interface call en tiempo de compilación. Si esa prueba sale bien, puede reemplazar el method dispatch indirecto por una llamada directa, lo que a su vez habilita optimizaciones posteriores como inlining.

Usá este ejemplo:

```go
package main

type Runner interface {
	Run() int
}

type job struct{}

func (job) Run() int {
	return 42
}

func call(r Runner) int {
	return r.Run()
}

func main() {
	_ = call(job{})
}
```

Inspeccioná el output del compilador:

```bash
go build -gcflags="-m -m" main.go
```

Después inspeccioná ensamblador:

```bash
go build -gcflags="-S" main.go
```

En releases recientes de Go, el compilador incluso puede reportar oportunidades de de-virtualización de forma textual en su output de optimización. Y aunque el wording cambie entre versiones, el ensamblador sigue siendo la verdad de fondo: si el compilador ve un único target concreto, puede emitir un path de llamada directa en lugar de lookup de método vía interfaz.

Esa es la historia de performance importante acá. Las interfaces son dinámicas por diseño, pero el compilador de Go es oportunista. Si puede recuperar conocimiento estático, lo hace.

---

## Una Regla Práctica para Diseñar APIs

Existe un punto medio razonable entre dos extremos malos.

Un extremo malo es temerle a las interfaces y especializar manualmente cada path. Eso normalmente produce APIs rígidas y desagradables.

El otro extremo malo es repartir límites de interfaz por todos los hot loops y funciones críticas sin medir el costo.

La mejor regla es esta:

- usá interfaces en límites arquitectónicos,
- mantené concretos los hot paths cuando la abstracción no te compra nada,
- benchmarkeá antes de aplanar diseño por razones de performance,
- inspeccioná output del compilador cuando los números sugieren que dispatch o escape son relevantes.

Esa es la forma de seguir siendo idiomático sin volverte ingenuo.

---

## Brief de Ilustraciones para Diseño

### 1. Layout de Memoria de `eface` vs `iface`

Dibujar dos cajas lado a lado. La caja de `eface` debe contener `type pointer` y `data pointer`. La caja de `iface` debe contener `itab pointer` y `data pointer`. Agregar un caption aclarando que la indirección de tabla de métodos existe solo para interfaces no vacías.

### 2. Flujo de Dynamic Dispatch

Crear un flujo de izquierda a derecha:

`interface value -> itab lookup -> concrete method address -> method call`

Debajo, agregar un segundo flujo más corto para calls concretas:

`concrete value -> direct call`

La imagen tiene que volver obvio el paso extra.

### 3. Split View de De-virtualización

Panel izquierdo: una interface call que permanece indirecta porque hay múltiples implementaciones concretas posibles.

Panel derecho: un único target probado por el compilador que se convierte en direct call. Agregar una nota breve de que las direct calls habilitan optimizaciones posteriores como inlining.

### 4. Mapa de Costos de Interfaces

Usar un mapa simple mostrando dónde la abstracción vía interfaz es barata y deseable, como package boundaries y test seams, versus dónde merece más escrutinio, como tight loops, serialization pipelines y adapters muy invocados.

---

## Cierre

Las interfaces no son lentas. Las suposiciones no examinadas sobre interfaces sí pueden serlo.

Una vez que entendés `eface`, `iface`, tablas de métodos y de-virtualización, el código Go cargado de interfaces se vuelve mucho más fácil de razonar tanto arquitectónica como mecánicamente.

Esa es también la lección más amplia de toda la serie: la simplicidad de Go en la superficie es real, pero sus características de performance salen de decisiones concretas del runtime y del compilador que podés inspeccionar directamente.