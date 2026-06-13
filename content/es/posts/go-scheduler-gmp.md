---
title: "Concurrencia en Go: La Anatomía Interna del Scheduler GMP"
subtitle: "G, M, P, Work Stealing, Syscalls, Preemption"
date: 2026-06-13
author: "@SilentGopher"
description: "Un deep dive sobre el scheduler de Go: estructuras G, M y P, work stealing, handoff en syscalls bloqueantes, netpolling y la evolución de preemption cooperativa a asíncrona."
image: "/images/posts/go-scheduler-gmp/cover.svg"
tags: ["Go", "Go Runtime", "Concurrency", "Scheduler", "Performance", "GMP"]
draft: false
---

> Las goroutines son baratas, pero no son magia. Son el resultado de un scheduler que trabaja duro para que la concurrencia se sienta simple.

<!--more-->

Cuando se explica concurrencia en Go, muchas veces todo queda en "las goroutines son lightweight threads". Esa frase ayuda al inicio y se vuelve incompleta muy rápido.

Las goroutines no son threads del sistema operativo. Son unidades de trabajo planificadas por el runtime. Y el mecanismo que hace esto viable a escala es el scheduler **GMP**.

En este artículo vamos a recorrer:

1. qué representan realmente G, M y P,
2. cómo se mueve trabajo entre colas locales y globales,
3. cómo work stealing mantiene throughput,
4. qué pasa durante syscalls bloqueantes,
5. y cómo cambió preemption de un modelo más cooperativo a uno asíncrono.

Además, vamos a ejecutar código que expone comportamiento del scheduler, porque la teoría se vuelve mucho más clara cuando el runtime habla.

> **Nota de serie:** esta es la Parte 2 de la serie de internals de Go. La Parte 1 cubrió memoria y Escape Analysis. La Parte 3 cubre internals de interfaces y de-virtualización.

---

## El problema que el scheduler debe resolver

Go quiere que puedas crear enormes cantidades de tareas concurrentes sin pedirle al SO un kernel thread por tarea.

Eso obliga al runtime a tener su propio scheduler.

El scheduler tiene que responder, de forma eficiente, preguntas difíciles:

- ¿qué goroutine corre ahora?
- ¿en qué thread del SO corre?
- ¿cuántos contextos pueden ejecutar Go code en paralelo?
- ¿qué pasa cuando una goroutine se bloquea en syscall?
- ¿cómo se reparte trabajo sin centralizar todo en un lock gigante?

Go responde con tres estructuras runtime: **G**, **M** y **P**.

---

## G, M y P: el modelo de tres cuerpos del scheduler

### G: Goroutine

`G` es la representación runtime de una goroutine.

Incluye conceptualmente:

- stack de la goroutine,
- instruction pointer y estado necesario para reanudar,
- metadata de scheduling,
- y estado de espera / razón de bloqueo.

Si pensás en "tarea" o "continuación", vas bien.

### M: Machine

`M` representa un thread del sistema operativo gestionado por el runtime.

Un `M` ejecuta código Go, hace syscalls y puede quedar estacionado o reactivado. Pero `M` solo no alcanza para ejecutar Go code regular.

### P: Processor

`P` es el recurso runtime que habilita a un `M` a ejecutar Go code.

Este es el punto más subestimado en muchas explicaciones.

Un `P` mantiene recursos locales del scheduler, incluida la cola local de goroutines runnable. La cantidad de `P` suele estar gobernada por `GOMAXPROCS`.

Eso implica:

- puede haber muchísimas goroutines,
- puede haber múltiples threads,
- pero solo pueden ejecutar Go code simultáneamente tantas goroutines como `P` existan.

Podés pensar `P` como el token de ejecución CPU-bound de Go.

---

## El loop central de planificación

A alto nivel, el ciclo estable es:

1. un `M` posee un `P`,
2. ese `P` tiene una cola local de `G` runnable,
3. el `M` toma una `G` y la ejecuta,
4. cuando esa `G` bloquea, cede, termina o es preempted, el scheduler toma la siguiente.

Esto se complica cuando la carga está desbalanceada: hay `P` sin trabajo y otros con colas profundas. Ahí entra work stealing.

