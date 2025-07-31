---
title: "Parte 2: Aplicando Component-Based Clean Architecture en Go"
subtitle: "Package by Components"
date: 2025-07-31
author: "@SilentGopher"
image: "/images/posts/package-by-component.png"
tags: ["Go", "Clean Architecture", "Package by Components"]
draft: false
---

> 💡 ADVERTENCIA: Si esperas copy-paste perfecto, mejor ve a StackOverflow.
Esto es código real con cicatrices, donde el 60% funcionó al primer intento y el otro 40% nos hizo llorar en el refactor.

## 🚧 El Proyecto que casi me Quema los Párpados
Hace varios meses, heredé un monolito en Go donde:

- `users` y `orders` compartían structs como si fueran confesiones de borrachos.

- Un cambio en `User.Email` rompía 3 servicios distintos.

- Los tests eran tan frágiles como cristal de Murano.

**Hoy te muestro cómo lo convertimos en esto**:

```go
/cmd/
/internal/
  users/
  payments/
  orders/
  contracts/
  web/
```

## 🔗 Paso 1: El Contrato - Nuestro "Tinder" Técnico
En lugar de que `payments` stalkee a `users`, creamos un contrato explícito:

```go
// contracts/user/user_service.go
package user

type Service interface {
	GetUserByID(id string) (UserDTO, error)  // Solo 1 método. ¡Como un buen microservicio!
}

type UserDTO struct {
	ID    string  // Justo lo necesario
	Email string  // Nada de "PasswordHash" aquí
}
```
¿Por qué esto es mágico?

- `payments` declara: "Necesito esto".

- users responde: "Te lo doy, pero no me preguntes cómo".

- **Divorcio saludable**: Si mañana `users` cambia de MySQL a CSV, a nadie le importa.

## 👷 Paso 2: Implementando `users` (con errores incluidos)
Aquí está el código real que usamos (con el bug que dejamos pasar a prod):

```go
// internal/users/adapters/service.go
type UserService struct {
	repo UserRepository
}

func (s *UserService) GetUserByID(id string) (user.UserDTO, error) {
	u, err := s.repo.FindByID(id)
	if err != nil {
		return user.UserDTO{}, fmt.Errorf("no encontré al usuario %s: %w", id, err)
		// 💥 Error: No registramos el fallo. Lo aprendimos después.
	}

	return user.UserDTO{
		ID:    u.ID,
		Email: u.Email,  // <- ¡Seguro que es válido? (Spoiler: No siempre)
	}, nil
}
```
**Lección aprendida**:
Los contratos no eliminan errores, pero contienen el daño. Aquí, aunque `UserService` fallara:

1. `payments` no se enteraba de campos internos como `u.FailedLoginAttempts`.

2. El error era claro y manejable.

## 💸 Paso 3: payments - El Cliente Exigente
Así consume el contrato (con un gotcha que no vimos venir):

```go
// components/payments/payment_component_impl/service.go
type PaymentComponentImpl struct {
	userService user.Service  // <- Depende del CONTRATO, no de users
}

func (s *PaymentComponentImpl) Charge(userID string, amount float64) error {
	u, err := s.userService.GetUserByID(userID)
	if err != nil {
		return fmt.Errorf("falló el pago para %s: %w", userID, err)
	}

	if u.Email == "" {  // 💡 ¡Validación donde DEBE estar!
		return errors.New("email requerido para pagos")
	}

	// ... lógica de Stripe/PayPal
}
```
**¿Qué pasó en producción?**

Descubrimos que algunos usuarios tenían `Email == ""` (mala validación inicial).

**Gracias al contrato**: El bug estuvo aislado en `users.payments` solo vio datos inválidos, no campos corruptos.

## ⚡ Wiring en main.go - El "Me Caso" del Código
Aquí es donde todo se une (o explota, si lo haces mal):

```go
// cmd/main.go
func main() {

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	wg := &sync.WaitGroup{}

	router := gin.Default()

	container := app.NewAppContainer() // Crea todos los componente inyectando su respectiva base de datos.
	routes.Register(router, container) // registra todas las rutas

	go server.Run(ctx, router, wg)

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
	<-sig

	cancel()
	wg.Wait()
}

// Orquesta components initializing and dependency injection
package app

type AppContainer struct {
	OrderComponent   orders.OrderComponent
	PaymentComponent payments.PaymentComponent
	UserComponent    users.UserComponent
}

func NewAppContainer() *AppContainer {
	return &AppContainer{
		OrderComponent: orders.NewOrderComponentImpl(orders.Deps{
			DB: db.InitMySQL(),
		}),
		PaymentComponent: payments.NewPaymentComponentImpl(payments.Deps{
			DB: db.InitPostgres(),
		}),
		UserComponent: users.NewUserComponentImpl(users.Deps{
			DB: db.InitMySQL(),
		}),
	}
}

// Orquesta controladores
package routes

func Register(router *gin.Engine, container *app.AppContainer) {
	api := router.Group("/api")

	// Public (sin auth)
	public := api.Group("/public")

	// Private (con auth middleware)
	private := api.Group("/private")
	private.Use(AuthMiddleware())

	// Payments
	paymentController := web.NewPaymentController(container.PaymentComponent)
	paymentController.RegisterRoutes(private.Group("/payments"))

	// Orders
	orderController := web.NewOrderController(container.OrderComponent)
	orderController.RegisterRoutes(public.Group("/orders"))

	// Users
	userController := web.NewUserController(container.UserComponent)
	userController.RegisterRoutes(private.Group("/users"))

	// Health
	api.GET("/health", func(c *gin.Context) {
		c.JSON(200, gin.H{"status": "ok"})
	})
}
```
Metáfora clave:

> `users/adapters/service.go` es como un traductor profesional. `payments` habla en "necesito un usuario", y el traductor convierte eso al dialecto interno de `users`. Si `users` cambia su idioma, solo el traductor debe actualizarse.

## 💣 ¿Y si No Usamos Contratos? (El Caos que Vivimos)
Te muestro el before/after de nuestro código real:

### 🚫 Antes (Acoplamiento Criminal)
```go
// internal/payments/payment_component_impl.go (OLD)
func (s *PaymentService) Refund(userID string) error {
	u, err := s.userRepo.GetUser(userID)  // ¡Acceso directo al repo de users!
	if err != nil {
		return err
	}

	if u.CreditCard == nil {  // 💥 Campo interno que cambió 3 veces
		return errors.New("no tiene tarjeta")
	}
}
```
### ✅ Después (Contratos al Rescate)
```go
// contracts/user/service.go (NEW)
type Service interface {
	GetUserForPayment(id string) (PaymentUserDTO, error)  // ¡Ahora el contrato es explícito!
}

// internal/payments/service.go (NEW)
func (s *PaymentService) Refund(userID string) error {
	u, err := s.userService.GetUserForPayment(userID)  // Solo lo que NECESITA
	// ...
}
```
**Beneficios concretos**:

1. Cuando `users` cambió su modelo de tarjetas, `payments` ni se enteró.

2. Los tests de `payments` usan un mock de 10 líneas, no una DB falsa.

## 📌 Conclusión: Menos Teoría, Más Superpoderes
Esta arquitectura nos permitió:

- Mover `users` a otro repo sin tocar `payments`.

- Refactorizar la DB 3 veces sin pánico.

- Onboardear devs nuevos con: "¿Necesitas datos de X? Mira sus contratos".

> "Clean Architecture no se trata de carpetas perfectas, sino de poder dormir sabiendo que el cambio de mañana no te arruinará la semana."

💬 ¿Vos también has lidiado con acoplamientos?
Déjame saber en los comentarios.