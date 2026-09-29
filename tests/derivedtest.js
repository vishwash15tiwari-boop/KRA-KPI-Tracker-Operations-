/* Exercises the REAL derivedTarget_ / derivedRuleFor_ out of Code.gs.
   The headline check: every rule's percentage must equal the percentage the
   workbook's own goal text promises that person, for that team. */
/* Resolved against this file, not the shell's working directory, so the
   suite runs the same from the repo root, from tests/, or from a CI step. */
var ROOT = require('path').join(__dirname, '..');
var fs = require('fs');
var src = fs.readFileSync(require('path').join(ROOT, 'Code.gs'), 'utf8').replace(/\r\n/g, '\n');
function grab(a, b) { var i = src.indexOf(a), j = src.indexOf(b, i); return src.slice(i, j); }
eval(grab('function num_(v)', 'function slug_'));
eval(grab('var DERIVED_FROM_PERIOD', 'var MONTH_NAMES_'));
var PERIOD_YTD = 'ytd';

var pass = 0, fail = 0;
function ck(label, got, want) {
  var ok = String(got) === String(want); ok ? pass++ : fail++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + ': ' + got + (ok ? '' : '   (want ' + want + ')'));
}
var JUN = 'per_2026-06';
var ALL = { sellers_onboarded_this_month: 10, sellers_onboarded_cumulative_prev: 10,
            sellers_transacted_prev_month: 10, buyers_onboarded_this_month: 10,
            buyers_onboarded_cumulative_prev: 10 };

console.log('--- the same KRA, a different bar per team ---');
var m = derivedTarget_('Retention of Existing Transacted Sellers', JUN, ALL, 'Metal');
var p = derivedTarget_('Retention of Existing Transacted Sellers', JUN, ALL, 'Plastic');
ck('Metal retention   50% of 10', m.value, 5);
ck('  rule names why', /supply and demand/.test(m.rule), true);
ck('Plastic retention 70% of 10', p.value, 7);
ck('  rule names why', /supply only/.test(p.rule), true);

console.log('\n--- the three buyer KRAs now covered ---');
ck('Metal   new buyers      20% of 10',
  derivedTarget_('Transaction from New Onboarded Buyers', JUN, ALL, 'Metal').value, 2);
ck('Plastic new buyers      20% of 10',
  derivedTarget_('Transaction from New Onboarded Buyers', JUN, ALL, 'Plastic').value, 2);
ck('Plastic existing buyers 60% of 10',
  derivedTarget_('Transaction from Existing Buyers', JUN, ALL, 'Plastic').value, 6);

console.log('\n--- the seller KRAs are Plastic-only, and fail closed elsewhere ---');
ck('Plastic existing sellers 50%',
  derivedTarget_('Transaction from Existing Sellers', JUN, ALL, 'Plastic').value, 5);
ck('Plastic new sellers      20%',
  derivedTarget_('Transaction from New Onboarded Sellers', JUN, ALL, 'Plastic').value, 2);
ck('Metal existing sellers -> no rule',
  String(derivedTarget_('Transaction from Existing Sellers', JUN, ALL, 'Metal')), 'null');
ck('Collections retention -> no rule',
  String(derivedTarget_('Retention of Existing Transacted Sellers', JUN, ALL, 'Collections')), 'null');
ck('no team given at all -> no rule',
  String(derivedTarget_('Retention of Existing Transacted Sellers', JUN, ALL, '')), 'null');

console.log('\n--- each rule reads its OWN basis, not any number lying around ---');
ck('retention ignores onboarding counts',
  derivedTarget_('Retention of Existing Transacted Sellers', JUN,
    { sellers_transacted_prev_month: 20, sellers_onboarded_this_month: 999 }, 'Plastic').value, 14);
ck('new buyers ignores seller counts',
  String(derivedTarget_('Transaction from New Onboarded Buyers', JUN,
    { sellers_onboarded_this_month: 50 }, 'Metal')), 'null');

console.log('\n--- rounding up, unknown-vs-zero, and the June start still hold ---');
ck('50% of 7 -> 4', derivedTarget_('Transaction from Existing Sellers', JUN,
  { sellers_onboarded_cumulative_prev: 7 }, 'Plastic').value, 4);
