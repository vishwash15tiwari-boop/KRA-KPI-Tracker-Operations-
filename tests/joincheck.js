/* Exercises the REAL readPocMap_ / readShipments_ / periodIdFromDate_ /
   shipmentCounts_ out of Code.gs, against grids rebuilt from the describeTab_
   output: POC_data's two-tier header, and Raw_Shipments' real column names. */
/* Resolved against this file, not the shell's working directory, so the
   suite runs the same from the repo root, from tests/, or from a CI step. */
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
var RUPEES_PER_CRORE = 1e7;
var SHIPMENTS_TAB = 'Raw_Shipments';
var SHIPMENTS_EXCLUDE_STATUS = ['cancelled'];

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

console.log('--- the month a shipment belongs to ---');
ck('ISO string',        periodIdFromDate_('2026-06-12T22:48:35'), 'per_2026-06');
ck('a shipment at 00:0x on the 1st stays in ITS month',
                        periodIdFromDate_('2026-07-01T00:04:00'), 'per_2026-07');
ck('and at 23:5x on the last day too',
                        periodIdFromDate_('2026-06-30T23:59:00'), 'per_2026-06');
ck('dd/mm/yyyy (invoice_date)', periodIdFromDate_('13/06/2026'), 'per_2026-06');
ck('blank',             String(periodIdFromDate_('')), 'null');
ck('nonsense',          String(periodIdFromDate_('n/a')), 'null');

console.log('\n--- cancelled shipments do not count ---');
ck('CANCELLED',  shipmentCounts_({ status: 'CANCELLED' }), false);
ck('lower case', shipmentCounts_({ status: 'cancelled' }), false);
ck('padded',     shipmentCounts_({ status: '  CANCELLED ' }), false);
ck('COMPLETED',  shipmentCounts_({ status: 'COMPLETED' }), true);
ck('DISPATCHED', shipmentCounts_({ status: 'DISPATCHED' }), true);
ck('DRAFT is NOT cancelled, so it counts',
                 shipmentCounts_({ status: 'DRAFT' }), true);

/* --- POC_data, exactly the shape describeTab_ reported ------------------- */
var POC = stub('POC_data', [
 ['Plastic Seller', '',                 '', '', 'Plastic Buyer',        ''],
 ['SellerName',     'POC',              '', '', 'Buyer Name',           'POC'],
 ['MAHER TRADERS',  'Ashish Kumar Rai', '', '', 'Jai Narain Enterprises', 'Neelesh Dixit'],
 ['SMS TRADERS',    'Asraful Hasan',    '', '', 'CHIRIPAL POLY FILMS',  'Panchal Rishi'],
 ['MAA SHYAMA TRADERS', 'Brajendra Upadhyay', '', '', 'PASHUPATI POLYTEX', 'Abhisek Sanyal'],
 ['AAYAS STEELS',   'Ashish Kumar Rai', '', '', '',                     ''],
 ['', '', '', '', '', '']
]);

console.log('\n--- POC_data: a two-tier header, found by text ---');
var p = readPocMap_(POC);
ck('warnings', p.warnings.join('|') || '(none)', '(none)');
ck('header is row 2, not row 1', p.headerRow, 2);
ck('two groups found', p.groups.length, 2);
ck('group 1 is the sellers', p.groups[0].kind, 'seller');
ck('  labelled from the row ABOVE', p.groups[0].label, 'Plastic Seller');
ck('  name c0 -> POC c1', p.groups[0].nameCol + '->' + p.groups[0].pocCol, '0->1');
ck('  4 accounts', p.groups[0].count, 4);
ck('group 2 is the buyers', p.groups[1].kind, 'buyer');
ck('  skips the two blank columns', p.groups[1].nameCol + '->' + p.groups[1].pocCol, '4->5');
ck('  3 accounts', p.groups[1].count, 3);
ck('the group records its material', p.groups[0].material, 'Plastic');
ck('seller lookup', pocFor_(p.sellerPoc, 'Maher Traders', 'Plastic'), 'Ashish Kumar Rai');
ck('  is case and punctuation blind',
   pocFor_(p.sellerPoc, 'maher   traders', 'Plastic'), 'Ashish Kumar Rai');
ck('buyer lookup', pocFor_(p.buyerPoc, 'JAI NARAIN ENTERPRISES', 'Plastic'), 'Neelesh Dixit');
ck('a buyer is NOT reachable through the seller map',
   String(pocFor_(p.sellerPoc, 'Jai Narain Enterprises', 'Plastic')), 'null');
