/* ============================================================================
 * PerformOS — Individual KRA / KPI Performance Platform
 * Apps Script backend.  Two deployable files: Code.gs + Index.html.
 *
 * WHAT THIS IS
 *   Every person has their OWN set of KRAs and KPIs, each with its own
 *   weightage and its own five target bands. This backend holds that
 *   structure, lets it be edited, and resolves "which target level has this
 *   person reached" once actuals arrive.
 *
 *       Team → Individual → KRA → KPI → Target 1..5 → Actual
 *            → KPI level → KRA level → Overall level
 *
 * SOURCE OF TRUTH
 *   The definitions come from the KRA/KPI workbook
 *   1c0_pP4Mmye5s5D_vzoxrvJ-utkLb6JhD69TvvOBbjoo
 *   (tabs: Metal / Plastic / Onboarding / Collections / Open Marketplace -
 *   Control Tower, each with a per-individual tab). importFromSource() reads
 *   it; the platform then owns an editable, audited copy so editing never
 *   writes back over the hand-maintained original.
 *
 * TWO THINGS THE WORKBOOK FORCES
 *   1. Weightage is per-KPI and sums to 100 for each person — so the overall
 *      level is a single weighted mean over that person's KPIs. Some tabs
 *      express it as fractions (0.35), others as percent (35) — normalised
 *      per person on import.
 *   2. Target bands are NOT uniformly numeric. Real ladders include
 *      "> 28 Days", "25–28 Days", "TGT-20 Days", "≥ ₹9 Cr", "10% of LD",
 *      "80% Cumulative of Team Target", an ordinal ladder ("T+7 days" →
 *      "T - 2 days") and a qualitative one ("As per Collections Process").
 *      Bands are therefore stored as the ORIGINAL TEXT and interpreted by the
 *      Bands engine below, which detects direction rather than assuming it.
 *
 * DEPLOY — two files, no build step, no dependencies
 *   1. Paste this file as Code.gs, and Index.html as an HTML file named
 *      exactly "Index" (doGet loads it by that name — do not rename it).
 *   2. Deploy → New deployment → Web app, execute as me.
 *   3. Open the URL. The first load seeds itself; nothing to run by hand.
 *   Re-import any time from Administration. Identity is a deterministic hash
 *   of the names, so importing twice UPDATES rather than duplicating. The
 *   source sheet must be shared with the account the web app runs as.
 *   selfTest() runs 21 assertions from the editor.
 *
 * CURRENTLY IMPORTED
 *   5 teams · 38 people · 90 KRAs · 91 KPIs · 208 individual KPI assignments.
 *   Every person's per-KPI weightage totals exactly 100.
 *
 * OPEN DATA DECISIONS — stated, never silently corrected, because these
 * ladders decide people's ratings. The Structure Review screen lists them.
 *   · "PDD ₹ Cr Recovered" (Ravi Naik, Ankur, Venkat) runs ≥ ₹9 Cr at
 *     Target 1 down to < ₹5 Cr at Target 5, so recovering LESS scores
 *     higher — although the KPI reads as something to increase. Needs a
 *     decision from the KRA owner; reverse the bands if unintended.
 *   · Two KPIs have no measurable ladder and must be awarded by hand:
 *     "Reporting & Escalations" (Vishwash) and "Adherence to Reminder
 *     (Total)" (Sai Nitin).
 *
 * A LEVEL is the highest band cleared counting CONSECUTIVELY from Target 1 —
 * a gap stops the count, so clearing T1, T2 and T4 is Target 2, not Target 4.
 * Unscored KPIs leave the rollup DENOMINATOR rather than counting as zero;
 * measured_weightage reports how much of a scorecard is actually measured.
 * ========================================================================== */

var APP_NAME = 'PerformOS';
var PROP_DB = 'PERFORMOS_DB_ID';
var SOURCE_SHEET_ID = '1c0_pP4Mmye5s5D_vzoxrvJ-utkLb6JhD69TvvOBbjoo';

/* ------------------------------------------------------------------ SCHEMA --
 * One tab per table. Column order is the contract: append, never reorder. */
var T = {
  TEAMS: 'TEAMS', EMPLOYEES: 'EMPLOYEES', KRAS: 'KRAS', KPIS: 'KPIS',
  ASSIGN: 'ASSIGNMENTS', TARGETS: 'TARGETS', PERF: 'PERFORMANCE',
  PERIODS: 'PERIODS', USERS: 'USERS', AUDIT: 'AUDIT', SETTINGS: 'SETTINGS'
};
var SCHEMA = {};
SCHEMA[T.TEAMS]     = ['id', 'name', 'code', 'lead_id', 'note', 'status'];
SCHEMA[T.EMPLOYEES] = ['id', 'name', 'designation', 'team_id', 'sub_group', 'region',
                       'manager_id', 'status', 'email'];
SCHEMA[T.KRAS]      = ['id', 'team_id', 'perspective', 'name', 'status'];
SCHEMA[T.KPIS]      = ['id', 'kra_id', 'name', 'goal', 'source', 'unit', 'status'];
/* one row per person per KPI — this is what makes each scorecard individual */
SCHEMA[T.ASSIGN]    = ['id', 'employee_id', 'kra_id', 'kpi_id', 'weightage', 'status',
                       'updated_by', 'updated_at'];
/* the five bands, kept as the text the workbook actually holds */
SCHEMA[T.TARGETS]   = ['id', 'employee_id', 'kpi_id', 'period_id',
                       't1', 't2', 't3', 't4', 't5',
                       'version', 'updated_by', 'updated_at'];
SCHEMA[T.PERF]      = ['id', 'employee_id', 'kpi_id', 'period_id', 'actual', 'manual_level',
                       'level', 'kind', 'direction', 'note', 'status', 'updated_by', 'updated_at'];
SCHEMA[T.PERIODS]   = ['id', 'name', 'kind', 'sort', 'status'];
SCHEMA[T.USERS]     = ['id', 'name', 'email', 'role_id', 'employee_id'];
SCHEMA[T.AUDIT]     = ['id', 'ts', 'actor', 'entity_type', 'entity_id', 'action',
                       'old_value', 'new_value', 'reason'];
SCHEMA[T.SETTINGS]  = ['key', 'value'];

/* ----------------------------------------------------------------- SERVING -- */
function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle(APP_NAME + ' — Individual KRA / KPI Performance')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/* -------------------------------------------------------------- REPOSITORY -- */
function ss_() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty(PROP_DB);
  if (id) { try { return SpreadsheetApp.openById(id); } catch (e) {} }
  var bound = null;
  try { bound = SpreadsheetApp.getActiveSpreadsheet(); } catch (e) {}
  var ss = bound || SpreadsheetApp.create(APP_NAME + ' — Backend');
  props.setProperty(PROP_DB, ss.getId());
  return ss;
}
function tab_(name) {
  var ss = ss_(), sh = ss.getSheetByName(name), head = SCHEMA[name];
  if (!sh) sh = ss.insertSheet(name);
  if (sh.getMaxColumns() < head.length) sh.insertColumnsAfter(sh.getMaxColumns(), head.length - sh.getMaxColumns());
  sh.getRange(1, 1, 1, head.length).setValues([head]).setFontWeight('bold').setBackground('#F1F5F9');
  sh.setFrozenRows(1);
  return sh;
}
function read_(name) {
  var ss; try { ss = ss_(); } catch (e) { return []; }
  var sh = ss.getSheetByName(name);
  if (!sh || sh.getLastRow() < 2) return [];
  var head = SCHEMA[name];
  return sh.getRange(2, 1, sh.getLastRow() - 1, head.length).getValues()
    .filter(function (r) { return String(r[0]).trim() !== ''; })
    .map(function (r) { var o = {}; head.forEach(function (k, i) { o[k] = r[i]; }); return o; });
}
function write_(name, objs) {
  var sh = tab_(name), head = SCHEMA[name], need = objs.length + 1;
  if (sh.getMaxRows() < need) sh.insertRowsAfter(sh.getMaxRows(), need - sh.getMaxRows());
  if (sh.getLastRow() > 1) sh.getRange(2, 1, sh.getLastRow() - 1, head.length).clearContent();
  if (objs.length) {
    sh.getRange(2, 1, objs.length, head.length).setValues(objs.map(function (o) {
      return head.map(function (k) { return o[k] == null ? '' : o[k]; });
    }));
  }
  return objs.length;
}
function append_(name, obj) {
  var sh = tab_(name), head = SCHEMA[name];
  sh.appendRow(head.map(function (k) { return obj[k] == null ? '' : obj[k]; }));
  return obj;
}
function upsert_(name, obj) {
  var sh = tab_(name), head = SCHEMA[name], id = String(obj[head[0]]);
  var at = -1, last = sh.getLastRow();
  if (last >= 2) {
    var ids = sh.getRange(2, 1, last - 1, 1).getValues();
    for (var i = 0; i < ids.length; i++) if (String(ids[i][0]) === id) { at = i + 2; break; }
  }
  var row = head.map(function (k) { return obj[k] == null ? '' : obj[k]; });
  if (at > 0) sh.getRange(at, 1, 1, head.length).setValues([row]); else sh.appendRow(row);
  return obj;
}
function del_(name, id) {
  var sh = tab_(name), last = sh.getLastRow();
  if (last < 2) return false;
  var ids = sh.getRange(2, 1, last - 1, 1).getValues();
  for (var i = 0; i < ids.length; i++) {
    if (String(ids[i][0]) === String(id)) { sh.deleteRow(i + 2); return true; }
  }
  return false;
}
function bulkUpdate_(name, objs) {
  if (!objs.length) return 0;
  var sh = tab_(name), head = SCHEMA[name], last = sh.getLastRow();
  if (last < 2) return 0;
  var all = sh.getRange(2, 1, last - 1, head.length).getValues();
  var rowOf = {};
  for (var i = 0; i < all.length; i++) rowOf[String(all[i][0])] = i;
  var n = 0;
  objs.forEach(function (o) {
    var r = rowOf[String(o[head[0]])];
    if (r === undefined) return;
    all[r] = head.map(function (k) { return o[k] == null ? '' : o[k]; });
    n++;
  });
  sh.getRange(2, 1, all.length, head.length).setValues(all);
  return n;
}

/* --------------------------------------------------------------- UTILITIES -- */
function uid_(p) { return (p || 'id') + '-' + Utilities.getUuid().slice(0, 8); }
function nowIso_() { return new Date().toISOString(); }
function idx_(a) { var o = {}; a.forEach(function (x) { o[x.id] = x; }); return o; }
function num_(v) {
  if (v === null || v === undefined || v === '') return null;
  var n = typeof v === 'number' ? v : Number(String(v).replace(/[,\s%₹]/g, ''));
  return isFinite(n) ? n : null;
}
function slug_(s) { return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); }
/* google.script.run cannot serialise NaN/Infinity/Date; one of them anywhere
   makes the WHOLE payload arrive as null. This is the backstop. */
function jsonSafe_(o) {
  if (o === null || o === undefined) return null;
  var t = typeof o;
  if (t === 'number') return isFinite(o) ? o : null;
  if (t === 'string' || t === 'boolean') return o;
  if (o instanceof Date) return o.toISOString();
  if (Object.prototype.toString.call(o) === '[object Array]') return o.map(jsonSafe_);
  if (t === 'object') { var r = {}; Object.keys(o).forEach(function (k) { r[k] = jsonSafe_(o[k]); }); return r; }
  return String(o);
}

/* ==========================================================================
 * BANDS — interprets the workbook's "Target 1..5" text.
 * Verified against all 16 distinct ladder patterns in the source workbook.
 * ======================================================================== */
var EMPTY_BAND = /^(|-|--|—|–|n\/?a|na|nil|tbd)$/i;

/* Bands expressed relative to a date/target rather than as a magnitude:
   "T+7 days", "T - 2 days", "On Time". Turning these into 7 or 2 would
   invert their meaning, so they are never given a numeric value. */
function bandIsRelative_(s) {
  return /(^|[^A-Za-z])T\s*[+\-]\s*\d/i.test(s) || /on\s*time/i.test(s) || /as\s+per\b/i.test(s);
}
function bandValue_(raw) {
  var s = String(raw == null ? '' : raw).trim();
  if (EMPTY_BAND.test(s) || bandIsRelative_(s)) return null;
  s = s.replace(/[₹$,]/g, ' ');
  /* A hyphen FOLLOWING A LETTER is a separator, not a minus sign. Without
     this, "TGT-20 Days" parses as -20 and every DSO score inverts. */
  s = s.replace(/([A-Za-z])\s*-\s*/g, '$1 ');
  var range = s.match(/(\d+(?:\.\d+)?)\s*[–—]\s*(\d+(?:\.\d+)?)/) ||
              s.match(/(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)/);
  if (range) return (parseFloat(range[1]) + parseFloat(range[2])) / 2;   /* range → midpoint */
  var m = s.match(/-?\d+(?:\.\d+)?/);
  if (!m) return null;
  var n = parseFloat(m[0]);
  return isFinite(n) ? n : null;
}
function parseBands_(raw) {
  var display = [], values = [], defined = 0, relative = 0, i;
  for (i = 0; i < 5; i++) {
    var b = raw[i] == null ? '' : String(raw[i]).trim();
    display.push(b);
    if (!EMPTY_BAND.test(b)) defined++;
    if (b && bandIsRelative_(b)) relative++;
    values.push(bandValue_(b));
  }
  var nums = values.filter(function (v) { return v !== null; });
  /* ORDER MATTERS: an ordinal ladder has no parseable magnitudes, so it must
     be caught BEFORE the "nothing numeric" fallback or it reads as qualitative. */
  if (relative >= 2) {
    return { kind: 'ordinal', direction: 'ordinal', values: [1, 2, 3, 4, 5], display: display,
             defined: defined, note: 'Ordinal ladder — Target 5 is best; level is awarded, not measured.' };
  }
  if (defined <= 1 || nums.length === 0) {
    return { kind: 'qualitative', direction: 'manual', values: values, display: display,
             defined: defined, note: 'No numeric ladder — the level must be awarded manually.' };
  }
  var first = null, last = null;
  for (i = 0; i < 5; i++) if (values[i] !== null) { first = values[i]; break; }
  for (i = 4; i >= 0; i--) if (values[i] !== null) { last = values[i]; break; }
  var direction = last >= first ? 'higher_is_better' : 'lower_is_better';
  var mono = true, prev = null;
  for (i = 0; i < 5; i++) {
    var v = values[i]; if (v === null) continue;
    if (prev !== null) {
      if (direction === 'higher_is_better' && v < prev) mono = false;
      if (direction === 'lower_is_better' && v > prev) mono = false;
    }
    prev = v;
  }
  return { kind: 'numeric', direction: direction, values: values, display: display,
           defined: defined, monotonic: mono,
           note: mono ? '' : 'Ladder is not monotonic — Target 1..5 do not move in one direction.' };
}
/* Highest level cleared, counting consecutively from Target 1. */
function levelFromBands_(parsed, actual) {
  if (parsed.kind !== 'numeric') return null;
  if (actual === null || actual === undefined || actual === '' || isNaN(Number(actual))) return null;
  var a = Number(actual), level = 0;
  for (var i = 0; i < 5; i++) {
    if (parsed.values[i] === null) break;
    var ok = parsed.direction === 'lower_is_better' ? (a <= parsed.values[i]) : (a >= parsed.values[i]);
    if (ok) level = i + 1; else break;
  }
  return level;
}
/* Weightage arrives as fractions on some tabs and percent on others. */
function normaliseWeights_(list) {
  var sum = 0, i;
  for (i = 0; i < list.length; i++) sum += (num_(list[i]) || 0);
  var scale = (sum > 0 && sum <= 1.5) ? 100 : 1, out = [];
  for (i = 0; i < list.length; i++) out.push(Math.round((num_(list[i]) || 0) * scale * 100) / 100);
  return out;
}

