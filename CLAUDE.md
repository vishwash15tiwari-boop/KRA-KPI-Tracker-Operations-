# PerformOS — Individual KRA / KPI Performance

A Google Apps Script web app that holds the **individual** KRA/KPI structure for the
five Recykal teams and scores each person against their own Target 1–5 ladders.

## Deploy

Two files, no build step, no dependencies.

1. Apps Script project → paste `Code.gs` and create an HTML file named **`Index`** with `Index.html`.
2. Deploy → New deployment → Web app → execute as *me*, access as needed.
3. Open the URL. The first load seeds itself; nothing to run by hand.

Do not rename `Index` — `doGet()` loads it by that exact name.

## Source workbook

Structure comes from sheet `1c0_pP4Mmye5s5D_vzoxrvJ-utkLb6JhD69TvvOBbjoo`, tabs
`Metal (Individual)`, `Plastics (Individual)`, `Onboarding (Individual)`,
`Collections (Individual)`, `Open Marketplace - Control Tower (Individual)`.

Imported: **5 teams, 38 people, 90 KRAs, 91 KPIs, 208 individual KPI assignments.**
Every person's per-KPI weightage totals exactly 100.

Re-import from Administration. Identity is derived from names via a deterministic
hash, so importing twice **updates** rather than duplicating. The sheet must be
shared with the account the web app runs as.

## The parts that are easy to get wrong

**Target bands are text, not numbers.** The workbook holds `> 28 Days`, `≥ ₹9 Cr`,
`TGT-20 Days`, `10% of LD`, `100% Cumulative of Team Target`. They are stored and
displayed exactly as written, because that is what people recognise. A separate
reader derives the numeric value for scoring:

- `TGT-20 Days` → **20**, not −20 (a letter followed by `-` is a separator, not a minus)
- `25–28 Days` → **26.5** (a range collapses to its midpoint; en-dash and hyphen both)
- `≥ ₹9 Cr` → **9** (currency symbols and separators dropped)

**Direction is detected, never assumed.** A ladder that descends is
`lower_is_better`; one that ascends is `higher_is_better`. `DSO Days` runs
`> 28 → ≤ 19` and scores lower-is-better; `Collection % vs Target` runs
`0.8 → 1.05` and scores higher-is-better. Nothing is hard-coded per KPI.

**Three ladder kinds.** `numeric` scores from an actual. `ordinal` (`T+7`,
`On Time`, `T-1`) and `qualitative` (one band, or no parseable value) carry no
measurable scale, so a reviewer **awards** Target 1–5 and no actual is accepted.
The ordinal test must run *before* the "nothing numeric" test or an ordinal
ladder is mistaken for a qualitative one.

**A level is the highest band cleared counting consecutively from Target 1.** A gap
stops the count — clearing T1, T2 and T4 is Target 2, not Target 4.

**Rollup.** Weightage is per KPI and totals 100 per person, so the overall level is
one weighted mean over that person's *scored* KPIs. A KRA level is the same mean
renormalised within the KRA. Unscored KPIs leave the denominator rather than
counting as zero — `measured_weightage` says how much of the scorecard is real.

## Structure Review

Findings are **stated, not corrected**. These ladders decide people's ratings, so
the platform never silently rewrites one. It currently reports:

- **PDD ₹ Cr Recovered** (Ravi Naik, Ankur, Venkat) runs `≥ ₹9 Cr` at Target 1 down
  to `< ₹5 Cr` at Target 5, so recovering *less* scores higher — although the KPI
  reads as something to increase. **This needs a decision from the KRA owner.**
- Two KPIs have no measurable ladder and must be awarded by hand:
  `Reporting & Escalations` (Vishwash) and `Adherence to Reminder (Total)` (Sai Nitin).

## Permissions

Enforced server-side in every write API, not merely hidden in the UI. Verified:
an employee may record their own actual but not edit their own targets or the
framework; a team leader cannot touch another team; an auditor cannot write.

## Editing

Per person, from their scorecard: the five target bands (free text, rejected if the
ladder changes direction mid-way), the KRA and KPI themselves (perspective, name,
goal, source, weightage), add and remove KPIs, and the actual or awarded level.
Every change is versioned and written to the audit log with actor and reason.

## Testing

`selfTest()` in the Apps Script editor — 21 assertions over the band reader,
direction detection, level resolution, weight normalisation and the import.
There is no Node in the authoring environment; the browser harness that drives the
real `Code.gs` and `Index.html` over stubbed Apps Script services lives outside
this repo as scaffolding.

## Still open

- Recording sheets and further scoring logic are yet to be supplied.
- Membership was parsed from a 2026-08-20 export; confirm against the live sheet.
