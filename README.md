# OMP Operations KRA/KPI Tracker

The single operating platform for the OMP Supply & Demand teams (Plastic and Metal).
It replaces a 25-sheet spreadsheet process with one application built around a single
loop:

> **Plan → Execute → Track → Measure → Review → Improve**

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

## Repository layout

```
src/
  appsscript.json            manifest
  server/                    16 .gs files, numeric prefixes set the load order
  client/                    Index, Styles, ClientCore, ClientComponents,
                             ClientBoot + 9 view modules
docs/
  WORKBOOK-ANALYSIS.md       the reverse-engineering record — read this first
  ARCHITECTURE.md            system shape, engine design, request lifecycle
  DATA-MODEL.md              all 23 tables, keys and relationships
  CALCULATION-ENGINE.md      every formula, with its source cell
  DEPLOYMENT.md              setup, configuration, operations, troubleshooting
tests/
  gas-harness.js             in-memory Apps Script environment
  engine.test.js             121 assertions against real workbook data
  fixtures/                  raw rows exported from the source workbook
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

The engine is tested against the workbook's own computed values, not against
invented numbers. `tests/engine.test.js` stages the raw `Overall Shipments` and
`Seller Onboarding` rows, runs the real sync, and asserts the engine reproduces
what the spreadsheet's formulas produced.

```bash
node tests/engine.test.js     # 121 passed, 0 failed
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