---

## Work Stealing: throughput sin cuello central

Si todas las goroutines runnable fueran a una sola cola global, cada decisión de scheduling competiría por la misma estructura compartida. Escala mal.

Go evita eso usando colas locales por `P` como camino principal.

Cuando un `P` se queda sin trabajo local, en vez de dormir inmediatamente intenta robar trabajo runnable de otro `P`.

Esta estrategia da dos propiedades clave:

1. scheduling local rápido en el caso común,
2. balanceo de carga sin pasar cada operación por un lock global.

La cola global existe, pero no es el camino normal para cada goroutine runnable.

---

## Hacer hablar al scheduler: demo ejecutable

Este programa crea trabajo desparejo y permite observar comportamiento real.

```go
package main

import (
	"fmt"
	"runtime"
	"sync"
	"time"
)

func cpuBound(id int, wg *sync.WaitGroup) {
	defer wg.Done()

	var sum uint64
	for i := 0; i < 80_000_000; i++ {
		sum += uint64(i % (id + 1))
	}

	if sum == 42 {
		fmt.Println("impossible")
	}
}

func main() {
	runtime.GOMAXPROCS(2)

	var wg sync.WaitGroup
	start := time.Now()

	for i := 1; i <= 8; i++ {
		wg.Add(1)
		go cpuBound(i, &wg)
	}

	wg.Wait()
	fmt.Println("done in", time.Since(start))
}
```

Corré primero normal:

```bash
go run main.go
```

Luego con trazas del scheduler:

```bash
set GODEBUG=schedtrace=1000,scheddetail=1
go run main.go
```

En PowerShell también podés usar:

```powershell
$env:GODEBUG = "schedtrace=1000,scheddetail=1"
go run main.go
```

Qué observar:

- cantidad de `P`,
- goroutines runnable,
- threads activos vs idle,
- si el sistema se estabiliza o acumula runnable sin drenar.

El output es ruidoso, pero entrena la intuición correcta: dejás de ver goroutines como green threads abstractos y empezás a ver un scheduler gestionando oferta y demanda.

---

## Qué pasa durante una syscall bloqueante

Un scheduler que solo maneja CPU puro sería simple. Los sistemas reales bloquean.

Supongamos que una goroutine entra en syscall bloqueante sobre un `M` que actualmente posee un `P`.

Si el runtime no hiciera nada, ese `P` quedaría secuestrado detrás de un thread bloqueado. Go evita esto desacoplando el `P` para que otro thread pueda seguir ejecutando Go code.

La idea general:

1. goroutine entra a syscall bloqueante,
2. el `M` actual puede quedar bloqueado en kernel,
3. el runtime libera o handoff del `P`,
4. otro `M` toma ese `P` y continúa scheduling.

Ese handoff es crítico para throughput en cargas mixtas CPU + I/O.

Ejemplo simple mezclando CPU con espera bloqueante simulada:

```go
package main

import (
	"fmt"
	"runtime"
	"sync"
	"time"
)

func busy(wg *sync.WaitGroup) {
	defer wg.Done()
	var total uint64
	for i := 0; i < 100_000_000; i++ {
		total += uint64(i)
	}
	if total == 0 {
		fmt.Println("never")
	}
}

func sleepy(wg *sync.WaitGroup) {
	defer wg.Done()
	time.Sleep(2 * time.Second)
}

func main() {
	runtime.GOMAXPROCS(1)

	var wg sync.WaitGroup
	wg.Add(2)

	go busy(&wg)
	go sleepy(&wg)

	wg.Wait()
	fmt.Println("finished")
}
```

Pregunta clave de interpretación: **¿una goroutine bloqueada impide que otras sigan ejecutando Go code?**

Con handoff correcto de `P`, normalmente no.

---

## Netpolling: por qué servidores de red escalan distinto

No toda espera se maneja igual.

En I/O de red, Go integra un poller para que goroutines esperando sockets no requieran un thread estacionado por conexión. Esa integración explica parte de por qué Go puede manejar alta concurrencia de conexiones eficientemente.

Modelo mental útil:

