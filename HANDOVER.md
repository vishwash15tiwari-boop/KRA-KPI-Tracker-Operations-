# KRA & KPI Tracker — Handover

**To:** Vishwash Tiwari
**From:** Srinivasa Reddy Dundi
**Date:** 10 September 2026
**App name in the UI:** Performance Tracker

This document is written so you can pick the project up without reading the
code first. It covers what the app is, where every piece lives, how data flows
in, the rules that decide a number, what is finished, what is half-built, and
the traps that have already cost time.

Read §11 (Open items) and §12 (Traps) before changing anything.

> **§16 is an addendum covering everything that changed after 10 September.**
> Where it disagrees with sections 1-15, §16 wins. Read it second.

---

## 1. What the app does

It is a Google Apps Script web app that renders an individual monthly
**scorecard** for each of 38 people across the Metal and Plastic teams.

For each person it holds a set of **KRAs** (e.g. *New Seller Acquisition*),
each with a **KPI** (e.g. *Monthly Target Achievement (%)*), each with a
**weightage** that sums to 100 for that person. Every KPI has a five-rung
**ladder** (Target 1 … Target 5). The person's **actual** is scored against
that ladder to produce a **level** from 1 to 5, and the weighted mean of their
levels is their overall level.

The important structural point, and the one that shapes everything else:

> **A ladder rung is not the same thing as a numeric target.**
>
> Most KPIs here use a *ratio* ladder — `0.6 / 0.75 / 0.9 / 1.0 / 1.05`. The
> level comes from **actual ÷ target**. So "9 new sellers" is not a rung; it is
> the **denominator**. Putting it into the rungs would turn a ratio ladder into
> a count ladder and score everyone wrongly.
>
> That is why there are two separate tables: `TARGETS` holds the five rungs,
> `PLAN` holds the numeric target. See §5.

---

## 2. Where everything lives

| Thing | Location |
|---|---|
| Apps Script project | Script ID `1BYfLvwrBaKQUnFw3tXd4RMeZxkwM4urwORHIw4kWxaOrDoyD-kaVjeiO` |
| Backend database | A Google Sheet, id in script property `PERFORMOS_DB_ID` |
| GitHub repo | `vishwash15tiwari-boop/KRA-KPI-Tracker-Operations-` |
| Local working copy | `C:\Claude - Project\kra-kpi-tracker` |

### Deployable files — there are only two

| File | Lines | Server-side name |
|---|---|---|
| `Code.gs` | ~2,600 | `Code` |
| `Index.html` | ~1,830 | **`Index`** — the name must be exactly this; `doGet` calls `HtmlService.createHtmlOutputFromFile('Index')` |

Plus `appsscript.json` (manifest). Everything else in the folder is local
tooling and is excluded by `.claspignore`.

### Manifest settings that matter

```json
"timeZone": "Asia/Kolkata",
"webapp": { "executeAs": "USER_DEPLOYING", "access": "DOMAIN" }
```

`executeAs: USER_DEPLOYING` means **the app runs as whoever created the
deployment**, and therefore reads the source workbooks with *that* person's
Drive access. This is why ownership was migrated. If you redeploy, it starts
running as you, and the backend sheet must be reachable by you.

### Push / deploy

```bash
clasp push -f
```

`clasp deploy` was repeatedly blocked by a local permission classifier during
development; deploying from the Apps Script editor is the reliable route.

---

## 3. Script properties

| Property | Purpose |
|---|---|
| `PERFORMOS_DB_ID` | **The only pointer to the backend spreadsheet.** |
| `PERFORMOS_ADMINS` | Break-glass admin list, comma or space separated. |
| `PERFORMOS_OPEN_ACCESS` | While set, anyone who opens the link gets `super_admin`. **Dev/UAT only — turn this off before real use.** |
| `PERFORMOS_SEEDED` | Set to `'3'` once the database has been seeded. |

> **Do not rename the `PERFORMOS_*` properties** even though the UI is now
> called Performance Tracker. They are not display text. Renaming
> `PERFORMOS_DB_ID` makes the app create a *fresh empty database*; renaming
> `PERFORMOS_ADMINS` locks every account out. The code carries this warning at
> the declaration site too.

### Re-seeding from scratch

Delete `PERFORMOS_DB_ID` **and** `PERFORMOS_SEEDED`, then open the web app.
The first page load seeds and commits.

Do **not** call `provisionAndSeed()` and stop there — it populates the cache
and stamps `PERFORMOS_SEEDED`, but only `commit_()` writes rows. Running it
alone leaves a headers-only sheet plus a "seeded" flag, i.e. a permanently
blank dashboard.

---

## 4. The database

One Google Sheet, one tab per table, first row = header. Read once per request
into `_CACHE`; written back by `commit_()`.

| Table | Columns |
|---|---|
| `TEAMS` | id, name, code, lead_id, note, status |
| `EMPLOYEES` | id, name, designation, team_id, sub_group, region, manager_id, status, email |
| `KRAS` | id, team_id, perspective, name, status |
| `KPIS` | id, kra_id, name, goal, source, unit, status |
| `ASSIGNMENTS` | id, employee_id, kra_id, kpi_id, weightage, status, updated_by, updated_at |
| `TARGETS` | id, employee_id, kpi_id, period_id, **t1..t5**, version, updated_by, updated_at |
| `PLAN` | id, employee_id, kpi_id, period_id, **target_value**, unit, source, rule, basis_value, updated_by, updated_at |
| `PERFORMANCE` | id, employee_id, kpi_id, period_id, actual, manual_level, level, kind, direction, note, status, updated_by, updated_at |
| `PERIODS` | id, name, kind, sort, status |
| `USERS` | id, name, email, role_id, employee_id |
| `AUDIT` | id, ts, actor, entity_type, entity_id, action, old_value, new_value, reason |
| `SETTINGS` | key, value |

### Data-layer helpers (`Code.gs`)

`read_(table)` · `write_` · `append_` · `upsert_` · `del_` · `bulkUpdate_` ·
**`commit_()`**

> `commit_()` **must** be called before an API function returns, or the
> request's changes are silently discarded.

### Deterministic ids

Ids are derived, not random, so re-running an import updates rather than
duplicates:

- team — `'team_' + slug_(name)`
- employee — `'EMP-' + slug_(name).toUpperCase().replace(/-/g,'').slice(0,12)`
- plan — `'pl_' + employee_id + '_' + kpi_id + '_' + period_id`
- KRA/KPI ids hashed from their natural keys

---

## 5. `TARGETS` vs `PLAN` — read this twice

| | `TARGETS` | `PLAN` |
|---|---|---|
| Holds | the five ladder rungs, **as the original text** | one number |
| Example | `> 28 Days`, `TGT-20 Days`, `≥ ₹9 Cr` | `9`, `0.35099785` |
| Meaning | the bar for each level | the **denominator** of a ratio ladder |
| Written by | the app's Bands editor | `importTargets()` from the Target Sheet, or a derived rule |

`PLAN.source` is one of:

- `target_sheet` — typed by hand in the Target Sheet
- `derived` — computed by a rule (§7)
- `manual` — entered in this app

`PLAN.rule` and `PLAN.basis_value` record *how* a derived number was reached,
so a person can see why their target is what it is instead of being handed a
bare number. The UI shows `rule` as the Target cell's tooltip.

---

## 6. Data sources — the connection flow

Three external workbooks. **All are read-only to this app.** Nothing is ever
written back to them.

```
  ┌─ SOURCE_SHEET_ID ─────────── 1c0_pP4Mmye5s5D_vzoxrvJ-utkLb6JhD69TvvOBbjoo
  │  KRA/KPI framework: who has which KRA, which KPI, what weightage,
  │  and the five ladder rungs.  Seeded once into TEAMS/EMPLOYEES/
  │  KRAS/KPIS/ASSIGNMENTS/TARGETS.
  │
  ├─ TARGETS_SHEET_ID ────────── 1AWHM6Cmtf0hFkdQtzlryVw0pRTzehiJ-u-yNjQbTFTc
  │  "Target Sheet".  Tabs: Metals, Plastics, Employee Directory.
  │  The hand-typed monthly numeric targets.  ──> PLAN
  │
  └─ SHIPMENTS_SHEET_ID ──────── 1JCM55z-FaTCUJk0oNxbyHokPQBIsq3DlUZW3Rsf9GhI
     "MM_CT Dashboard V1", 28 tabs.  The transaction ledger.
     ──> PERFORMANCE   (NOT BUILT YET — see §9)
```

### The Target Sheet layout

Metals and Plastics hold the same information in **different columns**, so
everything is located by header text and never by a fixed index.

```
Metals      r2  c0,c1 METALS       c3 JUNE  c5 JULY  c7 AUGUST  c9 SEPTEMBER
            r3  c1 EMPLOYEE NAME   c2 KRA   then Target/Achievement pairs

Plastics    r2  c1 PLASTICS        c4 JUNE  c6 JULY  c8 AUGUST  c10 SEPTEMBER
            r3  c2 EMPLOYEE NAME   c3 KRA   c1 carries SUPPLY / DEMAND
```

- The employee name appears **once per block** and is blank on the rows
  beneath, so the reader carries it down.
- Months name no year. `FY_START_YEAR = 2026` supplies it: Apr–Dec → 2026,
  Jan–Mar → 2027.
- `Employee Directory` (r2: TEAM, EMPLOYEE NAME, ROLE, EMPLOYEE ID) has only
  30 rows against our 38 people and its names differ from the KRA workbook.
  **It is not used for matching** — targets are matched against the KRA
  workbook's own names — so those variants are harmless. Do not "fix" the
  import by switching to the Directory.

### `MM_CT → Raw_POC_Targets` is NOT a target source

That tab holds `New Seller Onboarding Tgt` and `GMV_Cr (Target)` in a far more
convenient POC-keyed layout, and it is tempting. The KRA owner ruled it out.
Two sources for a number that decides someone's rating is one too many. Its
*achieved* columns remain fair game.

---

## 7. Derived targets

Three (now six) KRAs have targets the business computes rather than types.
They apply **from June 2026 onward** (`DERIVED_FROM_PERIOD = 'per_2026-06'`).

| KRA | Team | % | Basis |
|---|---|---|---|
| Transaction from Existing Sellers | Plastic | 50% | sellers onboarded up to end of previous month |
| Transaction from New Onboarded Sellers | Plastic | 20% | sellers onboarded this month |
| Retention of Existing Transacted Sellers | **Metal** | **50%** | sellers who transacted last month |
| Retention of Existing Transacted Sellers | **Plastic** | **70%** | sellers who transacted last month |
| Transaction from Existing Buyers | Plastic | 60% | buyers onboarded up to end of previous month |
| Transaction from New Onboarded Buyers | *any* | 20% | buyers onboarded this month |

**Why retention differs by team:** Metal handles supply *and* demand, so 50%.
Plastic handles supply only, so 70%. The workbook's own goal text agrees with
both, and the Plastics tab labels its KRAs `… @ 50%`, `… @ 20%`, `… @ 70%`,
which independently corroborates the Plastic figures. The Metal 50% rests on
the KRA owner's instruction plus the goal text, not on a label in the sheet.

Implementation notes:

- **Team-specific rules must come first** in `DERIVED_RULES` — first match
  wins, so a team-named rule has to be seen before a team-agnostic one for the
  same KRA.
