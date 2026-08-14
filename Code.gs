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
// targets + actual performance; the rest carry the product layer that the
// master sheet has no place for. All are ignored by the framework parser.
var ACTUALS_TAB     = 'KKT_Actuals';
var SETTINGS_TAB    = 'KKT_Settings';
var CYCLES_TAB      = 'KKT_Cycles';        // performance cycles (dates + lifecycle)
var ASSIGNMENTS_TAB = 'KKT_Assignments';   // per employee × cycle KPI overrides
var CHECKINS_TAB    = 'KKT_Checkins';      // append-only progress history
var REVIEWS_TAB     = 'KKT_Reviews';       // self → manager → final → lock

// Rating thresholds (on the 1–5 scale) → semantic status. Editable in Settings.
var DEFAULT_THRESHOLDS = { onTrack: 3.0, atRisk: 2.0 };   // >=3 On Track, >=2 At Risk
var RATING_MAX = 5;

/* ONE system-wide conversion from the 1–5 rating to a performance percentage.
 * It is deliberately NOT embedded per-KPI: change it here (or in Settings) and
 * every score in the product moves together. ratingPct[i] = % for rating i+1. */
var DEFAULT_SCORING = { ratingPct: [20, 40, 60, 80, 100], interpolate: true };

/* Status is a SEPARATE concept from rating: the rating is the measurement, the
 * status is how the business talks about it. Ordered worst→best by `min`. */
var DEFAULT_STATUS_SCALE = [
  { key: 'bad',    label: 'At Risk',   min: 0 },
  { key: 'warn',   label: 'Watch',     min: 2 },
  { key: 'good',   label: 'On Track',  min: 3 },
  { key: 'strong', label: 'Strong',    min: 4 },
  { key: 'elite',  label: 'Exceeding', min: 4.5 }
];

// Cycle lifecycle. A locked cycle is immutable — no check-ins, no reviews.
var CYCLE_STATES = ['Draft', 'Active', 'Review', 'Locked'];
// Review workflow states, in order.
var REVIEW_STATES = ['Not Started', 'Self Review', 'Manager Review', 'Final Review', 'Complete'];

var CACHE_PREFIX = 'kkt_v5_';
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
    bustCache_(period);
    return { ok: true, added: rows.length, period: period, total: sh.getLastRow() - 1, tab: ACTUALS_TAB };
  } catch (err) { return { ok: false, error: String(err && err.message || err) }; }
}

/** Upsert one actual/target/rating for a KPI × period; recompute follows on refresh. */
function apiSaveActual(p) {
  p = p || {};
  try {
    if (!p.kpiId) throw new Error('Missing kpiId.');
    var period = p.period || readSettings_().period || currentPeriod_();
    assertUnlocked_(period);
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
    bustCache_(period);
    return { ok: true, kpiId: p.kpiId, period: period };
  } catch (err) { return { ok: false, error: String(err && err.message || err) }; }
}

/** Persist settings (scoring / statuses / active period / actuals source). */
function apiSaveSettings(p) {
  try {
    var s = readSettings_();
    p = p || {};
    if (p.period      !== undefined) s.period = String(p.period || '');
    if (p.onTrack     !== undefined) s.thresholds.onTrack = num_(p.onTrack);
    if (p.atRisk      !== undefined) s.thresholds.atRisk  = num_(p.atRisk);
    if (p.actualsSheetId !== undefined) s.actualsSheetId = String(p.actualsSheetId || '');
    if (p.actualsTab     !== undefined) s.actualsTab     = String(p.actualsTab || '');
    // the ONE rating→percentage conversion, as five ascending values.
    if (p.ratingPct !== undefined) {
      var arr = (typeof p.ratingPct === 'string') ? p.ratingPct.split(',') : p.ratingPct;
      if (!arr || arr.length !== 5) throw new Error('Scoring needs exactly 5 percentages (rating 1 → 5).');
      s.scoring.ratingPct = arr.map(function (x) { return clamp_(num_(x), 0, 100); });
    }
    if (p.interpolate !== undefined) s.scoring.interpolate = !!(p.interpolate === true || p.interpolate === 'true');
    // status labels + cut-offs; thresholds re-derive from these on next read.
    if (p.statusScale !== undefined && p.statusScale) {
      var sc = (typeof p.statusScale === 'string') ? JSON.parse(p.statusScale) : p.statusScale;
      if (sc && sc.length) s.statusScale = sc.map(function (x) { return { key: String(x.key), label: String(x.label || x.key), min: clamp_(num_(x.min), 0, 5) }; });
    }
    writeSettings_(s); bustCache_(s.period);
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
  var ctx = { depts: [], deptById: {}, subTeams: [], subById: {}, employees: [], empById: {}, records: [], seenKpiId: {}, order: 0, notes: [], statusScale: settings.statusScale };
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

  // ---- the product layer: cycles, assignments, check-ins, reviews.
  var cycles = readCycles_();
  var cycle = cycleFor_(cycles, period);
  var assignments = readAssignments_();
  var checkins = readCheckins_();
  var reviews = readReviews_();

  // ---- join the SEPARATE actuals source (all periods) & compute performance.
  var all = readAllActuals_(settings);
  ctx.records.forEach(function (r) {
    var asg = assignments.byKey[r.kpiId + '|' + period] || assignments.byKey[r.kpiId + '|'] || null;
    computeRecord_(r, all.byKey[r.kpiId + '|' + period] || all.byKey[r.kpiId + '|'] || null, settings, asg);
    var log = checkins.byKey[r.kpiId + '|' + period] || [];
    r.checkins = log.slice(-8);
    r.checkinCount = log.length;
  });

  // ---- roll-ups, then trends / levels / perspectives / master-health.
  rollUp_(ctx, settings);
  computeTrends_(ctx, all, period, settings);
  attachReviews_(ctx, reviews, period, cycle);
  var perspectives = perspectiveRollup_(ctx, settings);
  var health = computeHealth_(ctx, all, assignments, reviews, period);

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
    settings: {
      thresholds: settings.thresholds, period: settings.period,
      periods: knownPeriods_(all, period, cycles, assignments),
      ratingMax: RATING_MAX,
      scoring: settings.scoring,
      statusScale: normalizeScale_(settings.statusScale),
      cycleStates: CYCLE_STATES, reviewStates: REVIEW_STATES
    },
    cycle: cycle,
    cycles: cycles.list,
    departments: ctx.depts,
    subTeams: ctx.subTeams,
    employees: ctx.employees,
    records: ctx.records,
    library: buildLibrary_(ctx, settings),
    rollups: ctx.rollups,
    perspectives: perspectives,
    checkins: checkins.recent.slice(0, 200),
    checkinTotal: checkins.rows,
    assignmentCount: assignments.rows,
    health: health,
    notes: ctx.notes
  };
}

/* KPI DEFINITION vs KPI ASSIGNMENT. The library is the master list — one entry
 * per distinct KPI definition — with the assignments that reference it. The
 * same definition can carry a different weight and ladder per person, which is
 * exactly what the workbook already does. */
