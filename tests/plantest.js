/* Exercises the REAL buildModel_ carrying PLAN — the numeric target — through
   to a scorecard row, single month and YTD, with only the sheet layer stubbed.
   The 282 rows importTargets() wrote are worthless if the model drops them. */
/* Resolved against this file, not the shell's working directory, so the
   suite runs the same from the repo root, from tests/, or from a CI step. */
var ROOT = require('path').join(__dirname, '..');
var fs = require('fs');
var src = fs.readFileSync(require('path').join(ROOT, 'Code.gs'), 'utf8').replace(/\r\n/g, '\n');
function grab(a, b) {
  var i = src.indexOf(a); if (i < 0) throw new Error('missing anchor: ' + a);
  var j = src.indexOf(b, i); if (j < 0) throw new Error('missing anchor: ' + b);
  return src.slice(i, j);
}

var T = { TEAMS: 'TEAMS', EMPLOYEES: 'EMPLOYEES', KRAS: 'KRAS', KPIS: 'KPIS',
  ASSIGN: 'ASSIGNMENTS', TARGETS: 'TARGETS', PERF: 'PERFORMANCE',
  PERIODS: 'PERIODS', USERS: 'USERS', AUDIT: 'AUDIT', SETTINGS: 'SETTINGS',
  PLAN: 'PLAN' };
var DB = {}, _DIRTY = {};
function read_(name) { return DB[name] || []; }
function ensureSeeded_() { return false; }
function nowIso_() { return '2026-09-10T00:00:00.000Z'; }
var SOURCE_SHEET_ID = 'source-workbook-id';

eval(grab('function num_(v)', 'function slug_'));
eval(grab('function idx_(a)', 'function num_'));
eval(grab('var EMPTY_BAND', 'var LEVEL_LABELS'));
eval(grab('/* YEAR TO DATE', 'var MONTH_NAMES_'));
/* Stop before DIAG_FUNCTIONS_: it is built at load time from functions this
   suite does not grab. Anchor on the declaration, not on the banner text above
   it — that text is inside a block comment, and ending a grab there leaves the
   comment unterminated, which fails as a SyntaxError. */
eval(grab('var MONTH_NAMES_', 'var DIAG_FUNCTIONS_'));
/* buildModel_ hides leavers; isLeaver_ canonicalises the name, and that in
   turn needs normName_ from the target-sheet block */
eval(grab('function normName_(v)', '/** Parse one target tab'));
eval(grab('var POC_ALIASES', 'function resolvePocEmployee_'));
eval(grab('function buildModel_(periodId)', '/* ------------------------------------------------------------ SCOPE FILTER'));
/* buildModel_ asks isRatioLadder_ whether to score on actual/target */
eval(grab('var RATING_SCALE', 'function ladderKey_'));

var pass = 0, fail = 0;
function ck(label, got, want) {
  var ok = String(got) === String(want); ok ? pass++ : fail++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + ': ' + got + (ok ? '' : '   (want ' + want + ')'));
}

/* The last month must be genuinely in the FUTURE, computed from today, or
   buildModel_'s status self-heal reopens it once the calendar passes the
   hardcoded date and every span assertion below shifts by one. */
function futureMonth_() {
  var d = new Date();
  d.setMonth(d.getMonth() + 2);
  return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2);
}
var FUT = futureMonth_();
var MONTHS = ['2026-06', '2026-07', '2026-08', FUT];
DB[T.PERIODS] = MONTHS.map(function (m, i) {
  return { id: 'per_' + m, name: '', kind: 'month', sort: i,
           status: i < 2 ? 'locked' : (i === 2 ? 'open' : 'upcoming') };
});
DB[T.SETTINGS] = [{ key: 'current_period', value: 'per_2026-08' }];
DB[T.TEAMS] = [{ id: 't1', name: 'Plastic' }];
DB[T.EMPLOYEES] = [{ id: 'E1', name: 'ASHISH KUMAR RAI', team_id: 't1', status: 'member' }];
DB[T.KRAS] = [{ id: 'k1', team_id: 't1', name: 'New Seller Acquisition', perspective: 'Customer' },
              { id: 'k2', team_id: 't1', name: 'GMV', perspective: 'Sales' },
              { id: 'k3', team_id: 't1', name: 'Transaction Closure', perspective: 'Sales' }];
