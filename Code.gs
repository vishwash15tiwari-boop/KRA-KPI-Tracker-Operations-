/*******************************************************************************
 * RECYKAL — KRA / KPI TRACKER  ·  BACKEND / DATA LAYER  (Code.gs)
 * =============================================================================
 * ONE generic, structure-discovering engine. It reads the MASTER spreadsheet
 * (org structure + KRA/KPI definitions + weightage + the 5-band rubric) live at
 * runtime, and joins a SEPARATE actuals/target source (a managed tab, or any
 * external spreadsheet you configure) by a stable KpiId. Every number, band,
 * rating, roll-up and status is computed here; Index.html is a pure renderer.
 *
 * NOTHING about the org is hard-coded — not tabs, people, KRAs, KPIs, weights,
 * targets or bands. The parser classifies each tab into one of four shapes and
 * adapts. If a department / team / person / KRA / KPI / band is blank in the
 * sheet, it stays blank here — no fabrication, no inference of missing data.
 *
 *   Tab shapes it understands (auto-detected, order-independent):
 *   • TEMPLATE  — a shared market scorecard (Perspective | KRA | Source |
 *                 KPI/Definition | Weightage | Unit | Target 1..5) with Supply
 *                 and/or Demand sections; individuals come from a ROSTER tab.
 *   • BLOCKS    — one KRA/KPI block per person (title "Individual - X" /
 *                 "Collections - X" / "Name (Role)") with bands labelled
 *                 Needs Improvement(1) … Exceeds(5).
 *   • ROSTER    — a directory mapping people to a team (+ region), e.g.
 *                 "POC Directory".
 *   • GENERIC   — any other tab (e.g. a Control-Tower summary): surfaced as a
 *                 read-only table so nothing is silently dropped.
 *
 * Scoring contract (unified across all shapes):
 *   Each KPI has up to 5 ordered bands worst(1)→best(5). Direction is
 *   auto-detected (band5 vs band1) so lower-is-better KPIs (DN%, DSO, PDD…) work.
 *   An Actual is interpolated across the band ladder into a RATING 1–5
 *   (band 3 = "Meets" = on-target). Person score = weight-normalised mean of
 *   ratings; rolls up person→sub-team→department→org. KPIs with non-numeric
 *   bands are qualitative (manual 1–5 rating). No actual yet ⇒ "Pending".
 ******************************************************************************/

/** ------------------------------------------------------------------ CONFIG */
var SOURCE_SPREADSHEET_ID = '1c0_pP4Mmye5s5D_vzoxrvJ-utkLb6JhD69TvvOBbjoo';

// Managed tabs (created on demand). ACTUALS is the "separate source" for
// targets + actual performance; SETTINGS holds thresholds / period / an
// optional external actuals spreadsheet id. Both are ignored by the parser.
var ACTUALS_TAB  = 'KKT_Actuals';
var SETTINGS_TAB = 'KKT_Settings';

// Rating thresholds (on the 1–5 scale) → semantic status. Editable in Settings.
var DEFAULT_THRESHOLDS = { onTrack: 3.0, atRisk: 2.0 };   // >=3 On Track, >=2 At Risk, else Off Track
var RATING_MAX = 5;

var CACHE_PREFIX = 'kkt_v3_';
var CACHE_TTL    = 900;   // 15 min; busted on any save/scaffold

/** -------------------------------------------------------------- WEB ENTRY */
function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('Recykal · KRA / KPI Tracker')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/** ============================================================= PUBLIC API */

/** Main entry — returns the fully computed model for a period. */
function apiBootstrap(opts) {
  opts = opts || {};
  try {
    var settings = readSettings_();
    var period = (opts.period || settings.period || currentPeriod_());
    var cacheKey = CACHE_PREFIX + period;
    var cache = CacheService.getScriptCache();
    if (!opts.force) {
      var hit = cache.get(cacheKey);
      if (hit) { try { return JSON.parse(hit); } catch (e) {} }
    }
    var model = buildModel_(period, settings);
    try { cache.put(cacheKey, JSON.stringify(model), CACHE_TTL); } catch (e) {}
    return model;
  } catch (err) {
    return errModel_(err);
  }
}

/** Observability — what the parser saw (run from the editor or the UI). */
function apiDiagnostics(opts) {
  opts = opts || {};
  try {
    var settings = readSettings_();
    var period = opts.period || settings.period || currentPeriod_();
    var ss = SpreadsheetApp.openById(SOURCE_SPREADSHEET_ID);
    var tabs = ss.getSheets().map(function (sh) {
      var grid = safeValues_(sh);
      var cls = isManaged_(sh.getName()) ? { kind: 'managed' } : classifyTab_(grid, sh.getName());
      return { name: sh.getName(), rows: sh.getLastRow(), cols: sh.getLastColumn(), kind: cls.kind };
    });
    var model = buildModel_(period, settings);
    return {
      ok: true, title: ss.getName(), period: period, tabs: tabs,
      summary: {
        departments: model.departments.map(function (d) { return d.name + ' (' + d.kind + ', ' + d.employeeCount + ' people, ' + d.kpiCount + ' KPIs)'; }),
        subTeams: model.subTeams.map(function (s) { return s.deptName + ' › ' + s.name; }),
        people: model.employees.length,
        records: model.records.length,
        withActuals: model.records.filter(function (r) { return r.hasActual; }).length,
        actualsSource: model.source.actuals
      }
    };
  } catch (err) { return { ok: false, error: String(err && err.message || err), stack: String(err && err.stack || '') }; }
}

/**
 * Create/refresh the SEPARATE actuals sheet from the live framework: one row
 * per KPI (× period), with the target pre-filled from the "Meets" band where
 * numeric and Actual left blank for the ops team to fill. Never overwrites
 * existing rows. This is scaffolding from real structure — not fabricated data.
 */
function apiScaffoldActuals(opts) {
  opts = opts || {};
  try {
    var settings = readSettings_();
    var period = opts.period || settings.period || currentPeriod_();
    var model = buildModel_(period, settings);           // framework (+ any existing actuals)
    var sh = ensureActualsSheet_();
    var existing = {};
    var data = sh.getDataRange().getValues();
    var head = data.length ? data[0] : ACTUALS_HEADERS_();
    var idIdx = head.indexOf('KpiId'), perIdx = head.indexOf('Period');
    for (var i = 1; i < data.length; i++) existing[data[i][idIdx] + '|' + data[i][perIdx]] = true;

    var rows = [];
    model.records.forEach(function (r) {
      var key = r.kpiId + '|' + period;
      if (existing[key]) return;
      rows.push([
        r.kpiId, period, r.department, r.subTeam || '', r.employee, r.kra, r.kpi,
        r.unit || '', r.weightShown == null ? '' : r.weightShown,
        r.meetsValue == null ? '' : r.meetsValue, '', '', '', '',
        nowIso_(), safeEmail_()
      ]);
    });
    if (rows.length) sh.getRange(sh.getLastRow() + 1, 1, rows.length, ACTUALS_HEADERS_().length).setValues(rows);
    bustCache_();
    return { ok: true, added: rows.length, period: period, total: sh.getLastRow() - 1, tab: ACTUALS_TAB };
  } catch (err) { return { ok: false, error: String(err && err.message || err) }; }
}

/** Upsert one actual/target/rating for a KPI × period; recompute follows on refresh. */
function apiSaveActual(p) {
  p = p || {};
  try {
    if (!p.kpiId) throw new Error('Missing kpiId.');
    var period = p.period || readSettings_().period || currentPeriod_();
    var sh = ensureActualsSheet_();
    var data = sh.getDataRange().getValues();
    var head = data[0];
    var col = {}; head.forEach(function (h, i) { col[h] = i; });
    var row = -1;
    for (var i = 1; i < data.length; i++) if (data[i][col.KpiId] === p.kpiId && String(data[i][col.Period]) === String(period)) { row = i; break; }

    var rec = row >= 0 ? data[row].slice() : newActualRow_(p, period);
    if (p.actual   !== undefined) rec[col.Actual]   = p.actual   === '' ? '' : num_(p.actual);
    if (p.target   !== undefined) rec[col.Target]   = p.target   === '' ? '' : num_(p.target);
    if (p.rating   !== undefined) rec[col.Rating]   = p.rating   === '' ? '' : clamp_(num_(p.rating), 1, 5);
    if (p.comment  !== undefined) rec[col.Comment]  = String(p.comment || '');
    if (p.evidence !== undefined) rec[col.Evidence] = String(p.evidence || '');
    rec[col.UpdatedAt] = nowIso_(); rec[col.UpdatedBy] = safeEmail_();

    if (row >= 0) sh.getRange(row + 1, 1, 1, head.length).setValues([rec]);
    else          sh.getRange(sh.getLastRow() + 1, 1, 1, head.length).setValues([rec]);
    bustCache_();
    return { ok: true, kpiId: p.kpiId, period: period };
  } catch (err) { return { ok: false, error: String(err && err.message || err) }; }
}

/** Persist settings (thresholds / active period / external actuals source). */
function apiSaveSettings(p) {
  try {
    var s = readSettings_();
    p = p || {};
    if (p.period      !== undefined) s.period = String(p.period || '');
    if (p.onTrack     !== undefined) s.thresholds.onTrack = num_(p.onTrack);
    if (p.atRisk      !== undefined) s.thresholds.atRisk  = num_(p.atRisk);
    if (p.actualsSheetId !== undefined) s.actualsSheetId = String(p.actualsSheetId || '');
    if (p.actualsTab     !== undefined) s.actualsTab     = String(p.actualsTab || '');
    if (p.planSheetId    !== undefined) s.planSheetId    = String(p.planSheetId || '').replace(/^.*\/d\/([-\w]{20,}).*$/, '$1');
    writeSettings_(s); bustCache_();
    return { ok: true, settings: s };
  } catch (err) { return { ok: false, error: String(err && err.message || err) }; }
}

/** ========================================================= BUILD MODEL */
function buildModel_(period, settings) {
  settings = settings || readSettings_();
  period = period || settings.period || currentPeriod_();

  var ss;
  try { ss = SpreadsheetApp.openById(SOURCE_SPREADSHEET_ID); }
  catch (e) { return { ok: false, connected: false, empty: true, error: 'Cannot open the master spreadsheet.', generatedAt: nowIso_() }; }

  var sheets = ss.getSheets();

  // ---- PASS 1: rosters (people → team + region), needed to expand templates.
  var rosterByTeam = {};
  sheets.forEach(function (sh) {
    if (isManaged_(sh.getName())) return;
    var grid = safeValues_(sh);
    if (classifyTab_(grid, sh.getName()).kind === 'roster') parseRoster_(grid, rosterByTeam);
  });

  // ---- PASS 2: departments / people / KPI records (+ collect PLAN tabs).
  var ctx = { depts: [], deptById: {}, subTeams: [], subById: {}, employees: [], empById: {}, records: [], seenKpiId: {}, order: 0, notes: [] };
  var planTabs = [];
  sheets.forEach(function (sh) {
    var name = sh.getName();
    if (isManaged_(name)) return;
    var grid = safeValues_(sh);
    if (!hasContent_(grid)) return;
    var cls = classifyTab_(grid, name);
    if (cls.kind === 'roster') return;                       // already consumed
    if (PLAN_KINDS_[cls.kind]) { planTabs.push({ grid: grid, name: name, cls: cls, source: ss.getName() }); return; }
    if (cls.kind === 'template') parseTemplateTab_(grid, name, cls, rosterByTeam, ctx);
    else if (cls.kind === 'blocks') parseBlocksTab_(grid, name, cls, ctx);
    else parseGenericTab_(grid, name, ctx);
  });

  // ---- optional SECOND source holding the GMV/onboarding plan workbook.
  var planSource = null;
  if (settings.planSheetId) {
    try {
      var ps = SpreadsheetApp.openById(settings.planSheetId);
      planSource = { title: ps.getName(), id: settings.planSheetId };
      ps.getSheets().forEach(function (sh) {
        if (isManaged_(sh.getName())) return;
        var g = safeValues_(sh);
        if (!hasContent_(g)) return;
        var c = classifyTab_(g, sh.getName());
        if (PLAN_KINDS_[c.kind]) planTabs.push({ grid: g, name: sh.getName(), cls: c, source: ps.getName() });
      });
    } catch (e) { ctx.notes.push('Could not open the plan spreadsheet: ' + (e && e.message || e)); }
  }

  // ---- join the SEPARATE actuals source (all periods) & compute performance.
  var all = readAllActuals_(settings);
  ctx.records.forEach(function (r) { computeRecord_(r, all.byKey[r.kpiId + '|' + period] || all.byKey[r.kpiId + '|'] || null, settings); });

  // ---- roll-ups, then trends / levels / perspectives / master-health.
  rollUp_(ctx, settings);
  computeTrends_(ctx, all, period, settings);
  var perspectives = perspectiveRollup_(ctx, settings);
  var health = computeHealth_(ctx, all);

  // ---- PLAN layer (GMV targets / onboarding / buyer-supplier mapping).
  var plan = buildPlan_(planTabs, planSource);

  var empty = ctx.records.length === 0 && !plan.hasData && ctx.depts.every(function (d) { return !d.rawTable; });
  return {
    ok: true, connected: true, empty: empty, plan: plan,
    generatedAt: nowIso_(), lastUpdated: fileUpdated_(),
    user: { email: safeEmail_() },
    period: period,
    source: {
      title: ss.getName(), id: SOURCE_SPREADSHEET_ID,
      tabs: sheets.map(function (s) { return { name: s.getName(), rows: s.getLastRow(), cols: s.getLastColumn() }; }),
      actuals: actualsSourceInfo_(settings, all)
    },
    settings: { thresholds: settings.thresholds, period: settings.period, periods: mergePeriods_(knownPeriods_(all, period), plan.periods), ratingMax: RATING_MAX, planSheetId: settings.planSheetId || '' },
    departments: ctx.depts,
    subTeams: ctx.subTeams,
    employees: ctx.employees,
    records: ctx.records,
    rollups: ctx.rollups,
    perspectives: perspectives,
    health: health,
    notes: ctx.notes
  };
}

