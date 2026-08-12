/**
 * generic-engine.test.js — Validates the config-driven Business Function layer.
 *
 * Where engine.test.js proves the LEGACY (OMP) engine reproduces the source
 * workbook's own numbers, this file proves the GENERIC engine — the path a
 * business function beyond OMP-Metal/Plastic uses — computes correctly from
 * nothing but declarative DB_BusinessFunctions / DB_ActivityTypeDef /
 * DB_MetricDef rows, with zero hand-written calculation code. It also proves
 * a genuinely new (5th) business function can be created, taught its
 * taxonomy, planned and operated purely through the API — the literal claim
 * behind this whole layer.
 *
 * Run: node tests/generic-engine.test.js
 */

const { createEnvironment } = require('./gas-harness');

const AS_OF = '2026-08-11T09:00:00';

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
  ok(name, delta <= tolerance, `expected ${expected}, got ${actual} (delta ${delta})`);
}
function section(title) { console.log('\n' + title); }

/* -------------------------------------------------------------- setup --- */
section('Bootstrapping with the Business Function layer');

const env = createEnvironment({ now: AS_OF, userEmail: 'lead@omp.test' });
const S = env.sandbox;
S.PropertiesService.getScriptProperties().setProperty('OMP_BOOTSTRAP_ADMIN', 'lead@omp.test');
S.Bootstrap.setup({});

const bfs = S.BusinessFunction.list();
eq('four business functions are seeded', bfs.length, 4);
ok('Plastic is LEGACY', S.BusinessFunction.get('Plastic').calculatorMode === 'LEGACY');
ok('Metal is LEGACY', S.BusinessFunction.get('Metal').calculatorMode === 'LEGACY');
ok('ONBOARDING is GENERIC', S.BusinessFunction.get('ONBOARDING').calculatorMode === 'GENERIC');
ok('COLLECTIONS is GENERIC', S.BusinessFunction.get('COLLECTIONS').calculatorMode === 'GENERIC');
ok('BusinessFunction.isGeneric agrees', S.BusinessFunction.isGeneric('COLLECTIONS') && !S.BusinessFunction.isGeneric('Plastic'));

/** Switch the harness's active identity — the harness bakes one email in at
 *  creation, so later "as this user" calls monkey-patch Session directly. */
function actAs(email) {
  S.Session.getActiveUser = () => ({ getEmail: () => email });
  S.Session.getEffectiveUser = () => ({ getEmail: () => email });
  S.Auth.reset();
}

/* ------------------------------------------------------- plan Collections --- */
section('Planning a GENERIC cycle (Collections)');

const region = S.Repository.where('DB_Regions', { category: 'COLLECTIONS' })[0];
ok('a region was auto-seeded for Collections', !!region);

const cycle = S.Planning.createCycle({ category: 'COLLECTIONS', year: 2026, month: 8 });
eq('cycle created in DRAFT', cycle.status, 'DRAFT');

const poc = S.Admin.saveUser({
  fullName: 'Priya Collections', email: 'priya@omp.test', role: 'POC',
  category: 'COLLECTIONS', regionId: region.regionId, stream: 'GENERAL'
});

const tree = S.Planning.getKraTree(cycle.cycleId);
eq('three KRAs cloned from the Collections library', tree.length, 3);
const totalWeight = tree.reduce((t, k) => t + k.totalWeightage, 0);
eq('weightage totals 100 across the single GENERAL stream', totalWeight, 100);

const kpiIds = tree.flatMap(k => k.kpis.map(p => p.kpiId));
S.Planning.assignKpis({ cycleId: cycle.cycleId, pocUserIds: [poc.userId], kpiIds });

const validation = S.Planning.validateCycle(cycle.cycleId);
ok('cycle validates cleanly (no ACCOUNT_PLAN/BALANCE_PLUS_MTD demands)', validation.valid,
  JSON.stringify(validation.errors));

