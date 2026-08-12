# Architecture

## 1. The shape of the system

```
                    ┌──────────────────────────────────────────┐
   Browser          │  Single-page app (HtmlService)           │
                    │  Index · Styles · ClientCore ·           │
                    │  Components · 9 view modules             │
                    └───────────────────┬──────────────────────┘
                                        │  google.script.run.api(action, payload)
                                        │  one RPC surface, one envelope
                    ┌───────────────────▼──────────────────────┐
   Apps Script      │  15_Api.gs — router, auth gate, error    │
   (V8)             │  shaping, timing, audit                  │
                    └───────────────────┬──────────────────────┘
                    ┌───────────────────▼──────────────────────┐
                    │  Services                                │
                    │  Planning · Accounts · Activity ·        │
                    │  Reports · Dashboard · Review · Sync ·   │
                    │  Admin                                   │
                    └───────────────────┬──────────────────────┘
                    ┌───────────────────▼──────────────────────┐
                    │  06_Engine.gs — the calculation engine   │
                    │  metric(key, window, scope) → value +    │
                    │  contributors                            │
                    └───────────────────┬──────────────────────┘
                    ┌───────────────────▼──────────────────────┐
                    │  03_Repository.gs — typed sheet access,  │
                    │  memoisation, batched writes, locking    │
                    └───────────────────┬──────────────────────┘
                    ┌───────────────────▼──────────────────────┐
   Google Sheets    │  23 DB_* tables (see DATA-MODEL.md)      │
                    └───────────────────┬──────────────────────┘
                                        │  Sync (nightly + on demand)
                    ┌───────────────────▼──────────────────────┐
   Source workbook  │  Overall Shipments · Seller Onboarding · │
   (unchanged)      │  MTD Pulse Summary · OMP-Sellers/Buyers  │
                    └──────────────────────────────────────────┘
```

The source workbook is **read-only** to this application. Nothing the product does
writes back into the sheets the operations teams already use.

## 2. Server files, in load order

Apps Script concatenates `.gs` files alphabetically, so the numeric prefixes are
the dependency order.

| File | Responsibility |
|------|----------------|
| `00_Config.gs` | Constants, enumerations, the activity taxonomy, the metric registry, and the tunable business rules with their shipped defaults. |
| `01_Schema.gs` | Every table's columns and types. The schema is declared, not implied. |
| `02_Util.gs` | Typed errors, identifiers, numeric helpers, and **the window algebra** — the only place that decides what MTD, LMTD or FYTD mean. |
| `03_Repository.gs` | The data access layer. One read per table per execution, batched writes, document-level locking for read-modify-write. |
| `03b_BusinessFunction.gs` | The Business Function registry — replaces the hardcoded Plastic/Metal `CATEGORY` enum as the source of truth for what business functions exist and how each is calculated. |
| `04_Auth.gs` | Identity, permissions and data scope — two separate questions, answered separately. Plus the audit trail. |
| `05_Bootstrap.gs` | Schema creation and forward-only migration; seeds the KRA/KPI library transcribed from the workbook, plus the Business Function registry and the Onboarding/Collections starter taxonomies. |
| `06_Engine.gs` | **The calculation engine.** Dispatches to `legacyMetric_` (OMP, hand-written) or `GenericEngine` (everything else) — see §10. |
| `06b_GenericEngine.gs` | **The generic calculation engine.** Interprets `DB_MetricDef`/`DB_ActivityTypeDef` rows so a business function beyond OMP computes its metrics from configuration alone. |
| `07_Planning.gs` | Cycles, KRA/KPI structure, assignments, account plan, annual plan, weekly plan. Enforces the publish gate. |
| `08_Accounts.gs` | Sellers, buyers, the onboarding pipeline, the document checklist, receivables. |
| `09_Activity.gs` | The "Update Once" surface, evidence rules, verification, voiding, `myDay`, and the drill-down resolver. |
| `10_Reports.gs` | Generated outputs: scorecard, leaderboard, POC-Wise, Region-Wise, daily review, weekly review, coverage, account performance. |
| `11_Dashboard.gs` | Executive tiles, trend and forecast, the alert engine, data-quality detection, daily snapshots. |
| `12_Review.gs` | Frozen review snapshots, acknowledgement, sign-off, action items, the review pack. |
| `13_Sync.gs` | Idempotent import from the source workbook, with self-healing dimensions. |
| `14_Admin.gs` | Users, regions, configuration, exports. |
| `15_Api.gs` | The single RPC router and the first-paint bootstrap payload. |
| `16_Code.gs` | `doGet`, the spreadsheet menu, and the three scheduled jobs. |

