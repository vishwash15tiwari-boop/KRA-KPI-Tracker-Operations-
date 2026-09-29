/* Exercises the REAL POC name reconciliation out of Code.gs — the alias table,
   the slash-separated shared accounts, the ignore list, and the Raw_Sellers /
   Raw_Buyers fallback. Every rule here was settled by the KRA owner on
   10 Sep 2026; each one decides whose scorecard a transaction lands on, so
   each one is pinned. */
var ROOT = require('path').join(__dirname, '..');
var fs = require('fs');
var src = fs.readFileSync(require('path').join(ROOT, 'Code.gs'), 'utf8').replace(/\r\n/g, '\n');
function grab(a, b) {
  var i = src.indexOf(a); if (i < 0) throw new Error('missing anchor: ' + a);
  var j = src.indexOf(b, i); if (j < 0) throw new Error('missing anchor: ' + b);
  return src.slice(i, j);
}
eval(grab('function num_(v)', 'function slug_'));
eval(grab('function normName_(v)', '/** Parse one target tab'));
eval(grab('var POC_TAB', '/** DRY RUN — can a shipment'));

var pass = 0, fail = 0;
function ck(label, got, want) {
  var ok = String(got) === String(want); ok ? pass++ : fail++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + ': ' + got + (ok ? '' : '   (want ' + want + ')'));
}
function stub(name, grid) {
  var maxC = 0; grid.forEach(function (r) { maxC = Math.max(maxC, r.length); });
  grid.forEach(function (r) { while (r.length < maxC) r.push(''); });
  return { getName: function () { return name; },
           getLastRow: function () { return grid.length; },
           getLastColumn: function () { return maxC; },
           getRange: function (r1, c1, nr, nc) {
             return { getValues: function () {
               return grid.slice(r1 - 1, r1 - 1 + nr).map(function (row) {
                 return row.slice(c1 - 1, c1 - 1 + nc); }); } };
           } };
}

/* the real roster, for the four names these rules touch */
var TEAMS = { tm: { id: 'tm', name: 'Metal' }, tp: { id: 'tp', name: 'Plastic' },
              tc: { id: 'tc', name: 'Open Marketplace - Control Tower' } };
var EMPS = [
  { id: 'E_ADARSH',  name: 'ADARSH KRISHNA', team_id: 'tm' },
  { id: 'E_PRAVEEN', name: 'PRAVEEN RAJ P',  team_id: 'tp' },
  { id: 'E_RAJU',    name: 'RAJU B',         team_id: 'tp' },
  { id: 'E_RISHI',   name: 'RISHI PANCHAL',  team_id: 'tp' },
  { id: 'E_PARTH',   name: 'PARTH GAUTAM',   team_id: 'tp' },
  { id: 'E_ARVIND',  name: 'ARVIND JAKKULA', team_id: 'tc' }
];
var byName = {};
EMPS.forEach(function (e) { byName[normName_(e.name)] = e; });
function who(cell, cat) {
  var r = resolvePocEmployee_(cell, cat, byName, TEAMS);
  return r.emp ? r.emp.name : 'null';
}
function why(cell, cat) { return resolvePocEmployee_(cell, cat, byName, TEAMS).why; }

console.log('--- "#N/A" must be caught BEFORE the slash split ---');
/* splitting "#N/A" on "/" yields ["#N","A"], two things that are not names */
ck('#N/A',      JSON.stringify(splitPocCell_('#N/A')), '[]');
ck('N/A',       JSON.stringify(splitPocCell_('N/A')), '[]');
ck('n/a lower', JSON.stringify(splitPocCell_('n/a')), '[]');
ck('NA',        JSON.stringify(splitPocCell_('NA')), '[]');
ck('blank',     JSON.stringify(splitPocCell_('')), '[]');
ck('null',      JSON.stringify(splitPocCell_(null)), '[]');
ck('a real name is not mistaken for N/A',
   JSON.stringify(splitPocCell_('Naresh')), '["Naresh"]');

console.log('\n--- one cell, two people ---');
ck('splits on the slash',
   JSON.stringify(splitPocCell_('Praveen Raj P/Adarsh Krishnan V')),
   '["Praveen Raj P","Adarsh Krishnan V"]');
ck('  and trims',
   JSON.stringify(splitPocCell_(' Raju B / Adarsh Krishnan V ')),
   '["Raju B","Adarsh Krishnan V"]');
ck('a single name is left alone',
   JSON.stringify(splitPocCell_('Neelesh Dixit')), '["Neelesh Dixit"]');

