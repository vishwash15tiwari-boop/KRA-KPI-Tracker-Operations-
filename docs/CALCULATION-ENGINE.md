# The Calculation Engine

Every KPI number in the product comes from one function. This document states each
formula, names the workbook cell it was taken from, and points at the test that
proves it.

```js
Engine.metric(metricKey, window, scope, { trace })
  → { value, count, contributors, meta }
```

---

## 1. Windows

All windows are half-open intervals `[start, end)`, defined once in
`DateUtil` (`02_Util.gs`) and used everywhere.

| Window | Bounds | Workbook original |
|--------|--------|-------------------|
| **as-of** | `today − REPORTING_LAG_DAYS` (default 1) | `TEXT(TODAY()-1, …)` — source imports lag a day |
| **MTD** | `[1st of the month, asOf + 1)` | `>= EOMONTH(TODAY(),-1)+1`, `< TODAY()` |
| **LMTD** | `[1st of previous month, same elapsed day + 1)` | `>= EOMONTH(TODAY(),-2)+1`, `< EDATE(TODAY(),-1)` |
| **MONTH** | `[1st, 1st of next month)` | `>= DATE(y,m,1)`, `< DATE(y,m+1,1)` |
| **FYTD** | `[1 Apr of the fiscal year, asOf + 1)` | `DATE(IF(MONTH(TODAY())>=4, YEAR(TODAY()), YEAR(TODAY())-1), 4, 1)` |
| **elapsed days** | `end − start` | `DAY(TODAY()-1)` |
| **remaining days** | `days in month − elapsed` | `DAY(EOMONTH(TODAY(),0)) − DAY(TODAY()-1)` |

Fiscal year is April–March (`FY_START_MONTH = 4`).

At as-of 2026-08-10 this yields MTD `[1 Aug, 11 Aug)` = 10 elapsed, 21 remaining,
and LMTD `[1 Jul, 11 Jul)` — identical coverage to the workbook.

> **Corrected:** the workbook used the *calendar* year for YTD onboarding
> (`POC-Wise!E`) and the *fiscal* year for YTD transactions. Both now use fiscal.

---

## 2. Transaction validity

Reproduced from roughly forty `COUNTIFS`/`SUMIFS` in the workbook:

```
valid ⇔ Shipment_Status ∉ { DRAFT, CANCELLED, "" }
        AND Draft_Date ∈ [window.start, window.end)
```

`Draft_Date` — not invoice date, not dispatch date — is the period basis for every
transaction measure. A blank status is not a transaction.

---

## 3. Value conventions

| Quantity | Rule | Source |
|----------|------|--------|
| GMV (₹ Cr) | `Σ invoice amount ÷ 10⁷` | `/10^7` throughout |
| GMV basis | `Invoice_Taxable_Amount` (ex-GST) | `GMV_BASIS` config |
| Tonnage | `Σ Invoice_Qty_MT` | column X |
| Realised rate | `GMV_taxable ÷ (tonnage_MT × 1000) ÷ RATE_GST_DIVISOR` | `OMP-Sellers!AK` |
| GMV target | `tonnage_MT × rate_per_kg ÷ 10,000` | `OMP-Sellers!AH = AF×AG/10000` |
| Percentages | stored as fractions (`0.9` = 90%) | throughout |
| Division | `IFERROR(a/b, 0)` — a zero denominator yields 0 | `Util.div` |

> **Corrected (config-gated):**
> * `GMV_BASIS = TAXABLE`. The workbook used `Invoice_Total_Amount` (incl. GST) for
>   FYTD and `Invoice_Taxable_Amount` for MTD and all targets — an 18% inconsistency
>   that made FYTD incomparable to the sum of its months. Set `TOTAL` for the legacy
>   FYTD figure.
> * `RATE_GST_DIVISOR = 1`. The workbook divided an already-ex-GST amount by 1.18,
>   reporting ₹42.57/kg where the invoice read ₹50/kg. Set `1.18` for the legacy rate.

---

## 4. Metrics

### Transaction measures

| Metric | Definition |
|--------|-----------|
| `TXN_COUNT` | count of valid shipments in scope and window |
| `TONNAGE_MT` | `Σ invoiceQtyMT` |
| `GMV_CR` | `Σ gmvInr ÷ 10⁷` |
| `RATE_PER_KG` | `Σ taxable ÷ (Σ tonnage × 1000) ÷ RATE_GST_DIVISOR` |

### Onboarding

