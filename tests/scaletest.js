/* Exercises the REAL isRatioLadder_ / applyRatingScale_ out of Code.gs against
   the 16 ladders the workbook actually holds, with only the sheet layer stubbed.

   The decision being enforced: THE FIGURE IN THE TARGET SHEET IS TARGET 4. For
   a KPI scored as a percentage of target, achieving it exactly is 100% and 100%
   rates 4 of 5. Thresholds 60/75/90/100/105 — the workbook's own ladder, on 106
   of the 208 assignments in the snapshot.

   Corrected on 15 Sep 2026. The earlier scale (80/90/100/110/120, on target =
   3) put on-target a rung too low; the assertions below are written so that
   reverting to it fails loudly rather than quietly re-rating everybody.

   The danger being guarded: rewriting a ladder that is NOT a percentage of
   target. "15 | 10 | 5 | 3 | 2" is DSO in DAYS — replacing it with 0.6..1.05
   would score a 20-day DSO as 2000% of target. */
var ROOT = require('path').join(__dirname, '..');
var fs = require('fs');
var src = fs.readFileSync(require('path').join(ROOT, 'Code.gs'), 'utf8').replace(/\r\n/g, '\n');
function grab(a, b) {
  var i = src.indexOf(a); if (i < 0) throw new Error('missing anchor: ' + a);
  var j = src.indexOf(b, i); if (j < 0) throw new Error('missing anchor: ' + b);
  return src.slice(i, j);
}
var page = fs.readFileSync(require('path').join(ROOT, 'Index.html'), 'utf8').replace(/\r\n/g, '\n');
function grabPage(a, b) {
  var i = page.indexOf(a); if (i < 0) throw new Error('missing page anchor: ' + a);
  var j = page.indexOf(b, i); if (j < 0) throw new Error('missing page anchor: ' + b);
  return page.slice(i, j);
}

var T = { TARGETS: 'TARGETS', PLAN: 'PLAN', KPIS: 'KPIS', EMPLOYEES: 'EMPLOYEES' };
var DB = {}, _DIRTY = {};
function read_(name) { return DB[name] || []; }
function ensureSeeded_() { return false; }
function commit_() { commits++; return 1; }
function currentEmail_() { return 'tester@recykal.com'; }
function nowIso_() { return '2026-09-15T00:00:00.000Z'; }
var audits = [], commits = 0;
function audit_(a, t, i, act, o, nn, r) { audits.push(act + ' ' + i + ' ' + o + ' -> ' + nn); }
var Logger = { log: function () {} };

eval(grab('function num_(v)', 'function slug_'));
eval(grab('function idx_(a)', 'function num_'));
eval(grab('var EMPTY_BAND', 'var LEVEL_LABELS'));
eval(grab('var RATING_SCALE', '/** The Target Sheet, all tabs. Read-only. */'));

var pass = 0, fail = 0;
function ck(label, got, want) {
  var ok = String(got) === String(want); ok ? pass++ : fail++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + ': ' + got + (ok ? '' : '   (want ' + want + ')'));
}

console.log('--- the scale itself ---');
ck('five thresholds', RATING_SCALE.join(' | '), '0.6 | 0.75 | 0.9 | 1.0 | 1.05');
ck('on target is the FOURTH rung', RATING_SCALE[3], '1.0');
ck('  and the code says which rung that is', RATING_ON_TARGET_, 4);
ck('  the third rung is 90% of target, as the KRA owner specified',
   RATING_SCALE[2], '0.9');
ck('  the fifth is 105%', RATING_SCALE[4], '1.05');
/* The exact ladder the workbook carries on 106 of 208 assignments. If this ever
   diverges, the app has started imposing a scale on the source again. */
ck('  it IS the workbook ladder, not one imposed on it',
   RATING_SCALE.map(Number).join(','), '0.6,0.75,0.9,1,1.05');

