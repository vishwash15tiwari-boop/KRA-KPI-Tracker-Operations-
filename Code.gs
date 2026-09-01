/* ============================================================================
 * PerformOS — Employee Performance Management Platform
 * Apps Script backend. Two deployable files: Code.gs + Index.html.
 *
 * Ported from the browser-native build (IndexedDB) to Apps Script:
 *   - the database is a Google Spreadsheet, one tab per table;
 *   - the calculation engine runs HERE, server-side, so scoring is
 *     backend-authoritative and the client only ever visualises;
 *   - the client gets the whole model for a period in one round trip
 *     (apiBootstrap / apiModel) and re-adopts a freshly recomputed model
 *     after every write.
 *
 * The product model is Target 1–5:
 *   Employee → Org → Team → KRA → KPI → Target 1–5 → Actual
 *     → KPI level → KRA level → Overall employee level
 *     → Leaderboard → Review → Analytics
 *
 * No setup is required to run: on first load the script creates its own
 * backend spreadsheet and seeds a full demo organisation.
 * ========================================================================== */

var APP_NAME = 'PerformOS';
var PROP_DB = 'PERFORMOS_DB_ID';

/* ------------------------------------------------------------------ SCHEMA --
 * One tab per table. Column order is the contract: read_() maps positionally,
 * so columns may be APPENDED but never reordered. */
var T = {
  ORG_TYPES: 'ORG_TYPES', ORG_UNITS: 'ORG_UNITS', TEAMS: 'TEAMS', EMPLOYEES: 'EMPLOYEES',
  ROLES: 'ROLES', KRAS: 'KRAS', KPIS: 'KPIS', PERIODS: 'PERIODS', ASSIGNMENTS: 'ASSIGNMENTS',
  TARGETS: 'TARGETS', PERFORMANCE: 'PERFORMANCE', REVIEWS: 'REVIEWS',
  NOTIFICATIONS: 'NOTIFICATIONS', AUDIT: 'AUDIT', SETTINGS: 'SETTINGS', USERS: 'USERS'
};

var SCHEMA = {};
SCHEMA[T.ORG_TYPES] = ['id', 'name', 'code', 'color', 'sort'];
SCHEMA[T.ORG_UNITS] = ['id', 'org_type_id', 'name', 'code', 'head_id', 'status'];
SCHEMA[T.TEAMS] = ['id', 'org_unit_id', 'name', 'code', 'leader_id', 'description', 'status'];
SCHEMA[T.EMPLOYEES] = ['id', 'name', 'designation', 'org_type_id', 'org_unit_id', 'team_id',
  'manager_id', 'functional_head_id', 'employment_status', 'employment_type',
  'date_of_joining', 'location', 'role_id', 'email'];
SCHEMA[T.ROLES] = ['id', 'name'];
SCHEMA[T.KRAS] = ['id', 'name', 'code', 'description', 'weight', 'status', 'effective_from'];
SCHEMA[T.KPIS] = ['id', 'kra_id', 'name', 'code', 'description', 'measurement_type', 'unit',
  'frequency', 'direction', 'weight', 'status'];
SCHEMA[T.PERIODS] = ['id', 'name', 'kind', 'code', 'sort', 'status', 'start_date'];
SCHEMA[T.ASSIGNMENTS] = ['id', 'employee_id', 'kpi_id', 'kra_id', 'source', 'weight',
  'status', 'effective_from', 'effective_to'];
SCHEMA[T.TARGETS] = ['id', 'employee_id', 'kpi_id', 'period_id', 't1', 't2', 't3', 't4', 't5',
  'unit', 'direction', 'status', 'version', 'created_by', 'approved_by', 'approved_at'];
SCHEMA[T.PERFORMANCE] = ['id', 'employee_id', 'team_id', 'kra_id', 'kpi_id', 'period_id',
  't1', 't2', 't3', 't4', 't5', 'direction', 'weight', 'actual',
  'highest_level', 'levels_achieved', 'pct', 'score', 'status', 'updated_at'];
SCHEMA[T.REVIEWS] = ['id', 'employee_id', 'period_id', 'status', 'mgr_achievements',
  'mgr_strengths', 'mgr_improvements', 'emp_self', 'emp_support', 'reviewer_id', 'updated_at'];
SCHEMA[T.NOTIFICATIONS] = ['id', 'recipient_id', 'type', 'title', 'message', 'entity_type',
  'entity_id', 'read', 'created_at'];
SCHEMA[T.AUDIT] = ['id', 'ts', 'actor_id', 'entity_type', 'entity_id', 'action',
  'old_value', 'new_value', 'reason'];
SCHEMA[T.SETTINGS] = ['key', 'value'];
SCHEMA[T.USERS] = ['id', 'name', 'email', 'role_id', 'employee_id'];

/* ----------------------------------------------------------------- SERVING -- */
function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle(APP_NAME + ' — Employee Performance Management')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/* -------------------------------------------------------------- REPOSITORY --
 * The backend spreadsheet. If none is configured the script creates one and
 * remembers its id, so a fresh deployment needs no manual setup. Set the
 * PERFORMOS_DB_ID script property to point at a specific spreadsheet instead. */
function ss_() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty(PROP_DB);
  if (id) {
    try { return SpreadsheetApp.openById(id); }
    catch (e) { /* unreachable/deleted — fall through and make a new one */ }
  }
  var bound = null;
  try { bound = SpreadsheetApp.getActiveSpreadsheet(); } catch (e) {}
  var ss = bound || SpreadsheetApp.create(APP_NAME + ' — Backend');
  props.setProperty(PROP_DB, ss.getId());
  return ss;
}

function tab_(name) {
  var ss = ss_(), sh = ss.getSheetByName(name);
  var head = SCHEMA[name];
  if (!sh) sh = ss.insertSheet(name);
  if (sh.getMaxColumns() < head.length) sh.insertColumnsAfter(sh.getMaxColumns(), head.length - sh.getMaxColumns());
  sh.getRange(1, 1, 1, head.length).setValues([head]).setFontWeight('bold').setBackground('#F1F5F9');
  sh.setFrozenRows(1);
  return sh;
}

function read_(name) {
  var ss;
  try { ss = ss_(); } catch (e) { return []; }
  var sh = ss.getSheetByName(name);
  if (!sh || sh.getLastRow() < 2) return [];
  var head = SCHEMA[name];
  var values = sh.getRange(2, 1, sh.getLastRow() - 1, head.length).getValues();
  return values.filter(function (r) { return String(r[0]).trim() !== ''; })
    .map(function (r) { var o = {}; head.forEach(function (k, i) { o[k] = r[i]; }); return o; });
}

/* Rewrites a whole tab. Used by provisioning only. */
function write_(name, objs) {
  var sh = tab_(name), head = SCHEMA[name];
  var need = objs.length + 1;
  if (sh.getMaxRows() < need) sh.insertRowsAfter(sh.getMaxRows(), need - sh.getMaxRows());
  if (sh.getLastRow() > 1) sh.getRange(2, 1, sh.getLastRow() - 1, head.length).clearContent();
  if (objs.length) {
    var rows = objs.map(function (o) { return head.map(function (k) { var v = o[k]; return v == null ? '' : v; }); });
    sh.getRange(2, 1, rows.length, head.length).setValues(rows);
  }
  return objs.length;
}

function append_(name, obj) {
  var sh = tab_(name), head = SCHEMA[name];
  sh.appendRow(head.map(function (k) { var v = obj[k]; return v == null ? '' : v; }));
  return obj;
}

/* Upsert by the first column (the id). One row per logical key, history-safe
 * because callers version rather than overwrite where it matters. */
function upsert_(name, obj) {
  var sh = tab_(name), head = SCHEMA[name], id = String(obj[head[0]]);
  var at = -1, last = sh.getLastRow();
  if (last >= 2) {
    var ids = sh.getRange(2, 1, last - 1, 1).getValues();
    for (var i = 0; i < ids.length; i++) if (String(ids[i][0]) === id) { at = i + 2; break; }
  }
  var row = head.map(function (k) { var v = obj[k]; return v == null ? '' : v; });
  if (at > 0) sh.getRange(at, 1, 1, head.length).setValues([row]);
  else sh.appendRow(row);
  return obj;
}

/* Bulk update of specific rows by id — avoids a full rewrite when recompute
 * touches many performance rows at once. */
