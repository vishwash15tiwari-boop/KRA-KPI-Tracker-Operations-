# Workbook Analysis — `OMP_August_2026_Plastic_Proposal_Daily_Review.xlsx`

This document is the reverse-engineering record of the existing spreadsheet-based
operating process for the OMP Supply & Demand (Plastic) team. Every rule below was
extracted from a live formula or a live data pattern in the workbook, not assumed.
It is the specification the application implements.

The workbook is **not** a set of spreadsheets. It is a five-layer business process:

```
Layer 1  SOURCE      Seller Onboarding · Overall Shipments · MTD Pulse Summary
         (imported)  Onboarded Sellers VS Pulse
                                  │
Layer 2  PLAN        OMP-Sellers · OMP-Buyers · Weekly Plan vs Achievement
         (manual)    Aug Buyer Plan · Sheet1 / Sheet1 (1) (prospect lists)
                                  │
Layer 3  MEASURE     POC-Wise  ──►  Region-Wise
         (formula)
                                  │
Layer 4  SCORE       OMP-Supply & Demand KRA & KPI  ──►  10 per-POC scorecards
         (formula)                                  ──►  BDM Summary
                                  │
Layer 5  REVIEW      WhatsApp Summary (daily leadership dashboard)
```

---

## 1. Sheet inventory (25 sheets)

| # | Sheet | Rows×Cols | Layer | Becomes |
|---|-------|-----------|-------|---------|
| 1 | `📱 WhatsApp Summary` | 334×64 | Review | **Daily Review / Executive Dashboard** module |
| 2 | `🎯 OMP-Supply & Demand KRA & KP` | 23×11 | Score | **Planning → KRA/KPI Library** module |
| 3 | `📅 Weekly Plan vs Achievement` (hidden) | 220×26 | Plan | **Weekly Plan** module |
| 4 | `📍 MTD Pulse Summary` | 1001×54 | Source | **Pulse / Field Visit** activity source |
| 5 | `🌍 Region-Wise` | 220×63 | Measure | *Generated* — Region Performance report |
| 6 | `POC-Wise` | 220×64 | Measure | *Generated* — POC Performance report |
| 7 | `🏢 OMP-Sellers` | 1002×47 | Plan+Measure | **Seller Account Plan** + generated actuals |
| 8 | `🤝 OMP-Buyers` | 1001×46 | Plan+Measure | **Buyer Account Plan** + generated actuals |
| 9 | `🏢 Seller Onboarding` | 1001×60 | Source | **Onboarding** activity source |
| 10 | `🚚 Overall Shipments` | 1000×59 | Source | **Transaction (shipment)** fact source |
| 11 | `👥 Onboarded Sellers VS 📍 Puls` | 1000×27 | Source | *Generated* — seller × visit coverage bridge |
| 12 | `Sheet1` | 55×8 | Plan | **Buyer prospect pipeline** (recyclers) |
| 13 | `📋 Aug Buyer Plan` | 229×22 | Plan | **Buyer Onboarding Pipeline** + document checklist |
| 14 | `Sheet1 (1)` | 1000×26 | Plan | **Seller prospect pipeline** |
| 15 | `BDM Summary` | 1000×26 | Score | *Generated* — Scorecard leaderboard |
| 16–25 | 10 × per-POC sheets | 22×10 each | Score | *Generated* — individual POC scorecard |

The ten per-POC sheets are: Ashish Kumar Rai, Asraful Hasan, Brajendra Upadhyay,
Joydeep Das, Parth Gautam, Atharva Sudhir Patil, Praveen Raj P, Raju B,
Rustumpet Ashwin Kumar, Uday Kiran Kumar Thota. They are **structurally identical**
— the clearest signal in the workbook that the scorecard is a template, not ten
documents. In the product it becomes one generated view parameterised by POC.

---

## 2. Layer 1 — Source facts

### 2.1 `🚚 Overall Shipments` — the transaction fact table

Pulled by `IMPORTRANGE` from the operations system. One row = one shipment.
This single table drives **every** GMV, tonnage and transaction-count number in
the entire workbook.

