/* Exercises the REAL kraKey_ / targetUnit_ / matchTargetRow_ out of Code.gs.
   The five KRA labels asserted here are the exact five the dry run reported as
   unmatched, so this suite fails if the fix regresses. */
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
eval(grab('function num_(v)', 'function slug_'));
eval(grab('var TARGET_TABS', '/* ==========================================================================\n * DERIVED TARGETS'));
eval(grab('var DERIVED_FROM_PERIOD', 'function derivedTarget_'));
eval(grab('var KRA_UNIT_WORDS_', 'function targetMatchCtx_'));
/* matchTargetRow_ canonicalises the employee name through the SAME alias table
   the POC columns use, so that block has to come along */
eval(grab('var POC_ALIASES', 'function resolvePocEmployee_'));
/* matchTargetRow_ merges two source rows that land on one person, so the merge
   helpers immediately above it have to come along */
eval(grab('function mergeIsMean_(kraName, unit)',
  '/* --------------------------------------------------------------- IMPORTING'));

var pass = 0, fail = 0;
function ck(label, got, want) {
  var ok = String(got) === String(want); ok ? pass++ : fail++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + ': ' + got + (ok ? '' : '   (want ' + want + ')'));
}
function currentEmail_() { return 'tester@recykal.com'; }
function nowIso_() { return '2026-09-10T00:00:00.000Z'; }

console.log('--- the five labels the dry run could not match ---');
ck('GMV (Crores) -> GMV',   kraKey_('GMV (Crores)'), 'GMV');
ck('GMV (Cr) -> GMV',       kraKey_('GMV (Cr)'), 'GMV');
ck('our own "GMV" is unchanged', kraKey_('GMV'), 'GMV');
ck('@ 50% stripped',
   kraKey_('Transaction from Existing Sellers @ 50%'), 'TRANSACTION FROM EXISTING SELLERS');
ck('@ 20% stripped',
   kraKey_('Transaction from New Onboarded Sellers @ 20%'), 'TRANSACTION FROM NEW ONBOARDED SELLERS');
ck('@ 70% stripped',
   kraKey_('Retention of Existing Transacted Sellers @ 70%'), 'RETENTION OF EXISTING TRANSACTED SELLERS');
ck('...and the undecorated form lands on the same key',
   kraKey_('Transaction from Existing Sellers'), 'TRANSACTION FROM EXISTING SELLERS');

console.log('\n--- stripping must NOT eat a real word ---');
ck('DSO Days keeps Days',   kraKey_('DSO Days'), 'DSO DAYS');
ck('New Seller Acquisition intact', kraKey_('New Seller Acquisition'), 'NEW SELLER ACQUISITION');
ck('New Buyer Acquisition intact',  kraKey_('New Buyer Acquisition'), 'NEW BUYER ACQUISITION');
ck('  and they stay DIFFERENT keys',
   kraKey_('New Seller Acquisition') === kraKey_('New Buyer Acquisition'), false);
ck('Transaction Closure intact', kraKey_('Transaction Closure'), 'TRANSACTION CLOSURE');
ck('a single-token name is never emptied', kraKey_('Cr'), 'CR');
ck('seller vs buyer transaction KRAs stay distinct',
   kraKey_('Transaction from New Onboarded Sellers @ 20%') ===
   kraKey_('Transaction from New Onboarded Buyers @ 20%'), false);

console.log('\n--- unit inference: 0.35 crore and 0.35 sellers are different things ---');
ck('GMV (Crores)', targetUnit_('GMV (Crores)'), 'Cr');
ck('GMV (Cr)',     targetUnit_('GMV (Cr)'), 'Cr');
ck('a seller count', targetUnit_('New Seller Acquisition'), 'count');
ck('DSO Days',     targetUnit_('DSO Days'), 'days');
ck('Qty in MT',    targetUnit_('Volume (MT)'), 'MT');

