---
title: "Go Runtime Internals Series: A Practical Reading Guide"
subtitle: "Series Index"
date: 2026-08-04
author: "@SilentGopher"
description: "Index for the 3-part Go runtime internals series: memory and escape analysis, GMP scheduler, and interface internals with devirtualization."
tags: ["Go", "Series", "Go Runtime", "Compiler", "Performance"]
series_index: true
draft: false
---

> This page is the reading hub for the Go runtime internals series.

<!--more-->

This series is designed as a practical path from memory behavior, to scheduling internals, to interface dispatch and compiler optimizations.

If you want to read in sequence, follow this order:

1. [Part 1: Memory Management in Go - Stack vs Heap, Escape Analysis, and Assembly](/posts/go-memory-escape-analysis)
2. [Part 2: Concurrency in Go - The Internal Anatomy of the GMP Scheduler](/posts/go-scheduler-gmp)
3. [Part 3: Go Interfaces Under the Hood - iTables, iface, eface, and Devirtualization](/posts/go-interfaces-itables-devirtualization)

## What You Will Learn Across the Series

- How the compiler decides stack vs heap and how to inspect it with `-gcflags="-m"`.
- How goroutines are scheduled through G, M, and P, including work stealing and preemption.
- How interfaces are represented internally, how method dispatch works, and when devirtualization can remove dynamic overhead.

## Suggested Workflow While Reading

1. Run every code sample locally.
2. Compare compiler diagnostics across examples.
3. Validate assumptions with `go test -bench=. -benchmem`.
4. Use assembly as confirmation, not as the first tool.

## Related Spanish Version

- [Serie en Espanol: Internals de Go (indice)](/es/posts/go-runtime-series-index)