const published = S.Planning.publishCycle(cycle.cycleId);
eq('cycle publishes', published.status, 'PUBLISHED');

/* -------------------------------------------------- record generic activity --- */
section('Recording activity as a POC and auto-linking to the assigned KPI');

actAs('priya@omp.test');

const a1 = S.Activity.save({
  activityType: 'PAYMENT_RECEIVED', cycleId: cycle.cycleId, activityDate: '2026-08-05',
  amount: 50000, subjectName: 'Acme Traders', remarks: 'Partial payment',
  evidenceUrl: 'https://example.com/r1'
});
const a2 = S.Activity.save({
  activityType: 'PAYMENT_RECEIVED', cycleId: cycle.cycleId, activityDate: '2026-08-07',
  amount: 75000, subjectName: 'Beta Corp', remarks: 'Full settlement',
  evidenceUrl: 'https://example.com/r2'
});
// Outside the cycle's backdate window from "today" (2026-08-11) is fine here
// (both dates are within 7 days), but outside the *metric's* MTD window would
// still count towards TXN totals if mis-scoped — the window test below checks that.
S.Activity.save({
  activityType: 'FOLLOW_UP_CALL', cycleId: cycle.cycleId, activityDate: '2026-08-06',
  subjectName: 'Gamma Ltd', remarks: 'Called about overdue invoice'
});
S.Activity.save({
  activityType: 'DISPUTE_LOGGED', cycleId: cycle.cycleId, activityDate: '2026-08-04',
  subjectName: 'Delta Inc', remarks: 'Disputed invoice amount', evidenceUrl: 'https://example.com/d1'
});
S.Activity.save({
  activityType: 'DISPUTE_RESOLVED', cycleId: cycle.cycleId, activityDate: '2026-08-08',
  subjectName: 'Delta Inc', remarks: 'Resolved after review', evidenceUrl: 'https://example.com/d2'
});

eq('a PAYMENT_RECEIVED row auto-links to the Amount Collected KPI',
  a1.metricKey, 'AMOUNT_COLLECTED_INR');
ok('the KPI id was resolved, not left blank', !!a1.kpiId);
eq('measureA on the raw row carries the payment amount',
  S.Repository.findById('DB_Activities', a1.activityId).measureA, 50000);
eq('a subjectName-only row has no accountId (no DB_Accounts entity for Collections)',
  a1.accountId, '');

/* --------------------------------------------------- COUNT / SUM / RATIO --- */
section('GenericEngine aggregations, computed purely from DB_MetricDef');

const win = S.DateUtil.cycleWindow(2026, 8, S.DateUtil.asOf());
const scope = S.Engine.scope({ category: 'COLLECTIONS', stream: 'GENERAL', pocUserId: poc.userId });

const amount = S.Engine.metric('AMOUNT_COLLECTED_INR', win, scope, { trace: true });
near('SUM: amount collected = 50000 + 75000', amount.value, 125000);
eq('SUM: two contributing rows', amount.count, 2);
ok('SUM: contributors carry an account/subject name for drilldown',
  amount.contributors.every(c => c.accountName));

const followUps = S.Engine.metric('FOLLOW_UPS_MADE', win, scope, { trace: false });
eq('COUNT: one follow-up call', followUps.value, 1);

const disputeRate = S.Engine.metric('DISPUTE_RESOLUTION_RATE_PCT', win, scope, { trace: false });
near('RATIO: 1 resolved / 1 logged × 100 = 100', disputeRate.value, 100);
eq('RATIO: numerator/denominator recorded in meta', disputeRate.meta.numerator.value, 1);

/* ----------------------------------------------------------- scoping --- */
section('Window and scope isolation');

const otherPocScope = S.Engine.scope({ category: 'COLLECTIONS', stream: 'GENERAL', pocUserId: 'NOBODY' });
const otherPocAmount = S.Engine.metric('AMOUNT_COLLECTED_INR', win, otherPocScope, { trace: false });
eq('an unrelated POC scope sees none of these activities', otherPocAmount.value, 0);

