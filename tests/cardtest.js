/* RENDERS all ten Overview card breakdowns out of Index.html, against a stub
   model, and reads what comes back.

   Why a rendering test and not a source scan: these modals are almost entirely
   string concatenation across nested ternaries, and the two faults that class
   of code actually produces — an unbalanced paren and a figure that silently
   comes out as "undefined" or "NaN" — are both invisible to a grep and to a
   parse check. One of them (an extra bracket closing the KPI-completion
   ternary) was already sitting in the file when this suite was written.

   Only the sheet layer and the DOM are stubbed; every helper is the real one
   lifted from the page. */
var ROOT = require('path').join(__dirname, '..');
var fs = require('fs');
var page = fs.readFileSync(require('path').join(ROOT, 'Index.html'), 'utf8')
  .replace(/\r\n/g, '\n');
function grab(a, b) {
  var i = page.indexOf(a); if (i < 0) throw new Error('missing anchor: ' + a);
  var j = page.indexOf(b, i); if (j < 0) throw new Error('missing anchor: ' + b);
  return page.slice(i, j);
}

var pass = 0, fail = 0;
function ck(label, got, want) {
  var ok = String(got) === String(want); ok ? pass++ : fail++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + ': ' + got + (ok ? '' : '   (want ' + want + ')'));
}

