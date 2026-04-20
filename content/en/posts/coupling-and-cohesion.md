---
title: "Coupling and Cohesion in Software Architecture (with Go Examples)"
subtitle: "Coupling and Cohesion"
date: "2025-06-15"
author: "@SilentGopher"
tags: ["Go", "Coupling", "Cohesion"]
image: "/images/posts/coupling-cohesion/coupling-cohesion.png"
draft: false
---

>When designing distributed or modular systems, understanding the relationship between coupling and cohesion is key to achieving a maintainable, flexible, and scalable architecture.

<!--more-->
Many teams easily fall into the trap of structural coupling, which compromises the independent evolution of modules and leads to fragile architecture.

In this article, we explore different types of coupling, their relationship with cohesion, and how to avoid them using real-world examples in Golang.

---

## The Migration That Should Have Taken Two Days

A while back, I joined a team where `PaymentService` directly imported `cart/domain` to read the cart total. When the business decided to extract Cart into its own service, we found that Payments had 14 files importing Cart's internal structs. The migration took three weeks instead of two days.

Every one of those 14 files was a different flavor of coupling — structural (shared structs), functional (business rules in the wrong place), temporal (sync HTTP calls that cascaded failures across services). We didn't have names for them at the time. We just called it "the mess."

This article gives those patterns names, so you can recognize them in code review — not during a migration.

> **Reading the series in order?** This is the "why" behind [Part 1](/posts/clean-architecture) and [Part 2](/posts/package-by-component). If you've read those, the decisions made there will start to feel inevitable.

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
    CreateOrder(ctx context.Context, req CreateOrderRequest) error
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

- Use clear local interfaces.
- Validate contracts with contract tests or tools like Pact.

---

### 3. Temporal Coupling

### Problem:

```go
func Checkout() {
    err := s.orderClient.CreateOrder(req) // Falla si Order está caído
}

```

### Solution: async events

Decouple by having Cart publish an event and Order subscribe to it independently:

```go
// Cart owns this event — the publisher defines the shape
type CartCheckedOut struct {
	CartID     string
	UserID     string
	TotalCents int64
	OccurredAt time.Time
}

// Cart publishes without knowing who listens
func (s *CartService) Checkout(ctx context.Context, cartID string) error {
	cart, err := s.repo.FindByID(ctx, cartID)
	if err != nil {
		return fmt.Errorf("checkout: %w", err)
	}
	return s.eventBus.Publish(ctx, CartCheckedOut{
		CartID:     cartID,
		UserID:     cart.UserID,
		TotalCents: cart.TotalCents,
		OccurredAt: time.Now(),
	})
}

// Order subscribes independently — Cart doesn't know this exists
func (s *OrderService) OnCartCheckedOut(ctx context.Context, e CartCheckedOut) error {
	return s.createOrder(ctx, e.UserID, e.CartID, e.TotalCents)
}
```

**Why this works:** Cart's HTTP response is sent before Order processes the event. If Order is down, the event stays in the queue — Cart is unaffected.

**Honest trade-off:** Async means eventual consistency. If the user's flow needs an Order ID in the same HTTP response (e.g., redirect to `/orders/123`), async is the wrong tool. It works best for fire-and-forget flows: notifications, analytics, audit logs.

---

### 4. Functional Coupling

### Problem:

```go
// CartContext handling payment logic
func Checkout() {
	if card.Type == "VISA" {
		// authorization logic specific to VISA
	}
}
```

### Why this is dangerous:

- When Amex or BNPL support is added, Cart is the service that changes — not Payment.
- The authorization rules duplicate: Payments also needs to validate cards for refunds.
- Cart's tests now require mocks for every card type, even though Cart has nothing to do with payments.
- A new developer reads `cart/service` and finds VISA authorization logic. Nobody knows why it's there.

### Solution:

Delegate to `PaymentContext`. Cart only knows "authorize this card for this amount":

```go
// cart/service — no knowledge of card types
func (s *CartService) Checkout(ctx context.Context, cartID string, card PaymentCard) error {
	cart, err := s.repo.FindByID(ctx, cartID)
	if err != nil {
		return fmt.Errorf("checkout: %w", err)
	}
	if err := s.paymentClient.Authorize(ctx, card, cart.TotalCents); err != nil {
		return fmt.Errorf("checkout: authorization failed: %w", err)
	}
	return s.completeCheckout(ctx, cart)
}
```

**Payoff:** When BNPL is added, only `payment/service` changes. Cart, Order, and their test suites are untouched.

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

## Choosing the right coupling level

There is no universally "best" answer — the right choice depends on your consistency requirements.

| Level | When to use | Honest trade-off |
|-------|-------------|------------------|
| ✅✅ **Async events** | Independent flows, fire-and-forget (notifications, analytics, audit) | Eventual consistency. Harder to trace failures. Wrong for flows that need an immediate result. |
| ✅ **Local interface + adapter** | Most synchronous service-to-service calls | Still temporally coupled: if the dependency is down, you fail. But isolates you from structural changes. |
| ⚠️ **HTTP without interface** | Quick prototypes, internal scripts | The URL is part of your business logic. Cannot be mocked cleanly. |
| ❌ **Shared struct / direct import** | Never in production modules | One field rename can break dozens of files across unrelated contexts. |

**Rule of thumb:** Start with a local interface + adapter. Promote to async events only when you've confirmed the flow has no hard dependency on an immediate result.

---

## Conclusión

Avoiding unnecessary coupling is key to healthy architecture. The most common mistake is structural coupling through shared structs or packages between services. Using adapters, local interfaces, and events will help decouple contexts, improve cohesion, and allow each part of your system to evolve freely.

>**Remember:** Design for change, not for immediate convenience.

## 📚 Referencias

* [Clean Architecture - Robert C. Martin](https://8thlight.com/blog/uncle-bob/2012/08/13/the-clean-architecture.html)
* [Component-Based Design](https://martinfowler.com/articles/component-based-thinking.html)
* [On the Hexagonal Architecture](https://alistair.cockburn.us/hexagonal-architecture/)
