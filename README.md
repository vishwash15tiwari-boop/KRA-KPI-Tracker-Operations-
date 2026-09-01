# PerformOS — Employee Performance Management Platform

A Google Apps Script web app, shipped as **two deployable files** —
`Code.gs` (backend) and `Index.html` (frontend) — built around a
**Target 1–5** model: every KRA/KPI carries five target thresholds, an
employee's actual is compared against them (direction-aware), and the highest
level cleared is the primary result. Percentage is supporting information only.

```
Employee → Organisation → Team → KRA → KPI → Target 1–5 → Actual
  → KPI Level → KRA Level → Overall Employee Level
  → Leaderboard → Review → Analytics
```

## Deploy

1. Create a new Apps Script project (<https://script.google.com>).
2. Paste **`Code.gs`** into the script file, and add an HTML file named
   **`Index`** containing `Index.html`.
3. Optional but recommended: enable *Show "appsscript.json" manifest file* in
   Project Settings and paste `appsscript.json` over the generated manifest.
4. **Deploy → New deployment → Web app**, then open the URL.

No setup step is required. On first load the script creates its own backend
spreadsheet, provisions 16 tabs, and seeds a complete demo organisation
(structure, ~46 people, KRAs/KPIs, FY 2026–27 targets and five months of
performance). To point it at a specific spreadsheet instead, set the
`PERFORMOS_DB_ID` script property before first load. `provisionAndSeed()` can
also be run manually from the editor, and is safe to re-run.

Run **`selfTest()`** from the editor to verify the calculation engine — it
checks the demo figures, all three KPI directions, every target state and the
weighted aggregation, and logs a pass/fail line for each.

## Architecture

The backend owns all business logic, so scoring is authoritative and the client
only ever visualises.

**`Code.gs`**
- *Repository* — one spreadsheet tab per table (16 tables), positional column
  contract, `read_`/`write_`/`append_`/`upsert_`/`bulkUpdate_`.
- *Calculation engine* — `levelFor_()` resolves the achieved target level for
  higher-is-better, lower-is-better and range KPIs; `aggregate_()` performs the
  weighted rollup and keeps its components so a result can always be explained;
  `recompute_()` persists KPI levels, KRA rollups and the overall employee level.
- *Leaderboard / analytics* — derived from performance rows on demand, never a
  stored rank, so they are always reproducible.
- *Authorization* — `resolveSession_`, `can_`, `canScope_` enforce role and
  manager-chain scope on **every write**, plus period locking; an audit row is
  written for each change and notifications are raised on real events.
- *API* — `apiBootstrap` returns session + the whole model for a period in one
  round trip; each write returns a freshly recomputed model.

**`Index.html`** — the entire frontend in one file: app shell (sidebar, topbar,
breadcrumbs, global search, period selector, notifications, role switcher), the
hash router, the drawer/modal overlay system, the reusable `TargetProgress`
component (full ladder / hero / compact ticks / pill), and the twelve modules:

| People | Performance | Analytics | System |
|---|---|---|---|
| Employee Directory | KRA / KPI | Reports | Notifications |
| Organization | Targets | Performance Analytics | Administration |
| Teams | Performance | | |
| | Reviews | | |
| | Leaderboard | | |

Employee Profile, Team, KRA, KPI, Target and Review are **contextual
drill-downs** (drawers), not sidebar items — the interface follows a
progressive-disclosure model: concise lists → drawers for detail → modals for
actions.

## Demo employee

**Rahul Sharma** — `EMP-00124` — Infra Business / Metals Team, manager Amit
Sharma. Monthly Sales ₹27L → Target 4, New Customer Revenue ₹32L → Target 5,
Collection ₹11L → Target 3 → overall **Target 4** (weighted score 4.3).

## A note on the specification's §17 example

The brief's worked example lists KPI levels 4, 5, 3, 4 at weights 40%, 20%,
15%, 25% and prints a weighted aggregate of **4.00**. Those figures actually
sum to **4.05** (1.6 + 1.0 + 0.45 + 1.0). Both map to Target 4, so the
published conclusion stands; this implementation reports the arithmetically
correct score, and `selfTest()` asserts 4.05.

## Relationship to the other branches in this repository

This repository's other branches hold the **KRA / KPI Tracker**, a different
product. PerformOS lives on its own branch with no shared history, so work on
one never disturbs the other.