/** ==================================================== TAB CLASSIFICATION */
function classifyTab_(grid, name) {
  if (!hasContent_(grid)) return { kind: 'empty' };
  // PLAN layer first: a GMV/onboarding/mapping tab must not be mistaken for a
  // roster (the onboarding tab carries Region + POC columns) or a generic tab.
  var plan = classifyPlanTab_(grid, name);
  if (plan) return plan;
  var headerRows = [];
  for (var r = 0; r < grid.length; r++) if (isKpiHeader_(grid[r])) headerRows.push(r);

  if (headerRows.length === 0) {
    if (isRosterTab_(grid, name)) return { kind: 'roster' };
    return { kind: 'generic' };
  }
  // KPI-shaped: BLOCKS if any header is owned by a person title, else TEMPLATE.
  var hasPersonTitle = false;
  for (var i = 0; i < headerRows.length; i++) if (personForHeader_(grid, headerRows[i]).name) { hasPersonTitle = true; break; }
  return hasPersonTitle ? { kind: 'blocks', headerRows: headerRows } : { kind: 'template', headerRows: headerRows };
}

/* A KRA/KPI header row: has a weightage col, a kra/kpi col, and >=3 band cols. */
function isKpiHeader_(row) {
  var n = row.map(norm_);
  var has = function (t) { return n.some(function (c) { return c.indexOf(t) >= 0; }); };
  var hasWeight = has('weightage') || has('weight');
  var hasKK = has('kra') || has('kpi');
  return hasWeight && hasKK && findBandCols_(row).length >= 3;
}

/* A roster/directory tab: a Region/POC header, or the name says directory/roster. */
function isRosterTab_(grid, name) {
  if (/directory|roster/i.test(name || '')) return true;
  for (var r = 0; r < grid.length; r++) {
    var n = grid[r].map(norm_);
    var hasPoc = n.some(function (c) { return c === 'poc' || c.indexOf('poc') >= 0; });
    var hasReg = n.some(function (c) { return c === 'region'; });
    if (hasPoc && hasReg) return true;
  }
  return false;
}

/** ==================================================== COLUMN MAPPING */
function findBandCols_(header) {
  var out = [];
  for (var c = 0; c < header.length; c++) {
    var s = norm_(header[c]);
    if (!s) continue;
    if (/target\s*\d/.test(s) || /\(\s*[1-5]\s*\)/.test(s) ||
        /needs improvement|below expectation|meets expectation|above expectation|exceeds/.test(s)) {
      out.push({ c: c, label: cleanCell_(header[c]) });
    }
  }
  return out;
}

/* Adapts to both TEMPLATE (name lives in "KRA", definition in "KPI/Definition")
 * and BLOCKS (distinct KRA + KPI + Goal columns) layouts. */
function mapCols_(header) {
  var n = header.map(norm_);
  function find(preds, from) { from = from || 0; for (var c = from; c < n.length; c++) for (var p = 0; p < preds.length; p++) if (n[c].indexOf(preds[p]) >= 0) return c; return -1; }
  function findExact(val, from) { from = from || 0; for (var c = from; c < n.length; c++) if (n[c] === val) return c; return -1; }

  var perspective = find(['perspective']);
  var role        = find(['role']);
  var weight      = find(['weightage', 'weight']);
  var source      = find(['source']);
  var unit        = find(['unit']);
  var bandCols    = findBandCols_(header);
  var def         = find(['definition', 'goal description', 'goal']);

  var kpiExact = findExact('kpi', perspective >= 0 ? perspective + 1 : 0);
  var kraCol   = findExact('kra', perspective >= 0 ? perspective + 1 : 0);
  if (kraCol < 0) kraCol = find(['kra'], perspective >= 0 ? perspective + 1 : 0);

  var nameCol, style;
  if (kpiExact >= 0) { style = 'blocks'; nameCol = kpiExact; }         // BLOCKS: KPI is the metric name
  else { style = 'template'; nameCol = kraCol; if (def < 0) def = find(['kpi']); } // TEMPLATE: KRA is the KPI name; def = "KPI / Definition"

  return { style: style, perspective: perspective, role: role, kra: kraCol, name: nameCol, def: def, weight: weight, source: source, unit: unit, bands: bandCols };
}

/** ==================================================== ROSTER PARSER */
function parseRoster_(grid, rosterByTeam) {
  var team = '', regCol = -1, pocCol = -1;
  for (var r = 0; r < grid.length; r++) {
    var row = grid[r], n = row.map(norm_);
    // team label = a lone non-empty cell (merged section header), not region/poc
    var nonEmpty = row.filter(function (c) { return String(c == null ? '' : c).trim() !== ''; });
    if (nonEmpty.length === 1) {
      var lbl = cleanCell_(nonEmpty[0]);
      if (lbl && !/^region$|^poc$/i.test(lbl)) { team = lbl; regCol = -1; pocCol = -1; continue; }
    }
    var ri = n.indexOf('region'), pi = -1;
    for (var c = 0; c < n.length; c++) if (n[c].indexOf('poc') >= 0) { pi = c; break; }
    if (pi >= 0) { regCol = ri; pocCol = pi; continue; }              // header row for this team block
    if (pocCol < 0) continue;
    var poc = cleanCell_(row[pocCol]);
    if (!poc || norm_(poc) === 'poc') continue;
    var region = regCol >= 0 ? cleanCell_(row[regCol]) : '';
    var key = norm_(team);
    (rosterByTeam[key] = rosterByTeam[key] || []).push({ name: poc, region: region });
  }
}

/** ==================================================== TEMPLATE PARSER */
function parseTemplateTab_(grid, tabName, cls, rosterByTeam, ctx) {
  var ds = splitDeptSub_(tabName);
  var dept = getDept_(ctx, ds.dept, 'scorecard');
  var headers = cls.headerRows;
  var sections = [];
  headers.forEach(function (hr, i) {
    var end = (i + 1 < headers.length) ? headers[i + 1] : grid.length;
    var cols = mapCols_(grid[hr]);
    var title = sectionTitleAbove_(grid, hr);
    var sub = ds.sub || classifySection_(title, headers.length);
    var kpis = [];
    for (var r = hr + 1; r < end; r++) {
      if (isKpiHeader_(grid[r])) break;
      var name = cell_(grid[r], cols.name);
      if (!name) continue;
      kpis.push(readKpi_(grid[r], cols, name));
    }
    if (kpis.length) sections.push({ sub: sub, title: title, kpis: kpis });
  });
  if (!sections.length) return;

  var roster = matchRoster_(rosterByTeam, ds.dept);
  sections.forEach(function (sec) {
    var subTeam = sec.sub ? getSubTeam_(ctx, dept, sec.sub) : null;
    var people = roster.length ? roster : [{ name: (sec.sub ? sec.sub + ' scorecard' : dept.name + ' scorecard'), region: '', isTemplate: true }];
    people.forEach(function (person) {
      var emp = getEmployee_(ctx, dept, person.name, '', person.region, !!person.isTemplate);
      sec.kpis.forEach(function (k) { pushRecord_(ctx, dept, subTeam, emp, k, sec.title); });
    });
  });
  dept.weightNote = weightNote_(sections[0].kpis);
}

/** ==================================================== BLOCKS PARSER */
function parseBlocksTab_(grid, tabName, cls, ctx) {
  var ds = splitDeptSub_(tabName);
  var dept = getDept_(ctx, ds.dept, 'individuals');
  var subTeam = ds.sub ? getSubTeam_(ctx, dept, ds.sub) : null;   // e.g. a "… - Supply" blocks tab
  var headers = cls.headerRows;
  headers.forEach(function (hr, i) {
    var end = (i + 1 < headers.length) ? headers[i + 1] : grid.length;
    var cols = mapCols_(grid[hr]);
    var person = personForHeader_(grid, hr);
    var emp = getEmployee_(ctx, dept, person.name || ('Member ' + (i + 1)), person.role || '', '', false);
    for (var r = hr + 1; r < end; r++) {
      var row = grid[r];
      if (isKpiHeader_(row) || personForHeader_(grid, r).name) break;
      var kra = cell_(row, cols.kra), name = cell_(row, cols.name);
      if (!kra && !name) continue;              // skip blank / SUM / total rows — a KPI needs a KRA or KPI name
      var k = readKpi_(row, cols, name || kra);
      if (!emp.role && cols.role >= 0) emp.role = cell_(row, cols.role) || emp.role;
      pushRecord_(ctx, dept, subTeam, emp, k, '');
    }
  });
}

/** ==================================================== GENERIC PARSER */
function parseGenericTab_(grid, tabName, ctx) {
  var dept = getDept_(ctx, tabName, 'info');
  // detect the header row: first row with >=3 non-empty, mostly-text cells.
  var hr = -1;
  for (var r = 0; r < Math.min(grid.length, 15); r++) {
    var ne = grid[r].filter(function (c) { return String(c == null ? '' : c).trim() !== ''; });
    if (ne.length >= 3) { hr = r; break; }
  }
  if (hr < 0) { dept.rawTable = { headers: [], rows: [] }; return; }
  var headers = grid[hr].map(cleanCell_);
  var lastCol = headers.length; while (lastCol > 0 && !headers[lastCol - 1]) lastCol--;
  headers = headers.slice(0, lastCol);
  var rows = [];
  for (var r2 = hr + 1; r2 < grid.length; r2++) {
    var row = grid[r2].slice(0, lastCol).map(cleanCell_);
    if (row.every(function (c) { return !c; })) continue;
    rows.push(row);
  }
  dept.rawTable = { headers: headers, rows: rows };
  dept.kpiCount = 0;
}

/** ---- read one KPI definition row into a normalized object. */
function readKpi_(row, cols, name) {
  var bands = cols.bands.map(function (b) { var raw = cleanCell_(row[b.c]); return { label: b.label, raw: raw, num: parseBandNum_(raw) }; });
  var nums = bands.map(function (b) { return b.num; }).filter(function (x) { return x != null; });
  var direction = nums.length >= 2 ? (nums[nums.length - 1] > nums[0] ? 1 : (nums[nums.length - 1] < nums[0] ? -1 : 0)) : 0;
  var meets = bands.length >= 3 ? bands[2].num : (nums.length ? nums[Math.floor(nums.length / 2)] : null);
  var def = cell_(row, cols.def);
  var unit = cell_(row, cols.unit) || inferUnit_(name, def, bands);
  var mc = classifyMetric_(unit, bands, name, def, direction);
  return {
    perspective: cell_(row, cols.perspective),
    role: cell_(row, cols.role),
    kra: cell_(row, cols.kra),
    kpi: name,
    definition: def,
    source: cell_(row, cols.source),
    unit: unit,
    weight: parseNum_(cell_(row, cols.weight)),
    bands: bands,
    direction: direction,
    metricType: mc.metricType,
    targetLogic: mc.targetLogic,
    qualitative: nums.length < 2,
    meets: meets
  };
}

/* KPI "rule layer": derive a metric TYPE and TARGET LOGIC from the unit, the
 * band cells and the KPI text, so the front-end can score & visualise each KPI
 * by its own nature instead of forcing every KPI into a percentage bar. */
