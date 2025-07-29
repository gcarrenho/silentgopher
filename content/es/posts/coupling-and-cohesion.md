---
title: "Acoplamiento y Cohesión en Arquitectura de Software (con ejemplos en Go)"
subtitle: "Coupling and Cohesion"
date: 2025-06-15
author: "@SilentGopher"
tags: ["Go", "Coupling", "Cohesion"]
image: "/images/posts/coupling-cohesion/coupling-cohesion.png"
draft: true
---

>Al diseñar sistemas distribuidos o modulares, comprender la relación entre **acoplamiento** y **cohesión** es clave para lograr una arquitectura mantenible, flexible y escalable.
<!--more-->

Muchos equipos caen fácilmente en el error del **acoplamiento estructural**, lo que compromete la evolución independiente de los módulos y genera una arquitectura frágil.

En este artículo exploramos los distintos tipos de acoplamiento, su relación con la cohesión y cómo evitarlos utilizando ejemplos reales en Golang.

---

## Conceptos clave

### Acoplamiento (Coupling)

El **acoplamiento** se refiere al grado de dependencia entre dos módulos o contextos. A menor acoplamiento, mayor libertad para que cada módulo evolucione de forma independiente.

#### Tipos principales:

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

### Cohesión

La **cohesión** mide qué tan relacionadas están las responsabilidades dentro de un módulo:

- Alta cohesión: Todas las funciones están alineadas con un propósito claro.
- Baja cohesión: El módulo mezcla responsabilidades dispares sin relación evidente.

**Objetivo ideal:** Alta cohesión + Bajo acoplamiento.

---

## Ejemplos reales de acoplamiento (en Go) y su solución

### 1. Acoplamiento estructural

#### Problema

```go
// cart/service/cart_service.go
import "order/domain"

func (s *CartService) Checkout() {
    order := domain.Order{...} // Uso directo del struct Order de otro contexto
}
```

### Consecuencias:

- Rompe la regla de separación de contextos.
- Cualquier cambio en `Order` rompe `Cart`.

### Solución:
Definir un contrato local:
```go
// cart/orderclient/order_client.go

// DTO local
type CreateOrderRequest struct {
    UserID string
    Items  []CartItem
}

type OrderClient interface {
    CreateOrder(req CreateOrderRequest) error
}

```

Este contrato puede implementarse mediante un adaptador HTTP o gRPC.

---

### 2. Acoplamiento contractual

### Problema:

```go
// cart/service
resp, err := http.Post("http://order-service/orders", "application/json", body)

```

### Riesgo:

- Cambios en el contrato del endpoint rompen `Cart`.

### Solución:

- Usar una interfaz local clara.
- Validar los contratos con tests de contrato o herramientas como Pact.

---

### 3. Acoplamiento temporal

### Problema:

```go
func Checkout() {
    err := s.orderClient.CreateOrder(req) // Falla si Order está caído
}

```

### Solución:

- Usar eventos asíncronos.

```go
eventBus.Publish(CartCheckedOut{...})

```

Y que `OrderService` escuche ese evento.

---

### 4. Acoplamiento funcional

### Problema:

```go
// CartContext haciendo lógica de pago
func Checkout() {
    if card.Type == "VISA" {
        // lógica de autorización
    }
}

```

### Solución:

Delegar esta responsabilidad: `PaymentContext`:

```go
s.paymentClient.Authorize(card, amount)

```

---

### 5. Acoplamiento de despliegue

### Problema:

- Monolito con todos los contextos.
- Base de datos compartida.

### Solución:

- Separar despliegues.
- Separar bases de datos o ownership de esquemas.

---

## Estructura de carpetas recomendada

```
/cart
  /domain            <- modelos y lógica del carrito
  /service           <- flujo de negocio
  /handler           <- HTTP handler
  /orderclient       <- interfaz y cliente HTTP
/order
  /domain
  /service
  /handler
/payment
  /domain
  /service
  /handler
/common               <- utilidades (uuid, logs, middlewares)

```

---

## Niveles de acoplamiento deseables (de peor a mejor)

1. ❌ Shared struct / import directo.
2. ⚠️ Llamada HTTP sin interfaz local.
3. ✅ Interfaz local + adaptador externo.
4. ✅✅ Eventos asíncronos (desacoplamiento total).

---

## Conclusión

Evitar el acoplamiento innecesario es clave para una arquitectura saludable. El error más común es el acoplamiento estructural por compartir structs o paquetes entre servicios. Usar adaptadores, interfaces locales y eventos te ayudará a desacoplar contextos, mejorar la cohesión y permitir que cada parte de tu sistema evolucione libremente.

>**Recuerda:** Diseña para el cambio, no para la comodidad inmediata.

## 📚 Referencias

* [Clean Architecture - Robert C. Martin](https://8thlight.com/blog/uncle-bob/2012/08/13/the-clean-architecture.html)
* [Component-Based Design](https://martinfowler.com/articles/component-based-thinking.html)
* [On the Hexagonal Architecture](https://alistair.cockburn.us/hexagonal-architecture/)