- goroutines esperando readiness no están quemando threads de forma lineal,
- eventos de readiness las vuelven runnable,
- scheduler y netpoll cooperan para reinsertar trabajo listo en colas de ejecución.

Eso es una pieza central detrás de "goroutines son baratas" en servidores reales.

---

## Preemption cooperativa: el modelo anterior

Históricamente, Go dependía más de safe points cooperativos.

Eso significa que una goroutine cedía control principalmente en puntos como:

- llamadas de función,
- operaciones de canal,
- bloqueos,
- chequeos runtime.

Funcionaba, pero tenía un borde feo: loops CPU-bound largos y sin puntos de cesión útiles podían perjudicar fairness y progreso del GC.

---

## Preemption asíncrona: el scheduler moderno

Go moderno incorporó preemption asíncrona para atacar esos casos.

A nivel conceptual, el runtime puede interrumpir goroutines ejecutando durante loops hostiles aunque no cedan voluntariamente con suficiente frecuencia.

Consecuencias prácticas:

1. loops largos monopolizan menos,
2. mejora fairness,
3. mejora robustez de coordinación con GC bajo carga adversa.

Demo de intuición:

```go
package main

import (
	"fmt"
	"runtime"
	"time"
)

func spinner() {
	for {
	}
}

func observer() {
	for i := 0; i < 5; i++ {
		fmt.Println("observer tick", i)
		time.Sleep(200 * time.Millisecond)
	}
}

func main() {
	runtime.GOMAXPROCS(1)
	go spinner()
	observer()
}
```

En toolchains modernos, `observer` debería seguir avanzando. Esa observación es justamente la intuición de preemption asíncrona.

---

## Cómo medir efectos del scheduler sin autoengañarte

Si querés comparar estrategias de concurrencia, medí con herramientas que reflejen scheduling real y no ruido de benchmark.

Comandos útiles:

```bash
go test -bench=. -benchmem
```

y para perfil CPU:

```bash
go test -bench=. -cpuprofile=cpu.out
go tool pprof cpu.out
```

No hay una "métrica mágica" única del scheduler. Buscá evidencia de:

- `P` subutilizados,
- contención,
- explosión de goroutines con bajo throughput,
- bloqueos excesivos,
- unfairness entre trabajo CPU-bound y sensible a latencia.

Insight de scheduler sirve más cuando está atado a un síntoma concreto: colas runnable crecientes, cola de latencia, bajo uso de CPU o throughput por debajo de lo esperado.

---

## Reglas prácticas para equipos

Cuando un servicio Go en producción se comporta mal bajo concurrencia, estas preguntas suelen ser más útiles que recomendaciones genéricas:

1. ¿la carga es CPU-bound, I/O-bound o mixta?
2. ¿`GOMAXPROCS` es razonable para ese entorno?
3. ¿las goroutines bloquean mucho en syscalls o llamadas externas?
4. ¿las trazas muestran runnable acumulado con processors ociosos?
5. ¿hay un loop caliente monopolizando ejecución?

Y algo igual de importante: entender internals del scheduler no significa intentar reemplazarlo manualmente. El objetivo es reconocer cuándo su comportamiento explica el comportamiento del sistema.

---

## Especificación de ilustraciones

### 1. Mapa GMP

Diagrama con tres nodos grandes:

- `G`: goroutine, stack, estado,
- `M`: thread del SO,
- `P`: recurso de scheduling / token de ejecución.

Mostrar que un `M` necesita un `P` para ejecutar una `G`.

### 2. Colas locales y work stealing

Mostrar varios `P` con colas locales. Uno sin trabajo roba parte de la cola de otro. Incluir cola global lateral pero visualmente secundaria.

### 3. Handoff en syscall bloqueante

Timeline de cuatro pasos:

1. `G` corre en `M1` con `P1`,
2. `G` entra syscall bloqueante,
3. `P1` se desacopla,
4. `M2` toma `P1` y ejecuta otra `G`.

Mensaje visual: thread bloqueado no debe secuestrar recurso de scheduling.

### 4. Cooperativa vs asíncrona

Panel doble:

- izquierda: loop largo espera safe point,
- derecha: runtime interrumpe asíncronamente.

Énfasis en fairness y capacidad de respuesta.