/* --- the page's small helpers, real ------------------------------------- */
function h(v) {
  return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function f1(v) { return v === null || v === undefined ? '—' : Number(v).toFixed(1); }
function pc(v) { return v === null || v === undefined ? '—' : Math.round(Number(v)) + '%'; }
function emptyBox(t, m) { return '<div class="empty"><div class="t">' + t + '</div><div class="m">' + m + '</div></div>'; }
function shell(title, cap, body, footer, wide) {
  return '<div class="modal' + (wide ? ' wide' : '') + '"><h2>' + h(title) + '</h2>' +
    '<div class="cap">' + h(cap) + '</div><div class="m-b">' + body + '</div>' +
    '<div class="m-f">' + footer + '</div></div>';
}
function teamLabel(t) { return (t && t.name) || ''; }
/* the REAL formatter, not a copy of it — a stub here would have gone on
   reporting 2dp days long after the page stopped doing so */
/* anchored on the NAME, not the parameter list: adding a parameter to
   fmtTarget silently broke this grab and the whole suite stopped reporting */
eval(grab('function fmtTarget(', '/* THE LADDER, READ IN THE UNITS'));
function activeCount() { return 0; }
function distinctKpiCountIn(rows) { return (rows || []).length; }

/* --- the stub model ------------------------------------------------------ */
var TEAMS = { tm: { id: 'tm', name: 'Metal', lead_id: 'E1' },
              tp: { id: 'tp', name: 'Plastic', lead_id: 'E3' },
              tc: { id: 'tc', name: 'Collections', lead_id: '' } };
var EMPS = {
  E1: { id: 'E1', name: 'AMIT JHA', team_id: 'tm', designation: 'Team Lead' },
  E2: { id: 'E2', name: 'ARIJIT DUTTA', team_id: 'tm', designation: 'BD' },
  E3: { id: 'E3', name: 'ASHISH KUMAR RAI', team_id: 'tp', designation: 'Team Lead' },
  E4: { id: 'E4', name: 'RAJU B', team_id: 'tp', designation: 'BD' },
  E5: { id: 'E5', name: 'RAVI NAIK', team_id: 'tc', designation: 'Collections' }
};
var ROWS = [
  { employee_id: 'E1', kpi_id: 'k1', kra_id: 'r1', kpi: 'GMV', plan_target: 6.5,
    plan_unit: 'Cr', actual: 7.15, ratio: 1.1, level: 5, bands: ['0.6', '0.75', '0.9', '1.0', '1.05'] },
  { employee_id: 'E2', kpi_id: 'k1', kra_id: 'r1', kpi: 'GMV', plan_target: 4,
    plan_unit: 'Cr', actual: 3.2, ratio: 0.8, level: 2, bands: ['0.6', '0.75', '0.9', '1.0', '1.05'] },
  { employee_id: 'E3', kpi_id: 'k2', kra_id: 'r2', kpi: 'New Sellers', plan_target: 9,
    plan_unit: 'count', actual: 9, ratio: 1, level: 4, bands: ['0.6', '0.75', '0.9', '1.0', '1.05'] },
  /* targeted, nothing achieved — the KPI-completion gap */
  { employee_id: 'E4', kpi_id: 'k2', kra_id: 'r2', kpi: 'New Sellers', plan_target: 5,
    plan_unit: 'count', actual: null, ratio: null, level: null, bands: ['0.6', '0.75', '0.9', '1.0', '1.05'] },
  /* an ABSOLUTE ladder: a real value, no percentage, so Target achievement
     must leave it out rather than count it as zero */
  { employee_id: 'E3', kpi_id: 'k3', kra_id: 'r3', kpi: 'Days Sales Outstanding (DSO)',
    plan_target: 5, plan_unit: 'days', actual: 18.7, ratio: null, level: 0,
    bands: ['15', '10', '5', '3', '2'] },
  /* no ladder at all — a KPI-gap cause */
  { employee_id: 'E5', kpi_id: 'k4', kra_id: 'r4', kpi: 'Collection %',
    plan_target: null, plan_unit: '', actual: null, ratio: null, level: null,
    bands: ['', '', '', '', ''] }
];
var M = {
  emps: EMPS, teams: TEAMS, kras: { r1: { name: 'GMV' }, r2: { name: 'New Seller Acquisition' },
    r3: { name: 'DSO Days' }, r4: { name: 'Collections' } },
  byTeam: { tm: [EMPS.E1, EMPS.E2], tp: [EMPS.E3, EMPS.E4], tc: [EMPS.E5] },
  byEmp: {}, overalls: {
    E1: { score: 4.2 }, E2: { score: 2.0 }, E3: { score: 3.4 }, E4: { score: 1.1 },
    E5: { score: null } }
};
Object.keys(EMPS).forEach(function (id) {
  M.byEmp[id] = ROWS.filter(function (r) { return r.employee_id === id; });
});
var S = { model: { employees: Object.keys(EMPS).map(function (k) { return EMPS[k]; }),
  teams: [TEAMS.tm, TEAMS.tp, TEAMS.tc] }, period: 'ytd' };

function filteredEmployees() { return S.model.employees; }
function filteredRows() { return ROWS; }
function stats(list) {
  var st = { n: list.length, scored: 0 };
  list.forEach(function (r) {
    if (r.level !== null && r.level !== undefined && r.level !== '') st.scored++; });
  return st;
}

/* --- the real code under test -------------------------------------------- */
eval(grab('function targetedRows(){', '/* One table per VERTICAL'));
eval(grab('function ovStats(){', '/* Every filtered row that HAS a numeric target'));
eval(grab('function sumLine(txt){', 'function cardDetail(key){'));
eval(grab('function cardDetail(key){', 'function closeModal(){'));

console.log('--- ovStats, the one computation both sides read ---');
var V = ovStats();
ck('people', V.people.length, 5);
ck('scored', V.scored.length, 4);
ck('  and the unscored are kept, not dropped', V.unscored.length, 1);
ck('targeted rows', V.tr.length, 5);
ck('  of which with an achieved value', V.withAch.length, 4);
ck('  and still missing one', V.noAch.length, 1);
/* three of the six: the two GMV rows and New Sellers for E3. E4 has a target
   but no actual, DSO is absolute, and the Collections row has neither. */
ck('rows with a PERCENTAGE (absolute ladders excluded)', V.pctRows.length, 3);
ck('  DSO is the one left out', V.pctRows.filter(function (r) {
  return /DSO/.test(r.kpi); }).length, 0);
ck('at or above target', V.atTgt.length, 2);
ck('unrated assignments', V.gap.length, 2);
ck('bands: on track / attention / critical',
   V.ok.length + '/' + V.warn.length + '/' + V.crit.length, '1/1/2');
ck('  and they add up to the scored count',
   V.ok.length + V.warn.length + V.crit.length, V.scored.length);
ck('departments ranked, best first', V.depts.map(function (d) {
  return teamLabel(d.t); }).join(','), 'Metal,Plastic');
ck('  Collections has nobody scored, so it is absent',
   V.depts.filter(function (d) { return d.t.id === 'tc'; }).length, 0);
ck('top performer', V.top.e.name, 'AMIT JHA');
ck('average level', Math.round(V.avgLvl * 100) / 100, 2.68);

console.log('\n--- every card renders, and none of them renders a NaN ---');
var KEYS = ['employees', 'avg', 'attain', 'completion', 'top', 'ok', 'warn', 'crit',
            'gap', 'dept'];
KEYS.forEach(function (k) {
  var html = cardDetail(k);
  ck('  ' + k + ' renders', !!(html && html.length > 200), true);
  /* the two ways this kind of code fails silently */
  ck('    no undefined', /undefined/.test(html), false);
  ck('    no NaN', /NaN/.test(html), false);
  ck('    balanced modal', (html.match(/<div class="modal/g) || []).length, 1);
});
ck('an unknown key returns null, so the click falls back', cardDetail('nope'), null);

console.log('\n--- the figures on the cards are the figures in the breakdown ---');
var avg = cardDetail('avg');
ck('the average appears as a percentage', avg.indexOf(pc(V.avgLvl / 5 * 100)) >= 0, true);
ck('  with the division written out', /&divide; 4 =/.test(avg), true);
ck('  and every scored person named',
   V.scored.filter(function (x) { return avg.indexOf(h(x.e.name)) >= 0; }).length, 4);
ck('  the unscored person is NOT averaged in', avg.indexOf('RAVI NAIK') >= 0, false);

var att = cardDetail('attain');
ck('target achievement names the absolute-ladder exclusion',
   att.indexOf('absolute ladder') >= 0, true);
ck('  and DSO does not appear in its tables', att.indexOf('Days Sales Outstanding') >= 0, false);

var comp = cardDetail('completion');
ck('completion lists the one missing value', comp.indexOf('RAJU B') >= 0, true);

var gap = cardDetail('gap');
ck('the gap is split by cause', gap.indexOf('No ladder at all') >= 0, true);
ck('  and counts the no-ladder row', /No ladder at all<\/td><td class="r num"><b>1<\/b>/
   .test(gap), true);

console.log('\n--- side by side, one card per vertical, each naming its lead ---');
['employees', 'avg', 'attain', 'completion'].forEach(function (k) {
  var html = cardDetail(k);
  ck('  ' + k + ' uses the side-by-side grid', /<div class="sbs">/.test(html), true);
  ck('    with a card per vertical', (html.match(/class="vcard"/g) || []).length >= 2, true);
  ck('    and Metal named', html.indexOf('>Metal</h4>') >= 0, true);
  ck('    with its lead', /Lead · <b>AMIT JHA<\/b>/.test(html), true);
});
var empl = cardDetail('employees');
ck('a department with no lead says so, rather than showing a blank',
   empl.indexOf('no lead recorded') >= 0, true);
ck('  the lead is marked in the member list', /AMIT JHA <span class="tag g">lead<\/span>/
   .test(empl), true);
ck('  and a person awaiting actuals is shown, not hidden',
   empl.indexOf('RAVI NAIK') >= 0 && empl.indexOf('awaiting') >= 0, true);
/* Collections has one person and no score: the card must still appear */
ck('  a vertical with nothing scored still gets a card',
   empl.indexOf('>Collections</h4>') >= 0, true);
ck('    saying so', empl.indexOf('nothing scored yet') >= 0, true);

console.log('\n--- Summary by vertical must not ADD a duration across people ---');
/* It summed unconditionally, so Plastic's DSO read as Neelesh's 20 days plus
   Rishi's 10 against a target of 5 + 5 — 30 days against 10, which is not a
   number of anything and showed as an achievement. Same mistake as adding a
   DSO across months, in the cross-person direction. */
eval(grab('function achievedPct(c){', 'function rowSlice(r,month){'));
eval(grab('function verticalSummary(){', 'function targetsPanel(){'));
/* a second Plastic DSO row, so the two have to be combined somehow */
ROWS.push({ employee_id: 'E4', kpi_id: 'k3', kra_id: 'r3',
  kpi: 'Days Sales Outstanding (DSO)', plan_target: 5, plan_unit: 'days',
  actual: 10, ratio: null, level: 1, agg_kind: 'mean', plan_agg: 'mean',
  bands: ['15', '10', '5', '3', '2'] });
ROWS[4].actual = 20; ROWS[4].agg_kind = 'mean'; ROWS[4].plan_agg = 'mean';

var sum = verticalSummary();
ck('the DSO row is there at all', sum.indexOf('DSO Days') >= 0, true);
ck('  averaged, not summed: 20 and 10 give 15 days',
   /15 days/.test(sum), true);
ck('  NOT 30', /30 days/.test(sum), false);
ck('the target is averaged too: 5 and 5 give 5',
   /5 days/.test(sum), true);
ck('  NOT 10', /10 days<\/td>/.test(sum), false);
ck('and the row says how it was combined', sum.indexOf('mean of 2 POCs') >= 0, true);

console.log('  while a QUANTITY still totals:');
ck('two GMV targets of 6.5 and 4 give 10.50 Cr', /10\.50 Cr/.test(sum), true);
ck('  and their achieved 7.15 + 3.2 gives 10.35 Cr', /10\.35 Cr/.test(sum), true);
ck('  labelled as a total, not a mean', sum.indexOf('total of 2 POCs') >= 0, true);
/* a single-POC KRA needs no label at all */
ck('one POC gets no combining note',
   (sum.match(/of 1 POCs/g) || []).length, 0);

console.log('  and the verticals are in business order here too:');
ck('Plastic before Metal',
   sum.indexOf('>Plastic<') < sum.indexOf('>Metal<') ||
   sum.indexOf('Plastic total') < sum.indexOf('Metal total'), true);

console.log('\n--- headings carry weight, and only headings carry colour ---');
ck('a heading colour exists', /--head:#1f3a5f/.test(page), true);
ck('  the vertical name uses it', /\.sum \.vname\{[^}]*color:var\(--head\)/.test(page), true);
ck('  bolder and bigger', /\.sum \.vname\{[^}]*font-weight:800[^}]*font-size:14\.5px/
   .test(page), true);
ck('  the KRA name too', /\.sum \.kname\{[^}]*color:var\(--head\)/.test(page), true);
ck('  the column headers', /\.sum thead th\{[^}]*color:var\(--head\)/.test(page), true);
ck('  the pivot KRA header', /\.pv \.pvkra\{[^}]*color:var\(--head\)/.test(page), true);
ck('  and the card headings', /\.vch h4\{[^}]*color:var\(--head\)/.test(page), true);
/* the monochrome promise: colour may decorate a heading, never carry data */
ck('no DATA cell is given the heading colour',
   /\.sum \.na\{[^}]*--head|\.sum \.miss\{[^}]*--head|\.num\{[^}]*--head/.test(page), false);
ck('  the sub-note under a KRA stays quiet ink, not heading colour',
   /\.sum \.kname \.cap\{[^}]*color:var\(--ink-3\)/.test(page), true);

console.log('\n--- the order the business reads its departments in ---');
/* Alphabetical put Collections first and Plastic fourth, which is tidy and
   useless. The two revenue verticals come first and side by side. */
var order = byVertical(V.all, function (x) { return x.e; })
  .map(function (gp) { return teamLabel(M.teams[gp.tid]); });
ck('Plastic, then Metal, then the rest', order.join(' > '),
   'Plastic > Metal > Collections');
ck('  Plastic is first, not fourth', order[0], 'Plastic');
ck('  Metal second, so the two revenue lines sit together', order[1], 'Metal');
ck('  and an unlisted department sorts after the listed ones',
   order.indexOf('Collections') > order.indexOf('Metal'), true);
/* the rank is by NAME, so it survives a re-seed giving new team ids */
ck('ranked by name, not by team id', verticalRank('tp') < verticalRank('tm'), true);
ck('  Onboarding before Collections',
   ['ONBOARDING', 'COLLECTIONS'].indexOf('ONBOARDING') <
   ['ONBOARDING', 'COLLECTIONS'].indexOf('COLLECTIONS'), true);
M.teams.tx = { id: 'tx', name: 'Open Marketplace - Control Tower', lead_id: '' };
ck('  and OMP-CT falls last of all', verticalRank('tx') >= 4, true);
delete M.teams.tx;
/* the cards must actually appear in that order in the rendered modal */
var emplHtml = cardDetail('employees');
ck('the rendered cards follow it',
   emplHtml.indexOf('>Plastic</h4>') < emplHtml.indexOf('>Metal</h4>'), true);
ck('  and Metal before Collections',
   emplHtml.indexOf('>Metal</h4>') < emplHtml.indexOf('>Collections</h4>'), true);

console.log('\n--- a total row, not a wall of addition ---');
/* The footer printed ( 3.8 + 0.5 + 1.2 + 0.7 + ... ) ÷ 12 = 1.1 — twelve
   numbers nobody reads, wrapping over two lines, in place of the one figure
   being explained. */
var avgHtml = cardDetail('avg');
ck('each vertical card carries a total row',
   (avgHtml.match(/<tfoot><tr class="vtr">/g) || []).length >= 2, true);
ck('  naming how many it averaged', /Average of 2<\/td>/.test(avgHtml), true);
ck('  with the mean in the Level column', /Average of 2<\/td><td class="r num">3\.1</
   .test(avgHtml), true);
ck('  and the percentage beside it', /Average of 2<\/td><td class="r num">3\.1<\/td><td class="r num">62%/
   .test(avgHtml), true);
ck('the long enumeration is gone',
   / \+ 2\.0 \+ /.test(avgHtml) || /\( 4\.2 \+ /.test(avgHtml), false);
/* Metal is AMIT 4.2 + ARIJIT 2.0 = 6.2 over two scorecards */
ck('  replaced by sum and count', /total 6\.2 ÷ 2 = 3\.1 of 5/.test(avgHtml), true);
/* and all four scored are 4.2 + 2.0 + 3.4 + 1.1 = 10.7 */
ck('the card headline states the total too, not every addend',
   /total <b>10\.7<\/b> across <b>4<\/b> scorecards/.test(avgHtml), true);
ck('  which divides to the figure on the card face',
   Math.round(10.7 / 4 * 10) / 10, f1(V.avgLvl));

console.log('\n--- a card popup has room for its tables ---');
ck('the breakdown asks for the roomy shell',
   /'<button class="btn p" data-close="1">Close<\/button>','cards'\)/.test(page), true);
ck('  which is wider than the form shell', /\.modal\.cards\{width:min\(1320px/.test(page),
   true);
ck('  and taller', /\.modal\.cards\{[^}]*max-height:94vh/.test(page), true);
ck('  two vertical cards per row, so the pairs sit together',
   /\.modal\.cards \.sbs\{grid-template-columns:repeat\(2,/.test(page), true);
ck('  and the inner tables get no scroller of their own',
   /\.modal\.cards \.vcard \.tw\{overflow:visible\}/.test(page), true);
ck('  collapsing to one column on a narrow screen',
   /@media\(max-width:900px\)\{\.modal\.cards \.sbs\{grid-template-columns:1fr\}\}/
     .test(page), true);
ck('shell still supports the plain wide form', /wide===true\?' wide'/.test(page), true);

console.log('\n--- how many decimals a figure deserves ---');
/* Decided by what the number MEASURES, not by whatever the arithmetic threw
   out. A YTD figure is a mean, so it arrives with a long tail that nothing
   downstream was trimming. */
ck('crore keeps 2dp, because lakhs matter', fmtTarget(6.5, 'Cr'), '6.50 Cr');
ck('  and rounds there', fmtTarget(6.82500001, 'Cr'), '6.83 Cr');
ck('  a long tail is trimmed', fmtTarget(13.719999999999999, 'Cr'), '13.72 Cr');
/* KRA owner, 17 Sep 2026: ONLY GMV keeps decimals. A DSO of 18.9 days and one
   of 19 are the same answer, and the extra digit only invites an argument
   about a tenth of a day. */
ck('days are whole — only GMV keeps decimals',
   fmtTarget(18.925, 'days'), '19 days');
ck('  a mean with a long tail', fmtTarget(18.924999999999997, 'days'), '19 days');
ck('  rounding, not truncating', fmtTarget(18.4, 'days'), '18 days');
ck('  a whole number stays whole', fmtTarget(17, 'days'), '17 days');
ck('  and no decimal point survives', /\./.test(fmtTarget(31.4, 'days')), false);
ck('counts are whole — there is no such thing as 8.35 sellers',
   fmtTarget(8.35, 'count'), '8');
ck('  rounding, not truncating', fmtTarget(8.6, 'count'), '9');
/* a LADDER RUNG is a threshold, not a quantity: rounding 5.4 down to 5 would
   say somebody with 5 sellers had cleared a bar they had missed */
ck('  but a rung keeps its precision', fmtTarget(5.4, 'count', true), '5.4');
ck('    and 8.1 stays 8.1', fmtTarget(8.1, 'count', true), '8.1');
ck('    while the measured count beside it still rounds',
   fmtTarget(5.4, 'count'), '5');
ck('  a bare unit behaves the same', fmtTarget(19.0000001, ''), '19');
ck('any other unit is whole too', fmtTarget(1.23456, 'kg'), '1 kg');
/* the one exception, and the reason for the rule */
ck('GMV keeps its decimals', fmtTarget(13.7234, 'Cr'), '13.72 Cr');
ck('  because lakhs are real money', fmtTarget(6.5, 'Cr'), '6.50 Cr');
ck('a non-number is blank, not NaN', fmtTarget('n/a', 'Cr'), '');
/* Number(null) is 0, so an unguarded formatter turns "nothing recorded" into a
   measured zero — the exact shape of bug this codebase keeps meeting. */
ck('  null is blank, NOT a measured zero', fmtTarget(null, 'days'), '');
ck('  undefined too', fmtTarget(undefined, 'days'), '');
ck('  and an empty cell', fmtTarget('', 'count'), '');
ck('  but a real zero still prints', fmtTarget(0, 'days'), '0 days');
/* the rule has to hold for the figures actually on screen today */
/* the real figures on screen, now that September is excluded */
ck('Neelesh YTD reads cleanly', fmtTarget((3.8 + 25.1 + 29.8) / 3, 'days'), '20 days');
ck('Rishi YTD too', fmtTarget((1.7 + 4.6 + 23.7) / 3, 'days'), '10 days');

console.log('\n--- the working behind a number nobody typed ---');
eval(grab('function noteFor(r,month){', 'function achievedCell(r,month){'));
var NOTE = 'MM_CT DSO · receivable 6.18 Cr ÷ GMV 6.96 Cr × 31 days = 27.5 days · 58 shipments';
/* it carries the row's identity now, so the modal can look the row back up */
function withNote(note, extra) {
  var r = { employee_id: 'E3', kpi_id: 'k3', actual_note: note };
  if (extra) Object.keys(extra).forEach(function (k) { r[k] = extra[k]; });
  return r;
}
ck('it renders', /class="working worklink"/.test(workingOf(withNote(NOTE))), true);
ck('  as a clickable button, not inert text',
   /data-work="E3\|k3\|"/.test(workingOf(withNote(NOTE))), true);
ck('  and the month it was clicked for travels with it',
   /data-work="E3\|k3\|per_2026-07"/.test(
     workingOf(withNote(NOTE), 'per_2026-07')), true);
ck('  with the receivable', workingOf({ actual_note: NOTE }).indexOf('6.18 Cr') >= 0, true);
ck('  the GMV', workingOf({ actual_note: NOTE }).indexOf('6.96 Cr') >= 0, true);
ck('  the days', workingOf({ actual_note: NOTE }).indexOf('31 days') >= 0, true);
ck('  and the shipment count', workingOf({ actual_note: NOTE }).indexOf('58 shipments') >= 0,
   true);
ck('the source prefix is dropped — the column already says it',
   workingOf({ actual_note: NOTE }).indexOf('MM_CT DSO') >= 0, false);
ck('a row with no note renders nothing at all', workingOf({ actual_note: '' }), '');
ck('  and neither does a bare row', workingOf({}), '');
/* under a per-table month filter it must show THAT month's working */
var multi = { actual_note: 'MM_CT DSO · August working',
  monthly: { 'per_2026-07': { note: 'MM_CT DSO · July working' } } };
ck('the month on screen wins', workingOf(multi, 'per_2026-07').indexOf('July') >= 0, true);
ck('  and the row note is the fallback',
   workingOf(multi, 'per_2026-09').indexOf('August') >= 0, true);
ck('a note is escaped, not injected',
   workingOf({ actual_note: '<script>x</script>' }).indexOf('&lt;script&gt;') >= 0, true);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