ck('one POC can hold several accounts',
   pocFor_(p.sellerPoc, 'AAYAS STEELS', 'Plastic'), 'Ashish Kumar Rai');

console.log('\n--- the material must match: POC_data is plastic-only ---');
/* AAYAS STEELS is in the Plastic Seller column. A METAL shipment from an
   identically named account must NOT borrow that column's POC. */
ck('same name, Metal shipment -> no POC',
   String(pocFor_(p.sellerPoc, 'AAYAS STEELS', 'Metal')), 'null');
ck('  the Plastic one still resolves',
   pocFor_(p.sellerPoc, 'AAYAS STEELS', 'Plastic'), 'Ashish Kumar Rai');
ck('an unstated category does not silently match a Plastic row',
   String(pocFor_(p.sellerPoc, 'AAYAS STEELS', '')), 'null');
ck('a blank name never matches', String(pocFor_(p.sellerPoc, '', 'Plastic')), 'null');
ck('distinct POCs collected', Object.keys(p.pocNames).length, 6);
ck('  the literal header "POC" was not collected as a person',
   String(p.pocNames['POC']), 'undefined');

console.log('\n--- an account under two POCs is reported, not silently overwritten ---');
var POC2 = stub('POC_data', [
 ['Plastic Seller', ''],
 ['SellerName', 'POC'],
 ['MAHER TRADERS', 'Ashish Kumar Rai'],
 ['Maher  Traders', 'Asraful Hasan']
]);
var p2 = readPocMap_(POC2);
ck('clash detected', p2.groups[0].clashes.length, 1);
ck('  and it names both POCs', /Ashish Kumar Rai vs Asraful Hasan/.test(p2.groups[0].clashes[0]), true);

console.log('\n--- a group with no material stated covers every material ---');
var PANY = stub('POC_data', [
 ['Seller', ''],
 ['SellerName', 'POC'],
 ['AAYAS STEELS', 'Amit Jha']
]);
var pa = readPocMap_(PANY);
ck('material is blank', pa.groups[0].material, '');
ck('  Metal resolves', pocFor_(pa.sellerPoc, 'AAYAS STEELS', 'Metal'), 'Amit Jha');
ck('  Plastic resolves too', pocFor_(pa.sellerPoc, 'AAYAS STEELS', 'Plastic'), 'Amit Jha');

console.log('\n--- a tab with no POC header is refused, not half-read ---');
var p3 = readPocMap_(stub('POC_data', [['Seller', 'Owner'], ['X', 'Y']]));
ck('no groups', p3.groups.length, 0);
ck('and it says why', /no "POC" header/.test(p3.warnings[0]), true);

/* --- Raw_Shipments, real header names, 62 columns compressed ------------- */
var H = ['shipment_id', 'shipment_status', 'shipment_created_date', 'seller_name',
         'seller_category', 'buyer_name', 'buyer_category', 'shipment_value',
         'dispatched_quantity'];
function sr(id, status, date, sn, sc, bn, bc, val, q) {
  return [id, status, date, sn, sc, bn, bc, val, q];
}
var SHIP = stub('Raw_Shipments', [H,
  sr('SH1', 'CANCELLED',  '2026-06-12T22:48:35', 'MAHER TRADERS', 'Plastic', 'Jai Narain Enterprises', 'Plastic', '524160.000000', '9360.000'),
  sr('SH2', 'COMPLETED',  '2026-06-13T21:34:04', 'MAHER TRADERS', 'Plastic', 'Jai Narain Enterprises', 'Plastic', '847700.000000', '24220.000'),
  sr('SH3', 'DISPATCHED', '2026-07-14T09:13:07', 'SMS TRADERS',   'Plastic', 'CHIRIPAL POLY FILMS',    'Plastic', '869750.000000', '24850.000'),
  sr('SH4', 'COMPLETED',  '2026-07-17T23:20:31', 'AAYAS STEELS',  'Metal',   'NATRAJ IRON',            'Metal',   '580720.000000', '10370.000'),
  sr('SH5', 'COMPLETED',  '2026-08-02T10:00:00', 'UNKNOWN TRADER','Metal',   'UNKNOWN BUYER',          'Metal',   '100000.000000', '1000.000'),
  sr('',    'COMPLETED',  '2026-08-02T10:00:00', 'X',             'Metal',   'Y',                      'Metal',   '1', '1')
]);

