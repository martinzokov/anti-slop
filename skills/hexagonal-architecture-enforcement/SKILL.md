---
name: hexagonal-architecture-enforcement
description: "Use when setting up or working in a hexagonal / ports-and-adapters codebase. Layer boundaries must be enforced by a linter or the compiler — never by convention. Includes copy-paste configs for TypeScript, Python, Java, Go, C#, and Rust."
category: software-development
---

# Hexagonal Architecture, Machine-Enforced

*(Alistair Cockburn's Ports & Adapters; Jeffrey Palermo's Onion; Robert C. Martin's Clean Architecture — same dependency rule, three names.)*

**The rule:** dependencies point inward. Domain knows nothing. Application knows domain. Adapters know application and domain. Nothing inner ever imports anything outer.

**The principle this skill exists for:** a boundary that is only written down in a README is not a boundary. An agent (or a human at 4pm on a Friday) will add `from myapp.adapters.postgres import session` inside a domain entity, the tests will pass, and the architecture will be gone six months later. The boundary must fail the build.

---

## 1. The Layers

```
                    ┌─────────────────────────────┐
                    │   adapters/  (driving)      │  http, cli, grpc, queue consumers
                    ├─────────────────────────────┤
                    │   application/              │  use cases, orchestration, ports
                    ├─────────────────────────────┤
                    │   domain/                   │  entities, value objects, rules
                    ├─────────────────────────────┤
                    │   adapters/  (driven)       │  postgres, s3, stripe, smtp
                    └─────────────────────────────┘
                       imports only ever point UP toward domain
```

| Layer | May import | May NOT import |
|---|---|---|
| `domain` | its own language's stdlib pure bits, nothing else | application, adapters, ORMs, HTTP, clock, filesystem, network |
| `application` | `domain` | adapters, concrete infrastructure, framework types |
| `adapters/*` | `application`, `domain` | **each other** (postgres adapter must not import http adapter) |
| `composition root` (`main`, `wire`, `container`) | everything | — it is the one place allowed to know all layers |

Two rules people forget:

- **Adapter-to-adapter independence** matters as much as the vertical rule. Sibling adapters importing each other is how a "hexagonal" codebase quietly becomes a ball of mud that still passes the layer check.
- **Ports live inside**, in `application` (or `domain`), as interfaces/protocols. The adapter implements the port; the port never names the adapter. If your port is called `PostgresUserRepository`, the boundary already leaked.

---

## 2. Three Enforcement Tiers

Pick the strongest tier your stack allows. They compose — tier 3 does not remove the need for tier 1's fast local feedback.

| Tier | Mechanism | Feedback | Bypassable |
|---|---|---|---|
| 1. Lint | import-linter, dependency-cruiser, eslint-plugin-boundaries, ArchUnit | seconds, local | yes (`# noqa`, disable comment) — so ban the bypass in CI |
| 2. Compiler / resolver | separate packages or modules; the inner package simply does not depend on the outer one, so the import cannot resolve | build time | no |
| 3. Build graph | Gradle/Bazel/Cargo/Nx module dependencies declared explicitly | build time, whole-repo | no |

Tier 2 is the goal: `domain` as its own package with an empty dependency list means `import adapters` is not a lint violation, it is an unresolvable name. **Prefer physical separation over rule files whenever the packaging cost is acceptable.**

---

## 3. TypeScript

### Tier 1 — dependency-cruiser (recommended: understands `import type`, node builtins, and npm packages)

`.dependency-cruiser.js` — see `configs/dependency-cruiser.js` for the full file.

```js
module.exports = {
  forbidden: [
    {
      name: "domain-is-pure",
      comment: "domain/ may only import from domain/. No app, no adapters, no npm, no node builtins.",
      severity: "error",
      from: { path: "^src/domain" },
      to: { pathNot: "^src/domain" },
    },
    {
      name: "application-not-adapters",
      severity: "error",
      from: { path: "^src/application" },
      to: { path: "^src/adapters" },
    },
    {
      name: "adapters-are-siblings",
      comment: "An adapter may not import another adapter. Talk through a port.",
      severity: "error",
      from: { path: "^src/adapters/([^/]+)/" },
      to: {
        path: "^src/adapters/([^/]+)/",
        pathNot: "^src/adapters/$1/", // $1 back-references the `from` capture group
      },
    },
  ],
  options: { tsPreCompilationDeps: true, doNotFollow: { path: "node_modules" } },
};
```

The `$1` back-reference in `to.pathNot` is the piece worth remembering — it expresses "any adapter other than my own" in one rule instead of N².

`domain-is-pure` is deliberately written as "may import nothing outside `src/domain`" rather than as a list of banned packages. That single rule covers adapters, npm packages, and node builtins at once, and it stays correct when someone adds a new dependency you never thought to ban.

Run: `npx depcruise src --config .dependency-cruiser.js`

**`typescript` must be installed in the project** (`npm i -D typescript`). Without it dependency-cruiser cruises 0 modules and prints `✔ no dependency violations found` — a green check that enforces nothing.

### Tier 1 alternative — eslint-plugin-boundaries

Use when you want violations inline in the editor and in the same ESLint run as everything else. Full config at `configs/eslint.boundaries.mjs`.

```js
"boundaries/dependencies": ["error", {
  default: "disallow",                     // enumerate allowed edges; everything else errors
  policies: [
    { from: { element: { type: "domain" } },
      allow: { to: { element: { type: "domain" } } } },
    { from: { element: { type: "application" } },
      allow: { to: { element: { types: { anyOf: ["application", "domain"] } } } } },
    { from: { element: { type: "adapter" } },
      allow: { to: { element: { types: { anyOf: ["application", "domain"] } } } } },
    { from: { element: { type: "adapter" } },   // ...and only its OWN adapter folder
      allow: { to: { element: { type: "adapter",
        captured: { adapterName: "{{from.captured.adapterName}}" } } } } },
    { from: { element: { type: "main" } }, allow: { to: { element: { type: "*" } } } },
  ],
}]
```

`default: "disallow"` is the load-bearing setting. Deny-by-default is the only mode worth using — an allow-by-default config silently permits every layer you forget to name.

Three things that make this config fail *open* (green run, zero enforcement) rather than closed:

- **No TS parser** in `languageOptions` — every file is a parse error and no boundary rule runs.
- **No `settings["import/resolver"].typescript`** — extensionless imports don't resolve, every dependency is classified "unknown", and the policies never fire. This one looks exactly like a clean codebase. Enable `boundaries/no-unknown-dependencies` so it surfaces as errors instead of silence.
- **`boundaries/dependencies` governs first-party elements only.** Third-party packages need the separate `boundaries/external` rule (`{ from: ["domain"], disallow: ["*"] }`) — without it a domain entity may freely import an ORM, which is the leak that matters most.

The composition root must be a *folder* (`src/main/`), not a `src/main.ts` file — element patterns match folders.

### Tier 2 — workspace packages

```
packages/
  domain/         package.json — "dependencies": {}
  application/    package.json — depends on @app/domain
  adapters-http/  package.json — depends on @app/application, @app/domain
  adapters-pg/    package.json — depends on @app/application, @app/domain
  main/           depends on all
```

With npm/pnpm workspaces, `import { UserRepo } from "@app/adapters-pg"` inside `packages/domain` fails module resolution. No rule file, no bypass. Add TS project references (`composite: true` + `references`) so `tsc -b` enforces the same graph and rejects cycles.

---

## 4. Python

### Tier 1 — import-linter (the right tool; `flake8-tidy-imports` bans are a weaker fallback)

`.importlinter` — full file at `configs/.importlinter`.

```ini
[importlinter]
root_package = myapp
include_external_packages = True

[importlinter:contract:layers]
name = Hexagonal layers
type = layers
containers =
    myapp
layers =
    adapters
    application
    domain
exhaustive = True
exhaustive_ignores =
    main

[importlinter:contract:adapter-independence]
name = Adapters do not know each other
type = independence
modules =
    myapp.adapters.http
    myapp.adapters.postgres
    myapp.adapters.stripe

[importlinter:contract:domain-purity]
name = Domain imports no infrastructure
type = forbidden
source_modules =
    myapp.domain
forbidden_modules =
    sqlalchemy
    django
    fastapi
    requests
    httpx
    boto3
    redis
```

Three contracts, three distinct jobs — most teams write only the first and think they are done:

- `layers` — the vertical rule. Listed **highest first**; each layer may import those below it, never above.
- `exhaustive = True` — any other module inside the container must be listed in `exhaustive_ignores` or the check fails. Without it, an agent creating `myapp/services/` invents a fourth unpoliced layer. Note `exhaustive` requires `containers`, and layer names are then relative to the container (`domain`, not `myapp.domain`) — the container-less form is a config error.
- `independence` — the sibling-adapter rule.
- `forbidden` with **external** packages — this is what actually keeps the domain pure. The layers contract only sees `myapp.*`; it will happily let a domain entity import `sqlalchemy`. Requires `include_external_packages = True`.

Run: `lint-imports` (exit code 1 on violation).

### Tier 2 — separate distributions

Split into `src/myapp_domain`, `src/myapp_application`, … each with its own `pyproject.toml` and explicit `dependencies`. Installed with `uv pip install -e`, an illegal import raises `ModuleNotFoundError` at import time and fails collection during tests.

---

## 5. Other Stacks (short recipes)

**Java / Kotlin — ArchUnit.** The best-in-class option; it has hexagonal architecture as a first-class primitive and runs as an ordinary JUnit test.

```java
@ArchTest
static final ArchRule hexagonal = Architectures.onionArchitecture()
    .domainModels("com.acme.domain.model..")
    .domainServices("com.acme.domain.service..")
    .applicationServices("com.acme.application..")
    .adapter("http", "com.acme.adapters.http..")
    .adapter("persistence", "com.acme.adapters.persistence..")
    .withOptionalLayers(false);
```

`onionArchitecture()` already enforces adapter-to-adapter independence. Add a `noClasses().that().resideInAPackage("..domain..").should().dependOnClassesThat().resideInAnyPackage("javax.persistence..", "org.springframework..")` rule for framework purity. Tier 2: Gradle multi-project with `implementation project(":domain")` declared only where legal.

**Go — the language does it for you.** `internal/` plus package-per-layer, and `go vet`-adjacent tooling:

```yaml
# .golangci.yml
linters-settings:
  depguard:
    rules:
      domain:
        files: ["**/internal/domain/**"]
        deny:
          - pkg: "database/sql"
            desc: "domain must not know about persistence"
          - pkg: "net/http"
            desc: "domain must not know about transport"
          - pkg: "github.com/acme/app/internal/adapters"
            desc: "inward dependencies only"
```

Go also forbids import cycles at compile time, which removes an entire class of boundary erosion for free. `go-arch-lint` covers the full layer graph if depguard rules get unwieldy.

**C# — NetArchTest.Rules**, same shape as ArchUnit, asserted in an xUnit test. Tier 2: separate `.csproj` per layer with `ProjectReference` only where legal — this is the idiomatic .NET answer and it is compile-time.

**Rust — Cargo workspace, tier 2 by default.** One crate per layer; `domain/Cargo.toml` with no dependencies on sibling crates. Illegal imports fail to compile. No linter needed.

---

## 6. Wiring It Into an Agentic Loop

Enforcement only changes agent behavior if the agent can run it and read the result. Four requirements:

1. **One command, documented in `CLAUDE.md`.** `make arch` or `npm run arch`. If the check is only reachable through a 12-minute CI pipeline, the agent will not use it and will discover violations after the PR.
2. **Wire it into the same gate as tests.** `npm test` / `make check` should run the architecture check. A separate optional command is a command nobody runs.
3. **Error messages must name the rule and the fix.** `dependency-cruiser`'s `comment` field and import-linter's contract `name` show up verbatim in output — write them as instructions to the next agent ("talk through a port"), not as labels.
4. **Verify the check can fail, before trusting it.** Every one of these tools has a misconfiguration that produces a green run with zero enforcement — dependency-cruiser without `typescript` installed cruises 0 modules and reports success; eslint-plugin-boundaries without an import resolver classifies everything "unknown" and fires nothing. Seed a deliberate violation (`import { save } from "../adapters/pg/repo"` inside a domain file), confirm the check goes red, then delete it. Do this once at setup and again whenever the config changes. **A passing architecture check is worthless until you have seen it fail.**
5. **Ban the bypass in CI.** `# noqa`, `// eslint-disable-next-line boundaries/*`, and `depcruise --no-config` are all escape hatches. Grep for them in CI and fail. An unpoliced escape hatch converts tier 1 back into a README.

Pre-commit hook (fast, local, no network):

```yaml
# .pre-commit-config.yaml
- repo: local
  hooks:
    - id: arch
      name: architecture boundaries
      entry: lint-imports
      language: system
      pass_filenames: false
```

**Add the rule to the prompt as well as the linter.** State the dependency rule in `CLAUDE.md` so the agent writes conforming code on the first attempt, and keep the linter so the second attempt cannot lie. Prompt without lint drifts; lint without prompt burns a correction round-trip on every feature.

---

## 7. Failure Modes to Watch For

| Smell | Why it defeats the boundary |
|---|---|
| Port named after its adapter (`PostgresUserRepository` interface in `application`) | The dependency inverted on paper only; renaming the DB now touches the core |
| ORM entity used as domain entity | `sqlalchemy`/JPA annotations *are* an outward dependency, and the layers contract cannot see them — this is why the `forbidden`/depguard external-package rule exists |
| DTO defined in an adapter, returned by a use case | Application's public signature now depends on an adapter type; the compiler enforces the inversion of your intent |
| Framework request/response objects in `application` | Same as above, and it makes the use case untestable without a web server |
| Layer check green, but `main.py` is 900 lines | Composition root is allowed to import everything — it is not allowed to *contain* logic. Nothing lints this; review it |
| Exceptions raised by domain, caught nowhere | Not a boundary violation, but the usual sign that adapters are reaching around the application layer |

---

## Quick Reference

| Stack | Tier 1 tool | Tier 2 (compile-time) |
|---|---|---|
| TypeScript | dependency-cruiser, eslint-plugin-boundaries | workspace packages + TS project references |
| Python | import-linter (`layers` + `independence` + `forbidden`) | separate distributions per layer |
| Java/Kotlin | ArchUnit `onionArchitecture()` | Gradle multi-project |
| Go | golangci-lint depguard, go-arch-lint | `internal/`, no import cycles |
| C# | NetArchTest.Rules | one `.csproj` per layer |
| Rust | — | Cargo workspace, crate per layer |

---

## Sources

- Alistair Cockburn — "Hexagonal Architecture" (2005)
- Jeffrey Palermo — "The Onion Architecture" (2008)
- Robert C. Martin — *Clean Architecture* (2017)
- Vaughn Vernon — *Implementing Domain-Driven Design* (2013), ch. 4
- Tom Hombergs — *Get Your Hands Dirty on Clean Architecture* (2019) — the ArchUnit enforcement chapter