function buildLibrary_(ctx, settings) {
  var map = {};
  ctx.records.forEach(function (r) {
    var m = map[r.defId] || (map[r.defId] = {
      defId: r.defId, kpi: r.kpi, kra: r.kra, perspective: r.perspective,
      definition: r.definition, unit: r.unit, source: r.source,
      metricType: r.metricType, targetLogic: r.targetLogic,
      directionKey: r.directionKey, directionSource: r.directionSource,
      qualitative: r.qualitative,
      assignments: [], departments: {}, weights: [], ladders: {}
    });
    m.assignments.push({
      kpiId: r.kpiId, employeeId: r.employeeId, employee: r.employee,
      department: r.department, subTeam: r.subTeam,
      weight: r.weightShown, rating: r.rating, scorePct: r.scorePct,
      status: r.status, bandSource: r.bandSource, reviewer: r.reviewer
    });
    m.departments[r.department] = true;
    if (r.weightShown != null) m.weights.push(r.weightShown);
    m.ladders[(r.bands || []).map(function (b) { return b.raw || ''; }).join(' | ')] = true;
  });
  return Object.keys(map).map(function (k) {
    var m = map[k];
    var rated = m.assignments.filter(function (a) { return a.rating != null; });
    m.owners = m.assignments.length;
    m.teams = Object.keys(m.departments).length;
    m.variants = Object.keys(m.ladders).length;      // >1 ⇒ the ladder differs by assignment
    m.weightMin = m.weights.length ? round1_(Math.min.apply(null, m.weights)) : null;
    m.weightMax = m.weights.length ? round1_(Math.max.apply(null, m.weights)) : null;
    m.rating = rated.length ? round2_(avg_(rated.map(function (a) { return a.rating; }))) : null;
    m.scorePct = scoreFromRating_(m.rating, settings.scoring);
    m.status = statusFromRating_(m.rating, settings.statusScale);
    delete m.departments; delete m.ladders; delete m.weights;
    return m;
  }).sort(function (a, b) { return b.owners - a.owners; });
}

/* Attach each person's review state for the period, and roll the cycle-level
 * review progress the Reviews screen needs. */
function attachReviews_(ctx, reviews, period, cycle) {
  var counts = { total: 0, notStarted: 0, self: 0, manager: 0, final: 0, complete: 0 };
  ctx.employees.forEach(function (e) {
    var rv = reviews.byKey[e.id + '|' + period] || null;
    e.review = rv ? {
      status: rv.status,
      selfRating: rv.selfRating, selfComment: rv.selfComment, selfBy: rv.selfBy, selfAt: rv.selfAt,
      managerRating: rv.managerRating, managerComment: rv.managerComment, managerBy: rv.managerBy, managerAt: rv.managerAt,
      finalRating: rv.finalRating, finalComment: rv.finalComment, updatedAt: rv.updatedAt
    } : { status: 'Not Started', selfRating: null, managerRating: null, finalRating: null };
    counts.total++;
    var s = e.review.status;
    if (s === 'Complete') counts.complete++;
    else if (s === 'Final Review') counts.final++;
    else if (s === 'Manager Review') counts.manager++;
    else if (s === 'Self Review') counts.self++;
    else counts.notStarted++;
  });
  counts.pending = counts.total - counts.complete;
  counts.progress = counts.total ? round1_(counts.complete / counts.total * 100) : 0;
  ctx.rollups.reviews = counts;
  ctx.rollups.cycle = cycle;
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
  var direction   = find(['direction', 'polarity', 'better']);
  var bandCols    = findBandCols_(header);
  var def         = find(['definition', 'goal description', 'goal']);

  var kpiExact = findExact('kpi', perspective >= 0 ? perspective + 1 : 0);
  var kraCol   = findExact('kra', perspective >= 0 ? perspective + 1 : 0);
  if (kraCol < 0) kraCol = find(['kra'], perspective >= 0 ? perspective + 1 : 0);

  var nameCol, style;
  if (kpiExact >= 0) { style = 'blocks'; nameCol = kpiExact; }         // BLOCKS: KPI is the metric name
  else { style = 'template'; nameCol = kraCol; if (def < 0) def = find(['kpi']); } // TEMPLATE: KRA is the KPI name; def = "KPI / Definition"

  return { style: style, perspective: perspective, role: role, kra: kraCol, name: nameCol, def: def, weight: weight, source: source, unit: unit, direction: direction, bands: bandCols };
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
  var def = cell_(row, cols.def);
  var unit = cell_(row, cols.unit) || inferUnit_(name, def, bands);
  var dir = resolveDirection_(cell_(row, cols.direction), bands, name, def);
  var mc = classifyMetric_(unit, bands, name, def, dir.sign);
  var meets = bands.length >= 3 ? bands[2].num : (nums.length ? nums[Math.floor(nums.length / 2)] : null);
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
    direction: dir.sign,           // -1 | 0 | 1 — kept for existing maths
    directionKey: dir.key,         // 'higher' | 'lower' | 'exact'
    directionSource: dir.source,   // 'declared' | 'inferred'
    metricType: mc.metricType,
    targetLogic: mc.targetLogic,
    qualitative: nums.length < 2,
    meets: meets
  };
}

/* Direction decides how an actual is read against the band ladder, and the
 * rating cannot be computed reliably without it. A declared value always wins;
 * otherwise it is inferred from whether the bands ascend or descend. */
function resolveDirection_(declared, bands, name, def) {
  var d = norm_(declared);
  if (d) {
    if (/lower|less|below|desc|down|reverse|-1/.test(d)) return { key: 'lower', sign: -1, source: 'declared' };
    if (/higher|greater|more|above|asc|up|1$/.test(d)) return { key: 'higher', sign: 1, source: 'declared' };
    if (/exact|binary|equal|yes\/no|match|target only/.test(d)) return { key: 'exact', sign: 0, source: 'declared' };
  }
  var nums = (bands || []).map(function (b) { return b.num; }).filter(function (x) { return x != null; });
  if (nums.length >= 2) {
    var last = nums[nums.length - 1], first = nums[0];
    if (last > first) return { key: 'higher', sign: 1, source: 'inferred' };
    if (last < first) return { key: 'lower', sign: -1, source: 'inferred' };
    return { key: 'exact', sign: 0, source: 'inferred' };   // flat ladder = hit the number
  }
  // No usable ladder: fall back to the KPI's own language.
  var s = norm_((name || '') + ' ' + (def || ''));
  if (/\b(dso|tat|pdd|ageing|aging|delay|defect|leakage|rejection|dn)\b|days outstanding|turnaround/.test(s)) return { key: 'lower', sign: -1, source: 'inferred' };
  return { key: 'higher', sign: 1, source: 'inferred' };
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
    // definition-level identity: the same KPI assigned to several people shares this.
    defId: slug_((k.perspective || '') + '|' + (k.kra || '') + '|' + (k.kpi || '')),
    weight: k.weight, weightShown: null, weightNorm: null, weightSource: 'master',
    bands: k.bands, bandSource: 'master',
    direction: k.direction, directionKey: k.directionKey, directionSource: k.directionSource,
    metricType: k.metricType, targetLogic: k.targetLogic,
    qualitative: k.qualitative, meetsValue: k.meets,
    // assignment (filled by applyAssignment_)
    assigned: false, reviewer: '', assignmentNote: '',
    // performance (filled by computeRecord_ / rollUp_)
    hasActual: false, target: null, actual: null, rating: null, achievedBand: null,
    attainment: null, scorePct: null, weighted: null, points: null, maxPoints: null,
    status: statusFromRating_(null, ctx.statusScale || DEFAULT_STATUS_SCALE),
    // trend (filled by computeTrends_) and check-in history
    history: [], delta: null, checkins: [], checkinCount: 0,
    comment: '', evidence: '', updatedAt: null
  };
  emp.kpiIds.push(kpiId);
  if (subTeam) { subTeam.kpiCount++; if (emp.subTeamIds.indexOf(subTeam.id) < 0) emp.subTeamIds.push(subTeam.id); }
  dept.kpiCount++;
  ctx.records.push(rec);
}

/** ==================================================== PERFORMANCE / SCORING */
/* One KPI line for one period. `asg` is the KPI ASSIGNMENT (this person, this
 * cycle) — it may override the weight, the direction and the whole band ladder,
 * which is what keeps a historical cycle scored against the bands that actually
 * applied at the time rather than today's master sheet. */