DB[T.KPIS] = [{ id: 'p1', kra_id: 'k1', name: 'Monthly Target Achievement (%)' },
              { id: 'p2', kra_id: 'k2', name: 'Monthly Target Achievement (%)' },
              { id: 'p3', kra_id: 'k3', name: 'Successfully Closed Transactions (Count)' }];
DB[T.ASSIGN] = [
  { id: 'a1', employee_id: 'E1', kra_id: 'k1', kpi_id: 'p1', weightage: 40, status: 'Active' },
  { id: 'a2', employee_id: 'E1', kra_id: 'k2', kpi_id: 'p2', weightage: 40, status: 'Active' },
  { id: 'a3', employee_id: 'E1', kra_id: 'k3', kpi_id: 'p3', weightage: 20, status: 'Active' }];
DB[T.AUDIT] = [];
DB[T.PERF] = [];

/* the ratio ladder that makes a numeric target necessary in the first place */
DB[T.TARGETS] = [];
MONTHS.forEach(function (m) {
  ['p1', 'p2', 'p3'].forEach(function (k) {
    DB[T.TARGETS].push({ id: 'tg_' + k + '_' + m, employee_id: 'E1', kpi_id: k,
      period_id: 'per_' + m, t1: '0.6', t2: '0.75', t3: '0.9', t4: '1.0', t5: '1.05', version: 1 });
  });
});

/* what importTargets() would have written: counts for p1, crores for p2,
   and NOTHING for p3 — Transaction Closure has no typed target */
var COUNTS = { '2026-06': 9, '2026-07': 6, '2026-08': 4 };
COUNTS[FUT] = 4;
var CR = { '2026-06': 0.35099785, '2026-07': 0.66, '2026-08': 0.6 };  /* no September */
DB[T.PLAN] = [];
MONTHS.forEach(function (m) {
  DB[T.PLAN].push({ id: 'pl_E1_p1_per_' + m, employee_id: 'E1', kpi_id: 'p1',
    period_id: 'per_' + m, target_value: COUNTS[m], unit: 'count',
    source: 'target_sheet', rule: 'typed in the Target Sheet, tab Plastics row 6' });
  if (CR[m] !== undefined) {
    DB[T.PLAN].push({ id: 'pl_E1_p2_per_' + m, employee_id: 'E1', kpi_id: 'p2',
      period_id: 'per_' + m, target_value: CR[m], unit: 'Cr',
      source: 'target_sheet', rule: 'typed in the Target Sheet, tab Plastics row 7' });
  }
});

function rowsOf(periodId) {
  var m = buildModel_(periodId), o = {};
  m.rows.forEach(function (r) { o[r.kpi_id] = r; });
  return o;
}

console.log('--- one month: the target reaches the scorecard row ---');
var r = rowsOf('per_2026-07');
ck('seller count target', r.p1.plan_target, 6);
ck('  unit', r.p1.plan_unit, 'count');
ck('  source', r.p1.plan_source, 'target_sheet');
ck('  rule survives, so a person can see WHY',
   /tab Plastics row 6/.test(r.p1.plan_rule), true);
ck('GMV target in crores', r.p2.plan_target, 0.66);
ck('  unit', r.p2.plan_unit, 'Cr');
ck('a KPI with no typed target stays null, not 0',
   String(r.p3.plan_target), 'null');
/* It used to carry no unit, and that was the display bug. With no PLAN row in
   ANY month and a ratio ladder, buildModel_ reads the stored actual STRAIGHT
   against the bands — targetless is false, so it is scored as a rate. The row
   is therefore marked 'ratio' and rendered as a percentage, because plan_unit
   was empty and fmtTarget fell to its count branch: 0.87 came out as "1" and
   0.33 as "0". Every OMP and Collections figure on the dashboard was one of
   those two.
   p3 is the awkward case on purpose — a KPI named (Count) with a ratio ladder
   and no target anywhere. The engine already scores it as a rate, so the
   display now agrees with the scoring rather than quietly disagreeing. If that
   combination is itself wrong, it is wrong in buildModel_ and this makes it
   visible (500%) instead of hiding it (5). */
ck('  and is marked as a rate, because that is how it is SCORED',
   r.p3.plan_unit, 'ratio');
ck('plan_months is null outside YTD', String(r.p1.plan_months), 'null');

console.log('\n--- the bands are untouched: a target is not a band ---');
ck('ladder still the ratio ladder', r.p1.bands.join('/'), '0.6/0.75/0.9/1.0/1.05');
ck('  still read as numeric', r.p1.kind, 'numeric');
ck('  target did NOT leak into t1', r.p1.bands[0], '0.6');