| Col | Field | Role |
|-----|-------|------|
| A | `Business_Category` | Partition key — `Plastic` (Metal in sibling workbook) |
| B | `Month_Year` | Denormalised period |
| C | `Overall_Business_Week` | Business week number (`Week-12`) |
| D | `Calendar_Month_Week` | Week within month (`Week-02`) |
| E | `Created_Date` | Order created |
| F | `Order_Last_Updated_Date` | |
| G | `Requisition_ID` | Buyer requisition |
| H | `Buyer_Name` | |
| **I** | **`Buyer_GSTIN`** | **Join key → OMP-Buyers.B** |
| J | `Listing_ID` | Seller listing |
| K | `Seller_Name` | |
| **L** | **`Seller_GSTIN`** | **Join key → OMP-Sellers.C** |
| M | `HSN_Code` | |
| N | `Item_Names` | Material description |
| O | `Requested_Qty_MT` | Buyer ask |
| P | `Booked_Qty_MT` | Order booked |
| Q | `Final_Price_Per_MT` | **Actually ₹/kg** — see §6.3 |
| R–T | `Taxable_Amount`, `GST_Amount`, `Total_Amount` | Order value |
| U–W | `Invoice_Date`, `Invoice_Number`, `Invoice_Eway_Bill_Number` | |
| **X** | **`Invoice_Qty_MT`** | **Tonnage measure** |
| **Y** | **`Invoice_Taxable_Amount`** | **GMV measure (MTD / MoM / target)** |
| Z | `Invoice_GST_Amount` | |
| **AA** | **`Invoice_Total_Amount`** | **GMV measure (FYTD only — inconsistent, see §6.2)** |
| AB–AC | `Payment_Terms_Days`, `Payment_Term_Bucket` | `0-7 Days` / `8-15 Days` / `16-30 Days` |
| AD–AE | `Sales_Order_ID`, `Shipment_ID` | |
| **AF** | **`Shipment_Status`** | **Validity filter** — `DRAFT`/`DISPATCHED`/`REACHED`/`RECEIVED_BY_RECYCLER`/`COMPLETED`/`CANCELLED` |
| AG | `Order_Status` | `ISSUED`/`IN_PROGRESS`/`REJECTED` |
| **AH** | **`Draft_Date`** | **Transaction date basis for every window** |
| AI–AN | `Order_Verified_Date`, `Dispatched_Date`, `Reached_Date`, `Received_By_Recycler_Date`, `Completed_Date`, `Cancelled_Date` | Lifecycle stamps → SLA measurement |
| AO | `Rejected_Date` | |
| **AP** | **`Region`** | Roll-up key |
| **AQ** | **`POC`** | Roll-up key (person accountable) |

**The universal transaction filter** — reproduced identically in ~40 formulas:

```
Shipment_Status <> "Draft"  AND  Shipment_Status <> "Cancelled"  AND  Shipment_Status <> ""
AND  Draft_Date >= <window start>  AND  Draft_Date < <window end>
```

Because Excel/Sheets `COUNTIFS` is case-insensitive, `"<>Draft"` correctly excludes
the stored `DRAFT`. Blank status is excluded — an empty row is not a transaction.

### 2.2 `🏢 Seller Onboarding` — the onboarding fact table

49 populated columns; 185 rows live. Also `IMPORTRANGE`d. One row = one seller
onboarding case, carrying both the funnel *and* a denormalised activity roll-up.

Identity & ownership: `Business_Vertical`(A) `Business_Category`(B) `Region`(C)
`RH_Name`(D) `Seller_ID`(E) `Seller_Business_Name`(F) `Seller_GST_Number`(G)
`Effective_Date_Of_Registration`(H) `Business_Vintage`(I, e.g. `09Y-01M`)
`Seller_Type`(J: Baler / Trader / Baler Cum Trader / Manufacturer)
**`Seller_Status`(K: `DRAFT`/`IN_REVIEW`/`COMPLETED`/`REJECTED`)** — the funnel state.

Contact: `Contact Person Name {Seller POC}`(L) `Seller_Mobile_Number`(M)
`Seller_Email`(N) `Seller_State`(O) `Seller_City`(P).

Funnel timestamps — **the SLA spine**:
`Created_Date`(Q) → `Review_Submission_Date {First Submission}`(S) →
**`Onboarded_Date`(R)** → `Updated_Date {Last Edit}`(T), with `Reject_Reason`(U).

Actor trail — already an audit trail in the source system:
`Created_By_ID/Name`(V/W) `Updated_By_ID/Name`(X/Y) `Submitted_By_ID/Name`(Z/AA).

Listing funnel: `Total_Listings`(AB) `Approved_Listings`(AC) `Closed_Listings`(AD)
`Expired_Listings`(AE) `Rejected_Listings`(AF) `Listings_Converted_To_Order`(AG)
`Listings_Not_Converted`(AH) `Yesterday_Listings`(AI) `Yesterday_Qty_MT`(AJ)
`Today_Listings`(AK) `Today_Qty_MT`(AL) `Last_Listing_Date`(AM)
**`Days_Inactive_Since_Last_Listing_Or_Onboarding`(AN)** — the dormancy signal.

Order/shipment funnel: `Total_Orders`(AO) `Total_Shipments`(AP) `Draft`(AQ)
`Dispatched`(AR) `Reached`(AS) `Received_By_Recycler`(AT) `Completed`(AU)
`Cancelled`(AV) `Cancelled_Before_Shipment`(AW) `Shipment_Cancelled_Order_Active`(AX).

**`POC`(AY)** — the accountable person; join key to POC-Wise.

**Onboarding count rule** (used everywhere):

```
COUNTIFS(Seller_Status = "Completed", POC = <poc>, Onboarded_Date ∈ [start, end))
```

