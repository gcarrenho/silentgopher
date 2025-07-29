---
title: "Part 1: Understanding Clean Architecture Beyond the Diagram"
image: "/images/posts/clean-architecture.jpg"
date: "2025-06-13"
subtitle: "Clean Architecture"
author: "@SilentGopher"
tags: ["Go", "Clean Architecture"]
draft: false
---
> ⚠️ Warning: This isn’t another theoretical article with pretty diagrams that only work in PowerPoint.
I’ll talk about failures, how my first attempts with Clean Architecture were a disaster, and the solution that finally worked in real projects (with deadlines, impatient bosses, and requirements that change every Tuesday).

<!--more-->
## 🚀 Why Am I Writing This?
A few years ago, in my first "serious" Go project, I made every possible mistake:

1. **Architectural Blindness**: I thought putting everything in /internal automatically made my code "clean." Spoiler: It didn’t.

2. **Overengineering**: I implemented a Hexagonal structure so "pure" that even HelloWorld needed 7 files.

3. **Hidden Coupling**: My interfaces were so big they looked like Java classes.

**This is the article I wish I’d read before wasting 3 months on endless refactors.**

## 🔪 Clean Architecture: Theory vs. My Reality
The theory says:

> "Separate domains, use interfaces, blah blah."

My reality was:

> "Why does my UserService know how to persist a PDF in S3? Who wrote this code?… Oh, it was me. 💀"

## The 3 Approaches I Tried (And How They Bit Me)
### 1. Package by Layer: The Classic "Layer Graveyard"
```go
/handlers/   # <- Chaos lives here  
/services/   # <- "Domain" logic mixed with HTTP  
/repositories/ # <- Why does this method have 20 parameters?  
```
**The Good**:

- Everyone understands it (at first).

- Ideal if your team comes from Java/Spring.

**The Bad**:

- In 6 months, your UserService ends up with 3000 lines and hidden dependencies.

- Real Experience: I once spent 2 days debugging a nil pointer because a handler called a repository directly, skipping 3 layers.

### 2. Package by Feature: The "Every Man for Himself" Approach
```go
/users/  
/payments/  
/reports/  # <- Home of the God Object that does EVERYTHING  
```
**The Good**:

- Looks tidy at first glance.

- Teams can work on separate "features."

**The Bad**:

- **Duplication Hell**: In one project, we had 5 different implementations of SendEmail() because each feature had its own logic.

- **Vampire Dependencies**: The payments module internally imported users.Model, and when we changed the DB, everything blew up.

(Pro tip: If you see import "../users" in your code, light a candle. It’s already too late.)

### 3. Hexagonal Architecture: When theory collides with practice
The theory promised:

> "Pure domain, swappable adapters, eternal happiness."

My implementation looked like:

```go
/internal/  
  /core/       # <- Where the "domain" lived  
    /domain/   # <- Ended up with 50 coupled "entities"  
    /ports/    # <- Interfaces with 100 methods  
    /services/ # <- Logic mixed with infrastructure  
  /adapters/   # <- Where the ORM sneaked into the domain  
```
**What Went Wrong?**

- **The Team Didn’t Get It**: New devs called the repository from the handler because "it was faster."

- **Testing Was Impossible**: Mocking 10 interfaces for a simple use case.

- **Result**: A "Clean Architecture" that was actually a monolith with unnecessary abstraction layers.

## 💥 The Day We Broke the Architecture (By Accident)
Or: "Why Juan on the Team Hates Me After That PR"

Context: A few months ago, during a normal sprint, a new teammate (let’s call him Juan) got this task:

>  "We need an endpoint `/orders/user/{id}` to return orders. It’s urgent for the client!"

Juan, being efficient, saw that there was already an `OrderRepository` with the perfect method:

```go
FindByUserID(userID string) ([]Order, error)  
```
So he wrote this in the handler:

```go
func (h *OrderHandler) GetOrdersByUser(w http.ResponseWriter, r *http.Request) {  
    userID := chi.URLParam(r, "id")  
    orders, err := h.orderRepo.FindByUserID(userID) // <- Direct access!  
    // ... (error handling and response)  
}  
```
**It seemed innocent... until the problems started**:

🤯 What Went Wrong?
1. **Forgotten Business Rules**:
Orders were supposed to be filtered by status != "canceled", but since he went straight to the repo, the client saw inconsistent data.

2. **Hidden Coupling**:
    - The handler now depended on:

    - The repository’s signature.

    - The Order struct from the DB (which included internal fields like internal_notes).

3. **Testing Nightmare**:
He had to mock the DB... just to test a handler.

## 🔍 Diagnosis: We Violated Hexagonal Architecture
(Without realizing it)

The theoretical diagram said:

> "Handlers (adapters) must talk to the domain (services), NOT to infrastructure (repositories)."

But in practice:

- **The repo sneaked into the handler** as a shortcut.

- **The domain was left out of the conversation** (no one used OrderService).

## 💡 The Solution: Contracts, Not Coupling
🚫 Common Mistake (We’ve All Made It):
```go
// payments/module.go  
type Payment struct {  
    User users.UserEntity // <- Direct coupling to users' entity!  
}  
```
**Problem**: If UserEntity changes, payments breaks.

✅ The Fix We Implemented:
```go
// contracts/user.go  
type UserDTO struct {  
    ID    string  
    Email string // Only what we need  
}  

// payments/module.go  
type Payment struct {  
    User contracts.UserDTO // <- Coupling to CONTRACT!  
}  
```
**Simple Rule**:

> "If module A uses something from B, B must expose it explicitly in its contract.
Like a public API: if it’s not documented, it doesn’t exist."

## 💡 The Solution That Worked for Me: Components + Contracts
After getting burned, I learned that:  
✅ Each component should be a "mini-project" (with its own domain, logic, and adapters).  
✅ Contracts are sacred (change one, and you break everything… like a public API).  
✅ Go is simple; your architecture should be too.  

Final Structure We Used (Still Alive):
```go
/cmd/
/internal/
  /users/
    /adapters/     # <- Contracts implementation.
    /models/      # <- Only small structs
    users_component.go     # <- PURE business logic interfaces
    users_component_impl.go  # <- PURE business logic implementation
    users_repository.go # <- Private persistence interface
    users_repository_impl.go # <- Private implementation of persistence in DB
  /contracts/
    /users/         # <- What OTHER components can use
      service.go    # <- Interface with 3 methods, not 20.
  /web/ # <- entry point controllers/handlers that only communicate with the service of each component.
```
**Golden Rule**:

> "If a component needs something from another, don’t ask how it works. Request it in the contract and move on."

(Real example: When we migrated from MySQL to PostgreSQL, we only touched adapters/. The domain didn’t even notice.)

## 🎤 Conclusion: Clean Architecture Isn’t a Religion
- **Don’t use it if**: Your project is an MVP or your team is junior.

- **Use it well if**: You need to scale, maintain, and sleep at night.

- **My Biggest Mistake**: Thinking "following the diagram to the letter" was enough. The key is defining clear contracts and enforcing boundaries.

> "Clean architecture isn’t about perfect folders—it’s about being able to change your mind without fear of everything exploding."

🚀 In Part 2: I’ll show you the REAL code (with mistakes included) of how we implemented this in a 100k-line Go project.

(And yes, there’ll be examples of how our "wonderful" PaymentService contract had to change 3 times… and how we survived it.)

📢 Have you struggled with Clean Architecture too?
Let me know in the comments.

## 📚 Referencias

* [Clean Architecture - Robert C. Martin](https://a.co/d/a3ALlXM)