console.log('\n--- a different month gives a different target ---');
var r6 = rowsOf('per_2026-06');
ck('June count', r6.p1.plan_target, 9);
ck('June GMV keeps full precision', r6.p2.plan_target, 0.35099785);
var r9 = rowsOf('per_' + FUT);
ck('September count', r9.p1.plan_target, 4);
ck('September GMV was never typed', String(r9.p2.plan_target), 'null');

console.log('\n--- YTD: a monthly target SUMS across the span, it does not average ---');
/* the span is every month not 'upcoming' — June, July, August */
var y = rowsOf('ytd');
ck('9 + 6 + 4 seller targets', y.p1.plan_target, 19);
ck('  built from 3 months', y.p1.plan_months, 3);
ck('  span is 3 months', y.p1.months_total, 3);
ck('  so it is a COMPLETE ytd target', y.p1.plan_months === y.p1.months_total, true);
ck('GMV sums too', y.p2.plan_target, 1.61099785);
ck('  and the float sum did not go ragged',
   /^1\.61[0-9]*$/.test(String(y.p2.plan_target)) && String(y.p2.plan_target).length <= 12, true);
ck('  also 3 months (Sept is upcoming, outside the span)', y.p2.plan_months, 3);
ck('no typed target stays null under YTD too', String(y.p3.plan_target), 'null');

console.log('\n--- a PARTIAL ytd target must be visibly partial ---');
/* drop July, so the sum covers 2 of the span's 3 months */
DB[T.PLAN] = DB[T.PLAN].filter(function (p) {
  return !(p.kpi_id === 'p1' && p.period_id === 'per_2026-07');
});
var y2 = rowsOf('ytd');
ck('sum is 9 + 4', y2.p1.plan_target, 13);
ck('  and it says so: 2 of 3', y2.p1.plan_months + ' of ' + y2.p1.months_total, '2 of 3');
ck('  which the UI can tell from a full one',
   y2.p1.plan_months < y2.p1.months_total, true);

console.log('\n--- a zero target is a target; a missing one is not ---');
DB[T.PLAN].push({ id: 'pl_E1_p3_per_2026-07', employee_id: 'E1', kpi_id: 'p3',
  period_id: 'per_2026-07', target_value: 0, unit: 'count', source: 'target_sheet', rule: 'x' });
var r7 = rowsOf('per_2026-07');
ck('0 survives as 0, not null', r7.p3.plan_target, 0);
ck('  and is not confused with absent', r7.p3.plan_target === null, false);

console.log('\n--- rows are still whole: nothing else was disturbed ---');
ck('three scorecard rows', Object.keys(rowsOf('per_2026-08')).length, 3);
ck('weightage intact', rowsOf('per_2026-08').p1.weightage, 40);

console.log('\n--- a RATIO ladder must be scored on actual / target ---');
/* This is the whole point of separating PLAN from TARGETS. The ladder reads
   0.8 | 0.9 | 1.0 | 1.1 | 1.2 — percentages of target — so comparing a GMV of
   7.19 CRORE against 1.2 would rate every GMV KPI a 5 whatever the target. */
/* Earlier sections deleted July's p1 plan and gave p3 a zero target, so this
   section rebuilds PLAN and PERF from scratch rather than inheriting that —
   the first run failed four assertions purely on leftover state. */
DB[T.TARGETS] = [];
MONTHS.forEach(function (m) {
  ['p1', 'p2', 'p3'].forEach(function (k) {
    DB[T.TARGETS].push({ id: 'tg_' + k + '_' + m, employee_id: 'E1', kpi_id: k,
      period_id: 'per_' + m, t1: '0.8', t2: '0.9', t3: '1.0', t4: '1.1', t5: '1.2', version: 1 });
  });
});
DB[T.PERF] = [];
DB[T.PLAN] = [];
MONTHS.forEach(function (m) {
  DB[T.PLAN].push({ id: 'pl_E1_p1_per_' + m, employee_id: 'E1', kpi_id: 'p1',
    period_id: 'per_' + m, target_value: COUNTS[m], unit: 'count',
    source: 'target_sheet', rule: 'x' });
  if (CR[m] !== undefined) {
    DB[T.PLAN].push({ id: 'pl_E1_p2_per_' + m, employee_id: 'E1', kpi_id: 'p2',
      period_id: 'per_' + m, target_value: CR[m], unit: 'Cr',
      source: 'target_sheet', rule: 'x' });
  }
  /* p3 deliberately has NO target, for the no-ratio case below */
});
/* p2 is GMV: target 0.66 Cr in July (from CR above), achieve 0.726 = 110% */
function setActual(kpi, m, v) {
  DB[T.PERF] = DB[T.PERF].filter(function (p) {
    return !(p.kpi_id === kpi && p.period_id === 'per_' + m); });
  DB[T.PERF].push({ id: 'prf_E1_' + kpi + '_per_' + m, employee_id: 'E1', kpi_id: kpi,
    period_id: 'per_' + m, actual: v, manual_level: '', level: '' });
}
setActual('p2', '2026-07', 0.726);          /* 0.726 / 0.66 = 1.10 exactly */
var rr = rowsOf('per_2026-07');
ck('the raw actual is what is stored and shown', rr.p2.actual, 0.726);
ck('  the target is still the target', rr.p2.plan_target, 0.66);
ck('  the ratio is exposed for the UI', rr.p2.ratio, 1.1);
ck('  and 110% of target rates 4', rr.p2.level, 4);
ck('  NOT 5, which comparing 0.726 to the raw ladder would give',
   rr.p2.level === 5, false);

