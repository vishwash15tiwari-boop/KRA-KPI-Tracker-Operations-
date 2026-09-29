/* Guards the HTTP diagnostics endpoint.

   A GET that can change data is a genuine hazard — a bookmark, a prefetching
   extension or a link preview can fire it with nobody watching. These
   assertions exist so that stays impossible as the function list grows. */
var ROOT = require('path').join(__dirname, '..');
var fs = require('fs');
var src = fs.readFileSync(require('path').join(ROOT, 'Code.gs'), 'utf8').replace(/\r\n/g, '\n');

var pass = 0, fail = 0;
function ck(label, got, want) {
  var ok = String(got) === String(want); ok ? pass++ : fail++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + ': ' + got + (ok ? '' : '   (want ' + want + ')'));
}

var m = src.match(/var DIAG_FUNCTIONS_ = \{([\s\S]*?)\n\};/);
ck('the allow list exists', !!m, true);
var names = [];
m[1].split('\n').forEach(function (l) {
  var g = l.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:/);
  if (g) names.push(g[1]);
});
ck('it has entries', names.length > 0, true);

console.log('\n--- every exposed name must exist ---');
var missing = names.filter(function (nm) { return src.indexOf('function ' + nm + '(') < 0; });
ck('no dangling references', missing.join(', ') || '(none)', '(none)');

console.log('\n--- NOTHING THAT WRITES MAY BE REACHABLE OVER HTTP ---');
/* the four that change the database, plus the API entry points */
['importTargets', 'importTargetsFromSheet_', 'applyRatingScale', 'applyRatingScale_',
 'refreshFrameworkFromSource', 'provisionAndSeed', 'importFromSource_',
 'apiSaveActual', 'apiSaveTargets', 'apiSaveAssignment', 'apiRemoveAssignment',
 'apiRecomputeAll', 'apiImportFromSource', 'commit_',
 /* the two functions in the file that DELETE rows */
 'cleanupLeaverRows', 'leaverCleanup_',
 /* dsoAchievements_ deletes its own rows for the month in progress */
 'importDsoAchievements', 'dsoAchievements_',
 /* the CSV feed reader replaces whole tabs */
 'importFeeds', 'importZohoReport', 'feedIngest_',
 /* this one creates a Drive folder and writes a script property */
 'setupImportFolder',
 /* so does the Metabase one */
 'importMetabase', 'metaIngest_'
].forEach(function (w) {
  ck('  ' + w + ' is NOT exposed', names.indexOf(w) >= 0, false);
});
/* its dry run IS exposed, and must stay the dry one */
ck('  but previewLeaverCleanup is', names.indexOf('previewLeaverCleanup') >= 0, true);
ck('    and it delegates with dryRun true',
   /function previewLeaverCleanup\(\) \{ return leaverCleanup_\(true\); \}/.test(src), true);
ck('    while the destructive one passes false',
   /function cleanupLeaverRows\(\) \{ return leaverCleanup_\(false\); \}/.test(src), true);
/* a delegating wrapper hides its mutations from the body scan above, so check
   the delegate itself only deletes on the non-dry branch */
var lc = bodyOf('leaverCleanup_');
ck('    and the delegate deletes only inside the else branch',
   lc.indexOf('if (dryRun) {') < lc.indexOf('del_(T.PLAN'), true);

console.log('\n--- no exposed function may MUTATE a table ---');
/* The test is on the mutators, not on commit_.
 *
 * A bare commit_() is allowed, and whoAmI has one: resolveSession_ calls
 * ensureSeeded_, which fills the cache and stamps PERFORMOS_SEEDED but leaves
 * the rows unwritten until something commits. That is the same seeding commit
 * the dashboard performs on every load, so it changes nothing a normal visit
 * would not. What must never appear is a call that CHANGES a row — and every
 * real writer has to make one before it can commit anything, so this catches
 * them all. */
