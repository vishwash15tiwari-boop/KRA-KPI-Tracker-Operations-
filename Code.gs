/*******************************************************************************
 * RECYKAL — KRA / KPI PERFORMANCE TRACKER
 * -----------------------------------------------------------------------------
 * Backend (data access, normalisation, persistence, security, APIs).
 *
 * The source Google Sheet is the SINGLE SOURCE OF TRUTH for the KRA/KPI
 * framework (teams, KRAs, KPIs, weights, targets, units, direction). This file
 * NEVER invents business logic — it reads whatever the sheet defines and maps
 * it into one normalised model. Individuals' actuals / commentary / evidence
 * are persisted into managed tabs that this script auto-provisions, so the
 * original framework tabs are never modified.
 *
 * DESIGN CONTRACT
 *   - Code.gs         : parse + normalise the messy sheet into a clean model,
 *                       compute the data *primitives* (band values, direction,
 *                       target, weight, stable KpiId), persist actuals, secure
 *                       and expose the APIs. It does the "data calculations".
 *   - Index.html      : owns the SINGLE scoring engine (rating -> score ->
 *                       status -> roll-ups -> trends). There is exactly one
 *                       scoring implementation in the whole product, so there
 *                       is no duplicated calculation logic. The same engine runs
 *                       on live server data and on the offline preview mock.
 *
 * Supported dynamically (nothing below is hardcoded to today's data):
 *   - new teams / tabs, new individuals, new KRAs / KPIs, new weights & targets
 *   - both scorecard shapes (Metal/Plastic market scorecard, Onboarding/
 *     Collections per-individual blocks) + the POC roster tab
 ******************************************************************************/

/** ------------------------------------------------------------------ CONFIG */

var SOURCE_SPREADSHEET_ID = '1c0_pP4Mmye5s5D_vzoxrvJ-utkLb6JhD69TvvOBbjoo';

// Managed tabs this app owns (created on first run; framework tabs untouched).
var TAB_ACTUALS  = '_KKT_Actuals';   // individual actuals / commentary / evidence
var TAB_SETTINGS = '_KKT_Settings';  // status thresholds, current period, etc.

// Team leads (from the brief). Used to flag the lead + ensure they exist as a
// member even if absent from the roster (e.g. Tabesh for Plastic).
var TEAM_LEADS = {
  'Metal':       'Amit Jha',
  'Plastic':     'Tabesh',
  'Onboarding':  'Ajay',
  'Collections': 'Srinivas Reddy'
};

// Rating (0..5) thresholds -> status. Overridable in the _KKT_Settings tab.
var DEFAULT_SETTINGS = {
  onTrack: 3.0,          // rating >= 3.0  -> On Track   (meets expectation+)
  atRisk:  2.0,          // rating >= 2.0  -> At Risk
  targetBandLevel: 3,    // band level treated as the "target" (Meets Exp.)
  currentPeriod: ''      // 'YYYY-MM'; '' -> latest period with data / this month
};

var CACHE_KEY = 'kkt_model_v3';
var CACHE_TTL = 21600;   // 6h; invalidated on save/reset

/** -------------------------------------------------------------- WEB ENTRY */

function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('Recykal · KRA / KPI Tracker')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/** ---------------------------------------------------------------- PUBLIC API
 * Everything the client needs in ONE round-trip. Reads are batched and the
 * parsed framework is cached; actuals are always read fresh.
 */
function apiBootstrap(opts) {
  opts = opts || {};
  try {
    var model    = getFrameworkModel(!!opts.force);      // cached parse
    var settings = readSettings();
    var store    = readActuals();                        // {key -> record}, periods

    var periods = uniqueSorted(store.periods.concat(defaultPeriods_()));
    var current = settings.currentPeriod && periods.indexOf(settings.currentPeriod) >= 0
      ? settings.currentPeriod
      : (periods.length ? periods[periods.length - 1] : thisMonth_());

    return {
      ok: true,
      generatedAt: new Date().toISOString(),
      user: safeUser_(),
      settings: {
        onTrack: settings.onTrack,
        atRisk: settings.atRisk,
        targetBandLevel: settings.targetBandLevel,
        currentPeriod: current
      },
      periods: periods,
      teams: model.teams,
      members: model.members,
      kpis: model.kpis,
      actuals: store.map
    };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
}

/**
 * Upsert a single actual (+ optional commentary / evidence / manual rating).
 * Returns the fresh bootstrap so the client always renders server truth.
 * payload: {memberId, kpiId, period, actual, rating, commentary, evidence}
 */
function apiSaveActual(payload) {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000);
    if (!payload || !payload.memberId || !payload.kpiId || !payload.period) {
      throw new Error('memberId, kpiId and period are required.');
    }
    var sh = ensureActualsSheet_();
    var data = sh.getDataRange().getValues();
    var header = data[0];
    var idx = colIndex_(header);
    var key = actualKey_(payload.memberId, payload.kpiId, payload.period);

    var rowNum = -1;
    for (var r = 1; r < data.length; r++) {
      var k = actualKey_(data[r][idx.MemberId], data[r][idx.KpiId], data[r][idx.Period]);
      if (k === key) { rowNum = r + 1; break; }
    }

    var now  = new Date();
    var who  = safeUser_().email || 'unknown';
    var rowArr = buildActualRow_(header, payload, who, now);

    if (rowNum === -1) {
      sh.appendRow(rowArr);
    } else {
      sh.getRange(rowNum, 1, 1, header.length).setValues([rowArr]);
    }
    invalidateCache_();
    return apiBootstrap({});
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  } finally {
    try { lock.releaseLock(); } catch (e) {}
  }
}