console.log('\n--- on target must score 4, using the real band engine ---');
var pr = parseBands_(RATING_SCALE);
ck('read as numeric', pr.kind, 'numeric');
ck('100% of target -> 4', levelFromBands_(pr, 1.0), 4);
ck(' 60% -> 1',            levelFromBands_(pr, 0.6), 1);
ck(' 75% -> 2',            levelFromBands_(pr, 0.75), 2);
ck(' 90% -> 3',            levelFromBands_(pr, 0.9), 3);
ck('105% -> 5',            levelFromBands_(pr, 1.05), 5);
ck('130% still 5, not 6',  levelFromBands_(pr, 1.3), 5);
console.log('  highest threshold CLEARED, not nearest:');
ck('  98% clears 90 but not 100 -> 3', levelFromBands_(pr, 0.98), 3);
ck('  104% -> 4, not rounded up to 5', levelFromBands_(pr, 1.04), 4);
/* below T1 is level 0 ("Below T1"), not null — null means UNSCORED */
ck('  59% is below every threshold -> 0', levelFromBands_(pr, 0.59), 0);

console.log('\n  the rung that moved — these fail if 80/90/100/110/120 returns:');
ck('  100% is NOT a 3 any more', levelFromBands_(pr, 1.0) === 3, false);
ck('  80% is no longer rung 1', levelFromBands_(pr, 0.8), 2);
ck('  120% is not needed for a 5', levelFromBands_(pr, 1.06), 5);

console.log('\n--- which of the 16 real ladders is a percentage of target ---');
function lad(a) { return isRatioLadder_(a); }
function yes(label, a) { ck(label, lad(a).ok, true); }
function no(label, a) { var r = lad(a); ck(label, r.ok, false); return r.why; }
yes('0.6 | 0.75 | 0.9 | 1.0 | 1.05   (106 rows)', ['0.6', '0.75', '0.9', '1.0', '1.05']);
yes('0.8 | 0.85 | 0.9 | 0.95 | 1.0   (61 rows)',  ['0.8', '0.85', '0.9', '0.95', '1.0']);
yes('0.8 | 0.85 | 0.9 | 1.0 | 1.05   (4 rows)',   ['0.8', '0.85', '0.9', '1.0', '1.05']);
yes('0.4 | 0.5 | 0.6 | 0.7 | 0.8     (4 rows)',   ['0.4', '0.5', '0.6', '0.7', '0.8']);
yes('0.0 | 0.15 | 0.3 | 0.5 | 0.7    (2 rows)',   ['0.0', '0.15', '0.3', '0.5', '0.7']);
yes('the scale itself is already one', RATING_SCALE);

console.log('  and the ones it must NOT touch:');
var w1 = no('15 | 10 | 5 | 3 | 2  (DSO days)', ['15.0', '10.0', '5.0', '3.0', '2.0']);
ck('  because they descend', /descend/.test(w1), true);
var w2 = no('0.013 | 0.012 | 0.01 | 0.008 | 0.006', ['0.013', '0.012', '0.01', '0.008', '0.006']);
ck('  also descending', /descend/.test(w2), true);
var w3 = no('12 | 10 | 8 | 7 | 5 Days', ['12 Days', '10 Days', '8 Days', '7 Days', '5 Days']);
ck('  because they are not numbers', /not a number/.test(w3), true);
no('> 28 Days | 25-28 Days | ... | <= 19 Days',
   ['> 28 Days', '25–28 Days', '21–24 Days', 'TGT-20 Days', '≤ 19 Days']);
no('>= 9 Cr | 8 Cr | 7 Cr | 6 Cr | < 5 Cr',
   ['≥ ₹9 Cr', '₹8 Cr', '₹7 Cr', '₹6 Cr', '< ₹5 Cr']);
no('10% of LD | 15% ... | 30% of LD',
   ['10% of LD', '15% of LD', '20% of LD', '25% of LD', '30% of LD']);
no('As per Collections Process | dashes',
   ['As per Collections Process', '—', '—', '—', '—']);