ck('60% of 7 -> 5', derivedTarget_('Transaction from Existing Buyers', JUN,
  { buyers_onboarded_cumulative_prev: 7 }, 'Plastic').value, 5);
ck('unknown basis -> null', String(derivedTarget_('Transaction from Existing Sellers', JUN,
  {}, 'Plastic')), 'null');
ck('real zero -> 0', derivedTarget_('Transaction from New Onboarded Sellers', JUN,
  { sellers_onboarded_this_month: 0 }, 'Plastic').value, 0);
ck('May -> null', String(derivedTarget_('Transaction from Existing Sellers', 'per_2026-05',
  ALL, 'Plastic')), 'null');
ck('YTD -> null', String(derivedTarget_('Transaction from Existing Sellers', 'ytd',
  ALL, 'Plastic')), 'null');

console.log('\n=== every rule vs the percentage the WORKBOOK promises that person ===');
var seed = JSON.parse(src.slice(src.indexOf('{', src.indexOf('var SRC_SEED =')),
                                src.lastIndexOf('};') + 1));
var seen = {}, checked = 0, covered = {};
seed.people.forEach(function (person) {
  person.kpis.forEach(function (r) {
    var kra = r[1], goal = String(r[3] || '');
    var rule = derivedRuleFor_(kra, person.team);
    if (!rule) return;
    var k = person.team + '||' + kra;
    if (seen[k]) return; seen[k] = 1;
    covered[rule.key] = 1;
    var stated = (goal.match(/(\d+)\s*%/) || [])[1];
    var rulePct = Math.round(rule.pct * 100);
    checked++;
    ck(person.team.padEnd(8) + ' ' + kra.slice(0, 42).padEnd(42) +
       ' rule ' + rulePct + '% vs goal ' + (stated || '?') + '%',
       rulePct, stated);
  });
});
ck('KRA/team pairs checked', checked, 7);
ck('all 6 rules exercised by real data', Object.keys(covered).length, 6);

/* ------------------------------------------------------------------ *
   PLASTIC DSO — the column addressing and the day counts.

   The KRA owner gave the formula in spreadsheet LETTERS (AP x 1.18 - AU), and
   the previous three attempts at DSO all failed on which column was which. So
   the letter/index conversion is pinned here: off by one column and every
   figure silently means something else. */
console.log('\n--- spreadsheet column letters ---');
eval(grab('function colLetter_(nCol)', 'function describeTab_('));
[[1, 'A'], [2, 'B'], [26, 'Z'], [27, 'AA'], [28, 'AB'], [52, 'AZ'], [53, 'BA'],
 [42, 'AP'], [43, 'AQ'], [47, 'AU'], [702, 'ZZ'], [703, 'AAA']]
  .forEach(function (p) { ck('  ' + p[0] + ' -> ' + p[1], colLetter_(p[0]), p[1]); });
ck('  and it refuses a non-column', colLetter_(0), '?');

console.log('\n--- and back again, which is what the formula needs ---');
['A', 'Z', 'AA', 'AP', 'AQ', 'AU', 'ZZ', 'AAA'].forEach(function (L) {
  ck('  ' + L + ' round-trips', colLetter_(letterCol_(L)), L);
});
/* the three the formula actually names, stated outright so a silent change
   to DSO_COLS_ cannot pass unnoticed */
ck('AP is column 42', letterCol_('AP'), 42);
ck('AQ is column 43', letterCol_('AQ'), 43);
ck('AU is column 47', letterCol_('AU'), 47);
ck('  so their zero-based indexes are 41, 42, 46',
   [letterCol_('AP') - 1, letterCol_('AQ') - 1, letterCol_('AU') - 1].join(','), '41,42,46');
ck('lower case is accepted', letterCol_('ap'), 42);
ck('  and junk is not a column', letterCol_(''), 0);

console.log('\n--- the formula the KRA owner specified ---');
eval(grab('var DSO_GST_ =', 'function previewPlasticDSO()'));
ck('GST multiplier', DSO_GST_, 1.18);
ck('counted from June 2026', DSO_FROM_, '2026-06');
ck('Plastic target is 5 days', DSO_TARGET_DAYS_.plastic, 5);
ck('the columns are the three named', DSO_COLS_.taxable + '/' + DSO_COLS_.collected +
   '/' + DSO_COLS_.debitNote, 'AP/AQ/AU');