function computeRecord_(r, a, settings, asg) {
  applyAssignment_(r, asg);

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
    rating = ratingFromBands_(r.bands, r.actual, r.directionKey);
  } else if (a && a.rating != null) {
    rating = clamp_(a.rating, 1, 5);                                     // manual override allowed
  }
  r.rating = rating;
  r.achievedBand = bandLabelForRating_(r.bands, rating);
  r.attainment = attainment_(r, r.actual, r.target);
  r.scorePct = scoreFromRating_(rating, settings.scoring);   // rating → % via the ONE system config
  r.status = statusFromRating_(rating, settings.statusScale);
  // weightNorm / points are set in rollUp_ (they need the block weight sum).
}

/* Overlay the assignment onto the definition. Anything the assignment leaves
 * blank keeps the master-sheet value, so a partial override is safe. */
function applyAssignment_(r, asg) {
  r.assigned = !!asg;
  r.reviewer = asg && asg.reviewer ? asg.reviewer : '';
  r.assignmentNote = asg && asg.note ? asg.note : '';
  if (!asg) return;

  if (asg.weight != null) { r.weight = asg.weight; r.weightSource = 'assignment'; }
  if (asg.bands && asg.bands.length) {
    var override = [];
    for (var i = 0; i < Math.max(r.bands.length, asg.bands.length); i++) {
      var base = r.bands[i] || { label: 'Target ' + (i + 1), raw: '', num: null };
      var raw = asg.bands[i];
      override.push((raw == null || raw === '')
        ? { label: base.label, raw: base.raw, num: base.num }
        : { label: base.label, raw: String(raw), num: parseBandNum_(raw) });
    }
    r.bands = override;
    r.bandSource = 'assignment';
    var nums = override.map(function (b) { return b.num; }).filter(function (x) { return x != null; });
    r.qualitative = nums.length < 2;
    r.meetsValue = override.length >= 3 ? override[2].num : (nums.length ? nums[Math.floor(nums.length / 2)] : null);
  }
  if (asg.direction) {
    var d = resolveDirection_(asg.direction, r.bands, r.kpi, r.definition);
    r.direction = d.sign; r.directionKey = d.key; r.directionSource = 'declared';
  } else if (r.bandSource === 'assignment') {
    var d2 = resolveDirection_(r.directionSource === 'declared' ? r.directionKey : '', r.bands, r.kpi, r.definition);
    r.direction = d2.sign; r.directionKey = d2.key;
  }
}

/* Interpolate an actual across the (rating 1..5 ↔ band value) ladder. Works for
 * both higher- and lower-is-better because it brackets on the monotonic values.
 * An 'exact' KPI never interpolates — the actual must land on a band value. */
function ratingFromBands_(bands, actual, directionKey) {
  if (actual == null || isNaN(actual)) return null;
  var pts = [];
  for (var i = 0; i < bands.length; i++) if (bands[i].num != null && !isNaN(bands[i].num)) pts.push({ r: i + 1, v: bands[i].num });
  if (directionKey === 'exact') return exactRating_(pts, actual);
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

/* Exact / binary KPIs: the actual either matches a band or it does not. No
 * partial credit between bands — the nearest band wins only on an exact hit,
 * otherwise the KPI scores at the bottom of the ladder. */
function exactRating_(pts, actual) {
  if (!pts.length) return null;
  for (var i = 0; i < pts.length; i++) if (Math.abs(pts[i].v - actual) < 1e-9) return pts[i].r;
  return pts[0].r;
}

function attainment_(r, actual, target) {
  if (actual == null || target == null || isNaN(actual) || isNaN(target) || target === 0) return null;
  if (r.directionKey === 'exact') return Math.abs(actual - target) < 1e-9 ? 100 : 0;
  var ratio = r.direction < 0 ? (target / actual) : (actual / target);   // lower-is-better inverts
  if (!isFinite(ratio) || ratio < 0) return null;
  return round1_(ratio * 100);
}

function bandLabelForRating_(bands, rating) {
  if (rating == null) return null;
  var idx = clamp_(Math.round(rating), 1, bands.length) - 1;
  return bands[idx] ? (bands[idx].label || ('Band ' + (idx + 1))) : null;
}

/* Status ≠ rating. The rating is the measurement; the status is the word the
 * business puts on it. Driven entirely by the configurable scale in Settings,
 * so labels and cut-offs can be retuned without touching scoring. */
function statusFromRating_(rating, scaleOrTh) {
  if (rating == null || isNaN(rating)) return { k: 'none', label: 'Pending', tier: 0 };
  var scale = normalizeScale_(scaleOrTh);
  var pick = scale[0];
  for (var i = 0; i < scale.length; i++) if (rating >= num_(scale[i].min)) pick = scale[i];
  return { k: pick.key, label: pick.label, tier: scale.indexOf(pick) + 1 };
}
/* Accepts a status scale, a legacy {onTrack,atRisk} thresholds object, or a
 * whole settings object — so every existing call site keeps working. */
function normalizeScale_(x) {
  if (!x) return DEFAULT_STATUS_SCALE;
  if (x.length) return x.slice().sort(function (a, b) { return num_(a.min) - num_(b.min); });
  if (x.statusScale && x.statusScale.length) return normalizeScale_(x.statusScale);
  if (x.onTrack != null || x.atRisk != null) {
    var atR = x.atRisk == null ? 2 : num_(x.atRisk), onT = x.onTrack == null ? 3 : num_(x.onTrack);
    return [
      { key: 'bad', label: 'At Risk', min: 0 },
      { key: 'warn', label: 'Watch', min: atR },
      { key: 'good', label: 'On Track', min: onT },
      { key: 'strong', label: 'Strong', min: Math.max(onT + 1, 4) },
      { key: 'elite', label: 'Exceeding', min: Math.max(onT + 1.5, 4.5) }
    ];
  }
  return DEFAULT_STATUS_SCALE;
}

/* ONE system conversion: rating 1–5 → performance percentage. With
 * interpolate on, a rating of 4.4 sits proportionally between the band-4 and
 * band-5 percentages instead of snapping down to 80%. */
function scoreFromRating_(rating, scoring) {
  if (rating == null || isNaN(rating)) return null;
  var map = (scoring && scoring.ratingPct && scoring.ratingPct.length === 5) ? scoring.ratingPct : DEFAULT_SCORING.ratingPct;
  var r = clamp_(rating, 1, 5);
  if (!(scoring && scoring.interpolate === false)) {
    var lo = Math.floor(r), hi = Math.ceil(r);
    if (lo === hi) return round1_(num_(map[lo - 1]));
    var a = num_(map[lo - 1]), b = num_(map[hi - 1]);
    return round1_(a + (r - lo) * (b - a));
  }
  return round1_(num_(map[Math.round(r) - 1]));
}

/** ==================================================== ROLL-UPS */
function rollUp_(ctx, settings) {
  var th = settings.thresholds, scale = settings.statusScale, scoring = settings.scoring;

  // 1) weight-normalise per (employee × sub-team) block, then compute the
  //    weighted contribution in BOTH currencies: rating (1–5) and points (/100).
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
      // points = (rating → %) × weight — the KPI's contribution to a /100 score.
      r.maxPoints = r.weightShown == null ? null : round2_(r.weightShown);
      r.points = (r.weightNorm != null && r.scorePct != null) ? round2_(r.scorePct * r.weightNorm) : null;
    });
  });

  // 2) block score per (employee × sub-team).
  var blockScore = {};
  Object.keys(blocks).forEach(function (key) {
    var recs = blocks[key];
    var sw = 0, sr = 0, sp = 0, withData = 0;
    recs.forEach(function (r) {
      if (r.rating != null && r.weightNorm != null) { sw += r.weightNorm; sr += r.weightNorm * r.rating; sp += r.weightNorm * r.scorePct; withData++; }
    });
    blockScore[key] = { rating: sw > 0 ? round2_(sr / sw) : null, score: sw > 0 ? round1_(sp / sw) : null, total: recs.length, withData: withData };
  });

  // 3) employees — including the KRA and perspective breakdown behind the score.
  ctx.employees.forEach(function (e) {
    var subs = e.subTeamIds.length ? e.subTeamIds : ['na'];
    var ratings = [], scores = [], total = 0, withData = 0;
    subs.forEach(function (sid) {
      var bs = blockScore[e.id + '|' + sid]; if (!bs) return;
      if (bs.rating != null) ratings.push(bs.rating);
      if (bs.score != null) scores.push(bs.score);
      total += bs.total; withData += bs.withData;
    });
    var mine = ctx.records.filter(function (r) { return r.employeeId === e.id; });
    var tally = statusTally_(mine);
    e.rating = ratings.length ? round2_(avg_(ratings)) : null;
    e.score = scores.length ? round1_(avg_(scores)) : null;
    e.points = round1_(sumBy_(mine, 'points'));
    e.maxPoints = round1_(sumBy_(mine, 'maxPoints'));
    e.kpiTotal = total; e.kpiWithData = withData;
    e.coverage = total ? round1_(withData / total * 100) : 0;
    e.onTrack = tally.onTrack; e.atRisk = tally.atRisk; e.offTrack = tally.offTrack;
    e.status = statusFromRating_(e.rating, scale);
    e.level = levelFromRating_(e.rating);
    e.kras = groupScore_(mine, 'kra', settings);                 // KRA score (spec §13)
    e.perspectives = groupScore_(mine, 'perspective', settings); // perspective score (spec §9)
    e.trend = []; e.delta = null; e.consistency = 0;   // filled by computeTrends_
  });

  // 4) sub-teams.
  ctx.subTeams.forEach(function (s) {
    var rs = [], ss = [], people = 0, withData = 0;
    ctx.employees.forEach(function (e) {
      var bs = blockScore[e.id + '|' + s.id]; if (!bs) return;
      people++;
      if (bs.rating != null) { rs.push(bs.rating); withData++; }
      if (bs.score != null) ss.push(bs.score);
    });
    s.rating = rs.length ? round2_(avg_(rs)) : null;
    s.score = ss.length ? round1_(avg_(ss)) : null;
    s.people = people; s.peopleWithData = withData;
    s.status = statusFromRating_(s.rating, scale);
  });

  // 5) departments.
  ctx.depts.forEach(function (d) {
    var emps = ctx.employees.filter(function (e) { return e.deptId === d.id; });
    var rs = emps.map(function (e) { return e.rating; }).filter(function (x) { return x != null; });
    var ss = emps.map(function (e) { return e.score; }).filter(function (x) { return x != null; });
    d.employeeCount = emps.length;
    d.rating = rs.length ? round2_(avg_(rs)) : null;
    d.score = ss.length ? round1_(avg_(ss)) : null;
    d.peopleWithData = rs.length;
    d.status = statusFromRating_(d.rating, scale);
    d.level = levelFromRating_(d.rating);
    d.trend = []; d.delta = null;                      // filled by computeTrends_
    var drecs = ctx.records.filter(function (r) { return r.deptId === d.id; });
    var dt = statusTally_(drecs);
    d.recOnTrack = dt.onTrack; d.recAtRisk = dt.atRisk; d.recOffTrack = dt.offTrack;
    d.perspectives = groupScore_(drecs, 'perspective', settings);
    d.subTeamIds = ctx.subTeams.filter(function (s) { return s.deptId === d.id; }).map(function (s) { return s.id; });
  });

  // 6) org.
  var allR = ctx.employees.map(function (e) { return e.rating; }).filter(function (x) { return x != null; });
  var allS = ctx.employees.map(function (e) { return e.score; }).filter(function (x) { return x != null; });
  var recWith = ctx.records.filter(function (r) { return r.hasActual; }).length;
  var orgRating = allR.length ? round2_(avg_(allR)) : null;
  var peopleTally = statusTally_(ctx.employees);
  var recTally = statusTally_(ctx.records);
  ctx.rollups = {
    org: {
      rating: orgRating,
      score: allS.length ? round1_(avg_(allS)) : null,
      status: statusFromRating_(orgRating, scale),
      level: levelFromRating_(orgRating),
      departments: ctx.depts.filter(function (d) { return d.kind !== 'info'; }).length,
      people: ctx.employees.length, peopleWithData: allR.length,
      kpis: ctx.records.length, kpisWithData: recWith,
      coverage: ctx.records.length ? round1_(recWith / ctx.records.length * 100) : 0,
      // people-level status counts
      onTrack: peopleTally.onTrack, atRisk: peopleTally.atRisk, offTrack: peopleTally.offTrack,
      peopleOnTrackPct: allR.length ? round1_(peopleTally.onTrack / allR.length * 100) : 0,
      // KPI-instance status counts (the "How are we performing" tallies)
      recOnTrack: recTally.onTrack, recAtRisk: recTally.atRisk, recOffTrack: recTally.offTrack,
      recOnTrackPct: recWith ? round1_(recTally.onTrack / recWith * 100) : 0,
      // filled by computeTrends_
      trend: [], delta: null, periods: [], movers: []
    }
  };
}

