/*******************************************************************************
 * RECYKAL — KRA / KPI PERFORMANCE COMMAND CENTRE
 * =============================================================================
 * BACKEND / DATA-PROCESSING LAYER  (the single source of truth for the UI)
 *
 * Architecture:  Google Sheet  ->  this backend  ->  normalized model  ->  UI
 *
 * This file owns ALL business logic. The frontend (Index.html) is a pure
 * renderer — it never calculates a KPI, a status, an achievement or a roll-up.
 * Everything below is computed here and returned as one normalized payload:
 *   - reads every tab once (batched) and parses the KRA/KPI framework
 *   - normalizes people, teams, KRAs, KPIs, weights, targets, units, direction
 *   - reads the actuals the app collects (targets today, achievements as they
 *     are entered) and scores every KPI line
 *   - aggregates to member / team / organisation, with trends across periods
 *   - handles missing / blank / malformed values and empty / error states
 *   - caches the parsed framework and exposes a "lastUpdated" signal
 *
 * The parser is generic and structure-driven (no hard-coded KPI data): it reads
 * whatever the sheet contains today and adapts as the sheet evolves.
 ******************************************************************************/

/** ------------------------------------------------------------------ CONFIG */
var SOURCE_SPREADSHEET_ID = '1c0_pP4Mmye5s5D_vzoxrvJ-utkLb6JhD69TvvOBbjoo';

var TAB_ACTUALS  = '_KKT_Actuals';    // app-managed: the achievements/actuals
var TAB_SETTINGS = '_KKT_Settings';   // app-managed: thresholds, current period

// Canonical functions/teams and the keywords that map raw text onto them.
// Team is resolved from (1) the tab name, (2) the block-title role suffix,
// (3) the KPI content — in that order — so it stays correct as the sheet grows.
var TEAM_RULES = [
  { id: 'Metal',        match: ['metal'] },
  { id: 'Plastic',      match: ['plastic'] },
  { id: 'Onboarding',   match: ['onboard'] },
  { id: 'Collections',  match: ['collection'] },
  { id: 'Transactions', match: ['transaction', 'mis', 'match making', 'match-making', 'cn / dn', 'dn / cn'] },
  { id: 'Logistics',    match: ['logistic', 'dispatch', 'pod', 'in-transit', 'transit', 'delivery', 'settlement', 'qc &', 'shipment'] }
];

var DEFAULT_SETTINGS = {
  onTrack: 3.0,          // rating >= 3.0 (Meets Expectation) -> On Track
  atRisk:  2.0,          // rating >= 2.0 -> At Risk, else Off Track
  targetBandLevel: 3,    // band level treated as the "target" (Meets)
  currentPeriod: ''      // '' -> latest period with data / this month
};

var CACHE_KEY = 'kkt_model_v4';
var CACHE_TTL = 900;     // 15 min; invalidated on write

/** -------------------------------------------------------------- WEB ENTRY */
function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('Recykal · KRA / KPI Command Centre')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/** ============================================================= PUBLIC API */

/**
 * The one call the frontend needs. Returns the fully computed, normalized
 * dashboard model. Never throws to the client — always returns a shaped object
 * with ok / connected / empty / error so the UI can render the right state.
 */
function apiBootstrap(opts) {
  opts = opts || {};
  try {
    var cache = CacheService.getScriptCache();
    if (!opts.force) {
      var hit = cache.get(CACHE_KEY);
      if (hit) { try { return JSON.parse(hit); } catch (e) {} }
    }
    var model = buildDashboard_();
    try { cache.put(CACHE_KEY, JSON.stringify(model), CACHE_TTL); } catch (e) {}
    return model;
  } catch (err) {
    return { ok: false, connected: false, empty: true,
             error: String(err && err.message || err),
             generatedAt: new Date().toISOString() };
  }
}

/** Save one actual/achievement (+ commentary / evidence / manual rating). */
function apiSaveActual(p) {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000);
    if (!p || !p.memberId || !p.kpiId || !p.period) {
      throw new Error('memberId, kpiId and period are required.');
    }
    var sh = ensureActualsSheet_();
    var data = sh.getDataRange().getValues();
    var header = data[0], idx = colIndex_(header);
    var key = actualKey_(p.memberId, p.kpiId, p.period), rowNum = -1;
    for (var r = 1; r < data.length; r++) {
      if (actualKey_(data[r][idx.MemberId], data[r][idx.KpiId], data[r][idx.Period]) === key) { rowNum = r + 1; break; }
    }
    var row = buildActualRow_(header, p, safeUser_().email || 'unknown', new Date());
    if (rowNum === -1) sh.appendRow(row);
    else sh.getRange(rowNum, 1, 1, header.length).setValues([row]);
    invalidateCache_();
    return apiBootstrap({ force: true });
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  } finally { try { lock.releaseLock(); } catch (e) {} }
}