function bulkUpdate_(name, objs) {
  if (!objs.length) return 0;
  var sh = tab_(name), head = SCHEMA[name], last = sh.getLastRow();
  if (last < 2) return 0;
  var ids = sh.getRange(2, 1, last - 1, 1).getValues();
  var rowOf = {};
  for (var i = 0; i < ids.length; i++) rowOf[String(ids[i][0])] = i + 2;
  var all = sh.getRange(2, 1, last - 1, head.length).getValues();
  var n = 0;
  objs.forEach(function (o) {
    var r = rowOf[String(o[head[0]])];
    if (!r) return;
    all[r - 2] = head.map(function (k) { var v = o[k]; return v == null ? '' : v; });
    n++;
  });
  sh.getRange(2, 1, last - 1, head.length).setValues(all);
  return n;
}

/* --------------------------------------------------------------- UTILITIES -- */
function uid_(p) { return (p || 'id') + '-' + Utilities.getUuid().slice(0, 8); }
function nowIso_() { return new Date().toISOString(); }
function num_(v) {
  if (v === null || v === undefined || v === '') return null;
  var n = typeof v === 'number' ? v : Number(String(v).replace(/[,\s%₹]/g, ''));
  return isFinite(n) ? n : null;
}
function idx_(arr) { var o = {}; arr.forEach(function (x) { o[x.id] = x; }); return o; }

/* google.script.run cannot serialise NaN/Infinity/Date — a single one anywhere
 * makes the WHOLE return arrive as null, which the client can only report as
 * "the server returned nothing". This is the backstop. */
function jsonSafe_(o) {
  if (o === null || o === undefined) return null;
  var t = typeof o;
  if (t === 'number') return isFinite(o) ? o : null;
  if (t === 'string' || t === 'boolean') return o;
  if (o instanceof Date) return o.toISOString();
  if (Object.prototype.toString.call(o) === '[object Array]') return o.map(jsonSafe_);
  if (t === 'object') { var out = {}; Object.keys(o).forEach(function (k) { out[k] = jsonSafe_(o[k]); }); return out; }
  return String(o);
}

/* ==========================================================================
 * CALCULATION ENGINE — the heart of the product.
 * Reproducible from stored targets + actual: same input, same level, always.
 * ======================================================================== */
var LEVEL_LABELS = { 0: 'Below T1', 1: 'Target 1', 2: 'Target 2', 3: 'Target 3', 4: 'Target 4', 5: 'Target 5' };

/**
 * Which Target level did an actual reach?
 *   targets   [t1..t5]
 *   direction higher_is_better | lower_is_better | range
 * Returns the highest CONSECUTIVE level cleared from T1 up, the per-level
 * achieved flags, and a supporting percentage. Never assumes higher-is-better.
 */
function levelFor_(targets, actual, direction) {
  var t = (targets || []).map(function (x) { return (x === null || x === undefined || x === '') ? null : Number(x); });
  if (actual === null || actual === undefined || actual === '' || isNaN(Number(actual))) {
    return { level: null, achieved: [false, false, false, false, false], pct: null };
  }
  var a = Number(actual), dir = direction || 'higher_is_better';
  var achieved = [false, false, false, false, false], level = 0;

  if (dir === 'lower_is_better') {
    for (var i = 0; i < 5; i++) achieved[i] = t[i] !== null && a <= t[i];
  } else if (dir === 'range') {
    /* t1 = minimum acceptable, t5 = maximum acceptable, t3 = ideal. Outside
     * [t1,t5] is below target; inside, closeness to the ideal raises the level. */
    var lo = t[0], hi = t[4], mid = t[2];
    if (lo !== null && hi !== null && a >= lo && a <= hi) {
      var half = Math.max(Math.abs(mid - lo), Math.abs(hi - mid)) || 1;
      var closeness = 1 - Math.abs(a - mid) / half;
      var rl = Math.max(1, Math.min(5, Math.round(1 + closeness * 4)));
      for (var r = 0; r < rl; r++) achieved[r] = true;
    }
  } else {
    for (var h = 0; h < 5; h++) achieved[h] = t[h] !== null && a >= t[h];
  }
  for (var k = 0; k < 5; k++) { if (achieved[k]) level = k + 1; else break; }

  var pct = null, top = t[4] !== null ? t[4] : t[2];
  if (top !== null && top !== 0) {
    pct = dir === 'lower_is_better' ? (a === 0 ? 100 : top / a * 100) : a / top * 100;
    pct = Math.round(Math.min(pct, 999) * 10) / 10;
  }
  return { level: level, achieved: achieved, pct: pct };
}

/**
 * Weighted aggregation of levels → an overall level.
 * Keeps the components so a result can always be explained rather than being
 * a black box (spec: "do not hide this methodology").
 */
function aggregate_(items) {
  var comps = items.filter(function (it) { return it.level !== null && it.level !== undefined && Number(it.weight) > 0; });
  if (!comps.length) return { level: null, score: null, components: [] };
  var wsum = 0, acc = 0;
  comps.forEach(function (it) { var w = Number(it.weight) || 0; wsum += w; acc += it.level * w; });
  var score = wsum > 0 ? acc / wsum : 0;
  return {
    level: Math.max(1, Math.min(5, Math.round(score))),
    score: Math.round(score * 100) / 100,
    components: comps.map(function (it) { return { ref: it.ref, level: it.level, weight: it.weight }; })
  };
}

/**
 * Recompute one employee's period end-to-end and persist the derived values:
 * each KPI's level from its own targets+actual, the KRA rollups, and the
 * overall employee level. Returns the summary the UI reads.
 */
function recompute_(employeeId, periodId) {
  var perf = read_(T.PERFORMANCE).filter(function (r) {
    return String(r.employee_id) === String(employeeId) && String(r.period_id) === String(periodId);
  });
  var kpis = idx_(read_(T.KPIS)), kras = idx_(read_(T.KRAS));
  var updates = [], kpiResults = [];

  perf.forEach(function (rec) {
    var kpi = kpis[rec.kpi_id] || {};
    var res = levelFor_([rec.t1, rec.t2, rec.t3, rec.t4, rec.t5], rec.actual, rec.direction || kpi.direction);
    rec.highest_level = res.level === null ? '' : res.level;
    rec.levels_achieved = res.achieved.map(function (b) { return b ? 1 : 0; }).join('');
    rec.pct = res.pct === null ? '' : res.pct;
    rec.score = res.level === null ? '' : res.level;
    rec.updated_at = nowIso_();
    updates.push(rec);
    if (res.level !== null) {
      kpiResults.push({ ref: rec.kpi_id, level: res.level, weight: num_(kpi.weight) || num_(rec.weight) || 1, kraId: rec.kra_id });
    }
  });
  if (updates.length) bulkUpdate_(T.PERFORMANCE, updates);

  var byKra = {};
  kpiResults.forEach(function (k) { (byKra[k.kraId] = byKra[k.kraId] || []).push(k); });
  var kraResults = Object.keys(byKra).map(function (kraId) {
    var agg = aggregate_(byKra[kraId]);
    return { ref: kraId, level: agg.level, score: agg.score, weight: num_((kras[kraId] || {}).weight) || 1 };
  });
  var overall = aggregate_(kraResults.map(function (k) { return { ref: k.ref, level: k.level, weight: k.weight }; }));

  return {
    employee_id: employeeId, period_id: periodId,
    overall_level: overall.level, overall_score: overall.score,
    kra_results: kraResults, kpi_count: kpiResults.length
  };
}

/* Overall summaries for every employee in a period, computed from the stored
 * (already recomputed) performance rows — no re-derivation of KPI levels. */
function overallsFor_(periodId, perfRows, kpisById, krasById) {
  var byEmp = {};
  perfRows.forEach(function (r) {
    if (String(r.period_id) !== String(periodId)) return;
    (byEmp[r.employee_id] = byEmp[r.employee_id] || []).push(r);
  });
  var out = {};
  Object.keys(byEmp).forEach(function (empId) {
    var byKra = {};
    byEmp[empId].forEach(function (r) {
      var lvl = num_(r.highest_level);
      if (lvl === null) return;
      var w = num_((kpisById[r.kpi_id] || {}).weight) || num_(r.weight) || 1;
      (byKra[r.kra_id] = byKra[r.kra_id] || []).push({ ref: r.kpi_id, level: lvl, weight: w });
    });
    var kraResults = Object.keys(byKra).map(function (kraId) {
      var agg = aggregate_(byKra[kraId]);
      return { ref: kraId, level: agg.level, score: agg.score, weight: num_((krasById[kraId] || {}).weight) || 1 };
    });
    var overall = aggregate_(kraResults.map(function (k) { return { ref: k.ref, level: k.level, weight: k.weight }; }));
    out[empId] = { overall_level: overall.level, overall_score: overall.score, kra_results: kraResults };
  });
  return out;
}

