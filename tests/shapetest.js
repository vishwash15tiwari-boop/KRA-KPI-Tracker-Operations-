/* Guards the SHAPE CONTRACTS between the helpers in Index.html and the views
   that consume them.

   Why this suite exists: the Overview read `x.e.name` from weightWarnings(),
   which returns `{emp, w}`. That threw "Cannot read properties of undefined
   (reading 'name')" and blanked the entire page. It hid for weeks because the
   branch only runs when some scorecard does not total 100% weightage, and none
   did until a framework re-import took assignments from 208 to 225.

   A field-name typo inside a rarely-taken branch is invisible to every test
   that does not render that branch, so these assertions work on the SOURCE as
   well as on the functions. */
var ROOT = require('path').join(__dirname, '..');
var fs = require('fs');
var page = fs.readFileSync(require('path').join(ROOT, 'Index.html'), 'utf8').replace(/\r\n/g, '\n');
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

var M = { overalls: {}, emps: {}, teams: {}, kras: {} };
eval(grab('function weightWarnings(){', '/* ================================ charts'));

console.log('--- weightWarnings returns {emp, w} ---');
M.emps = { E1: { id: 'E1', name: 'AMIT JHA' }, E2: { id: 'E2', name: 'RAJU B' } };
M.overalls = {
  E1: { assigned_weightage: 90 },     /* off 100 -> a warning */
  E2: { assigned_weightage: 100 },    /* exactly 100 -> not a warning */
  E3: { assigned_weightage: 40 }      /* no employee record -> skipped */
};
var ww = weightWarnings();
ck('one warning', ww.length, 1);
ck('  the key is "emp"', Object.keys(ww[0]).sort().join(','), 'emp,w');
ck('  NOT "e" — that typo blanked the Overview', ww[0].e === undefined, true);
ck('  and emp carries the person', ww[0].emp.name, 'AMIT JHA');
ck('  with the weightage', ww[0].w, 90);
ck('a scorecard at exactly 100 is not warned about',
   ww.filter(function (x) { return x.emp.id === 'E2'; }).length, 0);
ck('an overall with no employee record is skipped, not crashed on',
   ww.filter(function (x) { return !x.emp; }).length, 0);

console.log('\n--- within tolerance is not a warning ---');
M.overalls = { E1: { assigned_weightage: 100.4 } };
ck('100.4 is inside the 0.5 tolerance', weightWarnings().length, 0);
M.overalls = { E1: { assigned_weightage: 100.6 } };
ck('100.6 is outside it', weightWarnings().length, 1);
M.overalls = { E1: { assigned_weightage: 0 } };
ck('a scorecard with no weightage at all IS warned about', weightWarnings().length, 1);

console.log('\n--- nothing in the page may read .e off a weight warning ---');
/* the actual regression: h(x.e.name) */
/* The bug was reading .e off a WEIGHT WARNING, which is {emp, w}. A blanket ban
   on "x.e.name" also caught pplTable(), whose rows really are {e, o} — the same
   shape the top-performer list has always used. So the ban is on the PRODUCER,
   checked by proximity to ww just below, not on the expression itself. */
ck('weight warnings are read as .emp', /x\.emp\.name/.test(page), true);
ck('no ".e.name" at all on a warning', /\bww\b[\s\S]{0,200}?\.e\.name/.test(page), false);
var wwUses = page.split('weightWarnings()').length - 1;
ck('weightWarnings is called somewhere', wwUses > 0, true);

console.log('\n--- the other {e, ...} shapes must not be confused with it ---');
/* stats/top use {e, o}; flags use {emp, row}. Both are fine — the point is
   that each consumer matches ITS producer. */
ck('flags() produces emp', /out\.push\(\{sev:'w',emp:e,row:r/.test(page), true);
ck('the top-performer list produces e', /return \{e:e,o:M\.overalls\[e\.id\]\|\|\{\}\}/.test(page), true);
ck('  and is read as .e.name off that shape', /V1\.top\.e\.name/.test(page), true);
ck('flag rows are read as f.emp', /data-go="emp\/'\+h\(f\.emp\.id\)/.test(page), true);

console.log('\n--- every view function referenced by the router exists ---');
var routed = {};
(page.match(/V\.[a-z]+\s*=\s*function/g) || []).forEach(function (m) {
  routed[m.replace(/V\./, '').replace(/\s*=\s*function/, '')] = 1;
});
['overview', 'teams', 'people', 'framework', 'review', 'admin', 'emp', 'team',
 'method']
  .forEach(function (name) {
    if (routed[name]) { pass++; console.log('PASS  V.' + name + ' defined'); }
    else { fail++; console.log('FAIL  V.' + name + ' is referenced but NOT defined'); }
  });

console.log('\n--- the Overview helpers this release added ---');
ck('targetedRows defined', /function targetedRows\(\)/.test(page), true);
ck('pctOfTarget defined', /function pctOfTarget\(r\)/.test(page), true);
ck('targetsPanel defined', /function targetsPanel\(\)/.test(page), true);
/* teamLabel(t) reads t.id and t.name, so it must never be handed a bare id */
ck('teamLabel is always given the team OBJECT, not an id',
   /teamLabel\((?!M\.teams\[|t\)|t\b|M\.teams\b|best\.t\)|topTeam\.t\)|d\.t\)|V1?\.depts\[0\]\.t\))/
     .test(page), false);
ck('  and the pivot looks the team up before labelling it',
   page.indexOf('var g=byGroup[key], list=g.rows, t=M.teams[g.tid]||{};') >= 0, true);

