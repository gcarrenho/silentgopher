---
title: "Concurrency in Go: The Internal Anatomy of the GMP Scheduler"
subtitle: "G, M, P, Work Stealing, Syscalls, Preemption"
date: 2026-06-13
author: "@SilentGopher"
description: "A deep dive into Go's scheduler internals: the G, M, and P structures, work stealing, syscall handoff, netpolling, and the evolution from cooperative to asynchronous preemption."
image: "/images/posts/go-scheduler-gmp/cover.svg"
tags: ["Go", "Go Runtime", "Concurrency", "Scheduler", "Performance", "GMP"]
draft: true
---

> Goroutines are cheap, but they are not magic. They are the product of a scheduler that works very hard to make concurrency look simple.

<!--more-->

When people explain Go concurrency, they often stop at "goroutines are lightweight threads". That phrase is useful for a beginner and dangerously incomplete for everyone else.

Goroutines are not threads. They are scheduled units of work managed by the Go runtime. And the machinery that makes them practical at scale is the **GMP scheduler**.

This article explains that machinery from the inside out:

1. what G, M, and P actually represent,
2. how work moves through local and global run queues,
3. how work stealing preserves throughput,
4. what happens during blocking syscalls,
5. and how preemption changed from cooperative to asynchronous.

We will also run code that produces visible scheduler behavior, because scheduler theory is much easier to trust when you can make it talk.

> **Series note:** this is Part 2 of the Go internals series. Part 1 covered escape analysis and memory placement. Part 3 will cover interface internals and de-virtualization.

---

## The Problem the Scheduler Must Solve

Go wants to let you create huge numbers of concurrent tasks without forcing the operating system to manage one kernel thread per task.

That means the runtime needs its own scheduler.

The scheduler has to answer a hard set of questions efficiently:

- Which goroutine runs next?
- On which OS thread does it run?
- How many logical execution contexts may run Go code at the same time?
- What happens when one running goroutine blocks in a syscall?
- How do idle processors find work without centralizing everything behind a giant lock?

Go answers those questions with three core runtime structures: **G**, **M**, and **P**.

---

## G, M, and P: The Three-Body Model of Go Scheduling

### G: Goroutine

`G` is the runtime's representation of a goroutine.

Conceptually it includes:

- the goroutine stack,
- the instruction pointer and register state needed to resume execution,
- scheduling metadata,
- and bookkeeping such as wait reason or status.

If you think "task" or "continuation", you are in the right mental neighborhood.

### M: Machine

`M` represents an operating system thread managed by the runtime.

An `M` executes Go code, performs syscalls, and can be parked or resumed by the scheduler. But an `M` alone is not enough to run regular Go code.

### P: Processor

`P` is the runtime resource that gives an `M` permission to execute Go code.

This is the piece most explanations skip, and it is the piece that makes the model work.

A `P` owns scheduler-local resources, including the local run queue of runnable goroutines. The number of `P`s is typically the value of `GOMAXPROCS`.

That means:

- many goroutines may exist,
- many threads may exist,
- but only as many goroutines may execute Go code simultaneously as there are `P`s.

You can think of `P` as the token for CPU-bound Go execution.

---

## The Core Scheduling Loop

At a high level, the steady-state loop looks like this:

1. an `M` owns a `P`,
2. that `P` has a local run queue of runnable `G`s,
3. the `M` picks a `G` from that queue and runs it,
4. when the `G` blocks, yields, completes, or is preempted, the scheduler picks the next unit of work.

That loop becomes interesting only when work is unevenly distributed. Some processors go idle while others have deep queues. That is where work stealing enters.

---

## Work Stealing: Throughput Without a Central Bottleneck

If all runnable goroutines lived in one global queue, every scheduling decision would contend on the same shared structure. That would scale badly.

Go avoids that by keeping most runnable work in **per-P local queues**.

When a `P` runs out of local work, it does not immediately go idle. It tries to steal runnable goroutines from another `P`.

This strategy matters because it gives the scheduler two important properties:

1. fast local scheduling in the common case,
2. load balancing without forcing every operation through one global lock.

The global queue still exists, but it is not the default destination for every runnable goroutine.

---

## Make the Scheduler Speak: A Runnable Demo

Here is a small program that creates uneven work and gives you something to observe.

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

Run it normally first:

```bash
go run main.go
```

Then ask the runtime for scheduler traces:

```bash
set GODEBUG=schedtrace=1000,scheddetail=1
go run main.go
```

