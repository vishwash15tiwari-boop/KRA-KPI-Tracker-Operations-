// Performance Tracker — individual KRA / KPI scorecards (Apps Script web app).
// The rules and the reasons behind them are in PerformOS-handover.docx.

var APP_NAME = 'Performance Tracker';
// Keep the PERFORMOS_* names: renaming PERFORMOS_DB_ID points the app at a new, empty
// database, and renaming PERFORMOS_ADMINS locks every account out.
var PROP_DB = 'PERFORMOS_DB_ID';
var PROP_ADMINS = 'PERFORMOS_ADMINS';
var PROP_OPEN = 'PERFORMOS_OPEN_ACCESS';
var SOURCE_SHEET_ID = '1c0_pP4Mmye5s5D_vzoxrvJ-utkLb6JhD69TvvOBbjoo';

var SHIPMENTS_SHEET_ID = '1JCM55z-FaTCUJk0oNxbyHokPQBIsq3DlUZW3Rsf9GhI';
// The only target source. MM_CT Raw_POC_Targets is ruled out for targets (its achieved columns are fine).
var TARGETS_SHEET_ID = '1AWHM6Cmtf0hFkdQtzlryVw0pRTzehiJ-u-yNjQbTFTc';

var OMP_TRACKER_SHEET_ID = '15hAyV4C2DQEkGPOTcTmXfAuyQ2Y8Wvlu7yb5Fzar8Xw';
var OMP_TRACKER_TAB = 'OMP_TRACKER';
var SHIPMENTS_TAB = 'Raw_Shipments';
// Statuses that do not count. Data, not code: widen it here.
var SHIPMENTS_EXCLUDE_STATUS = ['cancelled'];
function shipmentExcluded_(status) {
  var v = String(status == null ? '' : status).trim().toLowerCase();
  return SHIPMENTS_EXCLUDE_STATUS.indexOf(v) >= 0;
}

// ===== SCHEMA =====
var T = {
  TEAMS: 'TEAMS', EMPLOYEES: 'EMPLOYEES', KRAS: 'KRAS', KPIS: 'KPIS',
  ASSIGN: 'ASSIGNMENTS', TARGETS: 'TARGETS', PERF: 'PERFORMANCE',
  PERIODS: 'PERIODS', USERS: 'USERS', AUDIT: 'AUDIT', SETTINGS: 'SETTINGS',
  PLAN: 'PLAN'
};
var SCHEMA = {};
SCHEMA[T.TEAMS]     = ['id', 'name', 'code', 'lead_id', 'note', 'status'];
SCHEMA[T.EMPLOYEES] = ['id', 'name', 'designation', 'team_id', 'sub_group', 'region',
                       'manager_id', 'status', 'email'];
SCHEMA[T.KRAS]      = ['id', 'team_id', 'perspective', 'name', 'status'];
SCHEMA[T.KPIS]      = ['id', 'kra_id', 'name', 'goal', 'source', 'unit', 'status'];
SCHEMA[T.ASSIGN]    = ['id', 'employee_id', 'kra_id', 'kpi_id', 'weightage', 'status',
                       'updated_by', 'updated_at'];
SCHEMA[T.TARGETS]   = ['id', 'employee_id', 'kpi_id', 'period_id',
                       't1', 't2', 't3', 't4', 't5',
                       'version', 'updated_by', 'updated_at'];
SCHEMA[T.PERF]      = ['id', 'employee_id', 'kpi_id', 'period_id', 'actual', 'manual_level',
                       'level', 'kind', 'direction', 'note', 'status', 'updated_by', 'updated_at'];
SCHEMA[T.PERIODS]   = ['id', 'name', 'kind', 'sort', 'status'];
SCHEMA[T.USERS]     = ['id', 'name', 'email', 'role_id', 'employee_id'];
SCHEMA[T.AUDIT]     = ['id', 'ts', 'actor', 'entity_type', 'entity_id', 'action',
                       'old_value', 'new_value', 'reason'];
SCHEMA[T.PLAN]      = ['id', 'employee_id', 'kpi_id', 'period_id', 'target_value', 'unit',
                       'source', 'rule', 'basis_value', 'updated_by', 'updated_at'];
SCHEMA[T.SETTINGS]  = ['key', 'value'];

// Pinned to plain text before writing, or Sheets turns 'August 2026' into a Date.
var TEXT_COLS = {};
TEXT_COLS[T.PERIODS] = ['id', 'name'];

// ===== READING THE TARGET SHEET =====
var TARGET_TABS = ['Metals', 'Plastics'];
var FY_START_YEAR = 2026;
var MONTH_COLUMN_NAMES = ['JANUARY', 'FEBRUARY', 'MARCH', 'APRIL', 'MAY', 'JUNE', 'JULY',
                          'AUGUST', 'SEPTEMBER', 'OCTOBER', 'NOVEMBER', 'DECEMBER'];
function periodIdForMonthName_(name) {
  var i = MONTH_COLUMN_NAMES.indexOf(String(name || '').trim().toUpperCase());
  if (i < 0) return null;
  var month = i + 1;
  var year = month >= 4 ? FY_START_YEAR : FY_START_YEAR + 1;
  return 'per_' + year + '-' + (month < 10 ? '0' : '') + month;
}
// Commas are thousands separators (deleted, not spaced). A dash, blank or n/a means no target, not 0.
function parseTargetValue_(v) {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return null;
  if (typeof v === 'number') return isFinite(v) ? v : null;
  var t = String(v).trim();
  if (t === '' || /^[—–\-.·]+$/.test(t) || /^n\/?a$/i.test(t)) return null;
  t = t.replace(/,/g, '').replace(/₹/g, ' ')
       .replace(/\bcr(ores?)?\b/gi, ' ').replace(/%/g, ' ');
  var m = t.match(/-?\d+(?:\.\d+)?/);
  if (!m) return null;
  var num = parseFloat(m[0]);
  return isFinite(num) ? num : null;
}
function normName_(v) {
  return String(v == null ? '' : v).toUpperCase()
    .replace(/[^A-Z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}
function readTargetTab_(sh) {
  var out = { tab: sh.getName(), months: [], rows: [], warnings: [] };
  var lastR = sh.getLastRow(), lastC = sh.getLastColumn();
  if (lastR < 3 || lastC < 3) { out.warnings.push('tab is too small to hold a table'); return out; }
  var grid = sh.getRange(1, 1, lastR, lastC).getValues();
  function cell(r, c) {
    var v = (grid[r] || [])[c];
    return v === null || v === undefined ? '' : String(v).replace(/\s+/g, ' ').trim();
  }
  var hr = -1;
  for (var r = 0; r < Math.min(grid.length, 12) && hr < 0; r++) {
    for (var c = 0; c < lastC; c++) {
      if (/^employee\s*name$/i.test(cell(r, c))) { hr = r; break; }
    }
  }
  if (hr < 0) { out.warnings.push('no row containing "EMPLOYEE NAME" in the first 12 rows'); return out; }
  out.headerRow = hr + 1;
  var nameCol = -1, kraCol = -1;
  for (c = 0; c < lastC; c++) {
    if (/^employee\s*name$/i.test(cell(hr, c))) nameCol = c;
    if (/^kra$/i.test(cell(hr, c))) kraCol = c;
  }
  out.nameCol = nameCol; out.kraCol = kraCol;
  if (nameCol < 0 || kraCol < 0) { out.warnings.push('could not find both EMPLOYEE NAME and KRA'); return out; }
  var monthRow = hr - 1;
  for (c = 0; c < lastC; c++) {
    var pid = monthRow >= 0 ? periodIdForMonthName_(cell(monthRow, c)) : null;
    if (!pid) continue;
    if (!/^target$/i.test(cell(hr, c))) {
      out.warnings.push('month "' + cell(monthRow, c) + '" at column ' + c +
        ' is not above a Target column (found "' + cell(hr, c) + '")');
      continue;
    }
    var aCol = /^achievement$/i.test(cell(hr, c + 1)) ? c + 1 : -1;
    if (aCol < 0) out.warnings.push('month "' + cell(monthRow, c) + '" has no Achievement column');
    out.months.push({ name: cell(monthRow, c), period_id: pid, targetCol: c, achCol: aCol });
  }
  if (!out.months.length) { out.warnings.push('no month columns found'); return out; }
  var subCol = -1;
  for (r = hr + 1; r < Math.min(grid.length, hr + 40) && subCol < 0; r++) {
    for (c = 0; c < nameCol; c++) {
      if (/^(supply|demand)$/i.test(cell(r, c))) { subCol = c; break; }
    }
  }
  out.subCol = subCol;
  var curName = '', curSub = '';
  for (r = hr + 1; r < grid.length; r++) {
    var nm = cell(r, nameCol);
    if (nm) curName = nm;
    if (subCol >= 0 && cell(r, subCol)) curSub = cell(r, subCol);
    var kra = cell(r, kraCol);
    if (!kra || !curName) continue;
    var cells = {};
    out.months.forEach(function (m) {
      cells[m.period_id] = {
        target: parseTargetValue_((grid[r] || [])[m.targetCol]),
        achievement: m.achCol >= 0 ? parseTargetValue_((grid[r] || [])[m.achCol]) : null
      };
    });
    out.rows.push({ rowNo: r + 1, name: curName, subGroup: curSub, kra: kra, cells: cells });
  }
  return out;
}

// ===== DERIVED TARGETS =====
var DERIVED_FROM_PERIOD = 'per_2026-06';

// Team-specific rules first: the first match wins, and a team mismatch yields no rule at all.
// Not wired up yet: nothing supplies the basis counts, so derivedTarget_ has no caller.
var DERIVED_RULES = [
  { key: 'existing_sellers', team: /plastic/i,
    match: /transaction\s+from\s+existing\s+sellers/i,
    pct: 0.50, basis: 'sellers_onboarded_cumulative_prev',
    rule: '50% of sellers onboarded up to the end of the previous month' },
  { key: 'new_sellers', team: /plastic/i,
    match: /transaction\s+from\s+new\s+onboarded\s+sellers/i,
    pct: 0.20, basis: 'sellers_onboarded_this_month',
    rule: '20% of sellers onboarded during this month' },
  { key: 'retention_metal', team: /metal/i,
    match: /retention\s+of\s+existing\s+transacted\s+sellers/i,
    pct: 0.50, basis: 'sellers_transacted_prev_month',
    rule: '50% of sellers who transacted last month (Metal handles supply and demand)' },
  { key: 'retention_plastic', team: /plastic/i,
    match: /retention\s+of\s+existing\s+transacted\s+sellers/i,
    pct: 0.70, basis: 'sellers_transacted_prev_month',
    rule: '70% of sellers who transacted last month (Plastic handles supply only)' },
  { key: 'existing_buyers', team: /plastic/i,
    match: /transaction\s+from\s+existing\s+buyers/i,
    pct: 0.60, basis: 'buyers_onboarded_cumulative_prev',
    rule: '60% of buyers onboarded up to the end of the previous month' },
  { key: 'new_buyers', team: null,
    match: /transaction\s+from\s+new\s+onboarded\s+buyers/i,
    pct: 0.20, basis: 'buyers_onboarded_this_month',
    rule: '20% of buyers onboarded during this month' }
];
function derivedRuleFor_(kraName, teamName) {
  var name = String(kraName == null ? '' : kraName);
  var team = String(teamName == null ? '' : teamName);
  for (var i = 0; i < DERIVED_RULES.length; i++) {
    var r = DERIVED_RULES[i];
    if (!r.match.test(name)) continue;
    if (r.team && !r.team.test(team)) continue;
    return r;
  }
  return null;
}
function periodAtOrAfter_(periodId, fromId) {
  return String(periodId) >= String(fromId);
}
function derivedTarget_(kraName, periodId, basis, teamName) {
  var r = derivedRuleFor_(kraName, teamName);
  if (!r) return null;
  if (String(periodId) === PERIOD_YTD) return null;
  if (!periodAtOrAfter_(periodId, DERIVED_FROM_PERIOD)) return null;
  var base = basis ? basis[r.basis] : null;
  base = num_(base);
  if (base === null || base < 0) return null;
  return { value: Math.ceil(base * r.pct), pct: r.pct, rule: r.rule,
           basis_key: r.basis, basis_value: base, key: r.key };
}

var PERIOD_YTD = 'ytd';
function ytdPeriodIds_(periods) {
  return periods.filter(function (p) { return String(p.status) !== 'upcoming'; })
                .map(function (p) { return String(p.id); });
}
function requireRealPeriod_(id) {
  if (String(id) === PERIOD_YTD) {
    throw new Error('Year to date is a read-only rollup across months. ' +
      'Pick a specific month before saving.');
  }
  return String(id);
}

var MONTH_NAMES_ = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
                    'August', 'September', 'October', 'November', 'December'];
function periodLabel_(p) {
  var m = String(p.id || '').match(/(\d{4})-(\d{2})$/);
  if (m) return MONTH_NAMES_[Number(m[2]) - 1] + ' ' + m[1];
  if (p.name instanceof Date) return MONTH_NAMES_[p.name.getMonth()] + ' ' + p.name.getFullYear();
  return String(p.name == null ? (p.id || '') : p.name);
}

// ===== SERVING =====
var FAVICON_URL = 'https://framerusercontent.com/images/KAa6VgdvV8bLALIzNxZGRkpVHbk.png';
// ===== DIAGNOSTICS OVER HTTP =====
// The ?diag=<name> allow list. Read-only functions only. Never add a writer
// (import*, apply*, refresh*, cleanup*, repoint*): a GET must not change data.
var DIAG_FUNCTIONS_ = {
  previewTargetImport: previewTargetImport,
  previewRatingScale: previewRatingScale,
  previewAchievementJoin: previewAchievementJoin,
  peekTimeline: peekTimeline,
  previewCollectionDays: previewCollectionDays,
  previewFrameworkRefresh: previewFrameworkRefresh,
  listTabsTargetSheet: listTabsTargetSheet,
  listTabsMMCT: listTabsMMCT,
  inspectAllSources: inspectAllSources,
  peekTargets: peekTargets,
  peekPOCData: peekPOCData,
  describeShipments: describeShipments,
  describePOCData: describePOCData,
  describeRawSellers: describeRawSellers,
  describeRawBuyers: describeRawBuyers,
  describeRawTransactions: describeRawTransactions,
  describeRawOBBuyers: describeRawOBBuyers,
  whoAmI: whoAmI,
  selfTest: selfTest,
  explainPerson: explainPerson,
  explainCoverage: explainCoverage,
  previewLeaverCleanup: previewLeaverCleanup,
  previewPlasticDSO: previewPlasticDSO,
  previewDsoAchievements: previewDsoAchievements,
  explainDso: explainDso,
  previewFeeds: previewFeeds,
  profileOnboarding: profileOnboarding,
  previewOnboardingAttribution: previewOnboardingAttribution,
  previewSellerTat: previewSellerTat,
  previewZohoReport: previewZohoReport,
  describeZohoTab: describeZohoTab,
  describeMetaBuyer: describeMetaBuyer,
  describeMetaSeller: describeMetaSeller,
  previewMetabase: previewMetabase,
  explainOnboardingOwners: explainOnboardingOwners,
  explainTeam: explainTeam,
  explainOMP: explainOMP,
  explainCollectionsTeam: explainCollectionsTeam,
  explainOnboardingTeam: explainOnboardingTeam,
  describeOmpTracker: describeOmpTracker,
  listTabsOmpTracker: listTabsOmpTracker,
  profileOmpTracker: profileOmpTracker,
  previewOmpTransit: previewOmpTransit,
  previewOmpDispatch: previewOmpDispatch,
  profileOmpCategoricals: profileOmpCategoricals,
  findBackends: findBackends,
  previewOmpTracking: previewOmpTracking
};

function diagText_(body) {
  return ContentService.createTextOutput(body)
    .setMimeType(ContentService.MimeType.TEXT);
}

// Needs the admin permission, and only names on DIAG_FUNCTIONS_ run.
function runDiag_(name, arg) {
  var nl = String.fromCharCode(10);
  var s;
  try { s = resolveSession_(null); }
  catch (e) { return diagText_('Cannot resolve a session: ' + (e && e.message || e)); }
  if (!can_(s, 'admin')) {
    return diagText_('Diagnostics need an admin role. You are ' +
      (s.email || 'not signed in') + ' (' + s.role_id + ').');
  }
  var fn = Object.prototype.hasOwnProperty.call(DIAG_FUNCTIONS_, name)
    ? DIAG_FUNCTIONS_[name] : null;
  if (typeof fn !== 'function') {
    return diagText_('"' + name + '" is not a diagnostic.' + nl + nl +
      'Available (all read-only):' + nl +
      Object.keys(DIAG_FUNCTIONS_).map(function (k) { return '  ' + k; }).join(nl) + nl + nl +
      'The functions that WRITE — importTargets, applyRatingScale,' + nl +
      'refreshFrameworkFromSource — are not reachable this way on purpose.' + nl +
      'Run those from the Apps Script editor, after their dry run.');
  }
  var out;
  try { out = fn(arg); }
  catch (e) {
    return diagText_(name + ' threw:' + nl + String(e && e.stack || e && e.message || e));
  }
  return diagText_(String(out == null ? '(no output)' : out));
}

function doGet(e) {
  var diag = e && e.parameter && e.parameter.diag;
  if (diag) return runDiag_(String(diag),
    (e.parameter.arg === undefined ? '' : String(e.parameter.arg)));
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle(APP_NAME + ' — Individual KRA / KPI Performance')
    .setFaviconUrl(FAVICON_URL)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

// ===== REPOSITORY =====
var _SS = null, _CACHE = {}, _DIRTY = {}, _TABS = {};

// An id that will not open is an error, never a cue to create a new database.
function ss_() {
  if (_SS) return _SS;
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty(PROP_DB);
  if (id) {
    try { _SS = SpreadsheetApp.openById(id); return _SS; }
    catch (e) {
      throw new Error('Cannot open the backend spreadsheet ' + id + ' — ' +
        (e && e.message || e) + '. Refusing to create a replacement: that ' +
        'would point the app at an empty database and overwrite the only ' +
        'record of where the real one is. Check the file still exists and is ' +
        'shared with this account, then reload. To move the app to a ' +
        'different backend, set ' + PROP_DB + ' deliberately.');
    }
  }
  var bound = null;
  try { bound = SpreadsheetApp.getActiveSpreadsheet(); } catch (e) {}
  _SS = bound || SpreadsheetApp.create(APP_NAME + ' — Backend');
  props.setProperty(PROP_DB, _SS.getId());
  return _SS;
}

function tab_(name) {
  if (_TABS[name]) return _TABS[name];
  var ss = ss_(), sh = ss.getSheetByName(name), head = SCHEMA[name], fresh = false;
  if (!sh) { sh = ss.insertSheet(name); fresh = true; }
  if (sh.getMaxColumns() < head.length) {
    sh.insertColumnsAfter(sh.getMaxColumns(), head.length - sh.getMaxColumns());
  }
  if (!fresh) {
    var first = sh.getRange(1, 1).getValue();
    fresh = String(first).trim() !== String(head[0]);
  }
  if (fresh) {
    sh.getRange(1, 1, 1, head.length).setValues([head]).setFontWeight('bold').setBackground('#F1F5F9');
    sh.setFrozenRows(1);
  }
  _TABS[name] = sh;
  return sh;
}

function read_(name) {
  if (_CACHE[name]) return _CACHE[name];
  var head = SCHEMA[name], rows = [];
  var sh; try { sh = tab_(name); } catch (e) { _CACHE[name] = rows; return rows; }
  var last = sh.getLastRow();
  if (last >= 2) {
    rows = sh.getRange(2, 1, last - 1, head.length).getValues()
      .filter(function (r) { return String(r[0]).trim() !== ''; })
      .map(function (r) { var o = {}; head.forEach(function (k, i) { o[k] = r[i]; }); return o; });
  }
  _CACHE[name] = rows;
  return rows;
}

function write_(name, objs) {
  _CACHE[name] = (objs || []).slice();
  _DIRTY[name] = true;
  return _CACHE[name].length;
}
function append_(name, obj) { read_(name).push(obj); _DIRTY[name] = true; return obj; }

function upsert_(name, obj) {
  var rows = read_(name), key = SCHEMA[name][0], id = String(obj[key]);
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i][key]) === id) { rows[i] = obj; _DIRTY[name] = true; return obj; }
  }
  rows.push(obj); _DIRTY[name] = true;
  return obj;
}
function del_(name, id) {
  var rows = read_(name), key = SCHEMA[name][0];
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i][key]) === String(id)) { rows.splice(i, 1); _DIRTY[name] = true; return true; }
  }
  return false;
}
function bulkUpdate_(name, objs) {
  if (!objs || !objs.length) return 0;
  var n = 0;
  objs.forEach(function (o) { upsert_(name, o); n++; });
  return n;
}

// Must run before an API function returns, or that request's writes are discarded.
function commit_() {
  var names = Object.keys(_DIRTY), written = 0;
  names.forEach(function (name) {
    var rows = _CACHE[name] || [], head = SCHEMA[name], sh = tab_(name);
    var need = rows.length + 1;
    if (sh.getMaxRows() < need) sh.insertRowsAfter(sh.getMaxRows(), need - sh.getMaxRows());
    if (rows.length && TEXT_COLS[name]) {
      TEXT_COLS[name].forEach(function (col) {
        var i = head.indexOf(col);
        if (i >= 0) sh.getRange(2, i + 1, rows.length, 1).setNumberFormat('@');
      });
    }
    if (rows.length) {
      sh.getRange(2, 1, rows.length, head.length).setValues(rows.map(function (o) {
        return head.map(function (k) { return o[k] == null ? '' : o[k]; });
      }));
    }
    var last = sh.getLastRow();
    if (last > rows.length + 1) {
      sh.getRange(rows.length + 2, 1, last - rows.length - 1, head.length).clearContent();
    }
    delete _DIRTY[name];
    written++;
  });
  return written;
}

function periodOr_(id) {
  if (id) return String(id);
  var set = read_(T.SETTINGS).filter(function (r) { return r.key === "current_period"; })[0];
  if (set && set.value) return String(set.value);
  var ps = read_(T.PERIODS).sort(function (a, b) { return num_(a.sort) - num_(b.sort); });
  if (ps.length) return String(ps[ps.length - 1].id);
  throw new Error("No period is defined, so there is nothing to write targets against.");
}

// ===== UTILITIES =====
function uid_(p) { return (p || 'id') + '-' + Utilities.getUuid().slice(0, 8); }
function nowIso_() { return new Date().toISOString(); }
function idx_(a) { var o = {}; a.forEach(function (x) { o[x.id] = x; }); return o; }
function num_(v) {
  if (v === null || v === undefined || v === '') return null;
  var n = typeof v === 'number' ? v : Number(String(v).replace(/[,\s%₹]/g, ''));
  return isFinite(n) ? n : null;
}
function slug_(s) { return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); }
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

// ===== BANDS =====
var EMPTY_BAND = /^(|-|--|—|–|n\/?a|na|nil|tbd)$/i;

function bandIsRelative_(s) {
  return /(^|[^A-Za-z])T\s*[+\-]\s*\d/i.test(s) || /on\s*time/i.test(s) || /as\s+per\b/i.test(s);
}
function bandValue_(raw) {
  var s = String(raw == null ? '' : raw).trim();
  if (EMPTY_BAND.test(s) || bandIsRelative_(s)) return null;
  s = s.replace(/[₹$,]/g, ' ');
  s = s.replace(/([A-Za-z])\s*-\s*/g, '$1 ');
  var range = s.match(/(\d+(?:\.\d+)?)\s*[–—]\s*(\d+(?:\.\d+)?)/) ||
              s.match(/(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)/);
  if (range) return (parseFloat(range[1]) + parseFloat(range[2])) / 2;
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
// Relative tolerance for band comparisons: 5.85 / 6.5 is 0.8999999999999999, not 0.9.
function bandEps_(b) { return Math.max(1e-9, Math.abs(b) * 1e-9); }
function atLeast_(a, b) { return a >= b - bandEps_(b); }
function atMost_(a, b) { return a <= b + bandEps_(b); }

// Highest band cleared, counting up from Target 1.
function levelFromBands_(parsed, actual) {
  if (parsed.kind !== 'numeric') return null;
  if (actual === null || actual === undefined || actual === '' || isNaN(Number(actual))) return null;
  var a = Number(actual), level = 0;
  for (var i = 0; i < 5; i++) {
    if (parsed.values[i] === null) break;
    var ok = parsed.direction === 'lower_is_better'
      ? atMost_(a, parsed.values[i]) : atLeast_(a, parsed.values[i]);
    if (ok) level = i + 1; else break;
  }
  return level;
}
function normaliseWeights_(list) {
  var sum = 0, i;
  for (i = 0; i < list.length; i++) sum += (num_(list[i]) || 0);
  var scale = (sum > 0 && sum <= 1.5) ? 100 : 1, out = [];
  for (i = 0; i < list.length; i++) out.push(Math.round((num_(list[i]) || 0) * scale * 100) / 100);
  return out;
}

// ===== SESSION & AUTHORIZATION =====
var ROLE_PERMS = {
  super_admin: ['*'],
  hr_admin: ['view', 'edit_target', 'edit_framework', 'enter_actual', 'admin', 'export'],
  business_head: ['view', 'edit_target', 'edit_framework', 'enter_actual', 'export'],
  team_leader: ['view', 'edit_target', 'enter_actual', 'export'],
  manager: ['view', 'enter_actual', 'export'],
  employee: ['view', 'enter_own'],
  auditor: ['view', 'export'],
  no_access: []
};
// Normalised before every comparison: strips mailto: and all whitespace.
function email_(v) {
  return String(v == null ? '' : v).replace(/^\s*mailto:/i, '').replace(/\s+/g, '').toLowerCase();
}
function openAccessState_() {
  var raw = '';
  try { raw = String(PropertiesService.getScriptProperties().getProperty(PROP_OPEN) || '').trim(); }
  catch (e) {}
  if (!raw) return { on: false };
  if (/^(always|true|on|yes)$/i.test(raw)) return { on: true, until: null, raw: raw };
  var t = Date.parse(raw);
  if (isNaN(t)) return { on: false, raw: raw, bad: true };
  return { on: Date.now() < t, until: raw, raw: raw, expired: Date.now() >= t };
}
function bootstrapAdmins_() {
  var raw = '';
  try { raw = PropertiesService.getScriptProperties().getProperty(PROP_ADMINS) || ''; } catch (e) {}
  return String(raw).split(/[,;\s]+/).map(email_).filter(function (x) { return x !== ''; });
}
function currentEmail_() {
  try { return email_(Session.getActiveUser().getEmail() || Session.getEffectiveUser().getEmail() || ''); }
  catch (e) { return ''; }
}
// USERS.email, then EMPLOYEES.email, otherwise no_access.
// PERFORMOS_ADMINS and PERFORMOS_OPEN_ACCESS then override to super_admin.
function resolveSession_(viewAs) {
  ensureSeeded_();
  var emps = read_(T.EMPLOYEES), users = read_(T.USERS), email = currentEmail_();

  var acct = null, me = null;
  if (email) {
    users.forEach(function (u) { if (email_(u.email) === email) acct = u; });
    emps.forEach(function (e) { if (email_(e.email) === email) me = e; });
  }
  if (acct && acct.employee_id && !me) me = idx_(emps)[acct.employee_id] || null;

  var role = acct ? String(acct.role_id || 'no_access')
           : me   ? (me.status === 'lead' ? 'team_leader' : 'employee')
           :        'no_access';
  if (!ROLE_PERMS[role]) role = 'no_access';
  if (email && bootstrapAdmins_().indexOf(email) >= 0) role = 'super_admin';
  var open_ = openAccessState_();
  if (open_.on && email) role = 'super_admin';

  var s = { email: email || '(unknown)',
            name: (acct && acct.name) || (me && me.name) || email || 'Unrecognised user',
            role_id: role,
            employee_id: (acct && acct.employee_id) || (me && me.id) || '' };
  s.admin = can_(s, 'admin');
  s.can_switch = s.admin;
  s.users = s.can_switch ? users : [];
  s.open_access = open_.on ? (open_.until || 'always') : null;

  if (viewAs && s.can_switch) {
    var u = users.filter(function (x) { return String(x.id) === String(viewAs); })[0];
    if (u) {
      s.role_id = String(u.role_id || 'no_access');
      if (!ROLE_PERMS[s.role_id]) s.role_id = 'no_access';
      s.employee_id = u.employee_id || ''; s.name = u.name;
    }
  }
  s.perms = (ROLE_PERMS[s.role_id] || []).slice();
  s.scope = (s.role_id === 'super_admin' || s.role_id === 'hr_admin' || s.role_id === 'business_head')
    ? { kind: 'all' }
    : (s.role_id === 'team_leader' || s.role_id === 'manager')
      ? { kind: 'team', team_id: (idx_(emps)[s.employee_id] || {}).team_id || '' }
      : (s.employee_id ? { kind: 'self' } : { kind: 'none' });
  s._byId = idx_(emps);
  return s;
}
function can_(s, action) {
  var p = ROLE_PERMS[s.role_id] || [];
  return p.indexOf('*') >= 0 || p.indexOf(action) >= 0;
}
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

// ===== MODEL =====
function buildModel_(periodId) {
  ensureSeeded_();
  var periods = read_(T.PERIODS).sort(function (a, b) { return num_(a.sort) - num_(b.sort); });
  periods.forEach(function (p) {
    var want = periodLabel_(p);
    if (String(p.name) !== want) { p.name = want; _DIRTY[T.PERIODS] = true; }
  });
  var nowD = new Date(), nowM = nowD.getMonth() + 1;
  var nowId = 'per_' + nowD.getFullYear() + '-' + (nowM < 10 ? '0' + nowM : nowM);
  periods.forEach(function (p) {
    if (String(p.status) === 'upcoming' && String(p.id) <= nowId) {
      p.status = 'open'; _DIRTY[T.PERIODS] = true;
    }
  });
  var settings = {};
  read_(T.SETTINGS).forEach(function (r) {
    var v = r.value; try { v = JSON.parse(r.value); } catch (e) {}
    settings[r.key] = v;
  });
  var eff = periodId || settings.current_period || (periods.length ? periods[periods.length - 1].id : '');

  var teams = read_(T.TEAMS);
  var allEmps = read_(T.EMPLOYEES);
  var emps = allEmps.filter(function (e) { return !isLeaver_(e.name); });
  var goneIds = {};
  allEmps.forEach(function (e) { if (isLeaver_(e.name)) goneIds[String(e.id)] = true; });
  var kras = read_(T.KRAS), kpis = read_(T.KPIS);
  var assigns = read_(T.ASSIGN).filter(function (a) {
    return String(a.status || 'Active') !== 'Inactive' && !goneIds[String(a.employee_id)]; });
  var spanIds = (String(eff) === PERIOD_YTD) ? ytdPeriodIds_(periods) : [String(eff)];
  var ytd = String(eff) === PERIOD_YTD;
  var inSpan = {};
  spanIds.forEach(function (id) { inSpan[id] = true; });
  var targets = read_(T.TARGETS).filter(function (t) { return !!inSpan[String(t.period_id)]; });
  var perf = read_(T.PERF).filter(function (p) { return !!inSpan[String(p.period_id)]; });
  var allPlans = read_(T.PLAN);
  var plans = allPlans.filter(function (p) { return !!inSpan[String(p.period_id)]; });
  // Does this person+KPI have a target in ANY month? Decides whether a bare number is a quantity or a rate.
  var planEver = {};
  allPlans.forEach(function (p) {
    if (num_(p.target_value) === null) return;
    planEver[String(p.employee_id) + '|' + String(p.kpi_id)] = true;
  });

  var tgtBy = {}, perfBy = {}, planBy = {};
  targets.forEach(function (t) { tgtBy[t.period_id + '|' + t.employee_id + '|' + t.kpi_id] = t; });
  perf.forEach(function (p) { perfBy[p.period_id + '|' + p.employee_id + '|' + p.kpi_id] = p; });
  plans.forEach(function (p) { planBy[p.period_id + '|' + p.employee_id + '|' + p.kpi_id] = p; });
  var kpiById = idx_(kpis);
  var empById_ = idx_(allEmps), kraById_ = idx_(kras);

// Across months, target-driven quantities SUM and durations/rates AVERAGE. The KPI name is not the first test.
function aggKind_(unit, kpiName, parsed, hasTarget) {
  var u = String(unit || '').toLowerCase();
  var k = String(kpiName || '');
  var isRatio = !!(parsed && parsed.kind === 'numeric' && isRatioLadder_(parsed.values).ok);
  if (hasTarget && isRatio) return 'sum';
  if (u === 'days' || u === 'day') return 'mean';
  if (parsed && parsed.kind === 'numeric' && parsed.direction === 'lower_is_better') return 'mean';
  if (/\b(days?|dso|tat|ageing|aging)\b/i.test(k)) return 'mean';
  if (/(\brate\b|%|\bpercent)/i.test(k)) return 'mean';
  return 'sum';
}

  var rows = [], byEmp = {};
  assigns.forEach(function (a) {
    var kpi = kpiById[a.kpi_id] || {};
    var levels = [], parsed = null, actual = null, manual = null, version = null, status = '';
    var planSum = null, planUnit = '', planSrc = '', planRule = '', planMonths = 0;
    var ratio = null;
    var actualNote = '';
    var noTargetMonths = 0;
    var monthly = {};
    var actSum = null, actMonths = 0;
    for (var i = 0; i < spanIds.length; i++) {
      var key = spanIds[i] + '|' + a.employee_id + '|' + a.kpi_id;
      var t = tgtBy[key], p = perfBy[key], pl = planBy[key];
      if (pl) {
        var pv = num_(pl.target_value);
        if (pv !== null) {
          planSum = (planSum === null ? 0 : planSum) + pv;
          planMonths++;
        }
        planUnit = pl.unit || planUnit;
        planSrc = pl.source || planSrc;
        planRule = pl.rule || planRule;
      }
      var pr = parseBands_(t ? [t.t1, t.t2, t.t3, t.t4, t.t5] : ['', '', '', '', '']);
      var act = p ? num_(p.actual) : null;
      var man = p ? num_(p.manual_level) : null;
      var monthTarget = pl ? num_(pl.target_value) : null;
      var scored = act;
      var isRatioL = pr.kind === 'numeric' && isRatioLadder_(pr.values).ok;
      if (act !== null && monthTarget !== null && monthTarget !== 0 && isRatioL) {
        scored = act / monthTarget;
        ratio = Math.round(scored * 10000) / 10000;
      }
      if (act !== null) { actSum = (actSum === null ? 0 : actSum) + act; actMonths++; }
      if (spanIds.length > 1 && (monthTarget !== null || act !== null)) {
        monthly[spanIds[i]] = { target: monthTarget, actual: act };
      }
      // A ratio ladder with no target this month is not scored, unless the KPI never has one (then the number IS the rate).
      var targetless = isRatioL && (monthTarget === null || monthTarget === 0) &&
                       act !== null &&
                       !!planEver[String(a.employee_id) + '|' + String(a.kpi_id)];
      if (targetless) noTargetMonths++;
      var lvl = (pr.kind === 'numeric' && !targetless)
        ? levelFromBands_(pr, scored) : (man === null ? null : man);
      if (lvl !== null && lvl !== undefined) levels.push(lvl);
      if (t || !parsed) parsed = pr;
      if (t) version = num_(t.version) || 1;
      actual = act; manual = man; status = p ? (p.status || '') : status;
      if (p && p.note) {
        actualNote = String(p.note);
        if (monthly[spanIds[i]]) monthly[spanIds[i]].note = actualNote;
      }
    }
    var agg = aggKind_(planUnit, kpi.name, parsed, planSum !== null && planSum !== 0);
    var ytdActual = null;
    if (actSum !== null) {
      ytdActual = (agg === 'mean' && actMonths > 0) ? actSum / actMonths : actSum;
      ytdActual = Math.round(ytdActual * 1e10) / 1e10;
    }
    var planAgg = planSum;
    if (ytd && agg === 'mean' && planSum !== null && planMonths > 0) {
      planAgg = planSum / planMonths;
    }
    var level = null, ytdBasis = '';
    if (ytd && ytdActual !== null && planSum !== null && planSum !== 0 &&
        parsed.kind === 'numeric' && isRatioLadder_(parsed.values).ok) {
      var ytdRatio = ytdActual / planSum;
      ratio = Math.round(ytdRatio * 10000) / 10000;
      level = levelFromBands_(parsed, ytdRatio);
      ytdBasis = 'year_ratio';
    } else if (levels.length) {
      level = ytd
        ? Math.round(levels.reduce(function (x, y) { return x + y; }, 0) / levels.length * 100) / 100
        : levels[0];
      if (ytd) ytdBasis = 'mean_of_monthly_levels';
    }
    var ovr = weightOverride_((empById_[a.employee_id] || {}).name,
                              (kraById_[a.kra_id] || {}).name);
    // Same condition as the scoring: a never-planned ratio KPI is a rate, shown as %.
    if (!planEver[String(a.employee_id) + '|' + String(a.kpi_id)] &&
        parsed && parsed.kind === 'numeric' && isRatioLadder_(parsed.values).ok) {
      planUnit = 'ratio';
    }
    var row = {
      employee_id: a.employee_id, kra_id: a.kra_id, kpi_id: a.kpi_id,
      assignment_id: a.id,
      weightage: ovr === null ? (num_(a.weightage) || 0) : ovr,
      weightage_source: ovr === null ? '' : 'override',
      kpi: kpi.name || '', goal: kpi.goal || '', source: kpi.source || '', unit: kpi.unit || '',
      bands: parsed.display, kind: parsed.kind, direction: parsed.direction,
      values: parsed.values, band_note: parsed.note || '',
      target_version: version,
      // Rounded at 1e10, not 1e4: the Target Sheet holds 8 decimals of a crore.
      plan_target: planAgg === null ? null : Math.round(planAgg * 1e10) / 1e10,
      plan_agg: agg,
      plan_unit: planUnit,
      plan_source: planSrc,
      plan_rule: planRule,
      plan_months: ytd ? planMonths : null,
      actual: ytd ? ytdActual : actual,
      agg_kind: ytd ? agg : '',
      no_target_months: noTargetMonths,
      monthly: spanIds.length > 1 ? monthly : null,
      actual_months: ytd ? actMonths : null,
      ytd_basis: ytdBasis,
      ratio: ratio,
      actual_note: actualNote,
      manual_level: ytd ? null : manual,
      level: level,
      months_scored: ytd ? levels.length : null,
      months_total: ytd ? spanIds.length : null,
      status: status
    };
    rows.push(row);
    (byEmp[a.employee_id] = byEmp[a.employee_id] || []).push(row);
  });

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
    ok: true, period_id: eff, ytd: ytd, ytd_periods: ytd ? spanIds : null,
    periods: periods, settings: settings,
    teams: teams, employees: emps, kras: kras, kpis: kpis,
    rows: rows, overalls: overalls,
    audit: read_(T.AUDIT).sort(function (a, b) { return String(b.ts).localeCompare(String(a.ts)); }).slice(0, 40),
    source_sheet_id: SOURCE_SHEET_ID,
    generated_at: nowIso_()
  };
}

// ===== SCOPE FILTER =====
function visibleEmployees_(m, s) {
  var sc = (s && s.scope) || { kind: 'none' };
  if (sc.kind === 'all') return null;
  var ok = {};
  if (sc.kind === 'team') {
    (m.employees || []).forEach(function (e) {
      if (String(e.team_id) === String(sc.team_id)) ok[String(e.id)] = true;
    });
  } else if (sc.kind === 'self' && s.employee_id) {
    ok[String(s.employee_id)] = true;
  }
  return ok;
}
// Reassign, never splice: these arrays are the _CACHE, and splicing them deletes sheet rows on commit_().
function scopeModel_(m, s) {
  var ok = visibleEmployees_(m, s);
  if (!ok) { m.scoped = false; return m; }
  function keep(id) { return !!ok[String(id)]; }
  m.employees = (m.employees || []).filter(function (e) { return keep(e.id); });
  m.rows      = (m.rows || []).filter(function (r) { return keep(r.employee_id); });
  var overalls = {};
  Object.keys(m.overalls || {}).forEach(function (id) {
    if (keep(id)) overalls[id] = m.overalls[id];
  });
  m.overalls = overalls;
  var seen = {};
  m.employees.forEach(function (e) { seen[String(e.team_id)] = true; });
  m.teams = (m.teams || []).filter(function (t) { return seen[String(t.id)]; });
  var ids = Object.keys(ok);
  m.audit = (m.audit || []).filter(function (a) {
    var eid = String(a.entity_id || '');
    for (var i = 0; i < ids.length; i++) if (eid.indexOf(ids[i]) >= 0) return true;
    return false;
  });
  m.scoped = true;
  m.scope_kind = (s && s.scope && s.scope.kind) || 'none';
  return m;
}

// ===== API =====
function apiBootstrap(periodId, viewAs) {
  try {
    // Open the database first: read_() would otherwise hide a failure as empty tables.
    ss_();
    var s = resolveSession_(viewAs);
    if (!can_(s, 'view')) {
      commit_();
      return { ok: false, where: 'apiBootstrap', denied: true,
               error: 'This dashboard is not open to ' + s.email + '. Ask an administrator to add ' +
                      'your address to the USERS tab (for an admin role) or to your EMPLOYEES row.' };
    }
    var _m = buildModel_(periodId); commit_();
    return jsonSafe_({ ok: true, model: scopeModel_(_m, s), users: s.users,
      session: { email: s.email, name: s.name, role_id: s.role_id, employee_id: s.employee_id,
                 admin: s.admin, can_switch: s.can_switch, perms: s.perms, scope: s.scope } });
  } catch (e) {
    return { ok: false, error: String(e && e.message || e), where: 'apiBootstrap',
             stack: String(e && e.stack || '').split('\n').slice(0, 4).join(' | ') };
  }
}
function apiModel(periodId) {
  try {
    ss_();
    var s = resolveSession_();
    if (!can_(s, 'view')) {
      commit_();
      return { ok: false, where: 'apiModel', denied: true,
               error: 'This dashboard is not open to ' + s.email + '.' };
    }
    var m = buildModel_(periodId); commit_(); return jsonSafe_({ ok: true, model: scopeModel_(m, s) }); }
  catch (e) { return { ok: false, error: String(e && e.message || e), where: 'apiModel' }; }
}

var COL_HINTS = [
  ['onboarding', /onboard|kyc|vendor|registration|osv|document|activation/i],
  ['transaction', /transaction|order|deal|invoice|dncn|debit|credit|pod|dispatch/i],
  ['quantity',   /\bqty\b|quantity|volume|weight|tonn|\bmt\b|\bkg\b|gmv|amount|value/i],
  ['month/date', /month|date|period|created|dispatch(ed)?[_ ]?on|delivered/i],
  ['person',     /owner|executive|manager|assign|responsible|spoc|poc|\bby\b|employee|user|sales/i],
  ['status',     /status|state|stage/i]
];
function colHints_(headers) {
  var hit = {};
  headers.forEach(function (hd) {
    var norm = String(hd).replace(/[_\-.\/]+/g, ' ');
    COL_HINTS.forEach(function (p) { if (p[1].test(norm)) hit[p[0]] = true; });
  });
  return Object.keys(hit);
}

function inspectWorkbook(sheetId) {
  var ID = sheetId || SHIPMENTS_SHEET_ID, out = [], src;
  try { src = SpreadsheetApp.openById(ID); }
  catch (e) {
    return 'Cannot open ' + ID + '. The account this runs as needs access.  (' +
           (e && e.message || e) + ')';
  }
  var sheets = src.getSheets();
  out.push('Workbook : ' + src.getName());
  out.push('Id       : ' + ID);
  out.push('Tabs     : ' + sheets.length);
  out.push('');
  sheets.forEach(function (sh, i) {
    var lastR = sh.getLastRow(), lastC = sh.getLastColumn();
    out.push('[' + (i + 1) + '] ' + sh.getName() +
      '   ' + Math.max(0, lastR - 1) + ' data rows x ' + lastC + ' cols' +
      (sh.isSheetHidden() ? '   (hidden)' : ''));
    if (lastR < 1 || lastC < 1) { out.push('      (empty)'); return; }
    var head = sh.getRange(1, 1, 1, Math.min(lastC, 60)).getValues()[0]
      .map(function (v) { return String(v == null ? '' : v).trim(); });
    var named = head.filter(function (x) { return x !== ''; });
    var hints = colHints_(named);
    out.push('      carries : ' + (hints.length ? hints.join(', ') : '(nothing recognised)'));
    out.push('      headers : ' + (named.length ? named.join(' | ') : '(row 1 is blank)'));
  });
  out.push('');
  out.push('Next: inspectTab("<tab name>") for a column-by-column profile of one tab.');
  var txt = out.join(String.fromCharCode(10));
  Logger.log(txt);
  return txt;
}

// ===== ONE-CLICK INSPECTORS =====
function listTabsTargetSheet() { return inspectTabList(TARGETS_SHEET_ID); }
function listTabsMMCT()        { return inspectTabList(SHIPMENTS_SHEET_ID); }

function peekMetals()            { return peekTab('Metals', 'target', 14, 12); }
function peekPlastics()          { return peekTab('Plastics', 'target', 14, 13); }
function peekEmployeeDirectory() { return peekTab('Employee Directory', 'target', 14, 6); }
function peekSellerOnboarding()  { return peekTab('seller onboarding', 'target', 6, 20); }
function peekOverallShipments()  { return peekTab('overall shipments', 'target', 6, 20); }
function peekRawPOCTargets()     { return peekTab('Raw_POC_Targets', 'mmct', 6, 22); }
function peekRawTransactions()   { return peekTab('Raw_Transactions', 'mmct', 8, 16); }
function peekRawOBBuyers()       { return peekTab('Raw_OB_Buyers', 'mmct', 6, 20); }
function peekPOCData()           { return peekTab('POC_data', 'mmct', 14, 6); }
function peekRawShipments()      { return peekTab('Raw_Shipments', 'mmct', 6, 20); }
function peekRawSellers()        { return peekTab('Raw_Sellers', 'mmct', 6, 20); }
function peekRawBuyers()         { return peekTab('Raw_Buyers', 'mmct', 6, 20); }
function peekSupplyTeamInput()   { return peekTab('Supply_team_input', 'mmct', 8, 18); }
function peekDemandTeamInput()   { return peekTab('Demand_team_input', 'mmct', 8, 18); }

function inspectTab(tabName, sheetId) {
  var ID = sheetId || SHIPMENTS_SHEET_ID, TAB = tabName || SHIPMENTS_TAB;
  var out = [], src;
  try { src = SpreadsheetApp.openById(ID); }
  catch (e) {
    return 'Cannot open ' + ID + '. The account this runs as needs access.  (' +
           (e && e.message || e) + ')';
  }
  out.push('Workbook : ' + src.getName());
  out.push('Tabs     : ' + src.getSheets().map(function (sh) {
    return sh.getName() + ' [' + sh.getLastRow() + 'r x ' + sh.getLastColumn() + 'c]';
  }).join('  |  '));
  var sh = findSheet_(src, TAB);
  if (!sh) { out.push(''); out.push('No tab matching "' + TAB + '". Tabs: ' +
    src.getSheets().map(function (x) { return x.getName(); }).join(' | '));
    return out.join('\n'); }

  var lastR = sh.getLastRow(), lastC = sh.getLastColumn();
  var CAP = 4000;
  var nRows = Math.max(0, Math.min(lastR - 1, CAP));
  out.push('');
  out.push('Tab "' + TAB + '": ' + (lastR - 1) + ' data rows x ' + lastC + ' columns' +
    (lastR - 1 > CAP ? '   (profiling the first ' + CAP + ')' : ''));
  if (nRows < 1) { out.push('No data rows.'); return out.join('\n'); }

  var head = sh.getRange(1, 1, 1, lastC).getValues()[0].map(function (v) {
    return String(v == null ? '' : v).trim(); });
  var data = sh.getRange(2, 1, nRows, lastC).getValues();

  var statusCol = -1;
  for (var i = 0; i < head.length; i++) {
    if (/shipment[_ ]?status/i.test(head[i])) { statusCol = i; break; }
  }
  if (statusCol < 0) for (i = 0; i < head.length; i++) {
    if (/status/i.test(head[i])) { statusCol = i; break; }
  }

  out.push('');
  out.push('COLUMNS — index, header, filled count, and what it holds');
  for (i = 0; i < lastC; i++) {
    var filled = 0, distinct = {}, nDistinct = 0, kinds = {};
    for (var r = 0; r < data.length; r++) {
      var v = data[r][i];
      if (v === '' || v === null || v === undefined) continue;
      filled++;
      kinds[v instanceof Date ? 'date' : typeof v] = 1;
      var k = String(v).slice(0, 60);
      if (!distinct[k] && nDistinct < 200) { distinct[k] = 0; nDistinct++; }
      if (distinct[k] !== undefined) distinct[k]++;
    }
    var keys = Object.keys(distinct);
    var samples = keys.slice(0, 4).map(function (k) { return '"' + k.slice(0, 34) + '"'; }).join(', ');
    out.push('  [' + (i < 10 ? ' ' : '') + i + '] ' + (head[i] || '(blank header)') +
      (i === statusCol ? '   <== STATUS COLUMN' : ''));
    out.push('        filled ' + filled + '/' + data.length +
      '   types: ' + (Object.keys(kinds).join('/') || '-') +
      '   distinct: ' + (nDistinct >= 200 ? '200+' : nDistinct));
    out.push('        e.g. ' + (samples || '(all blank)'));
  }

  if (statusCol >= 0) {
    var dist = {}, keep = 0, drop = 0;
    for (r = 0; r < data.length; r++) {
      var sv = String(data[r][statusCol] == null ? '' : data[r][statusCol]).trim();
      dist[sv || '(blank)'] = (dist[sv || '(blank)'] || 0) + 1;
      if (shipmentExcluded_(sv)) drop++; else keep++;
    }
    out.push('');
    out.push('STATUS distribution (column ' + statusCol + ', "' + head[statusCol] + '")');
    Object.keys(dist).sort(function (a, b) { return dist[b] - dist[a]; }).forEach(function (k) {
      out.push('  ' + String(dist[k]).padStart(6) + '  ' + k +
        (shipmentExcluded_(k) ? '   <== EXCLUDED' : ''));
    });
    out.push('  ---');
    out.push('  ' + String(keep).padStart(6) + '  kept');
    out.push('  ' + String(drop).padStart(6) + '  excluded by SHIPMENTS_EXCLUDE_STATUS');
  } else {
    out.push('');
    out.push('No status-like column on this tab — the Cancelled exclusion does not apply here.');
  }

  out.push('');
  out.push('FIRST 2 ROWS THAT SURVIVE THE EXCLUSION');
  var shown = 0;
  for (r = 0; r < data.length && shown < 2; r++) {
    if (statusCol >= 0 && shipmentExcluded_(data[r][statusCol])) continue;
    shown++;
    out.push('  --- row ' + (r + 2) + ' ---');
    for (i = 0; i < lastC; i++) {
      var val = data[r][i];
      if (val === '' || val === null || val === undefined) continue;
      out.push('    ' + (head[i] || '[' + i + ']') + ' = ' +
        (val instanceof Date ? val.toISOString() : String(val).slice(0, 70)));
    }
  }
  if (!shown) out.push('  (none survived)');

  var txt = out.join(String.fromCharCode(10));
  Logger.log(txt);
  return txt;
}

function findSheet_(src, name) {
  var exact = src.getSheetByName(name);
  if (exact) return exact;
  var needle = String(name || '').trim().toLowerCase();
  if (!needle) return null;
  var hit = null;
  src.getSheets().forEach(function (sh) {
    if (hit) return;
    if (String(sh.getName()).toLowerCase().indexOf(needle) >= 0) hit = sh;
  });
  return hit;
}

function peekTab(tabName, which, howManyRows, howManyCols) {
  var ID = (!which || /target/i.test(which)) ? TARGETS_SHEET_ID
         : /mmct|shipment|dashboard/i.test(which) ? SHIPMENTS_SHEET_ID : which;
  var ROWS = howManyRows || 14, COLS = howManyCols || 14;
  var out = [], src;
  try { src = SpreadsheetApp.openById(ID); }
  catch (e) { return 'Cannot open ' + ID + '  (' + (e && e.message || e) + ')'; }
  var sh = findSheet_(src, tabName);
  if (!sh) {
    return 'No tab matching "' + tabName + '" in ' + src.getName() + '. Tabs: ' +
      src.getSheets().map(function (x) { return x.getName(); }).join(' | ');
  }
  var lastR = sh.getLastRow(), lastC = sh.getLastColumn();
  out.push(src.getName() + '  ->  ' + tabName +
    '   (' + lastR + ' rows x ' + lastC + ' cols, showing ' +
    Math.min(ROWS, lastR) + 'x' + Math.min(COLS, lastC) + ')');
  if (lastR < 1 || lastC < 1) { out.push('(empty)'); return out.join('\n'); }
  var grid = sh.getRange(1, 1, Math.min(ROWS, lastR), Math.min(COLS, lastC)).getValues();
  out.push('');
  for (var r = 0; r < grid.length; r++) {
    var cells = [];
    for (var c = 0; c < grid[r].length; c++) {
      var v = grid[r][c];
      if (v === '' || v === null || v === undefined) { cells.push('c' + c + '=·'); continue; }
      if (v instanceof Date) v = v.toISOString().slice(0, 10);
      cells.push('c' + c + '=' + String(v).replace(/\s+/g, ' ').slice(0, 22));
    }
    out.push('r' + (r + 1) + (r < 9 ? ' ' : '') + '  ' + cells.join('  '));
  }
  if (lastC > COLS) out.push('');
  if (lastC > COLS) out.push('(' + (lastC - COLS) + ' more columns to the right — ' +
    'call peekTab("' + tabName + '", null, ' + ROWS + ', ' + lastC + ') to see them)');
  var txt = out.join(String.fromCharCode(10));
  Logger.log(txt);
  return txt;
}

// ===== TARGET SHEET MATCHING =====
// Stripped one at a time from the end of a KRA label. DAYS is deliberately absent: 'DSO Days' is a real KRA.
var KRA_UNIT_WORDS_ = ['CR', 'CRS', 'CRORE', 'CRORES', 'RS', 'INR',
                       'MT', 'KG', 'NOS', 'COUNT', 'PCT', 'PERCENT'];
function kraKey_(v) {
  var t = normName_(v), prev = null;
  while (t && t !== prev) {
    prev = t;
    var parts = t.split(' ');
    if (parts.length < 2) break;
    var last = parts[parts.length - 1];
    if (/^[0-9]+(\.[0-9]+)?$/.test(last) || KRA_UNIT_WORDS_.indexOf(last) >= 0) {
      t = parts.slice(0, -1).join(' ');
    }
  }
  return t;
}

function targetUnit_(kraLabel) {
  var t = normName_(kraLabel);
  if (/\b(CR|CRS|CRORE|CRORES)\b/.test(t)) return 'Cr';
  if (/\bMT\b/.test(t)) return 'MT';
  if (/\bKG\b/.test(t)) return 'Kg';
  if (/\bDAYS?\b/.test(t)) return 'days';
  return 'count';
}

function planId_(empId, kpiId, periodId) {
  return 'pl_' + empId + '_' + kpiId + '_' + periodId;
}

function targetMatchCtx_() {
  var ctx = {
    emps: read_(T.EMPLOYEES), kras: read_(T.KRAS), assigns: read_(T.ASSIGN),
    teamById: idx_(read_(T.TEAMS)), empByName: {}, kraByKey: {}, assignByEmpKra: {},
    warnings: []
  };
  ctx.emps.forEach(function (e) { ctx.empByName[normName_(e.name)] = e; });
  ctx.kras.forEach(function (k) {
    var key = kraKey_(k.name);
    (ctx.kraByKey[key] = ctx.kraByKey[key] || []).push(k);
  });
  Object.keys(ctx.kraByKey).forEach(function (key) {
    var byTeam = {};
    ctx.kraByKey[key].forEach(function (k) {
      var t = String(k.team_id);
      if (byTeam[t] && byTeam[t] !== k.name) {
        ctx.warnings.push('two KRAs collapse to "' + key + '" in one team: "' +
          byTeam[t] + '" and "' + k.name + '"');
      }
      byTeam[t] = k.name;
    });
  });
  ctx.assigns.forEach(function (a) {
    ctx.assignByEmpKra[String(a.employee_id) + '|' + String(a.kra_id)] = a;
  });
  return ctx;
}

function mergeIsMean_(kraName, unit) {
  if (String(unit) === 'days') return true;
  return /(\bdays?\b|\bdso\b|\btat\b|\brate\b|%)/i.test(String(kraName || ''));
}
function addOrMerge_(res, byId, arr, field, rec, kraName, fromName) {
  var prev = byId[rec.id];
  if (!prev) { byId[rec.id] = rec; arr.push(rec); rec._src = [fromName]; return; }
  var a = num_(prev[field]), b = num_(rec[field]);
  if (a === null) { prev[field] = rec[field]; }
  else if (b !== null) {
    prev._n = (prev._n || 1) + 1;
    prev[field] = mergeIsMean_(kraName, prev.unit)
      ? Math.round((a * (prev._n - 1) + b) / prev._n * 1e6) / 1e6
      : Math.round((a + b) * 1e6) / 1e6;
  }
  prev._src = (prev._src || []).concat(fromName);
  res.merges.push(kraName + '  ' + rec.period_id.replace('per_', '') + '  ' +
    (prev._src || []).join(' + ') + '  -> ' + field + ' ' + prev[field] +
    (mergeIsMean_(kraName, prev.unit) ? '  (averaged)' : '  (added)'));
}

function matchTargetRow_(row, tab, months, ctx, res) {
  var e = ctx.empByName[canonPersonName_(row.name)];
  if (!e) { res.noEmp[row.name] = (res.noEmp[row.name] || 0) + 1; return; }
  res.okEmp++;

  var cand = ctx.kraByKey[kraKey_(row.kra)] || [];
  var k = null;
  for (var i = 0; i < cand.length; i++) {
    if (String(cand[i].team_id) === String(e.team_id)) { k = cand[i]; break; }
  }
  if (!k && cand.length === 1) k = cand[0];
  if (!k) { res.noKra[row.kra] = (res.noKra[row.kra] || 0) + 1; return; }
  res.okKra++;

  var a = ctx.assignByEmpKra[String(e.id) + '|' + String(k.id)];
  if (!a) {
    var kx = row.name + ' / ' + row.kra;
    res.noKpi[kx] = (res.noKpi[kx] || 0) + 1;
    return;
  }
  res.okKpi++;

  var teamName = (ctx.teamById[e.team_id] || {}).name || tab;
  var rule = derivedRuleFor_(row.kra, teamName);
  var unit = targetUnit_(row.kra);

  var kt = res.byKra[row.kra] || (res.byKra[row.kra] = { t: 0, a: 0, rows: 0, m: {} });
  kt.rows++;
  months.forEach(function (m) {
    var mm = kt.m[m.name] || (kt.m[m.name] = { t: 0, a: 0 });
    if (row.cells[m.period_id].target !== null) { kt.t++; mm.t++; }
    if (row.cells[m.period_id].achievement !== null) { kt.a++; mm.a++; }
  });
  months.forEach(function (m) {
    var ach = row.cells[m.period_id].achievement;
    if (ach === null) return;
    res.actuals++;
    addOrMerge_(res, res.perfById, res.perf, 'actual', {
      id: 'prf_' + e.id + '_' + a.kpi_id + '_' + m.period_id,
      employee_id: e.id, kpi_id: a.kpi_id, period_id: m.period_id,
      actual: ach, manual_level: '', level: '', kind: '', direction: '',
      note: 'Target Sheet, tab ' + tab + ' row ' + row.rowNo,
      status: 'recorded', updated_by: currentEmail_(), updated_at: nowIso_()
    }, row.kra, row.name);
  });
  months.forEach(function (m) {
    var v = row.cells[m.period_id].target;
    if (v === null) return;
    res.values++;
    // A rule's percentage typed where a count belongs (e.g. 0.5) is dropped, not imported.
    if (rule && Math.abs(v - rule.pct) < 1e-9) {
      res.pctLike.push(tab + ' r' + row.rowNo + ' ' + row.name + ' / ' + row.kra +
        ' / ' + m.name + ' = ' + v);
      return;
    }
    addOrMerge_(res, res.planById, res.plans, 'target_value', {
      id: planId_(e.id, a.kpi_id, m.period_id),
      employee_id: e.id, kpi_id: a.kpi_id, period_id: m.period_id,
      target_value: v, unit: unit, source: 'target_sheet',
      rule: 'typed in the Target Sheet, tab ' + tab + ' row ' + row.rowNo,
      basis_value: '', updated_by: currentEmail_(), updated_at: nowIso_()
    }, row.kra, row.name);
  });
}

// ===== TARGET SHEET IMPORT =====
// One function for the dry run and the write, so the preview is exactly what gets written.
function importTargetsFromSheet_(dryRun) {
  ensureSeeded_();
  var ctx = targetMatchCtx_(), out = [], src;
  try { src = SpreadsheetApp.openById(TARGETS_SHEET_ID); }
  catch (e) { return 'Cannot open the Target Sheet  (' + (e && e.message || e) + ')'; }

  var res = { rows: 0, values: 0, actuals: 0, okEmp: 0, okKra: 0, okKpi: 0,
              noEmp: {}, noKra: {}, noKpi: {}, pctLike: [],
              planById: {}, perfById: {}, merges: [],
              byKra: {} };
  res.plans = []; res.perf = [];
  ctx.warnings.forEach(function (w) { out.push('!! ' + w); });

  TARGET_TABS.forEach(function (tabName) {
    var sh = findSheet_(src, tabName);
    if (!sh) { out.push('!! no tab matching "' + tabName + '"'); return; }
    var t = readTargetTab_(sh);
    var before = { kra: res.okKra, kpi: res.okKpi, plans: res.plans.length };
    out.push('=== ' + t.tab + ' ===');
    out.push('  header row ' + t.headerRow + ', name col ' + t.nameCol +
      ', KRA col ' + t.kraCol + (t.subCol >= 0 ? ', sub-group col ' + t.subCol : ''));
    out.push('  months: ' + t.months.map(function (m) {
      return m.name + '->' + m.period_id;
    }).join('  '));
    t.warnings.forEach(function (w) { out.push('  !! ' + w); });
    t.rows.forEach(function (row) {
      res.rows++;
      matchTargetRow_(row, t.tab, t.months, ctx, res);
    });
    out.push('  ' + t.rows.length + ' KRA rows, ' + (res.okKra - before.kra) +
      ' KRAs matched, ' + (res.okKpi - before.kpi) + ' assigned to a KPI');
    out.push('  -> ' + (res.plans.length - before.plans) + ' target values');
    out.push('');
  });

  out.push('=== totals ===');
  out.push('  ' + res.rows + ' KRA rows: ' + res.okEmp + ' matched a person, ' +
    res.okKra + ' matched a KRA, ' + res.okKpi + ' reached a KPI');
  out.push('  ' + res.values + ' target values read, ' + res.plans.length +
    ' importable, ' + res.pctLike.length + ' dropped as a rule percentage');
  out.push('  ' + res.perf.length + ' ACHIEVEMENT values read');
  if (res.merges.length) {
    out.push('');
    out.push('  !! ' + res.merges.length + ' values MERGED — two source rows for one person:');
    res.merges.slice(0, 25).forEach(function (x) { out.push('     ' + x); });
    if (res.merges.length > 25) out.push('     ... and ' + (res.merges.length - 25) + ' more');
  }
  out.push('');
  out.push('  per KRA — rows, then target/achievement counts per month:');
  Object.keys(res.byKra).sort().forEach(function (k) {
    var v = res.byKra[k];
    out.push('    ' + (v.rows + ' rows').substr(0, 8) + '  t=' + v.t + '  a=' + v.a +
      (v.t > 0 && v.a === 0 ? '   <<< targets but NO achievements in the sheet' : '') +
      '   ' + k);
    var mk = Object.keys(v.m || {});
    if (mk.length) {
      out.push('              ' + mk.map(function (mn) {
        var x = v.m[mn];
        return mn.substr(0, 3) + ' t=' + x.t + ' a=' + x.a +
          (x.t === 0 && x.a === 0 ? ' (empty)' : '');
      }).join('   '));
    }
  });
  [['names NOT matching a person', res.noEmp],
   ['KRA labels NOT matching a KRA', res.noKra],
   ['person+KRA with no assignment, so no KPI to hang a target on', res.noKpi]
  ].forEach(function (pair) {
    var keys = Object.keys(pair[1]);
    out.push('  ' + pair[0] + ' (' + keys.length + '):');
    keys.slice(0, 15).forEach(function (x) { out.push('    "' + x + '"  x' + pair[1][x]); });
    if (keys.length > 15) out.push('    ... and ' + (keys.length - 15) + ' more');
  });
  out.push('  dropped as a rule percentage (' + res.pctLike.length + '), ' +
    'the derived rules supply these:');
  res.pctLike.slice(0, 6).forEach(function (x) { out.push('    ' + x); });
  if (res.pctLike.length > 6) out.push('    ... and ' + (res.pctLike.length - 6) + ' more');

  out.push('');
  out.push('  sample of what would be written:');
  res.plans.slice(0, 5).forEach(function (p) {
    out.push('    ' + p.employee_id + '  ' + p.kpi_id + '  ' + p.period_id +
      '  = ' + p.target_value + ' ' + p.unit);
  });

  out.push('');
  if (dryRun) {
    out.push('NOTHING WAS WRITTEN. This is a dry run. Run importTargets() to write.');
  } else {
    var had = read_(T.PLAN).filter(function (r) {
      return String(r.source) === 'target_sheet'; }).length;
    var hadP = read_(T.PERF).filter(function (r) {
      return /Target Sheet/.test(String(r.note)); }).length;
    res.plans.forEach(function (p) { upsert_(T.PLAN, p); });
    var kept = 0;
    res.perf.forEach(function (pf) {
      var prev = read_(T.PERF).filter(function (x) { return String(x.id) === pf.id; })[0];
      if (prev && !/Target Sheet/.test(String(prev.note))) { kept++; return; }
      upsert_(T.PERF, pf);
    });
    audit_(currentEmail_(), 'PLAN', 'target_sheet', 'import',
      had + ' typed targets, ' + hadP + ' achievements',
      res.plans.length + ' typed targets, ' + (res.perf.length - kept) + ' achievements',
      'imported from the Target Sheet');
    commit_();
    out.push('WRITTEN: ' + res.plans.length + ' rows upserted into PLAN ' +
      '(' + had + ' typed targets were there before).');
    out.push('WRITTEN: ' + (res.perf.length - kept) + ' achievements into PERFORMANCE' +
      (kept ? ' (' + kept + ' left alone — entered by hand in this app)' : '') + '.');
  }
  var txt = out.join(String.fromCharCode(10));
  Logger.log(txt);
  return txt;
}

function previewTargetImport() { return importTargetsFromSheet_(true); }

function importTargets() { return importTargetsFromSheet_(false); }

// ===== MM_CT SHIPMENTS AND POCS =====
var POC_TAB = 'POC_data';
// shipment_value is in rupees; GMV targets are in crore.
var RUPEES_PER_CRORE = 1e7;

function pad2_(n) { return (n < 10 ? '0' : '') + n; }

function periodIdFromDate_(v) {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date) {
    return 'per_' + v.getFullYear() + '-' + pad2_(v.getMonth() + 1);
  }
  var m = String(v).match(/^\s*(\d{4})-(\d{2})/);
  if (m) return 'per_' + m[1] + '-' + m[2];
  m = String(v).match(/^\s*(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})/);
  if (m) return 'per_' + m[3] + '-' + pad2_(Number(m[2]));
  return null;
}

function headerIndex_(headerRow) {
  var ix = {};
  headerRow.forEach(function (h, i) {
    var k = String(h == null ? '' : h).trim().toLowerCase();
    if (k && !(k in ix)) ix[k] = i;
  });
  return ix;
}

function readPocMap_(sh) {
  var out = { groups: [], sellerPoc: {}, buyerPoc: {}, pocNames: {}, warnings: [] };
  var lastR = sh.getLastRow(), lastC = sh.getLastColumn();
  if (lastR < 2) { out.warnings.push(POC_TAB + ' is empty'); return out; }
  var g = sh.getRange(1, 1, lastR, lastC).getValues();
  var hdr = -1;
  for (var r = 0; r < Math.min(6, lastR) && hdr < 0; r++) {
    for (var c = 0; c < lastC; c++) {
      if (/^\s*poc\s*$/i.test(String(g[r][c]))) { hdr = r; break; }
    }
  }
  if (hdr < 0) { out.warnings.push('no "POC" header found in ' + sh.getName()); return out; }

  for (var c2 = 1; c2 < lastC; c2++) {
    if (!/^\s*poc\s*$/i.test(String(g[hdr][c2]))) continue;
    var nameCol = c2 - 1;
    var label = String((hdr > 0 ? g[hdr - 1][nameCol] : '') || '').trim();
    var kind = /buyer/i.test(label) ? 'buyer' : /seller/i.test(label) ? 'seller' : '';
    var material = /plastic/i.test(label) ? 'Plastic' : /metal/i.test(label) ? 'Metal' : '';
    if (!kind) {
      var nh = String(g[hdr][nameCol] || '');
      kind = /buyer/i.test(nh) ? 'buyer' : /seller/i.test(nh) ? 'seller' : '';
    }
    if (!kind) { out.warnings.push('POC column ' + c2 + ' is neither seller nor buyer ("' + label + '")'); continue; }
    var map = (kind === 'buyer') ? out.buyerPoc : out.sellerPoc;
    var grp = { label: label, kind: kind, material: material,
                nameCol: nameCol, pocCol: c2, count: 0, clashes: [] };
    for (var r2 = hdr + 1; r2 < lastR; r2++) {
      var nm = normName_(g[r2][nameCol]), poc = String(g[r2][c2] || '').trim();
      if (!nm || !poc) continue;
      var key = material + '|' + nm;
      if (map[key] && normName_(map[key]) !== normName_(poc)) {
        grp.clashes.push(g[r2][nameCol] + ': ' + map[key] + ' vs ' + poc);
      }
      map[key] = poc;
      out.pocNames[normName_(poc)] = poc;
      grp.count++;
    }
    out.groups.push(grp);
  }
  out.headerRow = hdr + 1;
  return out;
}

// Keyed material|name, so a Metal shipment never lands on a Plastic POC.
function pocFor_(map, name, category) {
  var nm = normName_(name);
  if (!nm) return null;
  var cat = String(category || '').trim();
  if (cat && map[cat + '|' + nm]) return map[cat + '|' + nm];
  if (map['|' + nm]) return map['|' + nm];
  return null;
}

// ===== POC NAMES =====
// An explicit table, never a fuzzy matcher. Values must match EMPLOYEES.name exactly (the id is derived from it).
var POC_ALIASES = {
  'ADARSH KRISHNAN V': 'ADARSH KRISHNA',
  'ADARSH':            'ADARSH KRISHNA',
  'PANCHAL RISHI':     'RISHI PANCHAL',
  'ABHISEK SANYAL':    'ADARSH KRISHNA',
  'ABHISHEK SANYAL':   'ADARSH KRISHNA',
  'ABHISEK':           'ADARSH KRISHNA',
  'ABHISHEK':          'ADARSH KRISHNA'
};
var POC_IGNORE = ['NOMUL ARAVIND'];

// Hidden from the model, rows kept. Keyed by normName_, so list every spelling.
var EMPLOYEE_LEAVERS = {
  'ABHISEK SANYAL':  { left: '2026-09', handoverTo: 'ADARSH KRISHNA' },
  'ABHISHEK SANYAL': { left: '2026-09', handoverTo: 'ADARSH KRISHNA' },
  'MEGARAJ':         { left: '2026-09' },
  'MEGHRAJ':         { left: '2026-09' },
  'MEGHARAJ':        { left: '2026-09' },
  'RAJESWARI':       { left: '2026-09' },
  'RAJESHWARI':      { left: '2026-09' }
};
// Survives framework re-imports; a no-op once the workbook agrees.
var WEIGHTAGE_OVERRIDES = {
  'TABESH MOHAMMAD': {
    'WORKING CAPITAL MANAGEMENT': 10,
    'TRANSACTION FROM EXISTING SELLERS': 10,
    'TRANSACTION QUALITY': 5
  }
};
function weightOverride_(empName, kraName) {
  var byP = WEIGHTAGE_OVERRIDES[canonPersonName_(empName)];
  if (!byP) return null;
  var k = normName_(kraName);
  return Object.prototype.hasOwnProperty.call(byP, k) ? byP[k] : null;
}

function isLeaver_(name) {
  return Object.prototype.hasOwnProperty.call(EMPLOYEE_LEAVERS, normName_(name));
}

// #N/A must be caught before the '/' split, or it becomes two names.
function isNaCell_(v) {
  return /^\s*#?\s*n\s*[\/-]?\s*a\s*$/i.test(String(v == null ? '' : v));
}

function splitPocCell_(v) {
  if (v === null || v === undefined || isNaCell_(v)) return [];
  return String(v).split('/').map(function (x) { return String(x).trim(); })
    .filter(function (x) { return x !== '' && !isNaCell_(x); });
}

function canonPersonName_(name) {
  var k = normName_(name);
  return POC_ALIASES[k] || k;
}
function canonPocName_(name) { return canonPersonName_(name); }

function resolvePocEmployee_(cell, category, empByName, teamById) {
  var parts = splitPocCell_(cell);
  if (!parts.length) return { emp: null, why: 'blank' };
  var cands = [], unknown = [], ignored = 0;
  parts.forEach(function (p) {
    var k = canonPocName_(p);
    if (POC_IGNORE.indexOf(k) >= 0) { ignored++; return; }
    var e = empByName[k];
    if (e) cands.push(e); else unknown.push(p);
  });
  if (!cands.length) {
    return { emp: null, why: unknown.length ? 'no employee: ' + unknown.join(' / ') : 'ignored' };
  }
  if (cands.length === 1) return { emp: cands[0], why: '' };
  var cat = normName_(category);
  var hit = cands.filter(function (e) {
    return normName_((teamById[e.team_id] || {}).name) === cat;
  });
  if (hit.length === 1) return { emp: hit[0], why: '' };
  return { emp: null, why: 'shared account, material "' + category +
    '" matches ' + hit.length + ' of ' + cands.length + ' POCs' };
}

function readAccountPoc_(sh) {
  var out = { map: {}, pocNames: {}, count: 0, missing: [], warnings: [] };
  var lastR = sh.getLastRow(), lastC = sh.getLastColumn();
  if (lastR < 2) { out.warnings.push(sh.getName() + ' is empty'); return out; }
  var g = sh.getRange(1, 1, lastR, lastC).getValues();
  var ix = headerIndex_(g[0]);
  var nameC = ix['business_name'], catC = ix['business_category'], pocC = ix['poc_name'];
  if (nameC === undefined) out.missing.push('business_name');
  if (catC === undefined) out.missing.push('business_category');
  if (pocC === undefined) out.missing.push('poc_name');
  if (out.missing.length) return out;
  for (var r = 1; r < lastR; r++) {
    var nm = normName_(g[r][nameC]);
    var poc = String(g[r][pocC] == null ? '' : g[r][pocC]).trim();
    if (!nm || !poc || isNaCell_(poc)) continue;
    var cat = String(g[r][catC] == null ? '' : g[r][catC]).trim();
    out.map[cat + '|' + nm] = poc;
    out.pocNames[normName_(poc)] = poc;
    out.count++;
  }
  return out;
}

function pocForChain_(maps, name, category) {
  for (var i = 0; i < maps.length; i++) {
    var v = pocFor_(maps[i], name, category);
    if (v) return v;
  }
  return null;
}

function readShipments_(sh) {
  var out = { rows: [], warnings: [], missing: [] };
  var lastR = sh.getLastRow(), lastC = sh.getLastColumn();
  if (lastR < 2) { out.warnings.push(SHIPMENTS_TAB + ' is empty'); return out; }
  var g = sh.getRange(1, 1, lastR, lastC).getValues();
  var ix = headerIndex_(g[0]);
  var want = { id: 'shipment_id', status: 'shipment_status', created: 'shipment_created_date',
    sellerName: 'seller_name', sellerCat: 'seller_category',
    buyerName: 'buyer_name', buyerCat: 'buyer_category',
    value: 'shipment_value', qty: 'dispatched_quantity' };
  var opt = { paid: 'paid_amount', invoiced: 'invoice_date',
              stage: 'shipment_stage_label', timeline: 'status_timeline' };
  var col = {};
  Object.keys(want).forEach(function (k) {
    if (want[k] in ix) col[k] = ix[want[k]]; else out.missing.push(want[k]);
  });
  Object.keys(opt).forEach(function (k) {
    if (opt[k] in ix) col[k] = ix[opt[k]];
    else out.optMissing = (out.optMissing || []).concat(opt[k]);
  });
  if (out.missing.length) return out;
  for (var r = 1; r < lastR; r++) {
    var row = g[r];
    if (String(row[col.id] || '').trim() === '') continue;
    out.rows.push({
      id: String(row[col.id]).trim(),
      status: String(row[col.status] || '').trim(),
      period_id: periodIdFromDate_(row[col.created]),
      sellerName: String(row[col.sellerName] || '').trim(),
      sellerCat: String(row[col.sellerCat] || '').trim(),
      buyerName: String(row[col.buyerName] || '').trim(),
      buyerCat: String(row[col.buyerCat] || '').trim(),
      value: num_(row[col.value]),
      qty: num_(row[col.qty]),
      paid: (col.paid === undefined) ? null : num_(row[col.paid]),
      invoiced: (col.invoiced === undefined) ? '' :
        String(row[col.invoiced] == null ? '' : row[col.invoiced]).trim(),
      stage: (col.stage === undefined) ? '' :
        String(row[col.stage] == null ? '' : row[col.stage]).trim(),
      timeline: (col.timeline === undefined) ? '' :
        String(row[col.timeline] == null ? '' : row[col.timeline]).trim()
    });
  }
  return out;
}

function shipmentCounts_(sh) { return !shipmentExcluded_(sh.status); }

// ===== COLLECTION TIMING (read-only) =====
function parseTimeline_(t) {
  var out = {};
  String(t || '').split('|').forEach(function (part) {
    var bits = String(part).split('~');
    if (bits.length < 2) return;
    var nm = bits[0].trim(), d = isoDate_(bits[1]);
    if (nm && d) out[nm] = d;
  });
  return out;
}
function isoDate_(v) {
  var m = String(v || '').match(/^\s*(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}
function ddmmDate_(v) {
  var m = String(v || '').match(/^\s*(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})/);
  if (!m) return null;
  return Date.UTC(Number(m[3]), Number(m[2]) - 1, Number(m[1]));
}
function daysBetween_(a, b) {
  if (a === null || b === null) return null;
  return Math.round((b - a) / 86400000);
}
function median_(a) {
  if (!a.length) return null;
  var v = a.slice().sort(function (x, y) { return x - y; });
  var i = Math.floor(v.length / 2);
  return v.length % 2 ? v[i] : Math.round((v[i - 1] + v[i]) / 2 * 10) / 10;
}

function previewCollectionDays() {
  ensureSeeded_();
  var nl = String.fromCharCode(10), out = [], src;
  try { src = SpreadsheetApp.openById(SHIPMENTS_SHEET_ID); }
  catch (e) { return 'Cannot open MM_CT  (' + (e && e.message || e) + ')'; }
  var shipSh = findSheet_(src, SHIPMENTS_TAB), pocSh = findSheet_(src, POC_TAB);
  var shp = readShipments_(shipSh);
  if (shp.missing.length) return 'Raw_Shipments is missing: ' + shp.missing.join(', ');
  var poc = pocSh ? readPocMap_(pocSh) : { sellerPoc: {}, buyerPoc: {} };
  var sellSh = findSheet_(src, 'Raw_Sellers'), buySh = findSheet_(src, 'Raw_Buyers');
  var accS = sellSh ? readAccountPoc_(sellSh) : { map: {} };
  var sellerMaps = [poc.sellerPoc, accS.map];
  var emps = read_(T.EMPLOYEES), empByName = {}, teamById = idx_(read_(T.TEAMS));
  emps.forEach(function (e) { empByName[normName_(e.name)] = e; });

  var STARTS = [['DRAFT', 'created'], ['DISPATCHED', 'dispatched'],
                ['REACHED', 'arrived'], ['RECEIVED_BY_RECYCLER', 'delivered']];
  var all = {}, fromInvoice = [], done = 0, noEnd = 0;
  STARTS.forEach(function (st) { all[st[0]] = []; });
  var perPerson = {};

  shp.rows.forEach(function (r) {
    if (!shipmentCounts_(r)) return;
    var tl = parseTimeline_(r.timeline);
    var end = tl['COMPLETED'];
    if (!end) { noEnd++; return; }
    done++;
    STARTS.forEach(function (st) {
      var d = daysBetween_(tl[st[0]], end);
      if (d !== null && d >= 0) all[st[0]].push(d);
    });
    var inv = daysBetween_(ddmmDate_(r.invoiced), end);
    if (inv !== null && inv >= 0) fromInvoice.push(inv);
    var d2 = daysBetween_(tl['RECEIVED_BY_RECYCLER'] || tl['REACHED'], end);
    if (d2 === null || d2 < 0) return;
    var pocName = pocForChain_(sellerMaps, r.sellerName, r.sellerCat);
    if (!pocName) return;
    var res = resolvePocEmployee_(pocName, r.sellerCat, empByName, teamById);
    if (!res.emp) return;
    var byE = perPerson[res.emp.id] || (perPerson[res.emp.id] = {});
    (byE[r.period_id] = byE[r.period_id] || []).push(d2);
  });

  out.push('=== how long to COMPLETED ===');
  out.push('  COMPLETED is being read as the money arriving, because the row');
  out.push('  labelled "Payment Released" is the one whose timeline ends there.');
  out.push('  That is an inference from the data, not a documented fact.');
  out.push('');
  out.push('  ' + done + ' shipments reached COMPLETED;  ' + noEnd + ' have not');
  out.push('');
  out.push('  median elapsed days, by where you start counting:');
  STARTS.forEach(function (st) {
    var a = all[st[0]];
    out.push('    ' + (st[1] + '            ').substr(0, 12) +
      ' -> completed   n=' + a.length +
      '   median ' + (median_(a) === null ? '-' : median_(a)) + ' days' +
      (a.length ? '   range ' + Math.min.apply(null, a) + '-' + Math.max.apply(null, a) : ''));
  });
  out.push('    invoice date -> completed   n=' + fromInvoice.length +
    '   median ' + (median_(fromInvoice) === null ? '-' : median_(fromInvoice)) + ' days');
  out.push('');

  out.push('=== delivered -> completed, per POC per month (median days) ===');
  var byId = idx_(emps), ids = Object.keys(perPerson);
  if (!ids.length) out.push('  (nothing attributable)');
  ids.sort(function (a, b) {
    return String((byId[a] || {}).name || a).localeCompare(String((byId[b] || {}).name || b)); });
  ids.forEach(function (id) {
    out.push('  ' + ((byId[id] || {}).name || id));
    Object.keys(perPerson[id]).sort().forEach(function (pid) {
      var a = perPerson[id][pid];
      out.push('    ' + String(pid).replace('per_', '') + '   n=' + a.length +
        '   median ' + median_(a) + ' days');
    });
  });

  out.push('');
  out.push('NOTHING WAS WRITTEN.');
  out.push('The DSO ladder here is 15 | 10 | 5 | 3 | 2 against a target of 3.');
  out.push('If the medians above are around twenty days, then "3" is not total');
  out.push('elapsed days — it is days past an agreed credit period, or something');
  out.push('else again. Which start point, and which definition, is the KRA');
  out.push('owner\'s call. Nothing can be written until that is settled.');
  var txt = out.join(nl);
  Logger.log(txt);
  return txt;
}
function peekTimeline() {
  var nl = String.fromCharCode(10), out = [];
  var src = SpreadsheetApp.openById(SHIPMENTS_SHEET_ID);
  var sh = findSheet_(src, SHIPMENTS_TAB);
  if (!sh) return 'no tab matching "' + SHIPMENTS_TAB + '"';
  var lastR = sh.getLastRow(), lastC = sh.getLastColumn();
  var g = sh.getRange(1, 1, lastR, lastC).getValues();
  var ix = headerIndex_(g[0]);
  var need = ['status_timeline', 'shipment_status', 'shipment_value',
              'paid_amount', 'invoice_date', 'shipment_stage_label'];
  var miss = need.filter(function (k) { return !(k in ix); });
  if (miss.length) return 'missing columns: ' + miss.join(', ');

  out.push('=== every stage name that appears in status_timeline ===');
  var stageCount = {}, withTl = 0;
  for (var r0 = 1; r0 < g.length; r0++) {
    var t0 = String(g[r0][ix['status_timeline']] || '');
    if (!t0) continue;
    withTl++;
    t0.split('|').forEach(function (part) {
      var nm = String(part).split('~')[0].trim();
      if (nm) stageCount[nm] = (stageCount[nm] || 0) + 1;
    });
  }
  out.push('  ' + withTl + ' rows carry a timeline');
  Object.keys(stageCount).sort(function (a, b) { return stageCount[b] - stageCount[a]; })
    .forEach(function (k) {
      out.push('    ' + stageCount[k] + '  ' + k +
        (/pay|settle|release/i.test(k) ? '   <<< a payment moment' : ''));
    });
  out.push('');

  out.push('=== one full example per shipment stage ===');
  var seenStage = {};
  for (var r = 1; r < g.length; r++) {
    var t = String(g[r][ix['status_timeline']] || '');
    if (!t) continue;
    var lbl = String(g[r][ix['shipment_stage_label']] || '(none)');
    if (seenStage[lbl]) continue;
    seenStage[lbl] = 1;
    out.push('  ' + lbl + '   (' + String(g[r][ix['shipment_status']] || '') + ')' +
      '   invoiced ' + String(g[r][ix['invoice_date']] || '-') +
      '   value ' + String(g[r][ix['shipment_value']] || '-') +
      '   paid ' + String(g[r][ix['paid_amount']] || '-'));
    t.split('|').forEach(function (part) { out.push('      ' + part); });
    out.push('');
  }

  out.push('=== does paid_amount ever exceed shipment_value? ===');
  var over = 0, exact = 0, under = 0, blank = 0, worst = 0, worstId = '';
  for (var r2 = 1; r2 < g.length; r2++) {
    var v = num_(g[r2][ix['shipment_value']]);
    var p = num_(g[r2][ix['paid_amount']]);
    if (v === null) continue;
    if (p === null) { blank++; continue; }
    if (p > v + 0.5) {
      over++;
      if (p - v > worst) { worst = p - v; worstId = String(g[r2][0]); }
    } else if (Math.abs(p - v) <= 0.5) { exact++; } else { under++; }
  }
  out.push('  paid EXCEEDS value : ' + over + (over ? '   <<< the negative DSO' : ''));
  out.push('  paid equals value  : ' + exact);
  out.push('  paid below value   : ' + under);
  out.push('  paid blank         : ' + blank);
  if (over) {
    out.push('  largest overshoot  : ' + Math.round(worst) + ' on ' + worstId);
    out.push('  => paid_amount is NOT a payment against this one shipment.');
  }
  var txt = out.join(nl);
  Logger.log(txt);
  return txt;
}
function previewAchievementJoin() {
  ensureSeeded_();
  var nl = String.fromCharCode(10), out = [], src;
  try { src = SpreadsheetApp.openById(SHIPMENTS_SHEET_ID); }
  catch (e) { return 'Cannot open MM_CT  (' + (e && e.message || e) + ')'; }
  var shipSh = findSheet_(src, SHIPMENTS_TAB), pocSh = findSheet_(src, POC_TAB);
  if (!shipSh) return 'no tab matching "' + SHIPMENTS_TAB + '"';
  if (!pocSh) return 'no tab matching "' + POC_TAB + '"';

  var poc = readPocMap_(pocSh), shp = readShipments_(shipSh);
  if (shp.missing.length) return 'Raw_Shipments is missing columns: ' + shp.missing.join(', ');
  var sellSh = findSheet_(src, 'Raw_Sellers'), buySh = findSheet_(src, 'Raw_Buyers');
  var accS = sellSh ? readAccountPoc_(sellSh) : { map: {}, count: 0, missing: ['(no tab)'], warnings: [] };
  var accB = buySh ? readAccountPoc_(buySh) : { map: {}, count: 0, missing: ['(no tab)'], warnings: [] };
  var sellerMaps = [poc.sellerPoc, accS.map], buyerMaps = [poc.buyerPoc, accB.map];

  out.push('=== POC_data ===');
  out.push('  header row ' + poc.headerRow);
  poc.groups.forEach(function (gp) {
    out.push('  "' + gp.label + '"  (' + gp.kind +
      (gp.material ? ', ' + gp.material + ' only' : ', ANY material') +
      ')  name c' + gp.nameCol + ' -> POC c' + gp.pocCol + '   ' + gp.count + ' accounts');
    if (gp.clashes.length) {
      out.push('    !! ' + gp.clashes.length + ' account(s) mapped to TWO different POCs:');
      gp.clashes.slice(0, 5).forEach(function (x) { out.push('       ' + x); });
    }
  });
  poc.warnings.forEach(function (w) { out.push('  !! ' + w); });
  out.push('');
  out.push('=== fallback POC sources (Metal AND Plastic) ===');
  out.push('  Raw_Sellers.POC_Name  ' + accS.count + ' accounts' +
    (accS.missing.length ? '   !! missing ' + accS.missing.join(', ') : ''));
  out.push('  Raw_Buyers.POC_Name   ' + accB.count + ' accounts' +
    (accB.missing.length ? '   !! missing ' + accB.missing.join(', ') : ''));

  var emps = read_(T.EMPLOYEES), empByName = {};
  emps.forEach(function (e) { empByName[normName_(e.name)] = e; });
  out.push('');
  out.push('=== POC names ===');
  var allPoc = {};
  [poc.pocNames, accS.pocNames, accB.pocNames].forEach(function (src2) {
    Object.keys(src2 || {}).forEach(function (k) { allPoc[k] = src2[k]; });
  });
  var pocKeys = Object.keys(allPoc), pocOk = 0, pocShared = 0, pocIgn = 0, pocBad = [];
  pocKeys.forEach(function (k) {
    var raw = allPoc[k], parts = splitPocCell_(raw), unknown = [], known = 0, ign = 0;
    parts.forEach(function (p) {
      var cn = canonPocName_(p);
      if (POC_IGNORE.indexOf(cn) >= 0) { ign++; return; }
      if (empByName[cn]) known++; else unknown.push(p);
    });
    if (unknown.length) pocBad.push(raw + '   (unknown: ' + unknown.join(', ') + ')');
    else if (known > 1) { pocOk++; pocShared++; }
    else if (known === 1) pocOk++;
    else pocIgn++;
  });
  out.push('  ' + pocKeys.length + ' distinct POC strings across POC_data, Raw_Sellers, Raw_Buyers');
  out.push('  ' + pocOk + ' resolve to an employee (' + pocShared +
    ' are shared cells split by material), ' + pocIgn + ' on the ignore list');
  if (pocBad.length) {
    out.push('  !! POC strings naming somebody we do not have (' + pocBad.length + '):');
    pocBad.slice(0, 20).forEach(function (x) { out.push('    ' + x); });
  } else {
    out.push('  no POC string names an unknown person');
  }
  out.push('');

  out.push('=== Raw_Shipments ===');
  var st = {}, byCat = {}, noPeriod = 0;
  var tot = 0, live = 0, sOk = 0, bOk = 0, neither = [], gmv = 0, catStat = {};
  var empHit = 0, peopleOk = 0, unresolved = {};
  var teamById = idx_(read_(T.TEAMS));
  var unmatchedSeller = {}, unmatchedBuyer = {};
  shp.rows.forEach(function (r) {
    tot++;
    st[r.status] = (st[r.status] || 0) + 1;
    if (!shipmentCounts_(r)) return;
    live++;
    if (!r.period_id) noPeriod++;
    var cat = r.sellerCat || r.buyerCat || '(none)';
    byCat[cat] = (byCat[cat] || 0) + 1;
    if (r.value !== null) gmv += r.value;
    var sp = pocForChain_(sellerMaps, r.sellerName, r.sellerCat);
    var bp = pocForChain_(buyerMaps, r.buyerName, r.buyerCat);
    var se = sp ? resolvePocEmployee_(sp, r.sellerCat, empByName, teamById) : null;
    var be = bp ? resolvePocEmployee_(bp, r.buyerCat, empByName, teamById) : null;
    if (se && se.emp) empHit++; else if (se && se.why) unresolved[sp + '  ->  ' + se.why] = 1;
    if (be && be.emp) empHit++; else if (be && be.why) unresolved[bp + '  ->  ' + be.why] = 1;
    if ((se && se.emp) || (be && be.emp)) peopleOk++;
    if (sp) sOk++; else if (r.sellerName) unmatchedSeller[r.sellerName + '  [' + r.sellerCat + ']'] = 1;
    if (bp) bOk++; else if (r.buyerName) unmatchedBuyer[r.buyerName + '  [' + r.buyerCat + ']'] = 1;
    if (!sp && !bp) neither.push(r.id + '  ' + r.sellerCat + '/' + r.buyerCat);
    var cs = catStat[cat] || (catStat[cat] = { n: 0, ok: 0, person: 0 });
    cs.n++; if (sp || bp) cs.ok++;
    if ((se && se.emp) || (be && be.emp)) cs.person++;
  });
  out.push('  ' + tot + ' shipments; by status:');
  Object.keys(st).forEach(function (k) { out.push('    ' + k + '  x' + st[k]); });
  out.push('  ' + live + ' counted after excluding ' + SHIPMENTS_EXCLUDE_STATUS.join('/'));
  out.push('  by category: ' + Object.keys(byCat).map(function (k) {
    return k + ' ' + byCat[k]; }).join(',  '));
  out.push('  ' + noPeriod + ' with an unreadable created date');
  out.push('  GMV of counted shipments: ' + (Math.round(gmv / RUPEES_PER_CRORE * 100) / 100) + ' Cr');
  out.push('');
  out.push('=== the join ===');
  out.push('  seller -> POC matched ' + sOk + '/' + live +
    '   (the ceiling for SELLER-side KRAs)');
  out.push('  buyer  -> POC matched ' + bOk + '/' + live +
    '   (the ceiling for BUYER-side KRAs)');
  out.push('  NEITHER side attributable: ' + neither.length + '/' + live);
  out.push('  reaching a PERSON (after aliases and the material split): ' +
    peopleOk + '/' + live + '   (' + empHit + ' sides)');
  var ur = Object.keys(unresolved);
  if (ur.length) {
    out.push('  POC strings that did NOT resolve to a person (' + ur.length + '):');
    ur.slice(0, 15).forEach(function (x) { out.push('    ' + x); });
  }
  out.push('  attributable by material:');
  Object.keys(catStat).forEach(function (k) {
    var c = catStat[k];
    out.push('    ' + k + ':  ' + c.ok + ' of ' + c.n + ' reach a POC,  ' +
      c.person + ' reach a PERSON');
  });
  var us = Object.keys(unmatchedSeller), ub = Object.keys(unmatchedBuyer);
  out.push('  seller names with no POC (' + us.length + '):');
  us.slice(0, 25).forEach(function (x) { out.push('    ' + x); });
  if (us.length > 25) out.push('    ... and ' + (us.length - 25) + ' more');
  out.push('  buyer names with no POC (' + ub.length + '):');
  ub.slice(0, 25).forEach(function (x) { out.push('    ' + x); });
  if (ub.length > 25) out.push('    ... and ' + (ub.length - 25) + ' more');
  out.push('');
  out.push('NOTHING WAS WRITTEN. This is a dry run.');
  var txt = out.join(nl);
  Logger.log(txt);
  return txt;
}

// ===== THE RATING SCALE =====
// The Target Sheet figure is Target 4 (100%). A ladder is rewritten only with a PLAN target,
// five numeric ascending bands and a largest band <= 2, which keeps DSO day ladders safe.
var RATING_SCALE = ['0.6', '0.75', '0.9', '1.0', '1.05'];
var RATING_ON_TARGET_ = 4;
var RATING_SCALE_MAX_ = 2;

function isRatioLadder_(bands) {
  var v = [];
  for (var i = 0; i < 5; i++) {
    var x = num_(bands[i]);
    if (x === null) return { ok: false, why: 'band ' + (i + 1) + ' is not a number' };
    v.push(x);
  }
  for (var j = 1; j < 5; j++) {
    if (v[j] < v[j - 1]) return { ok: false, why: 'bands descend (absolute ladder)' };
  }
  var max = v[4];
  if (max > RATING_SCALE_MAX_) {
    return { ok: false, why: 'largest band is ' + max + ', above ' +
      RATING_SCALE_MAX_ + ' — an absolute ladder, not a percentage' };
  }
  return { ok: true, why: '' };
}

// Numeric comparison: Sheets reads '1.0' back as 1.
function isOnRatingScale_(t) {
  var want = RATING_SCALE.map(Number);
  var got = [t.t1, t.t2, t.t3, t.t4, t.t5];
  for (var i = 0; i < 5; i++) {
    var v = num_(got[i]);
    if (v === null || Math.abs(v - want[i]) > 1e-9) return false;
  }
  return true;
}

function ladderKey_(t) {
  return [t.t1, t.t2, t.t3, t.t4, t.t5].map(function (x) {
    return String(x == null ? '' : x); }).join(' | ');
}

function previewRatingScale() { return applyRatingScale_(true); }

function applyRatingScale() { return applyRatingScale_(false); }

function applyRatingScale_(dryRun, quiet) {
  ensureSeeded_();
  var nl = String.fromCharCode(10), out = [];
  var targets = read_(T.TARGETS), plans = read_(T.PLAN);
  var kpis = idx_(read_(T.KPIS)), emps = idx_(read_(T.EMPLOYEES));
  var hasPlan = {};
  plans.forEach(function (p) {
    hasPlan[String(p.employee_id) + '|' + String(p.kpi_id) + '|' + String(p.period_id)] = true;
  });

  var want = RATING_SCALE.join(' | ');
  var change = [], already = 0, skipped = {}, byLadder = {}, unscoreable = [];
  targets.forEach(function (t) {
    var key = String(t.employee_id) + '|' + String(t.kpi_id) + '|' + String(t.period_id);
    var lad = ladderKey_(t);
    var g = byLadder[lad] || (byLadder[lad] = { n: 0, planned: 0, rewrite: 0, why: '' });
    g.n++;
    if (isOnRatingScale_(t)) { already++; g.planned++; return; }
    if (!hasPlan[key]) {
      skipped['no numeric target for that person/KPI/month'] =
        (skipped['no numeric target for that person/KPI/month'] || 0) + 1;
      return;
    }
    g.planned++;
    var defined = 0;
    [t.t1, t.t2, t.t3, t.t4, t.t5].forEach(function (b) {
      if (String(b == null ? '' : b).trim() !== '') defined++;
    });
    if (!defined) {
      unscoreable.push(((emps[t.employee_id] || {}).name || t.employee_id) + '  |  ' +
        ((kpis[t.kpi_id] || {}).name || t.kpi_id) + '  |  ' + t.period_id +
        '  |  ladder is ' + (defined ? 'unusable' : 'EMPTY'));
    }
    var r = isRatioLadder_([t.t1, t.t2, t.t3, t.t4, t.t5]);
    if (!r.ok) {
      skipped[r.why] = (skipped[r.why] || 0) + 1;
      g.why = r.why;
      return;
    }
    g.rewrite++;
    change.push(t);
  });

  out.push('=== the rating scale ===');
  out.push('  on target = ' + RATING_ON_TARGET_ + ' of 5   ->  ' + want);
  out.push('');
  out.push('=== every ladder in the database ===');
  out.push('  rows  withTarget  rewrite   ladder');
  Object.keys(byLadder).sort(function (a, b) { return byLadder[b].n - byLadder[a].n; })
    .forEach(function (k) {
      var g = byLadder[k];
      out.push('  ' + String(g.n) + '      ' + g.planned + '          ' + g.rewrite +
        '       ' + k + (g.why ? '      [' + g.why + ']' : ''));
    });
  out.push('');
  out.push('=== what would change ===');
  out.push('  ' + change.length + ' target rows rewritten, ' + already +
    ' already on the scale');
  Object.keys(skipped).forEach(function (k) {
    out.push('  skipped ' + skipped[k] + ': ' + k);
  });
  if (unscoreable.length) {
    out.push('');
    out.push('  !! ' + unscoreable.length + ' rows have a NUMERIC TARGET but no usable');
    out.push('     ladder, so they can never be rated. Fix the ladder in the source');
    out.push('     workbook and re-run refreshFrameworkFromSource():');
    var seenU = {};
    unscoreable.forEach(function (x) {
      var k = x.split('  |  ')[1] + '  ' + x.split('  |  ')[3];
      seenU[k] = (seenU[k] || 0) + 1;
    });
    Object.keys(seenU).forEach(function (k) {
      out.push('       ' + seenU[k] + ' x  ' + k);
    });
    out.push('     first few in full:');
    unscoreable.slice(0, 8).forEach(function (x) { out.push('       ' + x); });
  }
  out.push('');
  if (!change.length) {
    out.push('=== nothing to rewrite ===');
    out.push('  Every ratio ladder in the database already matches ' + want + '.');
    out.push('  Ratings are resolved from the STORED ladder, not from');
    out.push('  RATING_SCALE, so the scorecards already read on this scale.');
  } else {
    out.push('=== whose ladders change ===');
    out.push('  people affected: ' + (function () {
      var seen = {}; change.forEach(function (t) { seen[t.employee_id] = 1; });
      return Object.keys(seen).length; })());
    out.push('  sample:');
    change.slice(0, 5).forEach(function (t) {
      out.push('    ' + ((emps[t.employee_id] || {}).name || t.employee_id) + '  ' +
        ((kpis[t.kpi_id] || {}).name || t.kpi_id) + '  ' + t.period_id +
        '   ' + ladderKey_(t) + '  ->  ' + want);
    });
  }
  out.push('');

  if (dryRun) {
    out.push('NOTHING WAS WRITTEN. This is a dry run. Run applyRatingScale() to write.');
  } else {
    change.forEach(function (t) {
      var before = ladderKey_(t);
      t.t1 = RATING_SCALE[0]; t.t2 = RATING_SCALE[1]; t.t3 = RATING_SCALE[2];
      t.t4 = RATING_SCALE[3]; t.t5 = RATING_SCALE[4];
      t.version = (num_(t.version) || 1) + 1;
      t.updated_by = currentEmail_(); t.updated_at = nowIso_();
      _DIRTY[T.TARGETS] = true;
      audit_(currentEmail_(), 'TARGETS', t.id, 'rating_scale', before, want,
        'on target = 4 of 5 (the Target Sheet figure IS Target 4)');
    });
    commit_();
    out.push('WRITTEN: ' + change.length + ' target rows now use ' + want + '.');
    out.push('Every affected rating changes. Reload the dashboard.');
  }
  var txt = out.join(nl);
  if (!quiet) Logger.log(txt);
  return txt;
}

function refreshFrameworkFromSource() {
  ensureSeeded_();
  var nl = String.fromCharCode(10), out = [];
  var actor = currentEmail_() || 'system';
  var periods = read_(T.PERIODS).filter(function (p) {
    return String(p.status) !== 'upcoming'; });
  if (!periods.length) return 'No open periods to import into.';

  out.push('=== re-importing the framework from the source workbook ===');
  out.push('  ' + SOURCE_SHEET_ID);
  periods.forEach(function (p) {
    var res;
    try { res = importFromSource_(SOURCE_SHEET_ID, String(p.id), actor, false); }
    catch (e) { out.push('  !! ' + p.id + ': ' + (e && e.message || e)); return; }
    out.push('  ' + periodLabel_(p) + '  ' + JSON.stringify(res));
  });
  commit_();

  out.push('');
  out.push('=== putting the rating scale back ===');
  out.push(applyRatingScale_(false, true));
  var txt = out.join(nl);
  Logger.log(txt);
  return txt;
}

function previewFrameworkRefresh() {
  ensureSeeded_();
  var nl = String.fromCharCode(10), out = [];
  var re = /\b(recovered|recovery|collection|collections|gmv|revenue|achieved|achievement|acquisition|conversion|closure|completed|accuracy)\b/i;
  out.push('=== ladders that currently contradict their KPI ===');
  out.push('  These are what the dashboard counts as "need a decision".');
  var emps = idx_(read_(T.EMPLOYEES)), kpis = idx_(read_(T.KPIS));
  var seen = {}, count = 0;
  read_(T.TARGETS).forEach(function (t) {
    var kpi = kpis[t.kpi_id] || {};
    var pr = parseBands_([t.t1, t.t2, t.t3, t.t4, t.t5]);
    if (pr.kind !== 'numeric' || pr.direction !== 'lower_is_better') return;
    if (!re.test(String(kpi.name || ''))) return;
    count++;
    var k = String(kpi.name) + '  ||  ' + ladderKey_(t);
    (seen[k] = seen[k] || []).push((emps[t.employee_id] || {}).name || t.employee_id);
  });
  out.push('  ' + count + ' target rows across ' + Object.keys(seen).length + ' distinct KPI/ladder pairs');
  Object.keys(seen).forEach(function (k) {
    var who = {}; seen[k].forEach(function (x) { who[x] = 1; });
    out.push('    ' + k);
    out.push('      ' + Object.keys(who).join(', '));
  });
  out.push('');
  out.push('The app holds a SNAPSHOT of the framework (SRC_SEED, 2026-08-20).');
  out.push('If these were corrected in the workbook, run refreshFrameworkFromSource().');
  out.push('NOTHING WAS WRITTEN.');
  var txt = out.join(nl);
  Logger.log(txt);
  return txt;
}

// ===== DSO BY VERTICAL (read-only) =====
var DSO_GST_ = 1.18;
// By column letter, as specified. GMV = AP x 1.18 - AU; receivable = AP x 1.18 - AQ - AU.
var DSO_COLS_ = { taxable: 'AP', collected: 'AQ', debitNote: 'AU' };
var DSO_FROM_ = '2026-06';
// The month in progress would measure the calendar, not collections.
var DSO_SKIP_CURRENT_MONTH_ = true;
function currentMonthId_() {
  return 'per_' + Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM');
}
var DSO_TARGET_DAYS_ = { plastic: 5 };
var DSO_LADDER_ = ['15', '10', '5', '3', '2'];
var DSO_TARGET_RUNG_ = 3;
var DSO_CATEGORY_SIDE_ = 'buyer_category';

function daysInMonth_(periodId) {
  var p = String(periodId || '').replace('per_', '').split('-');
  var y = Number(p[0]), m = Number(p[1]);
  if (!(y > 0 && m >= 1 && m <= 12)) return 0;
  return new Date(y, m, 0).getDate();
}
function daysElapsed_(periodId, today) {
  var full = daysInMonth_(periodId);
  var ym = String(periodId || '').replace('per_', '');
  var cur = Utilities.formatDate(today, Session.getScriptTimeZone(), 'yyyy-MM');
  if (ym !== cur) return full;
  return Math.min(full, today.getDate());
}

function previewPlasticDSO() {
  var nl = String.fromCharCode(10), out = [];
  var src, sh;
  try { src = SpreadsheetApp.openById(SHIPMENTS_SHEET_ID); }
  catch (e) { return 'Cannot open MM_CT  (' + (e && e.message || e) + ')'; }
  sh = findSheet_(src, SHIPMENTS_TAB);
  if (!sh) return 'no tab matching "' + SHIPMENTS_TAB + '"';

  var lastR = sh.getLastRow(), lastC = sh.getLastColumn();
  if (lastR < 2) return SHIPMENTS_TAB + ' is empty';
  var g = sh.getRange(1, 1, lastR, lastC).getValues();
  var ix = headerIndex_(g[0]);

  var cTax = letterCol_(DSO_COLS_.taxable) - 1;
  var cCol = letterCol_(DSO_COLS_.collected) - 1;
  var cDN  = letterCol_(DSO_COLS_.debitNote) - 1;
  var widest = Math.max(cTax, cCol, cDN);
  if (widest >= lastC) {
    return SHIPMENTS_TAB + ' has only ' + lastC + ' columns (' + colLetter_(lastC) +
      '), so ' + colLetter_(widest + 1) + ' does not exist.';
  }

  out.push('=== THE THREE COLUMNS, AS THEY ARE TODAY ===');
  out.push('Check these headers before reading anything below. If a column has');
  out.push('been inserted upstream, every figure here is wrong and only this');
  out.push('block would show it.');
  out.push('');
  [['taxable value      ', cTax, DSO_COLS_.taxable],
   ['collected          ', cCol, DSO_COLS_.collected],
   ['debit note         ', cDN,  DSO_COLS_.debitNote]].forEach(function (x) {
    var head = String(g[0][x[1]] || '(no header)');
    var sample = [], seen = {};
    for (var r = 1; r < lastR && sample.length < 3; r++) {
      var v = g[r][x[1]];
      if (v === '' || v === null || v === undefined) continue;
      var t = String(v); if (seen[t]) continue; seen[t] = 1; sample.push(t);
    }
    out.push('  ' + x[2] + '  ' + x[0] + '  ' + head);
    out.push('        e.g. ' + (sample.length ? sample.join('  |  ') : '(all blank)'));
  });
  out.push('');
  [['shipment_value', cTax, DSO_COLS_.taxable], ['paid_amount', cCol, DSO_COLS_.collected]]
    .forEach(function (x) {
      if (!(x[0] in ix)) return;
      var byName = ix[x[0]];
      out.push(byName === x[1]
        ? '  ok: "' + x[0] + '" is also at ' + x[2]
        : '  !! "' + x[0] + '" is at ' + colLetter_(byName + 1) + ', NOT ' + x[2] +
          '  — the letter was used, as specified');
    });
  out.push('');

  var ixS = headerIndex_(g[0]);
  var cCat = (DSO_CATEGORY_SIDE_ in ixS) ? ixS[DSO_CATEGORY_SIDE_] : -1;
  var cBCat = ('seller_category' in ixS) ? ixS['seller_category'] : -1;
  if (cCat < 0) return 'Raw_Shipments has no ' + DSO_CATEGORY_SIDE_ + ' column.';
  var cDate = ('shipment_created_date' in ixS) ? ixS['shipment_created_date'] : -1;
  var cStat = ('shipment_status' in ixS) ? ixS['shipment_status'] : -1;
  var cId = ('shipment_id' in ixS) ? ixS['shipment_id'] : -1;
  if (cDate < 0) return 'Raw_Shipments has no shipment_created_date column.';

  var months = {}, skipped = { notPlastic: 0, cancelled: 0, beforeJune: 0, noDate: 0 };
  var negRows = [], clamped = { recv: 0, gmv: 0 }, sideDiffers = 0;
  for (var r = 1; r < lastR; r++) {
    var row = g[r];
    if (cId >= 0 && String(row[cId] || '').trim() === '') continue;
    if (cStat >= 0) {
      var st = String(row[cStat] || '').trim().toLowerCase();
      var skip = false;
      for (var i = 0; i < SHIPMENTS_EXCLUDE_STATUS.length; i++) {
        if (st === String(SHIPMENTS_EXCLUDE_STATUS[i]).toLowerCase()) skip = true;
      }
      if (skip) { skipped.cancelled++; continue; }
    }
    var isPlastic = /plastic/i.test(String(row[cCat] || ''));
    if (cBCat >= 0 && /plastic/i.test(String(row[cBCat] || '')) !== isPlastic) sideDiffers++;
    if (!isPlastic) { skipped.notPlastic++; continue; }
    var pid = periodIdFromDate_(row[cDate]);
    if (!pid) { skipped.noDate++; continue; }
    if (String(pid).replace('per_', '') < DSO_FROM_) { skipped.beforeJune++; continue; }

    var ap = num_(row[cTax]) || 0, aq = num_(row[cCol]) || 0, au = num_(row[cDN]) || 0;
    var withTax = ap * DSO_GST_;
    var rawGmv = withTax - au;
    var rawRecv = withTax - aq - au;
    var gmv = rawGmv < 0 ? 0 : rawGmv;
    var recv = rawRecv < 0 ? 0 : rawRecv;
    if (rawRecv < 0) clamped.recv++;
    if (rawGmv < 0) clamped.gmv++;
    var m = months[pid] || (months[pid] = { n: 0, gmv: 0, recv: 0, ap: 0, aq: 0, au: 0 });
    m.n++; m.gmv += gmv; m.recv += recv; m.ap += ap; m.aq += aq; m.au += au;
    if (rawRecv < 0 && negRows.length < 6) {
      negRows.push('    row ' + (r + 1) + '  ' + pid.replace('per_', '') +
        '  AP ' + ap + '  AQ ' + aq + '  AU ' + au + '  -> ' + Math.round(rawRecv) +
        ', counted as 0');
    }
  }

  var today = new Date();
  var keys = Object.keys(months).sort();
  if (!keys.length) {
    out.push('No Plastic shipments found from ' + DSO_FROM_ + ' onwards.');
    out.push('  skipped: ' + JSON.stringify(skipped));
    var t0 = out.join(nl); Logger.log(t0); return t0;
  }

  function cr(x) { return (Math.round(x / 1e5) / 100).toFixed(2); }
  out.push('=== MONTH BY MONTH (MTD) ===');
  out.push('  month     rows      GMV Cr   receivable Cr   days    DSO   vs 5');
  var tG = 0, tR = 0, tN = 0, monthly = [];
  var pb = parseBands_(DSO_LADDER_);
  keys.forEach(function (k) {
    var m = months[k], d = daysElapsed_(k, today);
    var dso = m.gmv ? m.recv / m.gmv * d : null;
    tG += m.gmv; tR += m.recv; tN += m.n;
    if (dso !== null) monthly.push({ k: k, dso: dso, gmv: m.gmv });
    out.push('  ' + k.replace('per_', '') + '  ' + String(m.n) + '      ' +
      cr(m.gmv) + '        ' + cr(m.recv) + '        ' + d + '    ' +
      (dso === null ? '  —' : (Math.round(dso * 10) / 10)) +
      (dso === null ? '' : '   Target ' + levelFromBands_(pb, dso)));
  });
  out.push('');

  var firstY = Number(keys[0].replace('per_', '').split('-')[0]);
  var firstM = Number(keys[0].replace('per_', '').split('-')[1]);
  var spanDays = Math.round((today - new Date(firstY, firstM - 1, 1)) / 86400000) + 1;
  var ytd = monthly.length
    ? monthly.reduce(function (a, x) { return a + x.dso; }, 0) / monthly.length : null;
  var wSum = monthly.reduce(function (a, x) { return a + x.gmv; }, 0);
  var ytdW = wSum
    ? monthly.reduce(function (a, x) { return a + x.dso * x.gmv; }, 0) / wSum : null;
  var spanQ = tG ? tR / tG * spanDays : null;
  out.push('=== YEAR TO DATE (' + keys[0].replace('per_', '') + ' to today) ===');
  out.push('  shipments        ' + tN);
  out.push('  GMV              ' + cr(tG) + ' Cr      (AP x 1.18 - AU)');
  out.push('  receivables      ' + cr(tR) + ' Cr      (AP x 1.18 - AQ - AU)');
  out.push('  months           ' + monthly.length);
  out.push('  DSO              ' + (ytd === null ? '—' : Math.round(ytd * 10) / 10) +
    ' days   <- mean of the months, which is how a duration aggregates');
  out.push('');
  out.push('  for comparison, NOT used:');
  out.push('    GMV-weighted   ' + (ytdW === null ? '—' : Math.round(ytdW * 10) / 10) +
    ' days   (a heavy month counts for more)');
  out.push('    span quotient  ' + (spanQ === null ? '—' : Math.round(spanQ * 10) / 10) +
    ' days   (receivables/GMV x ' + spanDays + ' days — WRONG for a duration,');
  out.push('                            it grows with the length of the year)');
  out.push('');
  out.push('  target           ' + DSO_TARGET_DAYS_.plastic + ' days   = Target ' +
    DSO_TARGET_RUNG_ + '      ' +
    (ytd === null ? '' : (ytd <= DSO_TARGET_DAYS_.plastic ? 'MET' : 'OVER by ' +
      (Math.round((ytd - DSO_TARGET_DAYS_.plastic) * 10) / 10) + ' days')));
  out.push('  ladder           ' + DSO_LADDER_.join(' | ') + '   (' + pb.direction + ')');
  out.push('  WOULD RATE       ' +
    (ytd === null ? '\u2014' : 'Target ' + levelFromBands_(pb, ytd)));
  out.push('');
  out.push('  for reference, what each rung needs:');
  DSO_LADDER_.forEach(function (b, i) {
    out.push('    Target ' + (i + 1) + '   ' + b + ' days or fewer' +
      (i + 1 === DSO_TARGET_RUNG_ ? '   <- the target' : ''));
  });
  out.push('');

  out.push('=== rows left out ===');
  out.push('  not Plastic      ' + skipped.notPlastic + '   (by ' + DSO_CATEGORY_SIDE_ + ')');
  out.push('    ' + sideDiffers + ' row(s) would have been classified differently by');
  out.push('    seller_category, so the choice of side is doing real work here.');
  out.push('  cancelled        ' + skipped.cancelled);
  out.push('  before ' + DSO_FROM_ + '    ' + skipped.beforeJune);
  out.push('  no usable date   ' + skipped.noDate);
  var lastK = keys[keys.length - 1], lastM = months[lastK];
  if (lastM && lastM.gmv && lastM.recv / lastM.gmv > 0.95) {
    out.push('  !! ' + lastK.replace('per_', '') + ' shows ' +
      Math.round(lastM.recv / lastM.gmv * 100) + '% of its GMV still outstanding.');
    out.push('     On the newest month that usually means NOT YET DUE rather than');
    out.push('     not collected — payment terms have not elapsed. Rating the month');
    out.push('     in progress on this measure penalises recency, not performance.');
    out.push('');
  }
  out.push('=== clamped to zero, as ruled ===');
  out.push('  negative receivable   ' + clamped.recv + ' rows');
  out.push('  negative GMV          ' + clamped.gmv + ' rows');
  if (clamped.recv || clamped.gmv) {
    out.push('  Counting these as 0 rather than as credits RAISES the DSO, which is');
    out.push('  the conservative direction: an over-collected shipment can no longer');
    out.push('  cancel out somebody else\'s genuine overdue.');
  }
  if (negRows.length) {
    out.push('  the first few:');
    negRows.forEach(function (x) { out.push(x); });
  }
  out.push('');
  out.push('NOTHING WAS WRITTEN. This is a dry run.');
  var txt = out.join(nl);
  Logger.log(txt);
  return txt;
}
// ===== DSO IMPORT =====
var DSO_NOTE_ = 'MM_CT DSO';
function dsoWorking_(recv, gmv, days, ships) {
  function cr(x) { return (Math.round(x / 1e5) / 100).toFixed(2) + ' Cr'; }
  var d = gmv ? Math.round(recv / gmv * days * 10) / 10 : 0;
  return DSO_NOTE_ + ' · receivable ' + cr(recv) + ' ÷ GMV ' + cr(gmv) +
    ' × ' + days + ' days = ' + d + ' days' +
    ' · ' + ships + (ships === 1 ? ' shipment' : ' shipments');
}
var DSO_KRA_ = 'DSO DAYS';
var DSO_KPI_RE_ = /DAYS SALES OUTSTANDING|\bDSO\b/;
// target null = keep the Target Sheet's own (Metal, 3 days); Plastic's 5 days is written.
var DSO_TEAMS_ = {
  'PLASTIC': { material: /plastic/i, target: 5 },
  'METAL':   { material: /metal/i,   target: null }
};
function dsoTeamOfCategory_(cat) {
  var t = String(cat || '');
  var names = Object.keys(DSO_TEAMS_);
  for (var i = 0; i < names.length; i++) {
    if (DSO_TEAMS_[names[i]].material.test(t)) return names[i];
  }
  return null;
}
function holdsDso_(kraName, kpiName) {
  return normName_(kraName) === DSO_KRA_ ||
         DSO_KPI_RE_.test(normName_(kpiName)) ||
         DSO_KPI_RE_.test(normName_(kraName));
}

function dsoAchievements_(dryRun) {
  ensureSeeded_();
  var nl = String.fromCharCode(10), out = [];
  var src;
  try { src = SpreadsheetApp.openById(SHIPMENTS_SHEET_ID); }
  catch (e) { return 'Cannot open MM_CT  (' + (e && e.message || e) + ')'; }
  var shipSh = findSheet_(src, SHIPMENTS_TAB);
  if (!shipSh) return 'no tab matching "' + SHIPMENTS_TAB + '"';

  var lastR = shipSh.getLastRow(), lastC = shipSh.getLastColumn();
  if (lastR < 2) return SHIPMENTS_TAB + ' is empty';
  var g = shipSh.getRange(1, 1, lastR, lastC).getValues();
  var ix = headerIndex_(g[0]);
  var cTax = letterCol_(DSO_COLS_.taxable) - 1;
  var cCol = letterCol_(DSO_COLS_.collected) - 1;
  var cDN  = letterCol_(DSO_COLS_.debitNote) - 1;
  if (Math.max(cTax, cCol, cDN) >= lastC) return SHIPMENTS_TAB + ' is too narrow.';
  var cCat = (DSO_CATEGORY_SIDE_ in ix) ? ix[DSO_CATEGORY_SIDE_] : -1;
  var cName = ('buyer_name' in ix) ? ix['buyer_name'] : -1;
  var cDate = ('shipment_created_date' in ix) ? ix['shipment_created_date'] : -1;
  var cStat = ('shipment_status' in ix) ? ix['shipment_status'] : -1;
  if (cCat < 0 || cName < 0 || cDate < 0) {
    return 'Raw_Shipments needs buyer_name, ' + DSO_CATEGORY_SIDE_ +
      ' and shipment_created_date.';
  }
  out.push('columns  ' + DSO_COLS_.taxable + '=' + g[0][cTax] +
    '   ' + DSO_COLS_.collected + '=' + g[0][cCol] +
    '   ' + DSO_COLS_.debitNote + '=' + g[0][cDN]);
  out.push('');

  var pocSh = findSheet_(src, POC_TAB), buySh = findSheet_(src, 'Raw_Buyers');
  var poc = pocSh ? readPocMap_(pocSh) : { buyerPoc: {} };
  var accB = buySh ? readAccountPoc_(buySh) : { map: {} };
  var buyerMaps = [poc.buyerPoc, accB.map];
  var emps = read_(T.EMPLOYEES), empByName = {}, teamById = idx_(read_(T.TEAMS));
  emps.forEach(function (e) { empByName[normName_(e.name)] = e; });

  var kras = idx_(read_(T.KRAS)), kpis = idx_(read_(T.KPIS));
  var holds = {}, teamOf = {};
  read_(T.ASSIGN).forEach(function (a) {
    var kra = kras[a.kra_id]; if (!kra) return;
    if (!holdsDso_(kra.name, (kpis[a.kpi_id] || {}).name)) return;
    var e = emps.filter(function (x) { return String(x.id) === String(a.employee_id); })[0];
    if (!e || isLeaver_(e.name)) return;
    var tm = normName_((teamById[e.team_id] || {}).name);
    if (!Object.prototype.hasOwnProperty.call(DSO_TEAMS_, tm)) return;
    teamOf[a.employee_id] = tm;
    (holds[a.employee_id] = holds[a.employee_id] || []).push(a.kpi_id);
  });
  var holders = Object.keys(holds);
  if (!holders.length) {
    return 'Nobody in ' + Object.keys(DSO_TEAMS_).join(' or ') + ' holds a DSO KPI.';
  }

  var curMonth = currentMonthId_(), nInProgress = 0;
  var acc = {}, vert = {}, unattributed = 0, unattribWhy = {};
  for (var r = 1; r < lastR; r++) {
    var row = g[r];
    if (cStat >= 0 && shipmentExcluded_(row[cStat])) continue;
    var cat = String(row[cCat] || '');
    var shipTeam = dsoTeamOfCategory_(cat);
    if (!shipTeam) continue;
    var pid = periodIdFromDate_(row[cDate]);
    if (!pid || String(pid).replace('per_', '') < DSO_FROM_) continue;
    if (DSO_SKIP_CURRENT_MONTH_ && String(pid) === curMonth) { nInProgress++; continue; }

    var ap = num_(row[cTax]) || 0, aq = num_(row[cCol]) || 0, au = num_(row[cDN]) || 0;
    var wt = ap * DSO_GST_;
    // A negative receivable counts as zero, so an over-collected shipment cannot cancel another's overdue.
    var gmv = Math.max(0, wt - au), recv = Math.max(0, wt - aq - au);

    var vkey = shipTeam + '|' + pid;
    var vk = vert[vkey] || (vert[vkey] = { team: shipTeam, pid: pid, gmv: 0, recv: 0 });
    vk.gmv += gmv; vk.recv += recv;

    var cell = pocForChain_(buyerMaps, String(row[cName] || ''), cat);
    var res = cell ? resolvePocEmployee_(cell, cat, empByName, teamById)
                   : { emp: null, why: 'no POC mapping' };
    if (!res.emp) {
      unattributed++;
      unattribWhy[res.why] = (unattribWhy[res.why] || 0) + 1;
      continue;
    }
    if (teamOf[res.emp.id] !== shipTeam) continue;
    var key = res.emp.id + '|' + pid;
    var a2 = acc[key] || (acc[key] = { emp: res.emp, pid: pid, team: shipTeam,
      gmv: 0, recv: 0, n: 0 });
    a2.gmv += gmv; a2.recv += recv; a2.n++;
  }

  var today = new Date();
  function dsoOf(b) {
    return b.gmv ? b.recv / b.gmv * daysElapsed_(b.pid, today) : null;
  }
  var perf = read_(T.PERF), perfById = {};
  perf.forEach(function (p) { perfById[String(p.id)] = p; });

  var writes = [], kept = [], blanks = [];
  var stale = [];
  if (DSO_SKIP_CURRENT_MONTH_) {
    holders.forEach(function (empId) {
      (holds[empId] || []).forEach(function (kpiId) {
        var id = 'prf_' + empId + '_' + kpiId + '_' + curMonth;
        var p = perfById[id];
        if (!p) return;
        if (String(p.note || '').indexOf(DSO_NOTE_) < 0) return;
        var e = emps.filter(function (x) { return String(x.id) === String(empId); })[0];
        stale.push({ id: id, name: (e || {}).name || empId, actual: p.actual });
      });
    });
  }
  Object.keys(acc).sort().forEach(function (k) {
    var b = acc[k], kpiIds = holds[b.emp.id];
    if (!kpiIds || !kpiIds.length) return;
    var d = dsoOf(b);
    if (d === null) { blanks.push(b.emp.name + '  ' + b.pid.replace('per_', '') +
      '  no GMV'); return; }
    var val = Math.round(d * 10) / 10;
    kpiIds.forEach(function (kpiId) {
      var id = 'prf_' + b.emp.id + '_' + kpiId + '_' + b.pid;
      var prev = perfById[id];
      if (prev && String(prev.note || '').indexOf(DSO_NOTE_) < 0 &&
          String(prev.actual || '') !== '') {
        kept.push(b.emp.name + '  ' + b.pid.replace('per_', '') + '  keeps ' +
          prev.actual + ' (note: ' + (prev.note || 'none') + ')');
        return;
      }
      writes.push({ id: id, emp: b.emp, kpiId: kpiId, pid: b.pid, val: val,
                    team: b.team, gmv: b.gmv, recv: b.recv, n: b.n,
                    was: prev ? prev.actual : '' });
    });
  });

  var pb = parseBands_(DSO_LADDER_), nNothing = 0;
  Object.keys(DSO_TEAMS_).forEach(function (tm) {
    var mine = writes.filter(function (w) { return w.team === tm; });
    var tgt = DSO_TEAMS_[tm].target;
    out.push('=== ' + tm + ' DSO, per POC per month ===');
    out.push('  target ' + (tgt === null ? 'left as the Target Sheet has it'
      : tgt + ' days, written by this import'));
    if (!mine.length) { out.push('  (no POC in ' + tm + ' has attributable buyers)');
      out.push(''); return; }
    out.push('  POC                        month     ships   DSO    rates   was');
    mine.forEach(function (w) {
      var full = daysElapsed_(w.pid, today);
      var none = w.gmv > 0 && w.recv / w.gmv >= 0.999;
      if (none) nNothing++;
      out.push('  ' + String(w.emp.name + '                          ').slice(0, 26) +
        '  ' + w.pid.replace('per_', '') + '   ' + String('   ' + w.n).slice(-4) +
        '   ' + String('     ' + w.val).slice(-6) +
        '   T' + levelFromBands_(pb, w.val) +
        '      ' + (w.was === '' || w.was === null ? '—' : w.was) +
        (none ? '   !! nothing collected (= ' + full + ' days elapsed)' : ''));
    });
    out.push('');
  });
  out.push('');
  out.push('=== each vertical as a whole, for comparison ===');
  Object.keys(vert).sort().forEach(function (k2) {
    var v = vert[k2];
    var d = v.gmv ? v.recv / v.gmv * daysElapsed_(v.pid, today) : null;
    out.push('  ' + String(v.team + '        ').slice(0, 9) +
      v.pid.replace('per_', '') + '   ' +
      (d === null ? '—' : Math.round(d * 10) / 10) + ' days');
  });
  out.push('');
  out.push('=== coverage ===');
  out.push('  POCs holding a DSO KPI                 ' + holders.length +
    '   (' + Object.keys(DSO_TEAMS_).map(function (tm) {
      return tm + ' ' + holders.filter(function (id) {
        return teamOf[id] === tm; }).length;
    }).join(', ') + ')');
  var got = {}; writes.forEach(function (w) { got[w.emp.id] = 1; });
  out.push('  of those, with a number                ' + Object.keys(got).length);
  holders.forEach(function (id) {
    if (got[id]) return;
    var e = emps.filter(function (x) { return String(x.id) === String(id); })[0];
    out.push('    no attributable buyers: ' + ((e || {}).name || id));
  });
  if (DSO_SKIP_CURRENT_MONTH_) {
    out.push('  ' + curMonth.replace('per_', '') + ' is the month IN PROGRESS' +
      ' and is not measured');
    out.push('    ' + nInProgress + ' shipment(s) in it were left out');
    out.push('    (payment terms have not elapsed, so its DSO would be the');
    out.push('     number of days since the month began, not a collections result)');
  }
  out.push('  shipments with no POC                  ' + unattributed);
  Object.keys(unattribWhy).forEach(function (w) {
    out.push('    ' + unattribWhy[w] + ' x  ' + w);
  });
  if (kept.length) {
    out.push('');
    out.push('  KEPT, because somebody typed them by hand:');
    kept.forEach(function (x) { out.push('    ' + x); });
  }
  if (blanks.length) {
    out.push('');
    blanks.forEach(function (x) { out.push('  skipped: ' + x); });
  }
  out.push('');
  if (stale.length) {
    out.push('');
    out.push('  ' + stale.length + ' row(s) written for ' +
      curMonth.replace('per_', '') + ' under the OLD rule will be REMOVED:');
    stale.forEach(function (x) {
      out.push('    ' + x.name + '   was ' + x.actual + ' days');
    });
    out.push('    (the target row is kept, so the month reads "target set,');
    out.push('     nothing achieved yet" rather than disappearing)');
  }
  if (nNothing) {
    out.push('');
    out.push('  !! ' + nNothing + ' of ' + writes.length + ' person-months show NOTHING');
    out.push('     COLLECTED — paid_amount is empty for every shipment, so the');
    out.push('     receivable is the whole invoice and the DSO is just the number');
    out.push('     of days that have elapsed. Those rate T0 regardless of how');
    out.push('     collections actually went. Two innocent explanations (payment');
    out.push('     not yet due, payment not yet recorded in MM_CT) and one that is');
    out.push('     not; worth settling before anybody is rated on them.');
  }
  out.push('');
  out.push('  ladder ' + DSO_LADDER_.join(' | ') + '   (lower is better)');
  Object.keys(DSO_TEAMS_).forEach(function (tm) {
    var tgt = DSO_TEAMS_[tm].target;
    out.push('  ' + String(tm + '        ').slice(0, 9) + 'target ' +
      (tgt === null ? 'unchanged — the Target Sheet keeps it'
        : tgt + ' days = Target ' + levelFromBands_(pb, tgt) + ', written here'));
  });
  out.push('');

  if (dryRun) {
    var wouldPlan = writes.filter(function (w) {
      var t = (DSO_TEAMS_[w.team] || {}).target;
      return t !== null && t !== undefined; }).length;
    out.push('NOTHING WAS WRITTEN, AND NOTHING REMOVED. This is a dry run.');
    out.push(writes.length + ' performance rows and ' + wouldPlan +
      ' plan rows would be written' +
      (stale.length ? ', and ' + stale.length + ' stale row(s) removed' : '') + '.');
    out.push('Run importDsoAchievements() to apply.');
  } else {
    var actor = currentEmail_() || 'system', nPlan = 0;
    writes.forEach(function (w) {
      upsert_(T.PERF, { id: w.id, employee_id: w.emp.id, kpi_id: w.kpiId,
        period_id: w.pid, actual: w.val, manual_level: '', level: '',
        kind: '', direction: '',
        note: dsoWorking_(w.recv, w.gmv, daysElapsed_(w.pid, today), w.n),
        status: 'recorded',
        updated_by: actor, updated_at: nowIso_() });
      var tgtDays = (DSO_TEAMS_[w.team] || {}).target;
      if (tgtDays !== null && tgtDays !== undefined) {
        nPlan++;
        upsert_(T.PLAN, { id: 'pl_' + w.emp.id + '_' + w.kpiId + '_' + w.pid,
          employee_id: w.emp.id, kpi_id: w.kpiId, period_id: w.pid,
          target_value: tgtDays, unit: 'days',
          source: 'derived', rule: 'DSO target ' + tgtDays +
            ' days (KRA owner, 15 Sep 2026)',
          basis_value: '', updated_by: actor, updated_at: nowIso_() });
      }
      recomputeOne_(w.emp.id, w.kpiId, w.pid, actor);
    });
    stale.forEach(function (x) { del_(T.PERF, x.id); });
    audit_(actor, 'system', 'dso_import', 'import',
      null, { rows: writes.length },
      Object.keys(DSO_TEAMS_).join('/') + ' DSO from MM_CT Raw_Shipments');
    commit_();
    out.push('WRITTEN: ' + writes.length + ' performance rows and ' + nPlan +
      ' plan rows.');
    if (stale.length) {
      out.push('REMOVED: ' + stale.length + ' stale row(s) for ' +
        curMonth.replace('per_', '') + ', the month in progress.');
    }
    if (nPlan < writes.length) {
      out.push('  (' + (writes.length - nPlan) + ' rows got no plan row: their team\'s');
      out.push('   target is left to the Target Sheet.)');
    }
    out.push('Reload the dashboard.');
  }
  var txt = out.join(nl);
  Logger.log(txt);
  return txt;
}

function previewDsoAchievements() { return dsoAchievements_(true); }

function importDsoAchievements() { return dsoAchievements_(false); }
// ===== CSV FEEDS =====
var FEED_FOLDER_PROP_ = 'IMPORT_DRIVE_FOLDER';
var FEEDS_ = [
  { key: 'collections', tab: 'Zoho_Collections',
    re: /collect|receivab|ageing|aging|zoho/i,
    prop: 'FEED_MATCH_COLLECTIONS',
    note: 'Zoho Books — the Collections receivables report' },
  { key: 'buyer', tab: 'Meta_Onboarding_Buyer',
    re: /buyer|5711/i,
    prop: 'FEED_MATCH_BUYER',
    note: 'Metabase question 5711 — buyer onboarding cases' },
  { key: 'seller', tab: 'Meta_Onboarding_Seller',
    re: /seller|5712/i,
    prop: 'FEED_MATCH_SELLER',
    note: 'Metabase question 5712 — seller onboarding cases' }
];
function feedMatcher_(feed) {
  var raw = PropertiesService.getScriptProperties().getProperty(feed.prop);
  var sub = raw && String(raw).trim();
  if (!sub) return feed.re;
  return { test: function (nm) { return String(nm).toLowerCase().indexOf(sub.toLowerCase()) >= 0; } };
}

function feedFolder_() {
  var id = PropertiesService.getScriptProperties().getProperty(FEED_FOLDER_PROP_);
  if (!id) {
    return { folder: null, why: 'No import folder yet. Run setupImportFolder() — it ' +
      'creates one, remembers its id, and prints the link. (Or set ' +
      FEED_FOLDER_PROP_ + ' by hand to an existing folder id.)' };
  }
  try { return { folder: DriveApp.getFolderById(String(id).trim()), why: '' }; }
  catch (e) {
    return { folder: null, why: 'Cannot open folder ' + id + ' (' +
      (e && e.message || e) + '). Check the id, and that this account can see it.' };
  }
}

// ===== IMPORT FOLDER =====
function setupImportFolder() {
  var nl = String.fromCharCode(10), out = [];
  var props = PropertiesService.getScriptProperties();
  var had = props.getProperty(FEED_FOLDER_PROP_);
  if (had) {
    try {
      var f = DriveApp.getFolderById(String(had).trim());
      out.push('An import folder is already set, and it opens fine:');
      out.push('  ' + f.getName());
      out.push('  ' + f.getUrl());
      out.push('');
      out.push('Nothing was changed. Drop the CSVs in there and run previewFeeds().');
      return logBack_(out.join(nl));
    } catch (e) {
      out.push('The stored folder id cannot be opened (' + (e && e.message || e) + ').');
      out.push('Making a new one and pointing at that instead.');
      out.push('');
    }
  }
  var folder = DriveApp.createFolder(APP_NAME + ' — CSV imports');
  props.setProperty(FEED_FOLDER_PROP_, folder.getId());
  audit_(currentEmail_() || 'system', 'system', 'import_folder', 'create',
    had || null, { id: folder.getId() }, 'CSV import folder');
  commit_();
  out.push('Created the import folder and remembered it:');
  out.push('  ' + folder.getName());
  out.push('  ' + folder.getUrl());
  out.push('');
  out.push('It is owned by ' + (currentEmail_() || 'this account') + ' and shared with');
  out.push('nobody else. Share it with whoever does the exports if that is not you.');
  out.push('');
  out.push('Now drop the CSVs in, named so each feed can find its own:');
  FEEDS_.forEach(function (feed) {
    out.push('  ' + String(feed.key + '           ').slice(0, 12) +
      'name it to contain ' + String(feed.re));
    out.push('  ' + '            ' + feed.note);
  });
  out.push('');
  out.push('Then run previewFeeds().');
  return logBack_(out.join(nl));
}

function feedFiles_(folder) {
  var it = folder.getFiles(), all = [];
  while (it.hasNext()) {
    var f = it.next(), nm = String(f.getName() || '');
    if (!/\.csv$/i.test(nm)) continue;
    all.push({ file: f, name: nm, date: f.getLastUpdated(), id: f.getId() });
  }
  all.sort(function (a, b) { return b.date - a.date; });
  return all;
}

function csvHeaderRow_(grid) {
  var at = 0, widest = 0;
  for (var r = 0; r < Math.min(10, grid.length); r++) {
    var w = grid[r].filter(function (c) { return String(c || '').trim() !== ''; }).length;
    if (w > widest) { widest = w; at = r; }
  }
  return at;
}

function feedLand_(feed, hit, dryRun, out) {
  var props = PropertiesService.getScriptProperties();
  var grid;
  try { grid = Utilities.parseCsv(hit.file.getBlob().getDataAsString()); }
  catch (e) { out.push('  !! could not parse: ' + (e && e.message || e)); return 0; }
  if (!grid || !grid.length) { out.push('  !! the file is empty'); return 0; }

  var hr = csvHeaderRow_(grid);
  var header = grid[hr].map(function (c) { return String(c == null ? '' : c).trim(); });
  var body = grid.slice(hr + 1).filter(function (row) {
    return row.some(function (c) { return String(c || '').trim() !== ''; });
  });

  out.push('  header on row ' + (hr + 1) + ', ' + body.length + ' data row(s)');
  header.forEach(function (hname, i) {
    if (!hname) return;
    var sample = '', k = 0;
    while (k < body.length && sample === '') {
      sample = String(body[k][i] == null ? '' : body[k][i]).trim(); k++;
    }
    out.push('    ' + colLetter_(i + 1) + '  ' + hname +
      (sample ? '   e.g. ' + sample.slice(0, 44) : '   (blank in every row)'));
  });

  var sigProp = 'FEED_HEADER_' + feed.key.toUpperCase();
  var sig = header.join('|'), was = props.getProperty(sigProp);
  if (was && was !== sig) {
    out.push('  !! THE COLUMNS HAVE CHANGED since the last run. Anything reading');
    out.push('     this tab by position is now reading a different column.');
    out.push('     was: ' + was);
  } else if (was) {
    out.push('  columns unchanged since the last run');
  }

  if (dryRun) return body.length;

  var sh = ss_().getSheetByName(feed.tab);
  if (!sh) sh = ss_().insertSheet(feed.tab);
  sh.clear();
  var all = [header].concat(body.map(function (row) {
    var copy = row.slice(0, header.length);
    while (copy.length < header.length) copy.push('');
    return copy;
  }));
  sh.getRange(1, 1, all.length, header.length).setValues(all);
  props.setProperty(sigProp, sig);
  props.setProperty('FEED_FILE_' + feed.key.toUpperCase(), hit.id);
  out.push('  WRITTEN to "' + feed.tab + '"');
  return body.length;
}

function feedIngest_(dryRun, onlyKey) {
  var nl = String.fromCharCode(10), out = [];
  var fol = feedFolder_();
  out.push('=== the folder ===');
  if (!fol.folder) { out.push('  ' + fol.why); return logBack_(out.join(nl)); }
  out.push('  ' + fol.folder.getName());
  var files = feedFiles_(fol.folder);
  out.push('  ' + files.length + ' CSV file(s)');
  out.push('');

  var claimed = {}, total = 0;
  FEEDS_.forEach(function (feed) {
    if (onlyKey && feed.key !== onlyKey) return;
    var m = feedMatcher_(feed);
    var hit = null;
    for (var i = 0; i < files.length; i++) {
      if (claimed[files[i].id]) continue;
      if (m.test(files[i].name)) { hit = files[i]; break; }
    }
    out.push('=== ' + feed.key + '  ->  ' + feed.tab + ' ===');
    out.push('  ' + feed.note);
    if (!hit) {
      out.push('  no CSV in the folder matches ' + String(feed.re) +
        '   (override with ' + feed.prop + ')');
      out.push('');
      return;
    }
    claimed[hit.id] = true;
    out.push('  file     ' + hit.name);
    out.push('  updated  ' + Utilities.formatDate(hit.date,
      Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm'));
    total += feedLand_(feed, hit, dryRun, out);
    out.push('');
  });

  var spare = files.filter(function (f) { return !claimed[f.id]; });
  if (spare.length) {
    out.push('=== matched no feed ===');
    out.push('  These are ignored. If one of them IS a feed, rename it or set the');
    out.push('  feed\'s match property, because right now it is being skipped.');
    spare.slice(0, 15).forEach(function (f) { out.push('    ' + f.name); });
    out.push('');
  }

  if (dryRun) {
    out.push('NOTHING WAS WRITTEN. This is a dry run.');
    out.push(total + ' row(s) would be landed. Run importFeeds() to apply.');
  } else {
    audit_(currentEmail_() || 'system', 'system', 'feed_ingest', 'import',
      null, { rows: total }, 'CSV feeds from ' + fol.folder.getName());
    commit_();
    out.push('WRITTEN: ' + total + ' row(s).');
    out.push('Nothing is scored from them yet — the TAT needs its status-history');
    out.push('columns named, which the profile above is for.');
  }
  return logBack_(out.join(nl));
}

function previewFeeds() { return feedIngest_(true, ''); }

function importFeeds() { return feedIngest_(false, ''); }

function previewZohoReport() { return feedIngest_(true, 'collections'); }

function importZohoReport() { return feedIngest_(false, 'collections'); }

function describeZohoTab() { return describeTab_(ss_().getId(), 'Zoho_Collections', 200); }
function describeMetaBuyer() { return describeTab_(ss_().getId(), 'Meta_Onboarding_Buyer', 200); }
function describeMetaSeller() { return describeTab_(ss_().getId(), 'Meta_Onboarding_Seller', 200); }
// ===== METABASE =====
var META_URL_PROP_ = 'METABASE_URL';
var META_KEY_PROP_ = 'METABASE_API_KEY';
var META_DEFAULT_URL_ = 'https://meta.recykal.com';
var META_CARDS_ = [
  { key: 'buyer',  card: 5711, tab: 'Meta_Onboarding_Buyer' },
  { key: 'seller', card: 5712, tab: 'Meta_Onboarding_Seller' }
];
var ONBOARD_FROM_ = '2026-04-01';

// ===== ONBOARDING OWNERS =====
var ONBOARD_IGNORE_ = [
  { vertical: /^SUPPORT$/, why: 'Support is not onboarded by this team' }
];
function onboardingIgnored_(vertical, category) {
  var v = normName_(vertical), c = normName_(category);
  for (var i = 0; i < ONBOARD_IGNORE_.length; i++) {
    var r = ONBOARD_IGNORE_[i];
    if (r.vertical && !r.vertical.test(v)) continue;
    if (r.category && !r.category.test(c)) continue;
    return r;
  }
  return null;
}
// First match wins, EPR first. A rule naming vertical and category needs both. One KRA, one TAT.
var ONBOARDING_OWNERS_ = [
  { vertical: /^EPR$/, who: 'NAVEEN RANGA', tatDays: 3,
    kra: 'EPR – Buyer & Seller Onboarding' },
  { vertical: /^OPEN MARKETPLACE$/, who: 'VAMSI', tatDays: 1,
    kra: 'Open Marketplace – Buyer & Seller Onboarding' },
  { vertical: /^MARKETPLACE$/, category: /^AFR$/, who: 'HARSHITA', tatDays: 3,
    kra: 'AFR – Buyer & Seller Onboarding' },
  { vertical: /^MARKETPLACE$/, category: /^(INFRA|METAL)$/, who: 'HARSHITA', tatDays: 3,
    kra: 'INFRA – Buyer & Seller Onboarding' },
  { vertical: /^MARKETPLACE$/, category: /^RE COMMERCE$/, who: 'VAMSI', tatDays: 1,
    kra: 'Re-Commerce – Seller Onboarding' },
  { vertical: /^MARKETPLACE$/, category: /^(PLASTIC|E WASTE)$/, who: 'VAMSI', tatDays: 1,
    kra: 'Open Marketplace – Buyer & Seller Onboarding' },
  { vertical: /^SUSTAINABILITY SERVICES$/, category: /^PLASTIC$/,
    who: 'NAVEEN RANGA', tatDays: 3, kra: 'EPR – Buyer & Seller Onboarding' }
];
function onboardingOwner_(vertical, category) {
  var v = normName_(vertical), c = normName_(category);
  for (var i = 0; i < ONBOARDING_OWNERS_.length; i++) {
    var r = ONBOARDING_OWNERS_[i];
    if (r.vertical && !r.vertical.test(v)) continue;
    if (r.category && !r.category.test(c)) continue;
    return r;
  }
  return null;
}

function metaUrl_() {
  var u = PropertiesService.getScriptProperties().getProperty(META_URL_PROP_);
  return String(u || META_DEFAULT_URL_).replace(/\/+$/, '');
}

function metaFetchCard_(cardId) {
  var key = PropertiesService.getScriptProperties().getProperty(META_KEY_PROP_);
  if (!key) {
    return { ok: false, why: 'No ' + META_KEY_PROP_ + ' in Script Properties. ' +
      'API keys in Metabase are created by ADMINS only, and admin access was ' +
      'not available (21 Sep 2026), so this path is dormant. Use the Drive ' +
      'route instead: export questions 5711 and 5712 as CSV, drop them in the ' +
      'IMPORT_DRIVE_FOLDER, and run previewFeeds(). Do NOT put a password in ' +
      'this project to work around the missing key.' };
  }
  var url = metaUrl_() + '/api/card/' + cardId + '/query/csv';
  var res;
  try {
    res = UrlFetchApp.fetch(url, {
      method: 'post',
      headers: { 'x-api-key': String(key).trim() },
      muteHttpExceptions: true,
      followRedirects: true
    });
  } catch (e) {
    return { ok: false, why: 'Could not reach ' + metaUrl_() + ' (' +
      (e && e.message || e) + '). If this is a VPN-only host, Apps Script ' +
      'cannot see it and the Drive-export route is the alternative.' };
  }
  var code = res.getResponseCode();
  if (code === 401 || code === 403) {
    return { ok: false, code: code, why: 'Metabase refused the key (HTTP ' + code +
      '). Check it is an API key rather than a password, that it is still ' +
      'active, and that its group can see question ' + cardId + '.' };
  }
  if (code !== 200) {
    return { ok: false, code: code, why: 'HTTP ' + code + ' from Metabase: ' +
      String(res.getContentText() || '').slice(0, 300) };
  }
  return { ok: true, code: code, text: res.getContentText() };
}

// ===== METABASE LANDING =====
function metaIngest_(dryRun) {
  var nl = String.fromCharCode(10), out = [];
  var key = PropertiesService.getScriptProperties().getProperty(META_KEY_PROP_);
  out.push('=== connection ===');
  out.push('  host      ' + metaUrl_());
  out.push('  api key   ' + (key ? 'set, ' + String(key).trim().length +
    ' characters (never logged)' : 'NOT SET'));
  out.push('  cases     In Review on or after ' + ONBOARD_FROM_);
  out.push('');

  var landed = 0;
  for (var i = 0; i < META_CARDS_.length; i++) {
    var c = META_CARDS_[i];
    out.push('=== question ' + c.card + '  (' + c.key + ') ===');
    var got = metaFetchCard_(c.card);
    if (!got.ok) { out.push('  !! ' + got.why); out.push(''); continue; }
    var grid;
    try { grid = Utilities.parseCsv(got.text); }
    catch (e) { out.push('  !! could not parse the CSV: ' + (e && e.message || e));
      out.push(''); continue; }
    if (!grid || grid.length < 2) { out.push('  no rows returned'); out.push(''); continue; }

    var header = grid[0].map(function (x) { return String(x == null ? '' : x).trim(); });
    var body = grid.slice(1);
    out.push('  ' + body.length + ' row(s), ' + header.length + ' column(s)');
    header.forEach(function (hname, ci) {
      var sample = '', k = 0;
      while (k < body.length && sample === '') {
        sample = String(body[k][ci] == null ? '' : body[k][ci]).trim(); k++;
      }
      out.push('    ' + colLetter_(ci + 1) + '  ' + (hname || '(no header)') +
        (sample ? '   e.g. ' + sample.slice(0, 44) : '   (blank in every row)'));
    });

    var vi = -1;
    header.forEach(function (hname, ci) {
      if (vi < 0 && /vertical|business.*type|category|line.*business/i.test(hname)) vi = ci;
    });
    out.push('');
    if (vi < 0) {
      out.push('  no column looks like the business vertical — name it below and');
      out.push('  the owner rules can be checked against it.');
    } else {
      out.push('  vertical column looks like ' + colLetter_(vi + 1) + '  "' +
        header[vi] + '"');
      var tally = {}, unmatched = {};
      body.forEach(function (row) {
        var v = String(row[vi] == null ? '' : row[vi]).trim();
        if (!v) return;
        var o = onboardingOwner_(v);
        if (o) { var t = o.who + '  <- ' + v; tally[t] = (tally[t] || 0) + 1; }
        else unmatched[v] = (unmatched[v] || 0) + 1;
      });
      out.push('  the owner rules against the real values:');
      Object.keys(tally).sort().forEach(function (t) {
        out.push('    ' + String(tally[t] + '     ').slice(0, 5) + t);
      });
      var un = Object.keys(unmatched);
      if (un.length) {
        out.push('    !! ' + un.length + ' vertical value(s) match NO rule — those');
        out.push('       cases would be attributed to nobody:');
        un.sort().slice(0, 12).forEach(function (v) {
          out.push('         ' + unmatched[v] + '  ' + v);
        });
      } else {
        out.push('    every vertical value matched a rule');
      }
    }
    out.push('');

    if (!dryRun) {
      var sh = ss_().getSheetByName(c.tab);
      if (!sh) sh = ss_().insertSheet(c.tab);
      sh.clear();
      var all = [header].concat(body.map(function (row) {
        var copy = row.slice(0, header.length);
        while (copy.length < header.length) copy.push('');
        return copy;
      }));
      sh.getRange(1, 1, all.length, header.length).setValues(all);
      landed += body.length;
      out.push('  WRITTEN to "' + c.tab + '"');
      out.push('');
    }
  }

  if (dryRun) {
    out.push('NOTHING WAS WRITTEN. This is a dry run.');
    out.push('Run importMetabase() to land both questions into their tabs.');
  } else {
    audit_(currentEmail_() || 'system', 'system', 'metabase_ingest', 'import',
      null, { rows: landed }, 'Metabase cards ' +
      META_CARDS_.map(function (c) { return c.card; }).join(', '));
    commit_();
    out.push('WRITTEN: ' + landed + ' row(s) across ' + META_CARDS_.length + ' tab(s).');
    out.push('Nothing is scored from them yet — the TAT needs the status-history');
    out.push('columns named, which the profile above is for.');
  }
  return logBack_(out.join(nl));
}

function previewMetabase() { return metaIngest_(true); }

function importMetabase() { return metaIngest_(false); }

function explainOnboardingOwners() {
  var nl = String.fromCharCode(10), out = [];
  out.push('Business vertical -> who owns the case, first match wins:');
  out.push('');
  ONBOARDING_OWNERS_.forEach(function (o, i) {
    out.push('  ' + (i + 1) + '. ' + String(o.re) + nl +
      '       -> ' + o.who + '   TAT ' + o.tatDays +
      (o.tatDays === 1 ? ' day' : ' days') + nl +
      '       -> ' + o.kra);
  });
  out.push('');
  out.push('Order matters: a vertical naming both Open Marketplace and EPR goes');
  out.push('to VAMSI, because Open Marketplace is tested first.');
  out.push('');
  out.push('AFR and INFRA are SEPARATE KRAs for HARSHITA, 0.25 each. A merged');
  out.push('figure could not be written to either.');
  out.push('');
  out.push('The ladder on all four is 0.8|0.85|0.9|0.95|1.0 — a RATIO — so the');
  out.push('achievement is the SHARE OF CASES MEETING TAT, not the mean days.');
  out.push('100% of cases within TAT is Target 5; 80% is Target 1.');
  return logBack_(out.join(nl));
}
// ===== ONBOARDING PROFILES =====
var ONBOARD_TABS_ = [
  { key: 'buyer',  tab: 'Meta_Onboarding_Buyer' },
  { key: 'seller', tab: 'Meta_Onboarding_Seller' }
];

function isoDay_(v) {
  if (v instanceof Date && !isNaN(v.getTime())) {
    return Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  }
  var t = String(v == null ? '' : v).trim();
  if (!t) return '';
  var m = t.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return m[0];
  var d = new Date(t);
  return isNaN(d.getTime())
    ? '' : Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

function profileOnboarding() {
  var nl = String.fromCharCode(10), out = [];
  ONBOARD_TABS_.forEach(function (T2) {
    var sh = ss_().getSheetByName(T2.tab);
    out.push('=== ' + T2.tab + ' ===');
    if (!sh) {
      out.push('  not landed yet — run importFeeds() first');
      out.push('');
      return;
    }
    var lastR = sh.getLastRow(), lastC = sh.getLastColumn();
    if (lastR < 2) { out.push('  empty'); out.push(''); return; }
    var g = sh.getRange(1, 1, lastR, lastC).getValues();
    var header = g[0].map(function (x) { return String(x == null ? '' : x).trim(); });
    out.push('  ' + (lastR - 1) + ' row(s), ' + lastC + ' column(s)');

    var byName = {};
    header.forEach(function (hname, i) {
      if (!hname) return;
      (byName[hname] = byName[hname] || []).push(i);
    });
    var dups = Object.keys(byName).filter(function (k) { return byName[k].length > 1; });
    if (dups.length) {
      out.push('');
      out.push('  !! ' + dups.length + ' column NAME(S) APPEAR MORE THAN ONCE.');
      out.push('     Looking one up by name silently takes the first. Use the');
      out.push('     letters below.');
      dups.slice(0, 8).forEach(function (k) {
        var at = byName[k].map(function (i) { return colLetter_(i + 1); });
        var off = '';
        var a = String(g[1][byName[k][0]] || ''), b = String(g[1][byName[k][1]] || '');
        if (/^\d{4}-\d{2}-\d{2}T/.test(a) && /^\d{4}-\d{2}-\d{2}T/.test(b)) {
          var da = new Date(a.replace(' ', 'T')), db = new Date(b.replace(' ', 'T'));
          var mins = Math.round((db - da) / 60000);
          if (mins) off = '   ' + (mins > 0 ? '+' : '') + mins + ' min apart' +
            (Math.abs(mins) === 330 ? '  (that is IST vs UTC)' : '');
        }
        out.push('       ' + k + '   at ' + at.join(', ') + off);
      });
    }

    function census(label, re, cap) {
      var ci = -1;
      for (var i = 0; i < header.length; i++) {
        if (re.test(header[i])) { ci = i; break; }
      }
      if (ci < 0) { out.push(''); out.push('  no column matching ' + String(re)); return null; }
      var seen = {};
      for (var r = 1; r < g.length; r++) {
        var v = String(g[r][ci] == null ? '' : g[r][ci]).trim();
        seen[v || '(blank)'] = (seen[v || '(blank)'] || 0) + 1;
      }
      var keys = Object.keys(seen).sort(function (a, b) { return seen[b] - seen[a]; });
      out.push('');
      out.push('  ' + label + '  — ' + colLetter_(ci + 1) + '  "' + header[ci] +
        '"   ' + keys.length + ' distinct');
      keys.slice(0, cap || 20).forEach(function (k) {
        out.push('    ' + String(seen[k] + '        ').slice(0, 7) + k);
      });
      if (keys.length > (cap || 20)) out.push('    ... and ' + (keys.length - (cap || 20)) + ' more');
      return { ci: ci, keys: keys, seen: seen };
    }

    var vert = census('BUSINESS VERTICAL', /^business_vertical$/i, 25);
    census('STATUS', /^(onboarding_status|status)$/i, 15);
    census('CURRENT STATUS', /^current_status$/i, 15);
    census('CATEGORY', /^business_category$/i, 15);

    if (vert) {
      out.push('');
      out.push('  THE OWNER RULES AGAINST THOSE VALUES:');
      var matched = 0, unmatched = 0;
      vert.keys.forEach(function (v) {
        if (v === '(blank)') { unmatched += vert.seen[v]; return; }
        var o = onboardingOwner_(v, '');
        if (o) { matched += vert.seen[v];
          out.push('    ' + String(vert.seen[v] + '        ').slice(0, 7) + v +
            '   -> ' + o.who + '   TAT ' + o.tatDays + 'd'); }
        else { unmatched += vert.seen[v];
          out.push('    ' + String(vert.seen[v] + '        ').slice(0, 7) + v +
            '   -> NO RULE MATCHES'); }
      });
      out.push('    ---');
      out.push('    ' + matched + ' row(s) would be attributed, ' + unmatched +
        ' would be attributed to NOBODY');
    }

    out.push('');
    out.push('  DATE COVERAGE from ' + ONBOARD_FROM_ + ':');
    header.forEach(function (hname, i) {
      if (!/date|_at$|_on$/i.test(hname)) return;
      var inWin = 0, filled = 0, min = '', max = '';
      for (var r = 1; r < g.length; r++) {
        var d = isoDay_(g[r][i]);
        if (!d) continue;
        filled++;
        if (!min || d < min) min = d;
        if (!max || d > max) max = d;
        if (d >= ONBOARD_FROM_) inWin++;
      }
      if (!filled) return;
      out.push('    ' + colLetter_(i + 1) + '  ' +
        String(hname + '                              ').slice(0, 30) +
        String('      ' + filled).slice(-6) + ' filled' +
        String('        ' + inWin).slice(-8) + ' in window   ' + min + ' .. ' + max);
    });
    out.push('');
  });
  return logBack_(out.join(nl));
}

// ===== ONBOARDING ATTRIBUTION =====
function previewOnboardingAttribution() {
  var nl = String.fromCharCode(10), out = [];
  var grand = {}, moved = 0, movedRows = [];

  ONBOARD_TABS_.forEach(function (T2) {
    var sh = ss_().getSheetByName(T2.tab);
    out.push('=== ' + T2.tab + ' ===');
    if (!sh || sh.getLastRow() < 2) {
      out.push('  not landed yet — run importFeeds() first'); out.push(''); return;
    }
    var g = sh.getRange(1, 1, sh.getLastRow(), sh.getLastColumn()).getValues();
    var header = g[0].map(function (x) { return String(x == null ? '' : x).trim(); });
    function find(re) {
      for (var i = 0; i < header.length; i++) if (re.test(header[i])) return i;
      return -1;
    }
    var vi = find(/^business_vertical$/i), ci = find(/^business_category$/i);
    if (vi < 0 || ci < 0) {
      out.push('  needs both business_vertical and business_category'); out.push(''); return;
    }
    out.push('  vertical ' + colLetter_(vi + 1) + '   category ' + colLetter_(ci + 1));

    var cell = {}, rows = 0;
    for (var r = 1; r < g.length; r++) {
      var v = String(g[r][vi] == null ? '' : g[r][vi]).trim() || '(blank)';
      var c = String(g[r][ci] == null ? '' : g[r][ci]).trim() || '(blank)';
      var o = onboardingOwner_(v, c);
      var who = o ? o.who : '— NOBODY';
      var k = v + ' ¦ ' + c;
      var e = cell[k] || (cell[k] = { v: v, c: c, who: who, n: 0, kra: o ? o.kra : '' });
      e.n++; rows++;
      grand[who] = (grand[who] || 0) + 1;
      if (o && o.category && normName_(v) === 'EPR') {
        moved++;
        if (movedRows.length < 6) movedRows.push(T2.key + '  ' + v + ' / ' + c +
          '  -> ' + o.who);
      }
    }

    var keys = Object.keys(cell).sort(function (a, b) { return cell[b].n - cell[a].n; });
    out.push('');
    out.push('  rows   vertical                  category              -> owner');
    keys.forEach(function (k) {
      var e = cell[k];
      out.push('  ' + String(e.n + '      ').slice(0, 6) +
        String(e.v + '                         ').slice(0, 26) +
        String(e.c + '                      ').slice(0, 22) + '-> ' + e.who);
    });
    out.push('  ' + rows + ' row(s) in this tab');
    out.push('');
  });

  out.push('=== who ends up with what, across both tabs ===');
  Object.keys(grand).sort(function (a, b) { return grand[b] - grand[a]; })
    .forEach(function (w) {
      out.push('  ' + String(grand[w] + '        ').slice(0, 8) + w);
    });

  out.push('');
  out.push('=== the cost of the rule order ===');
  if (!moved) {
    out.push('  No EPR row is claimed by a category rule, which is the ruling:');
    out.push('  EPR is tested first, so a Metal or AFR category can never take');
    out.push('  one. There is no EPR/Metal row in the data today either.');
  } else {
    out.push('  ' + moved + ' row(s) have vertical EPR but were taken by a CATEGORY');
    out.push('  rule, so they go to HARSHITA rather than NAVEEN. That follows the');
    out.push('  stated order (Open Marketplace, then AFR & Infra, then EPR).');
    out.push('  Move the EPR rule above the two category rules to reverse it.');
    movedRows.forEach(function (x) { out.push('    ' + x); });
  }
  out.push('');
  out.push('NOTHING WAS WRITTEN.');
  return logBack_(out.join(nl));
}
// ===== SELLER ONBOARDING TAT =====
var SELLER_TAB_ = 'Meta_Onboarding_Seller';
// Pinned to letters (header names repeat). SELLER_EXPECT_ is checked every run; a mismatch refuses to compute.
var SELLER_COLS_ = {
  id: 'A', name: 'B', vertical: 'E', category: 'F', status: 'H',
  submitted: 'L',
  approvals: ['Z', 'AF', 'AL', 'AR'],
  rejections: ['AB', 'AD', 'AH', 'AJ', 'AN', 'AP', 'AT', 'AV']
};
var SELLER_EXPECT_ = {
  A: 'id', B: 'business_name', E: 'business_vertical', F: 'business_category',
  H: 'status', L: 'review_submission_date',
  Z: 'level1_approved_at', AF: 'level2_approved_at',
  AL: 'level3_approved_at', AR: 'level4_approved_at',
  AB: 'level1_rejected1_at', AD: 'level1_rejected2_at',
  AH: 'level2_rejected1_at', AJ: 'level2_rejected2_at',
  AN: 'level3_rejected1_at', AP: 'level3_rejected2_at',
  AT: 'level4_rejected1_at', AV: 'level4_rejected2_at'
};
var ONBOARD_DONE_ = 'COMPLETED';
var ONBOARD_LADDER_ = ['0.8', '0.85', '0.9', '0.95', '1.0'];

function cellDate_(v) {
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
  var t = String(v == null ? '' : v).trim();
  if (!t) return null;
  var d = new Date(t.indexOf('T') > 0 ? t : t.replace(' ', 'T'));
  return isNaN(d.getTime()) ? null : d;
}
function col_(letter) { return letterCol_(letter) - 1; }

function sellerTat_(dryRun) {
  ensureSeeded_();
  var nl = String.fromCharCode(10), out = [];
  var sh = ss_().getSheetByName(SELLER_TAB_);
  if (!sh || sh.getLastRow() < 2) {
    return logBack_(SELLER_TAB_ + ' is not landed yet — run importFeeds() first.');
  }
  var g = sh.getRange(1, 1, sh.getLastRow(), sh.getLastColumn()).getValues();
  var header = g[0].map(function (x) { return String(x == null ? '' : x).trim(); });

  out.push('=== the columns being read ===');
  var bad = 0;
  Object.keys(SELLER_EXPECT_).forEach(function (L) {
    var i = col_(L), got = header[i] || '(none)';
    var ok = got === SELLER_EXPECT_[L];
    if (!ok) bad++;
    out.push('  ' + String(L + '   ').slice(0, 4) + (ok ? 'ok  ' : '!!  ') +
      SELLER_EXPECT_[L] + (ok ? '' : '   BUT FOUND "' + got + '"'));
  });
  if (bad) {
    out.push('');
    out.push('  ' + bad + ' column(s) are not what this expects. A column has been');
    out.push('  inserted or removed upstream and every figure below would be');
    out.push('  wrong. Refusing to compute. Re-point SELLER_COLS_ first.');
    return logBack_(out.join(nl));
  }
  out.push('  all ' + Object.keys(SELLER_EXPECT_).length + ' as expected');
  out.push('');

  var iId = col_(SELLER_COLS_.id), iNm = col_(SELLER_COLS_.name);
  var iV = col_(SELLER_COLS_.vertical), iC = col_(SELLER_COLS_.category);
  var iS = col_(SELLER_COLS_.status), iSub = col_(SELLER_COLS_.submitted);
  var iApp = SELLER_COLS_.approvals.map(col_);
  var iRej = SELLER_COLS_.rejections.map(col_);

  var skip = { notDone: 0, noOwner: 0, noSubmit: 0, noApproval: 0, before: 0,
               negative: 0, ignored: 0 };
  var scored = 0;
  var negEx = [], buckets = {}, restarted = 0, restartEx = [];
  var zero = 0, sameStamp = 0, straddle = 0, subHour = 0, sameOneLevel = 0;
  var noOwnerBy = {};

  for (var r = 1; r < g.length; r++) {
    var row = g[r];
    if (String(row[iS] || '').trim().toUpperCase() !== ONBOARD_DONE_) { skip.notDone++; continue; }

    var end = null;
    iApp.forEach(function (i) {
      var d = cellDate_(row[i]);
      if (d && (!end || d > end)) end = d;
    });
    if (!end) { skip.noApproval++; continue; }

    var sub = cellDate_(row[iSub]);
    if (!sub) { skip.noSubmit++; continue; }
    var start = sub, wasRestarted = false;
    iRej.forEach(function (i) {
      var d = cellDate_(row[i]);
      if (d && d < end && d > start) { start = d; wasRestarted = true; }
    });
    if (wasRestarted) {
      restarted++;
      if (restartEx.length < 5) restartEx.push('    ' + row[iNm] +
        '   submitted ' + Utilities.formatDate(sub, 'UTC', 'yyyy-MM-dd') +
        '  -> restarted ' + Utilities.formatDate(start, 'UTC', 'yyyy-MM-dd'));
    }

    var startDay = Utilities.formatDate(start, Session.getScriptTimeZone(), 'yyyy-MM-dd');
    var endDay = Utilities.formatDate(end, Session.getScriptTimeZone(), 'yyyy-MM-dd');
    if (startDay < ONBOARD_FROM_ && endDay >= ONBOARD_FROM_) straddle++;
    if (startDay < ONBOARD_FROM_) { skip.before++; continue; }

    if (onboardingIgnored_(row[iV], row[iC])) { skip.ignored++; continue; }
    var owner = onboardingOwner_(row[iV], row[iC]);
    if (!owner) {
      skip.noOwner++;
      var gk = String(row[iV] || '(blank)').trim() + '  /  ' +
               String(row[iC] || '(blank)').trim();
      noOwnerBy[gk] = (noOwnerBy[gk] || 0) + 1;
      continue;
    }

    var day = Utilities.formatDate(end, Session.getScriptTimeZone(), 'yyyy-MM-dd');

    var days = (end - start) / 86400000;
    if (days < 0) {
      skip.negative++;
      if (negEx.length < 5) negEx.push('    ' + row[iNm] + '   approved ' +
        Math.abs(Math.round(days * 10) / 10) + ' days BEFORE its submission');
      continue;
    }

    if (days * 24 < 1) subHour++;
    if (days === 0) zero++;
    var firstApp = null, levels = 0;
    iApp.forEach(function (i) {
      var d = cellDate_(row[i]);
      if (!d) return;
      levels++;
      if (!firstApp || d < firstApp) firstApp = d;
    });
    if (firstApp && Math.abs(firstApp.getTime() - sub.getTime()) < 1000) {
      sameStamp++;
      if (levels === 1) sameOneLevel++;
    }
    var period = 'per_' + day.slice(0, 7);
    var k = owner.who + '\u00a6' + owner.kra + '\u00a6' + period;
    var b = buckets[k] || (buckets[k] = { who: owner.who, kra: owner.kra,
      tat: owner.tatDays, period: period, n: 0, met: 0, sum: 0 });
    b.n++; b.sum += days; scored++;
    if (days <= owner.tatDays) b.met++;
  }

  var pb = parseBands_(ONBOARD_LADDER_);
  var keys = Object.keys(buckets).sort();
  out.push('=== share of cases meeting TAT ===');
  if (!keys.length) {
    out.push('  nothing to score');
  } else {
    out.push('  who           KRA                              month     TAT  cases  met   share  rates  mean days');
    keys.forEach(function (k) {
      var b = buckets[k], share = b.met / b.n;
      out.push('  ' + String(b.who + '              ').slice(0, 14) +
        String(b.kra + '                                 ').slice(0, 33) +
        b.period.replace('per_', '') + '    ' + b.tat + 'd' +
        String('      ' + b.n).slice(-6) + String('     ' + b.met).slice(-5) +
        String('       ' + Math.round(share * 100) + '%').slice(-7) +
        '     T' + levelFromBands_(pb, share) +
        String('         ' + (Math.round(b.sum / b.n * 10) / 10)).slice(-8));
    });
  }
  out.push('');
  out.push('  ladder ' + ONBOARD_LADDER_.join(' | ') + '   (a RATIO: the share, not the days)');
  out.push('');

  var total = g.length - 1;
  out.push('=== the funnel ===');
  out.push('  rows in the tab                      ' + total);
  out.push('  less not ' + ONBOARD_DONE_ + '                    -' + skip.notDone);
  out.push('  less no approval recorded            -' + skip.noApproval);
  out.push('  less no submission date              -' + skip.noSubmit);
  out.push('  less in review before ' + ONBOARD_FROM_ + '     -' + skip.before);
  out.push('     of which straddling the cutoff — in review before, approved');
  out.push('     after: ' + straddle);
  if (straddle) {
    out.push('       Those ' + straddle + ' would have been INCLUDED by filtering on the');
    out.push('       approval date instead, and are excluded here because they');
    out.push('       entered review before ' + ONBOARD_FROM_ + '. That is the ruling.');
  } else {
    out.push('       None, so filtering on the approval and on the in-review date');
    out.push('       would select the same population.');
  }
  out.push('     The in-review date is the REVISED one, so a 2025 case');
  out.push('     resubmitted after ' + ONBOARD_FROM_ + ' is in scope, not out.');
  out.push('    = in scope                         ' +
    (skip.noOwner + skip.negative + scored + skip.ignored));
  out.push('  less out of scope by ruling          -' + skip.ignored +
    (skip.ignored ? '   (Support)' : ''));
  out.push('  less belongs to nobody               -' + skip.noOwner);
  if (skip.negative) out.push('  less negative duration               -' + skip.negative);
  out.push('    = SCORED                           ' + scored);
  if (skip.negative) {
    out.push('  !! approved BEFORE submission   ' + skip.negative);
    out.push('     A negative duration is a data fault, not a fast case, so these');
     out.push('     are excluded rather than counted as met:');
    negEx.forEach(function (x) { out.push(x); });
  }
  out.push('');
  if (subHour || sameStamp) {
    out.push('=== is the submission stamp real? ===');
    out.push('  scored cases                              ' + scored);
    out.push('  completed in under an hour                ' + subHour);
    out.push('  submission stamp == first approval stamp  ' + sameStamp);
    out.push('    of those, the ONLY approval was level1  ' + sameOneLevel);
    out.push('');
    if (sameStamp === 0) {
      out.push('  The stamps are never identical, so the sub-hour cases are');
      out.push('  genuinely fast approvals rather than an artefact. The TAT is');
      out.push('  measuring something real.');
    } else if (sameOneLevel) {
      out.push('  !! ' + sameOneLevel + ' case(s) have the submission stamped at the same');
      out.push('     moment as their ONLY approval. For those the TAT is zero by');
      out.push('     construction and counts as met, so the share is overstated by');
      out.push('     up to ' + Math.round(sameOneLevel / Math.max(scored, 1) * 100) + '%.');
      out.push('     Worth asking whether review_submission_date is recorded at');
      out.push('     submission or written from the level1 approval.');
    } else {
      out.push('  The stamps coincide on ' + sameStamp + ' case(s), but each of those has a');
      out.push('  later approval, so the TAT is still measured against real work.');
    }
    out.push('');
  }
  if (zero) {
    out.push('  !! ' + zero + ' scored case(s) have a TAT of EXACTLY ZERO, of which');
    out.push('     ' + sameStamp + ' have review_submission_date identical to the first');
    out.push('     approval to the second. For those the submission timestamp looks');
    out.push('     derived from the approval rather than recorded when the case was');
    out.push('     submitted, so the 0 days is an artefact and counts as MET.');
    out.push('');
  }
  var thin = keys.filter(function (k) { return buckets[k].n < 5; });
  if (thin.length) {
    out.push('  !! ' + thin.length + ' of ' + keys.length + ' person-months rest on FEWER');
    out.push('     THAN 5 cases. One case then decides a whole rating: a single');
    out.push('     miss reads as 0% and rates Target 0.');
    thin.forEach(function (k) {
      var b = buckets[k];
      out.push('       ' + b.period.replace('per_', '') + '  ' +
        String(b.who + '            ').slice(0, 13) + b.n +
        (b.n === 1 ? ' case ' : ' cases') + '  ' + b.met + ' met  -> T' +
        levelFromBands_(pb, b.met / b.n));
    });
    out.push('');
  }
  if (skip.noOwner) {
    out.push('=== in scope but belonging to nobody ===');
    out.push('  These ARE cases in review since ' + ONBOARD_FROM_ + ' — so this is a');
    out.push('  live gap, not a historical one. Nobody is measured on them.');
    Object.keys(noOwnerBy).sort(function (a, b) { return noOwnerBy[b] - noOwnerBy[a]; })
      .forEach(function (k) {
        out.push('    ' + String(noOwnerBy[k] + '      ').slice(0, 6) + k);
      });
    out.push('');
  }
  out.push('  ' + restarted + ' case(s) had their clock restarted by a rejection');
  restartEx.forEach(function (x) { out.push(x); });
  out.push('');

  if (dryRun) {
    out.push('NOTHING WAS WRITTEN. This is a dry run.');
    out.push(keys.length + ' person-month row(s) would be written.');
    out.push('Run importSellerTat() to apply.');
    return logBack_(out.join(nl));
  }

  var emps = read_(T.EMPLOYEES), kras = idx_(read_(T.KRAS)), kpis = idx_(read_(T.KPIS));
  var empByName = {};
  emps.forEach(function (e) { empByName[normName_(e.name)] = e; });
  var actor = currentEmail_() || 'system', wrote = 0, missed = [];

  keys.forEach(function (k) {
    var b = buckets[k];
    var e = empByName[normName_(b.who)];
    if (!e) { missed.push(b.who + '  (no employee of that name)'); return; }
    var hit = read_(T.ASSIGN).filter(function (a) {
      if (String(a.employee_id) !== String(e.id)) return false;
      return normName_((kras[a.kra_id] || {}).name) === normName_(b.kra);
    })[0];
    if (!hit) { missed.push(b.who + '  /  ' + b.kra + '  (holds no such KRA)'); return; }
    var share = Math.round(b.met / b.n * 10000) / 10000;
    var id = 'prf_' + e.id + '_' + hit.kpi_id + '_' + b.period;
    var prev = read_(T.PERF).filter(function (p) { return String(p.id) === id; })[0];
    if (prev && String(prev.note || '').indexOf('Metabase 5712') < 0 &&
        String(prev.actual || '') !== '') {
      missed.push(b.who + '  /  ' + b.kra + '  keeps a hand-entered ' + prev.actual);
      return;
    }
    upsert_(T.PERF, { id: id, employee_id: e.id, kpi_id: hit.kpi_id,
      period_id: b.period, actual: share, manual_level: '', level: '',
      kind: '', direction: '',
      note: 'Metabase 5712 · ' + b.met + ' of ' + b.n + ' within ' + b.tat +
        (b.tat === 1 ? ' day' : ' days') + ' = ' + Math.round(share * 100) + '%' +
        ' · mean ' + (Math.round(b.sum / b.n * 10) / 10) + ' days',
      status: 'recorded', updated_by: actor, updated_at: nowIso_() });
    recomputeOne_(e.id, hit.kpi_id, b.period, actor);
    wrote++;
  });
  audit_(actor, 'system', 'seller_tat', 'import', null, { rows: wrote },
    'Seller onboarding TAT from Metabase 5712');
  commit_();
  out.push('WRITTEN: ' + wrote + ' performance row(s).');
  if (missed.length) {
    out.push('');
    out.push('  NOT written:');
    missed.forEach(function (x) { out.push('    ' + x); });
  }
  out.push('Reload the dashboard.');
  return logBack_(out.join(nl));
}

function previewSellerTat() { return sellerTat_(true); }

function importSellerTat() { return sellerTat_(false); }
function inspectTargets() { return inspectWorkbook(TARGETS_SHEET_ID); }

// ===== DESCRIBE A TAB =====
function colLetter_(nCol) {
  var s = '', n = Number(nCol);
  if (!(n >= 1)) return '?';
  while (n > 0) { var r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = (n - r - 1) / 26; }
  return s;
}
function letterCol_(letters) {
  var t = String(letters || '').toUpperCase().replace(/[^A-Z]/g, ''), n = 0;
  if (!t) return 0;
  for (var i = 0; i < t.length; i++) n = n * 26 + (t.charCodeAt(i) - 64);
  return n;
}
// ===== OMP TRACKER =====

function ompHeaderRow_(grid) {
  for (var r = 0; r < Math.min(6, grid.length); r++) {
    for (var c = 0; c < grid[r].length; c++) {
      if (/control\s*-?\s*poc/i.test(String(grid[r][c] || ''))) return r;
    }
  }
  return -1;
}

var OMP_WANT_ = {
  poc:       /control\s*-?\s*poc/i,
  vertical:  /^vert?c?al$/i,
  seller:    /^seller name$/i,
  buyer:     /^buyer name$/i,
  so:        /^so number$/i,
  shipment:  /^shipment id$/i,
  mmDate:    /^mm date$/i,
  status:    /^shipment status$/i,
  dispatch:  /^dispatch date$/i,
  expected:  /^exp date$/i,
  payStatus: /^payment status$/i,
  dnStatus:  /^dn status$/i,
  reached:   /^reached\s*\/\s*actual$/i,
  delivered: /^delivered\s*\/\s*actual$/i,
  completed: /^completed\s*\/\s*date$/i,
  tracking:  /^(vehcile status\s*\/\s*)?tracking$/i,
  qc:        /^delivered\s*\/\s*qc$/i,
  dn:        /^delivered\s*\/\s*dn$/i
};

function ompTrackerGrid_() {
  var src = SpreadsheetApp.openById(OMP_TRACKER_SHEET_ID);
  var sh = findSheet_(src, OMP_TRACKER_TAB);
  if (!sh) return { error: 'no tab matching "' + OMP_TRACKER_TAB + '"' };
  var g = sh.getRange(1, 1, sh.getLastRow(), sh.getLastColumn()).getValues();
  var hr = ompHeaderRow_(g);
  if (hr < 0) return { error: 'no header row found — nothing in the first 6 rows says "Control - POC"' };

  var banners = [], carry = '';
  var brow = hr > 0 ? g[hr - 1] : [];
  for (var b = 0; b < g[hr].length; b++) {
    var bv = b < brow.length ? brow[b] : '';
    var txt = String(bv == null ? '' : bv).trim();
    if (txt && num_(txt) === null) carry = txt;
    banners[b] = carry;
  }

  var col = {}, letters = {}, labels = [];
  for (var c = 0; c < g[hr].length; c++) {
    var h = String(g[hr][c] || '').trim();
    labels[c] = h ? (banners[c] ? banners[c] + ' / ' + h : h) : '';
    if (!h) continue;
    for (var k in OMP_WANT_) {
      if (col[k] !== undefined) continue;
      if (OMP_WANT_[k].test(h) || OMP_WANT_[k].test(labels[c])) {
        col[k] = c; letters[k] = colLetter_(c + 1) + ' "' + labels[c] + '"';
      }
    }
  }
  return { sheet: sh, grid: g, headerRow: hr, col: col, letters: letters,
           labels: labels, banners: banners };
}

// Scoped to the OMP tracker. POC_IGNORE holds a different Aravind, so this must never move into POC_ALIASES.
var OMP_POC_ALIASES_ = {
  'ARAVIND': 'ARVIND JAKKULA'
};
var OMP_POC_OFF_TEAM_ = {
  'KALYAN': 'not on Control Tower (confirmed 28 Sep 2026)'
};

var OMP_NOT_COUNTED_STATUS_ = /^\s*(CANCELLED|DRAFT)\s*$/i;
var OMP_NOT_COUNTED_STAGE_  = /^\s*(CANCELLED|DRAFT|READY[\s_-]*(TO|FOR)[\s_-]*DISPATCH)\s*$/i;
// Measured to month end + grace, not to today, so a past month does not move.
var OMP_TRANSIT_GRACE_DAYS_ = 10;
var OMP_IN_TRANSIT_ = /^\s*(DISPATCHED|IN[\s_-]*TRANSIT)\s*$/i;

function ompCutoff_(monthId, graceDays) {
  var g = (graceDays === undefined || graceDays === null) ? OMP_TRANSIT_GRACE_DAYS_ : graceDays;
  var y = Number(String(monthId).slice(0, 4)), m = Number(String(monthId).slice(5, 7));
  if (!(y > 0) || !(m > 0)) return null;
  return new Date(y, m, g);
}

function ompDayIndex_(v) {
  var d = isoDay_(v);
  if (!d) return null;
  var p = d.split('-');
  return Math.floor(Date.UTC(Number(p[0]), Number(p[1]) - 1, Number(p[2])) / 86400000);
}

function ompTransitVerdict_(status, stage, dispatchedOn, monthId) {
  var moving = OMP_IN_TRANSIT_.test(String(status == null ? '' : status)) ||
               OMP_IN_TRANSIT_.test(String(stage == null ? '' : stage));
  if (!moving) return null;
  var cut = ompCutoff_(monthId), from = cellDate_(dispatchedOn);
  if (!cut || !from) return { state: 'unknown', days: null };
  var a = ompDayIndex_(from), b = ompDayIndex_(cut);
  if (a === null || b === null) return { state: 'unknown', days: null };
  var days = b - a;
  if (days < 0) return { state: 'after', days: days };
  return { state: days > OMP_TRANSIT_GRACE_DAYS_ ? 'delayed' : 'pending', days: days };
}

function ompMonthClosed_(monthId, today) {
  var now = today || new Date();
  var cur = Utilities.formatDate(now, Session.getScriptTimeZone(), 'yyyy-MM');
  return String(monthId) < cur;
}

function ompCounts_(status, stage) {
  if (OMP_NOT_COUNTED_STATUS_.test(String(status == null ? '' : status))) return false;
  if (OMP_NOT_COUNTED_STAGE_.test(String(stage == null ? '' : stage))) return false;
  return true;
}

function editDist_(a, b) {
  var m = a.length, k = b.length, prev = [], cur = [], i, j;
  for (j = 0; j <= k; j++) prev[j] = j;
  for (i = 1; i <= m; i++) {
    cur[0] = i;
    for (j = 1; j <= k; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1,
                        prev[j - 1] + (a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1));
    }
    prev = cur.slice();
  }
  return prev[k];
}

function ompResolveName_(part, emps) {
  var raw = normName_(part);
  if (!raw) return { state: 'blank' };
  if (OMP_POC_OFF_TEAM_[raw]) {
    return { state: 'offteam', why: OMP_POC_OFF_TEAM_[raw] };
  }
  var want = canonPersonName_(OMP_POC_ALIASES_[raw] || part);
  if (!want) return { state: 'blank' };
  var hits = [], near = [];
  emps.forEach(function (e) {
    var full = canonPersonName_(e.name);
    if (full === want) { hits.push(e); return; }
    if ((' ' + full + ' ').indexOf(' ' + want + ' ') >= 0) { hits.push(e); return; }
    full.split(' ').forEach(function (tok) {
      if (tok.length < 4 || want.length < 4) return;
      var d = editDist_(tok, want);
      var pre = tok.slice(0, 4) === want.slice(0, 4);
      if (d <= 2 || pre) near.push({ who: e.name, tok: tok, d: d, pre: pre });
    });
  });
  if (hits.length === 1) return { state: 'one', emp: hits[0] };
  if (hits.length > 1) {
    return { state: 'ambiguous', who: hits.map(function (e) { return e.name; }) };
  }
  near.sort(function (x, y) { return x.d - y.d; });
  return { state: 'none', near: near.slice(0, 3) };
}

// ===== OMP CATEGORICAL COLUMNS =====
function profileOmpCategoricals() {
  ensureSeeded_();
  var nl = String.fromCharCode(10), out = [];
  var t = ompTrackerGrid_();
  if (t.error) { Logger.log(t.error); return t.error; }

  var dead = {};
  try {
    var msrc = SpreadsheetApp.openById(SHIPMENTS_SHEET_ID);
    var msh = findSheet_(msrc, SHIPMENTS_TAB);
    var mg = msh.getRange(1, 1, msh.getLastRow(), msh.getLastColumn()).getValues();
    var mi = headerIndex_(mg[0]);
    for (var r = 1; r < mg.length; r++) {
      var id = String(mg[r][mi['shipment_id']] || '').trim().toUpperCase();
      if (!id) continue;
      var st = String(mg[r][mi['shipment_status']] || '');
      if (/^\s*CANCELLED\s*$/i.test(st)) dead[id] = true;
    }
  } catch (e) {
    out.push('!! could not read MM_CT, so cancelled rows are still included: ' +
      (e && e.message || e));
  }

  var emps = read_(T.EMPLOYEES).filter(function (e) { return !isLeaver_(e.name); });
  var rows = t.grid.slice(t.headerRow + 1);

  var WANT = [
    { key: 'tracking',  kpi: 'Tracking Accuracy Rate' },
    { key: 'dnStatus',  kpi: 'CN & DN Closure Rate' },
    { key: 'dn',        kpi: 'CN & DN Closure Rate' },
    { key: 'qc',        kpi: 'QC & Settlement Accuracy Rate' },
    { key: 'payStatus', kpi: 'Timely Payment Release Rate' }
  ];

  var scored = 0, cancelled = 0, noPoc = 0, noId = 0;
  var tally = {}, byPoc = {};
  WANT.forEach(function (w) { tally[w.key] = {}; byPoc[w.key] = {}; });

  rows.forEach(function (row) {
    var id = String(row[t.col.shipment] == null ? '' : row[t.col.shipment]).trim().toUpperCase();
    if (!id) { noId++; return; }
    var who = String(row[t.col.poc] == null ? '' : row[t.col.poc]).trim();
    if (!who) { noPoc++; return; }
    if (dead[id]) { cancelled++; return; }
    var res = ompResolveName_(who, emps);
    var name = res.state === 'one' ? res.emp.name : '(' + res.state + ')';
    scored++;
    WANT.forEach(function (w) {
      var c = t.col[w.key];
      var v = (c === undefined) ? '(column not found)'
        : String(row[c] == null ? '' : row[c]).trim() || '(blank)';
      tally[w.key][v] = (tally[w.key][v] || 0) + 1;
      var bk = name + '|' + v;
      byPoc[w.key][bk] = (byPoc[w.key][bk] || 0) + 1;
    });
  });

  out.push('=== THE ROWS THESE COUNTS ARE OVER ===');
  out.push('  ' + scored + ' scoreable  (a Shipment ID, a POC, and not cancelled)');
  out.push('  ' + noId + ' with no Shipment ID');
  out.push('  ' + noPoc + ' with no POC');
  out.push('  ' + cancelled + ' cancelled');
  out.push('');

  WANT.forEach(function (w) {
    var c = t.col[w.key];
    out.push('=== ' + (c === undefined ? w.key + '  (COLUMN NOT FOUND)' : t.letters[w.key]) +
      '   ->  ' + w.kpi + ' ===');
    var vals = Object.keys(tally[w.key]).sort(function (a, b) {
      return tally[w.key][b] - tally[w.key][a]; });
    if (!vals.length) { out.push('  (nothing)'); out.push(''); return; }
    vals.forEach(function (v) {
      var n = tally[w.key][v];
      out.push('  ' + pad_(String(n), 6) + pad_(Math.round(n / scored * 1000) / 10 + '%', 8) + v);
    });
    out.push('');
    out.push('  by POC:');
    var people = {};
    Object.keys(byPoc[w.key]).forEach(function (k) { people[k.split('|')[0]] = true; });
    Object.keys(people).sort().forEach(function (p) {
      var line = '    ' + pad_(p, 24);
      vals.forEach(function (v) {
        var n2 = byPoc[w.key][p + '|' + v] || 0;
        line += pad_((n2 || '·') + ' ' + v.slice(0, 10), 16);
      });
      out.push(line);
    });
    out.push('');
  });

  out.push('WHAT IS NEEDED FROM YOU, PER KPI:');
  out.push('  which value(s) count as the GOOD outcome, and');
  out.push('  whether a blank is a miss or leaves the denominator.');
  out.push('A blank is the one that matters: treated as a miss it punishes a');
  out.push('row nobody filled in; excluded, it lets an unfilled column read as');
  out.push('a perfect score. Neither is safe to assume.');
  var txt = out.join(nl);
  Logger.log(txt);
  return txt;
}

// ===== TRACKING ACCURACY RATE =====
var OMP_TRACKING_NOTE_ = 'OMP tracking';
var OMP_TRACKING_KRA_ = /shipment visibility/i;
var OMP_TRACKING_KPI_ = /tracking accuracy/i;
var OMP_TRACK_NA_ = /^\s*(n\.?\s*a\.?|not\s*applicable|not\s*available)\s*$/i;
var OMP_TRACK_NONE_ = /^\s*(no|nil|none|not\s*tracked|not\s*done)\s*$/i;
var OMP_TRACK_METHOD_ = /^\s*(fastag|sim\s*track|sim|gps|both)\s*$/i;

function ompTrackingOne_(mmRow, tracking, monthId, today) {
  if (!mmRow) return { out: 'skip', why: 'not in MM_CT' };
  if (/^\s*CANCELLED\s*$/i.test(String(mmRow.status || '')) ||
      /^\s*CANCELLED\s*$/i.test(String(mmRow.stage || ''))) {
    return { out: 'skip', why: 'cancelled' };
  }
  if (!ompMonthClosed_(monthId, today)) {
    return { out: 'skip', why: 'current month, not scored yet' };
  }
  if (mmRow.inTransit === null || mmRow.inTransit === undefined) {
    return { out: 'skip', why: 'never reached In-Transit — nothing to track' };
  }
  var v = String(tracking == null ? '' : tracking).trim();
  if (OMP_TRACK_NA_.test(v)) {
    return { out: 'skip', why: 'N.A — tracker not in place at the time' };
  }
  if (!v || OMP_TRACK_NONE_.test(v)) {
    return { out: 'miss', why: v ? '"' + v + '" — no tracking in place'
                                 : 'blank — nothing recorded' };
  }
  if (OMP_TRACK_METHOD_.test(v)) {
    return { out: 'hit', why: '"' + v + '" — at least one method present' };
  }
  return { out: 'unruled', why: '"' + v + '" is not a value anybody has ruled on' };
}

function ompTrackingAchievements_(dryRun) {
  ensureSeeded_();
  var nl = String.fromCharCode(10), out = [];
  var today = new Date();

  var t = ompTrackerGrid_();
  if (t.error) return t.error;
  var need = ['poc', 'shipment', 'tracking'];
  var gone = need.filter(function (k) { return t.col[k] === undefined; });
  if (gone.length) return 'OMP_TRACKER is missing: ' + gone.join(', ');
  out.push('columns read:');
  need.forEach(function (k) { out.push('  ' + pad_(k, 11) + t.letters[k]); });
  out.push('');
  out.push('on track = at least one tracking method present.  N.A leaves the');
  out.push('denominator (tracker not in place).  Blank is a miss.');
  out.push('');

  var mm = {};
  try {
    var msrc = SpreadsheetApp.openById(SHIPMENTS_SHEET_ID);
    var msh = findSheet_(msrc, SHIPMENTS_TAB);
    if (!msh) return 'no tab matching "' + SHIPMENTS_TAB + '" in MM_CT';
    var mg = msh.getRange(1, 1, msh.getLastRow(), msh.getLastColumn()).getValues();
    var mi = headerIndex_(mg[0]);
    if (!('shipment_id' in mi)) return 'Raw_Shipments has no shipment_id column';
    if (!('status_timeline' in mi)) return 'Raw_Shipments has no status_timeline column';
    for (var r = 1; r < mg.length; r++) {
      var id = String(mg[r][mi['shipment_id']] || '').trim().toUpperCase();
      if (!id) continue;
      var tl = parseTimeline_(mg[r][mi['status_timeline']]);
      var ms = tl[OMP_INTRANSIT_STAGE_];
      mm[id] = {
        status: 'shipment_status' in mi ? mg[r][mi['shipment_status']] : '',
        stage: 'shipment_stage_label' in mi ? mg[r][mi['shipment_stage_label']] : '',
        inTransit: (ms === null || ms === undefined) ? null : Math.floor(ms / 86400000)
      };
    }
  } catch (e) { return 'Cannot read MM_CT  (' + (e && e.message || e) + ')'; }

  var emps = read_(T.EMPLOYEES).filter(function (e) { return !isLeaver_(e.name); });
  var kras = idx_(read_(T.KRAS)), kpis = idx_(read_(T.KPIS));
  var holds = {};
  read_(T.ASSIGN).forEach(function (a) {
    var kra = kras[a.kra_id], kpi = kpis[a.kpi_id];
    if (!kra || !kpi) return;
    if (!OMP_TRACKING_KRA_.test(String(kra.name))) return;
    if (!OMP_TRACKING_KPI_.test(String(kpi.name))) return;
    for (var i = 0; i < emps.length; i++) {
      if (String(emps[i].id) === String(a.employee_id)) {
        (holds[emps[i].id] = holds[emps[i].id] || []).push(a.kpi_id); return;
      }
    }
  });
  var names = Object.keys(holds).map(function (id) {
    for (var i = 0; i < emps.length; i++) if (String(emps[i].id) === id) return emps[i].name;
    return id;
  }).sort();
  out.push('holds this KPI: ' + (names.length ? names.join(', ') : 'NOBODY'));
  if (!names.length) { Logger.log(out.join(nl)); return out.join(nl); }
  out.push('');

  var rows = t.grid.slice(t.headerRow + 1);
  var acc = {}, whyCount = {}, verdictOf = {}, unruled = 0, notReached = 0;
  rows.forEach(function (row) {
    var id = String(row[t.col.shipment] == null ? '' : row[t.col.shipment]).trim().toUpperCase();
    if (!id) return;
    var who = String(row[t.col.poc] == null ? '' : row[t.col.poc]).trim();
    if (!who) return;
    var res = ompResolveName_(who, emps);
    if (res.state !== 'one' || !holds[res.emp.id]) return;
    var e = res.emp, mmRow = mm[id];
    if (!mmRow || mmRow.inTransit === null || mmRow.inTransit === undefined) {
      whyCount['skip: never reached In-Transit — nothing to track'] =
        (whyCount['skip: never reached In-Transit — nothing to track'] || 0) + 1;
      return;
    }
    var monthId = Utilities.formatDate(new Date(mmRow.inTransit * 86400000), 'UTC', 'yyyy-MM');
    var raw = String(row[t.col.tracking] == null ? '' : row[t.col.tracking]).trim() || '(blank)';
    var v = ompTrackingOne_(mmRow, row[t.col.tracking], monthId, today);
    if (v.out === 'hit' || v.out === 'miss' || v.out === 'unruled') {
      var vk = raw + '  ->  ' + v.out;
      verdictOf[vk] = (verdictOf[vk] || 0) + 1;
    } else notReached++;
    whyCount[v.out + ': ' + v.why.replace(/"[^"]*"/, '"…"')] =
      (whyCount[v.out + ': ' + v.why.replace(/"[^"]*"/, '"…"')] || 0) + 1;
    if (v.out === 'unruled') { unruled++; return; }
    var k = e.id + '|' + monthId;
    var b = acc[k] || (acc[k] = { emp: e, month: monthId, hit: 0, miss: 0, skip: 0 });
    if (v.out === 'hit') b.hit++; else if (v.out === 'miss') b.miss++; else b.skip++;
  });

  out.push('=== EVERY DISTINCT VALUE, AND THE VERDICT IT RECEIVED ===');
  out.push('Fastag / SIM track / Both are methods; N.A leaves the denominator;');
  out.push('"No" is a miss. Anything else is reported and not scored.');
  out.push('');
  Object.keys(verdictOf).sort().forEach(function (k) {
    out.push('  ' + pad_(String(verdictOf[k]), 6) + k);
  });
  if (notReached) {
    out.push('  ' + pad_(String(notReached), 6) +
      '(the value was never tested — cancelled, current month, or never moved)');
  }
  if (unruled) {
    out.push('');
    out.push('  !! ' + unruled + ' row(s) hold a value nobody has ruled on and were left');
    out.push('     out entirely — not scored either way. Rule on them and they count.');
  }
  out.push('');

  out.push('=== EVERY SHIPMENT, BY WHAT HAPPENED TO IT ===');
  Object.keys(whyCount).sort(function (a, b) { return whyCount[b] - whyCount[a]; })
    .forEach(function (k) { out.push('  ' + pad_(String(whyCount[k]), 6) + k); });
  out.push('');

  var perf = read_(T.PERF), perfById = {};
  perf.forEach(function (p) { perfById[String(p.id)] = p; });
  var ladder = {}, ladderAt = {}, pOrder = {};
  read_(T.PERIODS).slice().sort(function (x, y) {
    return (num_(x.sort) || 0) - (num_(y.sort) || 0); })
    .forEach(function (p, ix) { pOrder[String(p.id)] = ix; });
  read_(T.TARGETS).forEach(function (tg) {
    var at = pOrder[String(tg.period_id)];
    if (at === undefined) return;
    var k2 = tg.employee_id + '|' + tg.kpi_id;
    if (ladderAt[k2] !== undefined && ladderAt[k2] > at) return;
    ladderAt[k2] = at; ladder[k2] = [tg.t1, tg.t2, tg.t3, tg.t4, tg.t5];
  });

  var writes = [], kept = [];
  Object.keys(acc).sort().forEach(function (k) {
    var b = acc[k], den = b.hit + b.miss;
    if (!den) return;
    var rate = Math.round(b.hit / den * 10000) / 10000;
    (holds[b.emp.id] || []).forEach(function (kpiId) {
      var pid = 'per_' + b.month;
      var id2 = 'prf_' + b.emp.id + '_' + kpiId + '_' + pid;
      var prev = perfById[id2];
      if (prev && String(prev.note || '').indexOf(OMP_TRACKING_NOTE_) < 0 &&
          String(prev.actual || '') !== '') {
        kept.push(pad_(b.emp.name, 22) + b.month + '   keeps ' + prev.actual +
          '  (note: ' + (prev.note || 'none') + ')');
        return;
      }
      var lad = ladder[b.emp.id + '|' + kpiId];
      var pb = lad ? parseBands_(lad) : null;
      writes.push({ id: id2, emp: b.emp, kpiId: kpiId, pid: pid, month: b.month,
        rate: rate, hit: b.hit, miss: b.miss, skip: b.skip, den: den,
        level: pb ? levelFromBands_(pb, rate) : null,
        was: prev ? prev.actual : '' });
    });
  });

  out.push('=== THE RATE, PER PERSON PER MONTH ===');
  out.push('  ' + pad_('person', 22) + pad_('month', 9) + pad_('tracked', 9) +
    pad_('not', 7) + pad_('of', 6) + pad_('rate', 8) + pad_('skipped', 9) +
    pad_('rates', 6) + 'was');
  writes.forEach(function (w) {
    out.push('  ' + pad_(w.emp.name, 22) + pad_(w.month, 9) + pad_(String(w.hit), 9) +
      pad_(String(w.miss), 7) + pad_(String(w.den), 6) +
      pad_((Math.round(w.rate * 1000) / 10) + '%', 8) + pad_(String(w.skip), 9) +
      pad_(w.level === null || w.level === undefined ? '?' : 'T' + w.level, 6) +
      (w.was === '' ? '—' : String(w.was)) +
      (w.den < 5 ? '   << ' + w.den + ' shipments' : ''));
  });
  if (kept.length) {
    out.push('');
    out.push('  left alone — a hand-typed number is never ours to overwrite:');
    kept.forEach(function (l) { out.push('    ' + l); });
  }

  out.push('');
  if (dryRun) {
    out.push('NOTHING WAS WRITTEN. This is a dry run.');
    out.push(writes.length + ' performance row(s) would be written.');
    out.push('CHECK THE VALUE TABLE ABOVE before running importOmpTracking().');
  } else {
    var actor = currentEmail_() || 'system';
    writes.forEach(function (w) {
      upsert_(T.PERF, { id: w.id, employee_id: w.emp.id, kpi_id: w.kpiId,
        period_id: w.pid, actual: w.rate, manual_level: '', level: '',
        kind: '', direction: '',
        note: OMP_TRACKING_NOTE_ + ' · ' + w.hit + ' of ' + w.den +
          ' had a tracking method' + (w.skip ? ' · ' + w.skip + ' not counted' : ''),
        status: 'recorded', updated_by: actor, updated_at: nowIso_() });
    });
    out.push('WROTE ' + writes.length + ' performance row(s).');
  }
  var txt = out.join(nl);
  Logger.log(txt);
  return txt;
}

function previewOmpTracking() { return ompTrackingAchievements_(true); }
function importOmpTracking() { return ompTrackingAchievements_(false); }

// ===== TIMELY DISPATCH RATE =====
var OMP_DISPATCH_NOTE_ = 'OMP dispatch';
var OMP_DISPATCH_DAYS_ = 3;
var OMP_DISPATCH_KRA_ = /dispatch execution/i;
var OMP_DISPATCH_KPI_ = /timely dispatch rate/i;
// In-Transit comes from MM_CT's status_timeline, not the tracker's typed Dispatch Date.
var OMP_INTRANSIT_STAGE_ = 'DISPATCHED';

function ompDispatchOne_(mmRow, matchedOn, monthId, today) {
  if (!mmRow) return { out: 'skip', why: 'not in MM_CT' };
  if (/^\s*CANCELLED\s*$/i.test(String(mmRow.status || '')) ||
      /^\s*CANCELLED\s*$/i.test(String(mmRow.stage || ''))) {
    return { out: 'skip', why: 'cancelled — nobody was going to dispatch it' };
  }
  if (!ompMonthClosed_(monthId, today)) {
    return { out: 'skip', why: 'current month, not scored yet' };
  }
  if (mmRow.inTransit === null || mmRow.inTransit === undefined) {
    return { out: 'skip', why: 'never reached In-Transit — not counted (ruling)' };
  }
  var mm = ompDayIndex_(matchedOn);
  if (mm === null) return { out: 'skip', why: 'no MM Date, so no clock to start' };
  var gap = mmRow.inTransit - mm;
  if (gap < 0) {
    return { out: 'skip', why: 'In-Transit ' + (-gap) + ' day(s) BEFORE matchmaking' };
  }
  return gap <= OMP_DISPATCH_DAYS_
    ? { out: 'hit',  why: 'In-Transit in ' + gap + ' day(s)' }
    : { out: 'miss', why: 'In-Transit in ' + gap + ' day(s)' };
}

function ompDispatchAchievements_(dryRun) {
  ensureSeeded_();
  var nl = String.fromCharCode(10), out = [];
  var today = new Date();

  var t = ompTrackerGrid_();
  if (t.error) return t.error;
  var need = ['poc', 'shipment', 'mmDate', 'dispatch'];
  var gone = need.filter(function (k) { return t.col[k] === undefined; });
  if (gone.length) return 'OMP_TRACKER is missing: ' + gone.join(', ');
  out.push('columns read:');
  need.forEach(function (k) { out.push('  ' + pad_(k, 11) + t.letters[k]); });
  out.push('');
  out.push('on time = In-Transit within ' + OMP_DISPATCH_DAYS_ +
    ' day(s) of matchmaking.  The In-Transit date comes from MM_CT');
  out.push('status_timeline (' + OMP_INTRANSIT_STAGE_ + '), not from the tracker column.');
  out.push('');

  var mm = {};
  try {
    var msrc = SpreadsheetApp.openById(SHIPMENTS_SHEET_ID);
    var msh = findSheet_(msrc, SHIPMENTS_TAB);
    if (!msh) return 'no tab matching "' + SHIPMENTS_TAB + '" in MM_CT';
    var mg = msh.getRange(1, 1, msh.getLastRow(), msh.getLastColumn()).getValues();
    var mi = headerIndex_(mg[0]);
    if (!('shipment_id' in mi)) return 'Raw_Shipments has no shipment_id column';
    if (!('status_timeline' in mi)) return 'Raw_Shipments has no status_timeline column';
    for (var r = 1; r < mg.length; r++) {
      var id = String(mg[r][mi['shipment_id']] || '').trim().toUpperCase();
      if (!id) continue;
      var tl = parseTimeline_(mg[r][mi['status_timeline']]);
      var ms = tl[OMP_INTRANSIT_STAGE_];
      mm[id] = {
        status: 'shipment_status' in mi ? mg[r][mi['shipment_status']] : '',
        stage: 'shipment_stage_label' in mi ? mg[r][mi['shipment_stage_label']] : '',
        inTransit: (ms === null || ms === undefined) ? null : Math.floor(ms / 86400000)
      };
    }
  } catch (e) { return 'Cannot read MM_CT  (' + (e && e.message || e) + ')'; }

  var emps = read_(T.EMPLOYEES).filter(function (e) { return !isLeaver_(e.name); });
  var kras = idx_(read_(T.KRAS)), kpis = idx_(read_(T.KPIS));
  var holds = {};
  read_(T.ASSIGN).forEach(function (a) {
    var kra = kras[a.kra_id], kpi = kpis[a.kpi_id];
    if (!kra || !kpi) return;
    if (!OMP_DISPATCH_KRA_.test(String(kra.name))) return;
    if (!OMP_DISPATCH_KPI_.test(String(kpi.name))) return;
    for (var i = 0; i < emps.length; i++) {
      if (String(emps[i].id) === String(a.employee_id)) {
        (holds[emps[i].id] = holds[emps[i].id] || []).push(a.kpi_id); return;
      }
    }
  });
  var names = Object.keys(holds).map(function (id) {
    for (var i = 0; i < emps.length; i++) if (String(emps[i].id) === id) return emps[i].name;
    return id;
  }).sort();
  out.push('holds this KPI: ' + (names.length ? names.join(', ') : 'NOBODY'));
  if (!names.length) { Logger.log(out.join(nl)); return out.join(nl); }
  out.push('');

  var rows = t.grid.slice(t.headerRow + 1);
  var acc = {}, whyCount = {}, samples = [], neverLeft = 0;
  var agree = 0, differ = 0, differEx = [];
  rows.forEach(function (row) {
    var id = String(row[t.col.shipment] == null ? '' : row[t.col.shipment]).trim().toUpperCase();
    if (!id) return;
    var who = String(row[t.col.poc] == null ? '' : row[t.col.poc]).trim();
    if (!who) return;
    var res = ompResolveName_(who, emps);
    if (res.state !== 'one' || !holds[res.emp.id]) return;
    var e = res.emp;
    var d = cellDate_(row[t.col.mmDate]);
    if (!d) return;
    var monthId = Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM');
    var mmRow = mm[id];

    if (mmRow && mmRow.inTransit !== null && mmRow.inTransit !== undefined) {
      var typed = ompDayIndex_(row[t.col.dispatch]);
      if (typed !== null) {
        if (typed === mmRow.inTransit) agree++;
        else {
          differ++;
          if (differEx.length < 8) {
            differEx.push(pad_(id, 14) + 'tracker ' + isoDay_(row[t.col.dispatch]) +
              '   MM_CT ' + (mmRow.inTransit * 86400000 > 0
                ? Utilities.formatDate(new Date(mmRow.inTransit * 86400000), 'UTC', 'yyyy-MM-dd')
                : '?') +
              '   (' + (typed - mmRow.inTransit > 0 ? '+' : '') +
              (typed - mmRow.inTransit) + 'd)');
          }
        }
      }
    }

    var v = ompDispatchOne_(mmRow, row[t.col.mmDate], monthId, today);
    var lab = v.out + ': ' + v.why.replace(/\d+/g, 'N');
    whyCount[lab] = (whyCount[lab] || 0) + 1;
    if (v.why.indexOf('never reached In-Transit') >= 0) neverLeft++;
    var k = e.id + '|' + monthId;
    var b = acc[k] || (acc[k] = { emp: e, month: monthId, hit: 0, miss: 0, skip: 0 });
    if (v.out === 'hit') b.hit++; else if (v.out === 'miss') b.miss++; else b.skip++;
    if (v.out === 'miss' && samples.length < 10) {
      samples.push(pad_(e.name, 22) + pad_(monthId, 9) + pad_(id, 14) + v.why);
    }
  });

  out.push('=== EVERY SHIPMENT, BY WHAT HAPPENED TO IT ===');
  Object.keys(whyCount).sort(function (a, b) { return whyCount[b] - whyCount[a]; })
    .forEach(function (k) { out.push('  ' + pad_(String(whyCount[k]), 6) + k); });
  out.push('');

  out.push('=== DO THE TWO SOURCES AGREE ON WHEN IT LEFT? ===');
  out.push('  ' + agree + ' shipment(s): the tracker\'s Dispatch Date matches MM_CT\'s timeline.');
  out.push('  ' + differ + ' shipment(s): they differ.');
  if (differ) {
    out.push('');
    differEx.forEach(function (l) { out.push('    ' + l); });
    out.push('');
    out.push('  The MM_CT timeline is what the rate uses. A positive gap means the');
    out.push('  tracker was written later than the stage was actually reached.');
  }
  out.push('');

  var perf = read_(T.PERF), perfById = {};
  perf.forEach(function (p) { perfById[String(p.id)] = p; });
  var ladder = {}, ladderAt = {}, pOrder = {};
  read_(T.PERIODS).slice().sort(function (x, y) {
    return (num_(x.sort) || 0) - (num_(y.sort) || 0); })
    .forEach(function (p, ix) { pOrder[String(p.id)] = ix; });
  read_(T.TARGETS).forEach(function (tg) {
    var at = pOrder[String(tg.period_id)];
    if (at === undefined) return;
    var k2 = tg.employee_id + '|' + tg.kpi_id;
    if (ladderAt[k2] !== undefined && ladderAt[k2] > at) return;
    ladderAt[k2] = at; ladder[k2] = [tg.t1, tg.t2, tg.t3, tg.t4, tg.t5];
  });

  var writes = [], kept = [], nothing = [];
  Object.keys(acc).sort().forEach(function (k) {
    var b = acc[k], den = b.hit + b.miss;
    if (!den) { nothing.push(pad_(b.emp.name, 22) + b.month + '   nothing countable'); return; }
    var rate = Math.round(b.hit / den * 10000) / 10000;
    (holds[b.emp.id] || []).forEach(function (kpiId) {
      var pid = 'per_' + b.month;
      var id2 = 'prf_' + b.emp.id + '_' + kpiId + '_' + pid;
      var prev = perfById[id2];
      if (prev && String(prev.note || '').indexOf(OMP_DISPATCH_NOTE_) < 0 &&
          String(prev.actual || '') !== '') {
        kept.push(pad_(b.emp.name, 22) + b.month + '   keeps ' + prev.actual +
          '  (note: ' + (prev.note || 'none') + ')');
        return;
      }
      var lad = ladder[b.emp.id + '|' + kpiId];
      var pb = lad ? parseBands_(lad) : null;
      writes.push({ id: id2, emp: b.emp, kpiId: kpiId, pid: pid, month: b.month,
        rate: rate, hit: b.hit, miss: b.miss, skip: b.skip, den: den,
        bands: lad, level: pb ? levelFromBands_(pb, rate) : null,
        was: prev ? prev.actual : '' });
    });
  });

  out.push('=== THE RATE, PER PERSON PER MONTH ===');
  out.push('  ' + pad_('person', 22) + pad_('month', 9) + pad_('on time', 9) +
    pad_('late', 7) + pad_('of', 6) + pad_('rate', 8) + pad_('skipped', 9) +
    pad_('rates', 6) + 'was');
  writes.forEach(function (w) {
    out.push('  ' + pad_(w.emp.name, 22) + pad_(w.month, 9) + pad_(String(w.hit), 9) +
      pad_(String(w.miss), 7) + pad_(String(w.den), 6) +
      pad_((Math.round(w.rate * 1000) / 10) + '%', 8) + pad_(String(w.skip), 9) +
      pad_(w.level === null || w.level === undefined ? '?' : 'T' + w.level, 6) +
      (w.was === '' ? '—' : String(w.was)) +
      (w.den < 5 ? '   << ' + w.den + ' shipments' : ''));
  });
  if (nothing.length) {
    out.push('');
    nothing.forEach(function (l) { out.push('  ' + l); });
  }
  if (kept.length) {
    out.push('');
    out.push('  left alone — a hand-typed number is never ours to overwrite:');
    kept.forEach(function (l) { out.push('    ' + l); });
  }
  if (samples.length) {
    out.push('');
    out.push('=== A SAMPLE OF THE MISSES, TO SPOT-CHECK ===');
    samples.forEach(function (l) { out.push('  ' + l); });
  }

  out.push('');
  out.push('=== WHAT IS NOT IN THESE RATES ===');
  out.push('  ' + neverLeft + ' shipment(s) never reached In-Transit and are excluded');
  out.push('  by the ruling rather than counted as misses. The rate above is');
  out.push('  therefore computed over the shipments that did eventually go.');
  var zero = writes.filter(function (w) { return w.level === 0; });
  if (zero.length) {
    out.push('  ' + zero.length + ' of ' + writes.length + ' month(s) clear no band at all.');
  }

  out.push('');
  if (dryRun) {
    out.push('NOTHING WAS WRITTEN. This is a dry run.');
    out.push(writes.length + ' performance row(s) would be written.');
    out.push('Run importOmpDispatch() to apply.');
  } else {
    var actor = currentEmail_() || 'system';
    writes.forEach(function (w) {
      upsert_(T.PERF, { id: w.id, employee_id: w.emp.id, kpi_id: w.kpiId,
        period_id: w.pid, actual: w.rate, manual_level: '', level: '',
        kind: '', direction: '',
        note: OMP_DISPATCH_NOTE_ + ' · ' + w.hit + ' of ' + w.den +
          ' In-Transit within ' + OMP_DISPATCH_DAYS_ + ' days of matchmaking' +
          (w.skip ? ' · ' + w.skip + ' not counted' : ''),
        status: 'recorded', updated_by: actor, updated_at: nowIso_() });
    });
    out.push('WROTE ' + writes.length + ' performance row(s).');
  }
  var txt = out.join(nl);
  Logger.log(txt);
  return txt;
}

function previewOmpDispatch() { return ompDispatchAchievements_(true); }
function importOmpDispatch() { return ompDispatchAchievements_(false); }

// ===== ON-TIME TRANSIT COMPLETION RATE =====
var OMP_TRANSIT_NOTE_ = 'OMP transit';
var OMP_TRANSIT_KRA_ = /in-?\s*transit delivery management/i;
var OMP_TRANSIT_KPI_ = /on-?\s*time transit completion/i;

function ompTransitOne_(mmRow, expDate, reachedOn, dispatchedOn, monthId, today) {
  if (!mmRow) return { out: 'skip', why: 'not in MM_CT' };
  if (!ompCounts_(mmRow.status, mmRow.stage)) {
    return { out: 'skip', why: 'does not count (' + (mmRow.status || '?') + ')' };
  }
  if (!ompMonthClosed_(monthId, today)) {
    return { out: 'skip', why: 'current month, not scored yet' };
  }
  var tv = ompTransitVerdict_(mmRow.status, mmRow.stage, dispatchedOn, monthId);
  if (tv) {
    if (tv.state === 'delayed') {
      return { out: 'miss', why: 'still in transit after ' + tv.days + ' days' };
    }
    if (tv.state === 'pending') {
      return { out: 'skip', why: 'in transit ' + tv.days + ' days, within the grace' };
    }
    if (tv.state === 'after') {
      return { out: 'skip', why: 'dispatched ' + (-tv.days) +
        ' day(s) after this month closed' };
    }
    return { out: 'skip', why: 'in transit, no dispatch date to measure from' };
  }
  var exp = ompDayIndex_(expDate), got = ompDayIndex_(reachedOn);
  if (exp === null && got === null) return { out: 'skip', why: 'no Exp Date and no Reached date' };
  if (exp === null) return { out: 'skip', why: 'no Exp Date to compare against' };
  if (got === null) return { out: 'skip', why: 'arrived, but no Reached date recorded' };
  return got <= exp
    ? { out: 'hit',  why: 'reached ' + (exp - got) + ' day(s) early or on time' }
    : { out: 'miss', why: 'reached ' + (got - exp) + ' day(s) late' };
}

function ompTransitAchievements_(dryRun) {
  ensureSeeded_();
  var nl = String.fromCharCode(10), out = [];
  var today = new Date();

  var t = ompTrackerGrid_();
  if (t.error) return t.error;
  var need = ['poc', 'shipment', 'expected', 'reached', 'dispatch'];
  var miss = need.filter(function (k) { return t.col[k] === undefined; });
  if (miss.length) {
    return 'OMP_TRACKER is missing: ' + miss.join(', ') + nl +
      'Run describeOmpTracker() and check the header row.';
  }
  out.push('columns read:');
  need.forEach(function (k) { out.push('  ' + pad_(k, 11) + t.letters[k]); });
  out.push('');

  var mm = {};
  try {
    var msrc = SpreadsheetApp.openById(SHIPMENTS_SHEET_ID);
    var msh = findSheet_(msrc, SHIPMENTS_TAB);
    if (!msh) return 'no tab matching "' + SHIPMENTS_TAB + '" in MM_CT';
    var mg = msh.getRange(1, 1, msh.getLastRow(), msh.getLastColumn()).getValues();
    var mi = headerIndex_(mg[0]);
    if (!('shipment_id' in mi)) return 'Raw_Shipments has no shipment_id column';
    for (var r = 1; r < mg.length; r++) {
      var id = String(mg[r][mi['shipment_id']] || '').trim().toUpperCase();
      if (!id) continue;
      mm[id] = {
        status: 'shipment_status' in mi ? mg[r][mi['shipment_status']] : '',
        stage: 'shipment_stage_label' in mi ? mg[r][mi['shipment_stage_label']] : ''
      };
    }
  } catch (e) { return 'Cannot read MM_CT  (' + (e && e.message || e) + ')'; }

  var emps = read_(T.EMPLOYEES).filter(function (e) { return !isLeaver_(e.name); });
  var kras = idx_(read_(T.KRAS)), kpis = idx_(read_(T.KPIS));
  var holds = {};
  read_(T.ASSIGN).forEach(function (a) {
    var kra = kras[a.kra_id], kpi = kpis[a.kpi_id];
    if (!kra || !kpi) return;
    if (!OMP_TRANSIT_KRA_.test(String(kra.name))) return;
    if (!OMP_TRANSIT_KPI_.test(String(kpi.name))) return;
    var e = null;
    for (var i = 0; i < emps.length; i++) {
      if (String(emps[i].id) === String(a.employee_id)) { e = emps[i]; break; }
    }
    if (!e || isLeaver_(e.name)) return;
    (holds[e.id] = holds[e.id] || []).push(a.kpi_id);
  });
  var holderNames = Object.keys(holds).map(function (id) {
    for (var i = 0; i < emps.length; i++) if (String(emps[i].id) === id) return emps[i].name;
    return id;
  }).sort();
  out.push('holds this KPI: ' + (holderNames.length ? holderNames.join(', ') : 'NOBODY'));
  if (!holderNames.length) {
    out.push('');
    out.push('Nothing to write. Check the KRA and KPI name patterns against');
    out.push('explainOMP() — they are matched, not hardcoded.');
    return out.join(nl);
  }
  out.push('');

  var rows = t.grid.slice(t.headerRow + 1);
  var acc = {}, whyCount = {}, samples = [], unowned = 0, noEmp = {}, offTeam = {};
  var stale = 0, staleEx = [], agreeMoving = 0;
  rows.forEach(function (row, ri) {
    var id = String(row[t.col.shipment] == null ? '' : row[t.col.shipment]).trim().toUpperCase();
    if (!id) return;
    var who = String(row[t.col.poc] == null ? '' : row[t.col.poc]).trim();
    if (!who) { unowned++; return; }
    var res = ompResolveName_(who, emps);
    if (res.state === 'offteam') { offTeam[who] = (offTeam[who] || 0) + 1; return; }
    if (res.state !== 'one') { noEmp[who] = (noEmp[who] || 0) + 1; return; }
    var e = res.emp;
    if (!holds[e.id]) return;
    var d = cellDate_(row[t.col.dispatch]);
    if (!d) {
      whyCount['skip: no Dispatch Date, so no month to score it in'] =
        (whyCount['skip: no Dispatch Date, so no month to score it in'] || 0) + 1;
      return;
    }
    var monthId = Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM');
    var mmRow = mm[id];
    if (mmRow && OMP_IN_TRANSIT_.test(String(mmRow.status || '')) ) {
      var tStat = t.col.status === undefined ? '' :
        String(row[t.col.status] == null ? '' : row[t.col.status]).trim();
      var tReach = ompDayIndex_(row[t.col.reached]);
      if (tReach !== null || /reach|deliver|complet/i.test(tStat)) {
        stale++;
        if (staleEx.length < 8) {
          staleEx.push(pad_(id, 14) + pad_('MM_CT: ' + mmRow.status, 22) +
            'tracker: ' + (tStat || '(blank)') +
            (tReach !== null ? ', reached ' + isoDay_(row[t.col.reached]) : ''));
        }
      } else agreeMoving++;
    }
    var v = ompTransitOne_(mmRow, row[t.col.expected], row[t.col.reached],
                           row[t.col.dispatch], monthId, today);
    whyCount[v.out + ': ' + v.why.replace(/\d+/g, 'N')] =
      (whyCount[v.out + ': ' + v.why.replace(/\d+/g, 'N')] || 0) + 1;
    var key = e.id + '|' + monthId;
    var a2 = acc[key] || (acc[key] = { emp: e, month: monthId, hit: 0, miss: 0, skip: 0 });
    if (v.out === 'hit') a2.hit++; else if (v.out === 'miss') a2.miss++; else a2.skip++;
    if (v.out === 'miss' && samples.length < 12) {
      samples.push(pad_(e.name, 22) + pad_(monthId, 9) + pad_(id, 14) + v.why);
    }
  });

  out.push('=== EVERY SHIPMENT, BY WHAT HAPPENED TO IT ===');
  Object.keys(whyCount).sort(function (a, b) { return whyCount[b] - whyCount[a]; })
    .forEach(function (k) { out.push('  ' + pad_(String(whyCount[k]), 6) + k); });
  if (unowned) out.push('  ' + pad_(String(unowned), 6) + 'skip: no POC written on the row');
  Object.keys(offTeam).forEach(function (w) {
    out.push('  ' + pad_(String(offTeam[w]), 6) + 'skip: "' + w + '" is off the team by ruling');
  });
  Object.keys(noEmp).forEach(function (w) {
    out.push('  ' + pad_(String(noEmp[w]), 6) + 'skip: "' + w + '" DID NOT RESOLVE to an employee');
  });
  out.push('');

  var perf = read_(T.PERF), perfById = {};
  perf.forEach(function (p) { perfById[String(p.id)] = p; });
  var ladder = {}, ladderAt = {}, pOrder = {};
  read_(T.PERIODS).slice().sort(function (x, y) {
    return (num_(x.sort) || 0) - (num_(y.sort) || 0); })
    .forEach(function (p, ix) { pOrder[String(p.id)] = ix; });
  read_(T.TARGETS).forEach(function (tg) {
    var at = pOrder[String(tg.period_id)];
    if (at === undefined) return;
    var k = tg.employee_id + '|' + tg.kpi_id;
    if (ladderAt[k] !== undefined && ladderAt[k] > at) return;
    ladderAt[k] = at; ladder[k] = [tg.t1, tg.t2, tg.t3, tg.t4, tg.t5];
  });
  var writes = [], kept = [], tooThin = [];
  Object.keys(acc).sort().forEach(function (k) {
    var b = acc[k], den = b.hit + b.miss;
    if (!den) { tooThin.push(pad_(b.emp.name, 22) + b.month + '   nothing countable'); return; }
    var rate = Math.round(b.hit / den * 10000) / 10000;
    (holds[b.emp.id] || []).forEach(function (kpiId) {
      var pid = 'per_' + b.month;
      var id = 'prf_' + b.emp.id + '_' + kpiId + '_' + pid;
      var prev = perfById[id];
      if (prev && String(prev.note || '').indexOf(OMP_TRANSIT_NOTE_) < 0 &&
          String(prev.actual || '') !== '') {
        kept.push(pad_(b.emp.name, 22) + b.month + '   keeps ' + prev.actual +
          '  (note: ' + (prev.note || 'none') + ')');
        return;
      }
      var lad = ladder[b.emp.id + '|' + kpiId];
      var pb = lad ? parseBands_(lad) : null;
      var lvl = pb ? levelFromBands_(pb, rate) : null;
      writes.push({ id: id, emp: b.emp, kpiId: kpiId, pid: pid, month: b.month,
        rate: rate, hit: b.hit, miss: b.miss, skip: b.skip, den: den,
        bands: lad, level: lvl,
        was: prev ? prev.actual : '' });
    });
  });

  if (stale || agreeMoving) {
    out.push('=== DOES MM_CT AGREE THAT THESE ARE STILL MOVING? ===');
    out.push('  ' + agreeMoving + ' shipment(s): MM_CT says in transit and the tracker');
    out.push('        has no arrival either. Genuinely still moving.');
    out.push('  ' + stale + ' shipment(s): MM_CT says IN TRANSIT but the tracker says');
    out.push('        it arrived. One of the two is stale.');
    if (stale) {
      out.push('');
      staleEx.forEach(function (l) { out.push('    ' + l); });
      out.push('');
      out.push('  THIS MATTERS: every one of those is currently scored as a MISS on');
      out.push('  the "still in transit for more than ten days" rule. If the tracker');
      out.push('  is right, they arrived and most would be hits instead.');
    }
    out.push('');
  }
  out.push('=== THE RATE, PER PERSON PER MONTH ===');
  out.push('  ' + pad_('person', 22) + pad_('month', 9) + pad_('on time', 9) +
    pad_('late', 7) + pad_('of', 6) + pad_('rate', 8) + pad_('skipped', 9) +
    pad_('rates', 6) + 'was');
  writes.forEach(function (w) {
    out.push('  ' + pad_(w.emp.name, 22) + pad_(w.month, 9) + pad_(String(w.hit), 9) +
      pad_(String(w.miss), 7) + pad_(String(w.den), 6) +
      pad_((Math.round(w.rate * 1000) / 10) + '%', 8) + pad_(String(w.skip), 9) +
      pad_(w.level === null || w.level === undefined ? '?' : 'T' + w.level, 6) +
      (w.was === '' ? '—' : String(w.was)) +
      (w.den < 5 ? '   << ' + w.den + ' shipments, moves in steps of ' +
        Math.round(100 / w.den) + '%' : ''));
  });
  if (tooThin.length) {
    out.push('');
    out.push('  nothing countable:');
    tooThin.forEach(function (l) { out.push('    ' + l); });
  }
  if (kept.length) {
    out.push('');
    out.push('  left alone — a hand-typed number is never ours to overwrite:');
    kept.forEach(function (l) { out.push('    ' + l); });
  }
  if (samples.length) {
    out.push('');
    out.push('=== A SAMPLE OF THE MISSES, TO SPOT-CHECK ===');
    samples.forEach(function (l) { out.push('  ' + l); });
  }

  var zero = writes.filter(function (w) { return w.level === 0; });
  var thinW = writes.filter(function (w) { return w.den < 5; });
  if (zero.length || thinW.length) {
    out.push('');
    out.push(dryRun ? '=== READ THIS BEFORE IMPORTING ==='
                    : '=== WHAT WAS JUST WRITTEN, AND WHAT IT RATES ===');
    if (zero.length) {
      out.push('  ' + zero.length + ' of ' + writes.length +
        ' month(s) clear NO band at all — the lowest rung is ' +
        ((writes[0] && writes[0].bands) ? writes[0].bands[0] : '?') + '.');
      out.push('  Those months rate Target 0 on a KPI weighted half the scorecard.');
      out.push('  The arithmetic is doing what it was asked to; whether the Exp Date');
      out.push('  in the tracker is a commitment anybody signed up to is a different');
      out.push('  question, and it is the one these numbers are really asking.');
    }
    if (thinW.length) {
      out.push('  ' + thinW.length + ' month(s) rest on fewer than five shipments:');
      thinW.forEach(function (w) {
        out.push('      ' + pad_(w.emp.name, 22) + w.month + '   ' + w.den +
          ' shipment(s)');
      });
    }
  }
  out.push('');
  if (dryRun) {
    out.push('NOTHING WAS WRITTEN. This is a dry run.');
    out.push(writes.length + ' performance row(s) would be written.');
    out.push('No PLAN row is written and none is wanted: with no target in any');
    out.push('month the rate is read against the bands directly.');
    out.push('Run importOmpTransit() to apply.');
  } else {
    var actor = currentEmail_() || 'system';
    writes.forEach(function (w) {
      upsert_(T.PERF, { id: w.id, employee_id: w.emp.id, kpi_id: w.kpiId,
        period_id: w.pid, actual: w.rate, manual_level: '', level: '',
        kind: '', direction: '',
        note: OMP_TRANSIT_NOTE_ + ' · ' + w.hit + ' of ' + w.den +
          ' reached by the expected date' +
          (w.skip ? ' · ' + w.skip + ' not counted' : ''),
        status: 'recorded', updated_by: actor, updated_at: nowIso_() });
    });
    out.push('WROTE ' + writes.length + ' performance row(s).');
  }
  var txt = out.join(nl);
  Logger.log(txt);
  return txt;
}

function previewOmpTransit() { return ompTransitAchievements_(true); }
function importOmpTransit() { return ompTransitAchievements_(false); }

function profileOmpTracker() {
  ensureSeeded_();
  var nl = String.fromCharCode(10), out = [];
  var t = ompTrackerGrid_();
  if (t.error) { Logger.log(t.error); return t.error; }

  var emps = read_(T.EMPLOYEES).filter(function (e) { return !isLeaver_(e.name); });
  var teamById = idx_(read_(T.TEAMS));

  var ompTeam = null;
  read_(T.TEAMS).forEach(function (tm) {
    if (/open marketplace|control tower/i.test(String(tm.name))) ompTeam = tm;
  });
  out.push('=== 0. WHO IS ON CONTROL TOWER ===');
  if (!ompTeam) out.push('  no team matched — cannot list the roster');
  else {
    var roster = emps.filter(function (e) {
      return String(e.team_id) === String(ompTeam.id); });
    roster.sort(function (a, b) { return String(a.name).localeCompare(String(b.name)); })
      .forEach(function (e) {
        out.push('  ' + pad_(e.name, 26) + (e.designation || ''));
      });
    out.push('  ' + roster.length + ' people (leavers excluded)');
    var clash = [];
    Object.keys(OMP_POC_OFF_TEAM_).forEach(function (rule) {
      roster.forEach(function (e) {
        canonPersonName_(e.name).split(' ').forEach(function (tok) {
          if (tok.length < 4) return;
          var d = editDist_(tok, rule);
          if (d <= 2) clash.push({ rule: rule, who: e.name, d: d });
        });
      });
    });
    if (clash.length) {
      out.push('');
      out.push('  !! OFF-TEAM RULINGS THAT LOOK LIKE PEOPLE ON THIS TEAM:');
      clash.forEach(function (c) {
        out.push('     ruled off: ' + pad_(c.rule, 14) + 'roster has: ' + pad_(c.who, 24) +
          '(' + c.d + ' char' + (c.d === 1 ? '' : 's') + ' out)');
      });
      out.push('     If these are the same person the ruling is wrong and their');
      out.push('     shipments are being dropped. OMP_POC_OFF_TEAM_ in Code.gs.');
    }
  }
  out.push('');
  out.push('=== 1. THE SHAPE OF THE TAB ===');
  out.push('  header row is row ' + (t.headerRow + 1) +
    (t.headerRow === 0 ? '' : '   (row 1 is banners and running totals, not headers)'));
  out.push('  ' + (t.grid.length - t.headerRow - 1) + ' data rows');
  out.push('');
  var missing = [];
  for (var k in OMP_WANT_) {
    if (t.col[k] === undefined) missing.push(k);
    else out.push('  ' + pad_(k, 11) + t.letters[k]);
  }
  if (missing.length) {
    out.push('');
    out.push('  !! NOT FOUND: ' + missing.join(', '));
    out.push('     Everything below that needs one of these is wrong or absent.');
  }
  if (t.col.poc === undefined || t.col.shipment === undefined) {
    var stop = out.join(nl) + nl + nl + 'Stopping: without the POC and Shipment ID columns there is nothing to profile.';
    Logger.log(stop); return stop;
  }

  var rows = t.grid.slice(t.headerRow + 1);
  var pocCount = {}, pocRows = {};
  rows.forEach(function (r, i) {
    var v = String(r[t.col.poc] == null ? '' : r[t.col.poc]).trim();
    var key = v || '(blank)';
    pocCount[key] = (pocCount[key] || 0) + 1;
    (pocRows[key] = pocRows[key] || []).push(i);
  });
  out.push('');
  out.push('=== 2. "Control - POC" — WHAT IS ACTUALLY IN IT ===');
  out.push('Each value, how many rows carry it, and what each half of the pair');
  out.push('resolves to in the employee list.');
  out.push('');
  var pocKeys = Object.keys(pocCount).sort(function (a, b) { return pocCount[b] - pocCount[a]; });
  var unresolved = {}, resolvedTo = {}, paired = 0, single = 0;
  var offteamRows = 0, unresolvedRows = 0, blankRows = 0, attributedRows = 0;
  pocKeys.forEach(function (key) {
    out.push('  ' + pad_(String(pocCount[key]), 5) + key);
    if (key === '(blank)') {
      out.push('        -> no owner. These rows cannot be attributed to anyone.');
      blankRows += pocCount[key];
      return;
    }
    var anyResolved = false, anyOffteam = false, anyUnresolved = false;
    var parts = key.split(/[\/,&+]|\band\b/i).map(function (x) { return x.trim(); })
      .filter(function (x) { return x.length; });
    if (parts.length > 1) paired++; else single++;
    parts.forEach(function (p) {
      var r = ompResolveName_(p, emps);
      if (r.state === 'one') {
        var tm = (teamById[r.emp.team_id] || {}).name || '?';
        out.push('        ' + pad_(p, 16) + '-> ' + r.emp.name + '   [' + tm + ']');
        resolvedTo[r.emp.name] = (resolvedTo[r.emp.name] || 0) + pocCount[key];
        anyResolved = true;
      } else if (r.state === 'ambiguous') {
        out.push('        ' + pad_(p, 16) + '-> AMBIGUOUS: ' + r.who.join(' / '));
        unresolved[p] = 'ambiguous';
        anyUnresolved = true;
      } else if (r.state === 'offteam') {
        out.push('        ' + pad_(p, 16) + '-> OFF TEAM: ' + r.why);
        anyOffteam = true;
      } else {
        var tail = '-> NO MATCH in the employee list';
        if (r.near && r.near.length) {
          tail += '   did you mean ' + r.near.map(function (x) {
            return x.who + ' (' + (x.d === 0 ? 'same token' :
              x.d + ' char' + (x.d === 1 ? '' : 's') + ' out') +
              (x.pre ? ', same first four' : '') + ')';
          }).join('  or  ') + '?';
        }
        out.push('        ' + pad_(p, 16) + tail);
        unresolved[p] = 'none';
        anyUnresolved = true;
      }
    });
    if (anyResolved) attributedRows += pocCount[key];
    else if (anyOffteam && !anyUnresolved) offteamRows += pocCount[key];
    else unresolvedRows += pocCount[key];
  });
  out.push('');
  out.push('  ' + pocKeys.length + ' distinct values: ' + paired + ' are pairs, ' + single + ' are single names');
  var un = Object.keys(unresolved);
  out.push('  ' + un.length + ' name' + (un.length === 1 ? '' : 's') + ' did not resolve' +
    (un.length ? ': ' + un.join(', ') : ''));
  out.push('');
  out.push('  rows with an owner           ' + attributedRows);
  out.push('  rows excluded by ruling      ' + offteamRows +
    '   (Meghraj, Kalyan — closed, not a gap)');
  out.push('  rows with an unmatched name  ' + unresolvedRows +
    '   (open: these belong to nobody)');
  out.push('  rows with no POC written     ' + blankRows +
    '   (open: nothing to attribute them by)');

  out.push('');
  out.push('=== 3. DOES "Shipment ID" JOIN TO MM_CT? ===');
  var mm = {}, mmRows = 0, mmStatus = {};
  try {
    var msrc = SpreadsheetApp.openById(SHIPMENTS_SHEET_ID);
    var msh = findSheet_(msrc, SHIPMENTS_TAB);
    if (!msh) throw new Error('no tab matching "' + SHIPMENTS_TAB + '"');
    var mg = msh.getRange(1, 1, msh.getLastRow(), msh.getLastColumn()).getValues();
    var mh = mg[0], iId = -1, iSt = -1, iStage = -1, iUpd = -1;
    for (var c2 = 0; c2 < mh.length; c2++) {
      var hh = String(mh[c2] || '').trim().toLowerCase();
      if (hh === 'shipment_id') iId = c2;
      if (hh === 'shipment_status') iSt = c2;
      if (hh === 'shipment_stage_label') iStage = c2;
      if (hh === 'shipment_updated_date') iUpd = c2;
    }
    if (iId < 0) throw new Error('Raw_Shipments has no shipment_id column');
    for (var r2 = 1; r2 < mg.length; r2++) {
      var id = String(mg[r2][iId] || '').trim();
      if (!id) continue;
      mmRows++;
      mm[id.toUpperCase()] = {
        status: iSt < 0 ? '' : String(mg[r2][iSt] || ''),
        stage:  iStage < 0 ? '' : String(mg[r2][iStage] || ''),
        updated: iUpd < 0 ? '' : mg[r2][iUpd]
      };
    }
    out.push('  MM_CT ' + SHIPMENTS_TAB + ': ' + mmRows + ' shipments');
  } catch (e) {
    out.push('  !! cannot read MM_CT: ' + (e && e.message || e));
  }
  var hasId = 0, matched = 0, noId = 0, unmatchedEx = [];
  var seenTracker = {};
  rows.forEach(function (r) {
    var id = String(r[t.col.shipment] == null ? '' : r[t.col.shipment]).trim().toUpperCase();
    if (!id) { noId++; return; }
    hasId++; seenTracker[id] = true;
    if (mm[id]) {
      matched++;
      var st = mm[id].status || '(blank)';
      mmStatus[st] = (mmStatus[st] || 0) + 1;
    } else if (unmatchedEx.length < 8) unmatchedEx.push(id);
  });
  out.push('  tracker rows with a Shipment ID   ' + hasId);
  out.push('  tracker rows without one          ' + noId +
    (noId ? '   <- cannot be joined, and cannot be measured from MM_CT' : ''));
  out.push('  of those with one, found in MM_CT ' + matched +
    (hasId ? '   (' + Math.round(matched / hasId * 1000) / 10 + '%)' : ''));
  if (unmatchedEx.length) out.push('  not found, first few: ' + unmatchedEx.join(', '));
  var orphan = 0;
  Object.keys(mm).forEach(function (id) { if (!seenTracker[id]) orphan++; });
  out.push('  in MM_CT but not in the tracker   ' + orphan +
    (orphan ? '   <- owned by nobody on this tracker' : ''));
  out.push('');
  out.push('  the matched shipments, by MM_CT shipment_status:');
  Object.keys(mmStatus).sort(function (a, b) { return mmStatus[b] - mmStatus[a]; })
    .forEach(function (s) { out.push('      ' + pad_(String(mmStatus[s]), 6) + s); });

  out.push('');
  out.push('=== 4. HOW MANY SHIPMENTS PER POC PER MONTH ===');
  out.push('This is the number that decides whether a monthly percentage means');
  out.push('anything. Bucketed on MM Date, counting rows that HAVE a Shipment ID.');
  out.push('');
  var byPocMonth = {}, months = {};
  rows.forEach(function (r) {
    var id = String(r[t.col.shipment] == null ? '' : r[t.col.shipment]).trim();
    if (!id) return;
    var d = t.col.mmDate === undefined ? null : cellDate_(r[t.col.mmDate]);
    var mkey = d ? Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM') : '(no date)';
    months[mkey] = true;
    var who = String(r[t.col.poc] == null ? '' : r[t.col.poc]).trim() || '(blank)';
    (byPocMonth[who] = byPocMonth[who] || {})[mkey] = (byPocMonth[who][mkey] || 0) + 1;
  });
  var mkeys = Object.keys(months).sort();
  out.push('  ' + pad_('', 26) + mkeys.map(function (m) { return pad_(m.slice(2), 9); }).join(''));
  var thin = 0, cells = 0;
  Object.keys(byPocMonth).sort().forEach(function (who) {
    var line = pad_(who, 26);
    mkeys.forEach(function (m) {
      var v = byPocMonth[who][m] || 0;
      if (v > 0) { cells++; if (v < 5) thin++; }
      line += pad_(v ? String(v) : '·', 9);
    });
    out.push('  ' + line);
  });
  out.push('');
  out.push('  ' + thin + ' of ' + cells + ' person-months have FEWER THAN 5 shipments.');
  out.push('  A percentage over four shipments moves in steps of 25.');

  out.push('');
  out.push('=== 5. THE DENOMINATOR ===');
  out.push('Cancelled, draft and ready-to-dispatch do not count — they leave the');
  out.push('denominator rather than counting as a miss. Here is what that removes.');
  out.push('');
  var cross = {}, statuses = {}, stages = {};
  rows.forEach(function (r) {
    var id = String(r[t.col.shipment] == null ? '' : r[t.col.shipment]).trim().toUpperCase();
    if (!id || !mm[id]) return;
    var st = mm[id].status || '(blank)', sg = mm[id].stage || '(blank)';
    statuses[st] = true; stages[sg] = true;
    var k2 = st + ' | ' + sg;
    cross[k2] = (cross[k2] || 0) + 1;
  });
  out.push('  MM_CT shipment_status | shipment_stage_label, for the matched rows:');
  Object.keys(cross).sort(function (a, b) { return cross[b] - cross[a]; })
    .forEach(function (k2) {
      var st2 = k2.split(' | ')[0], sg2 = k2.split(' | ')[1];
      out.push('      ' + pad_(String(cross[k2]), 6) + pad_(k2, 46) +
        (ompCounts_(st2, sg2) ? 'counts' : 'DOES NOT COUNT'));
    });
  out.push('');
  var keep = {}, dropped = 0, kept = 0;
  rows.forEach(function (r) {
    var id = String(r[t.col.shipment] == null ? '' : r[t.col.shipment]).trim().toUpperCase();
    if (!id || !mm[id]) return;
    var who = String(r[t.col.poc] == null ? '' : r[t.col.poc]).trim() || '(blank)';
    var d2 = t.col.mmDate === undefined ? null : cellDate_(r[t.col.mmDate]);
    var mk = d2 ? Utilities.formatDate(d2, Session.getScriptTimeZone(), 'yyyy-MM') : '(no date)';
    if (!ompCounts_(mm[id].status, mm[id].stage)) { dropped++; return; }
    kept++;
    (keep[who] = keep[who] || {})[mk] = (keep[who][mk] || 0) + 1;
  });
  out.push('  ' + kept + ' shipments count, ' + dropped + ' do not.');
  out.push('');
  out.push('  countable shipments per POC per month:');
  out.push('  ' + pad_('', 26) + mkeys.map(function (m) { return pad_(m.slice(2), 9); }).join(''));
  var thin2 = 0, cells2 = 0;
  Object.keys(keep).sort().forEach(function (who) {
    var line2 = pad_(who, 26);
    mkeys.forEach(function (m) {
      var v2 = keep[who][m] || 0;
      if (v2 > 0) { cells2++; if (v2 < 5) thin2++; }
      line2 += pad_(v2 ? String(v2) : '·', 9);
    });
    out.push('  ' + line2);
  });
  out.push('');
  out.push('  ' + thin2 + ' of ' + cells2 + ' person-months still have fewer than 5.');

  var txt = out.join(nl);
  Logger.log(txt);
  return txt;
}

function pad_(s, n) { s = String(s == null ? '' : s); while (s.length < n) s += ' '; return s; }

function describeOmpTracker() {
  var txt = describeTab_(OMP_TRACKER_SHEET_ID, OMP_TRACKER_TAB, 400);
  Logger.log(txt);
  return txt;
}

function listTabsOmpTracker() { return inspectTabList(OMP_TRACKER_SHEET_ID); }

function describeTab_(id, tabName, scanRows) {
  var nl = String.fromCharCode(10);
  var src, sh;
  try { src = SpreadsheetApp.openById(id); }
  catch (e) { return 'Cannot open the workbook  (' + (e && e.message || e) + ')'; }
  sh = findSheet_(src, tabName);
  if (!sh) return 'no tab matching "' + tabName + '"';
  var lastR = sh.getLastRow(), lastC = sh.getLastColumn();
  if (lastR < 2) return sh.getName() + ' is empty';
  var nR = Math.min(lastR, (scanRows || 200) + 1);
  var g = sh.getRange(1, 1, nR, lastC).getValues();
  var out = [src.getName() + '  ->  ' + sh.getName() + '   (' + lastR + ' rows x ' +
            lastC + ' cols, scanning ' + (nR - 1) + ')', ''];
  for (var c = 0; c < lastC; c++) {
    var seen = {}, vals = [], filled = 0;
    for (var r = 1; r < nR; r++) {
      var v = g[r][c];
      if (v === '' || v === null || v === undefined) continue;
      filled++;
      var t = (v instanceof Date) ? '<date ' + Utilities.formatDate(v, 'UTC', 'yyyy-MM-dd') + '>'
            : String(v);
      if (t.length > 26) t = t.slice(0, 26) + '~';
      if (!seen[t]) { seen[t] = 1; if (vals.length < 4) vals.push(t); }
    }
    var nDistinct = Object.keys(seen).length;
    out.push(colLetter_(c + 1) + '  (c' + c + ')  ' + String(g[0][c] || '(no header)') +
      '   [' + filled + '/' + (nR - 1) + ' filled, ' + nDistinct + ' distinct]');
    out.push('      ' + (vals.length ? vals.join('  |  ') : '(all blank)'));
  }
  var txt = out.join(nl);
  Logger.log(txt);
  return txt;
}

function describeShipments()      { return describeTab_(SHIPMENTS_SHEET_ID, SHIPMENTS_TAB, 300); }
function describePOCData()        { return describeTab_(SHIPMENTS_SHEET_ID, 'POC_data', 300); }
function describeRawTransactions(){ return describeTab_(SHIPMENTS_SHEET_ID, 'Raw_Transactions', 300); }
function describeRawOBBuyers()    { return describeTab_(SHIPMENTS_SHEET_ID, 'Raw_OB_Buyers', 300); }
function describeRawSellers()     { return describeTab_(SHIPMENTS_SHEET_ID, 'Raw_Sellers', 300); }
function describeRawBuyers()      { return describeTab_(SHIPMENTS_SHEET_ID, 'Raw_Buyers', 300); }

function inspectTabList(which) {
  var ID = (!which || /target/i.test(which)) ? TARGETS_SHEET_ID
         : /mmct|shipment|dashboard/i.test(which) ? SHIPMENTS_SHEET_ID : which;
  var out = [], src;
  try { src = SpreadsheetApp.openById(ID); }
  catch (e) { return 'Cannot open ' + ID + '  (' + (e && e.message || e) + ')'; }
  var sheets = src.getSheets();
  out.push(src.getName() + '  —  ' + sheets.length + ' tabs');
  out.push('');
  sheets.forEach(function (sh, i) {
    var lastR = sh.getLastRow(), lastC = sh.getLastColumn();
    var hints = '';
    if (lastR >= 1 && lastC >= 1) {
      var head = sh.getRange(1, 1, 1, Math.min(lastC, 60)).getValues()[0]
        .map(function (v) { return String(v == null ? '' : v).trim(); })
        .filter(function (x) { return x !== ''; });
      hints = head.length ? colHints_(head).join(',') : 'ROW 1 BLANK — use peekTab';
    }
    out.push('  [' + (i + 1) + (i < 9 ? ' ' : '') + '] ' +
      String(sh.getName()).slice(0, 30) +
      '   ' + Math.max(0, lastR - 1) + 'r x ' + lastC + 'c' +
      (sh.isSheetHidden() ? ' (hidden)' : '') +
      (hints ? '   [' + hints + ']' : ''));
  });
  var txt = out.join(String.fromCharCode(10));
  Logger.log(txt);
  return txt;
}

function peekTargets() {
  var nl = String.fromCharCode(10);
  var txt = ['Metals', 'Plastics', 'Employee Directory'].map(function (t) {
    return peekTab(t, 'target', 12, 12);
  }).join(nl + nl + '----------------------------------------' + nl + nl);
  Logger.log(txt);
  return txt;
}

function inspectAllSources() {
  var nl = String.fromCharCode(10);
  var txt = inspectTabList(TARGETS_SHEET_ID) + nl + nl +
    '================================================================' + nl + nl +
    inspectTabList(SHIPMENTS_SHEET_ID);
  Logger.log(txt);
  return txt;
}

function inspectShipments() { return inspectTab(SHIPMENTS_TAB, SHIPMENTS_SHEET_ID); }

// ===== LEAVER CLEANUP =====
function leaverCleanup_(dryRun) {
  ensureSeeded_();
  var nl = String.fromCharCode(10), out = [];
  var emps = read_(T.EMPLOYEES), kpis = idx_(read_(T.KPIS));
  var gone = emps.filter(function (e) { return isLeaver_(e.name); });
  if (!gone.length) return 'No leavers listed, so nothing to clean up.';

  var goneById = {};
  gone.forEach(function (e) { goneById[String(e.id)] = e; });
  out.push('=== leavers ===');
  gone.forEach(function (e) {
    var lv = EMPLOYEE_LEAVERS[normName_(e.name)] || {};
    out.push('  ' + e.name + '   id ' + e.id +
      (lv.handoverTo ? '   figures merged into ' + lv.handoverTo : ''));
  });
  out.push('');

  var plans = read_(T.PLAN).filter(function (p) { return goneById[String(p.employee_id)]; });
  var perf = read_(T.PERF).filter(function (p) { return goneById[String(p.employee_id)]; });

  function show(title, rows, field) {
    out.push('=== ' + title + ': ' + rows.length + ' rows ===');
    rows.slice(0, 40).forEach(function (r) {
      out.push('  ' + String(r.period_id).replace('per_', '') +
        '  ' + ((kpis[r.kpi_id] || {}).name || r.kpi_id) +
        '  = ' + (r[field] === '' || r[field] === null ? '-' : r[field]));
    });
    if (rows.length > 40) out.push('  ... and ' + (rows.length - 40) + ' more');
    out.push('');
  }
  show('PLAN rows to delete', plans, 'target_value');
  show('PERFORMANCE rows to delete', perf, 'actual');

  out.push('KEPT, deliberately: the EMPLOYEES row (so audit entries naming the');
  out.push('id still resolve), ASSIGNMENTS and TARGETS (rebuilt by the next');
  out.push('framework import anyway), and the whole AUDIT log.');
  out.push('');

  if (dryRun) {
    out.push('NOTHING WAS WRITTEN. This is a dry run.');
    out.push('Check the values above appear under the person who took over,');
    out.push('then run cleanupLeaverRows() to delete them.');
  } else {
    plans.forEach(function (p) { del_(T.PLAN, p.id); });
    perf.forEach(function (p) { del_(T.PERF, p.id); });
    audit_(currentEmail_(), 'system', 'leaver_cleanup', 'delete',
      { plan: plans.length, performance: perf.length },
      null, 'superseded rows for ' + gone.map(function (e) { return e.name; }).join(', '));
    commit_();
    out.push('DELETED ' + plans.length + ' PLAN and ' + perf.length +
      ' PERFORMANCE rows. Recorded in the audit log.');
  }
  var txt = out.join(nl);
  Logger.log(txt);
  return txt;
}

function previewLeaverCleanup() { return leaverCleanup_(true); }

function cleanupLeaverRows() { return leaverCleanup_(false); }
function explainCoverage() {
  ensureSeeded_();
  var nl = String.fromCharCode(10), out = [];
  var emps = read_(T.EMPLOYEES), teams = idx_(read_(T.TEAMS));
  var kras = idx_(read_(T.KRAS)), kpis = idx_(read_(T.KPIS));
  var empById = idx_(emps);
  var assigns = read_(T.ASSIGN);

  var tCount = {}, aCount = {};
  read_(T.PLAN).forEach(function (p) {
    if (num_(p.target_value) === null) return;
    var k = String(p.employee_id) + '|' + String(p.kpi_id);
    tCount[k] = (tCount[k] || 0) + 1;
  });
  read_(T.PERF).forEach(function (p) {
    if (num_(p.actual) === null) return;
    var k = String(p.employee_id) + '|' + String(p.kpi_id);
    aCount[k] = (aCount[k] || 0) + 1;
  });

  var byEmp = {};
  assigns.forEach(function (a) {
    (byEmp[a.employee_id] = byEmp[a.employee_id] || []).push(a);
  });

  var complete = [], gapPeople = 0, gapRows = 0;
  var kraGap = {}, noSource = {}, noSourcePeople = {};
  var deptHasSource = {};
  Object.keys(tCount).forEach(function (k) {
    var emp = empById[k.split('|')[0]];
    if (emp) deptHasSource[(teams[emp.team_id] || {}).name || '?'] = true;
  });
  emps.slice().sort(function (x, y) {
    var t = String((teams[x.team_id] || {}).name || '')
      .localeCompare(String((teams[y.team_id] || {}).name || ''));
    return t || String(x.name).localeCompare(String(y.name));
  }).forEach(function (e) {
    var list = byEmp[e.id] || [];
    var lines = [];
    list.forEach(function (a) {
      var k = String(e.id) + '|' + String(a.kpi_id);
      var t = tCount[k] || 0, ac = aCount[k] || 0;
      if (t > 0 && ac > 0) return;
      var kraName = (kras[a.kra_id] || {}).name || a.kra_id;
      var why = (t === 0 && ac === 0) ? 'no target AND no achievement'
              : (ac === 0) ? 'target but NO ACHIEVEMENT in the sheet'
              : 'achievement but no target, so it cannot be rated';
      gapRows++;
      if (t === 0 && ac === 0) {
        var dept = (teams[e.team_id] || {}).name || '?';
        noSource[dept] = (noSource[dept] || 0) + 1;
        noSourcePeople[dept] = noSourcePeople[dept] || {};
        noSourcePeople[dept][e.name] = 1;
        return;
      }
      lines.push('    t=' + t + '  a=' + ac + '   ' + kraName + '   (' + why + ')');
      var gk = kraName + '   ' + why;
      kraGap[gk] = (kraGap[gk] || 0) + 1;
    });
    if (!lines.length) { complete.push(e.name); return; }
    gapPeople++;
    out.push(((teams[e.team_id] || {}).name || '?') +
      (e.sub_group ? ' / ' + e.sub_group : '') + '   ' + e.name);
    lines.forEach(function (l) { out.push(l); });
  });

  var head = [];
  head.push('=== coverage: months with a target (t) and with an achievement (a) ===');
  head.push('  ' + emps.length + ' people, ' + assigns.length + ' assignments');
  head.push('  ' + gapPeople + ' people have at least one gap, ' + gapRows + ' gap rows');
  head.push('');
  head.push('--- FIXABLE: a target exists, the Achievement column is empty ---');
  var fixable = Object.keys(kraGap).sort(function (a, b) { return kraGap[b] - kraGap[a]; });
  if (!fixable.length) head.push('  (none)');
  fixable.forEach(function (k) { head.push('    ' + kraGap[k] + ' x  ' + k); });
  head.push('');
  head.push('--- NOT FIXABLE HERE: no target source for these departments ---');
  head.push('    The Target Sheet has only Metals and Plastics tabs, so these');
  head.push('    KRAs can never receive a target until a source exists.');
  var depts = Object.keys(noSource).sort(function (a, b) { return noSource[b] - noSource[a]; });
  var anomalies = [];
  if (!depts.length) head.push('    (none)');
  depts.forEach(function (d) {
    var who = Object.keys(noSourcePeople[d] || {});
    if (deptHasSource[d]) { anomalies.push({ d: d, n: noSource[d], who: who }); return; }
    head.push('    ' + noSource[d] + ' assignments across ' + who.length +
      ' people   ' + d);
  });
  head.push('');
  if (anomalies.length) {
    head.push('--- !! ALSO FIXABLE: these people are in a department that HAS a');
    head.push('       target source, but are MISSING FROM THE TARGET SHEET ---');
    anomalies.forEach(function (a) {
      head.push('    ' + a.d + ':  ' + a.who.join(', ') +
        '   (' + a.n + ' assignments with no target at all)');
    });
    head.push('');
  }

  out.push('');
  out.push('no FIXABLE gap — every assignment either has both, or has no target');
  out.push('source at all (' + complete.length + '):');
  out.push('  ' + (complete.join(', ') || '(none)'));
  var txt = head.join(nl) + nl + out.join(nl);
  Logger.log(txt);
  return txt;
}
function explainPerson(name) {
  ensureSeeded_();
  var nl = String.fromCharCode(10), out = [];
  var want = canonPersonName_(name || '');
  if (!want) {
    var hint = 'explainPerson needs a NAME, and the Run button cannot pass one.' +
      nl + nl +
      'Either open  ?diag=explainPerson&arg=NEELESH DIXIT' + nl +
      'or run explainDso(), which takes no argument.';
    Logger.log(hint);
    return hint;
  }
  var emps = read_(T.EMPLOYEES);
  var e = null;
  for (var i = 0; i < emps.length; i++) {
    if (canonPersonName_(emps[i].name) === want) { e = emps[i]; break; }
  }
  if (!e) {
    return 'No employee matches "' + name + '" (canonical: ' + want + ')' + nl +
      'Known names:' + nl +
      emps.map(function (x) { return '  ' + x.name; }).sort().join(nl);
  }

  var teams = idx_(read_(T.TEAMS)), kras = idx_(read_(T.KRAS)), kpis = idx_(read_(T.KPIS));
  var periods = read_(T.PERIODS).slice().sort(function (a, b) {
    return num_(a.sort) - num_(b.sort); });
  var assigns = read_(T.ASSIGN).filter(function (a) {
    return String(a.employee_id) === String(e.id); });

  var planBy = {}, perfBy = {}, tgtBy = {};
  read_(T.PLAN).forEach(function (p) {
    if (String(p.employee_id) !== String(e.id)) return;
    planBy[String(p.kpi_id) + '|' + String(p.period_id)] = p;
  });
  read_(T.PERF).forEach(function (p) {
    if (String(p.employee_id) !== String(e.id)) return;
    perfBy[String(p.kpi_id) + '|' + String(p.period_id)] = p;
  });
  read_(T.TARGETS).forEach(function (t) {
    if (String(t.employee_id) !== String(e.id)) return;
    tgtBy[String(t.kpi_id) + '|' + String(t.period_id)] = t;
  });

  if (isLeaver_(e.name)) {
    var lv = EMPLOYEE_LEAVERS[canonPersonName_(e.name)];
    out.push('!! LEAVER — hidden from the dashboard since ' + (lv.left || '?') +
      (lv.handoverTo ? ', accounts handed to ' + lv.handoverTo : ''));
    out.push('   The rows below still exist and are unchanged. Removing the name');
    out.push('   from EMPLOYEE_LEAVERS restores the person and all of this.');
    out.push('');
  }
  out.push(e.name + '   ' + (e.designation || ''));
  out.push('  id ' + e.id + '   team ' + ((teams[e.team_id] || {}).name || e.team_id) +
    (e.sub_group ? '  /  ' + e.sub_group : ''));
  out.push('  ' + assigns.length + ' assignments');
  out.push('');

  assigns.forEach(function (a) {
    var kra = kras[a.kra_id] || {}, kpi = kpis[a.kpi_id] || {};
    out.push('== ' + (kra.name || a.kra_id) + '   [' + (kpi.name || a.kpi_id) + ']');
    var ovr_ = weightOverride_(e.name, kra.name);
    out.push('   weightage ' + a.weightage +
      (ovr_ === null ? '' : '  -> OVERRIDDEN to ' + ovr_ + ' (see WEIGHTAGE_OVERRIDES)') +
      '   kpi_id ' + a.kpi_id);
    var any = false;
    periods.forEach(function (p) {
      var k = String(a.kpi_id) + '|' + String(p.id);
      var pl = planBy[k], pf = perfBy[k], tg = tgtBy[k];
      var tv = pl ? num_(pl.target_value) : null;
      var av = pf ? num_(pf.actual) : null;
      if (tv === null && av === null && !tg) return;
      any = true;
      var bands = tg ? [tg.t1, tg.t2, tg.t3, tg.t4, tg.t5].map(function (b) {
        return String(b == null ? '' : b); }).join(' | ') : '(no ladder row)';
      out.push('   ' + periodLabel_(p) +
        '   target=' + (tv === null ? '-' : tv) +
        '   achieved=' + (av === null ? '-' : av) +
        '   ladder ' + bands);
      if (pf && pf.note) out.push('        note: ' + pf.note);
    });
    if (!any) out.push('   (no target, no achievement and no ladder in any month)');
    out.push('');
  });

  out.push('How to read a blank cell on the dashboard:');
  out.push('  no line above for that month  -> nothing was imported for it');
  out.push('  target=- achieved=<n>         -> achieved shows, but cannot be RATED');
  out.push('  target=<n> achieved=-         -> the Target Sheet Achievement column is empty');
  out.push('  neither                       -> the row will not appear in the table at all');
  var txt = out.join(nl);
  Logger.log(txt);
  return txt;
}
// ===== EXPLAIN A TEAM =====
var TEAM_ALIASES_ = {
  'omp': 'open marketplace',
  'ct': 'control tower',
  'omp ct': 'open marketplace'
};

function explainTeam(name) {
  ensureSeeded_();
  var nl = String.fromCharCode(10), out = [];
  var teams = read_(T.TEAMS);
  var want = normName_(name || '').toLowerCase();
  if (TEAM_ALIASES_[want]) want = normName_(TEAM_ALIASES_[want]).toLowerCase();

  if (!want) {
    var hint = 'explainTeam needs a TEAM, and the Run button cannot pass one.' + nl + nl +
      'Run explainOMP() instead, or open  ?diag=explainTeam&arg=OMP' + nl + nl +
      'Teams:' + nl + teams.map(function (t) { return '  ' + t.name; }).join(nl);
    Logger.log(hint); return hint;
  }
  var team = null;
  for (var i = 0; i < teams.length; i++) {
    var n = normName_(teams[i].name).toLowerCase();
    if (n === want || n.indexOf(want) >= 0 || want.indexOf(n) >= 0) { team = teams[i]; break; }
  }
  if (!team) {
    var miss = 'No team matches "' + name + '" (looked for: ' + want + ')' + nl +
      'Teams:' + nl + teams.map(function (t) { return '  ' + t.name; }).join(nl);
    Logger.log(miss); return miss;
  }

  var kras = idx_(read_(T.KRAS)), kpis = idx_(read_(T.KPIS));
  var periods = read_(T.PERIODS).slice().sort(function (a, b) {
    return (num_(a.sort) || 0) - (num_(b.sort) || 0); });
  var periodAt = {};
  periods.forEach(function (p, ix) { periodAt[String(p.id)] = ix; });

  var emps = read_(T.EMPLOYEES).filter(function (e) {
    return String(e.team_id) === String(team.id) && !isLeaver_(e.name);
  }).sort(function (a, b) { return String(a.name).localeCompare(String(b.name)); });
  var mine = {};
  emps.forEach(function (e) { mine[String(e.id)] = true; });

  var tCount = {}, aCount = {}, ladder = {}, ladderAt = {};
  read_(T.PLAN).forEach(function (p) {
    if (!mine[String(p.employee_id)] || num_(p.target_value) === null) return;
    var k = p.employee_id + '|' + p.kpi_id;
    tCount[k] = (tCount[k] || 0) + 1;
  });
  read_(T.PERF).forEach(function (p) {
    if (!mine[String(p.employee_id)] || num_(p.actual) === null) return;
    var k = p.employee_id + '|' + p.kpi_id;
    aCount[k] = (aCount[k] || 0) + 1;
  });
  read_(T.TARGETS).forEach(function (t) {
    if (!mine[String(t.employee_id)]) return;
    var at = periodAt[String(t.period_id)];
    if (at === undefined) return;
    var k = t.employee_id + '|' + t.kpi_id;
    if (ladderAt[k] !== undefined && ladderAt[k] > at) return;
    ladderAt[k] = at; ladder[k] = t;
  });

  var byEmp = {};
  read_(T.ASSIGN).forEach(function (a) {
    if (mine[String(a.employee_id)]) (byEmp[a.employee_id] = byEmp[a.employee_id] || []).push(a);
  });

  var scoreable = 0, needAct = 0, needBoth = 0, halfFed = 0, noLadder = 0, rows = 0;
  var bySource = {}, detail = [];

  emps.forEach(function (e) {
    var list = byEmp[e.id] || [];
    var wsum = 0;
    list.forEach(function (a) { wsum += (num_(a.weightage) || 0); });
    detail.push('=== ' + e.name + '   ' + (e.designation || ''));
    detail.push('    ' + list.length + ' assignments, weightage totals ' + wsum +
      (Math.abs(wsum - 100) < 0.01 ? '' : '   <<< does not total 100'));
    if (!list.length) detail.push('    (no assignments — nothing to score)');
    list.forEach(function (a) {
      rows++;
      var kra = kras[a.kra_id] || {}, kpi = kpis[a.kpi_id] || {};
      var k = e.id + '|' + a.kpi_id;
      var lad = ladder[k];
      var bands = lad ? [lad.t1, lad.t2, lad.t3, lad.t4, lad.t5] : null;
      var t = tCount[k] || 0, ac = aCount[k] || 0;
      var ratioShaped = bands ? isRatioLadder_(bands).ok : false;

      detail.push('');
      detail.push('  == ' + (kra.name || a.kra_id) + '   [' + (kpi.name || a.kpi_id) + ']');
      detail.push('     weightage ' + a.weightage +
        (kpi.unit ? '   unit ' + kpi.unit : '') +
        (kpi.source ? '   source ' + kpi.source : ''));

      if (!bands) {
        detail.push('     ladder    NONE in any month');
      } else {
        detail.push('     ladder    ' + bands.map(function (b) {
          return String(b == null ? '' : b); }).join(' | '));
        if (!ratioShaped) {
          detail.push('               absolute ladder — ' + isRatioLadder_(bands).why);
          detail.push('               the actual is read against the bands directly');
        } else if (t) {
          detail.push('               RATIO ladder, and a target exists — so this one IS');
          detail.push('               scored as achieved / target');
        } else {
          detail.push('               rate ladder with no target in any month — the stored');
          detail.push('               number is read against the bands AS IS (planEver)');
        }
      }
      detail.push('     target    ' + (t ? t + ' month' + (t === 1 ? '' : 's') : 'none'));
      detail.push('     achieved  ' + (ac ? ac + ' month' + (ac === 1 ? '' : 's') : 'none'));

      var verdict;
      if (!bands) {
        verdict = 'AWARD BY HAND — no ladder exists, so nothing can rate it';
        noLadder++;
      } else if (ac && (t || ratioShaped)) {
        verdict = 'scoreable'; scoreable++;
      } else if (t && !ac) {
        verdict = 'HALF FED — the target is there, the achievement is not';
        halfFed++;
      } else if (ratioShaped) {
        verdict = 'NEEDS AN ACHIEVEMENT ONLY — one figure per person per month. ' +
          'No target row is needed unless you want one';
        needAct++;
        var src = String(kpi.source || '(no source named)');
        (bySource[src] = bySource[src] || []).push(
          (kra.name || '?') + '  [' + (kpi.name || '?') + ']  ' + e.name);
      } else {
        verdict = 'NEEDS BOTH — an absolute ladder with no target and no achievement';
        needBoth++;
        var src2 = String(kpi.source || '(no source named)');
        (bySource[src2] = bySource[src2] || []).push(
          (kra.name || '?') + '  [' + (kpi.name || '?') + ']  ' + e.name);
      }
      detail.push('     -> ' + verdict);
    });
    detail.push('');
  });

  out.push(String(team.name).toUpperCase() + '   (team ' + team.id + ')');
  out.push('  ' + emps.length + ' people, ' + rows + ' assignments, leavers excluded');
  out.push('');
  out.push('=== WHERE THIS TEAM STANDS ===');
  out.push('  scoreable today                  ' + scoreable);
  out.push('  needs an ACHIEVEMENT only        ' + needAct);
  out.push('  needs BOTH sides                 ' + needBoth);
  out.push('  half fed, one side only          ' + halfFed);
  out.push('  no ladder, award by hand         ' + noLadder);
  out.push('');

  var srcs = Object.keys(bySource).sort();
  if (!srcs.length) {
    out.push('Nothing on this team is waiting on a number.');
  } else {
    out.push('=== WHAT IS MISSING, GROUPED BY WHERE THE WORKBOOK SAYS IT COMES FROM ===');
    out.push('The source column is the whole question. One that names a SYSTEM can be');
    out.push('read; one that names email, meetings or a manual audit cannot, and those');
    out.push('KPIs have to be entered rather than imported.');
    out.push('');
    srcs.forEach(function (sname) {
      var v = bySource[sname];
      out.push('  ' + sname + '   (' + v.length + ')');
      v.sort().forEach(function (line) { out.push('      ' + line); });
      out.push('');
    });
  }
  out.push('=== PER PERSON ===');
  out.push('');
  var txt = out.concat(detail).join(nl);
  Logger.log(txt);
  return txt;
}

function explainOMP() { return explainTeam('OMP'); }
function explainCollectionsTeam() { return explainTeam('Collections'); }
function explainOnboardingTeam() { return explainTeam('Onboarding'); }

// ===== EXPLAIN DSO =====
function explainDso() {
  ensureSeeded_();
  var nl = String.fromCharCode(10), out = [];
  var emps = read_(T.EMPLOYEES), teamById = idx_(read_(T.TEAMS));
  var kras = idx_(read_(T.KRAS)), kpis = idx_(read_(T.KPIS));
  var periods = read_(T.PERIODS).slice().sort(function (a, b) {
    return (num_(a.sort) || 0) - (num_(b.sort) || 0); });

  var holders = [];
  read_(T.ASSIGN).forEach(function (a) {
    var kra = kras[a.kra_id]; if (!kra) return;
    if (!/DSO/i.test(String(kra.name || '')) &&
        !/DSO/i.test(String((kpis[a.kpi_id] || {}).name || ''))) return;
    var e = emps.filter(function (x) { return String(x.id) === String(a.employee_id); })[0];
    if (!e) return;
    holders.push({ e: e, a: a, kra: kra, kpi: kpis[a.kpi_id] || {} });
  });
  if (!holders.length) return logBack_('Nobody holds a DSO KRA at all.');

  var plans = read_(T.PLAN), perf = read_(T.PERF), tgts = read_(T.TARGETS);
  function find(rows, emp, kpi, per) {
    return rows.filter(function (r) {
      return String(r.employee_id) === String(emp) &&
             String(r.kpi_id) === String(kpi) &&
             String(r.period_id) === String(per); })[0] || null;
  }

  var live = [], silent = [];
  holders.forEach(function (H) {
    var lines = [];
    periods.forEach(function (p) {
      var pl = find(plans, H.e.id, H.a.kpi_id, p.id);
      var pf = find(perf, H.e.id, H.a.kpi_id, p.id);
      var tv = pl ? num_(pl.target_value) : null;
      var av = pf ? num_(pf.actual) : null;
      if (tv === null && av === null) return;
      lines.push('    ' + String(p.id).replace('per_', '') +
        '  [' + (p.status || '?') + ']' +
        '   target=' + (tv === null ? '-' : tv) +
        '   achieved=' + (av === null ? '-' : av) +
        (pf && pf.note ? '   note=' + pf.note : ''));
    });
    if (lines.length) live.push({ H: H, lines: lines }); else silent.push(H);
  });

  var cur = periodOr_('');
  [cur, PERIOD_YTD].forEach(function (per) {
    out.push('');
    out.push('=== WHAT THE MODEL PRODUCES FOR ' + per + ' ===');
    var m;
    try { m = buildModel_(per); }
    catch (e) { out.push('  buildModel_ threw: ' + (e && e.message || e)); return; }
    holders.forEach(function (H) {
      var row = (m.rows || []).filter(function (r) {
        return String(r.employee_id) === String(H.e.id) &&
               String(r.kpi_id) === String(H.a.kpi_id); })[0];
      if (!row) {
        out.push('  ' + H.e.name + '   NO ROW IN THE MODEL' +
          '   (the assignment is missing, inactive, or the person is a leaver)');
        return;
      }
      out.push('  ' + H.e.name +
        '   target=' + (row.plan_target === null ? '-' : row.plan_target) +
        '   achieved=' + (row.actual === null || row.actual === undefined ? '-' : row.actual) +
        '   level=' + (row.level === null ? '-' : row.level) +
        '   agg=' + (row.agg_kind || '-') + '/' + (row.plan_agg || '-') +
        '   months=' + (row.actual_months === null ? '-' : row.actual_months));
    });
  });

  out.push('');
  out.push('=== WHAT IS STORED (only months carrying something) ===');
  live.forEach(function (L) {
    out.push('');
    out.push(L.H.e.name + '   [' + ((teamById[L.H.e.team_id] || {}).name || '?') + ']' +
      '   KRA ' + L.H.kra.name);
    L.lines.forEach(function (x) { out.push(x); });
  });
  if (silent.length) {
    out.push('');
    out.push('  NOTHING STORED IN ANY MONTH (' + silent.length + '):');
    silent.forEach(function (H) {
      out.push('    ' + H.e.name + '  [' +
        ((teamById[H.e.team_id] || {}).name || '?') + ']  ' + H.kra.name);
    });
  }
  out.push('');
  out.push('How to read this:');
  out.push('  stored achieved=<n> and model achieved=<n>  -> it IS on the dashboard;');
  out.push('                                                check which month is selected');
  out.push('  stored achieved=<n> and model achieved=-    -> the model is dropping it');
  out.push('  stored achieved=-                           -> the import never wrote it');
  out.push('  NO ROW IN THE MODEL                         -> the assignment is the problem,');
  out.push('                                                not the achievement');
  return logBack_(out.join(nl));
}
function logBack_(txt) { Logger.log(txt); return txt; }
function whoAmI() {
  var email = currentEmail_(), out = [];
  out.push('Session email : "' + email + '"');
  out.push('Backend DB    : ' + ss_().getUrl());
  var boot = bootstrapAdmins_();
  out.push('PERFORMOS_ADMINS property: ' + (boot.length ? boot.join(', ') : '(not set)') +
           (email && boot.indexOf(email) >= 0 ? '   <== YOU ARE LISTED' : ''));
  var oa = openAccessState_();
  out.push('PERFORMOS_OPEN_ACCESS      : ' + (oa.raw || '(not set)') +
    (oa.on ? '   <== ON — EVERY VISITOR IS super_admin'
           : oa.bad ? '   (unparseable, treated as OFF)'
           : oa.expired ? '   (expired, now OFF)' : '   (off)'));
  out.push('');
  out.push('USERS tab, as the server reads it:');
  read_(T.USERS).forEach(function (u, i) {
    var raw = String(u.email == null ? '' : u.email);
    out.push('  row ' + (i + 2) + '  id=' + u.id +
             '  role_id="' + u.role_id + '"' +
             '  email="' + raw + '" (len ' + raw.length + ', normalised "' + email_(raw) + '")' +
             (email && email_(raw) === email ? '   <== MATCHES YOU' : ''));
  });
  out.push('');
  out.push('EMPLOYEES rows carrying an address:');
  var any = false;
  read_(T.EMPLOYEES).forEach(function (e) {
    if (!String(e.email == null ? '' : e.email).trim()) return;
    any = true;
    out.push('  ' + e.name + '  email="' + e.email + '"' +
             (email && email_(e.email) === email ? '   <== MATCHES YOU' : ''));
  });
  if (!any) out.push('  (none — every employee row still has a blank email)');
  out.push('');
  var s = resolveSession_();
  out.push('RESOLVED role : ' + s.role_id + '    can view: ' + can_(s, 'view'));
  commit_();
  var txt = out.join(String.fromCharCode(10));
  Logger.log(txt);
  return txt;
}

function apiSaveTargets(p) {
  try {
    p = p || {};
    var s = resolveSession_(p.view_as);
    p.period_id = requireRealPeriod_(periodOr_(p.period_id));
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
    recomputeOne_(p.employee_id, p.kpi_id, p.period_id, s.name);
    audit_(s.name, 'target', id, 'edit_bands', old,
      { t1: bands[0], t2: bands[1], t3: bands[2], t4: bands[3], t5: bands[4] },
      'kind=' + parsed.kind + ' direction=' + parsed.direction);
    var _m = buildModel_(p.period_id); commit_();
    return jsonSafe_({ ok: true, parsed: parsed, model: scopeModel_(_m, s) });
  } catch (e) { return { ok: false, error: String(e && e.message || e), where: 'apiSaveTargets' }; }
}

function apiSaveAssignment(p) {
  try {
    p = p || {};
    var s = resolveSession_(p.view_as);
    p.period_id = requireRealPeriod_(periodOr_(p.period_id));
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
    if (!prev) {
      var tid = 'tgt_' + p.employee_id + '_' + kpiId + '_' + p.period_id;
      if (!read_(T.TARGETS).filter(function (t) { return String(t.id) === tid; }).length) {
        upsert_(T.TARGETS, { id: tid, employee_id: p.employee_id, kpi_id: kpiId, period_id: p.period_id,
          t1: '', t2: '', t3: '', t4: '', t5: '', version: 1, updated_by: s.name, updated_at: nowIso_() });
      }
    }
    audit_(s.name, 'assignment', id, prev ? 'edit' : 'create', old,
      { kra: p.kra_name, kpi: p.kpi_name, weightage: wt });
    var _m = buildModel_(p.period_id); commit_();
    return jsonSafe_({ ok: true, model: scopeModel_(_m, s) });
  } catch (e) { return { ok: false, error: String(e && e.message || e), where: 'apiSaveAssignment' }; }
}

function apiRemoveAssignment(p) {
  try {
    p = p || {};
    var s = resolveSession_(p.view_as);
    p.period_id = requireRealPeriod_(periodOr_(p.period_id));
    requirePerm_(s, 'edit_framework', 'edit the KRA/KPI framework');
    requireScope_(s, p.employee_id, 'edit this person’s KRA/KPI');
    var a = read_(T.ASSIGN).filter(function (x) { return String(x.id) === String(p.assignment_id); })[0];
    if (!a) throw new Error('That assignment no longer exists.');
    a.status = 'Inactive'; a.updated_by = s.name; a.updated_at = nowIso_();
    upsert_(T.ASSIGN, a);
    audit_(s.name, 'assignment', a.id, 'remove', { kpi: a.kpi_id, weightage: a.weightage }, null, p.reason || '');
    var _m = buildModel_(p.period_id); commit_();
    return jsonSafe_({ ok: true, model: scopeModel_(_m, s) });
  } catch (e) { return { ok: false, error: String(e && e.message || e), where: 'apiRemoveAssignment' }; }
}

// ===== CUSTOMER DETAIL =====
function apiCustomerDetail(p) {
  try {
    p = p || {};
    var s = resolveSession_(p.view_as);
    if (!can_(s, 'view')) {
      return { ok: false, error: 'This dashboard is not open to ' + s.email + '.' };
    }
    requireScope_(s, p.employee_id, 'see this customer detail');
    var emp = read_(T.EMPLOYEES).filter(function (e) {
      return String(e.id) === String(p.employee_id); })[0];
    if (!emp) return { ok: false, error: 'No such person.' };

    var periodId = String(p.period_id || '');
    var want = {};
    if (periodId === PERIOD_YTD) {
      read_(T.PERIODS).forEach(function (x) {
        if (String(x.status) !== 'upcoming') want[String(x.id)] = 1; });
    } else if (periodId) { want[periodId] = 1; }

    var src;
    try { src = SpreadsheetApp.openById(SHIPMENTS_SHEET_ID); }
    catch (e) { return { ok: false, error: 'Cannot open MM_CT (' + (e && e.message || e) + ')' }; }
    var shipSh = findSheet_(src, SHIPMENTS_TAB);
    if (!shipSh) return { ok: false, error: 'No ' + SHIPMENTS_TAB + ' tab.' };
    var lastR = shipSh.getLastRow(), lastC = shipSh.getLastColumn();
    if (lastR < 2) return { ok: true, rows: [], why: SHIPMENTS_TAB + ' is empty.' };
    var g = shipSh.getRange(1, 1, lastR, lastC).getValues();
    var ix = headerIndex_(g[0]);

    var cTax = letterCol_(DSO_COLS_.taxable) - 1;
    var cPaid = letterCol_(DSO_COLS_.collected) - 1;
    var cDN = letterCol_(DSO_COLS_.debitNote) - 1;
    function col(name) { return (name in ix) ? ix[name] : -1; }
    var cSN = col('seller_name'), cSC = col('seller_category');
    var cBN = col('buyer_name'), cBC = col('buyer_category');
    var cDate = col('shipment_created_date'), cStat = col('shipment_status');
    var cQty = col('dispatched_quantity');
    if (cDate < 0 || (cSN < 0 && cBN < 0)) {
      return { ok: true, rows: [], why: 'Raw_Shipments has no usable name or date column.' };
    }

    var pocSh = findSheet_(src, POC_TAB);
    var sellSh = findSheet_(src, 'Raw_Sellers'), buySh = findSheet_(src, 'Raw_Buyers');
    var poc = pocSh ? readPocMap_(pocSh) : { sellerPoc: {}, buyerPoc: {} };
    var accS = sellSh ? readAccountPoc_(sellSh) : { map: {} };
    var accB = buySh ? readAccountPoc_(buySh) : { map: {} };
    var sellerMaps = [poc.sellerPoc, accS.map], buyerMaps = [poc.buyerPoc, accB.map];
    var emps = read_(T.EMPLOYEES), empByName = {}, teamById = idx_(read_(T.TEAMS));
    emps.forEach(function (e) { empByName[normName_(e.name)] = e; });

    function mine(maps, name, cat) {
      var cell = pocForChain_(maps, String(name || ''), cat);
      if (!cell) return false;
      var r = resolvePocEmployee_(cell, cat, empByName, teamById);
      return !!(r.emp && String(r.emp.id) === String(emp.id));
    }

    var byCust = {}, months = {}, skipped = 0;
    for (var r2 = 1; r2 < lastR; r2++) {
      var row = g[r2];
      if (cStat >= 0) {
        var stx = String(row[cStat] || '').trim().toLowerCase(), bad = false;
        for (var i = 0; i < SHIPMENTS_EXCLUDE_STATUS.length; i++) {
          if (stx === String(SHIPMENTS_EXCLUDE_STATUS[i]).toLowerCase()) bad = true;
        }
        if (bad) continue;
      }
      var pid = periodIdFromDate_(row[cDate]);
      if (!pid) { skipped++; continue; }
      if (Object.keys(want).length && !want[pid]) continue;

      var sideName = '', side = '', cat = '';
      if (cSN >= 0 && mine(sellerMaps, row[cSN], cSC >= 0 ? row[cSC] : '')) {
        sideName = String(row[cSN] || ''); side = 'seller';
        cat = cSC >= 0 ? String(row[cSC] || '') : '';
      } else if (cBN >= 0 && mine(buyerMaps, row[cBN], cBC >= 0 ? row[cBC] : '')) {
        sideName = String(row[cBN] || ''); side = 'buyer';
        cat = cBC >= 0 ? String(row[cBC] || '') : '';
      } else { continue; }

      var ap = num_(row[cTax]) || 0, aq = num_(row[cPaid]) || 0, au = num_(row[cDN]) || 0;
      var withTax = ap * DSO_GST_;
      var k = side + '|' + normName_(sideName);
      var c2 = byCust[k] || (byCust[k] = { customer: sideName, side: side, category: cat,
        ships: 0, value: 0, paid: 0, dn: 0, receivable: 0, qty: 0, months: {} });
      c2.ships++;
      c2.value += withTax - au;
      c2.paid += aq;
      c2.dn += au;
      c2.receivable += Math.max(0, withTax - aq - au);
      if (cQty >= 0) c2.qty += num_(row[cQty]) || 0;
      c2.months[pid] = 1;
      months[pid] = 1;
    }

    var rows = Object.keys(byCust).map(function (k) {
      var c3 = byCust[k];
      c3.months = Object.keys(c3.months).sort().map(function (x) {
        return String(x).replace('per_', ''); });
      ['value', 'paid', 'dn', 'receivable', 'qty'].forEach(function (f) {
        c3[f] = Math.round(c3[f] * 100) / 100; });
      return c3;
    }).sort(function (a, b) { return b.value - a.value; });

    var tot = { ships: 0, value: 0, paid: 0, dn: 0, receivable: 0 };
    rows.forEach(function (c4) {
      tot.ships += c4.ships; tot.value += c4.value; tot.paid += c4.paid;
      tot.dn += c4.dn; tot.receivable += c4.receivable;
    });
    Object.keys(tot).forEach(function (f) {
      tot[f] = Math.round(tot[f] * 100) / 100; });

    commit_();
    return jsonSafe_({ ok: true, name: emp.name, rows: rows, totals: tot,
      months: Object.keys(months).sort().map(function (x) {
        return String(x).replace('per_', ''); }),
      why: rows.length ? '' : 'No shipments in MM_CT name ' + emp.name +
        ' as the POC for this period. Collections, Onboarding and Control Tower ' +
        'KRAs have no shipment-level source at all.' });
  } catch (e) {
    return { ok: false, error: String(e && e.message || e), where: 'apiCustomerDetail' };
  }
}
function apiSaveActual(p) {
  try {
    p = p || {};
    var s = resolveSession_(p.view_as);
    p.period_id = requireRealPeriod_(periodOr_(p.period_id));
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
    var _m = buildModel_(p.period_id); commit_();
    return jsonSafe_({ ok: true, level: res.level, model: scopeModel_(_m, s) });
  } catch (e) { return { ok: false, error: String(e && e.message || e), where: 'apiSaveActual' }; }
}

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

function apiRecomputeAll(p) {
  try {
    p = p || {};
    var s = resolveSession_(p.view_as);
    p.period_id = requireRealPeriod_(periodOr_(p.period_id));
    requirePerm_(s, 'admin', 'recompute the period');
    var n = 0;
    read_(T.PERF).forEach(function (r) {
      if (String(r.period_id) !== String(p.period_id)) return;
      recomputeOne_(r.employee_id, r.kpi_id, r.period_id, s.name); n++;
    });
    audit_(s.name, 'period', p.period_id, 'recompute_all', null, { rows: n });
    var _m = buildModel_(p.period_id); commit_();
    return jsonSafe_({ ok: true, rows: n, model: scopeModel_(_m, s) });
  } catch (e) { return { ok: false, error: String(e && e.message || e), where: 'apiRecomputeAll' }; }
}

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

// ===== FRAMEWORK IMPORT =====
function apiImportFromSource(p) {
  try {
    p = p || {};
    var s = resolveSession_(p.view_as);
    p.period_id = requireRealPeriod_(periodOr_(p.period_id));
    requirePerm_(s, 'edit_framework', 'import the framework');
    var res = importFromSource_(p.sheet_id || SOURCE_SHEET_ID, p.period_id, s.name, !!p.replace);
    audit_(s.name, 'system', 'import', 'import_source', null, res);
    var _m = buildModel_(p.period_id); commit_();
    return jsonSafe_({ ok: true, result: res, model: scopeModel_(_m, s) });
  } catch (e) { return { ok: false, error: String(e && e.message || e), where: 'apiImportFromSource' }; }
}

function importFromSource_(sheetId, periodId, actor, replace) {
  periodId = periodOr_(periodId);
  var src;
  try { src = SpreadsheetApp.openById(sheetId); }
  catch (e) {
    throw new Error('Cannot open the source workbook ' + sheetId +
      '. Share it with the account running this script, then try again. (' + (e && e.message || e) + ')');
  }
  var blocks = [];
  src.getSheets().forEach(function (sh) {
    var name = sh.getName();
    if (name.indexOf('_KKT_') === 0) return;
    var last = sh.getLastRow(), lastC = Math.max(sh.getLastColumn(), 12);
    if (last < 2) return;
    var grid = sh.getRange(1, 1, last, lastC).getValues();
    blocks = blocks.concat(blocksFromGrid_(grid, name));
  });
  var people = blocks.filter(function (b) { return b.isPerson; });
  if (!people.length) throw new Error('No individual KRA/KPI blocks were found in that workbook.');

  if (replace) {
    var inImport = {};
    people.forEach(function (b) { inImport[slug_(b.name)] = true; });
    var empSlug = {};
    read_(T.EMPLOYEES).forEach(function (e) { empSlug[e.id] = slug_(e.name); });
    write_(T.ASSIGN, read_(T.ASSIGN).filter(function (a) {
      return !inImport[empSlug[a.employee_id]];
    }));
    write_(T.TARGETS, read_(T.TARGETS).filter(function (t) {
      var samePeriod = String(t.period_id) === String(periodId);
      var mine = !!inImport[empSlug[t.employee_id]];
      return !(samePeriod && mine);
    }));
  }

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
        if (isHeader(rr + 1)) break;
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

// ===== SEED =====
// ===== FIND THE BACKEND =====
function findBackends() {
  var nl = String.fromCharCode(10), out = [];
  var props = PropertiesService.getScriptProperties();
  var current = props.getProperty(PROP_DB) || '(not set)';

  out.push('PERFORMOS_DB_ID is currently: ' + current);
  out.push('');

  var seen = {}, cands = [];
  ['PerformOS — Backend', 'Performance Tracker — Backend', 'Backend'].forEach(function (nm) {
    var it;
    try { it = DriveApp.getFilesByName(nm); } catch (e) { return; }
    while (it.hasNext()) {
      var f = it.next();
      if (seen[f.getId()]) continue;
      seen[f.getId()] = true;
      cands.push(f);
    }
  });
  if (current !== '(not set)' && !seen[current]) {
    try { cands.push(DriveApp.getFileById(current)); seen[current] = true; } catch (e) {
      out.push('!! the id in PERFORMOS_DB_ID cannot even be opened as a Drive file:');
      out.push('   ' + current);
      out.push('   ' + (e && e.message || e));
      out.push('');
    }
  }

  if (!cands.length) {
    out.push('No candidate spreadsheets found in this account.');
    var none = out.join(nl); Logger.log(none); return none;
  }

  out.push('=== EVERY CANDIDATE, AND WHAT IS ACTUALLY IN IT ===');
  out.push('');
  out.push('  ' + pad_('employees', 11) + pad_('assign', 9) + pad_('perf', 8) +
    pad_('modified', 20) + 'name / id');
  out.push('');

  var best = null;
  cands.forEach(function (f) {
    var id = f.getId(), name = f.getName(), when = '';
    try { when = Utilities.formatDate(f.getLastUpdated(), Session.getScriptTimeZone(),
                                      'yyyy-MM-dd HH:mm'); } catch (e) { when = '?'; }
    var emp = '-', asg = '-', prf = '-', note = '';
    try {
      var ss = SpreadsheetApp.openById(id);
      function count(tab) {
        var sh = ss.getSheetByName(tab);
        if (!sh) return '(no tab)';
        return Math.max(0, sh.getLastRow() - 1);
      }
      emp = count('EMPLOYEES'); asg = count('ASSIGNMENTS'); prf = count('PERFORMANCE');
      if (typeof emp === 'number' && (best === null || emp > best.emp)) {
        best = { id: id, name: name, emp: emp, asg: asg, prf: prf };
      }
    } catch (e) {
      note = '   << CANNOT OPEN: ' + (e && e.message || e);
    }
    out.push('  ' + pad_(String(emp), 11) + pad_(String(asg), 9) + pad_(String(prf), 8) +
      pad_(when, 20) + name + (id === current ? '   <== CURRENT' : ''));
    out.push('  ' + pad_('', 48) + id + note);
    out.push('');
  });

  if (best && best.emp > 0) {
    out.push('=== THE ONE WITH DATA IN IT ===');
    out.push('  ' + best.name);
    out.push('  ' + best.id);
    out.push('  ' + best.emp + ' employees, ' + best.asg + ' assignments, ' +
      best.prf + ' performance rows');
    out.push('');
    if (best.id === current) {
      out.push('  That is already what PERFORMOS_DB_ID points at. If the dashboard');
      out.push('  is still empty the fault is not the pointer.');
    } else {
      out.push('  Set PERFORMOS_DB_ID to that id — Project Settings > Script');
      out.push('  Properties — then run whoAmI() to confirm before reloading.');
    }
  } else {
    out.push('No candidate has any employees in it. The framework can be rebuilt');
    out.push('with refreshFrameworkFromSource() followed by importTargets().');
  }
  var txt = out.join(nl);
  Logger.log(txt);
  return txt;
}

// ===== REPOINT THE BACKEND =====
function repointToBackendWithData() {
  var nl = String.fromCharCode(10), out = [];
  var props = PropertiesService.getScriptProperties();
  var before = props.getProperty(PROP_DB) || '(not set)';
  out.push('before: ' + before);

  var seen = {}, best = null, looked = 0;
  ['PerformOS — Backend', 'Performance Tracker — Backend', 'Backend'].forEach(function (nm) {
    var it;
    try { it = DriveApp.getFilesByName(nm); } catch (e) { return; }
    while (it.hasNext()) {
      var f = it.next(), id = f.getId();
      if (seen[id]) continue;
      seen[id] = true; looked++;
      try {
        var ss = SpreadsheetApp.openById(id);
        var sh = ss.getSheetByName('EMPLOYEES');
        var emp = sh ? Math.max(0, sh.getLastRow() - 1) : 0;
        var ash = ss.getSheetByName('ASSIGNMENTS');
        var asg = ash ? Math.max(0, ash.getLastRow() - 1) : 0;
        var psh = ss.getSheetByName('PERFORMANCE');
        var prf = psh ? Math.max(0, psh.getLastRow() - 1) : 0;
        if (emp > 0 && (best === null || emp > best.emp ||
                        (emp === best.emp && prf > best.prf))) {
          best = { id: id, name: f.getName(), emp: emp, asg: asg, prf: prf };
        }
      } catch (e) {   }
    }
  });

  out.push('looked at ' + looked + ' candidate spreadsheet(s)');
  if (!best) {
    out.push('');
    out.push('NOTHING CHANGED. No candidate has a single employee in it.');
    out.push('Rebuild instead: refreshFrameworkFromSource() then importTargets().');
    var none = out.join(nl); Logger.log(none); return none;
  }

  out.push('');
  out.push('chosen: ' + best.name);
  out.push('        ' + best.id);
  out.push('        ' + best.emp + ' employees, ' + best.asg + ' assignments, ' +
    best.prf + ' performance rows');

  if (best.id === before) {
    out.push('');
    out.push('That is ALREADY what the property says. Nothing written.');
    out.push('If the dashboard is still empty, the pointer is not the fault.');
    var same = out.join(nl); Logger.log(same); return same;
  }

  props.setProperty(PROP_DB, best.id);
  _SS = null;

  var check = '';
  try {
    var ss2 = SpreadsheetApp.openById(props.getProperty(PROP_DB));
    var e2 = ss2.getSheetByName('EMPLOYEES');
    check = 'reopened it: ' + (e2 ? Math.max(0, e2.getLastRow() - 1) : 0) + ' employees';
  } catch (e) {
    check = '!! WROTE THE PROPERTY BUT CANNOT REOPEN IT: ' + (e && e.message || e);
  }
  out.push('');
  out.push('after : ' + props.getProperty(PROP_DB));
  out.push(check);
  out.push('');
  out.push('Now run whoAmI() to confirm, then reload the dashboard.');
  var txt = out.join(nl);
  Logger.log(txt);
  return txt;
}

// Seeding fills the cache and stamps PERFORMOS_SEEDED; only commit_() writes the rows.
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
  var already = read_(T.EMPLOYEES).length;
  if (already > 0 &&
      PropertiesService.getScriptProperties().getProperty('PERFORMOS_SEEDED') === '3') {
    throw new Error('Refusing to seed: the backend already holds ' + already +
      ' employees. Seeding empties every table. If you really mean to reset ' +
      'it, run provisionAndSeed().');
  }
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
    { id: 'u_admin', name: 'Platform Admin', email: 'srinivasareddy.dundi@recykal.com',
      role_id: 'super_admin', employee_id: '' },
    { id: 'u_hr', name: 'HR / Admin', email: '', role_id: 'hr_admin', employee_id: '' },
    { id: 'u_lead_col', name: 'Ravi Naik (Collections lead)', email: '', role_id: 'team_leader', employee_id: find(/^RAVI NAIK$/i) },
    { id: 'u_lead_met', name: 'Amit Jha (Metal lead)', email: '', role_id: 'team_leader', employee_id: find(/^AMIT JHA$/i) },
    { id: 'u_emp', name: 'Vishwash (Onboarding)', email: '', role_id: 'employee', employee_id: find(/^VISHWASH$/i) },
    { id: 'u_audit', name: 'Auditor', email: '', role_id: 'auditor', employee_id: '' }
  ]);
  PropertiesService.getScriptProperties().setProperty('PERFORMOS_SEEDED', '3');
  return true;
}

// ===== SELF TEST =====
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
  var empIds = {};
  m.employees.forEach(function (e) { empIds[String(e.id)] = true; });
  var orphans = m.rows.filter(function (r) { return !empIds[String(r.employee_id)]; });
  out.push('INFO  people=' + m.employees.length +
    '  assignment rows=' + m.rows.length);
  var gone = read_(T.EMPLOYEES).filter(function (e) { return isLeaver_(e.name); });
  if (gone.length) {
    out.push('INFO  ' + gone.length + ' leaver(s) hidden from the model: ' +
      gone.map(function (e) { return e.name; }).join(', '));
  }
  ck('at least one person', m.employees.length > 0, true);
  ck('at least one scorecard row', m.rows.length > 0, true);
  ck('no row belongs to an unknown person',
     orphans.length ? orphans.length + ': ' + orphans[0].employee_id : 0, 0);
  ck('every leaver is excluded from the model',
     m.employees.filter(function (e) { return isLeaver_(e.name); }).length, 0);
  out.push('INFO  KRAs=' + m.kras.length + '  KPIs=' + m.kpis.length + '  period=' + m.period_id);

  var bad = [];
  Object.keys(m.overalls).forEach(function (id) {
    var w = m.overalls[id].assigned_weightage;
    if (Math.abs(w - 100) > 0.5) bad.push(id + '=' + w);
  });
  ck('weightage totals 100 for every one of ' + m.employees.length,
     bad.length ? bad.join(',') : 0, 0);

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
// The KRA/KPI framework as exported on 2026-08-20. Used only to seed an empty database.
var SRC_SEED = {
  "source_sheet_id": "1c0_pP4Mmye5s5D_vzoxrvJ-utkLb6JhD69TvvOBbjoo",
  "exported": "2026-08-20",
  "people": [
    {"team": "Metal", "group": "", "sheet": "Metal (Supply & Demand KRAKPI)", "name": "AMIT JHA",
     "designation": "Team Lead - Business Development", "extra": "", "kpis": [
      ["Process", "Retention of Existing Transacted Sellers", "Repeat Seller Transaction Rate (%)",
       "Achieve repeat transactions from at least 50% of sellers who transacted in the previous month.",
       "5.0", "Monthly MIS Report", "0.6", "0.75", "0.9", "1.0", "1.05"],
      ["Customer", "New Buyer Acquisition", "Monthly Target Achievement (%)",
       "Achieve the defined monthly target for the KPI.", "15.0", "Monthly MIS Report",
       "0.6", "0.75", "0.9", "1.0", "1.05"],
      ["Customer", "New Seller Acquisition", "Monthly Target Achievement (%)",
       "Achieve the defined monthly target for the KPI.", "15.0", "Monthly MIS Report",
       "0.6", "0.75", "0.9", "1.0", "1.05"],
      ["Process", "Transaction from New Onboarded Buyers", "New Buyer Same-Month Transaction Rate (%)",
       "Ensure at least 20% of buyers onboarded during the month complete a transaction within the same " +
         "month.", "5.0", "Monthly MIS Report", "0.6", "0.75", "0.9", "1.0", "1.05"],
      ["Sales", "GMV", "Monthly Target Achievement (%)", "Achieve the defined monthly target for the KPI.",
       "40.0", "Monthly MIS Report", "0.6", "0.75", "0.9", "1.0", "1.05"],
      ["Sales", "Transaction Closure", "Successfully Closed Transactions (Count)",
       "Successfully close the targeted number of transactions through completion of POD, DNCN, and " +
         "payment upload requirements.", "10.0", "Monthly MIS Report", "0.6", "0.75", "0.9", "1.0", "1.05"],
      ["Process", "DSO Days", "Days Sales Outstanding (DSO)",
       "Maintain DSO within the defined monthly target, calculated as (Average Receivables ÷ GMV) × Number " +
         "of Days in the Month.", "10.0", "Monthly MIS Report", "15.0", "10.0", "5.0", "3.0", "2.0"]
    ]},
    {"team": "Metal", "group": "", "sheet": "Metal (Supply & Demand KRAKPI)", "name": "ABHISEK SANYAL",
     "designation": "Assistant Manager - Business Development", "extra": "", "kpis": [
      ["Process", "Retention of Existing Transacted Sellers", "Repeat Seller Transaction Rate (%)",
       "Achieve repeat transactions from at least 50% of sellers who transacted in the previous month.",
       "5.0", "Monthly MIS Report", "0.6", "0.75", "0.9", "1.0", "1.05"],
      ["Customer", "New Buyer Acquisition", "Monthly Target Achievement (%)",
       "Achieve the defined monthly target for the KPI.", "15.0", "Monthly MIS Report",
       "0.6", "0.75", "0.9", "1.0", "1.05"],
      ["Customer", "New Seller Acquisition", "Monthly Target Achievement (%)",
       "Achieve the defined monthly target for the KPI.", "15.0", "Monthly MIS Report",
       "0.6", "0.75", "0.9", "1.0", "1.05"],
      ["Process", "Transaction from New Onboarded Buyers", "New Buyer Same-Month Transaction Rate (%)",
       "Ensure at least 20% of buyers onboarded during the month complete a transaction within the same " +
         "month.", "5.0", "Monthly MIS Report", "0.6", "0.75", "0.9", "1.0", "1.05"],
      ["Sales", "GMV", "Monthly Target Achievement (%)", "Achieve the defined monthly target for the KPI.",
       "40.0", "Monthly MIS Report", "0.6", "0.75", "0.9", "1.0", "1.05"],
      ["Sales", "Transaction Closure", "Successfully Closed Transactions (Count)",
       "Successfully close the targeted number of transactions through completion of POD, DNCN, and " +
         "payment upload requirements.", "10.0", "Monthly MIS Report", "0.6", "0.75", "0.9", "1.0", "1.05"],
      ["Process", "DSO Days", "Days Sales Outstanding (DSO)",
       "Maintain DSO within the defined monthly target, calculated as (Average Receivables ÷ GMV) × Number " +
         "of Days in the Month.", "10.0", "Monthly MIS Report", "15.0", "10.0", "5.0", "3.0", "2.0"]
    ]},
    {"team": "Metal", "group": "", "sheet": "Metal (Supply & Demand KRAKPI)", "name": "ADARSH KRISHNA",
     "designation": "Assistant Manager - Business Development", "extra": "", "kpis": [
      ["Process", "Retention of Existing Transacted Sellers", "Repeat Seller Transaction Rate (%)",
       "Achieve repeat transactions from at least 50% of sellers who transacted in the previous month.",
       "5.0", "Monthly MIS Report", "0.6", "0.75", "0.9", "1.0", "1.05"],
      ["Customer", "New Buyer Acquisition", "Monthly Target Achievement (%)",
       "Achieve the defined monthly target for the KPI.", "15.0", "Monthly MIS Report",
       "0.6", "0.75", "0.9", "1.0", "1.05"],
      ["Customer", "New Seller Acquisition", "Monthly Target Achievement (%)",
       "Achieve the defined monthly target for the KPI.", "15.0", "Monthly MIS Report",
       "0.6", "0.75", "0.9", "1.0", "1.05"],
      ["Process", "Transaction from New Onboarded Buyers", "New Buyer Same-Month Transaction Rate (%)",
       "Ensure at least 20% of buyers onboarded during the month complete a transaction within the same " +
         "month.", "5.0", "Monthly MIS Report", "0.6", "0.75", "0.9", "1.0", "1.05"],
      ["Sales", "GMV", "Monthly Target Achievement (%)", "Achieve the defined monthly target for the KPI.",
       "40.0", "Monthly MIS Report", "0.6", "0.75", "0.9", "1.0", "1.05"],
      ["Sales", "Transaction Closure", "Successfully Closed Transactions (Count)",
       "Successfully close the targeted number of transactions through completion of POD, DNCN, and " +
         "payment upload requirements.", "10.0", "Monthly MIS Report", "0.6", "0.75", "0.9", "1.0", "1.05"],
      ["Process", "DSO Days", "Days Sales Outstanding (DSO)",
       "Maintain DSO within the defined monthly target, calculated as (Average Receivables ÷ GMV) × Number " +
         "of Days in the Month.", "10.0", "Monthly MIS Report", "15.0", "10.0", "5.0", "3.0", "2.0"]
    ]},
    {"team": "Metal", "group": "", "sheet": "Metal (Supply & Demand KRAKPI)", "name": "ARIJIT DUTTA",
     "designation": "Senior Executive - Business Development", "extra": "", "kpis": [
      ["Process", "Retention of Existing Transacted Sellers", "Repeat Seller Transaction Rate (%)",
       "Achieve repeat transactions from at least 50% of sellers who transacted in the previous month.",
       "5.0", "Monthly MIS Report", "0.6", "0.75", "0.9", "1.0", "1.05"],
      ["Customer", "New Buyer Acquisition", "Monthly Target Achievement (%)",
       "Achieve the defined monthly target for the KPI.", "15.0", "Monthly MIS Report",
       "0.6", "0.75", "0.9", "1.0", "1.05"],
      ["Customer", "New Seller Acquisition", "Monthly Target Achievement (%)",
       "Achieve the defined monthly target for the KPI.", "15.0", "Monthly MIS Report",
       "0.6", "0.75", "0.9", "1.0", "1.05"],
      ["Process", "Transaction from New Onboarded Buyers", "New Buyer Same-Month Transaction Rate (%)",
       "Ensure at least 20% of buyers onboarded during the month complete a transaction within the same " +
         "month.", "5.0", "Monthly MIS Report", "0.6", "0.75", "0.9", "1.0", "1.05"],
      ["Sales", "GMV", "Monthly Target Achievement (%)", "Achieve the defined monthly target for the KPI.",
       "40.0", "Monthly MIS Report", "0.6", "0.75", "0.9", "1.0", "1.05"],
      ["Sales", "Transaction Closure", "Successfully Closed Transactions (Count)",
       "Successfully close the targeted number of transactions through completion of POD, DNCN, and " +
         "payment upload requirements.", "10.0", "Monthly MIS Report", "0.6", "0.75", "0.9", "1.0", "1.05"],
      ["Process", "DSO Days", "Days Sales Outstanding (DSO)",
       "Maintain DSO within the defined monthly target, calculated as (Average Receivables ÷ GMV) × Number " +
         "of Days in the Month.", "10.0", "Monthly MIS Report", "15.0", "10.0", "5.0", "3.0", "2.0"]
    ]},
    {"team": "Metal", "group": "", "sheet": "Metal (Supply & Demand KRAKPI)", "name": "ARGHYADEEP SAMANTA",
     "designation": "Senior Executive - Business Development", "extra": "", "kpis": [
      ["Process", "Retention of Existing Transacted Sellers", "Repeat Seller Transaction Rate (%)",
       "Achieve repeat transactions from at least 50% of sellers who transacted in the previous month.",
       "5.0", "Monthly MIS Report", "0.6", "0.75", "0.9", "1.0", "1.05"],
      ["Customer", "New Buyer Acquisition", "Monthly Target Achievement (%)",
       "Achieve the defined monthly target for the KPI.", "15.0", "Monthly MIS Report",
       "0.6", "0.75", "0.9", "1.0", "1.05"],
      ["Customer", "New Seller Acquisition", "Monthly Target Achievement (%)",
       "Achieve the defined monthly target for the KPI.", "15.0", "Monthly MIS Report",
       "0.6", "0.75", "0.9", "1.0", "1.05"],
      ["Process", "Transaction from New Onboarded Buyers", "New Buyer Same-Month Transaction Rate (%)",
       "Ensure at least 20% of buyers onboarded during the month complete a transaction within the same " +
         "month.", "5.0", "Monthly MIS Report", "0.6", "0.75", "0.9", "1.0", "1.05"],
      ["Sales", "GMV", "Monthly Target Achievement (%)", "Achieve the defined monthly target for the KPI.",
       "40.0", "Monthly MIS Report", "0.6", "0.75", "0.9", "1.0", "1.05"],
      ["Sales", "Transaction Closure", "Successfully Closed Transactions (Count)",
       "Successfully close the targeted number of transactions through completion of POD, DNCN, and " +
         "payment upload requirements.", "10.0", "Monthly MIS Report", "0.6", "0.75", "0.9", "1.0", "1.05"],
      ["Process", "DSO Days", "Days Sales Outstanding (DSO)",
       "Maintain DSO within the defined monthly target, calculated as (Average Receivables ÷ GMV) × Number " +
         "of Days in the Month.", "10.0", "Monthly MIS Report", "15.0", "10.0", "5.0", "3.0", "2.0"]
    ]},
    {"team": "Metal", "group": "", "sheet": "Metal (Supply & Demand KRAKPI)", "name": "AYUSH GOYAL",
     "designation": "Assistant Manager - Business Development", "extra": "", "kpis": [
      ["Process", "Retention of Existing Transacted Sellers", "Repeat Seller Transaction Rate (%)",
       "Achieve repeat transactions from at least 50% of sellers who transacted in the previous month.",
       "5.0", "Monthly MIS Report", "0.6", "0.75", "0.9", "1.0", "1.05"],
      ["Customer", "New Buyer Acquisition", "Monthly Target Achievement (%)",
       "Achieve the defined monthly target for the KPI.", "15.0", "Monthly MIS Report",
       "0.6", "0.75", "0.9", "1.0", "1.05"],
      ["Customer", "New Seller Acquisition", "Monthly Target Achievement (%)",
       "Achieve the defined monthly target for the KPI.", "15.0", "Monthly MIS Report",
       "0.6", "0.75", "0.9", "1.0", "1.05"],
      ["Process", "Transaction from New Onboarded Buyers", "New Buyer Same-Month Transaction Rate (%)",
       "Ensure at least 20% of buyers onboarded during the month complete a transaction within the same " +
         "month.", "5.0", "Monthly MIS Report", "0.6", "0.75", "0.9", "1.0", "1.05"],
      ["Sales", "GMV", "Monthly Target Achievement (%)", "Achieve the defined monthly target for the KPI.",
       "40.0", "Monthly MIS Report", "0.6", "0.75", "0.9", "1.0", "1.05"],
      ["Sales", "Transaction Closure", "Successfully Closed Transactions (Count)",
       "Successfully close the targeted number of transactions through completion of POD, DNCN, and " +
         "payment upload requirements.", "10.0", "Monthly MIS Report", "0.6", "0.75", "0.9", "1.0", "1.05"],
      ["Process", "DSO Days", "Days Sales Outstanding (DSO)",
       "Maintain DSO within the defined monthly target, calculated as (Average Receivables ÷ GMV) × Number " +
         "of Days in the Month.", "10.0", "Monthly MIS Report", "15.0", "10.0", "5.0", "3.0", "2.0"]
    ]},
    {"team": "Plastic", "group": "Supply", "sheet": "Plastic (Supply KRAKPI)", "name": "ASHISH KUMAR RAI",
     "designation": "Senior Executive - Business Development", "extra": "", "kpis": [
      ["Sales", "Transaction from Existing Sellers", "Seller Monthly Transaction Rate (%)",
       "Ensure at least 50% of total onboarded sellers transact during the current month.", "15.0",
       "Monthly MIS Report", "0.6", "0.75", "0.9", "1.0", "1.05"],
      ["Sales", "Transaction from New Onboarded Sellers", "New Seller Same-Month Transaction Rate (%)",
       "Ensure at least 20% of sellers onboarded during the current month complete a transaction within " +
         "the same month.", "15.0", "Monthly MIS Report", "0.6", "0.75", "0.9", "1.0", "1.05"],
      ["Sales", "New Seller Acquisition", "Monthly Target Achievement (%)",
       "Achieve the defined monthly target for the respective KPI within the evaluation period.", "15.0",
       "Monthly MIS Report", "0.6", "0.75", "0.9", "1.0", "1.05"],
      ["Sales", "GMV", "Monthly Target Achievement (%)",
       "Achieve the defined monthly target for the respective KPI within the evaluation period.", "40.0",
       "Monthly MIS Report", "0.6", "0.75", "0.9", "1.0", "1.05"],
      ["Sales", "Retention of Existing Transacted Sellers", "Repeat Seller Transaction Rate (%)",
       "Ensure at least 70% of sellers who transacted in the previous month transact again during the " +
         "current month.", "15.0", "Monthly MIS Report", "0.6", "0.75", "0.9", "1.0", "1.05"]
    ]},
    {"team": "Plastic", "group": "Supply", "sheet": "Plastic (Supply KRAKPI)", "name": "RAJU B",
     "designation": "Senior Executive - Business Development", "extra": "", "kpis": [
      ["Sales", "Transaction from Existing Sellers", "Seller Monthly Transaction Rate (%)",
       "Ensure at least 50% of total onboarded sellers transact during the current month.", "15.0",
       "Monthly MIS Report", "0.6", "0.75", "0.9", "1.0", "1.05"],
      ["Sales", "Transaction from New Onboarded Sellers", "New Seller Same-Month Transaction Rate (%)",
       "Ensure at least 20% of sellers onboarded during the current month complete a transaction within " +
         "the same month.", "15.0", "Monthly MIS Report", "0.6", "0.75", "0.9", "1.0", "1.05"],
      ["Sales", "New Seller Acquisition", "Monthly Target Achievement (%)",
       "Achieve the defined monthly target for the respective KPI within the evaluation period.", "15.0",
       "Monthly MIS Report", "0.6", "0.75", "0.9", "1.0", "1.05"],
      ["Sales", "GMV", "Monthly Target Achievement (%)",
       "Achieve the defined monthly target for the respective KPI within the evaluation period.", "40.0",
       "Monthly MIS Report", "0.6", "0.75", "0.9", "1.0", "1.05"],
      ["Sales", "Retention of Existing Transacted Sellers", "Repeat Seller Transaction Rate (%)",
       "Ensure at least 70% of sellers who transacted in the previous month transact again during the " +
         "current month.", "15.0", "Monthly MIS Report", "0.6", "0.75", "0.9", "1.0", "1.05"]
    ]},
    {"team": "Plastic", "group": "Supply", "sheet": "Plastic (Supply KRAKPI)", "name": "BRAJENDRA UPADHYAY",
     "designation": "Assistant Manager - Business Development", "extra": "", "kpis": [
      ["Sales", "Transaction from Existing Sellers", "Seller Monthly Transaction Rate (%)",
       "Ensure at least 50% of total onboarded sellers transact during the current month.", "15.0",
       "Monthly MIS Report", "0.6", "0.75", "0.9", "1.0", "1.05"],
      ["Sales", "Transaction from New Onboarded Sellers", "New Seller Same-Month Transaction Rate (%)",
       "Ensure at least 20% of sellers onboarded during the current month complete a transaction within " +
         "the same month.", "15.0", "Monthly MIS Report", "0.6", "0.75", "0.9", "1.0", "1.05"],
      ["Sales", "New Seller Acquisition", "Monthly Target Achievement (%)",
       "Achieve the defined monthly target for the respective KPI within the evaluation period.", "15.0",
       "Monthly MIS Report", "0.6", "0.75", "0.9", "1.0", "1.05"],
      ["Sales", "GMV", "Monthly Target Achievement (%)",
       "Achieve the defined monthly target for the respective KPI within the evaluation period.", "40.0",
       "Monthly MIS Report", "0.6", "0.75", "0.9", "1.0", "1.05"],
      ["Sales", "Retention of Existing Transacted Sellers", "Repeat Seller Transaction Rate (%)",
       "Ensure at least 70% of sellers who transacted in the previous month transact again during the " +
         "current month.", "15.0", "Monthly MIS Report", "0.6", "0.75", "0.9", "1.0", "1.05"]
    ]},
    {"team": "Plastic", "group": "Supply", "sheet": "Plastic (Supply KRAKPI)", "name": "ATHARVA SUDHIR PATIL",
     "designation": "Senior Executive - Business Development", "extra": "", "kpis": [
      ["Sales", "Transaction from Existing Sellers", "Seller Monthly Transaction Rate (%)",
       "Ensure at least 50% of total onboarded sellers transact during the current month.", "15.0",
       "Monthly MIS Report", "0.6", "0.75", "0.9", "1.0", "1.05"],
      ["Sales", "Transaction from New Onboarded Sellers", "New Seller Same-Month Transaction Rate (%)",
       "Ensure at least 20% of sellers onboarded during the current month complete a transaction within " +
         "the same month.", "15.0", "Monthly MIS Report", "0.6", "0.75", "0.9", "1.0", "1.05"],
      ["Sales", "New Seller Acquisition", "Monthly Target Achievement (%)",
       "Achieve the defined monthly target for the respective KPI within the evaluation period.", "15.0",
       "Monthly MIS Report", "0.6", "0.75", "0.9", "1.0", "1.05"],
      ["Sales", "GMV", "Monthly Target Achievement (%)",
       "Achieve the defined monthly target for the respective KPI within the evaluation period.", "40.0",
       "Monthly MIS Report", "0.6", "0.75", "0.9", "1.0", "1.05"],
      ["Sales", "Retention of Existing Transacted Sellers", "Repeat Seller Transaction Rate (%)",
       "Ensure at least 70% of sellers who transacted in the previous month transact again during the " +
         "current month.", "15.0", "Monthly MIS Report", "0.6", "0.75", "0.9", "1.0", "1.05"]
    ]},
    {"team": "Plastic", "group": "Supply", "sheet": "Plastic (Supply KRAKPI)", "name": "PRAVEEN RAJ P",
     "designation": "Senior Executive - Business Development", "extra": "", "kpis": [
      ["Sales", "Transaction from Existing Sellers", "Seller Monthly Transaction Rate (%)",
       "Ensure at least 50% of total onboarded sellers transact during the current month.", "15.0",
       "Monthly MIS Report", "0.6", "0.75", "0.9", "1.0", "1.05"],
      ["Sales", "Transaction from New Onboarded Sellers", "New Seller Same-Month Transaction Rate (%)",
       "Ensure at least 20% of sellers onboarded during the current month complete a transaction within " +
         "the same month.", "15.0", "Monthly MIS Report", "0.6", "0.75", "0.9", "1.0", "1.05"],
      ["Sales", "New Seller Acquisition", "Monthly Target Achievement (%)",
       "Achieve the defined monthly target for the respective KPI within the evaluation period.", "15.0",
       "Monthly MIS Report", "0.6", "0.75", "0.9", "1.0", "1.05"],
      ["Sales", "GMV", "Monthly Target Achievement (%)",
       "Achieve the defined monthly target for the respective KPI within the evaluation period.", "40.0",
       "Monthly MIS Report", "0.6", "0.75", "0.9", "1.0", "1.05"],
      ["Sales", "Retention of Existing Transacted Sellers", "Repeat Seller Transaction Rate (%)",
       "Ensure at least 70% of sellers who transacted in the previous month transact again during the " +
         "current month.", "15.0", "Monthly MIS Report", "0.6", "0.75", "0.9", "1.0", "1.05"]
    ]},
    {"team": "Plastic", "group": "Supply", "sheet": "Plastic (Supply KRAKPI)", "name": "ASRAFUL HASAN",
     "designation": "Assistant Manager - Business Development", "extra": "", "kpis": [
      ["Sales", "Transaction from Existing Sellers", "Seller Monthly Transaction Rate (%)",
       "Ensure at least 50% of total onboarded sellers transact during the current month.", "15.0",
       "Monthly MIS Report", "0.6", "0.75", "0.9", "1.0", "1.05"],
      ["Sales", "Transaction from New Onboarded Sellers", "New Seller Same-Month Transaction Rate (%)",
       "Ensure at least 20% of sellers onboarded during the current month complete a transaction within " +
         "the same month.", "15.0", "Monthly MIS Report", "0.6", "0.75", "0.9", "1.0", "1.05"],
      ["Sales", "New Seller Acquisition", "Monthly Target Achievement (%)",
       "Achieve the defined monthly target for the respective KPI within the evaluation period.", "15.0",
       "Monthly MIS Report", "0.6", "0.75", "0.9", "1.0", "1.05"],
      ["Sales", "GMV", "Monthly Target Achievement (%)",
       "Achieve the defined monthly target for the respective KPI within the evaluation period.", "40.0",
       "Monthly MIS Report", "0.6", "0.75", "0.9", "1.0", "1.05"],
      ["Sales", "Retention of Existing Transacted Sellers", "Repeat Seller Transaction Rate (%)",
       "Ensure at least 70% of sellers who transacted in the previous month transact again during the " +
         "current month.", "15.0", "Monthly MIS Report", "0.6", "0.75", "0.9", "1.0", "1.05"]
    ]},
    {"team": "Plastic", "group": "Supply", "sheet": "Plastic (Supply KRAKPI)",
     "name": "RUSTUMPET ASHWIN KUMAR", "designation": "Assistant Manager - Business Development", "extra": "",
     "kpis": [
      ["Sales", "Transaction from Existing Sellers", "Seller Monthly Transaction Rate (%)",
       "Ensure at least 50% of total onboarded sellers transact during the current month.", "15.0",
       "Monthly MIS Report", "0.6", "0.75", "0.9", "1.0", "1.05"],
      ["Sales", "Transaction from New Onboarded Sellers", "New Seller Same-Month Transaction Rate (%)",
       "Ensure at least 20% of sellers onboarded during the current month complete a transaction within " +
         "the same month.", "15.0", "Monthly MIS Report", "0.6", "0.75", "0.9", "1.0", "1.05"],
      ["Sales", "New Seller Acquisition", "Monthly Target Achievement (%)",
       "Achieve the defined monthly target for the respective KPI within the evaluation period.", "15.0",
       "Monthly MIS Report", "0.6", "0.75", "0.9", "1.0", "1.05"],
      ["Sales", "GMV", "Monthly Target Achievement (%)",
       "Achieve the defined monthly target for the respective KPI within the evaluation period.", "40.0",
       "Monthly MIS Report", "0.6", "0.75", "0.9", "1.0", "1.05"],
      ["Sales", "Retention of Existing Transacted Sellers", "Repeat Seller Transaction Rate (%)",
       "Ensure at least 70% of sellers who transacted in the previous month transact again during the " +
         "current month.", "15.0", "Monthly MIS Report", "0.6", "0.75", "0.9", "1.0", "1.05"]
    ]},
    {"team": "Plastic", "group": "Supply", "sheet": "Plastic (Supply KRAKPI)", "name": "JOYDEEP DAS",
     "designation": "Senior Executive - Business Development", "extra": "", "kpis": [
      ["Sales", "Transaction from Existing Sellers", "Seller Monthly Transaction Rate (%)",
       "Ensure at least 50% of total onboarded sellers transact during the current month.", "15.0",
       "Monthly MIS Report", "0.6", "0.75", "0.9", "1.0", "1.05"],
      ["Sales", "Transaction from New Onboarded Sellers", "New Seller Same-Month Transaction Rate (%)",
       "Ensure at least 20% of sellers onboarded during the current month complete a transaction within " +
         "the same month.", "15.0", "Monthly MIS Report", "0.6", "0.75", "0.9", "1.0", "1.05"],
      ["Sales", "New Seller Acquisition", "Monthly Target Achievement (%)",
       "Achieve the defined monthly target for the respective KPI within the evaluation period.", "15.0",
       "Monthly MIS Report", "0.6", "0.75", "0.9", "1.0", "1.05"],
      ["Sales", "GMV", "Monthly Target Achievement (%)",
       "Achieve the defined monthly target for the respective KPI within the evaluation period.", "40.0",
       "Monthly MIS Report", "0.6", "0.75", "0.9", "1.0", "1.05"],
      ["Sales", "Retention of Existing Transacted Sellers", "Repeat Seller Transaction Rate (%)",
       "Ensure at least 70% of sellers who transacted in the previous month transact again during the " +
         "current month.", "15.0", "Monthly MIS Report", "0.6", "0.75", "0.9", "1.0", "1.05"]
    ]},
    {"team": "Plastic", "group": "Supply", "sheet": "Plastic (Supply KRAKPI)", "name": "PARTH GAUTAM",
     "designation": "Senior Manager - BusinessDevelopment", "extra": "", "kpis": [
      ["Sales", "Transaction from Existing Sellers", "Seller Monthly Transaction Rate (%)",
       "Ensure at least 50% of total onboarded sellers transact during the current month.", "15.0",
       "Monthly MIS Report", "0.6", "0.75", "0.9", "1.0", "1.05"],
      ["Sales", "Transaction from New Onboarded Sellers", "New Seller Same-Month Transaction Rate (%)",
       "Ensure at least 20% of sellers onboarded during the current month complete a transaction within " +
         "the same month.", "15.0", "Monthly MIS Report", "0.6", "0.75", "0.9", "1.0", "1.05"],
      ["Sales", "New Seller Acquisition", "Monthly Target Achievement (%)",
       "Achieve the defined monthly target for the respective KPI within the evaluation period.", "15.0",
       "Monthly MIS Report", "0.6", "0.75", "0.9", "1.0", "1.05"],
      ["Sales", "GMV", "Monthly Target Achievement (%)",
       "Achieve the defined monthly target for the respective KPI within the evaluation period.", "40.0",
       "Monthly MIS Report", "0.6", "0.75", "0.9", "1.0", "1.05"],
      ["Sales", "Retention of Existing Transacted Sellers", "Repeat Seller Transaction Rate (%)",
       "Ensure at least 70% of sellers who transacted in the previous month transact again during the " +
         "current month.", "15.0", "Monthly MIS Report", "0.6", "0.75", "0.9", "1.0", "1.05"]
    ]},
    {"team": "Plastic", "group": "Supply", "sheet": "Plastic (Supply KRAKPI)",
     "name": "UDAY KIRAN KUMAR THOTA", "designation": "Senior Manager - Business Development", "extra": "",
     "kpis": [
      ["Sales", "Transaction from Existing Sellers", "Seller Monthly Transaction Rate (%)",
       "Ensure at least 50% of total onboarded sellers transact during the current month.", "15.0",
       "Monthly MIS Report", "0.6", "0.75", "0.9", "1.0", "1.05"],
      ["Sales", "Transaction from New Onboarded Sellers", "New Seller Same-Month Transaction Rate (%)",
       "Ensure at least 20% of sellers onboarded during the current month complete a transaction within " +
         "the same month.", "15.0", "Monthly MIS Report", "0.6", "0.75", "0.9", "1.0", "1.05"],
      ["Sales", "New Seller Acquisition", "Monthly Target Achievement (%)",
       "Achieve the defined monthly target for the respective KPI within the evaluation period.", "15.0",
       "Monthly MIS Report", "0.6", "0.75", "0.9", "1.0", "1.05"],
      ["Sales", "GMV", "Monthly Target Achievement (%)",
       "Achieve the defined monthly target for the respective KPI within the evaluation period.", "40.0",
       "Monthly MIS Report", "0.6", "0.75", "0.9", "1.0", "1.05"],
      ["Sales", "Retention of Existing Transacted Sellers", "Repeat Seller Transaction Rate (%)",
       "Ensure at least 70% of sellers who transacted in the previous month transact again during the " +
         "current month.", "15.0", "Monthly MIS Report", "0.6", "0.75", "0.9", "1.0", "1.05"]
    ]},
    {"team": "Plastic", "group": "Supply", "sheet": "Plastic (Supply KRAKPI)", "name": "TABESH MOHAMMAD",
     "designation": "General Manager - Business Development", "extra": "", "kpis": [
      ["Sales", "Demand Activation", "Existing Buyer Monthly Transaction Rate (%)",
       "Ensure at least 50% of active/onboarded buyers transact during the current month, maintaining " +
         "healthy demand utilisation across the category.", "10.0", "Monthly MIS Report",
       "0.6", "0.75", "0.9", "1.0", "1.05"],
      ["Scale", "New Demand Activation", "New Buyer Same-Month Transaction Rate (%)",
       "Ensure at least 20% of buyers onboarded during the current month complete a transaction within the " +
         "same month.", "10.0", "Monthly MIS Report", "0.6", "0.75", "0.9", "1.0", "1.05"],
      ["Sales", "Supply Activation", "Existing Seller Monthly Transaction Rate (%)",
       "Ensure at least 50% of active/onboarded sellers transact during the current month, maintaining " +
         "healthy supply utilisation.", "10.0", "Monthly MIS Report", "0.6", "0.75", "0.9", "1.0", "1.05"],
      ["Scale", "New Supply Activation", "New Seller Same-Month Transaction Rate (%)",
       "Ensure at least 20% of sellers onboarded during the current month complete a transaction within " +
         "the same month.", "10.0", "Monthly MIS Report", "0.6", "0.75", "0.9", "1.0", "1.05"],
      ["Sales / Profit", "Category GMV Growth", "GMV Target Achievement (%)",
       "Achieve the approved monthly GMV target for the category, balancing demand and supply growth to " +
         "drive sustainable category revenue.", "30.0", "Monthly MIS Report",
       "0.6", "0.75", "0.9", "1.0", "1.05"],
      ["Customer", "Transaction Quality", "Debit Note Rate (%)",
       "Ensure debit notes remain within the defined threshold as a percentage of current-month GMV, " +
         "protecting transaction quality and commercial realisation.", "10.0", "Monthly MIS Report",
       "0.013", "0.012", "0.01", "0.008", "0.006"],
      ["Process / Profit", "Working Capital Management", "Days Sales Outstanding (DSO)",
       "Maintain DSO within the defined threshold to ensure timely collections and healthy working capital " +
         "for the category.", "15.0", "Monthly MIS Report", "15.0", "10.0", "5.0", "3.0", "2.0"],
      ["Sales / Profit", "Category Growth & Balance", "Demand–Supply Conversion Rate (%)",
       "Ensure available category demand is effectively fulfilled through available supply, improving " +
         "transaction conversion and reducing demand–supply imbalance.", "5.0", "Monthly MIS Report",
       "0.6", "0.75", "0.9", "1.0", "1.05"]
    ]},
    {"team": "Plastic", "group": "Supply", "sheet": "Plastic (Supply KRAKPI)", "name": "NARESH",
     "designation": "", "extra": "", "kpis": [
      ["Process", "Seller Onboarding", "Seller Onboarding TAT Achievement (%)",
       "Ensure seller onboarding cases are completed within the defined TAT through timely document " +
         "validation, third-party verification, OSV coordination and closure of pending documentation.",
       "30.0", "COP / MIS", "0.6", "0.75", "0.9", "1.0", "1.05"],
      ["Process", "Buyer Onboarding", "Buyer Onboarding TAT Achievement (%)",
       "Ensure buyer onboarding cases are completed within the defined TAT through timely document " +
         "collection, KYC/business validation, document updation and closure of identified gaps.", "20.0",
       "COP / MIS", "0.6", "0.75", "0.9", "1.0", "1.05"],
      ["Process", "Escalation Management & Issue Resolution", "Issue Resolution TAT Achievement (%)",
       "Ensure seller, buyer and transaction-related operational issues are logged, coordinated, followed " +
         "up and resolved within the defined TAT, with timely communication to relevant stakeholders.",
       "25.0", "MIS", "0.6", "0.75", "0.9", "1.0", "1.05"],
      ["Customer", "Sales & Relationship Team Coordination", "Pending Action Closure Rate (%)",
       "Ensure pending actions related to onboarding, inactive sellers/buyers, listing/requisition, " +
         "matchmaking, transaction readiness, dispatch, QC/POD and payment are tracked and closed within the " +
         "defined timeline.", "10.0", "MIS", "0.6", "0.75", "0.9", "1.0", "1.05"],
      ["Process", "MIS & Operational Reporting", "MIS Accuracy & Timeliness (%)",
       "Maintain accurate and timely reporting of onboarding, pending cases, escalations, ageing, TAT and " +
         "transaction-related operational metrics, ensuring critical gaps and dependencies are highlighted " +
         "to stakeholders.", "10.0", "MIS / COP / Dashboard", "0.6", "0.75", "0.9", "1.0", "1.05"],
      ["Process", "Process Improvement & SOP Adherence",
       "SOP Compliance & Process Improvement Achievement (%)",
       "Ensure adherence to defined SOPs and contribute to identifying and addressing recurring process " +
         "gaps, bottlenecks and documentation issues to improve operational efficiency and reduce TAT.",
       "5.0", "SOP Audit / MIS / Process Tracker", "0.6", "0.75", "0.9", "1.0", "1.05"]
    ]},
    {"team": "Plastic", "group": "Demand", "sheet": "Plastic (Demand KRAKPI)", "name": "NEELESH DIXIT",
     "designation": "Senior Manager - Bsuiness Development", "extra": "", "kpis": [
      ["Sales", "Transaction from Existing Buyers", "Buyer Monthly Transaction Rate (%)",
       "Ensure at least 60% of total onboarded buyers transact during the current month.", "15.0",
       "Monthly MIS Report", "0.6", "0.75", "0.9", "1.0", "1.05"],
      ["Scale", "Transaction from New Onboarded Buyers", "New Buyer Same-Month Transaction Rate (%)",
       "Ensure at least 20% of buyers onboarded during the current month complete a transaction within the " +
         "same month.", "15.0", "Monthly MIS Report", "0.6", "0.75", "0.9", "1.0", "1.05"],
      ["Customer", "New Buyer Acquisition", "Monthly Target Achievement (%)",
       "Achieve the defined monthly target for the respective KPI within the evaluation period.", "15.0",
       "Monthly MIS Report", "0.6", "0.75", "0.9", "1.0", "1.05"],
      ["Process", "GMV", "Monthly Target Achievement (%)",
       "Achieve the defined monthly target for the respective KPI within the evaluation period.", "30.0",
       "Monthly MIS Report", "0.6", "0.75", "0.9", "1.0", "1.05"],
      ["Customer", "DN % of GMV", "Debit Note Rate (%)",
       "Ensure debit notes do not exceed 1% of the buyer's current-month GMV.", "10.0", "Monthly MIS Report",
       "0.013", "0.012", "0.01", "0.008", "0.006"],
      ["Process", "DSO Days", "Days Sales Outstanding (DSO)",
       "Calculate DSO as (Average Receivables ÷ GMV) × Number of Days in the Month.", "15.0",
       "Monthly MIS Report", "15.0", "10.0", "5.0", "3.0", "2.0"]
    ]},
    {"team": "Plastic", "group": "Demand", "sheet": "Plastic (Demand KRAKPI)", "name": "RISHI PANCHAL",
     "designation": "Senior Executive - Business Development", "extra": "", "kpis": [
      ["Sales", "Transaction from Existing Buyers", "Buyer Monthly Transaction Rate (%)",
       "Ensure at least 60% of total onboarded buyers transact during the current month.", "15.0",
       "Monthly MIS Report", "0.6", "0.75", "0.9", "1.0", "1.05"],
      ["Scale", "Transaction from New Onboarded Buyers", "New Buyer Same-Month Transaction Rate (%)",
       "Ensure at least 20% of buyers onboarded during the current month complete a transaction within the " +
         "same month.", "15.0", "Monthly MIS Report", "0.6", "0.75", "0.9", "1.0", "1.05"],
      ["Customer", "New Buyer Acquisition", "Monthly Target Achievement (%)",
       "Achieve the defined monthly target for the respective KPI within the evaluation period.", "15.0",
       "Monthly MIS Report", "0.6", "0.75", "0.9", "1.0", "1.05"],
      ["Process", "GMV", "Monthly Target Achievement (%)",
       "Achieve the defined monthly target for the respective KPI within the evaluation period.", "30.0",
       "Monthly MIS Report", "0.6", "0.75", "0.9", "1.0", "1.05"],
      ["Customer", "DN % of GMV", "Debit Note Rate (%)",
       "Ensure debit notes do not exceed 1% of the buyer's current-month GMV.", "10.0", "Monthly MIS Report",
       "0.013", "0.012", "0.01", "0.008", "0.006"],
      ["Process", "DSO Days", "Days Sales Outstanding (DSO)",
       "Maintain DSO as per the defined formula: (Average Receivables ÷ GMV) × Number of Days in the Month.",
       "15.0", "Monthly MIS Report", "15.0", "10.0", "5.0", "3.0", "2.0"]
    ]},
    {"team": "Onboarding", "group": "", "sheet": "Onboarding (Individual)", "name": "VAMSI",
     "designation": "Senior Executive - Onboarding", "extra": "", "kpis": [
      ["Process", "Open Marketplace – Buyer & Seller Onboarding", "TAT ( 1 Day )",
       "% of cases completed within TAT", "0.35", "COP (Data)", "0.8", "0.85", "0.9", "0.95", "1.0"],
      ["Process", "Re-Commerce – Seller Onboarding", "TAT ( 1 Day )", "% of cases completed within TAT",
       "0.1", "COP (Data)", "0.8", "0.85", "0.9", "0.95", "1.0"],
      ["Process", "Fall Back – AFR & INFRA (Seller & Buyer Onboarding)", "TAT ( 3 Days)",
       "% of cases completed within TAT", "0.1", "COP (Data)", "0.8", "0.85", "0.9", "0.95", "1.0"],
      ["Process", "Audit & Monitoring of Onboarded Vendors", "Document Completeness",
       "% of audited vendors with complete and correctly validated documentation", "0.2",
       "Individual Work Sheet", "0.8", "0.85", "0.9", "0.95", "1.0"],
      ["Process", "On-Site Verification", "TAT ( 4 Days )", "% of OSVs completed within TAT", "0.15",
       "Individual Work Sheet", "0.8", "0.85", "0.9", "0.95", "1.0"],
      ["Process", "Vendor Payments – Third Party (Finoscale / Carma One)",
       "Timely Validation of Bills & Vendor Payments", "% of bills/payments validated within defined TAT",
       "0.1", "Individual Work Sheet", "0.8", "0.85", "0.9", "0.95", "1.0"]
    ]},
    {"team": "Onboarding", "group": "", "sheet": "Onboarding (Individual)", "name": "HARSHITA",
     "designation": "Executive - Onboarding", "extra": "", "kpis": [
      ["Process", "INFRA – Buyer & Seller Onboarding", "TAT ( 3 Days )", "% of cases completed within TAT",
       "0.25", "COP (Data)", "0.8", "0.85", "0.9", "0.95", "1.0"],
      ["Process", "AFR – Buyer & Seller Onboarding", "TAT ( 3 Days )", "% of cases completed within TAT",
       "0.25", "COP (Data)", "0.8", "0.85", "0.9", "0.95", "1.0"],
      ["Process", "Audit & Monitoring of Onboarded Vendors", "Document Completeness",
       "% of audited vendors with complete and correctly validated documentation", "0.2",
       "Individual Work Sheet", "0.8", "0.85", "0.9", "0.95", "1.0"],
      ["Process", "Fall Back – EPR (Seller Onboarding)", "TAT", "% of cases completed within defined TAT",
       "0.1", "COP (Data)", "0.8", "0.85", "0.9", "0.95", "1.0"],
      ["Process", "Vendor Payments – Third Party (Ongrid)", "Timely Validation of Bills & Vendor Payments",
       "% of bills/payments validated within defined TAT", "0.1", "Individual Work Sheet",
       "0.8", "0.85", "0.9", "0.95", "1.0"],
      ["Process", "Vendor Payments – Third Party (Finoscale / Carma One)",
       "Timely Validation of Bills & Vendor Payments", "% of bills/payments validated within defined TAT",
       "0.1", "Individual Work Sheet", "0.8", "0.85", "0.9", "0.95", "1.0"]
    ]},
    {"team": "Onboarding", "group": "", "sheet": "Onboarding (Individual)", "name": "NAVEEN RANGA",
     "designation": "Senior Executive - Onboarding", "extra": "", "kpis": [
      ["Process", "EPR – Buyer & Seller Onboarding", "TAT ( 3 Days)",
       "% of cases completed within defined TAT", "0.35", "COP (Data)", "0.8", "0.85", "0.9", "0.95", "1.0"],
      ["Process", "Audit & Monitoring of Onboarded Vendors", "Document Completeness",
       "% of audited vendors with complete and correctly validated documentation", "0.2",
       "Individual Work Sheet", "0.8", "0.85", "0.9", "0.95", "1.0"],
      ["Process", "Transporter Onboarding", "TAT", "% of cases completed within defined TAT", "0.15",
       "COP (Data)", "0.8", "0.85", "0.9", "0.95", "1.0"],
      ["Process", "Fall Back – Open Marketplace Onboarding", "TAT ( 1 Day )",
       "% of cases completed within defined TAT", "0.1", "COP (Data)", "0.8", "0.85", "0.9", "0.95", "1.0"],
      ["Process", "Open Marketplace – NBFC Coordination", "NBFC Coordination & Case Management",
       "% of NBFC coordination activities completed within defined SLA", "0.1", "Emails / Dashboard",
       "0.8", "0.85", "0.9", "0.95", "1.0"],
      ["Process", "GST Payments", "Compliance Check",
       "% of Third Party vendors paid within defined payment timeline", "0.1", "Documentation",
       "0.8", "0.85", "0.9", "0.95", "1.0"]
    ]},
    {"team": "Onboarding", "group": "", "sheet": "Onboarding (Individual)", "name": "VISHWASH",
     "designation": "Management Trainee", "extra": "", "kpis": [
      ["Process", "Fall Back for All Verticals – Vendor & Buyer Onboarding", "TAT",
       "% of onboarding cases completed within defined TAT as per SOP", "0.1", "COP (Data)",
       "0.8", "0.85", "0.9", "0.95", "1.0"],
      ["Process", "Design Standard Operating Procedures for Onboarding", "Approved SOPs",
       "% of required SOPs validated, approved and implemented", "0.2", "COP (Data)",
       "0.8", "0.85", "0.9", "0.95", "1.0"],
      ["Process", "Digitalization of the Onboarding Process", "Automation of Process",
       "% of identified onboarding processes automated", "0.3", "Process Flow",
       "0.0", "0.1", "0.2", "0.35", "0.5"],
      ["Process", "Maintain Daily Reports for Buyer & Seller Onboarding Across Verticals",
       "Accuracy & Timeliness of Reports / Dashboard Representation",
       "% of reports accurately represented and delivered within defined timeline", "0.3",
       "Individual Work Sheet", "0.8", "0.85", "0.9", "0.95", "1.0"],
      ["Process", "Audit Process for Entire Onboarding & Collections", "Reporting & Escalations",
       "% of audit findings reported and escalated within defined timeline", "0.1", "Meeting",
       "More than (T+7 days)", "T+7 days", "On Time (Defined TAT)", "T-1 day", "T - 2 days"]
    ]},
    {"team": "Onboarding", "group": "", "sheet": "Onboarding (Individual)", "name": "AJAY",
     "designation": "Manager - Onboarding", "extra": "", "kpis": [
      ["Process", "All Verticals – Vendor & Buyer Onboarding", "TAT",
       "% of onboarding cases completed within defined TAT as per SOP", "0.4", "COP (Data)",
       "0.8", "0.85", "0.9", "0.95", "1.0"],
      ["Process", "Design Standard Operating Procedures for Onboarding", "Approved SOPs",
       "% of required SOPs validated, approved and implemented", "0.2", "COP (Data)",
       "0.8", "0.85", "0.9", "0.95", "1.0"],
      ["Process", "Audit & Monitoring of Onboarded Vendors", "Document Completeness",
       "% of audited vendors with complete and correctly validated documentation", "0.1", "Monthly Reporting",
       "0.8", "0.85", "0.9", "0.95", "1.0"],
      ["Process", "Digitalization of the Onboarding Process", "Automation of Process",
       "% of identified onboarding processes automated", "0.2", "Process Flow",
       "0.0", "0.15", "0.3", "0.5", "0.7"],
      ["Process", "Vendor Payments", "Timely Validation of Bills & Vendor Payments",
       "% of bills/payments validated within defined payment timeline", "0.1", "Team Work Sheet",
       "0.8", "0.85", "0.9", "0.95", "1.0"]
    ]},
    {"team": "Collections", "group": "", "sheet": "Collections (Individual)", "name": "SAI NITIN",
     "designation": "Executive - Collections", "extra": "", "kpis": [
      ["Customer", "Due Date + 7 Days Collections – Marketplace & EPR", "Collection % vs Target",
       "Achieve the defined collection target within the evaluation period.", "0.6", "MIS Report",
       "0.8", "0.85", "0.9", "1.0", "1.05"],
      ["Process", "Balance Confirmation", "Confirmation Coverage %",
       "Ensure at least the defined percentage of customers with dues exceeding ₹50K have their payments " +
         "confirmed.", "0.1", "MIS Report", "0.8", "0.85", "0.9", "0.95", "1.0"],
      ["Process", "Reminder Emails", "Adherence to Reminder (Total)",
       "Ensure adherence to the defined collections reminder process within the evaluation period.", "0.1",
       "MIS Report", "As per Collections Process", "—", "—", "—", "—"],
      ["Process", "Payment Posting", "TAT – Days",
       "Ensure payment posting is completed within the defined TAT from the date of payment receipt.", "0.1",
       "MIS Report", "12 Days", "10 Days", "8 Days", "7 Days", "5 Days"],
      ["Process", "Cross-Functional Coordination", "Coordination Adherence %",
       "Ensure adherence to the defined coordination requirements during each quarter.", "0.1", "MIS Report",
       "75% in Quater", "80% in Quater", "85% in Quater", "90% in Quater", "100% in Quater"]
    ]},
    {"team": "Collections", "group": "", "sheet": "Collections (Individual)", "name": "RAVI NAIK",
     "designation": "Manager - Collections", "extra": "", "kpis": [
      ["Customer", "Due Date + 7 Days Collections – Marketplace & EPR", "Collection % vs Target",
       "Achieve the defined collection target within the evaluation period.", "0.3", "MIS Report",
       "0.8", "0.85", "0.9", "1.0", "1.05"],
      ["Customer", "DSO – Marketplace & EPR", "DSO Days",
       "Maintain DSO within the defined target during the evaluation period.", "0.3", "MIS Report",
       "> 28 Days", "25–28 Days", "21–24 Days", "TGT-20 Days", "≤ 19 Days"],
      ["Collections", "Legacy Collections", "Legacy Collection % of LD",
       "Ensure the defined percentage of Legacy Debt (LD) is collected within the evaluation period.", "0.15",
       "MIS Report", "10% of LD", "15% of LD", "20% of LD", "25% of LD", "30% of LD"],
      ["Collections", "PDD (Past Due Debt)", "PDD ₹ Cr Recovered",
       "Recover the defined PDD amount in ₹ Cr within the evaluation period.", "0.1", "MIS Report",
       "≥ ₹9 Cr", "₹8 Cr", "₹7 Cr", "₹6 Cr", "< ₹5 Cr"],
      ["Process", "Legal Actions", "Legal Action Coordination %",
       "Achieve the defined cumulative percentage of the team target through effective coordination of " +
         "legal actions.", "0.05", "MIS Report", "80% Cumulative of Team Target",
       "100% Cumulative of Team Target", "120% Cumulative of Team Target", "140% Cumulative of Team Target",
       "160% Cumulative of Team Target"],
      ["Collections", "Collection of Previous Dues (Marketplace & EPR)",
       "Collections of Overdue of Previous Financial prior to FY 25-26 (Marketplace & EPR)",
       "Ensure the defined percentage of overdue collections from financial years prior to FY 25-26 is " +
         "recovered during the evaluation period.", "0.1", "MIS Report", "0.4", "0.5", "0.6", "0.7", "0.8"]
    ]},
    {"team": "Collections", "group": "", "sheet": "Collections (Individual)", "name": "ANKUR",
     "designation": "Assistant Manager - Collections", "extra": "", "kpis": [
      ["Customer", "Due Date + 7 Days Collections – Marketplace & EPR", "Collection % vs Target",
       "Achieve the defined collection target within the evaluation period.", "0.3", "MIS Report",
       "0.8", "0.85", "0.9", "1.0", "1.05"],
      ["Customer", "DSO – Marketplace & EPR", "DSO Days",
       "Maintain DSO within the defined target during the evaluation period.", "0.3", "MIS Report",
       "> 28 Days", "25–28 Days", "21–24 Days", "TGT-20 Days", "≤ 19 Days"],
      ["Collections", "Legacy Collections", "Legacy Collection % of LD",
       "Ensure the defined percentage of Legacy Debt (LD) is collected within the evaluation period.", "0.15",
       "MIS Report", "10% of LD", "15% of LD", "20% of LD", "25% of LD", "30% of LD"],
      ["Collections", "PDD (Past Due Debt)", "PDD ₹ Cr Recovered",
       "Recover the defined PDD amount in ₹ Cr within the evaluation period.", "0.1", "MIS Report",
       "≥ ₹9 Cr", "₹8 Cr", "₹7 Cr", "₹6 Cr", "< ₹5 Cr"],
      ["Process", "Legal Actions", "Legal Action Coordination %",
       "Achieve the defined cumulative percentage of the team target through effective coordination of " +
         "legal actions.", "0.05", "MIS Report", "80% Cumulative of Team Target",
       "100% Cumulative of Team Target", "120% Cumulative of Team Target", "140% Cumulative of Team Target",
       "160% Cumulative of Team Target"],
      ["Collections", "Collection of Previous Dues (Marketplace)",
       "Collections of Overdue of Previous Financial prior to FY 25-26 (Marketplace)",
       "Ensure the defined percentage of overdue collections from financial years prior to FY 25-26 is " +
         "recovered during the evaluation period.", "0.1", "MIS Report", "0.4", "0.5", "0.6", "0.7", "0.8"]
    ]},
    {"team": "Collections", "group": "", "sheet": "Collections (Individual)", "name": "VENKAT",
     "designation": "Assistant Manager - Collections", "extra": "", "kpis": [
      ["Customer", "Due Date + 7 Days Collections – Marketplace & EPR", "Collection % vs Target",
       "Achieve the defined collection target within the evaluation period.", "0.3", "MIS Report",
       "0.8", "0.85", "0.9", "1.0", "1.05"],
      ["Customer", "DSO – Marketplace & EPR", "DSO Days",
       "Maintain DSO within the defined target during the evaluation period.", "0.3", "MIS Report",
       "> 28 Days", "25–28 Days", "21–24 Days", "TGT-20 Days", "≤ 19 Days"],
      ["Collections", "Legacy Collections", "Legacy Collection % of LD",
       "Ensure the defined percentage of Legacy Debt (LD) is collected within the evaluation period.", "0.15",
       "MIS Report", "10% of LD", "15% of LD", "20% of LD", "25% of LD", "30% of LD"],
      ["Collections", "PDD (Past Due Debt)", "PDD ₹ Cr Recovered",
       "Recover the defined PDD amount in ₹ Cr within the evaluation period.", "0.1", "MIS Report",
       "≥ ₹9 Cr", "₹8 Cr", "₹7 Cr", "₹6 Cr", "< ₹5 Cr"],
      ["Process", "Legal Actions", "Legal Action Coordination %",
       "Achieve the defined cumulative percentage of the team target through effective coordination of " +
         "legal actions.", "0.05", "MIS Report", "80% Cumulative of Team Target",
       "100% Cumulative of Team Target", "120% Cumulative of Team Target", "140% Cumulative of Team Target",
       "160% Cumulative of Team Target"],
      ["Collections", "Collection of Previous Dues (EPR)",
       "Collections of Overdue of Previous Financial prior to FY 25-26 (EPR)",
       "Ensure the defined percentage of overdue collections from financial years prior to FY 25-26 is " +
         "recovered during the evaluation period.", "0.1", "MIS Report", "0.4", "0.5", "0.6", "0.7", "0.8"]
    ]},
    {"team": "Collections", "group": "", "sheet": "Collections (Individual)", "name": "SRINIVAS REDDY",
     "designation": "Assistant Manager - Collections", "extra": "", "kpis": [
      ["Collections", "Collection of Previous Dues (Marketplace & EPR)",
       "Collections of Overdue of Previous Financial prior to FY 25-26 (EPR)",
       "Ensure the defined percentage of overdue collections from financial years prior to FY 25-26 is " +
         "recovered during the evaluation period.", "0.1", "MIS Report", "0.4", "0.5", "0.6", "0.7", "0.8"],
      ["Customer", "DSO – Marketplace & EPR", "DSO Days",
       "Maintain DSO within the defined target during the evaluation period.", "0.1", "MIS Report",
       "> 28 Days", "25–28 Days", "21–24 Days", "TGT-20 Days", "≤ 19 Days"],
      ["Process", "Transaction (Marketplace)", "Coordination Adherence %",
       "Ensure adherence to the defined coordination requirements during the evaluation period.", "0.15",
       "MIS Report / Email / Communication Channel", "0.8", "0.85", "0.9", "0.95", "1.0"],
      ["Process", "Payment Posting & Reconciliation", "TAT – Days",
       "Ensure payment posting and reconciliation are completed within the defined TAT from the date of " +
         "payment receipt.", "0.15", "MIS Report", "12 Days", "10 Days", "8 Days", "7 Days", "5 Days"],
      ["Process", "Process Improvement & Automation", "Process Automation (%)",
       "Identify process gaps and leakages and implement solutions to improve operational efficiency, " +
         "reduce manual intervention, and minimize errors.", "0.3",
       "Project Tracker / Process Improvement Tracker", "0.8", "0.85", "0.9", "0.95", "1.0"],
      ["Process", "Compliance (Documentation) & Audit", "Documentation Completion (%)",
       "Ensure 100% completion of required documentation from both Buyers and Sellers for every " +
         "transaction.", "0.2", "Dashboard / MIS", "0.8", "0.85", "0.9", "0.95", "1.0"]
    ]},
    {"team": "Open Marketplace - Control Tower", "group": "", "sheet": "Marketplace - Control Tower (In",
     "name": "ASHWIN KUMAR SINGH", "designation": "Manager", "extra": "", "kpis": [
      ["Process", "Compliance (Documentation)", "Documentation Completion (%)",
       "Ensure 100% completion of required documentation from both Buyers and Sellers for every " +
         "transaction.", "0.2", "Dashboard / MIP", "0.8", "0.85", "0.9", "0.95", "1.0"],
      ["Process", "Match Making", "Demand & Listing Conversion Rate (%)",
       "Achieve at least 80% conversion of demand requisitions and platform listings into successful " +
         "transactions.", "0.1", "Dashboard / MIP", "0.8", "0.85", "0.9", "0.95", "1.0"],
      ["MIS", "Transaction Tracking", "Transaction Closure & Tracking (%)",
       "Ensure 100% transaction closure, including completion of material movement, GST payment, and " +
         "end-to-end transaction tracking with complete dashboard visibility.", "0.2", "Dashboard / MIP",
       "0.8", "0.85", "0.9", "0.95", "1.0"],
      ["Process", "DN / CN Tracking", "CN & DN Closure Rate (%)",
       "Ensure 100% closure of all Credit Note (CN) and Debit Note (DN) transactions within the defined " +
         "timeline.", "0.2", "Dashboard / MIP", "0.8", "0.85", "0.9", "0.95", "1.0"],
      ["Process", "Process Improvement & Automation", "Process Automation (%)",
       "Identify process gaps and leakages and implement solutions to improve operational efficiency, " +
         "reduce manual intervention, and minimize errors.", "0.3",
       "Project Tracker / Process Improvement Tracker", "0.0", "0.15", "0.3", "0.5", "0.7"]
    ]},
    {"team": "Open Marketplace - Control Tower", "group": "", "sheet": "Marketplace - Control Tower (In",
     "name": "DIVYA BOPPURI", "designation": "Executive", "extra": "", "kpis": [
      ["Process", "Dispatch Execution", "Timely Dispatch Rate (%)",
       "Ensure shipments are dispatched within 2 days of matchmaking in accordance with the defined SOP.",
       "0.4", "Dashboard / MIP", "0.8", "0.85", "0.9", "0.95", "1.0"],
      ["Process", "Dispatch Documentation Management", "Dispatch Documentation Accuracy (%)",
       "Ensure 100% of dispatches have a complete and error-free 6-Document Pack.", "0.35",
       "Audit / Reconciliation", "0.8", "0.85", "0.9", "0.95", "1.0"],
      ["Process", "Dispatch Coordination & Resolution", "Dispatch Issue Resolution Rate (%)",
       "Ensure seller follow-ups, gate-pass coordination, and dispatch-related queries are resolved within " +
         "the defined SLA.", "0.15", "Email / MIP / Communication Channel",
       "0.8", "0.85", "0.9", "0.95", "1.0"],
      ["Process", "SOP & Process Compliance", "Dispatch SOP Compliance Rate (%)",
       "Ensure 100% of transactions are executed in accordance with the defined dispatch and documentation " +
         "guidelines.", "0.1", "Email / MIP / Training & Meetings", "0.8", "0.85", "0.9", "0.95", "1.0"]
    ]},
    {"team": "Open Marketplace - Control Tower", "group": "", "sheet": "Marketplace - Control Tower (In",
     "name": "JITHENDER CHITAKODUR", "designation": "Executive", "extra": "", "kpis": [
      ["Process", "Dispatch Execution", "Timely Dispatch Rate (%)",
       "Ensure shipments are dispatched within 2 days of matchmaking in accordance with the defined SOP.",
       "0.4", "Dashboard / MIP", "0.8", "0.85", "0.9", "0.95", "1.0"],
      ["Process", "Dispatch Documentation Management", "Dispatch Documentation Accuracy (%)",
       "Ensure 100% of dispatches have a complete and error-free 6-Document Pack.", "0.35",
       "Audit / Reconciliation", "0.8", "0.85", "0.9", "0.95", "1.0"],
      ["Process", "Dispatch Coordination & Resolution", "Dispatch Issue Resolution Rate (%)",
       "Ensure seller follow-ups, gate-pass coordination, and dispatch-related queries are resolved within " +
         "the defined SLA.", "0.15", "MIP / Communication Channel", "0.8", "0.85", "0.9", "0.95", "1.0"],
      ["Process", "SOP & Process Compliance", "Dispatch SOP Compliance Rate (%)",
       "Ensure 100% of transactions are executed in accordance with the defined dispatch and documentation " +
         "guidelines.", "0.1", "Email /MIP / Training & Meetings", "0.8", "0.85", "0.9", "0.95", "1.0"]
    ]},
    {"team": "Open Marketplace - Control Tower", "group": "", "sheet": "Marketplace - Control Tower (In",
     "name": "BHARATH KUMAR", "designation": "Senior Executive", "extra": "", "kpis": [
      ["Process", "In-Transit Delivery Management", "On-Time Transit Completion Rate (%)",
       "Ensure shipments reach the buyer location within the planned transit window.", "0.5",
       "Dashboard / MIP", "0.8", "0.85", "0.9", "0.95", "1.0"],
      ["Process", "Shipment Visibility & Monitoring", "Tracking Accuracy Rate (%)",
       "Ensure shipments are accurately monitored through Mobile SIM / FASTag without tracking blind spots.",
       "0.3", "Audit / Reconciliation", "0.8", "0.85", "0.9", "0.95", "1.0"],
      ["Process", "Buyer Coordination & Delay Management", "Pre-Arrival & Delay Resolution Rate (%)",
       "Ensure buyer notifications and shipment-delay cases are handled within the defined SLA.", "0.1",
       "Email / MIP / Communication Channel", "0.8", "0.85", "0.9", "0.95", "1.0"],
      ["Process", "In-Transit SOP Compliance", "Transit Process Compliance Rate (%)",
       "Ensure 100% of shipments are managed in accordance with the defined tracking and escalation SOPs.",
       "0.1", "Email / MIP / Training & Meetings", "0.8", "0.85", "0.9", "0.95", "1.0"]
    ]},
    {"team": "Open Marketplace - Control Tower", "group": "", "sheet": "Marketplace - Control Tower (In",
     "name": "RAJESWARI", "designation": "Executive", "extra": "", "kpis": [
      ["Process", "POD Closure Management", "POD Collection TAT (%)",
       "Ensure PODs are collected within 48 hours of delivery.", "0.35", "Dashboard / MIP",
       "0.8", "0.85", "0.9", "0.95", "1.0"],
      ["Process", "POD Documentation Management", "POD First-Time-Right Rate (%)",
       "Ensure POD submissions are complete and accurate on the first submission.", "0.4",
       "Audit / Reconciliation", "0.8", "0.85", "0.9", "0.95", "1.0"],
      ["Process", "Delivery Coordination & Exception Resolution", "Delivery Exception Resolution Rate (%)",
       "Ensure BR POC follow-ups and vehicle-rejection cases are resolved within the defined SLA.", "0.15",
       "Email / MIP / Communication Channel", "0.8", "0.85", "0.9", "0.95", "1.0"],
      ["Process", "POD & Exception Compliance", "POD Process Compliance Rate (%)",
       "Ensure 100% of shipments are handled in accordance with the defined POD collection and " +
         "rejection-handling SOPs.", "0.1", "Email / MIP / Training & Meetings",
       "0.8", "0.85", "0.9", "0.95", "1.0"]
    ]},
    {"team": "Open Marketplace - Control Tower", "group": "", "sheet": "Marketplace - Control Tower (In",
     "name": "AISHWARYA KARANAM", "designation": "Executive", "extra": "", "kpis": [
      ["Process", "Payment Release Management", "Timely Payment Release Rate (%)",
       "Ensure payments are released within 5 days of delivery in accordance with the defined SOP.", "0.3",
       "Dashboard / MIP", "0.8", "0.85", "0.9", "0.95", "1.0"],
      ["Process", "QC & Settlement Management", "QC & Settlement Accuracy Rate (%)",
       "Ensure QC reports, debit notes, and settlements are processed accurately and within the defined " +
         "timeline.", "0.4", "Audit / Reconciliation", "0.8", "0.85", "0.9", "0.95", "1.0"],
      ["Process", "Dispute & Payment Resolution", "Dispute & Follow-Up Resolution Rate (%)",
       "Ensure disputes and payment reminders are managed and resolved within the defined SLA.", "0.2",
       "Email / MIP / Communication Channel", "0.8", "0.85", "0.9", "0.95", "1.0"],
      ["Process", "Settlement Process Compliance", "QC & Settlement SOP Compliance Rate (%)",
       "Ensure 100% of transactions are executed in accordance with the defined QC, dispute, and " +
         "settlement SOPs.", "0.1", "Email / MIP / Training & Meetings", "0.8", "0.85", "0.9", "0.95", "1.0"]
    ]},
    {"team": "Open Marketplace - Control Tower", "group": "", "sheet": "Marketplace - Control Tower (In",
     "name": "MEGARAJ", "designation": "Senior Executive", "extra": "", "kpis": [
      ["Process", "POD Closure Management", "POD Collection TAT (%)",
       "Ensure at least the defined percentage of PODs are collected within 48 hours of delivery.", "0.35",
       "Dashboard / MIP", "0.8", "0.85", "0.9", "0.95", "1.0"],
      ["Process", "POD Documentation Management", "POD First-Time-Right Rate (%)",
       "Ensure at least the defined percentage of POD submissions are complete and accurate on the first " +
         "submission.", "0.4", "Audit / Reconciliation", "0.8", "0.85", "0.9", "0.95", "1.0"],
      ["Process", "Delivery Coordination & Exception Resolution", "Delivery Exception Resolution Rate (%)",
       "Ensure at least the defined percentage of BR POC follow-ups and vehicle-rejection cases are " +
         "resolved within the defined SLA.", "0.15", "Email / MIP / Communication Channel",
       "0.8", "0.85", "0.9", "0.95", "1.0"],
      ["Process", "POD & Exception Compliance", "POD Process Compliance Rate (%)",
       "Ensure 100% of shipments are handled in accordance with the defined POD collection and " +
         "rejection-handling SOPs.", "0.1", "Email / MIP / Training & Meetings",
       "0.8", "0.85", "0.9", "0.95", "1.0"]
    ]},
    {"team": "Open Marketplace - Control Tower", "group": "", "sheet": "Marketplace - Control Tower (In",
     "name": "ARVIND JAKKULA", "designation": "Executive", "extra": "", "kpis": [
      ["Process", "In-Transit Delivery Management", "On-Time Transit Completion Rate (%)",
       "Ensure at least the defined percentage of shipments reach the buyer location within the planned " +
         "transit window.", "0.5", "Dashboard / MIP", "0.8", "0.85", "0.9", "0.95", "1.0"],
      ["Process", "Shipment Visibility & Monitoring", "Tracking Accuracy Rate (%)",
       "Ensure at least the defined percentage of shipments are accurately monitored through Mobile SIM / " +
         "FASTag without tracking blind spots.", "0.3", "Audit / Reconciliation",
       "0.8", "0.85", "0.9", "0.95", "1.0"],
      ["Process", "Buyer Coordination & Delay Management", "Pre-Arrival & Delay Resolution Rate (%)",
       "Ensure at least the defined percentage of buyer notifications and shipment-delay cases are handled " +
         "within the defined SLA.", "0.1", "Email / MIP / Communication Channel",
       "0.8", "0.85", "0.9", "0.95", "1.0"],
      ["Process", "In-Transit SOP Compliance", "Transit Process Compliance Rate (%)",
       "Ensure 100% of shipments are managed in accordance with the defined tracking and escalation SOPs.",
       "0.1", "Email / MIP / Training & Meetings", "0.8", "0.85", "0.9", "0.95", "1.0"]
    ]}
  ]
};