- A KRA matching a rule whose team does *not* match yields **no rule at all**,
  rather than falling through to somebody else's percentage.
- `derivedTarget_` returns `null` before June 2026, for YTD, and for an unknown
  basis. Rounding is `Math.ceil` — you cannot acquire 4.2 sellers.
- **The basis values are not wired up yet.** They need the achievement data of
  §9. Until then no `derived` PLAN row is produced.

---

## 7b. The rating scale — on target = 3 of 5

> ⚠️ **SUPERSEDED on 15 Sep 2026 — see §16.2.** On target is **Target 4**, and
> the thresholds below are no longer the ones in force. The section is kept
> because the rewrite it describes really did happen to 76 live rows, and
> anyone reading an audit entry from that week needs to know what it meant.

Decided by the KRA owner on 10 Sep 2026 and **applied**: for a KPI scored as a
percentage of target, the five thresholds are

| % of target | Rating |
|---|---|
| 80% | 1 |
| 90% | 2 |
| **100% — on target** | **3** |
| 110% | 4 |
| 120% | 5 |

Rounding is **highest threshold cleared**, which is what `levelFromBands_`
already did. 98% of target clears 90% but not 100%, so it rates 2.
Nearest-threshold rounding was considered and rejected: it would award an
on-target rating to somebody who missed.

Before this, the workbook's `0.6 | 0.75 | 0.9 | 1.0 | 1.05` put on-target at
rating **4**.

### What it changed, and what it deliberately did not

`applyRatingScale()` rewrote **76 target rows across 18 people**. The full
picture from `previewRatingScale()`:

| Rows | Have a target | Rewritten | Ladder |
|---|---|---|---|
| 106 | 76 | **76** | `0.6 \| 0.75 \| 0.9 \| 1 \| 1.05` |
| 61 | 0 | 0 | `0.8 \| 0.85 \| 0.9 \| 0.95 \| 1` |
| 9 | 8 | 0 | `15 \| 10 \| 5 \| 3 \| 2` — descending, absolute |
| 3 | 2 | 0 | `0.013 \| 0.012 \| …` — descending, absolute |
| 29 | 0 | 0 | eleven text / ₹ / day / quarter ladders |

A row is rewritten only when **all four** hold: a `PLAN` target exists for that
person+KPI+month (so there is a denominator at all), all five bands are
numeric, they ascend, and the largest is ≤ 2.

> That last test is the one that matters. `15 | 10 | 5 | 3 | 2` is **DSO in
> days**. Rewriting it to 0.8–1.2 would score a 20-day DSO as 2000% of target.
> `previewRatingScale()` lists every skip with its reason, so nothing is
> silently left behind.

`applyRatingScale()` is idempotent — a row already on the scale is left alone —
so it is safe to re-run, and it must be re-run after any re-seed (§3), because
a re-seed rebuilds `TARGETS` from `SRC_SEED`, which still holds the old ladders.

### 🔴 Two inconsistencies this leaves open

**1. DSO still has its target at rating 4.** 8 DSO rows have a numeric target
(3 days) but an absolute descending ladder, so "on target = 3" does not hold
for them. Either the DSO ladder is re-authored so 3 days lands on the third
rung, or DSO is accepted as scored on its own absolute scale. **A KRA-owner
decision, not a code one.**

**2. Half the app has no numeric target at all.** 122 of 208 assignments were
skipped for exactly that reason, and the 61-row ladder has *zero* targets. The
cause is structural: the Target Sheet has only **Metals** and **Plastics**
tabs, so of the 38 people only the ~20 on those two teams can receive one.
**Collections, Onboarding and Open Marketplace – Control Tower have no target
source in any workbook.** Their ratio KPIs cannot be scored until one exists.

---

## 8. Target import — DONE

`previewTargetImport()` → dry run, writes nothing.
`importTargets()` → the real write.

Both are the same function (`importTargetsFromSheet_(dryRun)`) behind a flag,
deliberately: **a preview that matches by different logic than the write it
previews earns trust it has not tested.**

### Result of the run on 10 Sep 2026

```
104 KRA rows: 104 matched a person, 104 matched a KRA, 104 reached a KPI
317 target values read, 282 importable, 35 dropped as a rule percentage
names NOT matching a person (0)
KRA labels NOT matching a KRA (0)
person+KRA with no assignment (0)
WRITTEN: 282 rows upserted into PLAN
```

### How matching works

1. **Person** — `normName_` (uppercase, strip punctuation, collapse spaces).
2. **KRA** — `kraKey_`, which strips trailing *decoration* from the label:
   - a bare number: `Transaction from Existing Sellers @ 50%` → `… SELLERS`
   - a unit word (`CR`, `CRORES`, `MT`, `KG`, …): `GMV (Crores)` → `GMV`

   It strips **one guarded token at a time**, never "drop the last word" — that
   would fold *New Seller Acquisition* onto *New Buyer Acquisition* and hand one
   person another person's target. `DAYS` is deliberately **not** a unit word,
   because *DSO Days* is a real KRA.
3. **KPI** — via `ASSIGNMENTS` (employee + KRA → exactly one KPI; verified that
   no person carries the same KRA twice). **No assignment ⇒ the row is refused
   and reported, not invented.** A plan no scorecard reads is worse than a
   visible gap.

### The 35 dropped values

Metals typed the **rule percentage** into the target column where Plastics
typed a **count**:

| Tab | KRA | July | August |
|---|---|---|---|
| Metals | Retention of Existing Transacted Sellers | `0.5` | `0.5` |
| Metals | Transaction from New Onboarded Buyers | `0.2` | `0.2` |
| Plastics | Transaction from Existing Sellers | `7` | `8` |

Nobody is being asked to retain half a seller. Any target equal to its own
rule's percentage is dropped and reported; the derived engine supplies the real
count. Guarded both ways — a genuine `0.5 Cr` GMV target **is** kept, because
GMV has no derived rule.

### PLAN → dashboard

`buildModel_` indexes PLAN by `period|employee|kpi` and puts `plan_target`,
`plan_unit`, `plan_source`, `plan_rule`, `plan_months` on every scorecard row.
The scorecard has a **Target column between Ladder and Actual**, with the rule
as its tooltip.

**A monthly target SUMS across a YTD span; it does not average** (5+7+8 sellers
= a target of 20) — unlike a *level*, which averages. `plan_months` vs
`months_total` exposes a partial YTD target, and the UI prints "2 of 3 mo" so
an incomplete sum is never read as a full-year ask.

---

## 9. Achievements — NOT BUILT

This is the main outstanding piece. The readers and a coverage dry run exist;
nothing computes or writes an achievement yet.

### The problem

`Raw_Shipments` (324 rows × 62 columns) is the transaction ledger, and it
**carries no POC**. It names the seller and buyer only:

| Column | |
|---|---|
| c3 `shipment_status` | 6 values; **CANCELLED excluded** per the KRA owner |
| c4 `shipment_created_date` | decides the month |
| c22 `seller_name` / c23 `seller_category` | Plastic \| Metal |
| c26 `buyer_name` / c27 `buyer_category` | |
| c35 `dispatched_quantity` | |
| c41 `shipment_value` | **RUPEES** |

So attribution depends entirely on a **name join** to `POC_data` — two tabs
maintained separately. That join is the fragile heart of the feature, which is
why `previewAchievementJoin()` measures it before any number is computed.

`POC_data` (322 × 6) is a **two-tier header** like the Target Sheet:

```
r1   "Plastic Seller"   .   .   .   "Plastic Buyer"
r2   SellerName | POC   .   .       Buyer Name | POC
```

`readPocMap_` finds it by locating a cell reading exactly `POC`; the name
column is the one to its **left** and the group label sits above that — so a
`Metal Seller` pair added later just works.

### The measured coverage

`previewAchievementJoin()`, after the POC work of this section. **Re-run it any
time — it writes nothing.**

```
323 shipments; 15 CANCELLED excluded -> 308 counted
  by category:  Plastic 175,  Metal 132,  (none) 1
  GMV of counted shipments: 37.19 Cr

seller -> POC matched  271/308     <- the ceiling for SELLER-side KRAs
buyer  -> POC matched  301/308     <- the ceiling for BUYER-side KRAs
reaching a PERSON      307/308
  Plastic:  175 of 175
  Metal:    132 of 132
  (none):     0 of 1     <- one junk row: blank status, blank category
```

Before the `Raw_Sellers` / `Raw_Buyers` fallback and the name reconciliation,
Metal was **12 of 132**. It is now complete.

### 🔴 Which side matched decides which KRAs can be scored

307 of 308 reaching *a person* is the headline, but it is **not** the number to
build a seller KRA on. A seller-side KRA — *Transaction from Existing Sellers*,
*Retention of Existing Transacted Sellers*, *New Seller Acquisition* — needs the
**seller** POC. The buyer side cannot stand in for it.

So the real ceilings are **271/308 for seller KRAs** and **301/308 for buyer
KRAs**, and the 37 shipments that resolved only through their buyer must **not**
be added to a seller KRA. Doing so would silently inflate somebody's seller
numbers with transactions whose seller nobody owns.

The report prints both figures with that label on them, for exactly this reason.

### Accounts still absent from all three POC sources

10 seller names and 3 buyer names appear on shipments but in no POC source —
`DIWAKAR ENTERPRISES PRIVATE LIMITED`, `METALLIX STEEL AND ALLOYS`,
`A.G.A TRADERS`, `ICONIC TRADE LINKS`, `EKTA ENTERPRISES` and similar, almost
all Metal, plus `M/S. S.D.TEXTILES`, `DAYAMOY STORE` and
`M/S HINDALCO INDUSTRIES LIMITED`.

These are a **data-entry gap in the source workbooks**, not a code problem: the
account exists in `Raw_Shipments` but nobody has been recorded against it in
`POC_data`, `Raw_Sellers` or `Raw_Buyers`. The fix is to have the teams fill
them in. `previewAchievementJoin()` lists them by name and material every run.

### 🟡 `POC_data` is Plastic only — but `Raw_Sellers` / `Raw_Buyers` close the gap

`POC_data` holds 320 Plastic seller accounts and 105 Plastic buyer accounts and
**no Metal list at all**, which is why Metal sits at 12/132.

The Metal source was then found. **Both `Raw_Sellers` and `Raw_Buyers` carry a
`POC_Name` column**, and both cover Metal *and* Plastic:

| Tab | Rows | Account name | Material | POC | Distinct POCs |
|---|---|---|---|---|---|
| `Raw_Sellers` | 233 | c5 `business_name` | c2 `business_category` | **c31 `POC_Name`** | 19 |
| `Raw_Buyers` | 121 | c5 `business_name` | c2 `business_category` | **c30 `POC_Name`** | 10 |

So the attribution chain becomes:

```
Raw_Shipments.seller_name  --name+material-->  POC_data   (Plastic only)
                           --name+material-->  Raw_Sellers.POC_Name   (both)
Raw_Shipments.buyer_name   --name+material-->  POC_data   (Plastic only)
                           --name+material-->  Raw_Buyers.POC_Name    (both)
```

`POC_data` stays the first lookup — it is the tab the teams maintain by hand —
with `Raw_Sellers` / `Raw_Buyers` as the fallback. **This is implemented**:
`pocForChain_([POC_data, accountMap], name, category)`. It took Metal from
12/132 to 132/132.

### ✅ POC-name reconciliation — settled and implemented