## 3. The calculation engine

Everything reduces to one signature:

```js
Engine.metric(metricKey, window, scope, { trace })
  → { value, count, contributors, meta }
```

* **`metricKey`** — an entry in the metric registry (`METRICS` in `00_Config.gs`).
* **`window`** — a half-open interval `[start, end)` produced by `DateUtil`.
* **`scope`** — `{ category, stream, regionId?, pocUserId?, gstin?, materialType? }`.
* **`contributors`** — the identity of every record behind the number. This is what
  makes the traceability promise real rather than aspirational.

Three properties follow from this shape:

1. **One definition per number.** `GMV_CR` for a POC, a region, a category, a
   material or an account is the same function with a different scope. There is no
   second implementation to drift.
2. **Targets are data, not code.** A KPI declares *where its target comes from*
   (`ACCOUNT_PLAN`, `PCT_OF_METRIC`, `BALANCE_PLUS_MTD`, `RATE_PER_DAY`, `MANUAL`)
   and the engine resolves it. Changing "50% of onboarded sellers" to 60% is a
   configuration change.
3. **Attribution is explicit.** The same shipment counts for the seller's POC under
   `SUPPLY` and the buyer's POC under `DEMAND`. `stream` chooses which side owns it,
   and an unscoped total attributes to supply so nothing is double-counted.

### Fact loading

`Engine.facts(category)` loads every fact table once per execution and decorates it.
A dashboard computing 7 metrics × 3 windows × 13 scopes performs **one read per
table**, not 273. `Api` clears the cache at the end of every request so a warm Apps
Script instance never serves stale data.

## 4. Request lifecycle

```
client            api(action, payload)
  │
  ├─ 15_Api      route lookup → 404 if unknown
  ├─ 04_Auth     Auth.current()  → identity or NOT_PROVISIONED
  ├─ service     Auth.require(PERM)  → authority check
  │              Auth.scope()        → row visibility
  ├─ 06_Engine   metric / target / evaluate
  ├─ 03_Repo     memoised reads, batched writes inside a document lock
  ├─ 04_Audit    every mutation recorded with before/after
  └─ 15_Api      { ok, data, meta } | { ok: false, error: { code, message } }
                 then Engine.invalidate() + Repository.invalidate()
```

Errors carry a **stable code** (`VALIDATION`, `FORBIDDEN`, `CYCLE_LOCKED`,
`NOT_PROVISIONED`, …) that the client branches on, and a message written for the
person reading it. Stack traces never reach the browser.

## 5. Permissions and scope

Two independent questions, never conflated:

| | Question | Mechanism |
|---|---|---|
| **Authority** | May this user perform this kind of action? | `Auth.can(PERM.X)` against `ROLE_PERMISSIONS` |
| **Visibility** | Which rows may this user see or touch? | `Auth.scope()` → `{ level, categories, regionIds, pocUserIds }` |

A POC and a Regional Head both hold `ACTIVITY_WRITE`; their scopes differ. Every
service applies both. Writes additionally pass `Auth.requireOwnership()`, so a POC
can only record work against their own name unless they hold `ACTIVITY_WRITE_ANY`.

| Role | Plan | Execute | Measure | Review | Administer |
|------|------|---------|---------|--------|------------|
| ADMIN | ✓ | ✓ | ✓ | ✓ | ✓ |
| LEADERSHIP | view | verify | all | ✓ | audit |
| TEAM_LEAD | ✓ | ✓ any | all | ✓ | sync, audit |
| RH | ✓ | ✓ region | region | ✓ | — |
| POC | view | own only | own | acknowledge | — |
| VIEWER | view | — | scoped | — | — |

## 6. Client

No framework, no CDN — Apps Script's `HtmlService` sandbox and a strict CSP make
external dependencies impractical, and the application is small enough not to need
one.