/* --- a miniature app: 2 people, 2 teams, the KRAs the sheet references ---- */
var TEAM_M = 'team_metal', TEAM_P = 'team_plastic';
var ctx = {
  teamById: { team_metal: { id: TEAM_M, name: 'Metal' },
              team_plastic: { id: TEAM_P, name: 'Plastic' } },
  empByName: {
    'AMIT JHA':         { id: 'EMP-AMITJHA', name: 'AMIT JHA', team_id: TEAM_M },
    'ASHISH KUMAR RAI': { id: 'EMP-ASHISH', name: 'ASHISH KUMAR RAI', team_id: TEAM_P }
  },
  kraByKey: {},
  assignByEmpKra: {}
};
function addKra(id, name, team) {
  var k = { id: id, name: name, team_id: team }, key = kraKey_(name);
  (ctx.kraByKey[key] = ctx.kraByKey[key] || []).push(k);
  return k;
}
/* same KRA name in both teams — resolution must go by the person's team */
addKra('kra_m_gmv', 'GMV', TEAM_M);
addKra('kra_p_gmv', 'GMV', TEAM_P);
addKra('kra_m_ret', 'Retention of Existing Transacted Sellers', TEAM_M);
addKra('kra_p_exist', 'Transaction from Existing Sellers', TEAM_P);
addKra('kra_m_nsa', 'New Seller Acquisition', TEAM_M);
ctx.assignByEmpKra['EMP-AMITJHA|kra_m_gmv'] = { kpi_id: 'kpi_m_gmv' };
ctx.assignByEmpKra['EMP-AMITJHA|kra_m_ret'] = { kpi_id: 'kpi_m_ret' };
ctx.assignByEmpKra['EMP-ASHISH|kra_p_exist'] = { kpi_id: 'kpi_p_exist' };
ctx.assignByEmpKra['EMP-ASHISH|kra_p_gmv'] = { kpi_id: 'kpi_p_gmv' };
/* deliberately NO assignment for Amit + New Seller Acquisition */

var MONTHS = [
  { name: 'JUNE', period_id: 'per_2026-06' },
  { name: 'JULY', period_id: 'per_2026-07' }
];
function blank() {
  return { rows: 0, values: 0, actuals: 0, okEmp: 0, okKra: 0, okKpi: 0,
           noEmp: {}, noKra: {}, noKpi: {}, pctLike: [],
           /* rows are collected by id so a second source row for the same
              person+KPI+period merges instead of replacing */
           planById: {}, perfById: {}, merges: [],
           plans: [], perf: [], byKra: {} };
}
function row(rowNo, name, kra, cells) {
  var c = {};
  MONTHS.forEach(function (m, i) {
    c[m.period_id] = { target: cells[i][0], achievement: cells[i][1] };
  });
  return { rowNo: rowNo, name: name, kra: kra, cells: c };
}

console.log('\n--- a decorated GMV row now reaches the right team\'s KPI ---');
var r = blank();
matchTargetRow_(row(8, 'Amit Jha', 'GMV (Crores)', [[4.11, 4.11], [5, 7.19]]), 'Metals', MONTHS, ctx, r);
ck('person matched', r.okEmp, 1);
ck('KRA matched despite "(Crores)"', r.okKra, 1);
ck('reached a KPI', r.okKpi, 1);
ck('two months -> two plans', r.plans.length, 2);
ck('picked the METAL GMV KPI, not Plastic', r.plans[0].kpi_id, 'kpi_m_gmv');
ck('June value', r.plans[0].target_value, 4.11);
ck('unit is Cr', r.plans[0].unit, 'Cr');
ck('source recorded', r.plans[0].source, 'target_sheet');
ck('id is deterministic', r.plans[0].id, 'pl_EMP-AMITJHA_kpi_m_gmv_per_2026-06');
ck('rule text names the row', /Metals row 8/.test(r.plans[0].rule), true);