On PowerShell, you can also do:

```powershell
$env:GODEBUG = "schedtrace=1000,scheddetail=1"
go run main.go
```

What to look for in the trace:

- number of `P`s,
- runnable goroutines,
- idle vs active threads,
- whether the system stabilizes or keeps bouncing between runnable and idle states.

The trace output is noisy, but it trains the right instincts. You stop seeing goroutines as abstract green threads and start seeing a live scheduler managing supply and demand.

---

## What Happens During a Blocking Syscall

A scheduler that only handled pure CPU work would be simple. Real programs call the operating system.

Suppose a goroutine performs a blocking syscall on an `M` that currently owns a `P`.

If the runtime did nothing, that `P` would be stranded behind a blocked OS thread. Go avoids that by detaching the `P` so other threads can continue executing Go code.

The rough idea is:

1. goroutine enters blocking syscall,
2. the current `M` may block in the kernel,
3. the runtime releases or hands off the `P`,
4. another `M` can attach to that `P` and keep scheduling Go work.

That handoff is essential for concurrency under mixed CPU and I/O workloads.

Here is a small example that mixes CPU work with blocking I/O-like behavior using `time.Sleep` as a stand-in for waiting:

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

This example is intentionally simple, but it helps establish the scheduler question you should always ask: **does a blocked goroutine also block the ability of other goroutines to execute Go code?**

With proper `P` handoff, the answer is often no.

---

## Netpolling: Why Network Servers Scale Differently

Not all waiting is handled the same way.

For network I/O, Go integrates a poller so goroutines blocked on sockets do not require one parked OS thread per connection. This is one of the reasons Go can drive large numbers of concurrent network operations efficiently.

You do not need the full runtime source open to keep the correct mental model:

- goroutines waiting on network readiness are not simply burning threads,
- readiness events allow work to become runnable again,
- the scheduler and netpoller cooperate so runnable network work re-enters the scheduling loop.

That cooperation is a major part of why "goroutines are cheap" is true enough in real servers.

---

## Cooperative Preemption: The Old World

Historically, Go relied more heavily on **cooperative preemption**.

That means a running goroutine would typically give up control at safe points such as:

- function calls,
- channel operations,
- blocking operations,
- certain runtime checks.

This worked, but it had an ugly edge case: a long-running CPU-bound loop with no useful safe point could delay scheduler fairness and garbage collection progress.

In practice, one badly behaved loop could act like a bully.

---

## Asynchronous Preemption: The Modern Scheduler

Modern Go introduced **asynchronous preemption** to address those long-running loops.

At a high level, the runtime can now interrupt running goroutines more aggressively, even if they do not voluntarily reach a classic scheduling point quickly enough.

That changed the scheduler's behavior in important ways:

1. long CPU loops are less able to monopolize execution,
2. scheduler fairness improves,
3. stop-the-world pauses and GC coordination become more robust under hostile workloads.

You can demonstrate the intuition with a deliberately tight loop:

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

Run it with a current Go toolchain. The existence of progress in `observer` is exactly the kind of behavior that used to be more fragile under a purely cooperative model.

This is not a perfect proof of implementation details, but it is a good teaching experiment for the scheduler contract exposed to users.

---

## Benchmarking Scheduler Effects Carefully

If you want to compare concurrency strategies, you need measurements that reflect scheduler behavior instead of random benchmark artifacts.

Useful commands include:

```bash
go test -bench=. -benchmem
```

and for CPU profiles:

```bash
go test -bench=. -cpuprofile=cpu.out
go tool pprof cpu.out
```

What you are looking for is not a mythical single scheduler metric. You are looking for evidence of:

- underutilized processors,
- contention,
- goroutine explosion with poor throughput,
- excessive blocking,
- or unfairness between CPU-bound and latency-sensitive work.

Scheduler insight is most useful when tied to a concrete complaint: high latency tails, low throughput, poor CPU saturation, or suspicious runnable goroutine growth.

---

## Practical Rules for Engineering Teams

When a production Go service behaves strangely under concurrency, these questions are usually more useful than vague advice about "using goroutines correctly":

1. Is the workload CPU-bound, I/O-bound, or mixed?
2. Is `GOMAXPROCS` sensible for the environment?
3. Are goroutines frequently blocking in syscalls or external calls?
4. Do traces show runnable work piling up while processors sit idle?
5. Is one hot loop monopolizing execution?