console.log('\n--- Raw_Shipments: located by header name, blank ids dropped ---');
var sp = readShipments_(SHIP);
ck('no missing columns', sp.missing.join(',') || '(none)', '(none)');
ck('5 rows, the id-less one dropped', sp.rows.length, 5);
ck('status read', sp.rows[0].status, 'CANCELLED');
ck('month read', sp.rows[0].period_id, 'per_2026-06');
ck('rupee value is a NUMBER, not the string', sp.rows[1].value, 847700);
ck('  and it is rupees, so 847700 is 0.08 Cr, not 847700 Cr',
   Math.round(sp.rows[1].value / RUPEES_PER_CRORE * 100) / 100, 0.08);
ck('quantity read', sp.rows[1].qty, 24220);
ck('category read', sp.rows[3].sellerCat, 'Metal');

console.log('\n--- a missing column is refused loudly, never guessed by position ---');
var bad = readShipments_(stub('Raw_Shipments', [['shipment_id', 'status'], ['SH1', 'X']]));
ck('reports what is missing', bad.missing.indexOf('shipment_status') >= 0, true);
ck('  and returns no rows rather than wrong ones', bad.rows.length, 0);

console.log('\n--- the join, end to end ---');
var live = sp.rows.filter(shipmentCounts_);
ck('4 of 5 count (SH1 cancelled)', live.length, 4);
var att = live.map(function (r) {
  return { id: r.id, s: pocFor_(p.sellerPoc, r.sellerName, r.sellerCat),
                     b: pocFor_(p.buyerPoc, r.buyerName, r.buyerCat) };
});
ck('SH2 seller -> Ashish', att[0].s, 'Ashish Kumar Rai');
ck('SH2 buyer  -> Neelesh', att[0].b, 'Neelesh Dixit');
ck('SH3 seller -> Asraful', att[1].s, 'Asraful Hasan');
/* AAYAS STEELS IS in the Plastic Seller column, but SH4 is a Metal shipment,
   so the material guard refuses it. Before that guard this returned
   'Ashish Kumar Rai' — a Metal shipment credited to a Plastic POC. */
ck('SH4 is METAL and POC_data is plastic-only, so no seller POC',
   String(att[2].s), 'null');
ck('  and no buyer POC either', String(att[2].b), 'null');
ck('SH5 unknown on both sides', String(att[3].s) + '/' + String(att[3].b), 'null/null');
var attributable = att.filter(function (a) { return a.s || a.b; }).length;
ck('only 2 of the 4 counted shipments can be attributed', attributable, 2);

console.log('\n--- GMV in crore, cancelled excluded ---');
var gmv = live.reduce(function (t, r) { return t + (r.value || 0); }, 0);
ck('sum of the 4 counted', gmv, 2398170);
ck('  as crore', Math.round(gmv / RUPEES_PER_CRORE * 10000) / 10000, 0.2398);
ck('  the cancelled 524160 was NOT included', gmv < 2398170 + 524160, true);

console.log('\n--- receivables: the payment columns ---');
eval(grab('function daysInMonth_(periodId) {', '/** DRY RUN — GMV, receivables'));
var PAY = ['shipment_id', 'shipment_status', 'shipment_created_date', 'seller_name',
  'seller_category', 'buyer_name', 'buyer_category', 'shipment_value',
  'dispatched_quantity', 'paid_amount', 'invoice_date', 'shipment_stage_label',
  'status_timeline'];
function pr(id, status, date, val, paid, inv, tl) {
  return [id, status, date, 'S', 'Metal', 'B', 'Metal', val, '100', paid, inv, 'x',
          tl || ''];
}
var PS = stub('Raw_Shipments', [PAY,
  pr('P1', 'COMPLETED', '2026-06-10T00:00:00', '1000000', '400000', '11/06/2026'),
  pr('P2', 'COMPLETED', '2026-06-12T00:00:00', '500000', '', '13/06/2026'),
  pr('P3', 'COMPLETED', '2026-06-14T00:00:00', '900000', '900000', ''),
  pr('P4', 'CANCELLED', '2026-06-15T00:00:00', '800000', '', '15/06/2026')
]);
var ps = readShipments_(PS);
ck('all four rows read', ps.rows.length, 4);
ck('paid_amount parsed', ps.rows[0].paid, 400000);
/* the column fills only when money arrives, so blank is NOT zero exposure —
   it is the whole invoice outstanding */
ck('a BLANK paid_amount is null, not 0', String(ps.rows[1].paid), 'null');
ck('invoice_date carried', ps.rows[0].invoiced, '11/06/2026');
ck('  and its absence is an empty string', ps.rows[2].invoiced, '');
ck('optional columns are not reported missing when present',
   String(ps.optMissing), 'undefined');