setActual('p2', '2026-07', 0.66);           /* exactly on target */
ck('on target rates 3', rowsOf('per_2026-07').p2.level, 3);
setActual('p2', '2026-07', 0.594);          /* 90% */
ck('90% rates 2', rowsOf('per_2026-07').p2.level, 2);
setActual('p2', '2026-07', 0.5);            /* 76% — below every threshold */
ck('below 80% rates 0', rowsOf('per_2026-07').p2.level, 0);

console.log('\n--- a seller COUNT ratio, where the digits look nothing alike ---');
setActual('p1', '2026-07', 6);              /* target 6 -> exactly on target */
var rc2 = rowsOf('per_2026-07');
ck('6 sellers against a target of 6', rc2.p1.actual, 6);
ck('  rates 3, not 5', rc2.p1.level, 3);
ck('  ratio recorded as 1', rc2.p1.ratio, 1);
setActual('p1', '2026-07', 7);              /* 116.7% */
ck('7 of 6 is 117% -> 4', rowsOf('per_2026-07').p1.level, 4);

console.log('\n--- no target means no ratio: the actual is compared directly ---');
/* p3 has no PLAN row in July */
setActual('p3', '2026-07', 1.05);
var rn = rowsOf('per_2026-07');
ck('no plan target', String(rn.p3.plan_target), 'null');
ck('  so no ratio', String(rn.p3.ratio), 'null');
ck('  and 1.05 is compared to the ladder as-is -> 3', rn.p3.level, 3);

console.log('\n--- an ABSOLUTE ladder is never divided ---');
/* DSO in days: 15 | 10 | 5 | 3 | 2, descending, WITH a target of 3 */
DB[T.KPIS].push({ id: 'p4', kra_id: 'k3', name: 'Days Sales Outstanding (DSO)' });
DB[T.ASSIGN].push({ id: 'a4', employee_id: 'E1', kra_id: 'k3', kpi_id: 'p4',
  weightage: 0, status: 'Active' });
DB[T.TARGETS].push({ id: 'tg_p4', employee_id: 'E1', kpi_id: 'p4', period_id: 'per_2026-07',
  t1: '15', t2: '10', t3: '5', t4: '3', t5: '2', version: 1 });
DB[T.PLAN].push({ id: 'pl_p4', employee_id: 'E1', kpi_id: 'p4', period_id: 'per_2026-07',
  target_value: 3, unit: 'days', source: 'target_sheet', rule: 'x' });
setActual('p4', '2026-07', 4);              /* 4 days */
var rd2 = rowsOf('per_2026-07');
ck('a target exists', rd2.p4.plan_target, 3);
ck('  but the ladder is absolute, so NO ratio', String(rd2.p4.ratio), 'null');
ck('  4 days clears 15, 10 and 5 -> 3', rd2.p4.level, 3);
ck('  and 4/3 = 1.33 was NOT what got scored', rd2.p4.level === 5, false);

console.log('\n--- a zero target must not divide by zero ---');
DB[T.PLAN].push({ id: 'pl_zero', employee_id: 'E1', kpi_id: 'p1',
  period_id: 'per_2026-06', target_value: 0, unit: 'count', source: 'target_sheet', rule: 'x' });
DB[T.PLAN] = DB[T.PLAN].filter(function (p) {
  return !(p.kpi_id === 'p1' && p.period_id === 'per_2026-06' && p.id !== 'pl_zero'); });