console.log('\n--- the same label, a Plastic person, the other team\'s KPI ---');
var r2 = blank();
matchTargetRow_(row(7, 'Ashish Kumar Rai', 'GMV (Cr)', [[0.35099785, 0.35], [0.66, 0.63]]), 'Plastics', MONTHS, ctx, r2);
ck('picked the PLASTIC GMV KPI', r2.plans[0].kpi_id, 'kpi_p_gmv');
ck('long decimal survives', r2.plans[0].target_value, 0.35099785);

console.log('\n--- "@ 50%" in the label still finds the KRA ---');
var r3 = blank();
matchTargetRow_(row(4, 'Ashish Kumar Rai', 'Transaction from Existing Sellers @ 50%', [[5, 3], [7, 5]]), 'Plastics', MONTHS, ctx, r3);
ck('KRA matched', r3.okKra, 1);
ck('counts imported as counts', r3.plans.length, 2);
ck('unit is count', r3.plans[0].unit, 'count');
ck('June = 5', r3.plans[0].target_value, 5);
ck('nothing dropped as a percentage', r3.pctLike.length, 0);

console.log('\n--- Metals typed the RULE PERCENTAGE where a count belongs ---');
var r4 = blank();
matchTargetRow_(row(4, 'Amit Jha', 'Retention of Existing Transacted Sellers', [[null, null], [0.5, null]]), 'Metals', MONTHS, ctx, r4);
ck('the KRA and KPI resolve fine', r4.okKpi, 1);
ck('0.5 is NOT written as a target', r4.plans.length, 0);
ck('it is reported instead', r4.pctLike.length, 1);
ck('  and named in the report', /JULY = 0.5/.test(r4.pctLike[0]), true);
ck('the em-dash June cell was never counted', r4.values, 1);

console.log('\n--- a REAL 0.5 crore target must NOT be mistaken for the rule ---');
var r5 = blank();
matchTargetRow_(row(8, 'Amit Jha', 'GMV (Crores)', [[0.5, null], [null, null]]), 'Metals', MONTHS, ctx, r5);
ck('GMV has no derived rule, so 0.5 Cr is kept', r5.plans.length, 1);
ck('  value intact', r5.plans[0].target_value, 0.5);
ck('  nothing dropped', r5.pctLike.length, 0);

console.log('\n--- a target with nothing to attach to is refused, not invented ---');
var r6 = blank();
matchTargetRow_(row(6, 'Amit Jha', 'New Seller Acquisition', [[2, 2], [3, 2]]), 'Metals', MONTHS, ctx, r6);
ck('KRA matched', r6.okKra, 1);
ck('but no assignment, so no KPI', r6.okKpi, 0);
ck('no plans written', r6.plans.length, 0);
ck('reported by person and KRA',
   Object.keys(r6.noKpi)[0], 'Amit Jha / New Seller Acquisition');

console.log('\n--- an EMPLOYEE NAME variant resolves through the same alias table ---');
/* The Metals tab started writing "Adarsh Krishnan V" in the EMPLOYEE NAME
   column, not just in the POC columns, and seven rows silently stopped
   matching anybody. The alias table already knew that name — the target
   importer was not asking it. */
ctx.empByName[normName_('ADARSH KRISHNA')] =
  { id: 'EMP-ADARSH', name: 'ADARSH KRISHNA', team_id: TEAM_M };
