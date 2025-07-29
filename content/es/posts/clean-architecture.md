---
title: "Parte 1: Entendiendo Clean Architecture Más Allá del Diagrama"
subtitle: "Clean Architecture"
date: 2025-06-13
author: "@SilentGopher"
tags: ["Go", "Clean Architecture"]
image: "/images/posts/clean-architecture.jpg"
draft: false
---

> ⚠️ **Advertencia**: Esto no es otro artículo teórico con diagramas bonitos que solo funcionan en PowerPoint.
Hablaré de fracasos, de cómo **mis primeros intentos con Clean Architecture fueron un desastre**, y de la solución que finalmente funcionó en proyectos reales (con deadlines, jefes impacientes y requirements que cambian cada martes).
<!--more-->

## 🚀 ¿Por qué escribo esto?
Hace ya unos años, en mi primer proyecto "serio" con Go, cometí todos los errores posibles:

 1. **Ceguera arquitectónica**: Creí que poner todo en /internal automáticamente hacía mi código "limpio". Spoiler: No.

 2. **Overengineering**: Implementé una estructura Hexagonal tan "pura" que hasta el HelloWorld necesitaba 7 archivos.

 3. **Acoplamiento disfrazado**: Mis interfaces eran tan grandes que parecían clases de Java.

**Este artículo es el que me hubiera gustado leer antes de quemar 3 meses en refactors infinitos.**


## 🔪 Clean Architecture: La teoría vs. Mi realidad
La teoría dice:

> "Separa el dominio, usa interfaces, blah blah".

Mi realidad fue:

> "¿Por qué mi UserService sabe cómo se persiste un PDF en S3? ¿Quién escribió este código?… Ah, fui yo. 💀"

### **Los 3 enfoques que probé**
### 1. **Package by Layer: El clásico "cementerio de capas"**
```go
/handlers/   # <- Aquí vive el caos
/services/   # <- Aquí el "domain" se mezcla con lógica de HTTP
/repositories/ # <- ¿Por qué este método tiene 20 parámetros?
```
**Lo bueno**:

- Todos lo entienden (al principio).

- Ideal si tu equipo viene de Java/Spring.

**Lo malo**:

- En 6 meses, tu UserService termina con 3000 líneas y dependencias ocultas.

- Experiencia real: Una vez pasé 2 días debuggeando un nil pointer porque un handler llamaba directamente a un repository saltándose 3 capas.

### 2. **Package by Feature: El "sálvese quien pueda"**
```go
/users/
/payments/
/reports/  # <- Aquí hay un God Object que hace TODO
```

**Lo bueno:**

- Parece ordenado al principio.

- Los equipos pueden trabajar en "features" separadas.

**Lo malo:**

- **El infierno de la duplicación**: En un proyecto, teníamos 5 implementaciones distintas de SendEmail() porque cada feature tenía su propia lógica.

- **Dependencias vampiro**: El módulo payments importaba internamente users.Model, y cuando cambiamos la DB, todo explotó.

(Pro tip: Si ves import "../users" en tu código, prende una vela. Ya es tarde.)

## 3. **Hexagonal Architecture: Cuando la teoría choca con la práctica**
La teoría prometía:

> "Dominio puro, adaptadores intercambiables, felicidad eterna".

Mi implementación fue:

```go
/internal/
  /core/       # <- Aquí iba el "dominio"
    /domain/   # <- Terminó con 50 "entities" acopladas
    /ports/    # <- Interfaces de 100 métodos
    /services/ # <- Lógica mezclada con infra
  /adapters/   # <- Aquí el ORM se coló al dominio
```

**¿Qué salió mal?**

- **El equipo no lo entendió**: Los nuevos devs llamaban al repository desde el handler porque "era más rápido".

- **Los tests eran imposibles**: Mockear 10 interfaces para un caso de uso simple.

- **Resultado**: Una "Clean Architecture" que en realidad era un monolito con capas de abstracción innecesarias.

## 💥 El día que rompimos la arquitectura (sin querer)
O: "Por qué Juan del equipo me odia después de ese PR"
Contexto: Hace unos meses, en un sprint normal, un compañero nuevo (llamémosle Juan) recibió esta tarea:

> "Necesitamos un endpoint `/orders/user/{id}` que devuelva las órdenes. ¡Es urgente para el cliente!"

Juan, siendo eficiente, vio que ya existía un `OrderRepository` con el método perfecto:

```go
FindByUserID(userID string) ([]Order, error)
```
Y escribió esto en el handler:

