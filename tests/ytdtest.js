/* Exercises the REAL buildModel_ out of Code.gs, once per month and once for
   YTD, with only the sheet layer stubbed. Two things must hold:
     - the single-month path is byte-for-byte the behaviour it always had
     - YTD averages the monthly levels and excludes unmeasured months */
/* Resolved against this file, not the shell's working directory, so the
   suite runs the same from the repo root, from tests/, or from a CI step. */
var ROOT = require('path').join(__dirname, '..');
var fs = require('fs');
var src = fs.readFileSync(require('path').join(ROOT, 'Code.gs'), 'utf8').replace(/\r\n/g, '\n');
function grab(a, b) { var i = src.indexOf(a), j = src.indexOf(b, i); return src.slice(i, j); }

var T = { TEAMS: 'TEAMS', EMPLOYEES: 'EMPLOYEES', KRAS: 'KRAS', KPIS: 'KPIS',
  ASSIGN: 'ASSIGNMENTS', TARGETS: 'TARGETS', PERF: 'PERFORMANCE',
  PERIODS: 'PERIODS', USERS: 'USERS', AUDIT: 'AUDIT', SETTINGS: 'SETTINGS' };
var DB = {}, _DIRTY = {};
function read_(name) { return DB[name] || []; }
function ensureSeeded_() { return false; }
function nowIso_() { return '2026-09-09T00:00:00.000Z'; }
var SOURCE_SHEET_ID = 'source-workbook-id';

eval(grab('function num_(v)', 'function slug_'));
eval(grab('function idx_(a)', 'function num_'));
eval(grab('var EMPTY_BAND', 'var LEVEL_LABELS'));
/* narrow: grabbing as far as currentEmail_ swept up the real read_ and
   clobbered the stub above, which is how the sheet layer leaked back in */
eval(grab('/* YEAR TO DATE', 'var MONTH_NAMES_'));
/* End on a code boundary. Two ways this has bitten:
   - stopping inside the SERVING banner left an unterminated block comment;
   - stopping at the DIAGNOSTICS text did the same, because that text sits
     INSIDE a block comment. An unterminated comment is a SyntaxError, which
     looks nothing like the missing symbol you actually caused.
   The diagnostics block also builds DIAG_FUNCTIONS_ at load time from
   functions this suite does not grab, so it must be excluded either way. */
eval(grab('var MONTH_NAMES_', 'var DIAG_FUNCTIONS_'));
/* buildModel_ hides leavers; isLeaver_ canonicalises the name, and that in
   turn needs normName_ from the target-sheet block */
eval(grab('function normName_(v)', '/** Parse one target tab'));
eval(grab('var POC_ALIASES', 'function resolvePocEmployee_'));
eval(grab('function buildModel_(periodId)', '/* ------------------------------------------------------------ SCOPE FILTER'));
/* aggKind_ inside buildModel_ asks isRatioLadder_ how a value aggregates */
eval(grab('var RATING_SCALE', 'function ladderKey_'));

var pass = 0, fail = 0;
function ck(label, got, want) {
  var ok = String(got) === String(want); ok ? pass++ : fail++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + ': ' + got + (ok ? '' : '   (want ' + want + ')'));
}

/* Six months, the last one not yet open.
 *
 * That last month must be genuinely in the FUTURE, computed from today. It was
 * hardcoded as 2026-09, and on 12 September 2026 buildModel_'s status self-heal
 * correctly reopened it — so the span grew to six and four assertions here
 * failed. The code was right and the fixture had expired.
 *
 * A test whose meaning depends on the calendar not moving is a test with a
 * shelf life. */
function futureMonth_() {
  var d = new Date();
  d.setMonth(d.getMonth() + 2);
  return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2);
}
var MONTHS = ['2026-04', '2026-05', '2026-06', '2026-07', '2026-08', futureMonth_()];
DB[T.PERIODS] = MONTHS.map(function (m, i) {
  return { id: 'per_' + m, name: '', kind: 'month', sort: i,
           status: i < 4 ? 'locked' : (i === 4 ? 'open' : 'upcoming') };
});
DB[T.SETTINGS] = [{ key: 'current_period', value: 'per_2026-08' }];
DB[T.TEAMS] = [{ id: 't1', name: 'Collections' }];
DB[T.EMPLOYEES] = [{ id: 'E1', name: 'RAVI', team_id: 't1', status: 'lead' }];
DB[T.KRAS] = [{ id: 'k1', team_id: 't1', name: 'DSO', perspective: 'Customer' }];
DB[T.KPIS] = [{ id: 'p1', kra_id: 'k1', name: 'DSO Days' },
              { id: 'p2', kra_id: 'k1', name: 'Collection %' }];
