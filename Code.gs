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
var BACKEND_SHEET_ID = '16I2P3N9k2I0e4Xa0jWWdqWl0kpgHxw6tU-Y1sviwsTw';  /* single source of truth */
var SOURCE_SPREADSHEET_ID = BACKEND_SHEET_ID;

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

/* ---- PINNED TEAM REGISTRY ----
 * The org has exactly these 5 teams, each with a named lead. The engine still
 * parses the sheet generically, but every raw tab is mapped onto one of these
 * canonical teams (so "Plastic (Supply KRAKPI)" and "Plastic (Demand KRAKPI)"
 * both land under "Plastics", and the truncated "Open Marketplace - Control
 * Towe" reads as "Marketplace – Control Tower"). Editable via apiSaveTeams;
 * member rosters fill in when the separate roster sheets are provided. */
var DEFAULT_TEAMS = [
  { key: 'metal',       name: 'Metal',                       lead: 'Amit Jha',           patterns: ['metal'],                                     members: [] },
  { key: 'plastics',    name: 'Plastics',                    lead: 'Tabesh Mohammad',    patterns: ['plastic'],                                   members: [] },
  { key: 'onboarding',  name: 'Onboarding',                  lead: 'Ajay',               patterns: ['onboarding'],                                members: [] },
  { key: 'collections', name: 'Collections',                 lead: 'Srinivas',           patterns: ['collection'],                                members: [] },
  { key: 'marketplace', name: 'Marketplace – Control Tower', lead: 'Ashwin Kumar Singh', patterns: ['open marketplace', 'control tow', 'marketplace', 'control tower'], members: [] }
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
    assertUnlocked_(period);
    var model = buildModel_(period, settings);           // framework (+ any existing actuals)
    var sh = ensureActualsSheet_(settings);
    var data = sh.getDataRange().getValues();
    var head = data.length ? data[0] : ACTUALS_HEADERS_();
    var col = actualsCols_(head, sh.getName());
    var existing = {};
    for (var i = 1; i < data.length; i++) existing[cleanCell_(data[i][col.kpiid]) + '|' + String(data[i][col.period]).trim()] = true;

    // Build each row against the sheet's OWN column positions, so a source with
    // a different column order still receives the right values.
    var rows = [];
    model.records.forEach(function (r) {
      if (existing[r.kpiId + '|' + period]) return;
      var row = blankRow_(head.length);
      var put = function (key, val) { if (col[key] != null) row[col[key]] = val; };
      put('kpiid', r.kpiId);         put('period', period);
      put('department', r.department); put('subteam', r.subTeam || '');
      put('employee', r.employee);   put('kra', r.kra); put('kpi', r.kpi);
      put('unit', r.unit || '');     put('weight%', r.weightShown == null ? '' : r.weightShown);
      put('target', r.meetsValue == null ? '' : r.meetsValue);
      put('updatedat', nowIso_());   put('updatedby', safeEmail_());
      rows.push(row);
    });
    if (rows.length) sh.getRange(sh.getLastRow() + 1, 1, rows.length, head.length).setValues(rows);
    bustCache_(period);
    return { ok: true, added: rows.length, period: period, total: sh.getLastRow() - 1, tab: sh.getName() };
  } catch (err) { return { ok: false, error: String(err && err.message || err) }; }
}