/* Leaderboard derived from performance rows — never a stored rank, always
 * reproducible. Deterministic order: overall score, then T5 hits, then T4+
 * hits, then name. */
function leaderboard_(periodId, perfRows, employees, overalls) {
  var stats = {};
  perfRows.forEach(function (r) {
    if (String(r.period_id) !== String(periodId)) return;
    var s = stats[r.employee_id] || (stats[r.employee_id] = { t5: 0, t4plus: 0, eligible: 0 });
    s.eligible++;
    var lvl = num_(r.highest_level);
    if (lvl !== null) { if (lvl === 5) s.t5++; if (lvl >= 4) s.t4plus++; }
  });
  var rows = employees.filter(function (e) { return stats[e.id]; }).map(function (e) {
    var s = stats[e.id], ov = overalls[e.id] || {};
    return {
      employee_id: e.id, name: e.name, team_id: e.team_id,
      overall_level: ov.overall_level === undefined ? null : ov.overall_level,
      overall_score: ov.overall_score === undefined ? null : ov.overall_score,
      t5: s.t5, t4plus: s.t4plus, eligible: s.eligible,
      t5rate: s.eligible ? Math.round(s.t5 / s.eligible * 100) : 0
    };
  });
  rows.sort(function (a, b) {
    return (b.overall_score || 0) - (a.overall_score || 0) || b.t5 - a.t5 || b.t4plus - a.t4plus ||
      String(a.name).localeCompare(String(b.name));
  });
  rows.forEach(function (r, i) { r.rank = i + 1; });
  return rows;
}

function analytics_(periodId, perfRows) {
  var dist = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }, scored = 0, total = 0;
  perfRows.forEach(function (r) {
    if (String(r.period_id) !== String(periodId)) return;
    total++;
    var lvl = num_(r.highest_level);
    if (lvl !== null) { dist[lvl]++; scored++; }
  });
  return {
    total: total, scored: dist, count: scored,
    t5rate: scored ? Math.round(dist[5] / scored * 100) : 0,
    t4plus: scored ? Math.round((dist[4] + dist[5]) / scored * 100) : 0
  };
}

/* ==========================================================================
 * SESSION & AUTHORIZATION — server-authoritative (spec: not just UI hiding).
 * ======================================================================== */
var ROLE_PERMS = {
  super_admin: ['*'],
  hr_admin: ['view', 'create', 'edit', 'delete', 'approve', 'publish', 'export', 'lock', 'admin'],
  business_head: ['view', 'create', 'edit', 'approve', 'publish', 'export'],
  team_leader: ['view', 'create', 'edit', 'approve', 'export'],
  manager: ['view', 'create', 'edit', 'export'],
  employee: ['view', 'edit_own'],
  auditor: ['view', 'export']
};

function currentEmail_() {
  try { return (Session.getActiveUser().getEmail() || Session.getEffectiveUser().getEmail() || '').toLowerCase(); }
  catch (e) { return ''; }
}

/**
 * Who is calling. The signed-in email is matched against EMPLOYEES.email; an
 * unmatched caller falls back to an administrator who may preview other roles
 * (documented first-run behaviour, same as the Tracker).
 */
function resolveSession_(viewAsUserId) {
  var emps = read_(T.EMPLOYEES), users = read_(T.USERS);
  var email = currentEmail_(), me = null;
  emps.forEach(function (e) { if (email && String(e.email || '').toLowerCase() === email) me = e; });
  var isAdmin = !me;
  var role = me ? (me.role_id || 'employee') : 'super_admin';
  var employeeId = me ? me.id : '';
  var name = me ? me.name : (email || 'Administrator');

  /* "View as" preview — only an admin may assume another demo user, and it
   * changes the REAL permission set, not just the visible controls. */
  if (viewAsUserId && isAdmin) {
    var u = users.filter(function (x) { return String(x.id) === String(viewAsUserId); })[0];
    if (u) { role = u.role_id; employeeId = u.employee_id || ''; name = u.name; }
  }
  return {
    email: email || '(unknown)', name: name, role_id: role, employee_id: employeeId,
    admin: isAdmin, can_switch: isAdmin, users: users
  };
}

function can_(s, action) {
  var perms = ROLE_PERMS[s.role_id] || [];
  return perms.indexOf('*') >= 0 || perms.indexOf(action) >= 0;
}

/** May this session act on this employee's data? */
function canScope_(s, employeeId, empsById) {
  if (s.role_id === 'super_admin' || s.role_id === 'hr_admin' || s.role_id === 'business_head') return true;
  if (!s.employee_id || !employeeId) return false;
  if (String(s.employee_id) === String(employeeId)) return true;
  var e = empsById[employeeId], guard = 0;
  while (e && guard++ < 30) {
    if (String(e.manager_id) === String(s.employee_id)) return true;
    e = empsById[e.manager_id];
  }
  return false;
}

function requireScope_(s, employeeId, empsById, what) {
  if (!canScope_(s, employeeId, empsById)) {
    throw new Error('You do not have permission to ' + (what || 'change this') + '.');
  }
}

function audit_(actorId, entityType, entityId, action, oldValue, newValue, reason) {
  try {
    append_(T.AUDIT, {
      id: uid_('aud'), ts: nowIso_(), actor_id: actorId || 'system', entity_type: entityType,
      entity_id: String(entityId), action: action,
      old_value: oldValue === null || oldValue === undefined ? '' : JSON.stringify(oldValue),
      new_value: newValue === null || newValue === undefined ? '' : JSON.stringify(newValue),
      reason: reason || ''
    });
  } catch (e) { /* the audit trail must never break the write it records */ }
}

function notify_(recipientId, type, title, message, entityType, entityId) {
  try {
    append_(T.NOTIFICATIONS, {
      id: uid_('ntf'), recipient_id: recipientId || 'all', type: type, title: title,
      message: message, entity_type: entityType || '', entity_id: entityId || '',
      read: 0, created_at: nowIso_()
    });
  } catch (e) {}
}

/* ==========================================================================
 * MODEL — everything the client needs for one period, in one round trip.
 * Performance rows are period-scoped (the full history would be far larger
 * than the UI ever shows at once); per-period overall summaries for every
 * employee are included so trends and history render without extra calls.
 * ======================================================================== */
function buildModel_(periodId) {
  ensureSeeded_();
  var periods = read_(T.PERIODS).sort(function (a, b) { return num_(a.sort) - num_(b.sort); });
  var months = periods.filter(function (p) { return p.kind === 'month'; });
  var settings = {};
  read_(T.SETTINGS).forEach(function (s) {
    var v = s.value;
    try { v = JSON.parse(s.value); } catch (e) {}
    settings[s.key] = v;
  });
  var effPeriod = periodId || settings.current_period || (months.length ? months[Math.min(4, months.length - 1)].id : '');

  var employees = read_(T.EMPLOYEES), kras = read_(T.KRAS), kpis = read_(T.KPIS);
  var kpisById = idx_(kpis), krasById = idx_(kras);
  var allPerf = read_(T.PERFORMANCE);
  var perf = allPerf.filter(function (r) { return String(r.period_id) === String(effPeriod); });

  var overalls = overallsFor_(effPeriod, allPerf, kpisById, krasById);

  /* history: overall level per employee per month, for trends (small payload) */
  var history = {};
  months.forEach(function (p) {
    var ov = overallsFor_(p.id, allPerf, kpisById, krasById);
    Object.keys(ov).forEach(function (empId) {
      (history[empId] = history[empId] || []).push({ period_id: p.id, level: ov[empId].overall_level, score: ov[empId].overall_score });
    });
  });

  return {
    ok: true,
    period_id: effPeriod,
    org_types: read_(T.ORG_TYPES).sort(function (a, b) { return num_(a.sort) - num_(b.sort); }),
    org_units: read_(T.ORG_UNITS),
    teams: read_(T.TEAMS),
    employees: employees,
    roles: read_(T.ROLES),
    kras: kras,
    kpis: kpis,
    periods: periods,
    performance: perf.map(function (r) {
      return {
        id: r.id, employee_id: r.employee_id, team_id: r.team_id, kra_id: r.kra_id, kpi_id: r.kpi_id,
        period_id: r.period_id, t1: num_(r.t1), t2: num_(r.t2), t3: num_(r.t3), t4: num_(r.t4), t5: num_(r.t5),
        direction: r.direction, weight: num_(r.weight), actual: num_(r.actual),
        highest_level: num_(r.highest_level), pct: num_(r.pct), status: r.status
      };
    }),
    overalls: overalls,
    history: history,
    leaderboard: leaderboard_(effPeriod, allPerf, employees, overalls),
    analytics: analytics_(effPeriod, allPerf),
    reviews: read_(T.REVIEWS).filter(function (r) { return String(r.period_id) === String(effPeriod); }),
    notifications: read_(T.NOTIFICATIONS).sort(function (a, b) { return String(b.created_at).localeCompare(String(a.created_at)); }).slice(0, 60),
    audit: read_(T.AUDIT).sort(function (a, b) { return String(b.ts).localeCompare(String(a.ts)); }).slice(0, 40),
    settings: settings,
    generated_at: nowIso_()
  };
}