Note `Seller_Status` is matched as `"Completed"` against stored `COMPLETED` —
again relying on case-insensitive matching. The FYTD variant additionally bounds
`Created_Date <= TODAY()`.

### 2.3 `📍 MTD Pulse Summary` — field-visit facts

Two stacked blocks, current month (rows 3–15) and previous month (rows 18–30),
each: `Employee ID`, `Employee Name`, `Total Visits`, `Unique Seller Visits`,
`Leave Days`, then one column per calendar day holding either a visit count or
the literal **`L` = on leave**. Columns AL:AR repeat a rolling last-7-days block.
Row 33 carries `Last refreshed:` — the sheet is machine-populated.

13 employees are tracked, a superset of the 10 scored POCs (adds Panchal Rishi,
Neelesh Dixit, and the two RHs).

### 2.4 `👥 Onboarded Sellers VS 📍 Pulse` — coverage bridge

One row per onboarded seller: `Region`, `RH_Name`, `Seller_ID`, `Seller_GST_Number`,
`Seller_Business_Name`, `Seller_Status`, `Total_Visits`, monthly visit buckets
`Apr`…`Jul`, **`MTD-Aug`(L)**, **`LMTD`(M)**, `Last_Visit_Date`(N), `POC`(O).

Answers *"is the seller we onboarded actually being serviced?"* — the
`Onboarded vs Visit` metric counts sellers where `MTD-Aug > 0` and
`Seller_Status = Completed`.

---

## 3. Layer 2 — Plan

### 3.1 `🏢 OMP-Sellers` / `🤝 OMP-Buyers` — account-level monthly plan

Layout: row 2 = merged band headers, **row 3 = `SUBTOTAL(9, …)` totals**,
row 4 = field headers, rows 5+ = data. `SUBTOTAL` (not `SUM`) is deliberate:
totals must respond to the filter view the team uses in review meetings.

Identity block (manual): Region, RH_Name, **Seller_GST_Number** (or Buyer_GST_Number),
Business Name, Mobile, State, counterparty name, **POC**, **Material Type**
(`PET` / `Flakes` / `Others (Granules/Fibre)`).

Then four **computed** measure blocks and one **manual** target block:

| Block | Cols (Sellers) | Nature | Window |
|-------|----------------|--------|--------|
| `FY 2026–27 {YTD Performance}` | J–L | computed | 1-Apr-FY → today |
| `Transaction_Count {Month-on-Month}` | M–R | computed | May, Jun, Jul, Aug, LMTD, MTD-Growth% |
| `Tonnage_MT {Month-on-Month}` | S–X | computed | same |
| `GMV_₹ Cr {Month-on-Month}` | Y–AD | computed | same |
| **`Target (August Procurement Projection)`** | **AE–AH** | **MANUAL** | Txn Target, Tonnage_Mt Target, **Rate per KG Target**, GMV_Cr Target |
| `Achieved (Daily Actuals)` | AI–AL | computed | MTD |
| `LMTD (Last Month Till Date)` | AM–AO | computed | LMTD |
| `Growth % (This Month vs LMTD)` | AP–AR | computed | |
| `Remarks` / `Detailed Remarks` | AS–AT | MANUAL | qualitative blocker capture |

**Only AE, AF, AG and the remarks are human input.** Everything else is formula.
`GMV_Cr (Target) = Tonnage_Mt(Target) × Rate per KG(Target) / 10,000`.

`Remarks` is a controlled vocabulary in practice — *"Seller Working with Trader"*,
*"GST Payment Pending"*, *"Seller Working Only in Cash"* — i.e. a **blocker reason
code**, with `Detailed Remarks` as free text. This is the qualitative "why" that
leadership asks for in review.

`OMP-Buyers` mirrors this exactly, keyed on `Buyer_GST_Number` against
`Overall Shipments!I`, plus a `Payment Terms` column.

### 3.2 `📅 Weekly Plan vs Achievement` (hidden)

Per POC per week: `Weekly Target`, `Weekly Ach.`, `Ach %`, then a `Tgt`/`Ach`
column *pair* for each of 7 days. Day headers chain (`=H4+1`). Targets are
tonnage. Currently **both** target and achievement are typed by hand — the
achievement half is pure manual duplication of data that already exists in
`Overall Shipments`. The sheet is hidden because it went stale.

### 3.3 `📋 Aug Buyer Plan` — buyer onboarding pipeline

`Buyer Name`, `Commodity`, `Region`, `City`, `Payment Terms` (`D+3`/`D+5`/`D+10`/
`D+15`/`NBFC`/`POD`), `Document Status` (`Not Collected`/`Partially Collected`/
`Under Process`/`Collected`), `Onboarding Status` (`Under Process`/`Onboarded`),
`Current Orders`, `Onboarding Date`, `Remarks`, and a **document checklist**:
`GST Certificate`, `PAN Card`, `PWM Certificate CTE`, `PWM Certificate CTO`,
`Cancelled Cheque` — each `⬜`/`✅` — driving `Overall Status`
(`Pending` / `Partial` / `Onboarded`).