/* On Track counts everything at or above the On Track cut-off — Strong and
 * Exceeding are better than On Track, not separate from it. */
function statusTally_(items) {
  var t = { onTrack: 0, atRisk: 0, offTrack: 0, pending: 0 };
  items.forEach(function (x) {
    var k = x.status && x.status.k;
    if (!k || k === 'none') { t.pending++; return; }
    if (k === 'good' || k === 'strong' || k === 'elite') t.onTrack++;
    else if (k === 'warn') t.atRisk++;
    else t.offTrack++;
  });
  return t;
}
function sumBy_(items, field) {
  var s = 0, any = false;
  items.forEach(function (x) { if (x[field] != null) { s += x[field]; any = true; } });
  return any ? s : null;
}
/* Weighted score for an arbitrary grouping of records (KRA, perspective, …),
 * in both currencies, so any tier of the hierarchy can be read the same way. */
function groupScore_(recs, field, settings) {
  var map = {};
  recs.forEach(function (r) {
    var key = r[field] || (field === 'kra' ? (r.kpi || 'General') : (r.kra || 'General'));
    var m = map[key] || (map[key] = { name: key, sw: 0, sr: 0, sp: 0, kpis: 0, withData: 0, weight: 0, points: 0 });
    m.kpis++;
    if (r.weightShown != null) m.weight += r.weightShown;
    if (r.points != null) m.points += r.points;
    if (r.rating != null && r.weightNorm != null) { m.sw += r.weightNorm; m.sr += r.weightNorm * r.rating; m.sp += r.weightNorm * r.scorePct; m.withData++; }
  });
  return Object.keys(map).map(function (k) {
    var m = map[k];
    var rating = m.sw > 0 ? round2_(m.sr / m.sw) : null;
    return {
      name: m.name, rating: rating,
      score: m.sw > 0 ? round1_(m.sp / m.sw) : null,
      kpis: m.kpis, withData: m.withData,
      weight: round1_(m.weight), points: round1_(m.points),
      status: statusFromRating_(rating, settings.statusScale)
    };
  }).sort(function (a, b) { return (b.rating == null ? -1 : b.rating) - (a.rating == null ? -1 : a.rating); });
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
    if (a.actual != null) return ratingFromBands_(r.bands, a.actual, r.directionKey);
    if (a.rating != null) return clamp_(a.rating, 1, 5);
    return null;
  }
  function actualAt(r, p) { var a = all.byKey[r.kpiId + '|' + p] || (p === current ? all.byKey[r.kpiId + '|'] : null); return a && a.actual != null ? a.actual : null; }

  // per-record history + delta (current vs the period immediately before it).
  var prev = null; for (var i = show.length - 1; i >= 0; i--) { if (show[i] === current && i > 0) { prev = show[i - 1]; break; } }
  if (prev == null && show.length >= 2 && show[show.length - 1] === current) prev = show[show.length - 2];
  ctx.records.forEach(function (r) {
    r.history = show.map(function (p) {
      var rt = recRatingAt(r, p);
      return { period: p, rating: rt, score: scoreFromRating_(rt, settings.scoring), actual: actualAt(r, p) };
    });
    var cur = recRatingAt(r, current), pr = prev ? recRatingAt(r, prev) : null;
    r.delta = (cur != null && pr != null) ? round2_(cur - pr) : null;
    r.scoreDelta = (cur != null && pr != null) ? round1_(scoreFromRating_(cur, settings.scoring) - scoreFromRating_(pr, settings.scoring)) : null;
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
    e.trend = show.map(function (p) { return { period: p, rating: empPer[e.id][p], score: scoreFromRating_(empPer[e.id][p], settings.scoring) }; });
    var cur = empPer[e.id][current], pr = prev ? empPer[e.id][prev] : null;
    e.delta = (cur != null && pr != null) ? round2_(cur - pr) : null;
    e.scoreDelta = (cur != null && pr != null) ? round1_(scoreFromRating_(cur, settings.scoring) - scoreFromRating_(pr, settings.scoring)) : null;
    // consistency streak: consecutive periods (ending at current) rated On Track.
    var streak = 0; for (var i = show.length - 1; i >= 0; i--) { var v = empPer[e.id][show[i]]; if (v != null && v >= th.onTrack) streak++; else break; }
    e.consistency = streak;
  });

  // dept + org trends = mean of member ratings per period.
  function meanAt(emps, p) { var xs = emps.map(function (e) { return empPer[e.id][p]; }).filter(function (x) { return x != null; }); return xs.length ? round2_(avg_(xs)) : null; }
  ctx.depts.forEach(function (d) {
    var emps = ctx.employees.filter(function (e) { return e.deptId === d.id; });
    d.trend = show.map(function (p) { var v = meanAt(emps, p); return { period: p, rating: v, score: scoreFromRating_(v, settings.scoring) }; });
    var cur = meanAt(emps, current), pr = prev ? meanAt(emps, prev) : null;
    d.delta = (cur != null && pr != null) ? round2_(cur - pr) : null;
  });
  var org = ctx.rollups.org;
  org.periods = show;
  org.trend = show.map(function (p) { var v = meanAt(ctx.employees, p); return { period: p, rating: v, score: scoreFromRating_(v, settings.scoring) }; });
  var oc = meanAt(ctx.employees, current), op = prev ? meanAt(ctx.employees, prev) : null;
  org.delta = (oc != null && op != null) ? round2_(oc - op) : null;
  org.scoreDelta = (oc != null && op != null) ? round1_(scoreFromRating_(oc, settings.scoring) - scoreFromRating_(op, settings.scoring)) : null;

  // biggest movers (people with a computable delta), best & worst.
  org.movers = ctx.employees.filter(function (e) { return e.delta != null; })
    .map(function (e) { return { id: e.id, name: e.name, department: e.department, rating: e.rating, score: e.score, delta: e.delta, status: e.status }; })
    .sort(function (a, b) { return b.delta - a.delta; });
  org.previousPeriod = prev;
}