Of 21 distinct POCs in `POC_data`, five matched no employee. The KRA owner
ruled on each on 10 Sep 2026 and the rules are now in code as an **explicit
table**, not a fuzzy matcher:

| POC as written | Ruling | How it is handled |
|---|---|---|
| `Praveen Raj P/Adarsh Krishnan V` | some sellers supply **both** materials; the count follows **the material supplied** | split on `/`, then pick the name whose **team matches the shipment's category** |
| `Raju B/Adarsh Krishnan V` | same | same |
| `Adarsh Krishnan V` | means Adarsh Krishna, as does a bare `Adarsh` | alias → `ADARSH KRISHNA` |
| `Panchal Rishi` | means Rishi Panchal | alias → `RISHI PANCHAL` |
| `Nomul Aravind` | not an employee; ignore for now | ignore list |

The shared-account rule needs no guesswork, because the roster settles it:

| POC | Team |
|---|---|
| `ADARSH KRISHNA` | **Metal** |
| `PRAVEEN RAJ P` | **Plastic** |
| `RAJU B` | **Plastic** |
| `RISHI PANCHAL` | **Plastic** |

So a Plastic shipment on a shared account goes to Praveen or Raju and a Metal
one goes to Adarsh. **If a shared cell is ever ambiguous** — both candidates on
the same team, or neither on the shipment's — `resolvePocEmployee_` returns
`null` with a reason rather than awarding it to either.

> **Why an explicit table and not a fuzzy/reversed-name matcher.** A matcher
> clever enough to turn `Panchal Rishi` into `Rishi Panchal` would also have
> turned `Nomul Aravind` into `ARVIND JAKKULA` — a real employee, on the
> Control Tower team, with nothing to do with these accounts. Failing to place
> a name is safe; placing it on the wrong person is not. `tests/poctest.js`
> pins this.

`#N/A` (which appears in `Raw_Buyers.POC_Name`) counts as an empty cell, and it
**must be caught before the slash split** — splitting `#N/A` on `/` yields
`#N` and `A`, two things that are not names.

### Relevant functions

| Function | Does |
|---|---|
| `splitPocCell_` | one cell → the names in it, `#N/A` filtered first |
| `canonPocName_` | applies `POC_ALIASES` |
| `resolvePocEmployee_` | cell + material → one employee, or `null` **with a reason** |
| `readAccountPoc_` | `Raw_Sellers` / `Raw_Buyers` → a `material\|name → POC` map |
| `pocForChain_` | tries `POC_data` first, then the account maps |

To add a name later, edit `POC_ALIASES` / `POC_IGNORE` at the top of the POC
section in `Code.gs`. Do not add a heuristic.

### The material guard

`pocFor_(map, name, category)` requires the **material to match**, using the
material parsed out of the group label. A group stating no material covers
everything. This is what makes the Metal gap show up *as a gap* instead of
quietly crediting Metal shipments to Plastic POCs — see §12 #5.

### What still has to be written

1. ~~Add the `Raw_Sellers` / `Raw_Buyers` fallback~~ — done.
2. ~~Settle the five POC-name problems~~ — done.
3. Aggregate per person per month: transaction counts, GMV, quantity.
   Remember `shipment_value` is rupees and GMV targets are crore.
4. Feed the derived-rule bases (sellers onboarded, sellers transacted last
   month, buyers onboarded) — `Raw_Sellers.onboarded_date` (c22) is the
   onboarding signal, and it is filled on only 149 of 232 rows.
5. Write `PERFORMANCE.actual`, then let the existing band engine score it.

---

## 10. Identity and access

`resolveSession_` resolves the signed-in email in this order:

```
USERS.email  →  EMPLOYEES.email  →  'no_access'
then: PERFORMOS_ADMINS  → super_admin   (break-glass, overrides the sheet)
then: PERFORMOS_OPEN_ACCESS on → super_admin   (dev/UAT only)
```

**The unknown-email fallback is `no_access`, not `super_admin`.** That is
deliberate and was an explicit change. It is also exactly why the break-glass
property exists: with a `no_access` fallback, one wrong cell in `USERS` locks
out *every* account including whoever has to fix it, and sheet cells are easy
to get subtly wrong.

`email_()` normalises addresses before every comparison — it strips a `mailto:`
prefix (Sheets adds one when it auto-links) and all whitespace. A single
trailing space in `USERS.email` was enough to deny a legitimate admin.

### Roles

| Role | Permissions |
|---|---|
| `super_admin` | `*` |
| `hr_admin` | view, edit_target, edit_framework, enter_actual, admin, export |
| `business_head` | view, edit_target, edit_framework, enter_actual, export |
| `team_leader` | view, edit_target, enter_actual, export |
| `manager` | view, enter_actual, export |
| `employee` | view, enter_own |
| `auditor` | view, export |
| `no_access` | *(none)* |

A role name not in this table is coerced to `no_access` — a typo in the sheet
must not widen access.

### `scopeModel_` — the disclosure boundary

`apiBootstrap` originally returned **all 38 scorecards regardless of role**.
`scopeModel_` now filters the model to what the session may see, and is applied
to all 8 API responses.

> ⚠️ It **reassigns** `m.employees`, `m.rows`, `m.teams`, `m.audit` — it does
> **not** mutate them in place. Those arrays *are* the `_CACHE` arrays, so
> splicing them would **delete rows from the spreadsheet** on the next
> `commit_()`. There is a test that fails if anyone converts this to in-place
> mutation. Do not "optimise" it.

---

## 11. Open items

| # | Item |
|---|---|
| 1 | **Achievements** — the whole of §9. Largest remaining piece. |
| 2 | ~~Metal POC source~~ **Done** — `Raw_Sellers.POC_Name` / `Raw_Buyers.POC_Name` wired in behind `POC_data`. Re-run `previewAchievementJoin()` to confirm the Metal coverage. |
| 2b | ~~Five unmatched POC names~~ **Done** — aliases, the material split and the ignore list are in `POC_ALIASES` / `POC_IGNORE`. See §9. |
| 3 | **Derived-target bases** — blocked on #1. |
| 3b | **DSO keeps its target at rating 4** — absolute descending ladder, 8 rows. KRA-owner decision: re-author the ladder, or accept DSO on its own scale. See §7b. |
| 3c | **No target source for Collections, Onboarding or OMP-CT** — the Target Sheet has only Metals and Plastics tabs, so 122 of 208 assignments have no numeric target and cannot be scored as a ratio. See §7b. |
| 4 | **`PERFORMOS_OPEN_ACCESS` is a dev switch.** Turn it off before real use, or every visitor is a super admin. |
| 5 | **UAT deployment** for `ashwin.singh@recykal.com` was never created (`clasp deploy` blocked locally; use the editor). |
| 6 | **Naming inconsistency** — the filter says "Department", the nav/page/column still say "Teams"/"TEAM". |
| 7 | **`DRAFT` shipments currently count.** Only `CANCELLED` is excluded, per instruction. Confirm this is intended. |
| 8 | `SHIPMENTS_EXCLUDE_STATUS` is data, not code — widen it there if more statuses should be dropped. |

---

## 12. Traps that have already cost time

1. **Never author a patch script with a bash heredoc.** A heredoc eats the
   backslashes out of every regex. This once turned `/\s+/g` into `/s+/g` in
   `email_()`, which **stripped the letter "s" from every email address** —
   `srinivasareddy.dundi@` became `rinivaareddy.dundi@`. Only an address with no
   "s" in it still worked. Use an editor/Write tool.
2. **Sheets coerces text into dates.** `setValues("August 2026")` makes Sheets
   store a `Date`, and the next read returns `2026-07-31T18:30:00.000Z`.
   Guarded by `TEXT_COLS` (set number format `@` before writing) plus
   `periodLabel_`, which derives the label from the period **id** and is
   therefore timezone-proof.
3. **A comma is a thousands separator.** `parseTargetValue_('₹1,234.5 Cr')`
   once returned `1` — the comma was replaced with a space, so the number match
   stopped at "1". A crore figure wrong by 1000×. Commas are now deleted.
4. **Round to the source's real precision, not to what looks tidy.**
   `plan_target` was first rounded at 4 decimals to suppress float-sum noise,
   which turned a real GMV target of `0.35099785 Cr` into `0.351`. The Target
   Sheet genuinely carries 8 decimals of a crore. Now rounded at `1e10` —
   float noise lives near the 15th digit.
5. **Join keys need every dimension, not just the obvious one.** The POC map
   was keyed on account *name* alone, so a Metal shipment whose seller shared a
   name with a Plastic account was credited to a Plastic POC, silently. Now
   keyed `material|name`.
6. **An em dash is not a zero.** `—`, blank and `n/a` mean *no target set* and
   parse to `null`; a real `0` stays `0`.
7. **`shipment_value` is rupees; GMV targets are crore.** Divide by `1e7`.
   Getting this backwards makes everyone look 10-million-fold under target.
8. **`final_picked_quantity` (c11) is entirely blank** — 0 of 300 filled. Use
   `dispatched_quantity` (c35).
9. **The Apps Script Run dropdown only lists zero-argument functions.** That is
   why there are ~25 no-arg wrappers rather than one parameterised inspector.
10. **`inspectAllSources()` used to overflow the log** because it printed header
    rows for 34 tabs. It now lists tabs only.
11. **`clasp push` collides** if the folder holds both `Code.gs` and `Code.js` —
    both map to server file "Code". `.claspignore` excludes `Code.js`.
12. **Unsized inline `<svg>` fills its container** (90px glyphs). There is a
    global `svg{width:16px;height:16px;flex:none}` for this.
13. **Modal close buttons must be bound inside `openModal()`**, not in `wire()`
    — `wire()` runs at the end of `render()`, before the modal exists.
14. **Any threshold compared against a computed ratio needs an epsilon.**
    5.85 Cr against a 6.50 Cr target is exactly 90%, but `5.85 / 6.5`
    evaluates to `0.8999999999999999`, which is NOT `>= 0.9`. The person
    scored **1 instead of 2** for hitting a threshold precisely, and nothing
    on screen would have explained why. `levelFromBands_` now compares through
    `atLeast_` / `atMost_` with a relative 1e-9 tolerance. This affects every
    ratio ladder, because the actual is always a division.
15. **A diagnostic that does not use the real code path will lie to you.**
    The POC inventory in `previewAchievementJoin()` compared raw cell text to
    employee names while the join itself went through aliases and the material
    split. It therefore reported all five reconciled names as unmatched *after*
    they had been fixed — settled work looking outstanding. It now runs the
    same `splitPocCell_` / `canonPocName_` path the join does. The same
    principle is why `previewTargetImport()` and `importTargets()` are one
    function behind a flag.
16. **A per-change server call needs a sequence guard.** The month filter
    fired an `apiModel` on every change and the LAST reply to arrive won — not
    the reply for the month selected. Pick July then August and July's slower
    reply overwrites August, showing July's numbers under August's heading.
    `reload()` now stamps each request and drops any reply that is not the
    newest. It also shows a `loading…` marker, because a control that takes
    seconds and gives no feedback gets reported as broken rather than slow.
17. **`applyRatingScale()` run from the editor cannot clear the browser's
    model cache.** `_modelCache` is dropped on writes made *through the app*.
    After any editor-run migration, reload the dashboard tab.

---

## 13. Read-only inspectors

All zero-argument, all safe to run any number of times, all write nothing.
Run them from the Apps Script editor's Run dropdown and read the log.