This is a **stage-gated onboarding workflow with a document checklist**, expressed
in emoji. It becomes a first-class pipeline module with real document slots.

### 3.4 `Sheet1` / `Sheet1 (1)` — prospect lists

`Sheet1`: recycler (buyer) prospects — `RecyclerName`, `State`, `City`,
`Material rqd`, `Status` (`Onboarded`/`Followup`), `Paymant pattern`
(`POD`/`D+5`/`NBFC`/`Under Negotiation`), `Transaction` (`Transaction started`/
`Yet to be transected`).

`Sheet1 (1)`: seller prospects — `Region`, `Seller_Business_Name`, `Mobile`,
`State`, `POC`, `Remarks`, `Details`. Remarks are again blocker codes
(*"Spot Payment"*, *"Payment on Delivery"*).

---

## 4. Layer 3 — Measure

### 4.1 `POC-Wise` — the aggregation hub

64 columns, one row per POC. **Every cell except `Total Onboarding Sellers Plan`(D)
is a formula.** Two distinct source patterns:

*Onboarding block (D–P)* reads `Seller Onboarding` directly:

| Col | Field | Rule |
|-----|-------|------|
| D | `Total Onboarding Sellers Plan` | **manual** — annual plan |
| E | `YTD {Onboarded Till Now}` | `COUNTIFS(Status="Completed", POC, Onboarded_Date ≥ 1-Jan-YYYY, Created_Date ≤ today)` |
| F | `Achievement %` | `E/D` |
| G | `Balance To Do` | `D − E` |
| H–K | May / Jun / Jul / Aug | monthly onboarded counts by `Onboarded_Date` |
| L | `LMTD` | `EOMONTH(today,−2)+1 … EDATE(today,−1)` |
| M | `MTD Growth %` | `(K − L)/L` |
| **N** | **`New Seller Onboarding Tgt`** | **`G + K`** — balance-to-do *plus* what is already done this month |
| O | `New Seller Onboarding Achieved` | current-month onboarded count |
| P | `Achievement %` | `O/N` |

Column **N is the most important derived rule in the sheet**: the monthly
onboarding target is not a fixed number, it is *whatever is left of the annual
plan, re-baselined every month*. A POC who under-delivers carries the shortfall
forward automatically.

*Transaction block (Q–AZ)* reads `OMP-Sellers` (already GST-keyed), summing by
`POC`: FYTD txn/tonnage/GMV, month-on-month series, MTD target/achieved/LMTD,
achievement % and growth % for each of the three measures.

*Material split (BA–BL)*: tonnage & GMV target-vs-achieved for `PET`, `Flakes`,
`Others` — `SUMIFS(…, Material Type, "PET", POC, …)`.

### 4.2 `🌍 Region-Wise` — pure roll-up

Structurally identical to POC-Wise, and **every data cell is
`SUMIFS('POC-Wise'!<col>, 'POC-Wise'!A:A, <region>)`**. It adds nothing but the
grouping — proof that region is a dimension, not a separate calculation. Two rows:
North (RH: Parth Gautam) and South (RH: Uday Kiran Kumar Thota); plus a
`Not Mapped` bucket appearing in source data.

It also adds explicit `Achievement %` columns (AQ–AS) that POC-Wise computes
inline, and the same `New Seller Onboarding Tgt = Balance To Do + MTD` rule (col M).

---

## 5. Layer 4 — Score

### 5.1 `🎯 OMP-Supply & Demand KRA & KPI` — the master definition

Two KRA sets. Columns: `Perspective`, `KRA`, `Source of Tracking`,
`KPI / Definition`, `Weightage (%)`, `Unit of Measurement`, `Target 1`…`Target 5`.

**Supply (seller-side) — 100%**

| KRA | KPI definition | Weight | Unit |
|-----|----------------|-------:|------|
| Transaction from Existing Sellers | 50% of total onboarded sellers should transact in the current month | 15 | % |
| Transaction from New Onboarded Sellers | 20% of sellers onboarded this month should transact in the same month | 15 | % |
| New Seller Acquisition | As per monthly target | 15 | % |
| GMV | As per monthly target | **40** | % |
| Retention of Existing Transacted Sellers | 70% of sellers who transacted in the previous month should transact again | 15 | % |

**Demand (buyer-side) — 100%**

| Perspective | KRA | KPI definition | Weight | Unit |
|---|-----|----------------|-------:|------|
| Sales | Transaction from Existing Buyers | 50% of onboarded buyers should transact this month | 15 | % |
| Scale | Transaction from New Onboarded Buyers | 20% of buyers onboarded this month should transact same month | 15 | % |
| Customer | New Buyer Acquisition | As per monthly target | 15 | % |
| Process | GMV | As per monthly target | 30 | % |
| Customer | **DN % of GMV** | DN should be 1% of the buyer's current-month GMV | 10 | % |
| Process | **DSO Days** | (Average Receivables ÷ GMV) × days in month | 15 | Days |

