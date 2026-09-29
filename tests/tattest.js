/* Exercises the REAL seller onboarding TAT out of Code.gs, with only the sheet
   layer stubbed.

   The rule: In Review to Onboarded, and where a case was rejected and
   resubmitted it is the REVISED In Review that counts. Four things can go wrong
   quietly, and each has a case below:

     - the clock not restarting on a rejection, so a resubmitted case carries
       the whole rejection loop as one long delay;
     - restarting on a rejection that happened AFTER the approval, which belongs
       to a later re-review and would make the TAT negative or tiny;
     - reading level4 as the end when a case only went to level2;
     - mixing the UTC and IST copies of a column, which are 5.5 hours apart
       under identical headers and would move a 1-day TAT across its threshold.
*/
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

var Utilities = {
  formatDate: function (d, tz, fmt) {
    var p = function (x) { return (x < 10 ? '0' : '') + x; };
    if (fmt === 'yyyy-MM') return d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1);
    return d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate());
  }
};
var Session = { getScriptTimeZone: function () { return 'Etc/UTC'; } };

eval(grab('function num_(v)', 'function slug_'));
eval(grab('function normName_(v)', 'function readTargetTab_'));
eval(grab('var EMPTY_BAND', 'var LEVEL_LABELS'));
eval(grab('function colLetter_(nCol)', 'function describeTab_('));
/* from the ignore list through the owner rules, so both matchers come with it */
eval(grab('var ONBOARD_IGNORE_ = [', 'function metaUrl_()'));
eval(grab('var SELLER_TAB_', 'function sellerTat_(dryRun)'));
var ONBOARD_FROM_ = '2026-04-01';

console.log('--- the columns it reads are addressed by letter ---');
/* the export carries 24 duplicated names; a by-name lookup takes the UTC copy
   silently, so every column is pinned to a letter and checked on each run */
ck('level1 approved is read from Z, the UTC copy',
   SELLER_COLS_.approvals[0], 'Z');
ck('  not AX, the IST duplicate', SELLER_COLS_.approvals.indexOf('AX'), -1);
ck('the submission comes from L', SELLER_COLS_.submitted, 'L');
ck('  which is UTC too, matching Z rather than AX',
   SELLER_EXPECT_.L, 'review_submission_date');
ck('four approval levels are read', SELLER_COLS_.approvals.length, 4);
ck('  and eight rejection stamps', SELLER_COLS_.rejections.length, 8);
ck('every letter has an expected header pinned to it',
   Object.keys(SELLER_EXPECT_).length, 18);
ck('  and none of them is an IST column',
   Object.keys(SELLER_EXPECT_).filter(function (L) {
     return letterCol_(L) > letterCol_('AW'); }).length, 0);

console.log('\n--- letter to index, since everything hangs on it ---');
ck('L is index 11', letterCol_('L') - 1, 11);
ck('Z is index 25', letterCol_('Z') - 1, 25);
ck('AF is index 31', letterCol_('AF') - 1, 31);
ck('AR is index 43', letterCol_('AR') - 1, 43);
ck('AV is index 47', letterCol_('AV') - 1, 47);

console.log('\n--- the clock, case by case ---');
/* start = latest of the submission and any rejection BEFORE the approval;
   end = the LAST approval present. Reimplemented here exactly as the function
   does it, so the rule is asserted rather than the plumbing. */
function tatOf(submitted, rejections, approvals) {
  var end = null;
  approvals.forEach(function (t) {
    if (!t) return;
    var d = new Date(t);
    if (!end || d > end) end = d;
  });
  if (!end) return null;
  var start = new Date(submitted);
  rejections.forEach(function (t) {
    if (!t) return;
    var d = new Date(t);
    if (d < end && d > start) start = d;
  });
  return { days: (end - start) / 86400000, start: start, end: end };
}
function r1(x) { return Math.round(x * 10) / 10; }

var clean = tatOf('2026-04-10T09:00:00Z', [], ['2026-04-11T09:00:00Z', '', '', '']);
ck('a clean case is submission to approval', r1(clean.days), 1);
ck('  and meets a 3-day TAT', clean.days <= 3, true);
ck('  but misses a 1-day TAT only if it is OVER', clean.days <= 1, true);

