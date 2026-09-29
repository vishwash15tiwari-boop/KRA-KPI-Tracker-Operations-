/* Exercises the REAL scopeModel_/visibleEmployees_ lifted out of Code.gs. */
/* Resolved against this file, not the shell's working directory, so the
   suite runs the same from the repo root, from tests/, or from a CI step. */
var ROOT = require('path').join(__dirname, '..');
var fs = require('fs');
var src = fs.readFileSync(require('path').join(ROOT, 'Code.gs'), 'utf8').replace(/\r\n/g, '\n');
function grab(a, b) { var i = src.indexOf(a), j = src.indexOf(b, i); return src.slice(i, j); }
eval(grab('function visibleEmployees_', '/* ------------------------------------------------------------------- API ---'));

var pass = 0, fail = 0;
function ck(label, got, want) {
  var ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + ': ' + JSON.stringify(got) +
    (ok ? '' : '   (want ' + JSON.stringify(want) + ')'));
}

/* three teams, five people, one row each, plus audit entries naming them */
function freshModel() {
  return {
    teams: [{ id: 't_omp', name: 'OMP_CT' }, { id: 't_col', name: 'Collections' },
            { id: 't_met', name: 'Metal' }],
    employees: [
      { id: 'E_ASHWIN', name: 'ASHWIN', team_id: 't_omp', status: 'lead' },
      { id: 'E_DIVYA',  name: 'DIVYA',  team_id: 't_omp' },
      { id: 'E_RAVI',   name: 'RAVI',   team_id: 't_col', status: 'lead' },
      { id: 'E_SRINI',  name: 'SRINI',  team_id: 't_col' },
      { id: 'E_AMIT',   name: 'AMIT',   team_id: 't_met', status: 'lead' }],
    kras: [{ id: 'k1' }], kpis: [{ id: 'p1' }],
    rows: [
      { employee_id: 'E_ASHWIN', kpi_id: 'p1', level: 4 },
      { employee_id: 'E_DIVYA',  kpi_id: 'p1', level: 2 },
      { employee_id: 'E_RAVI',   kpi_id: 'p1', level: 5 },
      { employee_id: 'E_SRINI',  kpi_id: 'p1', level: 1 },
      { employee_id: 'E_AMIT',   kpi_id: 'p1', level: 3 }],
    overalls: { E_ASHWIN: { score: 4 }, E_DIVYA: { score: 2 }, E_RAVI: { score: 5 },
                E_SRINI: { score: 1 }, E_AMIT: { score: 3 } },
    audit: [
      { entity_id: 'tgt_E_RAVI_p1_per_2026-08', actor: 'x', action: 'edit_bands' },
      { entity_id: 'prf_E_DIVYA_p1_per_2026-08', actor: 'x', action: 'record' },
      { entity_id: 'asg_E_AMIT_p1', actor: 'x', action: 'edit' },
      { entity_id: 'import', entity_type: 'system', actor: 'x', action: 'import_source' }]
  };
}
function names(m) { return m.employees.map(function (e) { return e.name; }); }
function rowOwners(m) { return m.rows.map(function (r) { return r.employee_id; }); }

console.log('--- scope all: an admin sees everything, untouched ---');
var m = freshModel();
var r = scopeModel_(m, { scope: { kind: 'all' }, employee_id: 'E_ASHWIN' });
ck('people', names(r), ['ASHWIN', 'DIVYA', 'RAVI', 'SRINI', 'AMIT']);
ck('rows', r.rows.length, 5);
ck('teams', r.teams.length, 3);
ck('audit', r.audit.length, 4);
ck('scoped flag', r.scoped, false);

console.log('\n--- scope team: ASHWIN (OMP_CT lead) sees only his 2 ---');
m = freshModel();
r = scopeModel_(m, { scope: { kind: 'team', team_id: 't_omp' }, employee_id: 'E_ASHWIN' });
ck('people', names(r), ['ASHWIN', 'DIVYA']);
ck('rows', rowOwners(r), ['E_ASHWIN', 'E_DIVYA']);
ck('overalls', Object.keys(r.overalls).sort(), ['E_ASHWIN', 'E_DIVYA']);
ck('teams', r.teams.map(function (t) { return t.name; }), ['OMP_CT']);
ck('RAVI score is absent', r.overalls.E_RAVI === undefined, true);
ck('audit keeps only his team', r.audit.map(function (a) { return a.entity_id; }),
  ['prf_E_DIVYA_p1_per_2026-08']);
ck('scoped flag', r.scoped, true);
ck('scope kind', r.scope_kind, 'team');
ck('catalogue untouched', [r.kras.length, r.kpis.length], [1, 1]);

console.log('\n--- scope self: an employee sees only themselves ---');
m = freshModel();
r = scopeModel_(m, { scope: { kind: 'self' }, employee_id: 'E_SRINI' });
ck('people', names(r), ['SRINI']);
ck('rows', rowOwners(r), ['E_SRINI']);
ck('teams', r.teams.map(function (t) { return t.name; }), ['Collections']);
ck('own lead not visible', r.employees.some(function (e) { return e.id === 'E_RAVI'; }), false);
ck('audit', r.audit.length, 0);

console.log('\n--- scope none / missing: nothing at all ---');
m = freshModel();
r = scopeModel_(m, { scope: { kind: 'none' }, employee_id: '' });
ck('people', r.employees.length, 0);
ck('rows', r.rows.length, 0);
ck('teams', r.teams.length, 0);
m = freshModel();
r = scopeModel_(m, {});
ck('no scope object at all -> nothing', r.employees.length, 0);

console.log('\n--- self with no employee_id must not fall open ---');
m = freshModel();
r = scopeModel_(m, { scope: { kind: 'self' }, employee_id: '' });
ck('people', r.employees.length, 0);

console.log('\n--- THE CACHE MUST NOT BE MUTATED ---');
/* buildModel_ hands back the very arrays that live in _CACHE, so an in-place
   splice here would delete people from the spreadsheet on the next commit_() */
var cacheEmployees = freshModel().employees;
var cacheTeams = freshModel().teams;
var model = { teams: cacheTeams, employees: cacheEmployees, kras: [], kpis: [],
              rows: [], overalls: {}, audit: [] };
scopeModel_(model, { scope: { kind: 'team', team_id: 't_omp' }, employee_id: 'E_ASHWIN' });
ck('original employees array intact', cacheEmployees.length, 5);
ck('original teams array intact', cacheTeams.length, 3);
ck('model got a NEW employees array', model.employees !== cacheEmployees, true);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