### 5. Reinyección desde netpoll

Mostrar goroutines esperando en poller de red y luego reinsertadas como runnable en cola de un `P` al recibir eventos de readiness.

---

## Cierre

El scheduler GMP es la razón por la que Go puede hacer que la concurrencia se sienta simple sin volver simplista al runtime.

Cuando entendés G, M y P como roles distintos, varios comportamientos dejan de parecer mágicos: work stealing, handoff de syscalls, netpoll wakeups y preemption pasan a ser piezas coherentes del mismo sistema.

En la Parte 3 pasamos de scheduling a dispatch: cómo Go representa interfaces en memoria, cómo resuelve métodos en runtime y cuándo el compilador puede eliminar parte de la dinámica vía de-virtualización.

---

## Navegacion de la Serie

- [Indice de la Serie](/posts/go-runtime-series-index)
- Anterior: [Parte 1 - Gestion de Memoria en Go: El Viaje al Ensamblador y el Escape Analysis](/posts/go-memory-escape-analysis)
- Siguiente: [Parte 3 - Interfaces en Go: iTable, Layout Interno y De-virtualizacion](/posts/go-interfaces-itables-devirtualization)
---
title: "Concurrencia en Go: La Anatomía Interna del Scheduler GMP"
subtitle: "G, M, P, Work Stealing, Syscalls, Preemption"
date: 2026-06-13
author: "@SilentGopher"
description: "Un deep dive en los internos del scheduler de Go: las estructuras G, M y P, work stealing, handoff de syscalls, netpolling y la evolución de la preemption cooperativa a la asíncrona."
tags: ["Go", "Go Runtime", "Concurrency", "Scheduler", "Performance", "GMP"]
draft: false
---

> Las goroutines son baratas, pero no son magia. Son el resultado de un scheduler que trabaja muy duro para que la concurrencia se sienta simple.

<!--more-->

Cuando la gente explica concurrencia en Go, muchas veces se queda en "las goroutines son lightweight threads". Esa frase le sirve a un principiante y es peligrosamente incompleta para todos los demás.

Las goroutines no son threads. Son unidades de trabajo planificadas por el runtime de Go. Y la maquinaria que las vuelve prácticas a escala es el **scheduler GMP**.

En este artículo vamos a explicar esa maquinaria desde adentro hacia afuera:

1. qué representan realmente G, M y P,
2. cómo se mueve el trabajo entre colas locales y la cola global,
3. cómo work stealing preserva throughput,
4. qué pasa durante syscalls bloqueantes,
5. y cómo la preemption pasó de cooperativa a asíncrona.

También vamos a correr código que produzca comportamiento observable del scheduler, porque la teoría del runtime se vuelve mucho más confiable cuando podés hacerla hablar.

> **Nota de serie:** esta es la Parte 2 de la serie sobre internos de Go. La Parte 1 cubrió escape analysis y memory placement. La Parte 3 cubrirá internos de interfaces y de-virtualización.

---

## El Problema Que el Scheduler Tiene Que Resolver

Go quiere dejarte crear enormes cantidades de tareas concurrentes sin obligar al sistema operativo a manejar un kernel thread por tarea.

Eso significa que el runtime necesita su propio scheduler.

Ese scheduler tiene que responder eficientemente un conjunto duro de preguntas:

- ¿qué goroutine corre después?
- ¿en qué OS thread corre?
- ¿cuántos contextos lógicos pueden ejecutar Go code al mismo tiempo?
- ¿qué pasa cuando una goroutine en ejecución se bloquea en una syscall?
- ¿cómo encuentran trabajo los procesadores ociosos sin centralizar todo detrás de un lock gigante?

Go responde estas preguntas con tres estructuras centrales del runtime: **G**, **M** y **P**.

---

## G, M y P: El Modelo de Tres Cuerpos del Scheduler de Go

### G: Goroutine

`G` es la representación en runtime de una goroutine.

Conceptualmente incluye:

- el stack de la goroutine,
- el instruction pointer y el estado de registros necesario para reanudarla,
- metadata de scheduling,
- y bookkeeping como reason de espera o status.

Si pensás en "tarea" o "continuación", estás bastante cerca.