function apiSaveSettings(patch) {
  try {
    var s = readSettings_();
    patch = patch || {};
    if (patch.currentPeriod   != null) s.currentPeriod   = String(patch.currentPeriod);
    if (patch.onTrack         != null) s.onTrack         = Number(patch.onTrack);
    if (patch.atRisk          != null) s.atRisk          = Number(patch.atRisk);
    if (patch.targetBandLevel != null) s.targetBandLevel = Number(patch.targetBandLevel);
    writeSettings_(s);
    invalidateCache_();
    return apiBootstrap({ force: true });
  } catch (err) { return { ok: false, error: String(err && err.message || err) }; }
}

/** Remove actuals whose KpiId no longer exists in the framework (orphans from
 *  a framework change), then optionally everything. */
function apiCleanupActuals(mode) {
  try {
    var fw = getFramework_(true);
    var valid = {}; fw.kpis.forEach(function (k) { valid[k.memberId + '||' + k.kpiId] = true; });
    var sh = ensureActualsSheet_();
    var data = sh.getDataRange().getValues();
    if (data.length < 2) return apiBootstrap({ force: true });
    var idx = colIndex_(data[0]), keep = [data[0]];
    for (var r = 1; r < data.length; r++) {
      var mk = String(data[r][idx.MemberId]) + '||' + String(data[r][idx.KpiId]);
      if (mode === 'all') continue;
      if (valid[mk]) keep.push(data[r]);
    }
    sh.clearContents();
    sh.getRange(1, 1, keep.length, data[0].length).setValues(keep);
    invalidateCache_();
    return apiBootstrap({ force: true });
  } catch (err) { return { ok: false, error: String(err && err.message || err) }; }
}

/** Observability: what did the parser actually see? Helps validate the live
 *  sheet mapping without guessing. */
function apiDiagnostics() {
  try {
    var ss = SpreadsheetApp.openById(SOURCE_SPREADSHEET_ID);
    var out = { title: ss.getName(), tabs: [], teams: {}, warnings: PARSE_WARNINGS_.slice(0, 50) };
    ss.getSheets().forEach(function (sh) {
      out.tabs.push({ name: sh.getName(), rows: sh.getLastRow(), cols: sh.getLastColumn() });
    });
    var fw = getFramework_(true);
    fw.members.forEach(function (m) {
      out.teams[m.team] = out.teams[m.team] || { members: [], kpiLines: 0 };
      out.teams[m.team].members.push(m.name + ' (' + m.role + ')');
    });
    fw.kpis.forEach(function (k) { if (out.teams[k.team]) out.teams[k.team].kpiLines++; });
    return { ok: true, diagnostics: out };
  } catch (err) { return { ok: false, error: String(err && err.message || err) }; }
}

/** ========================================================= BUILD DASHBOARD */

function buildDashboard_() {
  var ss;
  try { ss = SpreadsheetApp.openById(SOURCE_SPREADSHEET_ID); }
  catch (e) { return { ok: false, connected: false, empty: true,
                       error: 'Cannot open the source spreadsheet.', generatedAt: nowIso_() }; }

  var fw = getFramework_(false);
  var settings = readSettings_();
  var store = readActuals_();

  var periods = uniqueSorted_(store.periods.concat(defaultPeriods_()));
  var current = (settings.currentPeriod && periods.indexOf(settings.currentPeriod) >= 0)
    ? settings.currentPeriod : (periods.length ? periods[periods.length - 1] : thisMonth_());

  // ---- score every KPI line for every period ----
  var results = {};                                   // key -> computed result
  fw.kpis.forEach(function (k) {
    periods.forEach(function (p) {
      var rec = store.map[k.memberId + '||' + k.kpiId + '||' + p] || null;
      results[k.memberId + '||' + k.kpiId + '||' + p] = evalKpi_(k, rec, settings);
    });
  });

  // ---- roll up per period ----
  var rollups = {}, trends = { org: [], teams: {}, members: {} };
  fw.teams.forEach(function (t) { trends.teams[t.name] = []; });
  fw.members.forEach(function (m) { trends.members[m.id] = []; });

  periods.forEach(function (p) {
    var roll = rollupPeriod_(fw, results, settings, p);
    rollups[p] = roll;
    trends.org.push({ period: p, v: roll.org.score });
    fw.teams.forEach(function (t) {
      trends.teams[t.name].push({ period: p, v: roll.teams[t.name] ? roll.teams[t.name].score : null });
    });
    fw.members.forEach(function (m) {
      trends.members[m.id].push({ period: p, v: roll.members[m.id] ? roll.members[m.id].score : null });
    });
  });

  // team meta (counts)
  var teamMeta = fw.teams.map(function (t) {
    var mem = fw.members.filter(function (m) { return m.team === t.name; });
    var kc = fw.kpis.filter(function (k) { return k.team === t.name; }).length;
    return { id: t.id, name: t.name, lead: t.lead || '', memberCount: mem.length, kpiCount: kc };
  });

  var empty = fw.members.length === 0 || fw.kpis.length === 0;

  return {
    ok: true, connected: true, empty: empty,
    generatedAt: nowIso_(),
    lastUpdated: store.lastUpdated || nowIso_(),
    user: safeUser_(),
    source: {
      title: ss.getName(),
      tabs: fw.tabs, blocks: fw.blockCount,
      kpiLines: fw.kpis.length, people: fw.members.length,
      hasActuals: store.count > 0
    },
    settings: {
      onTrack: settings.onTrack, atRisk: settings.atRisk,
      targetBandLevel: settings.targetBandLevel, currentPeriod: current
    },
    periods: periods,
    teams: teamMeta,
    members: fw.members,
    kpis: fw.kpis,
    results: results,
    rollups: rollups,
    trends: trends
  };
}