function classifyMetric_(unit, bands, name, def, direction) {
  var u = norm_(unit);
  var s = norm_((name || '') + ' ' + (def || ''));
  var numeric = bands.filter(function (b) { return b.num != null; }).length;
  if (numeric < 2) return { metricType: 'Qualitative', targetLogic: 'text' };
  var mt = 'Number';
  var bandHas = function (re) { return bands.some(function (b) { return re.test(String(b.raw || '')); }); };
  if (u.indexOf('day') >= 0 || /\b(dso|tat|pdd)\b|days/.test(s) || bandHas(/day/i)) mt = 'Days';
  else if (u.indexOf('cr') >= 0 || u.indexOf('₹') >= 0 || /gmv|revenue|recover|amount|collection value|\bvalue\b/.test(s) || bandHas(/₹|cr\b/i)) mt = 'Amount';
  else if (u.indexOf('percent') >= 0 || u.indexOf('%') >= 0 || bandHas(/%/) || /\brate\b|retention|adherence|coverage|\bdn\b|automation|accuracy/.test(s)) mt = 'Percentage';
  else if (u.indexOf('count') >= 0 || /count|number of|no\.? of|# of|cases|tickets|escalations/.test(s)) mt = 'Count';
  var tl = 'numeric';
  if (bandHas(/\d\s*[–—-]\s*\d/)) tl = 'range';
  else if (bandHas(/[<>≤≥]|less than|greater than|more than|within/i)) tl = 'threshold';
  return { metricType: mt, targetLogic: tl };
}

/** ---- register a leaf KPI record (employee × KPI). */
function pushRecord_(ctx, dept, subTeam, emp, k, sectionTitle) {
  var base = [dept.id, subTeam ? subTeam.id : 'na', slug_(emp.name), slug_(k.kra || ''), slug_(k.kpi || '')].join('.');
  var kpiId = base; var n = 2; while (ctx.seenKpiId[kpiId]) kpiId = base + '.' + (n++);
  ctx.seenKpiId[kpiId] = true;

  var rec = {
    kpiId: kpiId,
    deptId: dept.id, department: dept.name,
    subTeamId: subTeam ? subTeam.id : null, subTeam: subTeam ? subTeam.name : null,
    employeeId: emp.id, employee: emp.name, role: emp.role || k.role || '', region: emp.region || '',
    isTemplate: !!emp.isTemplate,
    perspective: k.perspective || '', kra: k.kra || '', kpi: k.kpi || '', definition: k.definition || '',
    source: k.source || '', unit: k.unit || '', section: sectionTitle || '',
    weight: k.weight, weightShown: null, weightNorm: null,
    bands: k.bands, direction: k.direction, metricType: k.metricType, targetLogic: k.targetLogic,
    qualitative: k.qualitative, meetsValue: k.meets,
    // performance (filled by computeRecord_)
    hasActual: false, target: null, actual: null, rating: null, achievedBand: null,
    attainment: null, weighted: null, status: statusFromRating_(null, ctx.thresholds || DEFAULT_THRESHOLDS),
    // trend (filled by computeTrends_)
    history: [], delta: null,
    comment: '', evidence: '', updatedAt: null
  };
  emp.kpiIds.push(kpiId);
  if (subTeam) { subTeam.kpiCount++; if (emp.subTeamIds.indexOf(subTeam.id) < 0) emp.subTeamIds.push(subTeam.id); }
  dept.kpiCount++;
  ctx.records.push(rec);
}

/** ==================================================== PERFORMANCE / SCORING */
function computeRecord_(r, a, settings) {
  var th = settings.thresholds;
  if (a) {
    r.hasActual = (a.actual != null) || (a.rating != null);
    r.actual = a.actual != null ? a.actual : null;
    r.target = a.target != null ? a.target : (r.meetsValue != null ? r.meetsValue : null);
    r.comment = a.comment || ''; r.evidence = a.evidence || ''; r.updatedAt = a.updatedAt || null;
  } else {
    r.target = r.meetsValue != null ? r.meetsValue : null;
  }

  var rating = null;
  if (r.qualitative) {
    rating = (a && a.rating != null) ? clamp_(a.rating, 1, 5) : null;   // manual only
  } else if (r.actual != null) {
    rating = ratingFromBands_(r.bands, r.actual);
  } else if (a && a.rating != null) {
    rating = clamp_(a.rating, 1, 5);                                     // manual override allowed
  }
  r.rating = rating;
  r.achievedBand = bandLabelForRating_(r.bands, rating);
  r.attainment = attainment_(r, r.actual, r.target);
  r.status = statusFromRating_(rating, th);
  // weightNorm is set in rollUp_ (needs the block sum); weighted computed there.
}

/* Interpolate an actual across the (rating 1..5 ↔ band value) ladder. Works for
 * both higher- and lower-is-better because it brackets on the monotonic values. */
function ratingFromBands_(bands, actual) {
  if (actual == null || isNaN(actual)) return null;
  var pts = [];
  for (var i = 0; i < bands.length; i++) if (bands[i].num != null && !isNaN(bands[i].num)) pts.push({ r: i + 1, v: bands[i].num });
  if (pts.length < 2) return null;
  var asc = pts[pts.length - 1].v >= pts[0].v;
  var first = pts[0], last = pts[pts.length - 1];
  if (asc) { if (actual <= first.v) return first.r; if (actual >= last.v) return last.r; }
  else     { if (actual >= first.v) return first.r; if (actual <= last.v) return last.r; }
  for (var j = 0; j < pts.length - 1; j++) {
    var aP = pts[j], bP = pts[j + 1], lo = Math.min(aP.v, bP.v), hi = Math.max(aP.v, bP.v);
    if (actual >= lo && actual <= hi) {
      if (bP.v === aP.v) return aP.r;
      return round2_(aP.r + (actual - aP.v) / (bP.v - aP.v) * (bP.r - aP.r));
    }
  }
  return null;
}

function attainment_(r, actual, target) {
  if (actual == null || target == null || isNaN(actual) || isNaN(target) || target === 0) return null;
  var ratio = r.direction < 0 ? (target / actual) : (actual / target);   // lower-is-better inverts
  if (!isFinite(ratio) || ratio < 0) return null;
  return round1_(ratio * 100);
}

function bandLabelForRating_(bands, rating) {
  if (rating == null) return null;
  var idx = clamp_(Math.round(rating), 1, bands.length) - 1;
  return bands[idx] ? (bands[idx].label || ('Band ' + (idx + 1))) : null;
}

function statusFromRating_(rating, th) {
  th = th || DEFAULT_THRESHOLDS;
  if (rating == null || isNaN(rating)) return { k: 'none', label: 'Pending' };
  if (rating >= 4.25) return { k: 'good', label: 'Exceeding' };
  if (rating >= th.onTrack) return { k: 'good', label: 'On Track' };
  if (rating >= th.atRisk) return { k: 'warn', label: 'At Risk' };
  return { k: 'bad', label: 'Off Track' };
}

/** ==================================================== ROLL-UPS */
function rollUp_(ctx, settings) {
  var th = settings.thresholds;

  // 1) weight-normalise per (employee × sub-team) block, then compute weighted.
  var blocks = {};   // employeeId|subTeamId -> [records]
  ctx.records.forEach(function (r) {
    var key = r.employeeId + '|' + (r.subTeamId || 'na');
    (blocks[key] = blocks[key] || []).push(r);
  });
  Object.keys(blocks).forEach(function (key) {
    var recs = blocks[key];
    var sum = 0; recs.forEach(function (r) { if (r.weight != null) sum += r.weight; });
    recs.forEach(function (r) {
      r.weightNorm = (sum > 0 && r.weight != null) ? r.weight / sum : (r.weight != null ? null : null);
      r.weightShown = r.weightNorm != null ? round1_(r.weightNorm * 100) : (r.weight != null ? round1_(r.weight) : null);
      r.weighted = (r.weightNorm != null && r.rating != null) ? round3_(r.weightNorm * r.rating) : null;
    });
  });

  // 2) block score per (employee × sub-team).
  var blockScore = {};
  Object.keys(blocks).forEach(function (key) {
    var recs = blocks[key];
    var sw = 0, sr = 0, withData = 0;
    recs.forEach(function (r) { if (r.rating != null && r.weightNorm != null) { sw += r.weightNorm; sr += r.weightNorm * r.rating; withData++; } });
    blockScore[key] = { rating: sw > 0 ? round2_(sr / sw) : null, total: recs.length, withData: withData };
  });

  // 3) employees.
  ctx.employees.forEach(function (e) {
    var subs = e.subTeamIds.length ? e.subTeamIds : ['na'];
    var ratings = [], total = 0, withData = 0, onTrack = 0, atRisk = 0, off = 0;
    subs.forEach(function (sid) {
      var bs = blockScore[e.id + '|' + sid]; if (!bs) return;
      if (bs.rating != null) ratings.push(bs.rating);
      total += bs.total; withData += bs.withData;
    });
    ctx.records.filter(function (r) { return r.employeeId === e.id; }).forEach(function (r) {
      if (r.rating == null) return;
      if (r.status.k === 'good') onTrack++; else if (r.status.k === 'warn') atRisk++; else if (r.status.k === 'bad') off++;
    });
    e.rating = ratings.length ? round2_(avg_(ratings)) : null;
    e.kpiTotal = total; e.kpiWithData = withData;
    e.coverage = total ? round1_(withData / total * 100) : 0;
    e.onTrack = onTrack; e.atRisk = atRisk; e.offTrack = off;
    e.status = statusFromRating_(e.rating, th);
    e.level = levelFromRating_(e.rating);
    e.trend = []; e.delta = null; e.consistency = 0;   // filled by computeTrends_
  });

  // 4) sub-teams.
  ctx.subTeams.forEach(function (s) {
    var rs = [], people = 0, withData = 0;
    ctx.employees.forEach(function (e) {
      var bs = blockScore[e.id + '|' + s.id]; if (!bs) return;
      people++; if (bs.rating != null) { rs.push(bs.rating); withData++; }
    });
    s.rating = rs.length ? round2_(avg_(rs)) : null;
    s.people = people; s.peopleWithData = withData;
    s.status = statusFromRating_(s.rating, th);
  });

  // 5) departments.
  ctx.depts.forEach(function (d) {
    var emps = ctx.employees.filter(function (e) { return e.deptId === d.id; });
    var rs = emps.map(function (e) { return e.rating; }).filter(function (x) { return x != null; });
    d.employeeCount = emps.length;
    d.rating = rs.length ? round2_(avg_(rs)) : null;
    d.peopleWithData = rs.length;
    d.status = statusFromRating_(d.rating, th);
    d.level = levelFromRating_(d.rating);
    d.trend = []; d.delta = null;                      // filled by computeTrends_
    var drecs = ctx.records.filter(function (r) { return r.deptId === d.id; });
    d.recOnTrack = drecs.filter(function (r) { return r.status.k === 'good'; }).length;
    d.recAtRisk = drecs.filter(function (r) { return r.status.k === 'warn'; }).length;
    d.recOffTrack = drecs.filter(function (r) { return r.status.k === 'bad'; }).length;
    d.subTeamIds = ctx.subTeams.filter(function (s) { return s.deptId === d.id; }).map(function (s) { return s.id; });
  });

  // 6) org.
  var allR = ctx.employees.map(function (e) { return e.rating; }).filter(function (x) { return x != null; });
  var recWith = ctx.records.filter(function (r) { return r.hasActual; }).length;
  var orgRating = allR.length ? round2_(avg_(allR)) : null;
  ctx.rollups = {
    org: {
      rating: orgRating,
      status: statusFromRating_(orgRating, th),
      level: levelFromRating_(orgRating),
      departments: ctx.depts.filter(function (d) { return d.kind !== 'info'; }).length,
      people: ctx.employees.length, peopleWithData: allR.length,
      kpis: ctx.records.length, kpisWithData: recWith,
      coverage: ctx.records.length ? round1_(recWith / ctx.records.length * 100) : 0,
      // people-level status counts
      onTrack: ctx.employees.filter(function (e) { return e.status.k === 'good'; }).length,
      atRisk: ctx.employees.filter(function (e) { return e.status.k === 'warn'; }).length,
      offTrack: ctx.employees.filter(function (e) { return e.status.k === 'bad'; }).length,
      // KPI-instance status counts (the "How are we performing" tallies)
      recOnTrack: ctx.records.filter(function (r) { return r.status.k === 'good'; }).length,
      recAtRisk: ctx.records.filter(function (r) { return r.status.k === 'warn'; }).length,
      recOffTrack: ctx.records.filter(function (r) { return r.status.k === 'bad'; }).length,
      // filled by computeTrends_
      trend: [], delta: null, periods: [], movers: []
    }
  };
}

/* Map a 1–5 rating to a performance LEVEL with a label (subtle gamification). */
function levelFromRating_(r) {
  if (r == null || isNaN(r)) return { level: 0, label: 'Unrated' };
  if (r >= 4.5) return { level: 5, label: 'Elite' };
  if (r >= 3.75) return { level: 4, label: 'High performer' };
  if (r >= 3.0) return { level: 3, label: 'Solid · meets' };
  if (r >= 2.0) return { level: 2, label: 'Developing' };
  return { level: 1, label: 'Needs focus' };
}

/** ==================================================== TRENDS (multi-period) */
/* Re-score every record for each known period and roll ratings up over time,
 * so the UI can answer "are we getting better?" and rank biggest movers. Uses
 * the weightNorm computed in rollUp_, so this must run AFTER it. */
function computeTrends_(ctx, all, current, settings) {
  var periods = all.periods.slice();
  if (periods.indexOf(current) < 0) periods.push(current);
  periods = periods.filter(function (p) { return p; }).sort();
  var show = periods.slice(-6);                          // last 6 for display
  if (show.indexOf(current) < 0) show.push(current);

  function recRatingAt(r, p) {
    var a = all.byKey[r.kpiId + '|' + p];
    if (!a && p === current) a = all.byKey[r.kpiId + '|'];
    if (!a) return null;
    if (r.qualitative) return a.rating != null ? clamp_(a.rating, 1, 5) : null;
    if (a.actual != null) return ratingFromBands_(r.bands, a.actual);
    if (a.rating != null) return clamp_(a.rating, 1, 5);
    return null;
  }
  function actualAt(r, p) { var a = all.byKey[r.kpiId + '|' + p] || (p === current ? all.byKey[r.kpiId + '|'] : null); return a && a.actual != null ? a.actual : null; }

  // per-record history + delta (current vs the period immediately before it).
  var prev = null; for (var i = show.length - 1; i >= 0; i--) { if (show[i] === current && i > 0) { prev = show[i - 1]; break; } }
  if (prev == null && show.length >= 2 && show[show.length - 1] === current) prev = show[show.length - 2];
  ctx.records.forEach(function (r) {
    r.history = show.map(function (p) { return { period: p, rating: recRatingAt(r, p), actual: actualAt(r, p) }; });
    var cur = recRatingAt(r, current), pr = prev ? recRatingAt(r, prev) : null;
    r.delta = (cur != null && pr != null) ? round2_(cur - pr) : null;
  });

  // per-period employee rating (weightNorm-weighted, same contract as rollUp_).
  var empPer = {}; ctx.employees.forEach(function (e) { empPer[e.id] = {}; });
  show.forEach(function (p) {
    var agg = {};
    ctx.records.forEach(function (r) {
      var rt = recRatingAt(r, p); if (rt == null || r.weightNorm == null) return;
      var a = agg[r.employeeId] || (agg[r.employeeId] = { sw: 0, sr: 0 });
      a.sw += r.weightNorm; a.sr += r.weightNorm * rt;
    });
    ctx.employees.forEach(function (e) { var a = agg[e.id]; empPer[e.id][p] = (a && a.sw > 0) ? round2_(a.sr / a.sw) : null; });
  });

  var th = settings.thresholds;
  ctx.employees.forEach(function (e) {
    e.trend = show.map(function (p) { return { period: p, rating: empPer[e.id][p] }; });
    var cur = empPer[e.id][current], pr = prev ? empPer[e.id][prev] : null;
    e.delta = (cur != null && pr != null) ? round2_(cur - pr) : null;
    // consistency streak: consecutive periods (ending at current) rated On Track.
    var streak = 0; for (var i = show.length - 1; i >= 0; i--) { var v = empPer[e.id][show[i]]; if (v != null && v >= th.onTrack) streak++; else break; }
    e.consistency = streak;
  });

  // dept + org trends = mean of member ratings per period.
  function meanAt(emps, p) { var xs = emps.map(function (e) { return empPer[e.id][p]; }).filter(function (x) { return x != null; }); return xs.length ? round2_(avg_(xs)) : null; }
  ctx.depts.forEach(function (d) {
    var emps = ctx.employees.filter(function (e) { return e.deptId === d.id; });
    d.trend = show.map(function (p) { return { period: p, rating: meanAt(emps, p) }; });
    var cur = meanAt(emps, current), pr = prev ? meanAt(emps, prev) : null;
    d.delta = (cur != null && pr != null) ? round2_(cur - pr) : null;
  });
  var org = ctx.rollups.org;
  org.periods = show;
  org.trend = show.map(function (p) { return { period: p, rating: meanAt(ctx.employees, p) }; });
  var oc = meanAt(ctx.employees, current), op = prev ? meanAt(ctx.employees, prev) : null;
  org.delta = (oc != null && op != null) ? round2_(oc - op) : null;

  // biggest movers (people with a computable delta), best & worst.
  org.movers = ctx.employees.filter(function (e) { return e.delta != null; })
    .map(function (e) { return { id: e.id, name: e.name, department: e.department, rating: e.rating, delta: e.delta, status: e.status }; })
    .sort(function (a, b) { return b.delta - a.delta; });
  org.previousPeriod = prev;
}

/** ==================================================== PERSPECTIVE ROLL-UP */
/* Preserve BOTH Perspective and KRA — aggregate ratings by Perspective across
 * the whole framework (weightNorm-weighted), with the KRAs that sit under each. */
function perspectiveRollup_(ctx, settings) {
  var th = settings.thresholds;
  var map = {};
  ctx.records.forEach(function (r) {
    var p = r.perspective || r.kra || 'General';
    var m = map[p] || (map[p] = { perspective: p, sw: 0, sr: 0, kpis: 0, withData: 0, people: {}, kras: {} });
    m.kpis++; m.people[r.employeeId] = true;
    if (r.kra) m.kras[r.kra] = true;
    if (r.rating != null && r.weightNorm != null) { m.sw += r.weightNorm; m.sr += r.weightNorm * r.rating; m.withData++; }
  });
  return Object.keys(map).map(function (k) {
    var m = map[k];
    var rating = m.sw > 0 ? round2_(m.sr / m.sw) : null;
    return { perspective: k, rating: rating, kpis: m.kpis, withData: m.withData, people: Object.keys(m.people).length, kras: Object.keys(m.kras), status: statusFromRating_(rating, th) };
  }).sort(function (a, b) { return (b.rating == null ? -1 : b.rating) - (a.rating == null ? -1 : a.rating); });
}

/** ==================================================== MASTER-DATA HEALTH */
/* Admin validation surfaced before an overall score is trusted: weightage that
 * doesn't total 100% per person-block, KPIs without numeric bands, actual rows
 * that map to no KPI, and coverage. */
function computeHealth_(ctx, all) {
  var blocks = {};
  ctx.records.forEach(function (r) {
    var k = r.employeeId + '|' + (r.subTeamId || 'na');
    (blocks[k] = blocks[k] || { recs: [], emp: r.employee, dept: r.department, sub: r.subTeam }).recs.push(r);
  });
  var weightIssues = [];
  Object.keys(blocks).forEach(function (k) {
    var b = blocks[k], sum = 0, has = false;
    b.recs.forEach(function (r) { if (r.weight != null) { sum += r.weight; has = true; } });
    if (has) {
      var norm = sum > 2 ? sum : sum * 100;            // handle fraction-weighted sheets
      if (Math.abs(norm - 100) >= 0.5) weightIssues.push({ employee: b.emp, dept: b.dept, subTeam: b.sub || '', sum: round1_(norm), kpis: b.recs.length });
    }
  });
  var missingBands = ctx.records.filter(function (r) { return r.qualitative; }).length;
  var ids = {}; ctx.records.forEach(function (r) { ids[r.kpiId] = true; });
  var seen = {}, unmapped = 0;
  Object.keys(all.byKey).forEach(function (key) { var id = key.slice(0, key.lastIndexOf('|')); if (id && !ids[id] && !seen[id]) { seen[id] = true; unmapped++; } });
  var withData = ctx.records.filter(function (r) { return r.hasActual; }).length;
  var noWeight = ctx.records.filter(function (r) { return r.weight == null; }).length;
  return {
    weightIssues: weightIssues,
    qualitative: missingBands,
    noWeight: noWeight,
    unmappedActuals: unmapped,
    templateRoster: ctx.employees.filter(function (e) { return e.isTemplate; }).length,
    kpis: ctx.records.length,
    withData: withData,
    coverage: ctx.records.length ? round1_(withData / ctx.records.length * 100) : 0,
    people: ctx.employees.length
  };
}

/** ==================================================== CTX GETTERS */
function getDept_(ctx, name, kind) {
  var id = slug_(name);
  if (!ctx.deptById[id]) {
    var d = { id: id, name: cleanCell_(name), kind: kind, order: ctx.order++, kpiCount: 0, employeeCount: 0, rating: null, status: statusFromRating_(null), subTeamIds: [], rawTable: null, weightNote: null };
    ctx.deptById[id] = d; ctx.depts.push(d);
  }
  return ctx.deptById[id];
}
function getSubTeam_(ctx, dept, name) {
  var id = dept.id + '::' + slug_(name);
  if (!ctx.subById[id]) {
    var s = { id: id, deptId: dept.id, deptName: dept.name, name: cleanCell_(name), kind: norm_(name), kpiCount: 0, rating: null, people: 0, status: statusFromRating_(null) };
    ctx.subById[id] = s; ctx.subTeams.push(s);
  }
  return ctx.subById[id];
}
function getEmployee_(ctx, dept, name, role, region, isTemplate) {
  var id = dept.id + '::' + slug_(name);
  if (!ctx.empById[id]) {
    var e = { id: id, deptId: dept.id, department: dept.name, name: cleanCell_(name), role: cleanCell_(role || ''), region: cleanCell_(region || ''), isTemplate: !!isTemplate, kpiIds: [], subTeamIds: [], rating: null, status: statusFromRating_(null) };
    ctx.empById[id] = e; ctx.employees.push(e);
  } else if (region && !ctx.empById[id].region) ctx.empById[id].region = cleanCell_(region);
  return ctx.empById[id];
}

/** ==================================================== TITLE / SECTION HELPERS */
/* Person owning a header row: col0 of the header itself, else a title row above. */
function personForHeader_(grid, hr) {
  var own = personName_(String(firstCell_(grid[hr]) || ''));
  if (own.name) return own;
  for (var r = hr - 1; r >= 0 && r >= hr - 3; r--) {
    var f = String(firstCell_(grid[r]) || '').trim();
    if (!f) continue;
    if (isKpiHeader_(grid[r])) break;
    var p = personName_(f);
    return p;    // first non-empty title row above decides
  }
  return { name: '', role: '' };
}
function personName_(text) {
  var t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return { name: '', role: '' };
  var m = t.match(/^individual\s*[-–:]\s*(.+)$/i);
  if (m) return { name: cleanName_(m[1]), role: '' };
  m = t.match(/^(?:collections?|onboarding|supply|demand)[^-–:]*[-–:]\s*(.+)$/i);
  if (m && looksLikeName_(m[1])) return { name: cleanName_(m[1]), role: '' };
  m = t.match(/^(.+?)\s*\(([^)]*)\)\s*$/);
  if (m && /poc|head|lead|manager|executive|senior|regional|analyst|associate|officer|specialist/i.test(m[2])) return { name: cleanName_(m[1]), role: m[2].trim() };
  if (looksLikeName_(t)) return { name: cleanName_(t), role: '' };
  return { name: '', role: '' };
}
function looksLikeName_(s) {
  s = String(s || '').trim();
  if (!/^[A-Za-z][A-Za-z.\s]{1,40}$/.test(s)) return false;
  if (s.split(/\s+/).length > 5) return false;
  return !/(kra|kpi|sales|development|perspective|weightage|target|demand|supply|goal|business|scorecard|process|customer|onboarding of)/i.test(s);
}
function sectionTitleAbove_(grid, hr) {
  for (var r = hr - 1; r >= 0 && r >= hr - 3; r--) {
    var f = String(firstCell_(grid[r]) || '').trim();
    if (!f) continue;
    if (isKpiHeader_(grid[r])) break;
    return cleanCell_(f);
  }
  return '';
}
function classifySection_(title, nSections) {
  var t = norm_(title);
  if (/demand|buyer/.test(t)) return 'Demand';
  if (/supply|seller|sales|business development/.test(t)) return 'Supply';
  if (nSections <= 1) return '';                 // single section → no sub-team
  return title ? cleanCell_(title) : 'Section';
}
/* Split a tab name like "Metal - Supply" / "Plastic (Demand)" into a base
 * department + sub-team, so Demand/Supply that live in SEPARATE tabs still roll
 * up under one department. A plain "Metal" (both sections inside) → sub = null. */