/** ==================================================== PERSPECTIVE ROLL-UP */
/* Preserve BOTH Perspective and KRA — aggregate ratings by Perspective across
 * the whole framework (weightNorm-weighted), with the KRAs that sit under each. */
function perspectiveRollup_(ctx, settings) {
  var map = {};
  ctx.records.forEach(function (r) {
    var p = r.perspective || r.kra || 'General';
    var m = map[p] || (map[p] = { perspective: p, sw: 0, sr: 0, sp: 0, kpis: 0, withData: 0, weight: 0, people: {}, kras: {}, recs: [] });
    m.kpis++; m.people[r.employeeId] = true; m.recs.push(r);
    if (r.kra) m.kras[r.kra] = true;
    if (r.weightShown != null) m.weight += r.weightShown;
    if (r.rating != null && r.weightNorm != null) { m.sw += r.weightNorm; m.sr += r.weightNorm * r.rating; m.sp += r.weightNorm * r.scorePct; m.withData++; }
  });
  return Object.keys(map).map(function (k) {
    var m = map[k];
    var rating = m.sw > 0 ? round2_(m.sr / m.sw) : null;
    return {
      perspective: k, rating: rating,
      score: m.sw > 0 ? round1_(m.sp / m.sw) : null,
      kpis: m.kpis, withData: m.withData,
      people: Object.keys(m.people).length,
      kras: Object.keys(m.kras),
      kraScores: groupScore_(m.recs, 'kra', settings),
      status: statusFromRating_(rating, settings.statusScale)
    };
  }).sort(function (a, b) { return (b.rating == null ? -1 : b.rating) - (a.rating == null ? -1 : a.rating); });
}

/** ==================================================== MASTER-DATA HEALTH */
/* Admin validation surfaced before an overall score is trusted: weightage that
 * doesn't total 100% per person-block, KPIs without numeric bands, actual rows
 * that map to no KPI, and coverage. */