function rollupPeriod_(fw, results, S, period) {
  var members = {}, teams = {};
  fw.teams.forEach(function (t) { teams[t.name] = accum_(); });
  var org = accum_();

  fw.members.forEach(function (m) {
    var rows = fw.kpis.filter(function (k) { return k.memberId === m.id; })
      .map(function (k) { return results[m.id + '||' + k.kpiId + '||' + period]; });
    var mr = summarize_(rows, S);
    members[m.id] = mr;
    if (teams[m.team]) mergeAccum_(teams[m.team], mr);
    mergeAccum_(org, mr);
  });

  var out = { org: finalizeAccum_(org, S), teams: {}, members: {} };
  fw.teams.forEach(function (t) { out.teams[t.name] = finalizeAccum_(teams[t.name], S); });
  fw.members.forEach(function (m) { out.members[m.id] = members[m.id]; });
  return out;
}

/* member-level summary from its scored rows */
function summarize_(rows, S) {
  var d = rows.filter(function (r) { return r && r.hasData && r.weight != null && r.weight > 0; });
  var counts = { good: 0, warn: 0, bad: 0, none: 0 };
  rows.forEach(function (r) { if (r) counts[r.hasData ? r.status.k : 'none']++; });
  var score = null, attainment = null;
  if (d.length) {
    var ws = d.reduce(function (s, r) { return s + r.weight; }, 0);
    score = d.reduce(function (s, r) { return s + r.weight * r.rating; }, 0) / ws;
    var da = d.filter(function (r) { return r.achievement != null; });
    if (da.length) {
      var wa = da.reduce(function (s, r) { return s + r.weight; }, 0);
      attainment = da.reduce(function (s, r) { return s + r.weight * r.achievement; }, 0) / wa;
    }
  }
  var tracked = rows.filter(function (r) { return r && r.hasData; }).length;
  var onPct = tracked ? Math.round(counts.good / tracked * 1000) / 10 : null;
  return { score: round2_(score), attainment: round1_(attainment),
           onTrackPct: onPct, counts: counts, tracked: tracked, hasData: !!d.length,
           status: statusOf_(score, S) };
}

function accum_() { return { scores: [], attain: [], counts: { good: 0, warn: 0, bad: 0, none: 0 }, people: 0, reporting: 0 }; }
function mergeAccum_(a, mr) {
  a.people++;
  if (mr.score != null) { a.scores.push(mr.score); a.reporting++; }
  if (mr.attainment != null) a.attain.push(mr.attainment);
  ['good', 'warn', 'bad', 'none'].forEach(function (k) { a.counts[k] += mr.counts[k]; });
}
function finalizeAccum_(a, S) {
  var score = a.scores.length ? a.scores.reduce(function (s, x) { return s + x; }, 0) / a.scores.length : null;
  var attn  = a.attain.length ? a.attain.reduce(function (s, x) { return s + x; }, 0) / a.attain.length : null;
  var tracked = a.counts.good + a.counts.warn + a.counts.bad;
  return { score: round2_(score), attainment: round1_(attn),
           onTrackPct: tracked ? Math.round(a.counts.good / tracked * 1000) / 10 : null,
           counts: a.counts, people: a.people, reporting: a.reporting,
           status: statusOf_(score, S) };
}

/** ============================================================ SCORING CORE */

function evalKpi_(kpi, rec, S) {
  var out = { memberId: kpi.memberId, kpiId: kpi.kpiId, weight: kpi.weight,
              actual: null, rating: null, achievement: null, gap: null,
              hasData: false, manual: false, status: statusOf_(null, S),
              commentary: '', evidence: '', updatedBy: '', updatedAt: '' };
  if (rec) {
    out.commentary = rec.commentary || ''; out.evidence = rec.evidence || '';
    out.updatedBy = rec.updatedBy || '';  out.updatedAt = rec.updatedAt || '';
    if (rec.rating != null && !isNaN(rec.rating)) {          // qualitative / manual
      out.rating = clamp_(Number(rec.rating), 0, 5); out.manual = true; out.hasData = true;
    } else if (rec.actual != null && !isNaN(rec.actual)) {
      out.actual = Number(rec.actual);
      out.rating = valueToRating_(kpi, out.actual);
      out.hasData = out.rating != null;
    }
  }
  if (out.actual != null && kpi.target != null) {
    var t = kpi.target;
    if (kpi.direction === 'lower') {
      out.achievement = out.actual > 0 ? round1_((t / out.actual) * 100) : null;
      out.gap = round2_(t - out.actual);
    } else {
      out.achievement = t > 0 ? round1_((out.actual / t) * 100) : null;
      out.gap = round2_(out.actual - t);
    }
  }
  out.status = statusOf_(out.rating, S);
  return out;
}

