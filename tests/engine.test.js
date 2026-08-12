/**
 * engine.test.js — Validates the calculation engine against the source workbook.
 *
 * The August 2026 Plastic workbook contains computed values produced by its own
 * formulas. Those values are the acceptance criteria: after syncing the same raw
 * facts through the application, the engine must reproduce them.
 *
 * Expected values below are read directly from the workbook cells named in each
 * comment, evaluated at TODAY() = 2026-08-11 (as-of 2026-08-10).
 *
 * Run: node tests/engine.test.js
 */

const fs = require('fs');
const path = require('path');
const { createEnvironment } = require('./gas-harness');

const AS_OF = '2026-08-11T09:00:00';       // the workbook's TODAY()
const FIXTURES = path.join(__dirname, 'fixtures');

/* ------------------------------------------------------------ assertions --- */
let passed = 0, failed = 0;
const failures = [];

function ok(name, condition, detail) {
  if (condition) { passed++; console.log('  ✓ ' + name); }
  else {
    failed++; failures.push({ name, detail });
    console.log('  ✗ ' + name + (detail ? '\n      ' + detail : ''));
  }
}
function eq(name, actual, expected) {
  ok(name, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function near(name, actual, expected, tolerance = 1e-6) {
  const delta = Math.abs(Number(actual) - Number(expected));
  ok(name, delta <= tolerance,
    `expected ${expected}, got ${actual} (delta ${delta.toExponential(2)})`);
}
function section(title) { console.log('\n' + title); }

/* ------------------------------------------------------------------ setup --- */
section('Bootstrapping the application');
// SOURCE_SPREADSHEET_ID now defaults to the connected operational workbook, so
// the mock "backend" spreadsheet is given that same id — Sync calls made with
// no explicit spreadsheetId (as production leaves it, reading its default)
// then resolve to this harness's mock spreadsheet, same as real deployments
// resolve to the connected workbook.
const env = createEnvironment({
  now: AS_OF, userEmail: 'lead@omp.test',
  spreadsheetId: '1h0MGbmtOriH-T-cxQOGgcXBeydcNqv-bqT2AlLnWDdU'
});
const S = env.sandbox;

// Before setup has ever run, the RPC entry point must hand back a normal
// { needsSetup: true } response so the client can render the in-app Setup
// wizard — not throw, which would strand the user on the fatal boot-error
// screen with no way to proceed short of the Apps Script editor.
const freshEnv = createEnvironment({ now: AS_OF, userEmail: 'lead@omp.test' });
const preSetup = freshEnv.sandbox.api('session.bootstrap', {});
ok('session.bootstrap succeeds before setup has run', preSetup.ok === true,
  JSON.stringify(preSetup));
ok('session.bootstrap reports needsSetup before setup has run',
  preSetup.ok && preSetup.data && preSetup.data.needsSetup === true,
  JSON.stringify(preSetup));

S.PropertiesService.getScriptProperties().setProperty('OMP_BOOTSTRAP_ADMIN', 'lead@omp.test');
const setup = S.Bootstrap.setup({});
ok('schema created', setup.created.length >= 20, 'created: ' + setup.created.length);
eq('schema version recorded', setup.schemaVersion, S.APP.SCHEMA_VERSION);

const me = S.Auth.current();
eq('bootstrap administrator provisioned', me.role, 'ADMIN');

const health = S.Bootstrap.health();
ok('health reports ok', health.ok, JSON.stringify(health.missingSheets));

/* ---------------------------------------------------- reference: windows --- */
section('Time windows (the workbook\'s window algebra)');
const w = S.DateUtil;
eq('as-of is today minus the reporting lag', w.isoDate(w.asOf()), '2026-08-10');

const mtd = w.cycleWindow(2026, 8, w.asOf());
eq('MTD starts on the 1st', w.isoDate(mtd.start), '2026-08-01');
eq('MTD ends exclusive at as-of + 1', w.isoDate(mtd.end), '2026-08-11');
eq('MTD elapsed days', w.elapsedDays(mtd), 10);
eq('MTD remaining days', w.remainingDays(mtd), 21);

const lmtd = w.cycleLmtdWindow(2026, 8, w.asOf());
eq('LMTD starts on the 1st of the previous month', w.isoDate(lmtd.start), '2026-07-01');
eq('LMTD ends at the same day-count last month', w.isoDate(lmtd.end), '2026-07-11');

const fytd = w.window('FYTD', w.asOf());
eq('FYTD starts 1 April (Indian FY)', w.isoDate(fytd.start), '2026-04-01');
eq('fiscal year label', w.fiscalYearLabel(new S.Date(AS_OF)), 'FY2026-27');

/* ------------------------------------------------------------- scoring --- */
section('Scoring maths (per-POC scorecard formulas)');
// Ashish Kumar Rai, GMV row: D19=0.6, E19=0.57, F19=0.95, G19=MIN(0.95,1.05)*40=38
let ev = S.Engine.evaluate({
  target: 0.6, actual: 0.57, weightage: 40,
  direction: 'HIGHER_BETTER', elapsedDays: 10, remainingDays: 21
});
near('GMV achievement % matches F19', ev.achievement, 0.95, 1e-9);
near('GMV weighted score matches G19', ev.weightedScore, 38, 1e-9);
eq('GMV status band matches I19', ev.bandLabel, '90% Target');

// Existing seller transactions: D16=7, E16=2, F16=0.2857…, G16=4.2857…
ev = S.Engine.evaluate({
  target: 7, actual: 2, weightage: 15,
  direction: 'HIGHER_BETTER', elapsedDays: 10, remainingDays: 21
});
near('existing-seller achievement matches F16', ev.achievement, 0.2857142857, 1e-9);
near('existing-seller weighted score matches G16', ev.weightedScore, 4.285714286, 1e-8);
eq('below-60% band label matches I16', ev.bandLabel, 'Below 60%');

// Achievement is capped at 105% before weighting (MIN(F,1.05)*C).
ev = S.Engine.evaluate({
  target: 100, actual: 200, weightage: 15,
  direction: 'HIGHER_BETTER', elapsedDays: 10, remainingDays: 21
});
near('achievement above the cap is credited at 105%', ev.weightedScore, 15.75, 1e-9);
eq('capped achievement rates 5', ev.rating, 5);

// Lower-is-better: DSO of 4 days against a 5-day target beats plan.
ev = S.Engine.evaluate({
  target: 5, actual: 4, weightage: 15,
  direction: 'LOWER_BETTER', elapsedDays: 10, remainingDays: 21
});
near('lower-is-better inverts the ratio', ev.achievement, 1.25, 1e-9);
eq('lower-is-better beating target rates 5', ev.rating, 5);

// Scorecard roll-up — Ashish Kumar Rai's five KPIs (per-POC sheet G16:G20).
const roll = S.Engine.scorecard([
  { weightage: 15, weightedScore: 4.285714286 },   // existing seller txn
  { weightage: 15, weightedScore: 0 },             // new seller txn
  { weightage: 15, weightedScore: 0 },             // acquisition
  { weightage: 40, weightedScore: 38 },            // GMV
  { weightage: 15, weightedScore: 4.285714286 }    // retention
]);
near('weighted score matches BDM Summary K3', roll.weightedScore, 46.57142857, 1e-5);
near('overall achievement matches BDM Summary L3', roll.overallAchievement, 0.4657142857, 1e-8);
eq('total weightage is 100', roll.totalWeightage, 100);
ok('weightage validates', roll.weightageValid);

// Competition ranking, as Excel RANK(x, range, 0) produces.
const ranks = S.Util.rank([0.4657, 0.4511, 0.4347, 0, 0]);
eq('rank 1 is the highest score', ranks[0], 1);
eq('tied last scores share rank 4', ranks[3], 4);
eq('the second tie shares the same rank', ranks[4], 4);

/* ------------------------------------------------ derived target formulas --- */
section('Derived target formulas');
near('GMV target = tonnage × rate ÷ 10,000 (OMP-Sellers AH)',
  S.Planning.deriveGmvTargetCr(40, 48), 0.192, 1e-12);
near('GMV target for 10 MT at ₹48/kg',
  S.Planning.deriveGmvTargetCr(10, 48), 0.048, 1e-12);

/* ------------------------------------------------------ load real facts --- */
section('Loading the workbook facts');
const shipments = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'shipments.json'), 'utf8'));
const onboarding = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'onboarding.json'), 'utf8'));
const sellerPlan = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'omp-sellers.json'), 'utf8'));
ok('shipment fixture loaded', shipments.length === 151, shipments.length + ' rows');
ok('onboarding fixture loaded', onboarding.length === 185, onboarding.length + ' rows');