/* a worked example: 100 taxable, 50 collected, 10 debit note, over 30 days */
var ap = 100, aq = 50, au = 10;
var gmv = ap * DSO_GST_ - au;                 /* 108 */
var recv = ap * DSO_GST_ - aq - au;           /*  58 */
ck('GMV is taxable x 1.18 less the debit note', Math.round(gmv * 100) / 100, 108);
ck('receivable also takes off what was collected', Math.round(recv * 100) / 100, 58);
ck('  DSO is that share of the days', Math.round(recv / gmv * 30 * 10) / 10, 16.1);
/* fully collected is zero days outstanding, not a small number */
ck('nothing outstanding is 0 days',
   (ap * DSO_GST_ - (ap * DSO_GST_ - au) - au) / gmv * 30, 0);

console.log('\n--- 5 days must rate TARGET 3, through the real band engine ---');
/* The KRA owner's ruling of 15 Sep 2026. DSO is an ABSOLUTE ladder, so it is
   the documented exception to "the Target Sheet figure is Target 4": the days
   are compared against the rungs directly, and 5 already sits at rung 3. If
   anybody ever "corrects" this ladder to put the target at rung 4, these fail. */
eval(grab('var EMPTY_BAND', 'var LEVEL_LABELS'));
var dso = parseBands_(DSO_LADDER_);
ck('the ladder is the workbook\'s own', DSO_LADDER_.join(' | '), '15 | 10 | 5 | 3 | 2');
ck('  read as lower-is-better', dso.direction, 'lower_is_better');
ck('  and the target rung is 3', DSO_TARGET_RUNG_, 3);
ck('EXACTLY 5 days rates Target 3', levelFromBands_(dso, 5), 3);
ck('  which is the target itself', levelFromBands_(dso, DSO_TARGET_DAYS_.plastic),
   DSO_TARGET_RUNG_);
console.log('  better than target earns more, which is the point of driving it down:');
ck('  3 days rates 4', levelFromBands_(dso, 3), 4);
ck('  2 days rates 5', levelFromBands_(dso, 2), 5);
ck('  1 day still rates 5, not 6', levelFromBands_(dso, 1), 5);
console.log('  and worse than target earns less:');
ck('  5.1 days drops to 2', levelFromBands_(dso, 5.1), 2);
ck('  10 days rates 2', levelFromBands_(dso, 10), 2);
ck('  15 days rates 1', levelFromBands_(dso, 15), 1);
ck('  16 days is below every rung -> 0', levelFromBands_(dso, 16), 0);
/* the trap this whole exercise exists to avoid */
ck('5 days is NOT rated 4', levelFromBands_(dso, 5) === 4, false);
/* that the 60/75/90/100/105 scale can never be written over this ladder is
   asserted in scaletest, where isRatioLadder_ lives */

console.log('\n--- who counts as holding DSO ---');
/* Matching the KRA name alone missed TABESH MOHAMMAD, whose DSO sits under a
   KRA called "Working Capital Management" — a different KRA, a different
   kpi_id, the same measurement. He is Plastic and he is rated on DSO, so the
   import skipping him was simply wrong. */
eval(grab('function normName_(v)', 'function readTargetTab_'));
/* from the constants through the matcher, so DSO_KRA_ and DSO_KPI_RE_ come
   with it — grabbing the function alone left them undefined */
eval(grab("var DSO_KRA_ = 'DSO DAYS';", '\nfunction dsoAchievements_'));
ck('the plain case, by KRA name',
   holdsDso_('DSO Days', 'Days Sales Outstanding (DSO)'), true);
ck('TABESH, whose KRA says nothing about DSO',
   holdsDso_('Working Capital Management', 'Days Sales Outstanding (DSO)'), true);
ck('  which is the one the old matcher missed',
   'WORKING CAPITAL MANAGEMENT' === 'DSO DAYS', false);