var LEVEL_LABELS = { 0: 'Below T1', 1: 'Target 1', 2: 'Target 2', 3: 'Target 3', 4: 'Target 4', 5: 'Target 5' };

/* ==========================================================================
 * SESSION & AUTHORIZATION — enforced here, not merely hidden in the UI.
 * ======================================================================== */
var ROLE_PERMS = {
  super_admin: ['*'],
  hr_admin: ['view', 'edit_target', 'edit_framework', 'enter_actual', 'admin', 'export'],
  business_head: ['view', 'edit_target', 'edit_framework', 'enter_actual', 'export'],
  team_leader: ['view', 'edit_target', 'enter_actual', 'export'],
  manager: ['view', 'enter_actual', 'export'],
  employee: ['view', 'enter_own'],
  auditor: ['view', 'export']
};
function currentEmail_() {
  try { return (Session.getActiveUser().getEmail() || Session.getEffectiveUser().getEmail() || '').toLowerCase(); }
  catch (e) { return ''; }
}
function resolveSession_(viewAs) {
  /* every entry point resolves the session first, so the seed has to be in
     place by now or the role list — and therefore "view as" — comes back empty */
  ensureSeeded_();
  var emps = read_(T.EMPLOYEES), users = read_(T.USERS), email = currentEmail_(), me = null;
  emps.forEach(function (e) { if (email && String(e.email || '').toLowerCase() === email) me = e; });
  var isAdmin = !me;
  var s = { email: email || '(unknown)', name: me ? me.name : (email || 'Administrator'),
            role_id: me ? (me.status === 'lead' ? 'team_leader' : 'employee') : 'super_admin',
            employee_id: me ? me.id : '', admin: isAdmin, can_switch: isAdmin, users: users };
  if (viewAs && isAdmin) {
    var u = users.filter(function (x) { return String(x.id) === String(viewAs); })[0];
    if (u) { s.role_id = u.role_id; s.employee_id = u.employee_id || ''; s.name = u.name; }
  }
  s._byId = idx_(emps);
  return s;
}
function can_(s, action) {
  var p = ROLE_PERMS[s.role_id] || [];
  return p.indexOf('*') >= 0 || p.indexOf(action) >= 0;
}
/* May this session act on this person's data? Admin/HR/head: anyone.
   Team leader / manager: their own team. Employee: only themselves. */
function canScope_(s, empId) {
  if (s.role_id === 'super_admin' || s.role_id === 'hr_admin' || s.role_id === 'business_head') return true;
  if (!s.employee_id || !empId) return false;
  if (String(s.employee_id) === String(empId)) return true;
  var me = s._byId[s.employee_id], them = s._byId[empId];
  if (!me || !them) return false;
  if (s.role_id === 'team_leader' || s.role_id === 'manager') return String(me.team_id) === String(them.team_id);
  return false;
}
function requireScope_(s, empId, what) {
  if (!canScope_(s, empId)) throw new Error('You do not have permission to ' + (what || 'change this') + '.');
}
function requirePerm_(s, action, what) {
  if (!can_(s, action)) throw new Error('Your role cannot ' + (what || action) + '.');
}
function audit_(actor, type, id, action, oldV, newV, reason) {
  try {
    append_(T.AUDIT, { id: uid_('aud'), ts: nowIso_(), actor: actor || 'system', entity_type: type,
      entity_id: String(id), action: action,
      old_value: oldV == null ? '' : JSON.stringify(oldV), new_value: newV == null ? '' : JSON.stringify(newV),
      reason: reason || '' });
  } catch (e) {}
}

/* ==========================================================================
 * MODEL — the whole structure for one period, in one round trip.
 * ======================================================================== */
function buildModel_(periodId) {
  ensureSeeded_();
  var periods = read_(T.PERIODS).sort(function (a, b) { return num_(a.sort) - num_(b.sort); });
  var settings = {};
  read_(T.SETTINGS).forEach(function (r) {
    var v = r.value; try { v = JSON.parse(r.value); } catch (e) {}
    settings[r.key] = v;
  });
  var eff = periodId || settings.current_period || (periods.length ? periods[periods.length - 1].id : '');

  var teams = read_(T.TEAMS), emps = read_(T.EMPLOYEES);
  var kras = read_(T.KRAS), kpis = read_(T.KPIS);
  var assigns = read_(T.ASSIGN).filter(function (a) { return String(a.status || 'Active') !== 'Inactive'; });
  var targets = read_(T.TARGETS).filter(function (t) { return String(t.period_id) === String(eff); });
  var perf = read_(T.PERF).filter(function (p) { return String(p.period_id) === String(eff); });

  var tgtBy = {}, perfBy = {};
  targets.forEach(function (t) { tgtBy[t.employee_id + '|' + t.kpi_id] = t; });
  perf.forEach(function (p) { perfBy[p.employee_id + '|' + p.kpi_id] = p; });

  /* one scorecard row per assignment, with its bands interpreted */
  var rows = [], byEmp = {};
  assigns.forEach(function (a) {
    var key = a.employee_id + '|' + a.kpi_id;
    var t = tgtBy[key], p = perfBy[key], kpi = kpis.filter(function (k) { return k.id === a.kpi_id; })[0] || {};
    var bandsRaw = t ? [t.t1, t.t2, t.t3, t.t4, t.t5] : ['', '', '', '', ''];
    var parsed = parseBands_(bandsRaw);
    var actual = p ? num_(p.actual) : null;
    var manual = p ? num_(p.manual_level) : null;
    var level = parsed.kind === 'numeric' ? levelFromBands_(parsed, actual) : (manual === null ? null : manual);
    var row = {
      employee_id: a.employee_id, kra_id: a.kra_id, kpi_id: a.kpi_id,
      assignment_id: a.id, weightage: num_(a.weightage) || 0,
      kpi: kpi.name || '', goal: kpi.goal || '', source: kpi.source || '', unit: kpi.unit || '',
      bands: parsed.display, kind: parsed.kind, direction: parsed.direction,
      values: parsed.values, band_note: parsed.note || '',
      target_version: t ? (num_(t.version) || 1) : null,
      actual: actual, manual_level: manual, level: level,
      status: p ? (p.status || '') : ''
    };
    rows.push(row);
    (byEmp[a.employee_id] = byEmp[a.employee_id] || []).push(row);
  });

  /* rollups: weightage is per-KPI and sums to 100 per person, so the overall
     level is one weighted mean over that person's KPIs. A KRA level is the
     same mean renormalised within the KRA. Only scored KPIs count, and the
     denominator says how much of the scorecard is actually measured. */
  var overalls = {};
  Object.keys(byEmp).forEach(function (empId) {
    var list = byEmp[empId], acc = 0, wsum = 0, assigned = 0, kraAcc = {};
    list.forEach(function (r) {
      assigned += r.weightage;
      if (r.level === null) return;
      acc += r.level * r.weightage; wsum += r.weightage;
      var k = kraAcc[r.kra_id] || (kraAcc[r.kra_id] = { a: 0, w: 0 });
      k.a += r.level * r.weightage; k.w += r.weightage;
    });
    var kraLevels = {};
    Object.keys(kraAcc).forEach(function (kid) {
      var k = kraAcc[kid];
      kraLevels[kid] = k.w > 0 ? Math.round(k.a / k.w * 100) / 100 : null;
    });
    overalls[empId] = {
      score: wsum > 0 ? Math.round(acc / wsum * 100) / 100 : null,
      level: wsum > 0 ? Math.max(1, Math.min(5, Math.round(acc / wsum))) : null,
      measured_weightage: Math.round(wsum * 100) / 100,
      assigned_weightage: Math.round(assigned * 100) / 100,
      kpi_count: list.length,
      scored_count: list.filter(function (r) { return r.level !== null; }).length,
      kra_levels: kraLevels
    };
  });

  return {
    ok: true, period_id: eff, periods: periods, settings: settings,
    teams: teams, employees: emps, kras: kras, kpis: kpis,
    rows: rows, overalls: overalls,
    audit: read_(T.AUDIT).sort(function (a, b) { return String(b.ts).localeCompare(String(a.ts)); }).slice(0, 40),
    source_sheet_id: SOURCE_SHEET_ID,
    generated_at: nowIso_()
  };
}

/* ------------------------------------------------------------------- API --- */
function apiBootstrap(periodId, viewAs) {
  try {
    var s = resolveSession_(viewAs);
    return jsonSafe_({ ok: true, model: buildModel_(periodId), users: s.users,
      session: { email: s.email, name: s.name, role_id: s.role_id, employee_id: s.employee_id,
                 admin: s.admin, can_switch: s.can_switch } });
  } catch (e) {
    return { ok: false, error: String(e && e.message || e), where: 'apiBootstrap',
             stack: String(e && e.stack || '').split('\n').slice(0, 4).join(' | ') };
  }
}
function apiModel(periodId) {
  try { return jsonSafe_({ ok: true, model: buildModel_(periodId) }); }
  catch (e) { return { ok: false, error: String(e && e.message || e), where: 'apiModel' }; }
}
function apiPing() { return { ok: true, app: APP_NAME, at: nowIso_() }; }

/** Edit the five target bands for one person's KPI. Bands are free text by
 *  design — the workbook holds "> 28 Days" and "≥ ₹9 Cr" — so validation
 *  checks interpretability and ladder direction, not numeric format. */
function apiSaveTargets(p) {
  try {
    p = p || {};
    var s = resolveSession_(p.view_as);
    requirePerm_(s, 'edit_target', 'edit targets');
    requireScope_(s, p.employee_id, 'edit this person’s targets');
    var bands = [p.t1, p.t2, p.t3, p.t4, p.t5].map(function (x) { return x == null ? '' : String(x).trim(); });
    var parsed = parseBands_(bands);
    if (parsed.kind === 'numeric' && !parsed.monotonic) {
      throw new Error('Target 1..5 must move in one direction. As entered they go up and down, so no level could be resolved.');
    }
    var id = 'tgt_' + p.employee_id + '_' + p.kpi_id + '_' + p.period_id;
    var prev = read_(T.TARGETS).filter(function (t) { return String(t.id) === id; })[0];
    var old = prev ? { t1: prev.t1, t2: prev.t2, t3: prev.t3, t4: prev.t4, t5: prev.t5 } : null;
    upsert_(T.TARGETS, { id: id, employee_id: p.employee_id, kpi_id: p.kpi_id, period_id: p.period_id,
      t1: bands[0], t2: bands[1], t3: bands[2], t4: bands[3], t5: bands[4],
      version: prev ? (num_(prev.version) || 1) + 1 : 1, updated_by: s.name, updated_at: nowIso_() });
    /* the level depends on the ladder, so re-resolve it now */
    recomputeOne_(p.employee_id, p.kpi_id, p.period_id, s.name);
    audit_(s.name, 'target', id, 'edit_bands', old,
      { t1: bands[0], t2: bands[1], t3: bands[2], t4: bands[3], t5: bands[4] },
      'kind=' + parsed.kind + ' direction=' + parsed.direction);
    return jsonSafe_({ ok: true, parsed: parsed, model: buildModel_(p.period_id) });
  } catch (e) { return { ok: false, error: String(e && e.message || e), where: 'apiSaveTargets' }; }
}

/** Edit the KRA/KPI definition and weightage carried by one assignment. */
function apiSaveAssignment(p) {
  try {
    p = p || {};
    var s = resolveSession_(p.view_as);
    requirePerm_(s, 'edit_framework', 'edit the KRA/KPI framework');
    requireScope_(s, p.employee_id, 'edit this person’s KRA/KPI');
    var emp = s._byId[p.employee_id]; if (!emp) throw new Error('Unknown employee.');
    var wt = num_(p.weightage);
    if (wt === null || wt < 0 || wt > 100) throw new Error('Weightage must be between 0 and 100.');
    if (!String(p.kra_name || '').trim()) throw new Error('The KRA needs a name.');
    if (!String(p.kpi_name || '').trim()) throw new Error('The KPI needs a name.');

    var kraId = ensureKra_(emp.team_id, p.perspective, p.kra_name);
    var kpiId = ensureKpi_(kraId, p.kpi_name, p.goal, p.source, p.unit);
    var assigns = read_(T.ASSIGN);
    var prev = p.assignment_id ? assigns.filter(function (a) { return String(a.id) === String(p.assignment_id); })[0] : null;
    var id = prev ? prev.id : uid_('asg');
    var old = prev ? { kra: prev.kra_id, kpi: prev.kpi_id, weightage: prev.weightage } : null;
    upsert_(T.ASSIGN, { id: id, employee_id: p.employee_id, kra_id: kraId, kpi_id: kpiId,
      weightage: wt, status: 'Active', updated_by: s.name, updated_at: nowIso_() });
    /* a brand-new assignment starts with an empty ladder the user then fills */
    if (!prev) {
      var tid = 'tgt_' + p.employee_id + '_' + kpiId + '_' + p.period_id;
      if (!read_(T.TARGETS).filter(function (t) { return String(t.id) === tid; }).length) {
        upsert_(T.TARGETS, { id: tid, employee_id: p.employee_id, kpi_id: kpiId, period_id: p.period_id,
          t1: '', t2: '', t3: '', t4: '', t5: '', version: 1, updated_by: s.name, updated_at: nowIso_() });
      }
    }
    audit_(s.name, 'assignment', id, prev ? 'edit' : 'create', old,
      { kra: p.kra_name, kpi: p.kpi_name, weightage: wt });
    return jsonSafe_({ ok: true, model: buildModel_(p.period_id) });
  } catch (e) { return { ok: false, error: String(e && e.message || e), where: 'apiSaveAssignment' }; }
}