**Inventory**
`listTabsTargetSheet` · `listTabsMMCT` · `inspectAllSources` · `inspectTargets`
· `inspectShipments`

**Peek (grid, good to ~20 columns)**
`peekTargets` · `peekMetals` · `peekPlastics` · `peekEmployeeDirectory` ·
`peekPOCData` · `peekRawShipments` · `peekRawSellers` · `peekRawBuyers` ·
`peekRawTransactions` · `peekRawOBBuyers` · `peekRawPOCTargets` ·
`peekSupplyTeamInput` · `peekDemandTeamInput` · `peekSellerOnboarding` ·
`peekOverallShipments`

**Describe (transposed — use for wide tabs)**
`describeShipments` · `describePOCData` · `describeRawTransactions` ·
`describeRawOBBuyers` · `describeRawSellers` · `describeRawBuyers`

> `peekTab` prints a grid, which stops being readable past about 20 columns —
> rows wrap and no value stays under its own header. `describeTab_` transposes:
> **one line per column**, with its first four *distinct* non-blank values and a
> filled/distinct count. Distinct rather than first-four, because 300 rows all
> reading `CANCELLED` tell you nothing about a column's shape.

### Over HTTP, without opening the editor

Append `?diag=<name>` to the web app URL and the same functions return plain
text in the browser:

```
.../dev?diag=previewTargetImport
```

Three guards, none optional: it is an **allow list** (not a blocklist, so the
next function somebody adds is not exposed by default), **every name on it is
read-only**, and it **requires the admin permission**.

> `importTargets`, `applyRatingScale` and `refreshFrameworkFromSource` are
> deliberately absent and must stay absent. A URL that rewrites 166 ratings is
> one bookmark, or one prefetching browser extension, away from doing it
> unasked. **A GET must never change data.** `tests/diagtest.js` fails if any
> exposed function calls a mutator.

An unknown name returns the list of what IS available, so it is
self-documenting.

**Dry runs**
`previewTargetImport` · `previewAchievementJoin`

**Diagnostics**
`whoAmI` · `selfTest`

---

## 14. Tests

Node harnesses that `eval` the **real** functions lifted out of `Code.gs` and
`Index.html`, with only the sheet layer stubbed. **They are in the repo, in
`tests/`** — see `tests/README.md`.

```bash
node tests/run-all.js
```

No dependencies, plain Node, runs from any working directory. It exits non-zero
if any assertion fails **or if a suite crashes without reporting** — a suite
that dies before printing its tally must not read as a pass.

| Suite | Assertions | Covers |
|---|---|---|
| `authtest` | 27 | identity, roles, email normalisation |
| `scopetest` | 27 | `scopeModel_`, incl. the reassign-not-splice guard |
| `uattest` | 24 | open-access / UAT behaviour |
| `permtest` | 23 | permission matrix |
| `ytdtest` | 28 | YTD spans and level averaging |
| `derivedtest` | 29 | derived rules, incl. team resolution |
| `targettest` | 46 | Target Sheet reader, both tab layouts |
| `importtest` | 56 | label matching, KPI resolution, PLAN rows |
| `plantest` | 31 | PLAN → `buildModel_` → scorecard row |
| `joincheck` | 62 | POC map, shipment reader, the name join |
| `poctest` | 51 | POC aliases, shared accounts, the account-tab fallback |
| `reloadtest` | 34 | the month filter: out-of-order replies, cache |
| `scaletest` | 66 | the rating scale, and which ladders it refuses |
| **total** | **504** | |

**All green as of 10 Sep 2026.** Several genuine bugs in §12 were caught by
these and by nothing else — the comma bug, the rounding bug and the
cross-material join bug were all invisible to inspection.

Two of the entries in §12 were originally *test* faults rather than app bugs
(a harness that set team leads but never replicated `assignLeads_`'s
`manager_id`, and a wrong YTD expectation). Check the harness before assuming
the app is wrong.

---

## 15. Suggested order of work

1. Run `previewAchievementJoin()` and read the coverage numbers. Everything in
   §9 depends on how good that join actually is.
2. Settle the Metal POC question (§11 #2). Until it is settled, Metal
   achievements cannot be produced honestly.
3. Build the achievement aggregation, then the derived-target bases.
4. Turn off `PERFORMOS_OPEN_ACCESS` and create the real deployment.
5. Tidy the Teams/Department naming.

---

# 16. What changed after 10 September

Sections 1–15 describe the project as it stood on 10 September. A good deal
landed after that. Where the two disagree, **this section wins**.

## 16.1 The data is in

`importTargets()` now imports **both** targets and achievements from the Target
Sheet — its Achievement column sits beside every Target and is the only source
of achieved values that exists today.

```
104 KRA rows: 104 matched a person, 104 matched a KRA, 104 reached a KPI
364 target values  ·  352 achievement values   (12 Sep 2026)
```

Achievements are stored **raw** (7.19 Cr, not 1.106). A person has to see what
they actually did, and a stored ratio cannot be turned back into it. A
hand-entered actual is never overwritten — only rows whose note says
`Target Sheet` are refreshed.

## 16.2 The rating scale — THE TARGET SHEET FIGURE IS TARGET 4

**Corrected 15 Sep 2026. This reverses §7b, and it is the version in force.**

The figure typed into the Target Sheet is **Target 4**, not Target 3. Achieving
it exactly is 100%, and 100% rates **4 of 5**.

| % of target | Rating | On a 6.50 Cr target |
|---|---|---|
| 60% | 1 | 3.90 Cr |
| 75% | 2 | 4.88 Cr |
| 90% | 3 | 5.85 Cr |
| **100% — on target** | **4** | **6.50 Cr** |
| 105% | 5 | 6.83 Cr |

### Why the 10 Sep scale was wrong

It was not a preference that changed. **The workbook had said this all along**,
in two places that agree independently:

| Evidence | What it says |
|---|---|
| The dominant ladder, on **106 of 208** assignments: `0.6 \| 0.75 \| 0.9 \| 1.0 \| 1.05` | `1.0` sits at **rung 4** |
| The Collections DSO ladder: `> 28 Days \| 25–28 \| 21–24 \| `**`TGT-20 Days`**` \| ≤ 19` | rung 4 is spelled **"TGT"** |

So `RATING_SCALE` is now the workbook's own ladder rather than one imposed on
it. The 10 Sep run had shifted every ratio-scored rating **down one rung**
across 166 rows; re-running `applyRatingScale()` moves them back.

> **The rungs are percentages of the Target Sheet figure**, so Target 3 is 90%
> of it and Target 5 is 105% of it. Scoring still divides achieved by target and
> compares the quotient — the same arithmetic in one step — but the UI derives
> the absolute figures back (`ladderInUnits` in `Index.html`) so a ladder can be
> read in crore, sellers or days instead of in decimals. Display only; nothing
> is written back.

`applyRatingScale()` rewrites only ladders that are genuinely a percentage of a
target: a `PLAN` row must exist, all five bands must be numeric, ascending, and
≤ 2. That last test is what protects `15 | 10 | 5 | 3 | 2` — **DSO in days**,
which rewritten to 0.6–1.05 would score a 20-day DSO as 2000% of target.

> **It was not idempotent at first.** It compared ladders as text, and Sheets
> returns the stored `'1.0'` as the number `1`. Every run rewrote all 166
> already-migrated rows and bumped every version. Now compared numerically.
> The in-memory suite could not see it because nothing there round-trips
> through a spreadsheet — **an idempotency test that never crosses the storage
> layer proves nothing about idempotency.**

## 16.3 Scoring rules added since

**A ratio ladder is scored on actual ÷ target**, not the raw actual. The ladder
reads 0.6–1.05, so comparing a GMV of 7.19 *crore* against 1.05 would rate every
GMV KPI a 5 regardless of target.

**A ratio ladder with no target for that month is NOT scored.** The sheet holds
achievements in months nobody set a target for; compared raw they cleared every
band, so "5 new buyers" scored a perfect 5 in a month with no target at all.

> But a ratio-shaped ladder with no target is not always wrong — the
> Collections rows use `0.8 | 0.85 | 0.9 | 0.95 | 1` and record the *percentage
> itself* by hand. `planEver[emp|kpi]` separates them: **if a KPI is given a
> target in any month, a bare number in another month is a quantity still
> waiting for its denominator, not a ratio.** The same distinction governs
> `aggKind_` (§16.4). In this workbook, "does this KPI ever have a target" is
> what tells a quantity from a ratio — the ladder shape alone cannot.

**Band comparisons carry a relative 1e-9 tolerance.** 5.85 Cr against a 6.50 Cr
target is exactly 90%, but `5.85 / 6.5` is `0.8999999999999999`, so the person
scored **1 instead of 2** for hitting a threshold precisely. Any threshold
compared against a computed ratio needs an epsilon.

## 16.4 Year to date

YTD is now the **default view**, and it aggregates the achieved side as well as
the target side.

- **A count or an amount SUMS across the months; a duration or a rate
  AVERAGES.** Summing a duration would report a five-month DSO of 91 days
  against a 20-day target. `aggKind_` decides, and `agg_kind` on the row says
  which it did.
- **The YTD rating comes from the year's own achieved ÷ the year's own target**,
  one comparison — not the mean of monthly ratings. Averaging lets a month with
  a target of 1 count as much as a month with a target of 40. `ytd_basis` says
  which produced the number.

> The KPI **name** is a bad discriminator here and must not be the first test.
> "Monthly Target Achievement (%)" and "Repeat Seller Transaction Rate (%)"
> both read as percentages but record a crore figure or a seller count. Keying
> off the `%` averaged GMV across the year and understated every one of them.

## 16.5 The Overview

One pivot table **per vertical** — Metal, Plastic · Supply, Plastic · Demand —
POCs down the side, KRAs across the top, **Target / Achieved / Achieved %**
beneath each.

- Split by sub-group because Supply works sellers and Demand works buyers; a
  merged table is half empty on every row, and an empty cell meaning *"not
  their KRA"* looks identical to *"nothing recorded"*. `·` now means the former,
  an em dash the latter.
- **Achieved % is inverted for lower-is-better KRAs** (target ÷ achieved), so
  100% always means on target. A DSO of 4 days against a 3-day target reads 75%,
  not 133%.
- Each table has its **own month filter, defaulting to Year to date**, and
  switching costs no server call — `buildModel_` sends every month's figures on
  the row as `monthly`.
- Entrance animation plays on **page load only**, staggered and capped at 520ms.
  Deliberately **not** a count-up: a figure spinning 0 → 2.96 Cr briefly shows
  values that are not that person's.

## 16.5b Counting KPIs — KRA + name, never the name alone

Anywhere the UI shows a number **labelled KPIs**, the same KPI counts once
however many people hold it. Anywhere it says **KPI assignments**, it is still
one row per person per KPI — that is the rollup denominator and deduping it
would silently reweight every scorecard.

| Where | Counts |
|---|---|
| Overview headline card | KPIs (`distinctKpiCountIn(list)`, over the **filtered** rows) |
| — its small print | assignments, and KRAs |
| People page, team header | KPIs |
| Structure review, `KPIs` column + `KPIs by team` chart | KPIs |
| — `Scored` beside it | assignments carrying an actual |
| Team page tiles, individual scorecard | assignments (a person holds each KPI once, so they agree) |

### The fold is on KRA + KPI name

`kpiIdentity(kraName, kpiName)` in `Index.html`. Both halves go through the
server's own fold (`normName_`: upper case, punctuation to spaces, runs
collapsed), so a workbook typo does not invent a KPI — `TAT ( 3 Days)` and
`TAT ( 3 Days )` are one.