function valueToRating_(kpi, actual) {
  var v = kpi.bands.map(function (b) { return b.value; });
  var w = v.slice();
  for (var i = 0; i < 5; i++) if (w[i] == null) w[i] = nearestVal_(v, i);
  if (w.every(function (x) { return x == null; })) return null;
  var sign = kpi.direction === 'lower' ? -1 : 1;
  var s = sign * actual, ww = w.map(function (x) { return sign * x; });
  if (s <= ww[0]) { var d0 = (ww[1] - ww[0]) || 1; return clamp_(1 + (s - ww[0]) / d0, 0, 1); }
  if (s >= ww[4]) return 5;
  for (var k = 0; k < 4; k++) {
    if (s >= ww[k] && s <= ww[k + 1]) { var d = (ww[k + 1] - ww[k]) || 1; return (k + 1) + (s - ww[k]) / d; }
  }
  return 5;
}
function nearestVal_(v, i) { for (var d = 1; d < 5; d++) { if (v[i - d] != null) return v[i - d]; if (v[i + d] != null) return v[i + d]; } return null; }

function statusOf_(rating, S) {
  if (rating == null) return { k: 'none', label: 'No Data' };
  if (rating >= S.onTrack) return { k: 'good', label: 'On Track' };
  if (rating >= S.atRisk)  return { k: 'warn', label: 'At Risk' };
  return { k: 'bad', label: 'Off Track' };
}

/** ============================================================ FRAMEWORK PARSE
 * Reads every tab and turns the KRA/KPI scorecards into a normalized model.
 * Handles the current sheet's shapes: consolidated team scorecards, per-person
 * "NAME (ROLE)" scorecard blocks, and Region/POC roster maps.
 */
var PARSE_WARNINGS_ = [];

function getFramework_(force) {
  var cache = CacheService.getScriptCache();
  if (!force) {
    var hit = cache.get(CACHE_KEY + '_fw');
    if (hit) { try { return JSON.parse(hit); } catch (e) {} }
  }
  var fw = parseFramework_();
  try { cache.put(CACHE_KEY + '_fw', JSON.stringify(fw), CACHE_TTL); } catch (e) {}
  return fw;
}

function parseFramework_() {
  PARSE_WARNINGS_ = [];
  var ss = SpreadsheetApp.openById(SOURCE_SPREADSHEET_ID);
  var sheets = ss.getSheets();
  var members = [], kpis = [], teamsSet = {}, tabs = [], blockCount = 0;
  var rosterHints = {};   // name(lower) -> {team, region}

  // Pass 1: roster maps (Region/POC) give team + region hints for people.
  sheets.forEach(function (sh) {
    var name = sh.getName();
    if (name === TAB_ACTUALS || name === TAB_SETTINGS) return;
    var grid = safeValues_(sh);
    if (!grid.length) return;
    collectRosterHints_(name, grid, rosterHints);
  });

  // Pass 2: parse scorecard blocks from every tab.
  sheets.forEach(function (sh) {
    var name = sh.getName();
    if (name === TAB_ACTUALS || name === TAB_SETTINGS) return;
    var grid = safeValues_(sh);
    if (!grid.length) return;
    tabs.push(name);
    try {
      var blocks = extractBlocks_(grid);
      blocks.forEach(function (b) {
        blockCount++;
        var kra = mapCols_(b.header);
        if (kra.kpi < 0 || kra.weight < 0) return;               // not a scorecard block
        var person = personFromTitle_(b.title);
        var teamGuess = resolveTeam_(name, person.role, b.rows, kra);
        var indiv = person.name || null;
        var isTemplate = !indiv;                                  // team-level template (e.g. Metal)

        if (isTemplate) {
          // Expand a team template across the roster of that team.
          var roster = rosterForTeam_(teamGuess, rosterHints, members);
          if (!roster.length) {
            // No roster -> treat the template itself as a single "Team (overall)" member
            roster = [{ name: teamGuess + ' — Team', role: 'Team', region: '' }];
          }
          roster.forEach(function (rm) {
            var mid = ensureMember_(members, teamGuess, rm.name, rm.role, rm.region, teamsSet);
            addBlockKpis_(kpis, b, kra, teamGuess, mid, rm.name, rm.role);
          });
        } else {
          var hint = rosterHints[norm_(indiv)] || {};
          var team = hint.team || teamGuess;
          var region = hint.region || '';
          var mid = ensureMember_(members, team, indiv, person.role, region, teamsSet);
          addBlockKpis_(kpis, b, kra, team, mid, indiv, person.role);
        }
      });
    } catch (e) { warn_('tab ' + name + ': ' + (e && e.message)); }
  });

  // Build team list with a lead (most senior role, else first member).
  var teams = Object.keys(teamsSet).map(function (tn) {
    var mem = members.filter(function (m) { return m.team === tn; });
    var lead = pickLead_(mem);
    mem.forEach(function (m) { m.isLead = (lead && m.id === lead.id); });
    return { id: slug_(tn), name: tn, lead: lead ? lead.name : '' };
  });

  return { teams: teams, members: members, kpis: kpis, tabs: tabs, blockCount: blockCount };
}