DB[T.ASSIGN] = [{ id: 'a1', employee_id: 'E1', kra_id: 'k1', kpi_id: 'p1', weightage: 60, status: 'Active' },
                { id: 'a2', employee_id: 'E1', kra_id: 'k1', kpi_id: 'p2', weightage: 40, status: 'Active' }];
DB[T.AUDIT] = [];

/* the same DSO ladder every month: lower is better, 28/26.5/22.5/20/19 */
var LADDER = ['> 28 Days', '25–28 Days', '21–24 Days', 'TGT-20 Days', '≤ 19 Days'];
DB[T.TARGETS] = [];
MONTHS.forEach(function (m) {
  DB[T.TARGETS].push({ id: 'tg1_' + m, employee_id: 'E1', kpi_id: 'p1', period_id: 'per_' + m,
    t1: LADDER[0], t2: LADDER[1], t3: LADDER[2], t4: LADDER[3], t5: LADDER[4], version: 1 });
  DB[T.TARGETS].push({ id: 'tg2_' + m, employee_id: 'E1', kpi_id: 'p2', period_id: 'per_' + m,
    t1: '0.8', t2: '0.85', t3: '0.9', t4: '1.0', t5: '1.05', version: 1 });
});

/* DSO actuals: Apr 19 (T5), May 22 (T3), Jun 30 (below T1 = 0), Jul none, Aug 20 (T4).
   September is upcoming and must not be in the span at all. */
DB[T.PERF] = [
  { id: 'x1', employee_id: 'E1', kpi_id: 'p1', period_id: 'per_2026-04', actual: 19, manual_level: '', status: 'recorded' },
  { id: 'x2', employee_id: 'E1', kpi_id: 'p1', period_id: 'per_2026-05', actual: 22, manual_level: '', status: 'recorded' },
  { id: 'x3', employee_id: 'E1', kpi_id: 'p1', period_id: 'per_2026-06', actual: 30, manual_level: '', status: 'recorded' },
  { id: 'x5', employee_id: 'E1', kpi_id: 'p1', period_id: 'per_2026-08', actual: 20, manual_level: '', status: 'recorded' },
  /* p2 measured in one month only, so its YTD mean rests on a single month */
  { id: 'y1', employee_id: 'E1', kpi_id: 'p2', period_id: 'per_2026-08', actual: 0.92, manual_level: '', status: 'recorded' }
];

function rowOf(m, kpi) {
  return m.rows.filter(function (r) { return r.kpi_id === kpi; })[0];
}

console.log('--- single month: unchanged behaviour ---');
var aug = buildModel_('per_2026-08');
ck('period_id',            aug.period_id, 'per_2026-08');
ck('ytd flag',             aug.ytd, false);
ck('rows',                 aug.rows.length, 2);
ck('DSO level (actual 20 -> T4)', rowOf(aug, 'p1').level, 4);
ck('DSO actual is shown',  rowOf(aug, 'p1').actual, 20);
ck('months_total is null', String(rowOf(aug, 'p1').months_total), 'null');
ck('bands preserved',      rowOf(aug, 'p1').bands[3], 'TGT-20 Days');
ck('overall score',        aug.overalls.E1.score, 3.6);   /* (4*60 + 3*40)/100 */

var jun = buildModel_('per_2026-06');
ck('June DSO (actual 30 -> below T1)', rowOf(jun, 'p1').level, 0);
var jul = buildModel_('per_2026-07');
ck('July DSO not scored', String(rowOf(jul, 'p1').level), 'null');

console.log('\n--- YTD: mean of the monthly levels ---');
var y = buildModel_('ytd');
ck('period_id',        y.period_id, 'ytd');
ck('ytd flag',         y.ytd, true);
ck('span excludes the upcoming month', y.ytd_periods.length, 5);
ck('span is Apr..Aug', y.ytd_periods.join(','),
  'per_2026-04,per_2026-05,per_2026-06,per_2026-07,per_2026-08');
/* levels were 5, 3, 0, (none), 4  ->  mean of the four measured = 3 */
ck('DSO months_scored', rowOf(y, 'p1').months_scored, 4);
ck('DSO months_total',  rowOf(y, 'p1').months_total, 5);
ck('DSO YTD level = mean(5,3,0,4) = 3', rowOf(y, 'p1').level, 3);
/* The YTD actual used to be null, on the grounds that no single number sits
   behind a mean of levels. The KRA owner asked for the year's achieved value,
   so it is now aggregated — and DSO is a DURATION, so it AVERAGES. Summing it
   would report a five-month DSO of 91 days against a 20-day target. */
ck('DSO YTD actual is the MEAN of the recorded months',
   rowOf(y, 'p1').actual, 22.75);
ck('  which is mean(24,22,25,20), not their sum of 91',
   rowOf(y, 'p1').actual === 91, false);