/* THE RULE: a rejection restarts it */
var rej = tatOf('2026-04-01T09:00:00Z',
  ['2026-04-05T09:00:00Z', '', '', '', '', '', '', ''],
  ['2026-04-07T09:00:00Z', '', '', '']);
ck('a rejection restarts the clock', r1(rej.days), 2);
ck('  NOT the 6 days from first submission', r1(rej.days) === 6, false);
ck('  and the revised start is the rejection',
   Utilities.formatDate(rej.start, 'UTC', 'yyyy-MM-dd'), '2026-04-05');
var twice = tatOf('2026-04-01T09:00:00Z',
  ['2026-04-05T09:00:00Z', '2026-04-09T09:00:00Z', '', '', '', '', '', ''],
  ['2026-04-10T09:00:00Z', '', '', '']);
ck('two rejections take the LATEST', r1(twice.days), 1);

/* a rejection AFTER the approval belongs to a later re-review */
var after = tatOf('2026-04-10T09:00:00Z',
  ['2026-07-01T09:00:00Z', '', '', '', '', '', '', ''],
  ['2026-04-12T09:00:00Z', '', '', '']);
ck('a rejection after the approval is ignored', r1(after.days), 2);
ck('  so it cannot produce a negative TAT', after.days > 0, true);

/* the end is the LAST approval, not level4 */
var twoLevels = tatOf('2026-04-10T09:00:00Z', [],
  ['2026-04-11T09:00:00Z', '2026-04-14T09:00:00Z', '', '']);
ck('the end is the last approval present', r1(twoLevels.days), 4);
ck('  not the first', r1(twoLevels.days) === 1, false);
var noApproval = tatOf('2026-04-10T09:00:00Z', [], ['', '', '', '']);
ck('no approval at all cannot be scored', noApproval, null);

console.log('\n--- UTC against IST: the 5.5 hours that would move a rating ---');
/* Z = 13:35 UTC, AX = 19:05 IST for the same event. Measuring from an IST
   approval to a UTC submission adds 5.5 hours to every case. */
var utc = tatOf('2026-04-10T18:00:00Z', [], ['2026-04-11T13:00:00Z', '', '', '']);
var mixed = tatOf('2026-04-10T18:00:00Z', [], ['2026-04-11T18:30:00Z', '', '', '']);
ck('measured in one zone', r1(utc.days), 0.8);
ck('  meets a 1-day TAT', utc.days <= 1, true);
ck('mixing zones adds 5.5 hours', r1(mixed.days), 1);
ck('  and pushes the same case past 1 day', mixed.days > 1, true);
ck('    which would cost a Target rung, so zones are never mixed',
   (utc.days <= 1) !== (mixed.days <= 1), true);

console.log('\n--- the window is on IN REVIEW, not on the approval ---');
/* KRA owner, 21 Sep 2026: consider cases from 1 April 2026 onwards. Filtering
   on the APPROVAL instead let in a case submitted Sep 2025 and approved May
   2026, while excluding one submitted Mar 2026 — the wrong population twice
   over. And it is the REVISED in-review date, so a 2025 case resubmitted after
   1 April 2026 is in scope: the work being measured happened in the window. */