ctx.assignByEmpKra['EMP-ADARSH|kra_m_gmv'] = { kpi_id: 'kpi_m_gmv' };
var rv = blank();
matchTargetRow_(row(11, 'Adarsh Krishnan V', 'GMV (Crores)', [[4, 4], [5, 5]]), 'Metals', MONTHS, ctx, rv);
ck('the variant matched a person', rv.okEmp, 1);
ck('  and reached the right one', rv.plans[0].employee_id, 'EMP-ADARSH');
ck('  producing plans', rv.plans.length, 2);
var rv2 = blank();
matchTargetRow_(row(11, 'Adarsh Krishna', 'GMV (Crores)', [[4, 4], [5, 5]]), 'Metals', MONTHS, ctx, rv2);
ck('the canonical spelling still matches', rv2.plans[0].employee_id, 'EMP-ADARSH');
var rv3 = blank();
matchTargetRow_(row(11, 'Adarsh', 'GMV (Crores)', [[4, 4], [5, 5]]), 'Metals', MONTHS, ctx, rv3);
ck('and the bare first name does too', rv3.plans[0].employee_id, 'EMP-ADARSH');
ck('canonPocName_ and canonPersonName_ are the same function',
   canonPocName_('Adarsh Krishnan V') === canonPersonName_('Adarsh Krishnan V'), true);

/* Abhisek left and his accounts passed to Adarsh, so BOTH spellings of his
   name now resolve to Adarsh — the Target Sheet still carries his block and
   must keep landing somewhere real rather than silently vanishing. */
var rs1 = blank(), rs2 = blank();
matchTargetRow_(row(20, 'Abhisek Sanyal', 'GMV (Crores)', [[1, 1], [2, 2]]), 'Metals', MONTHS, ctx, rs1);
matchTargetRow_(row(20, 'Abhishek Sanyal', 'GMV (Crores)', [[1, 1], [2, 2]]), 'Metals', MONTHS, ctx, rs2);
ck('both spellings reach Adarsh',
   rs1.plans[0].employee_id + '/' + rs2.plans[0].employee_id,
   'EMP-ADARSH/EMP-ADARSH');
ck('  and produce identical plan ids, so neither duplicates the other',
   rs1.plans[0].id, rs2.plans[0].id);
ck('  which is the same id Adarsh\'s own row would produce',
   rs1.plans[0].id.indexOf('EMP-ADARSH') > 0, true);
ck('  POC_IGNORE does NOT hide a name from the target importer',
   canonPersonName_('Nomul Aravind'), 'NOMUL ARAVIND');

console.log('\n--- TWO source rows landing on ONE person must MERGE, not overwrite ---');
/* Abhisek's Target Sheet block now resolves to Adarsh, and both men have a
   "GMV (Crores)" row. Two records with the same PLAN id would leave upsert_
   keeping whichever came last — one man's target silently replaced by the
   other's. A merge that loses half its input is worse than no merge. */
var rmg = blank();
matchTargetRow_(row(11, 'Adarsh Krishna', 'GMV (Crores)', [[1.20, 1.00], [2, 2]]), 'Metals', MONTHS, ctx, rmg);
matchTargetRow_(row(20, 'Abhisek Sanyal', 'GMV (Crores)', [[1.50, 0.50], [3, 1]]), 'Metals', MONTHS, ctx, rmg);
/* no flattening needed: addOrMerge_ pushes into res.plans and merges the
   object already there */
ck('both rows reached the same person', rmg.okEmp, 2);
ck('  producing ONE plan per month, not two', rmg.plans.length, 2);
var jun = rmg.plans.filter(function (p) { return p.period_id === 'per_2026-06'; })[0];
ck('June target is 1.20 + 1.50', jun.target_value, 2.7);
ck('  not just the last one seen', jun.target_value === 1.5, false);
ck('  nor just the first', jun.target_value === 1.2, false);
var junA = rmg.perf.filter(function (p) { return p.period_id === 'per_2026-06'; })[0];
ck('June achieved is 1.00 + 0.50', junA.actual, 1.5);
ck('the merge is reported, not silent', rmg.merges.length > 0, true);
ck('  naming both sources',
   /Adarsh Krishna \+ Abhisek Sanyal/.test(rmg.merges.join('|')), true);
ck('  and saying it added', /added/.test(rmg.merges.join('|')), true);