### M: Machine

`M` representa un operating system thread administrado por el runtime.

Un `M` ejecuta Go code, realiza syscalls y puede ser parked o reanudado por el scheduler. Pero un `M` por sí solo no alcanza para ejecutar Go normal.

### P: Processor

`P` es el recurso del runtime que le da a un `M` permiso para ejecutar Go code.

Esta es la pieza que más explicaciones se saltean, y es la pieza que hace funcionar al modelo.

Un `P` es dueño de recursos locales al scheduler, incluida la local run queue de goroutines runnable. La cantidad de `P`s suele ser el valor de `GOMAXPROCS`.

Eso significa que:

- pueden existir muchísimas goroutines,
- pueden existir varios threads,
- pero solo pueden ejecutar Go code simultáneamente tantas goroutines como `P`s haya.

Podés pensar en `P` como el token de ejecución CPU-bound para Go.

---

## El Scheduling Loop Central

A alto nivel, el loop estable del scheduler se ve así:

1. un `M` posee un `P`,
2. ese `P` tiene una local run queue de `G`s runnable,
3. el `M` toma una `G` de esa cola y la ejecuta,
4. cuando la `G` se bloquea, cede, termina o es preempted, el scheduler elige la siguiente unidad de trabajo.

Ese loop se vuelve interesante recién cuando el trabajo está desbalanceado. Algunos procesadores quedan ociosos mientras otros tienen colas profundas. Ahí entra work stealing.

---

## Work Stealing: Throughput Sin un Cuello de Botella Central

Si todas las goroutines runnable vivieran en una única cola global, cada decisión de scheduling contendría sobre la misma estructura compartida. Eso escalaría mal.

Go evita eso manteniendo la mayor parte del trabajo runnable en **colas locales por P**.

Cuando un `P` se queda sin trabajo local, no se va inmediatamente a idle. Primero intenta robar goroutines runnable desde otro `P`.

Esta estrategia importa porque le da al scheduler dos propiedades muy valiosas:

1. scheduling local rápido en el caso común,
2. balanceo de carga sin obligar a que toda operación pase por un lock global.

La global queue sigue existiendo, pero no es el destino por defecto de cada goroutine runnable.

---

## Hacer Hablar al Scheduler: Un Demo Ejecutable

Acá hay un programa pequeño que genera trabajo desparejo y te da algo observable.

```go
package main

import (
	"fmt"
	"runtime"
	"sync"
	"time"
)

func cpuBound(id int, wg *sync.WaitGroup) {
	defer wg.Done()

	var sum uint64
	for i := 0; i < 80_000_000; i++ {
		sum += uint64(i % (id + 1))
	}

	if sum == 42 {
		fmt.Println("impossible")
	}
}

func main() {
	runtime.GOMAXPROCS(2)

	var wg sync.WaitGroup
	start := time.Now()

	for i := 1; i <= 8; i++ {
		wg.Add(1)
		go cpuBound(i, &wg)
	}

	wg.Wait()
	fmt.Println("done in", time.Since(start))
}
```

Ejecutalo normalmente primero:

```bash
go run main.go
```

Después pedile trazas al runtime:

```bash
set GODEBUG=schedtrace=1000,scheddetail=1
go run main.go
```

En PowerShell también podés hacer:

```powershell
$env:GODEBUG = "schedtrace=1000,scheddetail=1"
go run main.go
```

Qué mirar en el trace:

- cantidad de `P`s,
- goroutines runnable,
- threads activos vs idle,
- si el sistema se estabiliza o sigue rebotando entre runnable e idle.

El output es ruidoso, pero entrena el instinto correcto. Dejás de ver goroutines como green threads abstractos y empezás a ver un scheduler vivo manejando oferta y demanda.

---

## Qué Pasa Durante una Blocking Syscall

Un scheduler que solo manejara trabajo puramente CPU-bound sería sencillo. Los programas reales llaman al sistema operativo.

Supongamos que una goroutine realiza una blocking syscall sobre un `M` que actualmente posee un `P`.

Si el runtime no hiciera nada, ese `P` quedaría varado detrás de un OS thread bloqueado. Go evita eso desacoplando el `P` para que otros threads puedan seguir ejecutando Go code.