setActual('p1', '2026-06', 5);
var rz = rowsOf('per_2026-06');
ck('target is 0', rz.p1.plan_target, 0);
ck('  no Infinity ratio', String(rz.p1.ratio), 'null');
ck('  the level is finite', isFinite(Number(rz.p1.level)), true);

console.log('\n--- YTD: the year rated on the YEAR\'S own achieved vs target ---');
/* Targets 9 + 6 + 4 = 19 sellers across the span; achieve 4 + 6 + 9 = 19.
   That is exactly on target for the year -> 3, even though the individual
   months were 44%, 100% and 225% and their mean level would be different. */
DB[T.PERF] = [];
DB[T.PLAN] = [];
['2026-06', '2026-07', '2026-08'].forEach(function (m) {
  DB[T.PLAN].push({ id: 'pl_p1_' + m, employee_id: 'E1', kpi_id: 'p1',
    period_id: 'per_' + m, target_value: COUNTS[m], unit: 'count',
    source: 'target_sheet', rule: 'x' });
});
setActual('p1', '2026-06', 4);
setActual('p1', '2026-07', 6);
setActual('p1', '2026-08', 9);
var yy = rowsOf('ytd');
ck('year target is 9+6+4', yy.p1.plan_target, 19);
ck('year achieved is 4+6+9', yy.p1.actual, 19);
ck('  summed, because a seller count is a quantity', yy.p1.agg_kind, 'sum');
ck('  from 3 months', yy.p1.actual_months, 3);
ck('19 of 19 is on target -> 3', yy.p1.level, 3);
ck('  rated on the year, not on a mean of monthly levels',
   yy.p1.ytd_basis, 'year_ratio');
ck('  and the year ratio is exposed', yy.p1.ratio, 1);

console.log('  the mean of monthly levels would have been different:');
/* 4/9 = 44% -> 0, 6/6 = 100% -> 3, 9/4 = 225% -> 5.  mean = 2.67 */
ck('  mean would be 2.67, the year figure is 3', yy.p1.level === 2.67, false);

console.log('\n--- a year that misses is rated as missing ---');
setActual('p1', '2026-08', 4);           /* 4 + 6 + 4 = 14 of 19 = 74% */
var ym = rowsOf('ytd');
ck('year achieved 14', ym.p1.actual, 14);
ck('  74% is below every threshold -> 0', ym.p1.level, 0);
setActual('p1', '2026-08', 7);           /* 17 of 19 = 89.5% */
ck('89.5% -> 1', rowsOf('ytd').p1.level, 1);
setActual('p1', '2026-08', 11);          /* 21 of 19 = 110.5% */
ck('110.5% -> 4', rowsOf('ytd').p1.level, 4);

console.log('\n--- a partial year is still rated on what it has ---');
DB[T.PERF] = DB[T.PERF].filter(function (p) {
  return p.period_id !== 'per_2026-07'; });
var yp = rowsOf('ytd');
ck('achieved from 2 months', yp.p1.actual_months, 2);
ck('  target still spans 3', yp.p1.plan_months, 3);
ck('  so the mismatch is visible', yp.p1.actual_months < yp.p1.plan_months, true);

console.log('\n--- with a ratio ladder and NO target, the value IS the rate ---');
/* This is the discriminator, and it is deliberate. A ratio ladder with a
   target means the recorded value is a quantity the percentage is derived
   from, so it sums. The SAME ladder with no target — the 305 Collections rows,
   "Collection % vs Target" — means the recorded value is itself the percentage,
   so it averages. Without that distinction one of the two is always wrong. */
DB[T.PERF] = [];
DB[T.PLAN] = DB[T.PLAN].filter(function (p) { return p.kpi_id !== 'p2'; });
setActual('p2', '2026-06', 0.9);
setActual('p2', '2026-07', 0.8);
var yr = rowsOf('ytd');
ck('no year target', String(yr.p2.plan_target), 'null');
ck('  so 0.9 and 0.8 average to 0.85', yr.p2.actual, 0.85);
ck('  as a rate', yr.p2.agg_kind, 'mean');
ck('  not summed to 1.7, which would read as 170%', yr.p2.actual === 1.7, false);

console.log('\n--- an achievement with NO target for that month must NOT score ---');
/* The Target Sheet holds achievements in months nobody set a target for — 26
   achievements against 19 targets on New Buyer Acquisition. Compared raw
   against 0.8|0.9|1.0|1.1|1.2, "5 new buyers" clears every band and scored a
   PERFECT 5 for a month with no target at all. */