var w4 = no('an ASCENDING absolute ladder, e.g. 5 | 10 | 15 | 20 | 25 units',
            ['5', '10', '15', '20', '25']);
ck('  rejected on magnitude, not direction', /above 2/.test(w4), true);
ck('  200% exactly is still a ratio', lad(['0.5', '1.0', '1.5', '1.8', '2.0']).ok, true);
ck('  201% is not', lad(['0.5', '1.0', '1.5', '1.8', '2.01']).ok, false);

/* --- the migration ------------------------------------------------------- */
function reset() {
  DB[T.EMPLOYEES] = [{ id: 'E1', name: 'AMIT JHA' }, { id: 'E2', name: 'ASHISH KUMAR RAI' }];
  DB[T.KPIS] = [{ id: 'K_GMV', name: 'Monthly Target Achievement (%)' },
                { id: 'K_DSO', name: 'Days Sales Outstanding (DSO)' },
                { id: 'K_TXT', name: 'Collections Process Adherence' }];
  DB[T.TARGETS] = [
    /* THE 10 SEP SCALE, which is what most live rows now carry -> rewrite back */
    { id: 'T1', employee_id: 'E1', kpi_id: 'K_GMV', period_id: 'per_2026-08',
      t1: '0.8', t2: '0.9', t3: '1.0', t4: '1.1', t5: '1.2', version: 1 },
    /* another ratio ladder, also with a target -> rewrite */
    { id: 'T2', employee_id: 'E2', kpi_id: 'K_GMV', period_id: 'per_2026-08',
      t1: '0.8', t2: '0.85', t3: '0.9', t4: '0.95', t5: '1.0', version: 3 },
    /* DSO days WITH a target -> must be LEFT ALONE */
    { id: 'T3', employee_id: 'E1', kpi_id: 'K_DSO', period_id: 'per_2026-08',
      t1: '15.0', t2: '10.0', t3: '5.0', t4: '3.0', t5: '2.0', version: 1 },
    /* text ladder with a target -> left alone */
    { id: 'T4', employee_id: 'E1', kpi_id: 'K_TXT', period_id: 'per_2026-08',
      t1: 'As per Collections Process', t2: '—', t3: '—', t4: '—', t5: '—', version: 1 },
    /* ratio ladder with NO target -> nothing to be a percentage OF */
    { id: 'T5', employee_id: 'E2', kpi_id: 'K_GMV', period_id: 'per_2026-09',
      t1: '0.8', t2: '0.9', t3: '1.0', t4: '1.1', t5: '1.2', version: 1 },
    /* already on the scale — i.e. already the workbook's own ladder */
    { id: 'T6', employee_id: 'E1', kpi_id: 'K_GMV', period_id: 'per_2026-07',
      t1: '0.6', t2: '0.75', t3: '0.9', t4: '1.0', t5: '1.05', version: 2 }
  ];
  DB[T.PLAN] = [
    { employee_id: 'E1', kpi_id: 'K_GMV', period_id: 'per_2026-08', target_value: 6.5 },
    { employee_id: 'E2', kpi_id: 'K_GMV', period_id: 'per_2026-08', target_value: 8 },
    { employee_id: 'E1', kpi_id: 'K_DSO', period_id: 'per_2026-08', target_value: 3 },
    { employee_id: 'E1', kpi_id: 'K_TXT', period_id: 'per_2026-08', target_value: 1 },
    { employee_id: 'E1', kpi_id: 'K_GMV', period_id: 'per_2026-07', target_value: 5 }
  ];
  _DIRTY = {}; audits = []; commits = 0;
}
function bands(id) {
  var t = DB[T.TARGETS].filter(function (x) { return x.id === id; })[0];
  return ladderKey_(t);
}