/** Persist a settings change (thresholds / current period). */
function apiSaveSettings(patch) {
  try {
    var s = readSettings();
    patch = patch || {};
    if (patch.currentPeriod   != null) s.currentPeriod   = String(patch.currentPeriod);
    if (patch.onTrack         != null) s.onTrack         = Number(patch.onTrack);
    if (patch.atRisk          != null) s.atRisk          = Number(patch.atRisk);
    if (patch.targetBandLevel != null) s.targetBandLevel = Number(patch.targetBandLevel);
    writeSettings_(s);
    return apiBootstrap({});
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
}

/** Clear only the actuals (keeps the framework + settings). */
function apiClearActuals() {
  try {
    var ss = SpreadsheetApp.openById(SOURCE_SPREADSHEET_ID);
    var sh = ss.getSheetByName(TAB_ACTUALS);
    if (sh) ss.deleteSheet(sh);
    ensureActualsSheet_();
    invalidateCache_();
    return apiBootstrap({});
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
}

/**
 * One-click first-run setup: provision managed tabs and seed a few months of
 * realistic SAMPLE actuals so the dashboard is immediately alive. Safe to
 * re-run — it only seeds when the actuals tab is empty (unless force=true).
 */
function apiSeedSampleData(force) {
  try {
    ensureSettingsSheet_();
    var sh = ensureActualsSheet_();
    var hasData = sh.getLastRow() > 1;
    if (hasData && !force) return apiBootstrap({});
    if (hasData && force) { apiClearActuals(); sh = ensureActualsSheet_(); }
    seedSampleActuals_();
    invalidateCache_();
    return apiBootstrap({});
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
}

/** ============================================================ FRAMEWORK PARSE
 * Reads every tab, classifies it, and builds the normalised model:
 *   teams[]   {id,name,lead,type,segments[]}
 *   members[] {id,name,team,role,region,isLead}
 *   kpis[]    {id,kpiId,team,memberId,individual,segment,perspective,role,
 *              kra,kpi,definition,source,unit,weight,direction,target,bands[]}
 */
function getFrameworkModel(force) {
  var cache = CacheService.getScriptCache();
  if (!force) {
    var hit = cache.get(CACHE_KEY);
    if (hit) { try { return JSON.parse(hit); } catch (e) {} }
  }
  var model = parseFramework_();
  try { cache.put(CACHE_KEY, JSON.stringify(model), CACHE_TTL); } catch (e) {}
  return model;
}

function parseFramework_() {
  var ss = SpreadsheetApp.openById(SOURCE_SPREADSHEET_ID);
  var sheets = ss.getSheets();

  var teams = [];
  var members = [];
  var kpis = [];
  var pocRoster = {};   // teamName(UPPER) -> [{name,region}]
  var rosterSheets = [];
  var scorecardSheets = [];

  // Pass 1: classify sheets. POC-roster parsing runs on EVERY sheet (it is a
  // no-op unless the grid actually contains METAL/PLASTIC + Region/POC sections),
  // so a scorecard tab and a POC roster can even coexist on one sheet. A sheet
  // is then additionally treated as a KPI framework if it carries KPI headers.
  sheets.forEach(function (sheet) {
    var name = sheet.getName();
    if (name === TAB_ACTUALS || name === TAB_SETTINGS) return;
    var grid = sheet.getDataRange().getValues();
    if (!grid || !grid.length) return;

    parsePocRoster_(grid, pocRoster);

    var isPocOnly = looksLikePocRoster_(grid) && !hasScorecard_(grid) &&
                    !hasHeaderRow_(grid, ['kpi', 'weightage']);
    if (isPocOnly) return;

    if (hasHeaderRow_(grid, ['kpi', 'weightage']) &&
        hasAny_(grid, ['individual -', 'collections -', 'collections &'])) {
      rosterSheets.push({ name: name, grid: grid });
    } else if (hasScorecard_(grid)) {
      scorecardSheets.push({ name: name, grid: grid });
    } else if (hasHeaderRow_(grid, ['kpi', 'weightage'])) {
      // Fallback: header-driven roster even without explicit name markers.
      rosterSheets.push({ name: name, grid: grid });
    }
  });

  // Pass 2: scorecard teams (Metal / Plastic style — shared template).
  scorecardSheets.forEach(function (s) {
    try {
      var parsed = parseScorecardSheet_(s.name, s.grid);
      teams.push(parsed.team);
      var roster = pocRoster[s.name.toUpperCase()] || [];
      var mem = buildScorecardMembers_(s.name, roster);
      mem.forEach(function (m) { members.push(m); });
      // Expand the shared template across every member.
      mem.forEach(function (m) {
        parsed.templates.forEach(function (t) {
          kpis.push(expandTemplateForMember_(t, m));
        });
      });
    } catch (e) { logSoft_('scorecard ' + s.name, e); }
  });

  // Pass 3: per-individual roster teams (Onboarding / Collections style).
  rosterSheets.forEach(function (s) {
    try {
      var parsed = parseRosterSheet_(s.name, s.grid);
      teams.push(parsed.team);
      parsed.members.forEach(function (m) { members.push(m); });
      parsed.kpis.forEach(function (k) { kpis.push(k); });
    } catch (e) { logSoft_('roster ' + s.name, e); }
  });

  // Ensure every configured lead exists as a member of their team.
  ensureLeads_(teams, members, kpis);

  return { teams: teams, members: members, kpis: kpis };
}

/** ------------------------------------------------ classification predicates */

function hasScorecard_(grid) {
  return hasAny_(grid, [
    'business development', 'kpi / definition', 'kpi description', 'target 1'
  ]) && hasHeaderRow_(grid, ['perspective', 'target 1']);
}

function looksLikePocRoster_(grid) {
  var poc = false, region = false;
  for (var r = 0; r < grid.length; r++) {
    for (var c = 0; c < grid[r].length; c++) {
      var v = norm_(grid[r][c]);
      if (v === 'poc') poc = true;
      if (v === 'region') region = true;
    }
  }
  return poc && region;
}

function hasHeaderRow_(grid, tokens) {
  for (var r = 0; r < grid.length; r++) {
    var rowTokens = grid[r].map(norm_);
    var all = tokens.every(function (t) {
      return rowTokens.some(function (cell) { return cell.indexOf(t) >= 0; });
    });
    if (all) return true;
  }
  return false;
}

function hasAny_(grid, needles) {
  for (var r = 0; r < grid.length; r++) {
    for (var c = 0; c < grid[r].length; c++) {
      var v = norm_(grid[r][c]);
      for (var i = 0; i < needles.length; i++) {
        if (v.indexOf(needles[i]) >= 0) return true;
      }
    }
  }
  return false;
}

/** ------------------------------------------------------- POC ROSTER parsing */

function parsePocRoster_(grid, out) {
  var currentTeam = null, regionCol = 0, pocCol = 1;
  for (var r = 0; r < grid.length; r++) {
    var row = grid[r];
    var joined = row.map(norm_).join(' ').trim();

    // Section header: a row that (merged) names a team, e.g. "METAL".
    var label = firstNonEmpty_(row);
    var upper = norm_(label).toUpperCase ? String(label).trim().toUpperCase() : '';
    if (upper === 'METAL' || upper === 'PLASTIC') {
      currentTeam = properTeam_(upper);
      out[currentTeam.toUpperCase()] = out[currentTeam.toUpperCase()] || [];
      continue;
    }
    // Header row inside a section.
    var rn = row.map(norm_);
    if (rn.indexOf('region') >= 0 && rn.indexOf('poc') >= 0) {
      regionCol = rn.indexOf('region');
      pocCol = rn.indexOf('poc');
      continue;
    }
    if (!currentTeam) continue;
    var pocName = String(row[pocCol] || '').trim();
    var region  = String(row[regionCol] || '').trim();
    if (pocName && norm_(pocName) !== 'poc') {
      out[currentTeam.toUpperCase()].push({ name: pocName, region: region });
    }
  }
}

function properTeam_(upper) {
  return upper.charAt(0) + upper.slice(1).toLowerCase(); // METAL -> Metal
}

/** ------------------------------------------------ SCORECARD sheet (template) */

function parseScorecardSheet_(teamName, grid) {
  var templates = [];
  var segments = [];
  var headerRows = findHeaderRows_(grid, ['perspective', 'target 1']);

  headerRows.forEach(function (hr) {
    var header = grid[hr];
    var cols = mapScorecardColumns_(header);
    var segment = detectSegment_(grid, hr);
    if (segments.indexOf(segment) < 0) segments.push(segment);

    for (var r = hr + 1; r < grid.length; r++) {
      var row = grid[r];
      // stop at next header / a new title block / a fully-blank separator run
      if (isHeaderRow_(row, ['perspective', 'target 1'])) break;
      if (isScorecardTitle_(row)) break;
      var kra = String(row[cols.kra] || '').trim();
      var kpi = String(row[cols.kpi] || '').trim();
      if (!kra && !kpi) continue;

      var bands = cols.bands.map(function (bc, i) {
        return makeBand_(i + 1, row[bc], scorecardBandLabel_(i));
      });
      var weight = parseWeight_(row[cols.weight]);
      var unit = String(row[cols.unit] || '').trim() || inferUnit_(bands);
      var kpiId = slug_([teamName, segment, kra, kpi].join('|'));

      templates.push({
        kpiId: kpiId,
        team: teamName,
        segment: segment,
        perspective: String(row[cols.perspective] || '').trim(),
        role: '',
        kra: kra,
        kpi: kpi,
        definition: String(row[cols.kpi] || '').trim(),
        source: String(row[cols.source] || '').trim(),
        unit: unit,
        weight: weight,
        bands: bands,
        direction: detectDirection_(bands),
        target: targetFromBands_(bands, DEFAULT_SETTINGS.targetBandLevel)
      });
    }
  });

  return {
    team: {
      id: slug_(teamName),
      name: teamName,
      lead: TEAM_LEADS[teamName] || '',
      type: 'scorecard',
      segments: segments
    },
    templates: templates
  };
}

function mapScorecardColumns_(header) {
  var n = header.map(norm_);
  function find(preds) {
    for (var c = 0; c < n.length; c++) {
      for (var p = 0; p < preds.length; p++) {
        if (n[c].indexOf(preds[p]) >= 0) return c;
      }
    }
    return -1;
  }
  var source = find(['source of tracking']);
  var cols = {
    perspective: find(['perspective']),
    kra: find(['kra']),
    kpi: find(['kpi / definition', 'kpi description', 'kpi']),
    weight: find(['weightage']),
    unit: find(['unit']),
    source: source,
    bands: []
  };
  // The five target columns are the trailing five (Target 1..5) after Unit.
  var start = -1;
  for (var c = 0; c < n.length; c++) {
    if (n[c].indexOf('target 1') >= 0) { start = c; break; }
  }
  if (start < 0) start = header.length - 5;
  for (var i = 0; i < 5; i++) cols.bands.push(start + i);
  return cols;
}

function detectSegment_(grid, headerRow) {
  // Look at the merged title above the header row.
  for (var r = headerRow - 1; r >= 0 && r >= headerRow - 3; r--) {
    var t = norm_(firstNonEmpty_(grid[r]));
    if (!t) continue;
    if (t.indexOf('demand') >= 0) return 'Demand · Buyer side';
    if (t.indexOf('business development') >= 0 || t.indexOf('sales') >= 0) {
      return 'Supply · Seller side';
    }
    return 'Supply · Seller side';
  }
  return 'Supply · Seller side';
}

function isScorecardTitle_(row) {
  var t = norm_(firstNonEmpty_(row));
  return t.indexOf('demand') >= 0 || t.indexOf('business development') >= 0;
}

function scorecardBandLabel_(i) {
  return ['Target 1', 'Target 2', 'Target 3', 'Target 4', 'Target 5'][i];
}

function buildScorecardMembers_(teamName, roster) {
  var seen = {}, out = [];
  roster.forEach(function (p) {
    var key = norm_(p.name);
    if (!p.name || seen[key]) return;
    seen[key] = true;
    out.push({
      id: slug_(teamName + '|' + p.name),
      name: p.name,
      team: teamName,
      role: p.region ? (p.region + ' Region POC') : 'Team Member',
      region: p.region || '',
      isLead: isLead_(teamName, p.name)
    });
  });
  return out;
}

function expandTemplateForMember_(t, m) {
  return {
    id: slug_(m.id + '|' + t.kpiId),
    kpiId: t.kpiId,
    team: t.team,
    memberId: m.id,
    individual: m.name,
    segment: t.segment,
    perspective: t.perspective,
    role: t.role,
    kra: t.kra,
    kpi: t.kpi,
    definition: t.definition,
    source: t.source,
    unit: t.unit,
    weight: t.weight,
    direction: t.direction,
    target: t.target,
    bands: t.bands
  };
}

/** -------------------------------------------- ROSTER sheet (per-individual) */

function parseRosterSheet_(teamName, grid) {
  var members = [], kpis = [], seenMember = {};
  var headerRows = findHeaderRows_(grid, ['kpi', 'weightage', 'kra']);

  headerRows.forEach(function (hr, hi) {
    var header = grid[hr];
    var cols = mapRosterColumns_(header);
    var indiv = memberNameForBlock_(grid, hr, cols);
    if (!indiv) indiv = teamName + ' Member ' + (hi + 1);

    var memberId = slug_(teamName + '|' + indiv);
    if (!seenMember[memberId]) {
      seenMember[memberId] = true;
      members.push({
        id: memberId,
        name: indiv,
        team: teamName,
        role: rowRole_(grid, hr, cols) || 'Team Member',
        region: '',
        isLead: isLead_(teamName, indiv)
      });
    }

    var nextHr = hi + 1 < headerRows.length ? headerRows[hi + 1] : grid.length;
    for (var r = hr + 1; r < nextHr; r++) {
      var row = grid[r];
      if (isRosterBlockTitle_(row)) continue;         // "Collections - X" title
      if (isTotalsRow_(row, cols)) continue;          // weightage 100% total
      var kra = String(row[cols.kra] || '').trim();
      var kpi = String(row[cols.kpi] || '').trim();
      if (!kra && !kpi) continue;

      var bands = cols.bands.map(function (bc, i) {
        return makeBand_(i + 1, row[bc], ROSTER_BAND_LABELS[i]);
      });
      var weight = parseWeight_(row[cols.weight]);
      var kpiId = slug_([teamName, indiv, kra, kpi].join('|'));

      kpis.push({
        id: kpiId,
        kpiId: kpiId,
        team: teamName,
        memberId: memberId,
        individual: indiv,
        segment: '',
        perspective: String(row[cols.perspective] || '').trim(),
        role: String(cols.role >= 0 ? (row[cols.role] || '') : '').trim(),
        kra: kra,
        kpi: kpi,
        definition: String(cols.goal >= 0 ? (row[cols.goal] || '') : '').trim() || kpi,
        source: String(cols.source >= 0 ? (row[cols.source] || '') : '').trim(),
        unit: inferUnit_(bands),
        weight: weight,
        direction: detectDirection_(bands),
        target: targetFromBands_(bands, DEFAULT_SETTINGS.targetBandLevel),
        bands: bands
      });
    }
  });

  return {
    team: {
      id: slug_(teamName),
      name: teamName,
      lead: TEAM_LEADS[teamName] || '',
      type: 'roster',
      segments: []
    },
    members: members,
    kpis: kpis
  };
}

var ROSTER_BAND_LABELS = [
  'Needs Improvement', 'Below Expectation', 'Meets Expectation',
  'Above Expectation', 'Exceeds Expectation'
];

function mapRosterColumns_(header) {
  var n = header.map(norm_);
  function findFrom(from, preds) {
    for (var c = from; c < n.length; c++) {
      for (var p = 0; p < preds.length; p++) {
        if (n[c].indexOf(preds[p]) >= 0) return c;
      }
    }
    return -1;
  }
  var kpiCol = findFrom(0, ['kpi']);
  // KRA is the "kra" header nearest-left of the KPI column (col0 may also be a
  // spurious "kra"/"individual -" label).
  var kraCol = -1;
  for (var c = 0; c < kpiCol; c++) { if (n[c].indexOf('kra') >= 0) kraCol = c; }
  if (kraCol < 0) kraCol = findFrom(0, ['kra']);

  var source = findFrom(0, ['source of tracking', 'source']);
  var cols = {
    perspective: findFrom(0, ['perspective']),
    role: findFrom(0, ['role']),
    kra: kraCol,
    kpi: kpiCol,
    goal: findFrom(0, ['goal description', 'goal']),
    weight: findFrom(0, ['weightage']),
    source: source,
    bands: []
  };
  // Five rating bands = the five columns after "Source of Tracking", or the
  // explicit "Needs Improvement".."Exceeds Expectation" columns if present.
  var start = -1;
  for (var c2 = 0; c2 < n.length; c2++) {
    if (n[c2].indexOf('needs improvement') >= 0) { start = c2; break; }
  }
  if (start < 0) start = source >= 0 ? source + 1 : header.length - 5;
  for (var i = 0; i < 5; i++) cols.bands.push(start + i);
  return cols;
}

function memberNameForBlock_(grid, hr, cols) {
  // 1) Onboarding: header col0 is "Individual - Vamsi".
  var h0 = String(grid[hr][0] || '').trim();
  var m = h0.match(/^\s*individual\s*[-–]\s*(.+)$/i);
  if (m) return cleanName_(m[1]);

  // 2) Collections: a title row above the header, "Collections - Sai Nitin",
  //    "Collections & OMP Tnx - Srinivas Reddy".
  for (var r = hr - 1; r >= 0 && r >= hr - 3; r--) {
    var t = String(firstNonEmpty_(grid[r]) || '').trim();
    var mm = t.match(/[-–]\s*([A-Za-z][A-Za-z .]+)\s*$/);
    if (mm && /collection|individual|omp|tnx/i.test(t)) return cleanName_(mm[1]);
  }
  // 3) Any leading label with a dash.
  var m3 = h0.match(/[-–]\s*([A-Za-z][A-Za-z .]+)\s*$/);
  if (m3) return cleanName_(m3[1]);
  return '';
}

function rowRole_(grid, hr, cols) {
  if (cols.role < 0) return '';
  for (var r = hr + 1; r < Math.min(grid.length, hr + 4); r++) {
    var v = String(grid[r][cols.role] || '').trim();
    if (v) return v;
  }
  return '';
}

function isRosterBlockTitle_(row) {
  var t = norm_(firstNonEmpty_(row));
  if (!t) return false;
  return (/^collections\s*[-–]/.test(t) || /^collections &/.test(t) ||
          /^individual\s*[-–]/.test(t));
}

function isTotalsRow_(row, cols) {
  var kra = String(row[cols.kra] || '').trim();
  var kpi = String(row[cols.kpi] || '').trim();
  if (kra || kpi) return false;
  // a weightage-only row (the "100%" total)
  return String(row[cols.weight] || '').trim() !== '';
}

/** --------------------------------------------------------------- leads glue */

function isLead_(teamName, name) {
  var lead = TEAM_LEADS[teamName];
  if (!lead) return false;
  return norm_(name).indexOf(norm_(lead)) >= 0 ||
         norm_(name).split(' ')[0] === norm_(lead).split(' ')[0];
}

function ensureLeads_(teams, members, kpis) {
  teams.forEach(function (team) {
    var lead = TEAM_LEADS[team.name];
    if (!lead) return;
    var has = members.some(function (m) {
      return m.team === team.name && isLead_(team.name, m.name);
    });
    if (has) {
      members.forEach(function (m) {
        if (m.team === team.name && isLead_(team.name, m.name)) m.isLead = true;
      });
      return;
    }
    // Lead absent from roster (e.g. Tabesh / Plastic): add as a member and,
    // for scorecard teams, give them the shared template.
    var memberId = slug_(team.name + '|' + lead);
    members.push({
      id: memberId, name: lead, team: team.name,
      role: 'Team Lead', region: '', isLead: true
    });
    if (team.type === 'scorecard') {
      var templates = {};
      kpis.forEach(function (k) {
        if (k.team === team.name) templates[k.kpiId] = k;
      });
      Object.keys(templates).forEach(function (tid) {
        var t = templates[tid];
        kpis.push(expandTemplateForMember_({
          kpiId: t.kpiId, team: t.team, segment: t.segment,
          perspective: t.perspective, role: t.role, kra: t.kra, kpi: t.kpi,
          definition: t.definition, source: t.source, unit: t.unit,
          weight: t.weight, direction: t.direction, target: t.target,
          bands: t.bands
        }, { id: memberId, name: lead }));
      });
    }
  });
}

/** ------------------------------------------------------------- band helpers */

function makeBand_(level, raw, label) {
  var text = raw == null ? '' : String(raw).trim();
  return { level: level, label: label, raw: text, value: parseBandValue_(text) };
}

/** First standalone number in a cell (commas stripped, hyphen-after-letter
 *  neutralised) -> Number, else null (qualitative band). */
function parseBandValue_(text) {
  if (text == null) return null;
  var s = String(text).trim();
  if (!s || s === '-' || s === '–' || s === '—') return null;
  s = s.replace(/,/g, '').replace(/([A-Za-z])-/g, '$1 ');
  var m = s.match(/\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : null;
}

/** best band (5) vs worst band (1): higher value in best -> higher-is-better. */
function detectDirection_(bands) {
  var vals = bands.map(function (b) { return b.value; })
                  .filter(function (v) { return v != null; });
  if (vals.length < 2) return 'qualitative';
  var first = vals[0], last = vals[vals.length - 1];
  if (last > first) return 'higher';
  if (last < first) return 'lower';
  return 'higher';
}

function targetFromBands_(bands, level) {
  var b = bands[Math.max(0, Math.min(4, level - 1))];
  if (b && b.value != null) return b.value;
  // fall back to nearest numeric band
  for (var i = 0; i < bands.length; i++) if (bands[i].value != null) return bands[i].value;
  return null;
}

function inferUnit_(bands) {
  var joined = bands.map(function (b) { return b.raw; }).join(' ').toLowerCase();
  if (joined.indexOf('%') >= 0) return 'Percentage';
  if (joined.indexOf('day') >= 0) return 'Days';
  if (joined.indexOf('cr') >= 0) return '₹ Cr';
  return 'Number';
}

function parseWeight_(raw) {
  if (raw == null || String(raw).trim() === '') return null;
  var m = String(raw).replace(/,/g, '').match(/\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : null;
}

/** --------------------------------------------------------- row/grid helpers */

function findHeaderRows_(grid, tokens) {
  var rows = [];
  for (var r = 0; r < grid.length; r++) {
    if (isHeaderRow_(grid[r], tokens)) rows.push(r);
  }
  return rows;
}

function isHeaderRow_(row, tokens) {
  var rn = row.map(norm_);
  return tokens.every(function (t) {
    return rn.some(function (cell) { return cell.indexOf(t) >= 0; });
  });
}

function firstNonEmpty_(row) {
  for (var c = 0; c < row.length; c++) {
    if (String(row[c] || '').trim() !== '') return row[c];
  }
  return '';
}

function cleanName_(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

function norm_(v) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().toLowerCase();
}

function slug_(s) {
  return String(s).toLowerCase()
    .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 200);
}

function logSoft_(where, e) {
  try { Logger.log('parse warning @' + where + ': ' + (e && e.message || e)); } catch (x) {}
}

/** ========================================================= ACTUALS STORE */

var ACTUAL_HEADER = ['Team', 'MemberId', 'Individual', 'KpiId', 'KpiName',
  'Period', 'Actual', 'Rating', 'Commentary', 'Evidence', 'UpdatedBy', 'UpdatedAt'];

function ensureActualsSheet_() {
  var ss = SpreadsheetApp.openById(SOURCE_SPREADSHEET_ID);
  var sh = ss.getSheetByName(TAB_ACTUALS);
  if (!sh) {
    sh = ss.insertSheet(TAB_ACTUALS);
    sh.getRange(1, 1, 1, ACTUAL_HEADER.length).setValues([ACTUAL_HEADER]);
    sh.setFrozenRows(1);
    try { sh.hideSheet(); } catch (e) {}
  }
  return sh;
}

function readActuals() {
  var sh = ensureActualsSheet_();
  var data = sh.getDataRange().getValues();
  var map = {}, periods = {};
  if (data.length < 2) return { map: map, periods: [] };
  var idx = colIndex_(data[0]);
  for (var r = 1; r < data.length; r++) {
    var row = data[r];
    var memberId = String(row[idx.MemberId] || '').trim();
    var kpiId = String(row[idx.KpiId] || '').trim();
    var period = String(row[idx.Period] || '').trim();
    if (!memberId || !kpiId || !period) continue;
    var key = actualKey_(memberId, kpiId, period);
    map[key] = {
      actual: numOrNull_(row[idx.Actual]),
      rating: numOrNull_(row[idx.Rating]),
      commentary: String(row[idx.Commentary] || ''),
      evidence: String(row[idx.Evidence] || ''),
      updatedBy: String(row[idx.UpdatedBy] || ''),
      updatedAt: row[idx.UpdatedAt] ? String(row[idx.UpdatedAt]) : ''
    };
    periods[period] = true;
  }
  return { map: map, periods: Object.keys(periods).sort() };
}

function buildActualRow_(header, p, who, now) {
  var idx = colIndex_(header);
  var arr = new Array(header.length).fill('');
  arr[idx.Team]       = p.team || '';
  arr[idx.MemberId]   = p.memberId;
  arr[idx.Individual] = p.individual || '';
  arr[idx.KpiId]      = p.kpiId;
  arr[idx.KpiName]    = p.kpiName || '';
  arr[idx.Period]     = p.period;
  arr[idx.Actual]     = (p.actual === '' || p.actual == null) ? '' : Number(p.actual);
  arr[idx.Rating]     = (p.rating === '' || p.rating == null) ? '' : Number(p.rating);
  arr[idx.Commentary] = p.commentary || '';
  arr[idx.Evidence]   = p.evidence || '';
  arr[idx.UpdatedBy]  = who;
  arr[idx.UpdatedAt]  = now.toISOString();
  return arr;
}

function colIndex_(header) {
  var idx = {};
  header.forEach(function (h, i) { idx[String(h).trim()] = i; });
  return idx;
}

function actualKey_(memberId, kpiId, period) {
  return [String(memberId).trim(), String(kpiId).trim(), String(period).trim()].join('||');
}

/** =========================================================== SETTINGS STORE */

function ensureSettingsSheet_() {
  var ss = SpreadsheetApp.openById(SOURCE_SPREADSHEET_ID);
  var sh = ss.getSheetByName(TAB_SETTINGS);
  if (!sh) {
    sh = ss.insertSheet(TAB_SETTINGS);
    sh.getRange(1, 1, 1, 2).setValues([['Key', 'Value']]);
    var rows = Object.keys(DEFAULT_SETTINGS).map(function (k) {
      return [k, DEFAULT_SETTINGS[k]];
    });
    sh.getRange(2, 1, rows.length, 2).setValues(rows);
    sh.setFrozenRows(1);
    try { sh.hideSheet(); } catch (e) {}
  }
  return sh;
}

function readSettings() {
  var sh = ensureSettingsSheet_();
  var data = sh.getDataRange().getValues();
  var s = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  for (var r = 1; r < data.length; r++) {
    var k = String(data[r][0] || '').trim();
    if (!k) continue;
    var v = data[r][1];
    if (k === 'currentPeriod') s[k] = String(v || '');
    else if (DEFAULT_SETTINGS.hasOwnProperty(k)) s[k] = Number(v);
  }
  return s;
}

function writeSettings_(s) {
  var sh = ensureSettingsSheet_();
  var rows = Object.keys(DEFAULT_SETTINGS).map(function (k) {
    return [k, s[k] != null ? s[k] : DEFAULT_SETTINGS[k]];
  });
  sh.clearContents();
  sh.getRange(1, 1, 1, 2).setValues([['Key', 'Value']]);
  sh.getRange(2, 1, rows.length, 2).setValues(rows);
}

/** ================================================================ SEED DATA
 * Deterministic, realistic SAMPLE actuals so the dashboard is alive on first
 * open. These are clearly-labelled samples in a managed tab — replace them
 * with real MIS numbers (or run "Clear actuals" from the app).
 */
function seedSampleActuals_() {
  var model = getFrameworkModel(true);
  var periods = defaultPeriods_();               // last 3 months incl. current
  var sh = ensureActualsSheet_();
  var rows = [];
  var header = ACTUAL_HEADER;

  model.kpis.forEach(function (k) {
    if (k.weight == null) return;                // skip unweighted info rows
    var baseR = 1.6 + 3.1 * hash01_(k.memberId + '|' + k.kpiId); // 1.6..4.7
    periods.forEach(function (period, pi) {
      var drift = (pi - (periods.length - 1)) * 0.18;            // improve over time
      var wobble = (hash01_(k.kpiId + period) - 0.5) * 0.5;
      var r = clamp_(baseR + drift + wobble, 0.7, 5);
      var rec = {
        team: k.team, memberId: k.memberId, individual: k.individual,
        kpiId: k.kpiId, kpiName: k.kpi, period: period,
        commentary: '', evidence: '', rating: ''
      };
      if (k.direction === 'qualitative' || k.target == null) {
        rec.rating = Math.round(r * 10) / 10;    // qualitative -> manual rating
        rec.actual = '';
      } else {
        rec.actual = Math.round(ratingToValue_(k.bands, r) * 100) / 100;
        rec.rating = '';
      }
      rows.push(buildActualRow_(header, rec, 'sample@recykal.com', new Date()));
    });
  });

  if (rows.length) {
    sh.getRange(sh.getLastRow() + 1, 1, rows.length, header.length).setValues(rows);
  }
}

/** Invert the band scale: rating (1..5) -> a plausible actual value. */
function ratingToValue_(bands, r) {
  var v = bands.map(function (b) { return b.value; });
  // fill nulls by neighbour so interpolation is safe
  for (var i = 0; i < 5; i++) if (v[i] == null) v[i] = nearestVal_(v, i);
  r = clamp_(r, 1, 5);
  var lo = Math.floor(r); if (lo >= 5) return v[4];
  var t = r - lo;
  return v[lo - 1] + t * (v[lo] - v[lo - 1]);
}

function nearestVal_(v, i) {
  for (var d = 1; d < 5; d++) {
    if (v[i - d] != null) return v[i - d];
    if (v[i + d] != null) return v[i + d];
  }
  return 0;
}

/** ---------------------------------------------------------------- utilities */

function defaultPeriods_() {
  var out = [], d = new Date();
  d.setDate(1);
  for (var i = 2; i >= 0; i--) {
    var dd = new Date(d.getFullYear(), d.getMonth() - i, 1);
    out.push(ym_(dd));
  }
  return out;
}

function thisMonth_() { return ym_(new Date()); }

function ym_(d) {
  var m = d.getMonth() + 1;
  return d.getFullYear() + '-' + (m < 10 ? '0' + m : '' + m);
}

function uniqueSorted(arr) {
  var seen = {}, out = [];
  arr.forEach(function (x) { if (x && !seen[x]) { seen[x] = true; out.push(x); } });
  return out.sort();
}

function numOrNull_(v) {
  if (v === '' || v == null) return null;
  var n = Number(v);
  return isNaN(n) ? null : n;
}

function clamp_(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }

/** stable 0..1 hash of a string */
function hash01_(s) {
  var h = 2166136261;
  s = String(s);
  for (var i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h * 16777619) >>> 0;
  }
  return (h % 100000) / 100000;
}

function safeUser_() {
  var email = '';
  try { email = Session.getActiveUser().getEmail() || ''; } catch (e) {}
  if (!email) { try { email = Session.getEffectiveUser().getEmail() || ''; } catch (e2) {} }
  return { email: email };
}

function invalidateCache_() {
  try { CacheService.getScriptCache().remove(CACHE_KEY); } catch (e) {}
}
