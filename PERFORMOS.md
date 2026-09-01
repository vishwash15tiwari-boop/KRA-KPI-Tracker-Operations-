# PerformOS — Employee Performance Management Platform

A real, database-backed Employee Performance Management platform built around
a **Target 1–5** model: every KRA/KPI has five target thresholds, an
employee's actual is compared against them (direction-aware — higher-is-better,
lower-is-better, or range), and the highest level cleared is the primary
result. Percentage is supporting information only.

```
Employee → Organisation → Team → KRA → KPI → Target 1–5 → Actual
  → KPI Level → KRA Level → Overall Employee Level
  → Leaderboard → Review → Analytics
```

## Sharing this branch with the KRA / KPI Tracker

This branch also hosts the **KRA / KPI Tracker** (`Code.gs` + `Index.html`,
`CLAUDE.md` — a Google Apps Script app). PerformOS is a completely different,
independent product with a different architecture; its files (`PerformOS.html`,
`app.css`, `js/`, `serve.ps1`, this file) sit at the same root level but don't
touch or depend on the Tracker's files, and vice versa.

The entry file is named **`PerformOS.html`**, not `index.html` — on a
case-insensitive filesystem (Windows, macOS by default) a folder cannot hold
both `Index.html` and `index.html` as distinct files, so this avoids colliding
with the Tracker's `Index.html` when the branch is checked out locally.

## Architecture

This runs entirely in the browser, backed by a **real IndexedDB relational
database** — not mock data, not a static demo:

- **`js/schema.js`** — the table/index/foreign-key definitions.
- **`js/db.js`** — a small relational engine over IndexedDB: transactions,
  indexed lookups, foreign-key enforcement on write, composite indexes.
- **`js/domain.js`** — all business logic, kept out of the views: the
  Target-1–5 calculation engine (direction-aware), KRA/overall aggregation
  (weighted mean, with stored components so results are always explainable),
  RBAC (`can()` / `canScope()`, enforced before every write), audit logging,
  notifications, leaderboard and analytics derivation.
- **`js/seed.js`** — realistic fictional demo data: the organisation structure
  (Leadership / Business Units / Central Functions / Support Functions, per
  the authoritative org chart), ~40 employees, a 3-KRA/8-KPI framework
  covering all three KPI directions, FY 2026–27 with 5 months of history.
- **`js/ui.js`** — app shell (sidebar, topbar, breadcrumbs, global search,
  period selector, notifications), the hash router, drawer/modal overlay
  system, and the `TargetProgress` component — the product's core visual.
- **`js/pages.js`** — the 12 sidebar modules (People: Directory / Organization
  / Teams · Performance: KRA-KPI / Targets / Performance / Reviews /
  Leaderboard · Analytics: Reports / Performance Analytics · System:
  Notifications / Administration) plus every contextual drawer and modal.

Data persists in the browser's IndexedDB across reloads. There is no server —
a deliberate response to the environment this was built in (no Node/Python
toolchain available to run a conventional backend) — but the domain layer
(`domain.js`) has no DOM dependency, so it can be lifted onto a real server
(Node/Prisma, .NET/EF, etc.) for a multi-user deployment without rewriting
the business logic.

## Running it locally

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File serve.ps1
```

Serves the app at `http://localhost:8190/`. First load seeds the database
automatically.

## Demo employee

**Rahul Sharma** — `EMP-00124` — Infra Business / Metals Team, manager Amit
Sharma. Monthly Sales ₹27L → Target 4, New Customer Revenue ₹32L → Target 5,
Collection ₹11L → Target 3 → overall **Target 4**.