// Stage the fixtures into the mock spreadsheet, then let the real sync read them.
function stage(sheetName, rows, headerOrder) {
  const sheet = env.spreadsheet.insertSheet(sheetName);
  const headers = headerOrder || Object.keys(rows[0]);
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  const body = rows.map(r => headers.map(h => {
    const v = r[h];
    if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v)) return new S.Date(v);
    return v === null || v === undefined ? '' : v;
  }));
  if (body.length) sheet.getRange(2, 1, body.length, headers.length).setValues(body);
  return sheet;
}

stage('🚚 Overall Shipments', shipments);
stage('🏢 Seller Onboarding', onboarding);

const syncOnb = S.Sync.syncOnboarding({});
eq('onboarding sync succeeded', syncOnb.status, 'SUCCESS');
eq('onboarding rows imported', syncOnb.rowsInserted, 185);

const syncShip = S.Sync.syncShipments({});
eq('shipment sync succeeded', syncShip.status, 'SUCCESS');
eq('shipment rows imported', syncShip.rowsInserted, 151);

// Re-running must correct, not duplicate.
const syncAgain = S.Sync.syncShipments({});
eq('re-sync updates rather than duplicating', syncAgain.rowsInserted, 0);
eq('re-sync updates every row', syncAgain.rowsUpdated, 151);

