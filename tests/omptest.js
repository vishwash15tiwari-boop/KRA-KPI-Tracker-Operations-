/* THE OMP RULES, case by case.

   Three rulings decide every Control Tower rate, and two of them are the kind
   that look obvious and are not:

     - cancelled / draft / ready-to-dispatch leave the DENOMINATOR. They are
       not misses. A rule that counted them as misses would mark somebody down
       for a shipment the buyer cancelled.

     - a current-month shipment is not scored at all, and a prior-month
       shipment still moving after more than ten days is DELAYED.

     - and the part that was NOT stated and had to be decided: ten days
       measured to WHAT. Measured to "now", a past month's rating changes every
       time the import runs — a shipment sitting at nine days when August was
       first scored crosses ten the next day and silently marks August down.
       The clock therefore stops at month end plus the grace. The stability
       test at the bottom is the one that matters: it asserts the same month
       scores the same whenever it is run.

   Every function here is the real one, lifted from Code.gs. */
var ROOT = require('path').join(__dirname, '..');
var fs = require('fs');
var src = fs.readFileSync(require('path').join(ROOT, 'Code.gs'), 'utf8')
  .replace(/\r\n/g, '\n');
function grab(a, b) {
  var i = src.indexOf(a); if (i < 0) throw new Error('missing anchor: ' + a);
  var j = src.indexOf(b, i); if (j < 0) throw new Error('missing anchor: ' + b);
  return src.slice(i, j);
}

var pass = 0, fail = 0;
function ck(label, got, want) {
  var ok = String(got) === String(want); ok ? pass++ : fail++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + ': ' + got + (ok ? '' : '   (want ' + want + ')'));
}

/* --- the Apps Script surface these touch, stubbed ---------------------- */
var Session = { getScriptTimeZone: function () { return 'Asia/Kolkata'; } };
var Utilities = {
  formatDate: function (d, tz, fmt) {
    function p(n) { return (n < 10 ? '0' : '') + n; }
    if (fmt === 'yyyy-MM') return d.getFullYear() + '-' + p(d.getMonth() + 1);
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }
};
eval(grab('function isoDay_(v) {', 'function cellDate_('));
eval(grab('function cellDate_(v) {', 'function col_('));
eval(grab('var OMP_NOT_COUNTED_STATUS_', 'function profileOmpTracker()'));

console.log('\n--- what counts, and what leaves the denominator ---');

ck('a reached shipment counts',              ompCounts_('REACHED', 'In Transit'), true);
ck('a dispatched one counts',                ompCounts_('DISPATCHED', 'In Transit'), true);
ck('one received by the recycler counts',    ompCounts_('RECEIVED_BY_RECYCLER', 'Delivered'), true);
ck('a completed one counts',                 ompCounts_('COMPLETED', 'Payment Released'), true);
ck('a cancelled one does NOT',               ompCounts_('CANCELLED', 'CANCELLED'), false);
ck('a draft does NOT',                       ompCounts_('DRAFT', 'Draft'), false);
ck('ready to dispatch does NOT',             ompCounts_('DRAFT', 'Ready to Dispatch'), false);
/* MM_CT says this twice and not identically: shipment_status has DRAFT but no
   ready-to-dispatch, shipment_stage_label has 'Ready to Dispatch' but buckets
   differently. Reading one column would let the other's spelling through. */
ck('  and BOTH columns are read, not just the status',
   ompCounts_('DISPATCHED', 'Ready to Dispatch'), false);
ck('  nor just the stage',                   ompCounts_('CANCELLED', 'In Transit'), false);
ck('spacing and case do not change the answer',
   ompCounts_('  cancelled  ', ''), false);
ck('ready FOR dispatch is the same thing as ready TO dispatch',
   ompCounts_('', 'Ready For Dispatch'), false);
ck('an underscored spelling too',            ompCounts_('', 'READY_TO_DISPATCH'), false);
/* A blank is not a state anybody ruled on. It must not be silently dropped —
   dropping rows quietly is how a denominator shrinks without anyone noticing. */
ck('a blank state still counts, and is somebody\'s to look at',
   ompCounts_('', ''), true);

console.log('\n--- the current month is not scored at all ---');

var AUG = new Date(2026, 7, 15), SEP = new Date(2026, 8, 15);
ck('August is closed when it is September', ompMonthClosed_('2026-08', SEP), true);
ck('  but not when it is still August',     ompMonthClosed_('2026-08', AUG), false);
ck('September is not closed in September',  ompMonthClosed_('2026-09', SEP), false);
ck('and a much older month is closed',      ompMonthClosed_('2026-05', SEP), true);
/* String comparison on yyyy-MM only orders correctly because the month is
   zero-padded. 2026-9 would sort after 2026-10. */
ck('the month id is zero padded, or the comparison is wrong',
   ompMonthClosed_('2026-09', new Date(2026, 9, 1)), true);

console.log('\n--- the cutoff: month end plus the grace ---');

ck('the grace is ten days', OMP_TRANSIT_GRACE_DAYS_, 10);
/* August closes on the 31st; +10 lands on 10 September. */
var cutAug = ompCutoff_('2026-08');
ck('August\'s clock stops on 10 Sep', Utilities.formatDate(cutAug, '', 'yyyy-MM-dd'), '2026-09-10');
var cutFeb = ompCutoff_('2026-02');
ck('  and February\'s on 10 Mar, whatever its length',
   Utilities.formatDate(cutFeb, '', 'yyyy-MM-dd'), '2026-03-10');