/** Remove a KPI from one person's scorecard (the definition stays in the catalogue). */
function apiRemoveAssignment(p) {
  try {
    p = p || {};
    var s = resolveSession_(p.view_as);
    requirePerm_(s, 'edit_framework', 'edit the KRA/KPI framework');
    requireScope_(s, p.employee_id, 'edit this person’s KRA/KPI');
    var a = read_(T.ASSIGN).filter(function (x) { return String(x.id) === String(p.assignment_id); })[0];
    if (!a) throw new Error('That assignment no longer exists.');
    a.status = 'Inactive'; a.updated_by = s.name; a.updated_at = nowIso_();
    upsert_(T.ASSIGN, a);
    audit_(s.name, 'assignment', a.id, 'remove', { kpi: a.kpi_id, weightage: a.weightage }, null, p.reason || '');
    return jsonSafe_({ ok: true, model: buildModel_(p.period_id) });
  } catch (e) { return { ok: false, error: String(e && e.message || e), where: 'apiRemoveAssignment' }; }
}

/** Record an actual (numeric ladders) or award a level (ordinal/qualitative). */
function apiSaveActual(p) {
  try {
    p = p || {};
    var s = resolveSession_(p.view_as);
    var own = String(s.employee_id || '') === String(p.employee_id);
    if (!(can_(s, 'enter_actual') || (own && can_(s, 'enter_own')))) {
      throw new Error('Your role cannot record performance.');
    }
    requireScope_(s, p.employee_id, 'record this performance');
    var per = read_(T.PERIODS).filter(function (x) { return String(x.id) === String(p.period_id); })[0];
    if (per && String(per.status) === 'locked' && s.role_id !== 'super_admin' && s.role_id !== 'hr_admin') {
      throw new Error(per.name + ' is locked.');
    }
    var id = 'prf_' + p.employee_id + '_' + p.kpi_id + '_' + p.period_id;
    var prev = read_(T.PERF).filter(function (x) { return String(x.id) === id; })[0];
    var old = prev ? { actual: prev.actual, manual_level: prev.manual_level, level: prev.level } : null;
    var actual = (p.actual === '' || p.actual == null) ? '' : num_(p.actual);
    if (p.actual !== '' && p.actual != null && actual === null) throw new Error('The actual must be a number.');
    var manual = (p.manual_level === '' || p.manual_level == null) ? '' : num_(p.manual_level);
    if (manual !== '' && (manual < 0 || manual > 5)) throw new Error('An awarded level must be between 0 and 5.');
    upsert_(T.PERF, { id: id, employee_id: p.employee_id, kpi_id: p.kpi_id, period_id: p.period_id,
      actual: actual, manual_level: manual, level: '', kind: '', direction: '',
      note: p.note || (prev ? prev.note : ''), status: 'recorded',
      updated_by: s.name, updated_at: nowIso_() });
    var res = recomputeOne_(p.employee_id, p.kpi_id, p.period_id, s.name);
    audit_(s.name, 'performance', id, 'record', old, { actual: actual, manual_level: manual, level: res.level });
    return jsonSafe_({ ok: true, level: res.level, model: buildModel_(p.period_id) });
  } catch (e) { return { ok: false, error: String(e && e.message || e), where: 'apiSaveActual' }; }
}

/* Resolve and persist one KPI's level from its stored ladder + actual. */
function recomputeOne_(empId, kpiId, periodId, actor) {
  var id = 'prf_' + empId + '_' + kpiId + '_' + periodId;
  var rec = read_(T.PERF).filter(function (x) { return String(x.id) === id; })[0];
  var tgt = read_(T.TARGETS).filter(function (t) {
    return String(t.employee_id) === String(empId) && String(t.kpi_id) === String(kpiId) &&
           String(t.period_id) === String(periodId); })[0];
  if (!rec) return { level: null };
  var parsed = parseBands_(tgt ? [tgt.t1, tgt.t2, tgt.t3, tgt.t4, tgt.t5] : ['', '', '', '', '']);
  var level = parsed.kind === 'numeric'
    ? levelFromBands_(parsed, num_(rec.actual))
    : (num_(rec.manual_level) === null ? null : num_(rec.manual_level));
  rec.level = level === null ? '' : level;
  rec.kind = parsed.kind; rec.direction = parsed.direction;
  rec.updated_by = actor || rec.updated_by; rec.updated_at = nowIso_();
  upsert_(T.PERF, rec);
  return { level: level, parsed: parsed };
}

/* Recompute every stored level for a period (safety net after bulk edits). */
function apiRecomputeAll(p) {
  try {
    p = p || {};
    var s = resolveSession_(p.view_as);
    requirePerm_(s, 'admin', 'recompute the period');
    var n = 0;
    read_(T.PERF).forEach(function (r) {
      if (String(r.period_id) !== String(p.period_id)) return;
      recomputeOne_(r.employee_id, r.kpi_id, r.period_id, s.name); n++;
    });
    audit_(s.name, 'period', p.period_id, 'recompute_all', null, { rows: n });
    return jsonSafe_({ ok: true, rows: n, model: buildModel_(p.period_id) });
  } catch (e) { return { ok: false, error: String(e && e.message || e), where: 'apiRecomputeAll' }; }
}

/* catalogue helpers — dedupe KRA/KPI definitions by name within a team */
/* Deterministic identity: a KRA/KPI id is derived from its natural key
 * (team + name, KRA + name), never from a random suffix. Two consequences
 * that matter: importing the same workbook twice is idempotent instead of
 * duplicating the catalogue, and two rows that share a KPI NAME under
 * DIFFERENT KRAs can never collide onto one id (which silently dropped a
 * person's KPI — and its weightage — before this was made deterministic). */
function hash_(s) {
  var h = 5381;
  for (var i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}
function ensureKra_(teamId, perspective, name) {
  var key = String(teamId) + '|' + slug_(name);
  var id = 'kra_' + slug_(name).slice(0, 24) + '_' + hash_(key).slice(0, 6);
  var rows = read_(T.KRAS);
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i].id) === id) {
      if (perspective && rows[i].perspective !== perspective) {
        rows[i].perspective = perspective; upsert_(T.KRAS, rows[i]);
      }
      return id;
    }
  }
  upsert_(T.KRAS, { id: id, team_id: teamId, perspective: perspective || '', name: name, status: 'Active' });
  return id;
}
function ensureKpi_(kraId, name, goal, source, unit) {
  var key = String(kraId) + '|' + slug_(name);
  var id = 'kpi_' + slug_(name).slice(0, 24) + '_' + hash_(key).slice(0, 6);
  var rows = read_(T.KPIS);
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i].id) === id) {
      var r = rows[i], dirty = false;
      if (goal && r.goal !== goal) { r.goal = goal; dirty = true; }
      if (source && r.source !== source) { r.source = source; dirty = true; }
      if (unit && r.unit !== unit) { r.unit = unit; dirty = true; }
      if (dirty) upsert_(T.KPIS, r);
      return id;
    }
  }
  upsert_(T.KPIS, { id: id, kra_id: kraId, name: name, goal: goal || '', source: source || '',
                    unit: unit || '', status: 'Active' });
  return id;
}

/* ==========================================================================
 * IMPORT — read the definitions straight out of the KRA/KPI workbook.
 *
 * Deliberately tolerant, because the workbook is hand-maintained: tabs get
 * renamed, the two block families order their columns differently, and a
 * person's header sometimes carries a Region or a second role. So blocks are
 * FOUND by shape ("a title row followed by a row starting 'Perspective'")
 * and columns are mapped BY HEADER NAME, never by position.
 * ======================================================================== */
function apiImportFromSource(p) {
  try {
    p = p || {};
    var s = resolveSession_(p.view_as);
    requirePerm_(s, 'edit_framework', 'import the framework');
    var res = importFromSource_(p.sheet_id || SOURCE_SHEET_ID, p.period_id, s.name, !!p.replace);
    audit_(s.name, 'system', 'import', 'import_source', null, res);
    return jsonSafe_({ ok: true, result: res, model: buildModel_(p.period_id) });
  } catch (e) { return { ok: false, error: String(e && e.message || e), where: 'apiImportFromSource' }; }
}

function importFromSource_(sheetId, periodId, actor, replace) {
  var src;
  try { src = SpreadsheetApp.openById(sheetId); }
  catch (e) {
    throw new Error('Cannot open the source workbook ' + sheetId +
      '. Share it with the account running this script, then try again. (' + (e && e.message || e) + ')');
  }
  var blocks = [];
  src.getSheets().forEach(function (sh) {
    var name = sh.getName();
    if (name.indexOf('_KKT_') === 0) return;                    /* managed tabs, not definitions */
    var last = sh.getLastRow(), lastC = Math.max(sh.getLastColumn(), 12);
    if (last < 2) return;
    var grid = sh.getRange(1, 1, last, lastC).getValues();
    blocks = blocks.concat(blocksFromGrid_(grid, name));
  });
  var people = blocks.filter(function (b) { return b.isPerson; });
  if (!people.length) throw new Error('No individual KRA/KPI blocks were found in that workbook.');

  if (replace) { write_(T.ASSIGN, []); write_(T.TARGETS, []); }

  var teamsSeen = {}, created = { teams: 0, people: 0, kras: 0, kpis: 0, assignments: 0, targets: 0 };
  var existingEmps = read_(T.EMPLOYEES), empByName = {};
  existingEmps.forEach(function (e) { empByName[slug_(e.name)] = e; });

  people.forEach(function (b) {
    var teamName = teamNameFor_(b.sheet);
    var teamId = 'team_' + slug_(teamName);
    if (!teamsSeen[teamId]) {
      teamsSeen[teamId] = true;
      if (!read_(T.TEAMS).filter(function (t) { return t.id === teamId; }).length) {
        upsert_(T.TEAMS, { id: teamId, name: teamName, code: slug_(teamName).toUpperCase().slice(0, 6),
                           lead_id: '', note: '', status: 'Active' });
        created.teams++;
      }
    }
    var emp = empByName[slug_(b.name)];
    var empId = emp ? emp.id : ('EMP-' + slug_(b.name).toUpperCase().replace(/-/g, '').slice(0, 12));
    if (!emp) {
      upsert_(T.EMPLOYEES, { id: empId, name: b.name, designation: b.designation, team_id: teamId,
        sub_group: subGroupFor_(b.sheet), region: b.extra, manager_id: '', status: 'Active', email: '' });
      empByName[slug_(b.name)] = { id: empId, name: b.name };
      created.people++;
    }
    var weights = normaliseWeights_(b.rows.map(function (r) { return r.weightage; }));
    b.rows.forEach(function (r, i) {
      var kraId = ensureKra_(teamId, r.perspective, r.kra || 'General');
      var kpiId = ensureKpi_(kraId, r.kpi || r.kra, r.goal, r.source, r.unit);
      upsert_(T.ASSIGN, { id: 'asg_' + empId + '_' + kpiId, employee_id: empId, kra_id: kraId, kpi_id: kpiId,
        weightage: weights[i], status: 'Active', updated_by: actor, updated_at: nowIso_() });
      created.assignments++;
      upsert_(T.TARGETS, { id: 'tgt_' + empId + '_' + kpiId + '_' + periodId, employee_id: empId,
        kpi_id: kpiId, period_id: periodId,
        t1: r.targets[0], t2: r.targets[1], t3: r.targets[2], t4: r.targets[3], t5: r.targets[4],
        version: 1, updated_by: actor, updated_at: nowIso_() });
      created.targets++;
    });
  });
  assignLeads_();
  created.kras = read_(T.KRAS).length; created.kpis = read_(T.KPIS).length;
  return created;
}