DB[T.PERF] = [];
DB[T.PLAN] = [
  /* p1 IS target-driven — but only in June */
  { id: 'pl_j', employee_id: 'E1', kpi_id: 'p1', period_id: 'per_2026-06',
    target_value: 9, unit: 'count', source: 'target_sheet', rule: 'x' }
];
setActual('p1', '2026-06', 9);
setActual('p1', '2026-07', 5);          /* achieved, but July has no target */
var jn = rowsOf('per_2026-06');
ck('June has a target and scores', jn.p1.level, 3);
var jl = rowsOf('per_2026-07');
ck('July has an actual', jl.p1.actual, 5);
ck('  but no target', String(jl.p1.plan_target), 'null');
ck('  so it is NOT scored', String(jl.p1.level), 'null');
ck('  and emphatically not a 5', jl.p1.level === 5, false);
ck('  the row says why', jl.p1.no_target_months, 1);

console.log('\n--- but a ladder that NEVER has targets still scores directly ---');
/* the Collections shape: 0.8|0.85|0.9|0.95|1 with the percentage recorded by
   hand and no target anywhere. p3 has no PLAN row in any month. */
DB[T.TARGETS] = DB[T.TARGETS].filter(function (t) { return t.kpi_id !== 'p3'; });
MONTHS.forEach(function (m) {
  DB[T.TARGETS].push({ id: 'tg_p3_' + m, employee_id: 'E1', kpi_id: 'p3',
    period_id: 'per_' + m, t1: '0.8', t2: '0.85', t3: '0.9', t4: '0.95', t5: '1.0', version: 1 });
});
setActual('p3', '2026-07', 0.92);
var cl = rowsOf('per_2026-07');
ck('no target for p3 in any month', String(cl.p3.plan_target), 'null');
ck('  the recorded 0.92 IS the ratio, so it scores', cl.p3.level, 3);
ck('  and it is not counted as a missing target', cl.p3.no_target_months, 0);

console.log('\n--- an ABSOLUTE ladder needs no target either ---');
DB[T.TARGETS] = DB[T.TARGETS].filter(function (t) { return t.kpi_id !== 'p3'; });
MONTHS.forEach(function (m) {
  DB[T.TARGETS].push({ id: 'tg_p3_' + m, employee_id: 'E1', kpi_id: 'p3',
    period_id: 'per_' + m, t1: '15', t2: '10', t3: '5', t4: '3', t5: '2', version: 1 });
});
setActual('p3', '2026-07', 4);
var ab = rowsOf('per_2026-07');
ck('4 days scores against the absolute ladder', ab.p3.level, 3);
ck('  not withheld for want of a target', ab.p3.no_target_months, 0);

console.log('\n--- a GMV year sums crore, and keeps its precision ---');
DB[T.PERF] = [];
['2026-06', '2026-07', '2026-08'].forEach(function (m) {
  if (CR[m] === undefined) return;
  DB[T.PLAN].push({ id: 'pl_p2_' + m, employee_id: 'E1', kpi_id: 'p2',
    period_id: 'per_' + m, target_value: CR[m], unit: 'Cr',
    source: 'target_sheet', rule: 'x' });
});
setActual('p2', '2026-06', 0.35099785);
setActual('p2', '2026-07', 0.66);
var yg = rowsOf('ytd');
ck('year target 0.35099785 + 0.66 + 0.6', yg.p2.plan_target, 1.61099785);
ck('year achieved sums to the same 8 decimals', yg.p2.actual, 1.01099785);
ck('  as a quantity', yg.p2.agg_kind, 'sum');
ck('  and it is 62.8% of the year target -> 0', yg.p2.level, 0);

console.log('\n--- a leaver is HIDDEN, and their history is not touched ---');
/* Deleting the person would orphan months of imported targets and achievements
   and falsify a period they actually worked. Hiding is reversible; deleting is
   not. */
DB[T.EMPLOYEES].push({ id: 'E9', name: 'ABHISEK SANYAL', team_id: 't1', status: 'member' });
DB[T.ASSIGN].push({ id: 'a9', employee_id: 'E9', kra_id: 'k1', kpi_id: 'p1',
  weightage: 100, status: 'Active' });
DB[T.PLAN].push({ id: 'pl_E9', employee_id: 'E9', kpi_id: 'p1',
  period_id: 'per_2026-07', target_value: 5, unit: 'count', source: 'target_sheet', rule: 'x' });