console.log('\n--- the DRY RUN writes nothing ---');
reset();
var dry = previewRatingScale();
ck('says so', /NOTHING WAS WRITTEN/.test(dry), true);
ck('reports 2 rewrites', /2 target rows rewritten/.test(dry), true);
ck('  and 1 already on the scale', /1 already on the scale/.test(dry), true);
ck('T1 untouched', bands('T1'), '0.8 | 0.9 | 1.0 | 1.1 | 1.2');
ck('nothing committed', commits, 0);
ck('nothing marked dirty', Object.keys(_DIRTY).length, 0);
ck('the DSO skip is explained', /absolute ladder/.test(dry), true);
ck('the no-target skip is explained', /no numeric target/.test(dry), true);

console.log('\n--- the real write ---');
reset();
var got = applyRatingScale();
ck('T1 rewritten', bands('T1'), '0.6 | 0.75 | 0.9 | 1.0 | 1.05');
ck('T2 rewritten too', bands('T2'), '0.6 | 0.75 | 0.9 | 1.0 | 1.05');
ck('T3 DSO DAYS LEFT ALONE', bands('T3'), '15.0 | 10.0 | 5.0 | 3.0 | 2.0');
ck('T4 text ladder left alone', bands('T4'), 'As per Collections Process | — | — | — | —');
ck('T5 has no target, so left alone', bands('T5'), '0.8 | 0.9 | 1.0 | 1.1 | 1.2');
ck('T6 already correct, not double-counted', bands('T6'), '0.6 | 0.75 | 0.9 | 1.0 | 1.05');
ck('committed once', commits, 1);
ck('two audit entries', audits.length, 2);
ck('  the audit records the OLD ladder',
   /0.8 \| 0.9 \| 1.0 \| 1.1 \| 1.2 -> 0.6 \| 0.75 \| 0.9 \| 1.0 \| 1.05/.test(audits[0]), true);
ck('version bumped on a rewrite',
   DB[T.TARGETS].filter(function (x) { return x.id === 'T2'; })[0].version, 4);
ck('version untouched on a skip',
   DB[T.TARGETS].filter(function (x) { return x.id === 'T3'; })[0].version, 1);
ck('reports the write', /WRITTEN: 2 target rows/.test(got), true);

console.log('\n--- running it twice must not change anything the second time ---');
var again = applyRatingScale();
ck('nothing left to rewrite', /WRITTEN: 0 target rows/.test(again), true);
ck('T1 unchanged', bands('T1'), '0.6 | 0.75 | 0.9 | 1.0 | 1.05');
ck('no new audit entries', audits.length, 2);

console.log('\n--- idempotent AFTER A SPREADSHEET ROUND TRIP, which is the real test ---');
/* The first live run rewrote all 166 rows a SECOND time. Sheets stores the
   string '1.0' as a number and returns 1, so a text comparison against the
   scale never matched an already-migrated row. Nothing in an in-memory suite
   round-trips through a spreadsheet, so simulate it. */
reset();
DB[T.TARGETS] = [
  /* exactly what Sheets hands back after a successful migration */
  { id: 'R1', employee_id: 'E1', kpi_id: 'K_GMV', period_id: 'per_2026-08',
    t1: 0.6, t2: 0.75, t3: 0.9, t4: 1, t5: 1.05, version: 2 },
  /* and as text, with the trailing zero dropped */
  { id: 'R2', employee_id: 'E2', kpi_id: 'K_GMV', period_id: 'per_2026-08',
    t1: '0.6', t2: '0.75', t3: '0.9', t4: '1', t5: '1.05', version: 2 }
];
ck('the numbers-from-Sheets row reads as on-scale',
   isOnRatingScale_(DB[T.TARGETS][0]), true);
ck('  even though its text form differs', ladderKey_(DB[T.TARGETS][0]),
   '0.6 | 0.75 | 0.9 | 1 | 1.05');