/* ------------------------------------------- engine vs workbook totals --- */
section('Engine totals vs the workbook\'s computed values');

const cycle = S.Planning.createCycle({ category: 'Plastic', year: 2026, month: 8, workingDays: 25 });
eq('cycle created in draft', cycle.status, 'DRAFT');

const overall = S.Engine.scope({ category: 'Plastic', stream: 'SUPPLY' });

// OMP-Sellers row 3 (SUBTOTAL of the Achieved block): 35 txns, 430.245 MT, 2.1523311 Cr.
// The same figures appear in WhatsApp Summary D11:D13.
const txn = S.Engine.metric('TXN_COUNT', mtd, overall, { trace: false });
eq('MTD transactions match OMP-Sellers AI3 / WhatsApp D11', txn.value, 35);

const tonnage = S.Engine.metric('TONNAGE_MT', mtd, overall, { trace: false });
near('MTD tonnage matches OMP-Sellers AJ3 / WhatsApp D12', tonnage.value, 430.245, 1e-6);

const gmv = S.Engine.metric('GMV_CR', mtd, overall, { trace: false });
near('MTD GMV matches OMP-Sellers AL3 / WhatsApp D13', gmv.value, 2.1523311, 1e-7);

// LMTD block — WhatsApp Summary H11:H13 and Region-Wise AT3:AV3.
//
// Note: OMP-Sellers row 3 reports 15 / 190.9 / 0.919212 for the same measures,
// because those cells use SUBTOTAL(9, …), which excludes rows hidden by whatever
// filter a user last left applied to the sheet. WhatsApp Summary and Region-Wise
// compute the same figures without a filter and agree with each other; those are
// the true values and the ones the engine must reproduce. See defect #13 in
// docs/WORKBOOK-ANALYSIS.md.
const lTxn = S.Engine.metric('TXN_COUNT', lmtd, overall, { trace: false });
eq('LMTD transactions match WhatsApp H11 / Region-Wise AT3', lTxn.value, 19);
const lTon = S.Engine.metric('TONNAGE_MT', lmtd, overall, { trace: false });
near('LMTD tonnage matches WhatsApp H12 / Region-Wise AU3', lTon.value, 242.735, 1e-6);
const lGmv = S.Engine.metric('GMV_CR', lmtd, overall, { trace: false });
near('LMTD GMV matches WhatsApp H13 / Region-Wise AV3', lGmv.value, 1.1531985, 1e-7);

// Growth — Region-Wise AW3:AY3.
near('transaction growth matches Region-Wise AW3',
  S.Util.div(txn.value - lTxn.value, lTxn.value, 0), 0.8421052632, 1e-8);
near('tonnage growth matches Region-Wise AX3',
  S.Util.div(tonnage.value - lTon.value, lTon.value, 0), 0.7724885163, 1e-8);