var lv = buildModel_('per_2026-07');
ck('the leaver is not in the roster',
   (lv.employees || []).filter(function (e) { return e.id === 'E9'; }).length, 0);
ck('  nor are their scorecard rows',
   (lv.rows || []).filter(function (r) { return r.employee_id === 'E9'; }).length, 0);
ck('  the people who remain are unaffected',
   (lv.employees || []).filter(function (e) { return e.id === 'E1'; }).length, 1);
/* the underlying tables keep everything */
ck('the EMPLOYEES row still exists',
   DB[T.EMPLOYEES].filter(function (e) { return e.id === 'E9'; }).length, 1);
ck('  the assignment too', DB[T.ASSIGN].filter(function (a) { return a.id === 'a9'; }).length, 1);
ck('  and the imported target', DB[T.PLAN].filter(function (p) { return p.id === 'pl_E9'; }).length, 1);

console.log('  a spelling variant of a leaver is still a leaver:');
ck('canonical', isLeaver_('ABHISEK SANYAL'), true);
ck('  the other spelling', isLeaver_('Abhishek Sanyal'), true);
ck('  lower case', isLeaver_('abhisek sanyal'), true);
ck('somebody still here is not', isLeaver_('ADARSH KRISHNA'), false);
ck('  nor is an unknown name', isLeaver_('Nobody At All'), false);
/* hasOwnProperty, or "constructor" would resolve off Object.prototype */
ck('  and neither is an inherited property name', isLeaver_('constructor'), false);

console.log('  removing the name would restore everything:');
var keep = EMPLOYEE_LEAVERS['ABHISEK SANYAL'];
delete EMPLOYEE_LEAVERS['ABHISEK SANYAL'];
var back = buildModel_('per_2026-07');
ck('the person returns',
   (back.employees || []).filter(function (e) { return e.id === 'E9'; }).length, 1);
ck('  with their row', (back.rows || []).filter(function (r) {
     return r.employee_id === 'E9'; }).length, 1);
ck('  and their target intact', (back.rows || []).filter(function (r) {
     return r.employee_id === 'E9'; })[0].plan_target, 5);
EMPLOYEE_LEAVERS['ABHISEK SANYAL'] = keep;

console.log('\n--- a weightage override survives a framework re-import ---');
/* Weightage comes from the KRA/KPI workbook and is rewritten by every import,
   so a correction made in the ASSIGNMENTS tab lasts until the next one. */
ck('the real entry is Tabesh', !!WEIGHTAGE_OVERRIDES['TABESH MOHAMMAD'], true);
ck('  DSO 15 -> 10', weightOverride_('Tabesh Mohammad', 'Working Capital Management'), 10);
ck('  Seller Monthly Transaction Rate 15 -> 10',
   weightOverride_('TABESH MOHAMMAD', 'Transaction from Existing Sellers'), 10);
ck('  Debit Note Rate 10 -> 5',
   weightOverride_('Tabesh Mohammad', 'Transaction Quality'), 5);
ck('a KRA of his with no override', String(weightOverride_('Tabesh Mohammad', 'Category GMV Growth')), 'null');
ck('somebody else is untouched',
   String(weightOverride_('Amit Jha', 'Working Capital Management')), 'null');
ck('  and an unknown person', String(weightOverride_('Nobody', 'Anything')), 'null');
/* hasOwnProperty, or 'constructor' would resolve off Object.prototype */
ck('an inherited property name is not an override',
   String(weightOverride_('Tabesh Mohammad', 'constructor')), 'null');

console.log('  and the three of them take him from 115% to exactly 100:');
var WSHOT = [['Category GMV Growth', 30], ['Working Capital Management', 15],
  ['Transaction from Existing Sellers', 15], ['Demand Activation', 10],
  ['New Demand Activation', 10], ['Supply Activation', 10],
  ['New Supply Activation', 10], ['Transaction Quality', 10],
  ['Category Growth & Balance', 5]];
ck('as imported', WSHOT.reduce(function (a, b) { return a + b[1]; }, 0), 115);
ck('with the overrides applied',
   WSHOT.reduce(function (a, b) {
     var o = weightOverride_('Tabesh Mohammad', b[0]);
     return a + (o === null ? b[1] : o); }, 0), 100);