function computeHealth_(ctx, all, assignments, reviews, period) {
  var blocks = {};
  ctx.records.forEach(function (r) {
    var k = r.employeeId + '|' + (r.subTeamId || 'na');
    (blocks[k] = blocks[k] || { recs: [], emp: r.employee, dept: r.department, sub: r.subTeam }).recs.push(r);
  });
  /* Spec §6: total KPI weightage per person per cycle must be 100%. This is
   * validation logic, not a manual rule — every block is checked and the ones
   * that fail are named, because an overall score built on a block that does
   * not total 100% is not comparable with one that does. */
  var weightIssues = [];
  Object.keys(blocks).forEach(function (k) {
    var b = blocks[k], sum = 0, has = false;
    b.recs.forEach(function (r) { if (r.weight != null) { sum += r.weight; has = true; } });
    if (has) {
      var norm = sum > 2 ? sum : sum * 100;            // handle fraction-weighted sheets
      if (Math.abs(norm - 100) >= 0.5) weightIssues.push({ employee: b.emp, dept: b.dept, subTeam: b.sub || '', sum: round1_(norm), kpis: b.recs.length, gap: round1_(norm - 100) });
    }
  });
  var missingBands = ctx.records.filter(function (r) { return r.qualitative; }).length;
  var ids = {}; ctx.records.forEach(function (r) { ids[r.kpiId] = true; });
  var seen = {}, unmapped = 0;
  Object.keys(all.byKey).forEach(function (key) { var id = key.slice(0, key.lastIndexOf('|')); if (id && !ids[id] && !seen[id]) { seen[id] = true; unmapped++; } });
  var withData = ctx.records.filter(function (r) { return r.hasActual; }).length;
  var noWeight = ctx.records.filter(function (r) { return r.weight == null; }).length;
  // Direction drives the rating; an inferred one is a guess worth surfacing.
  var inferredDirection = ctx.records.filter(function (r) { return r.directionSource !== 'declared' && !r.qualitative; }).length;
  var lowerIsBetter = ctx.records.filter(function (r) { return r.directionKey === 'lower'; }).length;
  var exactKpis = ctx.records.filter(function (r) { return r.directionKey === 'exact'; }).length;
  var assignedThisPeriod = 0;
  Object.keys((assignments && assignments.byKey) || {}).forEach(function (k) { if (k.slice(k.lastIndexOf('|') + 1) === period) assignedThisPeriod++; });

  return {
    weightIssues: weightIssues,
    qualitative: missingBands,
    noWeight: noWeight,
    unmappedActuals: unmapped,
    inferredDirection: inferredDirection,
    lowerIsBetter: lowerIsBetter,
    exactKpis: exactKpis,
    assignments: assignedThisPeriod,
    bandOverrides: ctx.records.filter(function (r) { return r.bandSource === 'assignment'; }).length,
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
/** ==================================================== PERFORMANCE CYCLES */
/* A cycle is the container the whole product hangs off: it owns the window,
 * the KPI assignments, the actuals, the check-ins and the review. Locking one
 * freezes it — nothing downstream may write to a locked cycle. */
function CYCLES_HEADERS_() {
  return ['Period', 'Name', 'StartDate', 'EndDate', 'Status', 'ReviewDue', 'Note', 'UpdatedAt', 'UpdatedBy'];
}
function ensureSheet_(tab, headers) {
  var ss = SpreadsheetApp.openById(SOURCE_SPREADSHEET_ID);
  var sh = ss.getSheetByName(tab);
  if (!sh) { sh = ss.insertSheet(tab); sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold'); sh.setFrozenRows(1); }
  else if (sh.getLastRow() === 0) sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
  return sh;
}
function readCycles_() {
  var out = { byPeriod: {}, list: [] };
  var sh = null;
  try { sh = SpreadsheetApp.openById(SOURCE_SPREADSHEET_ID).getSheetByName(CYCLES_TAB); } catch (e) {}
  if (!sh) return out;
  var data = safeValues_(sh);
  if (data.length < 2) return out;
  var col = {}; data[0].forEach(function (h, i) { col[norm_(h)] = i; });
  for (var i = 1; i < data.length; i++) {
    var period = cell_(data[i], col['period']);
    if (!period) continue;
    var c = {
      period: period,
      name: cell_(data[i], col['name']) || periodLabel_(period),
      startDate: dateStr_(data[i][col['startdate']]),
      endDate: dateStr_(data[i][col['enddate']]),
      status: cell_(data[i], col['status']) || 'Active',
      reviewDue: dateStr_(data[i][col['reviewdue']]),
      note: cell_(data[i], col['note']),
      updatedAt: cell_(data[i], col['updatedat'])
    };
    if (CYCLE_STATES.indexOf(c.status) < 0) c.status = 'Active';
    c.locked = c.status === 'Locked';
    out.byPeriod[period] = c; out.list.push(c);
  }
  out.list.sort(function (a, b) { return a.period < b.period ? 1 : -1; });
  return out;
}
/* A period with no row yet still behaves like a real cycle — derived from the
 * period itself — so the product works before anyone opens the admin screen. */
function cycleFor_(cycles, period) {
  if (cycles.byPeriod[period]) return cycles.byPeriod[period];
  var m = /^(\d{4})-(\d{2})$/.exec(period || '');
  var start = '', end = '';
  if (m) {
    var y = +m[1], mo = +m[2];
    start = m[1] + '-' + m[2] + '-01';
    end = Utilities.formatDate(new Date(y, mo, 0), 'UTC', 'yyyy-MM-dd');
  }
  return { period: period, name: periodLabel_(period), startDate: start, endDate: end, status: 'Active', reviewDue: '', note: '', locked: false, implicit: true };
}
function apiSaveCycle(p) {
  p = p || {};
  try {
    if (!p.period) throw new Error('Missing period.');
    if (p.status && CYCLE_STATES.indexOf(p.status) < 0) throw new Error('Unknown cycle status: ' + p.status);
    var sh = ensureSheet_(CYCLES_TAB, CYCLES_HEADERS_());
    var data = sh.getDataRange().getValues();
    var head = data[0], col = {}; head.forEach(function (h, i) { col[h] = i; });
    var row = -1;
    for (var i = 1; i < data.length; i++) if (String(data[i][col.Period]).trim() === String(p.period).trim()) { row = i; break; }
    var rec = row >= 0 ? data[row].slice() : head.map(function () { return ''; });
    rec[col.Period] = p.period;
    if (p.name      !== undefined) rec[col.Name]      = String(p.name || '');
    if (p.startDate !== undefined) rec[col.StartDate] = String(p.startDate || '');
    if (p.endDate   !== undefined) rec[col.EndDate]   = String(p.endDate || '');
    if (p.status    !== undefined) rec[col.Status]    = String(p.status || 'Active');
    if (p.reviewDue !== undefined) rec[col.ReviewDue] = String(p.reviewDue || '');
    if (p.note      !== undefined) rec[col.Note]      = String(p.note || '');
    if (!rec[col.Name]) rec[col.Name] = periodLabel_(p.period);
    if (!rec[col.Status]) rec[col.Status] = 'Active';
    rec[col.UpdatedAt] = nowIso_(); rec[col.UpdatedBy] = safeEmail_();
    if (row >= 0) sh.getRange(row + 1, 1, 1, head.length).setValues([rec]);
    else          sh.getRange(sh.getLastRow() + 1, 1, 1, head.length).setValues([rec]);
    bustCache_(p.period);
    return { ok: true, period: p.period, status: rec[col.Status] };
  } catch (err) { return { ok: false, error: String(err && err.message || err) }; }
}

/** ==================================================== KPI ASSIGNMENTS */
/* The assignment is the employee × cycle × KPI join. It is what makes the same
 * KPI definition carry a different weight — or a different target ladder — for
 * two people, and what preserves the bands a past cycle was actually judged on. */
function ASSIGNMENTS_HEADERS_() {
  return ['KpiId', 'Period', 'Employee', 'KPI', 'Weight%', 'Direction',
          'Target1', 'Target2', 'Target3', 'Target4', 'Target5',
          'Reviewer', 'Note', 'UpdatedAt', 'UpdatedBy'];
}
function readAssignments_() {
  var out = { byKey: {}, rows: 0, periods: {} };
  var sh = null;
  try { sh = SpreadsheetApp.openById(SOURCE_SPREADSHEET_ID).getSheetByName(ASSIGNMENTS_TAB); } catch (e) {}
  if (!sh) return out;
  var data = safeValues_(sh);
  if (data.length < 2) return out;
  var col = {}; data[0].forEach(function (h, i) { col[norm_(h)] = i; });
  if (col['kpiid'] == null) return out;
  for (var i = 1; i < data.length; i++) {
    var id = cell_(data[i], col['kpiid']);
    if (!id) continue;
    var per = cell_(data[i], col['period']);
    var bands = [];
    for (var b = 1; b <= 5; b++) { var ci = col['target' + b]; bands.push(ci == null ? '' : cleanCell_(data[i][ci])); }
    var hasBand = bands.some(function (x) { return x !== ''; });
    out.byKey[id + '|' + per] = {
      weight: col['weight%'] != null ? parseNum_(data[i][col['weight%']]) : null,
      direction: cell_(data[i], col['direction']),
      bands: hasBand ? bands : null,
      reviewer: cell_(data[i], col['reviewer']),
      note: cell_(data[i], col['note'])
    };
    out.rows++;
    if (per) out.periods[per] = true;
  }
  return out;
}
function apiSaveAssignment(p) {
  p = p || {};
  try {
    if (!p.kpiId) throw new Error('Missing kpiId.');
    var settings = readSettings_();
    var period = p.period || settings.period || currentPeriod_();
    assertUnlocked_(period);
    var sh = ensureSheet_(ASSIGNMENTS_TAB, ASSIGNMENTS_HEADERS_());
    var data = sh.getDataRange().getValues();
    var head = data[0], col = {}; head.forEach(function (h, i) { col[h] = i; });
    var row = -1;
    for (var i = 1; i < data.length; i++) if (data[i][col.KpiId] === p.kpiId && String(data[i][col.Period]) === String(period)) { row = i; break; }
    var rec = row >= 0 ? data[row].slice() : head.map(function () { return ''; });
    rec[col.KpiId] = p.kpiId; rec[col.Period] = period;
    if (p.employee  !== undefined) rec[col.Employee]  = String(p.employee || '');
    if (p.kpi       !== undefined) rec[col.KPI]       = String(p.kpi || '');
    if (p.weight    !== undefined) rec[col['Weight%']] = p.weight === '' ? '' : num_(p.weight);
    if (p.direction !== undefined) rec[col.Direction] = String(p.direction || '');
    if (p.reviewer  !== undefined) rec[col.Reviewer]  = String(p.reviewer || '');
    if (p.note      !== undefined) rec[col.Note]      = String(p.note || '');
    if (p.bands !== undefined && p.bands) for (var b = 1; b <= 5; b++) rec[col['Target' + b]] = p.bands[b - 1] == null ? '' : String(p.bands[b - 1]);
    rec[col.UpdatedAt] = nowIso_(); rec[col.UpdatedBy] = safeEmail_();
    if (row >= 0) sh.getRange(row + 1, 1, 1, head.length).setValues([rec]);
    else          sh.getRange(sh.getLastRow() + 1, 1, 1, head.length).setValues([rec]);
    bustCache_(period);
    return { ok: true, kpiId: p.kpiId, period: period };
  } catch (err) { return { ok: false, error: String(err && err.message || err) }; }
}

/** ==================================================== CHECK-INS (HISTORY) */
/* Append-only. A check-in never overwrites the previous one — the progression
 * through the period is the point. The latest check-in for a KPI × period is
 * what the actuals row reflects; the rest is the audit trail. */
function CHECKINS_HEADERS_() {
  return ['CheckinId', 'KpiId', 'Period', 'Date', 'Employee', 'KPI', 'Actual', 'Rating', 'Comment', 'Evidence', 'By', 'At'];
}
function readCheckins_() {
  var out = { byKey: {}, rows: 0, recent: [] };
  var sh = null;
  try { sh = SpreadsheetApp.openById(SOURCE_SPREADSHEET_ID).getSheetByName(CHECKINS_TAB); } catch (e) {}
  if (!sh) return out;
  var data = safeValues_(sh);
  if (data.length < 2) return out;
  var col = {}; data[0].forEach(function (h, i) { col[norm_(h)] = i; });
  if (col['kpiid'] == null) return out;
  for (var i = 1; i < data.length; i++) {
    var id = cell_(data[i], col['kpiid']);
    if (!id) continue;
    var per = cell_(data[i], col['period']);
    var c = {
      id: cell_(data[i], col['checkinid']),
      kpiId: id, period: per,
      date: dateStr_(data[i][col['date']]),
      employee: cell_(data[i], col['employee']),
      kpi: cell_(data[i], col['kpi']),
      actual: col['actual'] != null ? parseNum_(data[i][col['actual']]) : null,
      rating: col['rating'] != null ? parseNum_(data[i][col['rating']]) : null,
      comment: cell_(data[i], col['comment']),
      evidence: cell_(data[i], col['evidence']),
      by: cell_(data[i], col['by']),
      at: cell_(data[i], col['at'])
    };
    (out.byKey[id + '|' + per] = out.byKey[id + '|' + per] || []).push(c);
    out.recent.push(c);
    out.rows++;
  }
  Object.keys(out.byKey).forEach(function (k) {
    out.byKey[k].sort(function (a, b) { return String(a.at || a.date) < String(b.at || b.date) ? -1 : 1; });
  });
  out.recent.sort(function (a, b) { return String(b.at || b.date) < String(a.at || a.date) ? -1 : 1; });
  return out;
}
/* Record a check-in AND move the actuals row to the latest value, so the two
 * stay consistent without the caller making two round-trips. */
function apiSaveCheckin(p) {
  p = p || {};
  try {
    if (!p.kpiId) throw new Error('Missing kpiId.');
    var settings = readSettings_();
    var period = p.period || settings.period || currentPeriod_();
    assertUnlocked_(period);
    var sh = ensureSheet_(CHECKINS_TAB, CHECKINS_HEADERS_());
    var head = CHECKINS_HEADERS_(), col = {}; head.forEach(function (h, i) { col[h] = i; });
    var rec = head.map(function () { return ''; });
    rec[col.CheckinId] = 'ci_' + new Date().getTime() + '_' + Math.floor(Math.random() * 1000);
    rec[col.KpiId] = p.kpiId;
    rec[col.Period] = period;
    rec[col.Date] = p.date || Utilities.formatDate(new Date(), Session.getScriptTimeZone() || 'Asia/Kolkata', 'yyyy-MM-dd');
    rec[col.Employee] = String(p.employee || '');
    rec[col.KPI] = String(p.kpi || '');
    rec[col.Actual] = (p.actual === '' || p.actual == null) ? '' : num_(p.actual);
    rec[col.Rating] = (p.rating === '' || p.rating == null) ? '' : clamp_(num_(p.rating), 1, 5);
    rec[col.Comment] = String(p.comment || '');
    rec[col.Evidence] = String(p.evidence || '');
    rec[col.By] = safeEmail_();
    rec[col.At] = nowIso_();
    sh.getRange(sh.getLastRow() + 1, 1, 1, head.length).setValues([rec]);

    // roll the check-in forward into the actuals row (the current position).
    var fwd = { kpiId: p.kpiId, period: period, comment: p.comment, evidence: p.evidence };
    if (p.actual !== undefined && p.actual !== '') fwd.actual = p.actual;
    if (p.rating !== undefined && p.rating !== '') fwd.rating = p.rating;
    apiSaveActual(fwd);
    bustCache_(period);
    return { ok: true, kpiId: p.kpiId, period: period, checkinId: rec[col.CheckinId] };
  } catch (err) { return { ok: false, error: String(err && err.message || err) }; }
}

/** ==================================================== REVIEWS */
/* The review sits on top of the computed score — it never replaces it. The
 * system result is shown first; self and manager add context and an assessment;
 * the final rating is an explicit, attributable decision. */
function REVIEWS_HEADERS_() {
  return ['Period', 'EmployeeId', 'Employee', 'Department', 'SystemRating', 'SystemScore',
          'SelfRating', 'SelfComment', 'SelfBy', 'SelfAt',
          'ManagerRating', 'ManagerComment', 'ManagerBy', 'ManagerAt',
          'FinalRating', 'FinalComment', 'Status', 'UpdatedAt', 'UpdatedBy'];
}
function readReviews_() {
  var out = { byKey: {}, rows: 0 };
  var sh = null;
  try { sh = SpreadsheetApp.openById(SOURCE_SPREADSHEET_ID).getSheetByName(REVIEWS_TAB); } catch (e) {}
  if (!sh) return out;
  var data = safeValues_(sh);
  if (data.length < 2) return out;
  var col = {}; data[0].forEach(function (h, i) { col[norm_(h)] = i; });
  if (col['employeeid'] == null) return out;
  for (var i = 1; i < data.length; i++) {
    var eid = cell_(data[i], col['employeeid']);
    if (!eid) continue;
    var per = cell_(data[i], col['period']);
    out.byKey[eid + '|' + per] = {
      employeeId: eid, period: per,
      selfRating: col['selfrating'] != null ? parseNum_(data[i][col['selfrating']]) : null,
      selfComment: cell_(data[i], col['selfcomment']),
      selfBy: cell_(data[i], col['selfby']), selfAt: cell_(data[i], col['selfat']),
      managerRating: col['managerrating'] != null ? parseNum_(data[i][col['managerrating']]) : null,
      managerComment: cell_(data[i], col['managercomment']),
      managerBy: cell_(data[i], col['managerby']), managerAt: cell_(data[i], col['managerat']),
      finalRating: col['finalrating'] != null ? parseNum_(data[i][col['finalrating']]) : null,
      finalComment: cell_(data[i], col['finalcomment']),
      status: cell_(data[i], col['status']) || 'Not Started',
      updatedAt: cell_(data[i], col['updatedat'])
    };
    out.rows++;
  }
  return out;
}
/* stage: 'self' | 'manager' | 'final'. Each stage advances the workflow state
 * but never rewrites an earlier stage's comment or attribution. */
function apiSaveReview(p) {
  p = p || {};
  try {
    if (!p.employeeId) throw new Error('Missing employeeId.');
    var stage = String(p.stage || '').toLowerCase();
    if (['self', 'manager', 'final'].indexOf(stage) < 0) throw new Error('Unknown review stage: ' + p.stage);
    var settings = readSettings_();
    var period = p.period || settings.period || currentPeriod_();
    assertUnlocked_(period);
    var sh = ensureSheet_(REVIEWS_TAB, REVIEWS_HEADERS_());
    var data = sh.getDataRange().getValues();
    var head = data[0], col = {}; head.forEach(function (h, i) { col[h] = i; });
    var row = -1;
    for (var i = 1; i < data.length; i++) if (data[i][col.EmployeeId] === p.employeeId && String(data[i][col.Period]) === String(period)) { row = i; break; }
    var rec = row >= 0 ? data[row].slice() : head.map(function () { return ''; });
    rec[col.Period] = period; rec[col.EmployeeId] = p.employeeId;
    if (p.employee   !== undefined) rec[col.Employee]   = String(p.employee || '');
    if (p.department !== undefined) rec[col.Department] = String(p.department || '');
    if (p.systemRating !== undefined) rec[col.SystemRating] = p.systemRating === '' ? '' : num_(p.systemRating);
    if (p.systemScore  !== undefined) rec[col.SystemScore]  = p.systemScore === '' ? '' : num_(p.systemScore);

    var now = nowIso_(), who = safeEmail_();
    if (stage === 'self') {
      if (p.rating  !== undefined) rec[col.SelfRating]  = p.rating === '' ? '' : clamp_(num_(p.rating), 1, 5);
      if (p.comment !== undefined) rec[col.SelfComment] = String(p.comment || '');
      rec[col.SelfBy] = who; rec[col.SelfAt] = now;
      if (p.submit) rec[col.Status] = 'Manager Review';
      else if (!rec[col.Status] || rec[col.Status] === 'Not Started') rec[col.Status] = 'Self Review';
    } else if (stage === 'manager') {
      if (p.rating  !== undefined) rec[col.ManagerRating]  = p.rating === '' ? '' : clamp_(num_(p.rating), 1, 5);
      if (p.comment !== undefined) rec[col.ManagerComment] = String(p.comment || '');
      rec[col.ManagerBy] = who; rec[col.ManagerAt] = now;
      if (p.submit) rec[col.Status] = 'Final Review';
      else rec[col.Status] = 'Manager Review';
    } else {
      if (p.rating  !== undefined) rec[col.FinalRating]  = p.rating === '' ? '' : clamp_(num_(p.rating), 1, 5);
      if (p.comment !== undefined) rec[col.FinalComment] = String(p.comment || '');
      rec[col.Status] = p.submit ? 'Complete' : 'Final Review';
    }
    rec[col.UpdatedAt] = now; rec[col.UpdatedBy] = who;
    if (row >= 0) sh.getRange(row + 1, 1, 1, head.length).setValues([rec]);
    else          sh.getRange(sh.getLastRow() + 1, 1, 1, head.length).setValues([rec]);
    bustCache_(period);
    return { ok: true, employeeId: p.employeeId, period: period, status: rec[col.Status] };
  } catch (err) { return { ok: false, error: String(err && err.message || err) }; }
}

/* Guard every downstream write. A locked cycle is a closed book. */
function assertUnlocked_(period) {
  var c = readCycles_().byPeriod[period];
  if (c && c.status === 'Locked') throw new Error('Cycle ' + period + ' is locked. Reopen it in Performance Cycles to make changes.');
}

function actualsSourceInfo_(settings, all) {
  return {
    type: settings.actualsSheetId ? 'external' : 'managed',
    tab: settings.actualsSheetId ? (settings.actualsTab || ACTUALS_TAB) : ACTUALS_TAB,
    sheetId: settings.actualsSheetId || SOURCE_SPREADSHEET_ID,
    rows: all ? all.rows : 0
  };
}
/* Every period the product knows about: from actuals, from declared cycles and
 * from assignments — so a cycle set up in advance is selectable before a single
 * actual has been entered against it. */
function knownPeriods_(all, current, cycles, assignments) {
  var set = {}; set[current] = true;
  (all && all.periods || []).forEach(function (p) { if (p) set[p] = true; });
  ((cycles && cycles.list) || []).forEach(function (c) { if (c.period) set[c.period] = true; });
  Object.keys((assignments && assignments.periods) || {}).forEach(function (p) { if (p) set[p] = true; });
  return Object.keys(set).sort().reverse();
}

/** ==================================================== SETTINGS */
function readSettings_() {
  var s = {
    period: '',
    thresholds: { onTrack: DEFAULT_THRESHOLDS.onTrack, atRisk: DEFAULT_THRESHOLDS.atRisk },
    scoring: { ratingPct: DEFAULT_SCORING.ratingPct.slice(), interpolate: DEFAULT_SCORING.interpolate },
    statusScale: DEFAULT_STATUS_SCALE.map(function (x) { return { key: x.key, label: x.label, min: x.min }; }),
    actualsSheetId: '', actualsTab: ''
  };
  try {
    var raw = PropertiesService.getDocumentProperties().getProperty('KKT_SETTINGS') ||
              PropertiesService.getScriptProperties().getProperty('KKT_SETTINGS');
    if (raw) {
      var o = JSON.parse(raw);
      if (o) {
        s.period = o.period || '';
        if (o.thresholds) s.thresholds = o.thresholds;
        if (o.scoring && o.scoring.ratingPct && o.scoring.ratingPct.length === 5) s.scoring = o.scoring;
        if (o.statusScale && o.statusScale.length) s.statusScale = o.statusScale;
        s.actualsSheetId = o.actualsSheetId || '';
        s.actualsTab = o.actualsTab || '';
      }
    }
  } catch (e) {}
  if (!s.period) s.period = currentPeriod_();
  // keep the derived thresholds in step with the status scale, so the priority
  // maths and streak logic never disagree with the labels people see.
  var onT = statusMin_(s.statusScale, 'good'), atR = statusMin_(s.statusScale, 'warn');
  if (onT != null) s.thresholds.onTrack = onT;
  if (atR != null) s.thresholds.atRisk = atR;
  return s;
}
function statusMin_(scale, key) {
  for (var i = 0; i < scale.length; i++) if (scale[i].key === key) return num_(scale[i].min);
  return null;
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
/* A sheet date cell arrives as a Date; a typed one arrives as text. Normalise
 * both to yyyy-MM-dd so the UI never has to guess. */
function dateStr_(v) {
  if (v == null || v === '') return '';
  if (Object.prototype.toString.call(v) === '[object Date]' && !isNaN(v)) {
    try { return Utilities.formatDate(v, Session.getScriptTimeZone() || 'Asia/Kolkata', 'yyyy-MM-dd'); } catch (e) { return ''; }
  }
  return cleanCell_(v);
}
var MONTH_NAMES_ = ['', 'January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
function periodLabel_(p) {
  var m = /^(\d{4})-(\d{2})$/.exec(String(p || ''));
  return m ? (MONTH_NAMES_[+m[2]] + ' ' + m[1]) : String(p || '');
}
/* Scoring now depends on cycles, assignments, check-ins and reviews too, so any
 * write must clear the period it touched — plus the active one. */
function bustCache_(period) {
  try {
    var c = CacheService.getScriptCache(), s = readSettings_();
    var keys = {};
    keys[CACHE_PREFIX + (s.period || currentPeriod_())] = true;
    if (period) keys[CACHE_PREFIX + period] = true;
    c.removeAll(Object.keys(keys));
  } catch (e) {}
}
function errModel_(err) { return { ok: false, connected: false, empty: true, error: String(err && err.message || err), generatedAt: nowIso_() }; }