And just as important: do not treat scheduler internals as an excuse to outsmart the runtime blindly. The goal is not to manually simulate scheduling. The goal is to recognize when runtime behavior explains system behavior.

---

## Illustration Brief for the Designer

### 1. The GMP Triangle

Draw three large labeled nodes:

- `G`: goroutine, stack, state,
- `M`: OS thread,
- `P`: scheduler resource / execution token.

Use arrows to show that an `M` must own a `P` to execute a `G`.

### 2. Local Queues and Work Stealing

Show four `P`s, each with a small local queue of goroutines. One `P` should be empty and stealing half the runnable work from another queue. Include a smaller global queue off to the side, but visually de-emphasize it.

### 3. Blocking Syscall Handoff

Create a timeline:

1. `G` runs on `M1` with `P1`,
2. `G` enters blocking syscall,
3. `P1` detaches,
4. `M2` picks up `P1` and runs another goroutine.

The point of the image is to show that the blocked thread is not allowed to strand the scheduler resource.

### 4. Cooperative vs Asynchronous Preemption

Use a side-by-side panel.

- Left: long loop continues until a safe point.
- Right: runtime interrupts long-running execution asynchronously.

The visual emphasis should be fairness and scheduler responsiveness, not low-level signal mechanics.

### 5. Netpoll Reinsertion

Show goroutines waiting on sockets in a poller box, then becoming runnable again and re-entering a `P` run queue. This should feel like a wake-up path back into scheduling.

---

## Closing

The GMP scheduler is the reason Go can make concurrency feel simple without making the runtime simplistic.

Once you understand G, M, and P as separate roles, several runtime behaviors stop feeling magical: work stealing, syscall handoff, poller wakeups, and preemption all become coherent pieces of the same system.

In Part 3, we will move from scheduling to dispatch: how Go represents interfaces in memory, how method tables drive dynamic calls, and when the compiler can eliminate the dynamic dispatch entirely.---
title: "Go Concurrency Under the Hood: Inside the GMP Scheduler"
subtitle: "G, M, P, Work Stealing, and Preemption"
date: 2026-06-14
author: "@SilentGopher"
description: "A practical deep dive into Go's runtime scheduler, including G, M, P, work stealing, blocking syscalls, and asynchronous preemption."
tags: ["Go", "Go Runtime", "Concurrency", "Scheduler", "Performance", "GMP"]
draft: false
---

> Goroutines are cheap because the runtime works hard to make them cheap.

<!--more-->

Go's concurrency story is often summarized with a slogan: "goroutines are lightweight threads." That is useful for a beginner, but technically incomplete. Goroutines are not threads. They are scheduled units of work managed by the runtime, multiplexed onto a smaller set of operating system threads through the GMP scheduler.

This article is the second part of the series:

- [Part 1: Stack vs Heap, Escape Analysis, and Assembly](/posts/go-memory-escape-analysis)
- [Part 3: iTables, iface, eface, and Devirtualization](/posts/go-interfaces-itables-devirtualization)

We will focus on the scheduler's real moving parts: the `G`, `M`, and `P` structures; local and global run queues; work stealing; what happens during blocking syscalls; and why asynchronous preemption changed the latency profile of Go programs.

---

## The Three Actors: G, M, and P

The simplest accurate summary of the scheduler is this:

- `G` is a goroutine: the logical unit of execution.
- `M` is a machine: an operating system thread managed by the runtime.
- `P` is a processor: a scheduling token with resources required to execute Go code.

Most confusion disappears once `P` is understood correctly. A `P` is not a CPU core. It is the runtime context an `M` needs in order to run Go code: run queue, allocator caches, and other scheduler-local state.

That is why an `M` can exist without actively executing Go code, and why the number of active `P`s is controlled by `GOMAXPROCS`.

If `GOMAXPROCS=4`, the runtime can execute Go code on at most four `P`s at once, even if more goroutines are runnable.

---

## A Runnable Goroutine's Journey

When a goroutine becomes runnable, the scheduler tries to keep it close to the place where it was created or resumed.

The usual path looks like this:

1. the goroutine is placed on a local run queue attached to a `P`,
2. an `M` holding that `P` executes it,
3. if it blocks, yields, or finishes, the scheduler picks another runnable goroutine.

Locality matters here. Per-`P` queues reduce contention compared with a single global queue, and they improve cache behavior because work tends to stay near the thread that recently touched it.

The global queue still exists, but it is not the preferred path. It acts more like a coordination point and overflow mechanism.