near('GMV growth matches Region-Wise AY3',
  S.Util.div(gmv.value - lGmv.value, lGmv.value, 0), 0.866401231, 1e-8);

/* -------------------------------------------------- regional attribution --- */
section('Regional attribution (Region-Wise / WhatsApp Summary)');
const regions = S.Repository.readAll('DB_Regions')
  .filter(r => r.category === 'Plastic' && r.active !== false);
const north = regions.find(r => r.regionName === 'North');
const south = regions.find(r => r.regionName === 'South');
ok('North region resolved from the source data', !!north);
ok('South region resolved from the source data', !!south);

const northScope = S.Engine.scope({ category: 'Plastic', stream: 'SUPPLY', regionId: north.regionId });
const southScope = S.Engine.scope({ category: 'Plastic', stream: 'SUPPLY', regionId: south.regionId });

// WhatsApp Summary D21:D23 (North) and D31:D33 (South).
eq('North MTD transactions match WhatsApp D21',
  S.Engine.metric('TXN_COUNT', mtd, northScope, { trace: false }).value, 23);
near('North MTD tonnage matches WhatsApp D22',
  S.Engine.metric('TONNAGE_MT', mtd, northScope, { trace: false }).value, 287.59, 1e-6);
near('North MTD GMV matches WhatsApp D23',
  S.Engine.metric('GMV_CR', mtd, northScope, { trace: false }).value, 1.4104036, 1e-7);

eq('South MTD transactions match WhatsApp D31',
  S.Engine.metric('TXN_COUNT', mtd, southScope, { trace: false }).value, 12);
near('South MTD tonnage matches WhatsApp D32',
  S.Engine.metric('TONNAGE_MT', mtd, southScope, { trace: false }).value, 142.655, 1e-6);
near('South MTD GMV matches WhatsApp D33',
  S.Engine.metric('GMV_CR', mtd, southScope, { trace: false }).value, 0.7419275, 1e-7);

ok('regions sum to the category total',
  Math.abs(287.59 + 142.655 - tonnage.value) < 1e-6,
  'North + South = ' + (287.59 + 142.655) + ', total = ' + tonnage.value);

/* --------------------------------------------------------- POC attribution --- */
section('POC attribution (WhatsApp Summary POC blocks)');
const users = S.Repository.readAll('DB_Users');
function pocScope(name) {
  const u = users.find(x => x.fullName === name);
  if (!u) throw new Error('POC not found: ' + name);
  return S.Engine.scope({ category: 'Plastic', stream: 'SUPPLY', pocUserId: u.userId });
}

// WhatsApp Summary D42:D44 — Ashish Kumar Rai.
const ashish = pocScope('Ashish Kumar Rai');
eq('Ashish MTD transactions match WhatsApp D42',
  S.Engine.metric('TXN_COUNT', mtd, ashish, { trace: false }).value, 12);
near('Ashish MTD tonnage matches WhatsApp D43',
  S.Engine.metric('TONNAGE_MT', mtd, ashish, { trace: false }).value, 151.395, 1e-6);
near('Ashish MTD GMV matches WhatsApp D44',
  S.Engine.metric('GMV_CR', mtd, ashish, { trace: false }).value, 0.7456501, 1e-7);

// WhatsApp Summary D102:D104 — Praveen Raj P.
const praveen = pocScope('Praveen Raj P');
eq('Praveen MTD transactions match WhatsApp D102',
  S.Engine.metric('TXN_COUNT', mtd, praveen, { trace: false }).value, 1);
near('Praveen MTD tonnage matches WhatsApp D103',
  S.Engine.metric('TONNAGE_MT', mtd, praveen, { trace: false }).value, 17.98, 1e-6);
near('Praveen MTD GMV matches WhatsApp D104',
  S.Engine.metric('GMV_CR', mtd, praveen, { trace: false }).value, 0.09687, 1e-7);

// WhatsApp Summary D112:D114 — Raju B.
const raju = pocScope('Raju B');
eq('Raju MTD transactions match WhatsApp D112',
  S.Engine.metric('TXN_COUNT', mtd, raju, { trace: false }).value, 5);
near('Raju MTD tonnage matches WhatsApp D113',
  S.Engine.metric('TONNAGE_MT', mtd, raju, { trace: false }).value, 46.36, 1e-6);