```
SELLER_ONBOARDED = count( status = COMPLETED AND onboardedDate ∈ window )
```
Source: `COUNTIFS('Seller Onboarding'!K, "Completed", …AY, poc, …R, window)`.

### Existing / new / retained

| Metric | Definition |
|--------|-----------|
| `EXISTING_SELLER_TXN` | distinct sellers transacting in the window whose onboarded date falls **before** it |
| `NEW_SELLER_TXN` | distinct sellers transacting in the window whose onboarded date falls **inside** it |
| `SELLER_RETENTION` | distinct sellers transacting in **both** this window and the previous full month |

An account with no onboarding record counts as *existing*, matching the workbook,
which put every onboarded seller in the denominator. Buyer equivalents are identical
with the demand-side owner.

### Coverage

| Metric | Definition | Source |
|--------|-----------|--------|
| `ONBOARDED_VS_VISIT` | onboarded accounts with ≥ 1 visit in the window | `WhatsApp!D8` |
| `ONBOARDED_VS_TXN` | onboarded accounts that transacted in the window | `WhatsApp!D9` |
| `PULSE_VISITS` | `Σ visitCount` excluding leave days | `MTD Pulse Summary!D` |

### Receivables (Demand)

```
DN_PCT_OF_GMV = Σ debitNoteINR ÷ Σ GMV_INR
DSO_DAYS      = (avg(opening, closing) ÷ GMV_INR) × days in month
```
Source: KRA definitions *"DN should be 1% of the buyer's current-month GMV"* and
*"(Average Receivables ÷ GMV) × Number of Days in the Month"*.

Both are **lower-is-better** and their rating bands descend.

---

## 5. Targets

A KPI declares where its target comes from; the engine resolves it.

| Basis | Formula | Source |
|-------|---------|--------|
| `ACCOUNT_PLAN` | `Σ` of the per-account monthly plan | `OMP-Sellers!AE:AH` |
| `PCT_OF_METRIC` | `basisPct × metric(basisMetric)` | 50% / 20% / 70% rules |
| `BALANCE_PLUS_MTD` | `max(0, annual − FYTD) + MTD` | `POC-Wise!N = G + K` |
| `RATE_PER_DAY` | `(workingDays − leaveDays) × visitsPerDay` | `WhatsApp!C38 = 25*3` |
| `MANUAL` | the number entered during planning | — |
| *override* | an explicit per-assignment value always wins | — |

The three percentage rules, verbatim from the KRA sheet:

| KPI | Target |
|-----|--------|
| Transaction from Existing Sellers | `50% × onboarded sellers (FYTD)` |
| Transaction from New Onboarded Sellers | `20% × sellers onboarded this month` |
| Retention of Existing Transacted Sellers | `70% × sellers transacting last month` |

`BALANCE_PLUS_MTD` is the most consequential rule in the workbook: the monthly
acquisition target is not fixed, it is *whatever is left of the annual plan*,
re-baselined each month, so a shortfall carries forward automatically.

> **Corrected:** `RATE_PER_DAY` now deducts recorded leave
> (`PULSE_DEDUCT_LEAVE = true`). The workbook tracked leave but never applied it.

---

## 6. Achievement, pace and rating

```
achievement    = actual ÷ target                         (0 when target = 0)
               = target ÷ actual                         (lower-is-better KPIs)
capped         = MIN(achievement, ACHIEVEMENT_CAP)       cap = 1.05
weightedScore  = capped × weightage                      OMP scorecard G16 = MIN(F16,1.05)*C16
gap            = MAX(0, target − actual)
currentDrr     = actual ÷ elapsedDays                    WhatsApp F = D/DAY(TODAY()-1)
requiredDrr    = gap ÷ remainingDays                     WhatsApp G = (C-D)/(days-elapsed)
projected      = actual + currentDrr × remainingDays
growthPct      = (actual − lmtd) ÷ lmtd                  WhatsApp I
paceRatio      = currentDrr ÷ requiredDrr
```

**Pace status** — the single most actionable signal on any screen:

| Status | Condition |
|--------|-----------|
| `ACHIEVED` | `achievement ≥ 1` |
| `ON_TRACK` | `paceRatio ≥ PACE_WARN_RATIO` (0.90) |
| `AT_RISK` | `paceRatio ≥ PACE_CRITICAL_RATIO` (0.70) |
| `CRITICAL` | below that |

**Rating bands** (KRA sheet rows 19–23):

