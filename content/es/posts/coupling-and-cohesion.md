---
title: "Acoplamiento y Cohesión en Arquitectura de Software (con ejemplos en Go)"
subtitle: "Coupling and Cohesion"
date: 2026-02-12
author: "@SilentGopher"
description: "Acoplamiento estructural, contractual, temporal, funcional y de despliegue explicados con Go real. Incluye una guerra de migración, el patrón de eventos asíncronos y una tabla de decisión para elegir el nivel correcto."
image: "/images/posts/coupling-cohesion/coupling-cohesion.png"
draft: false
---

>Al diseñar sistemas distribuidos o modulares, comprender la relación entre **acoplamiento** y **cohesión** es clave para lograr una arquitectura mantenible, flexible y escalable.
<!--more-->

Muchos equipos caen fácilmente en el error del **acoplamiento estructural**, lo que compromete la evolución independiente de los módulos y genera una arquitectura frágil.

En este artículo exploramos los distintos tipos de acoplamiento, su relación con la cohesión y cómo evitarlos utilizando ejemplos reales en Golang.

---

## La Migración que Debería Haber Tomado Dos Días

Hace un tiempo, me sumé a un equipo donde `PaymentService` importaba directamente `cart/domain` para leer el total del carrito. Cuando el negocio decidió extraer Cart a su propio servicio, descubrimos que Payments tenía 14 archivos importando structs internos de Cart. La migración tomó tres semanas en vez de dos días.

Cada uno de esos 14 archivos era un sabor distinto de acoplamiento — estructural (structs compartidos), funcional (reglas de negocio en el lugar equivocado), temporal (llamadas HTTP síncronas que propagaban fallas en cascada). No teníamos nombres para ellos en ese momento. Los llamábamos simplemente "el desastre".

Este artículo pone nombre a esos patrones, para que los puedas identificar en una code review — no durante una migración.

> **¿Estás leyendo la serie en orden?** Este es el "por qué" detrás de [Parte 1](/posts/clean-architecture) y [Parte 2](/posts/package-by-component). Si ya los leíste, las decisiones tomadas allí empezarán a sentirse inevitables.

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
    CreateOrder(ctx context.Context, req CreateOrderRequest) error
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

### Solución: eventos asíncronos

Desacoplar haciendo que Cart publique un evento y Order se suscriba de forma independiente:

```go
// Cart es dueño de este evento — el publicador define la forma
type CartCheckedOut struct {
	CartID     string
	UserID     string
	TotalCents int64
	OccurredAt time.Time
}

// Cart publica sin saber quién escucha
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

// Order se suscribe de forma independiente — Cart no sabe que esto existe
func (s *OrderService) OnCartCheckedOut(ctx context.Context, e CartCheckedOut) error {
	return s.createOrder(ctx, e.UserID, e.CartID, e.TotalCents)
}
```

**Por qué funciona:** La respuesta HTTP de Cart ya fue enviada antes de que Order procese el evento. Si Order está caído, el evento queda en la cola — Cart no se ve afectado.

**Trade-off honesto:** Async implica consistencia eventual. Si el flujo del usuario necesita el ID de Order en la misma respuesta HTTP (p.ej., redirigir a `/orders/123`), async es la herramienta equivocada. Funciona mejor para flujos fire-and-forget: notificaciones, analytics, logs de auditoría.

---

### 4. Acoplamiento funcional

### Problema:

```go
// CartContext haciendo lógica de pago
func Checkout() {
	if card.Type == "VISA" {
		// lógica de autorización específica de VISA
	}
}
```

### Por qué es peligroso:

- Cuando se agrega soporte para Amex o BNPL, Cart es el servicio que cambia — no Payment.
- Las reglas de autorización se duplican: Payments también necesita validar tarjetas para reembolsos.
- Los tests de Cart ahora necesitan mocks para cada tipo de tarjeta, aunque Cart no tiene nada que ver con pagos.
- Un dev nuevo lee `cart/service` y encuentra lógica de autorización VISA. Nadie sabe por qué está ahí.

### Solución:

Delegar a `PaymentContext`. Cart solo sabe "autorizar esta tarjeta por este monto":

```go
// cart/service — sin conocimiento de tipos de tarjeta
func (s *CartService) Checkout(ctx context.Context, cartID string, card PaymentCard) error {
	cart, err := s.repo.FindByID(ctx, cartID)
	if err != nil {
		return fmt.Errorf("checkout: %w", err)
	}
	if err := s.paymentClient.Authorize(ctx, card, cart.TotalCents); err != nil {
		return fmt.Errorf("checkout: autorización fallida: %w", err)
	}
	return s.completeCheckout(ctx, cart)
}
```

**Resultado:** Cuando se agrega BNPL, solo cambia `payment/service`. Cart, Order y sus test suites permanecen intactos.

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

## Eligiendo el nivel de acoplamiento correcto

No existe una respuesta universalmente "correcta" — la elección depende de tus requisitos de consistencia.

| Nivel | Cuándo usarlo | Trade-off honesto |
|-------|--------------|------------------|
| ✅✅ **Eventos asíncronos** | Flujos independientes, fire-and-forget (notificaciones, analytics, auditoría) | Consistencia eventual. Más difícil de rastrear fallas. Incorrecto para flujos que necesitan un resultado inmediato. |
| ✅ **Interfaz local + adaptador** | La mayoría de las llamadas síncronas entre servicios | Sigue siendo temporalmente acoplado: si la dependencia está caída, fallás. Pero te aísla de cambios estructurales. |
| ⚠️ **HTTP sin interfaz** | Prototipos rápidos, scripts internos | La URL es parte de tu lógica de negocio. No se puede mockear limpiamente. |
| ❌ **Struct compartido / import directo** | Nunca en módulos de producción | Renombrar un campo puede romper docenas de archivos en contextos no relacionados. |

**Regla general:** Empezá con una interfaz local + adaptador. Promové a eventos asíncronos solo cuando hayas confirmado que el flujo no tiene dependencia dura de un resultado inmediato.

---

## Conclusión

Evitar el acoplamiento innecesario es clave para una arquitectura saludable. El error más común es el acoplamiento estructural por compartir structs o paquetes entre servicios. Usar adaptadores, interfaces locales y eventos te ayudará a desacoplar contextos, mejorar la cohesión y permitir que cada parte de tu sistema evolucione libremente.

>**Recuerda:** Diseña para el cambio, no para la comodidad inmediata.

## 📚 Referencias

* [Clean Architecture - Robert C. Martin](https://8thlight.com/blog/uncle-bob/2012/08/13/the-clean-architecture.html)
* [Component-Based Design](https://martinfowler.com/articles/component-based-thinking.html)
* [On the Hexagonal Architecture](https://alistair.cockburn.us/hexagonal-architecture/)
