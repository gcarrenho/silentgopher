---
title: "Functional Options en Go: El Patrón Detrás de Constructores Limpios"
subtitle: "Functional Options Pattern"
date: 2026-04-20
author: "@SilentGopher"
image: "/images/posts/functional-options/functional-options.png"
description: "Cómo dejar de pasar booleanos y strings vacíos a tus constructores en Go. Un análisis profundo del patrón Functional Options — cuándo usarlo a nivel constructor vs método, y cuándo no usarlo."
draft: false
---

> 💡 Si la firma de tu función ya tiene cinco parámetros, el sexto no la hace más difícil de leer — la hace peligrosa.

<!--more-->

## 🚧 La Creep de Parámetros: La Muerte Lenta por Mil Argumentos

A los seis meses de un proyecto Go en producción, me encontré mirando esto:

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

Cada parámetro fue agregado por una buena razón — en su momento. El flag de CRM vino de un requerimiento de negocio. El token era necesario para llamar a una API externa. El locale era para formateo. El `includeDeleted` era para el panel de administración.

**El costo real no estaba en la función. Estaba en cada call site:**

```go
// Llamada en producción — ¿qué significa "false, "", "en-US", false"?
profile, err := userService.GetProfile(ctx, id, false, "", "en-US", false)

// Llamada de admin — encontrá la diferencia:
profile, err := userService.GetProfile(ctx, id, false, "", "en-US", true)
```

Tres meses después, alguien agregó un séptimo parámetro. Para propagarlo, tuvieron que tocar 40 archivos. El PR tenía 800 líneas de `false` y `""` sin contexto.