var body0 = grab('function sellerTat_(dryRun)', 'function previewSellerTat');
ck('the cutoff is applied to the START', /if \(startDay < ONBOARD_FROM_\)/.test(body0), true);
ck('  not to the end', /if \(day < ONBOARD_FROM_\)/.test(body0), false);
ck('  and startDay comes from start, not end',
   /var startDay = Utilities\.formatDate\(start,/.test(body0), true);
ck('the cutoff itself', ONBOARD_FROM_, '2026-04-01');

/* the four cases the change decides differently */
function inWindow(submitted, rejections, approvals) {
  var t = tatOf(submitted, rejections, approvals);
  if (!t) return null;
  return Utilities.formatDate(t.start, 'UTC', 'yyyy-MM-dd') >= '2026-04-01';
}
ck('submitted 2025, approved 2026, never resubmitted -> OUT',
   inWindow('2025-09-09T09:00:00Z', [], ['2026-05-01T09:00:00Z', '', '', '']), false);
ck('  even though the approval is inside the window',
   '2026-05-01' >= '2026-04-01', true);
ck('submitted 2025, RESUBMITTED after 1 Apr 2026 -> IN',
   inWindow('2025-09-09T09:00:00Z',
     ['2026-04-20T09:00:00Z', '', '', '', '', '', '', ''],
     ['2026-04-22T09:00:00Z', '', '', '']), true);
ck('  and its TAT is measured from the resubmission',
   r1(tatOf('2025-09-09T09:00:00Z',
     ['2026-04-20T09:00:00Z', '', '', '', '', '', '', ''],
     ['2026-04-22T09:00:00Z', '', '', '']).days), 2);
ck('submitted 2026-03-31 -> OUT by one day',
   inWindow('2026-03-31T09:00:00Z', [], ['2026-04-02T09:00:00Z', '', '', '']), false);
ck('submitted 2026-04-01 -> IN',
   inWindow('2026-04-01T09:00:00Z', [], ['2026-04-02T09:00:00Z', '', '', '']), true);
/* JVD METALS from the real run: restarted 2026-02-16, so still out */
ck('JVD METALS restarted Feb 2026, so still out of scope',
   inWindow('2025-09-09T00:00:00Z',
     ['2026-02-16T00:00:00Z', '', '', '', '', '', '', ''],
     ['2026-05-01T00:00:00Z', '', '', '']), false);

console.log('  and a case is BUCKETED by when it completed:');
ck('bucketing by completion is stated, with the reason',
   body0.indexOf('bucketed by the month it was completed') >= 0 ||
   body0.indexOf('BUCKETED by the month it was completed') >= 0, true);
ck('  because the newest month would otherwise flatter itself',
   body0.indexOf('flatter') >= 0, true);

console.log('\n--- the share of cases is what gets recorded, not the days ---');
var pb = parseBands_(ONBOARD_LADDER_);
ck('the ladder is the four KRAs\' own', ONBOARD_LADDER_.join('|'), '0.8|0.85|0.9|0.95|1.0');
/* that this ladder is a ratio rather than an absolute one is asserted in
   scaletest, where isRatioLadder_ lives; here it matters only that a SHARE is
   what gets compared against it */
ck('  and a share of 1.0 is its top rung',
   levelFromBands_(parseBands_(ONBOARD_LADDER_), 1.0), 5);
ck('100% of cases within TAT rates 5', levelFromBands_(pb, 1.0), 5);
ck(' 95% rates 4', levelFromBands_(pb, 0.95), 4);
ck(' 90% rates 3', levelFromBands_(pb, 0.90), 3);
ck(' 80% rates 1', levelFromBands_(pb, 0.80), 1);
ck(' 79% is below every rung', levelFromBands_(pb, 0.79), 0);
/* 17 of 20 within TAT */
ck('17 of 20 is 85%, which rates 2', levelFromBands_(pb, 17 / 20), 2);
ck('  and the mean DAYS is not what is scored',
   levelFromBands_(pb, 17 / 20) === levelFromBands_(pb, 2.4), false);

console.log('\n--- Support is out of scope by ruling, not unattributed ---');
/* KRA owner, 22 Sep 2026: ignore Support. Those 157 in-scope cases were being
   reported as "nobody is measured on them" — true, and misleading, because
   nobody is supposed to be. Out-of-scope and unattributed are different
   findings and must not share a counter. */
ck('Support is ignored', !!onboardingIgnored_('Support', 'Support'), true);
ck('  and so never reaches the owner rules',
   onboardingIgnored_('Support', 'Support') !== null, true);
ck('  with a reason attached',
   /not onboarded by this team/.test(onboardingIgnored_('Support', 'Support').why), true);
ck('a Support/Metal row is ignored too, not given to Harshita',
   !!onboardingIgnored_('Support', 'Metal'), true);
ck('nothing else is ignored', onboardingIgnored_('Marketplace', 'Plastic'), null);
ck('  nor EPR', onboardingIgnored_('EPR', 'Plastic'), null);
ck('  nor Sustainability Services, which was not ruled on',
   onboardingIgnored_('Sustainability Services', 'Plastic'), null);
var body3 = grab('function sellerTat_(dryRun)', 'function previewSellerTat');
ck('the loop tests ignore BEFORE attributing',
   body3.indexOf('onboardingIgnored_(row[iV], row[iC])') <
   body3.indexOf('var owner = onboardingOwner_'), true);
ck('  and counts it separately from the gap',
   /skip\.ignored\+\+/.test(body3), true);
ck('the funnel shows it on its own line',
   body3.indexOf('less out of scope by ruling') >= 0, true);

console.log('\n--- Marketplace Plastic and E-Waste are Vamsi\'s, at one day ---');
/* "Plastic, E-Waste belongs to Vamsi and TAT will be 1 day only." At one day
   they sit on the Open Marketplace KRA he already holds, and the whole KRA is
   then held to a SINGLE TAT — which is what makes the share it produces mean
   something. An earlier reading put Plastic at three days on a KRA of its own;
   that needed adding to the workbook and his weightages rebalanced. */
var plastic = onboardingOwner_('Marketplace', 'Plastic');
var ewaste = onboardingOwner_('Marketplace', 'E-Waste');
ck('Plastic is Vamsi\'s', plastic.who, 'VAMSI');
ck('E-Waste is too', ewaste.who, 'VAMSI');
ck('  both at ONE day', plastic.tatDays + '/' + ewaste.tatDays, '1/1');
ck('  on the Open Marketplace KRA he already holds',
   plastic.kra, 'Open Marketplace – Buyer & Seller Onboarding');
ck('    the same KRA for both', plastic.kra, ewaste.kra);
ck('    and the same one the Open Marketplace vertical uses',
   plastic.kra, onboardingOwner_('Open Marketplace', 'Plastic').kra);
/* the whole point: one KRA, one TAT */
ck('every case on that KRA is held to the same TAT',
   [onboardingOwner_('Open Marketplace', 'Plastic').tatDays,
    plastic.tatDays, ewaste.tatDays].join(','), '1,1,1');
ck('  so no separate KRA is needed in the workbook',
   src.indexOf('Nothing to add now') >= 0, true);
/* E-Waste folds through normName_, so the hyphen must not matter */
ck('the hyphen in E-Waste is folded away', normName_('E-Waste'), 'E WASTE');
ck('  and the pattern matches the folded form',
   /\^\(PLASTIC\|E WASTE\)\$/.test(src), true);
/* scoped to Marketplace, like Harshita's */
ck('EPR/E-Waste still goes to Naveen, not Vamsi',
   onboardingOwner_('EPR', 'E-Waste').who, 'NAVEEN RANGA');
/* KRA owner, 22 Sep 2026: Sustainability Services / Plastic goes to Naveen. */
var ssp = onboardingOwner_('Sustainability Services', 'Plastic');
ck('Sustainability Services/Plastic is Naveen\'s', ssp.who, 'NAVEEN RANGA');
ck('  on his EPR KRA, the onboarding one he holds',
   ssp.kra, 'EPR – Buyer & Seller Onboarding');
ck('  at three days, the TAT that KRA already runs at',
   ssp.tatDays, onboardingOwner_('EPR', 'Plastic').tatDays);
ck('    so that KRA stays held to a single TAT',
   [ssp.tatDays, onboardingOwner_('EPR', 'Plastic').tatDays,
    onboardingOwner_('EPR', 'E-Waste').tatDays].join(','), '3,3,3');
/* only PLASTIC was ruled on for that vertical */
ck('  Sustainability Services/Other Services is NOT swept in with it',
   onboardingOwner_('Sustainability Services', 'Other Services'), null);
ck('Metal is still Harshita\'s', onboardingOwner_('Marketplace', 'Metal').who, 'HARSHITA');
ck('  and AFR', onboardingOwner_('Marketplace', 'AFR').who, 'HARSHITA');
ck('Paper and M3 remain unowned',
   [onboardingOwner_('Marketplace', 'Paper'),
    onboardingOwner_('Marketplace', 'M3')].filter(Boolean).length, 0);
/* Plastic must not have taken Metal's or AFR's place in the order */
ck('Metal is still Harshita\'s', onboardingOwner_('Marketplace', 'Metal').who, 'HARSHITA');
ck('AFR is still Harshita\'s', onboardingOwner_('Marketplace', 'AFR').who, 'HARSHITA');
/* E-Waste became Vamsi's on 22 Sep; Paper is now the largest unowned category */
ck('Paper belongs to nobody, which was not ruled on',
   onboardingOwner_('Marketplace', 'Paper'), null);

console.log('\n--- the TAT each owner is held to ---');
function ownerOf(v, c) { return onboardingOwner_(v, c); }
ck('Open Marketplace is ONE day', ownerOf('Open Marketplace', 'Plastic').tatDays, 1);
ck('  and is Vamsi\'s', ownerOf('Open Marketplace', 'Plastic').who, 'VAMSI');
ck('Marketplace/Metal is three days', ownerOf('Marketplace', 'Metal').tatDays, 3);
ck('  and is Harshita\'s INFRA KRA',
   ownerOf('Marketplace', 'Metal').kra.indexOf('INFRA'), 0);
ck('Marketplace/AFR is her AFR KRA',
   ownerOf('Marketplace', 'AFR').kra.indexOf('AFR'), 0);
ck('EPR is Naveen at three days',
   ownerOf('EPR', 'Plastic').who + ' ' + ownerOf('EPR', 'Plastic').tatDays,
   'NAVEEN RANGA 3');
ck('EPR with a Metal category still goes to Naveen',
   ownerOf('EPR', 'Metal').who, 'NAVEEN RANGA');
/* Support/Metal matches Harshita's category rule but is ignored upstream of it,
   so the loop never asks; the rule itself still fires, which is why the ignore
   check has to come first. */
ck('Support/Metal is ignored before the rules are asked',
   !!onboardingIgnored_('Support', 'Metal'), true);
/* Marketplace Plastic and E-Waste both became Vamsi's on 22 Sep 2026 */
ck('Marketplace/Plastic is now attributed', ownerOf('Marketplace', 'Plastic').who, 'VAMSI');
ck('  and so is E-Waste', ownerOf('Marketplace', 'E-Waste').who, 'VAMSI');
ck('  leaving Paper and M3 as the unowned ones',
   [ownerOf('Marketplace', 'Paper'), ownerOf('Marketplace', 'M3')]
     .filter(Boolean).length, 0);

console.log('\n--- ONE KRA, ONE TAT: the invariant behind two of the rulings ---');
/* A KRA whose cases are held to different TATs produces a share that means
   nothing — a 2-day case would be a miss against a 1-day KRA and a pass against
   a 3-day one, in the same bucket. This came up twice: Plastic at 3 days could
   not share Vamsi's 1-day Open Marketplace KRA (so it would have needed its own
   KRA in the workbook), and at 1 day it could. Asserting it directly means the
   next rule cannot break it quietly. */
var tatByKra = {}, clash = [];
ONBOARDING_OWNERS_.forEach(function (r) {
  if (tatByKra[r.kra] === undefined) { tatByKra[r.kra] = r.tatDays; return; }
  if (tatByKra[r.kra] !== r.tatDays) {
    clash.push(r.kra + ': ' + tatByKra[r.kra] + 'd and ' + r.tatDays + 'd');
  }
});
ck('no KRA is held to two different TATs', clash.join('; ') || '(none)', '(none)');
ck('  across every rule', ONBOARDING_OWNERS_.length >= 5, true);
ck('  and every rule names a KRA somebody could hold',
   ONBOARDING_OWNERS_.filter(function (r) { return !r.kra; }).length, 0);
/* the KRAs in play, and what each is worth */
ck('Open Marketplace KRA runs at 1 day',
   tatByKra['Open Marketplace – Buyer & Seller Onboarding'], 1);
ck('Re-Commerce at 1 day', tatByKra['Re-Commerce – Seller Onboarding'], 1);
ck('EPR at 3', tatByKra['EPR – Buyer & Seller Onboarding'], 3);
ck('AFR at 3', tatByKra['AFR – Buyer & Seller Onboarding'], 3);
ck('INFRA at 3', tatByKra['INFRA – Buyer & Seller Onboarding'], 3);
ck('  five distinct KRAs in all', Object.keys(tatByKra).length, 5);

console.log('\n--- a case is only counted once it is COMPLETED ---');
ck('the completion status is COMPLETED, not "Onboarded"', ONBOARD_DONE_, 'COMPLETED');
/* current_status holds ONBOARDED, but that is the lifecycle axis */
ck('  and not read from current_status',
   /current_status/.test(grab('function sellerTat_(dryRun)', 'function previewSellerTat')),
   false);

console.log('\n--- is the submission stamp real? ---');
/* 71 of 240 scored cases completed in under an hour. That is either a fast
   desk or an artefact: in this export review_submission_date sometimes carries
   the same timestamp as level1_approved_at, and for a case whose ONLY approval
   is level1 the TAT is then zero by construction and counts as met.

   The first version of this check only looked at cases whose elapsed time was
   EXACTLY zero. None are — they are small positive values — so it measured
   nothing and reported nothing, which read as reassurance. It now runs on every
   scored case. */
var body1 = grab('function sellerTat_(dryRun)', 'function previewSellerTat');
ck('the stamp test runs outside the exact-zero branch',
   /if \(days === 0\) zero\+\+;/.test(body1), true);
ck('  and compares the submission to the FIRST approval',
   /Math\.abs\(firstApp\.getTime\(\) - sub\.getTime\(\)\) < 1000/.test(body1), true);
ck('  counting separately those whose only approval is level1',
   /if \(levels === 1\) sameOneLevel\+\+;/.test(body1), true);
ck('  within a second, not exact equality',
   body1.indexOf('< 1000') >= 0, true);
ck('it says so plainly when the stamps never coincide',
   body1.indexOf('genuinely fast approvals rather than an artefact') >= 0, true);
ck('  and quantifies the overstatement when they do',
   body1.indexOf('the share is overstated by') >= 0, true);
ck('  distinguishing a coincidence that has a LATER approval',
   body1.indexOf('later approval, so the TAT is still measured') >= 0, true);

/* the arithmetic of the artefact, so the reasoning is pinned */
ck('one level, stamps equal -> 0 days, counts as met',
   (function () {
     var t = tatOf('2026-05-01T10:00:00Z', [], ['2026-05-01T10:00:00Z', '', '', '']);
     return t.days === 0 && t.days <= 1;
   })(), true);
ck('  but a LATER approval makes it real again',
   r1(tatOf('2026-05-01T10:00:00Z', [],
     ['2026-05-01T10:00:00Z', '2026-05-03T10:00:00Z', '', '']).days), 2);

console.log('\n--- the ORDER of the skip tests decides what each count means ---');
/* "no owner rule matches: 1556" was reported as the in-window gap. It was not:
   the owner test ran BEFORE the date window, so it swept in every unattributed
   case back to 2019. The question actually asked — how many cases in review
   since 1 April 2026 belong to nobody — had never been measured. */
var body2 = grab('function sellerTat_(dryRun)', 'function previewSellerTat');
var atCutoff = body2.indexOf('if (startDay < ONBOARD_FROM_) { skip.before++');
var atOwner = body2.indexOf('var owner = onboardingOwner_');
ck('the cutoff is applied before the owner is looked up', atCutoff > 0, true);
ck('  and the owner test comes after it', atOwner > atCutoff, true);
ck('  so skip.noOwner counts IN-SCOPE cases only',
   body2.indexOf('IN SCOPE from here on') >= 0, true);
ck('the unattributed are broken down by vertical and category',
   /noOwnerBy\[gk\] = \(noOwnerBy\[gk\] \|\| 0\) \+ 1;/.test(body2), true);
ck('  and reported as a live gap rather than a historical one',
   body2.indexOf('live gap, not a historical one') >= 0, true);
ck('the counts are presented as a funnel, so each line is what survived',
   body2.indexOf('=== the funnel ===') >= 0, true);
ck('  and the funnel reconciles to the scored figure',
   body2.indexOf("'    = SCORED                           ' + scored") >= 0, true);
/* the cheap date-independent tests still come first, or the funnel misleads
   in the other direction */
ck('completeness is still tested first',
   body2.indexOf('!== ONBOARD_DONE_') < atCutoff, true);
ck('  and timeability before the cutoff too',
   body2.indexOf('skip.noApproval++') < atCutoff, true);

console.log('\n--- it refuses to compute if a column has moved ---');
var body = grab('function sellerTat_(dryRun)', 'function previewSellerTat');
ck('every pinned header is verified', body.indexOf('SELLER_EXPECT_[L]') >= 0, true);
ck('  and a mismatch aborts rather than guessing',
   body.indexOf('Refusing to compute') >= 0, true);
ck('a negative duration is excluded, not counted as met',
   body.indexOf('not a fast case') >= 0, true);
ck('a hand-entered actual is never overwritten',
   body.indexOf('keeps a hand-entered') >= 0, true);
ck('the note records the working',
   body.indexOf("' within ' + b.tat") >= 0, true);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