/* Split a grid into scorecard blocks: each block = an optional title row + a
 * header row (Perspective/KRA/KPI/Weightage/Target 1..) + the KPI rows under it. */
function extractBlocks_(grid) {
  var blocks = [], headerRows = [];
  for (var r = 0; r < grid.length; r++) {
    if (isKpiHeader_(grid[r])) headerRows.push(r);
  }
  headerRows.forEach(function (hr, hi) {
    var title = findTitleAbove_(grid, hr);
    var end = (hi + 1 < headerRows.length) ? headerRows[hi + 1] - 0 : grid.length;
    // stop the block before the next block's title
    var rows = [];
    for (var r = hr + 1; r < end; r++) {
      if (isKpiHeader_(grid[r])) break;
      rows.push(grid[r]);
    }
    blocks.push({ title: title, header: grid[hr], rows: rows });
  });
  return blocks;
}

function isKpiHeader_(row) {
  var rn = row.map(norm_);
  var has = function (t) { return rn.some(function (c) { return c.indexOf(t) >= 0; }); };
  return has('kra') && (has('kpi') || has('kpi / definition') || has('kpi description')) &&
         has('weightage') && (has('target 1') || has('needs improvement') || has('unit'));
}

/* Find the merged/title row just above a header row (the person or template). */
function findTitleAbove_(grid, hr) {
  for (var r = hr - 1; r >= 0 && r >= hr - 4; r--) {
    var first = firstNonEmpty_(grid[r]);
    if (!first) continue;
    if (isKpiHeader_(grid[r])) break;
    return String(first).trim();
  }
  return '';
}

function mapCols_(header) {
  var n = header.map(norm_);
  function find(preds, from) {
    for (var c = (from || 0); c < n.length; c++) {
      for (var p = 0; p < preds.length; p++) if (n[c].indexOf(preds[p]) >= 0) return c;
    }
    return -1;
  }
  var kpiCol = find(['kpi / definition', 'kpi description', 'kpi']);
  // KRA = the 'kra' column nearest-left of KPI (col0 may be a spurious label)
  var kraCol = -1; for (var c = 0; c < (kpiCol < 0 ? n.length : kpiCol); c++) if (n[c].indexOf('kra') >= 0) kraCol = c;
  if (kraCol < 0) kraCol = find(['kra']);
  var src = find(['source of tracking', 'source']);
  var cols = {
    perspective: find(['perspective']), kra: kraCol, kpi: kpiCol,
    weight: find(['weightage']), unit: find(['unit of measurement', 'units of measurement', 'unit']),
    source: src, bands: []
  };
  var start = -1;
  for (var i = 0; i < n.length; i++) { if (n[i].indexOf('target 1') >= 0 || n[i].indexOf('needs improvement') >= 0) { start = i; break; } }
  if (start < 0) start = (cols.unit >= 0 ? cols.unit + 1 : header.length - 5);
  for (var b = 0; b < 5; b++) cols.bands.push(start + b);
  return cols;
}

var BAND_LABELS = ['Target 1', 'Target 2', 'Target 3', 'Target 4', 'Target 5'];

function addBlockKpis_(kpis, block, cols, team, memberId, indiv, role) {
  block.rows.forEach(function (row) {
    if (isTotalsRow_(row, cols) || isTitleRow_(row)) return;
    var kra = cell_(row, cols.kra), kpiName = cell_(row, cols.kpi);
    if (!kra && !kpiName) return;
    var bands = cols.bands.map(function (bc, i) { return makeBand_(i + 1, row[bc], BAND_LABELS[i]); });
    var weight = parseNum_(cell_(row, cols.weight));
    var unit = cell_(row, cols.unit) || inferUnit_(bands);
    // Display KPI name = the KRA area when the "KPI" cell is just a TAT/metric label.
    var displayKpi = kpiName;
    if (/^tat\b|^document completeness$|^approved sop|^automation|^collection %|^dso days$|^pdd |^legacy /i.test(kpiName) && kra) {
      displayKpi = kra;
    }
    var kpiId = slug_([team, indiv, kra, kpiName].join('|'));
    kpis.push({
      id: kpiId, kpiId: kpiId, team: team, memberId: memberId, individual: indiv, role: role || '',
      perspective: cell_(row, cols.perspective), kra: kra, kpi: displayKpi || kra || kpiName,
      definition: kpiName || kra, source: cell_(row, cols.source),
      unit: unit, weight: weight, direction: detectDirection_(bands),
      target: targetFromBands_(bands, DEFAULT_SETTINGS.targetBandLevel), bands: bands
    });
  });
}

