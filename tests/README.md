# Tests

```bash
node tests/run-all.js
```

Exits non-zero if any assertion fails **or if a suite crashes without
reporting** — a suite that dies before printing its tally must not read as a
pass. Runs from any working directory. No dependencies; plain Node.

To run one suite:

```bash
node tests/plantest.js
```

## How they work

There is no build step and no import mechanism in Apps Script, so each suite
reads `Code.gs` (or `Index.html`) as text, cuts out the functions it needs with
a `grab(startAnchor, endAnchor)` helper, and `eval`s them.

**This means the suites exercise the shipped code, not a copy of it.** Change a
function in `Code.gs` and the tests see the change immediately. Only the sheet
layer is stubbed — `read_`, `SpreadsheetApp`, `Logger` — so everything above it
is real.

## Suites

| Suite | Assertions | Covers |
|---|---|---|
| `authtest` | 27 | identity resolution, roles, email normalisation |
| `scopetest` | 27 | `scopeModel_`, incl. the reassign-not-splice guard |
| `uattest` | 24 | open-access / UAT behaviour |
| `permtest` | 23 | permission matrix (reads `Index.html`) |
| `ytdtest` | 28 | YTD spans, level averaging |
| `derivedtest` | 29 | derived target rules, incl. per-team resolution |
| `targettest` | 46 | Target Sheet reader, both tab layouts |
| `importtest` | 56 | KRA label matching, KPI resolution, PLAN rows |
| `plantest` | 31 | PLAN → `buildModel_` → scorecard row |
| `joincheck` | 62 | POC map, shipment reader, the name join |
| `poctest` | 51 | POC aliases, shared accounts, the Raw_Sellers fallback |
| `reloadtest` | 34 | the month filter: out-of-order replies, caching |
| `scaletest` | 84 | the rating scale, and which ladders it refuses to touch |
| `shapetest` | 62 | contracts between helpers and views; achieved-% arithmetic |

**655 assertions, all green as of 12 September 2026.**

Counts drift as suites grow — `node tests/run-all.js` prints the current total.

## Why they are worth keeping

Several real bugs were caught by these and by nothing else — none were visible
on inspection or in the UI:

- a comma treated as a separator rather than a thousands mark, making
  `₹1,234.5 Cr` parse as `1` — a crore figure wrong by 1000×
- rounding `plan_target` at 4 decimals, turning a real GMV target of
  `0.35099785 Cr` into `0.351`
- a POC map keyed on account name alone, silently crediting **Metal** shipments
  to a **Plastic** POC when two accounts shared a name
- `email_()` losing the letter `s` from every address after a regex was
  mangled — caught only because the suite count dropped from 27 to 18
- a `#N/A` POC cell being split on its slash into two non-names, `#N` and `A`
- an exact 90% of target scoring **1 instead of 2**, because `5.85/6.5` is
  `0.8999999999999999` and therefore not `>= 0.9`
- the month filter showing one month's numbers under another month's heading
  when replies arrived out of order
- `applyRatingScale()` rewriting all 166 already-migrated rows on every run,
  because it compared ladders as text and Sheets returns the stored `'1.0'` as
  the number `1`
- averaging GMV across the year instead of summing it, because the aggregation
  rule keyed off the `%` in "Monthly Target Achievement (%)" — a name that
  reads as a percentage but records a crore figure

## Two cautions

**`scopetest` guards a data-loss bug, not a display bug.** `scopeModel_`
*reassigns* `m.employees` / `m.rows` / `m.teams` / `m.audit`; it must never
splice them in place, because those arrays *are* the `_CACHE` arrays and
splicing would delete rows from the spreadsheet on the next `commit_()`. If
that test fails, do not "fix" it by changing the test.

**Check the harness before assuming the app is wrong.** Two apparent failures
during development were test faults: a harness that set team leads but never
replicated `assignLeads_`'s `manager_id`, and a YTD expectation of 2.6 where
2.8 was correct (26 days clears both `≤ 28` and `≤ 26.5`).

## Fixtures

`targettest` and `joincheck` rebuild the real grids **cell for cell** from the
output of `peekTargets` / `describeTab_` against the live workbooks — the
two-tier headers, the blank spacer columns, the em dashes, the currency strings
and the differing column offsets between Metals and Plastics. That is what
makes them worth trusting; if the source layout changes, re-peek and update
the fixture rather than loosening an assertion.

## Note on `.claspignore`

`tests/**` is excluded so `clasp push` does not upload these Node files into
the Apps Script project. The pattern needs the `/**` suffix — a bare `tests/`
does **not** match, and pushed all eleven files as server-side script files.
`clasp status` shows what will and will not be pushed.