/* Find "title row + Perspective header row + data rows" blocks in a grid. */
function blocksFromGrid_(grid, sheetName) {
  function cell(r, c) { var row = grid[r]; return row && row[c] != null ? String(row[c]).replace(/\s+/g, ' ').trim() : ''; }
  function isHeader(r) { return cell(r, 0) === 'Perspective'; }
  var out = [], r = 0;
  while (r < grid.length) {
    if (cell(r, 0) !== '' && !isHeader(r) && isHeader(r + 1)) {
      var title = cell(r, 0), extra = cell(r, 1), hdr = r + 1, map = {};
      for (var c = 0; c < (grid[hdr] || []).length; c++) {
        var h = cell(hdr, c); if (h) map[h] = c;
      }
      function pick() {
        for (var i = 0; i < arguments.length; i++) if (map[arguments[i]] !== undefined) return map[arguments[i]];
        return -1;
      }
      var cP = pick('Perspective'), cK = pick('KRA'),
          cI = pick('KPI', 'KPI / Definition', 'KPI/Definition'),
          cG = pick('Goal Description', 'Goal'), cW = pick('Weightage (%)', 'Weightage'),
          cS = pick('Source of Tracking', 'Source'), cU = pick('Unit of Measurement', 'Unit');
      var tc = [pick('Target 1'), pick('Target 2'), pick('Target 3'), pick('Target 4'), pick('Target 5')];

      var rows = [], rr = hdr + 1;
      while (rr < grid.length) {
        if (cell(rr, 0) === '') break;
        if (isHeader(rr)) break;
        if (isHeader(rr + 1)) break;                     /* next block's title */
        var kra = cK >= 0 ? cell(rr, cK) : '', kpi = cI >= 0 ? cell(rr, cI) : '';
        if (kra || kpi) {
          rows.push({
            perspective: cP >= 0 ? cell(rr, cP) : '', kra: kra, kpi: kpi,
            goal: cG >= 0 ? cell(rr, cG) : '', weightage: cW >= 0 ? cell(rr, cW) : '',
            source: cS >= 0 ? cell(rr, cS) : '', unit: cU >= 0 ? cell(rr, cU) : '',
            targets: tc.map(function (i) { return i >= 0 ? cell(rr, i) : ''; })
          });
        }
        rr++;
      }
      /* People are entered in CAPS ("AMIT JHA (Team Lead)"); section titles are
         Title Case ("Business Development – (Purchase & Sales)"). */
      var namePart = title, op = title.indexOf('(');
      if (op > 0) namePart = title.slice(0, op);
      var letters = namePart.replace(/[^A-Za-z]/g, '');
      var isPerson = letters.length >= 2 && letters === letters.toUpperCase();
      var name = namePart.trim(), desig = '';
      var cp = title.lastIndexOf(')');
      if (op > 0 && cp > op) desig = title.slice(op + 1, cp).trim();
      if (rows.length) {
        out.push({ sheet: sheetName, title: title, extra: extra, isPerson: isPerson,
                   name: name, designation: desig, rows: rows });
      }
      r = rr; continue;
    }
    r++;
  }
  return out;
}
function teamNameFor_(sheet) {
  var s = String(sheet);
  if (/metal/i.test(s)) return 'Metal';
  if (/plastic/i.test(s)) return 'Plastic';
  if (/onboarding/i.test(s)) return 'Onboarding';
  if (/collection/i.test(s)) return 'Collections';
  if (/control\s*tower|marketplace/i.test(s)) return 'Open Marketplace - Control Tower';
  return s.replace(/\s*\((Individual|.*KRAKPI.*)\)\s*$/i, '').trim() || s;
}
function subGroupFor_(sheet) {
  if (/supply/i.test(sheet)) return 'Supply';
  if (/demand/i.test(sheet)) return 'Demand';
  return '';
}
/* The most senior designation in a team becomes its lead. */
function assignLeads_() {
  var RANK = [[/general\s*manager/i, 5], [/team\s*lead/i, 4], [/\bmanager\b/i, 3], [/senior\s*manager/i, 3]];
  var emps = read_(T.EMPLOYEES), teams = read_(T.TEAMS), best = {};
  emps.forEach(function (e) {
    var d = String(e.designation || ''), score = 0;
    if (/assistant/i.test(d)) return;
    RANK.forEach(function (r) { if (r[0].test(d)) score = Math.max(score, r[1]); });
    if (!score) return;
    if (!best[e.team_id] || score > best[e.team_id].score) best[e.team_id] = { id: e.id, score: score };
  });
  teams.forEach(function (t) {
    var b = best[t.id];
    if (b && String(t.lead_id) !== String(b.id)) { t.lead_id = b.id; upsert_(T.TEAMS, t); }
  });
  /* everyone reports to their team lead unless they are the lead */
  var leadOf = {}; read_(T.TEAMS).forEach(function (t) { leadOf[t.id] = t.lead_id; });
  var updates = [];
  emps.forEach(function (e) {
    var want = (leadOf[e.team_id] && String(leadOf[e.team_id]) !== String(e.id)) ? leadOf[e.team_id] : '';
    var isLead = leadOf[e.team_id] && String(leadOf[e.team_id]) === String(e.id);
    if (String(e.manager_id || '') !== String(want) || (isLead && e.status !== 'lead')) {
      e.manager_id = want; if (isLead) e.status = 'lead';
      updates.push(e);
    }
  });
  if (updates.length) bulkUpdate_(T.EMPLOYEES, updates);
}

/* ==========================================================================
 * SEED — the structure as exported from the workbook on 2026-08-20, so the
 * platform is usable before anyone runs an import. apiImportFromSource()
 * refreshes it from the live workbook.
 * ======================================================================== */
function ensureSeeded_() {
  var props = PropertiesService.getScriptProperties();
  if (props.getProperty('PERFORMOS_SEEDED') === '3') return false;
  seedFromEmbedded_();
  return true;
}
function provisionAndSeed() {
  PropertiesService.getScriptProperties().deleteProperty('PERFORMOS_SEEDED');
  seedFromEmbedded_();
  return 'Seeded. Backend: ' + ss_().getUrl();
}
function seedFromEmbedded_() {
  var CURRENT = 'per_2026-08';
  var months = [['2026-04', 'April 2026'], ['2026-05', 'May 2026'], ['2026-06', 'June 2026'],
    ['2026-07', 'July 2026'], ['2026-08', 'August 2026'], ['2026-09', 'September 2026']];
  write_(T.PERIODS, months.map(function (m, i) {
    return { id: 'per_' + m[0], name: m[1], kind: 'month', sort: i,
             status: i < 4 ? 'locked' : (i === 4 ? 'open' : 'upcoming') };
  }));
  write_(T.SETTINGS, [
    { key: 'current_period', value: CURRENT },
    { key: 'source_sheet_id', value: SOURCE_SHEET_ID },
    { key: 'rollup', value: JSON.stringify({
        description: 'Weightage is per KPI and totals 100% per person, so the overall level is one weighted mean over that person’s scored KPIs. A KRA level is the same mean renormalised within the KRA.' }) }
  ]);
  write_(T.TEAMS, []); write_(T.EMPLOYEES, []); write_(T.KRAS, []); write_(T.KPIS, []);
  write_(T.ASSIGN, []); write_(T.TARGETS, []); write_(T.PERF, []); write_(T.AUDIT, []);

  var teamsSeen = {};
  SRC_SEED.people.forEach(function (b) {
    var teamId = 'team_' + slug_(b.team);
    if (!teamsSeen[teamId]) {
      teamsSeen[teamId] = true;
      upsert_(T.TEAMS, { id: teamId, name: b.team, code: slug_(b.team).toUpperCase().slice(0, 6),
                         lead_id: '', note: '', status: 'Active' });
    }
    var empId = 'EMP-' + slug_(b.name).toUpperCase().replace(/-/g, '').slice(0, 12);
    upsert_(T.EMPLOYEES, { id: empId, name: b.name, designation: b.designation, team_id: teamId,
      sub_group: b.group || '', region: b.extra || '', manager_id: '', status: 'Active', email: '' });
    var weights = normaliseWeights_(b.kpis.map(function (r) { return r[4]; }));
    b.kpis.forEach(function (r, i) {
      var kraId = ensureKra_(teamId, r[0], r[1] || 'General');
      var kpiId = ensureKpi_(kraId, r[2] || r[1], r[3], r[5], '');
      upsert_(T.ASSIGN, { id: 'asg_' + empId + '_' + kpiId, employee_id: empId, kra_id: kraId,
        kpi_id: kpiId, weightage: weights[i], status: 'Active', updated_by: 'seed', updated_at: nowIso_() });
      upsert_(T.TARGETS, { id: 'tgt_' + empId + '_' + kpiId + '_' + CURRENT, employee_id: empId,
        kpi_id: kpiId, period_id: CURRENT,
        t1: r[6], t2: r[7], t3: r[8], t4: r[9], t5: r[10],
        version: 1, updated_by: 'seed', updated_at: nowIso_() });
    });
  });
  assignLeads_();

  var emps = read_(T.EMPLOYEES);
  function find(re) { var m = emps.filter(function (e) { return re.test(e.name); })[0]; return m ? m.id : ''; }
  write_(T.USERS, [
    { id: 'u_admin', name: 'Platform Admin', email: '', role_id: 'super_admin', employee_id: '' },
    { id: 'u_hr', name: 'HR / Admin', email: '', role_id: 'hr_admin', employee_id: '' },
    { id: 'u_lead_col', name: 'Ravi Naik (Collections lead)', email: '', role_id: 'team_leader', employee_id: find(/^RAVI NAIK$/i) },
    { id: 'u_lead_met', name: 'Amit Jha (Metal lead)', email: '', role_id: 'team_leader', employee_id: find(/^AMIT JHA$/i) },
    { id: 'u_emp', name: 'Vishwash (Onboarding)', email: '', role_id: 'employee', employee_id: find(/^VISHWASH$/i) },
    { id: 'u_audit', name: 'Auditor', email: '', role_id: 'auditor', employee_id: '' }
  ]);
  PropertiesService.getScriptProperties().setProperty('PERFORMOS_SEEDED', '3');
  return true;
}

/* ==========================================================================
 * SELF TEST — proves the structure and the band engine from the editor.
 * ======================================================================== */