console.log('\n--- the alias table ---');
ck('Adarsh Krishnan V -> ADARSH KRISHNA', canonPocName_('Adarsh Krishnan V'), 'ADARSH KRISHNA');
ck('bare Adarsh       -> ADARSH KRISHNA', canonPocName_('Adarsh'), 'ADARSH KRISHNA');
ck('Adarsh Krishna    -> itself',         canonPocName_('Adarsh Krishna'), 'ADARSH KRISHNA');
ck('Panchal Rishi     -> RISHI PANCHAL',  canonPocName_('Panchal Rishi'), 'RISHI PANCHAL');
ck('Rishi Panchal     -> itself',         canonPocName_('Rishi Panchal'), 'RISHI PANCHAL');
ck('an unlisted name passes through',     canonPocName_('Neelesh Dixit'), 'NEELESH DIXIT');
/* HANDOVER: Abhisek Sanyal left on 15 Sep 2026 and his accounts and figures
   passed to Adarsh Krishna, history included. Every spelling of his name now
   resolves to Adarsh. */
ck('Abhisek Sanyal  -> ADARSH KRISHNA', canonPocName_('Abhisek Sanyal'), 'ADARSH KRISHNA');
ck('Abhishek Sanyal -> ADARSH KRISHNA', canonPocName_('Abhishek Sanyal'), 'ADARSH KRISHNA');
ck('bare Abhisek    -> ADARSH KRISHNA', canonPocName_('Abhisek'), 'ADARSH KRISHNA');
ck('bare Abhishek   -> ADARSH KRISHNA', canonPocName_('Abhishek'), 'ADARSH KRISHNA');
/* canonPersonName_ does ONE lookup, not a chain, so every spelling has to point
   straight at the destination — a two-hop alias would stop halfway */
ck('  nothing stops at the old name',
   [canonPocName_('Abhisek'), canonPocName_('Abhishek Sanyal')]
     .indexOf('ABHISEK SANYAL'), -1);
ck('  and the destination matches the employee row exactly, or the id breaks',
   canonPocName_('ADARSH KRISHNA'), 'ADARSH KRISHNA');

console.log('\n--- the leaver check must NOT canonicalise first ---');
/* canonPersonName_('Abhisek') is now ADARSH KRISHNA. Asking "is the canonical
   name a leaver?" would hide the person who took the work over. */
ck('Abhisek is hidden', isLeaver_('Abhisek Sanyal'), true);
ck('  the other spelling too', isLeaver_('Abhishek Sanyal'), true);
ck('ADARSH KRISHNA IS NOT HIDDEN', isLeaver_('Adarsh Krishna'), false);
ck('  nor via his own alias', isLeaver_('Adarsh Krishnan V'), false);
ck('  nor anybody else', isLeaver_('Amit Jha'), false);

console.log('\n--- a shared account follows the MATERIAL SUPPLIED ---');
/* Praveen is on Plastic, Adarsh on Metal, so the shipment's own category
   decides. This is the KRA owner's rule, and it needs no guessing. */
ck('Plastic shipment -> Praveen',
   who('Praveen Raj P/Adarsh Krishnan V', 'Plastic'), 'PRAVEEN RAJ P');
ck('Metal shipment   -> Adarsh',
   who('Praveen Raj P/Adarsh Krishnan V', 'Metal'), 'ADARSH KRISHNA');
ck('Raju pair, Plastic -> Raju',
   who('Raju B/Adarsh Krishnan V', 'Plastic'), 'RAJU B');
ck('Raju pair, Metal   -> Adarsh',
   who('Raju B/Adarsh Krishnan V', 'Metal'), 'ADARSH KRISHNA');
ck('order in the cell does not matter',
   who('Adarsh Krishnan V/Praveen Raj P', 'Plastic'), 'PRAVEEN RAJ P');

console.log('\n--- a shared account it CANNOT split is refused, not awarded ---');
ck('material matches neither -> null',
   who('Praveen Raj P/Adarsh Krishnan V', 'Paper'), 'null');
ck('  and it says why',
   /shared account/.test(why('Praveen Raj P/Adarsh Krishnan V', 'Paper')), true);
ck('material matches BOTH -> null',
   who('Praveen Raj P/Raju B', 'Plastic'), 'null');
ck('  2 of 2 reported',
   /matches 2 of 2/.test(why('Praveen Raj P/Raju B', 'Plastic')), true);

console.log('\n--- the ignore list, and why it is a list and not a heuristic ---');
ck('Nomul Aravind -> null', who('Nomul Aravind', 'Plastic'), 'null');
/* A reversed/fuzzy matcher would have landed "Aravind" on ARVIND JAKKULA, who
   is on the Control Tower team and has nothing to do with these accounts. */