Existe un patrón que hace que esto se detenga. Se llama **Functional Options**. La idea fue descripta originalmente por [Rob Pike](http://commandcenter.blogspot.com/2014/01/self-referential-functions-and-design.html) en enero de 2014 y popularizada por [Dave Cheney](https://dave.cheney.net/2014/10/17/functional-options-for-friendly-apis) en dotGo ese mismo año. Una vez que lo ves, no podés ignorarlo.

---

## 🔑 El Patrón: Funciones que Configuran

La idea es simple: en lugar de pasar configuración como parámetros básicos, pasás **funciones** que aplican esa configuración a un struct.

```go
// El struct de opciones — guarda todo lo que un servicio puede configurar
type UserServiceOptions struct {
    crmClient      CRMClient
    defaultLocale  string
    includeDeleted bool
}

// Una opción es simplemente una función que muta el struct de opciones
type UserServiceOption func(*UserServiceOptions)
```

Después creás **funciones constructoras** para cada opción:

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

Y el servicio las aplica en un loop:

```go
type UserService struct {
    storer  UserStorer
    options UserServiceOptions
}

func NewUserService(storer UserStorer, opts ...UserServiceOption) *UserService {
    options := UserServiceOptions{
        defaultLocale: "en-US", // valores por defecto sensatos
    }
    for _, opt := range opts {
        opt(&options)
    }
    return &UserService{storer: storer, options: options}
}
```

**Los call sites se vuelven autodocumentados:**

```go
// Servicio simple — sin enriquecimiento, sin config especial
plainService := user.NewService(storer)

// Servicio con enriquecimiento de CRM — variante del panel de admin
adminService := user.NewService(storer,
    user.WithCRMEnrichment(crmClient),
    user.WithDeletedUsers(),
)
```

Sin adivinar posiciones. Sin `false` silenciosos. El código se lee como una oración.

---

## 🚧 ¿Por Qué No un Config Struct?

Antes de las functional options, la solución estándar era un struct de configuración:

```go
type ServerConfig struct {
    Port    int
    Timeout time.Duration
    TLS     bool
}

func NewServer(cfg ServerConfig) *Server
```

Esto funciona — hasta que chocás con la **ambigüedad del zero value**. `Port: 0` puede significar dos cosas completamente distintas:

- *"No lo seteé, usá el default (8080)"*
- *"Quiero el puerto 0 para que el OS elija uno libre"*

Son indistinguibles. En un test que necesita un puerto libre, no podés expresar esa intención.

La variante con puntero (`*ServerConfig`) resuelve el zero-value, pero ahora los callers tienen que pasar `nil` para el caso default — y la regla de Dave Cheney es clara: **`nil` nunca debe ser un argumento requerido de una función pública**. Pone la carga en el caller y abre la puerta al estado mutable compartido.

Las functional options evitan ambos problemas: la firma variádica hace que el caso default no requiera ningún argumento, y las options se componen de forma segura sin compartir estado interno.

---

## ⚡ Dos Lugares para Aplicar Options: Constructor vs. Método

Acá está lo interesante — y donde la mayoría de los tutoriales se cortan demasiado rápido.

Podés aplicar functional options en **dos niveles distintos**:

1. **Nivel constructor**: configura cómo el servicio *funciona* (dependencia, toggle de comportamiento)
2. **Nivel método**: configura cómo *esta llamada específica* se comporta

Se ven igual sintácticamente, pero resuelven problemas distintos.

### Constructor-level (configuración del servicio)

```go
// El cliente CRM es una dependencia — nunca cambia por request
svc := user.NewService(storer, user.WithCRMEnrichment(crmClient))

// Cada llamada usa el mismo cliente CRM
svc.GetProfile(ctx, id)
svc.GetProfile(ctx, otherID) // misma configuración
```

Usá constructor options para: **dependencias, feature flags, timeouts, comportamientos por defecto**.

### Method-level (variación por request)

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

Llamado así:

```go
// El token cambia por cada HTTP request — no puede setearse en construcción
profile, err := svc.GetProfile(ctx, id, user.WithAuthToken(r.Header.Get("Authorization")))
```

Usá method options para: **datos específicos del caller, tokens de sesión, overrides por llamada**.

---

## 🔬 Código Real: El Refactor del Product Service

Acá hay un servicio que combina ambos niveles — un `ProductService` que sincroniza productos y puede opcionalmente enriquecerlos desde una **API de catálogo de proveedores** externa. El código original:

```go
// ⚠️ Antes: option de nivel método mezclando datos de sesión + toggle de comportamiento
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

Llamado así:

```go
err := svc.Upsert(ctx, product, WithSupplierSync(supplierToken))
```

**¿Qué molesta?** La option mezcla dos cosas:
1. Un **toggle de comportamiento** (`SyncFromSupplier: true`) — esto es *configuración*, responde "¿usa este servicio el catálogo del proveedor?"
2. Una **credencial de sesión** (`SupplierToken`) — esto es *dato por request*, cambia en cada llamada HTTP

Tienen ciclos de vida distintos y no pertenecen a la misma option.

---

### ✅ La Versión Refactorizada

**Paso 1:** El `SupplierClient` se inyecta en construcción — es una dependencia, no un detalle del request.

```go
type ProductService struct {
    storer   ProductStorer
    supplier ports.SupplierClient // nil significa "no sincronizar con proveedor"
}

func NewProductService(storer ProductStorer, opts ...ProductServiceOption) *ProductService {
    svc := &ProductService{storer: storer}
    for _, opt := range opts {
        opt(svc)
    }
    return svc
}

// Option de constructor: conecta la dependencia
func WithSupplierClient(client ports.SupplierClient) ProductServiceOption {
    return func(s *ProductService) {
        s.supplier = client
    }
}
```

**Paso 2:** El token del proveedor viaja por `context.Context` — donde pertenecen los datos por request.

```go
// Middleware o handler setea el token en context:
ctx = auth.WithSupplierToken(ctx, r.Header.Get("X-Supplier-Token"))

// El servicio lo lee del context cuando lo necesita:
func (s *ProductService) Upsert(ctx context.Context, product model.Product) error {
    storedProduct, err := s.storer.FindByID(ctx, product.ID)
    if err != nil && !errors.Is(err, ports.ErrNotFound) {
        return fmt.Errorf("finding product | ID: %s --> %w", product.ID, err)
    }
    notFound := errors.Is(err, ports.ErrNotFound)

    // Si el servicio fue configurado con un supplier client, lo usa
    if s.supplier != nil {
        token, ok := auth.SupplierTokenFromContext(ctx)
        if !ok {
            return fmt.Errorf("supplier sync configurado pero no hay token en context")
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

**Wiring en `AppContainer`:**

```go
// Sin sincronización con proveedor (servicio default)
basicProductService := product.NewService(productStorer)

// Con sincronización del catálogo (para el endpoint de vendedores)
enrichedProductService := product.NewService(productStorer,
    product.WithSupplierClient(supplierClient),
)
```

**Los call sites ahora son limpios — sin option que propagar:**

```go
// Antes:
err := svc.Upsert(ctx, product, WithSupplierSync(supplierToken))

// Después:
err := svc.Upsert(ctx, product)
```

El token ya está en `ctx`. El comportamiento ya está configurado en el servicio.

---

## 📌 Constructor vs. Método: La Tabla de Decisión

| Pregunta | Constructor option | Method option |
|----------|--------------------|---------------|
| ¿Configura una dependencia (DB, client)? | ✅ | ❌ |
| ¿Activa un feature que aplica a todas las llamadas? | ✅ | ❌ |
| ¿El dato cambia por cada HTTP request (token, locale)? | ❌ | ✅ |
| ¿Diferentes callers necesitan comportamiento distinto en runtime? | ❌ | ✅ |
| ¿Es opcional pero idéntico en la mayoría de los call sites? | ✅ | ❌ |
| ¿Es relevante solo para una llamada específica? | ❌ | ✅ |

**Heurística:** Si estás pasando la misma option en cada llamada, es configuración — movela al constructor. Si el valor cambia entre llamadas, es por request — dejala en el método o movela al context.

---

## ❌ Cuándo NO Usar Functional Options

El patrón es poderoso, pero no es gratis.

**No lo uses para parámetros requeridos.** Las functional options implican opcionalidad. Si un servicio no puede funcionar sin un parámetro, ese parámetro va directo en la firma del constructor — no detrás de una option.

```go
// ❌ No hagas esto:
svc := NewUserService(user.WithStorer(storer)) // ¿qué pasa si se olvidan?

// ✅ Hacé esto:
svc := NewUserService(storer) // lo requerido es requerido
```

**No lo uses para funciones simples.** Un helper con 2 parámetros no necesita toda la maquinaria de functional options. Agregá la abstracción cuando tenés 3+ parámetros opcionales que van a crecer con el tiempo.

**No lo uses cuando las options interactúan.** Si `WithOptionA` y `WithOptionB` combinadas producen un estado inválido, vas a necesitar lógica de validación. En ese punto, un struct `Config` con un `Validate()` explícito es más honesto:

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

## ⚖️ Ventajas y Desventajas

| | Functional Options |
|---|---|
| ✅ **Call sites autodocumentados** | `WithCRMEnrichment(client)` supera a `true, client, 0, ""` |
| ✅ **Backwards compatible** | Agregás nuevas options sin tocar call sites existentes |
| ✅ **Valores por defecto sensatos** | Aplicás defaults en el constructor antes de aplicar las options |
| ✅ **Testeable en aislamiento** | Construís exactamente la variante que necesitás en cada test |
| ❌ **Más archivos, más tipos** | Cada option es una nueva función y tipo exportado |
| ❌ **Control flow oculto** | Options aplicadas en un loop son menos explícitas que asignación directa |
| ❌ **Validación manual** | El compilador no te avisa si olvidaste options "casi requeridas" |
| ❌ **Sobreuso** | Aplicarlo a cada función es cargo culting |

---

## 📌 Conclusión: Las Options Son Diseño de API

El patrón de functional options no es solo sobre evitar listas largas de parámetros. Es sobre hacer visible la **intención** de una llamada en el código.

Cuando leés:

```go
svc := product.NewService(storer, product.WithSupplierClient(supplierClient))
```

Sabés inmediatamente que **esta instancia del servicio** sincroniza desde un catálogo de proveedor. Sin decodificar booleanos. Sin leer el body de la función para entender qué significaba `true`.

Y cuando leés:

```go
err := svc.Upsert(ctx, product)
```

Sabés que la llamada no tiene comportamiento especial — es el camino default.

> El objetivo del buen diseño de API es que el call site se lea como una decisión, no como una estructura de datos.

Este patrón se conecta directamente con lo que construimos en [Parte 1](/posts/clean-architecture) y [Parte 2](/posts/package-by-component): cada servicio expone un contrato, y ese contrato debe ser tan angosto y legible como el comportamiento de negocio que representa.

💬 ¿Estás usando functional options en tu proyecto? ¿A nivel constructor o a nivel método?
Contame en los comentarios.

---

## 📚 Referencias

* [Dave Cheney — Functional options for friendly APIs (dotGo, 2014)](https://dave.cheney.net/2014/10/17/functional-options-for-friendly-apis)
* [Rob Pike — Self referential functions and design (2014)](http://commandcenter.blogspot.com/2014/01/self-referential-functions-and-design.html)
* [Clean Architecture — Robert C. Martin](https://8thlight.com/blog/uncle-bob/2012/08/13/the-clean-architecture.html)