| Rating | Label | Threshold | Legacy status string |
|-------:|-------|----------:|----------------------|
| 5 | Exceeds Expectation | ≥ 105% | `105% Target` |
| 4 | Above Expectation | ≥ 100% | `100% Target` |
| 3 | Meets Expectation | ≥ 90% | `90% Target` |
| 2 | Below Expectation | ≥ 75% | `75% Target` |
| 1 | Needs Improvement | ≥ 60% | `60% Target` |
| 0 | — | below | `Below 60%` |

For lower-is-better KPIs the bands descend: `DN % of GMV` runs 1.3% → 0.6% and
`DSO Days` runs 15 → 2.

---

## 7. Scorecard roll-up

```
totalWeightage     = Σ weightage
weightedScore      = Σ (capped_i × weightage_i)          BDM Summary K = SUM(G16:G20)
overallAchievement = MIN(weightedScore ÷ totalWeightage, 1.05)
                                                          BDM Summary L = MIN(K/100, 1.05)
rank               = competition ranking, descending      BDM Summary M = RANK(L, range, 0)
```

> **Corrected:** the workbook divided by a hard-coded 100. The engine divides by the
> *actual* total weightage, so the figure stays meaningful even if the 100% rule is
> ever relaxed. Publishing still blocks unless each stream totals exactly 100
> (`REQUIRE_WEIGHTAGE_100`) — the rule the spreadsheet assumed but never checked.

Ranking preserves Excel's `RANK(…, 0)` semantics: ties share the better rank and the
next rank is skipped.

---

## 8. Scope and attribution

```js
scope = { category, stream, regionId?, pocUserId?, gstin?, materialType? }
```

`stream` decides which side of a transaction owns it:

| Stream | Owner | Region |
|--------|-------|--------|
| `SUPPLY` | `pocUserId` (seller-side) | `regionId` |
| `DEMAND` | `buyerPocUserId` | `buyerRegionId` |
| `BOTH` | supply side, so an unscoped total never double-counts | |

The aggregation chain from the workbook is preserved exactly, but as scope narrowing
rather than as three separate calculations:

```
Overall Shipments ─┬─ gstin ─> account ─┬─ POC ──> region ──> category
Seller Onboarding ─┘                    └─ material type
```

`Region-Wise` in the workbook was literally
`SUMIFS('POC-Wise'!<col>, 'POC-Wise'!A:A, <region>)` — proof that region is a
dimension, not a separate calculation. The engine treats it that way.

---

## 9. Verification

`tests/engine.test.js` — 121 assertions against the raw August 2026 data.

| Assertion | Source cell | Expected | Result |
|-----------|-------------|---------:|--------|
| MTD transactions | `WhatsApp!D11` | 35 | ✓ |
| MTD tonnage | `WhatsApp!D12` | 430.245 | ✓ |
| MTD GMV | `WhatsApp!D13` | 2.1523311 | ✓ |
| LMTD transactions | `WhatsApp!H11` | 19 | ✓ |
| LMTD GMV | `WhatsApp!H13` | 1.1531985 | ✓ |
| North MTD transactions | `WhatsApp!D21` | 23 | ✓ |
| North MTD GMV | `WhatsApp!D23` | 1.4104036 | ✓ |
| South MTD GMV | `WhatsApp!D33` | 0.7419275 | ✓ |
| Ashish Kumar Rai GMV | `WhatsApp!D44` | 0.7456501 | ✓ |
| Praveen Raj P tonnage | `WhatsApp!D103` | 17.98 | ✓ |
| Raju B GMV | `WhatsApp!D114` | 0.266312 | ✓ |
| Completed onboardings | `WhatsApp!C8` | 110 | ✓ |
| MTD onboarded | `WhatsApp!D10` | 3 | ✓ |
| North onboarded base | `WhatsApp!C18` | 58 | ✓ |
| Plan totals | `WhatsApp!C11:C13` | 102 / 1120 / 5.709 | ✓ |
| Weighted score | `BDM Summary!K3` | 46.5714 | ✓ |
| Overall achievement | `BDM Summary!L3` | 46.57% | ✓ |
| GMV weighted score | scorecard `G19` | 38 | ✓ |
| Status band | scorecard `I19` | `90% Target` | ✓ |

Where two sheets disagreed, the test follows the figure two independent formulas
agree on. For the LMTD block and the plan totals that is `WhatsApp Summary` and
`Region-Wise` — both unfiltered — against the single filter-sensitive `SUBTOTAL` on
`OMP-Sellers` (defect 13).