ck('  it did NOT drift to ARVIND JAKKULA',
   who('Nomul Aravind', 'Plastic') === 'ARVIND JAKKULA', false);
ck('  reported as ignored', why('Nomul Aravind', 'Plastic'), 'ignored');
ck('a shared cell still works when one half is ignored',
   who('Nomul Aravind/Parth Gautam', 'Plastic'), 'PARTH GAUTAM');

console.log('\n--- a single name resolves regardless of material ---');
/* only a SHARED cell needs the material to disambiguate */
ck('Adarsh alone on a Plastic shipment still resolves',
   who('Adarsh Krishnan V', 'Plastic'), 'ADARSH KRISHNA');
ck('Panchal Rishi resolves', who('Panchal Rishi', 'Plastic'), 'RISHI PANCHAL');

console.log('\n--- an unknown single name is reported by name ---');
ck('null', who('Someone Nobody', 'Plastic'), 'null');
ck('  named in the reason', /no employee: Someone Nobody/.test(why('Someone Nobody', 'Plastic')), true);
ck('blank cell', why('', 'Plastic'), 'blank');
ck('#N/A cell', why('#N/A', 'Metal'), 'blank');

/* --- Raw_Sellers / Raw_Buyers, the Metal fallback ------------------------ */
var SELLERS = stub('Raw_Sellers', [
  ['id', 'business_vertical', 'business_category', 'business_name', 'POC_Name'],
  ['71750', 'Open Marketplace', 'Metal',   'AAYAS STEELS',    'Adarsh Krishnan V'],
  ['71751', 'Open Marketplace', 'Plastic', 'MAHER TRADERS',   'Panchal Rishi'],
  ['71752', 'Open Marketplace', 'Metal',   'RAJ METAL INDUSTRIES', '#N/A'],
  ['71753', 'Open Marketplace', 'Metal',   '',                'Adarsh Krishnan V'],
  ['71754', 'Open Marketplace', 'Plastic', 'SMS TRADERS',     '']
]);

console.log('\n--- Raw_Sellers: located by header, junk rows dropped ---');
var acc = readAccountPoc_(SELLERS);
ck('no missing columns', acc.missing.join(',') || '(none)', '(none)');
ck('2 usable rows of 5', acc.count, 2);
ck('  #N/A row dropped',      String(acc.map['Metal|RAJ METAL INDUSTRIES']), 'undefined');
ck('  nameless row dropped',  Object.keys(acc.map).filter(function (k) {
     return k === 'Metal|'; }).length, 0);
ck('  POC-less row dropped',  String(acc.map['Plastic|SMS TRADERS']), 'undefined');
ck('keyed by material+name',  acc.map['Metal|AAYAS STEELS'], 'Adarsh Krishnan V');
ck('distinct POC names collected for the report',
   Object.keys(acc.pocNames).sort().join(','), 'ADARSH KRISHNAN V,PANCHAL RISHI');
ck('  the #N/A row contributed no POC name',
   String(acc.pocNames['N A']), 'undefined');

console.log('\n--- the fallback chain: POC_data first, Raw_Sellers second ---');
var pocData = { 'Plastic|MAHER TRADERS': 'Neelesh Dixit' };
ck('POC_data wins where both have it',
   pocForChain_([pocData, acc.map], 'Maher Traders', 'Plastic'), 'Neelesh Dixit');
ck('Raw_Sellers covers what POC_data cannot (Metal)',
   pocForChain_([pocData, acc.map], 'AAYAS STEELS', 'Metal'), 'Adarsh Krishnan V');
ck('still nothing for a genuinely unknown account',
   String(pocForChain_([pocData, acc.map], 'WHO KNOWS LTD', 'Metal')), 'null');
ck('the material guard survives the chain',
   String(pocForChain_([pocData, acc.map], 'AAYAS STEELS', 'Plastic')), 'null');

console.log('\n--- end to end: a Metal shipment now reaches a person ---');
ck('AAYAS STEELS / Metal -> ADARSH KRISHNA',
   who(pocForChain_([pocData, acc.map], 'AAYAS STEELS', 'Metal'), 'Metal'), 'ADARSH KRISHNA');
ck('MAHER TRADERS / Plastic -> the alias resolves too',
   who(pocForChain_([{}, acc.map], 'MAHER TRADERS', 'Plastic'), 'Plastic'), 'RISHI PANCHAL');

console.log('\n--- a tab missing its columns is refused, not read by position ---');
var badAcc = readAccountPoc_(stub('Raw_Sellers', [['id', 'name'], ['1', 'X']]));
ck('missing all three', badAcc.missing.length, 3);
ck('  and no rows read', badAcc.count, 0);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