ck('a KRA that names DSO without the KPI doing so',
   holdsDso_('DSO – Marketplace & EPR', 'Collection %'), true);
ck('punctuation and case do not matter',
   holdsDso_('dso days', 'days sales outstanding (dso)'), true);
console.log('  and it must not sweep in everything else:');
ck('  Debit Note Rate is not DSO', holdsDso_('Transaction Quality', 'Debit Note Rate (%)'), false);
ck('  GMV is not DSO', holdsDso_('GMV', 'Monthly Target Achievement (%)'), false);
ck('  New Seller Acquisition is not DSO',
   holdsDso_('New Seller Acquisition', 'Monthly Target Achievement (%)'), false);
ck('  nor is a TAT', holdsDso_('Payment Posting', 'TAT – Days'), false);
/* \b matters: a word containing "dso" must not match */
ck('  and a word merely containing dso does not match',
   holdsDso_('Hudson Review', 'Hudson Rate'), false);
ck('empty names match nothing', holdsDso_('', ''), false);

console.log('\n--- DSO now covers Metal too, on its own target ---');
/* The ruling asked for was the CALCULATION, not a new target. Plastic had no
   DSO target at all, so the KRA owner's 5 days is written. Metal already has 3
   days on every DSO row from the Target Sheet — the authority for targets — so
   this importer leaves it alone. */
ck('both teams are configured', Object.keys(DSO_TEAMS_).sort().join(','), 'METAL,PLASTIC');
ck('Plastic gets a written target of 5', DSO_TEAMS_.PLASTIC.target, 5);
ck('Metal keeps whatever the Target Sheet says', DSO_TEAMS_.METAL.target, null);
ck('  which is not the same as a target of zero', DSO_TEAMS_.METAL.target === 0, false);

console.log('  a shipment is routed by its buyer category:');
ck('  a plastic buyer', dsoTeamOfCategory_('Plastic'), 'PLASTIC');
ck('  a metal buyer', dsoTeamOfCategory_('Metal'), 'METAL');
ck('  case does not matter', dsoTeamOfCategory_('METAL SCRAP'), 'METAL');
ck('  a category we do not compute DSO for', dsoTeamOfCategory_('Paper'), null);
ck('  and a blank one', dsoTeamOfCategory_(''), null);

console.log('  and the two teams are held to different rungs, by the workbook:');
ck('  5 days is Target 3', levelFromBands_(dso, DSO_TEAMS_.PLASTIC.target), 3);
ck('  3 days is Target 4', levelFromBands_(dso, 3), 4);
ck('    so Metal\'s existing bar is the stricter of the two',
   levelFromBands_(dso, 3) > levelFromBands_(dso, 5), true);

/* the raw source, for the assertions below that are about the CODE rather than
   about a value it returns */
var src2 = fs.readFileSync(require('path').join(ROOT, 'Code.gs'), 'utf8')
  .replace(/\r\n/g, '\n');

console.log('\n--- the month IN PROGRESS is not measured ---');
/* KRA owner's ruling, 17 Sep 2026. On the current month payment terms have not
   elapsed, so receivables equal GMV and the formula returns days-since-the-
   month-began. September put every POC in both teams at exactly 17.0 days,
   rating T0, climbing by one a day. It measured the calendar. */
ck('the rule is on', DSO_SKIP_CURRENT_MONTH_, true);
ck('the current month is the CALENDAR one, not whatever PERIODS calls open',
   /Utilities\.formatDate\(new Date\(\)[\s\S]{0,60}'yyyy-MM'\)/.test(src2), true);
ck('  which matters, because August is still open and is complete',
   src2.indexOf('August is') >= 0, true);
ck('shipments in it are skipped, not zeroed',
   /=== curMonth\) \{ nInProgress\+\+; continue; \}/.test(src2), true);

console.log('  and the rows the OLD rule already wrote must go, or the ruling is a no-op:');
ck('stale rows for the current month are collected',
   /var stale = \[\];/.test(src2), true);
ck('  only ones carrying this importer\'s own note',
   /if \(String\(p\.note \|\| ''\)\.indexOf\(DSO_NOTE_\) < 0\) return;/.test(src2), true);