console.log('  a reader without those columns still works:');
var bare = readShipments_(stub('Raw_Shipments', [
  ['shipment_id', 'shipment_status', 'shipment_created_date', 'seller_name',
   'seller_category', 'buyer_name', 'buyer_category', 'shipment_value',
   'dispatched_quantity'],
  ['B1', 'COMPLETED', '2026-06-10T00:00:00', 'S', 'Metal', 'B', 'Metal', '5', '1']]));
ck('no required column missing', bare.missing.length, 0);
ck('  the row still reads', bare.rows.length, 1);
ck('  paid is null', String(bare.rows[0].paid), 'null');
ck('  and the gap is REPORTED, not silent',
   (bare.optMissing || []).join(',').indexOf('paid_amount') >= 0, true);

console.log('\n--- the status timeline ---');
eval(grab('function parseTimeline_(t) {', '/** DRY RUN — elapsed days to COMPLETED'));
var TL = 'DRAFT~2026-05-31T15:35:00|DISPATCHED~2026-06-01T17:08:23|' +
         'REACHED~2026-06-06T17:38:22|RECEIVED_BY_RECYCLER~2026-06-12T16:30:37|' +
         'COMPLETED~2026-06-26T08:57:52';
var tl = parseTimeline_(TL);
ck('five stages parsed', Object.keys(tl).length, 5);
ck('  COMPLETED found', tl.COMPLETED !== undefined && tl.COMPLETED !== null, true);
/* COMPLETED is the last stage in the data; the row labelled "Payment Released"
   is exactly the one whose timeline ends there */
ck('delivered -> completed is 14 days',
   daysBetween_(tl.RECEIVED_BY_RECYCLER, tl.COMPLETED), 14);
ck('dispatched -> completed is 25 days',
   daysBetween_(tl.DISPATCHED, tl.COMPLETED), 25);
ck('a shipment with no COMPLETED yields nothing',
   String(parseTimeline_('DRAFT~2026-07-07T16:54:14').COMPLETED), 'undefined');
ck('an empty timeline parses to nothing', Object.keys(parseTimeline_('')).length, 0);
ck('junk between separators is skipped',
   Object.keys(parseTimeline_('DRAFT~2026-06-01T00:00:00|rubbish|~|X~notadate')).length, 1);
/* times are stripped, so a stage at 23:59 and one at 00:01 the next day are
   one day apart, not zero */
ck('whole days only, times ignored',
   daysBetween_(parseTimeline_('A~2026-06-01T23:59:00').A,
                parseTimeline_('B~2026-06-02T00:01:00').B), 1);
ck('the timeline reaches the row', readShipments_(PS).rows.length > 0, true);

console.log('  the invoice date is dd/mm/yyyy, not ISO:');
ck('13/06/2026 parses', ddmmDate_('13/06/2026') !== null, true);
ck('  and it is June, not the 13th month',
   new Date(ddmmDate_('13/06/2026')).getUTCMonth(), 5);
ck('blank gives nothing', String(ddmmDate_('')), 'null');

console.log('  median, which is used because the mean is skewed by stragglers:');
ck('odd count', median_([3, 1, 2]), 2);
ck('even count averages the middle pair', median_([1, 2, 3, 4]), 2.5);
ck('empty', String(median_([])), 'null');
ck('one outlier does not move it', median_([2, 2, 3, 3, 400]), 3);
ck('  where the mean would say 82', Math.round((2 + 2 + 3 + 3 + 400) / 5), 82);

console.log('\n--- days in the month, which scales every DSO ---');
ck('June has 30', daysInMonth_('per_2026-06'), 30);
ck('July has 31', daysInMonth_('per_2026-07'), 31);
ck('February 2026 has 28', daysInMonth_('per_2026-02'), 28);
/* 2028 is a leap year — a hardcoded 30 would misstate February by 7% */
ck('February 2028 has 29', daysInMonth_('per_2028-02'), 29);
ck('an unreadable period falls back to 30', daysInMonth_('nonsense'), 30);

console.log('\n--- the DSO arithmetic ---');
function dso(gmv, paid, days) { return (gmv - paid) / gmv * days; }
ck('1.0 Cr sold, 0.4 Cr received, June -> 18 days',
   Math.round(dso(1000000, 400000, 30) * 10) / 10, 18);
ck('nothing received -> the full month', dso(1000000, 0, 30), 30);
ck('everything received -> 0 days', dso(1000000, 1000000, 30), 0);
ck('  blank treated as fully settled would have said 0 here too, which is why',
   dso(1000000, 1000000, 30) === 0, true);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