> 🔴 **Folding on the KPI name alone is wrong, and looks right.**
> `Monthly Target Achievement (%)` is the KPI name for **GMV**, for **New Buyer
> Acquisition** and for **New Seller Acquisition**. Three targets, three
> weightages, three KPIs. Name-only folding reported Metal as 5 KPIs when it
> has 7, and the organisation as 64 instead of 84 — **20 of the 38 people hold
> some KPI name more than once.**

The KRA is folded by **name, not by `kra_id`**, because a `kra_id` is scoped to
a team: Metal's GMV and Plastic's GMV are different ids for the same result
area, and the point of these counts is that holding the same KPI does not make
it a new one. Counting by id gives 91 rather than 84.

| Fold | August snapshot |
|---|---|
| assignment rows | 208 |
| `kra_id` + name | 91 |
| **KRA name + KPI name** — what is used | **84** |
| KPI name alone — rejected | 64 |

`KPIS` itself is untouched: it still holds one row per `kra_id` + name, so two
KRAs sharing a KPI name cannot collide onto one id and drop somebody's
weightage. **The dedupe is a display fold, never a storage change.**
`shapetest` asserts nothing divides by or compares against either counter.

## 16.6 Diagnostics over HTTP

Append `?diag=<name>` to the web app URL for any read-only diagnostic, as plain
text. Some take `&arg=` (URL-encode spaces as `%20`).

```
.../dev?diag=explainCoverage
.../dev?diag=explainPerson&arg=ABHISEK%20SANYAL
.../dev?diag=previewTargetImport
```

**The writers are absent from the allow list and must stay absent.** A URL that
rewrites 166 ratings is one bookmark, or one prefetching extension, away from
doing it unasked. `tests/diagtest.js` fails if any exposed function mutates.

`explainCoverage()` is zero-argument, so it also runs from the editor's Run
dropdown — `explainPerson` cannot, because the dropdown passes no arguments.

## 16.7 Coverage as of 12 September

**Only 10 rows across 8 people are fixable, and all of them are blanks in the
Target Sheet, not faults in the app:**

| Who | Missing |
|---|---|
| All 6 Metal people | `DSO Days` achievement |
| Neelesh Dixit, Rishi Panchal | `DSO Days` **and** `DN % of GMV` achievement |
| **NARESH, TABESH MOHAMMAD** | **absent from the Plastics tab entirely** — 15 assignments with no target |

Everything else in Metal and Plastic has both a target and an achievement.

The remaining ~90 gap rows are Collections, Onboarding and Control Tower, which
have **no target source at all** — the Target Sheet has only Metals and
Plastics tabs. That is §11 item 3c and still needs a business answer.

> NARESH and TABESH were invisible for two runs because they sat inside that
> structural gap: "Plastic, 2 people" read like more of the same. `explainCoverage`
> now separates them — **a department where somebody has a target clearly has a
> source, so anyone in it without one is an omission, not a gap.**

## 16.8 Traps added since

18. **`$$` in a `String.replace` REPLACEMENT is an escape for a literal `$`.**
    A patch wrote `$$('.tblm')` into the file as `$('.tblm')`. `$` is
    querySelector, `$$` is querySelectorAll, and `.forEach` on one element
    threw — inside `wire()`, so **every binding below it silently died too**:
    view-as, row clicks, filters, search. Escape as `$$$$`, or use the function
    form of `replace`. **A throw in a wiring function is never local to the line
    it is on.**
19. **A code-extraction anchor must not land inside a block comment.** Ending a
    `grab()` at banner text leaves the comment unterminated — a `SyntaxError`
    that looks nothing like the missing symbol you actually caused.
20. **A diagnostic that truncates has failed.** `explainCoverage` first listed
    all ~75 no-target KRAs one line each and overflowed the log, burying the ten
    that mattered. Volume is not thoroughness.
21. **A diagnostic that does not use the real code path will lie to you.** The
    POC inventory compared raw cell text to employee names while the join went
    through aliases — so it reported settled work as outstanding.
22. **Rounding must respect the source's precision, not tidiness.** Rounding
    `plan_target` at 4 decimals turned a real GMV target of `0.35099785 Cr` into
    `0.351`.

## 16.9 Tests

```bash
node tests/run-all.js
```

**774 assertions across 15 suites**, all green as of 12 September 2026. New
since the original write-up: `poctest`, `reloadtest`, `scaletest`, `shapetest`,
`diagtest`. See `tests/README.md`.

`shapetest` asserts on the SOURCE as well as on behaviour. That is brittle by
design — several assertions broke on cosmetic changes — and it is the only
thing that could have caught the `wire()` crash, which no behavioural test
reaches.

## 16.9b DSO from MM_CT — investigated, and NOT built. Read this first.

> ⚠️ **SUPERSEDED on 15 Sep 2026 — see §17.1. DSO IS NOW BUILT.** This section
> was right that it could not be built from guessed columns, and three
> attempts proved it. The KRA owner then NAMED the columns, which is what was
> missing. Keep reading it for the traps — they are all still real — but the
> conclusion no longer holds.

Three attempts, each killed by the data. The conclusion is that **DSO cannot
honestly be computed from MM_CT today**, and the reasons are worth knowing
before anyone tries a fourth time.

### What was tried

**A receivables ratio** — `(shipment_value − paid_amount) / GMV × days in
month`, the textbook formula. It produced **negative days** for seven people
and a hard ceiling at the month length for everyone else.

- `paid_amount` is **order- or buyer-level, not per shipment**. Across the full
  sheet, **57 rows exceed their own `shipment_value`**, by up to **₹95 lakh**.
  It cannot be subtracted from one shipment's value.
- The formula mathematically cannot exceed the month, so a 45-day DSO is
  unrepresentable.

**Days to collect, from the status timeline.** `status_timeline` holds
`STAGE~ISO|STAGE~ISO…`, and the stages are DRAFT, DISPATCHED, REACHED,
RECEIVED_BY_RECYCLER, COMPLETED, CANCELLED, ORDER_VERIFIED. **There is no
payment stage.** The row labelled "Payment Released" is the one whose timeline
ends `COMPLETED`, so COMPLETED is taken as the money arriving — an inference
from one example, not a documented fact.

### What the data actually says

```
41 shipments reached COMPLETED;  286 have not

created      -> completed   n=36   median 27 days   range 3-75
dispatched   -> completed   n=41   median 31 days   range 3-75
arrived      -> completed   n=41   median 23 days   range 0-63
delivered    -> completed   n=33   median 20 days   range 0-41
invoice date -> completed   n=34   median 26 days
```

### Two reasons this cannot be turned into a KPI

**1. The target does not match any measurable elapsed time.** The DSO ladder is
`15 | 10 | 5 | 3 | 2` against a target of **3**. Collection actually takes
**20 to 31 days** depending on where you start counting. A target of 3 is
therefore measuring something else — days past an agreed credit period, or days
to raise a document, or a different thing again. **No amount of data resolves
this; only the KRA owner can.**

**2. There is nowhere near enough of it.** Only **41 of 327** shipments have
completed — 12.5%. Per person per month the counts are **n=1** for most people
and **n=7** at best. A "median" of one observation is that observation, and
rating somebody on it would be worse than leaving the cell blank.

### The pragmatic route

Every other KRA's achievements are **typed into the Target Sheet by hand** and
imported. DSO can be too, and that sidesteps the definition problem entirely —
the team already knows what it means by DSO, which is more than can be
reconstructed from the ledger. `DSO Days` currently has **19 targets and 0
achievements**; filling that column is one afternoon's typing and needs no code.

### What exists, and what it is for

| Function | Status |
|---|---|
| `previewDSO()` | **Its output is wrong.** Kept only because the run itself is the evidence; it prints a DO-NOT-WRITE warning. |
| `previewCollectionDays()` | Sound, and the numbers above come from it. Reports elapsed days from four candidate starts; deliberately picks none. |
| `peekTimeline()` | The stage census and the `paid_amount` vs `shipment_value` count. |

None of them writes anything.

---

## 16.10 Still true, still urgent

**`PERFORMOS_OPEN_ACCESS` is on. Every visitor is a super admin over all 38
scorecards. Turn it off before anyone relies on this.**

---

# 17. Onboarding, DSO and the CSV feeds — 15 to 22 September

**Section 17 is the newest addendum. Where it disagrees with anything above,
including §16, this wins.**

Three things were built in this window: DSO from MM_CT (which §16.9b said was
not buildable — see 17.1), a general CSV ingester for sources with no usable
API, and the seller onboarding TAT from Metabase.

---

## 17.1 DSO from MM_CT — BUILT. §16.9b is superseded.

§16.9b concluded DSO could not be built and should not be attempted. **That was
correct at the time and is now out of date.** The blocker was never the
arithmetic — it was not knowing which columns carried the sale, the collection
and the debit note. Three guesses were tried and all three produced negative
days. On 15 September the KRA owner named the columns:

```
GMV          = AP × 1.18 − AU        sale value with taxes, less debit notes
receivables  = AP × 1.18 − AQ − AU
DSO          = receivables ÷ GMV × days
```

| letter | header | |
|---|---|---|
| **AP** | `shipment_value` | pre-tax sale |
| **AQ** | `paid_amount` | collected |
| **AU** | `dn_amount_incl_gst` | debit note |

**Columns are resolved by LETTER, not by header name**, because the letter is
what was specified — and the run prints the header found at each letter every
time. `colLetter_()` / `letterCol_()` convert; `describeTab_()` now labels every
column with its letter for the same reason.

### The rules, and why each one is there

| Rule | Why |
|---|---|
| A negative receivable counts as **zero** | Left signed, an over-collected shipment cancels out somebody else's genuine overdue. In the test case the signed total is **−24** and the clamped total **58** from the same two rows. Clamping can only raise the DSO. |
| Attribution by **`buyer_category`** | Receivables are owed by buyers. A plastic seller shipping to a metal buyer is not a Plastic receivable. 13 rows classify differently by `seller_category`. |
| The POC must be in the **shipment's own team** | A Metal buyer handled by a Plastic POC is not Metal's DSO. |
| **The month in progress is not measured** | On the current month payment terms have not elapsed, so receivables equal GMV and the formula returns days-since-the-month-began. September put every POC in both teams at exactly 17.0 days, climbing by one a day. It measured the calendar. Rows already written for it are deleted on the next run. |
| YTD is the **mean of the months** | DSO is a duration. The first version summed and multiplied by the 108-day span and reported **75.4 days** against months that ran 2.4, 14.4, 27.5 and 15.0 — worse than every month, which is the tell. |

### Targets

```
PLASTIC   5 days, WRITTEN by the import   (KRA owner, 15 Sep)
METAL     left to the Target Sheet's own 3 days
```

Metal already has a target and the Target Sheet is the authority for targets, so
the importer does not overwrite it. `DSO_TEAMS_[team].target = null` means
"leave it alone". Note 3 days is Target 4 on the `15 | 10 | 5 | 3 | 2` ladder and
5 days is Target 3 — **the two teams are not held to the same rung**, which is
the workbook's own design.