/** Upsert one actual/target/rating for a KPI × period; recompute follows on refresh. */
function apiSaveActual(p) {
  p = p || {};
  try {
    if (!p.kpiId) throw new Error('Missing kpiId.');
    var settings = readSettings_();
    var period = p.period || settings.period || currentPeriod_();
    assertUnlocked_(period);
    var sh = ensureActualsSheet_(settings);
    var data = sh.getDataRange().getValues();
    var head = data[0];
    var col = actualsCols_(head, sh.getName());
    var row = -1;
    for (var i = 1; i < data.length; i++) if (cleanCell_(data[i][col.kpiid]) === p.kpiId && String(data[i][col.period]).trim() === String(period)) { row = i; break; }

    var rec = row >= 0 ? data[row].slice() : blankRow_(head.length);
    while (rec.length < head.length) rec.push('');
    var put = function (key, val) { if (col[key] != null) rec[col[key]] = val; };
    put('kpiid', p.kpiId); put('period', period);
    if (p.actual   !== undefined) put('actual',   p.actual === '' ? '' : num_(p.actual));
    if (p.target   !== undefined) put('target',   p.target === '' ? '' : num_(p.target));
    if (p.rating   !== undefined) put('rating',   p.rating === '' ? '' : clamp_(num_(p.rating), 1, 5));
    if (p.comment  !== undefined) put('comment',  String(p.comment || ''));
    if (p.evidence !== undefined) put('evidence', String(p.evidence || ''));
    put('updatedat', nowIso_()); put('updatedby', safeEmail_());

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

/** Persist the pinned team registry (names, leads, tab patterns, members). */
function apiSaveTeams(p) {
  try {
    p = p || {};
    var teams = (typeof p.teams === 'string') ? JSON.parse(p.teams) : p.teams;
    if (!teams || !teams.length) throw new Error('At least one team is required.');
    var s = readSettings_();
    s.teams = teams.map(function (t, i) {
      return {
        key: String(t.key || slug_(t.name) || ('team' + i)),
        name: String(t.name || 'Team ' + (i + 1)),
        lead: String(t.lead || ''),
        patterns: (Array.isArray(t.patterns) ? t.patterns : String(t.patterns || '').split(',')).map(function (x) { return String(x).trim(); }).filter(Boolean),
        members: Array.isArray(t.members) ? t.members.map(function (m) { return String(m).trim(); }).filter(Boolean) : []
      };
    });
    writeSettings_(s); bustCache_(s.period);
    return { ok: true, settings: s };
  } catch (err) { return { ok: false, error: String(err && err.message || err) }; }
}

/** ========================================================= BUILD MODEL */
function buildModel_(period, settings) {
  settings = settings || readSettings_();
  period = period || settings.period || currentPeriod_();

  var ss;
  /* The generic "cannot open" message cost a deploy cycle to diagnose: it hid
   * both which id was tried and why it failed. Name the id and the likely
   * cause, because this is the one error a user sees before any UI exists. */
  try { ss = SpreadsheetApp.openById(SOURCE_SPREADSHEET_ID); }
  catch (e) {
    var why = !SOURCE_SPREADSHEET_ID
      ? 'No spreadsheet id is configured.'
      : 'Spreadsheet ' + SOURCE_SPREADSHEET_ID + ' could not be opened. Check the id is correct and that ' +
        (function(){ try { return Session.getEffectiveUser().getEmail() || 'this account'; } catch (x) { return 'this account'; } })() +
        ' has at least view access.';
    return { ok: false, connected: false, empty: true,
             error: why, detail: String(e && e.message || e),
             spreadsheetId: SOURCE_SPREADSHEET_ID || null, generatedAt: nowIso_() };
  }

  var sheets = ss.getSheets();

  // ---- PASS 1: rosters (people → team + region), needed to expand templates.
  var rosterByTeam = {};
  sheets.forEach(function (sh) {
    if (isManaged_(sh.getName())) return;
    var grid = safeValues_(sh);
    if (classifyTab_(grid, sh.getName()).kind === 'roster') parseRoster_(grid, rosterByTeam);
  });

  // ---- PASS 2: departments / people / KPI records.
  var ctx = { depts: [], deptById: {}, subTeams: [], subById: {}, employees: [], empById: {}, records: [], seenKpiId: {}, order: 0, notes: [], statusScale: settings.statusScale, teams: settings.teams };
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

  // ---- TARGET-INPUT LAYER: the plan workbooks assign a target to a person, so
  //      a KPI can read Target → Actual → Achievement % → Rating. Injected here,
  //      before finalizeTeams_, so these teams get lead resolution + ordering.
  var targets = injectTargetPlan_(ctx, period);

  // ---- reconcile against the pinned team registry.
  finalizeTeams_(ctx, settings);

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
    // A target-sourced record already carries its assigned target and actual from
    // the plan workbook. computeRecord_ would reset target to the "Meets" band
    // (90% of plan) and null the actual, so score it on its own terms instead.
    if (r.targetSourced) scoreTargetRecord_(r, settings, all.byKey[r.kpiId + '|' + period] || null);
    else computeRecord_(r, all.byKey[r.kpiId + '|' + period] || all.byKey[r.kpiId + '|'] || null, settings, asg);
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
      teams: settings.teams,
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
    targets: targets,
    notes: ctx.notes
  };
}

/** ==================================================== TARGET-INPUT LAYER */
/**
 * Pull the per-team target plans for `period` and register them as real
 * departments / people / KPI records, using the same ctx getters the sheet
 * parsers use so ids and shapes stay native. Returns the plan hierarchy for the
 * management "Targets" view (team target → individual allocation → buyer lines).
 */
function injectTargetPlan_(ctx, period) {
  var tp;
  try { tp = targetRecordsFor_(period); }
  catch (e) { ctx.notes.push('Target plan unavailable: ' + (e && e.message || e)); return { teams: [], periods: [], available: false }; }

  var deptIds = {};
  tp.plan.teams.forEach(function (t) {
    if (!t.connected || !t.allocation.length) return;
    var dept = getDept_(ctx, t.team, 'targets');
    dept.targetPlan = t.summary;
    dept.targetMode = t.mode;
    dept.qtyUnit = t.qtyUnit;
    deptIds[t.key] = dept.id;

    t.allocation.forEach(function (m) {
      var region = m.region || '—';
      var sub = getSubTeam_(ctx, dept, region);
      var emp = getEmployee_(ctx, dept, m.name, m.rh ? (region + ' POC · RH ' + m.rh) : (region + ' POC'), region, false);
      if (emp.subTeamIds.indexOf(sub.id) < 0) emp.subTeamIds.push(sub.id);
      emp.targetPlan = {
        gmvTarget: m.gmvTarget, gmvActual: m.gmvActual, qtyTarget: m.qtyTarget, qtyActual: m.qtyActual,
        qtyUnit: t.qtyUnit, txnTarget: m.txnTarget, txnActual: m.txnActual,
        supTarget: m.supTarget, buyTarget: m.buyTarget,
        achievementPct: m.achievementPct, qtyAchievementPct: m.qtyAchievementPct,
        share: m.share, rh: m.rh, region: region,
        buyerCount: m.buyerCount, buyerLines: m.buyerLines, buyers: m.buyers || []
      };

      TARGET_KPIS.forEach(function (k) {
        var target = m[k.tKey];
        if (target == null) return;                 // nothing assigned ⇒ no KPI line
        var actual = k.aKey ? m[k.aKey] : null;
        var base = [dept.id, sub.id, slug_(m.name), slug_(k.kra), slug_(k.kpi)].join('.');
        var kpiId = base, i = 2;
        while (ctx.seenKpiId[kpiId]) kpiId = base + '.' + (i++);
        ctx.seenKpiId[kpiId] = true;
        var rec = {
          kpiId: kpiId,
          deptId: dept.id, department: dept.name,
          subTeamId: sub.id, subTeam: sub.name,
          employeeId: emp.id, employee: emp.name, role: emp.role, region: region,
          perspective: k.persp, kra: k.kra, kpi: k.kpi,
          definition: k.definition, method: k.method, source: k.method,
          weight: k.weight, weightShown: k.weight, weightNorm: null,
          // Counts must stay unitless — inheriting qtyUnit rendered "3 suppliers" as "3 MT".
          metricType: k.type, unit: k.unit || '',
          qualitative: false, direction: 1, directionKey: 'higher', directionSource: 'declared',
          bands: gmvBands_(target),
          meetsValue: Math.round(target * 0.9 * 1000) / 1000,
          planTarget: target, target: target,
          actual: actual, hasActual: actual != null,
          targetSourced: true, primaryMetric: !!k.primary,
          targetSource: t.team + ' target plan · ' + (t.tabs[0] || 'workbook'),
          bandSource: 'target-plan', weightSource: 'target-plan',
          comment: '', evidence: '', updatedAt: null,
          checkins: [], checkinCount: 0
        };
        emp.kpiIds.push(kpiId);
        sub.kpiCount++; dept.kpiCount++;
        ctx.records.push(rec);
      });
    });
  });

  return {
    available: tp.plan.teams.some(function (t) { return t.connected; }),
    periods: tsPeriods_(),
    teams: tp.plan.teams.map(function (t) {
      return { key: t.key, team: t.team, deptId: deptIds[t.key] || null, configured: t.configured,
               connected: t.connected, mode: t.mode, qtyUnit: t.qtyUnit, error: t.error,
               summary: t.summary, concentration: t.concentration, tabs: t.tabs,
               buyerLines: t.buyerLines, unownedBuyers: t.unownedBuyers,
               allocation: t.allocation.map(function (m) {
                 return { name: m.name, region: m.region, rh: m.rh, share: m.share,
                          gmvTarget: m.gmvTarget, gmvActual: m.gmvActual, achievementPct: m.achievementPct,
                          qtyTarget: m.qtyTarget, qtyActual: m.qtyActual, qtyAchievementPct: m.qtyAchievementPct,
                          txnTarget: m.txnTarget, txnActual: m.txnActual,
                          supTarget: m.supTarget, buyTarget: m.buyTarget,
                          buyerCount: m.buyerCount, buyerLines: m.buyerLines, buyers: m.buyers || [],
                          employeeId: (deptIds[t.key] ? deptIds[t.key] + '::' + slug_(m.name) : null) };
               }) };
    })
  };
}

/**
 * Score a target-sourced record. The KPI's own rating logic is reused verbatim
 * (its band ladder + direction), but ACHIEVEMENT is measured against the
 * assigned plan target rather than the "Meets" band — so ₹5.80 Cr against a
 * ₹6.50 Cr target reads 89.2%, not 99%. An actuals-sheet row for the same KPI
 * still wins, so a manual correction is always possible.
 */
function scoreTargetRecord_(r, settings, a) {
  if (a) {
    if (a.actual != null) { r.actual = a.actual; r.hasActual = true; r.actualSource = 'actuals-sheet'; }
    if (a.target != null) { r.planTarget = a.target; r.target = a.target; r.bands = gmvBands_(a.target); r.meetsValue = Math.round(a.target * 0.9 * 1000) / 1000; }
    if (a.comment) r.comment = a.comment;
    if (a.evidence) r.evidence = a.evidence;
    if (a.updatedAt) r.updatedAt = a.updatedAt;
  }
  r.target = r.planTarget;
  var rating = null;
  if (r.actual != null) rating = ratingFromBands_(r.bands, r.actual, r.directionKey);
  else if (a && a.rating != null) rating = clamp_(a.rating, 1, 5);
  r.rating = rating;
  r.achievedBand = bandLabelForRating_(r.bands, rating);
  r.attainment = (r.actual != null && r.planTarget) ? round1_(r.actual / r.planTarget * 100) : null;
  r.scorePct = scoreFromRating_(rating, settings.scoring);
  r.status = statusFromRating_(rating, settings.statusScale);
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
  var rd = resolveDeptSub_(ctx, tabName, 'scorecard');
  var ds = { dept: rd.dept.name, sub: rd.sub };
  var dept = rd.dept;
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
  var rd = resolveDeptSub_(ctx, tabName, 'individuals');
  var dept = rd.dept;
  var subTeam = rd.sub ? getSubTeam_(ctx, dept, rd.sub) : null;   // e.g. a "… - Supply" blocks tab
  var headers = cls.headerRows;
  headers.forEach(function (hr, i) {
    var end = (i + 1 < headers.length) ? headers[i + 1] : grid.length;
    var cols = mapCols_(grid[hr]);
    var person = personForHeader_(grid, hr);
    var emp = getEmployee_(ctx, dept, person.name || ('Member ' + (i + 1)), person.role || '', person.region || '', false);
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
  var dept = resolveDeptSub_(ctx, tabName, 'info').dept;
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
/* Evidence is ranked, strongest first: an explicit Unit column beats what the
 * band cells look like, which beats guessing from the KPI's name. Without that
 * ordering a KPI like "PDD Recovered" measured in ₹ Cr gets read as Days purely
 * because "pdd" appears in the days-ish name pattern. */
function classifyMetric_(unit, bands, name, def, direction) {
  var u = norm_(unit);
  var s = norm_((name || '') + ' ' + (def || ''));
  var numeric = bands.filter(function (b) { return b.num != null; }).length;
  if (numeric < 2) return { metricType: 'Qualitative', targetLogic: 'text' };
  var bandHas = function (re) { return bands.some(function (b) { return re.test(String(b.raw || '')); }); };

  var mt = null;
  // 1) the declared unit.
  if (u) {
    if (u.indexOf('day') >= 0) mt = 'Days';
    else if (u.indexOf('cr') >= 0 || u.indexOf('₹') >= 0 || u.indexOf('inr') >= 0 || u.indexOf('lakh') >= 0 || u.indexOf('amount') >= 0) mt = 'Amount';
    else if (u.indexOf('percent') >= 0 || u.indexOf('%') >= 0) mt = 'Percentage';
    else if (u.indexOf('count') >= 0 || u.indexOf('number') >= 0 || u.indexOf('nos') >= 0) mt = 'Count';
  }
  // 2) what the band cells actually contain.
  if (!mt) {
    if (bandHas(/₹|\bcr\b|lakh/i)) mt = 'Amount';
    else if (bandHas(/%/)) mt = 'Percentage';
    else if (bandHas(/day/i)) mt = 'Days';
  }
  // 3) the KPI's own language, last.
  if (!mt) {
    if (/\b(dso|tat|pdd)\b|days/.test(s)) mt = 'Days';
    else if (/gmv|revenue|recover|amount|collection value|\bvalue\b/.test(s)) mt = 'Amount';
    else if (/\brate\b|retention|adherence|coverage|\bdn\b|automation|accuracy/.test(s)) mt = 'Percentage';
    else if (/count|number of|no\.? of|# of|cases|tickets|escalations/.test(s)) mt = 'Count';
    else mt = 'Number';
  }
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
    var m = map[key] || (map[key] = { name: key, sw: 0, sr: 0, sp: 0, kpis: 0, withData: 0, weight: 0, points: 0, people: {} });
    m.kpis++; m.people[r.employeeId] = true;
    if (r.weightShown != null) m.weight += r.weightShown;
    if (r.points != null) m.points += r.points;
    if (r.rating != null && r.weightNorm != null) { m.sw += r.weightNorm; m.sr += r.weightNorm * r.rating; m.sp += r.weightNorm * r.scorePct; m.withData++; }
  });
  return Object.keys(map).map(function (k) {
    var m = map[k];
    var rating = m.sw > 0 ? round2_(m.sr / m.sw) : null;
    var people = Object.keys(m.people).length;
    return {
      name: m.name, rating: rating,
      score: m.sw > 0 ? round1_(m.sp / m.sw) : null,
      kpis: m.kpis, withData: m.withData, people: people,
      // Weightage is only additive inside ONE person's scorecard. Across several
      // people the sum is meaningless, so expose the per-person average instead
      // and let the caller say which it is showing.
      weight: people === 1 ? round1_(m.weight) : null,
      avgWeight: people ? round1_(m.weight / people) : null,
      points: people === 1 ? round1_(m.points) : null,
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

/* Reconcile parsed departments against the pinned registry: drop the phantom
 * "scorecard" placeholders a template tab creates once a team has real people,
 * resolve each team's declared lead to an actual employee where possible, and
 * order the departments to match the registry. */
function finalizeTeams_(ctx, settings) {
  // 1) suppress template-placeholder employees (and their records) for any dept
  //    that also carries real, named people — a shared template is a framework,
  //    not a headcount.
  var realByDept = {};
  ctx.employees.forEach(function (e) { if (!e.isTemplate) realByDept[e.deptId] = true; });
  var drop = {};
  ctx.employees = ctx.employees.filter(function (e) {
    if (e.isTemplate && realByDept[e.deptId]) { drop[e.id] = true; delete ctx.empById[e.id]; return false; }
    return true;
  });
  ctx.records = ctx.records.filter(function (r) { return !drop[r.employeeId]; });

  // 1b) prune sub-teams no surviving record references — a template tab's
  //     "Business Development" section otherwise leaves an empty "Supply · 0".
  var subUsed = {};
  ctx.records.forEach(function (r) { if (r.subTeamId) subUsed[r.subTeamId] = true; });
  ctx.subTeams = ctx.subTeams.filter(function (s) { return subUsed[s.id]; });
  Object.keys(ctx.subById).forEach(function (k) { if (!subUsed[k]) delete ctx.subById[k]; });
  ctx.employees.forEach(function (e) { e.subTeamIds = (e.subTeamIds || []).filter(function (id) { return subUsed[id]; }); });

  // 2) resolve declared leads to a real employee in the same team (by name).
  ctx.depts.forEach(function (d) {
    if (!d.lead) return;
    var want = norm_(d.lead);
    var hit = ctx.employees.filter(function (e) { return e.deptId === d.id; })
      .filter(function (e) { return norm_(e.name) === want || norm_(e.name).indexOf(want) >= 0 || want.indexOf(norm_(e.name)) >= 0; })[0];
    if (hit) { d.leadEmployeeId = hit.id; d.leadRole = hit.role || 'Team Lead'; d.leadResolved = true; hit.isLead = true; }
    else { d.leadResolved = false; }
  });

  // 3) order departments by the registry, unregistered tabs last.
  var order = {};
  (settings.teams || DEFAULT_TEAMS).forEach(function (t, i) { order[t.key] = i; });
  ctx.depts.sort(function (a, b) {
    var oa = a.teamKey && order[a.teamKey] != null ? order[a.teamKey] : 900 + a.order;
    var ob = b.teamKey && order[b.teamKey] != null ? order[b.teamKey] : 900 + b.order;
    return oa - ob;
  });
}

/** ==================================================== CTX GETTERS */
function getDept_(ctx, name, kind) {
  var id = slug_(name);
  if (!ctx.deptById[id]) {
    var d = { id: id, name: cleanCell_(name), kind: kind, order: ctx.order++, kpiCount: 0, employeeCount: 0, rating: null, status: statusFromRating_(null), subTeamIds: [], rawTable: null, weightNote: null,
              teamKey: '', lead: '', leadEmployeeId: null, leadRole: '', leadResolved: false, registered: false, registeredMembers: [] };
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
  return { name: '', role: '', region: '' };
}
/* Parse a block-owner title into { name, role, region }. Real sheets are messy:
 * the title often carries a trailing "| Region - South", the parenthetical role
 * can be anything ("Management Trainee", not just manager/executive), and only
 * the name before the "(" needs to look like a person — so we anchor on the
 * LEADING "Name (Role)" shape and tolerate whatever trails it, instead of
 * requiring the string to end at the ")". */
function personName_(text) {
  var t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return { name: '', role: '', region: '' };

  // pull a trailing "| Region - South" / "Region: North" off first
  var region = '';
  var rg = t.match(/[|,;]\s*region\s*[-–:]\s*([A-Za-z .&]+?)\s*$/i);
  if (rg) { region = cleanName_(rg[1]); t = t.slice(0, rg.index).trim(); }
  // then drop any remaining trailing "| …" segment (region without a label, etc.)
  var pipe = t.indexOf('|');
  if (pipe > 0) t = t.slice(0, pipe).trim();

  var m = t.match(/^individual\s*[-–:]\s*(.+)$/i);
  if (m) return { name: cleanName_(m[1]), role: '', region: region };
  m = t.match(/^(?:collections?|onboarding|supply|demand)[^-–:]*[-–:]\s*(.+)$/i);
  if (m && looksLikeName_(m[1])) return { name: cleanName_(m[1]), role: '', region: region };
  // "Name (Role)…"  — accept any parenthetical role once the name reads as a
  // person; the ")" no longer has to be the end of the string.
  m = t.match(/^([A-Za-z][A-Za-z.\s]{1,40}?)\s*\(([^)]{1,80})\)/);
  if (m && looksLikeName_(m[1])) return { name: cleanName_(m[1]), role: cleanName_(m[2]), region: region };
  if (looksLikeName_(t)) return { name: cleanName_(t), role: '', region: region };
  return { name: '', role: '', region: region };
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
  var s = String(name || '');
  // A tab that names BOTH sides ("Metal (Supply & Demand KRAKPI)") is a combined
  // scorecard, not a sub-team — only split when exactly one side is named.
  var hasSupply = /\b(supply|seller)\b/i.test(s), hasDemand = /\b(demand|buyer)\b/i.test(s);
  if (hasSupply !== hasDemand) {
    var m = s.match(/^(.*?)[\s\-–—:(]+\s*(supply|demand|seller|buyer)\b.*$/i);
    if (m) {
      var base = m[1].replace(/[\-–—:(]+$/, '').trim();
      var tok = m[2].toLowerCase();
      if (base) return { dept: base, sub: (tok === 'supply' || tok === 'seller') ? 'Supply' : 'Demand' };
    }
  }
  return { dept: cleanCell_(name), sub: null };
}

/* ---- canonical team resolution ---- */
/* Map a raw tab name onto a registered team by pattern. Returns the team or
 * null (an unregistered tab keeps its own name, e.g. a stray reference tab). */
function canonicalTeam_(rawName, teams) {
  var n = norm_(rawName);
  teams = teams && teams.length ? teams : DEFAULT_TEAMS;
  for (var i = 0; i < teams.length; i++) {
    var pats = teams[i].patterns || [];
    for (var p = 0; p < pats.length; p++) {
      if (pats[p] && n.indexOf(norm_(pats[p])) >= 0) return teams[i];
    }
  }
  return null;
}
/* Resolve a tab to its canonical department (+ sub-team), attaching the team's
 * declared lead. Every parser routes through this so tabs collapse into the
 * fixed 5 teams. */
function resolveDeptSub_(ctx, tabName, kind) {
  var ds = splitDeptSub_(tabName);
  var team = canonicalTeam_(tabName, ctx.teams);
  var deptName = team ? team.name : ds.dept;
  var dept = getDept_(ctx, deptName, kind);
  if (team) {
    dept.teamKey = team.key;
    dept.lead = team.lead || '';
    dept.registered = true;
    dept.registeredMembers = team.members || [];
  }
  // template scorecards are only a framework; a real blocks tab upgrades the kind
  if (kind === 'individuals') dept.kind = 'individuals';
  return { dept: dept, sub: ds.sub, team: team };
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
/* Resolve the actuals sheet the SAME way readAllActuals_ does. When an external
 * source is configured, reads come from it — so writes must go there too, or a
 * saved actual lands in the master tab and never appears again. */
function ensureActualsSheet_(settings) {
  settings = settings || readSettings_();
  var headers = ACTUALS_HEADERS_();
  var ss, tab;
  if (settings.actualsSheetId) { ss = SpreadsheetApp.openById(settings.actualsSheetId); tab = settings.actualsTab || ACTUALS_TAB; }
  else { ss = SpreadsheetApp.openById(SOURCE_SPREADSHEET_ID); tab = ACTUALS_TAB; }
  var sh = ss.getSheetByName(tab);
  if (!sh) { sh = ss.insertSheet(tab); sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold'); sh.setFrozenRows(1); }
  else if (sh.getLastRow() === 0) sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
  return sh;
}
/* ONE header-matching rule, shared by every reader and writer. Case, spacing
 * and punctuation are ignored ("KPI Id", "kpi_id" and "KpiId" all match), so
 * the read and write paths can never disagree about which column is which. */
function normCols_(head) {
  var col = {};
  (head || []).forEach(function (h, i) { var k = norm_(h).replace(/[^a-z0-9%]/g, ''); if (k && col[k] == null) col[k] = i; });
  return col;
}
/* Same mapping, but for writes — where a missing key column must fail loudly
 * rather than silently write into nothing or append duplicate rows. */
/* `keys` are [normalisedKey, headerAsWritten] pairs so the error can name the
 * column the way it appears in the sheet, not the internal key. */
function requireCols_(head, keys, tab) {
  var col = normCols_(head);
  for (var i = 0; i < keys.length; i++) {
    var k = keys[i][0], label = keys[i][1];
    if (col[k] == null) throw new Error('The "' + tab + '" sheet has no "' + label + '" column, so rows cannot be matched. Restore that header, or delete the tab and let it be rebuilt.');
  }
  return col;
}
function actualsCols_(head, tab) { return requireCols_(head, [['kpiid', 'KpiId'], ['period', 'Period']], tab || ACTUALS_TAB); }
function blankRow_(n) { var r = []; for (var i = 0; i < n; i++) r.push(''); return r; }
/* Existing row padded to the header width, or a fresh blank row. */
function blankOr_(data, row, width) {
  var rec = row >= 0 ? data[row].slice() : [];
  while (rec.length < width) rec.push('');
  return rec;
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
  var head = data[0], col = normCols_(head);
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
  var col = normCols_(data[0]);
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
    var head = data[0], col = requireCols_(head, [['period', 'Period']], CYCLES_TAB);
    var row = -1;
    for (var i = 1; i < data.length; i++) if (String(data[i][col.period]).trim() === String(p.period).trim()) { row = i; break; }
    var rec = blankOr_(data, row, head.length);
    var put = function (k, v) { if (col[k] != null) rec[col[k]] = v; };
    put('period', p.period);
    if (p.name      !== undefined) put('name',      String(p.name || ''));
    if (p.startDate !== undefined) put('startdate', String(p.startDate || ''));
    if (p.endDate   !== undefined) put('enddate',   String(p.endDate || ''));
    if (p.status    !== undefined) put('status',    String(p.status || 'Active'));
    if (p.reviewDue !== undefined) put('reviewdue', String(p.reviewDue || ''));
    if (p.note      !== undefined) put('note',      String(p.note || ''));
    if (col.name != null && !rec[col.name]) rec[col.name] = periodLabel_(p.period);
    if (col.status != null && !rec[col.status]) rec[col.status] = 'Active';
    put('updatedat', nowIso_()); put('updatedby', safeEmail_());
    if (row >= 0) sh.getRange(row + 1, 1, 1, head.length).setValues([rec]);
    else          sh.getRange(sh.getLastRow() + 1, 1, 1, head.length).setValues([rec]);
    bustCache_(p.period);
    return { ok: true, period: p.period, status: col.status != null ? rec[col.status] : 'Active' };
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
  var col = normCols_(data[0]);
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
    var head = data[0], col = requireCols_(head, [['kpiid', 'KpiId'], ['period', 'Period']], ASSIGNMENTS_TAB);
    var row = -1;
    for (var i = 1; i < data.length; i++) if (cleanCell_(data[i][col.kpiid]) === p.kpiId && String(data[i][col.period]).trim() === String(period)) { row = i; break; }
    var rec = blankOr_(data, row, head.length);
    var put = function (k, v) { if (col[k] != null) rec[col[k]] = v; };
    put('kpiid', p.kpiId); put('period', period);
    if (p.employee  !== undefined) put('employee',  String(p.employee || ''));
    if (p.kpi       !== undefined) put('kpi',       String(p.kpi || ''));
    if (p.weight    !== undefined) put('weight%',   p.weight === '' ? '' : num_(p.weight));
    if (p.direction !== undefined) put('direction', String(p.direction || ''));
    if (p.reviewer  !== undefined) put('reviewer',  String(p.reviewer || ''));
    if (p.note      !== undefined) put('note',      String(p.note || ''));
    if (p.bands !== undefined && p.bands) for (var b = 1; b <= 5; b++) put('target' + b, p.bands[b - 1] == null ? '' : String(p.bands[b - 1]));
    put('updatedat', nowIso_()); put('updatedby', safeEmail_());
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
  var col = normCols_(data[0]);
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

    // Roll the check-in forward into the actuals row (the current position).
    // If that write fails the log entry still stands, so say so rather than
    // reporting a clean save the numbers do not reflect.
    var fwd = { kpiId: p.kpiId, period: period, comment: p.comment, evidence: p.evidence };
    if (p.actual !== undefined && p.actual !== '') fwd.actual = p.actual;
    if (p.rating !== undefined && p.rating !== '') fwd.rating = p.rating;
    var rolled = apiSaveActual(fwd);
    bustCache_(period);
    if (!rolled || !rolled.ok) {
      return { ok: false, checkinId: rec[col.CheckinId], kpiId: p.kpiId, period: period,
               error: 'Check-in logged, but the current value could not be updated: ' + ((rolled && rolled.error) || 'unknown error') };
    }
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
  var col = normCols_(data[0]);
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
    var head = data[0], col = requireCols_(head, [['employeeid', 'EmployeeId'], ['period', 'Period']], REVIEWS_TAB);
    var row = -1;
    for (var i = 1; i < data.length; i++) if (cleanCell_(data[i][col.employeeid]) === p.employeeId && String(data[i][col.period]).trim() === String(period)) { row = i; break; }
    var rec = blankOr_(data, row, head.length);
    var put = function (k, v) { if (col[k] != null) rec[col[k]] = v; };
    var statusNow = function () { return col.status != null ? rec[col.status] : ''; };
    put('period', period); put('employeeid', p.employeeId);
    if (p.employee   !== undefined) put('employee',   String(p.employee || ''));
    if (p.department !== undefined) put('department', String(p.department || ''));
    if (p.systemRating !== undefined) put('systemrating', p.systemRating === '' ? '' : num_(p.systemRating));
    if (p.systemScore  !== undefined) put('systemscore',  p.systemScore === '' ? '' : num_(p.systemScore));

    var now = nowIso_(), who = safeEmail_();
    if (stage === 'self') {
      if (p.rating  !== undefined) put('selfrating',  p.rating === '' ? '' : clamp_(num_(p.rating), 1, 5));
      if (p.comment !== undefined) put('selfcomment', String(p.comment || ''));
      put('selfby', who); put('selfat', now);
      if (p.submit) put('status', 'Manager Review');
      else if (!statusNow() || statusNow() === 'Not Started') put('status', 'Self Review');
    } else if (stage === 'manager') {
      if (p.rating  !== undefined) put('managerrating',  p.rating === '' ? '' : clamp_(num_(p.rating), 1, 5));
      if (p.comment !== undefined) put('managercomment', String(p.comment || ''));
      put('managerby', who); put('managerat', now);
      put('status', p.submit ? 'Final Review' : 'Manager Review');
    } else {
      if (p.rating  !== undefined) put('finalrating',  p.rating === '' ? '' : clamp_(num_(p.rating), 1, 5));
      if (p.comment !== undefined) put('finalcomment', String(p.comment || ''));
      put('status', p.submit ? 'Complete' : 'Final Review');
    }
    put('updatedat', now); put('updatedby', who);
    if (row >= 0) sh.getRange(row + 1, 1, 1, head.length).setValues([rec]);
    else          sh.getRange(sh.getLastRow() + 1, 1, 1, head.length).setValues([rec]);
    bustCache_(period);
    return { ok: true, employeeId: p.employeeId, period: period, status: statusNow() };
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
/* How many recent months the period switch always offers, even before any data
 * exists for them. A rolling window means the list advances by itself each
 * month instead of needing a code change. */
var PERIOD_WINDOW = 3;

/** The last `n` months ending at `current`, newest first. */
function recentPeriods_(current, n) {
  var m = /^(\d{4})-(\d{2})$/.exec(current || '');
  if (!m) return [];
  var y = Number(m[1]), mo = Number(m[2]), out = [];
  for (var i = 0; i < (n || PERIOD_WINDOW); i++) {
    out.push(y + '-' + ('0' + mo).slice(-2));
    mo--; if (mo < 1) { mo = 12; y--; }
  }
  return out;
}

function knownPeriods_(all, current, cycles, assignments) {
  var set = {}; set[current] = true;
  (all && all.periods || []).forEach(function (p) { if (p) set[p] = true; });
  ((cycles && cycles.list) || []).forEach(function (c) { if (c.period) set[c.period] = true; });
  Object.keys((assignments && assignments.periods) || {}).forEach(function (p) { if (p) set[p] = true; });
  // the rolling window, so a month is selectable before its data lands
  recentPeriods_(current, PERIOD_WINDOW).forEach(function (p) { set[p] = true; });
  // and any month a target-plan workbook describes (GmvSource.gs is optional)
  try { if (typeof tsPeriods_ === 'function') tsPeriods_().forEach(function (p) { if (p) set[p] = true; }); } catch (e) {}
  return Object.keys(set).sort().reverse();
}

/** ==================================================== SETTINGS */
function readSettings_() {
  var s = {
    period: '',
    thresholds: { onTrack: DEFAULT_THRESHOLDS.onTrack, atRisk: DEFAULT_THRESHOLDS.atRisk },
    scoring: { ratingPct: DEFAULT_SCORING.ratingPct.slice(), interpolate: DEFAULT_SCORING.interpolate },
    statusScale: DEFAULT_STATUS_SCALE.map(function (x) { return { key: x.key, label: x.label, min: x.min }; }),
    teams: DEFAULT_TEAMS.map(function (t) { return { key: t.key, name: t.name, lead: t.lead, patterns: t.patterns.slice(), members: (t.members || []).slice() }; }),
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
        if (o.teams && o.teams.length) s.teams = o.teams;
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

/*******************************************************************************
 * ============================================================================
 * GMV / TARGET SOURCE — merged in from GmvSource.gs
 * ============================================================================
 * Apps Script shares one global scope across every .gs file, so this module
 * behaved identically as a separate file; it is inlined here to keep the
 * project to the two files that get pasted into the editor: Code.gs and
 * Index.html. Code.gs calls gmvBands_, tsPeriods_ and targetRecordsFor_ from
 * this section, so deleting it rather than merging would have broken the app.
 *******************************************************************************/

/*******************************************************************************
 * GmvSource.gs — reads "OPEN MARKETPLACE GMV PLAN-METAL.xlsx" and turns it into
 * the KRA/KPI model the dashboard renders.
 *
 * WHY THIS FILE EXISTS
 * The source is an .xlsx in Drive, not a native Google Sheet, so
 * SpreadsheetApp.openById() throws on it. This module converts it to a native
 * Sheet on demand (Advanced Drive Service), caches the converted copy, and
 * re-converts only when the .xlsx is edited — so the dashboard tracks the file
 * live without anyone converting it by hand.
 *
 * SETUP REQUIRED BEFORE THIS RUNS
 *   1. Apps Script editor → Services → add "Drive API" with identifier `Drive`.
 *      (v2 is what Drive.Files.insert below expects.)
 *   2. appsscript.json needs the wider Drive scope — drive.file is NOT enough,
 *      because the .xlsx was created by someone else:
 *        "https://www.googleapis.com/auth/drive"
 *   3. Re-authorise the web app after adding the scope.
 *
 * SCHEMA OF THE SOURCE (5 tabs, transcribed from the file)
 *   "July26 GMV Targets"        data starts in column B (column A is blank)
 *     Team Member | Buyer Name | Region | Product Category | Qty Target (MT)
 *     | GMV Target (Cr) | GMV Achievement (Cr)
 *     ...then a SUMMARY block, then a "Target vs Achievement" block holding the
 *     only onboarding actuals in the workbook (team level, not per person).
 *   "July26 Onboarding Plan"    data starts in column B
 *     Team Member | New Region | New Suppliers (Target) | New Buyers (Target)
 *     | Total Onboardings (Auto) | Notes
 *   "August26 GMV Targets"      data starts in column A, and has NO achievement
 *     column — August is plan-only.
 *   "August26 Onboarding Plan"  data starts in column A
 *   "Buyer-Supplier Mapping"    Buyer | Team Member | Supplier 1..4 | Category
 *     | Est. Volume | Est. GMV | Status | NBFC Pitch | Payment Terms | Capacity
 *
 * Because the leading-blank-column differs per tab, nothing here hardcodes cell
 * positions — headers are located by scanning for their labels.
 ******************************************************************************/

var GMV_FILE_ID   = '1kmmh8mio78QsF1lUz9ihDoYwDVbe1JDe';
var GMV_DEPT_NAME = 'Metal';
/* period key -> the tabs that describe it */
var GMV_PERIODS = [
  { period: '2026-07', gmvTab: 'July26 GMV Targets',   onbTab: 'July26 Onboarding Plan'   },
  { period: '2026-08', gmvTab: 'August26 GMV Targets', onbTab: 'August26 Onboarding Plan' }
];

/* ---------------------------------------------------------------- plumbing */

/** Native-Sheet handle for the .xlsx, converting + caching as needed. */
function gmvSpreadsheet_() {
  var props = PropertiesService.getScriptProperties();
  var srcStamp = '';
  try { srcStamp = DriveApp.getFileById(GMV_FILE_ID).getLastUpdated().toISOString(); } catch (e) {
    throw new Error('Cannot read the GMV workbook (' + GMV_FILE_ID + '): ' + e.message);
  }
  var cachedId = props.getProperty('GMV_CONV_ID');
  if (cachedId && props.getProperty('GMV_CONV_STAMP') === srcStamp) {
    try { return SpreadsheetApp.openById(cachedId); } catch (e) { /* fall through and rebuild */ }
  }
  if (typeof Drive === 'undefined') {
    throw new Error('Advanced Drive Service is not enabled — add "Drive API" under Services.');
  }
  var blob = DriveApp.getFileById(GMV_FILE_ID).getBlob();
  var made = Drive.Files.insert(
    { title: '[auto] ' + GMV_DEPT_NAME + ' GMV plan (converted)', mimeType: MimeType.GOOGLE_SHEETS },
    blob, { convert: true });
  props.setProperty('GMV_CONV_ID', made.id);
  props.setProperty('GMV_CONV_STAMP', srcStamp);
  if (cachedId && cachedId !== made.id) {
    try { DriveApp.getFileById(cachedId).setTrashed(true); } catch (e) {}
  }
  return SpreadsheetApp.openById(made.id);
}

function gmvNorm_(v) { return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().toLowerCase(); }

/**
 * Locate a header row by the labels it must contain, anywhere in the grid.
 * Returns { row: <0-based>, col: {label -> 0-based index} } or null.
 * This is what makes the July (offset by one column) and August (not offset)
 * layouts parse with the same code.
 */
function gmvHeader_(values, required) {
  var need = required.map(gmvNorm_);
  for (var r = 0; r < values.length; r++) {
    var row = values[r], map = {}, hits = 0;
    for (var c = 0; c < row.length; c++) {
      var cell = gmvNorm_(row[c]);
      if (!cell) continue;
      for (var i = 0; i < need.length; i++) {
        if (map[need[i]] === undefined && cell.indexOf(need[i]) === 0) { map[need[i]] = c; hits++; }
      }
    }
    if (hits === need.length) return { row: r, col: map };
  }
  return null;
}

/** "₹0.36", "1,125", "8Cr", "8.45Cr" -> Number, else null. */
function gmvNum_(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return v;
  var s = String(v).replace(/[₹,\s]/g, '');
  var cr = /cr$/i.test(s);
  s = s.replace(/cr$/i, '');
  var n = parseFloat(s);
  if (!isFinite(n)) return null;
  return cr ? n : n;
}

/**
 * True when a row ends the block its header opened.
 *
 * This matters more than it looks. Each tab stacks several blocks under one
 * another — the buyer-wise rows, then TEAM GRAND TOTAL, then SUMMARY, then the
 * "Target vs Achievement" block. Scanning to the end of the sheet picks up
 * "Seller Onboarding", "GMV" and the SUMMARY sub-header as if they were people.
 * So a block is read only until its terminator.
 */
function gmvIsBlockEnd_(v) {
  var s = gmvNorm_(v);
  if (!s) return false;
  return /^(team\s+)?(grand\s+)?total\b/.test(s) || s === 'summary' || s === 'team member';
}

function gmvTitle_(s) {
  return String(s || '').toLowerCase().replace(/\b[a-z]/g, function (m) { return m.toUpperCase(); }).trim();
}

/* ------------------------------------------------------------- tab parsers */

/** Buyer-wise GMV rows -> per-member { gmvTarget, gmvActual, qtyTarget, buyers[] } */
function gmvParseGmvTab_(sh) {
  if (!sh) return {};
  var values = sh.getDataRange().getValues();
  var h = gmvHeader_(values, ['team member', 'buyer name', 'region', 'qty target', 'gmv target']);
  if (!h) return {};
  var cM = h.col['team member'], cB = h.col['buyer name'], cR = h.col['region'],
      cQ = h.col['qty target'], cT = h.col['gmv target'];
  // the achievement column exists only on months that are closed
  var cA = null;
  var hdr = values[h.row];
  for (var c = 0; c < hdr.length; c++) if (gmvNorm_(hdr[c]).indexOf('gmv achievement') === 0) cA = c;

  var out = {};
  for (var r = h.row + 1; r < values.length; r++) {
    var row = values[r];
    if (gmvIsBlockEnd_(row[cM])) break;      // stop at TEAM GRAND TOTAL / SUMMARY
    if (!gmvNorm_(row[cM])) continue;        // blank spacer inside the block
    var name = gmvTitle_(row[cM]);
    if (!out[name]) out[name] = { region: '', gmvTarget: 0, gmvActual: null, qtyTarget: 0, buyers: [], hasActual: false };
    var o = out[name];
    if (!o.region) o.region = gmvTitle_(row[cR]);
    var t = gmvNum_(row[cT]), q = gmvNum_(row[cQ]);
    if (t != null) o.gmvTarget += t;
    if (q != null) o.qtyTarget += q;
    if (cA != null) {
      var a = gmvNum_(row[cA]);
      if (a != null) { o.gmvActual = (o.gmvActual || 0) + a; o.hasActual = true; }
    }
    if (row[cB]) o.buyers.push(String(row[cB]).trim());
  }
  // round the accumulations — floating point on ₹0.36 x 3 is ugly otherwise
  Object.keys(out).forEach(function (k) {
    out[k].gmvTarget = Math.round(out[k].gmvTarget * 1000) / 1000;
    if (out[k].gmvActual != null) out[k].gmvActual = Math.round(out[k].gmvActual * 1000) / 1000;
  });
  return out;
}

/** Onboarding plan -> per-member { supTarget, buyTarget } */
function gmvParseOnboardingTab_(sh) {
  if (!sh) return {};
  var values = sh.getDataRange().getValues();
  var h = gmvHeader_(values, ['team member', 'new suppliers', 'new buyers']);
  if (!h) return {};
  var cM = h.col['team member'], cS = h.col['new suppliers'], cB = h.col['new buyers'];
  var cR = null, hdr = values[h.row];
  for (var c = 0; c < hdr.length; c++) if (gmvNorm_(hdr[c]).indexOf('new region') === 0) cR = c;

  var out = {};
  for (var r = h.row + 1; r < values.length; r++) {
    var row = values[r];
    if (gmvIsBlockEnd_(row[cM])) break;      // stop at TEAM TOTAL, before the name lists
    if (!gmvNorm_(row[cM])) continue;
    var name = gmvTitle_(row[cM]);
    out[name] = {
      region: cR != null ? gmvTitle_(row[cR]) : '',
      supTarget: gmvNum_(row[cS]),
      buyTarget: gmvNum_(row[cB])
    };
  }
  return out;
}

/**
 * The "Target vs Achievement" block on the July tab — the ONLY onboarding
 * actuals anywhere in the workbook, and they are team-level, not per person.
 * Shape is a label column followed by Target/Achievement rows.
 */
function gmvParseTeamActuals_(sh) {
  if (!sh) return {};
  var values = sh.getDataRange().getValues();
  var out = {}, current = null;
  for (var r = 0; r < values.length; r++) {
    var row = values[r];
    for (var c = 0; c < row.length; c++) {
      var cell = gmvNorm_(row[c]);
      if (!cell) continue;
      if (/^(seller onboarding|buyer onboarding|gmv)$/.test(cell)) { current = cell; continue; }
      if (current && (cell === 'target' || cell === 'achievement')) {
        var v = null;
        for (var k = c + 1; k < row.length && v == null; k++) v = gmvNum_(row[k]);
        if (v != null) {
          if (!out[current]) out[current] = {};
          out[current][cell] = v;
        }
      }
    }
  }
  return out;
}

/** Buyer-Supplier Mapping -> rows, surfaced as reference context. */
function gmvParseMapping_(sh) {
  if (!sh) return [];
  var values = sh.getDataRange().getValues();
  var h = gmvHeader_(values, ['buyer name', 'team member', 'supplier 1']);
  if (!h) return [];
  var cB = h.col['buyer name'], cM = h.col['team member'], cS = h.col['supplier 1'];
  var cStatus = null, hdr = values[h.row];
  for (var c = 0; c < hdr.length; c++) if (gmvNorm_(hdr[c]) === 'status') cStatus = c;
  var out = [];
  for (var r = h.row + 1; r < values.length; r++) {
    var row = values[r];
    if (!row[cB]) continue;
    out.push({
      buyer: String(row[cB]).trim(),
      member: gmvTitle_(row[cM]),
      supplier: String(row[cS] || '').trim(),
      status: cStatus != null ? String(row[cStatus] || '').trim() : ''
    });
  }
  return out;
}

/* ------------------------------------------------------------ model build */

/** The four KPIs the workbook actually measures, with their weightage. */
var GMV_KPIS = [
  { kpi: 'GMV delivered',           kra: 'GMV delivery', persp: 'Growth', unit: 'Cr', type: 'Amount', weight: 50, tKey: 'gmvTarget', aKey: 'gmvActual' },
  { kpi: 'Volume delivered',        kra: 'GMV delivery', persp: 'Growth', unit: 'MT', type: 'Number', weight: 20, tKey: 'qtyTarget', aKey: null },
  { kpi: 'New suppliers onboarded', kra: 'Onboarding',   persp: 'Supply', unit: '',   type: 'Number', weight: 15, tKey: 'supTarget', aKey: null },
  { kpi: 'New buyers onboarded',    kra: 'Onboarding',   persp: 'Demand', unit: '',   type: 'Number', weight: 15, tKey: 'buyTarget', aKey: null }
];

/** 5-band ladder at 60/75/90/100/105% of target — the dashboard's rubric. */
function gmvBands_(target) {
  return [0.6, 0.75, 0.9, 1, 1.05].map(function (f, i) {
    var v = Math.round(target * f * 100) / 100;
    return { label: 'Target ' + (i + 1), raw: String(v), num: v };
  });
}

function gmvRating_(att) {
  if (att == null) return null;
  if (att >= 1.05) return 5;
  if (att >= 1)    return 4;
  if (att >= 0.9)  return 3;
  if (att >= 0.75) return 2;
  return 1;
}

/**
 * Read every tab for `period` and return { members, teamActuals, mapping }.
 * Exposed so apiBootstrap can call it per period.
 */
function gmvReadPeriod_(period) {
  var spec = null;
  for (var i = 0; i < GMV_PERIODS.length; i++) if (GMV_PERIODS[i].period === period) spec = GMV_PERIODS[i];
  if (!spec) return null;
  var ss = gmvSpreadsheet_();
  var gmv = gmvParseGmvTab_(ss.getSheetByName(spec.gmvTab));
  var onb = gmvParseOnboardingTab_(ss.getSheetByName(spec.onbTab));
  var members = {};
  Object.keys(gmv).forEach(function (n) { members[n] = gmv[n]; });
  Object.keys(onb).forEach(function (n) {
    if (!members[n]) members[n] = { region: onb[n].region, gmvTarget: 0, gmvActual: null, qtyTarget: 0, buyers: [] };
    members[n].supTarget = onb[n].supTarget;
    members[n].buyTarget = onb[n].buyTarget;
    if (!members[n].region) members[n].region = onb[n].region;
  });
  return {
    members: members,
    teamActuals: gmvParseTeamActuals_(ss.getSheetByName(spec.gmvTab)),
    mapping: gmvParseMapping_(ss.getSheetByName('Buyer-Supplier Mapping')),
    tabs: [spec.gmvTab, spec.onbTab]
  };
}

/** Employees + records for a period, in the shape apiBootstrap already emits. */
function gmvRecordsFor_(period) {
  var read = gmvReadPeriod_(period);
  if (!read) return { employees: [], records: [], subTeams: [] };
  var names = Object.keys(read.members).sort();
  var subIdx = {}, subTeams = [], employees = [], records = [], n = 0;

  names.forEach(function (name, i) {
    var m = read.members[name];
    var region = m.region || '—';
    if (!subIdx[region]) {
      subIdx[region] = { id: 's' + (subTeams.length + 1), name: region, deptId: 'd1', deptName: GMV_DEPT_NAME };
      subTeams.push(subIdx[region]);
    }
    employees.push({
      id: 'e' + (i + 1), name: name, role: region + ' POC', region: region,
      department: GMV_DEPT_NAME, deptId: 'd1',
      subTeamIds: [subIdx[region].id], subName: region,
      review: { status: 'Not started' }
    });
    GMV_KPIS.forEach(function (k) {
      n++;
      var target = m[k.tKey];
      var actual = k.aKey ? (m[k.aKey] == null ? null : m[k.aKey]) : null;
      var att = (actual == null || !target) ? null : Math.round(actual / target * 1000) / 1000;
      var rating = gmvRating_(att);
      records.push({
        kpiId: 'r' + n, employeeId: 'e' + (i + 1), employee: name,
        deptId: 'd1', department: GMV_DEPT_NAME,
        subTeamId: subIdx[region].id, subTeam: region,
        perspective: k.persp, kra: k.kra, kpi: k.kpi,
        definition: k.kpi + ' against the ' + period + ' plan (GMV workbook).',
        weight: k.weight, weightShown: k.weight, weightNorm: k.weight / 100,
        metricType: k.type, targetLogic: 'range', qualitative: false,
        direction: 'higher', directionKey: 'higher', directionSource: 'declared',
        unit: k.unit, bands: target ? gmvBands_(target) : [], target: target,
        actual: actual, hasActual: actual != null,
        achievedBand: rating ? ('Target ' + rating) : '',
        attainment: att, rating: rating,
        source: 'OPEN MARKETPLACE GMV PLAN-METAL.xlsx',
        bandSource: 'master', weightSource: 'master',
        checkins: [], checkinCount: 0
      });
    });
  });
  return { employees: employees, records: records, subTeams: subTeams, teamActuals: read.teamActuals, mapping: read.mapping };
}

/** Smoke test — run from the editor and read the log. */
function gmvSelfTest() {
  GMV_PERIODS.forEach(function (p) {
    var out = gmvRecordsFor_(p.period);
    var rated = out.records.filter(function (r) { return r.rating != null; });
    Logger.log('%s → %s people, %s KPIs, %s rated, team actuals: %s',
      p.period, out.employees.length, out.records.length, rated.length,
      JSON.stringify(out.teamActuals));
  });
}

/*==============================================================================
 * TARGET-INPUT LAYER — the bridge from business target to individual KPI
 * =============================================================================
 * The target plans are NOT displayed as spreadsheets. They are the layer that
 * ASSIGNS a target to a person, so a KPI can then read
 *
 *     Target  →  Actual  →  Achievement %  →  Rating  →  Status
 *
 * The KPI keeps its own identity (definition, measurement method, weightage,
 * band ladder, rating logic). The target plan only supplies the number it is
 * measured against. That separation is deliberate: re-planning a target must
 * never rewrite the KPI's definition or its weight.
 *
 * Hierarchy each team exposes, drilled in this order and no other:
 *   1. TEAM      — GMV target, quantity target, headcount, buyer target lines
 *   2. INDIVIDUAL— per-person GMV/quantity target, region, actual, achievement
 *   3. BUYER     — the buyer-wise lines behind one person's target (2nd level)
 *
 * Two teams, two source shapes, one contract:
 *   METAL   — "OPEN MARKETPLACE GMV PLAN-METAL.xlsx": buyer-wise GMV rows per
 *             member (₹ Cr + MT), onboarding targets, buyer-supplier mapping.
 *             August is plan-only; July carries achievement.
 *   PLASTIC — "OMP_*_Plastic_Proposal_Daily_Review.xlsx" → "POC-Wise": one row
 *             per POC already carrying BOTH target and achieved for GMV (₹ Cr),
 *             Tonnage (MT) and transaction count, plus the regional head.
 *============================================================================*/

/* Per-team target sources. `fileId` may be overridden from settings so a team
 * can be pointed at a new month's workbook without touching code. */
var TARGET_SOURCES = [
  { key: 'metal',   team: 'Metal',   shape: 'metalPlan',     fileId: GMV_FILE_ID, qtyUnit: 'MT' },
  { key: 'plastic', team: 'Plastic', shape: 'plasticPocWise', fileId: '',         qtyUnit: 'MT' }
];

function tsSources_() {
  var over = {};
  try {
    var raw = PropertiesService.getScriptProperties().getProperty('TARGET_SOURCE_IDS');
    if (raw) over = JSON.parse(raw) || {};
  } catch (e) {}
  return TARGET_SOURCES.map(function (s) {
    var o = {}; for (var k in s) o[k] = s[k];
    if (over[s.key]) o.fileId = String(over[s.key]);
    return o;
  });
}

/** Point a team at a workbook: apiSaveTargetSource({team:'plastic', fileId:'…'}) */
function apiSaveTargetSource(p) {
  p = p || {};
  try {
    var key = String(p.team || '').toLowerCase();
    if (!key) throw new Error('Missing team.');
    var props = PropertiesService.getScriptProperties();
    var cur = {};
    try { cur = JSON.parse(props.getProperty('TARGET_SOURCE_IDS') || '{}') || {}; } catch (e) {}
    var id = String(p.fileId || '').replace(/^.*\/d\/([-\w]{20,}).*$/, '$1').trim();
    if (id) cur[key] = id; else delete cur[key];
    props.setProperty('TARGET_SOURCE_IDS', JSON.stringify(cur));
    try { CacheService.getScriptCache().remove('TS_' + key); } catch (e) {}
    return { ok: true, sources: cur };
  } catch (err) { return { ok: false, error: String(err && err.message || err) }; }
}

/* Native-Sheet handle for any target workbook (same convert-and-cache trick as
 * gmvSpreadsheet_, generalised over file id). */
function tsSpreadsheet_(fileId, label) {
  if (!fileId) throw new Error('No workbook configured for ' + label + '.');
  /* If the workbook is already a native Google Sheet, open it directly — no
   * Drive API and no conversion needed. This must be checked BEFORE delegating
   * to gmvSpreadsheet_, which always demands the Advanced Drive Service. */
  try {
    if (/spreadsheet/i.test(DriveApp.getFileById(fileId).getMimeType())) return SpreadsheetApp.openById(fileId);
  } catch (e) { /* fall through to the conversion path */ }
  if (fileId === GMV_FILE_ID) return gmvSpreadsheet_();     // reuse the cached Metal conversion
  var props = PropertiesService.getScriptProperties();
  var stampKey = 'TS_STAMP_' + fileId, idKey = 'TS_CONV_' + fileId;
  var srcStamp = '';
  try { srcStamp = DriveApp.getFileById(fileId).getLastUpdated().toISOString(); }
  catch (e) { throw new Error('Cannot read the ' + label + ' workbook (' + fileId + '): ' + e.message); }
  var cached = props.getProperty(idKey);
  if (cached && props.getProperty(stampKey) === srcStamp) {
    try { return SpreadsheetApp.openById(cached); } catch (e) {}
  }
  var f = DriveApp.getFileById(fileId);
  if (/spreadsheet/i.test(f.getMimeType())) return SpreadsheetApp.openById(fileId);   // already native
  if (typeof Drive === 'undefined') throw new Error('Advanced Drive Service is not enabled — add "Drive API" under Services.');
  var made = Drive.Files.insert(
    { title: '[auto] ' + label + ' target plan (converted)', mimeType: MimeType.GOOGLE_SHEETS },
    f.getBlob(), { convert: true });
  props.setProperty(idKey, made.id); props.setProperty(stampKey, srcStamp);
  if (cached && cached !== made.id) { try { DriveApp.getFileById(cached).setTrashed(true); } catch (e) {} }
  return SpreadsheetApp.openById(made.id);
}

function tsNum_(v) { return gmvNum_(v); }
/* "-", "", "na" are MISSING, never zero. */
function tsVal_(v) { var s = String(v == null ? '' : v).replace(/\s+/g, ' ').trim(); if (!s || s === '-' || s === '—' || /^n\/?a$/i.test(s)) return ''; return s; }
function tsFindSheet_(ss, re) {
  var all = ss.getSheets();
  for (var i = 0; i < all.length; i++) if (re.test(all[i].getName())) return all[i];
  return null;
}
function tsPct_(a, t) { return (a == null || t == null || !t) ? null : Math.round(a / t * 1000) / 10; }

/* ---------------------------------------------------------- METAL shape ---- */
/* Buyer-wise rows → per-member allocation WITH the buyer lines kept for drill. */
function tsMetalPlan_(ss, period) {
  var spec = null;
  for (var i = 0; i < GMV_PERIODS.length; i++) if (GMV_PERIODS[i].period === period) spec = GMV_PERIODS[i];
  if (!spec) return null;
  var gsh = ss.getSheetByName(spec.gmvTab);
  if (!gsh) return null;
  var values = gsh.getDataRange().getValues();
  var h = gmvHeader_(values, ['team member', 'buyer name', 'region', 'qty target', 'gmv target']);
  if (!h) return null;
  var cM = h.col['team member'], cB = h.col['buyer name'], cR = h.col['region'],
      cQ = h.col['qty target'], cT = h.col['gmv target'], cC = null, cA = null;
  var hdr = values[h.row];
  for (var c = 0; c < hdr.length; c++) {
    var n = gmvNorm_(hdr[c]);
    if (n.indexOf('gmv achievement') === 0) cA = c;
    if (n.indexOf('product') === 0 || n.indexOf('category') === 0) cC = c;
  }
  var byName = {}, order = [], buyerLines = 0;
  for (var r = h.row + 1; r < values.length; r++) {
    var row = values[r];
    if (gmvIsBlockEnd_(row[cM])) break;
    if (!gmvNorm_(row[cM])) continue;
    var name = gmvTitle_(row[cM]);
    if (!byName[name]) { byName[name] = tsBlankMember_(name, gmvTitle_(row[cR])); order.push(name); }
    var m = byName[name];
    if (!m.region) m.region = gmvTitle_(row[cR]);
    var t = tsNum_(row[cT]), q = tsNum_(row[cQ]), a = cA != null ? tsNum_(row[cA]) : null;
    if (t != null) m.gmvTarget = Math.round((m.gmvTarget + t) * 1000) / 1000;
    if (q != null) m.qtyTarget = Math.round((m.qtyTarget + q) * 1000) / 1000;
    if (a != null) { m.gmvActual = Math.round(((m.gmvActual || 0) + a) * 1000) / 1000; }
    var buyer = tsVal_(row[cB]);
    buyerLines++;
    m.buyers.push({
      buyer: buyer || '(unnamed)', placeholder: !buyer || /^new\s+buyer$/i.test(buyer),
      bundled: buyer.indexOf('/') >= 0,
      region: gmvTitle_(row[cR]), category: cC != null ? gmvTitle_(row[cC]) : '',
      qty: q, gmvTarget: t, gmvActual: a
    });
  }
  // onboarding targets per member
  var onb = gmvParseOnboardingTab_(ss.getSheetByName(spec.onbTab)) || {};
  Object.keys(onb).forEach(function (n) {
    if (!byName[n]) { byName[n] = tsBlankMember_(n, onb[n].region); order.push(n); }
    byName[n].supTarget = onb[n].supTarget;
    byName[n].buyTarget = onb[n].buyTarget;
    if (!byName[n].region) byName[n].region = onb[n].region;
  });
  var teamActuals = gmvParseTeamActuals_(gsh) || {};
  return {
    members: order.map(function (n) { return byName[n]; }),
    buyerLines: buyerLines,
    teamActuals: teamActuals,
    mapping: gmvParseMapping_(ss.getSheetByName('Buyer-Supplier Mapping')) || [],
    tabs: [spec.gmvTab, spec.onbTab]
  };
}
function tsBlankMember_(name, region) {
  return { name: name, region: region || '', rh: '', gmvTarget: 0, gmvActual: null, qtyTarget: 0, qtyActual: null,
           txnTarget: null, txnActual: null, supTarget: null, supActual: null, buyTarget: null, buyActual: null, buyers: [] };
}

/* Which month does a whole workbook describe? Metal names its tabs per period,
 * but the Plastic daily-review carries ONE month with no period column — so its
 * numbers must not be replayed for another month. Read the month from the
 * workbook/tab title and refuse to answer for anything else. */
var TS_MONTHS_ = { jan:1, feb:2, mar:3, apr:4, may:5, jun:6, jul:7, aug:8, sep:9, oct:10, nov:11, dec:12 };
function tsPeriodOfText_(text) {
  var m = String(text || '').match(/([A-Za-z]{3,9})[\s_'-]*(\d{4})/);
  if (m) {
    var mo = TS_MONTHS_[m[1].slice(0, 3).toLowerCase()];
    if (mo) return m[2] + '-' + ('0' + mo).slice(-2);
  }
  m = String(text || '').match(/(\d{4})[\s_-]*([A-Za-z]{3,9})/);
  if (m) {
    var mo2 = TS_MONTHS_[m[2].slice(0, 3).toLowerCase()];
    if (mo2) return m[1] + '-' + ('0' + mo2).slice(-2);
  }
  return null;
}
function tsWorkbookPeriod_(ss) {
  var p = tsPeriodOfText_(ss.getName());
  if (p) return p;
  var all = ss.getSheets();
  for (var i = 0; i < all.length && i < 6; i++) {
    p = tsPeriodOfText_(all[i].getName());
    if (p) return p;
    var g = all[i].getDataRange().getValues();
    for (var r = 0; r < Math.min(g.length, 3); r++)
      for (var c = 0; c < g[r].length; c++) { p = tsPeriodOfText_(g[r][c]); if (p) return p; }
  }
  return null;
}

/* -------------------------------------------------------- PLASTIC shape ---- */
/* "POC-Wise": one row per POC carrying target AND achieved for GMV / tonnage /
 * transactions, plus the regional head. Several columns repeat the same label
 * further right (PET / Flakes / Others splits) so the FIRST match wins. */
function tsPlasticPocWise_(ss, period) {
  var sh = tsFindSheet_(ss, /poc\s*-?\s*wise/i);
  if (!sh) return null;
  var values = sh.getDataRange().getValues();
  var hr = -1, col = {};
  for (var r = 0; r < values.length && hr < 0; r++) {
    var row = values[r], seen = {}, hits = 0;
    for (var c = 0; c < row.length; c++) {
      var n = gmvNorm_(row[c]);
      if (!n) continue;
      if (seen[n] === undefined) { seen[n] = c; }
      if (n === 'poc') hits++;
      if (n === 'region') hits++;
    }
    if (hits >= 2 && seen['poc'] !== undefined) { hr = r; col = seen; }
  }
  if (hr < 0) return null;
  function find(re) {
    var row = values[hr];
    for (var c = 0; c < row.length; c++) if (re.test(gmvNorm_(row[c]))) return c;
    return -1;
  }
  var cPoc = col['poc'], cRegion = col['region'], cRh = find(/^rh[_ ]?name/);
  var cGt = find(/^gmv_?cr \(target\)/), cGa = find(/^gmv_?cr \(achieved\)/);
  var cTt = find(/^tonnage_?mt \(target\)/), cTa = find(/^tonnage_?mt \(achieved\)/);
  var cXt = find(/^txn target/), cXa = find(/^txn achieved/);
  var cSt = find(/^new seller onboarding tgt/), cSa = find(/^new seller onboarding achieved/);
  var cPlan = find(/^total onboarding sellers plan/);
  var members = [];
  for (var i = hr + 1; i < values.length; i++) {
    var row2 = values[i];
    var poc = tsVal_(row2[cPoc]);
    if (!poc) break;
    if (gmvIsBlockEnd_(poc)) break;
    var m = tsBlankMember_(gmvTitle_(poc), gmvTitle_(row2[cRegion]));
    m.rh = cRh >= 0 ? gmvTitle_(row2[cRh]) : '';
    m.gmvTarget = cGt >= 0 ? (tsNum_(row2[cGt]) || 0) : 0;
    m.gmvActual = cGa >= 0 ? tsNum_(row2[cGa]) : null;
    m.qtyTarget = cTt >= 0 ? (tsNum_(row2[cTt]) || 0) : 0;
    m.qtyActual = cTa >= 0 ? tsNum_(row2[cTa]) : null;
    m.txnTarget = cXt >= 0 ? tsNum_(row2[cXt]) : null;
    m.txnActual = cXa >= 0 ? tsNum_(row2[cXa]) : null;
    m.supTarget = cSt >= 0 ? tsNum_(row2[cSt]) : null;
    m.supActual = cSa >= 0 ? tsNum_(row2[cSa]) : null;
    m.sellerPlan = cPlan >= 0 ? tsNum_(row2[cPlan]) : null;
    members.push(m);
  }
  // buyer target lines, if the workbook carries an activation plan
  var buyerLines = 0;
  var bsh = tsFindSheet_(ss, /buyer plan/i);
  if (bsh) {
    var bv = bsh.getDataRange().getValues();
    var bh = gmvHeader_(bv, ['buyer name', 'transaction target']);
    if (bh) {
      var cbB = bh.col['buyer name'], cbT = bh.col['transaction target'];
      var cbR = -1, cbC = -1, hrow = bv[bh.row];
      for (var c2 = 0; c2 < hrow.length; c2++) {
        var nn = gmvNorm_(hrow[c2]);
        if (nn === 'region' && cbR < 0) cbR = c2;
        if (nn === 'commodity' && cbC < 0) cbC = c2;
      }
      var cbA = -1;
      for (var c3 = 0; c3 < hrow.length; c3++) if (/^transactions completed/.test(gmvNorm_(hrow[c3]))) cbA = c3;
      for (var j = bh.row + 1; j < bv.length; j++) {
        var br = bv[j], bn = tsVal_(br[cbB]);
        if (!bn) continue;
        if (gmvIsBlockEnd_(bn)) continue;
        buyerLines++;
        // no owner column on this tab — held at team level, not attributed to a person
        members.__unowned = members.__unowned || [];
        members.__unowned.push({ buyer: bn, placeholder: false, bundled: false,
          region: cbR >= 0 ? gmvTitle_(br[cbR]) : '', category: cbC >= 0 ? tsVal_(br[cbC]) : '',
          qty: null, gmvTarget: null, gmvActual: null,
          txnTarget: tsNum_(br[cbT]), txnActual: cbA >= 0 ? tsNum_(br[cbA]) : null });
      }
    }
  }
  return { members: members, buyerLines: buyerLines, teamActuals: {}, mapping: [],
           unownedBuyers: members.__unowned || [], tabs: [sh.getName()] };
}

/* ------------------------------------------------------- the shared build --- */
/**
 * Read every configured team for `period` and return the target hierarchy.
 * Returns { teams: [...], periods: [...], notes: [...] } — never throws for a
 * team whose workbook is missing; that team is reported as unconfigured.
 */
function targetPlanFor_(period) {
  var out = { teams: [], notes: [] };
  tsSources_().forEach(function (src) {
    var entry = { key: src.key, team: src.team, shape: src.shape, qtyUnit: src.qtyUnit,
                  configured: !!src.fileId, connected: false, period: period,
                  summary: null, allocation: [], concentration: null, buyerLines: 0,
                  unownedBuyers: [], mapping: [], tabs: [], mode: 'plan', error: '' };
    if (!src.fileId) {
      entry.error = 'No workbook configured for ' + src.team + '. Set it in Targets → source.';
      out.teams.push(entry); return;
    }
    var read = null;
    try {
      var ss = tsSpreadsheet_(src.fileId, src.team);
      if (src.shape === 'metalPlan') {
        read = tsMetalPlan_(ss, period);                  // per-period tabs, self-scoping
      } else {
        /* One-month workbook: only answer for the month it actually covers, so a
         * July view never shows August's numbers. */
        var wbPeriod = tsWorkbookPeriod_(ss);
        entry.workbookPeriod = wbPeriod;
        if (wbPeriod && wbPeriod !== period) {
          entry.error = 'The ' + src.team + ' workbook covers ' + wbPeriod + ', not ' + period + '.';
          out.teams.push(entry); return;
        }
        read = tsPlasticPocWise_(ss, period);
      }
    } catch (e) {
      entry.error = String(e && e.message || e);
      out.teams.push(entry); return;
    }
    if (!read) { entry.error = 'No target plan for ' + period + ' in the ' + src.team + ' workbook.'; out.teams.push(entry); return; }
    entry.connected = true;
    entry.tabs = read.tabs || [];
    entry.buyerLines = read.buyerLines || 0;
    entry.unownedBuyers = read.unownedBuyers || [];
    entry.mapping = read.mapping || [];

    var gT = 0, gA = null, qT = 0, qA = null, hasA = false;
    read.members.forEach(function (m) {
      gT += m.gmvTarget || 0; qT += m.qtyTarget || 0;
      if (m.gmvActual != null) { gA = (gA || 0) + m.gmvActual; hasA = true; }
      if (m.qtyActual != null) { qA = (qA || 0) + m.qtyActual; }
      m.buyerCount = (m.buyers || []).filter(function (b) { return !b.placeholder; }).length;
      m.buyerLines = (m.buyers || []).length;
      m.achievementPct = tsPct_(m.gmvActual, m.gmvTarget);
      m.qtyAchievementPct = tsPct_(m.qtyActual, m.qtyTarget);
    });
    gT = Math.round(gT * 1000) / 1000; qT = Math.round(qT * 1000) / 1000;
    if (gA != null) gA = Math.round(gA * 1000) / 1000;
    if (qA != null) qA = Math.round(qA * 1000) / 1000;

    /* July's Metal sheet copies target into the achievement column on every row,
     * so a row-sum is not real performance. Its team-level "Target vs
     * Achievement" block is. Prefer that when the two disagree. */
    var stated = read.teamActuals && read.teamActuals['gmv'] ? read.teamActuals['gmv'] : null;
    var statedT = stated && stated['target'] != null ? stated['target'] : null;
    var statedA = stated && stated['achievement'] != null ? stated['achievement'] : null;
    var rowsAreCopies = hasA && gA != null && Math.abs(gA - gT) < 0.005;
    var headA = (rowsAreCopies && statedA != null) ? statedA : gA;
    var basis = (rowsAreCopies && statedA != null) ? 'stated' : (hasA ? 'rows' : null);

    entry.mode = (headA != null) ? 'performance' : 'plan';
    entry.summary = {
      gmvTarget: gT, gmvActual: headA, gmvActualRows: gA,
      statedTarget: statedT, statedActual: statedA, actualBasis: basis,
      qtyTarget: qT, qtyActual: qA, qtyUnit: src.qtyUnit,
      employees: read.members.length, buyerLines: entry.buyerLines,
      achievementPct: (headA != null) ? tsPct_(headA, (basis === 'stated' && statedT != null) ? statedT : gT) : null,
      qtyAchievementPct: tsPct_(qA, qT),
      onboarding: read.teamActuals || {}
    };
    entry.allocation = read.members.slice().sort(function (a, b) { return (b.gmvTarget || 0) - (a.gmvTarget || 0); });
    entry.allocation.forEach(function (m) { m.share = gT ? Math.round((m.gmvTarget || 0) / gT * 1000) / 10 : null; });
    if (entry.allocation.length) {
      var top = entry.allocation[0];
      entry.concentration = { name: top.name, share: top.share, gmvTarget: top.gmvTarget };
    }
    out.teams.push(entry);
  });
  return out;
}

/** Which periods do the configured target workbooks describe? */
function tsPeriods_() {
  var set = {};
  GMV_PERIODS.forEach(function (p) { set[p.period] = 1; });
  return Object.keys(set).sort();
}

/* ------------------------------------------- targets → KPI assignment ------ */
/* The four things the plans measure. GMV is primary, quantity secondary — the
 * weights say so. `tKey`/`aKey` point at the member fields the target layer
 * filled in; everything else is the KPI's own identity and stays put. */
var TARGET_KPIS = [
  { kpi: 'GMV Achievement',          kra: 'GMV delivery', persp: 'Growth', unit: 'Cr', type: 'Amount', weight: 50, tKey: 'gmvTarget', aKey: 'gmvActual', primary: true,
    definition: 'Gross merchandise value delivered against the month\'s assigned GMV target.', method: 'Sum of transacted GMV for the member\'s buyers, from the monthly MIS.' },
  { kpi: 'Volume Achievement',       kra: 'GMV delivery', persp: 'Growth', unit: 'MT', type: 'Number', weight: 20, tKey: 'qtyTarget', aKey: 'qtyActual',
    definition: 'Tonnage delivered against the month\'s assigned quantity target.', method: 'Sum of dispatched tonnage for the member\'s buyers, from the monthly MIS.' },
  { kpi: 'New suppliers onboarded',  kra: 'Onboarding',   persp: 'Supply', unit: '',   type: 'Number', weight: 15, tKey: 'supTarget', aKey: 'supActual',
    definition: 'New suppliers/sellers onboarded against the month\'s onboarding target.', method: 'Count of suppliers activated in the period.' },
  { kpi: 'New buyers onboarded',     kra: 'Onboarding',   persp: 'Demand', unit: '',   type: 'Number', weight: 15, tKey: 'buyTarget', aKey: 'buyActual',
    definition: 'New buyers onboarded against the month\'s onboarding target.', method: 'Count of buyers activated in the period.' }
];

/**
 * Turn the target hierarchy into the employees + KPI records the dashboard
 * already renders. Each record carries `planTarget` (what was assigned) so
 * achievement is measured against the target, not against the "Meets" band.
 */
function targetRecordsFor_(period) {
  var plan = targetPlanFor_(period);
  var employees = [], records = [], subTeams = [], depts = [], n = 0;
  plan.teams.forEach(function (t, ti) {
    if (!t.connected || !t.allocation.length) return;
    var deptId = 'tp_' + t.key;
    depts.push({ id: deptId, name: t.team, key: t.key });
    var subIdx = {};
    t.allocation.forEach(function (m, mi) {
      var region = m.region || '—';
      var subId = deptId + '::' + slugSafe_(region);
      if (!subIdx[subId]) { subIdx[subId] = true; subTeams.push({ id: subId, deptId: deptId, deptName: t.team, name: region }); }
      var empId = deptId + '::' + slugSafe_(m.name);
      employees.push({ id: empId, name: m.name, role: m.rh ? (region + ' POC · RH ' + m.rh) : (region + ' POC'),
        region: region, department: t.team, deptId: deptId, subTeamIds: [subId], subName: region,
        targetPlan: { gmvTarget: m.gmvTarget, gmvActual: m.gmvActual, qtyTarget: m.qtyTarget, qtyActual: m.qtyActual,
                      qtyUnit: t.qtyUnit, txnTarget: m.txnTarget, txnActual: m.txnActual,
                      achievementPct: m.achievementPct, share: m.share, rh: m.rh,
                      buyerCount: m.buyerCount, buyers: m.buyers || [] } });
      TARGET_KPIS.forEach(function (k) {
        var target = m[k.tKey];
        if (target == null) return;                       // no target assigned ⇒ no KPI line
        var actual = k.aKey ? m[k.aKey] : null;
        n++;
        records.push({
          kpiId: 'tp' + n, employeeId: empId, employee: m.name,
          deptId: deptId, department: t.team, subTeamId: subId, subTeam: region,
          perspective: k.persp, kra: k.kra, kpi: k.kpi,
          definition: k.definition, method: k.method,
          weight: k.weight, weightShown: k.weight,
          metricType: k.type, unit: k.unit || t.qtyUnit,
          qualitative: false, direction: 1, directionKey: 'higher', directionSource: 'declared',
          bands: target ? gmvBands_(target) : [],
          meetsValue: target ? Math.round(target * 0.9 * 1000) / 1000 : null,
          planTarget: target, target: target,
          actual: actual, hasActual: actual != null,
          targetSourced: true, primaryMetric: !!k.primary,
          source: t.team + ' target plan (' + (t.tabs[0] || 'workbook') + ')',
          bandSource: 'target-plan', weightSource: 'target-plan',
          checkins: [], checkinCount: 0
        });
      });
    });
  });
  return { plan: plan, depts: depts, employees: employees, records: records, subTeams: subTeams };
}
function slugSafe_(s) { return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'x'; }

/** Smoke test for both teams — run from the editor. */
function targetSelfTest() {
  tsPeriods_().forEach(function (p) {
    var out = targetRecordsFor_(p);
    Logger.log('%s → %s people, %s KPI lines', p, out.employees.length, out.records.length);
    out.plan.teams.forEach(function (t) {
      Logger.log('   %s: connected=%s mode=%s %s', t.team, t.connected, t.mode,
        t.summary ? ('GMV ' + t.summary.gmvTarget + ' / act ' + t.summary.gmvActual + ' · qty ' + t.summary.qtyTarget + ' · ' + t.summary.employees + ' people · ' + t.summary.buyerLines + ' buyer lines') : ('— ' + t.error));
    });
  });
}

/*******************************************************************************
 * ============================================================================
 * KRA / KPI MASTER BACKEND - five teams, individual assignments
 * ============================================================================
 * Three kinds of data, never mixed:
 *
 *   KRA/KPI definitions are MASTER data  (frozen here)
 *   Targets are PERIOD data              (MONTHLY_TARGETS, loaded later)
 *   Actuals are PERFORMANCE data         (ACTUAL_PERFORMANCE, loaded later)
 *
 * The central fact this model exists to express: people on the same team do
 * NOT share a KPI set. Vamsi and Harshita are both Onboarding and have six
 * KPIs each, but not the same six. Divya has four KPIs weighted 40/35/15/10
 * while Ashwin, her manager, has five weighted 20/10/20/20/30. So ownership
 * lives in EMPLOYEE_KPI_MAPPING, never in the team record and never in a
 * frontend conditional.
 *
 * Authoring note: assignments below are written in readable form - team,
 * person, perspective, KRA, KPI, weight - and provisioning DERIVES
 * KRA_MASTER, KPI_MASTER and EMPLOYEE_KPI_MAPPING from them with generated
 * ids. Hand-writing foreign keys across six tables is how referential
 * integrity dies; here it cannot drift because there is one source.
 *******************************************************************************/

var TEAMS = [
  /* team_id, name, short, type, team_lead, category_head */
  ['TEAM01','Metal','MET','Category','Amit Jha',''],
  ['TEAM02','Plastic','PLA','Category','','Tabesh Mohammad'],
  ['TEAM03','Onboarding','ONB','Function','Ajay',''],
  ['TEAM04','Collections','COL','Function','Ravi Naik',''],
  ['TEAM05','Marketplace - Control Tower','MCT','Function','Ashwin Kumar Singh','']
];

var PEOPLE = [
  /* employee_id, name, team_id, designation, region, reporting_manager */
  ['MET001','Amit Jha','TEAM01','Team Lead - Business Development','Central',''],
  ['MET002','Arijit Dutta','TEAM01','Senior Executive - Business Development','East','MET001'],
  ['MET003','Arghyadeep Samanta','TEAM01','Senior Executive - Business Development','East','MET001'],
  ['MET004','Abhisek Sanyal','TEAM01','Assistant Manager - Business Development','South','MET001'],
  ['MET005','Adarsh Krishna','TEAM01','Assistant Manager - Business Development','South','MET001'],
  ['MET006','Ayush Goyal','TEAM01','Assistant Manager - Business Development','East','MET001'],

  ['PLA001','Tabesh Mohammad','TEAM02','General Manager - Business Development / Category Head - Plastics','',''],
  ['PLA002','Ashish Kumar Rai','TEAM02','Point of Contact','','PLA001'],
  ['PLA003','Raju B','TEAM02','Point of Contact','','PLA001'],
  ['PLA004','Brajendra Upadhyay','TEAM02','Point of Contact','','PLA001'],
  ['PLA005','Atharva Sudhir Patil','TEAM02','Point of Contact','','PLA001'],
  ['PLA006','Praveen Raj P','TEAM02','Point of Contact','','PLA001'],
  ['PLA007','Asraful Hasan','TEAM02','Point of Contact','','PLA001'],
  ['PLA008','Rustumpet Ashwin Kumar','TEAM02','Point of Contact','','PLA001'],
  ['PLA009','Joydeep Das','TEAM02','Point of Contact','','PLA001'],
  ['PLA010','Parth Gautam','TEAM02','Regional Head','','PLA001'],
  ['PLA011','Uday Kiran Kumar Thota','TEAM02','Regional Head','','PLA001'],

  ['ONB001','Ajay','TEAM03','Manager - Onboarding','',''],
  ['ONB002','Vamsi','TEAM03','Senior Executive - Onboarding','','ONB001'],
  ['ONB003','Harshita','TEAM03','Executive - Onboarding','','ONB001'],
  ['ONB004','Naveen Ranga','TEAM03','Senior Executive - Onboarding','','ONB001'],
  ['ONB005','Vishwash','TEAM03','Management Trainee','','ONB001'],

  ['COL001','Ravi Naik','TEAM04','Manager - Collections','',''],
  ['COL002','Sai Nitin','TEAM04','Executive - Collections','','COL001'],
  ['COL003','Ankur','TEAM04','Assistant Manager - Collections','','COL001'],
  ['COL004','Venkat','TEAM04','Assistant Manager - Collections','','COL001'],
  ['COL005','Srinivas Reddy','TEAM04','Assistant Manager - Collections','','COL001'],

  ['MCT001','Ashwin Kumar Singh','TEAM05','Manager','',''],
  ['MCT002','Divya Boppuri','TEAM05','Executive','','MCT001'],
  ['MCT003','Jithender Chitakodur','TEAM05','Executive','','MCT001'],
  ['MCT004','Bharath Kumar','TEAM05','Senior Executive','','MCT001'],
  ['MCT005','Rajeswari','TEAM05','Executive','','MCT001'],
  ['MCT006','Aishwarya Karanam','TEAM05','Executive','','MCT001'],
  ['MCT007','Megaraj','TEAM05','Senior Executive','','MCT001'],
  ['MCT008','Arvind Jakkula','TEAM05','Executive','','MCT001']
];

/* Threshold profiles. Referenced by name from the assignments so a ladder is
 * defined once and shared, and a KPI with no published ladder is explicitly
 * marked rather than given invented numbers. */
var THRESHOLD_SETS = {
  STD_PCT:  { dir:'HIGHER_IS_BETTER', unit:'PERCENT', levels:[60,75,90,100,105] },
  TAT_PCT:  { dir:'HIGHER_IS_BETTER', unit:'PERCENT', levels:[80,85,90,95,100] },
  DSO_DAYS: { dir:'LOWER_IS_BETTER',  unit:'DAYS',    levels:[15,10,5,3,2] },
  DEBIT_NOTE:{dir:'LOWER_IS_BETTER',  unit:'PERCENT', levels:[1.30,1.20,1.00,0.80,0.60] },
  NONE:     { dir:'HIGHER_IS_BETTER', unit:'PERCENT', levels:null }   /* not defined in source */
};

/* ---------------------------------------------------------- ASSIGNMENTS --
 * [ employee_id, perspective, kra_name, kpi_name, weightage, threshold_set ]
 * Provisioning asserts each person's weightages total 100 and reports any that
 * do not, rather than quietly normalising them. */
var ASSIGNMENTS = [];

/* --- Metal: one shared seven-KPI structure across the team --------------- */
(function () {
  var rows = [
    ['Process','Retention of Existing Transacted Sellers','Repeat Seller Transaction Rate',5,'STD_PCT'],
    ['Customer','New Buyer Acquisition','Monthly Target Achievement',15,'STD_PCT'],
    ['Customer','New Seller Acquisition','Monthly Target Achievement',15,'STD_PCT'],
    ['Process','Transaction from New Onboarded Buyers','New Buyer Same-Month Transaction Rate',5,'STD_PCT'],
    ['Sales','GMV','Monthly Target Achievement',40,'STD_PCT'],
    ['Sales','Transaction Closure','Successfully Closed Transactions',10,'STD_PCT'],
    ['Process','DSO Days','Days Sales Outstanding',10,'DSO_DAYS']
  ];
  ['MET001','MET002','MET003','MET004','MET005','MET006'].forEach(function (e) {
    rows.forEach(function (r) { ASSIGNMENTS.push([e, r[0], r[1], r[2], r[3], r[4]]); });
  });
})();

/* --- Plastic: the category head and the field team run DIFFERENT sets ----
 * Tabesh carries the eight-KPI category framework (demand + supply + quality
 * + working capital); everyone else carries the five-KPI supply-side set that
 * the individual scorecards actually publish. */
(function () {
  var head = [
    ['Sales','Demand Activation','Existing Buyer Monthly Transaction Rate',10,'STD_PCT'],
    ['Scale','New Demand Activation','New Buyer Same-Month Transaction Rate',10,'STD_PCT'],
    ['Sales','Supply Activation','Existing Seller Monthly Transaction Rate',10,'STD_PCT'],
    ['Scale','New Supply Activation','New Seller Same-Month Transaction Rate',10,'STD_PCT'],
    ['Sales / Profit','Category GMV Growth','GMV Target Achievement',30,'STD_PCT'],
    ['Customer','Transaction Quality','Debit Note Rate',10,'DEBIT_NOTE'],
    ['Process / Profit','Working Capital Management','DSO',15,'DSO_DAYS'],
    ['Sales / Profit','Category Growth & Balance','Demand-Supply Conversion Rate',5,'STD_PCT']
  ];
  head.forEach(function (r) { ASSIGNMENTS.push(['PLA001', r[0], r[1], r[2], r[3], r[4]]); });

  var field = [
    ['Sales','Transaction from Existing Sellers','Monthly Target Achievement',15,'STD_PCT'],
    ['Sales','Transaction from New Onboarded Sellers','Monthly Target Achievement',15,'STD_PCT'],
    ['Customer','New Seller Acquisition','Monthly Target Achievement',15,'STD_PCT'],
    ['Sales','GMV','Monthly Target Achievement',40,'STD_PCT'],
    ['Process','Retention of Existing Transacted Sellers','Monthly Target Achievement',15,'STD_PCT']
  ];
  ['PLA002','PLA003','PLA004','PLA005','PLA006','PLA007','PLA008','PLA009','PLA010','PLA011'].forEach(function (e) {
    field.forEach(function (r) { ASSIGNMENTS.push([e, r[0], r[1], r[2], r[3], r[4]]); });
  });
})();

/* --- Onboarding: every person a different set --------------------------- */
[
  ['ONB002','Process','Open Marketplace - Buyer & Seller Onboarding','TAT - 1 Day',35,'TAT_PCT'],
  ['ONB002','Process','Re-Commerce - Seller Onboarding','TAT - 1 Day',10,'TAT_PCT'],
  ['ONB002','Process','Fall Back - AFR & INFRA','TAT - 3 Days',10,'TAT_PCT'],
  ['ONB002','Process','Audit & Monitoring','Document Completeness',20,'NONE'],
  ['ONB002','Process','On-Site Verification','TAT - 4 Days',15,'TAT_PCT'],
  ['ONB002','Process','Vendor Payments - Finoscale / Carma One','Timely Validation',10,'NONE'],

  ['ONB003','Process','INFRA - Buyer & Seller Onboarding','TAT - 3 Days',25,'TAT_PCT'],
  ['ONB003','Process','AFR - Buyer & Seller Onboarding','TAT - 3 Days',25,'TAT_PCT'],
  ['ONB003','Process','Audit & Monitoring','Document Completeness',20,'NONE'],
  ['ONB003','Process','Fall Back - EPR','TAT',10,'TAT_PCT'],
  ['ONB003','Process','Vendor Payments - Ongrid','Timely Validation',10,'NONE'],
  ['ONB003','Process','Vendor Payments - Finoscale / Carma One','Timely Validation',10,'NONE'],

  ['ONB004','Process','EPR - Buyer & Seller Onboarding','TAT',35,'TAT_PCT'],
  ['ONB004','Process','Audit & Monitoring','Document Completeness',20,'NONE'],
  ['ONB004','Process','Transporter Onboarding','TAT',15,'TAT_PCT'],
  ['ONB004','Process','Fall Back - Open Marketplace','TAT',10,'TAT_PCT'],
  ['ONB004','Process','Open Marketplace - NBFC Coordination','NBFC Coordination & Case Management',10,'NONE'],
  ['ONB004','Process','GST Payments','Compliance Check',10,'NONE'],

  ['ONB005','Process','Fall Back for All Verticals','TAT',10,'TAT_PCT'],
  ['ONB005','Process','Design Standard Operating Procedures','Approved SOPs',20,'NONE'],
  ['ONB005','Process','Digitalization of Onboarding','Automation of Process',30,'NONE'],
  ['ONB005','Process','Daily Reports Across Verticals','Accuracy & Timeliness',30,'NONE'],
  ['ONB005','Process','Audit Process for Entire Onboarding & Collections','Reporting & Escalations',10,'NONE'],

  ['ONB001','Process','All Verticals - Vendor & Buyer Onboarding','TAT',40,'TAT_PCT'],
  ['ONB001','Process','Design Standard Operating Procedures','Approved SOPs',20,'NONE'],
  ['ONB001','Process','Audit & Monitoring','Document Completeness',10,'NONE'],
  ['ONB001','Process','Digitalization','Automation of Process',20,'NONE'],
  ['ONB001','Process','Vendor Payments','Timely Validation',10,'NONE']
].forEach(function (r) { ASSIGNMENTS.push(r); });

/* --- Collections -------------------------------------------------------- */
[
  ['COL002','Sales','Due Date + 7 Days Collections - Marketplace & EPR','Collection % vs Target',60,'STD_PCT'],
  ['COL002','Process','Balance Confirmation','Confirmation Coverage %',10,'STD_PCT'],
  ['COL002','Process','Reminder Emails','Adherence to Reminder',10,'STD_PCT'],
  ['COL002','Process','Payment Posting','TAT - Days',10,'NONE'],
  ['COL002','Process','Cross-Functional Coordination','Coordination Adherence %',10,'STD_PCT'],

  ['COL001','Sales','Due Date + 7 Days Collections - Marketplace & EPR','Collection % vs Target',30,'STD_PCT'],
  ['COL001','Process / Profit','DSO - Marketplace & EPR','DSO Days',30,'DSO_DAYS'],
  ['COL001','Sales','Legacy Collections','Legacy Collection % of LD',15,'STD_PCT'],
  ['COL001','Sales','PDD','PDD Cr Recovered',10,'STD_PCT'],
  ['COL001','Process','Legal Actions','Legal Action Coordination %',5,'STD_PCT'],
  ['COL001','Sales','Collection of Previous Dues','Previous Financial Year Collections',10,'STD_PCT'],

  ['COL005','Sales','Collection of Previous Dues','Previous Dues Collection',10,'STD_PCT'],
  ['COL005','Process / Profit','DSO - Marketplace & EPR','DSO Days',10,'DSO_DAYS'],
  ['COL005','Process','Transaction - Marketplace','Coordination Adherence',15,'STD_PCT'],
  ['COL005','Process','Payment Posting & Reconciliation','TAT - Days',15,'NONE'],
  ['COL005','Process','Process Improvement & Automation','Process Automation',30,'NONE'],
  ['COL005','Process','Compliance & Audit','Documentation Completion',20,'NONE']
].forEach(function (r) { ASSIGNMENTS.push(r); });

/* --- Marketplace - Control Tower: role-based sets ------------------------ */
(function () {
  var dispatch = [
    ['Process','Dispatch Execution','Timely Dispatch Rate',40,'STD_PCT'],
    ['Process','Dispatch Documentation Management','Dispatch Documentation Accuracy',35,'STD_PCT'],
    ['Process','Dispatch Coordination & Resolution','Dispatch Issue Resolution',15,'STD_PCT'],
    ['Process','SOP & Process Compliance','Dispatch SOP Compliance',10,'NONE']
  ];
  var transit = [
    ['Process','In-Transit Delivery Management','On-Time Transit Completion',50,'STD_PCT'],
    ['Process','Shipment Visibility & Monitoring','Tracking Accuracy',30,'STD_PCT'],
    ['Customer','Buyer Coordination & Delay Management','Pre-Arrival & Delay Resolution',10,'STD_PCT'],
    ['Process','In-Transit SOP Compliance','Transit Process Compliance',10,'NONE']
  ];
  var pod = [
    ['Process','POD Closure Management','POD Collection TAT',35,'TAT_PCT'],
    ['Process','POD Documentation Management','POD First-Time-Right',40,'STD_PCT'],
    ['Customer','Delivery Coordination & Exception Resolution','Delivery Exception Resolution',15,'STD_PCT'],
    ['Process','POD & Exception Compliance','POD Process Compliance',10,'NONE']
  ];
  var mgr = [
    ['Process','Compliance (Documentation)','Documentation Completion',20,'NONE'],
    ['Sales','Match Making','Demand & Listing Conversion',10,'STD_PCT'],
    ['Process','Transaction Tracking','Transaction Closure & Tracking',20,'STD_PCT'],
    ['Customer','DN / CN Tracking','CN & DN Closure Rate',20,'STD_PCT'],
    ['Process','Process Improvement & Automation','Process Automation',30,'NONE']
  ];
  var pay = [
    ['Process','Payment Release Management','Timely Payment Release',30,'STD_PCT'],
    ['Process','QC & Settlement Management','QC & Settlement Accuracy',40,'STD_PCT'],
    ['Customer','Dispute & Payment Resolution','Dispute & Follow-Up Resolution',20,'STD_PCT'],
    ['Process','Settlement Process Compliance','QC & Settlement SOP Compliance',10,'NONE']
  ];
  function assign(emp, set) { set.forEach(function (r) { ASSIGNMENTS.push([emp, r[0], r[1], r[2], r[3], r[4]]); }); }
  assign('MCT001', mgr);
  assign('MCT002', dispatch);
  assign('MCT003', dispatch);
  assign('MCT004', transit);
  assign('MCT005', pod);
  assign('MCT006', pay);
  assign('MCT007', pod);
  assign('MCT008', transit);
})();

/* People known to exist but whose KPI sets are not fully enumerated in any
 * source I have. They are seeded into EMPLOYEE_MASTER so the roster is
 * complete, and left unmapped rather than given guessed weightages. */
var UNMAPPED_NOTE = {
  COL003: 'Ankur - described as the same six-KRA structure as Ravi Naik with a Marketplace-specific previous-dues KPI, but individual weightages are not enumerated in the source.',
  COL004: 'Venkat - same six-KRA structure with an EPR-specific previous-dues KPI; weightages not enumerated in the source.'
};

/* ------------------------------------------------------- MASTER SCHEMAS -- */

var M_TAB = {
  TEAM:'TEAM_MASTER', EMP:'EMPLOYEE_MASTER', KRA:'KRA_MASTER', KPI:'KPI_MASTER',
  MAP:'EMPLOYEE_KPI_MAPPING', THR:'KPI_THRESHOLDS',
  TGT:'MONTHLY_TARGETS', ACT:'ACTUAL_PERFORMANCE', PERF:'KPI_PERFORMANCE'
};

var M_SCHEMA = {};
M_SCHEMA[M_TAB.TEAM] = ['team_id','team_name','team_short_code','team_type','team_lead','category_head','active'];
M_SCHEMA[M_TAB.EMP]  = ['employee_id','employee_name','team_id','designation','region','reporting_manager','employment_status','active_from','active_to','notes'];
M_SCHEMA[M_TAB.KRA]  = ['kra_id','team_id','perspective','kra_name','goal_description','active'];
M_SCHEMA[M_TAB.KPI]  = ['kpi_id','kra_id','kpi_name','goal_description','weightage','source_of_tracking','measurement_type','direction','target_type','threshold_set','active'];
M_SCHEMA[M_TAB.MAP]  = ['mapping_id','employee_id','kpi_id','weightage','effective_from','effective_to','applicable'];
M_SCHEMA[M_TAB.THR]  = ['threshold_id','kpi_id','level','threshold_value','threshold_unit','label','comparison_operator','threshold_not_defined'];
M_SCHEMA[M_TAB.TGT]  = ['target_id','month','team_id','employee_id','kpi_id','target_value','target_unit','target_source','approved'];
M_SCHEMA[M_TAB.ACT]  = ['actual_id','month','team_id','employee_id','kpi_id','actual_value','actual_unit','source','updated_at'];
M_SCHEMA[M_TAB.PERF] = ['performance_id','month','team_id','employee_id','kpi_id','target','actual','achievement_percentage','variance','weighted_score','performance_level','status'];

/* --------------------------------------------------------- PROVISIONING -- */

/**
 * Builds the master backend. Derives KRA_MASTER, KPI_MASTER,
 * EMPLOYEE_KPI_MAPPING and KPI_THRESHOLDS from ASSIGNMENTS so every foreign
 * key is generated from one source and cannot drift.
 *
 * Master tabs are rewritten on every run. The three performance tabs
 * (MONTHLY_TARGETS, ACTUAL_PERFORMANCE, KPI_PERFORMANCE) are created but never
 * cleared - master data is frozen, period data is not, and re-freezing the
 * master must never destroy a month of actuals.
 */
function provisionMaster() {
  var teamOf = {}, i;
  PEOPLE.forEach(function (p) { teamOf[p[0]] = p[2]; });

  /* 1. Teams and people */
  var teams = TEAMS.map(function (t) { return [t[0],t[1],t[2],t[3],t[4],t[5],'TRUE']; });
  var emps  = PEOPLE.map(function (p) {
    return [p[0],p[1],p[2],p[3],p[4],p[5],'ACTIVE','','', UNMAPPED_NOTE[p[0]] || ''];
  });

  /* 2. Derive KRAs, KPIs, mappings, thresholds */
  var kraIdx = {}, kraRows = [], kpiIdx = {}, kpiRows = [], mapRows = [], thrRows = [];
  var kraSeq = 0, kpiSeq = 0, mapSeq = 0, thrSeq = 0;

  ASSIGNMENTS.forEach(function (a) {
    var emp = a[0], persp = a[1], kraName = a[2], kpiName = a[3], wt = a[4], thrSet = a[5];
    var team = teamOf[emp];
    if (!team) throw new Error('Assignment references unknown employee ' + emp);

    var kraKey = team + '|' + kraName;
    if (!kraIdx[kraKey]) {
      kraIdx[kraKey] = 'KRA-' + shortOf_(team) + '-' + pad3_(++kraSeq);
      kraRows.push([kraIdx[kraKey], team, persp, kraName, '', 'TRUE']);
    }
    /* A KPI is unique per KRA *and* weightage: the same KPI name under the same
     * KRA can carry a different weight for a different person, and collapsing
     * those would silently rewrite someone's scorecard. */
    var kpiKey = kraIdx[kraKey] + '|' + kpiName + '|' + wt;
    if (!kpiIdx[kpiKey]) {
      var set = THRESHOLD_SETS[thrSet] || THRESHOLD_SETS.NONE;
      kpiIdx[kpiKey] = 'KPI-' + shortOf_(team) + '-' + pad3_(++kpiSeq);
      kpiRows.push([kpiIdx[kpiKey], kraIdx[kraKey], kpiName, '', wt, '',
                    set.unit, set.dir, set.levels ? 'THRESHOLD' : 'NOT_DEFINED', thrSet, 'TRUE']);
      if (set.levels) {
        set.levels.forEach(function (v, li) {
          thrRows.push(['THR' + pad3_(++thrSeq), kpiIdx[kpiKey], li + 1, v, set.unit,
                        'Target ' + (li + 1), set.dir === 'LOWER_IS_BETTER' ? '<=' : '>=', 'FALSE']);
        });
      } else {
        thrRows.push(['THR' + pad3_(++thrSeq), kpiIdx[kpiKey], '', '', '', 'Not defined in source', '', 'TRUE']);
      }
    }
    mapRows.push(['MAP' + pad3_(++mapSeq), emp, kpiIdx[kpiKey], wt, '', '', 'TRUE']);
  });

  /* 3. Integrity: every mapped person's weightages must total 100 */
  var byEmp = {}, issues = [];
  mapRows.forEach(function (m) { byEmp[m[1]] = (byEmp[m[1]] || 0) + Number(m[3]); });
  Object.keys(byEmp).forEach(function (e) {
    if (Math.round(byEmp[e]) !== 100) issues.push(e + ' totals ' + byEmp[e] + '%');
  });

  mWrite_(M_TAB.TEAM, teams);
  mWrite_(M_TAB.EMP, emps);
  mWrite_(M_TAB.KRA, kraRows);
  mWrite_(M_TAB.KPI, kpiRows);
  mWrite_(M_TAB.MAP, mapRows);
  mWrite_(M_TAB.THR, thrRows);
  mTab_(M_TAB.TGT); mTab_(M_TAB.ACT); mTab_(M_TAB.PERF);

  var unmapped = PEOPLE.filter(function (p) { return !byEmp[p[0]]; }).map(function (p) { return p[1]; });
  return [
    'Teams: ' + teams.length,
    'Employees: ' + emps.length,
    'KRAs: ' + kraRows.length,
    'KPIs: ' + kpiRows.length,
    'Mappings: ' + mapRows.length,
    'Thresholds: ' + thrRows.length,
    'Unmapped (no KPI set in source): ' + (unmapped.length ? unmapped.join(', ') : 'none'),
    'Weightage issues: ' + (issues.length ? issues.join('; ') : 'none - every mapped person totals 100%')
  ].join('\n');
}

function shortOf_(teamId) {
  var t = TEAMS.filter(function (x) { return x[0] === teamId; })[0];
  return t ? t[2] : 'GEN';
}
function mTab_(name) {
  var ss = bkSS_(), sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  var h = M_SCHEMA[name];
  sh.getRange(1, 1, 1, h.length).setValues([h]).setFontWeight('bold').setBackground('#F2F0E8');
  sh.setFrozenRows(1);
  return sh;
}
function mWrite_(name, rows) {
  var sh = mTab_(name), h = M_SCHEMA[name];
  if (sh.getLastRow() > 1) sh.getRange(2, 1, sh.getLastRow() - 1, h.length).clearContent();
  if (rows.length) sh.getRange(2, 1, rows.length, h.length).setValues(rows);
  return rows.length;
}
function mRead_(name) {
  var ss = bkSS_(), sh = ss.getSheetByName(name);
  if (!sh || sh.getLastRow() < 2) return [];
  var h = M_SCHEMA[name], v = sh.getRange(2, 1, sh.getLastRow() - 1, h.length).getValues();
  return v.filter(function (r) { return String(r[0]).trim() !== ''; })
          .map(function (r) { var o = {}; h.forEach(function (k, i) { o[k] = r[i]; }); return o; });
}

/**
 * The record shape the frontend consumes. It carries no business logic: every
 * derived value is already computed here, so the UI only ever visualises.
 */
function apiMasterModel(teamId, month) {
  var teams = mRead_(M_TAB.TEAM), emps = mRead_(M_TAB.EMP);
  var kras = mRead_(M_TAB.KRA), kpis = mRead_(M_TAB.KPI), maps = mRead_(M_TAB.MAP);
  var kraById = {}; kras.forEach(function (k) { kraById[k.kra_id] = k; });
  var kpiById = {}; kpis.forEach(function (k) { kpiById[k.kpi_id] = k; });
  var tgt = mRead_(M_TAB.TGT), act = mRead_(M_TAB.ACT);
  function find(list, empId, kpiId) {
    var h = list.filter(function (r) { return r.employee_id === empId && r.kpi_id === kpiId && (!month || r.month === month); })[0];
    return h || null;
  }
  var scorecards = emps
    .filter(function (e) { return !teamId || e.team_id === teamId; })
    .map(function (e) {
      var rows = maps.filter(function (m) { return m.employee_id === e.employee_id && String(m.applicable).toUpperCase() !== 'FALSE'; })
        .map(function (m) {
          var kpi = kpiById[m.kpi_id] || {}, kra = kraById[kpi.kra_id] || {};
          var t = find(tgt, e.employee_id, m.kpi_id), a = find(act, e.employee_id, m.kpi_id);
          var tv = t ? Number(t.target_value) : null, av = a ? Number(a.actual_value) : null;
          var ach = (tv == null || av == null) ? null : achievementPct_(tv, av, kpi.direction);
          var ws = weightedScore_(m.weightage, ach);
          return { kpi_id: m.kpi_id, perspective: kra.perspective || '', kra: kra.kra_name || '',
                   kpi: kpi.kpi_name || '', weightage: Number(m.weightage),
                   unit: kpi.measurement_type || '', direction: kpi.direction || '',
                   target: tv, actual: av, achievement: ach, weighted_score: ws,
                   status: ach == null ? 'Awaiting data' : statusFor_(ach, ach >= 100 ? 5 : ach >= 90 ? 4 : ach >= 75 ? 3 : ach >= 60 ? 2 : 1) };
        });
      var earned = 0, measured = 0;
      rows.forEach(function (r) { if (r.weighted_score != null) { earned += r.weighted_score; measured += r.weightage; } });
      return { employee_id: e.employee_id, employee_name: e.employee_name, team_id: e.team_id,
               designation: e.designation, region: e.region, kpis: rows,
               assigned_weightage: rows.reduce(function (s, r) { return s + r.weightage; }, 0),
               measured_weightage: measured,
               overall_score: measured > 0 ? Math.round(earned * 10) / 10 : null };
    });
  return { ok: true, month: month || null, teams: teams, scorecards: scorecards,
           generatedAt: new Date().toISOString() };
}

/** Proves the master is internally consistent before any target is loaded. */
function masterSelfTest() {
  var out = [], byEmp = {}, teamOf = {};
  PEOPLE.forEach(function (p) { teamOf[p[0]] = p[2]; });
  ASSIGNMENTS.forEach(function (a) { byEmp[a[0]] = (byEmp[a[0]] || 0) + Number(a[4]); });
  out.push('Teams: ' + TEAMS.length);
  out.push('People: ' + PEOPLE.length);
  out.push('Assignments: ' + ASSIGNMENTS.length);
  var bad = Object.keys(byEmp).filter(function (e) { return Math.round(byEmp[e]) !== 100; });
  out.push('Weightage != 100: ' + (bad.length ? bad.map(function (e) { return e + '=' + byEmp[e]; }).join(', ') : 'none'));
  var orphan = ASSIGNMENTS.filter(function (a) { return !teamOf[a[0]]; });
  out.push('Orphan assignments: ' + orphan.length);
  var unmapped = PEOPLE.filter(function (p) { return !byEmp[p[0]]; }).map(function (p) { return p[1]; });
  out.push('People with no KPI set: ' + (unmapped.length ? unmapped.join(', ') : 'none'));
  return out.join('\n');
}

/* ---------------------------------------------------- SHARED PRIMITIVES --
 * Opening the source of truth, id padding, and the scoring rules. These are
 * the only place a number is turned into a judgement, so they live together.
 */

function bkSS_() {
  try { return SpreadsheetApp.openById(BACKEND_SHEET_ID); }
  catch (e) {
    throw new Error('Cannot open the backend spreadsheet ' + BACKEND_SHEET_ID +
      '. Confirm the id is correct and that ' +
      (function () { try { return Session.getEffectiveUser().getEmail() || 'this account'; } catch (x) { return 'this account'; } })() +
      ' has edit access. (' + (e && e.message || e) + ')');
  }
}

function pad3_(n) { return ('00' + n).slice(-3); }

/* Achievement is capped at the top band. The published scorecards show GMV of
 * 0.83 against 0.6 as 105.0%, not 138%, and score it 42 against a weightage of
 * 40 - so the cap is part of the contract, not display rounding. */
var ACHIEVEMENT_CAP_PCT = 105;
function capAch_(pct) { return round1_(Math.min(Number(pct), ACHIEVEMENT_CAP_PCT)); }

/**
 * Achievement %, direction-aware.
 *   HIGHER_IS_BETTER: actual / target
 *   LOWER_IS_BETTER : target / actual - so a DSO of 3 days against a 5 day
 *   target over-achieves, and 15 days against 5 does not. Without this
 *   inversion the two KPI families cannot share one scoring path.
 *
 * A target of zero means the KPI was not asked of this person this period. It
 * is neither zero achievement nor full achievement - the source sheets do both,
 * returning 0% for one person and 100% for another on identical 0/0 input.
 * Returning null makes it N/A and excludes it from the weighted denominator, so
 * nobody is rewarded or punished for a target that was never set.
 */
function achievementPct_(target, actual, direction) {
  var t = Number(target), a = Number(actual);
  if (!isFinite(t) || !isFinite(a)) return null;
  if (t === 0) return null;
  if (direction === 'LOWER_IS_BETTER') {
    if (a === 0) return null;          /* zero days is not a real measurement */
    return capAch_(t / a * 100);
  }
  return capAch_(a / t * 100);
}

/* Weighted score = weightage x capped achievement. This is what the published
 * scorecards compute: weightage 40 at 105% scores 42.0; weightage 15 at 85.7%
 * scores 12.857. An earlier version used weightage x (rating / 5) off the band
 * ladder, which collapsed everything from 100% to 104% into one value and
 * reproduced none of the published figures. The bands remain, but as STATUS
 * thresholds: they label a result, they do not score it. */
function weightedScore_(weightPct, achPct) {
  if (achPct == null) return null;
  return Math.round(Number(weightPct) * (Number(achPct) / 100) * 1000) / 1000;
}

function statusFor_(achPct, level) {
  if (achPct == null) return 'Awaiting data';
  if (level >= 5) return 'Exceeded';
  if (level >= 4) return 'Above Expectation';
  if (level >= 3) return 'Near';
  if (level >= 2) return 'At Risk';
  return 'Critical';
}