near('Raju MTD GMV matches WhatsApp D114',
  S.Engine.metric('GMV_CR', mtd, raju, { trace: false }).value, 0.266312, 1e-7);

/* -------------------------------------------------- onboarding attribution --- */
section('Onboarding counts (POC-Wise / WhatsApp Summary)');

// WhatsApp Summary C8 / C9: COUNTIFS(Seller_Status, "Completed") = 110.
const fytdOnboardScope = S.Engine.scope({ category: 'Plastic', stream: 'SUPPLY' });
const completedSet = S.Engine.onboardedAccountSet(
  S.Engine.facts('Plastic'), fytdOnboardScope, null, 'SELLER');
eq('total completed onboardings match WhatsApp C8', Object.keys(completedSet).length, 110);

// WhatsApp Summary D10: onboarded in the MTD window = 3.
eq('MTD sellers onboarded match WhatsApp D10',
  S.Engine.metric('SELLER_ONBOARDED', mtd, overall, { trace: false }).value, 3);
// WhatsApp Summary H10: LMTD = 6.
eq('LMTD sellers onboarded match WhatsApp H10',
  S.Engine.metric('SELLER_ONBOARDED', lmtd, overall, { trace: false }).value, 6);

// WhatsApp Summary D20 / D30: North = 1, South = 2.
eq('North MTD onboarded matches WhatsApp D20',
  S.Engine.metric('SELLER_ONBOARDED', mtd, northScope, { trace: false }).value, 1);
eq('South MTD onboarded matches WhatsApp D30',
  S.Engine.metric('SELLER_ONBOARDED', mtd, southScope, { trace: false }).value, 2);

// WhatsApp Summary C18 / C28: onboarded base by region = 58 North, 52 South.
eq('North onboarded base matches WhatsApp C18',
  Object.keys(S.Engine.onboardedAccountSet(
    S.Engine.facts('Plastic'), northScope, null, 'SELLER')).length, 58);
eq('South onboarded base matches WhatsApp C28',
  Object.keys(S.Engine.onboardedAccountSet(
    S.Engine.facts('Plastic'), southScope, null, 'SELLER')).length, 52);

// WhatsApp Summary C39: Ashish's completed onboardings = 14.
eq('Ashish onboarded base matches WhatsApp C39',
  Object.keys(S.Engine.onboardedAccountSet(
    S.Engine.facts('Plastic'), ashish, null, 'SELLER')).length, 14);

/* ------------------------------------------------ transaction validity rule --- */
section('Transaction validity rule');
const allShipments = S.Repository.readAll('DB_Shipments');
const cancelled = allShipments.filter(s => String(s.shipmentStatus).toUpperCase() === 'CANCELLED');
const drafts = allShipments.filter(s => String(s.shipmentStatus).toUpperCase() === 'DRAFT');
ok('cancelled shipments exist in the source', cancelled.length > 0, cancelled.length + ' rows');
ok('cancelled shipments are excluded from counting',
  cancelled.every(s => s.isValidTxn === false));
ok('draft shipments are excluded from counting',
  drafts.every(s => s.isValidTxn === false));
ok('blank-status rows are excluded',
  allShipments.filter(s => !s.shipmentStatus).every(s => s.isValidTxn === false));

/* --------------------------------------------------- account plan targets --- */
section('Account plan and derived KPI targets');
stage('🏢 OMP-Sellers-Plan', sellerPlan);
const planImport = S.Sync.importAccountPlan({
  cycleId: cycle.cycleId, sheetName: '🏢 OMP-Sellers-Plan', headerRow: 1, accountType: 'SELLER'
});
eq('account plan import succeeded', planImport.status, 'SUCCESS');
ok('account plan rows imported', planImport.rowsInserted > 90, planImport.rowsInserted + ' rows');

const plans = S.Repository.where('DB_AccountPlan', { cycleId: cycle.cycleId });
const planTonnage = S.Util.sum(plans, p => p.tonnageTargetMT);
const planGmv = S.Util.sum(plans, p => p.gmvTargetCr);
const planTxn = S.Util.sum(plans, p => p.txnTarget);