Demand weights sum to **100** (15+15+15+30+10+15).

**Target bands** map to the five-point rating scale in rows 19–23:

| Rating | Label | Normal KPI | `DN % of GMV` | `DSO Days` |
|-------:|-------|-----------:|--------------:|-----------:|
| 1 | Needs Improvement | 60% | 1.3% | 15 |
| 2 | Below Expectation | 75% | 1.2% | 10 |
| 3 | Meets Expectation | 90% | 1.0% | 5 |
| 4 | Above Expectation | 100% | 0.8% | 3 |
| 5 | Exceeds Expectation | 105% | 0.6% | 2 |

`DN % of GMV` and `DSO Days` are **lower-is-better**: their bands descend. Every
other KPI is higher-is-better. The engine must carry a direction flag per KPI.

### 5.2 Per-POC scorecard (×10, identical structure)

*Section 1 — `BDM Target & Achievement`* (rows 5–11): the raw inputs.

| Metric | Target/Base | Achieved | Achievement % | Meaning |
|--------|-------------|----------|---------------|---------|
| YTD Onboarded Sellers | 14 | — | — | base for existing-seller target |
| New Seller Onboarding | 4 | 0 | `=C/B` | monthly target vs achieved |
| GMV (Cr) | 0.6 | 0.57 | `=C/B` | |
| July Transacted Sellers | 5 | — | — | base for retention |
| Retention Achieved | 5 | 1 | `=C/B` | retained vs previous-month base |
| Transaction from Existing Sellers | 7 | 2 | `=C/B` | target = **50% of onboarded** (⌈14×0.5⌉=7) |
| Transaction from New Onboarded Sellers | 0 | 0 | `=C/B` | target = **20% of current-month onboarded** |

*Section 2 — `KRA & KPI Weighted Scorecard`* (rows 15–22):

```
KPI Target      D16 = B10                      (link to section 1)
Actual          E16 = C10
Achievement %   F16 = IFERROR(E16/D16, 0)
Weighted Score  G16 = MIN(F16, 1.05) × C16      ← cap at 105%, C = weightage
Status          I16 = IF(F≥1.05,"105% Target",
                      IF(F≥1,"100% Target",
                      IF(F≥0.9,"90% Target",
                      IF(F≥0.75,"75% Target",
                      IF(F≥0.6,"60% Target","Below 60%")))))
Total Weightage B22 = SUM(C16:C20)              = 100
Weighted Score  E22 = SUM(G16:G20)
Maximum at 105% H22 = B22 × 1.05                = 105
Overall Ach.    J22 = IFERROR(E22/100, 0)
```

**Retention has its own target derivation**: `D20 = B9 × 70%` — the KPI target is
70% of the previous-month transacted base, not the base itself.

### 5.3 `BDM Summary` — leaderboard

Pulls each POC's inputs plus:

```
Weighted Score        K = SUM('<POC>'!G16:G20)
Overall Achievement % L = MIN(K/100, 1.05)
Ranking               M = RANK(L, $L$3:$L$12, 0)     ← descending, ties share rank
```

Row 15 documents the rule: *"Weighted Score ÷ 100 × 100. Overall Achievement is
capped at 105%."*

---

## 6. Layer 5 — Review: `📱 WhatsApp Summary`

The daily leadership artefact. `B3 = "As Of " & TEXT(TODAY()-1, "dd-mmm-yyyy")` —
**the dashboard reports through yesterday**, because source imports lag one day.
This single fact explains every `TODAY()-1` and every `< TODAY()` bound in the
workbook.

Three nested scopes, each a 7-metric × 8-column grid:

* **Overall** (rows 7–13) — Plastic category total
* **Region** (rows 17–23 North, 27–33 South) — `= Σ` of member POC blocks for
  visit metrics, direct `SUMIFS` for the rest
* **POC** (rows 38–44, 48–54, … 128–134) — ten blocks, one per POC

**The seven metrics**

| Metric | Target source | Achieved source |
|--------|---------------|-----------------|
| Overall Pulse Visits | `25 working days × 3 visits = 75`/POC | `MTD Pulse Summary` Total Visits |
| Onboarded vs Visit | count of `Completed` onboardings | onboarded sellers with `MTD visits > 0` |
| Onboarded vs Transaction | count of `Completed` onboardings | onboarded sellers that transacted MTD |
| Sellers Onboarded | `POC-Wise!N` (Balance + MTD) | `COUNTIFS(Onboarded_Date ∈ MTD)` |
| Seller Txns | `Σ OMP-Sellers!AE` (Txn Target) | `COUNTIFS(Shipments, MTD, valid)` |
| Tonnage (MT) | `Σ OMP-Sellers!AF` | `SUMIFS(Invoice_Qty_MT, MTD, valid)` |
| GMV (₹ Cr) | `Σ OMP-Sellers!AH` | `SUMIFS(Invoice_Taxable_Amount, MTD, valid)/10^7` |