console.log('  a DURATION averages instead, or two 3-day DSOs become 6:');
ck('days is a mean', mergeIsMean_('DSO Days', 'days'), true);
ck('  by unit', mergeIsMean_('Anything', 'days'), true);
ck('  or by name', mergeIsMean_('DSO Days', 'count'), true);
ck('a rate averages too', mergeIsMean_('DN % of GMV', 'count'), true);
ck('a seller count does NOT', mergeIsMean_('New Seller Acquisition', 'count'), false);
ck('GMV does NOT', mergeIsMean_('GMV (Crores)', 'Cr'), false);

console.log('  one person alone is untouched by any of this:');
var rsolo = blank();
matchTargetRow_(row(11, 'Adarsh Krishna', 'GMV (Crores)', [[1.20, 1.00], [2, 2]]), 'Metals', MONTHS, ctx, rsolo);
ck('no merge recorded', rsolo.merges.length, 0);
ck('  and the value is his own', rsolo.plans[0].target_value, 1.2);

console.log('\n--- an unknown person / unknown KRA is reported, never guessed ---');
var r7 = blank();
matchTargetRow_(row(9, 'Someone Not Here', 'GMV (Cr)', [[1, 1], [1, 1]]), 'Plastics', MONTHS, ctx, r7);
ck('person not matched', r7.okEmp, 0);
ck('  no plans', r7.plans.length, 0);
ck('  reported', Object.keys(r7.noEmp)[0], 'Someone Not Here');
var r8 = blank();
matchTargetRow_(row(9, 'Amit Jha', 'Brand New KRA Nobody Seeded', [[1, 1], [1, 1]]), 'Metals', MONTHS, ctx, r8);
ck('KRA not matched', r8.okKra, 0);
ck('  no plans', r8.plans.length, 0);
ck('  and it did NOT fall through to some other KRA',
   Object.keys(r8.noKra)[0], 'Brand New KRA Nobody Seeded');

console.log('\n--- the ACHIEVEMENT column beside every target ---');
var ra = blank();
matchTargetRow_(row(8, 'Amit Jha', 'GMV (Crores)', [[4.11, 4.11], [5, 7.19]]), 'Metals', MONTHS, ctx, ra);
ck('two achievements collected', ra.perf.length, 2);
ck('  counted', ra.actuals, 2);
ck('June actual', ra.perf[0].actual, 4.11);
ck('July actual', ra.perf[1].actual, 7.19);
ck('  stored RAW, not as a ratio of the target',
   ra.perf[1].actual === 7.19 / 5, false);
ck('  the id matches what apiSaveActual would use',
   ra.perf[0].id, 'prf_EMP-AMITJHA_kpi_m_gmv_per_2026-06');
ck('  attached to the same KPI as the target', ra.perf[0].kpi_id, ra.plans[0].kpi_id);
ck('  the note says where it came from',
   /Target Sheet, tab Metals row 8/.test(ra.perf[0].note), true);
ck('  status recorded', ra.perf[0].status, 'recorded');
ck('  no level asserted — the model resolves it', ra.perf[0].level, '');

console.log('\n--- the per-KRA tally, which answers "why is X not showing" ---');
/* A KRA with targets and zero achievements has em dashes in its Achievement
   column. Reporting that per KRA turns a suspicion about the importer into a
   fact about the sheet. */
/* this KRA needs to resolve, or the row exits before the tally is reached */
addKra('kra_m_nba', 'New Buyer Acquisition', TEAM_M);
ctx.assignByEmpKra['EMP-AMITJHA|kra_m_nba'] = { kpi_id: 'kpi_m_nba' };
var rt = blank();
matchTargetRow_(row(8, 'Amit Jha', 'GMV (Crores)', [[4.11, 4.11], [5, 7.19]]), 'Metals', MONTHS, ctx, rt);
matchTargetRow_(row(5, 'Amit Jha', 'New Buyer Acquisition', [[2, null], [2, null]]), 'Metals', MONTHS, ctx, rt);
ck('GMV: 2 targets, 2 achievements',
   rt.byKra['GMV (Crores)'].t + '/' + rt.byKra['GMV (Crores)'].a, '2/2');
