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
