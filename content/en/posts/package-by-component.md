---
title: "Part 2: Applying Component-Based Clean Architecture in Go"
subtitle: "Package by Components"
date: 2025-06-14
author: "@SilentGopher"
image: "/images/posts/package-by-component.png"
tags: ["Go", "Clean Architecture", "Package by Components"]
draft: false
---

> 💡 WARNING: If you're expecting perfect copy-paste code, better go to StackOverflow.
This is real-world code with scars—60% worked on the first try, the other 40% made us cry during refactor.

## 🚧 The Project That Nearly Burned My Eyeballs
Several months ago, I inherited a Go monolith where:

- `users` and `orders` shared structs like drunken confessions.

- A change in `User.Email` broke 3 different services.

- The tests were as fragile as Murano glass.

**Today, I’ll show you how we turned it into this**:

```go
/cmd/
/internal/
  users/
  payments/
  orders/
  contracts/
  web/
```

## 🔗 Step 1: The Contract – Our Technical "Tinder"
Instead of `payments` stalking `users`, we created an explicit contract:

```go
// contracts/user/user_service.go
package user

type Service interface {
	GetUserByID(id string) (UserDTO, error)  // Just one method. Like a good microservice!
}

type UserDTO struct {
	ID    string  // Just what we need
	Email string  // No "PasswordHash" here
}
```
Why is this magical?

- `payments` declares: "I need this."

- `users` replies: "I’ll give it to you, but don’t ask how."

- **Healthy decoupling**: If tomorrow `users` switches from MySQL to CSV, nobody cares.

## 👷 Step 2: Implementing `users` (Bugs Included)
Here’s the actual code we used (with the bug that made it to prod):

```go
// internal/users/adapters/service.go
type UserService struct {
	repo UserRepository
}

func (s *UserService) GetUserByID(id string) (user.UserDTO, error) {
	u, err := s.repo.FindByID(id)
	if err != nil {
		return user.UserDTO{}, fmt.Errorf("couldn’t find user %s: %w", id, err)
		// 💥 Bug: We didn’t log the error. Lesson learned later.
	}

	return user.UserDTO{
		ID:    u.ID,
		Email: u.Email,  // <- Is this valid? (Spoiler: Not always)
	}, nil
}
```
**Lesson learned**:
Contracts don’t eliminate bugs, but they **contain** the damage. Even if `UserService` failed:

1. `payments` had no idea about internal fields like `u.FailedLoginAttempts`.

2. The error was clear and manageable.

## 💸 Step 3: payments – The Demanding Client
Here’s how the contract is consumed (with a gotcha we missed):

```go
// components/payments/payment_component_impl/service.go
type PaymentComponentImpl struct {
	userService user.Service  // <- Depends on the CONTRACT, not on users
}

func (s *PaymentComponentImpl) Charge(userID string, amount float64) error {
	u, err := s.userService.GetUserByID(userID)
	if err != nil {
		return fmt.Errorf("payment failed for %s: %w", userID, err)
	}

	if u.Email == "" {  // 💡 Validation where it SHOULD be!
		return errors.New("email required for payments")
	}

	// ... Stripe/PayPal logic
}
```
**What happened in production?**

We discovered that some users had `Email == ""` (bad initial validation).

**Thanks to the contract**: The bug was isolated in `users`; `payments` only saw invalid data, not corrupted fields.

## ⚡ Wiring in main.go – The “Marriage” of the Code
This is where everything comes together (or blows up, if done wrong):

```go
// cmd/main.go
func main() {

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	wg := &sync.WaitGroup{}

	router := gin.Default()

	container := app.NewAppContainer() // Creates all components, injecting respective databases
	routes.Register(router, container) // Registers all routes

	go server.Run(ctx, router, wg)

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
	<-sig

	cancel()
	wg.Wait()
}

// Orchestrates component initialization and dependency injection
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

// Orchestrates controllers
package routes

func Register(router *gin.Engine, container *app.AppContainer) {
	api := router.Group("/api")

	// Public (no auth)
	public := api.Group("/public")

	// Private (with auth middleware)
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
Key metaphor:

> `users/adapters/service.go` is like a professional translator. `payments` says “I need a user,” and the translator converts that to the internal dialect of `users`. If `users` changes its language, only the translator needs updating.

## 💣 What If We Don’t Use Contracts? (The Chaos We Lived Through)
Here's a before/after from our real codebase:

### 🚫 Before (Criminal Coupling)
```go
// internal/payments/payment_component_impl.go (OLD)
func (s *PaymentService) Refund(userID string) error {
	u, err := s.userRepo.GetUser(userID)  // Direct access to users repo!
	if err != nil {
		return err
	}

	if u.CreditCard == nil {  // 💥 Internal field that changed 3 times
		return errors.New("no credit card")
	}
}
```
### ✅ After (Contracts to the Rescue)
```go
// contracts/user/service.go (NEW)
type Service interface {
	GetUserForPayment(id string) (PaymentUserDTO, error)  // Now the contract is explicit!
}

// internal/payments/service.go (NEW)
func (s *PaymentService) Refund(userID string) error {
	u, err := s.userService.GetUserForPayment(userID)  // Only what’s NEEDED
	// ...
}
```
**Tangible benefits**:

1. When `users` changed its credit card model, `payments` didn’t even notice.

2. `payments` tests use a 10-line mock, not a fake DB.

## 📌 Conclusion: Less Theory, More Superpowers
This architecture allowed us to:

- Move `users` to another repo without touching `payments`.

- Refactor the DB 3 times without panic.

- Onboard new devs with: “Need data from X? Check their contracts.”

> "Clean Architecture is not about perfect folders, but about sleeping well knowing tomorrow’s change won’t ruin your week."

💬 Have you also struggled with tight coupling?
Tell me in the comments.