/* ------------------------------------------------------------------- API --- */

/** Session + model in one call. Everything the client needs to start. */
function apiBootstrap(periodId, viewAsUserId) {
  try {
    var s = resolveSession_(viewAsUserId);
    var model = buildModel_(periodId);
    return jsonSafe_({
      ok: true,
      session: { email: s.email, name: s.name, role_id: s.role_id, employee_id: s.employee_id, admin: s.admin, can_switch: s.can_switch },
      users: s.users, model: model
    });
  } catch (e) {
    return { ok: false, error: String(e && e.message || e), where: 'apiBootstrap',
             stack: String(e && e.stack || '').split('\n').slice(0, 4).join(' | ') };
  }
}

function apiModel(periodId) {
  try { return jsonSafe_({ ok: true, model: buildModel_(periodId) }); }
  catch (e) { return { ok: false, error: String(e && e.message || e), where: 'apiModel' }; }
}

function apiPing() { return { ok: true, ping: 'ok', app: APP_NAME, at: nowIso_() }; }

/** Enter/update an actual → recompute levels → audit → notify on Target 5. */
function apiSaveActual(p) {
  try {
    p = p || {};
    var s = resolveSession_(p.view_as);
    var emps = read_(T.EMPLOYEES), empsById = idx_(emps);
    requireScope_(s, p.employee_id, empsById, 'edit this performance');
    var periods = idx_(read_(T.PERIODS)), per = periods[p.period_id];
    if (per && String(per.status) === 'locked' && s.role_id !== 'super_admin' && s.role_id !== 'hr_admin') {
      throw new Error('Period ' + per.name + ' is locked.');
    }
    var rows = read_(T.PERFORMANCE);
    var rec = null;
    for (var i = 0; i < rows.length; i++) {
      if (String(rows[i].employee_id) === String(p.employee_id) && String(rows[i].kpi_id) === String(p.kpi_id) &&
          String(rows[i].period_id) === String(p.period_id)) { rec = rows[i]; break; }
    }
    if (!rec) throw new Error('No performance record for that KPI and period.');
    var val = num_(p.value);
    if (p.value !== '' && val === null) throw new Error('Enter a numeric actual value.');
    var oldActual = num_(rec.actual), oldLevel = num_(rec.highest_level);
    rec.actual = val === null ? '' : val;
    rec.status = 'submitted';
    rec.updated_at = nowIso_();
    upsert_(T.PERFORMANCE, rec);

    var summary = recompute_(p.employee_id, p.period_id);
    var fresh = read_(T.PERFORMANCE).filter(function (r) { return String(r.id) === String(rec.id); })[0] || rec;
    var newLevel = num_(fresh.highest_level);
    var emp = empsById[p.employee_id] || {}, kpi = idx_(read_(T.KPIS))[p.kpi_id] || {};

    audit_(s.employee_id || s.email, 'performance', rec.id, 'edit_actual',
      { actual: oldActual, level: oldLevel }, { actual: val, level: newLevel });
    if (newLevel === 5 && oldLevel !== 5) {
      notify_(emp.manager_id || 'all', 'Target 5 Achieved', 'Target 5 achieved',
        emp.name + ' achieved Target 5 for ' + kpi.name + ' (' + ((periods[p.period_id] || {}).name || p.period_id) + ').',
        'employee', p.employee_id);
    }
    return jsonSafe_({ ok: true, summary: summary, model: buildModel_(p.period_id) });
  } catch (e) {
    return { ok: false, error: String(e && e.message || e), where: 'apiSaveActual' };
  }
}

/** Save several actuals for one employee/period in one transaction-ish pass. */
function apiSavePerformance(p) {
  try {
    p = p || {};
    var s = resolveSession_(p.view_as);
    var emps = read_(T.EMPLOYEES), empsById = idx_(emps);
    requireScope_(s, p.employee_id, empsById, 'enter this performance');
    var periods = idx_(read_(T.PERIODS)), per = periods[p.period_id];
    if (per && String(per.status) === 'locked' && s.role_id !== 'super_admin' && s.role_id !== 'hr_admin') {
      throw new Error('Period ' + per.name + ' is locked.');
    }
    var entries = p.entries || [];
    if (!entries.length) throw new Error('Nothing to save.');
    var rows = read_(T.PERFORMANCE), updates = [];
    entries.forEach(function (en) {
      var val = num_(en.value);
      if (val === null) return;
      for (var i = 0; i < rows.length; i++) {
        var r = rows[i];
        if (String(r.employee_id) === String(p.employee_id) && String(r.kpi_id) === String(en.kpi_id) &&
            String(r.period_id) === String(p.period_id)) {
          r.actual = val; r.status = 'submitted'; r.updated_at = nowIso_(); updates.push(r); break;
        }
      }
    });
    if (updates.length) bulkUpdate_(T.PERFORMANCE, updates);
    var summary = recompute_(p.employee_id, p.period_id);
    var emp = empsById[p.employee_id] || {};
    audit_(s.employee_id || s.email, 'performance', p.employee_id + '|' + p.period_id, 'enter_performance', null, { kpis: updates.length });
    notify_(emp.manager_id || 'all', 'Performance Submitted', 'Performance submitted',
      emp.name + ' submitted performance for ' + ((per || {}).name || p.period_id) + '.', 'employee', p.employee_id);
    return jsonSafe_({ ok: true, saved: updates.length, summary: summary, model: buildModel_(p.period_id) });
  } catch (e) {
    return { ok: false, error: String(e && e.message || e), where: 'apiSavePerformance' };
  }
}

/** Edit a KPI's five target thresholds for a period. Validates ordering by
 *  direction (never applies higher-is-better rules to a range KPI), versions
 *  the target, and mirrors the change onto the performance row so the level
 *  recomputes against the new ladder. */
function apiSaveTarget(p) {
  try {
    p = p || {};
    var s = resolveSession_(p.view_as);
    var emps = read_(T.EMPLOYEES), empsById = idx_(emps);
    requireScope_(s, p.employee_id, empsById, 'set this target');
    if (!can_(s, 'edit')) throw new Error('Your role cannot edit targets.');
    var kpi = idx_(read_(T.KPIS))[p.kpi_id];
    if (!kpi) throw new Error('Unknown KPI.');
    var dir = kpi.direction || 'higher_is_better';
    var t = [num_(p.t1), num_(p.t2), num_(p.t3), num_(p.t4), num_(p.t5)];
    for (var i = 1; i < 5; i++) {
      if (t[i] === null || t[i - 1] === null) continue;
      if (dir === 'higher_is_better' && t[i] < t[i - 1]) throw new Error('For higher-is-better, T' + (i + 1) + ' must be ≥ T' + i + '.');
      if (dir === 'lower_is_better' && t[i] > t[i - 1]) throw new Error('For lower-is-better, T' + (i + 1) + ' must be ≤ T' + i + '.');
    }
    var targets = read_(T.TARGETS), rec = null;
    for (var j = 0; j < targets.length; j++) {
      if (String(targets[j].employee_id) === String(p.employee_id) && String(targets[j].kpi_id) === String(p.kpi_id) &&
          String(targets[j].period_id) === String(p.period_id)) { rec = targets[j]; break; }
    }
    var old = rec ? { t1: num_(rec.t1), t2: num_(rec.t2), t3: num_(rec.t3), t4: num_(rec.t4), t5: num_(rec.t5) } : null;
    var version = rec ? (num_(rec.version) || 1) + 1 : 1;
    var row = {
      id: rec ? rec.id : ('tgt_' + p.employee_id + '_' + p.kpi_id + '_' + p.period_id),
      employee_id: p.employee_id, kpi_id: p.kpi_id, period_id: p.period_id,
      t1: t[0], t2: t[1], t3: t[2], t4: t[3], t5: t[4],
      unit: kpi.unit, direction: dir, status: 'published', version: version,
      created_by: rec ? rec.created_by : (s.employee_id || s.email),
      approved_by: s.employee_id || s.email, approved_at: nowIso_()
    };
    upsert_(T.TARGETS, row);

    /* keep the performance row's ladder in step, then recompute */
    var perf = read_(T.PERFORMANCE), pr = null;
    for (var k = 0; k < perf.length; k++) {
      if (String(perf[k].employee_id) === String(p.employee_id) && String(perf[k].kpi_id) === String(p.kpi_id) &&
          String(perf[k].period_id) === String(p.period_id)) { pr = perf[k]; break; }
    }
    if (pr) {
      pr.t1 = t[0]; pr.t2 = t[1]; pr.t3 = t[2]; pr.t4 = t[3]; pr.t5 = t[4];
      pr.updated_at = nowIso_();
      upsert_(T.PERFORMANCE, pr);
    }
    var summary = recompute_(p.employee_id, p.period_id);
    audit_(s.employee_id || s.email, 'target', row.id, 'edit_target', old,
      { t1: t[0], t2: t[1], t3: t[2], t4: t[3], t5: t[4] }, 'Target revision v' + version);
    notify_(p.employee_id, 'Target Changed', 'Targets updated',
      'Your targets for ' + kpi.name + ' were updated (v' + version + ').', 'employee', p.employee_id);
    return jsonSafe_({ ok: true, summary: summary, model: buildModel_(p.period_id) });
  } catch (e) {
    return { ok: false, error: String(e && e.message || e), where: 'apiSaveTarget' };
  }
}