ck('New Buyer Acquisition: 2 targets, 0 achievements',
   rt.byKra['New Buyer Acquisition'].t + '/' + rt.byKra['New Buyer Acquisition'].a, '2/0');
ck('  so nothing was imported for it', rt.perf.filter(function (p) {
     return p.kpi_id === 'kpi_m_nba'; }).length, 0);
ck('row counts kept per KRA', rt.byKra['GMV (Crores)'].rows, 1);

/* "t=2" on a KRA held by two people can mean one month each, or two months for
   one of them. Those are different problems — a sheet with one column filled
   in, versus a person missing — so the tally splits by month. */
ck('GMV June: one target, one achievement',
   rt.byKra['GMV (Crores)'].m.JUNE.t + '/' + rt.byKra['GMV (Crores)'].m.JUNE.a, '1/1');
ck('New Buyer Acquisition June: target, no achievement',
   rt.byKra['New Buyer Acquisition'].m.JUNE.t + '/' +
   rt.byKra['New Buyer Acquisition'].m.JUNE.a, '1/0');
ck('  and July the same', rt.byKra['New Buyer Acquisition'].m.JULY.a, 0);
/* a month present in the header but empty for this KRA is recorded as 0/0,
   not omitted — "no column" and "an empty column" read differently */
var rm = blank();
matchTargetRow_(row(8, 'Amit Jha', 'GMV (Crores)', [[null, null], [5, 5]]), 'Metals', MONTHS, ctx, rm);
ck('an empty month is 0/0, not missing',
   rm.byKra['GMV (Crores)'].m.JUNE.t + '/' + rm.byKra['GMV (Crores)'].m.JUNE.a, '0/0');
ck('  while the filled one counts', rm.byKra['GMV (Crores)'].m.JULY.t, 1);

console.log('\n--- a blank achievement is not a zero ---');
var rb = blank();
matchTargetRow_(row(6, 'Amit Jha', 'GMV (Crores)', [[2, null], [3, 0]]), 'Metals', MONTHS, ctx, rb);
ck('only the real one collected', rb.perf.length, 1);
ck('  and it is the ZERO, which IS an achievement', rb.perf[0].actual, 0);
ck('  for July', rb.perf[0].period_id, 'per_2026-07');

console.log('\n--- an achievement on a row that reaches no KPI is not invented ---');
var rc = blank();
matchTargetRow_(row(6, 'Amit Jha', 'New Seller Acquisition', [[2, 2], [3, 2]]), 'Metals', MONTHS, ctx, rc);
ck('no assignment, so no KPI', rc.okKpi, 0);
ck('  no achievements either', rc.perf.length, 0);

console.log('\n--- a dropped rule-percentage TARGET must not drop its achievement ---');
var rd = blank();
matchTargetRow_(row(4, 'Amit Jha', 'Retention of Existing Transacted Sellers',
                    [[null, null], [0.5, 3]]), 'Metals', MONTHS, ctx, rd);
ck('the 0.5 target is dropped', rd.plans.length, 0);
ck('  but the achievement of 3 survives', rd.perf.length, 1);
ck('  with its real value', rd.perf[0].actual, 3);

console.log('\n--- re-import must refresh, not duplicate ---');
var a = blank(), b = blank();
var mk = function () { return row(8, 'Amit Jha', 'GMV (Crores)', [[4.11, 0], [5, 0]]); };
matchTargetRow_(mk(), 'Metals', MONTHS, ctx, a);
matchTargetRow_(mk(), 'Metals', MONTHS, ctx, b);
ck('same row, same ids', a.plans[0].id, b.plans[0].id);
ck('ids differ across months', a.plans[0].id === a.plans[1].id, false);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