function splitDeptSub_(name) {
  var m = String(name || '').match(/^(.*?)[\s\-–—:(]+\s*(supply|demand|seller|buyer)\b.*$/i);
  if (m) {
    var base = m[1].replace(/[\-–—:(]+$/, '').trim();
    var tok = m[2].toLowerCase();
    if (base) return { dept: base, sub: (tok === 'supply' || tok === 'seller') ? 'Supply' : 'Demand' };
  }
  return { dept: cleanCell_(name), sub: null };
}
function matchRoster_(rosterByTeam, deptName) {
  var k = norm_(deptName);
  if (rosterByTeam[k]) return rosterByTeam[k];
  var keys = Object.keys(rosterByTeam);
  for (var i = 0; i < keys.length; i++) if (keys[i] && (k.indexOf(keys[i]) >= 0 || keys[i].indexOf(k) >= 0)) return rosterByTeam[keys[i]];
  return [];
}
function weightNote_(kpis) {
  var sum = 0, has = false; kpis.forEach(function (k) { if (k.weight != null) { sum += k.weight; has = true; } });
  if (!has) return null;
  var ok = Math.abs(sum - 100) < 0.5 || Math.abs(sum - 1) < 0.01;
  return { sum: round2_(sum), ok: ok };
}
function inferUnit_(name, def, bands) {
  var s = norm_(name + ' ' + def);
  if (/dso|tat|days/.test(s)) return 'Days';
  if (/gmv|₹|cr|revenue|pdd|recover/.test(s) || bands.some(function (b) { return /₹|cr/i.test(b.raw); })) return '₹ Cr';
  if (/%|percent|rate|retention|dn |coverage|adherence/.test(s) || bands.some(function (b) { return /%/.test(b.raw); })) return 'Percentage';
  return '';
}

/** ==================================================== ACTUALS (SEPARATE SOURCE) */
function ACTUALS_HEADERS_() {
  return ['KpiId', 'Period', 'Department', 'SubTeam', 'Employee', 'KRA', 'KPI', 'Unit', 'Weight%', 'Target', 'Actual', 'Rating', 'Comment', 'Evidence', 'UpdatedAt', 'UpdatedBy'];
}
function ensureActualsSheet_() {
  var ss = SpreadsheetApp.openById(SOURCE_SPREADSHEET_ID);
  var sh = ss.getSheetByName(ACTUALS_TAB);
  if (!sh) { sh = ss.insertSheet(ACTUALS_TAB); sh.getRange(1, 1, 1, ACTUALS_HEADERS_().length).setValues([ACTUALS_HEADERS_()]).setFontWeight('bold'); sh.setFrozenRows(1); }
  else if (sh.getLastRow() === 0) sh.getRange(1, 1, 1, ACTUALS_HEADERS_().length).setValues([ACTUALS_HEADERS_()]).setFontWeight('bold');
  return sh;
}
function newActualRow_(p, period) {
  var h = ACTUALS_HEADERS_(), row = h.map(function () { return ''; });
  row[h.indexOf('KpiId')] = p.kpiId; row[h.indexOf('Period')] = period;
  return row;
}
/* Read ALL actual rows (every period) from the managed tab, or an external
 * sheet if configured. Returns { byKey: {"kpiId|period": rec}, periods: [...] }.
 * A period-less row is stored under "kpiId|" as a fallback for the current view. */
function readAllActuals_(settings) {
  settings = settings || readSettings_();
  var out = { byKey: {}, periods: [], rows: 0 };
  var sh = null;
  try {
    if (settings.actualsSheetId) {
      var ext = SpreadsheetApp.openById(settings.actualsSheetId);
      sh = ext.getSheetByName(settings.actualsTab || ACTUALS_TAB) || ext.getSheets()[0];
    } else {
      sh = SpreadsheetApp.openById(SOURCE_SPREADSHEET_ID).getSheetByName(ACTUALS_TAB);
    }
  } catch (e) { sh = null; }
  if (!sh) return out;
  var data = safeValues_(sh);
  if (!data.length) return out;
  var head = data[0], col = {}; head.forEach(function (h, i) { col[norm_(h)] = i; });
  var ci = { id: col['kpiid'], per: col['period'], tgt: col['target'], act: col['actual'], rat: col['rating'], com: col['comment'], ev: col['evidence'], up: col['updatedat'] };
  if (ci.id == null) return out;
  var pset = {};
  for (var i = 1; i < data.length; i++) {
    var row = data[i], id = String(row[ci.id] || '').trim();
    if (!id) continue;
    var per = ci.per != null ? String(row[ci.per] || '').trim() : '';
    var rec = {
      actual: ci.act != null ? parseNum_(row[ci.act]) : null,
      target: ci.tgt != null ? parseNum_(row[ci.tgt]) : null,
      rating: ci.rat != null ? parseNum_(row[ci.rat]) : null,
      comment: ci.com != null ? String(row[ci.com] || '') : '',
      evidence: ci.ev != null ? String(row[ci.ev] || '') : '',
      updatedAt: ci.up != null && row[ci.up] ? String(row[ci.up]) : null
    };
    out.byKey[id + '|' + per] = rec;
    out.rows++;
    if (per) pset[per] = true;
  }
  out.periods = Object.keys(pset).sort();
  return out;
}
function actualsSourceInfo_(settings, all) {
  return {
    type: settings.actualsSheetId ? 'external' : 'managed',
    tab: settings.actualsSheetId ? (settings.actualsTab || ACTUALS_TAB) : ACTUALS_TAB,
    sheetId: settings.actualsSheetId || SOURCE_SPREADSHEET_ID,
    rows: all ? all.rows : 0
  };
}
function knownPeriods_(all, current) {
  var set = {}; set[current] = true;
  (all && all.periods || []).forEach(function (p) { if (p) set[p] = true; });
  return Object.keys(set).sort().reverse();
}

/** ==================================================== SETTINGS */
function readSettings_() {
  var s = { period: '', thresholds: { onTrack: DEFAULT_THRESHOLDS.onTrack, atRisk: DEFAULT_THRESHOLDS.atRisk }, actualsSheetId: '', actualsTab: '', planSheetId: '' };
  try {
    var raw = PropertiesService.getDocumentProperties().getProperty('KKT_SETTINGS') ||
              PropertiesService.getScriptProperties().getProperty('KKT_SETTINGS');
    if (raw) { var o = JSON.parse(raw); if (o) { s.period = o.period || ''; if (o.thresholds) s.thresholds = o.thresholds; s.actualsSheetId = o.actualsSheetId || ''; s.actualsTab = o.actualsTab || ''; s.planSheetId = o.planSheetId || ''; } }
  } catch (e) {}
  if (!s.period) s.period = currentPeriod_();
  return s;
}
function writeSettings_(s) {
  try { PropertiesService.getScriptProperties().setProperty('KKT_SETTINGS', JSON.stringify(s)); } catch (e) {}
}

/** ==================================================== SMALL HELPERS */
function isManaged_(name) { return /^kkt[_ ]/i.test(name) || /^_kkt/i.test(name); }
function hasContent_(grid) { for (var r = 0; r < grid.length; r++) for (var c = 0; c < grid[r].length; c++) if (String(grid[r][c] == null ? '' : grid[r][c]).trim() !== '') return true; return false; }
function safeValues_(sh) { try { var lr = sh.getLastRow(), lc = sh.getLastColumn(); if (!lr || !lc) return []; return sh.getRange(1, 1, lr, lc).getValues(); } catch (e) { return []; } }
function cell_(row, i) { return (i != null && i >= 0 && i < row.length) ? cleanCell_(row[i]) : ''; }
function firstCell_(row) { return row && row.length ? row[0] : ''; }
function cleanCell_(v) { return String(v == null ? '' : v).replace(/\s+/g, ' ').trim(); }
function cleanName_(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }
function parseNum_(raw) { if (raw == null || String(raw).trim() === '') return null; if (typeof raw === 'number') return raw; var m = String(raw).replace(/,/g, '').match(/-?\d+(?:\.\d+)?/); return m ? Number(m[0]) : null; }
/* Parse a band cell → a representative number (ranges averaged; else first number). */
function parseBandNum_(raw) {
  if (raw == null) return null;
  var s = String(raw).trim();
  if (s === '' || s === '-' || s === '—' || s === 'na' || /^n\/?a$/i.test(s)) return null;
  // Band labels are non-negative; a '-' is a separator/qualifier, never a sign
  // (e.g. "TGT-20" must read 20, not -20), so match digits without a leading '-'.
  var s2 = s.replace(/[₹$,]/g, '').replace(/%/g, ' ');
  var range = s2.match(/(\d+(?:\.\d+)?)\s*[–—-]\s*(\d+(?:\.\d+)?)/);
  if (range) return (Number(range[1]) + Number(range[2])) / 2;
  var m = s2.match(/\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : null;
}
function num_(v) { var n = parseNum_(v); return n == null ? 0 : n; }
function clamp_(x, a, b) { return Math.max(a, Math.min(b, x)); }
function avg_(a) { return a.length ? a.reduce(function (s, x) { return s + x; }, 0) / a.length : null; }
function slug_(s) { return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 90) || 'x'; }
function norm_(v) { return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().toLowerCase(); }
function round1_(x) { return x == null || isNaN(x) ? null : Math.round(x * 10) / 10; }
function round2_(x) { return x == null || isNaN(x) ? null : Math.round(x * 100) / 100; }
function round3_(x) { return x == null || isNaN(x) ? null : Math.round(x * 1000) / 1000; }
function nowIso_() { return new Date().toISOString(); }
function currentPeriod_() { try { return Utilities.formatDate(new Date(), Session.getScriptTimeZone() || 'Asia/Kolkata', 'yyyy-MM'); } catch (e) { return ('' + new Date().getFullYear()) + '-' + ('0' + (new Date().getMonth() + 1)).slice(-2); } }
function fileUpdated_() { try { return DriveApp.getFileById(SOURCE_SPREADSHEET_ID).getLastUpdated().toISOString(); } catch (e) { return nowIso_(); } }
function safeEmail_() { var e = ''; try { e = Session.getActiveUser().getEmail() || ''; } catch (x) {} if (!e) { try { e = Session.getEffectiveUser().getEmail() || ''; } catch (y) {} } return e; }
function bustCache_() { try { var c = CacheService.getScriptCache(); var s = readSettings_(); c.remove(CACHE_PREFIX + (s.period || currentPeriod_())); } catch (e) {} }
function errModel_(err) { return { ok: false, connected: false, empty: true, error: String(err && err.message || err), generatedAt: nowIso_() }; }

/*==============================================================================
 * PLAN LAYER — GMV targets · onboarding plan · buyer-supplier mapping
 * =============================================================================
 * A second, independent family of tab shapes found in the marketplace planning
 * workbook. Same rules as the KRA/KPI engine: nothing hard-coded, aggregates are
 * always recomputed from the ATOMIC rows (never read from TEAM GRAND TOTAL /
 * SUMMARY / TOTAL rows), blanks and "-" stay missing rather than becoming zero,
 * and any disagreement between the sheet's own stated totals and the recomputed
 * ones is surfaced as a reconciliation finding instead of being silently hidden.
 *
 *   • GMV          — Team | Buyer | Region | Category | Qty | GMV target [| GMV
 *                    achievement]. Achievement present ⇒ the period is scored as
 *                    PERFORMANCE (target→achievement→variance); absent ⇒ PLAN
 *                    (target→allocation→coverage), so a plan month never shows a
 *                    fabricated achievement %.
 *   • ONBOARDING   — region-wise supplier/buyer targets, the named supplier and
 *                    buyer pipelines, plus an unlabelled buyer REQUISITION
 *                    tracker (Region | Buyer | Requisition | POC | Remarks).
 *   • MAPPING      — buyer intelligence: owner, supplier network (Supplier 1..N),
 *                    category, est. volume/GMV, status, NBFC pitch, payment
 *                    terms, monthly capacity. Inverted to a supplier view too.
 *============================================================================*/

var PLAN_KINDS_ = { gmv: 1, onboarding: 1, mapping: 1 };
var MONTHS_ = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
var MONTH_NAMES_ = ['', 'January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
/* Rows that are aggregates, not data. */
var TOTAL_ROW_RE_ = /^(team\s*grand\s*total|grand\s*total|team\s*total|sub\s*total|total|summary)\b/i;
/* Placeholder buyer/supplier names that stand for "someone new, not yet named". */
var PLACEHOLDER_RE_ = /^(new\s+buyer|new\s+supplier|new|tbd|to\s*be\s*decided|na)$/i;

/** ---------------------------------------------------- tab classification */
function classifyPlanTab_(grid, name) {
  for (var r = 0; r < Math.min(grid.length, 25); r++) {
    var n = grid[r].map(norm_);
    var has = function (t) { return n.some(function (c) { return c.indexOf(t) >= 0; }); };
    var hasBuyerName = has('buyer name');
    if (hasBuyerName && has('supplier 1')) return { kind: 'mapping', header: r };
    if (hasBuyerName && (has('gmv target') || has('qty target') || has('quantity target'))) return { kind: 'gmv', header: r };
    if (has('new suppliers') && has('new buyers')) return { kind: 'onboarding', header: r };
  }
  if (/onboarding\s*plan/i.test(name || '')) return { kind: 'onboarding', header: -1 };
  if (/gmv\s*(target|plan)/i.test(name || '')) return { kind: 'gmv', header: -1 };
  if (/(buyer|supplier)[\s\-–—]*(supplier|buyer)\s*mapping/i.test(name || '')) return { kind: 'mapping', header: -1 };
  return null;
}

/** Period for a plan tab: from its name ("July26 …"), else from a title row. */
function periodFromText_(text) {
  var m = String(text || '').match(/([A-Za-z]{3,9})\s*'?\s*(\d{2,4})\b/);
  if (!m) return null;
  var mo = MONTHS_[m[1].slice(0, 3).toLowerCase()];
  if (!mo) return null;
  var y = Number(m[2]); if (y < 100) y = 2000 + y;
  if (y < 2000 || y > 2100) return null;
  return { key: y + '-' + ('0' + mo).slice(-2), label: MONTH_NAMES_[mo] + ' ' + y };
}
function periodForTab_(grid, name) {
  var p = periodFromText_(name);
  if (p) return p;
  for (var r = 0; r < Math.min(grid.length, 5); r++) {
    for (var c = 0; c < grid[r].length; c++) {
      var t = cleanCell_(grid[r][c]);
      if (!t) continue;
      p = periodFromText_(t);
      if (p) return p;
    }
  }
  return null;
}

/** Map a header row's columns by keyword, first match wins. */
function planCols_(header, spec) {
  var n = header.map(norm_), out = {};
  Object.keys(spec).forEach(function (key) {
    out[key] = -1;
    var words = spec[key];
    for (var w = 0; w < words.length && out[key] < 0; w++)
      for (var c = 0; c < n.length; c++)
        if (n[c] && n[c].indexOf(words[w]) >= 0) { out[key] = c; break; }
  });
  return out;
}
function isTotalRow_(row) {
  for (var c = 0; c < Math.min(row.length, 3); c++) { var t = cleanCell_(row[c]); if (t && TOTAL_ROW_RE_.test(t)) return true; }
  return false;
}
function blankRow_(row) { return row.every(function (c) { return cleanCell_(c) === ''; }); }
/* "-" / "" / "na" all mean MISSING, never zero. */
function planVal_(raw) { var s = cleanCell_(raw); if (!s || s === '-' || s === '—' || /^n\/?a$/i.test(s)) return null; return s; }
function planNum_(raw) { var s = planVal_(raw); return s == null ? null : parseNum_(s); }

/** ---------------------------------------------------------- GMV parser */
function parseGmvTab_(grid, name, cls, period, acc) {
  var hr = cls.header;
  if (hr < 0) return;
  var cols = planCols_(grid[hr], {
    team: ['team'], buyer: ['buyer name', 'buyer'], region: ['region'],
    category: ['category', 'product'], qty: ['qty', 'quantity'],
    target: ['gmv target', 'target'], actual: ['achievement', 'actual', 'achieved']
  });
  // The achievement column must be a *distinct* column from target.
  if (cols.actual === cols.target) cols.actual = -1;
  var end = grid.length;
  for (var r = hr + 1; r < grid.length; r++) {
    var row = grid[r];
    if (isTotalRow_(row)) { end = r; break; }
    if (blankRow_(row)) { var nx = grid[r + 1]; if (!nx || blankRow_(nx)) { end = r; break; } }
  }
  for (var i = hr + 1; i < end; i++) {
    var row = grid[i];
    if (blankRow_(row)) continue;
    var buyer = planVal_(row[cols.buyer]);
    var team = planVal_(row[cols.team]);
    if (!buyer && !team) continue;
    var qty = planNum_(row[cols.qty]);
    var tgt = planNum_(row[cols.target]);
    var act = cols.actual >= 0 ? planNum_(row[cols.actual]) : null;
    if (!buyer && qty == null && tgt == null) continue;
    acc.gmv.push({
      period: period.key, team: team || '', buyer: buyer || '',
      placeholder: !!(buyer && PLACEHOLDER_RE_.test(buyer)),
      bundled: !!(buyer && buyer.indexOf('/') >= 0),
      region: planVal_(row[cols.region]) || '', category: planVal_(row[cols.category]) || '',
      qty: qty, target: tgt, actual: act, tab: name
    });
  }
  // stated aggregates, kept only for reconciliation
  var stated = { total: null, summary: [], onboarding: {} };
  for (var r2 = end; r2 < grid.length; r2++) {
    var row2 = grid[r2];
    if (isTotalRow_(row2) && stated.total == null) {
      var q = null, t = null, a = null;
      if (cols.qty >= 0) q = planNum_(row2[cols.qty]);
      if (cols.target >= 0) t = planNum_(row2[cols.target]);
      if (cols.actual >= 0) a = planNum_(row2[cols.actual]);
      if (q != null || t != null) stated.total = { qty: q, target: t, actual: a };
    }
  }
  parseStatedSummary_(grid, end, stated);
  parseTargetVsAchievement_(grid, end, stated);
  acc.stated[period.key] = acc.stated[period.key] || {};
  acc.stated[period.key].gmv = stated;
}

/* A "SUMMARY" sub-table (Team Member | # Buyers | # Suppliers | Qty | GMV). */
function parseStatedSummary_(grid, from, stated) {
  for (var r = from; r < grid.length; r++) {
    var n = grid[r].map(norm_);
    var hasTeam = n.some(function (c) { return c.indexOf('team member') >= 0; });
    var hasNum = n.some(function (c) { return c.indexOf('# buyers') >= 0 || c.indexOf('buyers') >= 0 || c.indexOf('qty') >= 0; });
    if (!hasTeam || !hasNum) continue;
    var cols = planCols_(grid[r], { team: ['team member'], buyers: ['# buyers', 'buyers'], suppliers: ['# suppliers', 'suppliers'], qty: ['qty', 'quantity'], gmv: ['gmv'] });
    var unitNote = null;
    if (cols.gmv >= 0) { var h = norm_(grid[r][cols.gmv]); if (h.indexOf('₹ l') >= 0 || h.indexOf('(l)') >= 0 || /\bl\b/.test(h.replace(/[()]/g, ' '))) unitNote = cleanCell_(grid[r][cols.gmv]); }
    stated.summaryUnitLabel = unitNote;
    for (var i = r + 1; i < grid.length; i++) {
      var row = grid[i];
      if (blankRow_(row)) break;
      var t = planVal_(row[cols.team]);
      if (!t) break;
      if (TOTAL_ROW_RE_.test(t)) break;
      stated.summary.push({ team: t, buyers: planNum_(row[cols.buyers]), suppliers: planNum_(row[cols.suppliers]), qty: planNum_(row[cols.qty]), gmv: planNum_(row[cols.gmv]) });
    }
    return;
  }
}

/* A free-form "Target vs Achievement" block: a carried-forward label plus rows
 * tagged Target / Achievement (labels may be merged across two rows). */
function parseTargetVsAchievement_(grid, from, stated) {
  var label = '';
  for (var r = from; r < grid.length; r++) {
    var row = grid[r];
    if (blankRow_(row)) continue;
    var texts = row.map(cleanCell_).filter(function (t) { return t !== ''; });
    if (!texts.length) continue;
    var isT = texts.some(function (t) { return /^target$/i.test(t); });
    var isA = texts.some(function (t) { return /^achievement|^achieved|^actual/i.test(t); });
    var lead = texts.find(function (t) { return !/^target$|^achievement|^achieved|^actual/i.test(t) && !/^-?[\d.,]+\s*(cr|mt|l)?$/i.test(t); });
    if (lead && !TOTAL_ROW_RE_.test(lead)) label = lead;
    if (!isT && !isA) continue;
    var val = null;
    for (var c = row.length - 1; c >= 0; c--) { var v = planNum_(row[c]); if (v != null) { val = v; break; } }
    if (val == null || !label) continue;
    var key = slug_(label);
    var e = stated.onboarding[key] || (stated.onboarding[key] = { label: label, target: null, actual: null });
    if (isT) e.target = val; else e.actual = val;
  }
}

/** -------------------------------------------------- ONBOARDING parser */
function parseOnboardingTab_(grid, name, cls, period, acc) {
  var hr = -1;
  for (var r = 0; r < grid.length && hr < 0; r++) {
    var n = grid[r].map(norm_);
    if (n.some(function (c) { return c.indexOf('new suppliers') >= 0; }) && n.some(function (c) { return c.indexOf('new buyers') >= 0; })) hr = r;
  }
  if (hr >= 0) {
    var cols = planCols_(grid[hr], { team: ['team member', 'team'], region: ['region'], suppliers: ['new suppliers'], buyers: ['new buyers'], total: ['total onboard', 'total'], notes: ['notes', 'focus'] });
    for (var i = hr + 1; i < grid.length; i++) {
      var row = grid[i];
      if (blankRow_(row)) break;
      if (isTotalRow_(row)) break;
      var t = planVal_(row[cols.team]);
      if (!t) break;
      acc.onboarding.push({
        period: period.key, team: t, region: planVal_(row[cols.region]) || '',
        suppliers: planNum_(row[cols.suppliers]), buyers: planNum_(row[cols.buyers]),
        notes: planVal_(row[cols.notes]) || '', tab: name
      });
    }
  }
  // Named pipelines: "Supplier 1..N" and "Buyer 1..N" blocks.
  acc.pipeline = acc.pipeline.concat(parseNameBlock_(grid, 'supplier', period, name));
  acc.pipeline = acc.pipeline.concat(parseNameBlock_(grid, 'buyer', period, name));
  // Unlabelled buyer requisition / status tracker.
  parseRequisitionBlock_(grid, period, name, acc);
}

/* Rows of "Team | Region | <Thing> 1 | <Thing> 2 | …" → one record per name. */
function parseNameBlock_(grid, thing, period, tab) {
  var out = [];
  for (var r = 0; r < grid.length; r++) {
    var n = grid[r].map(norm_);
    if (!n.some(function (c) { return c === thing + ' 1'; })) continue;
    var nameCols = [];
    for (var c = 0; c < n.length; c++) if (new RegExp('^' + thing + '\\s*\\d+$').test(n[c])) nameCols.push(c);
    if (!nameCols.length) continue;
    var cols = planCols_(grid[r], { team: ['team member', 'team'], region: ['region'] });
    for (var i = r + 1; i < grid.length; i++) {
      var row = grid[i];
      if (blankRow_(row)) break;
      var t = planVal_(row[cols.team]);
      if (!t || TOTAL_ROW_RE_.test(t)) break;
      var names = [];
      nameCols.forEach(function (cc) { var v = planVal_(row[cc]); if (v) names.push(v); });
      // A single cell may hold several names crammed together.
      out.push({ period: period.key, team: t, region: planVal_(row[cols.region]) || '', type: thing, names: names, tab: tab });
    }
    break;
  }
  return out;
}

/* The requisition tracker: Region | Buyer | Requisition | POC | Remarks. */
function parseRequisitionBlock_(grid, period, tab, acc) {
  for (var r = 0; r < grid.length; r++) {
    var n = grid[r].map(norm_);
    if (!n.some(function (c) { return c.indexOf('requisition') >= 0; })) continue;
    var cols = planCols_(grid[r], { region: ['region'], buyer: ['buyer'], req: ['requisition'], poc: ['poc', 'owner'], remarks: ['remark', 'status'] });
    if (cols.buyer < 0) continue;
    for (var i = r + 1; i < grid.length; i++) {
      var row = grid[i];
      if (blankRow_(row)) continue;
      var b = planVal_(row[cols.buyer]);
      if (!b || TOTAL_ROW_RE_.test(b)) continue;
      acc.requisitions.push({
        period: period.key, region: planVal_(row[cols.region]) || '', buyer: b,
        requisition: planVal_(row[cols.req]) || '', poc: planVal_(row[cols.poc]) || '',
        remarks: planVal_(row[cols.remarks]) || '', tab: tab
      });
    }
    return;
  }
}

/** ------------------------------------------------------ MAPPING parser */
function parseMappingTab_(grid, name, cls, period, acc) {
  var hr = cls.header;
  if (hr < 0) return;
  var header = grid[hr], n = header.map(norm_);
  var supCols = [];
  for (var c = 0; c < n.length; c++) if (/^supplier\s*\d+$/.test(n[c])) supCols.push(c);
  var cols = planCols_(header, {
    buyer: ['buyer name', 'buyer'], team: ['team'], category: ['category', 'product'],
    volume: ['volume'], gmv: ['gmv'], status: ['status'], nbfc: ['nbfc'],
    terms: ['payment'], capacity: ['capacity']
  });
  var volLabel = cols.volume >= 0 ? cleanCell_(header[cols.volume]) : '';
  for (var i = hr + 1; i < grid.length; i++) {
    var row = grid[i];
    if (blankRow_(row)) continue;
    var buyer = planVal_(row[cols.buyer]);
    if (!buyer || TOTAL_ROW_RE_.test(buyer)) continue;
    var sups = [];
    supCols.forEach(function (cc) { var v = planVal_(row[cc]); if (v) sups.push(v); });
    acc.mapping.push({
      period: period ? period.key : null, buyer: buyer, team: planVal_(row[cols.team]) || '',
      suppliers: sups, category: planVal_(row[cols.category]) || '',
      volume: planNum_(row[cols.volume]), estGmv: planNum_(row[cols.gmv]),
      status: planVal_(row[cols.status]) || '', nbfc: planVal_(row[cols.nbfc]) || '',
      terms: planVal_(row[cols.terms]) || '', capacity: planNum_(row[cols.capacity]), tab: name
    });
  }
  acc.mappingMeta = { volumeLabel: volLabel, supplierSlots: supCols.length, tab: name, period: period ? period.key : null };
}

/** ============================================ BUILD THE PLAN MODEL */
function buildPlan_(planTabs, planSource) {
  var acc = { gmv: [], onboarding: [], pipeline: [], requisitions: [], mapping: [], stated: {}, mappingMeta: null, tabs: [] };
  if (!planTabs.length) return { hasData: false, periods: [], byPeriod: {}, buyers: [], suppliers: [], findings: [], tabs: [], source: planSource };

  planTabs.forEach(function (t) {
    var period = periodForTab_(t.grid, t.name) || { key: 'unscoped', label: 'Unscoped' };
    acc.tabs.push({ name: t.name, kind: t.cls.kind, period: period.key, periodLabel: period.label, source: t.source });
    if (t.cls.kind === 'gmv') parseGmvTab_(t.grid, t.name, t.cls, period, acc);
    else if (t.cls.kind === 'onboarding') parseOnboardingTab_(t.grid, t.name, t.cls, period, acc);
    else if (t.cls.kind === 'mapping') parseMappingTab_(t.grid, t.name, t.cls, period, acc);
  });

  // ---- canonical team identity (ABHISEK / Abhisek / Abhishek → one person).
  var roster = buildRoster_(acc);
  var canon = function (raw) { return canonTeam_(roster, raw); };
  acc.gmv.forEach(function (g) { g.teamId = canon(g.team).id; g.teamName = canon(g.team).name; });
  acc.onboarding.forEach(function (o) { o.teamId = canon(o.team).id; o.teamName = canon(o.team).name; });
  acc.pipeline.forEach(function (p) { p.teamId = canon(p.team).id; p.teamName = canon(p.team).name; });
  acc.requisitions.forEach(function (q) { q.teamId = canon(q.poc).id; q.teamName = canon(q.poc).name; });
  acc.mapping.forEach(function (m) { m.teamId = canon(m.team).id; m.teamName = canon(m.team).name; });

  // ---- per-period aggregation, recomputed from atomic rows only.
  var pset = {};
  acc.gmv.forEach(function (g) { pset[g.period] = 1; });
  acc.onboarding.forEach(function (o) { pset[o.period] = 1; });
  acc.requisitions.forEach(function (q) { pset[q.period] = 1; });
  var periods = Object.keys(pset).filter(function (p) { return p !== 'unscoped'; }).sort();

  var byPeriod = {};
  periods.forEach(function (pk) { byPeriod[pk] = aggregatePeriod_(pk, acc, roster); });

  // ---- buyer + supplier intelligence from the mapping layer.
  var buyers = buildBuyerIntel_(acc, roster);
  var suppliers = buildSupplierNetwork_(acc);

  // ---- reconciliation + data-quality findings.
  var findings = planFindings_(acc, byPeriod, periods, roster, buyers);

  return {
    hasData: true,
    periods: periods.map(function (pk) { return { key: pk, label: periodLabel_(pk), mode: byPeriod[pk].mode }; }),
    byPeriod: byPeriod, team: roster.list, buyers: buyers, suppliers: suppliers,
    mappingMeta: acc.mappingMeta, findings: findings, tabs: acc.tabs, source: planSource,
    counts: { gmvRows: acc.gmv.length, onboardingRows: acc.onboarding.length, mappingRows: acc.mapping.length, requisitionRows: acc.requisitions.length }
  };
}
function periodLabel_(pk) {
  var m = /^(\d{4})-(\d{2})$/.exec(pk);
  return m ? (MONTH_NAMES_[Number(m[2])] + ' ' + m[1]) : pk;
}

/* Roster: canonical team members, seeded from the GMV/onboarding tabs (which use
 * consistent upper-case names) then fuzzy-matched for mapping/tracker variants. */
function buildRoster_(acc) {
  var byId = {}, list = [];
  function add(raw) {
    var s = cleanCell_(raw); if (!s) return;
    var id = slug_(s);
    if (!byId[id]) { var o = { id: id, name: titleCase_(s), variants: {} }; byId[id] = o; list.push(o); }
    byId[id].variants[s] = 1;
  }
  acc.gmv.forEach(function (g) { add(g.team); });
  acc.onboarding.forEach(function (o) { add(o.team); });
  return { byId: byId, list: list };
}
function canonTeam_(roster, raw) {
  var s = cleanCell_(raw);
  if (!s) return { id: '', name: '' };
  var id = slug_(s);
  if (roster.byId[id]) { roster.byId[id].variants[s] = 1; return roster.byId[id]; }
  // fuzzy: nearest roster name within edit distance 2 (Abhisek ↔ Abhishek)
  var best = null, bestD = 99;
  roster.list.forEach(function (m) {
    var d = editDist_(id, m.id);
    if (d < bestD) { bestD = d; best = m; }
  });
  if (best && bestD <= 2) { best.variants[s] = 1; best.fuzzy = true; return best; }
  var o = { id: id, name: titleCase_(s), variants: {} }; o.variants[s] = 1;
  roster.byId[id] = o; roster.list.push(o);
  return o;
}
function editDist_(a, b) {
  a = String(a); b = String(b);
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > 3) return 99;
  var prev = [], cur = [];
  for (var j = 0; j <= b.length; j++) prev[j] = j;
  for (var i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (var j2 = 1; j2 <= b.length; j2++) {
      cur[j2] = Math.min(prev[j2] + 1, cur[j2 - 1] + 1, prev[j2 - 1] + (a.charAt(i - 1) === b.charAt(j2 - 1) ? 0 : 1));
    }
    prev = cur.slice();
  }
  return prev[b.length];
}
function titleCase_(s) {
  return String(s || '').toLowerCase().replace(/\b([a-z])/g, function (m, c) { return c.toUpperCase(); }).replace(/\s+/g, ' ').trim();
}

/** Aggregate one period from atomic rows: team / region / category rollups. */
function aggregatePeriod_(pk, acc, roster) {
  var rows = acc.gmv.filter(function (g) { return g.period === pk; });
  var onb = acc.onboarding.filter(function (o) { return o.period === pk; });
  var reqs = acc.requisitions.filter(function (q) { return q.period === pk; });
  var pipe = acc.pipeline.filter(function (p) { return p.period === pk; });

  var hasActual = rows.some(function (r) { return r.actual != null; });
  var stated = (acc.stated[pk] && acc.stated[pk].gmv) || null;
  var statedOnb = stated ? stated.onboarding : {};
  var statedHasActual = Object.keys(statedOnb).some(function (k) { return statedOnb[k].actual != null; });

  function sum(list, f) { var s = null; list.forEach(function (x) { var v = f(x); if (v != null) s = (s == null ? 0 : s) + v; }); return s; }
  function group(list, keyFn) {
    var m = {}, order = [];
    list.forEach(function (x) {
      var k = keyFn(x); if (k === '' || k == null) k = '—';
      if (!m[k]) { m[k] = { key: k, rows: [] }; order.push(k); }
      m[k].rows.push(x);
    });
    return order.map(function (k) {
      var g = m[k];
      return {
        key: k, rows: g.rows.length,
        qty: round2_(sum(g.rows, function (x) { return x.qty; })),
        target: round2_(sum(g.rows, function (x) { return x.target; })),
        actual: hasActual ? round2_(sum(g.rows, function (x) { return x.actual; })) : null,
        buyers: g.rows.filter(function (x) { return x.buyer && !x.placeholder; }).length,
        placeholders: g.rows.filter(function (x) { return x.placeholder; }).length
      };
    });
  }

  var totalTarget = round2_(sum(rows, function (x) { return x.target; }));
  var totalQty = round2_(sum(rows, function (x) { return x.qty; }));
  var totalActual = hasActual ? round2_(sum(rows, function (x) { return x.actual; })) : null;

  var byTeam = group(rows, function (x) { return x.teamName; }).sort(function (a, b) { return (b.target || 0) - (a.target || 0); });
  var byRegion = group(rows, function (x) { return titleCase_(x.region); }).sort(function (a, b) { return (b.target || 0) - (a.target || 0); });
  var byCategory = group(rows, function (x) { return titleCase_(x.category); }).sort(function (a, b) { return (b.target || 0) - (a.target || 0); });
  [byTeam, byRegion, byCategory].forEach(function (arr) {
    arr.forEach(function (g) { g.share = (totalTarget && g.target != null) ? round1_(g.target / totalTarget * 100) : null; });
  });

  // onboarding rollup (numeric targets) + named pipeline coverage
  var obSup = sum(onb, function (o) { return o.suppliers; });
  var obBuy = sum(onb, function (o) { return o.buyers; });
  var pipeByTeam = {};
  pipe.forEach(function (p) {
    var e = pipeByTeam[p.teamId] || (pipeByTeam[p.teamId] = { team: p.teamName, supplier: [], buyer: [] });
    e[p.type] = e[p.type].concat(p.names);
  });
  var onboarding = onb.map(function (o) {
    var pp = pipeByTeam[o.teamId] || { supplier: [], buyer: [] };
    return {
      teamId: o.teamId, team: o.teamName, region: titleCase_(o.region),
      suppliers: o.suppliers, buyers: o.buyers,
      total: (o.suppliers == null && o.buyers == null) ? null : (o.suppliers || 0) + (o.buyers || 0),
      notes: o.notes, supplierNames: pp.supplier, buyerNames: pp.buyer,
      supplierNamed: pp.supplier.length, buyerNamed: pp.buyer.length
    };
  }).sort(function (a, b) { return (b.total || 0) - (a.total || 0); });

  // requisition funnel
  var funnel = {}, reqYes = 0;
  reqs.forEach(function (q) {
    var k = q.remarks || '—';
    funnel[k] = (funnel[k] || 0) + 1;
    if (/^y/i.test(q.requisition)) reqYes++;
  });
  var funnelList = Object.keys(funnel).map(function (k) { return { label: k, count: funnel[k], share: round1_(funnel[k] / reqs.length * 100) }; }).sort(function (a, b) { return b.count - a.count; });

  var mode = (hasActual || statedHasActual) ? 'performance' : 'plan';
  /* Headline achievement: the sheet's own stated total is the ONLY real
   * performance figure when the per-buyer achievement column merely copies
   * target (which it does in July). Attainment is therefore computed from a
   * single consistent source pair, and `basis` says which one was used. */
  var statedTarget = (stated && stated.total && stated.total.target != null) ? stated.total.target
                   : ((statedOnb.gmv && statedOnb.gmv.target != null) ? statedOnb.gmv.target : null);
  var statedActual = (stated && stated.total && stated.total.actual != null) ? stated.total.actual
                   : ((statedOnb.gmv && statedOnb.gmv.actual != null) ? statedOnb.gmv.actual : null);
  var rowsAreCopies = hasActual && totalActual != null && totalTarget != null && Math.abs(totalActual - totalTarget) < 0.005;
  var useStated = mode === 'performance' && statedActual != null && statedTarget != null && (rowsAreCopies || !hasActual);
  var headActual = useStated ? statedActual : totalActual;
  var attain = null, basis = null;
  if (mode === 'performance') {
    if (useStated) { attain = round1_(statedActual / statedTarget * 100); basis = 'stated'; }
    else if (totalActual != null && totalTarget) { attain = round1_(totalActual / totalTarget * 100); basis = 'rows'; }
  }
  return {
    key: pk, label: periodLabel_(pk), mode: mode,
    gmv: {
      target: totalTarget, actual: headActual, actualRows: totalActual, qty: totalQty,
      statedTarget: statedTarget, statedActual: statedActual,
      rows: rows.length,
      buyers: rows.filter(function (r) { return r.buyer && !r.placeholder; }).length,
      placeholders: rows.filter(function (r) { return r.placeholder; }).length,
      attainment: attain, attainmentBasis: basis,
      byTeam: byTeam, byRegion: byRegion, byCategory: byCategory,
      concentration: byTeam.length ? { team: byTeam[0].key, share: byTeam[0].share, target: byTeam[0].target } : null,
      records: rows
    },
    onboarding: {
      suppliers: obSup, buyers: obBuy,
      total: (obSup == null && obBuy == null) ? null : (obSup || 0) + (obBuy || 0),
      byTeam: onboarding,
      stated: statedOnb,
      namedSuppliers: pipe.filter(function (p) { return p.type === 'supplier'; }).reduce(function (s, p) { return s + p.names.length; }, 0),
      namedBuyers: pipe.filter(function (p) { return p.type === 'buyer'; }).reduce(function (s, p) { return s + p.names.length; }, 0)
    },
    requisitions: { rows: reqs, total: reqs.length, yes: reqYes, funnel: funnelList },
    stated: stated
  };
}

/** Buyer intelligence: one card per buyer in the mapping layer. */
function buildBuyerIntel_(acc, roster) {
  var byKey = {};
  acc.mapping.forEach(function (m) {
    var key = normEntity_(m.buyer);
    var b = byKey[key];
    if (!b) { b = byKey[key] = { key: key, name: m.buyer, teamId: m.teamId, team: m.teamName, suppliers: [], category: m.category, volume: m.volume, estGmv: m.estGmv, status: m.status, nbfc: m.nbfc, terms: m.terms, capacity: m.capacity, requisition: null, remarks: null, gmvTarget: null, gmvPeriods: [], names: {} }; }
    b.names[m.buyer] = 1;
    m.suppliers.forEach(function (s) { if (b.suppliers.indexOf(s) < 0) b.suppliers.push(s); });
  });
  // attach requisition status + GMV-plan linkage by fuzzy entity name
  acc.requisitions.forEach(function (q) {
    var b = matchEntity_(byKey, q.buyer);
    if (b) { b.requisition = q.requisition; b.remarks = q.remarks; b.trackerPoc = q.teamName; b.trackerRegion = titleCase_(q.region); }
    else byKey['__req_' + normEntity_(q.buyer)] = { key: '__req_' + normEntity_(q.buyer), name: q.buyer, team: q.teamName, teamId: q.teamId, suppliers: [], category: '', volume: null, estGmv: null, status: '', nbfc: '', terms: '', capacity: null, requisition: q.requisition, remarks: q.remarks, trackerPoc: q.teamName, trackerRegion: titleCase_(q.region), gmvTarget: null, gmvPeriods: [], names: {}, mappingMissing: true };
  });
  acc.gmv.forEach(function (g) {
    if (!g.buyer || g.placeholder) return;
    var b = matchEntity_(byKey, g.buyer);
    if (!b) return;
    b.gmvTarget = (b.gmvTarget == null ? 0 : b.gmvTarget) + (g.target || 0);
    b.gmvByPeriod = b.gmvByPeriod || {};
    var e = b.gmvByPeriod[g.period] || (b.gmvByPeriod[g.period] = { target: 0, qty: 0, actual: null });
    e.target = round2_(e.target + (g.target || 0));
    e.qty = round2_(e.qty + (g.qty || 0));
    if (g.actual != null) e.actual = round2_((e.actual || 0) + g.actual);
    if (b.gmvPeriods.indexOf(g.period) < 0) b.gmvPeriods.push(g.period);
    if (!b.region) b.region = titleCase_(g.region);
  });
  return Object.keys(byKey).map(function (k) {
    var b = byKey[k];
    b.gmvTarget = round2_(b.gmvTarget);
    b.active = /^act/i.test(b.status);
    b.variants = Object.keys(b.names);
    return b;
  }).sort(function (a, b) { return (b.gmvTarget || 0) - (a.gmvTarget || 0) || a.name.localeCompare(b.name); });
}
/* Entity-name normalisation so "M/S Natraj Iron & Casting Ltd." ≈ "NATRAJ". */
function normEntity_(s) {
  return String(s || '').toLowerCase()
    .replace(/\b(m\/s|messrs)\b/g, ' ')
    .replace(/\b(private|pvt|limited|ltd|llp|inc|co|company|corporation|corp|industries|industry|enterprises|enterprise|steels?|metals?|ispat|traders?|trading|and|&)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, '').trim();
}
function matchEntity_(byKey, raw) {
  var k = normEntity_(raw);
  if (!k) return null;
  if (byKey[k]) return byKey[k];
  var keys = Object.keys(byKey);
  for (var i = 0; i < keys.length; i++) {
    var kk = keys[i]; if (kk.indexOf('__req_') === 0) continue;
    if (!kk) continue;
    if (kk.indexOf(k) === 0 || k.indexOf(kk) === 0) return byKey[kk];
  }
  return null;
}

/** Invert buyer→suppliers into a supplier→buyers network with coverage. */
function buildSupplierNetwork_(acc) {
  var by = {};
  acc.mapping.forEach(function (m) {
    m.suppliers.forEach(function (s) {
      var k = normEntity_(s) || slug_(s);
      var e = by[k] || (by[k] = { key: k, name: s, buyers: [], teams: {}, categories: {}, capacity: null, variants: {} });
      e.variants[s] = 1;
      if (e.buyers.indexOf(m.buyer) < 0) e.buyers.push(m.buyer);
      if (m.teamName) e.teams[m.teamName] = 1;
      if (m.category) e.categories[titleCase_(m.category)] = 1;
      if (m.capacity != null) e.capacity = (e.capacity == null ? 0 : e.capacity) + m.capacity;
    });
  });
  return Object.keys(by).map(function (k) {
    var e = by[k];
    return { key: k, name: e.name, buyers: e.buyers, buyerCount: e.buyers.length, teams: Object.keys(e.teams), categories: Object.keys(e.categories), reachCapacity: round2_(e.capacity), variants: Object.keys(e.variants) };
  }).sort(function (a, b) { return b.buyerCount - a.buyerCount || a.name.localeCompare(b.name); });
}

/** ---------------------------------- RECONCILIATION / DATA QUALITY */
function planFindings_(acc, byPeriod, periods, roster, buyers) {
  var out = [];
  function add(sev, title, detail) { out.push({ severity: sev, title: title, detail: detail }); }

  periods.forEach(function (pk) {
    var p = byPeriod[pk], st = p.stated, L = p.label;
    if (st && st.total) {
      if (st.total.target != null && p.gmv.target != null && Math.abs(st.total.target - p.gmv.target) > 0.005)
        add('high', L + ' — GMV total disagrees with its own rows', 'The sheet states ₹' + st.total.target + ' Cr but the buyer rows sum to ₹' + p.gmv.target + ' Cr (difference ₹' + round2_(st.total.target - p.gmv.target) + ' Cr). The dashboard uses the row sum.');
      if (st.total.qty != null && p.gmv.qty != null && Math.abs(st.total.qty - p.gmv.qty) > 0.5)
        add('high', L + ' — quantity total disagrees with its own rows', 'Stated ' + st.total.qty + ' MT vs ' + p.gmv.qty + ' MT from the rows.');
      if (st.total.actual != null && p.gmv.actual != null && Math.abs(st.total.actual - p.gmv.actual) > 0.005)
        add('high', L + ' — GMV achievement total disagrees with its own rows', 'Stated ₹' + st.total.actual + ' Cr achieved but the per-buyer achievement column sums to ₹' + p.gmv.actual + ' Cr. Per-buyer achievement looks like a copy of target, so only the stated total carries real performance.');
    }
    // stated SUMMARY buyer counts vs atomic rows
    if (st && st.summary && st.summary.length) {
      var mism = [];
      st.summary.forEach(function (s) {
        var t = canonTeam_(roster, s.team);
        var g = p.gmv.byTeam.filter(function (x) { return x.key === t.name; })[0];
        if (!g) return;
        if (s.buyers != null && s.buyers !== g.rows) mism.push(t.name + ' (says ' + s.buyers + ', rows show ' + g.rows + ')');
      });
      if (mism.length) add('medium', L + ' — SUMMARY "# Buyers" is not a count of the GMV rows', 'Mismatch for ' + mism.join('; ') + '. These figures match the onboarding targets instead, so the dashboard counts buyers from the rows.');
      if (st.summaryUnitLabel) add('medium', L + ' — summary GMV column is labelled "' + st.summaryUnitLabel + '"', 'The values are in ₹ Cr, matching the detail rows. Everything is standardised to ₹ Cr.');
    }
    // named pipeline vs numeric onboarding targets
    var gaps = [];
    p.onboarding.byTeam.forEach(function (o) {
      if (o.suppliers != null && o.supplierNamed !== o.suppliers) gaps.push(o.team + ' suppliers ' + o.supplierNamed + '/' + o.suppliers);
      if (o.buyers != null && o.buyerNamed !== o.buyers) gaps.push(o.team + ' buyers ' + o.buyerNamed + '/' + o.buyers);
    });
    if (gaps.length) add('medium', L + ' — named onboarding pipeline does not match the targets', 'Named vs target: ' + gaps.join('; ') + '. Targets drive the totals; names are shown as the pipeline.');
  });

  // team-name variants folded together
  roster.list.forEach(function (m) {
    var v = Object.keys(m.variants);
    if (v.length > 1) {
      var distinct = {};
      v.forEach(function (x) { if (!distinct[x.toLowerCase()]) distinct[x.toLowerCase()] = x; });
      var keys = Object.keys(distinct);
      if (keys.length > 1) add('low', 'Team name spelled ' + keys.length + ' ways: ' + keys.map(function (k) { return distinct[k]; }).join(' / '), 'All folded into one person (' + m.name + ').');
    }
  });

  // missing vs zero in the mapping layer
  if (acc.mapping.length) {
    var noGmv = acc.mapping.filter(function (m) { return m.estGmv == null; }).length;
    var noVol = acc.mapping.filter(function (m) { return m.volume == null; }).length;
    var noCap = acc.mapping.filter(function (m) { return m.capacity == null; }).length;
    if (noGmv) add('medium', noGmv + ' of ' + acc.mapping.length + ' mapped buyers have no Est. GMV', 'Shown as "—", never as ₹0, and excluded from averages.');
    if (noVol) add('low', noVol + ' mapped buyers have no Est. Volume', 'Blank and "-" are both treated as missing.');
    if (noCap) add('low', noCap + ' mapped buyers have no monthly capacity', 'Excluded from capacity coverage.');
    if (acc.mappingMeta && /july/i.test(acc.mappingMeta.volumeLabel || '') && acc.mappingMeta.period && !/-07$/.test(acc.mappingMeta.period))
      add('medium', 'Mapping volume column is labelled "' + acc.mappingMeta.volumeLabel + '"', 'The tab itself is dated ' + periodLabel_(acc.mappingMeta.period) + ', so the column heading and the tab disagree on the month.');
    // capacity outliers (order-of-magnitude)
    var caps = acc.mapping.map(function (m) { return m.capacity; }).filter(function (x) { return x != null; }).sort(function (a, b) { return a - b; });
    if (caps.length >= 4) {
      var med = caps[Math.floor(caps.length / 2)];
      var big = acc.mapping.filter(function (m) { return m.capacity != null && med > 0 && m.capacity >= med * 10; });
      if (big.length) add('medium', big.length + ' buyer(s) report a monthly capacity 10×+ the median', big.map(function (m) { return m.buyer + ' (' + m.capacity + ' MT)'; }).join('; ') + ' vs a median of ' + med + ' MT — worth confirming the unit.');
    }
  }

  // buyers known to the tracker but absent from the mapping, and owner conflicts
  var missing = buyers.filter(function (b) { return b.mappingMissing; });
  if (missing.length) add('medium', missing.length + ' buyer(s) in the requisition tracker are missing from the mapping', missing.map(function (b) { return b.name; }).join('; '));
  var conflicts = buyers.filter(function (b) { return b.trackerPoc && b.team && normEntity_(b.trackerPoc) !== normEntity_(b.team); });
  if (conflicts.length) add('medium', conflicts.length + ' buyer(s) have a different owner in the tracker vs the mapping', conflicts.slice(0, 12).map(function (b) { return b.name + ' (' + b.trackerPoc + ' → ' + b.team + ')'; }).join('; ') + (conflicts.length > 12 ? '; …' : '') + '. This may be a genuine reassignment between months — worth confirming.');
  var variants = buyers.filter(function (b) { return b.variants && b.variants.length > 1; });
  if (variants.length) add('low', variants.length + ' buyer(s) appear under more than one spelling', variants.slice(0, 10).map(function (b) { return b.variants.join(' / '); }).join('; '));
  var bundled = acc.gmv.filter(function (g) { return g.bundled; });
  if (bundled.length) add('medium', bundled.length + ' GMV row(s) hold several buyers in one cell', bundled.map(function (g) { return g.buyer + ' (' + g.teamName + ')'; }).join('; ') + ' — counted as one row; split them to track each buyer.');
  var ph = acc.gmv.filter(function (g) { return g.placeholder; });
  if (ph.length) add('low', ph.length + ' GMV row(s) are unnamed placeholders', ph.map(function (g) { return g.teamName + ' · ' + g.buyer + ' (₹' + (g.target == null ? '—' : g.target) + ' Cr)'; }).join('; ') + '. Their targets count toward the plan but they are excluded from named-buyer counts.');
  return out;
}

function mergePeriods_(a, b) {
  var set = {};
  (a || []).forEach(function (p) { if (p) set[p] = 1; });
  (b || []).forEach(function (p) { var k = p && p.key ? p.key : p; if (k) set[k] = 1; });
  return Object.keys(set).sort().reverse();
}