const julyWindow = S.DateUtil.window('MONTH', new Date(2026, 6, 15));
const julyAmount = S.Engine.metric('AMOUNT_COLLECTED_INR', julyWindow, scope, { trace: false });
eq('a window before the activities were logged sees nothing', julyAmount.value, 0);

const onboardingScope = S.Engine.scope({ category: 'ONBOARDING', stream: 'GENERAL' });
const onboardingSeesCollections = S.Engine.metric('APPLICATIONS_RECEIVED', win, onboardingScope, { trace: false });
eq('a different business function\'s facts stay isolated', onboardingSeesCollections.value, 0);

/* --------------------------------------------------------- drilldown --- */
section('Drilldown resolves through Activity.drilldown exactly like OMP');

const dd = S.Activity.drilldown({ cycleId: cycle.cycleId, metricKey: 'AMOUNT_COLLECTED_INR', pocUserId: poc.userId });
near('drilldown value matches the metric', dd.value, 125000);
eq('drilldown lists both contributing records', dd.records.length, 2);
ok('drilldown records carry the subject name (no account, so it falls back)',
  dd.records.some(r => r.accountName === 'Acme Traders'));

/* --------------------------------------------------------- scorecard --- */
section('Scorecard and executive dashboard both work end-to-end');

const card = S.Reports.scorecardFor(cycle.cycleId, poc.userId);
eq('scorecard carries all three assigned KPIs', card.kpis.length, 3);
ok('weightage totals 100', Math.abs(card.summary.totalWeightage - 100) < 0.01);

actAs('lead@omp.test');
const dashRes = S.api('dashboard.executive', { cycleId: cycle.cycleId });
ok('dashboard.executive succeeds for a GENERIC business function (no hardcoded OMP metrics)', dashRes.ok,
  JSON.stringify(dashRes.error));
if (dashRes.ok) {
  ok('dashboard tiles are built from the cycle\'s own KPIs', dashRes.data.tiles.length === 3);
}

/* ------------------------------------------------------------ DERIVED --- */
section('DERIVED aggregation and the safe expression evaluator');

S.api('metricDef.save', {
  businessFunctionId: 'COLLECTIONS', metricKey: 'NET_COLLECTION_INR', label: 'Net of Disputes',
  unit: 'INR', direction: 'HIGHER_BETTER', aggregation: 'DERIVED',
  expression: 'AMOUNT_COLLECTED_INR - (DISPUTES_LOGGED * 1000)'
});
const derived = S.Engine.metric('NET_COLLECTION_INR', win, scope, { trace: false });
near('DERIVED: 125000 - (1 * 1000) = 124000', derived.value, 124000);

ok('a malformed expression is rejected at save time', (() => {
  const res = S.api('metricDef.save', {
    businessFunctionId: 'COLLECTIONS', metricKey: 'BROKEN_METRIC', label: 'Broken',
    unit: 'INR', direction: 'HIGHER_BETTER', aggregation: 'DERIVED',
    expression: 'AMOUNT_COLLECTED_INR + ('
  });
  return res.ok === false && res.error.code === 'BAD_EXPRESSION';
})());

/* --------------------------------------------------- collision guards --- */
section('Config-authored keys cannot collide with built-in OMP keys');

ok('an activity type key colliding with OMP\'s ACTIVITY_TYPE is rejected', (() => {
  const res = S.api('activityTypeDef.save', {
    businessFunctionId: 'COLLECTIONS', activityTypeId: 'PAYMENT_COLLECTED', label: 'Clash',
    evidence: 'NONE', requiresAccount: false, measures: []
  });
  return res.ok === false && res.error.code === 'VALIDATION';
})());

