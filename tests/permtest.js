/* Exercises the REAL can()/inScope()/mayTargets()/mayFramework()/mayActual()
   out of Index.html against a team_leader session, so what the UI will and will
   not offer Ashwin is asserted rather than eyeballed. */
/* Resolved against this file, not the shell's working directory, so the
   suite runs the same from the repo root, from tests/, or from a CI step. */
var ROOT = require('path').join(__dirname, '..');
var fs = require('fs');
var page = fs.readFileSync(require('path').join(ROOT, 'Index.html'), 'utf8').replace(/\r\n/g, '\n');
function grab(a, b) { var i = page.indexOf(a), j = page.indexOf(b, i); return page.slice(i, j); }

var S = {}, M = {};
eval(grab('function can(a){', 'function roleName(r)'));

var pass = 0, fail = 0;
function ck(label, got, want) {
  var ok = String(got) === String(want); ok ? pass++ : fail++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + ': ' + got + (ok ? '' : '   (want ' + want + ')'));
}

/* the model Ashwin now receives: his 8 OMP_CT people and nobody else */
M.emps = {
  'EMP-ASHWINKUMARS': { id: 'EMP-ASHWINKUMARS', name: 'ASHWIN KUMAR SINGH', team_id: 'team_omp' },
  'EMP-DIVYABOPPUR':  { id: 'EMP-DIVYABOPPUR',  name: 'DIVYA BOPPURI',      team_id: 'team_omp' }
};
S.session = { role_id: 'team_leader', employee_id: 'EMP-ASHWINKUMARS',
  perms: ['view', 'edit_target', 'enter_actual', 'export'],
  scope: { kind: 'team', team_id: 'team_omp' } };

console.log('--- what a team leader may do ---');
ck('view',            can('view'), true);
ck('edit_target',     can('edit_target'), true);
ck('enter_actual',    can('enter_actual'), true);
ck('export',          can('export'), true);
ck('edit_framework',  can('edit_framework'), false);
ck('admin',           can('admin'), false);

console.log('\n--- so the UI offers ---');
ck('Bands button on his own team',   mayTargets('EMP-DIVYABOPPUR'), true);
ck('Actual button on his own team',  mayActual('EMP-DIVYABOPPUR'), true);
ck('Add KPI / Edit assignment',      mayFramework('EMP-DIVYABOPPUR'), false);
ck('Administration page (needs admin or edit_framework)',
  can('admin') || can('edit_framework'), false);

console.log('\n--- and someone outside his team is unreachable even if he guesses the id ---');
M.emps['EMP-RAVINAIK'] = { id: 'EMP-RAVINAIK', name: 'RAVI NAIK', team_id: 'team_collections' };
ck('inScope(RAVI)',      inScope('EMP-RAVINAIK'), false);
ck('mayTargets(RAVI)',   mayTargets('EMP-RAVINAIK'), false);
ck('mayActual(RAVI)',    mayActual('EMP-RAVINAIK'), false);
ck('mayFramework(RAVI)', mayFramework('EMP-RAVINAIK'), false);

console.log('\n--- an ordinary employee: own scorecard only, own actuals only ---');
S.session = { role_id: 'employee', employee_id: 'EMP-DIVYABOPPUR',
  perms: ['view', 'enter_own'], scope: { kind: 'self' } };
ck('view',                       can('view'), true);
ck('own actual',                 mayActual('EMP-DIVYABOPPUR'), true);
ck('someone else\'s actual',     mayActual('EMP-ASHWINKUMARS'), false);
ck('edit own bands',             mayTargets('EMP-DIVYABOPPUR'), false);
ck('inScope(self)',              inScope('EMP-DIVYABOPPUR'), true);
ck('inScope(their lead)',        inScope('EMP-ASHWINKUMARS'), false);

console.log('\n--- no_access can do nothing at all ---');
S.session = { role_id: 'no_access', employee_id: '', perms: [], scope: { kind: 'none' } };
ck('view',   can('view'), false);
ck('actual', mayActual('EMP-DIVYABOPPUR'), false);
ck('bands',  mayTargets('EMP-DIVYABOPPUR'), false);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
