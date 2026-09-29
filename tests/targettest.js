/* Exercises the REAL readTargetTab_ / parseTargetValue_ / periodIdForMonthName_
   out of Code.gs against the actual Metals and Plastics grids, reconstructed
   cell-for-cell from the peekTargets output. */
/* Resolved against this file, not the shell's working directory, so the
   suite runs the same from the repo root, from tests/, or from a CI step. */
var ROOT = require('path').join(__dirname, '..');
var fs = require('fs');
var src = fs.readFileSync(require('path').join(ROOT, 'Code.gs'), 'utf8').replace(/\r\n/g, '\n');
function grab(a, b) { var i = src.indexOf(a), j = src.indexOf(b, i); return src.slice(i, j); }
eval(grab('function num_(v)', 'function slug_'));
eval(grab('var TARGET_TABS', '/* ==========================================================================\n * DERIVED TARGETS'));

var pass = 0, fail = 0;
function ck(label, got, want) {
  var ok = String(got) === String(want); ok ? pass++ : fail++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + ': ' + got + (ok ? '' : '   (want ' + want + ')'));
}
var D = '—', B = '';
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

/* --- Metals, exactly as peekTargets printed it --------------------------- */
var METALS = stub('Metals', [
 [B,B,B,B,B,B,B,B,B,B,B],
 ['METALS','METALS',B,'JUNE',B,'JULY',B,'AUGUST',B,'SEPTEMBER',B],
 [B,'EMPLOYEE NAME','KRA','Target','Achievement','Target','Achievement','Target','Achievement','Target','Achievement'],
 [B,'Amit Jha','Retention of Existing Transacted Sellers',D,D,0.5,D,0.5,D,0.5,D],
 [B,B,'New Buyer Acquisition',D,D,2,D,2,D,2,D],
 [B,B,'New Seller Acquisition',2,2,3,2,2,0,2,D],
 [B,B,'Transaction from New Onboarded Buyers',D,D,0.2,D,0.2,D,0.2,D],
 [B,B,'GMV (Crores)','₹4.11 Cr','₹4.11 Cr','₹5.00 Cr','₹7.19 Cr','₹6.50 Cr','₹7.43 Cr','₹6.80 Cr',D],
 [B,B,'Transaction Closure',D,D,D,D,D,D,D,D],
 [B,B,'DSO Days',D,D,3,D,3,D,3,D],
 [B,'Adarsh Krishna','Retention of Existing Transacted Sellers',D,D,0.5,D,0.5,D,0.5,D],
 [B,B,'New Buyer Acquisition',D,D,1,D,2,D,2,D]
]);

/* --- Plastics: one column further right, plus a SUPPLY/DEMAND column ----- */
var PLASTICS = stub('Plastics', [
 [B,B,B,B,B,B,B,B,B,B,B,B],
 [B,'PLASTICS',B,B,'JUNE',B,'JULY',B,'AUGUST',B,'SEPTEMBER',B],
 [B,B,'EMPLOYEE NAME','KRA','Target','Achievement','Target','Achievement','Target','Achievement','Target','Achievement'],
 [B,'SUPPLY','Ashish Kumar Rai','Transaction from Existing Sellers',5,3,7,5,8,7,8,3],
 [B,B,B,'Transaction from New Onboarded Sellers',2,B,1,B,1,1,0,B],
 [B,B,B,'New Seller Acquisition',9,9,6,5,4,2,4,0],
 [B,B,B,'GMV (Cr)',0.35099785,0.35099785,0.66,0.631327,0.6,2.06540466,0.94,0.3923618],
 [B,B,B,'Retention of Existing Transacted Sellers',B,B,3,B,4,4,5,B],
 [B,B,'Asraful Hasan','Transaction from Existing Sellers',5,2,6,4,7,3,7,0],
 [B,B,B,'Transaction from New Onboarded Sellers',2,B,1,B,1,0,0,B],
 [B,B,B,'New Seller Acquisition',10,10,1,1,3,2,3,0],
 [B,B,B,'GMV (Cr)',0.1553435,0.1553435,0.78,0.545733,0.87,0.7422936,0.94,0]
]);