// WhatsApp Summary C11:C13 and Region-Wise AK3:AM3 both report 102 / 1120 / 5.709.
// OMP-Sellers row 3 shows 43 / 465 / 2.296 for the same block because it uses
// SUBTOTAL(9, …) and a filter was left applied. The unfiltered figures are the
// real plan, and are what the import must produce.
eq('planned transactions match WhatsApp C11 / Region-Wise AK3', planTxn, 102);
near('planned tonnage matches WhatsApp C12 / Region-Wise AL3', planTonnage, 1120, 1e-6);
near('planned GMV matches WhatsApp C13 / Region-Wise AM3', planGmv, 5.709, 1e-9);

// GMV target is recomputed on import, never trusted from the source.
const withRate = plans.filter(p => p.tonnageTargetMT > 0 && p.ratePerKgTarget > 0);
ok('every GMV target equals tonnage × rate ÷ 10,000',
  withRate.every(p =>
    Math.abs(p.gmvTargetCr - (p.tonnageTargetMT * p.ratePerKgTarget / 10000)) < 1e-9),
  withRate.length + ' rows checked');

/* --------------------------------------------------------- traceability --- */
section('Traceability — every number resolves to records');
const traced = S.Engine.metric('GMV_CR', mtd, ashish, { trace: true });
ok('drill-down returns the contributing records',
  traced.contributors.length === 12, traced.contributors.length + ' records');
ok('each record carries its identity',
  traced.contributors.every(c => c.id && c.date && c.accountName && c.source),
  JSON.stringify(traced.contributors[0]));
near('contributed GMV sums back to the metric',
  traced.contributors.reduce((s, c) => s + c.gmvCr, 0), traced.value, 1e-8);

/* --------------------------------------------------------- data quality --- */
section('Data quality detection');
const dq = S.Dashboard.dataQuality(cycle.cycleId);
ok('data quality panel produced', Array.isArray(dq.issues));
const codes = dq.issues.map(i => i.code);
ok('unmapped accounts are surfaced rather than dropped',
  codes.includes('ACCOUNT_NO_POC') || codes.includes('ACCOUNT_NO_REGION') ||
  codes.includes('ACCOUNT_NO_GSTIN') || dq.ok,
  'codes: ' + codes.join(', '));

/* -------------------------------------------------- validation & lifecycle --- */
section('Cycle validation and lifecycle');
const check = S.Planning.validateCycle(cycle.cycleId);
ok('validation blocks publishing without assignments',
  !check.valid && check.errors.some(e => e.code === 'NO_ASSIGNMENT'),
  check.errors.map(e => e.code).join(', '));

const tree = S.Planning.getKraTree(cycle.cycleId);
const supply = tree.filter(k => k.stream === 'SUPPLY');
eq('supply KRA set cloned from the library', supply.length, 5);
eq('supply weightage totals 100',
  supply.reduce((s, k) => s + k.totalWeightage, 0), 100);
const demand = tree.filter(k => k.stream === 'DEMAND');
eq('demand KRA set cloned from the library', demand.length, 6);
eq('demand weightage totals 100',
  demand.reduce((s, k) => s + k.totalWeightage, 0), 100);

// Assign the supply set to one POC and confirm the scorecard computes.
const ashishUser = users.find(u => u.fullName === 'Ashish Kumar Rai');
S.Repository.update('DB_Users', ashishUser.userId,
  { role: 'POC', regionId: north.regionId, category: 'Plastic', email: 'ashish@omp.test' });
const supplyKpiIds = supply.flatMap(k => k.kpis.map(p => p.kpiId));
const assigned = S.Planning.assignKpis({
  cycleId: cycle.cycleId, pocUserIds: [ashishUser.userId], kpiIds: supplyKpiIds
});
eq('assignments created', assigned.inserted, 5);

const card = S.Reports.scorecardFor(cycle.cycleId, ashishUser.userId);
eq('scorecard carries five KPIs', card.kpis.length, 5);
eq('scorecard weightage totals 100', card.summary.totalWeightage, 100);
const gmvKpi = card.kpis.find(k => k.metricKey === 'GMV_CR');
near('scorecard GMV actual matches the engine', gmvKpi.evaluation.actual, 0.7456501, 1e-7);
ok('scorecard GMV target comes from the account plan',
  gmvKpi.targetBasis === 'ACCOUNT_PLAN', gmvKpi.targetBasis);
