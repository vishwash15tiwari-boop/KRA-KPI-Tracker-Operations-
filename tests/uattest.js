/* Exercises the REAL openAccessState_ + resolveSession_ out of Code.gs. */
/* Resolved against this file, not the shell's working directory, so the
   suite runs the same from the repo root, from tests/, or from a CI step. */
var ROOT = require('path').join(__dirname, '..');
var fs = require('fs');
var src = fs.readFileSync(require('path').join(ROOT, 'Code.gs'), 'utf8').replace(/\r\n/g, '\n');
function grab(a, b) { var i = src.indexOf(a), j = src.indexOf(b, i); return src.slice(i, j); }

var T = { EMPLOYEES: 'EMPLOYEES', USERS: 'USERS' };
var EMPS = [], USERS = [], EMAIL = '', PROPS = {};
var PROP_ADMINS = 'PERFORMOS_ADMINS', PROP_OPEN = 'PERFORMOS_OPEN_ACCESS';
function read_(x) { return x === T.EMPLOYEES ? EMPS : USERS; }
function ensureSeeded_() { return false; }
function idx_(a) { var o = {}; a.forEach(function (x) { o[x.id] = x; }); return o; }
var PropertiesService = { getScriptProperties: function () {
  return { getProperty: function (k) { return PROPS[k] || null; } }; } };

eval(grab('var ROLE_PERMS', 'function email_'));
eval(grab('function email_', 'function currentEmail_'));
function currentEmail_() { return email_(EMAIL); }
eval(grab('function resolveSession_', '/* May this session act'));

var pass = 0, fail = 0;
function ck(label, got, want) {
  var ok = String(got) === String(want); ok ? pass++ : fail++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + ': ' + got + (ok ? '' : '   (want ' + want + ')'));
}

EMPS = [{ id: 'EMP-ASHWIN', name: 'ASHWIN', status: 'lead', team_id: 't_omp', email: '' },
        { id: 'EMP-DIVYA', name: 'DIVYA', status: 'Active', team_id: 't_omp', email: '' }];
USERS = [{ id: 'u_admin', name: 'Platform Admin', email: '', role_id: 'super_admin', employee_id: '' }];

function as(email) { EMAIL = email; return resolveSession_(); }
var STRANGER = 'someone.random@recykal.com';
var TOMORROW = new Date(Date.now() + 864e5).toISOString().slice(0, 10);
var YESTERDAY = new Date(Date.now() - 864e5).toISOString().slice(0, 10);

console.log('--- property NOT set: the strict gate stands ---');
PROPS = {};
ck('stranger', as(STRANGER).role_id, 'no_access');
ck('open_access flag', as(STRANGER).open_access, 'null');

console.log('\n--- a future date: UAT mode on ---');
PROPS[PROP_OPEN] = TOMORROW;
var s1 = as(STRANGER);
ck('stranger becomes super_admin', s1.role_id, 'super_admin');
ck('can view', can_(s1, 'view'), true);
ck('can admin', can_(s1, 'admin'), true);
ck('scope', s1.scope.kind, 'all');
ck('banner value', s1.open_access, TOMORROW);

console.log('\n--- "always": on with no expiry ---');
PROPS[PROP_OPEN] = 'always';
ck('role', as(STRANGER).role_id, 'super_admin');
ck('banner value', as(STRANGER).open_access, 'always');
PROPS[PROP_OPEN] = 'TRUE';
ck('"TRUE" also accepted', as(STRANGER).role_id, 'super_admin');

console.log('\n--- a PAST date: closes itself, no code change needed ---');
PROPS[PROP_OPEN] = YESTERDAY;
ck('role', as(STRANGER).role_id, 'no_access');
ck('banner value', as(STRANGER).open_access, 'null');

console.log('\n--- unparseable values FAIL CLOSED, never open ---');
['yes please', 'soon', '??', 'later', '0', 'false', 'off', 'no'].forEach(function (v) {
  PROPS[PROP_OPEN] = v;
  ck('"' + v + '"', as(STRANGER).role_id, 'no_access');
});

console.log('\n--- an unsigned session is still refused even in UAT mode ---');
PROPS[PROP_OPEN] = 'always';
ck('empty email', as('').role_id, 'no_access');

console.log('\n--- UAT mode does not erase a real role, it raises it ---');
PROPS[PROP_OPEN] = 'always';
EMPS[0].email = 'ashwin.singh@recykal.com';
var s2 = as('ashwin.singh@recykal.com');
ck('the OMP_CT lead is raised to super_admin', s2.role_id, 'super_admin');
PROPS[PROP_OPEN] = '';
var s3 = as('ashwin.singh@recykal.com');
ck('and drops back to team_leader when it is off', s3.role_id, 'team_leader');
ck('with his team scope', s3.scope.kind + ':' + s3.scope.team_id, 'team:t_omp');

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
