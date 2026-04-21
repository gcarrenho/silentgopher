---
title: "Functional Options in Go: The Pattern Behind Clean Service Constructors"
subtitle: "Functional Options Pattern"
date: 2026-04-20
author: "@SilentGopher"
description: "How to stop passing boolean flags and empty strings to your Go constructors. A deep dive into the Functional Options pattern — when to use it at constructor level vs method level, and when not to use it at all."
image: "/images/posts/functional-options/functional-options.png"
tags: ["Go", "Design Patterns", "Clean Code", "API Design", "Software Architecture"]
draft: false
---

> 💡 If your function signature has grown to five parameters, the sixth one doesn't make the code harder to read — it makes it dangerous.

<!--more-->

## 🚧 Parameter Creep: The Slow Death by a Thousand Arguments

Six months into a production Go project, I found myself staring at this:

```go
func (s *UserService) GetProfile(
    ctx context.Context,
    id string,
    enrichFromCRM bool,
    crmAuthToken string,
    locale string,
    includeDeleted bool,
) (Profile, error)
```

Each parameter was added for a good reason — at the time. The CRM enrichment flag came from a business requirement. The auth token was needed to call an external API. The locale was for formatting. The `includeDeleted` flag was for an admin panel.

**The real cost wasn't the function itself. It was every call site:**

```go
// Production call — what does "false, "", "en-US", false" mean?
profile, err := userService.GetProfile(ctx, id, false, "", "en-US", false)

// Admin call — spot the difference:
profile, err := userService.GetProfile(ctx, id, false, "", "en-US", true)
```

Three months later, someone added a seventh parameter. To thread it through, they had to touch 40 files. The PR had 800 lines of context-free `false` and `""` changes.