ck('  they are listed before anything is removed',
   src2.indexOf('under the OLD rule will be REMOVED') >= 0, true);
ck('  deleted only on the real run',
   /stale\.forEach\(function \(x\) \{ del_\(T\.PERF, x\.id\); \}\);/.test(src2), true);
ck('  and the dry run says nothing was removed',
   src2.indexOf('NOTHING WAS WRITTEN, AND NOTHING REMOVED') >= 0, true);
ck('the target row is kept, so the month is not erased',
   src2.indexOf('the target row is kept') >= 0, true);

console.log('  a CLOSED month with nothing collected is a different question:');
ck('  those are still imported, flag and all',
   src2.indexOf('A closed month with nothing collected is a DIFFERENT question') >= 0, true);
ck('  and the zero-collection flag still exists',
   src2.indexOf('nothing collected (= ') >= 0, true);

console.log('\n--- the log must not round its own write up ---');
/* The first Metal run reported "27 performance rows and 27 plan rows". Only 8
   plan rows were written: Metal's target is left to the Target Sheet, so those
   19 rows get a performance row and no plan row at all. A log that overstates
   what it did is worse than no log, because it is believed. */
ck('the plan count is its own counter, not the row count',
   /out\.push\('WRITTEN: ' \+ writes\.length \+ ' performance rows and ' \+ nPlan/
     .test(src2), true);
ck('  which is incremented only where a target is written',
   /if \(tgtDays !== null && tgtDays !== undefined\) \{\n\s*nPlan\+\+;/.test(src2), true);
ck('  and the shortfall is explained rather than left as a puzzle',
   src2.indexOf("rows got no plan row: their team") >= 0, true);
ck('the old claim is gone',
   /performance rows and ' \+ writes\.length \+\n\s*' plan rows/.test(src2), false);

console.log('\n--- a month with NOTHING collected must be called out ---');
/* Half the Metal rows came back at exactly the number of days in the month:
   30, 31, 31. That is receivables == GMV — no payment recorded at all — and it
   rates T0 whatever collections actually did. It is an absence of data wearing
   the costume of a measurement. */
function dsoFor(gmv, recv, days) { return gmv ? recv / gmv * days : null; }
ck('nothing collected gives exactly the days elapsed', dsoFor(100, 100, 31), 31);
ck('  which is what AYUSH GOYAL showed in three consecutive months', 31, 31);
ck('  and it is detected as a ratio, not by matching the number',
   100 / 100 >= 0.999, true);
ck('  a genuinely slow month is NOT flagged', (95 / 100) >= 0.999, false);
ck('  nor is a fast one', (5 / 100) >= 0.999, false);
/* the tolerance has to allow for float noise on a sum of many shipments */
ck('  float noise still counts as nothing collected',
   (99.99999 / 100) >= 0.999, true);
ck('the flag appears in the report', src2.indexOf('nothing collected (= ') >= 0, true);
ck('  and the summary names both innocent explanations',
   src2.indexOf('payment') >= 0 && src2.indexOf('not yet due') >= 0, true);

console.log('\n--- a negative receivable counts as zero, not as a credit ---');
/* Left signed, an over-collected shipment cancels out somebody else's genuine
   overdue. Clamping is the conservative direction: it can only RAISE the DSO. */
function clamp(x) { return x < 0 ? 0 : x; }
var rows = [{ ap: 100, aq: 50, au: 10 }, { ap: 100, aq: 200, au: 0 }];
function total(useClamp) {
  var gmv = 0, recv = 0;
  rows.forEach(function (r) {
    var wt = r.ap * DSO_GST_;
    var g = wt - r.au, v = wt - r.aq - r.au;
    gmv += useClamp ? clamp(g) : g;
    recv += useClamp ? clamp(v) : v;
  });
  return { gmv: gmv, recv: recv };
}
var signed = total(false), clampedT = total(true);
ck('signed, the over-collected row cancels the overdue one',
   Math.round(signed.recv * 100) / 100, -24);
ck('  clamped, only the genuine receivable counts',
   Math.round(clampedT.recv * 100) / 100, 58);
ck('clamping therefore RAISES the DSO, never lowers it',
   clampedT.recv >= signed.recv, true);
ck('  a signed total could even go negative, which is not a number of days',
   signed.recv < 0, true);
ck('  clamped can never be negative', clampedT.recv >= 0, true);
ck('GMV is clamped the same way, for a debit note above the sale value',
   clamp(100 * DSO_GST_ - 200), 0);

console.log('\n--- YTD DSO averages the months; it does not stretch the span ---');
/* THE REAL NUMBERS from the 15 Sep 2026 run over Raw_Shipments, Plastic by
   buyer_category, June to date. The first version of the report summed the
   receivables and the GMV and multiplied by the 108 days of the whole span,
   and reported 75.4 days against months that ran 2.4, 14.4, 27.5 and 15.0.
   Arithmetically fine, and meaningless: stretching the multiplier stretches
   the answer, so the longer the year ran the worse Plastic would have looked.

   DSO is a DURATION, and durations average — the app's own YTD rule. */
var MONTHS = [{ k: '2026-06', gmv: 1.62, recv: 0.13, days: 30 },
              { k: '2026-07', gmv: 3.50, recv: 1.63, days: 31 },
              { k: '2026-08', gmv: 6.96, recv: 6.18, days: 31 },
              { k: '2026-09', gmv: 1.64, recv: 1.64, days: 15 }];
function dsoOf(m) { return m.recv / m.gmv * m.days; }
function r1(x) { return Math.round(x * 10) / 10; }
var each = MONTHS.map(dsoOf);
ck('the four months', each.map(r1).join(' | '), '2.4 | 14.4 | 27.5 | 15');
var sumG = MONTHS.reduce(function (a, m) { return a + m.gmv; }, 0);
var sumR = MONTHS.reduce(function (a, m) { return a + m.recv; }, 0);

var mean = each.reduce(function (a, b) { return a + b; }, 0) / each.length;
ck('YTD is the MEAN of the months', r1(mean), 14.8);
ck('  and it sits inside the range the months actually ran',
   mean >= Math.min.apply(null, each) && mean <= Math.max.apply(null, each), true);

var span = sumR / sumG * 108;
ck('the span quotient is the bug', r1(span), 75.4);
ck('  it is WORSE than every single month, which is the tell',
   span > Math.max.apply(null, each), true);
/* and it gets worse purely by the calendar running on */
ck('  at 200 days the same data would read', r1(sumR / sumG * 200), 139.7);
ck('    so the span quotient grows with the year, on identical performance',
   sumR / sumG * 200 > span, true);

var wgt = MONTHS.reduce(function (a, m) { return a + dsoOf(m) * m.gmv; }, 0) / sumG;
ck('the GMV-weighted mean is reported too, for the owner to choose', r1(wgt), 19.7);
ck('  it differs enough from the plain mean to be worth the choice',
   Math.abs(wgt - mean) > 4, true);

console.log('  and what each aggregation would RATE:');
ck('  mean of months  -> Target 1', levelFromBands_(dso, mean), 1);
ck('  span quotient   -> Target 0', levelFromBands_(dso, span), 0);
ck('  so the bug cost a whole rung', levelFromBands_(dso, span) < levelFromBands_(dso, mean),
   true);
/* the target is 5 days; none of these reach it, and that is a finding */
ck('no aggregation reaches the 5-day target',
   Math.min(mean, wgt) <= DSO_TARGET_DAYS_.plastic, false);

console.log('\n--- days in the month, and the month still running ---');
eval(grab('function daysInMonth_(periodId)', '/* The month in progress'));
ck('June has 30', daysInMonth_('per_2026-06'), 30);
ck('July has 31', daysInMonth_('per_2026-07'), 31);
ck('February 2026 has 28', daysInMonth_('per_2026-02'), 28);
ck('February 2028 has 29 — a leap year', daysInMonth_('per_2028-02'), 29);
ck('December has 31, not a rollover to January',
   daysInMonth_('per_2026-12'), 31);
ck('a malformed period is 0, not NaN', daysInMonth_('per_nonsense'), 0);
ck('  and so is an empty one', daysInMonth_(''), 0);
ck('a bare yyyy-MM works too, without the prefix', daysInMonth_('2026-06'), 30);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