* **`ClientCore`** — RPC with request coalescing and optional caching, application
  state, a hash router, formatting, and DOM helpers with event delegation.
* **`ClientComponents`** — the shared visual vocabulary: metric tiles, tables,
  inline-SVG charts, form fields, and the drill-down drawer.
* **View modules** — one per route, each a `render(host, params)` function
  registered with the router.

Every value interpolated into markup passes through `F.esc()`. Tables and charts
scroll inside their own containers; the page body never scrolls horizontally.

### Traceability in the UI

Any element carrying a `data-drill` payload opens the drill-down drawer, which calls
`activity.drilldown` and renders the contributing records with date, account, POC,
measure, remark, evidence link and source table. This is the same code path from a
dashboard tile, a scorecard row, a POC-Wise cell and a daily-review figure.

## 7. Scheduled jobs

| Job | When | Purpose |
|-----|------|---------|
| `jobNightlySync` | 02:00 IST | Pull shipments, onboarding and pulse from the source workbook. |
| `jobDailySnapshot` | 06:00 IST | Freeze each metric so trends survive later fact corrections. |
| `jobDailyAlerts` | 08:00 IST | Email each owner their grouped attention list — one message, not seven. |

## 8. Performance

| Concern | Approach |
|---------|----------|
| Sheet reads | Memoised per execution in `Repository`; one `getValues()` per table. |
| Fact decoration | Once per category per execution in `Engine.facts`. |
| Writes | `upsertMany` batches contiguous row runs into single `setValues()` calls. |
| Concurrency | `LockService` document lock around every read-modify-write. |
| Client round trips | First paint is a single `session.bootstrap` call carrying identity, cycles and all reference data. |
| Duplicate requests | Identical in-flight calls share one promise. |

## 9. Testing

`tests/gas-harness.js` supplies in-memory implementations of `SpreadsheetApp`,
`PropertiesService`, `LockService`, `Session` and `Utilities`, then loads the real
`.gs` files into a VM context. `tests/engine.test.js` stages the raw
`Overall Shipments` and `Seller Onboarding` rows exported from the source workbook,
runs the real sync, and asserts the engine reproduces the workbook's own computed
values.

```
npm test                            # engine.test.js + generic-engine.test.js
node tests/engine.test.js           # the LEGACY (OMP) engine — 126 assertions
node tests/generic-engine.test.js   # the GENERIC engine and Business Function layer — 44 assertions
```

The `engine.test.js` fixtures are the actual August 2026 data, so those tests are a
regression suite against the business process rather than against invented numbers.
`generic-engine.test.js` proves the config-driven layer described in §10 below —
including that creating a business function beyond OMP, planning it and operating
it end to end requires no engine code, only API calls.

## 10. The Business Function layer

The first nine sections describe an architecture built for one domain — OMP's
Plastic/Metal marketplace. The product vision calls for a platform where any
number of business functions (OMP-Metal, OMP-Plastic, Onboarding, Collections,
and whatever comes after) each configure their own KRAs, KPIs, activity types
and metrics, and where adding a new one is a configuration act, not a code
change. This section is the seam that makes that true without touching the
tested OMP engine.

### The registry

`DB_BusinessFunctions` (read through `BusinessFunction`, `03b_BusinessFunction.gs`)
replaces the hardcoded `CATEGORY` enum as the source of truth for what values the
`category` column may hold and what each one means: its `calculatorMode`
(`LEGACY` | `GENERIC`), its `streamMode` (`SUPPLY_DEMAND` | `SINGLE`) and stream
labels, and whether it plans against a per-account book (`hasAccountPlan`, true
only for OMP). The `category` column itself is untouched everywhere it already
exists — it was already an unconstrained string on 18 tables with no special
handling in `Repository`, so nothing needed to change there. OMP's two functions
keep their literal historical values (`Plastic`, `Metal`).

### Two calculators behind one dispatcher

```
Engine.metric(metricKey, window, scope)
        │
        ├─ scope.category is LEGACY  → legacyMetric_()        (06_Engine.gs, unchanged)
        └─ scope.category is GENERIC → GenericEngine.metric()  (06b_GenericEngine.gs)
```

