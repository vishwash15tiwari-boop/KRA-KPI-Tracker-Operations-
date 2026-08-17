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