---

## Seeing the Scheduler in Action

Start with a small CPU-bound program:

```go
package main

import (
	"fmt"
	"runtime"
	"sync"
	"time"
)

func worker(id int, wg *sync.WaitGroup) {
	defer wg.Done()

	var sum uint64
	for i := 0; i < 40_000_000; i++ {
		sum += uint64(i ^ id)
	}

	fmt.Println("worker", id, "sum", sum)
}

func main() {
	runtime.GOMAXPROCS(2)

	var wg sync.WaitGroup
	start := time.Now()

	for i := 0; i < 6; i++ {
		wg.Add(1)
		go worker(i, &wg)
	}

	wg.Wait()
	fmt.Println("elapsed:", time.Since(start))
}
```

Run it with scheduler tracing enabled:

```bash
GODEBUG=schedtrace=1000,scheddetail=1 go run main.go
```

On Windows PowerShell, use:

```powershell
$env:GODEBUG="schedtrace=1000,scheddetail=1"
go run main.go
```

This produces periodic scheduler snapshots. The exact formatting changes across Go releases, but the useful signals are stable:

- number of processors (`P`s),
- number of threads (`M`s),
- runnable goroutines,
- local queue lengths,
- idle vs active scheduler state.

You are not looking for a single magic number. You are trying to correlate your workload with runtime behavior.

---

## Work Stealing: Why Idle P's Do Not Stay Idle for Long

Per-`P` run queues are great for locality, but they create an obvious risk: imbalance. One `P` can have plenty of work while another goes idle.

That is where work stealing enters.

When a `P` runs out of local work, the scheduler does not immediately give up and sleep the thread. It first tries to steal runnable goroutines from another `P`'s queue. This keeps CPUs busy without turning every scheduling operation into a global lock contention event.

You can observe the effect by increasing asymmetry in the previous program:

```go
package main

import (
	"runtime"
	"sync"
)

func heavy(n int) uint64 {
	var sum uint64
	for i := 0; i < n; i++ {
		sum += uint64(i*i + i)
	}
	return sum
}

func main() {
	runtime.GOMAXPROCS(2)

	var wg sync.WaitGroup
	jobs := []int{100_000_000, 5_000_000, 100_000_000, 5_000_000, 100_000_000, 5_000_000}

	for _, n := range jobs {
		wg.Add(1)
		go func(n int) {
			defer wg.Done()
			_ = heavy(n)
		}(n)
	}

	wg.Wait()
}
```

Run it with the same `schedtrace` settings and watch how runnable work gets redistributed. Work stealing is one of the key reasons Go handles bursty fan-out patterns well without requiring you to manually partition tasks by thread.

---

## What Happens During Blocking Syscalls

A scheduler that only handled CPU-bound work would be easy. Real systems block.

If a goroutine enters a blocking syscall, the runtime must preserve overall progress. The critical design rule is this: a blocked thread must not take a `P` out of circulation longer than necessary.

Conceptually, the runtime does the following:

1. a goroutine enters a syscall on an `M`,
2. if that syscall blocks, the `M` may release its `P`,
3. another `M` can pick up that `P` and continue running Go code,
4. when the syscall returns, the original goroutine becomes runnable again and is rescheduled.

That handoff is one of the reasons Go can keep making forward progress even when some goroutines are blocked in the operating system.

A practical demonstration is to mix CPU-bound work with socket I/O. Use this small program:

```go
package main

import (
	"io"
	"log"
	"net"
	"runtime"
	"sync"
	"time"
)

func cpuWorker(wg *sync.WaitGroup) {
	defer wg.Done()
	var x uint64
	for i := 0; i < 150_000_000; i++ {
		x += uint64(i)
	}
	_ = x
}

func ioWorker(wg *sync.WaitGroup, addr string) {
	defer wg.Done()
	conn, err := net.Dial("tcp", addr)
	if err != nil {
		log.Fatal(err)
	}
	defer conn.Close()

	_, _ = io.WriteString(conn, "ping")
	buf := make([]byte, 4)
	_, _ = io.ReadFull(conn, buf)
}

func main() {
	runtime.GOMAXPROCS(2)

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		log.Fatal(err)
	}
	defer ln.Close()

	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			go func(c net.Conn) {
				defer c.Close()
				time.Sleep(2 * time.Second)
				_, _ = c.Write([]byte("pong"))
			}(conn)
		}
	}()

	var wg sync.WaitGroup
	wg.Add(3)
	go cpuWorker(&wg)
	go cpuWorker(&wg)
	go ioWorker(&wg, ln.Addr().String())
	wg.Wait()
}
```