/* Extract a person's name + role from a block title like "NAME (ROLE)". Returns
 * empty name for team templates (Business Development / Demand / Supply / etc.). */
function personFromTitle_(title) {
  if (!title) return { name: '', role: '' };
  var t = title.replace(/\\\[merged\\\]/g, '').trim();
  var low = t.toLowerCase();
  if (/business development|demand|supply|purchase & sales|sales kra|kpi/i.test(low) && !/\(/.test(t)) {
    return { name: '', role: '' };
  }
  var m = t.match(/^(.+?)\s*\(([^)]*)\)\s*$/);
  if (m) {
    var nm = m[1].trim(), role = m[2].trim();
    if (/business development|demand|supply|purchase|sales kra|kra & kpi/i.test(nm.toLowerCase())) return { name: '', role: '' };
    if (looksLikeName_(nm)) return { name: cleanName_(nm), role: role };
  }
  // "Individual - NAME" / "Collections - NAME"
  var m2 = t.match(/[-–]\s*([A-Za-z][A-Za-z .]+)\s*$/);
  if (m2 && /individual|collections|omp/i.test(low)) return { name: cleanName_(m2[1]), role: '' };
  if (looksLikeName_(t)) return { name: cleanName_(t), role: '' };
  return { name: '', role: '' };
}
function looksLikeName_(s) {
  if (!s) return false;
  var w = s.trim().split(/\s+/);
  if (w.length > 5) return false;
  if (/business|development|demand|supply|sales|kra|kpi|scorecard|perspective|target/i.test(s)) return false;
  return /^[A-Za-z][A-Za-z. ]+$/.test(s);
}

/* Team resolution: tab name -> role suffix -> KPI content. */
function resolveTeam_(tabName, role, rows, cols) {
  var byTab = teamFromText_(tabName); if (byTab) return byTab;
  var byRole = teamFromText_(role);   if (byRole) return byRole;
  var joined = rows.map(function (r) { return [cell_(r, cols.kra), cell_(r, cols.kpi), cell_(r, cols.perspective)].join(' '); }).join(' ').toLowerCase();
  var byKpi = teamFromText_(joined);  if (byKpi) return byKpi;
  return properCase_(tabName) || 'Other';
}
function teamFromText_(text) {
  if (!text) return '';
  var low = String(text).toLowerCase();
  for (var i = 0; i < TEAM_RULES.length; i++) {
    var rule = TEAM_RULES[i];
    for (var j = 0; j < rule.match.length; j++) if (low.indexOf(rule.match[j]) >= 0) return rule.id;
  }
  return '';
}

function collectRosterHints_(tabName, grid, out) {
  // A roster block has a "Region"/"POC" header. Names beneath map to a team.
  var section = teamFromText_(tabName);
  for (var r = 0; r < grid.length; r++) {
    var rn = grid[r].map(norm_);
    var label = norm_(firstNonEmpty_(grid[r]));
    var t = teamFromText_(label);
    if (t && rn.filter(function (x) { return x; }).length <= 2) section = t;   // section header e.g. "PLASTIC"
    var regionCol = rn.indexOf('region'), pocCol = rn.indexOf('poc');
    if (regionCol >= 0 && pocCol >= 0) { grid._rc = { regionCol: regionCol, pocCol: pocCol }; continue; }
    if (!grid._rc) continue;
    var poc = String(grid[r][grid._rc.pocCol] || '').trim();
    var region = String(grid[r][grid._rc.regionCol] || '').trim();
    if (poc && norm_(poc) !== 'poc' && section) {
      out[norm_(poc)] = { team: section, region: region };
    }
  }
}
function rosterForTeam_(team, hints, members) {
  var seen = {}, out = [];
  Object.keys(hints).forEach(function (k) {
    if (hints[k].team === team) { out.push({ name: titleCaseName_(k), role: 'Team Member', region: hints[k].region }); seen[k] = true; }
  });
  return out;
}

function ensureMember_(members, team, name, role, region, teamsSet) {
  teamsSet[team] = true;
  var id = slug_(team + '|' + name);
  var existing = members.filter(function (m) { return m.id === id; })[0];
  if (existing) { if (!existing.role && role) existing.role = role; return id; }
  members.push({ id: id, name: cleanName_(name), team: team, role: role || 'Team Member', region: region || '', isLead: false });
  return id;
}