```go
func (h *OrderHandler) GetOrdersByUser(w http.ResponseWriter, r *http.Request) {
    userID := chi.URLParam(r, "id")
    orders, err := h.orderRepo.FindByUserID(userID) // <- ¡Acceso directo!
    // ... (manejo de errores y respuesta)
}
```
**Parecía inocente... hasta que empezaron los problemas**:

🤯 ¿Qué salió mal?
1. **Reglas de negocio olvidadas**:
Las órdenes debían filtrarse por status != "canceled", pero como fue directo al repo, el cliente vio datos inconsistentes.

2. **El gran acoplamiento oculto**:
El handler ahora dependía de:
    - La firma del repositorio.
    - La estructura Order de la DB (que incluía campos internos como internal_notes).

3. **El test fue una pesadilla**:
Tuvo que mockear la DB... para probar un handler.

## 🔍 Diagnóstico: Violamos la Hexagonal Architecture
(Sin darnos cuenta)

El diagrama teórico decía:

> "Los handlers (adapters) deben hablar con el dominio (services), NO con la infraestructura (repositories)."

Pero en la práctica:

- **El repo se coló en el handler** como un atajo.

- **El dominio quedó fuera de la conversación** (nadie usó el OrderService).

## 💡 La solución: Contratos, no acoplamentos
🚫 Error común (que todos cometemos):
```go

// payments/module.go
type Payment struct {
    User users.UserEntity // <- ¡Acoplamiento directo a la entidad de users!
}
```
**Problema**: Si UserEntity cambia, payments se rompe.

✅ Fix real (que implementamos):
```go
// contracts/user.go
type UserDTO struct {
    ID    string
    Email string // Solo lo que necesitamos
}

// payments/module.go
type Payment struct {
    User contracts.UserDTO // <- ¡Acoplamiento a CONTRATO!
}
```
**Regla simple**:

> "Si un módulo A usa algo de B, B debe exponerlo explícitamente en su contrato.
Como una API pública: si no está documentado, no existe."


## 💡 La solución que me funcionó: Componentes + Contratos
Después de quemarme, aprendí que:  

✅ Cada componente debe ser un "mini-proyecto" (con su dominio, lógica y adaptadores).  
✅ Los contratos son sagrados (si cambias uno, rompes todo… como un API pública).  
✅ Go es simple, tu arquitectura también debería serlo.

Estructura final que usamos (y sigue viva):
```go
/cmd/
/internal/
  /users/
    /adapters/     # <- Implementacion de contratos.
    /models/      # <- Solo structs
    users_component.go     # <- Interface lógica de negocio PURA
    users_component_impl.go  # <- Implementacion lógica de negocio PURA
    users_repository.go # <- Interface privada persistencia 
    users_repository_impl.go # <- Implementacion privada persistencia en db
  /contracts/
    /users/         # <- Lo que OTROS componentes pueden usar (necesitan)
      service.go    # <- Interfaz con 3 métodos, no 20.
  /web/ # <- punto de entrada controllers/handlers que solamente se comunican con el servicio de cada component.
```
Regla de oro:

> "Si un componente necesita algo de otro, no le preguntes cómo lo hace. Pídelo en el contrato y sigue con tu vida."

(Ejemplo real: Cuando tuvimos que migrar de MySQL a PostgreSQL, solamente implementamos la interface y swicheamos. El dominio ni se enteró.)

## 🎤 Conclusión: Clean Architecture no es religión
- **No la uses si**: Tu proyecto es un MVP o tienes un equipo junior.

- **Úsala bien si**: Necesitas escalar, mantener y dormir por las noches.

- **Mi error más grande**: Pensar que "seguir el diagrama al pie" era suficiente. La clave está en definir contratos claros y hacer cumplir los límites.

> "La arquitectura limpia no se trata de carpetas perfectas, sino de poder cambiar de idea sin miedo a que todo explote."

🚀 En la Parte 2: Te mostraré el código REAL (con los errores incluidos) de cómo implementamos esto en un proyecto con 100k líneas de Go.

(Y sí, habrá ejemplos de cómo nuestro "maravilloso" contrato de PaymentService tuvo que cambiar 3 veces… y cómo lo manejamos sin morir en el intento).

📢 ¿Tú también has luchado con Clean Architecture?
Déjame saber en los comentarios.

## 📚 Referencias

* [Clean Architecture - Robert C. Martin](https://a.co/d/a3ALlXM)