/** Create/update a performance review. */
function apiSaveReview(p) {
  try {
    p = p || {};
    var s = resolveSession_(p.view_as);
    var empsById = idx_(read_(T.EMPLOYEES));
    requireScope_(s, p.employee_id, empsById, 'edit this review');
    var id = 'rev_' + p.employee_id + '_' + p.period_id;
    var existing = read_(T.REVIEWS).filter(function (r) { return String(r.id) === id; })[0];
    var STATUSES = ['Draft', 'Pending', 'Submitted', 'Completed', 'Overdue'];
    var status = STATUSES.indexOf(p.status) >= 0 ? p.status : 'Draft';
    var row = {
      id: id, employee_id: p.employee_id, period_id: p.period_id, status: status,
      mgr_achievements: p.mgr_achievements || '', mgr_strengths: p.mgr_strengths || '',
      mgr_improvements: p.mgr_improvements || '', emp_self: p.emp_self || '',
      emp_support: p.emp_support || '', reviewer_id: s.employee_id || s.email, updated_at: nowIso_()
    };
    upsert_(T.REVIEWS, row);
    audit_(s.employee_id || s.email, 'review', id, existing ? 'update_review' : 'create_review',
      existing ? { status: existing.status } : null, { status: status });
    notify_(p.employee_id, 'Review Completed', 'Review updated',
      'Your review was updated (' + status + ').', 'review', id);
    return jsonSafe_({ ok: true, model: buildModel_(p.period_id) });
  } catch (e) {
    return { ok: false, error: String(e && e.message || e), where: 'apiSaveReview' };
  }
}

/** Add an employee. Employee ID must be unique and well-formed. */
function apiSaveEmployee(p) {
  try {
    p = p || {};
    var s = resolveSession_(p.view_as);
    if (!can_(s, 'create')) throw new Error('Your role cannot add employees.');
    var id = String(p.id || '').trim();
    if (!/^EMP-\d{5}$/.test(id)) throw new Error('Employee ID must look like EMP-00200.');
    var emps = read_(T.EMPLOYEES);
    if (emps.filter(function (e) { return String(e.id) === id; }).length) throw new Error('Employee ID ' + id + ' already exists.');
    if (!String(p.name || '').trim()) throw new Error('Name is required.');
    var team = idx_(read_(T.TEAMS))[p.team_id];
    if (!team) throw new Error('Choose a valid team.');
    var unit = idx_(read_(T.ORG_UNITS))[team.org_unit_id] || {};
    append_(T.EMPLOYEES, {
      id: id, name: p.name, designation: p.designation || 'Executive',
      org_type_id: unit.org_type_id || '', org_unit_id: unit.id || '', team_id: team.id,
      manager_id: team.leader_id || '', functional_head_id: unit.head_id || '',
      employment_status: 'Active', employment_type: p.employment_type || 'Full-time',
      date_of_joining: p.date_of_joining || nowIso_().slice(0, 10), location: p.location || '',
      role_id: 'employee', email: p.email || ''
    });
    audit_(s.employee_id || s.email, 'employee', id, 'create', null, { name: p.name, team: team.name });
    return jsonSafe_({ ok: true, model: buildModel_(p.period_id) });
  } catch (e) {
    return { ok: false, error: String(e && e.message || e), where: 'apiSaveEmployee' };
  }
}

function apiSaveKra(p) {
  try {
    p = p || {};
    var s = resolveSession_(p.view_as);
    if (!can_(s, 'create')) throw new Error('Your role cannot create KRAs.');
    if (!String(p.name || '').trim()) throw new Error('Name is required.');
    var id = p.id || ('kra_' + uid_('').slice(-6));
    upsert_(T.KRAS, {
      id: id, name: p.name, code: p.code || String(p.name).slice(0, 3).toUpperCase(),
      description: p.description || '', weight: num_(p.weight) || 0, status: 'Active',
      effective_from: p.effective_from || nowIso_().slice(0, 10)
    });
    audit_(s.employee_id || s.email, 'kra', id, 'create', null, { name: p.name, weight: p.weight });
    return jsonSafe_({ ok: true, model: buildModel_(p.period_id) });
  } catch (e) { return { ok: false, error: String(e && e.message || e), where: 'apiSaveKra' }; }
}

function apiSaveKpi(p) {
  try {
    p = p || {};
    var s = resolveSession_(p.view_as);
    if (!can_(s, 'create')) throw new Error('Your role cannot create KPIs.');
    if (!String(p.name || '').trim()) throw new Error('Name is required.');
    if (!idx_(read_(T.KRAS))[p.kra_id]) throw new Error('Choose a valid KRA.');
    var DIRS = ['higher_is_better', 'lower_is_better', 'range'];
    var MTS = ['number', 'currency', 'percentage', 'quantity', 'count', 'ratio', 'time', 'boolean', 'rating'];
    var id = p.id || ('kpi_' + uid_('').slice(-6));
    upsert_(T.KPIS, {
      id: id, kra_id: p.kra_id, name: p.name, code: p.code || String(p.name).slice(0, 3).toUpperCase(),
      description: p.description || '',
      measurement_type: MTS.indexOf(p.measurement_type) >= 0 ? p.measurement_type : 'number',
      unit: p.unit || '', frequency: p.frequency || 'Monthly',
      direction: DIRS.indexOf(p.direction) >= 0 ? p.direction : 'higher_is_better',
      weight: num_(p.weight) || 0, status: 'Active'
    });
    audit_(s.employee_id || s.email, 'kpi', id, 'create', null, { name: p.name, kra: p.kra_id });
    return jsonSafe_({ ok: true, model: buildModel_(p.period_id) });
  } catch (e) { return { ok: false, error: String(e && e.message || e), where: 'apiSaveKpi' }; }
}

function apiMarkNotifications(p) {
  try {
    p = p || {};
    var rows = read_(T.NOTIFICATIONS), updates = [];
    rows.forEach(function (r) {
      if (p.id && String(r.id) !== String(p.id)) return;
      if (String(r.read) === '1') return;
      r.read = 1; updates.push(r);
    });
    if (updates.length) bulkUpdate_(T.NOTIFICATIONS, updates);
    return jsonSafe_({ ok: true, marked: updates.length, model: buildModel_(p.period_id) });
  } catch (e) { return { ok: false, error: String(e && e.message || e), where: 'apiMarkNotifications' }; }
}

/* Rebuild every derived value for a period — a safety net after bulk edits. */
function apiRecomputeAll(p) {
  try {
    p = p || {};
    var s = resolveSession_(p.view_as);
    if (!can_(s, 'admin')) throw new Error('Only an administrator can recompute everything.');
    var periodId = p.period_id;
    var emps = {};
    read_(T.PERFORMANCE).forEach(function (r) { if (String(r.period_id) === String(periodId)) emps[r.employee_id] = 1; });
    Object.keys(emps).forEach(function (id) { recompute_(id, periodId); });
    audit_(s.employee_id || s.email, 'period', periodId, 'recompute_all', null, { employees: Object.keys(emps).length });
    return jsonSafe_({ ok: true, employees: Object.keys(emps).length, model: buildModel_(periodId) });
  } catch (e) { return { ok: false, error: String(e && e.message || e), where: 'apiRecomputeAll' }; }
}