var cutDec = ompCutoff_('2026-12');
ck('  and December rolls into the next year',
   Utilities.formatDate(cutDec, '', 'yyyy-MM-dd'), '2027-01-10');
ck('a nonsense month has no cutoff', ompCutoff_('rubbish'), null);

console.log('\n--- in transit: delayed, pending, or not in transit at all ---');

function v(status, stage, dispatched, month) {
  return ompTransitVerdict_(status, stage, dispatched, month);
}
ck('a shipment that reached is not in transit',   v('REACHED', 'Delivered', new Date(2026,7,1), '2026-08'), null);
ck('a completed one is not either',               v('COMPLETED', 'Payment Released', new Date(2026,7,1), '2026-08'), null);
ck('a cancelled one is not either',               v('CANCELLED', 'CANCELLED', new Date(2026,7,1), '2026-08'), null);
/* August's clock stops on 10 Sep. Dispatched 1 Aug is 40 days — delayed. */
ck('dispatched on 1 Aug, still moving: delayed',  v('DISPATCHED', 'In Transit', new Date(2026,7,1), '2026-08').state, 'delayed');
ck('  and the days are reported',                 v('DISPATCHED', 'In Transit', new Date(2026,7,1), '2026-08').days, 40);
/* Dispatched 31 Aug is 10 days at the cutoff — NOT more than ten. */
ck('dispatched on the last day gets its full ten days',
   v('DISPATCHED', 'In Transit', new Date(2026,7,31), '2026-08').state, 'pending');
ck('  which is exactly ten, and ten is not "more than ten"',
   v('DISPATCHED', 'In Transit', new Date(2026,7,31), '2026-08').days, 10);
ck('eleven days is more than ten',
   v('DISPATCHED', 'In Transit', new Date(2026,7,30), '2026-08').state, 'delayed');
ck('the stage label alone is enough to say it is moving',
   v('', 'In Transit', new Date(2026,7,1), '2026-08').state, 'delayed');
ck('  as is the status alone',
   v('DISPATCHED', '', new Date(2026,7,1), '2026-08').state, 'delayed');
/* No dispatch date means the question cannot be answered. Saying "pending"
   would quietly forgive it; saying "delayed" would quietly punish it. */
ck('no dispatch date is UNKNOWN, not forgiven and not punished',
   v('DISPATCHED', 'In Transit', '', '2026-08').state, 'unknown');
ck('  and reports no day count',
   v('DISPATCHED', 'In Transit', '', '2026-08').days, null);

console.log('\n--- THE STABILITY PROPERTY ---');
/* This is the assertion the whole design of ompCutoff_ exists to satisfy. A
   rating that moves after the fact is not a rating. */
var a = v('DISPATCHED', 'In Transit', new Date(2026,7,25), '2026-08');
var b = v('DISPATCHED', 'In Transit', new Date(2026,7,25), '2026-08');
ck('the same shipment scores the same twice', a.state + '/' + a.days, b.state + '/' + b.days);
ck('  and the verdict takes no argument that could be "today"',
   /function ompTransitVerdict_\(status, stage, dispatchedOn, monthId\)/.test(src), true);
ck('  nor calls new Date() with no argument',
   /function ompTransitVerdict_[\s\S]{0,700}?new Date\(\)/.test(src), false);
/* The point is that nothing resembling "today" reaches it — not the exact
   signature. It gained an optional graceDays when the dispatch KPI needed a
   3-day window, and pinning the literal argument list failed that change for
   no reason. */
