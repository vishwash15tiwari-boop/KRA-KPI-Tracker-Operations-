# OMP Operations KRA/KPI Tracker

A single operating platform for Operations KRA/KPI management, built around one loop:

> **Plan → Execute → Track → Measure → Review → Improve**

It shipped first for the OMP Supply & Demand teams (Plastic and Metal), replacing a
25-sheet spreadsheet process. The platform now hosts any number of **Business
Functions** on the same loop, each configuring its own KRAs, KPIs, activity types and
metrics: **OMP-Metal** and **OMP-Plastic** (built-in, tested against the source
workbook) plus **Onboarding** and **Collections** (config-driven — see
[`ARCHITECTURE.md` §10](docs/ARCHITECTURE.md#10-the-business-function-layer)). A fifth
function is a configuration act, not a code change.

Built entirely on **Google Apps Script**, with Google Sheets as the backend data
repository during the transition.

---

## What it does

**Team Leads assign once.** At the start of a month a Team Lead opens a cycle,
reviews the KRA/KPI structure, sets weightages and per-account targets, assigns POCs
and publishes. Publishing is a gate: weightages must total 100% per stream, every KPI
must be linked to a measurable metric, and every assigned POC must exist. The
spreadsheet assumed those rules; the application enforces them.

**POCs update once.** A POC records the work they actually did — a visit, a proposal,
a document collected, a follow-up — with a remark and, where it matters, an evidence
link. That is the whole of their obligation. They never touch a tracker, a report or
a dashboard.

**The system calculates everything.** Achievements, completion percentages, run rates,
SLA adherence, trends, forecasts, weighted KPI scores, KRA scores, regional and team
performance are all derived. There is exactly one place in the codebase that produces
a KPI number.

**Every number is traceable.** Click any figure on any screen and a drawer opens with
the operational records behind it: the date, the account, the person, the measure, the
remark, the evidence link and the source table. Nothing exists without an underlying
record.

**Leadership stops asking.** The dashboard states what is achieved, what is pending,
who owns each item, why it is stuck and what the next step is — with a per-day run
rate showing whether the gap is closing or widening.

---

## The six principles, and where they live

| Principle | Implementation |
|-----------|----------------|
| **Assign Once** | `07_Planning.gs` — a cycle is published once and locked; assignment is one action across many POCs and KPIs. |
| **Update Once** | `09_Activity.gs` — one form, eleven activity types. Synced facts are read-only; POCs annotate, never invent. |
| **Calculate Everything** | `06_Engine.gs` — `metric(key, window, scope)`. No other file performs an operational calculation. |
| **Complete Traceability** | Every metric returns `contributors`; every mutation writes to `DB_Audit`; records are voided with a reason, never deleted. |
| **Action-Oriented** | `11_Dashboard.gs` — seven alert kinds, each naming an owner, the size of the gap and the next step. One click converts an alert into a tracked action. |
| **Simple by Design** | A POC sees three things on My Day: what needs attention, their scorecard, and a button to log work. |

---

## Business Functions

Every business function — OMP-Metal, OMP-Plastic, Onboarding, Collections, or one an
admin adds — runs on the same six principles above. OMP's two functions compute their
metrics from hand-written, tested engine code (`calculatorMode: LEGACY`); every other
function computes purely from configuration (`calculatorMode: GENERIC`) — its activity
types and metrics are rows in `DB_ActivityTypeDef`/`DB_MetricDef`, authored from
**Administration → Business Functions** or seeded once at bootstrap. Its KRAs and KPIs
are then built from the same Monthly Plan screen a Team Lead already uses for OMP.

Onboarding a function beyond the first four needs no code: create it, give it activity
types and metrics, and plan its first cycle — `tests/generic-engine.test.js` does
exactly this for a fifth function end to end. See
[`ARCHITECTURE.md` §10](docs/ARCHITECTURE.md#10-the-business-function-layer) for the
full design.

---

## Repository layout

```
src/
  appsscript.json            manifest
  server/                    18 .gs files, numeric prefixes set the load order
                              (03b_BusinessFunction, 06b_GenericEngine are the
                               config-driven Business Function layer, see below)
  client/                    Index, Styles, ClientCore, ClientComponents,
                             ClientBoot + 9 view modules
docs/
  WORKBOOK-ANALYSIS.md       the reverse-engineering record — read this first
  ARCHITECTURE.md            system shape, engine design, request lifecycle,
                              §10 the Business Function layer
  DATA-MODEL.md              all 26 tables, keys and relationships
  CALCULATION-ENGINE.md      every OMP formula, with its source cell
  DEPLOYMENT.md              setup, configuration, operations, troubleshooting
tests/
  gas-harness.js             in-memory Apps Script environment
  engine.test.js             126 assertions against real workbook data (OMP)
  generic-engine.test.js     44 assertions against the config-driven layer
  fixtures/                  raw rows exported from the source workbook
scripts/
  generate-quickdeploy.js    regenerates dist/quickdeploy/ from src/
```

---

## Workbook → product

Of the 25 sheets in the source workbook, **15 become read-only outputs of the engine**.

| Source sheet | Becomes | Human input |
|--------------|---------|-------------|
| `OMP-Supply & Demand KRA & KPI` | Planning → KRA/KPI library | Team Lead, monthly |
| `OMP-Sellers` / `OMP-Buyers` (target columns) | Planning → Account Plan | Team Lead, monthly |
| `POC-Wise!D` | Planning → Annual Onboarding Plan | Team Lead, yearly |
| `Weekly Plan vs Achievement` (target half) | Planning → Weekly Plan | Team Lead, weekly |
| `Aug Buyer Plan` | Pipeline → Buyer Onboarding | POC, on change |
| `Sheet1`, `Sheet1 (1)` | Pipeline → Prospects | POC, on change |
| `Seller Onboarding` | Activity → Onboarding | synced |
| `Overall Shipments` | Activity → Transactions | synced |
| `MTD Pulse Summary` | Activity → Field Visits | POC, daily |
| `POC-Wise`, `Region-Wise` | *generated* | — |
| 10 per-POC scorecards, `BDM Summary` | *generated* | — |
| `WhatsApp Summary` | *generated* — Daily Review | — |
| `Onboarded Sellers VS Pulse` | *generated* — Coverage | — |

---

## Verification

The OMP engine is tested against the workbook's own computed values, not against
invented numbers. `tests/engine.test.js` stages the raw `Overall Shipments` and
`Seller Onboarding` rows, runs the real sync, and asserts the engine reproduces
what the spreadsheet's formulas produced. `tests/generic-engine.test.js` proves the
config-driven Business Function layer — planning, executing and measuring a
business function that has never had a line of engine code written for it.

```bash
npm test                            # both suites
node tests/engine.test.js           # 126 passed, 0 failed — OMP (Plastic/Metal)
node tests/generic-engine.test.js   # 44 passed, 0 failed — Onboarding/Collections/config-driven
```

Covered: the window algebra (MTD, LMTD, FYTD, fiscal year), the scoring formulas
(achievement, the 105% cap, weighted score, rating bands, competition ranking),
regional and per-POC attribution, onboarding counts, the transaction-validity rule,
plan-target derivation, traceability, RBAC and the generated reports.

Sample assertions, each tied to a source cell:

| Assertion | Workbook cell | Value |
|-----------|---------------|-------|
| MTD transactions | `WhatsApp!D11` | 35 |
| MTD tonnage | `WhatsApp!D12` | 430.245 MT |
| MTD GMV | `WhatsApp!D13` | ₹2.1523311 Cr |
| North MTD GMV | `WhatsApp!D23` | ₹1.4104036 Cr |
| Ashish Kumar Rai MTD GMV | `WhatsApp!D44` | ₹0.7456501 Cr |
| Weighted score | `BDM Summary!K3` | 46.5714 |
| Completed onboardings | `WhatsApp!C8` | 110 |

---

## Defects found in the source process

Fourteen are documented in `docs/WORKBOOK-ANALYSIS.md` §8. Five change reported
numbers:

1. **GMV basis is inconsistent** — FYTD sums invoice totals *including* GST while
   MTD and every target use the taxable amount. The two differ by 18%, so FYTD was
   never comparable to the sum of its months.
2. **Realised rate divides an ex-GST amount by 1.18** — reporting ₹42.57/kg where the
   invoice says ₹50/kg.
3. **YTD onboarding uses the calendar year while YTD transactions use the fiscal
   year** — the same "YTD" label meaning two different windows on adjacent sheets.
12. **The pulse target is hard-coded at `25 × 3`** and never deducts recorded leave.
13. **The headline totals on `OMP-Sellers` are filter-sensitive.** Row 3 uses
    `SUBTOTAL`, so it silently reports whatever is not hidden. LMTD GMV reads
    ₹0.919 Cr there and ₹1.153 Cr on two other sheets that compute it without a
    filter — a 25% discrepancy in a number used for review.

Items 1, 2, 3 and 12 ship as **config-gated corrections**: the default is the
corrected behaviour, and one settings change reproduces the legacy figure exactly.
Every affected dashboard states which basis is active. Item 13 has no legacy mode —
reproducing it would mean reproducing a filter nobody recorded.

---

## Getting started

Full instructions in [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md). In brief:

```bash
cp .clasp.json.example .clasp.json    # add your scriptId
clasp login && clasp push
```

Then in the Apps Script editor run **`setupFirstRun`**, deploy as a web app
(*execute as the accessing user*, *anyone in your organisation*), and open the URL.
The application walks you through connecting the source workbook and creating the
first cycle.

To have every push deploy automatically instead of running `clasp push` by
hand, see [`docs/DEPLOYMENT.md` § 13](docs/DEPLOYMENT.md#13-continuous-deployment-optional)
— a GitHub Actions workflow is already in `.github/workflows/deploy.yml`,
it just needs your script ID and credentials as repository secrets.

---

## Targets this product is built to

| Goal | How it is met |
|------|---------------|
| Team Lead completes monthly planning in minutes | Cloning a cycle carries the KRA structure and the account plan forward; one action assigns a whole KRA set to many POCs. |
| POC spends under ten minutes a day | One screen, one form, no trackers. |
| No KPI requires manual calculation | The engine is the only producer of a number. |
| Dashboards update without intervention | Every read is computed from live facts; nothing is cached across requests. |
| Every metric is traceable | Every metric returns its contributing records; every mutation is audited. |
| Bottlenecks visible before the review | Seven alert kinds, run-rate pacing, and a data-quality panel that surfaces what the spreadsheet hid. |
| Leadership never asks for a file again | The review pack assembles the entire meeting in one call. |