console.log('\n--- the per-vertical pivot table ---');
ck('verticalTable defined, and it takes the month to show',
   /function verticalTable\(tid,rs,month\)\{/.test(page), true);
ck('  KRA headers span all three of their columns',
   page.indexOf('<th colspan="3" class="pvkra"') >= 0, true);
ck('  the POC column spans both header rows',
   page.indexOf('<th rowspan="2" class="pvname">POC</th>') >= 0, true);
ck('  and the sub-header names all three',
   page.indexOf('>Target</th><th class="r pvsub">Achieved</th>') >= 0 &&
   page.indexOf('>Achieved %</th>') >= 0, true);
ck('  the group border matches a 3-wide group',
   /\.pv td:nth-child\(3n\+2\)\{border-left/.test(page), true);

console.log('  headers wrap; numbers do not:');
/* "TRANSACTION FROM EXISTING BUYE…" was unreadable, and two different KRAs can
   truncate to the same string — which is worse than unreadable. */
ck('the global th rule wraps', /white-space:normal;vertical-align:bottom/.test(page), true);
ck('  no header is left nowrap by the old global rule',
   /border-bottom:1px solid var\(--line\);white-space:nowrap\}/.test(page), false);
ck('  and no KRA header is truncated with an ellipsis',
   /\.pv \.pvkra\{[^}]*text-overflow:ellipsis/.test(page), false);
ck('pivot headers wrap', /\.pv th\{white-space:normal\}/.test(page), true);
ck('  but pivot DATA cells do not, so a figure never breaks',
   /\.pv td\{white-space:nowrap\}/.test(page), true);
ck('  and the sub-header stays on one line',
   /\.pv \.pvsub\{[^}]*white-space:nowrap/.test(page), true);
ck('the KRA column has a min-width so three numbers still fit',
   /\.pv \.pvkra\{[^}]*min-width:180px/.test(page), true);
ck('the name column is sticky, or a wide table loses whose row it is',
   /\.pv \.pvname\{position:sticky/.test(page), true);
ck('a KRA the person does not hold is marked distinctly from an empty value',
   page.indexOf('class="r num pvna">·</td>') >= 0, true);
ck('  and pvna is styled', /\.pv \.pvna\{/.test(page), true);
/* a person can hold one KRA through two KPIs, so the cell adds rather than
   overwrites — and it adds the SLICE, which respects the table's month */
ck('numbers accumulate per person+KRA rather than assuming one KPI',
   page.indexOf("c.t=(c.t===null?0:c.t)+Number(sl.t)") >= 0, true);
ck('  and they come from the month slice',
   page.indexOf('var sl=rowSlice(r,month);') >= 0, true);

console.log('\n--- Plastic splits into Supply and Demand ---');
/* The seed carries sub_group: Plastic is 12 Supply + 2 Demand, every other
   department is blank. Supply works sellers and Demand works buyers, so a
   merged Plastic table would be half empty on every row. */
ck('grouped by department AND sub-group',
   page.indexOf("var key=String(e.team_id)+'||'+sub;") >= 0, true);
ck('  the sub-group comes off the employee', /var sub=String\(e\.sub_group\|\|''\)\.trim\(\);/.test(page), true);
ck('  and titles the panel when present',
   page.indexOf("h(teamLabel(t)+(g.sub?' · '+g.sub:''))") >= 0, true);
ck('  a department with no sub-group therefore stays ONE table',
   /\(g\.sub\?/.test(page), true);
ck('sorted by department first, then sub-group, so they stay adjacent',
   page.indexOf('return d||String(ga.sub).localeCompare(String(gb.sub));') >= 0, true);
ck('the existing sub-group FILTER still reads the same field',
   page.indexOf("String(e.sub_group||'')!==S.fSub") >= 0, true);

console.log('\n--- each table has its own month filter, defaulting to YTD ---');
eval(grab('function rowSlice(r,month){', 'function verticalTable(tid,rs,month){'));
var R = { plan_target: 19, actual: 14,
  monthly: { 'per_2026-06': { target: 9, actual: 4 },
             'per_2026-07': { target: 6, actual: 6 },
             'per_2026-08': { target: 4, actual: 4 } } };
ck('no month selected gives the whole span',
   JSON.stringify(rowSlice(R, '')), '{"t":19,"a":14}');
ck('  which is what the row already carried', rowSlice(R, '').t, R.plan_target);
ck('June', JSON.stringify(rowSlice(R, 'per_2026-06')), '{"t":9,"a":4}');
ck('August', JSON.stringify(rowSlice(R, 'per_2026-08')), '{"t":4,"a":4}');
/* a month with neither a target nor an achievement is absent from the
   breakdown; that is not the same as the row having none at all */
ck('a month the row has nothing in',
   JSON.stringify(rowSlice(R, 'per_2026-09')), '{"t":null,"a":null}');
ck('  and it did NOT fall back to the span total',
   rowSlice(R, 'per_2026-09').t === 19, false);
ck('a row with no breakdown at all', JSON.stringify(rowSlice({}, 'per_2026-06')),
   '{"t":null,"a":null}');

ck('the state defaults to empty, i.e. Year to date', /tblMonth:\{\}/.test(page), true);
ck('  the option is labelled Year to date and selected by default',
   page.indexOf('<option value=""\'+(month?\'\':\' selected\')+\'>Year to date</option>') >= 0, true);
ck('the selector only appears for a multi-month span',
   page.indexOf('var sel=span.length>1') >= 0, true);
ck('  it is keyed per table', /data-tbl="'\+h\(key\)\+'"/.test(page), true);
ck('  and switching it costs NO server round trip',
   /S\.tblMonth\[el\.getAttribute\('data-tbl'\)\]=el\.value; render\(\);/.test(page), true);
ck('a stale month outside the span is dropped rather than kept',
   page.indexOf("if(month&&span.indexOf(month)<0){ month=''; }") >= 0, true);
ck('the caption names the month actually shown',
   page.indexOf("' · '+h(shown)+'</div></div>'") >= 0, true);

console.log('\n--- the server sends the breakdown to make that possible ---');
var codeSrc = fs.readFileSync(require('path').join(ROOT, 'Code.gs'), 'utf8');
ck('rows carry monthly', /monthly: spanIds\.length > 1 \? monthly : null,/.test(codeSrc), true);
ck('  only for a multi-month span, not for a single month',
   /if \(spanIds\.length > 1 && \(monthTarget !== null \|\| act !== null\)\)/.test(codeSrc), true);

console.log('\n--- month-by-month performance, one card per vertical ---');
eval(grab('function monthlyHitRate(rows){', 'function chartMonthly(id,rows){'));
S = { model: { ytd_periods: ['per_2026-06', 'per_2026-07', 'per_2026-08'] } };
function mrow(dir, m) { return { direction: dir, monthly: m }; }
var MR = [
  /* met in June, missed in July, met in August */
  mrow('higher_is_better', { 'per_2026-06': { target: 9, actual: 9 },
                             'per_2026-07': { target: 6, actual: 4 },
                             'per_2026-08': { target: 4, actual: 8 } }),
  /* missed in June, met in July, nothing recorded in August */
  mrow('higher_is_better', { 'per_2026-06': { target: 10, actual: 2 },
                             'per_2026-07': { target: 5, actual: 5 } })
];
var hr = monthlyHitRate(MR);
ck('one point per month in the span', hr.length, 3);
ck('June: 1 of 2 met target', hr[0].hit + '/' + hr[0].n, '1/2');
ck('  which is 50%', hr[0].pct, 50);
ck('July: 1 of 2', hr[1].hit + '/' + hr[1].n, '1/2');
ck('August counts only the month that HAS both', hr[2].n, 1);
ck('  and that one met target', hr[2].pct, 100);

console.log('  a share, not an average — one 600% must not carry the month:');
/* the real data has 600%, 400% and 325% against small counts. A mean of ratios
   would read as a triumph in a month most of the vertical missed. */
var SKEW = [mrow('higher_is_better', { 'per_2026-06': { target: 3, actual: 18 } }),
            mrow('higher_is_better', { 'per_2026-06': { target: 20, actual: 1 } }),
            mrow('higher_is_better', { 'per_2026-06': { target: 20, actual: 1 } })];
ck('1 of 3 met target -> 33%', Math.round(monthlyHitRate(SKEW)[0].pct), 33);
ck('  a mean of ratios would have said 203%',
   Math.round((600 + 5 + 5) / 3), 203);

console.log('  lower-is-better must invert the test:');
var DSO = [mrow('lower_is_better', { 'per_2026-06': { target: 20, actual: 18 } })];
ck('18 days against a 20-day target MET it', monthlyHitRate(DSO)[0].pct, 100);
var DSO2 = [mrow('lower_is_better', { 'per_2026-06': { target: 20, actual: 24 } })];
ck('  24 days missed it', monthlyHitRate(DSO2)[0].pct, 0);
ck('  read the naive way it would have counted as a hit',
   24 >= 20, true);

console.log('  nothing recorded is not nothing achieved:');
var NONE = [mrow('higher_is_better', { 'per_2026-06': { target: 5, actual: null } })];
ck('no achievement -> no share at all', String(monthlyHitRate(NONE)[0].pct), 'null');
ck('  and it is not drawn as zero', monthlyHitRate(NONE)[0].pct === 0, false);
var NOT = [mrow('higher_is_better', { 'per_2026-06': { target: null, actual: 5 } })];
ck('no target -> also excluded', String(monthlyHitRate(NOT)[0].pct), 'null');
var ZERO = [mrow('higher_is_better', { 'per_2026-06': { target: 0, actual: 5 } })];
ck('a ZERO target is excluded, not a free hit', String(monthlyHitRate(ZERO)[0].pct), 'null');

/* match the DECLARATION and the canvas ids, not the name in prose — the
   comment left behind explaining the removal is worth keeping */
ck('chartLevels is no longer declared', /function chartLevels\(/.test(page), false);
ck('  nor is its canvas rendered', /id="cLevels"/.test(page), false);
ck('  nor the by-team canvas on the Overview', /id="cTeams"/.test(page), false);
ck('  and chartTeams survives for the Teams page',
   /function chartTeams\(id,mode\)\{/.test(page), true);
ck('  which still draws its own canvases', /id="tAvg"|'tAvg'/.test(page), true);
ck('the y axis is a percentage, bounded 0-100',
   /o\.scales\.y\.min=0; o\.scales\.y\.max=100;/.test(page), true);

console.log('\n--- every CSS variable used must actually be defined ---');
/* `background:var(--card)` on the frozen POC column. --card is not one of this
   palette's tokens, so it resolved to nothing, the cell was transparent, and
   every scrolled number slid visibly through the names. CSS does not warn:
   an undefined custom property with no fallback simply produces nothing. */
var defined = {};
(page.match(/--[a-z0-9-]+\s*:/gi) || []).forEach(function (d) {
  defined[d.replace(/\s*:$/, '')] = 1;
});
var usedNoFallback = {};
(page.match(/var\(\s*--[a-z0-9-]+\s*\)/gi) || []).forEach(function (u) {
  usedNoFallback[u.replace(/var\(\s*/, '').replace(/\s*\)$/, '')] = 1;
});
var undef = Object.keys(usedNoFallback).filter(function (v) { return !defined[v]; });
ck('tokens are defined somewhere', Object.keys(defined).length > 10, true);
ck('every var() without a fallback resolves', undef.join(', ') || '(none)', '(none)');
ck('  --card specifically is gone', /var\(--card\)/.test(page), false);
/* A var() WITH a fallback is fine, and the scanner must not flag one. There is
   no such declaration in the page today — .pvna used to carry the only one —
   so the rule is checked against the scanner itself rather than against a line
   that may or may not exist. */
var fallbackSample = 'color:var(--nope,var(--ink-3));background:var(--surface)';
var flagged = (fallbackSample.match(/var\(\s*--[a-z0-9-]+\s*\)/gi) || [])
  .map(function (u) { return u.replace(/var\(\s*/, '').replace(/\s*\)$/, ''); });
ck('  a fallback form is not treated as a bare var()',
   flagged.indexOf('--nope') >= 0, false);
ck('    though the tokens beside it still are',
   flagged.join(',').indexOf('--surface') >= 0, true);

console.log('\n--- the frozen POC column ---');
ck('its background is opaque and real',
   /\.pv \.pvname\{[^}]*background:var\(--surface\)/.test(page), true);
/* border-collapse means the TABLE owns borders; a collapsed border does not
   travel with a cell offset from its column, so the separator is a shadow */
ck('the separator is a shadow, not a collapsed border',
   /\.pv \.pvname\{[^}]*box-shadow:1px 0 0 var\(--line\)/.test(page), true);
ck('  and border-right is not relied on', /\.pv \.pvname\{[^}]*border-right/.test(page), false);
ck('the corner cell outranks the other sticky headers',
   /\.pv thead \.pvname\{[^}]*z-index:3/.test(page), true);
ck('  which are z-index 2', /th\{position:sticky;top:0;z-index:2/.test(page), true);
ck('  and the body cells are 1', /\.pv \.pvname\{[^}]*z-index:1/.test(page), true);

console.log('\n--- the page-load reveal ---');
/* It plays on a page LOAD only. A month change re-renders too, and animating
   that would delay numbers somebody is actively comparing. */
ck('playReveal defined', /function playReveal\(\)\{/.test(page), true);
ck('  only the initial load asks for it', /S\.reveal=true;/.test(page), true);
/* The flag only: what the teardown does with it afterwards is boottest's to
   say, and pinning the whole line here made this fail for a change that was
   nothing to do with the reveal. */
ck('  and it is consumed once, not left on',
   page.indexOf('if(S.reveal){ S.reveal=false;') >= 0, true);
/* bound the slice at boot(), which legitimately DOES set it — slicing to the
   end of the file swept boot() in and the assertion tested nothing useful */
ck('  reload() never sets it',
   /S\.reveal=true/.test(grab('function reload(){', 'function boot(quiet)')), false);
/* boot() is the LAST of the three in the file, so slice to the end */
ck('  but boot() does',
   /S\.reveal=true/.test(page.slice(page.indexOf('function boot(quiet)'))), true);
ck('the old month-change fade is gone entirely',
   /fx-out|fx-in|S\.fx\b/.test(page), false);
/* the delay is capped: ~200 rows at a fixed step would run for seconds */
ck('the stagger is capped', /var STEP=16, CAP=520;/.test(page), true);
ck('  and the cap is applied', page.indexOf('Math.min(i*STEP,CAP)') >= 0, true);
ck('only opacity and transform animate, so a long list does not thrash layout',
   /@keyframes revIn\{from\{opacity:0;transform:translateY\(5px\)\}/.test(page), true);
ck('  with both, so nothing flashes before its delay elapses',
   /\.rev\{animation:revIn [^}]*both\}/.test(page), true);
ck('reduced motion skips it completely',
   /\.rev\{animation:none!important\}/.test(page), true);

console.log('\n--- $ returns ONE element; $$ returns an array ---');
/* `$$('.tblm')` was written into the file as `$('.tblm')`, because "$$" in a
   String.replace REPLACEMENT is an escape for a literal "$". `.forEach` on a
   single element threw, and because it sat inside wire(), every binding below
   it — view-as, row clicks, the filter row, search — silently died with it.
   A throw in a wiring function is never local to the line it is on. */
var listMethod = /(^|[^$])\$\((?:[^()]|\([^()]*\))*\)\s*\.\s*(forEach|map|filter|slice)\b/;
ck('no single-$ result is treated as a list', listMethod.test(page), false);
ck('  while $$ results are', /\$\$\([^)]*\)\.forEach/.test(page), true);
ck('$ is querySelector', /function \$\(s,r\)\{ return \(r\|\|document\)\.querySelector\(s\); \}/.test(page), true);
ck('$$ is querySelectorAll', /function \$\$\(s,r\)\{[\s\S]{0,80}querySelectorAll\(s\)/.test(page), true);
ck('the per-table binding uses $$', page.indexOf("$$('.tblm').forEach") >= 0, true);

console.log('\n--- Achieved %: 100% must always mean ON TARGET ---');
eval(grab('function achievedPct(c){', 'function rowSlice(r,month){'));
function ap(t, a, dir) { return achievedPct({ t: t, a: a, dir: dir || 'higher_is_better' }); }
ck('9 of 9 sellers', ap(9, 9), 100);
ck('  half of target', ap(10, 5), 50);
ck('  over target', ap(10, 12), 120);
ck('6.50 Cr target, 7.15 Cr achieved',
   Math.round(ap(6.5, 7.15)), 110);

console.log('  a LOWER-is-better KRA has to be inverted, or it lies:');
/* DSO target 3 days, achieved 4 days. Naively 4/3 = 133% and looks like an
   overachievement. It is a miss, and the inverted figure says so. */
ck('4 days against a 3-day target reads as 75%, not 133%',
   Math.round(ap(3, 4, 'lower_is_better')), 75);
ck('  3 days against 3 is exactly 100%', ap(3, 3, 'lower_is_better'), 100);
ck('  2 days against 3 beats target', ap(3, 2, 'lower_is_better'), 150);
ck('  and the naive reading is NOT what is shown',
   Math.round(ap(3, 4, 'lower_is_better')) === 133, false);

console.log('  divisions that have no answer:');
ck('no target', String(ap(null, 5)), 'null');
ck('no achieved', String(ap(5, null)), 'null');
ck('a ZERO target is not a 500% achievement', String(ap(0, 5)), 'null');
ck('zero achieved on a lower-is-better KRA', String(ap(3, 0, 'lower_is_better')), 'null');
ck('zero achieved on a higher-is-better KRA is a real 0%', ap(5, 0), 0);

console.log('  and the inverted case is explained on the cell:');
ck('a title says why', /Lower is better for this KRA/.test(page), true);

console.log('\n--- Year to date is the default view ---');
ck('the initial period is ytd', /period:\s*'ytd'\s*,/.test(page), true);
ck('  and YTD is read-only by design',
   /function editable\(\)\{ return String\(S\.period\)!=='ytd'; \}/.test(page), true);

console.log('\n--- the YTD achieved cell ---');
/* takes the month now, so a per-table filter shows THAT month's working */
ck('achievedCell defined', /function achievedCell\(r,month\)\{/.test(page), true);
ck('  the scorecard uses it', page.indexOf("achievedCell(r)+'</td>'") >= 0, true);
/* the cell used to print only "4 / 5 mo" under YTD and no achieved value */
ck('  the months-only cell is gone',
   page.indexOf("r.months_scored+' / '+r.months_total+' mo'") >= 0, false);
ck('  it labels a mean as an average, not a total',
   page.indexOf('monthly average') >= 0, true);
ck('  and still says how many months it covers',
   page.indexOf("+' of '+r.months_total+' mo'") >= 0, true);
/* the source escapes the apostrophe, so match around it */
/* The YTD explanation card was removed on request. The RULES it described are
   still in force and are not obvious from the numbers, so the row still
   reports how it aggregated and the reasoning lives in HANDOVER.md §16.4. */
ck('the YTD explanation card is gone',
   page.indexOf('the year is rated on <b>the year') >= 0, false);
ck('  but the row still says how it aggregated', /agg_kind/.test(page), true);
ck('  and the achieved cell still labels a mean as an average',
   page.indexOf('monthly average') >= 0, true);

console.log('\n--- a card explains itself when clicked ---');
ck('tile takes a destination', /function tile\(label,value,hint,small,go\)\{/.test(page), true);
ck('  and only becomes clickable when given one',
   page.indexOf("(go?' clk\" data-go=\"'+go:'')") >= 0, true);
/* Ten Overview cards across the two rows. Seven are plain tiles carrying
   ,'method'; the three health bands are statTiles, which hard-code the same
   destination because their label slot holds a status dot rather than text. */
/* Every card now opens its OWN figures instead of navigating to the prose page.
   The ten card: destinations are counted further down; here we only check the
   plumbing that lets a card carry one. */
var statTiles = (page.match(/statTile\('(?:ok|warn|crit)'/g) || []).length;
ck('three health bands', statTiles, 3);
ck('  and statTile takes a destination of its own',
   /function statTile\(kind,label,value,hint,go\)\{/.test(page), true);
ck('  defaulting to the method page when none is given',
   /\(go\|\|'method'\)/.test(page), true);
ck('  the page says so, rather than leaving it to be discovered',
   page.indexOf('Click any card to see the figures behind it.') >= 0, true);
ck('  with a hover affordance', /\.tile\.clk:hover\{/.test(page), true);
ck('  and a keyboard focus ring', /\.tile\.clk:focus-visible\{/.test(page), true);
ck('data-go is already wired, so no new handler was needed',
   /\$\$\('\[data-go\]'\)\.forEach/.test(page), true);

console.log('\n--- the vertical x KRA roll-up above the detail tables ---');
ck('verticalSummary defined', /function verticalSummary\(\)\{/.test(page), true);
ck('  rendered above Targets and achieved',
   page.indexOf('var sum=verticalSummary();') <
   page.indexOf("<b style=\"color:var(--ink)\">Targets and achieved</b>"), true);
/* This used to assert that a KRA row SUMS across POCs "which is unit-safe".
   It is unit-safe and still wrong for a duration: Plastic's DSO came out as
   Neelesh's 20 days plus Rishi's 10 against a target of 5 + 5. The values are
   collected and reduced by agg_kind now — totalled for a quantity, averaged
   for a rate or a duration. Rendering is checked in cardtest. */
ck('  a KRA row collects its POC values rather than adding them blind',
   page.indexOf('k.ts.push(Number(r.plan_target))') >= 0, true);
ck('    and reduces by the aggregation kind',
   /function meansAcrossPocs\(k\)\{/.test(page), true);
ck('    the blind sum is gone',
   page.indexOf('k.t=(k.t===null?0:k.t)+Number(r.plan_target)') >= 0, false);
/* 15.61 crore of GMV + 19 sellers + 3 days of DSO is not 37.61 of anything.
   The shipment report this is modelled on can total its columns because each
   is a single unit; here every ROW is a different unit. */
ck('  but a vertical total does NOT sum them',
   page.indexOf('not summable — each KRA has its own unit') >= 0, true);
ck('  it counts KRAs meeting target instead',
   page.indexOf("(cnt?met+' / '+cnt:'—')") >= 0, true);
ck('  and the grand total does the same',
   page.indexOf("(gN?gMet+' / '+gN:'—')") >= 0, true);
/* the caveat is said ONCE in the caption now, not as a sentence sitting in a
   column of numbers on every vertical's total row */
ck('the quantity cells carry a deliberate blank marker',
   /\.sum \.na\{/.test(page), true);
ck('  and no prose is rendered inside the numeric columns',
   page.indexOf('not summable — each KRA has its own unit</td>') >= 0, false);
ck('  the caveat is in the caption instead',
   page.indexOf('totals count KRAs that met target') >= 0, true);
ck('total rows are styled distinctly', /\.sum tr\.vtot td\{/.test(page) &&
   /\.sum tr\.gtot td\{/.test(page), true);
ck('  and the dark row keeps its blanks readable',
   /\.sum tr\.gtot \.na\{color:rgba\(255,255,255,/.test(page), true);
/* OPACITY ON A TABLE CELL FADES ITS BACKGROUND TOO, not just its text.
   .sum .na and .sum tr.gtot .na sit on the <td>, and the Grand total row is
   painted var(--ink) — so opacity:.35 turned two black cells 35% grey and left
   a silver band across the middle of the row. Mute a cell by COLOUR. */
['\\.sum \\.na', '\\.sum tr\\.gtot \\.na', '\\.pv \\.pvna'].forEach(function (sel) {
  var m = page.match(new RegExp(sel + '\\{([^}]*)\\}'));
  ck('  ' + sel.replace(/\\/g, '') + ' does not use opacity',
     !!m && /opacity/.test(m[1]), false);
});
ck('  the blank marker is still visibly muted, just by colour',
   /\.sum \.na\{color:#[0-9a-f]{6}\}/i.test(page), true);
ck('the vertical name is one spanning cell, not a column of blanks',
   /rowspan=\\"'\+kids\.length\+'\\"/.test(page) ||
   page.indexOf('rowspan="\'+kids.length+\'"') >= 0, true);

console.log('\n--- the clear button only exists when there is something to clear ---');
/* Match the JS string literal the page would RENDER, not the words — the
   comment explaining the removal legitimately names it, and three guards in a
   row have now failed on their own documentation. */
ck('the disabled placeholder is never rendered',
   page.indexOf("'No filters'") >= 0, false);
ck('  and the button is no longer ever disabled',
   /data-clear="1" '\+\n?\s*'[^']*disabled/.test(page), false);
ck('  the cell is conditional', page.indexOf('if(live){') >= 0, true);
/* hidden, not deleted: it is the only one-click reset, and the only place the
   page states how many filters are active */
ck('  but the button still exists for when filters ARE set',
   page.indexOf("'Clear '+live+' filter'+(live===1?'':'s')") >= 0, true);
ck('  and clearing is still wired', /\[data-clear\]/.test(page), true);

console.log('\n--- the month selector moved into the filter row ---');
ck('periodCell defined', /function periodCell\(\)\{/.test(page), true);
ck('periodBar defined', /function periodBar\(\)\{/.test(page), true);
ck('it is the FIRST filter cell', page.indexOf('cells.push(periodCell());') >= 0, true);
ck('  and keeps id="pSel", so wire() finds it wherever it lands',
   /<select id=\\"pSel\\"/.test(page) || page.indexOf('<select id="pSel"') >= 0, true);
ck('the top bar no longer renders it', /class="pwrap"/.test(page), false);
ck('  and its old styles are gone', /^\.pwrap\{/m.test(page), false);
/* filterRow() only exists on Overview and People. Without a bar of its own,
   every other view would silently lose the ability to change month — including
   the scorecard, where actuals are RECORDED. */
var barViews = (page.match(/out\+=periodBar\(\);/g) || []).length;
ck('every view without a filter row gets a bar of its own', barViews, 5);
ck('  including the individual scorecard',
   /the scorecard is where actuals are RECORDED/.test(page), true);

/* ------------------------------------------------------------------ *
   A KPI IS COUNTED ONCE, HOWEVER MANY PEOPLE HOLD IT.

   Six Metal POCs hold the same seven KPIs. Counting assignment rows reported
   42 and made the framework look six times broader than it is.

   But the fold is on KRA + KPI NAME, never on the name alone. "Monthly Target
   Achievement (%)" is the KPI name for GMV, for New Buyer Acquisition and for
   New Seller Acquisition — three targets, three weightages, three KPIs. Name-
   only folding reported Metal as 5 and the organisation as 64 instead of 84,
   and 20 of the 38 people are affected by it.

   The KRA is taken by NAME rather than by kra_id on purpose: a kra_id is scoped
   to a team, so Metal's GMV and Plastic's GMV carry different ids for the same
   result area, and the whole point of these counts is that holding the same KPI
   does not make it a new one. */
console.log('\n--- a KPI is counted once, however many people hold it ---');
var S = { model: { kpis: [] } };
eval(grab('function normKpiName(v){',
          '/* Every filtered row that HAS a numeric target'));

M.kras = {
  k_gmv_m:  { id: 'k_gmv_m',  name: 'GMV' },                     /* Metal */
  k_gmv_p:  { id: 'k_gmv_p',  name: 'GMV' },                     /* Plastic, same KRA */
  k_nba:    { id: 'k_nba',    name: 'New Buyer Acquisition' },
  k_nsa:    { id: 'k_nsa',    name: 'New Seller Acquisition' },
  k_dso:    { id: 'k_dso',    name: 'DSO Days' },
  k_tat_om: { id: 'k_tat_om', name: 'Open Marketplace – Buyer & Seller Onboarding' },
  k_tat_rc: { id: 'k_tat_rc', name: 'Re-Commerce – Seller Onboarding' }
};
function row(emp, kraId, kpi) { return { employee_id: emp, kra_id: kraId, kpi: kpi }; }

console.log('  the reason it exists — the same KPI across people:');
var MTA = 'Monthly Target Achievement (%)';
var six = [];
for (var p = 0; p < 6; p++) {
  six.push(row('E' + p, 'k_gmv_m', MTA), row('E' + p, 'k_nba', MTA),
           row('E' + p, 'k_nsa', MTA), row('E' + p, 'k_dso', 'Days Sales Outstanding (DSO)'));
}
ck('six people x four KPIs is 24 assignment rows', six.length, 24);
ck('  but four KPIs', distinctKpiCountIn(six), 4);
ck('  and one person alone already holds all four', distinctKpiCountIn(six.slice(0, 4)), 4);

console.log('  and the trap it must not fall into — one KPI NAME, three KRAs:');
var amit = [row('E1', 'k_gmv_m', MTA), row('E1', 'k_nba', MTA), row('E1', 'k_nsa', MTA)];
ck('GMV, New Buyer and New Seller are THREE KPIs, not one',
   distinctKpiCountIn(amit), 3);
ck('  folding on the name alone would have said one',
   [MTA, MTA, MTA].filter(function (v, i, a) { return a.indexOf(v) === i; }).length, 1);
ck('  the identity carries the KRA', kpiIdentity('GMV', MTA), 'GMV | MONTHLY TARGET ACHIEVEMENT');
ck('  so two KRAs sharing a name differ',
   kpiIdentity('GMV', MTA) === kpiIdentity('New Buyer Acquisition', MTA), false);

console.log('  but the same KRA in two teams is still ONE KPI:');
ck('Metal GMV and Plastic GMV count once',
   distinctKpiCountIn([row('E1', 'k_gmv_m', MTA), row('E2', 'k_gmv_p', MTA)]), 1);
ck('  because the KRA is folded by NAME, not by id',
   kpiIdentity(M.kras.k_gmv_m.name, MTA), kpiIdentity(M.kras.k_gmv_p.name, MTA));

console.log('\n--- names are folded the way the SERVER folds them ---');
/* normName_ in Code.gs: upper case, punctuation to spaces, runs collapsed.
   The workbook really does contain both of the TAT spellings below. */
ck('a stray space is a typo, not a second KPI',
   distinctKpiCountIn([row('E1', 'k_tat_om', 'TAT ( 3 Days)'),
                       row('E1', 'k_tat_om', 'TAT ( 3 Days )')]), 1);
ck('case and padding do not make new KPIs',
   distinctKpiCountIn([row('E1', 'k_gmv_m', 'GMV'), row('E1', 'k_gmv_m', 'gmv'),
                       row('E1', 'k_gmv_m', '  GMV  ')]), 1);
ck('punctuation folds to a space',
   distinctKpiCountIn([row('E1', 'k_nba', 'New-Buyer Acquisition'),
                       row('E1', 'k_nba', 'New/Buyer Acquisition')]), 1);
ck('but genuinely different durations stay apart',
   distinctKpiCountIn([row('E1', 'k_tat_om', 'TAT ( 1 Day )'),
                       row('E1', 'k_tat_om', 'TAT ( 3 Days )'),
                       row('E1', 'k_tat_om', 'TAT')]), 3);
ck('  and the same TAT under two KRAs is two KPIs',
   distinctKpiCountIn([row('E1', 'k_tat_om', 'TAT ( 1 Day )'),
                       row('E1', 'k_tat_rc', 'TAT ( 1 Day )')]), 2);
/* the fold must stay the SERVER's fold — if normName_ changes and this does
   not, two counts of the same catalogue start disagreeing */
var codeFold = fs.readFileSync(require('path').join(ROOT, 'Code.gs'), 'utf8')
  .replace(/\r\n/g, '\n').match(/function normName_\(v\) \{[\s\S]*?\n\}/)[0];
ck('Code.gs normName_ uses the same character class',
   codeFold.indexOf('[^A-Z0-9 ]+') >= 0 && codeFold.indexOf('.toUpperCase()') >= 0, true);
ck('  and so does normKpiName',
   grab('function normKpiName(v){', 'function kpiIdentity(')
     .indexOf('[^A-Z0-9 ]+') >= 0, true);

console.log('\n--- blanks and bad rows cannot inflate the count ---');
ck('a nameless row is not a KPI',
   distinctKpiCountIn([row('E1', 'k_gmv_m', ''), row('E1', 'k_gmv_m', '   '),
                       row('E1', 'k_gmv_m', 'GMV')]), 1);
ck('a null row does not throw', distinctKpiCountIn([null, undefined, row('E1', 'k_gmv_m', 'GMV')]), 1);
ck('an unknown KRA does not throw either',
   distinctKpiCountIn([row('E1', 'no_such_kra', 'GMV')]), 1);
ck('no rows at all counts zero, not NaN', distinctKpiCountIn([]), 0);
ck('  and neither does nothing at all', distinctKpiCountIn(), 0);
ck('a KPI with no name is dropped even with a KRA', kpiIdentity('GMV', ''), '');

console.log('\n--- the catalogue counter folds the same way ---');
function kpis(defs) {
  S.model.kpis = defs.map(function (d, i) {
    return { id: 'kpi_' + i, kra_id: d[0], name: d[1] };
  });
}
kpis([]);
ck('an empty catalogue counts zero', distinctKpiCount(), 0);
kpis([['k_gmv_m', MTA], ['k_nba', MTA], ['k_nsa', MTA]]);
ck('three catalogue rows under three KRAs count three', distinctKpiCount(), 3);
ck('  and the rows themselves are untouched', S.model.kpis.length, 3);
kpis([['k_gmv_m', MTA], ['k_gmv_p', MTA]]);
ck('the same KRA in two teams counts once', distinctKpiCount(), 1);
S.model = {};
ck('no catalogue at all counts zero, not NaN', distinctKpiCount(), 0);

console.log('\n--- which number goes where ---');
/* The headline is the KPI count; the assignment count keeps its place beneath,
   because it is what every rollup divides by. */
/* The Overview lost its own KPIs card when the two rows became Executive
   summary / Performance health. The deduped count must not have gone with it —
   it is the one number saying how much of the framework the assignments cover,
   so it lives in the KPI gap card's small print. */
ck('the Overview still carries the DEDUPED count',
   /distinctKpiCountIn\(V1\.list\)/.test(page), true);
ck('  folded over the FILTERED rows, like every figure beside it',
   page.indexOf("'</b> KPIs · <b>'+V1.rated.length+") >= 0, true);
ck('  beside the assignment count, which is NOT deduped',
   page.indexOf("'of <b>'+V1.st.n+'</b> assignments · <b>'+distinctKpiCountIn(V1.list)+") >= 0,
   true);
ck('the People page team header counts KPIs',
   page.indexOf('var kpis=distinctKpiCountIn(gr);') >= 0, true);
ck('  not assignment rows', /kpis\+=\(M\.byEmp\[e\.id\]\|\|\[\]\)\.length/.test(page), false);
ck('the Teams table KPIs column counts KPIs',
   page.indexOf('var n=distinctKpiCountIn(all);') >= 0, true);
ck('  and Scored beside it stays a row count', /sc\+=o\.scored_count\|\|0/.test(page), true);
ck('the by-team chart counts KPIs',
   page.indexOf('vals.push(distinctKpiCountIn(rs));') >= 0, true);
ck('  and says so in its tooltip',
   page.indexOf("c.parsed.x+(c.parsed.x===1?' KPI':' KPIs')") >= 0, true);
ck('  and in its title', page.indexOf("title:'KPIs by team'") >= 0, true);
ck('the old row-counting headline is gone',
   page.indexOf("tile('KPI assignments',String(st.n),'<b>'+((S.model||{}).kras||[]).length") >= 0,
   false);
ck('  as is the raw catalogue length',
   page.indexOf("((S.model||{}).kpis||[]).length+'</b> KPIs in the catalogue") >= 0, false);
ck('  and the framework header shows the catalogue fold',
   page.indexOf("distinctKpiCount()+' distinct KPIs") >= 0, true);
ck('    not its row count', page.indexOf("(m.kpis||[]).length+' KPIs ") >= 0, false);

console.log('\n--- but the ASSIGNMENT count must never be deduped ---');
/* Deduping the rollup denominator would silently reweight every scorecard:
   the weightage lives on the ASSIGNMENT, and there is one per person. */
ck('the team page still counts assignments per person',
   page.indexOf("tile('KPI assignments',String(st.n),'<b>'+st.scored+'</b> scored')") >= 0, true);
ck('stats() counts rows, not names', /var st=\{n:list\.length,/.test(page), true);
ck('the scorecard tile still counts the person\'s own rows',
   page.indexOf("tile('KPIs',String(rs.length)") >= 0, true);
/* and that is not a shortcut: a person holds each KRA+KPI exactly once, so the
   two agree. Assert it, so the claim is checked rather than assumed. */
ck('  which for one person is already the deduped count',
   distinctKpiCountIn(amit), amit.length);
/* `+` cannot be in this class: it is also string concatenation, and once the
   count was concatenated across a line break the old pattern matched the
   INDENT of the next line and reported arithmetic that was not there. The
   operators below have no second meaning, and a `+` is only caught when a
   NUMBER follows it. */
ck('nothing divides or scales either counter',
   /distinctKpiCount(In)?\([^)]*\)\s*[\/*-]/.test(page), false);
ck('  and nothing adds a number to one',
   /distinctKpiCount(In)?\([^)]*\)\s*\+\s*[0-9]/.test(page), false);
ck('  and nothing compares against them',
   /(?:[<>]=?|[=!]==?)\s*distinctKpiCount(In)?\(/.test(page), false);
ck('the method page explains why the two differ',
   page.indexOf("title:'Assignments, KRAs and KPIs'") >= 0, true);
ck('  leading with the one on the card',
   page.indexOf("['KPIs <span class=\"cap\">(the number on the card)</span>'") >= 0, true);
ck('  and spelling out what makes two KPIs the same',
   page.indexOf("['What counts as the same KPI'") >= 0, true);
ck('    naming the shared KPI outright',
   page.indexOf('is the KPI name for GMV') >= 0, true);

/* ------------------------------------------------------------------ *
   EVERY svg() KEY MUST EXIST.

   svg('i') was written for the Customers button. ICON has no 'i', so
   ICON[n].split() threw on undefined — and it threw while BUILDING the
   scorecard header, which would have blanked the whole page for every person.
   A missing icon is not a cosmetic fault. */
console.log('\n--- every icon referenced actually exists ---');
var iconBlock = (function () {
  var i = page.indexOf('var ICON = {'), j = page.indexOf('\n};', i);
  return i < 0 ? '' : page.slice(i, j);
})();
var iconKeys = {};
(iconBlock.match(/^\s{2}([a-z0-9]+)\s*:/gm) || []).forEach(function (x) {
  iconKeys[x.trim().replace(':', '')] = 1;
});
ck('the ICON table was found', Object.keys(iconKeys).length > 8, true);
var usedIcons = {};
(page.match(/svg\('([a-z0-9]+)'/g) || []).forEach(function (u) {
  usedIcons[u.replace(/svg\('/, '').replace(/'/, '')] = 1;
});
ck('  icons are actually used', Object.keys(usedIcons).length > 5, true);
var missingIcons = Object.keys(usedIcons).filter(function (k) { return !iconKeys[k]; });
ck('  every svg() key resolves', missingIcons.join(', ') || '(none)', '(none)');
ck('  svg(\'i\') specifically is gone', /svg\('i'\)/.test(page), false);

/* ------------------------------------------------------------------ *
   A CARD SHOWS ITS OWN WORKING, and cannot disagree with itself. */
console.log('\n--- each Overview card opens its own figures ---');
ck('ovStats is the single computation', /function ovStats\(\)\{/.test(page), true);
ck('  and the cards read it', /var V1=ovStats\(\);/.test(page), true);
ck('  as does the breakdown', /function cardDetail\(key\)\{[\s\S]{0,80}?ovStats\(\)/.test(page),
   true);
/* The point is that the cards and the breakdown share ONE computation. Counting
   the name would count it in the prose above it too, so the check is that the
   breakdown never takes its own mean of the scores. */
ck('  the breakdown does not recompute the average',
   /function cardDetail\(key\)\{[\s\S]{0,6000}?o\.score[^\n]{0,40}reduce/.test(page), false);
var cardKeys = (page.match(/'card:([a-z]+)'/g) || []).map(function (x) {
  return x.replace(/'card:/, '').replace(/'/, '');
});
ck('all ten cards carry a card: destination', cardKeys.length, 10);
['employees', 'avg', 'attain', 'completion', 'top', 'ok', 'warn', 'crit', 'gap', 'dept']
  .forEach(function (k) {
    ck('  ' + k, cardKeys.indexOf(k) >= 0, true);
    /* and cardDetail must handle it, or the click silently falls back */
    ck('    handled by cardDetail', new RegExp("key==='" + k + "'").test(page), true);
  });
ck('an unknown key falls back to the method page rather than dying',
   page.indexOf("go='method';") >= 0, true);
ck('  and cardDetail returns null for one', /else \{ return null; \}/.test(page), true);
ck('the arithmetic is written out, not described', /function sumLine\(txt\)\{/.test(page), true);
ck('  and styled as its own block', /\.sumline\{/.test(page), true);
ck('the modal still links to the rules',
   page.indexOf('The rules behind every card') >= 0, true);
ck('the page no longer promises prose',
   page.indexOf('Click any card to see how it is calculated.') >= 0, false);
ck('  it promises figures', page.indexOf('Click any card to see the figures behind it.') >= 0,
   true);
/* shell() escapes title and cap, so pre-escaping them double-encodes a name */
ck('a card caption is not pre-escaped',
   /cap=V\.top\?h\(V\.top\.e\.name\)/.test(page), false);
ck('  nor is the department one', /cap=V\.depts\.length\?h\(teamLabel/.test(page), false);

console.log('\n--- the customers behind a scorecard ---');
ck('the button exists', /data-cust="'\+h\(e\.id\)\+'"/.test(page), true);
ck('  and is wired', /\$\$\('\[data-cust\]'\)/.test(page), true);
ck('  to a modal that loads on demand', /function modalCustomers\(empId\)\{/.test(page), true);
ck('it calls the read-only API', page.indexOf("Api.call('apiCustomerDetail'") >= 0, true);
ck('  passing the period and the view-as', /period_id:S\.period,[\s\S]{0,40}view_as:S\.viewAs/
   .test(page), true);
ck('  and shows a loading state rather than an empty box',
   page.indexOf('Reading MM_CT') >= 0, true);
ck('a failure is reported, not swallowed',
   /emptyBox\('Could not load'/.test(page) &&
   /emptyBox\('Could not reach the server'/.test(page), true);
ck('an empty result explains itself', /emptyBox\('No customers found',res\.why/.test(page),
   true);
ck('money is shown in crore, like every other figure on the page',
   /function crore\(v\)\{/.test(page), true);
ck('  and the basis is stated on the table', page.indexOf('the same basis the DSO') >= 0,
   true);

/* The boot screen used to be asserted here. It moved to boottest.js when the
   spinning mark was replaced by the desk figure: half of what this section
   checked — the flight to the sidebar logo, the frozen spin, the word-fill —
   was about code that no longer exists, and the half that survived belongs
   with the drawing it constrains. Do not re-add it here; one owner per fact,
   or the two copies drift and the weaker one gets believed. */

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);

