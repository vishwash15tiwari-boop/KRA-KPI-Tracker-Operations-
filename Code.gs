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

  // ---- join the SEPARATE actuals source and compute per-record performance.
  var actuals = readActuals_(period, settings);
  ctx.records.forEach(function (r) { computeRecord_(r, actuals[r.kpiId + '|' + period] || actuals[r.kpiId] || null, settings); });

  // ---- roll-ups.
  rollUp_(ctx, settings);

  var empty = ctx.records.length === 0 && ctx.depts.every(function (d) { return !d.rawTable; });
  return {
    ok: true, connected: true, empty: empty,
    generatedAt: nowIso_(), lastUpdated: fileUpdated_(),
    user: { email: safeEmail_() },
    period: period,
    source: {
      title: ss.getName(), id: SOURCE_SPREADSHEET_ID,
      tabs: sheets.map(function (s) { return { name: s.getName(), rows: s.getLastRow(), cols: s.getLastColumn() }; }),
      actuals: actualsSourceInfo_(settings, actuals)
    },
    settings: { thresholds: settings.thresholds, period: settings.period, periods: knownPeriods_(actuals, period), ratingMax: RATING_MAX },
    departments: ctx.depts,
    subTeams: ctx.subTeams,
    employees: ctx.employees,
    records: ctx.records,
    rollups: ctx.rollups,
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
  return {
    perspective: cell_(row, cols.perspective),
    role: cell_(row, cols.role),
    kra: cell_(row, cols.kra),
    kpi: name,
    definition: cell_(row, cols.def),
    source: cell_(row, cols.source),
    unit: cell_(row, cols.unit) || inferUnit_(name, cell_(row, cols.def), bands),
    weight: parseNum_(cell_(row, cols.weight)),
    bands: bands,
    direction: direction,
    qualitative: nums.length < 2,
    meets: meets
  };
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
    bands: k.bands, direction: k.direction, qualitative: k.qualitative, meetsValue: k.meets,
    // performance (filled by computeRecord_)
    hasActual: false, target: null, actual: null, rating: null, achievedBand: null,
    attainment: null, weighted: null, status: statusFromRating_(null, ctx.thresholds || DEFAULT_THRESHOLDS),
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
    d.subTeamIds = ctx.subTeams.filter(function (s) { return s.deptId === d.id; }).map(function (s) { return s.id; });
  });

  // 6) org.
  var allR = ctx.employees.map(function (e) { return e.rating; }).filter(function (x) { return x != null; });
  var recWith = ctx.records.filter(function (r) { return r.hasActual; }).length;
  ctx.rollups = {
    org: {
      rating: allR.length ? round2_(avg_(allR)) : null,
      status: statusFromRating_(allR.length ? avg_(allR) : null, th),
      departments: ctx.depts.length,
      people: ctx.employees.length, peopleWithData: allR.length,
      kpis: ctx.records.length, kpisWithData: recWith,
      coverage: ctx.records.length ? round1_(recWith / ctx.records.length * 100) : 0,
      onTrack: ctx.employees.filter(function (e) { return e.status.k === 'good'; }).length,
      atRisk: ctx.employees.filter(function (e) { return e.status.k === 'warn'; }).length,
      offTrack: ctx.employees.filter(function (e) { return e.status.k === 'bad'; }).length
    }
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
/* Read actuals for a period from the managed tab, or an external sheet if set. */
function readActuals_(period, settings) {
  settings = settings || readSettings_();
  var map = {};
  var sh = null;
  try {
    if (settings.actualsSheetId) {
      var ext = SpreadsheetApp.openById(settings.actualsSheetId);
      sh = ext.getSheetByName(settings.actualsTab || ACTUALS_TAB) || ext.getSheets()[0];
    } else {
      sh = SpreadsheetApp.openById(SOURCE_SPREADSHEET_ID).getSheetByName(ACTUALS_TAB);
    }
  } catch (e) { sh = null; }
  if (!sh) return map;
  var data = safeValues_(sh);
  if (!data.length) return map;
  var head = data[0], col = {}; head.forEach(function (h, i) { col[norm_(h)] = i; });
  var ci = { id: col['kpiid'], per: col['period'], tgt: col['target'], act: col['actual'], rat: col['rating'], com: col['comment'], ev: col['evidence'], up: col['updatedat'] };
  if (ci.id == null) return map;
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
    map[id + '|' + per] = rec;
    if (per === period || !per) map[id] = rec;          // period-agnostic fallback
  }
  return map;
}
function actualsSourceInfo_(settings, actuals) {
  var count = 0; for (var k in actuals) if (k.indexOf('|') < 0) count++;
  return {
    type: settings.actualsSheetId ? 'external' : 'managed',
    tab: settings.actualsSheetId ? (settings.actualsTab || ACTUALS_TAB) : ACTUALS_TAB,
    sheetId: settings.actualsSheetId || SOURCE_SPREADSHEET_ID,
    rows: count
  };
}
function knownPeriods_(actuals, current) {
  var set = {}; set[current] = true;
  for (var k in actuals) { var i = k.indexOf('|'); if (i >= 0) { var p = k.slice(i + 1); if (p) set[p] = true; } }
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