ck('the "1" text row too', isOnRatingScale_(DB[T.TARGETS][1]), true);
var third = applyRatingScale();
ck('neither is rewritten', /WRITTEN: 0 target rows/.test(third), true);
ck('  both counted as already on the scale', /2 already on the scale/.test(third), true);
ck('  versions untouched', DB[T.TARGETS][0].version + '/' + DB[T.TARGETS][1].version, '2/2');
ck('  and no audit spam', audits.length, 0);

console.log('\n--- but a row genuinely off the scale is still caught ---');
ck('one band different is NOT on-scale',
   isOnRatingScale_({ t1: 0.6, t2: 0.75, t3: 0.9, t4: 1, t5: 1.2 }), false);
ck('a blank band is NOT on-scale',
   isOnRatingScale_({ t1: 0.6, t2: 0.75, t3: '', t4: 1, t5: 1.05 }), false);
ck('the 10 Sep imposed ladder is NOT on-scale',
   isOnRatingScale_({ t1: 0.8, t2: 0.9, t3: 1, t4: 1.1, t5: 1.2 }), false);

console.log('\n--- a target with NO ladder can never be rated, and must be named ---');
/* The framework re-import surfaced 30 real rows like this: a numeric target on
   screen with an empty ladder behind it. It reads as scored and never rates. */
reset();
DB[T.TARGETS].push({ id: 'T7', employee_id: 'E1', kpi_id: 'K_GMV', period_id: 'per_2026-06',
  t1: '', t2: '', t3: '', t4: '', t5: '', version: 1 });
DB[T.TARGETS].push({ id: 'T8', employee_id: 'E2', kpi_id: 'K_GMV', period_id: 'per_2026-06',
  t1: '—', t2: '—', t3: '—', t4: '—', t5: '—', version: 1 });
DB[T.PLAN].push({ employee_id: 'E1', kpi_id: 'K_GMV', period_id: 'per_2026-06', target_value: 4 });
DB[T.PLAN].push({ employee_id: 'E2', kpi_id: 'K_GMV', period_id: 'per_2026-06', target_value: 9 });
var un = previewRatingScale();
/* Only the EMPTY one counts. A "—" ladder is not silently unscoreable: it
   parses as qualitative, so the app already flags it as awarded by hand. */
ck('the dash ladder is qualitative, not nothing',
   parseBands_(['—', '—', '—', '—', '—']).kind, 'qualitative');
ck('so exactly one row is reported', /1 rows have a NUMERIC TARGET but no usable/.test(un), true);
ck('  and it says EMPTY', /ladder is EMPTY/.test(un), true);
ck('  and the person is named', /AMIT JHA/.test(un), true);
ck('  and the KPI is named', /Monthly Target Achievement/.test(un), true);
ck('  neither was rewritten', bands('T7') + ' / ' + bands('T8'),
   ' |  |  |  |  / — | — | — | — | —');
ck('  it says how to fix them', /refreshFrameworkFromSource/.test(un), true);

console.log('\n--- a row with a real ladder is NOT called unscoreable ---');
reset();
var clean = previewRatingScale();
ck('nothing reported', /no usable/.test(clean), false);

console.log('\n--- floating-point error must not cost somebody a rating ---');
/* 5.85 Cr against a 6.50 Cr target is exactly 90%, but the division evaluates
   to 0.8999999999999999. Before bandEps_ this scored a rung low, and nothing on
   screen would have explained why. */
ck('the raw division really does fall short', 5.85 / 6.5 >= 0.9, false);
ck('  yet it must still rate 3', levelFromBands_(pr, 5.85 / 6.5), 3);
ck('  7.15/6.5 rates 5', levelFromBands_(pr, 7.15 / 6.5), 5);
ck('  a GENUINE near miss is still a miss', levelFromBands_(pr, 0.8999), 2);
ck('  the tolerance is tiny, not generous', levelFromBands_(pr, 0.99999), 3);
/* lower_is_better goes through the same tolerance */
var dsoP = parseBands_(['15', '10', '5', '3', '2']);
ck('  DSO ladder still reads lower-is-better', dsoP.direction, 'lower_is_better');
ck('  a DSO of exactly 5.0 clears the 5 band', levelFromBands_(dsoP, 15 / 3), 3);