Run it again with `schedtrace`. The socket-based goroutine will spend time waiting, but the CPU-bound goroutines should continue to make progress. In practice, the networking path is often integrated with the runtime netpoller rather than behaving like an arbitrary raw blocking syscall, but it illustrates the central scheduling principle: blocked work must not stall unrelated runnable goroutines.

---

## Preemption: From Cooperative to Asynchronous

For a long time, Go relied primarily on cooperative safe points for scheduling. That meant a goroutine generally had to reach a function call, channel operation, blocking point, or another runtime-managed transition before the scheduler could reliably regain control.

That design worked, but it had a weakness: tight CPU loops with no safe points could delay scheduling fairness and garbage collection assistance.

Modern Go added asynchronous preemption to address this. The runtime can now interrupt running goroutines at more points, which dramatically improves scheduler responsiveness in pathological CPU-bound loops.

Try this program:

```go
package main

import (
	"fmt"
	"runtime"
	"time"
)

func busy() {
	var x uint64
	for {
		x++
		if x == 0 {
			fmt.Println("impossible")
		}
	}
}

func main() {
	runtime.GOMAXPROCS(1)
	go busy()

	ticker := time.NewTicker(200 * time.Millisecond)
	defer ticker.Stop()

	for i := 0; i < 5; i++ {
		<-ticker.C
		fmt.Println("main still making progress", i)
	}
}
```

On modern Go, `main` should keep printing. That is the practical consequence of asynchronous preemption: a runaway CPU loop no longer monopolizes the scheduler as easily as it once could.

If you want to inspect the effect in more detail, combine the program with scheduler trace output:

```bash
GODEBUG=schedtrace=1000,scheddetail=1 go run main.go
```

---

## Why This Matters in Real Systems

The scheduler is not just runtime trivia. It directly affects throughput, tail latency, and the way Go services behave under mixed workloads.

Three engineering consequences show up often:

- CPU-bound goroutines can starve others if you misunderstand safe points and preemption.
- Excessive blocking work changes the balance between available `P`s and useful progress.
- Scheduler-local queues mean locality and batching patterns can visibly affect performance.

If you care about latency under load, the scheduler is part of your application architecture whether you acknowledge it or not.

---

## Illustration Brief for the Design Pass

### 1. The GMP Architecture Map

Show three lanes labeled `G`, `M`, and `P`. Each `P` should have a local run queue. `M`s attach to `P`s, and `G`s move through queues into execution. The design should make it visually obvious that `P` is the scarce scheduling resource, not `G`.

### 2. Local Queue and Work Stealing Flow

Draw two `P`s side by side. One has a full queue; the other is empty. Add arrows showing the idle `P` attempting to steal work from the busy one. Include a smaller arrow toward the global queue to show that it exists but is not the default fast path.

### 3. Blocking Syscall Handoff

Create a four-step timeline:

1. `G1` runs on `M1` with `P1`.
2. `G1` enters a blocking syscall.
3. `P1` is detached and handed to `M2`.
4. `G2` continues on `M2` with `P1` while `M1` remains blocked.

This diagram should emphasize that progress continues because the `P` is not trapped behind the blocked thread.

### 4. Cooperative vs Asynchronous Preemption

Use a split-panel design. The left panel shows a tight loop delaying scheduler intervention until a safe point. The right panel shows the runtime interrupting execution asynchronously and allowing another goroutine to run. Add a short label about improved fairness and latency.

---

## Closing Thought

The GMP scheduler is the mechanism that turns goroutines from a pleasant language feature into a practical systems programming tool.

Once you understand `G`, `M`, `P`, work stealing, syscalls, and preemption as one coherent design, Go's concurrency behavior stops feeling magical and starts feeling inspectable.

In the next article, we move from scheduling to polymorphism: how interfaces are represented in memory, how method dispatch works at runtime, and when the compiler can turn a dynamic call back into a static one.

---

## Series Navigation

- [Series Index](/posts/go-runtime-series-index)
- Previous: [Part 1 - Memory Management in Go: The Trip to Assembly and Escape Analysis](/posts/go-memory-escape-analysis)
- Next: [Part 3 - Go Interfaces Under the Hood: iTables, iface, eface, and Devirtualization](/posts/go-interfaces-itables-devirtualization)