**The eight columns** — this is the decision grammar leadership actually reads:

```
Target          plan for the month
Achieved        MTD actual (through yesterday)
Achievement %   = Achieved / Target
Current DRR     = Achieved / DAY(TODAY()-1)                       ← run-rate so far
Required DRR    = (Target − Achieved) / (days_in_month − elapsed) ← run-rate needed
LMTD            same-window last month
MTD Growth %    = (Achieved − LMTD) / LMTD
```

`Current DRR` vs `Required DRR` is the single most actionable pair in the workbook:
when Required > Current, the POC is off pace and the gap quantifies the catch-up.
The application promotes this to a first-class, colour-coded signal.

---

## 7. Cross-cutting rules the engine must centralise

### 7.1 Time windows (all derived from `TODAY()`)

| Window | Bounds | Formula in workbook |
|--------|--------|---------------------|
| **MTD** | `[1st of current month, TODAY)` | `>= EOMONTH(TODAY(),-1)+1`, `< TODAY()` |
| **LMTD** | `[1st of prev month, same day prev month)` | `>= EOMONTH(TODAY(),-2)+1`, `< EDATE(TODAY(),-1)` |
| **Full month** | `[1st, 1st of next month)` | `>= DATE(y,m,1)`, `< DATE(y,m+1,1)` |
| **FYTD** | `[1 Apr of FY, TODAY)` | `>= DATE(IF(MONTH(TODAY())>=4, YEAR(TODAY()), YEAR(TODAY())-1), 4, 1)` |
| **Elapsed days** | `DAY(TODAY()-1)` | |
| **Remaining days** | `DAY(EOMONTH(TODAY(),0)) − DAY(TODAY()-1)` | |

Fiscal year is **April–March** (Indian FY). Note the *inconsistency*: `POC-Wise!E`
("YTD Onboarded") uses `DATE(YEAR(TODAY()),1,1)` — **calendar** year — while every
transaction YTD uses the **fiscal** year. Recorded in §8.

### 7.2 Aggregation chain

```
Overall Shipments ──GSTIN──► OMP-Sellers ──POC──► POC-Wise ──Region──► Region-Wise
                  └─GSTIN──► OMP-Buyers  ──POC──┘                          │
Seller Onboarding ────POC────────────────────────┘                          │
MTD Pulse ────────────Employee────────────────────────────────────────► WhatsApp
                                                                      Summary ◄┘
Scorecard inputs ──► per-POC scorecard ──► BDM Summary
```

### 7.3 Value conventions

* GMV is reported in **₹ Crore** = raw ₹ ÷ 10<sup>7</sup>.
* Tonnage in **MT**; rate in **₹/kg**; `GMV_Cr = Tonnage_MT × Rate_per_kg / 10,000`.
* `Final_Price_Per_MT` (Shipments!Q) holds values like `50`, `50.5`, `48` while
  `Invoice_Taxable_Amount / Invoice_Qty_MT` = `50,000`/MT. The column is
  **mislabelled — it is ₹ per kg.**
* All `%` values are stored as fractions (`0.9` = 90%).
* Every division is wrapped `IFERROR(…, 0)` — divide-by-zero yields 0, never an error.
* `IFERROR(…, "0")+0` is used to coerce the text fallback back to a number.

### 7.4 Achievement, capping and rating

```
achievement   = achieved / target                      (0 when target = 0)
capped        = MIN(achievement, 1.05)
weightedScore = Σ (capped_i × weight_i)
overall       = MIN(weightedScore / 100, 1.05)
rating        = 5 if a ≥ 1.05, 4 if ≥ 1.00, 3 if ≥ 0.90, 2 if ≥ 0.75, 1 if ≥ 0.60, else 0
```

For **lower-is-better** KPIs (`DN % of GMV`, `DSO Days`) the band comparison
inverts: rating 5 when `actual ≤ Target5`, and achievement is computed as
`target / actual`.

### 7.5 Derived KPI targets

| KPI | Target formula | Source |
|-----|----------------|--------|
| Transaction from Existing Sellers | `50% × YTD onboarded sellers` | scorecard row 10 |
| Transaction from New Onboarded Sellers | `20% × current-month onboarded` | scorecard row 11 |
| Retention of Existing Transacted Sellers | `70% × previous-month transacted sellers` | scorecard `D20 = B9×70%` |
| New Seller Acquisition | `Balance To Do + MTD onboarded` | `POC-Wise!N = G + K` |
| GMV / Tonnage / Txn | `Σ account plan` | `OMP-Sellers!AE:AH` |
| Pulse Visits | `working days × 3` | `WhatsApp!C38 = 25*3` |

---

## 8. Defects and inconsistencies found (and how the product handles them)

