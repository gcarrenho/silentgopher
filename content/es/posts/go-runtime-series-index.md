---
title: "Serie Internals de Go: Guia de Lectura Practica"
subtitle: "Indice de la Serie"
date: 2026-06-16
author: "@SilentGopher"
description: "Indice de la serie de 3 articulos sobre internals de Go: memoria y escape analysis, scheduler GMP e internals de interfaces con de-virtualizacion."
tags: ["Go", "Series", "Go Runtime", "Compiler", "Performance"]
series_index: true
draft: false
---

> Esta pagina es el punto de entrada para leer la serie completa de internals de Go.

<!--more-->

La serie esta pensada como un recorrido practico: desde comportamiento de memoria, pasando por scheduler, hasta dispatch de interfaces y optimizaciones del compilador.

Si queres leerla en orden, segui esta secuencia:

1. [Parte 1: Gestion de Memoria en Go - Stack vs Heap, Escape Analysis y Ensamblador](/posts/go-memory-escape-analysis)
2. [Parte 2: Concurrencia en Go - La Anatomia Interna del Scheduler GMP](/posts/go-scheduler-gmp)
3. [Parte 3: Interfaces en Go - iTable, iface, eface y De-virtualizacion](/posts/go-interfaces-itables-devirtualization)

## Que vas a aprender en la serie

- Como decide el compilador stack vs heap y como inspeccionarlo con `-gcflags="-m"`.
- Como se planifican goroutines con G, M y P, incluyendo work stealing y preemption.
- Como se representan internamente las interfaces, como se resuelven metodos y cuando la de-virtualizacion elimina parte del costo dinamico.

## Workflow recomendado al leer

1. Ejecutar localmente cada ejemplo de codigo.
2. Comparar diagnosticos del compilador entre ejemplos.
3. Validar hipotesis con `go test -bench=. -benchmem`.
4. Usar ensamblador como confirmacion, no como primer paso.

## Version en ingles

- [English Version: Go Runtime Internals Series (index)](/posts/go-runtime-series-index)