La idea general es:

1. la goroutine entra en una blocking syscall,
2. el `M` actual puede bloquearse en el kernel,
3. el runtime libera o entrega el `P`,
4. otro `M` puede adjuntarse a ese `P` y seguir scheduling Go work.

Ese handoff es esencial para la concurrencia bajo cargas mixtas de CPU e I/O.

Acá hay un ejemplo pequeño que mezcla trabajo de CPU con una espera bloqueante usando `time.Sleep` como reemplazo pedagógico de una espera real:

```go
package main

import (
	"fmt"
	"runtime"
	"sync"
	"time"
)

func busy(wg *sync.WaitGroup) {
	defer wg.Done()
	var total uint64
	for i := 0; i < 100_000_000; i++ {
		total += uint64(i)
	}
	if total == 0 {
		fmt.Println("never")
	}
}

func sleepy(wg *sync.WaitGroup) {
	defer wg.Done()
	time.Sleep(2 * time.Second)
}

func main() {
	runtime.GOMAXPROCS(1)

	var wg sync.WaitGroup
	wg.Add(2)

	go busy(&wg)
	go sleepy(&wg)

	wg.Wait()
	fmt.Println("finished")
}
```

El ejemplo es intencionalmente simple, pero ayuda a fijar la pregunta correcta: **¿una goroutine bloqueada también bloquea la capacidad de otras goroutines de ejecutar Go code?**

Con el handoff correcto de `P`, muchas veces la respuesta es no.

---

## Netpolling: Por Qué los Servidores de Red Escalan Distinto

No toda espera se maneja igual.

Para network I/O, Go integra un poller para que las goroutines bloqueadas esperando sockets no requieran un OS thread parked por conexión. Esa es una de las razones por las que Go puede manejar grandes cantidades de operaciones de red concurrentes de forma eficiente.

No hace falta abrir todo el runtime source para tener el modelo correcto:

- las goroutines esperando network readiness no están simplemente quemando threads,
- los eventos de readiness hacen que el trabajo vuelva a estar runnable,
- el scheduler y el netpoller cooperan para reinsertar ese trabajo en el loop de scheduling.

Esa cooperación es una parte importante de por qué "las goroutines son baratas" es suficientemente cierto en servidores reales.

---

## Preemption Cooperativa: El Mundo Viejo

Históricamente, Go dependía más fuertemente de la **preemption cooperativa**.

Eso significa que una goroutine en ejecución típicamente cedía control en safe points como:

- function calls,
- operaciones de canal,
- operaciones bloqueantes,
- ciertos chequeos del runtime.

Esto funcionaba, pero tenía un edge case feo: un loop CPU-bound largo sin safe points útiles podía retrasar la fairness del scheduler y el progreso del garbage collector.

En la práctica, un loop mal portado podía comportarse como un abusador.

---

## Preemption Asíncrona: El Scheduler Moderno

Las versiones modernas de Go introdujeron **preemption asíncrona** para corregir esos loops largos.

A alto nivel, el runtime ahora puede interrumpir goroutines en ejecución de manera más agresiva, incluso si no alcanzan voluntariamente un punto clásico de scheduling con suficiente rapidez.

Eso cambió el comportamiento del scheduler de maneras importantes:

1. los loops largos de CPU tienen menos capacidad de monopolizar ejecución,
2. mejora la fairness del scheduler,
3. las pausas stop-the-world y la coordinación del GC se vuelven más robustas frente a cargas hostiles.

Podés demostrar la intuición con un loop deliberadamente apretado:

```go
package main

import (
	"fmt"
	"runtime"
	"time"
)

func spinner() {
	for {
	}
}

func observer() {
	for i := 0; i < 5; i++ {
		fmt.Println("observer tick", i)
		time.Sleep(200 * time.Millisecond)
	}
}

func main() {
	runtime.GOMAXPROCS(1)
	go spinner()
	observer()
}
```

Ejecutalo con un toolchain actual de Go. Que `observer` siga avanzando es exactamente el tipo de comportamiento que antes era más frágil bajo un modelo puramente cooperativo.