| # | Finding | Evidence | Product decision |
|---|---------|----------|------------------|
| 1 | **GMV basis is inconsistent.** FYTD GMV sums `Invoice_Total_Amount` (incl. GST); MTD/MoM/target GMV sums `Invoice_Taxable_Amount` (ex-GST). The two columns differ by 18%, so FYTD is not comparable to the sum of its months. | `OMP-Sellers!L` uses `$AA:$AA`; `OMP-Sellers!Y:AB, AL` use `$Y:$Y` | Engine computes **both** `gmvTaxable` and `gmvTotal` per shipment. A single config key `GMV_BASIS` (default `TAXABLE`) selects the reporting basis for **all** windows, so FYTD and MTD are always comparable. Both remain available for drill-down. |
| 2 | **`Rate per KG (Achieved)` divides an ex-GST amount by 1.18.** Yields ₹42.57/kg where the invoice is ₹50/kg — a 15% understatement, and not comparable to `Rate per KG (Target)` which is quoted ex-GST. | `OMP-Sellers!AK = ((AL×10^7)/(1+18%))/(AJ×1000)` while `AL` sums taxable | Engine computes `ratePerKg = gmv_taxable / (tonnage_MT × 1000)`. The GST divisor is retained as config `RATE_GST_DIVISOR` (default `1`) so the legacy number can be reproduced if finance requires it. |
| 3 | **YTD onboarding uses the calendar year; YTD transactions use the fiscal year.** A seller onboarded in Feb 2026 counts in "YTD onboarded" for FY26-27 reporting. | `POC-Wise!E` → `DATE(YEAR(TODAY()),1,1)`; `OMP-Sellers!J` → April-based | Engine standardises on **fiscal year (Apr–Mar)** everywhere; `FY_START_MONTH` is config. Calendar-YTD remains selectable as a window. |
| 4 | **Month-on-month columns are hard-coded dates.** `DATE(2026,5,1)`, `DATE(2026,6,1)`… must be edited by hand every month; May's column starts at `DATE(2026,5,18)` in POC-Wise (a partial month) but `DATE(2026,5,1)` in OMP-Sellers. | `POC-Wise!H` vs `OMP-Sellers!M` | Windows are computed from the cycle, never hard-coded. The May discrepancy is dropped — it was a data-availability artefact, and the engine records `dataAvailableFrom` in config instead. |
| 5 | **`Total Weightage` is not validated.** Nothing stops a KRA set summing to ≠ 100, which silently breaks `Overall = Score/100`. | `BDM Summary!L = MIN(K/100, 1.05)` hard-codes the 100 | Publishing a cycle **blocks** unless each stream's weightages sum to exactly 100. Overall achievement divides by the *actual* total weightage, so the maths holds even if the rule is later relaxed. |
| 6 | **`Weekly Plan vs Achievement` achievement is typed manually** and is entirely derivable from `Overall Shipments`. The sheet is hidden and stale (all achievements 0). | sheet state = hidden; `F` column constants | Weekly achievement is **computed**. Only the daily target is entered. |
| 7 | **Ten identical scorecard sheets.** Any change to the model requires ten edits. | sheets 16–25 | One generated view, one calculation path. |
| 8 | **`RANK` gives ties the same rank and skips the next** (two POCs at rank 9, no rank 10). | `BDM Summary!M` | Preserved — competition ranking is the intended semantic. |
| 9 | **`Not Mapped` region / `Not Mapped` RH appear in source data**; several sellers have no POC (`POC` blank on 5 of 185 rows). | `Seller Onboarding!C,D,AY` | Engine buckets these into an explicit `UNASSIGNED` dimension and the Data Quality panel surfaces them as an action item rather than dropping them silently. |
| 10 | **Document checklist encoded as `⬜`/`✅` glyphs** with a derived `Overall Status` that is itself typed. | `Aug Buyer Plan!M:R` | Real boolean document slots with evidence links; `Overall Status` derived. |
| 11 | **`Reject_Reason` contains `"Approved"`, `"approved "`, `"Approved\n"`** — a rejection field carrying approval text with inconsistent whitespace/case. | `Seller Onboarding!U` | Normalised on import (trim + case-fold); mapped to a decision enum. |
| 12 | **Pulse target `25*3` is hard-coded** in each POC block; the actual month has a different working-day count, and leave days are tracked but not deducted. | `WhatsApp!C38 = 25*3` | `workingDays` is a cycle attribute; pulse target = `(workingDays − leaveDays) × visitsPerDay`, all three configurable. Legacy behaviour reproducible by setting `PULSE_DEDUCT_LEAVE = false`. |
| 13 | **The headline totals on `OMP-Sellers` are filter-sensitive and currently wrong.** Row 3 uses `SUBTOTAL(9, …)`, which silently excludes rows hidden by whatever filter a user last left applied. The same measures therefore disagree across sheets by up to 60%. | LMTD GMV reads **0.919212 Cr** on `OMP-Sellers!AO3` but **1.1531985 Cr** on `WhatsApp!H13` and `Region-Wise!AV3`. The August plan reads **43 txn / 465 MT / 2.296 Cr** on `OMP-Sellers!AE3:AH3` but **102 / 1120 / 5.709** on `WhatsApp!C11:C13`. | The engine has no notion of a view filter — a total is always the total of the rows in scope. Filtering in the UI narrows the *scope*, and the scope is stated on screen, so a filtered number is never mistaken for a complete one. The unfiltered figures are the ones reproduced. |
| 14 | **34 of 151 shipment rows carry no `Shipment_ID`** — orders raised but not yet shipped. Any import keyed solely on that column drops them, losing the pipeline they represent. | `Overall Shipments!AE` blank where `Order_Status = ISSUED` and no dispatch has occurred | The sync falls back to `Sales_Order_ID` + `Requisition_ID` + `Listing_ID` to build a stable key, and flags the row with `hasShipmentId = false`. The rows are stored and visible but still excluded from transaction counts, because their status is blank. |