function pickLead_(mem) {
  if (!mem.length) return null;
  var rank = ['head', 'manager', 'senior manager', 'lead', 'regional head', 'am ', 'assistant manager', 'senior', 'poc'];
  function score(m) {
    var r = (m.role || '').toLowerCase();
    if (/head|regional head/.test(r)) return 5;
    if (/senior manager/.test(r)) return 5;
    if (/manager/.test(r)) return 4;
    if (/lead/.test(r)) return 4;
    if (/senior/.test(r)) return 2;
    return 1;
  }
  return mem.slice().sort(function (a, b) { return score(b) - score(a); })[0];
}

/** ------------------------------------------------------------- band helpers */
function makeBand_(level, raw, label) {
  var text = raw == null ? '' : String(raw).trim();
  return { level: level, label: label, raw: text, value: parseBandValue_(text) };
}
function parseBandValue_(text) {
  if (text == null) return null;
  var s = String(text).trim();
  if (!s || s === '-' || s === '–' || s === '—') return null;
  s = s.replace(/,/g, '').replace(/([A-Za-z])-/g, '$1 ');
  var m = s.match(/\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : null;
}
function detectDirection_(bands) {
  var vals = bands.map(function (b) { return b.value; }).filter(function (v) { return v != null; });
  if (vals.length < 2) return 'qualitative';
  var f = vals[0], l = vals[vals.length - 1];
  return l > f ? 'higher' : l < f ? 'lower' : 'higher';
}
function targetFromBands_(bands, level) {
  var b = bands[Math.max(0, Math.min(4, level - 1))];
  if (b && b.value != null) return b.value;
  for (var i = 0; i < bands.length; i++) if (bands[i].value != null) return bands[i].value;
  return null;
}
function inferUnit_(bands) {
  var j = bands.map(function (b) { return b.raw; }).join(' ').toLowerCase();
  if (j.indexOf('%') >= 0) return 'Percentage';
  if (j.indexOf('day') >= 0) return 'Days';
  if (j.indexOf('cr') >= 0) return '₹ Cr';
  return 'Number';
}

/** ------------------------------------------------------------ grid helpers */
function safeValues_(sh) { try { var r = sh.getDataRange(); return r ? r.getValues() : []; } catch (e) { return []; } }
function isTitleRow_(row) {
  var n = row.map(norm_).filter(function (x) { return x; });
  if (n.length === 0) return true;
  return /\(poc\)|\(regional head\)|\(manager|\(executive|\(senior|\(assistant|\(management trainee|business development|^demand$|^metal$|^plastic$/.test(norm_(firstNonEmpty_(row)));
}
function isTotalsRow_(row, cols) {
  var kra = cell_(row, cols.kra), kpi = cell_(row, cols.kpi);
  if (kra || kpi) return false;
  return cell_(row, cols.weight) !== '';
}
function cell_(row, i) { return i >= 0 && i < row.length ? String(row[i] == null ? '' : row[i]).trim() : ''; }
function firstNonEmpty_(row) { for (var c = 0; c < row.length; c++) if (String(row[c] == null ? '' : row[c]).trim() !== '') return row[c]; return ''; }
function cleanName_(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }
function titleCaseName_(s) { return String(s || '').replace(/\w\S*/g, function (t) { return t.charAt(0).toUpperCase() + t.substr(1); }); }
function properCase_(s) { s = String(s || '').trim(); return s ? s.charAt(0).toUpperCase() + s.slice(1) : ''; }
function norm_(v) { return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().toLowerCase(); }
function slug_(s) { return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 200); }
function parseNum_(raw) { if (raw == null || String(raw).trim() === '') return null; var m = String(raw).replace(/,/g, '').match(/\d+(?:\.\d+)?/); return m ? Number(m[0]) : null; }
function warn_(msg) { PARSE_WARNINGS_.push(msg); try { Logger.log('parse: ' + msg); } catch (e) {} }

/** =========================================================== ACTUALS STORE */
var ACTUAL_HEADER = ['Team', 'MemberId', 'Individual', 'KpiId', 'KpiName', 'Period',
  'Actual', 'Rating', 'Commentary', 'Evidence', 'UpdatedBy', 'UpdatedAt'];

function ensureActualsSheet_() {
  var ss = SpreadsheetApp.openById(SOURCE_SPREADSHEET_ID);
  var sh = ss.getSheetByName(TAB_ACTUALS);
  if (!sh) {
    sh = ss.insertSheet(TAB_ACTUALS);
    sh.getRange(1, 1, 1, ACTUAL_HEADER.length).setValues([ACTUAL_HEADER]);
    sh.setFrozenRows(1); try { sh.hideSheet(); } catch (e) {}
  }
  return sh;
}
function readActuals_() {
  var sh = ensureActualsSheet_();
  var data = safeValues_(sh), map = {}, periods = {}, count = 0, last = '';
  if (data.length < 2) return { map: map, periods: [], count: 0, lastUpdated: '' };
  var idx = colIndex_(data[0]);
  for (var r = 1; r < data.length; r++) {
    var row = data[r];
    var memberId = String(row[idx.MemberId] || '').trim();
    var kpiId = String(row[idx.KpiId] || '').trim();
    var period = String(row[idx.Period] || '').trim();
    if (!memberId || !kpiId || !period) continue;
    var updatedAt = row[idx.UpdatedAt] ? String(row[idx.UpdatedAt]) : '';
    map[actualKey_(memberId, kpiId, period)] = {
      actual: numOrNull_(row[idx.Actual]), rating: numOrNull_(row[idx.Rating]),
      commentary: String(row[idx.Commentary] || ''), evidence: String(row[idx.Evidence] || ''),
      updatedBy: String(row[idx.UpdatedBy] || ''), updatedAt: updatedAt
    };
    periods[period] = true; count++;
    if (updatedAt > last) last = updatedAt;
  }
  return { map: map, periods: Object.keys(periods).sort(), count: count, lastUpdated: last };
}
function buildActualRow_(header, p, who, now) {
  var idx = colIndex_(header), arr = new Array(header.length).fill('');
  arr[idx.Team] = p.team || ''; arr[idx.MemberId] = p.memberId; arr[idx.Individual] = p.individual || '';
  arr[idx.KpiId] = p.kpiId; arr[idx.KpiName] = p.kpiName || ''; arr[idx.Period] = p.period;
  arr[idx.Actual] = (p.actual === '' || p.actual == null) ? '' : Number(p.actual);
  arr[idx.Rating] = (p.rating === '' || p.rating == null) ? '' : Number(p.rating);
  arr[idx.Commentary] = p.commentary || ''; arr[idx.Evidence] = p.evidence || '';
  arr[idx.UpdatedBy] = who; arr[idx.UpdatedAt] = now.toISOString();
  return arr;
}
function colIndex_(header) { var idx = {}; header.forEach(function (h, i) { idx[String(h).trim()] = i; }); return idx; }
function actualKey_(m, k, p) { return [String(m).trim(), String(k).trim(), String(p).trim()].join('||'); }

/** ============================================================ SETTINGS STORE */
function ensureSettingsSheet_() {
  var ss = SpreadsheetApp.openById(SOURCE_SPREADSHEET_ID);
  var sh = ss.getSheetByName(TAB_SETTINGS);
  if (!sh) {
    sh = ss.insertSheet(TAB_SETTINGS);
    sh.getRange(1, 1, 1, 2).setValues([['Key', 'Value']]);
    var rows = Object.keys(DEFAULT_SETTINGS).map(function (k) { return [k, DEFAULT_SETTINGS[k]]; });
    sh.getRange(2, 1, rows.length, 2).setValues(rows);
    sh.setFrozenRows(1); try { sh.hideSheet(); } catch (e) {}
  }
  return sh;
}
function readSettings_() {
  var sh = ensureSettingsSheet_(), data = safeValues_(sh);
  var s = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  for (var r = 1; r < data.length; r++) {
    var k = String(data[r][0] || '').trim(); if (!k) continue;
    if (k === 'currentPeriod') s[k] = String(data[r][1] || '');
    else if (DEFAULT_SETTINGS.hasOwnProperty(k)) s[k] = Number(data[r][1]);
  }
  return s;
}
function writeSettings_(s) {
  var sh = ensureSettingsSheet_();
  var rows = Object.keys(DEFAULT_SETTINGS).map(function (k) { return [k, s[k] != null ? s[k] : DEFAULT_SETTINGS[k]]; });
  sh.clearContents();
  sh.getRange(1, 1, 1, 2).setValues([['Key', 'Value']]);
  sh.getRange(2, 1, rows.length, 2).setValues(rows);
}

/** ---------------------------------------------------------------- utilities */
function defaultPeriods_() {
  var out = [], d = new Date(); d.setDate(1);
  for (var i = 2; i >= 0; i--) { var dd = new Date(d.getFullYear(), d.getMonth() - i, 1); out.push(ym_(dd)); }
  return out;
}
function thisMonth_() { return ym_(new Date()); }
function ym_(d) { var m = d.getMonth() + 1; return d.getFullYear() + '-' + (m < 10 ? '0' + m : '' + m); }
function uniqueSorted_(arr) { var seen = {}, out = []; arr.forEach(function (x) { if (x && !seen[x]) { seen[x] = true; out.push(x); } }); return out.sort(); }
function numOrNull_(v) { if (v === '' || v == null) return null; var n = Number(v); return isNaN(n) ? null : n; }
function clamp_(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }
function round1_(x) { return x == null || isNaN(x) ? null : Math.round(x * 10) / 10; }
function round2_(x) { return x == null || isNaN(x) ? null : Math.round(x * 100) / 100; }
function nowIso_() { return new Date().toISOString(); }
function safeUser_() { var e = ''; try { e = Session.getActiveUser().getEmail() || ''; } catch (x) {} if (!e) { try { e = Session.getEffectiveUser().getEmail() || ''; } catch (y) {} } return { email: e }; }
function invalidateCache_() { try { var c = CacheService.getScriptCache(); c.remove(CACHE_KEY); c.remove(CACHE_KEY + '_fw'); } catch (e) {} }