> 🔴 **Half the Metal rows show NOTHING COLLECTED.** `paid_amount` is empty for
> every shipment in those person-months, so the DSO is just the days elapsed and
> rates T0 regardless of how collections went. The import flags each one
> `!! nothing collected`. Three explanations — not yet due, not yet recorded, or
> genuinely uncollected — and only the third is a performance result.
> **AYUSH GOYAL has 16 shipments across four months and not a rupee recorded.**

### Functions

| Function | |
|---|---|
| `previewPlasticDSO()` | Vertical-level check; verifies the three column headers. Read-only. |
| `previewDsoAchievements()` | Per POC per month, both teams. Read-only. |
| `importDsoAchievements()` | Writes. Deletes its own rows for the month in progress. Never overwrites a hand-entered actual. |
| `explainDso()` | Zero-argument. Prints the stored rows **and** what `buildModel_` makes of them, side by side. |

---

## 17.2 CSV feeds from a Drive folder

**Every automated route was closed off, in this order:**

| Route | Why not |
|---|---|
| Zoho Books scheduled report → email | Scheduling is gated by plan and by role. |
| Metabase API key | API keys are created by admins only. |
| Metabase session token (email + password) | **Refused, deliberately.** It puts one person's credentials in a script property any editor can read, breaks on their next password change, inherits everything they can see rather than only the report, and cannot be revoked without locking them out. `diagtest` asserts no password field, no `/api/session` call and no password read from properties. |

What every plan and every role **can** do is export a CSV. So: export, drop the
file in one Drive folder, and `feedIngest_` lands it.

```
setupImportFolder()   creates the folder, stores its id, prints the link
previewFeeds()        finds each feed's newest CSV, profiles every column
importFeeds()         lands them into staging tabs
```

**One folder, matched by filename.** A folder per feed would need three ids kept
in step.

| feed | filename must contain | staging tab |
|---|---|---|
| collections | `collect`, `receivab`, `ageing`, `zoho` | `Zoho_Collections` |
| buyer | `buyer`, `5711` | `Meta_Onboarding_Buyer` |
| seller | `seller`, `5712` | `Meta_Onboarding_Seller` |

Overridable per feed via `FEED_MATCH_*`; the override is a plain substring, not
a regex, because whoever sets it is naming a file.

Two things it does on purpose: it takes the **newest** matching file, so old
exports can stay as history; and it lists every CSV that matched **no** feed, so
a misnamed export is visible instead of silently skipped.

> **The failure mode of this route is a quietly changed column** — the same trap
> as MM_CT's AP/AQ/AU. Every run prints the header row with column letters and
> says whether it differs from the run before. It also handles Zoho's habit of
> putting title and date-range lines above the real header: the widest of the
> first ten rows is taken as the header.

`METABASE_API_KEY` support is still in the code and dormant. If anyone is ever
given a key it works immediately; without one it says keys are admin-only and
points at the Drive route.

---

## 17.3 Who owns an onboarding case

Given as "if the business vertical contains Open Marketplace / AFR & Infra /
EPR". **The data does not support that reading**: `business_vertical` holds only
`Marketplace`, `Open Marketplace`, `EPR`, `Support` and `Sustainability
Services`. There is no AFR or Infra vertical — AFR and Metal are
**`business_category`** values. Read strictly by vertical, HARSHITA would score
nothing, and her AFR and INFRA KRAs are half her scorecard at 0.25 each.

So a rule may name a vertical, a category, or both — and **both must match**.
`ONBOARDING_OWNERS_`, first match wins, in this order:

| # | vertical | category | owner | TAT | KRA |
|---|---|---|---|---|---|
| 1 | `EPR` | — | NAVEEN RANGA | 3d | EPR – Buyer & Seller Onboarding |
| 2 | `Open Marketplace` | — | VAMSI | 1d | Open Marketplace – Buyer & Seller Onboarding |
| 3 | `Marketplace` | `AFR` | HARSHITA | 3d | AFR – Buyer & Seller Onboarding |
| 4 | `Marketplace` | `Metal` | HARSHITA | 3d | INFRA – Buyer & Seller Onboarding |
| 5 | `Marketplace` | `Re-Commerce` | VAMSI | 1d | Re-Commerce – Seller Onboarding |
| 6 | `Marketplace` | `Plastic`, `E-Waste` | VAMSI | 1d | Open Marketplace – Buyer & Seller Onboarding |
| 7 | `Sustainability Services` | `Plastic` | NAVEEN RANGA | 3d | EPR – Buyer & Seller Onboarding |

`ONBOARD_IGNORE_` holds `Support`, which is **out of scope by ruling** — 157
in-scope cases that nobody is *supposed* to be measured on. Out-of-scope and
unattributed are different findings and do not share a counter.

**EPR is tested first** so no category rule can take an EPR row: *"In EPR there
will be no Metal — if yes that should go to Naveen itself."*

Patterns are **anchored** and values folded through `normName_`. `Marketplace`
and `Open Marketplace` are separate values in the same column, 4,011 rows
against 457, so an unanchored `/MARKETPLACE/` would swallow both.

> ⚠️ **ONE KRA, ONE TAT.** A KRA whose cases are held to different TATs produces
> a share that means nothing — a 2-day case is a miss against a 1-day KRA and a
> pass against a 3-day one, in the same bucket. This decided rule 6 twice: at
> 3 days Plastic needed a KRA of its own (and a workbook change); at 1 day it
> shares the one Vamsi already holds. `tattest` asserts the invariant against
> the live rules, so a future rule cannot break it quietly.

Still unowned, in scope: **3 cases** — one each of `GOA DRS`, `Institutional
Business` and `M4`. `Paper` and `M3` have volume historically but nothing in
scope yet.

---

## 17.4 The seller onboarding TAT

From Metabase question **5712**, tab `Meta_Onboarding_Seller`.

```
START   the latest of review_submission_date (L) and any rejection BEFORE the
        final approval — a rejection is what restarts the clock
END     the LAST approval present across level1..level4
TAT     end − start, in days
MET     ≤ the owner's TAT (1 day or 3)
```

| Decision | Why |
|---|---|
| A rejection **after** the approval is ignored | It belongs to a later re-review. Counting it gives a negative TAT. |
| End is the **last approval present**, not `level4` | Not every case runs all four levels. |
| **UTC throughout** | The export carries every level twice — `Z` at 13:35 UTC and `AX` at 19:05 IST for the same event, under *identical headers*, so a by-name lookup silently takes the UTC one. 24 names are duplicated. An elapsed time is the same in either zone; IST is used **only** to decide the month. Mixing them turns a 0.8-day case into 1.0 and costs a Target rung. |
| The window is on the **in-review** date | Not the approval. Filtering on the approval let in a case submitted Sep 2025 and approved May 2026 while excluding one submitted Mar 2026. It is the **revised** in-review date, so a 2025 case resubmitted after 1 Apr 2026 is in scope. 6 cases straddle the cutoff. |
| Bucketed by the month it **completed** | Bucketing by submission would flatter the newest month: its unfinished cases are not COMPLETED, so only the quick ones would remain. |
| The achievement is the **share of cases meeting TAT** | The ladder `0.8 \| 0.85 \| 0.9 \| 0.95 \| 1.0` is a RATIO. 100% within TAT is Target 5, 80% is Target 1. The mean days is reported but **not** scored. |
| Completion is `status = COMPLETED` | There is no literal "Onboarded". `current_status` does hold `ONBOARDED`, but that is the lifecycle axis — `CHURNED / ONBOARDED / DEACTIVATED / ACTIVE`. |

All 18 columns are pinned to letters with their expected header in
`SELLER_EXPECT_` and **verified on every run**. A mismatch aborts with
*"Refusing to compute"* rather than producing confident nonsense.

### The funnel, 22 September

```
rows in the tab                      3493
less not COMPLETED                    -798
less no approval recorded            -1821
less in review before 2026-04-01      -455
  = in scope                           419
less out of scope by ruling           -157   (Support)
less belongs to nobody                  -3
  = SCORED                             259   -> 22 person-month rows
```

**The order of those tests decides what each count means.** The owner test used
to run first, and "no owner: 1556" was reported as the in-window gap when it
swept in every unattributed case back to 2019. The date-independent tests come
first, then the window, then the owner — so everything below the window is a
count of in-scope cases.

### What it found

| | |
|---|---|
| `submission stamp == first approval` | **0.** So the 76 sub-hour cases are genuinely fast approvals, not an artefact. The TAT measures real work. |
| 14 of 22 person-months | rest on **fewer than five cases**; four rest on one. KRA owner: leave them as they are. |
| 1,821 completed cases | have **no approval timestamp** in any level, so cannot be timed at all. |

```
VAMSI  Open Marketplace   Apr 0%  May 89%  Jun 77%  Jul 59%  Aug 79%  Sep 100%
```

214 cases against a 1-day promise. **July at 59% is the one real signal in the
whole set** — everything else is either too thin to read or Vamsi's.

`previewSellerTat()` / `importSellerTat()`. The note on each row carries the
working: `17 of 20 within 3 days = 85% · mean 2.4 days`.

---

## 17.5 The buyer TAT is NOT built, and cannot be as specified

Question **5711** has no `review_submission_date` and **no rejection
timestamps** — only `onboarding_created_date` (G), `onboarding_updated_date`
(H), `level1_approved_at` (AF) and `level2_approved_at` (AH).

So a rejected-and-resubmitted buyer case is **indistinguishable from a slow
one**, and the rule "the revised In Review counts" cannot be applied at all.

Two ways forward, both needing a decision:

1. add the review-submission and rejection columns to 5711, or
2. accept `onboarding_created_date → level2_approved_at` as an approximation,
   which silently treats a rejection loop as one long delay.

Do not guess at it. Guessing at columns is what made the first three DSO
attempts wrong.

---

## 17.6 Collections — parked

Zoho Books is the source for the receivables side. **Of the 29 Collections
assignments, roughly 18 could come from it** — Due Date + 7, DSO, PDD, Legacy,
Previous Dues, and possibly Payment Posting TAT. The rest (Reminder Emails,
Legal Action Coordination, Balance Confirmation, Cross-Functional Coordination,
Process Automation, Compliance Documentation) are process and judgement KPIs no
accounting system holds, and stay manually recorded.

**The blocker is attribution, not the pull.** Zoho Books knows customers and
invoices; it does not know which of the five Collections people owns a customer.
Several KRAs also need the Marketplace / EPR split. Until that mapping exists —
a custom field in Zoho, or a tab like `POC_data` — a perfect feed still yields
one company-wide number instead of five scorecards.

The `collections` feed and `describeZohoTab()` are ready and waiting for a file.

---

## 17.7 Tests

**17 suites, 1,592 assertions.** Two new since §16.9:

| Suite | |
|---|---|
| `cardtest` | **Renders** all ten Overview card breakdowns against a stub model and reads the output. An unbalanced bracket and a figure coming out as `undefined` or `NaN` are both invisible to a grep and to a parse check — and an extra bracket was already in the file when the suite was written. |
| `tattest` | The TAT rule case by case: the rejection restart, the post-approval rejection, the last-approval end, the UTC/IST trap, which side of 1 April each case falls, the ignore-before-attribute order, and the one-KRA-one-TAT invariant. |