`legacyMetric_` is the exact hand-written switch statement the engine has always
had — same code, same tests, same 126 assertions. `GenericEngine.metric()`
interprets a `DB_MetricDef` row instead of running hand-written code:

| Aggregation | Meaning |
|---|---|
| `COUNT` | Number of `DB_Activities` rows of a given `activityType`, in window and scope. |
| `SUM` | Σ of a measure field (`count` \| `measureA` \| `measureB` \| `measureC`) on those rows. |
| `DISTINCT_COUNT` | Distinct values of a chosen row field among matching rows. |
| `RATIO` | `numeratorMetric ÷ denominatorMetric × multiplier`, both resolved recursively through the same `Engine.metric()` dispatcher — a ratio may reference a LEGACY metric too. |
| `DERIVED` | A small hand-written recursive-descent arithmetic evaluator (`+ - * / ( )`, metric keys as variables) — no `eval`/`Function`, so an admin-authored expression is parsed, never executed as code. |

Every branch returns the same `{ value, count, contributors, meta }` shape,
built from the same `activityTrace_()` traceability payload the legacy engine
uses (exposed from `06_Engine.gs` for `06b_GenericEngine.gs` to reuse), so
drill-down works identically regardless of which calculator produced a number.
`Engine.target()`'s `MANUAL`, `PCT_OF_METRIC` and `RATE_PER_DAY` bases are
already metric-agnostic and work unchanged for GENERIC KPIs; `ACCOUNT_PLAN` and
`BALANCE_PLUS_MTD` stay LEGACY-only and are simply never offered to a function
where `hasAccountPlan` is false. `Dashboard.executive()` follows the same
dispatch shape: a GENERIC business function's tiles are built from its own
cycle's KPIs (`genericExecutive_`, `11_Dashboard.gs`) rather than OMP's
hand-picked six headline metrics.

### Config-only taxonomy

`DB_ActivityTypeDef` and `DB_MetricDef` are the config-only analogs of the
hardcoded `ACTIVITY_TYPES` array and `METRICS` object in `00_Config.gs`. A
GENERIC business function's entire activity taxonomy and metric set are rows in
these tables — authored through the `businessFunction.*` / `activityTypeDef.*`
/ `metricDef.*` API actions (routed straight to `BusinessFunction` /
`ActivityTypeDef` / `MetricDef` in `15_Api.gs`, no `14_Admin.gs` indirection)
and the Administration → Business Functions screen, or seeded once at
bootstrap for Onboarding and Collections. Every key an admin authors is
checked against the static OMP arrays so it cannot collide with a built-in
key (`ActivityTypeDef.save` / `MetricDef.save`).

`DB_Activities` gained four trailing columns to support this — `subjectName`
(a free-text stand-in for functions with no `DB_Accounts` counterpart) and
three generic numeric slots, `measureA`/`measureB`/`measureC`. A GENERIC
activity type's `measures` declare which physical column each logical field
(e.g. `amount`) writes to; OMP's measures already name a real column directly
(`quantityMT`, `ratePerKg`, `amountINR`) and are unaffected.

### What "no code change" actually means

Proven end to end in `tests/generic-engine.test.js`: creating a fifth business
function, giving it an activity type and a metric, planning a cycle for it
(with no seed library — a Team Lead builds its first KRA from scratch through
the same "Add KRA" flow OMP uses), assigning it, publishing it, recording
activity against it and reading its scorecard and dashboard back — all through
`api()` calls, none through a `.gs` file edit.

### What is still OMP-only

`DB_Accounts` (sellers/buyers/GSTIN), the account plan, the annual onboarding
plan, and the deeper report suite (`Reports.pocWise`, `regionWise`,
`coverage`, `accountPerformance`, `dailyReview`, the weekly plan) are OMP's
marketplace model and have no GENERIC equivalent yet. The client hides the
screens built on them (`Components.notApplicable()`) for a business function
where `hasAccountPlan` is false, rather than letting them error against data
that cannot exist. A GENERIC business function's operating loop — plan,
execute, measure, review via the scorecard, dashboard and drill-down — works
in full; the OMP-specific reporting layer is a natural follow-up once a real
GENERIC function needs it.