function apiResetDemo(p) {
  try {
    p = p || {};
    var s = resolveSession_(p.view_as);
    if (!can_(s, 'admin')) throw new Error('Only an administrator can reset the demo data.');
    PropertiesService.getScriptProperties().deleteProperty('PERFORMOS_SEEDED');
    seedAll_();
    audit_(s.employee_id || s.email, 'system', 'demo', 'reset_demo', null, null);
    return jsonSafe_({ ok: true, model: buildModel_(null) });
  } catch (e) { return { ok: false, error: String(e && e.message || e), where: 'apiResetDemo' }; }
}

/* ==========================================================================
 * SEED — a realistic demo organisation. The structure is authoritative (from
 * the supplied organisation chart); people, targets and performance are
 * generated deterministically so the spread of levels is reproducible.
 * Rahul Sharma (EMP-00124) carries the specified demo figures exactly.
 * ======================================================================== */
function ensureSeeded_() {
  var props = PropertiesService.getScriptProperties();
  if (props.getProperty('PERFORMOS_SEEDED') === '1') return false;
  seedAll_();
  return true;
}

/** Run once manually if you prefer explicit setup. Safe to re-run. */
function provisionAndSeed() {
  PropertiesService.getScriptProperties().deleteProperty('PERFORMOS_SEEDED');
  seedAll_();
  var ss = ss_();
  return 'Seeded. Backend spreadsheet: ' + ss.getUrl();
}

var LEADERSHIP_ = [
  ['EMP-00001', 'Abhay Deshpande', 'Chief Executive Officer · Founder', 'CEO'],
  ['EMP-00002', 'Ekta Narain', 'Chief Business & Impact Officer', 'CBIO'],
  ['EMP-00003', 'Abhishek Deshpande', 'Chief Operating Officer', 'COO'],
  ['EMP-00004', 'Vijay Vanparthi', 'Chief Financial Officer', 'CFO'],
  ['EMP-00005', 'Vikram Prabhakar', 'Chief Product & Technology Officer', 'CPTO'],
  ['EMP-00006', 'Anirudha Jalan', 'Chief Strategy Officer', 'CSO'],
  ['EMP-00007', 'Sujan Parthasaradhi', 'Chief Innovation Officer', 'CIO']
];

/* [code, name, org type, head] — Business Units, Central Functions, Support */
var UNITS_ = [
  ['AFR', 'Alternative Fuels & Resources', 'ot_bu', 'EMP-00002'],
  ['DRS', 'Deposit Refund System', 'ot_bu', 'EMP-00002'],
  ['EPR', 'Extended Producer Responsibility', 'ot_bu', 'EMP-00002'],
  ['INFRA', 'Infra Business', 'ot_bu', 'EMP-00003'],
  ['OMP', 'Open Marketplace', 'ot_bu', 'EMP-00002'],
  ['RECOM', 'Recommerce', 'ot_bu', 'EMP-00002'],
  ['COMPL', 'Compliance', 'ot_cf', 'EMP-00003'],
  ['ONBC', 'Onboarding & Collections', 'ot_cf', 'EMP-00003'],
  ['OPS', 'Operations', 'ot_cf', 'EMP-00003'],
  ['STRAT', 'Strategy', 'ot_cf', 'EMP-00006'],
  ['TECH', 'Technology', 'ot_cf', 'EMP-00005'],
  ['HW', 'Hardware', 'ot_cf', 'EMP-00005'],
  ['FAC', 'Facility Management', 'ot_sf', 'EMP-00003'],
  ['FINL', 'Finance & Legal', 'ot_sf', 'EMP-00004'],
  ['MKTG', 'Marketing', 'ot_sf', 'EMP-00002'],
  ['PC', 'People & Culture', 'ot_sf', 'EMP-00002']
];

var TEAMSPEC_ = [
  ['INFRA', 'Metals Team', 'METAL'],
  ['INFRA', 'Cement & Aggregates', 'CEMENT'],
  ['OMP', 'Marketplace Sales', 'OMPSALES'],
  ['EPR', 'EPR Compliance Desk', 'EPRDESK'],
  ['ONBC', 'Onboarding Ops', 'ONBOPS'],
  ['RECOM', 'Recommerce Trade', 'RCTRADE']
];

var KRAS_ = [
  ['kra_rev', 'Revenue', 'REV', 40, 'Top-line revenue delivered across new and existing business.'],
  ['kra_ca', 'Customer Acquisition', 'CA', 30, 'Growth of the customer base and conversion effectiveness.'],
  ['kra_prod', 'Productivity', 'PROD', 30, 'Operational efficiency, throughput and quality of delivery.']
];

/* id, kra, name, code, measurement, unit, direction, weight, [t1..t5], definition */
var KPIS_ = [
  ['kpi_ms', 'kra_rev', 'Monthly Sales', 'MS', 'currency', 'L', 'higher_is_better', 40, [10, 15, 20, 25, 30], 'Total sales value closed in the period.'],
  ['kpi_ncr', 'kra_rev', 'New Customer Revenue', 'NCR', 'currency', 'L', 'higher_is_better', 30, [10, 15, 20, 25, 30], 'Revenue from customers acquired this period.'],
  ['kpi_col', 'kra_rev', 'Collection', 'COL', 'currency', 'L', 'higher_is_better', 30, [5, 8, 10, 12, 15], 'Payments collected against outstanding invoices.'],
  ['kpi_na', 'kra_ca', 'New Accounts', 'NA', 'count', 'accounts', 'higher_is_better', 60, [5, 10, 15, 20, 25], 'Number of new accounts onboarded.'],
  ['kpi_lc', 'kra_ca', 'Lead Conversion', 'LC', 'percentage', '%', 'higher_is_better', 40, [40, 50, 60, 70, 80], 'Share of qualified leads converted.'],
  ['kpi_ut', 'kra_prod', 'Utilization', 'UT', 'percentage', '%', 'higher_is_better', 50, [60, 70, 80, 90, 95], 'Productive utilisation of available capacity.'],
  ['kpi_ct', 'kra_prod', 'Cycle Time', 'CT', 'time', 'days', 'lower_is_better', 25, [30, 25, 20, 15, 10], 'Average days to complete the core workflow (lower is better).'],
  ['kpi_qs', 'kra_prod', 'Quality Score', 'QS', 'number', 'pts', 'range', 25, [60, 70, 80, 90, 100], 'Balanced quality index; the ideal sits mid-band.']
];

var FIRST_ = ['Aarav', 'Vivaan', 'Aditya', 'Vihaan', 'Arjun', 'Sai', 'Reyansh', 'Krishna', 'Ishaan', 'Kabir',
  'Ananya', 'Diya', 'Aadhya', 'Saanvi', 'Pari', 'Anika', 'Neha', 'Priya', 'Riya', 'Kavya',
  'Rohan', 'Karan', 'Nikhil', 'Varun', 'Sneha', 'Pooja', 'Deepak', 'Manish', 'Meera', 'Divya'];
var LAST_ = ['Sharma', 'Verma', 'Patel', 'Reddy', 'Nair', 'Iyer', 'Rao', 'Singh', 'Gupta', 'Mehta',
  'Kulkarni', 'Bose', 'Das', 'Menon', 'Kapoor', 'Malhotra', 'Chopra', 'Bhat', 'Pillai', 'Joshi'];
var DESIGS_ = ['Executive', 'Senior Executive', 'Associate', 'Senior Associate', 'Assistant Manager', 'Manager'];