ck('  and it says how it aggregated', rowOf(y, 'p1').agg_kind, 'mean');
ck('  over 4 recorded months', rowOf(y, 'p1').actual_months, 4);
ck('  with no year target to divide by, the level stays the mean of levels',
   rowOf(y, 'p1').ytd_basis, 'mean_of_monthly_levels');
ck('ladder still shown',  rowOf(y, 'p1').bands[4], '≤ 19 Days');
/* p2: 0.92 clears 0.8/0.85/0.9 consecutively -> T3, in one month of five */
ck('p2 months_scored',    rowOf(y, 'p2').months_scored, 1);
ck('p2 YTD level',        rowOf(y, 'p2').level, 3);
ck('overall YTD score',   y.overalls.E1.score, 3);        /* (3*60 + 3*40)/100 */

console.log('\n--- an unmeasured month must not count as zero ---');
/* if July counted as 0 the mean would be mean(5,3,0,0,4)=2.4, not 3 */
ck('mean ignores July', rowOf(y, 'p1').level, 3);
ck('and says so via the month count', rowOf(y, 'p1').months_scored + '/' +
  rowOf(y, 'p1').months_total, '4/5');

console.log('\n--- a fractional mean survives ---');
/* 26 days clears T1 (<= 28) AND T2 (<= 26.5, the midpoint of "25–28 Days"),
   but not T3 (<= 22.5) — so it is Target 2, not Target 1 */
DB[T.PERF].push({ id: 'x4', employee_id: 'E1', kpi_id: 'p1', period_id: 'per_2026-07',
  actual: 26, manual_level: '', status: 'recorded' });
var y2 = buildModel_('ytd');
ck('mean(5,3,0,2,4) = 2.8', rowOf(y2, 'p1').level, 2.8);
ck('months_scored now 5',   rowOf(y2, 'p1').months_scored, 5);

console.log('\n--- A TARGET AGGREGATES THE WAY ITS ACHIEVEMENT DOES ---');
/* Found when Plastic DSO landed on real scorecards. The rating was right —
   absolute ladders rate on the mean of monthly levels — but plan_target SUMMED
   across the months, so a 5-day DSO target read as 20 over four months and an
   achieved 18.7 scored 107%. A pass and a fail on the same row, from the same
   numbers, with the target growing one month at a time until anybody cleared
   it. Counts still accumulate; durations and rates must not. */
T.PLAN = 'PLAN';
DB[T.PLAN] = [];
['2026-04', '2026-05', '2026-06', '2026-07', '2026-08'].forEach(function (m) {
  /* DSO: 5 days every month, and 'days' is what aggKind_ reads first */
  DB[T.PLAN].push({ id: 'pl1_' + m, employee_id: 'E1', kpi_id: 'p1',
    period_id: 'per_' + m, target_value: 5, unit: 'days', source: 'derived' });
  /* a count, to prove the summing path is untouched */
  DB[T.PLAN].push({ id: 'pl2_' + m, employee_id: 'E1', kpi_id: 'p2',
    period_id: 'per_' + m, target_value: 10, unit: 'count', source: 'target_sheet' });
});

var yP = buildModel_('ytd');
var dsoRow = rowOf(yP, 'p1'), cntRow = rowOf(yP, 'p2');
ck('the DSO target is still 5 days across five months', dsoRow.plan_target, 5);
ck('  NOT 25, which is what summing gave', dsoRow.plan_target === 25, false);
ck('  and the row says it averaged', dsoRow.plan_agg, 'mean');
ck('  the achievement averaged too, so the two sides match',
   dsoRow.agg_kind, 'mean');
ck('a COUNT target still accumulates', cntRow.plan_target, 50);
ck('  and says so', cntRow.plan_agg, 'sum');

console.log('  a single month is unchanged, which is the thing most easily broken:');
var mP = buildModel_('per_2026-08');
ck('  one month of DSO is 5', rowOf(mP, 'p1').plan_target, 5);
ck('  one month of the count is 10', rowOf(mP, 'p2').plan_target, 10);

console.log('  and the rating never depended on the summed target:');
ck('  DSO still rates on the mean of monthly levels',
   dsoRow.ytd_basis, 'mean_of_monthly_levels');
/* the bug in miniature: achieved 18.7 against a target that should be 5 */
ck('  achieved over target can no longer read as a pass',
   5 / 18.7 > 1, false);
ck('    whereas the summed target would have', 25 / 18.7 > 1, true);

console.log('\n--- writes must refuse the YTD pseudo-period ---');
var threw = '';
try { requireRealPeriod_('ytd'); } catch (e) { threw = e.message; }
ck('requireRealPeriod_("ytd") throws', /read-only rollup/.test(threw), true);
ck('a real month passes through', requireRealPeriod_('per_2026-08'), 'per_2026-08');

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