There's a pattern that makes this stop. It's called **Functional Options**. The idea was first described by [Rob Pike](http://commandcenter.blogspot.com/2014/01/self-referential-functions-and-design.html) in January 2014 and popularized by [Dave Cheney](https://dave.cheney.net/2014/10/17/functional-options-for-friendly-apis) at dotGo the same year. Once you see it, you can't unsee it.

---

## 🔑 The Pattern: Functions That Configure

The idea is simple: instead of passing configuration as bare parameters, you pass **functions** that apply configuration to a struct.

```go
// The options struct — holds everything a service might configure
type UserServiceOptions struct {
    crmClient      CRMClient
    defaultLocale  string
    includeDeleted bool
}

// An option is just a function that mutates the options struct
type UserServiceOption func(*UserServiceOptions)
```

You then create **constructor functions** for each option:

```go
func WithCRMEnrichment(client CRMClient) UserServiceOption {
    return func(opts *UserServiceOptions) {
        opts.crmClient = client
    }
}

func WithLocale(locale string) UserServiceOption {
    return func(opts *UserServiceOptions) {
        opts.defaultLocale = locale
    }
}

func WithDeletedUsers() UserServiceOption {
    return func(opts *UserServiceOptions) {
        opts.includeDeleted = true
    }
}
```

And the service applies them in a loop:

```go
type UserService struct {
    storer  UserStorer
    options UserServiceOptions
}

func NewUserService(storer UserStorer, opts ...UserServiceOption) *UserService {
    options := UserServiceOptions{
        defaultLocale: "en-US", // sensible defaults
    }
    for _, opt := range opts {
        opt(&options)
    }
    return &UserService{storer: storer, options: options}
}
```

**Call sites become self-documenting:**

```go
// Plain service — no enrichment, no special config
plainService := user.NewService(storer)

// Service with CRM enrichment — admin panel variant
adminService := user.NewService(storer,
    user.WithCRMEnrichment(crmClient),
    user.WithDeletedUsers(),
)
```

No positional guessing. No silent `false`. The code reads like a sentence.

---

## 🚧 Why Not Just a Config Struct?

Before functional options, the standard solution was a `Config` struct:

```go
type ServerConfig struct {
    Port    int
    Timeout time.Duration
    TLS     bool
}

func NewServer(cfg ServerConfig) *Server
```

This works — until you hit **zero value ambiguity**. `Port: 0` could mean two completely different things:

- *"I didn't set it, use the default (8080)"*
- *"I want port 0 so the OS chooses a free port"*

Those are indistinguishable. For a test suite that needs a free port, you can't express that intent.

The pointer variant (`*ServerConfig`) solves zero-value, but now callers must pass `nil` for the default case — and Dave Cheney's rule is clear: **`nil` should never be a required argument to a public function**. It puts the burden on the caller and opens the door to shared mutable state.

Functional options sidestep both problems: the variadic signature makes the default case require zero arguments, and options compose safely without sharing internal state.

---

## ⚡ Two Places to Apply Options: Constructor vs. Method

Here's where it gets interesting — and where most tutorials stop too early.

You can apply functional options at **two different levels**:

1. **Constructor-level**: configures how the service *works* (dependency, behavior toggle)
2. **Method-level**: configures how *this specific call* behaves

They look the same syntactically, but they solve different problems.

### Constructor-level (service configuration)

```go
// The CRM client is a dependency — it never changes per request
svc := user.NewService(storer, user.WithCRMEnrichment(crmClient))

// Every call uses the same CRM client
svc.GetProfile(ctx, id)
svc.GetProfile(ctx, otherID) // same configuration
```

Use constructor options for: **dependencies, feature flags, timeouts, default behaviors**.

### Method-level (per-request variation)

```go
type GetProfileOption func(*getProfileRequest)

func WithAuthToken(token string) GetProfileOption {
    return func(r *getProfileRequest) {
        r.authToken = token
    }
}

func (s *UserService) GetProfile(
    ctx context.Context,
    id string,
    opts ...GetProfileOption,
) (Profile, error) {
    req := &getProfileRequest{}
    for _, opt := range opts {
        opt(req)
    }
    // ...
}
```

Called as:

```go
// Token changes per HTTP request — it can't be set at construction time
profile, err := svc.GetProfile(ctx, id, user.WithAuthToken(r.Header.Get("Authorization")))
```

Use method options for: **caller-specific data, request-scoped tokens, per-call overrides**.

---

## 🔬 Real-World Code: The Product Service Refactor

Here's a service that combines both levels — a `ProductService` that syncs product data and can optionally enrich it from a third-party **supplier catalog API**. The original code:

```go
// ⚠️ Before: method-level option carrying session data + behavior toggle together
func (s *ProductService) Upsert(
    ctx context.Context,
    product model.Product,
    opts ...ProductServiceOption,
) error {
    options := &ProductServiceOptions{}
    for _, opt := range opts {
        opt(options)
    }

    storedProduct, err := s.productStorer.FindByID(ctx, product.ID)
    if err != nil && !errors.Is(err, ports.ErrNotFound) {
        return fmt.Errorf("finding product | ID: %s --> %w", product.ID, err)
    }
    notFound := errors.Is(err, ports.ErrNotFound)

    if options.SyncFromSupplier {
        product, err = s.supplierClient.GetProduct(ctx, options.SupplierToken)
        if err != nil {
            return fmt.Errorf("fetching from supplier catalog --> %w", err)
        }
    }

    if !notFound && product.Equal(storedProduct) {
        return nil
    }
    return s.productStorer.Upsert(ctx, product)
}
```

Called as:

```go
err := svc.Upsert(ctx, product, WithSupplierSync(supplierToken))
```

**What feels wrong?** The option bundles two things:
1. A **behavior toggle** (`SyncFromSupplier: true`) — this is *configuration*, it answers "does this service use the supplier catalog?"
2. A **session credential** (`SupplierToken`) — this is *per-request data*, it changes for every HTTP call

They have different lifecycles and don't belong in the same option.

---

### ✅ The Refactored Version

**Step 1:** The `SupplierClient` is injected at construction — it's a dependency, not a request detail.

```go
type ProductService struct {
    storer   ProductStorer
    supplier ports.SupplierClient // nil means "don't sync from supplier"
}

func NewProductService(storer ProductStorer, opts ...ProductServiceOption) *ProductService {
    svc := &ProductService{storer: storer}
    for _, opt := range opts {
        opt(svc)
    }
    return svc
}

// Constructor-level option: wires the dependency
func WithSupplierClient(client ports.SupplierClient) ProductServiceOption {
    return func(s *ProductService) {
        s.supplier = client
    }
}
```

**Step 2:** The supplier token travels through `context.Context` — where per-request data belongs.

```go
// Middleware or handler sets the token in context:
ctx = auth.WithSupplierToken(ctx, r.Header.Get("X-Supplier-Token"))

// Service reads it from context when needed:
func (s *ProductService) Upsert(ctx context.Context, product model.Product) error {
    storedProduct, err := s.storer.FindByID(ctx, product.ID)
    if err != nil && !errors.Is(err, ports.ErrNotFound) {
        return fmt.Errorf("finding product | ID: %s --> %w", product.ID, err)
    }
    notFound := errors.Is(err, ports.ErrNotFound)

    // If the service was configured with a supplier client, use it
    if s.supplier != nil {
        token, ok := auth.SupplierTokenFromContext(ctx)
        if !ok {
            return fmt.Errorf("supplier sync configured but no token in context")
        }
        product, err = s.supplier.GetProduct(ctx, token)
        if err != nil {
            return fmt.Errorf("fetching from supplier catalog --> %w", err)
        }
    }

    if !notFound && product.Equal(storedProduct) {
        return nil
    }
    return s.storer.Upsert(ctx, product)
}
```

**Wiring in `AppContainer`:**

```go
// Without supplier sync (default service)
basicProductService := product.NewService(productStorer)

// With supplier catalog sync (for the vendor-facing endpoint)
enrichedProductService := product.NewService(productStorer,
    product.WithSupplierClient(supplierClient),
)
```

**Call sites are now clean — no option to thread through:**

```go
// Before:
err := svc.Upsert(ctx, product, WithSupplierSync(supplierToken))

// After:
err := svc.Upsert(ctx, product)
```

The token is already in `ctx`. The behavior is already configured in the service.

---

## 📌 Constructor vs. Method: The Decision Table

| Question | Constructor option | Method option |
|----------|--------------------|---------------|
| Does this configure a dependency (DB, client)? | ✅ | ❌ |
| Does this toggle a feature that applies to all calls? | ✅ | ❌ |
| Does this data change per HTTP request (token, locale)? | ❌ | ✅ |
| Do different callers need different behavior at runtime? | ❌ | ✅ |
| Is this optional but identical across most call sites? | ✅ | ❌ |
| Is this meaningful on a single specific call? | ❌ | ✅ |

**Heuristic:** If you're passing the same option in every call, it's configuration — move it to the constructor. If the value changes between calls, it's per-request — keep it at the method level or move it to context.

---

## ❌ When NOT to Use Functional Options

The pattern is powerful, but it's not free.

**Don't use it for required parameters.** Functional options imply optionality. If a service cannot work without a parameter, that parameter goes in the constructor signature directly — not behind an option.

```go
// ❌ Don't:
svc := NewUserService(user.WithStorer(storer)) // what if they forget?

// ✅ Do:
svc := NewUserService(storer) // required is required
```

**Don't use it for simple functions.** A helper with 2 parameters doesn't need a functional options apparatus. Add the abstraction when you have 3+ optional parameters that grow over time.

**Don't use it when options interact.** If `WithOptionA` and `WithOptionB` combined produce invalid state, you'll need validation logic. At that point, a dedicated `Config` struct with an explicit `Validate()` method is more honest:

```go
config := UserServiceConfig{
    Locale:   "en-US",
    MaxRetry: 3,
}
if err := config.Validate(); err != nil {
    return nil, err
}
svc := NewUserService(storer, config)
```

---

## ⚖️ Advantages and Disadvantages

| | Functional Options |
|---|---|
| ✅ **Self-documenting call sites** | `WithCRMEnrichment(client)` beats `true, client, 0, ""` |
| ✅ **Backwards compatible** | Add new options without changing existing call sites |
| ✅ **Sensible defaults** | Apply defaults in the constructor before options are applied |
| ✅ **Testable in isolation** | Build the exact variant you need in each test |
| ❌ **More files, more types** | Each option is a new exported function and type |
| ❌ **Hidden control flow** | Options applied in a loop are less explicit than direct assignment |
| ❌ **Validation is manual** | No compiler enforcement that required options are set |
| ❌ **Overused** | Applying it to every function is cargo culting |

---

## 📌 Conclusion: Options Are API Design

The functional options pattern isn't just about avoiding long parameter lists. It's about making the **intent** of a call visible in the code.

When you read:

```go
svc := product.NewService(storer, product.WithSupplierClient(supplierClient))
```

You know immediately that **this service instance** syncs from a supplier catalog. No boolean decoding. No reading the function body to understand what `true` meant.

And when you read:

```go
err := svc.Upsert(ctx, product)
```

You know the call has no special behavior — it's the default path.

> The goal of good API design is that the call site reads like a decision, not a data structure.

This pattern connects directly to what we built in [Part 1](/posts/clean-architecture) and [Part 2](/posts/package-by-component): each service exposes a contract, and that contract should be as narrow and readable as the business behavior it represents.

💬 Are you using functional options in your project? At the constructor or method level?
Tell me in the comments.

---

## 📚 References

* [Dave Cheney — Functional options for friendly APIs (dotGo, 2014)](https://dave.cheney.net/2014/10/17/functional-options-for-friendly-apis)
* [Rob Pike — Self referential functions and design (2014)](http://commandcenter.blogspot.com/2014/01/self-referential-functions-and-design.html)
* [Clean Architecture — Robert C. Martin](https://8thlight.com/blog/uncle-bob/2012/08/13/the-clean-architecture.html)