/* deterministic RNG so a reseed reproduces the same organisation */
function rng_(seed) {
  var s = seed >>> 0;
  return function () { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}
function hash_(str) { var h = 0; for (var i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) & 0x7fffffff; return h; }
function pick_(r, arr) { return arr[Math.floor(r() * arr.length)]; }

/** An actual that lands on a chosen target level, direction-aware. */
function actualForLevel_(t, level, dir) {
  function mid(a, b) { return a + (b - a) * 0.5; }
  if (dir === 'lower_is_better') {
    if (level <= 0) return Math.round(t[0] * 1.2);
    if (level >= 5) return Math.round(t[4] * 0.9 * 10) / 10;
    return Math.round(mid(t[level - 1], t[level]) * 10) / 10;
  }
  if (dir === 'range') {
    var lo = t[0], hi = t[4], m = t[2];
    if (level <= 0) return Math.round(lo - (hi - lo) * 0.2);
    var frac = (5 - level) / 5;
    return Math.round(m + (hi - m) * frac);
  }
  if (level <= 0) return Math.round(t[0] * 0.8 * 10) / 10;
  if (level >= 5) return Math.round((t[4] + (t[4] - t[3]) * 0.4) * 10) / 10;
  return Math.round(mid(t[level - 1], t[level]) * 10) / 10;
}

/** Rahul Sharma's exact demo actuals for August 2026 (the specified figures). */
function rahulActual_(empId, kpiId, periodId) {
  if (empId !== 'EMP-00124' || periodId !== 'per_2026-08') return null;
  var map = { kpi_ms: 27, kpi_ncr: 32, kpi_col: 11, kpi_na: 26, kpi_lc: 72, kpi_ut: 92, kpi_ct: 13, kpi_qs: 88 };
  return map[kpiId] === undefined ? null : map[kpiId];
}

function slug_(n) { return String(n).toLowerCase().replace(/[^a-z]+/g, '.').replace(/^\.|\.$/g, ''); }

function seedAll_() {
  var r = rng_(20260901);

  var orgTypes = [
    { id: 'ot_lead', name: 'Leadership', code: 'LEAD', color: '#B8860B', sort: 0 },
    { id: 'ot_bu', name: 'Business Unit', code: 'BU', color: '#2E7D52', sort: 1 },
    { id: 'ot_cf', name: 'Central Function', code: 'CF', color: '#7C4DBC', sort: 2 },
    { id: 'ot_sf', name: 'Support Function', code: 'SF', color: '#2F74D0', sort: 3 }
  ];
  var roles = [
    { id: 'super_admin', name: 'Super Admin' }, { id: 'hr_admin', name: 'HR / Admin' },
    { id: 'business_head', name: 'Business Head' }, { id: 'team_leader', name: 'Team Leader' },
    { id: 'manager', name: 'Manager' }, { id: 'employee', name: 'Employee' }, { id: 'auditor', name: 'Auditor' }
  ];
  var unitId = function (code) { return 'ou_' + String(code).toLowerCase(); };
  var headOf = {}, typeOf = {};
  UNITS_.forEach(function (u) { headOf[u[0]] = u[3]; typeOf[u[0]] = u[2]; });
  var orgUnits = UNITS_.map(function (u) {
    return { id: unitId(u[0]), org_type_id: u[2], name: u[1], code: u[0], head_id: u[3], status: 'Active' };
  });

  var employees = LEADERSHIP_.map(function (l, i) {
    return {
      id: l[0], name: l[1], designation: l[2], org_type_id: 'ot_lead', org_unit_id: '', team_id: '',
      manager_id: i === 0 ? '' : 'EMP-00001', functional_head_id: '', employment_status: 'Active',
      employment_type: 'Full-time', date_of_joining: '2019-04-01', location: 'Hyderabad',
      role_id: i === 0 ? 'super_admin' : 'business_head', email: slug_(l[1]) + '@recykal.com'
    };
  });

  /* periods: FY 2026–27 months + quarters + FY */
  var monthDefs = [['2026-04', 'April 2026'], ['2026-05', 'May 2026'], ['2026-06', 'June 2026'],
    ['2026-07', 'July 2026'], ['2026-08', 'August 2026'], ['2026-09', 'September 2026'],
    ['2026-10', 'October 2026'], ['2026-11', 'November 2026'], ['2026-12', 'December 2026'],
    ['2027-01', 'January 2027'], ['2027-02', 'February 2027'], ['2027-03', 'March 2027']];
  var CURRENT = 'per_2026-08';
  var periods = monthDefs.map(function (m, i) {
    return { id: 'per_' + m[0], name: m[1], kind: 'month', code: m[0], sort: i,
             status: i < 4 ? 'locked' : (i === 4 ? 'open' : 'upcoming'), start_date: m[0] + '-01' };
  });
  ['Q1', 'Q2', 'Q3', 'Q4', 'FY'].forEach(function (q, i) {
    periods.push({ id: 'per_' + q, name: 'FY 2026–27 · ' + q, kind: q === 'FY' ? 'fy' : 'quarter',
                   code: q, sort: 100 + i, status: 'open', start_date: '2026-04-01' });
  });
  var HIST = ['per_2026-04', 'per_2026-05', 'per_2026-06', 'per_2026-07', CURRENT];

  var kras = KRAS_.map(function (k) {
    return { id: k[0], name: k[1], code: k[2], description: k[4], weight: k[3], status: 'Active', effective_from: '2026-04-01' };
  });
  var kpis = KPIS_.map(function (k) {
    return { id: k[0], kra_id: k[1], name: k[2], code: k[3], description: k[9],
             measurement_type: k[4], unit: k[5], frequency: 'Monthly', direction: k[6], weight: k[7], status: 'Active' };
  });
  var ladder = {}, dirOf = {}, kraOf = {};
  KPIS_.forEach(function (k) { ladder[k[0]] = k[8]; dirOf[k[0]] = k[6]; kraOf[k[0]] = k[1]; });

  /* teams + members. Generated ids start at 200 so they never collide with the
   * reserved ones (Amit Sharma EMP-00120, Rahul Sharma EMP-00124). */
  var teams = [], empNo = 200;
  function nextId() { empNo++; return 'EMP-' + ('00000' + empNo).slice(-5); }

  TEAMSPEC_.forEach(function (ts) {
    var code = ts[2], teamId = 'team_' + code.toLowerCase();
    var leaderId = code === 'METAL' ? 'EMP-00120' : nextId();
    var leaderName = code === 'METAL' ? 'Amit Sharma' : (pick_(r, FIRST_) + ' ' + pick_(r, LAST_));
    teams.push({ id: teamId, org_unit_id: unitId(ts[0]), name: ts[1], code: code, leader_id: leaderId,
                 description: ts[1] + ' — ' + ts[0], status: 'Active' });
    employees.push(mkEmp_(leaderId, leaderName, 'Team Leader', ts[0], teamId, headOf[ts[0]], 'team_leader', typeOf, headOf, unitId, r));
    var count = 5 + Math.floor(r() * 2);
    for (var i = 0; i < count; i++) {
      var id, name, desig, role;
      if (code === 'METAL' && i === 0) { id = 'EMP-00124'; name = 'Rahul Sharma'; desig = 'Senior Executive'; role = 'employee'; }
      else { id = nextId(); name = pick_(r, FIRST_) + ' ' + pick_(r, LAST_); desig = pick_(r, DESIGS_); role = (i === 1 ? 'manager' : 'employee'); }
      employees.push(mkEmp_(id, name, desig, ts[0], teamId, leaderId, role, typeOf, headOf, unitId, r));
    }
  });

  var users = [
    { id: 'u_admin', name: 'Platform Admin', email: 'admin@recykal.com', role_id: 'super_admin', employee_id: 'EMP-00001' },
    { id: 'u_hr', name: 'Ekta Narain (HR)', email: 'ekta.narain@recykal.com', role_id: 'hr_admin', employee_id: 'EMP-00002' },
    { id: 'u_lead', name: 'Amit Sharma (Team Leader)', email: 'amit.sharma@recykal.com', role_id: 'team_leader', employee_id: 'EMP-00120' },
    { id: 'u_emp', name: 'Rahul Sharma (Employee)', email: 'rahul.sharma@recykal.com', role_id: 'employee', employee_id: 'EMP-00124' },
    { id: 'u_audit', name: 'Auditor', email: 'auditor@recykal.com', role_id: 'auditor', employee_id: '' }
  ];

  /* assignments + targets + performance for every team member across HIST */
  var assignments = [], targets = [], performance = [];
  var members = employees.filter(function (e) { return e.team_id; });
  members.forEach(function (emp) {
    var er = rng_(hash_(emp.id));
    KPIS_.forEach(function (k) {
      var kpiId = k[0];
      assignments.push({ id: uid_('asg'), employee_id: emp.id, kpi_id: kpiId, kra_id: kraOf[kpiId],
        source: 'team', weight: k[7], status: 'Active', effective_from: '2026-04-01', effective_to: '' });
      HIST.forEach(function (periodId, hi) {
        var base = er();
        var bucket = base < 0.08 ? 0 : base < 0.22 ? 1 : base < 0.42 ? 2 : base < 0.68 ? 3 : base < 0.88 ? 4 : 5;
        var drift = Math.round((hi - 2) * 0.4 * (er() < 0.6 ? 1 : 0));
        var level = Math.max(0, Math.min(5, bucket + drift));
        var t = ladder[kpiId];
        var actual = actualForLevel_(t, level, dirOf[kpiId]);
        var override = rahulActual_(emp.id, kpiId, periodId);
        if (override !== null) actual = override;
        targets.push({ id: 'tgt_' + emp.id + '_' + kpiId + '_' + periodId, employee_id: emp.id, kpi_id: kpiId,
          period_id: periodId, t1: t[0], t2: t[1], t3: t[2], t4: t[3], t5: t[4], unit: k[5], direction: dirOf[kpiId],
          status: periodId === CURRENT ? 'published' : 'locked', version: 1, created_by: 'EMP-00120',
          approved_by: 'EMP-00003', approved_at: '2026-03-28T10:00:00Z' });
        performance.push({ id: 'prf_' + emp.id + '_' + kpiId + '_' + periodId, employee_id: emp.id, team_id: emp.team_id,
          kra_id: kraOf[kpiId], kpi_id: kpiId, period_id: periodId,
          t1: t[0], t2: t[1], t3: t[2], t4: t[3], t5: t[4], direction: dirOf[kpiId], weight: k[7],
          actual: actual, highest_level: '', levels_achieved: '', pct: '', score: '',
          status: periodId === CURRENT ? 'submitted' : 'locked', updated_at: '' });
      });
    });
  });

  var reviews = ['EMP-00124', 'EMP-00120'].map(function (id) {
    return { id: 'rev_' + id + '_' + CURRENT, employee_id: id, period_id: CURRENT,
             status: id === 'EMP-00124' ? 'Submitted' : 'Draft', mgr_achievements: '', mgr_strengths: '',
             mgr_improvements: '', emp_self: '', emp_support: '', reviewer_id: 'EMP-00120', updated_at: nowIso_() };
  });

  var notifications = [
    { id: uid_('ntf'), recipient_id: 'EMP-00120', type: 'Target 5 Achieved', title: 'Target 5 achieved',
      message: 'Rahul Sharma achieved Target 5 for New Customer Revenue (August 2026).',
      entity_type: 'employee', entity_id: 'EMP-00124', read: 0, created_at: nowIso_() },
    { id: uid_('ntf'), recipient_id: 'EMP-00120', type: 'Performance Submitted', title: 'Performance submitted',
      message: 'Rahul Sharma submitted performance for August 2026.',
      entity_type: 'employee', entity_id: 'EMP-00124', read: 0, created_at: nowIso_() },
    { id: uid_('ntf'), recipient_id: 'all', type: 'Target Published', title: 'Targets published',
      message: 'August 2026 targets have been published for all active teams.',
      entity_type: 'period', entity_id: CURRENT, read: 0, created_at: nowIso_() },
    { id: uid_('ntf'), recipient_id: 'EMP-00124', type: 'Review Pending', title: 'Review pending',
      message: 'Your August 2026 performance review is pending manager sign-off.',
      entity_type: 'review', entity_id: 'rev_EMP-00124_' + CURRENT, read: 0, created_at: nowIso_() }
  ];

  var settings = [
    { key: 'current_period', value: CURRENT },
    { key: 'aggregation', value: JSON.stringify({ method: 'weighted_mean', rounding: 'nearest',
        description: 'Overall = round( Σ(level × weight) ÷ Σ weight ), weighted by KRA weight.' }) },
    { key: 'ranking', value: JSON.stringify({ order: ['overall_score', 't5', 't4plus', 'name'],
        description: 'Rank by overall score, then Target 5 hits, then Target 4+ hits, then name.' }) },
    { key: 'consistency', value: JSON.stringify({ level: 4, periods: 3,
        description: 'Consistent = Target 4+ for 3 consecutive periods.' }) }
  ];

  write_(T.ORG_TYPES, orgTypes);
  write_(T.ROLES, roles);
  write_(T.ORG_UNITS, orgUnits);
  write_(T.TEAMS, teams);
  write_(T.EMPLOYEES, employees);
  write_(T.KRAS, kras);
  write_(T.KPIS, kpis);
  write_(T.PERIODS, periods);
  write_(T.ASSIGNMENTS, assignments);
  write_(T.TARGETS, targets);
  write_(T.PERFORMANCE, performance);
  write_(T.REVIEWS, reviews);
  write_(T.NOTIFICATIONS, notifications);
  write_(T.SETTINGS, settings);
  write_(T.USERS, users);
  write_(T.AUDIT, []);

  /* compute every level/rollup once, so the app opens on real numbers */
  var pairs = {};
  performance.forEach(function (p) { pairs[p.employee_id + '|' + p.period_id] = [p.employee_id, p.period_id]; });
  Object.keys(pairs).forEach(function (k) { recompute_(pairs[k][0], pairs[k][1]); });

  PropertiesService.getScriptProperties().setProperty('PERFORMOS_SEEDED', '1');
  return true;
}

function mkEmp_(id, name, desig, unitCode, teamId, managerId, roleId, typeOf, headOf, unitId, r) {
  return {
    id: id, name: name, designation: desig, org_type_id: typeOf[unitCode], org_unit_id: unitId(unitCode),
    team_id: teamId, manager_id: managerId, functional_head_id: headOf[unitCode],
    employment_status: 'Active', employment_type: (r() < 0.85 ? 'Full-time' : 'Contract'),
    date_of_joining: '2023-0' + (1 + Math.floor(r() * 8)) + '-15',
    location: pick_(r, ['Hyderabad', 'Bengaluru', 'Mumbai', 'Delhi', 'Pune']),
    role_id: roleId, email: slug_(name) + id.slice(-3) + '@recykal.com'
  };
}

/* ==========================================================================
 * SELF-TEST — proves the engine against the specified demo figures without
 * needing the UI. Run from the editor; reads the log.
 * ======================================================================== */
function selfTest() {
  var out = [];
  function check(label, got, want) {
    out.push((String(got) === String(want) ? 'PASS' : 'FAIL') + '  ' + label + ': ' + got + (String(got) === String(want) ? '' : ' (want ' + want + ')'));
  }
  ensureSeeded_();

  /* the three specified KPI results for Rahul Sharma, August 2026 */
  var perf = read_(T.PERFORMANCE).filter(function (r) {
    return String(r.employee_id) === 'EMP-00124' && String(r.period_id) === 'per_2026-08';
  });
  var byKpi = {};
  perf.forEach(function (r) { byKpi[r.kpi_id] = r; });
  check('Monthly Sales (27 → T4)', num_((byKpi.kpi_ms || {}).highest_level), 4);
  check('New Customer Revenue (32 → T5)', num_((byKpi.kpi_ncr || {}).highest_level), 5);
  check('Collection (11 → T3)', num_((byKpi.kpi_col || {}).highest_level), 3);

  var sum = recompute_('EMP-00124', 'per_2026-08');
  check('Overall level', sum.overall_level, 4);

  /* direction handling */
  check('lower_is_better 13 days vs [30,25,20,15,10]', levelFor_([30, 25, 20, 15, 10], 13, 'lower_is_better').level, 4);
  /* 88 sits 8 above the ideal of 80 in a 60–100 band: closeness = 1 - 8/20 = 0.6,
     so round(1 + 0.6×4) = 3. Level 3 is the designed answer, not 4. */
  check('range 88 in [60..100] ideal 80', levelFor_([60, 70, 80, 90, 100], 88, 'range').level, 3);
  check('below T1 (9 vs [10..30])', levelFor_([10, 15, 20, 25, 30], 9, 'higher_is_better').level, 0);
  check('exactly T1 (10)', levelFor_([10, 15, 20, 25, 30], 10, 'higher_is_better').level, 1);
  check('above T5 (32)', levelFor_([10, 15, 20, 25, 30], 32, 'higher_is_better').level, 5);
  check('no actual → null', String(levelFor_([10, 15, 20, 25, 30], null, 'higher_is_better').level), 'null');

  /* aggregation example from the specification: 4·.40 + 5·.20 + 3·.15 + 4·.25 = 4.00 */
  var agg = aggregate_([{ ref: 'a', level: 4, weight: 40 }, { ref: 'b', level: 5, weight: 20 },
    { ref: 'c', level: 3, weight: 15 }, { ref: 'd', level: 4, weight: 25 }]);
  /* The specification's §17 example prints 4.00, but its own figures give
     4.05 (1.6 + 1.0 + 0.45 + 1.0). Both map to Target 4, so the published
     conclusion holds; the engine reports the arithmetically correct score. */
  check('weighted aggregate 4.05', agg.score, 4.05);
  check('mapped level T4', agg.level, 4);

  var model = buildModel_(null);
  check('model period', model.period_id, 'per_2026-08');
  out.push('INFO  employees=' + model.employees.length + ' teams=' + model.teams.length +
    ' units=' + model.org_units.length + ' perf rows(period)=' + model.performance.length +
    ' leaderboard=' + model.leaderboard.length);
  out.push('INFO  T5 rate=' + model.analytics.t5rate + '%  T4+ rate=' + model.analytics.t4plus + '%');

  var res = out.join('\n');
  Logger.log(res);
  return res;
}