Esto no es una prueba perfecta de cada detalle de implementación, pero sí es un experimento docente muy útil sobre el contrato que el scheduler expone al usuario.

---

## Cómo Medir Efectos del Scheduler con Cuidado

Si querés comparar estrategias de concurrencia, necesitás mediciones que reflejen comportamiento del scheduler y no artifacts aleatorios del benchmark.

Comandos útiles:

```bash
go test -bench=. -benchmem
```

y para CPU profiles:

```bash
go test -bench=. -cpuprofile=cpu.out
go tool pprof cpu.out
```

Lo que estás buscando no es una métrica mística única del scheduler. Estás buscando evidencia de:

- procesadores subutilizados,
- contención,
- explosión de goroutines con poco throughput,
- bloqueo excesivo,
- o unfairness entre trabajo CPU-bound y trabajo sensible a latencia.

El conocimiento del scheduler es más útil cuando está atado a un problema concreto: latencia alta en la cola larga, throughput pobre, mala saturación de CPU o crecimiento sospechoso de goroutines runnable.

---

## Reglas Prácticas para Equipos de Ingeniería

Cuando un servicio Go se comporta raro bajo concurrencia, estas preguntas suelen servir más que el consejo vago de "usar bien las goroutines":

1. ¿La carga es CPU-bound, I/O-bound o mixta?
2. ¿`GOMAXPROCS` tiene sentido para el entorno?
3. ¿Las goroutines se bloquean seguido en syscalls o llamadas externas?
4. ¿Los traces muestran trabajo runnable acumulándose mientras hay procesadores ociosos?
5. ¿Hay un hot loop monopolizando ejecución?

Y algo igual de importante: no uses los internos del scheduler como excusa para intentar simular manualmente su trabajo. El objetivo no es reemplazar al runtime. El objetivo es reconocer cuándo el comportamiento del runtime explica el comportamiento del sistema.

---

## Brief de Ilustraciones para Diseño

### 1. El Triángulo GMP

Dibujar tres nodos grandes etiquetados:

- `G`: goroutine, stack, estado,
- `M`: OS thread,
- `P`: recurso de scheduler / token de ejecución.

Usar flechas para mostrar que un `M` necesita poseer un `P` para ejecutar una `G`.

### 2. Colas Locales y Work Stealing

Mostrar cuatro `P`s, cada uno con una cola local pequeña de goroutines. Uno de los `P`s debe estar vacío y robando la mitad del trabajo runnable desde otra cola. Agregar una global queue pequeña a un costado, pero visualmente menos protagonista.

### 3. Blocking Syscall Handoff

Crear una línea de tiempo:

1. `G` corre sobre `M1` con `P1`,
2. `G` entra en blocking syscall,
3. `P1` se desacopla,
4. `M2` toma `P1` y ejecuta otra goroutine.

La idea visual es mostrar que el thread bloqueado no puede secuestrar el recurso de scheduling.

### 4. Preemption Cooperativa vs Asíncrona

Usar un panel lado a lado.

- Izquierda: loop largo continúa hasta alcanzar un safe point.
- Derecha: el runtime interrumpe la ejecución larga de forma asíncrona.

El énfasis visual debe estar en fairness y capacidad de respuesta del scheduler, no en la mecánica de señales de bajo nivel.

### 5. Reinserción Desde Netpoll

Mostrar goroutines esperando sockets dentro de una caja de poller y luego volviendo a una local run queue de un `P` cuando aparece un evento de readiness. La imagen tiene que transmitir la idea de "wake-up path" de vuelta al scheduling loop.

---

## Cierre

El scheduler GMP es la razón por la que Go puede hacer que la concurrencia se sienta simple sin volver simplista al runtime.

Una vez que entendés G, M y P como roles separados, varios comportamientos del runtime dejan de parecer mágicos: work stealing, handoff de syscalls, wakeups del poller y preemption pasan a verse como piezas coherentes del mismo sistema.

En la Parte 3 vamos a movernos de scheduling a dispatch: cómo Go representa interfaces en memoria, cómo las tablas de métodos impulsan llamadas dinámicas y cuándo el compilador puede eliminar completamente ese dispatch dinámico.