ck('the cutoff takes the month, and a grace, and nothing else',
   /function ompCutoff_\(monthId(, graceDays)?\) \{/.test(src), true);
ck('  and derives no part of itself from the clock',
   /function ompCutoff_[\s\S]{0,400}?new Date\(\)/.test(src), false);

console.log('\n--- the two who came off the team ---');
var lv = grab('var EMPLOYEE_LEAVERS = {', '};');
/* Keyed on normName_, so a spelling that is not listed is not hidden. Both the
   roster spelling and the tracker spelling have to be there. */
['MEGARAJ', 'MEGHRAJ', 'MEGHARAJ', 'RAJESWARI', 'RAJESHWARI'].forEach(function (k) {
  ck('  ' + k + ' is hidden', lv.indexOf("'" + k + "'") >= 0, true);
});
/* They were on the roster, so they are LEAVERS — hidden, rows intact. Kalyan
   never was, so he is an off-team ruling. Two mechanisms claiming one name is
   one more than can be kept true. */
var off = grab('var OMP_POC_OFF_TEAM_ = {', '};');
ck('Kalyan is an off-team ruling, not a leaver', off.indexOf("'KALYAN'") >= 0, true);
ck('  and is not also in the leavers table', lv.indexOf("'KALYAN'") >= 0, false);
['MEGARAJ', 'MEGHRAJ', 'MEGHARAJ', 'RAJESWARI', 'RAJESHWARI'].forEach(function (k) {
  ck('  ' + k + ' is NOT also an off-team ruling', off.indexOf("'" + k + "'") >= 0, false);
});
/* Hiding is not deleting, and the reason has to survive with the decision. */
ck('the leavers table still says why hiding beats deleting',
   src.indexOf('A leaver is HIDDEN, not deleted') >= 0, true);

console.log('\n--- the two-row header, and the column called "Actual" twice ---');
/* AJ is "Actual" under the banner "Reached"; AN is "Actual" under "Delivered".
   Matching row 2 alone picks whichever comes first — right today, wrong the
   day somebody reorders the sheet, and silent either way. */
eval(grab('var OMP_WANT_ = {', 'function ompTrackerGrid_('));
function labelsFor(bannerRow, headerRow) {
  var banners = [], carry = '';
  for (var b = 0; b < headerRow.length; b++) {
    var txt = String(bannerRow[b] == null ? '' : bannerRow[b]).trim();
    if (txt && num_(txt) === null) carry = txt;
    banners[b] = carry;
  }
  return headerRow.map(function (h, c) {
    h = String(h || '').trim();
    return h ? (banners[c] ? banners[c] + ' / ' + h : h) : '';
  });
}
function num_(v) {
  if (v === null || v === undefined || v === '') return null;
  var x = typeof v === 'number' ? v : Number(String(v).replace(/[,\s%₹]/g, ''));
  return isFinite(x) ? x : null;
}
/* the real shape, as describeOmpTracker printed it */
var BANNER = ['', '', '', '', '', '', '', '', '', '', '', '', '', '',
  148034.7, '', '', '', 'Aging ', '', 60680.95, '', 87353.75, '', '',
  'Payment Terms ', '', '', 'DISPATCH ', '', '', 'Vehcile Status ', '', '', '',
  'Reached ', '', '', '', 'Delivered ', '', '', '', '', '', 'Completed ', '',
  '', '', '', '', 215];
var HEADER = ['Vertcal ', 'Control - POC', 'Seller Name', 'SR POC', 'BR POC',
  'Buyer Name', 'SO Number', 'MM Date', 'PO Status', 'Shipment ID',
  'Agreement Shared to POC/Seller', 'Agreement signed', 'Margin status',
  'Revenue Comission ', 'Revenue Amount inc GST', 'Per Units',
  'Margin Invoice status', 'Revenue Inv Date', 'Revenue >15 days',
  'Revenue paid value', 'Revenue Paid date', 'Revenue Balance',
  'Invoice Number', 'Inv Date', 'Shipment Status', 'Payment Terms', 'Due Date',
  'Aging', 'Vehicle Images', 'Weighments', 'Invoice / EWB', 'Tracking',
  'Dispatch Date', 'Distance', 'Exp Date', 'Actual ', 'Portal', 'POD',
  'POD Doc', 'Actual', 'Portal', 'QC', 'DN', 'DN Status ', 'DN Remarks',
  'Date', 'Payment Status', 'Payment remarks ', 'Remarks',
  'Actual Dispatch status Remarks', 'Remarks', ''];
var L = labelsFor(BANNER, HEADER);

function find(key) {
  for (var c = 0; c < HEADER.length; c++) {
    var h = String(HEADER[c] || '').trim();
    if (!h) continue;
    if (OMP_WANT_[key].test(h) || OMP_WANT_[key].test(L[c])) return c;
  }
  return -1;
}
function letter(c) {
  var s2 = '', n2 = c + 1;
  while (n2 > 0) { var r2 = (n2 - 1) % 26; s2 = String.fromCharCode(65 + r2) + s2; n2 = (n2 - r2 - 1) / 26; }
  return s2;
}
ck('the Reached date is AJ, not AN',   letter(find('reached')), 'AJ');
ck('the Delivered date is AN',         letter(find('delivered')), 'AN');
ck('  and they are different columns', find('reached') === find('delivered'), false);
ck('the Completed date is AT',         letter(find('completed')), 'AT');
ck('Exp Date is AI',                   letter(find('expected')), 'AI');
ck('Dispatch Date is AG',              letter(find('dispatch')), 'AG');
ck('Shipment ID is J',                 letter(find('shipment')), 'J');
ck('Control - POC is B',               letter(find('poc')), 'B');
ck('MM Date is H',                     letter(find('mmDate')), 'H');
/* A RUNNING TOTAL IS NOT A BANNER. O, T, V and AZ hold numbers; carried
   forward they would rename every column after them. */
ck('a number in the banner row is ignored', L[15], 'Per Units');
ck('  and the next real banner still applies', L[35], 'Reached / Actual');
ck('  as does the one after it', L[39], 'Delivered / Actual');
ck('a column with no banner keeps its plain name', L[1], 'Control - POC');

console.log('\n--- one shipment, one verdict ---');
eval(grab('function ompTransitOne_(', 'function ompTransitAchievements_('));
var SEPT = new Date(2026, 8, 20);
function one(mmRow, exp, reached, dispatched, month) {
  return ompTransitOne_(mmRow, exp, reached, dispatched, month || '2026-08', SEPT);
}
var ARRIVED = { status: 'REACHED', stage: 'Arrived' };
var MOVING  = { status: 'DISPATCHED', stage: 'In Transit' };
var DEAD    = { status: 'CANCELLED', stage: 'CANCELLED' };

ck('reached before the expected date is on time',
   one(ARRIVED, new Date(2026,7,20), new Date(2026,7,18), new Date(2026,7,10)).out, 'hit');
ck('reached ON the expected date is on time — the rule is <=, not <',
   one(ARRIVED, new Date(2026,7,20), new Date(2026,7,20), new Date(2026,7,10)).out, 'hit');
ck('reached after it is a miss',
   one(ARRIVED, new Date(2026,7,20), new Date(2026,7,22), new Date(2026,7,10)).out, 'miss');
ck('  and the report says by how much',
   one(ARRIVED, new Date(2026,7,20), new Date(2026,7,22), new Date(2026,7,10)).why,
   'reached 2 day(s) late');
ck('a cancelled shipment is not a miss, it leaves the denominator',
   one(DEAD, new Date(2026,7,20), '', new Date(2026,7,10)).out, 'skip');
ck('a shipment MM_CT has never heard of is a skip, and says so',
   one(null, new Date(2026,7,20), new Date(2026,7,18), new Date(2026,7,10)).why, 'not in MM_CT');
/* The current month is not scored, whatever state the shipment is in. */
ck('a September shipment is not scored in September',
   one(ARRIVED, new Date(2026,8,2), new Date(2026,8,1), new Date(2026,8,1), '2026-09').out, 'skip');
ck('  even when it arrived on time',
   one(ARRIVED, new Date(2026,8,2), new Date(2026,8,1), new Date(2026,8,1), '2026-09').why,
   'current month, not scored yet');
/* Still moving. August's clock stops on 10 Sep. */
ck('still in transit from 1 Aug is DELAYED, and that is a miss',
   one(MOVING, new Date(2026,7,5), '', new Date(2026,7,1)).out, 'miss');
ck('  which is the point: a shipment that never arrived is the clearest miss',
   one(MOVING, new Date(2026,7,5), '', new Date(2026,7,1)).why,
   'still in transit after 40 days');
ck('still in transit from 31 Aug is within the grace, so not yet judged',
   one(MOVING, new Date(2026,8,5), '', new Date(2026,7,31)).out, 'skip');
ck('in transit with no dispatch date is neither forgiven nor punished',
   one(MOVING, new Date(2026,7,5), '', '').out, 'skip');
/* Missing dates must not silently become a hit or a miss. */
ck('arrived with no Exp Date cannot be judged',
   one(ARRIVED, '', new Date(2026,7,18), new Date(2026,7,10)).out, 'skip');
ck('arrived with no Reached date cannot be judged either',
   one(ARRIVED, new Date(2026,7,20), '', new Date(2026,7,10)).out, 'skip');
ck('  and each says which date was missing',
   one(ARRIVED, '', new Date(2026,7,18), new Date(2026,7,10)).why,
   'no Exp Date to compare against');

console.log('\n--- the rate is a fraction, because the bands are ---');
var imp = grab('function ompTransitAchievements_(', '/** DRY RUN');
/* The ladder reads 0.8 | 0.85 | 0.9 | 0.95 | 1 and buildModel_ compares the
   stored number to it directly. Writing 87 instead of 0.87 clears every band
   and rates everybody 5. */
ck('the rate is hits over the countable total, not a percentage',
   /b\.hit \/ den/.test(imp), true);
/* Asserted on what is STORED, not on the source text. The report line
   formats w.rate * 1000 / 10 to print "87.0%", which is display and is fine;
   an earlier version of this assertion matched that and failed the code for
   doing the right thing. */
ck('  and the value stored is the raw fraction, unscaled',
   /actual: w\.rate,/.test(imp), true);
ck('a hand-typed number is never overwritten',
   imp.indexOf('never overwrite a number somebody typed by hand') >= 0, true);
ck('  and the check is on this importer\'s own note',
   /indexOf\(OMP_TRANSIT_NOTE_\) < 0/.test(imp), true);
ck('holders are found by KRA and KPI name, not by naming people',
   /OMP_TRANSIT_KRA_\.test|OMP_TRANSIT_KPI_\.test/.test(imp), true);
ck('the dry run writes nothing at all',
   /if \(dryRun\) \{[\s\S]{0,400}?NOTHING WAS WRITTEN/.test(imp), true);
/* A thin denominator must be visible on the row it belongs to, not buried. */
ck('a month resting on fewer than five shipments says so on its own line',
   /w\.den < 5 \?/.test(imp), true);

console.log('\n--- the write is not reachable over HTTP ---');
var diag = grab('var DIAG_FUNCTIONS_ = {', '};');
ck('previewOmpTransit is a diagnostic', diag.indexOf('previewOmpTransit') >= 0, true);
ck('importOmpTransit is NOT', diag.indexOf('importOmpTransit:') >= 0, false);


console.log('\n--- ONE resolver, used by both the profiler and the importer ---');
/* THE BUG THIS CATCHES. The importer had its own name lookup: canonical name
   into a map keyed on the full name. The tracker writes "Bharath", the roster
   says "BHARATH KUMAR", and an exact lookup misses — so 275 of 364 rows were
   dropped as "not an employee" while Bharath was still NAMED as a holder at
   the top of the same report. ARVIND survived only because its alias happens
   to expand to the full name.

   A plausible report with a person silently missing from it is the worst shape
   a bug can take here, so this is asserted two ways: the behaviour, and that
   there is only one piece of code doing it. */
eval(grab('function normName_(v) {', '/** Parse one target tab'));
eval(grab('var POC_ALIASES = {', 'var POC_IGNORE'));
eval(grab('function canonPersonName_(name) {', 'function canonPocName_('));
eval(grab('var OMP_POC_ALIASES_ = {', 'function ompCounts_('));
eval(grab('function editDist_(a, b) {', 'function profileOmpTracker()')
  .replace(/function ompResolveName_[\s\S]*$/, '') +
  grab('function ompResolveName_(part, emps) {', 'function profileOmpTracker()'));

var ROSTER = [
  { id: 'e1', name: 'BHARATH KUMAR' },
  { id: 'e2', name: 'ARVIND JAKKULA' },
  { id: 'e3', name: 'DIVYA BOPPURI' },
  { id: 'e4', name: 'JITHENDER CHITAKODUR' },
  { id: 'e5', name: 'AISHWARYA KARANAM' },
  { id: 'e6', name: 'ASHWIN KUMAR SINGH' }
];
function who(nm) {
  var r = ompResolveName_(nm, ROSTER);
  return r.state === 'one' ? r.emp.name : r.state;
}
ck('a forename finds the full name — "Bharath"', who('Bharath'), 'BHARATH KUMAR');
ck('  "Divya"',      who('Divya'), 'DIVYA BOPPURI');
ck('  "Jithender"',  who('Jithender'), 'JITHENDER CHITAKODUR');
ck('  "Aishwarya"',  who('Aishwarya'), 'AISHWARYA KARANAM');
ck('the OMP alias still works — "Aravind"', who('Aravind'), 'ARVIND JAKKULA');
ck('  and so does the full name itself', who('ARVIND JAKKULA'), 'ARVIND JAKKULA');
ck('case and spacing do not matter', who('  bharath '), 'BHARATH KUMAR');
ck('a name off the team by ruling says so', who('Kalyan'), 'offteam');
ck('a name nobody has is not silently assigned', who('Zephyr'), 'none');
/* A surname shared by two people must NOT resolve to one of them. */
ck('an ambiguous token is reported, never picked', who('KUMAR'), 'ambiguous');
/* Whole token, not substring: DIVYA must not match a longer name. */
ck('a partial token does not match', who('Div'), 'none');

var impSrc = grab('function ompTransitAchievements_(', '/** DRY RUN');
ck('the importer calls the shared resolver',
   /ompResolveName_\(who, emps\)/.test(impSrc), true);
ck('  and no longer builds a name map of its own',
   /empByCanon/.test(impSrc), false);
ck('  and excludes leavers before resolving',
   /filter\(function \(e\) \{ return !isLeaver_\(e\.name\); \}\)/.test(impSrc), true);
/* Off the team by ruling and failed to resolve are different findings. */
ck('a ruling is counted apart from a failure',
   /offTeam\[who\]/.test(impSrc) && /noEmp\[who\]/.test(impSrc), true);
ck('  and they are reported with different words',
   /DID NOT RESOLVE/.test(impSrc) && /off the team by ruling/.test(impSrc), true);

console.log('\n--- is MM_CT actually up to date? ---');
/* 22 "still in transit" verdicts are either true or they are MM_CT lagging
   behind the tracker, and the rate is very different either way. The dry run
   has to say which rather than quietly assuming MM_CT is right. */
ck('the dry run compares the two sources on whether a shipment arrived',
   /DOES MM_CT AGREE THAT THESE ARE STILL MOVING/.test(impSrc), true);
ck('  using the tracker\'s own status AND its reached date',
   /reach\|deliver\|complet/.test(impSrc) && /ompDayIndex_\(row\[t\.col\.reached\]\)/.test(impSrc),
   true);
ck('  and says plainly that those rows are currently scored as misses',
   /currently scored as a MISS/.test(impSrc), true);



console.log('\n--- dispatched after the month closed ---');
/* A negative age fell through the pending branch and printed "in transit -6
   days, within the grace", which is nonsense. It means the MM Date puts the
   shipment in one month and the lorry left after that month had already
   settled — a bucketing problem wearing a grace-period label. */
ck('a negative transit age is its own verdict, not pending',
   ompTransitVerdict_('DISPATCHED', 'In Transit', new Date(2026, 8, 20), '2026-07').state,
   'after');
ck('  and the shipment is skipped, not counted either way',
   one(MOVING, new Date(2026, 6, 5), '', new Date(2026, 8, 20), '2026-07').out, 'skip');
ck('  saying how far outside the month it was',
   /dispatched \d+ day\(s\) after this month closed/.test(
     one(MOVING, new Date(2026, 6, 5), '', new Date(2026, 8, 20), '2026-07').why), true);
/* This verdict is now unreachable in the importer — the month IS the dispatch
   month, so the age at the cutoff is always at least the grace. It is still
   exercised here, directly, because a guard nothing tests is a guard nobody
   knows is broken. */
ck('  and it stays correct as a guard even though nothing can reach it',
   /function ompTransitAchievements_[\s\S]*?cellDate_\(row\[t\.col\.dispatch\]\)/
     .test(src), true);
/* The ordinary cases must not have moved. */
ck('a same-month dispatch is still judged normally',
   one(MOVING, new Date(2026, 7, 5), '', new Date(2026, 7, 1), '2026-08').out, 'miss');

console.log('\n--- the consequence is stated before the import, not after ---');
var imp2 = grab('function ompTransitAchievements_(', '/** DRY RUN');
ck('the dry run scores each rate against its own ladder',
   /levelFromBands_\(pb, rate\)/.test(imp2), true);
ck('  reading the LATEST ladder, not the first',
   /ladderAt\[k\] > at/.test(imp2), true);
ck('a month clearing no band at all is called out',
   /READ THIS BEFORE IMPORTING/.test(imp2), true);
ck('  and the report says what a Target 0 costs',
   /weighted half the scorecard/.test(imp2), true);
/* The numbers are not the arithmetic's fault and the report must not imply
   they are. The question these rates raise is about the Exp Date, and saying
   so is more use than hedging the figure. */
ck('  and does not pretend the arithmetic is at fault',
   /The arithmetic is doing what it was asked to/.test(imp2), true);
ck('a thin month is named, with its count',
   /thinW\.forEach/.test(imp2), true);

console.log('\n--- the month is the DISPATCH month, not the order month ---');
/* Ruled 28 Sep 2026. A shipment ordered 28 Jul and dispatched 3 Aug was being
   judged against July's clock for transit work that happened in August. */
ck('the month comes from the dispatch date',
   /THE DISPATCH MONTH, not the order month[\s\S]{0,120}?cellDate_\(row\[t\.col\.dispatch\]\)/
     .test(imp2), true);
ck('  and MM Date is no longer required at all',
   /var need = \['poc', 'shipment', 'expected', 'reached', 'dispatch'\]/.test(imp2), true);
/* No dispatch date now means no month, which is a data gap somebody can fix —
   not a row that silently lands in the order month and fails later. */
ck('a shipment with no dispatch date gets its own skip reason',
   /no Dispatch Date, so no month to score it in/.test(imp2), true);
ck('  and is counted, not dropped in silence',
   /whyCount\['skip: no Dispatch Date/.test(imp2), true);

console.log('\n--- the warning heading suits the run it is printed in ---');
/* "READ THIS BEFORE IMPORTING", printed underneath "WROTE 7 rows", is a
   warning that arrived too late. Same facts, heading chosen by the run. */
ck('the dry run says read this first',
   /dryRun \? '=== READ THIS BEFORE IMPORTING ==='/.test(imp2), true);
ck('  and the real run says what it just did',
   /'=== WHAT WAS JUST WRITTEN, AND WHAT IT RATES ==='/.test(imp2), true);


console.log('\n--- timely dispatch: In-Transit within 3 days of matchmaking ---');
eval(grab('var OMP_DISPATCH_NOTE_', 'function ompDispatchAchievements_('));
var OCT = new Date(2026, 9, 5);
/* The In-Transit date is a DAY INDEX taken from MM_CT's status_timeline, not a
   date typed into the tracker. Built here the way the importer builds it. */
function day(y, m, d) { return Math.floor(Date.UTC(y, m, d) / 86400000); }
function mmrow(inTransit, status, stage) {
  return { status: status || 'DISPATCHED', stage: stage || 'In Transit',
           inTransit: inTransit };
}
function dp(row, matched, month) {
  return ompDispatchOne_(row, matched, month || '2026-08', OCT);
}
ck('In-Transit the same day is on time',
   dp(mmrow(day(2026, 7, 10)), new Date(2026, 7, 10)).out, 'hit');
ck('three days is on time — the rule is <=, not <',
   dp(mmrow(day(2026, 7, 13)), new Date(2026, 7, 10)).out, 'hit');
ck('four days is not',
   dp(mmrow(day(2026, 7, 14)), new Date(2026, 7, 10)).out, 'miss');
ck('  and the report says how long it took',
   dp(mmrow(day(2026, 7, 14)), new Date(2026, 7, 10)).why, 'In-Transit in 4 day(s)');
ck('a cancelled shipment leaves the denominator',
   dp(mmrow(day(2026, 7, 11), 'CANCELLED', 'CANCELLED'), new Date(2026, 7, 10)).out, 'skip');
ck('the current month is not scored',
   dp(mmrow(day(2026, 9, 2)), new Date(2026, 9, 1), '2026-10').out, 'skip');

/* THE RULING: only shipments that reached In-Transit count. One that never
   left is EXCLUDED, not counted as a miss. */
ck('a shipment that never reached In-Transit is excluded',
   dp(mmrow(null, 'DRAFT', 'Ready to Dispatch'), new Date(2026, 7, 1)).out, 'skip');
ck('  and the report names the ruling as the reason',
   /never reached In-Transit — not counted \(ruling\)/.test(
     dp(mmrow(null, 'DRAFT', 'Ready to Dispatch'), new Date(2026, 7, 1)).why), true);
/* In transit before matchmaking is data, not a rating. A negative gap must not
   arithmetic its way into a hit. */
ck('In-Transit before matchmaking is reported, not scored',
   dp(mmrow(day(2026, 7, 8)), new Date(2026, 7, 10)).out, 'skip');
ck('  and says which way round it was',
   /In-Transit 2 day\(s\) BEFORE matchmaking/.test(
     dp(mmrow(day(2026, 7, 8)), new Date(2026, 7, 10)).why), true);
ck('no MM Date means no clock to start',
   dp(mmrow(day(2026, 7, 12)), '').out, 'skip');

console.log('\n--- the date comes from the timeline, not from the tracker ---');
var dimp = grab('function ompDispatchAchievements_(', '/** DRY RUN — writes nothing. */');
ck('MM_CT status_timeline is parsed for the In-Transit stage',
   /parseTimeline_\(mg\[r\]\[mi\['status_timeline'\]\]\)/.test(dimp), true);
ck('  and the stage key is DISPATCHED, not the "In Transit" label',
   OMP_INTRANSIT_STAGE_, 'DISPATCHED');
ck('  and a missing status_timeline column stops the run',
   /has no status_timeline column/.test(dimp), true);
/* The tracker's typed Dispatch Date is still read — to be CHECKED against the
   timeline, because the gap it feeds is the numerator of the rate. */
ck('the two sources are compared on every run',
   /DO THE TWO SOURCES AGREE ON WHEN IT LEFT/.test(dimp), true);
ck('  and the disagreement is shown with the direction of the gap',
   /tracker was written later than the stage was actually reached/.test(dimp), true);

console.log('\n--- what the ruling costs is printed, not hidden ---');
ck('the excluded shipments are counted and reported',
   /WHAT IS NOT IN THESE RATES/.test(dimp), true);
ck('  saying the rate covers only what did eventually go',
   /computed over the shipments that did eventually go/.test(dimp), true);
ck('the rate is stored as a fraction',
   /actual: w\.rate,/.test(dimp), true);
ck('a hand-typed number is never overwritten',
   /indexOf\(OMP_DISPATCH_NOTE_\) < 0/.test(dimp), true);
ck('the writer exists now that the ruling is made',
   /function importOmpDispatch\(\)/.test(src), true);
ck('  and it is NOT reachable over HTTP',
   grab('var DIAG_FUNCTIONS_ = {', '};').indexOf('importOmpDispatch:') >= 0, false);
ck('  while the dry run is',
   grab('var DIAG_FUNCTIONS_ = {', '};').indexOf('previewOmpDispatch') >= 0, true);

console.log('\n--- the grace is per KPI ---');
ck('transit still stops ten days after month end',
   Utilities.formatDate(ompCutoff_('2026-08'), '', 'yyyy-MM-dd'), '2026-09-10');
ck('and the cutoff takes a grace of its own',
   Utilities.formatDate(ompCutoff_('2026-08', 3), '', 'yyyy-MM-dd'), '2026-09-03');

console.log('\n--- tracking accuracy: one method is enough ---');
eval(grab('var OMP_TRACKING_NOTE_', 'function ompTrackingAchievements_('));
function tk(value, row) {
  return ompTrackingOne_(row || mmrow(day(2026, 7, 5)), value, '2026-08', OCT);
}
/* The real column, as profileOmpCategoricals found it:
   Fastag 200 · Both 51 · N.A 37 · SIM track 36 · No 28.  No blanks at all. */
ck('Fastag is on track',      tk('Fastag').out, 'hit');
ck('SIM track is on track',   tk('SIM track').out, 'hit');
ck('Both is on track',        tk('Both').out, 'hit');
ck('  one of the two is enough — Both is not required',
   tk('Fastag').out === tk('Both').out, true);
ck('N.A leaves the denominator — the tracker was not in place',
   tk('N.A').out, 'skip');
ck('  and says so', /tracker not in place/.test(tk('N.A').why), true);
ck('"No" is a miss', tk('No').out, 'miss');
ck('  and names the value rather than calling it blank',
   /"No" — no tracking in place/.test(tk('No').why), true);
/* "No" as a miss is the KRA owner s own ruling (28 Sep 2026), not a reading
   of "blank is a miss" — that was ruled before the values were known, and the
   column has no blanks. The blank case is kept anyway, for the day it gains
   one. */
ck('a blank would still be a miss', tk('').out, 'miss');
ck('case and spacing do not change the answer', tk('  fastag ').out, 'hit');
ck('N.A. with stops is the same value', tk('N.A.').out, 'skip');

/* THE GUARD THAT MATTERS. A hand-maintained column gains values. An unknown
   must not default to either verdict — a hit is a silent lie, a miss punishes
   somebody for a word nobody ruled on. */
ck('an unrecognised value is NOT scored as a hit',
   tk('Sometimes').out === 'hit', false);
ck('  nor as a miss',
   tk('Sometimes').out === 'miss', false);
ck('  it is reported as unruled',  tk('Sometimes').out, 'unruled');
ck('  and says nobody has ruled on it',
   /is not a value anybody has ruled on/.test(tk('Sometimes').why), true);

console.log('\n--- and the denominator ---');
ck('a cancelled shipment leaves it',
   tk('Fastag', mmrow(day(2026,7,5), 'CANCELLED', 'CANCELLED')).out, 'skip');
/* Nothing to track before a shipment moves. */
ck('one that never reached In-Transit has nothing to track',
   tk('Fastag', mmrow(null, 'DRAFT', 'Ready to Dispatch')).out, 'skip');
ck('the current month is not scored',
   ompTrackingOne_(mmrow(day(2026,9,2)), 'Fastag', '2026-10', OCT).out, 'skip');

var timp = grab('function ompTrackingAchievements_(', '/** DRY RUN — writes nothing. */');
ck('every distinct value is printed against its verdict',
   /EVERY DISTINCT VALUE, AND THE VERDICT IT RECEIVED/.test(timp), true);
ck('  which is how a wrong bucket is caught on the first run',
   /verdictOf\[vk\]/.test(timp), true);
ck('unruled rows are counted and never silently dropped',
   /nobody has ruled on and were left/.test(timp), true);
ck('it buckets on the dispatch month, like the transit KPI',
   /THE DISPATCH MONTH — tracking happens during transit/.test(timp), true);
ck('the rate is stored as a fraction',  /actual: w\.rate,/.test(timp), true);
ck('a hand-typed number is never overwritten',
   /indexOf\(OMP_TRACKING_NOTE_\) < 0/.test(timp), true);
ck('the dry run is reachable over HTTP',
   grab('var DIAG_FUNCTIONS_ = {', '};').indexOf('previewOmpTracking') >= 0, true);
ck('  and the writer is not',
   grab('var DIAG_FUNCTIONS_ = {', '};').indexOf('importOmpTracking:') >= 0, false);

console.log('\n--- a rate must not be rendered as a count ---');
/* THE BUG. plan_unit came from the PLAN row. An OMP KPI has no PLAN row, so
   the unit was empty, so fmtTarget fell to its count branch and rounded:
   a rate of 0.87 rendered as "1", and 0.333 as "0". Every OMP and Collections
   figure on the dashboard was one of those two. */
var page = fs.readFileSync(require('path').join(ROOT, 'Index.html'), 'utf8')
  .replace(/\r\n/g, '\n');
function grabPage(a, b) {
  var i = page.indexOf(a); if (i < 0) throw new Error('missing anchor: ' + a);
  var j = page.indexOf(b, i); if (j < 0) throw new Error('missing anchor: ' + b);
  return page.slice(i, j);
}
eval(grabPage('function fmtTarget(v,unit,exact){', 'function ratioLadder(r){'));
ck('87% renders as a percentage, not as 1', fmtTarget(0.87, 'ratio'), '87%');
ck('33.3% does not round to 0',            fmtTarget(0.333, 'ratio'), '33.3%');
ck('100% renders whole',                   fmtTarget(1, 'ratio'), '100%');
ck('  and 66.7% keeps its decimal',        fmtTarget(0.6667, 'ratio'), '66.7%');
ck('a blank is still nothing, not 0%',     fmtTarget('', 'ratio'), '');
ck('  and so is null',                     fmtTarget(null, 'ratio'), '');
/* The other units must not have moved. */
ck('crore is untouched',  fmtTarget(6.184, 'cr'), '6.18 Cr');
ck('days are untouched',  fmtTarget(18.9, 'days'), '19\u2009days');
ck('counts are untouched', fmtTarget(5.4, 'count'), '5');

eval(grabPage('function ratioLadder(r){', '/* HOW MANY KPIs THERE ARE'));
/* The rungs are shown in the same units as the achievement, or the row reads
   "0.8" beside "87%". */
var rateRow = { values: [0.8, 0.85, 0.9, 0.95, 1], plan_target: null, plan_unit: 'ratio' };
ck('the ladder is shown as percentages too',
   (ladderInUnits(rateRow) || []).join(' '), '80% 85% 90% 95% 100%');
/* A row WITH a target still scales its rungs by the target, as before. */
var counted = { values: [0.6, 0.75, 0.9, 1, 1.05], plan_target: 6, plan_unit: 'count' };
ck('a targeted ladder still scales by the target',
   (ladderInUnits(counted) || []).join(' '), '3.6 4.5 5.4 6 6.3');

console.log('\n--- and the model only marks a row that is SCORED as a rate ---');
var bm = grab('var ovr = weightOverride_((empById_[a.employee_id] || {}).name,', 'var row = {');
ck('the condition is never-planned AND a ratio ladder',
   /!planEver\[String\(a\.employee_id\) \+ '\|' \+ String\(a\.kpi_id\)\][\s\S]{0,120}?isRatioLadder_\(parsed\.values\)\.ok/
     .test(bm), true);
/* A ratio ladder on a KPI planned in some OTHER month means a bare actual is a
   quantity waiting for its denominator — 5 sellers, not 500%. */
ck('  and the reason planEver is in it is written down',
   /waiting for its denominator/.test(bm), true);

console.log('\n--- the value table tabulates VALUES, not everything ---');
/* It read "Fastag -> hit  68" and "Fastag -> skip  28" side by side. The skips
   were current-month and cancelled rows, which never reach the value test at
   all — but the table is the one thing the reader was told to check before
   importing, and it looked like Fastag was sometimes being skipped as a value. */
var tv = grab('function ompTrackingAchievements_(', '/** DRY RUN — writes nothing. */');
ck('only a verdict the VALUE decided is tabulated',
   /if \(v\.out === 'hit' \|\| v\.out === 'miss' \|\| v\.out === 'unruled'\) \{/.test(tv), true);
ck('  and the rest are counted on one line of their own',
   /the value was never tested/.test(tv), true);
ck('  rather than dropped, which would make the counts not add up',
   /notReached\+\+/.test(tv), true);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