function selfTest() {
  var out = [], pass = 0, fail = 0;
  function ck(label, got, want) {
    var ok = String(got) === String(want);
    if (ok) pass++; else fail++;
    out.push((ok ? 'PASS  ' : 'FAIL  ') + label + ': ' + got + (ok ? '' : '  (want ' + want + ')'));
  }
  ensureSeeded_();
  var m = buildModel_(null);
  ck('teams', m.teams.length, 5);
  ck('people', m.employees.length, 38);
  ck('assignment rows', m.rows.length, 208);
  out.push('INFO  KRAs=' + m.kras.length + '  KPIs=' + m.kpis.length + '  period=' + m.period_id);

  /* every person's weightage must total 100 after normalisation */
  var bad = [];
  Object.keys(m.overalls).forEach(function (id) {
    var w = m.overalls[id].assigned_weightage;
    if (Math.abs(w - 100) > 0.5) bad.push(id + '=' + w);
  });
  ck('weightage totals 100 for all 38', bad.length ? bad.join(',') : 0, 0);

  /* band engine — the 16 real ladder shapes reduce to these behaviours */
  ck('ratio ladder direction', parseBands_(['0.6','0.75','0.9','1.0','1.05']).direction, 'higher_is_better');
  ck('DSO days direction', parseBands_(['15','10','5','3','2']).direction, 'lower_is_better');
  ck('TGT-20 parses as 20 not -20', parseBands_(['> 28 Days','25–28 Days','21–24 Days','TGT-20 Days','≤ 19 Days']).values[3], 20);
  ck('range 25-28 midpoint', parseBands_(['> 28 Days','25–28 Days','21–24 Days','TGT-20 Days','≤ 19 Days']).values[1], 26.5);
  ck('currency ≥ ₹9 Cr', parseBands_(['≥ ₹9 Cr','₹8 Cr','₹7 Cr','₹6 Cr','< ₹5 Cr']).values[0], 9);
  ck('percent-of-LD', parseBands_(['10% of LD','15% of LD','20% of LD','25% of LD','30% of LD']).values[4], 30);
  ck('ordinal ladder kind', parseBands_(['More than (T+7 days)','T+7 days','On Time (Defined TAT)','T-1 day','T - 2 days']).kind, 'ordinal');
  ck('qualitative kind', parseBands_(['As per Collections Process','—','—','—','—']).kind, 'qualitative');

  var dso = parseBands_(['> 28 Days','25–28 Days','21–24 Days','TGT-20 Days','≤ 19 Days']);
  ck('DSO 19 → T5', levelFromBands_(dso, 19), 5);
  ck('DSO 22 → T3', levelFromBands_(dso, 22), 3);
  ck('DSO 30 → below T1', levelFromBands_(dso, 30), 0);
  var ratio = parseBands_(['0.6','0.75','0.9','1.0','1.05']);
  ck('ratio 0.92 → T3', levelFromBands_(ratio, 0.92), 3);
  ck('ratio 1.06 → T5', levelFromBands_(ratio, 1.06), 5);
  ck('ratio 0.55 → below T1', levelFromBands_(ratio, 0.55), 0);
  ck('ordinal is not auto-scored', String(levelFromBands_(parseBands_(['More than (T+7 days)','T+7 days','On Time (Defined TAT)','T-1 day','T - 2 days']), 3)), 'null');

  ck('weights normalise (fractions)', normaliseWeights_([0.35,0.1,0.1,0.2,0.15,0.1]).reduce(function(a,b){return a+b;},0), 100);
  ck('weights normalise (percent)', normaliseWeights_([5,15,15,5,40,10,10]).reduce(function(a,b){return a+b;},0), 100);

  out.push('');
  out.push(pass + ' passed, ' + fail + ' failed');
  var txt = out.join('\n');
  Logger.log(txt);
  return txt;
}
/* Generated from the KRA/KPI workbook — do not hand-edit. */
var SRC_SEED = {"source_sheet_id":"1c0_pP4Mmye5s5D_vzoxrvJ-utkLb6JhD69TvvOBbjoo","exported":"2026-08-20","people":[{"team":"Metal","group":"","sheet":"Metal (Supply \u0026 Demand KRAKPI)","name":"AMIT JHA","designation":"Team Lead - Business Development","extra":"","kpis":[["Process","Retention of Existing Transacted Sellers","Repeat Seller Transaction Rate (%)","Achieve repeat transactions from at least 50% of sellers who transacted in the previous month.","5.0","Monthly MIS Report","0.6","0.75","0.9","1.0","1.05"],["Customer","New Buyer Acquisition","Monthly Target Achievement (%)","Achieve the defined monthly target for the KPI.","15.0","Monthly MIS Report","0.6","0.75","0.9","1.0","1.05"],["Customer","New Seller Acquisition","Monthly Target Achievement (%)","Achieve the defined monthly target for the KPI.","15.0","Monthly MIS Report","0.6","0.75","0.9","1.0","1.05"],["Process","Transaction from New Onboarded Buyers","New Buyer Same-Month Transaction Rate (%)","Ensure at least 20% of buyers onboarded during the month complete a transaction within the same month.","5.0","Monthly MIS Report","0.6","0.75","0.9","1.0","1.05"],["Sales","GMV","Monthly Target Achievement (%)","Achieve the defined monthly target for the KPI.","40.0","Monthly MIS Report","0.6","0.75","0.9","1.0","1.05"],["Sales","Transaction Closure","Successfully Closed Transactions (Count)","Successfully close the targeted number of transactions through completion of POD, DNCN, and payment upload requirements.","10.0","Monthly MIS Report","0.6","0.75","0.9","1.0","1.05"],["Process","DSO Days","Days Sales Outstanding (DSO)","Maintain DSO within the defined monthly target, calculated as (Average Receivables ÷ GMV) × Number of Days in the Month.","10.0","Monthly MIS Report","15.0","10.0","5.0","3.0","2.0"]]},{"team":"Metal","group":"","sheet":"Metal (Supply \u0026 Demand KRAKPI)","name":"ABHISEK SANYAL","designation":"Assistant Manager - Business Development","extra":"","kpis":[["Process","Retention of Existing Transacted Sellers","Repeat Seller Transaction Rate (%)","Achieve repeat transactions from at least 50% of sellers who transacted in the previous month.","5.0","Monthly MIS Report","0.6","0.75","0.9","1.0","1.05"],["Customer","New Buyer Acquisition","Monthly Target Achievement (%)","Achieve the defined monthly target for the KPI.","15.0","Monthly MIS Report","0.6","0.75","0.9","1.0","1.05"],["Customer","New Seller Acquisition","Monthly Target Achievement (%)","Achieve the defined monthly target for the KPI.","15.0","Monthly MIS Report","0.6","0.75","0.9","1.0","1.05"],["Process","Transaction from New Onboarded Buyers","New Buyer Same-Month Transaction Rate (%)","Ensure at least 20% of buyers onboarded during the month complete a transaction within the same month.","5.0","Monthly MIS Report","0.6","0.75","0.9","1.0","1.05"],["Sales","GMV","Monthly Target Achievement (%)","Achieve the defined monthly target for the KPI.","40.0","Monthly MIS Report","0.6","0.75","0.9","1.0","1.05"],["Sales","Transaction Closure","Successfully Closed Transactions (Count)","Successfully close the targeted number of transactions through completion of POD, DNCN, and payment upload requirements.","10.0","Monthly MIS Report","0.6","0.75","0.9","1.0","1.05"],["Process","DSO Days","Days Sales Outstanding (DSO)","Maintain DSO within the defined monthly target, calculated as (Average Receivables ÷ GMV) × Number of Days in the Month.","10.0","Monthly MIS Report","15.0","10.0","5.0","3.0","2.0"]]},{"team":"Metal","group":"","sheet":"Metal (Supply \u0026 Demand KRAKPI)","name":"ADARSH KRISHNA","designation":"Assistant Manager - Business Development","extra":"","kpis":[["Process","Retention of Existing Transacted Sellers","Repeat Seller Transaction Rate (%)","Achieve repeat transactions from at least 50% of sellers who transacted in the previous month.","5.0","Monthly MIS Report","0.6","0.75","0.9","1.0","1.05"],["Customer","New Buyer Acquisition","Monthly Target Achievement (%)","Achieve the defined monthly target for the KPI.","15.0","Monthly MIS Report","0.6","0.75","0.9","1.0","1.05"],["Customer","New Seller Acquisition","Monthly Target Achievement (%)","Achieve the defined monthly target for the KPI.","15.0","Monthly MIS Report","0.6","0.75","0.9","1.0","1.05"],["Process","Transaction from New Onboarded Buyers","New Buyer Same-Month Transaction Rate (%)","Ensure at least 20% of buyers onboarded during the month complete a transaction within the same month.","5.0","Monthly MIS Report","0.6","0.75","0.9","1.0","1.05"],["Sales","GMV","Monthly Target Achievement (%)","Achieve the defined monthly target for the KPI.","40.0","Monthly MIS Report","0.6","0.75","0.9","1.0","1.05"],["Sales","Transaction Closure","Successfully Closed Transactions (Count)","Successfully close the targeted number of transactions through completion of POD, DNCN, and payment upload requirements.","10.0","Monthly MIS Report","0.6","0.75","0.9","1.0","1.05"],["Process","DSO Days","Days Sales Outstanding (DSO)","Maintain DSO within the defined monthly target, calculated as (Average Receivables ÷ GMV) × Number of Days in the Month.","10.0","Monthly MIS Report","15.0","10.0","5.0","3.0","2.0"]]},{"team":"Metal","group":"","sheet":"Metal (Supply \u0026 Demand KRAKPI)","name":"ARIJIT DUTTA","designation":"Senior Executive - Business Development","extra":"","kpis":[["Process","Retention of Existing Transacted Sellers","Repeat Seller Transaction Rate (%)","Achieve repeat transactions from at least 50% of sellers who transacted in the previous month.","5.0","Monthly MIS Report","0.6","0.75","0.9","1.0","1.05"],["Customer","New Buyer Acquisition","Monthly Target Achievement (%)","Achieve the defined monthly target for the KPI.","15.0","Monthly MIS Report","0.6","0.75","0.9","1.0","1.05"],["Customer","New Seller Acquisition","Monthly Target Achievement (%)","Achieve the defined monthly target for the KPI.","15.0","Monthly MIS Report","0.6","0.75","0.9","1.0","1.05"],["Process","Transaction from New Onboarded Buyers","New Buyer Same-Month Transaction Rate (%)","Ensure at least 20% of buyers onboarded during the month complete a transaction within the same month.","5.0","Monthly MIS Report","0.6","0.75","0.9","1.0","1.05"],["Sales","GMV","Monthly Target Achievement (%)","Achieve the defined monthly target for the KPI.","40.0","Monthly MIS Report","0.6","0.75","0.9","1.0","1.05"],["Sales","Transaction Closure","Successfully Closed Transactions (Count)","Successfully close the targeted number of transactions through completion of POD, DNCN, and payment upload requirements.","10.0","Monthly MIS Report","0.6","0.75","0.9","1.0","1.05"],["Process","DSO Days","Days Sales Outstanding (DSO)","Maintain DSO within the defined monthly target, calculated as (Average Receivables ÷ GMV) × Number of Days in the Month.","10.0","Monthly MIS Report","15.0","10.0","5.0","3.0","2.0"]]},{"team":"Metal","group":"","sheet":"Metal (Supply \u0026 Demand KRAKPI)","name":"ARGHYADEEP SAMANTA","designation":"Senior Executive - Business Development","extra":"","kpis":[["Process","Retention of Existing Transacted Sellers","Repeat Seller Transaction Rate (%)","Achieve repeat transactions from at least 50% of sellers who transacted in the previous month.","5.0","Monthly MIS Report","0.6","0.75","0.9","1.0","1.05"],["Customer","New Buyer Acquisition","Monthly Target Achievement (%)","Achieve the defined monthly target for the KPI.","15.0","Monthly MIS Report","0.6","0.75","0.9","1.0","1.05"],["Customer","New Seller Acquisition","Monthly Target Achievement (%)","Achieve the defined monthly target for the KPI.","15.0","Monthly MIS Report","0.6","0.75","0.9","1.0","1.05"],["Process","Transaction from New Onboarded Buyers","New Buyer Same-Month Transaction Rate (%)","Ensure at least 20% of buyers onboarded during the month complete a transaction within the same month.","5.0","Monthly MIS Report","0.6","0.75","0.9","1.0","1.05"],["Sales","GMV","Monthly Target Achievement (%)","Achieve the defined monthly target for the KPI.","40.0","Monthly MIS Report","0.6","0.75","0.9","1.0","1.05"],["Sales","Transaction Closure","Successfully Closed Transactions (Count)","Successfully close the targeted number of transactions through completion of POD, DNCN, and payment upload requirements.","10.0","Monthly MIS Report","0.6","0.75","0.9","1.0","1.05"],["Process","DSO Days","Days Sales Outstanding (DSO)","Maintain DSO within the defined monthly target, calculated as (Average Receivables ÷ GMV) × Number of Days in the Month.","10.0","Monthly MIS Report","15.0","10.0","5.0","3.0","2.0"]]},{"team":"Metal","group":"","sheet":"Metal (Supply \u0026 Demand KRAKPI)","name":"AYUSH GOYAL","designation":"Assistant Manager - Business Development","extra":"","kpis":[["Process","Retention of Existing Transacted Sellers","Repeat Seller Transaction Rate (%)","Achieve repeat transactions from at least 50% of sellers who transacted in the previous month.","5.0","Monthly MIS Report","0.6","0.75","0.9","1.0","1.05"],["Customer","New Buyer Acquisition","Monthly Target Achievement (%)","Achieve the defined monthly target for the KPI.","15.0","Monthly MIS Report","0.6","0.75","0.9","1.0","1.05"],["Customer","New Seller Acquisition","Monthly Target Achievement (%)","Achieve the defined monthly target for the KPI.","15.0","Monthly MIS Report","0.6","0.75","0.9","1.0","1.05"],["Process","Transaction from New Onboarded Buyers","New Buyer Same-Month Transaction Rate (%)","Ensure at least 20% of buyers onboarded during the month complete a transaction within the same month.","5.0","Monthly MIS Report","0.6","0.75","0.9","1.0","1.05"],["Sales","GMV","Monthly Target Achievement (%)","Achieve the defined monthly target for the KPI.","40.0","Monthly MIS Report","0.6","0.75","0.9","1.0","1.05"],["Sales","Transaction Closure","Successfully Closed Transactions (Count)","Successfully close the targeted number of transactions through completion of POD, DNCN, and payment upload requirements.","10.0","Monthly MIS Report","0.6","0.75","0.9","1.0","1.05"],["Process","DSO Days","Days Sales Outstanding (DSO)","Maintain DSO within the defined monthly target, calculated as (Average Receivables ÷ GMV) × Number of Days in the Month.","10.0","Monthly MIS Report","15.0","10.0","5.0","3.0","2.0"]]},{"team":"Plastic","group":"Supply","sheet":"Plastic (Supply KRAKPI)","name":"ASHISH KUMAR RAI","designation":"Senior Executive - Business Development","extra":"","kpis":[["Sales","Transaction from Existing Sellers","Seller Monthly Transaction Rate (%)","Ensure at least 50% of total onboarded sellers transact during the current month.","15.0","Monthly MIS Report","0.6","0.75","0.9","1.0","1.05"],["Sales","Transaction from New Onboarded Sellers","New Seller Same-Month Transaction Rate (%)","Ensure at least 20% of sellers onboarded during the current month complete a transaction within the same month.","15.0","Monthly MIS Report","0.6","0.75","0.9","1.0","1.05"],["Sales","New Seller Acquisition","Monthly Target Achievement (%)","Achieve the defined monthly target for the respective KPI within the evaluation period.","15.0","Monthly MIS Report","0.6","0.75","0.9","1.0","1.05"],["Sales","GMV","Monthly Target Achievement (%)","Achieve the defined monthly target for the respective KPI within the evaluation period.","40.0","Monthly MIS Report","0.6","0.75","0.9","1.0","1.05"],["Sales","Retention of Existing Transacted Sellers","Repeat Seller Transaction Rate (%)","Ensure at least 70% of sellers who transacted in the previous month transact again during the current month.","15.0","Monthly MIS Report","0.6","0.75","0.9","1.0","1.05"]]},{"team":"Plastic","group":"Supply","sheet":"Plastic (Supply KRAKPI)","name":"RAJU B","designation":"Senior Executive - Business Development","extra":"","kpis":[["Sales","Transaction from Existing Sellers","Seller Monthly Transaction Rate (%)","Ensure at least 50% of total onboarded sellers transact during the current month.","15.0","Monthly MIS Report","0.6","0.75","0.9","1.0","1.05"],["Sales","Transaction from New Onboarded Sellers","New Seller Same-Month Transaction Rate (%)","Ensure at least 20% of sellers onboarded during the current month complete a transaction within the same month.","15.0","Monthly MIS Report","0.6","0.75","0.9","1.0","1.05"],["Sales","New Seller Acquisition","Monthly Target Achievement (%)","Achieve the defined monthly target for the respective KPI within the evaluation period.","15.0","Monthly MIS Report","0.6","0.75","0.9","1.0","1.05"],["Sales","GMV","Monthly Target Achievement (%)","Achieve the defined monthly target for the respective KPI within the evaluation period.","40.0","Monthly MIS Report","0.6","0.75","0.9","1.0","1.05"],["Sales","Retention of Existing Transacted Sellers","Repeat Seller Transaction Rate (%)","Ensure at least 70% of sellers who transacted in the previous month transact again during the current month.","15.0","Monthly MIS Report","0.6","0.75","0.9","1.0","1.05"]]},{"team":"Plastic","group":"Supply","sheet":"Plastic (Supply KRAKPI)","name":"BRAJENDRA UPADHYAY","designation":"Assistant Manager - Business Development","extra":"","kpis":[["Sales","Transaction from Existing Sellers","Seller Monthly Transaction Rate (%)","Ensure at least 50% of total onboarded sellers transact during the current month.","15.0","Monthly MIS Report","0.6","0.75","0.9","1.0","1.05"],["Sales","Transaction from New Onboarded Sellers","New Seller Same-Month Transaction Rate (%)","Ensure at least 20% of sellers onboarded during the current month complete a transaction within the same month.","15.0","Monthly MIS Report","0.6","0.75","0.9","1.0","1.05"],["Sales","New Seller Acquisition","Monthly Target Achievement (%)","Achieve the defined monthly target for the respective KPI within the evaluation period.","15.0","Monthly MIS Report","0.6","0.75","0.9","1.0","1.05"],["Sales","GMV","Monthly Target Achievement (%)","Achieve the defined monthly target for the respective KPI within the evaluation period.","40.0","Monthly MIS Report","0.6","0.75","0.9","1.0","1.05"],["Sales","Retention of Existing Transacted Sellers","Repeat Seller Transaction Rate (%)","Ensure at least 70% of sellers who transacted in the previous month transact again during the current month.","15.0","Monthly MIS Report","0.6","0.75","0.9","1.0","1.05"]]},{"team":"Plastic","group":"Supply","sheet":"Plastic (Supply KRAKPI)","name":"ATHARVA SUDHIR PATIL","designation":"Senior Executive - Business Development","extra":"","kpis":[["Sales","Transaction from Existing Sellers","Seller Monthly Transaction Rate (%)","Ensure at least 50% of total onboarded sellers transact during the current month.","15.0","Monthly MIS Report","0.6","0.75","0.9","1.0","1.05"],["Sales","Transaction from New Onboarded Sellers","New Seller Same-Month Transaction Rate (%)","Ensure at least 20% of sellers onboarded during the current month complete a transaction within the same month.","15.0","Monthly MIS Report","0.6","0.75","0.9","1.0","1.05"],["Sales","New Seller Acquisition","Monthly Target Achievement (%)","Achieve the defined monthly target for the respective KPI within the evaluation period.","15.0","Monthly MIS Report","0.6","0.75","0.9","1.0","1.05"],["Sales","GMV","Monthly Target Achievement (%)","Achieve the defined monthly target for the respective KPI within the evaluation period.","40.0","Monthly MIS Report","0.6","0.75","0.9","1.0","1.05"],["Sales","Retention of Existing Transacted Sellers","Repeat Seller Transaction Rate (%)","Ensure at least 70% of sellers who transacted in the previous month transact again during the current month.","15.0","Monthly MIS Report","0.6","0.75","0.9","1.0","1.05"]]},{"team":"Plastic","group":"Supply","sheet":"Plastic (Supply KRAKPI)","name":"PRAVEEN RAJ P","designation":"Senior Executive - Business Development","extra":"","kpis":[["Sales","Transaction from Existing Sellers","Seller Monthly Transaction Rate (%)","Ensure at least 50% of total onboarded sellers transact during the current month.","15.0","Monthly MIS Report","0.6","0.75","0.9","1.0","1.05"],["Sales","Transaction from New Onboarded Sellers","New Seller Same-Month Transaction Rate (%)","Ensure at least 20% of sellers onboarded during the current month complete a transaction within the same month.","15.0","Monthly MIS Report","0.6","0.75","0.9","1.0","1.05"],["Sales","New Seller Acquisition","Monthly Target Achievement (%)","Achieve the defined monthly target for the respective KPI within the evaluation period.","15.0","Monthly MIS Report","0.6","0.75","0.9","1.0","1.05"],["Sales","GMV","Monthly Target Achievement (%)","Achieve the defined monthly target for the respective KPI within the evaluation period.","40.0","Monthly MIS Report","0.6","0.75","0.9","1.0","1.05"],["Sales","Retention of Existing Transacted Sellers","Repeat Seller Transaction Rate (%)","Ensure at least 70% of sellers who transacted in the previous month transact again during the current month.","15.0","Monthly MIS Report","0.6","0.75","0.9","1.0","1.05"]]},{"team":"Plastic","group":"Supply","sheet":"Plastic (Supply KRAKPI)","name":"ASRAFUL HASAN","designation":"Assistant Manager - Business Development","extra":"","kpis":[["Sales","Transaction from Existing Sellers","Seller Monthly Transaction Rate (%)","Ensure at least 50% of total onboarded sellers transact during the current month.","15.0","Monthly MIS Report","0.6","0.75","0.9","1.0","1.05"],["Sales","Transaction from New Onboarded Sellers","New Seller Same-Month Transaction Rate (%)","Ensure at least 20% of sellers onboarded during the current month complete a transaction within the same month.","15.0","Monthly MIS Report","0.6","0.75","0.9","1.0","1.05"],["Sales","New Seller Acquisition","Monthly Target Achievement (%)","Achieve the defined monthly target for the respective KPI within the evaluation period.","15.0","Monthly MIS Report","0.6","0.75","0.9","1.0","1.05"],["Sales","GMV","Monthly Target Achievement (%)","Achieve the defined monthly target for the respective KPI within the evaluation period.","40.0","Monthly MIS Report","0.6","0.75","0.9","1.0","1.05"],["Sales","Retention of Existing Transacted Sellers","Repeat Seller Transaction Rate (%)","Ensure at least 70% of sellers who transacted in the previous month transact again during the current month.","15.0","Monthly MIS Report","0.6","0.75","0.9","1.0","1.05"]]},{"team":"Plastic","group":"Supply","sheet":"Plastic (Supply KRAKPI)","name":"RUSTUMPET ASHWIN KUMAR","designation":"Assistant Manager - Business Development","extra":"","kpis":[["Sales","Transaction from Existing Sellers","Seller Monthly Transaction Rate (%)","Ensure at least 50% of total onboarded sellers transact during the current month.","15.0","Monthly MIS Report","0.6","0.75","0.9","1.0","1.05"],["Sales","Transaction from New Onboarded Sellers","New Seller Same-Month Transaction Rate (%)","Ensure at least 20% of sellers onboarded during the current month complete a transaction within the same month.","15.0","Monthly MIS Report","0.6","0.75","0.9","1.0","1.05"],["Sales","New Seller Acquisition","Monthly Target Achievement (%)","Achieve the defined monthly target for the respective KPI within the evaluation period.","15.0","Monthly MIS Report","0.6","0.75","0.9","1.0","1.05"],["Sales","GMV","Monthly Target Achievement (%)","Achieve the defined monthly target for the respective KPI within the evaluation period.","40.0","Monthly MIS Report","0.6","0.75","0.9","1.0","1.05"],["Sales","Retention of Existing Transacted Sellers","Repeat Seller Transaction Rate (%)","Ensure at least 70% of sellers who transacted in the previous month transact again during the current month.","15.0","Monthly MIS Report","0.6","0.75","0.9","1.0","1.05"]]},{"team":"Plastic","group":"Supply","sheet":"Plastic (Supply KRAKPI)","name":"JOYDEEP DAS","designation":"Senior Executive - Business Development","extra":"","kpis":[["Sales","Transaction from Existing Sellers","Seller Monthly Transaction Rate (%)","Ensure at least 50% of total onboarded sellers transact during the current month.","15.0","Monthly MIS Report","0.6","0.75","0.9","1.0","1.05"],["Sales","Transaction from New Onboarded Sellers","New Seller Same-Month Transaction Rate (%)","Ensure at least 20% of sellers onboarded during the current month complete a transaction within the same month.","15.0","Monthly MIS Report","0.6","0.75","0.9","1.0","1.05"],["Sales","New Seller Acquisition","Monthly Target Achievement (%)","Achieve the defined monthly target for the respective KPI within the evaluation period.","15.0","Monthly MIS Report","0.6","0.75","0.9","1.0","1.05"],["Sales","GMV","Monthly Target Achievement (%)","Achieve the defined monthly target for the respective KPI within the evaluation period.","40.0","Monthly MIS Report","0.6","0.75","0.9","1.0","1.05"],["Sales","Retention of Existing Transacted Sellers","Repeat Seller Transaction Rate (%)","Ensure at least 70% of sellers who transacted in the previous month transact again during the current month.","15.0","Monthly MIS Report","0.6","0.75","0.9","1.0","1.05"]]},{"team":"Plastic","group":"Supply","sheet":"Plastic (Supply KRAKPI)","name":"PARTH GAUTAM","designation":"Senior Manager - BusinessDevelopment","extra":"","kpis":[["Sales","Transaction from Existing Sellers","Seller Monthly Transaction Rate (%)","Ensure at least 50% of total onboarded sellers transact during the current month.","15.0","Monthly MIS Report","0.6","0.75","0.9","1.0","1.05"],["Sales","Transaction from New Onboarded Sellers","New Seller Same-Month Transaction Rate (%)","Ensure at least 20% of sellers onboarded during the current month complete a transaction within the same month.","15.0","Monthly MIS Report","0.6","0.75","0.9","1.0","1.05"],["Sales","New Seller Acquisition","Monthly Target Achievement (%)","Achieve the defined monthly target for the respective KPI within the evaluation period.","15.0","Monthly MIS Report","0.6","0.75","0.9","1.0","1.05"],["Sales","GMV","Monthly Target Achievement (%)","Achieve the defined monthly target for the respective KPI within the evaluation period.","40.0","Monthly MIS Report","0.6","0.75","0.9","1.0","1.05"],["Sales","Retention of Existing Transacted Sellers","Repeat Seller Transaction Rate (%)","Ensure at least 70% of sellers who transacted in the previous month transact again during the current month.","15.0","Monthly MIS Report","0.6","0.75","0.9","1.0","1.05"]]},{"team":"Plastic","group":"Supply","sheet":"Plastic (Supply KRAKPI)","name":"UDAY KIRAN KUMAR THOTA","designation":"Senior Manager - Business Development","extra":"","kpis":[["Sales","Transaction from Existing Sellers","Seller Monthly Transaction Rate (%)","Ensure at least 50% of total onboarded sellers transact during the current month.","15.0","Monthly MIS Report","0.6","0.75","0.9","1.0","1.05"],["Sales","Transaction from New Onboarded Sellers","New Seller Same-Month Transaction Rate (%)","Ensure at least 20% of sellers onboarded during the current month complete a transaction within the same month.","15.0","Monthly MIS Report","0.6","0.75","0.9","1.0","1.05"],["Sales","New Seller Acquisition","Monthly Target Achievement (%)","Achieve the defined monthly target for the respective KPI within the evaluation period.","15.0","Monthly MIS Report","0.6","0.75","0.9","1.0","1.05"],["Sales","GMV","Monthly Target Achievement (%)","Achieve the defined monthly target for the respective KPI within the evaluation period.","40.0","Monthly MIS Report","0.6","0.75","0.9","1.0","1.05"],["Sales","Retention of Existing Transacted Sellers","Repeat Seller Transaction Rate (%)","Ensure at least 70% of sellers who transacted in the previous month transact again during the current month.","15.0","Monthly MIS Report","0.6","0.75","0.9","1.0","1.05"]]},{"team":"Plastic","group":"Supply","sheet":"Plastic (Supply KRAKPI)","name":"TABESH MOHAMMAD","designation":"General Manager - Business Development","extra":"","kpis":[["Sales","Demand Activation","Existing Buyer Monthly Transaction Rate (%)","Ensure at least 50% of active/onboarded buyers transact during the current month, maintaining healthy demand utilisation across the category.","10.0","Monthly MIS Report","0.6","0.75","0.9","1.0","1.05"],["Scale","New Demand Activation","New Buyer Same-Month Transaction Rate (%)","Ensure at least 20% of buyers onboarded during the current month complete a transaction within the same month.","10.0","Monthly MIS Report","0.6","0.75","0.9","1.0","1.05"],["Sales","Supply Activation","Existing Seller Monthly Transaction Rate (%)","Ensure at least 50% of active/onboarded sellers transact during the current month, maintaining healthy supply utilisation.","10.0","Monthly MIS Report","0.6","0.75","0.9","1.0","1.05"],["Scale","New Supply Activation","New Seller Same-Month Transaction Rate (%)","Ensure at least 20% of sellers onboarded during the current month complete a transaction within the same month.","10.0","Monthly MIS Report","0.6","0.75","0.9","1.0","1.05"],["Sales / Profit","Category GMV Growth","GMV Target Achievement (%)","Achieve the approved monthly GMV target for the category, balancing demand and supply growth to drive sustainable category revenue.","30.0","Monthly MIS Report","0.6","0.75","0.9","1.0","1.05"],["Customer","Transaction Quality","Debit Note Rate (%)","Ensure debit notes remain within the defined threshold as a percentage of current-month GMV, protecting transaction quality and commercial realisation.","10.0","Monthly MIS Report","0.013","0.012","0.01","0.008","0.006"],["Process / Profit","Working Capital Management","Days Sales Outstanding (DSO)","Maintain DSO within the defined threshold to ensure timely collections and healthy working capital for the category.","15.0","Monthly MIS Report","15.0","10.0","5.0","3.0","2.0"],["Sales / Profit","Category Growth \u0026 Balance","Demand–Supply Conversion Rate (%)","Ensure available category demand is effectively fulfilled through available supply, improving transaction conversion and reducing demand–supply imbalance.","5.0","Monthly MIS Report","0.6","0.75","0.9","1.0","1.05"]]},{"team":"Plastic","group":"Supply","sheet":"Plastic (Supply KRAKPI)","name":"NARESH","designation":"","extra":"","kpis":[["Process","Seller Onboarding","Seller Onboarding TAT Achievement (%)","Ensure seller onboarding cases are completed within the defined TAT through timely document validation, third-party verification, OSV coordination and closure of pending documentation.","30.0","COP / MIS","0.6","0.75","0.9","1.0","1.05"],["Process","Buyer Onboarding","Buyer Onboarding TAT Achievement (%)","Ensure buyer onboarding cases are completed within the defined TAT through timely document collection, KYC/business validation, document updation and closure of identified gaps.","20.0","COP / MIS","0.6","0.75","0.9","1.0","1.05"],["Process","Escalation Management \u0026 Issue Resolution","Issue Resolution TAT Achievement (%)","Ensure seller, buyer and transaction-related operational issues are logged, coordinated, followed up and resolved within the defined TAT, with timely communication to relevant stakeholders.","25.0","MIS","0.6","0.75","0.9","1.0","1.05"],["Customer","Sales \u0026 Relationship Team Coordination","Pending Action Closure Rate (%)","Ensure pending actions related to onboarding, inactive sellers/buyers, listing/requisition, matchmaking, transaction readiness, dispatch, QC/POD and payment are tracked and closed within the defined timeline.","10.0","MIS","0.6","0.75","0.9","1.0","1.05"],["Process","MIS \u0026 Operational Reporting","MIS Accuracy \u0026 Timeliness (%)","Maintain accurate and timely reporting of onboarding, pending cases, escalations, ageing, TAT and transaction-related operational metrics, ensuring critical gaps and dependencies are highlighted to stakeholders.","10.0","MIS / COP / Dashboard","0.6","0.75","0.9","1.0","1.05"],["Process","Process Improvement \u0026 SOP Adherence","SOP Compliance \u0026 Process Improvement Achievement (%)","Ensure adherence to defined SOPs and contribute to identifying and addressing recurring process gaps, bottlenecks and documentation issues to improve operational efficiency and reduce TAT.","5.0","SOP Audit / MIS / Process Tracker","0.6","0.75","0.9","1.0","1.05"]]},{"team":"Plastic","group":"Demand","sheet":"Plastic (Demand KRAKPI)","name":"NEELESH DIXIT","designation":"Senior Manager - Bsuiness Development","extra":"","kpis":[["Sales","Transaction from Existing Buyers","Buyer Monthly Transaction Rate (%)","Ensure at least 60% of total onboarded buyers transact during the current month.","15.0","Monthly MIS Report","0.6","0.75","0.9","1.0","1.05"],["Scale","Transaction from New Onboarded Buyers","New Buyer Same-Month Transaction Rate (%)","Ensure at least 20% of buyers onboarded during the current month complete a transaction within the same month.","15.0","Monthly MIS Report","0.6","0.75","0.9","1.0","1.05"],["Customer","New Buyer Acquisition","Monthly Target Achievement (%)","Achieve the defined monthly target for the respective KPI within the evaluation period.","15.0","Monthly MIS Report","0.6","0.75","0.9","1.0","1.05"],["Process","GMV","Monthly Target Achievement (%)","Achieve the defined monthly target for the respective KPI within the evaluation period.","30.0","Monthly MIS Report","0.6","0.75","0.9","1.0","1.05"],["Customer","DN % of GMV","Debit Note Rate (%)","Ensure debit notes do not exceed 1% of the buyer\u0027s current-month GMV.","10.0","Monthly MIS Report","0.013","0.012","0.01","0.008","0.006"],["Process","DSO Days","Days Sales Outstanding (DSO)","Calculate DSO as (Average Receivables ÷ GMV) × Number of Days in the Month.","15.0","Monthly MIS Report","15.0","10.0","5.0","3.0","2.0"]]},{"team":"Plastic","group":"Demand","sheet":"Plastic (Demand KRAKPI)","name":"RISHI PANCHAL","designation":"Senior Executive - Business Development","extra":"","kpis":[["Sales","Transaction from Existing Buyers","Buyer Monthly Transaction Rate (%)","Ensure at least 60% of total onboarded buyers transact during the current month.","15.0","Monthly MIS Report","0.6","0.75","0.9","1.0","1.05"],["Scale","Transaction from New Onboarded Buyers","New Buyer Same-Month Transaction Rate (%)","Ensure at least 20% of buyers onboarded during the current month complete a transaction within the same month.","15.0","Monthly MIS Report","0.6","0.75","0.9","1.0","1.05"],["Customer","New Buyer Acquisition","Monthly Target Achievement (%)","Achieve the defined monthly target for the respective KPI within the evaluation period.","15.0","Monthly MIS Report","0.6","0.75","0.9","1.0","1.05"],["Process","GMV","Monthly Target Achievement (%)","Achieve the defined monthly target for the respective KPI within the evaluation period.","30.0","Monthly MIS Report","0.6","0.75","0.9","1.0","1.05"],["Customer","DN % of GMV","Debit Note Rate (%)","Ensure debit notes do not exceed 1% of the buyer\u0027s current-month GMV.","10.0","Monthly MIS Report","0.013","0.012","0.01","0.008","0.006"],["Process","DSO Days","Days Sales Outstanding (DSO)","Maintain DSO as per the defined formula: (Average Receivables ÷ GMV) × Number of Days in the Month.","15.0","Monthly MIS Report","15.0","10.0","5.0","3.0","2.0"]]},{"team":"Onboarding","group":"","sheet":"Onboarding (Individual)","name":"VAMSI","designation":"Senior Executive - Onboarding","extra":"","kpis":[["Process","Open Marketplace – Buyer \u0026 Seller Onboarding","TAT ( 1 Day )","% of cases completed within TAT","0.35","COP (Data)","0.8","0.85","0.9","0.95","1.0"],["Process","Re-Commerce – Seller Onboarding","TAT ( 1 Day )","% of cases completed within TAT","0.1","COP (Data)","0.8","0.85","0.9","0.95","1.0"],["Process","Fall Back – AFR \u0026 INFRA (Seller \u0026 Buyer Onboarding)","TAT ( 3 Days)","% of cases completed within TAT","0.1","COP (Data)","0.8","0.85","0.9","0.95","1.0"],["Process","Audit \u0026 Monitoring of Onboarded Vendors","Document Completeness","% of audited vendors with complete and correctly validated documentation","0.2","Individual Work Sheet","0.8","0.85","0.9","0.95","1.0"],["Process","On-Site Verification","TAT ( 4 Days )","% of OSVs completed within TAT","0.15","Individual Work Sheet","0.8","0.85","0.9","0.95","1.0"],["Process","Vendor Payments – Third Party (Finoscale / Carma One)","Timely Validation of Bills \u0026 Vendor Payments","% of bills/payments validated within defined TAT","0.1","Individual Work Sheet","0.8","0.85","0.9","0.95","1.0"]]},{"team":"Onboarding","group":"","sheet":"Onboarding (Individual)","name":"HARSHITA","designation":"Executive - Onboarding","extra":"","kpis":[["Process","INFRA – Buyer \u0026 Seller Onboarding","TAT ( 3 Days )","% of cases completed within TAT","0.25","COP (Data)","0.8","0.85","0.9","0.95","1.0"],["Process","AFR – Buyer \u0026 Seller Onboarding","TAT ( 3 Days )","% of cases completed within TAT","0.25","COP (Data)","0.8","0.85","0.9","0.95","1.0"],["Process","Audit \u0026 Monitoring of Onboarded Vendors","Document Completeness","% of audited vendors with complete and correctly validated documentation","0.2","Individual Work Sheet","0.8","0.85","0.9","0.95","1.0"],["Process","Fall Back – EPR (Seller Onboarding)","TAT","% of cases completed within defined TAT","0.1","COP (Data)","0.8","0.85","0.9","0.95","1.0"],["Process","Vendor Payments – Third Party (Ongrid)","Timely Validation of Bills \u0026 Vendor Payments","% of bills/payments validated within defined TAT","0.1","Individual Work Sheet","0.8","0.85","0.9","0.95","1.0"],["Process","Vendor Payments – Third Party (Finoscale / Carma One)","Timely Validation of Bills \u0026 Vendor Payments","% of bills/payments validated within defined TAT","0.1","Individual Work Sheet","0.8","0.85","0.9","0.95","1.0"]]},{"team":"Onboarding","group":"","sheet":"Onboarding (Individual)","name":"NAVEEN RANGA","designation":"Senior Executive - Onboarding","extra":"","kpis":[["Process","EPR – Buyer \u0026 Seller Onboarding","TAT ( 3 Days)","% of cases completed within defined TAT","0.35","COP (Data)","0.8","0.85","0.9","0.95","1.0"],["Process","Audit \u0026 Monitoring of Onboarded Vendors","Document Completeness","% of audited vendors with complete and correctly validated documentation","0.2","Individual Work Sheet","0.8","0.85","0.9","0.95","1.0"],["Process","Transporter Onboarding","TAT","% of cases completed within defined TAT","0.15","COP (Data)","0.8","0.85","0.9","0.95","1.0"],["Process","Fall Back – Open Marketplace Onboarding","TAT ( 1 Day )","% of cases completed within defined TAT","0.1","COP (Data)","0.8","0.85","0.9","0.95","1.0"],["Process","Open Marketplace – NBFC Coordination","NBFC Coordination \u0026 Case Management","% of NBFC coordination activities completed within defined SLA","0.1","Emails / Dashboard","0.8","0.85","0.9","0.95","1.0"],["Process","GST Payments","Compliance Check","% of Third Party vendors paid within defined payment timeline","0.1","Documentation","0.8","0.85","0.9","0.95","1.0"]]},{"team":"Onboarding","group":"","sheet":"Onboarding (Individual)","name":"VISHWASH","designation":"Management Trainee","extra":"","kpis":[["Process","Fall Back for All Verticals – Vendor \u0026 Buyer Onboarding","TAT","% of onboarding cases completed within defined TAT as per SOP","0.1","COP (Data)","0.8","0.85","0.9","0.95","1.0"],["Process","Design Standard Operating Procedures for Onboarding","Approved SOPs","% of required SOPs validated, approved and implemented","0.2","COP (Data)","0.8","0.85","0.9","0.95","1.0"],["Process","Digitalization of the Onboarding Process","Automation of Process","% of identified onboarding processes automated","0.3","Process Flow","0.0","0.1","0.2","0.35","0.5"],["Process","Maintain Daily Reports for Buyer \u0026 Seller Onboarding Across Verticals","Accuracy \u0026 Timeliness of Reports / Dashboard Representation","% of reports accurately represented and delivered within defined timeline","0.3","Individual Work Sheet","0.8","0.85","0.9","0.95","1.0"],["Process","Audit Process for Entire Onboarding \u0026 Collections","Reporting \u0026 Escalations","% of audit findings reported and escalated within defined timeline","0.1","Meeting","More than (T+7 days)","T+7 days","On Time (Defined TAT)","T-1 day","T - 2 days"]]},{"team":"Onboarding","group":"","sheet":"Onboarding (Individual)","name":"AJAY","designation":"Manager - Onboarding","extra":"","kpis":[["Process","All Verticals – Vendor \u0026 Buyer Onboarding","TAT","% of onboarding cases completed within defined TAT as per SOP","0.4","COP (Data)","0.8","0.85","0.9","0.95","1.0"],["Process","Design Standard Operating Procedures for Onboarding","Approved SOPs","% of required SOPs validated, approved and implemented","0.2","COP (Data)","0.8","0.85","0.9","0.95","1.0"],["Process","Audit \u0026 Monitoring of Onboarded Vendors","Document Completeness","% of audited vendors with complete and correctly validated documentation","0.1","Monthly Reporting","0.8","0.85","0.9","0.95","1.0"],["Process","Digitalization of the Onboarding Process","Automation of Process","% of identified onboarding processes automated","0.2","Process Flow","0.0","0.15","0.3","0.5","0.7"],["Process","Vendor Payments","Timely Validation of Bills \u0026 Vendor Payments","% of bills/payments validated within defined payment timeline","0.1","Team Work Sheet","0.8","0.85","0.9","0.95","1.0"]]},{"team":"Collections","group":"","sheet":"Collections (Individual)","name":"SAI NITIN","designation":"Executive - Collections","extra":"","kpis":[["Customer","Due Date + 7 Days Collections – Marketplace \u0026 EPR","Collection % vs Target","Achieve the defined collection target within the evaluation period.","0.6","MIS Report","0.8","0.85","0.9","1.0","1.05"],["Process","Balance Confirmation","Confirmation Coverage %","Ensure at least the defined percentage of customers with dues exceeding ₹50K have their payments confirmed.","0.1","MIS Report","0.8","0.85","0.9","0.95","1.0"],["Process","Reminder Emails","Adherence to Reminder (Total)","Ensure adherence to the defined collections reminder process within the evaluation period.","0.1","MIS Report","As per Collections Process","—","—","—","—"],["Process","Payment Posting","TAT – Days","Ensure payment posting is completed within the defined TAT from the date of payment receipt.","0.1","MIS Report","12 Days","10 Days","8 Days","7 Days","5 Days"],["Process","Cross-Functional Coordination","Coordination Adherence %","Ensure adherence to the defined coordination requirements during each quarter.","0.1","MIS Report","75% in Quater","80% in Quater","85% in Quater","90% in Quater","100% in Quater"]]},{"team":"Collections","group":"","sheet":"Collections (Individual)","name":"RAVI NAIK","designation":"Manager - Collections","extra":"","kpis":[["Customer","Due Date + 7 Days Collections – Marketplace \u0026 EPR","Collection % vs Target","Achieve the defined collection target within the evaluation period.","0.3","MIS Report","0.8","0.85","0.9","1.0","1.05"],["Customer","DSO – Marketplace \u0026 EPR","DSO Days","Maintain DSO within the defined target during the evaluation period.","0.3","MIS Report","\u003e 28 Days","25–28 Days","21–24 Days","TGT-20 Days","≤ 19 Days"],["Collections","Legacy Collections","Legacy Collection % of LD","Ensure the defined percentage of Legacy Debt (LD) is collected within the evaluation period.","0.15","MIS Report","10% of LD","15% of LD","20% of LD","25% of LD","30% of LD"],["Collections","PDD (Past Due Debt)","PDD ₹ Cr Recovered","Recover the defined PDD amount in ₹ Cr within the evaluation period.","0.1","MIS Report","≥ ₹9 Cr","₹8 Cr","₹7 Cr","₹6 Cr","\u003c ₹5 Cr"],["Process","Legal Actions","Legal Action Coordination %","Achieve the defined cumulative percentage of the team target through effective coordination of legal actions.","0.05","MIS Report","80% Cumulative of Team Target","100% Cumulative of Team Target","120% Cumulative of Team Target","140% Cumulative of Team Target","160% Cumulative of Team Target"],["Collections","Collection of Previous Dues (Marketplace \u0026 EPR)","Collections of Overdue of Previous Financial prior to FY 25-26 (Marketplace \u0026 EPR)","Ensure the defined percentage of overdue collections from financial years prior to FY 25-26 is recovered during the evaluation period.","0.1","MIS Report","0.4","0.5","0.6","0.7","0.8"]]},{"team":"Collections","group":"","sheet":"Collections (Individual)","name":"ANKUR","designation":"Assistant Manager - Collections","extra":"","kpis":[["Customer","Due Date + 7 Days Collections – Marketplace \u0026 EPR","Collection % vs Target","Achieve the defined collection target within the evaluation period.","0.3","MIS Report","0.8","0.85","0.9","1.0","1.05"],["Customer","DSO – Marketplace \u0026 EPR","DSO Days","Maintain DSO within the defined target during the evaluation period.","0.3","MIS Report","\u003e 28 Days","25–28 Days","21–24 Days","TGT-20 Days","≤ 19 Days"],["Collections","Legacy Collections","Legacy Collection % of LD","Ensure the defined percentage of Legacy Debt (LD) is collected within the evaluation period.","0.15","MIS Report","10% of LD","15% of LD","20% of LD","25% of LD","30% of LD"],["Collections","PDD (Past Due Debt)","PDD ₹ Cr Recovered","Recover the defined PDD amount in ₹ Cr within the evaluation period.","0.1","MIS Report","≥ ₹9 Cr","₹8 Cr","₹7 Cr","₹6 Cr","\u003c ₹5 Cr"],["Process","Legal Actions","Legal Action Coordination %","Achieve the defined cumulative percentage of the team target through effective coordination of legal actions.","0.05","MIS Report","80% Cumulative of Team Target","100% Cumulative of Team Target","120% Cumulative of Team Target","140% Cumulative of Team Target","160% Cumulative of Team Target"],["Collections","Collection of Previous Dues (Marketplace)","Collections of Overdue of Previous Financial prior to FY 25-26 (Marketplace)","Ensure the defined percentage of overdue collections from financial years prior to FY 25-26 is recovered during the evaluation period.","0.1","MIS Report","0.4","0.5","0.6","0.7","0.8"]]},{"team":"Collections","group":"","sheet":"Collections (Individual)","name":"VENKAT","designation":"Assistant Manager - Collections","extra":"","kpis":[["Customer","Due Date + 7 Days Collections – Marketplace \u0026 EPR","Collection % vs Target","Achieve the defined collection target within the evaluation period.","0.3","MIS Report","0.8","0.85","0.9","1.0","1.05"],["Customer","DSO – Marketplace \u0026 EPR","DSO Days","Maintain DSO within the defined target during the evaluation period.","0.3","MIS Report","\u003e 28 Days","25–28 Days","21–24 Days","TGT-20 Days","≤ 19 Days"],["Collections","Legacy Collections","Legacy Collection % of LD","Ensure the defined percentage of Legacy Debt (LD) is collected within the evaluation period.","0.15","MIS Report","10% of LD","15% of LD","20% of LD","25% of LD","30% of LD"],["Collections","PDD (Past Due Debt)","PDD ₹ Cr Recovered","Recover the defined PDD amount in ₹ Cr within the evaluation period.","0.1","MIS Report","≥ ₹9 Cr","₹8 Cr","₹7 Cr","₹6 Cr","\u003c ₹5 Cr"],["Process","Legal Actions","Legal Action Coordination %","Achieve the defined cumulative percentage of the team target through effective coordination of legal actions.","0.05","MIS Report","80% Cumulative of Team Target","100% Cumulative of Team Target","120% Cumulative of Team Target","140% Cumulative of Team Target","160% Cumulative of Team Target"],["Collections","Collection of Previous Dues (EPR)","Collections of Overdue of Previous Financial prior to FY 25-26 (EPR)","Ensure the defined percentage of overdue collections from financial years prior to FY 25-26 is recovered during the evaluation period.","0.1","MIS Report","0.4","0.5","0.6","0.7","0.8"]]},{"team":"Collections","group":"","sheet":"Collections (Individual)","name":"SRINIVAS REDDY","designation":"Assistant Manager - Collections","extra":"","kpis":[["Collections","Collection of Previous Dues (Marketplace \u0026 EPR)","Collections of Overdue of Previous Financial prior to FY 25-26 (EPR)","Ensure the defined percentage of overdue collections from financial years prior to FY 25-26 is recovered during the evaluation period.","0.1","MIS Report","0.4","0.5","0.6","0.7","0.8"],["Customer","DSO – Marketplace \u0026 EPR","DSO Days","Maintain DSO within the defined target during the evaluation period.","0.1","MIS Report","\u003e 28 Days","25–28 Days","21–24 Days","TGT-20 Days","≤ 19 Days"],["Process","Transaction (Marketplace)","Coordination Adherence %","Ensure adherence to the defined coordination requirements during the evaluation period.","0.15","MIS Report / Email / Communication Channel","0.8","0.85","0.9","0.95","1.0"],["Process","Payment Posting \u0026 Reconciliation","TAT – Days","Ensure payment posting and reconciliation are completed within the defined TAT from the date of payment receipt.","0.15","MIS Report","12 Days","10 Days","8 Days","7 Days","5 Days"],["Process","Process Improvement \u0026 Automation","Process Automation (%)","Identify process gaps and leakages and implement solutions to improve operational efficiency, reduce manual intervention, and minimize errors.","0.3","Project Tracker / Process Improvement Tracker","0.8","0.85","0.9","0.95","1.0"],["Process","Compliance (Documentation) \u0026 Audit","Documentation Completion (%)","Ensure 100% completion of required documentation from both Buyers and Sellers for every transaction.","0.2","Dashboard / MIS","0.8","0.85","0.9","0.95","1.0"]]},{"team":"Open Marketplace - Control Tower","group":"","sheet":"Marketplace - Control Tower (In","name":"ASHWIN KUMAR SINGH","designation":"Manager","extra":"","kpis":[["Process","Compliance (Documentation)","Documentation Completion (%)","Ensure 100% completion of required documentation from both Buyers and Sellers for every transaction.","0.2","Dashboard / MIP","0.8","0.85","0.9","0.95","1.0"],["Process","Match Making","Demand \u0026 Listing Conversion Rate (%)","Achieve at least 80% conversion of demand requisitions and platform listings into successful transactions.","0.1","Dashboard / MIP","0.8","0.85","0.9","0.95","1.0"],["MIS","Transaction Tracking","Transaction Closure \u0026 Tracking (%)","Ensure 100% transaction closure, including completion of material movement, GST payment, and end-to-end transaction tracking with complete dashboard visibility.","0.2","Dashboard / MIP","0.8","0.85","0.9","0.95","1.0"],["Process","DN / CN Tracking","CN \u0026 DN Closure Rate (%)","Ensure 100% closure of all Credit Note (CN) and Debit Note (DN) transactions within the defined timeline.","0.2","Dashboard / MIP","0.8","0.85","0.9","0.95","1.0"],["Process","Process Improvement \u0026 Automation","Process Automation (%)","Identify process gaps and leakages and implement solutions to improve operational efficiency, reduce manual intervention, and minimize errors.","0.3","Project Tracker / Process Improvement Tracker","0.0","0.15","0.3","0.5","0.7"]]},{"team":"Open Marketplace - Control Tower","group":"","sheet":"Marketplace - Control Tower (In","name":"DIVYA BOPPURI","designation":"Executive","extra":"","kpis":[["Process","Dispatch Execution","Timely Dispatch Rate (%)","Ensure shipments are dispatched within 2 days of matchmaking in accordance with the defined SOP.","0.4","Dashboard / MIP","0.8","0.85","0.9","0.95","1.0"],["Process","Dispatch Documentation Management","Dispatch Documentation Accuracy (%)","Ensure 100% of dispatches have a complete and error-free 6-Document Pack.","0.35","Audit / Reconciliation","0.8","0.85","0.9","0.95","1.0"],["Process","Dispatch Coordination \u0026 Resolution","Dispatch Issue Resolution Rate (%)","Ensure seller follow-ups, gate-pass coordination, and dispatch-related queries are resolved within the defined SLA.","0.15","Email / MIP / Communication Channel","0.8","0.85","0.9","0.95","1.0"],["Process","SOP \u0026 Process Compliance","Dispatch SOP Compliance Rate (%)","Ensure 100% of transactions are executed in accordance with the defined dispatch and documentation guidelines.","0.1","Email / MIP / Training \u0026 Meetings","0.8","0.85","0.9","0.95","1.0"]]},{"team":"Open Marketplace - Control Tower","group":"","sheet":"Marketplace - Control Tower (In","name":"JITHENDER CHITAKODUR","designation":"Executive","extra":"","kpis":[["Process","Dispatch Execution","Timely Dispatch Rate (%)","Ensure shipments are dispatched within 2 days of matchmaking in accordance with the defined SOP.","0.4","Dashboard / MIP","0.8","0.85","0.9","0.95","1.0"],["Process","Dispatch Documentation Management","Dispatch Documentation Accuracy (%)","Ensure 100% of dispatches have a complete and error-free 6-Document Pack.","0.35","Audit / Reconciliation","0.8","0.85","0.9","0.95","1.0"],["Process","Dispatch Coordination \u0026 Resolution","Dispatch Issue Resolution Rate (%)","Ensure seller follow-ups, gate-pass coordination, and dispatch-related queries are resolved within the defined SLA.","0.15","MIP / Communication Channel","0.8","0.85","0.9","0.95","1.0"],["Process","SOP \u0026 Process Compliance","Dispatch SOP Compliance Rate (%)","Ensure 100% of transactions are executed in accordance with the defined dispatch and documentation guidelines.","0.1","Email /MIP / Training \u0026 Meetings","0.8","0.85","0.9","0.95","1.0"]]},{"team":"Open Marketplace - Control Tower","group":"","sheet":"Marketplace - Control Tower (In","name":"BHARATH KUMAR","designation":"Senior Executive","extra":"","kpis":[["Process","In-Transit Delivery Management","On-Time Transit Completion Rate (%)","Ensure shipments reach the buyer location within the planned transit window.","0.5","Dashboard / MIP","0.8","0.85","0.9","0.95","1.0"],["Process","Shipment Visibility \u0026 Monitoring","Tracking Accuracy Rate (%)","Ensure shipments are accurately monitored through Mobile SIM / FASTag without tracking blind spots.","0.3","Audit / Reconciliation","0.8","0.85","0.9","0.95","1.0"],["Process","Buyer Coordination \u0026 Delay Management","Pre-Arrival \u0026 Delay Resolution Rate (%)","Ensure buyer notifications and shipment-delay cases are handled within the defined SLA.","0.1","Email / MIP / Communication Channel","0.8","0.85","0.9","0.95","1.0"],["Process","In-Transit SOP Compliance","Transit Process Compliance Rate (%)","Ensure 100% of shipments are managed in accordance with the defined tracking and escalation SOPs.","0.1","Email / MIP / Training \u0026 Meetings","0.8","0.85","0.9","0.95","1.0"]]},{"team":"Open Marketplace - Control Tower","group":"","sheet":"Marketplace - Control Tower (In","name":"RAJESWARI","designation":"Executive","extra":"","kpis":[["Process","POD Closure Management","POD Collection TAT (%)","Ensure PODs are collected within 48 hours of delivery.","0.35","Dashboard / MIP","0.8","0.85","0.9","0.95","1.0"],["Process","POD Documentation Management","POD First-Time-Right Rate (%)","Ensure POD submissions are complete and accurate on the first submission.","0.4","Audit / Reconciliation","0.8","0.85","0.9","0.95","1.0"],["Process","Delivery Coordination \u0026 Exception Resolution","Delivery Exception Resolution Rate (%)","Ensure BR POC follow-ups and vehicle-rejection cases are resolved within the defined SLA.","0.15","Email / MIP / Communication Channel","0.8","0.85","0.9","0.95","1.0"],["Process","POD \u0026 Exception Compliance","POD Process Compliance Rate (%)","Ensure 100% of shipments are handled in accordance with the defined POD collection and rejection-handling SOPs.","0.1","Email / MIP / Training \u0026 Meetings","0.8","0.85","0.9","0.95","1.0"]]},{"team":"Open Marketplace - Control Tower","group":"","sheet":"Marketplace - Control Tower (In","name":"AISHWARYA KARANAM","designation":"Executive","extra":"","kpis":[["Process","Payment Release Management","Timely Payment Release Rate (%)","Ensure payments are released within 5 days of delivery in accordance with the defined SOP.","0.3","Dashboard / MIP","0.8","0.85","0.9","0.95","1.0"],["Process","QC \u0026 Settlement Management","QC \u0026 Settlement Accuracy Rate (%)","Ensure QC reports, debit notes, and settlements are processed accurately and within the defined timeline.","0.4","Audit / Reconciliation","0.8","0.85","0.9","0.95","1.0"],["Process","Dispute \u0026 Payment Resolution","Dispute \u0026 Follow-Up Resolution Rate (%)","Ensure disputes and payment reminders are managed and resolved within the defined SLA.","0.2","Email / MIP / Communication Channel","0.8","0.85","0.9","0.95","1.0"],["Process","Settlement Process Compliance","QC \u0026 Settlement SOP Compliance Rate (%)","Ensure 100% of transactions are executed in accordance with the defined QC, dispute, and settlement SOPs.","0.1","Email / MIP / Training \u0026 Meetings","0.8","0.85","0.9","0.95","1.0"]]},{"team":"Open Marketplace - Control Tower","group":"","sheet":"Marketplace - Control Tower (In","name":"MEGARAJ","designation":"Senior Executive","extra":"","kpis":[["Process","POD Closure Management","POD Collection TAT (%)","Ensure at least the defined percentage of PODs are collected within 48 hours of delivery.","0.35","Dashboard / MIP","0.8","0.85","0.9","0.95","1.0"],["Process","POD Documentation Management","POD First-Time-Right Rate (%)","Ensure at least the defined percentage of POD submissions are complete and accurate on the first submission.","0.4","Audit / Reconciliation","0.8","0.85","0.9","0.95","1.0"],["Process","Delivery Coordination \u0026 Exception Resolution","Delivery Exception Resolution Rate (%)","Ensure at least the defined percentage of BR POC follow-ups and vehicle-rejection cases are resolved within the defined SLA.","0.15","Email / MIP / Communication Channel","0.8","0.85","0.9","0.95","1.0"],["Process","POD \u0026 Exception Compliance","POD Process Compliance Rate (%)","Ensure 100% of shipments are handled in accordance with the defined POD collection and rejection-handling SOPs.","0.1","Email / MIP / Training \u0026 Meetings","0.8","0.85","0.9","0.95","1.0"]]},{"team":"Open Marketplace - Control Tower","group":"","sheet":"Marketplace - Control Tower (In","name":"ARVIND JAKKULA","designation":"Executive","extra":"","kpis":[["Process","In-Transit Delivery Management","On-Time Transit Completion Rate (%)","Ensure at least the defined percentage of shipments reach the buyer location within the planned transit window.","0.5","Dashboard / MIP","0.8","0.85","0.9","0.95","1.0"],["Process","Shipment Visibility \u0026 Monitoring","Tracking Accuracy Rate (%)","Ensure at least the defined percentage of shipments are accurately monitored through Mobile SIM / FASTag without tracking blind spots.","0.3","Audit / Reconciliation","0.8","0.85","0.9","0.95","1.0"],["Process","Buyer Coordination \u0026 Delay Management","Pre-Arrival \u0026 Delay Resolution Rate (%)","Ensure at least the defined percentage of buyer notifications and shipment-delay cases are handled within the defined SLA.","0.1","Email / MIP / Communication Channel","0.8","0.85","0.9","0.95","1.0"],["Process","In-Transit SOP Compliance","Transit Process Compliance Rate (%)","Ensure 100% of shipments are managed in accordance with the defined tracking and escalation SOPs.","0.1","Email / MIP / Training \u0026 Meetings","0.8","0.85","0.9","0.95","1.0"]]}]};