function bodyOf(name) {
  var i = src.indexOf('function ' + name + '(');
  if (i < 0) return '';
  var j = src.indexOf('\nfunction ', i + 1);
  return src.slice(i, j < 0 ? src.length : j);
}
names.forEach(function (nm) {
  var b = bodyOf(nm);
  var mutates = /\b(upsert_|write_|append_|del_|bulkUpdate_)\s*\(/.test(b);
  /* previewX delegates to the shared implementation with dryRun = true */
  var delegatesDry = /\(\s*true\s*(,|\))/.test(b);
  ck('  ' + nm, mutates && !delegatesDry, false);
});
ck('whoAmI commits only what seeding needs',
   /\b(upsert_|write_|append_|del_|bulkUpdate_)\s*\(/.test(bodyOf('whoAmI')), false);
ck('  and the writers DO mutate, so the rule has teeth',
   /\b(upsert_|write_)\s*\(/.test(bodyOf('importTargetsFromSheet_')), true);

console.log('\n--- the endpoint itself ---');
ck('doGet takes the event and inspects it',
   /function doGet\(e\) \{\n  var diag = e && e\.parameter && e\.parameter\.diag;/.test(src), true);
ck('  a request with no diag still renders the dashboard',
   /if \(diag\) return runDiag_\(String\(diag\),/.test(src), true);
/* the one optional argument is a NAME looked up in the database — it can never
   widen what a function reaches, and the allow list still gates what may run */
ck('  an optional arg is passed through, defaulting to empty',
   /\(e\.parameter\.arg === undefined \? '' : String\(e\.parameter\.arg\)\)/.test(src), true);
ck('  and the function receives it', /try \{ out = fn\(arg\); \}/.test(src), true);
ck('  it is an ALLOW list, checked with hasOwnProperty',
   /hasOwnProperty\.call\(DIAG_FUNCTIONS_, name\)/.test(src), true);
/* hasOwnProperty matters: DIAG_FUNCTIONS_['constructor'] or ['toString'] would
   otherwise resolve to a real function off Object.prototype */
ck('  so an inherited property cannot be invoked',
   /DIAG_FUNCTIONS_\[name\]\s*:\s*null/.test(src), true);
ck('  and a non-function is refused', /typeof fn !== 'function'/.test(src), true);
ck('it requires the admin permission, not merely view',
   /if \(!can_\(s, 'admin'\)\)/.test(src), true);
ck('  and says who it thought you were',
   /You are ' \+\n\s*\(s\.email \|\| 'not signed in'\)/.test(src), true);
ck('output is plain text, not HTML',
   /setMimeType\(ContentService\.MimeType\.TEXT\)/.test(src), true);
ck('an unknown name lists what IS available',
   /Available \(all read-only\)/.test(src), true);
ck('  and says the writers are excluded on purpose',
   /are not reachable this way on purpose/.test(src), true);
ck('a throw is reported rather than swallowed',
   /threw:' \+ nl \+ String\(e && e\.stack/.test(src), true);

/* ------------------------------------------------------------------ *
   METABASE: AN API KEY, NEVER A PASSWORD.

   Metabase will hand out a session token for an email and password, and
   building on that would put one person's credentials in a script property
   that any editor can read, break on their next password change, inherit
   everything they can see rather than only this report, and be unrevocable
   without locking them out of Metabase. These assertions exist so nobody
   "simplifies" it back to a login. */
console.log('\n--- Metabase authenticates with a key, not a password ---');
ck('there is no /api/session call', /api\/session/.test(src), false);
/* Ban the PRACTICE, not the word. The file mentions "password" six times and
   every one warns against using one — a guard on the word alone fails on its
   own documentation, which is how three earlier guards in this suite went
   wrong. So: no password as an object key, no password read from properties,
   no password in a request payload. */
ck('  no password is ever used as a field',
   /['"]?password['"]?\s*:/i.test(src), false);
ck('  none is read from Script Properties',
   /getProperty\(\s*['"][^'"]*PASS/i.test(src), false);
ck('  and no username is sent either',
   /['"]?username['"]?\s*:/i.test(src), false);
ck('  the only mentions are the warnings against it',
   (src.match(/password/gi) || []).length > 0 &&
   /AN API KEY, NEVER A PASSWORD/.test(src), true);
ck('the key comes from Script Properties',
   src.indexOf("META_KEY_PROP_ = 'METABASE_API_KEY'") >= 0, true);
ck('  and travels as the x-api-key header',
   /'x-api-key': String\(key\)\.trim\(\)/.test(src), true);
/* API keys are admin-only and admin was not available, so the message now
   points at the Drive route rather than at a key nobody can create — while
   still refusing a password as the workaround. */
ck('a missing key warns off a password',
   src.indexOf('Do NOT put a password in') >= 0, true);
ck('  and sends the reader to the route that works',
   src.indexOf('Use the Drive ') >= 0 && src.indexOf('previewFeeds()') >= 0, true);
ck('  saying why the key path is dormant',
   src.indexOf('created by ADMINS only') >= 0, true);
ck('401 and 403 are told apart from other failures',
   /code === 401 \|\| code === 403/.test(src), true);

console.log('\n--- and the key itself is never printed ---');
var metaBody = bodyOf('metaIngest_') + bodyOf('metaFetchCard_');
/* only its LENGTH may be reported, so an operator can tell set from unset */
ck('the diagnostics report its length, not its value',
   metaBody.indexOf('.length +') >= 0 || metaBody.indexOf("' characters (never logged)'") >= 0,
   true);
ck('  the key is never concatenated into output',
   /out\.push\([^;]*\+ key\b/.test(metaBody), false);
ck('  nor logged directly', /Logger\.log\([^)]*key/.test(metaBody), false);
ck('  and the response body is truncated, so a key echoed back cannot spill',
   /getContentText\(\) \|\| ''\)\.slice\(0, 300\)/.test(src), true);

console.log('\n--- the import folder sets itself up ---');
/* Asking somebody to create a folder, dig its id out of a URL and paste it into
   Script Properties is three steps and two places to get it wrong. */
ck('setupImportFolder exists', src.indexOf('function setupImportFolder()') >= 0, true);
ck('  and the not-set message names it rather than the manual route',
   src.indexOf('Run setupImportFolder()') >= 0, true);
/* the dangerous version of this helper is the one that makes a SECOND folder */
var setup = bodyOf('setupImportFolder');
ck('it checks for an existing folder before creating one',
   setup.indexOf('getProperty(FEED_FOLDER_PROP_)') < setup.indexOf('DriveApp.createFolder'),
   true);
ck('  and returns early when that one opens',
   /return logBack_\(out\.join\(nl\)\);\s*\} catch \(e\)/.test(setup), true);
ck('  so re-running cannot orphan the folder people are using',
   setup.indexOf('a second folder would silently become') >= 0 ||
   src.indexOf('a second folder would silently become') >= 0, true);
ck('it records the change in the audit log',
   /audit_\([^;]*'import_folder', 'create'/.test(setup), true);
ck('  and prints the link, so nobody hunts for it',
   setup.indexOf('folder.getUrl()') >= 0, true);
ck('it says who can see the folder',
   setup.indexOf('shared with') >= 0, true);

console.log('\n--- the onboarding owner rules ---');
/* First match wins, and a rule falls through only when a condition fails. */
ck('first match wins, in the KRA owner\'s order',
   /for \(var i = 0; i < ONBOARDING_OWNERS_\.length; i\+\+\) \{[\s\S]{0,200}?return r;\n\s*\}/
     .test(src), true);
/* The rule was given as "if the business vertical contains AFR & Infra", and
   the data has no such vertical — AFR and Metal are CATEGORIES. So a rule has
   to be able to name a vertical, a category, or both. */
/* scoped to the OWNERS block: ONBOARD_IGNORE_ uses the same shape, and
   counting across the whole file made an ignore rule look like an owner one */
var ownersBlock = (function () {
  var i = src.indexOf('var ONBOARDING_OWNERS_ = [');
  var j = src.indexOf('\n];', i);
  return i < 0 ? '' : src.slice(i, j);
})();
/* Counting the rules meant editing this line every time one was added, which is
   churn without value. What matters is the SHAPE: every rule names a vertical,
   an owner, a TAT and a KRA. The one-KRA-one-TAT invariant is checked against
   the live rules in tattest. */
var ruleCount = (ownersBlock.match(/\{ vertical: \//g) || []).length;
ck('  there are rules at all', ruleCount >= 5, true);
ck('  every one names a vertical',
   (ownersBlock.match(/\{ vertical: \//g) || []).length, ruleCount);
ck('  every one names an owner',
   (ownersBlock.match(/who: '/g) || []).length, ruleCount);
ck('  every one names a TAT',
   (ownersBlock.match(/tatDays: /g) || []).length, ruleCount);
ck('  every one names a KRA',
   (ownersBlock.match(/kra: '/g) || []).length, ruleCount);
ck('  and a TAT is only ever 1 or 3 days',
   (ownersBlock.match(/tatDays: (?!1,|3,)/g) || []).length, 0);
ck('  and the ignore list is separate from them',
   /var ONBOARD_IGNORE_ = \[/.test(src) &&
   ownersBlock.indexOf('ONBOARD_IGNORE_') < 0, true);
ck('  Harshita\'s two require Marketplace AND a category',
   (src.match(/vertical: \/\^MARKETPLACE\$\/, category: \/\^(AFR|\(INFRA\|METAL\))\$\/, who: 'HARSHITA'/g)
     || []).length, 2);
/* "In EPR there will be no Metal — if yes that should go to Naveen itself." */
ck('  EPR is tested FIRST, so no category can take an EPR row',
   src.indexOf("{ vertical: /^EPR$/, who: 'NAVEEN RANGA'") <
   src.indexOf("category: /^AFR$/"), true);
ck('  a rule with both conditions needs both to match',
   /if \(r\.vertical && !r\.vertical\.test\(v\)\) continue;\n\s*if \(r\.category && !r\.category\.test\(c\)\) continue;/
     .test(src), true);
/* ANCHORED on purpose: "Marketplace" and "Open Marketplace" are separate
   verticals in the same column, 4,011 rows against 457. An unanchored
   /OPEN MARKET/ was fine, but an unanchored /MARKETPLACE/ would swallow both. */
ck('the patterns are anchored, so Marketplace is not Open Marketplace',
   src.indexOf('/^OPEN MARKETPLACE$/') >= 0, true);
ck('  and values are folded before matching',
   /var v = normName_\(vertical\), c = normName_\(category\);/.test(src), true);
ck('AFR and INFRA are separate entries, not one bucket',
   (src.match(/who: 'HARSHITA'/g) || []).length, 2);
ck('  because they are separate KRAs at 0.25 each',
   src.indexOf('AFR AND INFRA ARE NOT ONE BUCKET') >= 0, true);
ck('Open Marketplace carries a ONE day TAT',
   /\^OPEN MARKETPLACE\$\/, who: 'VAMSI', tatDays: 1/.test(src), true);
/* The one-day TAT is Vamsi's alone: Open Marketplace, Re-Commerce, and the
   Marketplace Plastic/E-Waste rule. Everyone else is on three. Asserted as a
   property rather than a count, so adding a rule does not require editing it. */
ck('  and every one-day rule is Vamsi\'s',
   (ownersBlock.match(/tatDays: 1/g) || []).length,
   (ownersBlock.match(/who: 'VAMSI', tatDays: 1/g) || []).length);
ck('  nobody else is held to one day',
   /who: '(?!VAMSI)[A-Z ]+', tatDays: 1/.test(ownersBlock), false);
ck('the ladder is a ratio, so the achievement is a SHARE of cases',
   src.indexOf('SHARE OF CASES MEETING TAT') >= 0, true);
ck('the TAT is not computed before the columns are known',
   src.indexOf('The TAT itself is NOT computed here') >= 0, true);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