console.log('--- month name -> period id (the tabs never state a year) ---');
ck('JUNE',      periodIdForMonthName_('JUNE'), 'per_2026-06');
ck('SEPTEMBER', periodIdForMonthName_('SEPTEMBER'), 'per_2026-09');
ck('APRIL',     periodIdForMonthName_('April'), 'per_2026-04');
ck('JANUARY rolls into the next calendar year',
   periodIdForMonthName_('JANUARY'), 'per_2027-01');
ck('MARCH also',  periodIdForMonthName_('march'), 'per_2027-03');
ck('not a month', String(periodIdForMonthName_('Target')), 'null');

console.log('\n--- value parsing, all three shapes that appear ---');
ck('plain number',       parseTargetValue_(0.66), 0.66);
ck('currency string',    parseTargetValue_('₹4.11 Cr'), 4.11);
ck('currency, thousands', parseTargetValue_('₹1,234.5 Cr'), 1234.5);
ck('em dash is NOT zero', String(parseTargetValue_('—')), 'null');
ck('blank is NOT zero',   String(parseTargetValue_('')), 'null');
ck('a real zero stays 0', parseTargetValue_(0), 0);
ck('long decimal kept',   parseTargetValue_(0.35099785), 0.35099785);

console.log('\n--- Metals: located by header text, not by index ---');
var m = readTargetTab_(METALS);
ck('warnings', m.warnings.join('|') || '(none)', '(none)');
ck('header row', m.headerRow, 3);
ck('name col', m.nameCol, 1);
ck('KRA col', m.kraCol, 2);
ck('no sub-group col', m.subCol, -1);
ck('months found', m.months.length, 4);
ck('JUNE target col', m.months[0].targetCol, 3);
ck('JUNE achievement col', m.months[0].achCol, 4);
ck('SEPTEMBER period', m.months[3].period_id, 'per_2026-09');
ck('KRA rows', m.rows.length, 9);
ck('name carried down to row 8', m.rows[4].name, 'Amit Jha');
ck('  that row is GMV', m.rows[4].kra, 'GMV (Crores)');
ck('  GMV June target parsed from "₹4.11 Cr"',
   m.rows[4].cells['per_2026-06'].target, 4.11);
ck('  GMV July achievement', m.rows[4].cells['per_2026-07'].achievement, 7.19);
ck('new block starts at Adarsh', m.rows[7].name, 'Adarsh Krishna');
ck('em-dash target -> null, not 0',
   String(m.rows[0].cells['per_2026-06'].target), 'null');
ck('New Seller Acquisition Aug achievement is a REAL zero',
   m.rows[2].cells['per_2026-08'].achievement, 0);

console.log('\n--- Plastics: different columns, same reader ---');
var p = readTargetTab_(PLASTICS);
ck('warnings', p.warnings.join('|') || '(none)', '(none)');
ck('header row', p.headerRow, 3);
ck('name col', p.nameCol, 2);
ck('KRA col', p.kraCol, 3);
ck('sub-group col found', p.subCol, 1);
ck('JUNE target col', p.months[0].targetCol, 4);
ck('KRA rows', p.rows.length, 9);
ck('first row name', p.rows[0].name, 'Ashish Kumar Rai');
ck('  sub-group carried', p.rows[0].subGroup, 'SUPPLY');
ck('  June target', p.rows[0].cells['per_2026-06'].target, 5);
ck('  Sep achievement', p.rows[0].cells['per_2026-09'].achievement, 3);
ck('sub-group carried down a block', p.rows[3].subGroup, 'SUPPLY');
/* Ashish has FIVE KRA rows (0..4), so the next person starts at 5 — my first
   pass indexed 4 and was asserting against Ashish's own Retention row */
ck('Ashish spans 5 rows, so Asraful starts at 5', p.rows[5].name, 'Asraful Hasan');
ck('GMV as a plain number', p.rows[3].cells['per_2026-06'].target, 0.35099785);
ck('  row 4 is Ashish / Retention', /^Retention/.test(p.rows[4].kra), true);
ck('  its blank June target -> null', String(p.rows[4].cells['per_2026-06'].target), 'null');

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