console.log('  the override reaches the scorecard row, not just the table:');
DB[T.EMPLOYEES].push({ id: 'ET', name: 'TABESH MOHAMMAD', team_id: 't1', status: 'member' });
DB[T.KRAS].push({ id: 'kwc', team_id: 't1', name: 'Working Capital Management' });
DB[T.KPIS].push({ id: 'pwc', kra_id: 'kwc', name: 'Days Sales Outstanding (DSO)' });
DB[T.ASSIGN].push({ id: 'awc', employee_id: 'ET', kra_id: 'kwc', kpi_id: 'pwc',
  weightage: 15, status: 'Active' });
var tm = buildModel_('per_2026-07').rows.filter(function (r) {
  return r.employee_id === 'ET'; })[0];
ck('the row shows 10, not the imported 15', tm.weightage, 10);
ck('  and says the number was overridden', tm.weightage_source, 'override');
ck('the ASSIGNMENTS row is NOT rewritten, so the next import has nothing to fight',
   DB[T.ASSIGN].filter(function (a) { return a.id === 'awc'; })[0].weightage, 15);

console.log('\n--- the leaver cleanup: the only thing here that DELETES ---');
/* Abhisek's figures are merged into Adarsh, so his own PLAN and PERFORMANCE
   rows are duplicates. They are invisible, which is exactly why a stale one
   left behind resurfaces later looking authoritative. */
var commits2 = 0, audits2 = [];
function del_(name, id) {
  var rows = DB[name] || [];
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i].id) === String(id)) { rows.splice(i, 1); return true; }
  }
  return false;
}
function commit_() { commits2++; return 1; }
function audit_(a, t, i, act, o, nn, reason) { audits2.push(act + ' ' + reason); }
function currentEmail_() { return 'tester@recykal.com'; }
var Logger = { log: function () {} };
eval(grab('function leaverCleanup_(dryRun) {', '/** READ-ONLY, ZERO ARGUMENT'));

DB[T.PERF] = DB[T.PERF].concat([
  { id: 'prf_E9_a', employee_id: 'E9', kpi_id: 'p1', period_id: 'per_2026-06', actual: 4 },
  { id: 'prf_E9_b', employee_id: 'E9', kpi_id: 'p1', period_id: 'per_2026-07', actual: 6 }
]);
DB[T.PLAN].push({ id: 'pl_E9b', employee_id: 'E9', kpi_id: 'p1',
  period_id: 'per_2026-08', target_value: 2, unit: 'count' });
var beforePlan = DB[T.PLAN].length, beforePerf = DB[T.PERF].length;
var beforeEmp = DB[T.EMPLOYEES].length, beforeAsg = DB[T.ASSIGN].length;

var dry = previewLeaverCleanup();
ck('the dry run says so', /NOTHING WAS WRITTEN/.test(dry), true);
ck('  it names the leaver', /ABHISEK SANYAL/.test(dry), true);
ck('  and who the figures went to', /merged into ADARSH KRISHNA/.test(dry), true);
ck('  it lists 2 PLAN rows', /PLAN rows to delete: 2 rows/.test(dry), true);
ck('  and 2 PERFORMANCE rows', /PERFORMANCE rows to delete: 2 rows/.test(dry), true);
ck('  showing the values, so nothing is deleted unseen', /= 5|= 2|= 4|= 6/.test(dry), true);
ck('NOTHING was actually removed', DB[T.PLAN].length, beforePlan);
ck('  nor committed', commits2, 0);

var did = cleanupLeaverRows();
ck('both PLAN rows gone', beforePlan - DB[T.PLAN].length, 2);
ck('both PERFORMANCE rows gone', beforePerf - DB[T.PERF].length, 2);
ck('  and it says how many', /DELETED 2 PLAN and 2 PERFORMANCE/.test(did), true);
ck('committed once', commits2, 1);
ck('recorded in the audit log', /superseded rows for ABHISEK SANYAL/.test(audits2.join('|')), true);

console.log('  and it leaves alone everything it said it would:');
ck('the EMPLOYEES row survives', DB[T.EMPLOYEES].length, beforeEmp);
ck('  so an audit entry naming the id still resolves',
   DB[T.EMPLOYEES].filter(function (e) { return e.id === 'E9'; }).length, 1);
ck('the assignment survives', DB[T.ASSIGN].length, beforeAsg);
ck('nobody else lost a row',
   DB[T.PLAN].filter(function (p) { return p.employee_id === 'E1'; }).length > 0, true);

console.log('  running it again is harmless:');
var again2 = cleanupLeaverRows();
ck('nothing left to delete', /DELETED 0 PLAN and 0 PERFORMANCE/.test(again2), true);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