`run-all.js` exits non-zero if a suite **fails to report**, not only if an
assertion fails. Worth trusting: adding a parameter to `fmtTarget` broke two
suites' grab anchors and the total still read "1114 passed, 0 failed" — the
`!! did not report` line was the only thing that caught it. **Read the tail of
the output, not the total.**

Grab anchors are now on function **names**, not parameter lists, for that
reason.

---

## 17.8 Still open

| | |
|---|---|
| 🔴 `PERFORMOS_OPEN_ACCESS` | Still the first thing to deal with. Every visitor is a super admin over all 38 scorecards. `selfTest()` prints whether it is set. |
| Buyer TAT | Blocked on 5711's columns — see 17.5. |
| 1,821 untimeable seller cases | COMPLETED with no approval stamp. Historical, or an ongoing gap? |
| Metal DSO: nothing collected | Half the person-months. AYUSH GOYAL first. |
| Collections attribution | See 17.6. |
| Thin months | 14 of 22 onboarding person-months rest on under five cases. KRA owner has accepted this. |
| `Marketplace / GOA DRS`, `Institutional Business`, `M4` | One case each, unowned. |
| Tabesh's weightage | The workbook still says 115%; `WEIGHTAGE_OVERRIDES` corrects it to 100% in the app. Fix the workbook and the override becomes a no-op. |

## 17.9 The boot screen

Deployed 2026-09-28 as **v63**.

**What it is.** The Recykal mark, turning on a slow eased cycle, held over the
page while the first `apiBootstrap` call is in flight, with the line
*"Preparing your performance dashboard…"* beneath it. When the data lands the
sentence fades, the spin freezes where it stands, and the mark flies onto the
sidebar logo while the white lifts and the dashboard opens out from the centre.

**It has been three things.** v62 was the mark with a word-by-word "Performance
Tracker" fill. That was replaced by a desk-figure silhouette, which was replaced
by the mark again on request. Only the *visual* changed each time. What has
survived all three is the part that was never about the picture — the minimum
hold, the staged exit, the three teardown paths, reduced motion, and the tests.
That separation is the point: the scaffolding is the hard part and it should not
be rewritten every time somebody wants a different picture.

**It is tied to the data, not to a timer.** A fixed three-second hold is wrong
in both directions: on a warm cache the server answers in well under a second
and the reader is made to watch the rest of the countdown; on a cold one the
load runs longer and the timer lifts the cover off an empty page. So the overlay
comes down **when the data lands**, with a floor of `BOOT_MIN_MS` (1,750ms)
under it and **no ceiling** — the mark turns for as long as the load takes. Both
failure paths pass `finishBoot(true)` to skip the floor: somebody being told
they were refused should be told at once.

`finishBoot()` **returns** whether it took the teardown on, because it also owns
the call to `playReveal()`. With an overlay up, the tiles must not stagger in
behind a cover that is still opaque — their entrance would be spent unseen. A
view-as switch paints no overlay, gets `false` back, and runs the reveal itself.

**Two geometric facts that are easy to get wrong and are now asserted:**

*The flight must measure after the hiding class comes off.* `.app.revealing`
holds the page at `scale(.94)`, and a target rect read through that transform is
6% small — the mark lands beside the sidebar logo rather than on it. `closeBoot`
clears the class first, before any branch, which also happens to be the only
arrangement in which all three exits from it can't miss one.

*What sweeps the box is the image's diagonal, not its width.* The PNG is
182×163, so at width `w` its diagonal is `1.343w`. At 78% of the box that
diagonal was 1.047 of the side and the corners swung outside it on every quarter
turn. It is 68% now, giving 0.913. `boottest` asserts the geometry rather than
the number, so the next person to nudge the percentage is told why it is what it
is.

**Tests.** `tests/boottest.js`, 41 assertions: the mark and its sizing, the
flight (both rects measured, order of operations, spin frozen before stopped, no
rotate of its own), all three teardown paths, the floor-without-a-ceiling, and
that every moving part is named in the reduced-motion block. The v62 boot
assertions that used to live in `shapetest` were removed when this was rewritten
— half were about a flight that had been deleted. One owner per fact.

---

# 18. OMP — Control Tower

## 18.1 Why OMP needed no Target Sheet

§7b and open item 3c say Collections, Onboarding and OMP-CT have no target
source and their ratio KPIs cannot be scored. **For OMP that is wrong, and it
cost a round trip to find out.**

Every OMP KPI is a rate on the ladder `0.8 | 0.85 | 0.9 | 0.95 | 1`. A
ratio-shaped ladder is only divided through when that person-and-KPI has a PLAN
target in *some* month — `planEver`, [Code.gs:1161]. With no target anywhere,
the stored number **is** the rate and is read against the bands directly, which
is already how the Collections percentages score.

So OMP needs **achievements only**. One figure per person per month, stored as a
**fraction** (0.87, not 87) — the bands are 0.8–1.0 and writing 87 would clear
every rung and rate everybody 5.

## 18.2 The two sources, and what each is for

| | |
|---|---|
| **OMP_TRACKER** `15hAyV4C2DQ…` | attribution: `Control - POC` says who owns a shipment. Also carries the operational dates. |
| **MM_CT `Raw_Shipments`** | live state: `shipment_status`, `shipment_stage_label`. |

They join on **Shipment ID → `shipment_id`, and the join is total**: 364 of 364
tracker rows with an ID were found in MM_CT. 35 tracker rows have no Shipment ID
and cannot be measured from MM_CT at all.

### Two shapes in that tracker that break a naive reader

**Row 1 is not the header row.** It holds banners spanning column groups —
DISPATCH, Vehcile Status, Reached, Delivered, Completed — and three running
totals. The headers are on **row 2**. `ompHeaderRow_` finds the row rather than
assuming it, because banner rows get inserted by hand.

**Row 2 is not unique.** `AJ` is "Actual" under *Reached* and `AN` is "Actual"
under *Delivered*. Matching the header alone picks whichever comes first — right
today, wrong the day somebody reorders the sheet, silent either way. A column's
identity is therefore **banner + name** (`Reached / Actual`), banner carried
forward. **A number in row 1 is not a banner** — the totals in O, T, V and AZ
would otherwise rename every column after them.

## 18.3 On-Time Transit Completion Rate — BUILT

`previewOmpTransit()` → dry run. `importOmpTransit()` → the write, deliberately
**not** on `DIAG_FUNCTIONS_`.

Rules, all ruled by the KRA owner on 28 Sep 2026:

| | |
|---|---|
| on time | `Reached/Actual` **≤** `Exp Date` — equal counts as on time |
| leaves the denominator | cancelled, draft, ready-to-dispatch. **Not misses.** |
| not scored | anything in the **current month** |
| **miss** | a prior month's shipment still in transit **more than 10 days** |
| month | the **dispatch** month, not the order month |
| floor on the denominator | **none** — ruled 28 Sep 2026 |

**Ten days measured to what.** Not stated, and it matters more than it looks.
Measured to *today*, a past month's rating moves every time the import runs: a
shipment at nine days when August was first scored crosses ten the next day and
silently marks August down. The clock stops at **month end plus the grace**, so
every shipment gets its full ten days and the month settles once.
`omptest` asserts the stability property directly.

**Why dispatch month.** MM Date is the *order* date. A shipment ordered 28 July
and dispatched 3 August was being judged against July's clock for transit work
done in August. As a side effect the "dispatched after this month closed" verdict
became unreachable — the month *is* the dispatch month, so the age at the cutoff
is always at least the grace. The branch stays as a guard and the test exercises
it directly.

### What the first real run said

7 rows, Arvind and Bharath (the only holders — found by KRA/KPI name, not by
naming people). **5 of 7 months clear no band at all.** MM_CT and the tracker
agree the late deliveries are real — the staleness check returned **0**
disagreements — so this is a finding about the deliveries, not about the
arithmetic. **The open question is whether `Exp Date` is a commitment anybody
agreed to or an optimistic ETA**; 66 misses against 52 hits suggests the latter,
and this KPI is half of both scorecards.

## 18.4 Names

`OMP_POC_ALIASES_` is **scoped to this tracker and must stay that way**.
`ARAVIND → ARVIND JAKKULA` is confirmed, but `POC_ALIASES` is global — every POC
lookup in the project runs through `canonPersonName_`, Metal and Plastic
included — and `POC_IGNORE` already holds **`NOMUL ARAVIND`, a different
person**. A global alias would re-route any bare "Aravind" in those columns onto
Arvind Jakkula's scorecard, silently.

`MEGARAJ` and `RAJESWARI` are in `EMPLOYEE_LEAVERS` (28 Sep 2026), under **both**
the roster spelling and the tracker spelling — that table is keyed on
`normName_` and an unlisted spelling is not hidden. `KALYAN` is an
`OMP_POC_OFF_TEAM_` ruling instead: never on the roster under any spelling.

**They were nearly ruled off on my bug.** The profiler first matched on
`normName_`, which bypasses `POC_ALIASES` entirely, and reported both as "NO
MATCH" when the roster had them one character out (`MEGARAJ`/Meghraj,
`RAJESWARI`/Rajeshwari). The ruling was made from that. It now resolves through
`canonPersonName_`, suggests near misses instead of flatly failing, and
**warns when an off-team ruling looks like somebody on the roster**.

## 18.5 The bug worth remembering

The importer had **its own** name lookup — canonical name into a map keyed on
the full name. The tracker writes "Bharath"; the roster says "BHARATH KUMAR";
an exact lookup misses. **275 of 364 rows were dropped** as "not an employee"
while Bharath was still *named as a holder* at the top of the same report.
ARVIND survived only because its alias expands to the full name.

A plausible report with a person silently missing from it is the worst shape a
bug can take here. There is one resolver now, used by both, and `omptest` pins
both the behaviour and the fact that there is only one.

## 18.6 Timely Dispatch Rate — BUILT

`previewOmpDispatch()` → dry run. `importOmpDispatch()` → the write, not on
`DIAG_FUNCTIONS_`. Held by **Divya Boppuri** and **Jithender Chitakodur**.

Ruled 28 Sep 2026: a shipment should go In-Transit within **3 days of
matchmaking**, and the shipments that count are those that **reached In-Transit
or beyond**.

**The In-Transit date comes from MM_CT's `status_timeline`, not from the
tracker's Dispatch Date.** The timeline records when the stage was actually
reached; the tracker column is somebody typing it in afterwards. The stage key
is `DISPATCHED` — only the *label* reads "In Transit".

The tracker's column is still read, to be **checked** against the timeline every
run, because that gap is the numerator of the whole rate. First run: **152 agree,
7 differ**, six of them by a single day. The outlier was `SH08263102` — tracker 2026-09-02, MM_CT 2026-09-15, **13 days
apart**. Confirmed by the KRA owner (28 Sep 2026) as a **genuine delay**: MM_CT
is right and the tracker column was optimistic. The rate already used MM_CT, so
it is correctly counted as a miss — and had it trusted the typed column, a real
13-day delay would have scored as on time. That is the case for reading the
timeline rather than the tracker, in one row.

### Two things that differ from the transit KPI, neither arbitrary

**It buckets on the MATCHMAKING month.** The clock starts at matchmaking, so a
shipment matched in July and dispatched in August is a July failure. Bucketing
on dispatch — as the transit KPI does, correctly, because transit starts there —
would also have meant a never-dispatched shipment had no month and vanished.