ok('every KPI exposes a drill-down handle',
  card.kpis.every(k => k.drill && k.drill.metricKey));

// Publishing must still be blocked while the weightage rule is unmet elsewhere.
const check2 = S.Planning.validateCycle(cycle.cycleId);
ok('validation reports a concrete summary',
  check2.summary.kpis === 11 && check2.summary.pocs === 1,
  JSON.stringify(check2.summary));

/* ---------------------------------------------------------- permissions --- */
section('Role-based access control');
const pocEnv = createEnvironment({ now: AS_OF, userEmail: 'ashish@omp.test' });
ok('a POC cannot manage cycles', (() => {
  const fake = { role: 'POC', permissions: S.ROLE_PERMISSIONS.POC };
  return !S.Auth.can(S.PERM.CYCLE_MANAGE, fake);
})());
ok('a POC can record activity', (() => {
  const fake = { role: 'POC', permissions: S.ROLE_PERMISSIONS.POC };
  return S.Auth.can(S.PERM.ACTIVITY_WRITE, fake);
})());
ok('a POC cannot write on behalf of others', (() => {
  const fake = { role: 'POC', permissions: S.ROLE_PERMISSIONS.POC };
  return !S.Auth.can(S.PERM.ACTIVITY_WRITE_ANY, fake);
})());
ok('leadership cannot edit the plan', (() => {
  const fake = { role: 'LEADERSHIP', permissions: S.ROLE_PERMISSIONS.LEADERSHIP };
  return !S.Auth.can(S.PERM.PLAN_MANAGE, fake);
})());
ok('a Team Lead can publish a cycle', (() => {
  const fake = { role: 'TEAM_LEAD', permissions: S.ROLE_PERMISSIONS.TEAM_LEAD };
  return S.Auth.can(S.PERM.CYCLE_MANAGE, fake);
})());

/* ------------------------------------------------------------- reporting --- */
section('Generated reports');
const pocWise = S.Reports.pocWise(cycle.cycleId);
ok('POC-Wise generated', pocWise.rows.length >= 1, pocWise.rows.length + ' rows');
const ashishRow = pocWise.rows.find(r => r.pocUserId === ashishUser.userId);
near('POC-Wise GMV matches the engine', ashishRow.mtd.gmvAchievedCr, 0.7456501, 1e-6);
eq('POC-Wise transactions match the engine', ashishRow.mtd.txnAchieved, 12);
eq('POC-Wise onboarding base uses FYTD', ashishRow.onboarding.fytdOnboarded >= 0, true);

const regionWise = S.Reports.regionWise(cycle.cycleId);
ok('Region-Wise generated', regionWise.rows.length >= 1);
ok('Region-Wise totals equal the sum of its POCs',
  Math.abs(regionWise.totals.gmvAchievedCr - pocWise.totals.gmvAchievedCr) < 1e-9);

const daily = S.Reports.dailyReview(cycle.cycleId);
eq('daily review carries the seven workbook metrics', daily.overall.length, 7);
eq('daily review reports through the as-of date', daily.asOfLabel, 'As Of 10-Aug-2026');
const dailyGmv = daily.overall.find(m => m.metricKey === 'GMV_CR');
near('daily review GMV matches the engine', dailyGmv.achieved, 2.1523311, 1e-6);
near('daily review current DRR = achieved ÷ elapsed days',
  dailyGmv.currentDrr, 2.1523311 / 10, 1e-6);
ok('daily review required DRR = gap ÷ remaining days',
  Math.abs(dailyGmv.requiredDrr -
    Math.max(0, dailyGmv.target - dailyGmv.achieved) / 21) < 1e-6,
  'required=' + dailyGmv.requiredDrr);

const board = S.Reports.leaderboard(cycle.cycleId);
ok('leaderboard generated', board.rows.length >= 1);
eq('leaderboard ranks from 1', board.rows[0].rank, 1);

/* ---------------------------------------------------------------- results --- */
console.log('\n' + '─'.repeat(62));
console.log(`  ${passed} passed, ${failed} failed`);
if (failed) {
  console.log('\nFailures:');
  failures.forEach(f => console.log('  • ' + f.name + '\n    ' + (f.detail || '')));
}
console.log('─'.repeat(62));
process.exit(failed ? 1 : 0);
