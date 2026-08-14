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

  // ---- PASS 2: departments / people / KPI records.
  var ctx = { depts: [], deptById: {}, subTeams: [], subById: {}, employees: [], empById: {}, records: [], seenKpiId: {}, order: 0, notes: [] };
  sheets.forEach(function (sh) {
    var name = sh.getName();
    if (isManaged_(name)) return;
    var grid = safeValues_(sh);
    if (!hasContent_(grid)) return;
    var cls = classifyTab_(grid, name);
    if (cls.kind === 'roster') return;                       // already consumed
    if (cls.kind === 'template') parseTemplateTab_(grid, name, cls, rosterByTeam, ctx);
    else if (cls.kind === 'blocks') parseBlocksTab_(grid, name, cls, ctx);
    else parseGenericTab_(grid, name, ctx);
  });

  // ---- join the SEPARATE actuals source (all periods) & compute performance.
  var all = readAllActuals_(settings);
  ctx.records.forEach(function (r) { computeRecord_(r, all.byKey[r.kpiId + '|' + period] || all.byKey[r.kpiId + '|'] || null, settings); });

  // ---- roll-ups, then trends / levels / perspectives / master-health.
  rollUp_(ctx, settings);
  computeTrends_(ctx, all, period, settings);
  var perspectives = perspectiveRollup_(ctx, settings);
  var health = computeHealth_(ctx, all);

  var empty = ctx.records.length === 0 && ctx.depts.every(function (d) { return !d.rawTable; });
  return {
    ok: true, connected: true, empty: empty,
    generatedAt: nowIso_(), lastUpdated: fileUpdated_(),
    user: { email: safeEmail_() },
    period: period,
    source: {
      title: ss.getName(), id: SOURCE_SPREADSHEET_ID,
      tabs: sheets.map(function (s) { return { name: s.getName(), rows: s.getLastRow(), cols: s.getLastColumn() }; }),
      actuals: actualsSourceInfo_(settings, all)
    },
    settings: { thresholds: settings.thresholds, period: settings.period, periods: knownPeriods_(all, period), ratingMax: RATING_MAX },
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
  var s = { period: '', thresholds: { onTrack: DEFAULT_THRESHOLDS.onTrack, atRisk: DEFAULT_THRESHOLDS.atRisk }, actualsSheetId: '', actualsTab: '' };
  try {
    var raw = PropertiesService.getDocumentProperties().getProperty('KKT_SETTINGS') ||
              PropertiesService.getScriptProperties().getProperty('KKT_SETTINGS');
    if (raw) { var o = JSON.parse(raw); if (o) { s.period = o.period || ''; if (o.thresholds) s.thresholds = o.thresholds; s.actualsSheetId = o.actualsSheetId || ''; s.actualsTab = o.actualsTab || ''; } }
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