**`ompCounts_` is deliberately NOT reused.** On the transit rate a shipment that
had not left was rightly excluded: it had no transit to judge. Here those are the
failures. The ruling excludes them anyway, and that is implemented — but
`WHAT IS NOT IN THESE RATES` prints the excluded count on every run so the rate
is never read without the number it leaves out. On the first run that count was
**0**, so the concern was moot in practice.

## 18.7 THE LADDER — and a correction

### What was said first, from two KPIs

| | |
|---|---|
| On-Time Transit (Arvind, Bharath) | 5 of 7 months clear no band |
| Timely Dispatch (Divya, Jithender) | 7 of 7 months clear no band |

Twelve of fourteen person-months, four people, two unrelated measures, all below
Target 1. The conclusion drawn was that **the ladder does not describe how this
team operates** — that `0.8 | 0.85 | 0.9 | 0.95 | 1` appears identically on every
OMP KPI, which is what a template looks like rather than a calibration.

### What the third KPI said — 29 Sep 2026

Tracking Accuracy, same people, same ladder, same shipments:

| | | |
|---|---|---|
| Arvind | Jun 100% · Jul 100% · Aug 90.6% | **T5 · T5 · T3** |
| Bharath | Jun 100% · Jul 92.3% · Aug 91.3% | **T5 · T3 · T3** |

**The floor is reachable.** Six of six months clear a band and four clear
Target 3 or better, on the same ladder that gave twelve zeroes elsewhere.

### So the conclusion was too broad, and this is the sharper one

The bands are not the problem. **Transit and dispatch are genuinely missing
their marks, and tracking genuinely is not.** The ladder is doing what a ladder
should: distinguishing.

That does not close the question, it moves it. Delivery is late — 66 misses
against 52 hits on transit — and the thing worth checking is no longer the
bands but **`Exp Date`**: whether it is a commitment anybody signed up to or an
optimistic ETA nobody agreed. If it is the latter, transit is measuring the
wrong thing while dispatch and tracking measure the right one, and only transit
needs revisiting.

Jithender's 40% → 44% → 62% → 75% still records as four identical zeroes, and
that is still worth someone's attention — but it is now evidence that the
dispatch floor may be set above where this team currently operates, not evidence
that the whole framework is a template.

**Still a KRA-owner decision. It is just a narrower one than it looked.**

## 18.9 Tracking Accuracy Rate — IMPORTED 29 Sep 2026

`previewOmpTracking()` → dry run. `importOmpTracking()` → the write, not on
`DIAG_FUNCTIONS_`. Held by **Arvind Jakkula** and **Bharath Kumar**.

Ruled 28 Sep 2026: **one of the two tracking methods is enough** — "Both" is
not required.

| Value | n | Verdict |
|---|---|---|
| Fastag | 200 | on track |
| Both | 51 | on track |
| SIM track | 36 | on track |
| N.A | 37 | **leaves the denominator** — tracker not in place at the time |
| No | 28 | **miss** |

**There are no blanks in that column.** "Blank is a miss" was ruled before the
values were known; the value carrying that intent is `No`, confirmed by the KRA
owner after the list came back.

**An unrecognised value is not scored at all.** A hand-maintained column gains
values, and an unknown must not default to either verdict — a hit is a silent
lie, a miss punishes somebody for a word nobody has ruled on. It is reported
and held back, and the dry run prints **every distinct value against the verdict
it received** so a wrong bucket shows on the first run rather than inside a rate.

Denominator: reached In-Transit, bucketed on the **dispatch** month — nothing to
track before a shipment moves.

It did score far better, and that changed the reading of the ladder. **6 rows,
four of them Target 3 or better, two Target 5.** See 18.7 — this is what showed
the floor is reachable and narrowed the ladder question to transit and dispatch.

## 18.10 THE DISPLAY BUG — every rate on the dashboard read as 0 or 1

Found 29 Sep 2026 when the imported numbers were finally looked at on screen.
**Fixed and deployed as v64.**

`plan_unit` comes from the PLAN row. A rate KPI has no PLAN row, so the unit was
empty, so `fmtTarget` fell through to its **count** branch and rounded:

```
0.87  ->  "1"        0.333  ->  "0"
```

Every OMP figure was one of those two — and every **Collections** percentage had
been rendering that way for as long as they have existed, unnoticed, because
nobody had looked at a rate KPI on screen and asked why it was a whole number.

### The fix is tied to the scoring rule, not guessed at

`buildModel_` marks a row `plan_unit: 'ratio'` under **exactly** the condition
that makes it read the stored number straight against the bands — a ratio ladder
**and** `planEver` false. That precision is the whole point: a ratio-shaped
ladder on a KPI planned in some *other* month means a bare actual is a quantity
still waiting for its denominator, and marking that a rate would render **5
sellers as 500%**.

`fmtTarget` gained a `ratio` branch (one decimal, so 66.7% does not read as
67%), and `ladderInUnits` shows the rungs in the same units — `80% | 85% | 90% |
95% | 100%` beside an achieved 87%, rather than `0.8` beside `87%`.

### The lesson

Both importers were correct, fully tested, and dry-run three times each. The
number they wrote was right. **Nobody had looked at it on the page.** A dry run
proves the arithmetic; it says nothing about what the reader sees. This cost
nothing to find and would have cost a great deal of trust to find later, in
front of somebody whose rating it was.

`plantest` carried an assertion that a targetless row `carries no unit` — it was
pinning the bug. It now asserts the row is marked as a rate, with the reason.

## 18.11 The categorical columns, profiled

`profileOmpCategoricals()` — read-only, prints every distinct value with counts
and a per-POC breakdown, over the **352 scoreable rows** (a Shipment ID, a POC,
not cancelled). Run it before ruling on any remaining KPI: `describeOmpTracker`
prints only four sample values, and the Tracking column had six.

| Column | For | Values |
|---|---|---|
| AF `Tracking` | Tracking Accuracy | Fastag 200 · Both 51 · N.A 37 · SIM track 36 · No 28 — **no blanks** |
| AR `DN Status` | CN & DN Closure | **(blank) 192** · DN Pending 128 · POD Pending 19 · DN Raised 12 · DN in DUE 1 |
| AQ `DN` | CN & DN Closure | **(blank) 260** · NO DN 58 · Uploaded 34 |
| AP `QC` | QC & Settlement | **(blank) 262** · Not Applicable 72 · Uploaded 18 |
| AU `Payment Status` | Timely Payment Release | (blank) 104 · OverDue 97 · Partial Paid 85 · Full Paid 54 · Due Date Not Available 9 · Within-Terms 3 |

**The blanks are the story.** QC is 74% blank and DN Status 55% blank. For those
KPIs the blank ruling will not be a detail at the edges — it will decide the
entire result. Treated as a miss, QC & Settlement scores near zero for everyone;
excluded, it scores on a fifth of the data and reads as near-perfect. Neither is
a number worth putting on a scorecard without saying which it is.

Note also `Payment Status` has only **54 Full Paid** across five months, and
`Within-Terms` — which sounds like the on-time value — has **3 rows**. Whatever
Timely Payment Release ends up measuring, it will not be that column alone.

## 18.12 Still open on OMP

| | |
|---|---|
| `Exp Date` — commitment or ETA? | Decides whether 5-of-7 Target 0 is a true reading. See 18.3. |
| 36 rows with no POC | Growing: 1 Jun, 2 Jul, 7 Aug, 6 Sep. Nobody is on the hook for them. |
| 11 MM_CT shipments not in the tracker | Owned by nobody. |
| 12 arrived with no Reached date | Tracker gap; they cannot be judged. |
| CN & DN Closure (Ashwin) | Needs a ruling. AR is 55% blank — see 18.11. |
| QC & Settlement (Aishwarya) | Needs a ruling. AP is 74% blank; the blank decides the whole result. |
| Timely Payment Release (Aishwarya) | Needs a ruling, and a source: Within-Terms is 3 rows. Only 43 shipments ever reached COMPLETED. |
| Documentation, SOP compliance, Dispute | Sources are email, meetings and manual audit. **Not importable** — these have to be entered by hand. |

---

# 19. WHERE THIS STANDS — 29 Sep 2026

**Live: v64** on deployment `AKfycby_i1JVIRNUeEX3C0LsGA6CccU9nNSN52AC5k-9CqOQNL0S0olhUGm5YW-Jsx-u7Pv4`.
Domain-only (`access: DOMAIN`). 1,834 assertions across 19 suites green.

## What is on the dashboard now

| | |
|---|---|
| **OMP achievements** | 14 rows imported: On-Time Transit (Arvind, Bharath) and Timely Dispatch (Divya, Jithender), May–Aug. |
| **Two people removed** | Megaraj and Rajeswari, via `EMPLOYEE_LEAVERS` — hidden, rows intact. The roster is 6. |
| **Rates render correctly** | As of v64. Before it, every rate KPI on the page — OMP *and* Collections — showed as 0 or 1. See 18.10. |
| **Boot screen** | The Recykal mark, v63. |

## The three things worth a decision, in order

**1. The ladder (18.7).** Twelve of fourteen person-months across two unrelated
KPIs sit below Target 1. Jithender improved 40% → 75% over four months and the
scorecard records four identical zeroes. Tracking Accuracy will land near 90%,
which suggests the floor is not wrong everywhere — so transit and dispatch are
telling you something real about delivery, and the bands are telling you
something about how they were set. **KRA owner's call, not a code change.**

**2. `Exp Date` (18.3).** 66 misses against 52 hits. If that column is an
optimistic ETA rather than a commitment anyone agreed to, the transit KPI is
measuring the wrong thing. Both importers pick up a change to `TARGETS` on the
next run with no edits.

**3. The blanks (18.11).** QC is 74% blank and DN Status 55% blank. Those two
KPIs cannot be built until somebody rules on what a blank means, and the ruling
decides the entire result rather than trimming it at the edges.

## Two gaps nothing here can close

**36 tracker rows have no POC**, and it is growing — 1 Jun, 2 Jul, 7 Aug, 6 Sep.
No importer can attribute a shipment nobody owns.

**11 MM_CT shipments are not in the tracker at all**, and 12 arrived with no
Reached date recorded.

## How to pick this up

Every source is inspected before it is used and every writer has a dry run.
In rough order of use:

```
explainOMP()                  what the team holds, and what is still missing
profileOmpTracker()           the POC column, the join, the volume per month
profileOmpCategoricals()      every value in the columns the next KPIs need
previewOmpTransit()           dry run    ->  importOmpTransit()
previewOmpDispatch()          dry run    ->  importOmpDispatch()
previewOmpTracking()          dry run    ->  importOmpTracking()   [not yet run]
```

The `preview*` and `profile*` functions are on `DIAG_FUNCTIONS_` and can be
reached over HTTP as `?diag=<name>`. **No writer is**, deliberately — every
`import*` runs from the editor only.

## The three bugs from this round, because they rhyme

They were all the same shape: **code that was right in a way nobody had
checked against what a person would actually see or read.**

- The importer resolved names differently from the profiler, dropped 275 of 364
  rows, and still printed Bharath as a holder at the top of the report (18.5).
- `AJ` and `AN` are both headed "Actual". Matching the header row alone picked
  the right one by luck and would have silently started measuring delivery
  instead of arrival (18.2).
- Every rate on the dashboard rendered as 0 or 1, through three dry runs and two
  imports, because a dry run proves the arithmetic and says nothing about the
  page (18.10).

A test that asserts the number is not a test that anybody can read the number.