console.log('\n--- the point of it all: the Target Sheet figure IS Target 4 ---');
ck('6.50 Cr against a 6.50 Cr target', levelFromBands_(pr, 6.5 / 6.5), 4);
ck('  7.15 Cr (110%)', levelFromBands_(pr, 7.15 / 6.5), 5);
ck('  5.85 Cr (90%)  is Target 3, as specified', levelFromBands_(pr, 5.85 / 6.5), 3);
ck('  6.83 Cr (105%) is Target 5, as specified', levelFromBands_(pr, 6.825 / 6.5), 5);
ck('  it was only a 3 under the 10 Sep ladder',
   levelFromBands_(parseBands_(['0.8', '0.9', '1.0', '1.1', '1.2']), 1.0), 3);
ck('  every ratio-scored rating therefore moved up one rung',
   levelFromBands_(pr, 1.0) - levelFromBands_(parseBands_(['0.8', '0.9', '1.0', '1.1', '1.2']), 1.0), 1);

/* --- the ladder as the reader sees it ------------------------------------ */
console.log('\n--- the rungs, derived back into real units (Index.html) ---');
/* "Calculate the 90% of the target which will be the Target 3." The scoring
   divides achieved by target, which is the same arithmetic in one step — but
   nobody carries a target as 0.9, so the page derives the figures back. */
eval(grabPage('function fmtTarget(',
              '/* Every filtered row that HAS a numeric target'));

var gmv = { values: [0.6, 0.75, 0.9, 1.0, 1.05], plan_target: 6.5, plan_unit: 'Cr' };
ck('a 6.50 Cr target becomes five real figures',
   ladderInUnits(gmv).join(' | '), '3.90 Cr | 4.88 Cr | 5.85 Cr | 6.50 Cr | 6.83 Cr');
ck('  Target 4 is the Target Sheet figure itself', ladderInUnits(gmv)[3], '6.50 Cr');
ck('  Target 3 is 90% of it', ladderInUnits(gmv)[2], '5.85 Cr');
ck('  Target 5 is 105% of it', ladderInUnits(gmv)[4], '6.83 Cr');

var sellers = { values: [0.6, 0.75, 0.9, 1.0, 1.05], plan_target: 9, plan_unit: 'count' };
ck('a count target works the same way',
   ladderInUnits(sellers).join(' | '), '5.4 | 6.75 | 8.1 | 9 | 9.45');

console.log('  and it must REFUSE to rescale anything that is not a ratio:');
ck('a DSO ladder in days is left alone',
   ladderInUnits({ values: [15, 10, 5, 3, 2], plan_target: 3, plan_unit: 'days' }), null);
ck('  an ascending ABSOLUTE ladder too',
   ladderInUnits({ values: [5, 10, 15, 20, 25], plan_target: 20, plan_unit: 'count' }), null);
ck('  a text ladder has no numeric values',
   ladderInUnits({ values: [null, null, null, null, null], plan_target: 4 }), null);
ck('  no target means nothing to take a percentage OF',
   ladderInUnits({ values: [0.6, 0.75, 0.9, 1.0, 1.05], plan_target: null }), null);
ck('  and a target of zero is not a denominator',
   ladderInUnits({ values: [0.6, 0.75, 0.9, 1.0, 1.05], plan_target: 0 }), null);
ck('  a partly-empty ladder is refused rather than half-derived',
   ladderInUnits({ values: [0.6, null, 0.9, 1.0, 1.05], plan_target: 6.5 }), null);
/* the derived figure must be what the engine would actually rate */
ck('the derived Target 3 really does rate 3',
   levelFromBands_(pr, 5.85 / 6.5), 3);
ck('  and a hair under it does not', levelFromBands_(pr, 5.84 / 6.5), 2);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