Items 1, 2, 3, 12 and 13 change reported numbers. Items 1, 2, 3 and 12 are implemented
as **config-gated corrections** — the legacy behaviour is one settings change away —
and the `Data Quality` panel reports which basis is active on every affected dashboard.
Item 13 has no legacy mode: reproducing it would mean reproducing a filter that nobody
recorded.

### 8.1 Verification

`tests/engine.test.js` runs the application's real server code against the raw
`Overall Shipments` and `Seller Onboarding` rows exported from this workbook and asserts
that the engine reproduces the workbook's own computed values — 121 assertions covering
the window algebra, the scoring formulas, regional and per-POC attribution, onboarding
counts, the transaction-validity rule, plan-target derivation and traceability.

Where two sheets disagreed, the test follows the figure that two independent formulas
agree on. For the LMTD block and the plan totals that is `WhatsApp Summary` and
`Region-Wise` — both computed without a filter — against the single filter-sensitive
`SUBTOTAL` on `OMP-Sellers`.

---

## 9. People, dimensions and vocabulary observed

**Regions**: `North` (RH — Parth Gautam), `South` (RH — Uday Kiran Kumar Thota),
plus `Not Mapped`. `Aug Buyer Plan` additionally uses `North East` and `West` for
buyer geography.

**POCs (10 scored)**: Ashish Kumar Rai, Asraful Hasan, Brajendra Upadhyay,
Joydeep Das, Parth Gautam *(North RH, also carries a POC book)*,
Atharva Sudhir Patil, Praveen Raj P, Raju B, Rustumpet Ashwin Kumar,
Uday Kiran Kumar Thota *(South RH, also carries a POC book)*.
**Also in Pulse, unscored**: Panchal Rishi, Neelesh Dixit.

**Material types**: `PET`, `Flakes`, `Others (Granules/Fibre)`.
**Seller types**: `Baler`, `Trader`, `Baler Cum Trader`, `Manufacturer`.
**Payment terms**: `POD`, `D+3`, `D+5`, `D+10`, `D+15`, `NBFC`, `Spot Payment`,
`Under Negotiation`.
**Shipment status**: `DRAFT`, `DISPATCHED`, `REACHED`, `RECEIVED_BY_RECYCLER`,
`COMPLETED`, `CANCELLED`.
**Order status**: `ISSUED`, `IN_PROGRESS`, `REJECTED`.
**Onboarding status**: `DRAFT`, `IN_REVIEW`, `COMPLETED`, `REJECTED`.

---

## 10. Module mapping — workbook → product

| Workbook sheet | Product module | Input becomes |
|----------------|----------------|---------------|
| `OMP-Supply & Demand KRA & KPI` | **Planning → KRA/KPI Library & Cycle** | Team Lead, once per month |
| `OMP-Sellers` / `OMP-Buyers` (target cols only) | **Planning → Account Plan** | Team Lead / POC, once per month |
| `POC-Wise!D` (`Total Onboarding Sellers Plan`) | **Planning → Annual Onboarding Plan** | Team Lead, once per year |
| `Weekly Plan vs Achievement` (target only) | **Planning → Weekly Plan** | Team Lead, weekly |
| `Aug Buyer Plan` | **Pipeline → Buyer Onboarding** | POC, on change |
| `Sheet1`, `Sheet1 (1)` | **Pipeline → Prospects** | POC, on change |
| `Seller Onboarding` | **Activity → Onboarding** (synced) | system + POC remarks/evidence |
| `Overall Shipments` | **Activity → Transactions** (synced) | system |
| `MTD Pulse Summary` | **Activity → Field Visits** | POC, daily |
| `Onboarded Sellers VS Pulse` | *generated* — Coverage report | — |
| `POC-Wise` | *generated* — POC Performance | — |
| `Region-Wise` | *generated* — Region Performance | — |
| per-POC scorecards | *generated* — Scorecard | — |
| `BDM Summary` | *generated* — Leaderboard | — |
| `WhatsApp Summary` | *generated* — Daily Review / Exec Dashboard | — |

Sheets in the *generated* rows have **zero human input** in the product. That is the
"Calculate Everything" principle made concrete: of the 25 sheets, 15 become
read-only outputs of the engine.