ok('a metric key colliding with a built-in OMP metric is rejected', (() => {
  const res = S.api('metricDef.save', {
    businessFunctionId: 'COLLECTIONS', metricKey: 'GMV_CR', label: 'Clash',
    unit: 'INR', direction: 'HIGHER_BETTER', aggregation: 'COUNT', sourceActivityType: 'PAYMENT_RECEIVED'
  });
  return res.ok === false && res.error.code === 'VALIDATION';
})());

/* --------------------------------------------- a genuinely new function --- */
section('Onboarding a 5th business function through configuration alone');

const bfRes = S.api('businessFunction.save', {
  businessFunctionId: 'RETURNS', name: 'Returns & Refunds', streamMode: 'SINGLE', generalLabel: 'Returns'
});
ok('the new business function is created', bfRes.ok);
eq('it defaults to GENERIC (LEGACY is reserved for OMP)', bfRes.data.calculatorMode, 'GENERIC');

S.api('activityTypeDef.save', {
  businessFunctionId: 'RETURNS', activityTypeId: 'RETURN_PROCESSED', label: 'Return Processed',
  measures: [{ key: 'refundAmount', label: 'Refund Amount', unit: '₹', column: 'measureA' }],
  requiresAccount: false, evidence: 'REQUIRED'
});
S.api('metricDef.save', {
  businessFunctionId: 'RETURNS', metricKey: 'REFUND_AMOUNT_INR', label: 'Refund Amount',
  unit: 'INR', direction: 'LOWER_BETTER', aggregation: 'SUM',
  sourceActivityType: 'RETURN_PROCESSED', measureField: 'measureA'
});

const returnsCycleRes = S.api('cycle.create', { category: 'RETURNS', year: 2026, month: 8 });
ok('a cycle can be created for the new function', returnsCycleRes.ok);
const returnsTreeRes = S.api('kra.tree', { cycleId: returnsCycleRes.data.cycleId });
eq('no seed library — a brand-new function starts empty, not broken', returnsTreeRes.data.length, 0);

const kraRes = S.api('kra.save', {
  cycleId: returnsCycleRes.data.cycleId, kraName: 'Refund Control', stream: 'GENERAL', perspective: 'Process'
});
ok('a KRA can be hand-built exactly like an OMP one', kraRes.ok);
const kpiRes = S.api('kpi.save', {
  kraId: kraRes.data.kraId, kpiName: 'Refund Amount', metricKey: 'REFUND_AMOUNT_INR',
  weightage: 100, targetBasis: 'MANUAL', targets: [50000, 40000, 30000, 20000, 10000]
});
ok('a KPI referencing the new metric saves without engine changes', kpiRes.ok,
  JSON.stringify(kpiRes.error));

ok('a KRA on a SUPPLY_DEMAND-only stream is rejected for a SINGLE-stream function', (() => {
  const res = S.api('kra.save', {
    cycleId: returnsCycleRes.data.cycleId, kraName: 'Bad Stream', stream: 'SUPPLY', perspective: 'Process'
  });
  return res.ok === false && res.error.code === 'VALIDATION';
})());

/* -------------------------------------------------------- LEGACY intact --- */
section('The LEGACY (OMP) path is untouched by any of the above');

ok('OMP metrics are still computed by the hand-written switch, not the generic engine', (() => {
  const plasticScope = S.Engine.scope({ category: 'Plastic', stream: 'SUPPLY' });
  // GMV_CR has no DB_MetricDef row — if the dispatcher ever misrouted a LEGACY
  // category to the generic engine this would throw UNKNOWN_METRIC.
  const r = S.Engine.metric('GMV_CR', win, plasticScope, { trace: false });
  return typeof r.value === 'number';
})());

/* ------------------------------------------------------------- summary --- */
console.log('\n' + '─'.repeat(64));
console.log(`  ${passed} passed, ${failed} failed`);
console.log('─'.repeat(64));
if (failed) {
  console.log('\nFailures:');
  failures.forEach(f => console.log(`  ✗ ${f.name}\n      ${f.detail || ''}`));
  process.exit(1);
}
