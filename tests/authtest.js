/* Exercises the REAL resolveSession_ / can_ / ROLE_PERMS lifted out of Code.gs,
   with only the sheet layer and Session stubbed. */
/* Resolved against this file, not the shell's working directory, so the
   suite runs the same from the repo root, from tests/, or from a CI step. */
var ROOT = require('path').join(__dirname, '..');
var fs=require('fs'), src=fs.readFileSync(require('path').join(ROOT, 'Code.gs'),'utf8').replace(/\r\n/g,'\n');
function grab(a,b){var i=src.indexOf(a),j=src.indexOf(b,i);return src.slice(i,j);}
var T={EMPLOYEES:'EMPLOYEES',USERS:'USERS'};
var EMPS=[], USERS=[], EMAIL='';
function read_(n){return n===T.EMPLOYEES?EMPS:USERS;}
function ensureSeeded_(){return false;}
function idx_(a){var o={};a.forEach(function(x){o[x.id]=x;});return o;}
function currentEmail_(){return EMAIL;}
eval(grab('var ROLE_PERMS','function currentEmail_'));
eval(grab('function resolveSession_','/* May this session act'));

EMPS=[{id:'EMP-SRINIVASREDD',name:'SRINIVAS REDDY',status:'Active',team_id:'team_collections',email:''},
      {id:'EMP-RAVINAIK',name:'RAVI NAIK',status:'lead',team_id:'team_collections',email:'ravi.naik@recykal.com'},
      {id:'EMP-VISHWASH',name:'VISHWASH',status:'Active',team_id:'team_onboarding',email:'vishwash.tiwari@recykal.com'}];
USERS=[{id:'u_admin',name:'Platform Admin',email:'srinivasareddy.dundi@recykal.com',role_id:'super_admin',employee_id:''},
       {id:'u_hr',name:'HR / Admin',email:'',role_id:'hr_admin',employee_id:''},
       {id:'u_bad',name:'Typo Role',email:'typo@recykal.com',role_id:'suepr_admin',employee_id:''}];

var pass=0,fail=0;
function ck(label,got,want){var ok=String(got)===String(want);ok?pass++:fail++;
  console.log((ok?'PASS  ':'FAIL  ')+label+': '+got+(ok?'':'   (want '+want+')'));}

function as(email,viewAs){EMAIL=email;return resolveSession_(viewAs);}

console.log('--- USERS row wins, and is the only route to admin ---');
var s=as('srinivasareddy.dundi@recykal.com');
ck('owner role', s.role_id, 'super_admin');
ck('owner can view', can_(s,'view'), true);
ck('owner can switch', s.can_switch, true);
ck('owner gets USERS list', s.users.length, 3);

console.log('\n--- EMPLOYEES row = own scorecard only ---');
s=as('vishwash.tiwari@recykal.com');
ck('employee role', s.role_id, 'employee');
ck('employee id resolved', s.employee_id, 'EMP-VISHWASH');
ck('employee cannot admin', can_(s,'admin'), false);
ck('employee cannot edit targets', can_(s,'edit_target'), false);
ck('employee scope', s.scope.kind, 'self');
ck('employee gets NO USERS list', s.users.length, 0);

console.log('\n--- a lead gets their team ---');
s=as('ravi.naik@recykal.com');
ck('lead role', s.role_id, 'team_leader');
ck('lead scope', s.scope.kind, 'team');
ck('lead team', s.scope.team_id, 'team_collections');

console.log('\n--- THE FIX: an unknown address gets nothing ---');
s=as('anyone.else@recykal.com');
ck('unknown role', s.role_id, 'no_access');
ck('unknown can view', can_(s,'view'), false);
ck('unknown can admin', can_(s,'admin'), false);
ck('unknown scope', s.scope.kind, 'none');
ck('unknown gets NO USERS list', s.users.length, 0);

s=as('');
ck('blank email role', s.role_id, 'no_access');
ck('blank email can view', can_(s,'view'), false);

console.log('\n--- a seeded employee with no email is NOT auto-admin any more ---');
ck('SRINIVAS REDDY row has blank email', EMPS[0].email, '');
s=as('someone.new@recykal.com');
ck('still no_access', s.role_id, 'no_access');

console.log('\n--- view as: admins only, and a bad role cannot widen access ---');
s=as('srinivasareddy.dundi@recykal.com','u_hr');
ck('admin can view-as hr_admin', s.role_id, 'hr_admin');
s=as('vishwash.tiwari@recykal.com','u_admin');
ck('employee CANNOT view-as admin', s.role_id, 'employee');
s=as('anyone.else@recykal.com','u_admin');
ck('unknown CANNOT view-as admin', s.role_id, 'no_access');
s=as('typo@recykal.com');
ck('typo role falls back to no_access', s.role_id, 'no_access');
ck('typo cannot view', can_(s,'view'), false);

console.log('\n'+pass+' passed, '+fail+' failed');
process.exit(fail?1:0);
