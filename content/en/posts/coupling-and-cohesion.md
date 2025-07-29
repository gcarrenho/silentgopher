---
title: "Coupling and Cohesion in Software Architecture (with Go Examples)"
subtitle: "Coupling and Cohesion"
date: "2025-06-15"
author: "@SilentGopher"
tags: ["Go", "Coupling", "Cohesion"]
image: "/images/posts/coupling-cohesion/coupling-cohesion.png"
draft: true
---

>When designing distributed or modular systems, understanding the relationship between coupling and cohesion is key to achieving a maintainable, flexible, and scalable architecture.

<!--more-->
Many teams easily fall into the trap of structural coupling, which compromises the independent evolution of modules and leads to fragile architecture.

In this article, we explore different types of coupling, their relationship with cohesion, and how to avoid them using real-world examples in Golang.

---

## Key Concepts

### Coupling

**Coupling** refers to the degree of dependency between two modules or contexts. The lower the coupling, the greater the freedom for each module to evolve independently.

#### Main Types:

<table style="border-collapse: collapse; width: 100%;">
  <thead>
    <tr>
      <th style="border: 1px solid #ccc; padding: 8px;">Tipo</th>
      <th style="border: 1px solid #ccc; padding: 8px;">¿Qué significa?</th>
      <th style="border: 1px solid #ccc; padding: 8px;">Ejemplo común</th>
      <th style="border: 1px solid #ccc; padding: 8px;">Ejemplo en Go</th>
      <th style="border: 1px solid #ccc; padding: 8px;">Problemas</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td style="border: 1px solid #ccc; padding: 8px;"><strong>Estructural</strong></td>
      <td style="border: 1px solid #ccc; padding: 8px;">Depende de estructuras internas del otro servicio</td>
      <td style="border: 1px solid #ccc; padding: 8px;">Compartir structs, enums</td>
      <td style="border: 1px solid #ccc; padding: 8px;">Ambos usan <code>Product struct</code> del mismo paquete</td>
      <td style="border: 1px solid #ccc; padding: 8px;">Cambiar un campo rompe ambos</td>
    </tr>
    <tr>
      <td style="border: 1px solid #ccc; padding: 8px;"><strong>Contractual</strong></td>
      <td style="border: 1px solid #ccc; padding: 8px;">Depende del contrato expuesto (API, payload)</td>
      <td style="border: 1px solid #ccc; padding: 8px;">gRPC, JSON API</td>
      <td style="border: 1px solid #ccc; padding: 8px;"><code>OrderService</code> espera JSON de <code>ProductService</code></td>
      <td style="border: 1px solid #ccc; padding: 8px;">Incompatibilidad ante cambios en contratos</td>
    </tr>
    <tr>
      <td style="border: 1px solid #ccc; padding: 8px;"><strong>Temporal</strong></td>
      <td style="border: 1px solid #ccc; padding: 8px;">Requiere disponibilidad inmediata del otro servicio</td>
      <td style="border: 1px solid #ccc; padding: 8px;">HTTP sincrónico</td>
      <td style="border: 1px solid #ccc; padding: 8px;"><code>OrderService</code> llama directamente</td>
      <td style="border: 1px solid #ccc; padding: 8px;">Falla uno, falla el otro</td>
    </tr>
    <tr>
      <td style="border: 1px solid #ccc; padding: 8px;"><strong>Lógico / Funcional</strong></td>
      <td style="border: 1px solid #ccc; padding: 8px;">Depende de la lógica interna del otro</td>
      <td style="border: 1px solid #ccc; padding: 8px;">Orquestación mal distribuida</td>
      <td style="border: 1px solid #ccc; padding: 8px;"><code>PaymentService</code> calcula descuentos</td>
      <td style="border: 1px solid #ccc; padding: 8px;">Dificulta refactor y separación de lógica</td>
    </tr>
    <tr>
      <td style="border: 1px solid #ccc; padding: 8px;"><strong>De despliegue</strong></td>
      <td style="border: 1px solid #ccc; padding: 8px;">Cambiar uno obliga a desplegar el otro</td>
      <td style="border: 1px solid #ccc; padding: 8px;">Repo compartido, DB común</td>
      <td style="border: 1px solid #ccc; padding: 8px;">–</td>
      <td style="border: 1px solid #ccc; padding: 8px;">Falta de independencia en releases</td>
    </tr>
  </tbody>
</table>

---

### Cohesion

**Cohesion** measures how closely related the responsibilities are within a module:

- High cohesion: All functions are aligned with a clear purpose.
- Low cohesion: The module mixes unrelated responsibilities without clear rationale.

**Ideal goal:** High cohesion + Low coupling.

---

## Real-world coupling examples (in Go) and their solutions

### 1. Structural Coupling

#### Problem

```go
// cart/service/cart_service.go
import "order/domain"

func (s *CartService) Checkout() {
    order := domain.Order{...} // Direct usage of Order struct from another context
}
```

### Consequences:

- Breaks context separation principle.
- Any change to `Order` breaks `Cart`.

### Solution:
Define a local contract:
```go
// cart/orderclient/order_client.go

// local DTO
type CreateOrderRequest struct {
    UserID string
    Items  []CartItem
}

type OrderClient interface {
    CreateOrder(req CreateOrderRequest) error
}

```

This contract can be implemented via HTTP or gRPC adapter.

---

### 2. Contractual Coupling

### Problem:

```go
// cart/service
resp, err := http.Post("http://order-service/orders", "application/json", body)

```

### Risk:

- Changes to the endpoint contract break `Cart`.

### Solution:

- UUse clear local interfaces.
- Validate contracts with contract tests or tools like Pact.

---

### 3. Temporal Coupling

### Problem:

```go
func Checkout() {
    err := s.orderClient.CreateOrder(req) // Falla si Order está caído
}

```

### Solution:

- Use async events.

```go
eventBus.Publish(CartCheckedOut{...})

```

Have `OrderService` listen for this event.

---

### 4. Functional Coupling

### Problem:

```go
// CartContext handling payment logic
func Checkout() {
    if card.Type == "VISA" {
        // authorization logic
    }
}

```

### Solution:

Delegate this responsibility to  `PaymentContext`:

```go
s.paymentClient.Authorize(card, amount)

```

---

### 5. Deployment Coupling

### Problem:

- Monolith with all contexts.
- Shared database.

### Solución:

- Separate deployments.
- Separate databases or schema ownership.

---

## Recommended folder structure
```
/cart
  /domain            <- Cart models and logic
  /service           <- Business flow
  /handler           <- HTTP handler
  /orderclient       <- Interface and HTTP client
/order
  /domain
  /service
  /handler
/payment
  /domain
  /service
  /handler
/common               <- Utilities (uuid, logs, middlewares)

```

---

## Desirable coupling levels (from worst to best)

1. ❌ Shared struct / direct import.
2. ⚠️ HTTP call without local interface.
3. ✅ Local interface + external adapter.
4. ✅✅ Async events (complete decoupling).

---

## Conclusión

Avoiding unnecessary coupling is key to healthy architecture. The most common mistake is structural coupling through shared structs or packages between services. Using adapters, local interfaces, and events will help decouple contexts, improve cohesion, and allow each part of your system to evolve freely.

>**Remember:** Design for change, not for immediate convenience.

## 📚 Referencias

* [Clean Architecture - Robert C. Martin](https://8thlight.com/blog/uncle-bob/2012/08/13/the-clean-architecture.html)
* [Component-Based Design](https://martinfowler.com/articles/component-based-thinking.html)
* [On the Hexagonal Architecture](https://alistair.cockburn.us/hexagonal-architecture/)
