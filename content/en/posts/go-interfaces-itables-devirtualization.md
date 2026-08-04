---
title: "Go Interfaces Under the Hood: iTables, iface, eface, and Devirtualization"
subtitle: "Interface Layout and Dynamic Dispatch"
date: 2026-06-15
author: "@SilentGopher"
description: "An internal look at Go interfaces, including iface, eface, method tables, dynamic dispatch, and the compiler optimizations behind devirtualization."
image: "/images/posts/go-interfaces-itables-devirtualization/cover.svg"
tags: ["Go", "Go Runtime", "Interfaces", "Compiler", "Performance", "Assembly"]
draft: true
---

> Interfaces make code flexible. The runtime and compiler pay the bill unless they can prove they do not have to.

<!--more-->

Go interfaces are one of the language's best design choices. They let APIs depend on behavior instead of concrete types, which is exactly why they are everywhere in idiomatic code. But that abstraction is not free. Every interface value has a runtime representation, every method call has a dispatch path, and every conversion into an interface gives the compiler one more thing to reason about.

This article is the third part of the series:

- [Part 1: Stack vs Heap, Escape Analysis, and Assembly](/posts/go-memory-escape-analysis)
- [Part 2: Inside the GMP Scheduler](/posts/go-scheduler-gmp)

We will focus on three questions:

1. What does an interface value look like in memory?
2. How are methods resolved at runtime?
3. When can the compiler replace dynamic dispatch with a direct call?

---

## Two Shapes of Interface Values: `eface` and `iface`

Internally, Go distinguishes between two broad kinds of interface values.

- `eface` is the internal representation for the empty interface, now spelled `any` in everyday Go.
- `iface` is the representation for a non-empty interface that carries method requirements.

Conceptually, an empty interface needs two things:

1. a pointer to type metadata,
2. a pointer to the underlying data.

A non-empty interface needs one more layer: method resolution data. In practice, that means a pointer to metadata describing both the concrete type and how it satisfies the target interface.

You should never depend on runtime internal structs in production code. But for learning purposes, it is useful to mirror the shape with `unsafe`.

---

## Inspecting Interface Layout with `unsafe`

Use this program:

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

Run it with:

```bash
go run main.go
```

The exact addresses are not important. What matters is the shape:

- `any` stores type plus data,
- a non-empty interface stores method-table metadata plus data.

That extra indirection is why interface method dispatch has a different runtime profile from a direct call.

---

## Method Dispatch Through an Interface

Consider this example:

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

At the source level, `shape.Area()` looks like a normal method call. Internally, it is different from `square.Area()` on a concrete value.

With a concrete value, the compiler can emit a direct call or inline the method if profitable.

With an interface value, the runtime needs to:

1. identify the concrete type behind the interface,
2. find the correct method implementation through the interface metadata,
3. perform the call using that resolved target.

That dynamic dispatch cost is usually tiny, but in hot loops it is measurable.

---

## Comparing Direct Calls vs Interface Calls

Create a small benchmark file:

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

Run:

```bash
go test -bench=. -benchmem
```

What you usually see is not a dramatic difference in allocations, but a small throughput difference due to dynamic dispatch and the compiler's reduced optimization freedom.

The important lesson is not "never use interfaces." The lesson is that abstraction has a representation, and representation has a cost model.

---

## Where Escape Analysis Meets Interfaces

Interface conversions often interact with allocation behavior. Consider this example:

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

Inspect it with:

```bash
go build -gcflags="-m -m" main.go
```

Depending on the exact context and Go version, the compiler may report escape behavior around the interface conversion or the formatting path. The point is not that interfaces always allocate. They do not. The point is that crossing into an interface removes some information from the compiler's perspective and can make it more conservative.

This is especially visible in logging, formatting, and generic plumbing layers that accept `any`.

---

## Devirtualization: When the Compiler Turns Dynamic Back into Static

The most interesting optimization in this area is devirtualization.

Devirtualization happens when the compiler can prove the concrete type behind an interface call at compile time. If that proof succeeds, it can replace the indirect method dispatch with a direct call, which then unlocks further optimizations such as inlining.

Use this example:

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

Inspect the compiler output:

```bash
go build -gcflags="-m -m" main.go
```

Then inspect assembly:

```bash
go build -gcflags="-S" main.go
```

On recent Go releases, the compiler may report devirtualization opportunities directly in its optimization output. Even when the textual message changes across versions, assembly remains the ground truth: if the compiler can see a single concrete target, the emitted code may use a direct call path instead of an interface method lookup.

That is the key performance story here. Interfaces are dynamic by design, but Go's compiler is opportunistic. When it can recover static knowledge, it does.

---

## A Practical Rule for API Design

There is a mature middle ground between two bad extremes.

One bad extreme is to fear interfaces and manually specialize every code path. That usually produces rigid, unpleasant APIs.

The other bad extreme is to scatter interface boundaries through hot loops and critical inner functions without measuring the cost.

The better rule is this:

- use interfaces at architectural boundaries,
- keep hot paths concrete when the abstraction buys you nothing,
- benchmark before flattening design for performance reasons,
- inspect compiler output when the numbers suggest dispatch or escape is relevant.

That is how you stay idiomatic without becoming naive.

---

## Illustration Brief for the Design Pass

### 1. `eface` vs `iface` Memory Layout

Draw two side-by-side boxes. The `eface` box should contain `type pointer` and `data pointer`. The `iface` box should contain `itab pointer` and `data pointer`. Add a caption explaining that the method table indirection exists only for non-empty interfaces.

### 2. Dynamic Dispatch Flow

Create a left-to-right flow:

`interface value -> itab lookup -> concrete method address -> method call`

Under it, add a second shorter flow for concrete calls:

`concrete value -> direct call`

The diagram should make the extra step visually obvious.

### 3. Devirtualization Split View

Left panel: an interface call that remains indirect because multiple concrete implementations are possible.

Right panel: a compiler-proven single target that becomes a direct call. Add a small note that direct calls unlock later optimizations like inlining.

### 4. Interface Cost Map

Use a simple architecture map showing where interface abstraction is cheap and desirable, such as package boundaries and test seams, versus where it deserves scrutiny, such as tight loops, serialization pipelines, and frequently invoked adapters.

---

## Closing Thought

Interfaces are not slow. Unexamined assumptions about interfaces are slow.

Once you understand `eface`, `iface`, method tables, and devirtualization, interface-heavy Go code becomes easier to reason about both architecturally and mechanically.

That is the broader lesson of the entire series: Go's simplicity on the surface is real, but its performance characteristics come from concrete runtime and compiler decisions that you can inspect directly.

---

## Series Navigation

- [Series Index](/posts/go-runtime-series-index)
- Previous: [Part 2 - Concurrency in Go: The Internal Anatomy of the GMP Scheduler](/posts/go-scheduler-gmp)