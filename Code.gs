/* ============================================================================
 * Performance Tracker — Individual KRA / KPI Performance Platform
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

var APP_NAME = 'Performance Tracker';
/* PROPERTY KEYS — deliberately still PERFORMOS_*.  These are not display text:
 * PERFORMOS_DB_ID is the only pointer to the backend spreadsheet and
 * PERFORMOS_ADMINS is the break-glass admin list, so renaming either would
 * make the app create a fresh empty database and lock every account out.
 * Same for the PERFORMOS_SEEDED flag further down. Leave all three alone. */
var PROP_DB = 'PERFORMOS_DB_ID';
var PROP_ADMINS = 'PERFORMOS_ADMINS';
var PROP_OPEN = 'PERFORMOS_OPEN_ACCESS';
var SOURCE_SHEET_ID = '1c0_pP4Mmye5s5D_vzoxrvJ-utkLb6JhD69TvvOBbjoo';

/* ACHIEVEMENTS SOURCE — "MM_CT Dashboard V1", owned by anoj.sk@recykal.com.
 * Raw operational rows that actuals are aggregated FROM; like the KRA/KPI
 * workbook this is read-only to us and never written back to. */
var SHIPMENTS_SHEET_ID = '1JCM55z-FaTCUJk0oNxbyHokPQBIsq3DlUZW3Rsf9GhI';
/* TARGET SOURCE — "Target Sheet", owned by vishwash.tiwari@recykal.com. The
 * per-individual monthly targets that are typed by hand (New Seller
 * Acquisition, GMV in Cr), on its Metals and Plastics tabs. Read-only to us,
 * like every other source.
 *
 * THIS IS THE ONLY SOURCE OF TARGETS.  MM_CT's Raw_POC_Targets tab also holds
 * columns called "New Seller Onboarding Tgt" and "GMV_Cr (Target)", and it is
 * in a far more convenient POC-keyed layout — but the KRA owner has ruled it
 * out as a target source. Do not import targets from it, however tempting the
 * layout is; two sources of a number that decides someone's rating is one too
 * many. Its ACHIEVED columns remain fair game for achievements. */
var TARGETS_SHEET_ID = '1AWHM6Cmtf0hFkdQtzlryVw0pRTzehiJ-u-yNjQbTFTc';

/* THE OMP TRACKER — who on Control Tower owns which shipment.
 *
 * The OMP_TRACKER tab carries a 'Control - POC' column assigning shipments to
 * the Control Tower team. It is the ATTRIBUTION, not the measurement: the
 * state of each shipment is read from MM_CT, which is the live one. Joining
 * the two is the whole job, and which key they join ON is the first thing to
 * settle — describeOmpTracker() prints both sides' columns with letters so
 * that can be decided by looking rather than by assuming. */
var OMP_TRACKER_SHEET_ID = '15hAyV4C2DQEkGPOTcTmXfAuyQ2Y8Wvlu7yb5Fzar8Xw';
var OMP_TRACKER_TAB = 'OMP_TRACKER';
var SHIPMENTS_TAB = 'Raw_Shipments';
/* TARGET SHEET — "Target Sheet", owned by vishwash.tiwari@recykal.com. Holds the
 * per-individual monthly targets that are TYPED IN (New Seller Acquisition,
 * GMV in Cr). The three share-of-a-count KRAs are not in here; those are
 * derived — see DERIVED_BASE below. */
var TARGET_SHEET_ID = '1AWHM6Cmtf0hFkdQtzlryVw0pRTzehiJ-u-yNjQbTFTc';
/* A cancelled shipment did not happen, so counting it would credit or penalise
 * work nobody did. Kept as a named list so the rule is visible and editable
 * rather than buried in a filter expression. */
var SHIPMENTS_EXCLUDE_STATUS = ['cancelled'];
function shipmentExcluded_(status) {
  var v = String(status == null ? '' : status).trim().toLowerCase();
  return SHIPMENTS_EXCLUDE_STATUS.indexOf(v) >= 0;
}

/* ------------------------------------------------------------------ SCHEMA --
 * One tab per table. Column order is the contract: append, never reorder. */
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
/* THE NUMERIC TARGET, which is NOT the same thing as the five bands.
 *
 * For KPIs like "Monthly Target Achievement (%)" the ladder is a RATIO —
 * 0.6 / 0.75 / 0.9 / 1.0 / 1.05 — so the recorded actual is achieved ÷ target,
 * and the target itself is the denominator, not a band. Putting a seller count
 * or a GMV figure into t1..t5 would silently turn a ratio ladder into a count
 * ladder and score everyone wrongly, so it lives here instead.
 *
 *   source  'target_sheet' typed by hand in the Target Sheet
 *           'derived'      computed by a rule below, from source data
 *           'manual'       entered in this app
 *   rule / basis_value record HOW a derived number was reached, so a person
 *   can see why their target is what it is rather than being handed a number. */
SCHEMA[T.PLAN]      = ['id', 'employee_id', 'kpi_id', 'period_id', 'target_value', 'unit',
                       'source', 'rule', 'basis_value', 'updated_by', 'updated_at'];
SCHEMA[T.SETTINGS]  = ['key', 'value'];

/* Columns whose values are prose and must be pinned to plain text before they
 * are written.  setValues() hands the string to Sheets, which happily parses
 * "August 2026" as a DATE — so the cell stops being text, the next read_()
 * returns a Date object, and jsonSafe_ ships it to the client as
 * "2026-07-31T18:30:00.000Z" (midnight IST on the 1st, in UTC).  The first
 * request after a seed looked fine only because the model was still being
 * built from _CACHE, which held the original string. */
var TEXT_COLS = {};
TEXT_COLS[T.PERIODS] = ['id', 'name'];

/* ==========================================================================
 * READING THE TARGET SHEET
 *
 * Metals and Plastics hold the same information in DIFFERENT columns, so
 * everything below is located by header text and never by a fixed index:
 *
 *   Metals    r2  c0,c1 METALS      c3 JUNE  c5 JULY  c7 AUGUST  c9 SEPTEMBER
 *             r3  c1 EMPLOYEE NAME  c2 KRA   then Target/Achievement pairs
 *   Plastics  r2  c1 PLASTICS       c4 JUNE  c6 JULY  c8 AUGUST  c10 SEPTEMBER
 *             r3  c2 EMPLOYEE NAME  c3 KRA   c1 carries SUPPLY / DEMAND
 *
 * The employee name appears once per block and is blank on the rows beneath,
 * so it is carried down.  A month's Target and Achievement are the month
 * column and the one to its right.
 * ======================================================================== */
var TARGET_TABS = ['Metals', 'Plastics'];
var FY_START_YEAR = 2026;              /* April 2026 - March 2027 */
var MONTH_COLUMN_NAMES = ['JANUARY', 'FEBRUARY', 'MARCH', 'APRIL', 'MAY', 'JUNE', 'JULY',
                          'AUGUST', 'SEPTEMBER', 'OCTOBER', 'NOVEMBER', 'DECEMBER'];
/* The tabs name a month but never a year, so the financial year supplies it:
 * April-December are FY_START_YEAR, January-March the year after. */
function periodIdForMonthName_(name) {
  var i = MONTH_COLUMN_NAMES.indexOf(String(name || '').trim().toUpperCase());
  if (i < 0) return null;
  var month = i + 1;
  var year = month >= 4 ? FY_START_YEAR : FY_START_YEAR + 1;
  return 'per_' + year + '-' + (month < 10 ? '0' : '') + month;
}
/* Values arrive in three shapes across the two tabs: a plain number (0.66), a
 * formatted currency string ("₹4.11 Cr"), and an em dash or blank for "none".
 * A dash is NOT zero — it means no target was set. */
function parseTargetValue_(v) {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return null;
  if (typeof v === 'number') return isFinite(v) ? v : null;
  var t = String(v).trim();
  if (t === '' || /^[—–\-.·]+$/.test(t) || /^n\/?a$/i.test(t)) return null;
  /* A comma is a THOUSANDS SEPARATOR inside the number, so it has to be
     deleted rather than turned into a space: "₹1,234.5 Cr" split on spaces
     matches "1" and stops, reading a crore figure as one-thousandth of itself. */
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
/** Parse one target tab into { header, months, rows[], warnings[] }.
 *  rows: { rowNo, name, subGroup, kra, cells: { period_id: {target, achievement} } } */
function readTargetTab_(sh) {
  var out = { tab: sh.getName(), months: [], rows: [], warnings: [] };
  var lastR = sh.getLastRow(), lastC = sh.getLastColumn();
  if (lastR < 3 || lastC < 3) { out.warnings.push('tab is too small to hold a table'); return out; }
  var grid = sh.getRange(1, 1, lastR, lastC).getValues();
  function cell(r, c) {
    var v = (grid[r] || [])[c];
    return v === null || v === undefined ? '' : String(v).replace(/\s+/g, ' ').trim();
  }
  /* the header row is the one that names the employee column */
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
  /* months live on the row above, at the same column as their Target */
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
  /* a sub-group column (SUPPLY / DEMAND) sits left of the name on Plastics */
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
    if (nm) curName = nm;                       /* carried down the block */
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

/* ==========================================================================
 * DERIVED TARGETS — three KRAs whose target is not typed by anyone, but is a
 * percentage of something that happened in the source data. Stated by the KRA
 * owner and effective from June 2026 onward:
 *
 *   Transaction from Existing Sellers        50% of the sellers onboarded up
 *                                            to the END OF LAST MONTH
 *   Transaction from New Onboarded Sellers   20% of the sellers onboarded
 *                                            DURING THIS MONTH
 *   Retention of Existing Transacted Sellers 70% of the sellers who
 *                                            TRANSACTED LAST MONTH
 *
 * Two decisions worth stating, because they move people's ratings:
 *
 *  1. ROUNDING IS UP.  Each rule reads "at least N% must transact", and 50% of
 *     7 sellers is 3.5 — 3 of 7 is 42.9%, which does not clear the bar. So the
 *     target is ceil(), never round().
 *  2. AN UNKNOWN BASIS YIELDS NO TARGET, NOT ZERO.  If the source data has not
 *     arrived, returning 0 would hand out a target that is met by doing
 *     nothing. null means "cannot be computed yet" and the UI says so.
 * ======================================================================== */
var DERIVED_FROM_PERIOD = 'per_2026-06';    /* the rules start in June 2026 */

/* The percentage is per TEAM as well as per KRA, because the same KRA name
 * carries a different bar in different teams — Metal's retention goal is 50%
 * because Metal handles supply AND demand, Plastic's is 70% because Plastic
 * handles supply only.  The workbook's own goal text agrees with both.  A rule
 * with `team: null` applies to any team.
 *
 * TEAM-SPECIFIC RULES MUST COME FIRST — the first match wins, so a rule that
 * names a team has to be seen before a team-agnostic one for the same KRA. */
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
  /* 20% in both Metal and Plastic, so this one names no team */
  { key: 'new_buyers', team: null,
    match: /transaction\s+from\s+new\s+onboarded\s+buyers/i,
    pct: 0.20, basis: 'buyers_onboarded_this_month',
    rule: '20% of buyers onboarded during this month' }
];
/* A KRA that matches a rule whose team does NOT match yields no rule at all,
 * rather than falling through to somebody else's percentage. */
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
/* Periods are ids like per_2026-06, which sort lexically in date order. */
function periodAtOrAfter_(periodId, fromId) {
  return String(periodId) >= String(fromId);
}
/** The target for one derived KRA in one month.
 *  basis: { onboarded_this_month, onboarded_cumulative_prev, transacted_prev_month }
 *  Returns null when the rule does not apply or the basis is not known yet. */
function derivedTarget_(kraName, periodId, basis, teamName) {
  var r = derivedRuleFor_(kraName, teamName);
  if (!r) return null;
  if (String(periodId) === PERIOD_YTD) return null;      /* YTD spans months */
  if (!periodAtOrAfter_(periodId, DERIVED_FROM_PERIOD)) return null;
  var base = basis ? basis[r.basis] : null;
  base = num_(base);
  if (base === null || base < 0) return null;            /* unknown, not zero */
  return { value: Math.ceil(base * r.pct), pct: r.pct, rule: r.rule,
           basis_key: r.basis, basis_value: base, key: r.key };
}

/* YEAR TO DATE — a pseudo-period id.  Selecting it spans every month of the
 * financial year that has actually opened and reports, per KPI, the MEAN of
 * the monthly levels that were awarded.
 *
 * Why a mean of levels rather than a re-resolve against summed actuals: the
 * ladders are MONTHLY targets — "≤ 19 Days", "≥ ₹9 Cr" — so adding twelve
 * months of actuals and testing that against a one-month ladder would be
 * nonsense.  Averaging the ratings a person actually earned each month is the
 * only reading that survives ladders like "TGT-20 Days" and the ordinal ones.
 *
 * Months with no recorded actual are LEFT OUT of the mean rather than counted
 * as zero, for the same reason unscored KPIs leave the rollup denominator —
 * so a row also reports months_scored / months_total and the reader can see
 * how thin the average is. */
var PERIOD_YTD = 'ytd';
function ytdPeriodIds_(periods) {
  return periods.filter(function (p) { return String(p.status) !== 'upcoming'; })
                .map(function (p) { return String(p.id); });
}
/* Writes must name a real month.  Silently redirecting a save to the latest
 * month would put a target or an actual somewhere nobody chose. */
function requireRealPeriod_(id) {
  if (String(id) === PERIOD_YTD) {
    throw new Error('Year to date is a read-only rollup across months. ' +
      'Pick a specific month before saving.');
  }
  return String(id);
}

var MONTH_NAMES_ = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
                    'August', 'September', 'October', 'November', 'December'];
/* The id ("per_2026-08") carries the month unambiguously; the stored name may
 * have been mangled into a date, and reading the month back off that date is
 * timezone-dependent.  So derive the label from the id and trust nothing else. */
function periodLabel_(p) {
  var m = String(p.id || '').match(/(\d{4})-(\d{2})$/);
  if (m) return MONTH_NAMES_[Number(m[2]) - 1] + ' ' + m[1];
  if (p.name instanceof Date) return MONTH_NAMES_[p.name.getMonth()] + ' ' + p.name.getFullYear();
  return String(p.name == null ? (p.id || '') : p.name);
}

/* ----------------------------------------------------------------- SERVING -- */
/* FAVICON — replaces the default Apps Script icon in the browser tab.
 * setFaviconUrl needs a fetchable URL, so unlike the sidebar mark (which is
 * inlined as a data URI) this one is referenced from the Recykal site's own
 * CDN.  If that asset is ever moved the tab quietly falls back to the default
 * icon — the app itself is unaffected. */
var FAVICON_URL = 'https://framerusercontent.com/images/KAa6VgdvV8bLALIzNxZGRkpVHbk.png';
/* ==========================================================================
 * DIAGNOSTICS OVER HTTP
 *
 * The dry runs are the main way this app is checked, and until now they could
 * only be read by opening the Apps Script editor, picking a function from the
 * Run dropdown and copying the log. That is fine for the person who wrote it
 * and miserable for anyone else, so the same functions are reachable as
 *
 *     <the web app URL>?diag=previewTargetImport
 *
 * returning plain text.
 *
 * THREE THINGS GUARD IT, and none of them is optional:
 *
 *   1. AN ALLOW LIST, not a blocklist. Only the names below can be called.
 *      Anything not on it is refused by name. A blocklist would mean every
 *      future function is exposed by default, including the next writer
 *      somebody adds.
 *
 *   2. EVERY NAME ON IT IS READ-ONLY. importTargets, applyRatingScale and
 *      refreshFrameworkFromSource are deliberately absent and MUST STAY
 *      ABSENT — a URL that rewrites 166 ratings is one careless bookmark, or
 *      one prefetching browser extension, away from doing it unasked. A GET
 *      must never change data.
 *
 *   3. IT NEEDS ADMIN. The output names people, targets and achievements, so
 *      it is behind the same session check as everything else and requires
 *      the admin permission rather than mere view.
 *
 * Note that this runs as the deploying user, like the rest of the app, so the
 * source workbooks are read with those credentials — the output is exactly
 * what the editor would print. */
var DIAG_FUNCTIONS_ = {
  /* dry runs — every one of these reports and writes nothing */
  previewTargetImport: previewTargetImport,
  previewRatingScale: previewRatingScale,
  previewAchievementJoin: previewAchievementJoin,
  previewDSO: previewDSO,
  peekTimeline: peekTimeline,
  previewCollectionDays: previewCollectionDays,
  previewFrameworkRefresh: previewFrameworkRefresh,
  /* inventories */
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
  /* diagnostics */
  whoAmI: whoAmI,
  selfTest: selfTest,
  /* takes &arg=<name> */
  explainPerson: explainPerson,
  explainCoverage: explainCoverage,
  /* the DRY RUN only. cleanupLeaverRows() deletes rows and must never be
     reachable from a URL — see the allow-list note above. */
  previewLeaverCleanup: previewLeaverCleanup,
  previewPlasticDSO: previewPlasticDSO,
  /* the DRY RUN only. importDsoAchievements() writes performance rows. */
  previewDsoAchievements: previewDsoAchievements,
  explainDso: explainDso,
  /* the DRY RUN and the profiler only. importZohoReport() writes a tab. */
  previewFeeds: previewFeeds,
  profileOnboarding: profileOnboarding,
  previewOnboardingAttribution: previewOnboardingAttribution,
  previewSellerTat: previewSellerTat,
  previewZohoReport: previewZohoReport,
  describeZohoTab: describeZohoTab,
  describeMetaBuyer: describeMetaBuyer,
  describeMetaSeller: describeMetaSeller,
  /* the DRY RUN only. importMetabase() writes tabs. */
  previewMetabase: previewMetabase,
  explainOnboardingOwners: explainOnboardingOwners,
  explainTeam: explainTeam,
  explainOMP: explainOMP,
  explainCollectionsTeam: explainCollectionsTeam,
  explainOnboardingTeam: explainOnboardingTeam,
  describeOmpTracker: describeOmpTracker,
  listTabsOmpTracker: listTabsOmpTracker,
  profileOmpTracker: profileOmpTracker,
  /* the DRY RUN only. importOmpTransit() writes performance rows. */
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
  /* One optional argument, and it is only ever a NAME being looked up in the
     database — never a path, a sheet id or anything that widens what the
     function can reach. The allow list still decides what may run at all. */
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

/* -------------------------------------------------------------- REPOSITORY --
 * Each tab is a table; column order is the contract (append, never reorder).
 *
 * Everything is read ONCE per request into _CACHE and written back ONCE per
 * table by commit_(). This is not an optimisation, it is what makes the app
 * work: Apps Script charges a round trip per getValues/setValues and caps an
 * execution at six minutes. The earlier version re-read a whole table inside
 * every upsert AND re-stamped the header row on every tab_() call, so a full
 * import of 208 assignments cost thousands of sheet operations and could not
 * finish. Reading 11 tables and writing back the few that changed costs a
 * couple of dozen.
 *
 * Callers mutate the objects read_() hands back and then upsert_() them; since
 * those objects ARE the cache, that stays consistent within a request.
 * ------------------------------------------------------------------------- */
var _SS = null, _CACHE = {}, _DIRTY = {}, _TABS = {};

function ss_() {
  if (_SS) return _SS;
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty(PROP_DB);
  /* AN ID THAT WILL NOT OPEN IS A HARD FAILURE, NEVER A NEW DATABASE.
   *
   * This line used to read  catch (e) {}  and fall through to create(). One
   * transient Drive error was then enough to detach the app from its data
   * PERMANENTLY: it minted an empty backend, overwrote PROP_DB — the only
   * pointer there is — seeded the new file and stamped PERFORMOS_SEEDED, so
   * every later run agreed the empty sheet was the database. Nothing was
   * deleted and nothing said anything. It had happened at least three times
   * before anyone noticed, leaving three orphaned backends in Drive.
   *
   * An outage is recoverable in five minutes. A silently swapped database is
   * only recoverable if somebody happens to remember which file it was. So
   * this throws, and names the id it could not open. */
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
  /* No id at all — a genuine first run, and the only time creating is right. */
  var bound = null;
  try { bound = SpreadsheetApp.getActiveSpreadsheet(); } catch (e) {}
  _SS = bound || SpreadsheetApp.create(APP_NAME + ' — Backend');
  props.setProperty(PROP_DB, _SS.getId());
  return _SS;
}

/* Stamps the header only when the sheet is new or its first cell is wrong —
   re-writing it on every access was three wasted round trips per upsert. */
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

/* Writes every changed table back in one setValues each, then clears whatever
   the table shrank past. MUST be called before an API function returns, or the
   request's changes are discarded. */
function commit_() {
  var names = Object.keys(_DIRTY), written = 0;
  names.forEach(function (name) {
    var rows = _CACHE[name] || [], head = SCHEMA[name], sh = tab_(name);
    var need = rows.length + 1;
    if (sh.getMaxRows() < need) sh.insertRowsAfter(sh.getMaxRows(), need - sh.getMaxRows());
    /* pin prose columns to plain text BEFORE writing, or Sheets reinterprets them */
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

/* Resolves the period an API call should act on. Nothing may fall back to an
   empty period: targets written with period_id "" belong to no month, are
   invisible in every view, and quietly make a KPI look like it has no ladder. */
function periodOr_(id) {
  if (id) return String(id);
  var set = read_(T.SETTINGS).filter(function (r) { return r.key === "current_period"; })[0];
  if (set && set.value) return String(set.value);
  var ps = read_(T.PERIODS).sort(function (a, b) { return num_(a.sort) - num_(b.sort); });
  if (ps.length) return String(ps[ps.length - 1].id);
  throw new Error("No period is defined, so there is nothing to write targets against.");
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
/* A band comparison has to tolerate floating-point error, because the actual on
 * a ratio ladder is a DIVISION and the bands are exact decimals.
 *
 *   5.85 Cr against a 6.50 Cr target is exactly 90%, but 5.85/6.5 evaluates to
 *   0.8999999999999999, which is NOT >= 0.9. Without this the person scores 1
 *   instead of 2 for hitting a threshold precisely — and nothing on screen
 *   would explain why.
 *
 * The tolerance is relative, so it scales with the band, and at 1e-9 it is far
 * below any difference that could matter to a target in crore, days or counts. */
function bandEps_(b) { return Math.max(1e-9, Math.abs(b) * 1e-9); }
function atLeast_(a, b) { return a >= b - bandEps_(b); }
function atMost_(a, b) { return a <= b + bandEps_(b); }

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
  auditor: ['view', 'export'],
  /* holds no permission at all — the fallback for an email we do not know */
  no_access: []
};
/* Addresses typed or pasted into a sheet cell pick up stray leading and trailing
   spaces, non-breaking spaces, and a mailto: prefix when Sheets auto-links them.
   A single trailing space in USERS.email was enough to deny a legitimate admin,
   so every comparison goes through here rather than comparing raw cell text. */
function email_(v) {
  return String(v == null ? '' : v).replace(/^\s*mailto:/i, '').replace(/\s+/g, '').toLowerCase();
}
/* BREAK-GLASS ADMINS — a comma or space separated list in the script property
   PERFORMOS_ADMINS, e.g. "someone@example.com, someone.else@example.com".
   Anyone listed resolves to super_admin regardless of what the sheet says.

   Why this exists rather than relying on the USERS tab alone: with the
   no_access fallback below, one wrong cell locks EVERY account out of the app,
   including whoever has to fix it — and sheet cells are easy to get subtly
   wrong. An address can land in the neighbouring column, Sheets can turn it
   into a people chip whose getValues() reads back as an empty string, or it can
   carry a non-breaking space that looks like nothing at all. A script property
   is plain text, sits in Project Settings where it is easy to check, and Sheets
   cannot reshape it. Keep at least one address here permanently. */
/* UAT / OPEN ACCESS — while the script property PERFORMOS_OPEN_ACCESS is set,
 * ANY signed-in visitor resolves to super_admin.  It exists so reviewers can
 * open a preview deployment without someone first adding their address to the
 * sheet, and it deliberately has three properties:
 *
 *   1. OFF unless the property is set — the default is the strict gate.
 *   2. FAILS CLOSED — anything unparseable counts as off, never as on.
 *   3. EXPIRES — set it to an ISO date ("2026-09-16") and it closes itself on
 *      that day.  Set it to "always" to disable the expiry, which is the
 *      riskier choice and therefore has to be typed out.
 *
 * While it is on, every visitor is an administrator over all 38 scorecards, so
 * the UI shows a standing banner.  Clear the property before the web app is
 * circulated beyond the review group. */
function openAccessState_() {
  var raw = '';
  try { raw = String(PropertiesService.getScriptProperties().getProperty(PROP_OPEN) || '').trim(); }
  catch (e) {}
  if (!raw) return { on: false };
  if (/^(always|true|on|yes)$/i.test(raw)) return { on: true, until: null, raw: raw };
  var t = Date.parse(raw);
  if (isNaN(t)) return { on: false, raw: raw, bad: true };   /* fail closed */
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
function resolveSession_(viewAs) {
  /* every entry point resolves the session first, so the seed has to be in
     place by now or the role list — and therefore "view as" — comes back empty */
  ensureSeeded_();
  var emps = read_(T.EMPLOYEES), users = read_(T.USERS), email = currentEmail_();

  /* IDENTITY, in order of authority:
       1. a USERS row carrying this email — the only way to hold an admin role;
       2. an EMPLOYEES row carrying this email — their own scorecard only;
       3. an email we do not know — no access.
     Step 3 used to be inverted: an unrecognised email became super_admin. With
     the web app published to the whole DOMAIN that made every colleague who
     opened the link a super admin over all 38 scorecards. USERS was read on
     every request but never compared against the session, so it only ever fed
     the "view as" picker and had no bearing on what anyone could actually do. */
  var acct = null, me = null;
  if (email) {
    users.forEach(function (u) { if (email_(u.email) === email) acct = u; });
    emps.forEach(function (e) { if (email_(e.email) === email) me = e; });
  }
  /* a USERS row may name the employee it belongs to, which is how an admin who
     is also appraised gets their own scorecard in scope */
  if (acct && acct.employee_id && !me) me = idx_(emps)[acct.employee_id] || null;

  var role = acct ? String(acct.role_id || 'no_access')
           : me   ? (me.status === 'lead' ? 'team_leader' : 'employee')
           :        'no_access';
  if (!ROLE_PERMS[role]) role = 'no_access';   /* a typo in the sheet must not widen access */
  /* the property list outranks the sheet, so a bad cell can never lock out an
     administrator who is named there */
  if (email && bootstrapAdmins_().indexOf(email) >= 0) role = 'super_admin';
  /* UAT mode: everyone who can open the link is an admin.  Requires a signed-in
     identity even so — an empty email still resolves to no_access. */
  var open_ = openAccessState_();
  if (open_.on && email) role = 'super_admin';

  var s = { email: email || '(unknown)',
            name: (acct && acct.name) || (me && me.name) || email || 'Unrecognised user',
            role_id: role,
            employee_id: (acct && acct.employee_id) || (me && me.id) || '' };
  s.admin = can_(s, 'admin');
  s.can_switch = s.admin;
  /* USERS lists colleagues' addresses and roles, so it goes only to someone who
     can actually use the "view as" picker */
  s.users = s.can_switch ? users : [];
  /* the client renders a standing banner off this, so the mode is never silent */
  s.open_access = open_.on ? (open_.until || 'always') : null;

  if (viewAs && s.can_switch) {
    var u = users.filter(function (x) { return String(x.id) === String(viewAs); })[0];
    if (u) {
      s.role_id = String(u.role_id || 'no_access');
      if (!ROLE_PERMS[s.role_id]) s.role_id = 'no_access';
      s.employee_id = u.employee_id || ''; s.name = u.name;
    }
  }
  /* The client used to keep its own copy of ROLE_PERMS and its own copy of the
     scope rules, so editing one table silently desynchronised the buttons from
     what the server would actually allow. Ship the resolved permissions and
     the scope shape instead — the server stays the only definition. */
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
  /* self-heal: rewrite any name a previous save turned into a date.  These are
     the cache objects, so the repair is picked up by commit_() below. */
  periods.forEach(function (p) {
    var want = periodLabel_(p);
    if (String(p.name) !== want) { p.name = want; _DIRTY[T.PERIODS] = true; }
  });
  /* SELF-HEAL: a month that has arrived must not still be 'upcoming'.
   *
   * The seed hardcoded September 2026 as upcoming. On 12 September that was
   * simply false, and the consequences were invisible rather than obvious:
   * ytdPeriodIds_ drops upcoming months, so September vanished from the YTD
   * span, from every per-table month dropdown, and from the year's totals —
   * while its targets and achievements sat imported in the database. A stale
   * status does not look like a bug, it looks like missing data.
   *
   * Only 'upcoming' is healed. 'locked' is a deliberate act by an admin closing
   * a month off, and must never be reopened by the calendar. */
  var nowD = new Date(), nowM = nowD.getMonth() + 1;
  /* padded inline rather than via pad2_, which lives in the achievements
     section — buildModel_ is grabbed on its own by two test suites and should
     not reach across the file for two characters */
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
  /* Leavers are filtered at the MODEL boundary, not deleted from the tables —
     see EMPLOYEE_LEAVERS. Their assignments go with them, so no orphan row
     reaches a scorecard, a count or a chart. */
  var allEmps = read_(T.EMPLOYEES);
  var emps = allEmps.filter(function (e) { return !isLeaver_(e.name); });
  var goneIds = {};
  allEmps.forEach(function (e) { if (isLeaver_(e.name)) goneIds[String(e.id)] = true; });
  var kras = read_(T.KRAS), kpis = read_(T.KPIS);
  var assigns = read_(T.ASSIGN).filter(function (a) {
    return String(a.status || 'Active') !== 'Inactive' && !goneIds[String(a.employee_id)]; });
  /* one month, or every opened month when the pseudo-period YTD is selected */
  var spanIds = (String(eff) === PERIOD_YTD) ? ytdPeriodIds_(periods) : [String(eff)];
  var ytd = String(eff) === PERIOD_YTD;
  var inSpan = {};
  spanIds.forEach(function (id) { inSpan[id] = true; });
  var targets = read_(T.TARGETS).filter(function (t) { return !!inSpan[String(t.period_id)]; });
  var perf = read_(T.PERF).filter(function (p) { return !!inSpan[String(p.period_id)]; });
  /* the numeric target, which is not a band — see SCHEMA[T.PLAN] */
  var allPlans = read_(T.PLAN);
  var plans = allPlans.filter(function (p) { return !!inSpan[String(p.period_id)]; });
  /* Whether a person's KPI is TARGET-DRIVEN at all, across every month rather
     than only the span. The scoring guard below needs it: the answer decides
     what a bare recorded number means. */
  var planEver = {};
  allPlans.forEach(function (p) {
    if (num_(p.target_value) === null) return;
    planEver[String(p.employee_id) + '|' + String(p.kpi_id)] = true;
  });

  var tgtBy = {}, perfBy = {}, planBy = {};
  targets.forEach(function (t) { tgtBy[t.period_id + '|' + t.employee_id + '|' + t.kpi_id] = t; });
  perf.forEach(function (p) { perfBy[p.period_id + '|' + p.employee_id + '|' + p.kpi_id] = p; });
  plans.forEach(function (p) { planBy[p.period_id + '|' + p.employee_id + '|' + p.kpi_id] = p; });
  var kpiById = idx_(kpis);   /* was a linear scan per assignment */
  var empById_ = idx_(allEmps), kraById_ = idx_(kras);

  /* HOW AN ACHIEVED VALUE AGGREGATES ACROSS MONTHS
 *
 * Not everything sums. 9 new sellers in June plus 6 in July is 15 sellers, and
 * 4.11 crore plus 5.00 crore is 9.11 crore — those are QUANTITIES. But a DSO of
 * 20 days in June and 22 in July is not 42 days, and a 90% rate followed by an
 * 80% rate is not 170%; those are RATES and DURATIONS, and they average.
 *
 * Summing a duration would be spectacular nonsense on a scorecard — a
 * five-month DSO of "104 days" against a 20-day target — so the two are
 * separated here rather than everything being summed for convenience.
 *
 * The KPI's NAME is a poor guide here and must not be the first test.
 * "Monthly Target Achievement (%)" and "Repeat Seller Transaction Rate (%)"
 * both read as percentages, yet what is recorded against them is a crore
 * figure or a seller count — a quantity that sums. Keying off the "%" would
 * average GMV across the year and understate every one of them.
 *
 * What actually settles it is whether a TARGET exists to divide by:
 *
 *   1. a numeric target AND a ratio ladder  -> the recorded value is a
 *      quantity, because the percentage is derived from it. SUM.
 *   2. otherwise, a duration or a rate — a descending ladder (DSO days, a
 *      lower-is-better rate), a days unit, or a name that says days / DSO /
 *      TAT / ageing / rate / %. MEAN.
 *   3. anything else is a count or an amount. SUM.
 *
 * Checked against all 16 ladders in the workbook.
 */
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

/* One scorecard row per assignment, with its bands interpreted.  With a
     single month in the span this is exactly the old behaviour; with several
     it collects a level per month and reports their mean. */
  var rows = [], byEmp = {};
  assigns.forEach(function (a) {
    var kpi = kpiById[a.kpi_id] || {};
    var levels = [], parsed = null, actual = null, manual = null, version = null, status = '';
    /* A target is a MONTHLY quantity, so a span of months carries the sum, not
       the last one: 5 + 7 + 8 new sellers over three months is a target of 20.
       Counting the months it came from as well, because a YTD target built
       from two of four months is not comparable with a full one. */
    var planSum = null, planUnit = '', planSrc = '', planRule = '', planMonths = 0;
    var ratio = null;   /* actual / target, when that is what was scored */
    var actualNote = '';   /* how the achieved figure was arrived at, if stated */
    var noTargetMonths = 0;   /* recorded, but with no target to divide by */
    /* Per month, so a table can be sliced to one month on the client instead
       of asking the server again. Only populated for a multi-month span —
       for a single month the row's own target/actual already say it. */
    var monthly = {};
    /* the achieved side, aggregated across the span exactly as the target is */
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
      /* A RATIO LADDER is scored on actual / target, not on the raw actual.
         The ladder now reads 0.8 | 0.9 | 1.0 | 1.1 | 1.2 — percentages of
         target — so comparing 7.19 (crore) against 1.2 would score every GMV
         KPI a 5 regardless of the target. The raw actual is what gets stored
         and shown; only the comparison uses the quotient.
         An absolute ladder (DSO days, PDD crore) is compared directly. */
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
      /* A RATIO LADDER WITH NO TARGET FOR THIS MONTH CANNOT BE SCORED.
       *
       * The Target Sheet carries achievements in months where nobody typed a
       * target — 26 achievements against 19 targets on New Buyer Acquisition.
       * Comparing those raw against 0.8 | 0.9 | 1.0 | 1.1 | 1.2 clears every
       * band, so "5 new buyers" scored a PERFECT 5 in a month with no target
       * at all. Silent, and generous in the worst possible direction.
       *
       * A ratio-shaped ladder with no target is not always wrong, though: the
       * Collections rows use 0.8 | 0.85 | 0.9 | 0.95 | 1 and record the
       * PERCENTAGE itself, by hand, with no target anywhere. Those must still
       * score. planEver separates the two — if this KPI is given a target in
       * ANY month, then a bare number in some other month is a quantity still
       * waiting for its denominator, not a ratio. */
      var targetless = isRatioL && (monthTarget === null || monthTarget === 0) &&
                       act !== null &&
                       !!planEver[String(a.employee_id) + '|' + String(a.kpi_id)];
      if (targetless) noTargetMonths++;
      var lvl = (pr.kind === 'numeric' && !targetless)
        ? levelFromBands_(pr, scored) : (man === null ? null : man);
      if (lvl !== null && lvl !== undefined) levels.push(lvl);
      /* the ladder on show is the most recent month that actually defines one */
      if (t || !parsed) parsed = pr;
      if (t) version = num_(t.version) || 1;
      actual = act; manual = man; status = p ? (p.status || '') : status;
      /* HOW the number was reached, when whatever produced it said so. Carried
         per month as well as on the row, so the per-table month filter shows
         the working for the month on screen and not for some other one. */
      if (p && p.note) {
        actualNote = String(p.note);
        if (monthly[spanIds[i]]) monthly[spanIds[i]].note = actualNote;
      }
    }
    /* ---- the year, as one figure -------------------------------------- */
    var agg = aggKind_(planUnit, kpi.name, parsed, planSum !== null && planSum !== 0);
    var ytdActual = null;
    if (actSum !== null) {
      ytdActual = (agg === 'mean' && actMonths > 0) ? actSum / actMonths : actSum;
      ytdActual = Math.round(ytdActual * 1e10) / 1e10;
    }
    /* A TARGET AGGREGATES THE SAME WAY ITS ACHIEVEMENT DOES.
     *
     * Counts and amounts accumulate — 5 + 7 + 8 new sellers is a target of 20.
     * Durations and rates do NOT: four months of a 5-day DSO target is still a
     * 5-day target, not 20. Summing regardless made the year's target grow one
     * month at a time until anybody would clear it.
     *
     * Found when Plastic DSO landed: the rating said Target 0 (absolute ladders
     * rate on the mean of monthly levels, which was right) while the columns
     * beside it read "target 20 days, achieved 18.7" and scored 107% — a pass
     * and a fail on the same row, from the same numbers. The rating was never
     * wrong; the target it was displayed against was. */
    var planAgg = planSum;
    if (ytd && agg === 'mean' && planSum !== null && planMonths > 0) {
      planAgg = planSum / planMonths;
    }
    /* A YEAR-TO-DATE RATING comes from the year's own achieved against the
     * year's own target — 15 sellers against a target of 20 is 75%, one
     * rating — and NOT from averaging the monthly ratings.
     *
     * Those two differ, and the mean is the weaker of the pair: a month with a
     * target of 1 counts as much as a month with a target of 40, so one easy
     * month can carry a bad year. Summing weights each month by its own size,
     * which is what a year-to-date figure is supposed to mean.
     *
     * It only applies where the year has BOTH a summed target and a ratio
     * ladder. Absolute ladders and hand-awarded KPIs keep the mean of monthly
     * levels, because there is no year-level quotient to compute; ytd_basis
     * says which of the two produced the number. */
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
    /* An override replaces the imported weightage for display AND for the
       weighted rollup, because r.weightage is what both read. The ASSIGNMENTS
       row itself is left alone, so the next import neither fights it nor
       erases it. */
    var ovr = weightOverride_((empById_[a.employee_id] || {}).name,
                              (kraById_[a.kra_id] || {}).name);
    /* A RATE ROW, AND WHY IT NEEDS A UNIT OF ITS OWN.
     *
     * When a KPI has no PLAN target in ANY month and its ladder is a ratio,
     * the stored number IS the rate — that is the planEver rule above, and it
     * is how the Collections percentages and every OMP KPI score.
     *
     * Nothing downstream could tell. plan_unit came from the PLAN row, and a
     * row with no plan had no unit, so fmtTarget fell to its count branch and
     * rendered Math.round(0.87) — a rate of 87% displayed as "1", and 33% as
     * "0". Every OMP figure on the dashboard was one of those two.
     *
     * The condition is EXACTLY the one the scoring used, not an approximation
     * of it: ratio-shaped ladder, and never planned. A ratio-shaped ladder on
     * a KPI that IS planned elsewhere means a bare actual is a quantity still
     * waiting for its denominator — marking that 'ratio' would render 5
     * sellers as 500%.
     *
     * AND parsed IS NULL when an assignment has no TARGETS row in any period, and
     * plenty do. Reading .kind off it threw inside buildModel_, which took
     * apiBootstrap down with it and emptied the whole dashboard on both /dev
     * and /exec — not just the rate rows. aggKind_ two lines up guards for
     * exactly this and that guard should have been copied with the idea. */
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
      /* The denominator, kept apart from bands. Rounded ONLY to stop a float
         sum of crore figures rendering as 4.109999999999999 — and rounded at
         the 10th decimal, not the 4th, because the Target Sheet really does
         hold 8 decimals of a crore (0.35099785) and 4 would silently restate
         someone's GMV target. Float noise lives around the 15th digit, so this
         removes the artefact without touching the data. */
      plan_target: planAgg === null ? null : Math.round(planAgg * 1e10) / 1e10,
      /* 'sum' or 'mean' — the same rule the achievement used, so the two sides
         of the row are always comparable */
      plan_agg: agg,
      plan_unit: planUnit,
      plan_source: planSrc,
      plan_rule: planRule,
      plan_months: ytd ? planMonths : null,
      /* there is no single actual behind a multi-month mean, so do not invent one */
      /* Under YTD this is the year's achieved — SUMMED for a count or an
         amount, AVERAGED for a rate or a duration. It used to be null, on the
         grounds that no single actual sits behind a mean of levels; now that
         the year is rated on its own total, the total is the honest thing to
         show. agg_kind says which of the two it is. */
      actual: ytd ? ytdActual : actual,
      agg_kind: ytd ? agg : '',
      /* months with an achievement but no target — unscoreable, and the row
         must say so rather than looking merely unrecorded */
      no_target_months: noTargetMonths,
      /* { period_id: {target, actual} } across the span, for the per-table
         month filter. Null outside a multi-month span. */
      monthly: spanIds.length > 1 ? monthly : null,
      actual_months: ytd ? actMonths : null,
      ytd_basis: ytdBasis,
      /* what the ladder was actually compared against, when it is not the
         raw actual — so the UI can show "7.19 Cr (111% of target)" */
      ratio: ratio,
      /* the derivation, for a number nobody typed by hand */
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
    ok: true, period_id: eff, ytd: ytd, ytd_periods: ytd ? spanIds : null,
    periods: periods, settings: settings,
    teams: teams, employees: emps, kras: kras, kpis: kpis,
    rows: rows, overalls: overalls,
    audit: read_(T.AUDIT).sort(function (a, b) { return String(b.ts).localeCompare(String(a.ts)); }).slice(0, 40),
    source_sheet_id: SOURCE_SHEET_ID,
    generated_at: nowIso_()
  };
}

/* ------------------------------------------------------------ SCOPE FILTER --
 * buildModel_ assembles the whole period; this projects it down to what one
 * session is allowed to SEE.
 *
 * Why it lives here and not in the client: scope used to gate only writes
 * (requireScope_) and which buttons the UI drew, so the bootstrap response
 * still carried all 38 scorecards.  A team leader could read anyone's rating
 * by navigating to them, and anyone could call apiModel through
 * google.script.run directly.  Hiding it in the UI would not have hidden it in
 * the payload, so the filter belongs on the response.
 *
 * The KRA/KPI catalogue is deliberately NOT filtered — those are shared
 * definitions, not anybody's performance.  The AUDIT trail is, because its
 * entity ids name the people whose targets and actuals were changed.
 * ------------------------------------------------------------------------- */
function visibleEmployees_(m, s) {
  var sc = (s && s.scope) || { kind: 'none' };
  if (sc.kind === 'all') return null;              /* null = see everything */
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
function scopeModel_(m, s) {
  var ok = visibleEmployees_(m, s);
  if (!ok) { m.scoped = false; return m; }
  function keep(id) { return !!ok[String(id)]; }
  /* reassignment, not mutation — m.employees and m.teams ARE the _CACHE arrays,
     so splicing them here would delete rows from the spreadsheet on commit */
  m.employees = (m.employees || []).filter(function (e) { return keep(e.id); });
  m.rows      = (m.rows || []).filter(function (r) { return keep(r.employee_id); });
  var overalls = {};
  Object.keys(m.overalls || {}).forEach(function (id) {
    if (keep(id)) overalls[id] = m.overalls[id];
  });
  m.overalls = overalls;
  /* a team with nobody visible would render as an empty row and an empty bar */
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

/* ------------------------------------------------------------------- API --- */
function apiBootstrap(periodId, viewAs) {
  try {
    var s = resolveSession_(viewAs);
    /* commit_() first: resolveSession_ calls ensureSeeded_(), which fills the
       cache and stamps PERFORMOS_SEEDED, but only commit_() writes the rows.
       Returning before it would leave the flag set and the tables empty. */
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
  /* the model carries every person's scorecard, so this needs the same gate as
     apiBootstrap — google.script.run can be called directly, not only by our UI */
  try {
    var s = resolveSession_();
    if (!can_(s, 'view')) {
      commit_();
      return { ok: false, where: 'apiModel', denied: true,
               error: 'This dashboard is not open to ' + s.email + '.' };
    }
    var m = buildModel_(periodId); commit_(); return jsonSafe_({ ok: true, model: scopeModel_(m, s) }); }
  catch (e) { return { ok: false, error: String(e && e.message || e), where: 'apiModel' }; }
}
function apiPing() { return { ok: true, app: APP_NAME, at: nowIso_() }; }

/* What each header looks like it carries.  Only used to point a human at the
 * right tab — nothing downstream keys off these guesses. */
var COL_HINTS = [
  ['onboarding', /onboard|kyc|vendor|registration|osv|document|activation/i],
  ['transaction', /transaction|order|deal|invoice|dncn|debit|credit|pod|dispatch/i],
  ['quantity',   /\bqty\b|quantity|volume|weight|tonn|\bmt\b|\bkg\b|gmv|amount|value/i],
  ['month/date', /month|date|period|created|dispatch(ed)?[_ ]?on|delivered/i],
  ['person',     /owner|executive|manager|assign|responsible|spoc|poc|\bby\b|employee|user|sales/i],
  ['status',     /status|state|stage/i]
];
/* Headers here are snake_case (Shipment_Status, Qty_MT).  An underscore is a
 * WORD character in a JS regex, so \bqty\b never matches "Qty_MT" — normalise the
 * separators to spaces before testing or half the hints silently miss. */
function colHints_(headers) {
  var hit = {};
  headers.forEach(function (hd) {
    var norm = String(hd).replace(/[_\-.\/]+/g, ' ');
    COL_HINTS.forEach(function (p) { if (p[1].test(norm)) hit[p[0]] = true; });
  });
  return Object.keys(hit);
}

/** Read-only map of EVERY tab in a workbook: size, header row, and which of the
 *  things we are looking for each tab appears to carry. Start here, then use
 *  inspectTab('<name>') on the ones that matter. Writes nothing. */
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

/* ==========================================================================
 * ONE-CLICK INSPECTORS.  The editor's Run dropdown can only call a function
 * with NO arguments, so every inspector that takes one gets a wrapper here.
 * All read-only; none of them writes anything, anywhere.
 *
 *   listTabsTargetSheet / listTabsMMCT   what tabs exist, and how big
 *   peekTargets                          Metals + Plastics + Employee Directory
 *   peek<Tab>                            the top rows of one tab, raw
 * ======================================================================== */
function listTabsTargetSheet() { return inspectTabList(TARGETS_SHEET_ID); }
function listTabsMMCT()        { return inspectTabList(SHIPMENTS_SHEET_ID); }

function peekMetals()            { return peekTab('Metals', 'target', 14, 12); }
function peekPlastics()          { return peekTab('Plastics', 'target', 14, 13); }
function peekEmployeeDirectory() { return peekTab('Employee Directory', 'target', 14, 6); }
function peekSellerOnboarding()  { return peekTab('seller onboarding', 'target', 6, 20); }
function peekOverallShipments()  { return peekTab('overall shipments', 'target', 6, 20); }
/* achievements only — NOT a target source, see TARGETS_SHEET_ID above */
function peekRawPOCTargets()     { return peekTab('Raw_POC_Targets', 'mmct', 6, 22); }
function peekRawTransactions()   { return peekTab('Raw_Transactions', 'mmct', 8, 16); }
function peekRawOBBuyers()       { return peekTab('Raw_OB_Buyers', 'mmct', 6, 20); }
/* tabs the full 28-tab inventory turned up */
function peekPOCData()           { return peekTab('POC_data', 'mmct', 14, 6); }
function peekRawShipments()      { return peekTab('Raw_Shipments', 'mmct', 6, 20); }
function peekRawSellers()        { return peekTab('Raw_Sellers', 'mmct', 6, 20); }
function peekRawBuyers()         { return peekTab('Raw_Buyers', 'mmct', 6, 20); }
function peekSupplyTeamInput()   { return peekTab('Supply_team_input', 'mmct', 8, 18); }
function peekDemandTeamInput()   { return peekTab('Demand_team_input', 'mmct', 8, 18); }

/** Read-only profile of the achievements workbook. Run from the editor and paste
 *  the log back — it prints the tab list, the header row, what each column
 *  actually holds, and the Shipment_Status distribution, so the raw-to-KPI
 *  mapping can be built from facts. Writes nothing, anywhere. */
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
  var CAP = 4000;                       /* profile a sample, report the true size */
  var nRows = Math.max(0, Math.min(lastR - 1, CAP));
  out.push('');
  out.push('Tab "' + TAB + '": ' + (lastR - 1) + ' data rows x ' + lastC + ' columns' +
    (lastR - 1 > CAP ? '   (profiling the first ' + CAP + ')' : ''));
  if (nRows < 1) { out.push('No data rows.'); return out.join('\n'); }

  var head = sh.getRange(1, 1, 1, lastC).getValues()[0].map(function (v) {
    return String(v == null ? '' : v).trim(); });
  var data = sh.getRange(2, 1, nRows, lastC).getValues();

  /* which column holds the status, matched loosely so a renamed header still lands */
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

  /* two surviving rows in full, so the shape is unambiguous */
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

/* Tab names in these workbooks carry leading emoji — "\ud83d\ude9a Overall
 * Shipments", "\ud83c\udfe2 Seller Onboarding" — which nobody wants to type and
 * which someone may well change.  Match exactly first, then fall back to a
 * case-insensitive substring, so 'seller onboarding' finds it either way. */
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

/** Raw top-of-tab dump, making NO assumption that row 1 is the header.
 *  Several tabs report "row 1 is blank" (Metals, Plastics, Employee Directory)
 *  or carry a totals row where the header should be (Raw_Transactions, whose
 *  row 1 reads "318 Shipment ID", "5219352 Qty"), so the real header has to be
 *  found by eye before anything can be mapped to it. Read-only.
 *
 *  peekTab('Metals')                      — first 14 rows of the Target Sheet
 *  peekTab('Raw_Transactions', 'mmct')     — ... of MM_CT Dashboard V1
 *  peekTab('Metals', null, 25, 20)         — 25 rows, 20 columns */
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

/** DRY RUN of the target import. Reads Metals and Plastics, matches every name
 *  and KRA against what this app already holds, and prints what WOULD be
 *  written. Writes nothing. Run it, read the unmatched lists, then decide. */
/* ------------------------------------------------- MATCHING THE TWO SIDES --
 *
 * The Target Sheet's KRA labels carry decoration that our KRA names do not,
 * and the dry run put numbers on exactly how much:
 *
 *   "GMV (Crores)"                              Metals,   6 rows
 *   "GMV (Cr)"                                  Plastics, 10 rows
 *   "Transaction from Existing Sellers @ 50%"   Plastics,  1 row
 *   "Transaction from New Onboarded Sellers @ 20%"          1 row
 *   "Retention of Existing Transacted Sellers @ 70%"        1 row
 *
 * The first two are a unit; the last three are the rule restated in the label,
 * and they appear on ONE block only (the sheet author typed the goal into the
 * first person's rows and trimmed it for everyone below). normName_ has
 * already flattened the punctuation, so by the time we see them they read
 * "GMV CRORES" and "TRANSACTION FROM EXISTING SELLERS 50" — the decoration is
 * always the LAST token.
 *
 * So strip trailing tokens, but only ones that are provably decoration: a bare
 * number, or a unit word from the list. A general "drop the last word" would
 * fold "New Seller Acquisition" and "New Buyer Acquisition" onto the same key
 * and hand one person another person's target. DAYS is deliberately absent —
 * "DSO Days" is a real KRA name, and it matches without help. */
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

/* The unit belongs in PLAN so a number is never shown bare: 0.35 crore and 0.35
 * sellers are the same digits and a different conversation. */
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

/* Everything the app needs to recognise a row of the Target Sheet. Built once
   and shared by the dry run and the real import, because a preview that
   matches by different logic than the write it is previewing is worse than no
   preview at all — it earns trust it has not tested. */
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
  /* A collision INSIDE one team cannot be resolved by team and would be picked
     arbitrarily, so say so rather than guess. */
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

/* TWO SOURCE ROWS CAN NOW LAND ON ONE PERSON.
 *
 * Abhisek's Target Sheet block resolves to Adarsh, and both men have a
 * "GMV (Crores)" row. Pushing both would produce two records with the same
 * PLAN id, and upsert_ would keep whichever came last — Adarsh's target
 * SILENTLY REPLACED by Abhisek's, or the reverse. A merge that loses half its
 * input is worse than no merge.
 *
 * So a collision COMBINES, and how it combines depends on the unit:
 *
 *   counts and amounts  ADD.    Two GMV targets of 1.20 and 1.50 Cr make a
 *                               person responsible for 2.70 Cr. Correct — he
 *                               took the accounts on.
 *   durations and rates AVERAGE. A 3-day DSO plus a 3-day DSO is not 6 days.
 *
 * Every merge is recorded and printed, because a combined figure that nobody
 * was told about is indistinguishable from a wrong one. */
function mergeIsMean_(kraName, unit) {
  if (String(unit) === 'days') return true;
  return /(\bdays?\b|\bdso\b|\btat\b|\brate\b|%)/i.test(String(kraName || ''));
}
/* The array holds the SAME object the map does, so a later merge mutates what
   the array already contains and no flattening pass is needed. Callers keep
   reading res.plans / res.perf exactly as before. */
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

/* One row of one tab -> the PLAN rows it produces, or the reason it produces
   none. Never writes. */
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

  /* The target is a denominator for a KPI, not for a KRA, so the person must
     actually be assigned that KRA. If they are not, the target has nothing to
     attach to and writing it would create a plan no scorecard reads. */
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

  /* The same row carries an Achievement beside every Target. It is the only
     source of achieved values that exists today — MM_CT can say WHOSE a
     shipment is but nothing aggregates it yet — so it is imported here.
     Stored RAW (7.19 Cr, not 1.106): the ratio is derived at scoring time in
     buildModel_, because a person needs to see what they actually did, and a
     stored ratio cannot be turned back into it. */
  /* Per KRA, so a missing achievement can be traced to the SHEET rather than
     suspected of the importer. A KRA with targets and zero achievements has
     em dashes in its Achievement column, and no code change will conjure
     numbers that were never typed. */
  var kt = res.byKra[row.kra] || (res.byKra[row.kra] = { t: 0, a: 0, rows: 0, m: {} });
  kt.rows++;
  months.forEach(function (m) {
    /* per MONTH too. "t=2" on a KRA held by two people can mean one month
       each or two months for one of them, and those are different problems —
       the first is a sheet with one column filled in, the second is a person
       missing. Without the split, every empty column needs a second query. */
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
    /* Metals holds 0.5 and 0.2 where Plastics holds 5, 7, 8: the rule's
       percentage typed into the target column, not a target. Nobody is being
       asked to retain half a seller. Importing it would rate a person against
       a number that means something else, so it is dropped here and the
       derived engine supplies the real count from last month's data. */
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

/* --------------------------------------------------------------- IMPORTING --
 * dryRun true  reads, matches, reports, writes NOTHING
 * dryRun false same matching, then upserts PLAN and commits
 * The PLAN id is derived from employee + KPI + period, so re-running replaces
 * the previous import instead of stacking a second copy of every target. */
function importTargetsFromSheet_(dryRun) {
  ensureSeeded_();
  var ctx = targetMatchCtx_(), out = [], src;
  try { src = SpreadsheetApp.openById(TARGETS_SHEET_ID); }
  catch (e) { return 'Cannot open the Target Sheet  (' + (e && e.message || e) + ')'; }

  var res = { rows: 0, values: 0, actuals: 0, okEmp: 0, okKra: 0, okKpi: 0,
              noEmp: {}, noKra: {}, noKpi: {}, pctLike: [],
              planById: {}, perfById: {}, merges: [],
              byKra: {} };
  /* plans/perf are the arrays every caller already reads; addOrMerge_ pushes
     into them AND indexes by id, so a merge mutates the object already in the
     array rather than needing a second pass */
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
    /* A hand-entered actual must not be silently replaced by the sheet's copy:
       somebody typed it in this app, deliberately, and the sheet may be stale.
       Only rows this importer itself wrote are refreshed. */
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

/** DRY RUN — read the Target Sheet, report exactly what would be imported,
 *  write nothing. Safe to run any number of times. */
function previewTargetImport() { return importTargetsFromSheet_(true); }

/** THE REAL IMPORT — writes the typed targets into PLAN. Idempotent: the PLAN
 *  id is employee+KPI+period, so re-running refreshes rather than duplicates. */
function importTargets() { return importTargetsFromSheet_(false); }


/* ==========================================================================
 * ACHIEVEMENTS — MM_CT Dashboard V1
 *
 * Raw_Shipments is the transaction ledger: 324 rows x 62 columns, one row per
 * shipment. It carries the seller and the buyer BY NAME (c22, c26) and it
 * carries no POC at all — so a shipment cannot say whose achievement it is.
 * POC_data supplies that: a seller name -> POC map and a buyer name -> POC map.
 * Every achievement therefore rests on a NAME JOIN between two tabs that were
 * maintained separately, which is the fragile part of this whole exercise and
 * the reason previewAchievementJoin() exists before any number is computed.
 *
 * Columns worth knowing (all located by header text, never by index):
 *   c3  shipment_status      CANCELLED excluded, per the KRA owner
 *   c4  shipment_created_date  decides the month
 *   c22 seller_name  c23 seller_category   Plastic | Metal
 *   c26 buyer_name   c27 buyer_category
 *   c41 shipment_value     RUPEES — GMV targets are in CRORE, so / 1e7
 *   c35 dispatched_quantity  c36 delivered_quantity
 *   c11 final_picked_quantity is entirely blank; do not reach for it.
 * ======================================================================== */
var POC_TAB = 'POC_data';
var RUPEES_PER_CRORE = 1e7;

function pad2_(n) { return (n < 10 ? '0' : '') + n; }

/* The month a shipment belongs to. The dates arrive as ISO strings
   ("2026-06-12T22:48:35"), which are parsed textually so no timezone can shift
   a midnight shipment into the previous month. A real Date is handled too, but
   only as a fallback — that path IS timezone-dependent and is flagged. */
function periodIdFromDate_(v) {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date) {
    return 'per_' + v.getFullYear() + '-' + pad2_(v.getMonth() + 1);
  }
  var m = String(v).match(/^\s*(\d{4})-(\d{2})/);
  if (m) return 'per_' + m[1] + '-' + m[2];
  /* dd/mm/yyyy, which is how invoice_date is written */
  m = String(v).match(/^\s*(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})/);
  if (m) return 'per_' + m[3] + '-' + pad2_(Number(m[2]));
  return null;
}

/* Header index for a tab whose headers are on row 1: name -> column index. */
function headerIndex_(headerRow) {
  var ix = {};
  headerRow.forEach(function (h, i) {
    var k = String(h == null ? '' : h).trim().toLowerCase();
    if (k && !(k in ix)) ix[k] = i;
  });
  return ix;
}

/* POC_data is a TWO-TIER header, like the Target Sheet:
 *   r1   "Plastic Seller"  .  .  .  "Plastic Buyer"
 *   r2   SellerName | POC  .  .     Buyer Name | POC
 * so the real header is row 2 and row 1 says what each PAIR of columns is for.
 * Located by finding the row that contains a cell reading exactly "POC"; the
 * name column is the one to its left and the group label sits above that.
 * Written this way so that a "Metal Seller" pair appearing later just works.
 *
 * Returns { groups: [ {label, kind, name->poc map, ...} ], ... }
 */
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
    /* "Plastic Seller" says BOTH what the column is and which material it
       covers. Keeping the material is what stops a Metal shipment being
       attributed through a Plastic column when two accounts share a name. */
    var material = /plastic/i.test(label) ? 'Plastic' : /metal/i.test(label) ? 'Metal' : '';
    if (!kind) {
      /* fall back to the name header itself — "Buyer Name" / "SellerName" */
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
      /* the same account listed twice under two POCs would otherwise be
         attributed to whichever row came last, silently */
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

/* Look up the POC for one side of a shipment.
 *
 * The material has to match. POC_data's columns are headed "Plastic Seller"
 * and "Plastic Buyer" — there is no Metal list in it at all — so a name-only
 * lookup would hand a Metal shipment to a Plastic POC the moment two accounts
 * shared a name, and would do it silently. Requiring the material means the
 * Metal gap shows up as a gap, which is the truthful answer until a Metal POC
 * source exists.
 *
 * A group whose header states no material (just "Seller") is treated as
 * covering everything, so this does not break if the sheet is reorganised. */
function pocFor_(map, name, category) {
  var nm = normName_(name);
  if (!nm) return null;
  var cat = String(category || '').trim();
  if (cat && map[cat + '|' + nm]) return map[cat + '|' + nm];
  if (map['|' + nm]) return map['|' + nm];
  return null;
}

/* ------------------------------------------- WHO A POC CELL ACTUALLY MEANS --
 *
 * The POC columns are typed by hand and five of the 21 distinct values did not
 * match anybody. The KRA owner settled each one on 10 Sep 2026; the rules are
 * encoded here rather than inferred, because every one of them decides whose
 * scorecard a transaction lands on.
 *
 * 1. "Praveen Raj P/Adarsh Krishnan V" and "Raju B/Adarsh Krishnan V" are TWO
 *    people in one cell. Some sellers supply both Plastic and Metal, and the
 *    count follows the MATERIAL SUPPLIED. That is resolvable without guessing:
 *    Praveen Raj P and Raju B are on Plastic, Adarsh Krishna is on Metal, so
 *    the shipment's own category picks the person. If the split is ever
 *    ambiguous — both candidates on the same team, or neither on the
 *    shipment's — the row is reported instead of being awarded to either.
 *
 * 2. "Adarsh Krishnan V" and a bare "Adarsh" both mean ADARSH KRISHNA.
 * 3. "Panchal Rishi" is RISHI PANCHAL written backwards.
 * 4. "Nomul Aravind" is not an employee; ignore it for now.
 *
 * These are an explicit table, NOT a fuzzy matcher. A reversed-name heuristic
 * would also have matched "Nomul Aravind" to ARVIND JAKKULA, who is on a
 * different team entirely and has nothing to do with these accounts. Being
 * unable to place a name is the safe outcome; placing it on the wrong person
 * is not. Keys are normName_ output.
 */
/* The VALUE side must stay exactly as EMPLOYEES.name has it, because the
 * employee id is derived from that name ('EMP-' + slug). Correcting a spelling
 * on the employee row would change the id and orphan every PLAN and PERFORMANCE
 * row already written against the old one. So the app's spelling is canonical
 * whether or not it is the nicer one, and every variant is mapped TO it here.
 *   ABHISEK / ABHISHEK is a genuine ambiguity in the source workbooks; the KRA
 *   workbook seeded ABHISEK, so that is the id, and ABHISHEK routes to it. */
var POC_ALIASES = {
  'ADARSH KRISHNAN V': 'ADARSH KRISHNA',
  'ADARSH':            'ADARSH KRISHNA',
  'PANCHAL RISHI':     'RISHI PANCHAL',
  /* HANDOVER, 15 Sep 2026: Abhisek Sanyal left and his accounts passed to
     Adarsh Krishna. Every spelling points STRAIGHT at Adarsh — not at
     'ABHISEK SANYAL' and then onward, because canonPersonName_ does one
     lookup, not a chain, and a two-hop alias would quietly stop halfway.
     When the source sheets are updated to name Adarsh directly these become
     no-ops, which is why it is safe to leave them in place. */
  'ABHISEK SANYAL':    'ADARSH KRISHNA',
  'ABHISHEK SANYAL':   'ADARSH KRISHNA',
  'ABHISEK':           'ADARSH KRISHNA',
  'ABHISHEK':          'ADARSH KRISHNA'
};
var POC_IGNORE = ['NOMUL ARAVIND'];

/* PEOPLE WHO HAVE LEFT.
 *
 * Keyed by canonical name, so every spelling variant in POC_ALIASES lands here
 * too. A leaver is HIDDEN, not deleted:
 *
 *   - their EMPLOYEES, ASSIGNMENTS, PLAN and PERFORMANCE rows stay exactly as
 *     they are. Deleting the person would orphan months of imported targets
 *     and achievements — rows pointing at an id nothing resolves — and would
 *     falsify the record of a period they actually worked;
 *   - they are filtered out of the model, so they do not appear in the roster,
 *     in any count, or in any table;
 *   - and the filter is HERE rather than in the spreadsheet, so
 *     refreshFrameworkFromSource() cannot resurrect them. Removing someone by
 *     hand from the database lasts exactly until the next framework import.
 *
 * Removing a name from this list brings the person and all their history back
 * intact, which is the property that makes hiding safer than deleting. */
var EMPLOYEE_LEAVERS = {
  /* left the organisation; accounts and figures merged into Adarsh Krishna */
  'ABHISEK SANYAL':  { left: '2026-09', handoverTo: 'ADARSH KRISHNA' },
  'ABHISHEK SANYAL': { left: '2026-09', handoverTo: 'ADARSH KRISHNA' },
  /* OFF CONTROL TOWER, 28 Sep 2026. Their shipments in OMP_TRACKER were
     reassigned to the remaining five by hand before this was recorded, so no
     achievement is stranded. BOTH the roster spelling and the tracker
     spelling are listed: this table is keyed on normName_, and a spelling
     that is not listed is not hidden. */
  'MEGARAJ':         { left: '2026-09' },
  'MEGHRAJ':         { left: '2026-09' },
  'MEGHARAJ':        { left: '2026-09' },
  'RAJESWARI':       { left: '2026-09' },
  'RAJESHWARI':      { left: '2026-09' }
};
/* Keyed on normName_, NOT canonPersonName_. Abhisek's aliases now resolve to
   ADARSH KRISHNA, so canonicalising first would ask "is Adarsh a leaver?" and
   hide the person who took the work over. Every spelling that must be hidden
   is therefore listed explicitly above. */
/* WEIGHTAGE OVERRIDES.
 *
 * Weightage arrives from the KRA/KPI workbook and is rewritten by every
 * refreshFrameworkFromSource(). Editing it in the app — or in the ASSIGNMENTS
 * tab — lasts exactly until the next import, which is how a correction gets
 * quietly undone weeks later with nobody watching. Overrides live here so they
 * survive, and so the reason survives with them.
 *
 * Keyed by canonical person, then by KRA NAME. A person holds each KRA once
 * (checked across all 38), so that is a unique address; the KPI name is not,
 * because several KRAs share one KPI name.
 *
 * THE WORKBOOK IS STILL THE RIGHT PLACE. An override makes the app and the
 * source disagree, and anyone reading the workbook sees the old number. Each
 * entry records what it changed and why so that can be reconciled, and the
 * entry becomes harmless the moment the workbook agrees. */
var WEIGHTAGE_OVERRIDES = {
  /* 15 Sep 2026 — his scorecard totalled 115%. These three take it to exactly
     100 and were set by the KRA owner:
       Days Sales Outstanding (DSO)        15 -> 10
       Seller Monthly Transaction Rate (%) 15 -> 10
       Debit Note Rate (%)                 10 ->  5   */
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

/* "#N/A" and "N/A" mean the cell is empty, and they MUST be caught before the
   slash split — splitting "#N/A" on "/" yields ["#N", "A"], two names that are
   not names. */
function isNaCell_(v) {
  return /^\s*#?\s*n\s*[\/-]?\s*a\s*$/i.test(String(v == null ? '' : v));
}

/* One cell -> the names in it. Slash separated, because that is how a shared
   account is written. */
function splitPocCell_(v) {
  if (v === null || v === undefined || isNaCell_(v)) return [];
  return String(v).split('/').map(function (x) { return String(x).trim(); })
    .filter(function (x) { return x !== '' && !isNaCell_(x); });
}

/* THE canonical form of a person's name, wherever it is written.
 *
 * POC_ALIASES was built for the POC columns, but the same people are typed by
 * hand into the Target Sheet's EMPLOYEE NAME column too, and with the same
 * variations. When the Metals tab started saying "Adarsh Krishnan V" instead
 * of "Adarsh Krishna", seven rows silently stopped matching anybody — the
 * alias table already knew that name, and the target importer simply was not
 * asking it.
 *
 * Two canonicalisers for one concept is how that happens, so there is one.
 * POC_IGNORE is deliberately NOT applied here: it says "this POC is not
 * someone we track", which is a statement about attribution, not about how a
 * name is spelled. */
function canonPersonName_(name) {
  var k = normName_(name);
  return POC_ALIASES[k] || k;
}
function canonPocName_(name) { return canonPersonName_(name); }

/* A POC cell + the shipment's material -> the one employee it belongs to, or
   null with a reason. Never returns a person it had to guess at. */
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
  /* several people share the account: the material decides */
  var cat = normName_(category);
  var hit = cands.filter(function (e) {
    return normName_((teamById[e.team_id] || {}).name) === cat;
  });
  if (hit.length === 1) return { emp: hit[0], why: '' };
  return { emp: null, why: 'shared account, material "' + category +
    '" matches ' + hit.length + ' of ' + cands.length + ' POCs' };
}

/* Raw_Sellers and Raw_Buyers both carry a POC_Name column and both cover Metal
 * AND Plastic, unlike POC_data which is Plastic only. They are the fallback,
 * consulted after POC_data — POC_data is the tab the teams curate by hand, so
 * it wins where the two disagree.
 *   Raw_Sellers  c5 business_name  c2 business_category  c31 POC_Name
 *   Raw_Buyers   c5 business_name  c2 business_category  c30 POC_Name
 * Located by header text, not by those indexes. */
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

/* Try each map in order and return the first hit. */
function pocForChain_(maps, name, category) {
  for (var i = 0; i < maps.length; i++) {
    var v = pocFor_(maps[i], name, category);
    if (v) return v;
  }
  return null;
}

/* One row per shipment, with only the columns an achievement needs. */
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
  /* Optional: present in Raw_Shipments today, but a missing one must degrade
     the DSO report rather than abort the whole read, which other callers
     depend on. */
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
      /* paid_amount is filled only once money arrives — blank means NOTHING
         paid, which for a receivable is the whole invoice, not zero exposure */
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

/* A shipment counts only if it is not cancelled. SHIPMENTS_EXCLUDE_STATUS is
   the KRA owner's rule, kept as data so it can be widened without a code change. */
function shipmentCounts_(sh) {
  var st = String(sh.status || '').trim().toLowerCase();
  for (var i = 0; i < SHIPMENTS_EXCLUDE_STATUS.length; i++) {
    if (st === String(SHIPMENTS_EXCLUDE_STATUS[i]).toLowerCase()) return false;
  }
  return true;
}

/* ==========================================================================
 * GMV, RECEIVABLES AND DSO FROM MM_CT
 *
 * DSO — days sales outstanding — is the standard receivables measure:
 *
 *     DSO = (receivables at period end / credit sales in the period)
 *           x days in the period
 *
 * From Raw_Shipments: shipment_value is the sale, paid_amount is what has come
 * back, and the difference is the receivable.
 *
 * FOUR JUDGEMENTS ARE BAKED IN HERE AND EVERY ONE OF THEM MOVES THE NUMBER.
 * They are reported at the top of the run rather than buried, because a DSO is
 * a rating input and a silent assumption in it is worse than no DSO at all.
 *
 *  1. A BLANK paid_amount MEANS NOTHING PAID. Only 105 of 300 rows carry one,
 *     and the column fills when money arrives. Read the other way — blank as
 *     "fully settled" — DSO would collapse toward zero and flatter everybody.
 *
 *  2. ONLY INVOICED SHIPMENTS COUNT. A receivable begins at the invoice, not
 *     at dispatch. A shipment with no invoice_date is excluded from both sides
 *     of the ratio, so it neither inflates the numerator nor pads the
 *     denominator.
 *
 *  3. CANCELLED SHIPMENTS ARE EXCLUDED, as everywhere else in this app.
 *
 *  4. THE MONTH IS THE SHIPMENT CREATED DATE, matching every other figure
 *     here. Using invoice_date instead would shift some shipments a month and
 *     is arguably more correct for a receivables measure — it is offered as a
 *     second column rather than chosen silently.
 *
 * WHOSE DSO IS IT? Receivables are owed by the BUYER, so the buyer POC is the
 * natural owner. But the KRA sits on people who run the seller relationship.
 * Both attributions are printed side by side; the KRA owner picks, and until
 * they do nothing is written.
 * ======================================================================== */
function daysInMonth_(periodId) {
  var m = String(periodId || '').match(/(\d{4})-(\d{2})$/);
  if (!m) return 30;
  return new Date(Number(m[1]), Number(m[2]), 0).getDate();
}

/* ==========================================================================
 * HOW LONG COLLECTION ACTUALLY TAKES
 *
 * peekTimeline settled two things:
 *
 *   - THERE IS NO PAYMENT STAGE in status_timeline. The stages are DRAFT,
 *     DISPATCHED, REACHED, RECEIVED_BY_RECYCLER, COMPLETED, CANCELLED and
 *     ORDER_VERIFIED. The shipment whose stage_label reads "Payment Released"
 *     is exactly the one whose timeline ends COMPLETED, so COMPLETED is the
 *     money arriving. That is an inference from one example and it is labelled
 *     as one below, not presented as fact.
 *
 *   - paid_amount is order- or buyer-level: 57 rows exceed their own shipment
 *     value, by up to 95 lakh. It cannot be used per shipment at all.
 *
 * AND invoice_date is BLANK on the paid example. Excluding rows without one —
 * which previewDSO does — would drop the very shipments that got paid. That
 * assumption has to go too.
 *
 * So this measures ELAPSED DAYS TO COMPLETED from four candidate starts and
 * reports the spread. It does not pick one: the DSO ladder here runs
 * 15 | 10 | 5 | 3 | 2 against a target of 3, and if real collection takes
 * twenty days then "3" means something other than total elapsed days —
 * days past due, perhaps — and only the KRA owner can say which.
 * ======================================================================== */
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
/* the timeline is always ISO with no zone; parsed textually so no timezone can
   move a stage across midnight */
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

/** DRY RUN — elapsed days to COMPLETED, from four candidate start points. */
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
    /* attribute on the delivered->completed leg, the one a collections KRA
       would plausibly own */
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
/** READ-ONLY — the status_timeline column in full, plus how paid_amount
 *  compares with shipment_value.
 *
 *  previewDSO() returned NEGATIVE days for several people and capped at the
 *  length of the month for everyone else. Both are symptoms, not noise:
 *
 *    negative  -> paid_amount on a row EXCEEDS that row's shipment_value, so
 *                 the two are not describing the same thing. A payment that
 *                 settles a whole order, or a buyer balance, cannot be
 *                 subtracted from one shipment's value.
 *
 *    capped    -> receivable/sales x days-in-month cannot exceed the month.
 *                 A real DSO of 45 days is unrepresentable, and the DSO ladder
 *                 in this workbook runs 15 | 10 | 5 | 3 | 2 with a target of 3,
 *                 which is a measure of DAYS TO COLLECT, not a balance ratio.
 *
 *  status_timeline looks like STAGE~ISO|STAGE~ISO..., which would give the
 *  actual moment payment was released. That is what a 3-day target is about.
 *  This prints it whole so the format can be read rather than assumed. */
function peekTimeline() {
  var nl = String.fromCharCode(10), out = [];
  var src = SpreadsheetApp.openById(SHIPMENTS_SHEET_ID);
  var sh = findSheet_(src, SHIPMENTS_TAB);
  if (!sh) return 'no tab matching "' + SHIPMENTS_TAB + '"';
  var lastR = sh.getLastRow(), lastC = sh.getLastColumn();
  /* the whole sheet, not the first 200 rows — the paid_amount census below is
     a count and must cover everything, and the earlier cap meant it reported
     71 rows with a payment when the column actually has 105 */
  var g = sh.getRange(1, 1, lastR, lastC).getValues();
  var ix = headerIndex_(g[0]);
  var need = ['status_timeline', 'shipment_status', 'shipment_value',
              'paid_amount', 'invoice_date', 'shipment_stage_label'];
  var miss = need.filter(function (k) { return !(k in ix); });
  if (miss.length) return 'missing columns: ' + miss.join(', ');

  /* The first version printed the first six rows that had a timeline. The sheet
     opens with cancelled shipments, so all six were CANCELLED and the run
     answered nothing — a sample taken from the top of a sorted file is not a
     sample. Census every stage name first, then show ONE example per
     shipment_stage_label so a paid shipment cannot be missed. */
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
/** DRY RUN — GMV, receivables and DSO per person per month. Writes nothing. */
function previewDSO() {
  ensureSeeded_();
  var nl = String.fromCharCode(10), out = [], src;
  try { src = SpreadsheetApp.openById(SHIPMENTS_SHEET_ID); }
  catch (e) { return 'Cannot open MM_CT  (' + (e && e.message || e) + ')'; }
  var shipSh = findSheet_(src, SHIPMENTS_TAB), pocSh = findSheet_(src, POC_TAB);
  if (!shipSh) return 'no tab matching "' + SHIPMENTS_TAB + '"';
  var poc = pocSh ? readPocMap_(pocSh) : { sellerPoc: {}, buyerPoc: {} };
  var shp = readShipments_(shipSh);
  if (shp.missing.length) return 'Raw_Shipments is missing: ' + shp.missing.join(', ');

  var sellSh = findSheet_(src, 'Raw_Sellers'), buySh = findSheet_(src, 'Raw_Buyers');
  var accS = sellSh ? readAccountPoc_(sellSh) : { map: {} };
  var accB = buySh ? readAccountPoc_(buySh) : { map: {} };
  var sellerMaps = [poc.sellerPoc, accS.map], buyerMaps = [poc.buyerPoc, accB.map];

  var emps = read_(T.EMPLOYEES), empByName = {}, teamById = idx_(read_(T.TEAMS));
  emps.forEach(function (e) { empByName[normName_(e.name)] = e; });

  out.push('=== assumptions (every one moves the number) ===');
  out.push('  blank paid_amount        = NOTHING paid, so fully receivable');
  out.push('  no invoice_date          = excluded from BOTH sides of the ratio');
  out.push('  cancelled                = excluded');
  out.push('  month                    = shipment_created_date');
  out.push('  DSO = receivable / GMV x days in month');
  if (shp.optMissing) out.push('  !! columns not found: ' + shp.optMissing.join(', '));
  out.push('');

  /* [sellerOrBuyer][empId][period] = {gmv, paid, n} */
  var acc = { seller: {}, buyer: {} };
  var tot = 0, counted = 0, noInvoice = 0, noPeriod = 0, unattr = 0;
  var gGmv = 0, gPaid = 0;
  shp.rows.forEach(function (r) {
    tot++;
    if (!shipmentCounts_(r)) return;
    if (!r.invoiced) { noInvoice++; return; }
    if (!r.period_id) { noPeriod++; return; }
    var v = r.value; if (v === null) return;
    counted++;
    var paid = r.paid === null ? 0 : r.paid;
    gGmv += v; gPaid += paid;
    var sides = [
      { k: 'seller', poc: pocForChain_(sellerMaps, r.sellerName, r.sellerCat), cat: r.sellerCat },
      { k: 'buyer', poc: pocForChain_(buyerMaps, r.buyerName, r.buyerCat), cat: r.buyerCat }
    ];
    var any = false;
    sides.forEach(function (sd) {
      if (!sd.poc) return;
      var res = resolvePocEmployee_(sd.poc, sd.cat, empByName, teamById);
      if (!res.emp) return;
      any = true;
      var byE = acc[sd.k][res.emp.id] || (acc[sd.k][res.emp.id] = {});
      var cell = byE[r.period_id] || (byE[r.period_id] = { gmv: 0, paid: 0, n: 0 });
      cell.gmv += v; cell.paid += paid; cell.n++;
    });
    if (!any) unattr++;
  });

  out.push('=== Raw_Shipments ===');
  out.push('  ' + tot + ' rows;  ' + counted + ' counted');
  out.push('  ' + noInvoice + ' skipped: no invoice_date');
  out.push('  ' + noPeriod + ' skipped: unreadable created date');
  out.push('  ' + unattr + ' counted but attributable to nobody');
  out.push('  GMV ' + (Math.round(gGmv / RUPEES_PER_CRORE * 100) / 100) + ' Cr,  ' +
    'received ' + (Math.round(gPaid / RUPEES_PER_CRORE * 100) / 100) + ' Cr,  ' +
    'outstanding ' + (Math.round((gGmv - gPaid) / RUPEES_PER_CRORE * 100) / 100) + ' Cr');
  out.push('');

  ['seller', 'buyer'].forEach(function (side) {
    out.push('=== DSO attributed to the ' + side.toUpperCase() + ' POC ===');
    var ids = Object.keys(acc[side]);
    if (!ids.length) { out.push('  (nothing attributable)'); out.push(''); return; }
    ids.sort(function (a, b) {
      return String((idx_(emps)[a] || {}).name || a)
        .localeCompare(String((idx_(emps)[b] || {}).name || b)); });
    var byId = idx_(emps);
    ids.forEach(function (id) {
      var e = byId[id] || { name: id };
      out.push('  ' + e.name);
      var pers = Object.keys(acc[side][id]).sort();
      pers.forEach(function (pid) {
        var c = acc[side][id][pid];
        var recv = c.gmv - c.paid;
        var dso = c.gmv > 0 ? recv / c.gmv * daysInMonth_(pid) : null;
        out.push('    ' + pid.replace('per_', '') +
          '  txns ' + c.n +
          '  GMV ' + (Math.round(c.gmv / RUPEES_PER_CRORE * 100) / 100) + ' Cr' +
          '  recd ' + (Math.round(c.paid / RUPEES_PER_CRORE * 100) / 100) + ' Cr' +
          '  outstanding ' + (Math.round(recv / RUPEES_PER_CRORE * 100) / 100) + ' Cr' +
          '  DSO ' + (dso === null ? '-' : Math.round(dso * 10) / 10) + ' days');
      });
    });
    out.push('');
  });

  out.push('NOTHING WAS WRITTEN. This is a dry run.');
  out.push('');
  out.push('!! DO NOT WRITE THESE NUMBERS YET. The first run produced NEGATIVE');
  out.push('   days for several people, which means paid_amount exceeds the');
  out.push('   shipment value it is being subtracted from — the two are not');
  out.push('   describing the same thing. And this formula cannot exceed the');
  out.push('   length of the month, so a 45-day DSO is unrepresentable, while');
  out.push('   the ladder here runs 15|10|5|3|2 with a target of 3 — a measure');
  out.push('   of DAYS TO COLLECT, not a balance ratio. Run peekTimeline.');
  var txt = out.join(nl);
  Logger.log(txt);
  return txt;
}
/** DRY RUN — can a shipment actually be attributed to a person? Reads
 *  Raw_Shipments and POC_data, joins them by name, and reports the coverage.
 *  Writes nothing. Every achievement number depends on this join, so it is
 *  measured before anything is computed rather than after someone queries a
 *  number that looks wrong. */
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

  /* do the POC names correspond to people the app knows? */
  var emps = read_(T.EMPLOYEES), empByName = {};
  emps.forEach(function (e) { empByName[normName_(e.name)] = e; });
  /* Every distinct POC string across all three sources, put through the SAME
     reconciliation the join uses. Comparing the raw cell text to employee
     names instead — which this used to do — reported all five reconciled
     names as unmatched and made settled work look outstanding. */
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
    /* a POC string is not yet a person — aliases, slash pairs and the ignore
       list all sit between the two */
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
  /* WHICH side matched decides WHICH KRAs can be scored. A seller-side KRA —
     Transaction from Existing Sellers, Retention of Existing Transacted
     Sellers, New Seller Acquisition — needs the SELLER POC; the buyer side
     cannot stand in for it. So the seller figure, not the combined one, is the
     ceiling for those KRAs, and a shipment counted only through its buyer
     must not be added to a seller KRA. */
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

/* ==========================================================================
 * THE RATING SCALE
 *
 * Corrected by the KRA owner on 15 Sep 2026: THE FIGURE IN THE TARGET SHEET IS
 * TARGET 4. Achieving it exactly is 100%, and 100% rates 4 out of 5.
 *
 *     60% of target -> 1     100% -> 4   <- ON TARGET
 *     75%           -> 2     105% -> 5
 *     90%           -> 3
 *
 * THIS IS THE WORKBOOK'S OWN LADDER, NOT ONE IMPOSED ON IT. The scale applied
 * on 10 Sep (80/90/100/110/120) put on-target at rung 3 and was wrong; it
 * shifted every ratio-scored rating down a rung across 166 rows. The source
 * had said otherwise all along, in two independent places:
 *
 *   - its dominant ladder is 0.6 | 0.75 | 0.9 | 1.0 | 1.05, carried by 106 of
 *     the 208 assignments in the snapshot, with 1.0 sitting at RUNG 4;
 *   - the Collections DSO ladder spells rung 4 out in words: "TGT-20 Days".
 *
 * The rungs are PERCENTAGES OF THE TARGET SHEET FIGURE. A GMV target of 6.50
 * Cr therefore means T3 = 5.85 Cr, T4 = 6.50 Cr, T5 = 6.825 Cr. Scoring
 * divides achieved by target and compares the quotient against the ladder,
 * which is the same arithmetic done in one step; the UI derives the absolute
 * rungs from plan_target so the ladder can also be read in crore, sellers or
 * days rather than in decimals.
 *
 * A rating is earned only when its threshold is fully reached (the existing
 * levelFromBands_ behaviour), so 98% of target clears 90% but not 100% and
 * rates 3. Nearest-threshold rounding was considered and rejected: it would
 * award an on-target rating to somebody who missed.
 *
 * WHAT THIS MAY AND MAY NOT TOUCH
 *
 * The workbook holds 16 distinct ladders and only some are percentages of a
 * target. Rewriting the wrong one would be silent and severe — "15 | 10 | 5 |
 * 3 | 2" is a ladder of DSO DAYS, and replacing it with 0.6..1.05 would score
 * a 20-day DSO as though it were 2000% of target.
 *
 * So a row is rewritten only when ALL of these hold:
 *   1. a PLAN row exists for the same employee+KPI+period, i.e. a numeric
 *      target exists to be a denominator at all;
 *   2. all five bands parse as numbers;
 *   3. they ascend (a percentage-of-target ladder always improves upward);
 *   4. the largest is <= 2, i.e. at most 200% — which is what separates a
 *      ratio ladder from an absolute one like 15 days or 9 crore.
 *
 * Everything skipped is listed by reason, so nothing is quietly left behind.
 * ======================================================================== */
var RATING_SCALE = ['0.6', '0.75', '0.9', '1.0', '1.05'];
/* Rung 4 is on-target, and several places need to say so without hard-coding a
   4 that would drift if the ladder were ever re-cut. */
var RATING_ON_TARGET_ = 4;
var RATING_SCALE_MAX_ = 2;

/* Is this ladder a percentage of a target, as opposed to an absolute one? */
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

/* Is this row ALREADY on the rating scale?
 *
 * This has to be a NUMERIC comparison. The scale is written as the strings
 * '0.8','0.9','1.0','1.1','1.2', but Sheets stores '1.0' as a number and hands
 * it back as 1, which stringifies to "1" — so a text comparison against
 * "0.8 | 0.9 | 1.0 | 1.1 | 1.2" never matches a row that was already
 * migrated. The first live run of applyRatingScale() therefore rewrote all 166
 * rows a second time, bumped every version and wrote 166 more audit entries,
 * and would have done so on every run forever. The in-memory test suite could
 * not see it, because nothing there round-trips through a spreadsheet. */
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

/** DRY RUN — what the rating scale would change. Writes nothing. */
function previewRatingScale() { return applyRatingScale_(true); }

/** THE REAL CHANGE — rewrite the percentage-of-target ladders to
 *  80/90/100/110/120. Re-rates every affected scorecard, so run
 *  previewRatingScale() first. Idempotent: a row already on the scale is
 *  left alone. */
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
    /* A target with NO usable ladder can never produce a rating. That is worse
       than a missing target: the number is on screen, so it reads as scored,
       and nothing says why the level stays blank. Named individually below. */
    var pb = parseBands_([t.t1, t.t2, t.t3, t.t4, t.t5]);
    var defined = 0;
    [t.t1, t.t2, t.t3, t.t4, t.t5].forEach(function (b) {
      if (String(b == null ? '' : b).trim() !== '') defined++;
    });
    if (!defined || pb.kind === 'none') {
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
  /* This block describes CHANGE, and it used to print unconditionally right
     under the unscoreable list — so a run with nothing to rewrite ended
     "people affected: 0" and an empty "sample:" immediately after naming 40
     broken rows, which reads as though those 40 affected nobody. */
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
  /* refreshFrameworkFromSource() embeds this text in its own log; logging it
     here as well printed the whole ladder inventory twice. */
  if (!quiet) Logger.log(txt);
  return txt;
}

/** Re-read the KRA/KPI framework from the LIVE source workbook, for every
 *  month that is not upcoming, then put the rating scale back.
 *
 *  Why this exists as one function rather than two steps: the app does NOT
 *  read the source workbook on demand. Its copy of the framework came from
 *  SRC_SEED, a snapshot taken on 2026-08-20 and embedded in this file, so a
 *  correction typed into the workbook is invisible here until it is imported.
 *
 *  Importing also brings back the workbook's OWN ladders. Since 15 Sep those
 *  AGREE with RATING_SCALE on the dominant ladder — the scale is the
 *  workbook's, not one imposed on it — so the second step is usually a no-op.
 *  It is still welded on, because the workbook carries sixteen ladders and
 *  nothing stops somebody re-cutting one; running the import without it would
 *  leave the difference invisible until somebody's rating had already moved.
 *
 *  Read the log: it reports what the import changed AND what the scale
 *  re-applied. */
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

/** DRY RUN of the above — what the import would find, without writing. */
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

/* ==========================================================================
 * PLASTIC DSO — THE KRA OWNER'S OWN FORMULA, AS A DRY RUN
 *
 * §16.9b of the handover records that DSO from MM_CT was investigated and NOT
 * built. That still stands as a warning, but the reason it failed has been
 * removed: the blocker was never the arithmetic, it was not knowing WHICH
 * columns carried the sale, the collection and the debit note. Three guesses
 * were tried and all three produced negative days.
 *
 * The KRA owner has now named the columns, on 15 Sep 2026:
 *
 *     sale value with taxes, net of debit notes   =  AP x 1.18 - AU
 *     receivables                                 =  AP x 1.18 - AQ - AU
 *     DSO                                         =  receivables / GMV x days
 *
 * counted from June 2026 to date, against a target of 5 DAYS for Plastic on
 * both MTD and YTD.
 *
 * COLUMNS ARE RESOLVED BY LETTER, NOT BY HEADER NAME, because the letter is
 * what was specified. The header actually sitting at each letter is printed at
 * the top of the report — if a column is ever inserted upstream every figure
 * below moves silently, and the printed header is the only thing that would
 * show it. Check those three lines before trusting anything under them.
 *
 * WRITES NOTHING. This reports what the formula produces so it can be checked
 * against the finance numbers before any rating depends on it.
 * ======================================================================== */
var DSO_GST_ = 1.18;
var DSO_COLS_ = { taxable: 'AP', collected: 'AQ', debitNote: 'AU' };
var DSO_FROM_ = '2026-06';
/* THE MONTH IN PROGRESS IS NOT MEASURED.
 *
 * KRA owner's ruling, 17 Sep 2026. On the current month almost nothing has
 * been collected yet — payment terms have not elapsed — so receivables equal
 * GMV and the formula returns the number of days since the month began. In
 * September that put every POC in both teams at exactly 17.0 days, rating T0,
 * and it climbed by one every day the month ran on. It measured the calendar,
 * not collections.
 *
 * A closed month with nothing collected is a DIFFERENT question and is still
 * imported: eight of those exist in June to August, and whether they are a
 * collections failure or unrecorded payments has not been settled. They keep
 * their T0 and their flag rather than being quietly dropped. */
var DSO_SKIP_CURRENT_MONTH_ = true;
/* The CALENDAR current month, not "whatever PERIODS calls open" — August is
   still open in PERIODS and is complete, so it must be imported. */
function currentMonthId_() {
  return 'per_' + Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM');
}
/* 5 DAYS IS TARGET 3, NOT TARGET 4.
 *
 * DSO is an ABSOLUTE ladder — 15 | 10 | 5 | 3 | 2, descending, in days — and
 * absolute ladders are the documented exception to "the Target Sheet figure is
 * Target 4". The days are compared against the rungs directly, so no ladder
 * change is needed: 5 already sits at rung 3, and an actual of 5 days clears
 * 15, 10 and 5 but not 3.
 *
 * Getting BETTER than target is what earns 4 and 5 here, which is the right
 * shape for a measure you want to drive down. */
var DSO_TARGET_DAYS_ = { plastic: 5 };
var DSO_LADDER_ = ['15', '10', '5', '3', '2'];
var DSO_TARGET_RUNG_ = 3;
/* Which side of the shipment makes it Plastic. RECEIVABLES ARE OWED BY BUYERS,
   so the buyer's category is the one that decides whose DSO this is — a plastic
   seller shipping to a metal buyer is not a Plastic receivable. KRA owner's
   ruling, 15 Sep 2026. */
var DSO_CATEGORY_SIDE_ = 'buyer_category';

function daysInMonth_(periodId) {
  var p = String(periodId || '').replace('per_', '').split('-');
  var y = Number(p[0]), m = Number(p[1]);
  if (!(y > 0 && m >= 1 && m <= 12)) return 0;
  return new Date(y, m, 0).getDate();
}
/* The month in progress has not finished, so charging it a full month of days
   overstates DSO for no reason other than the calendar. Count what has run. */
function daysElapsed_(periodId, today) {
  var full = daysInMonth_(periodId);
  var ym = String(periodId || '').replace('per_', '');
  var cur = Utilities.formatDate(today, Session.getScriptTimeZone(), 'yyyy-MM');
  if (ym !== cur) return full;
  return Math.min(full, today.getDate());
}

/** DRY RUN — Plastic DSO by the KRA owner's column formula. Writes nothing. */
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
  /* If the letter and the name disagree, say so rather than picking one. */
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

  /* --- aggregate, Plastic only, from June 2026 --------------------------- */
  var ixS = headerIndex_(g[0]);
  var cCat = (DSO_CATEGORY_SIDE_ in ixS) ? ixS[DSO_CATEGORY_SIDE_] : -1;
  /* kept only to report what the OTHER side would have counted, so the choice
     of side stays visible rather than becoming an unexamined default */
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
    /* A NEGATIVE RECEIVABLE IS ZERO, not a credit. KRA owner's ruling, and it
       is the conservative one: left signed, an over-collected shipment would
       cancel out somebody else's genuine overdue and flatter the whole month.
       Nobody is owed less than nothing. The same applies to a shipment whose
       debit note exceeds its value. Both are counted so the clamping stays
       visible rather than silently improving the number. */
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

  /* ===================== YTD: A DURATION AVERAGES =========================
   *
   * DSO is a NUMBER OF DAYS, and days do not accumulate across months: five
   * months of 20-day DSO is 20 days, not 100. This is the app's own YTD rule
   * for rates and durations (aggKind_, handover 16.4), and it applies here.
   *
   * The first version of this report got it wrong in exactly the way that rule
   * exists to prevent: it summed the receivables and the GMV, then multiplied
   * by the 108 days of the whole span, and reported 75.4 days against months
   * that ran 2.4, 14.4, 27.5 and 15.0. The quotient was arithmetically fine
   * and the answer was meaningless — stretching the multiplier stretches the
   * result, so the longer the year got the worse Plastic would have looked.
   *
   * Both alternatives are still printed, because the choice between a plain
   * and a GMV-weighted mean is the KRA owner's, not this function's. */
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
  /* what it would actually RATE, through the same engine the scorecards use.
     pb was built above, where each month is rated. */
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
  /* The newest month always looks worst here, and usually for no reason worse
     than the calendar: a shipment that is not yet DUE is counted as fully
     outstanding. Say so where the numbers show it, rather than leaving whoever
     reads the rating to discover it. */
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
/* ==========================================================================
 * PLASTIC DSO ONTO THE SCORECARDS
 *
 * previewPlasticDSO() proves the arithmetic at VERTICAL level. This puts it on
 * individual scorecards, which needs one more decision the vertical report did
 * not: WHOSE receivable is it.
 *
 * Each shipment is attributed through the buyer POC chain — POC_data first,
 * then Raw_Buyers — the same chain every other achievement uses. A POC with no
 * attributable buyers gets NO number, not the vertical average: an invented
 * figure that looks like a measurement is worse than a visible blank.
 *
 * WHEN AN ACCOUNT NAMES TWO POCs, BOTH ARE CREDITED IN FULL, and that is not
 * the rounding error it looks like. DSO is a RATIO: putting the whole
 * receivable over the whole GMV for each of them leaves each POC's ratio
 * correct. Splitting it in half would be right for a COUNT and wrong here —
 * half the numerator over half the denominator is the same quotient anyway,
 * but only if both halves move together, which they do not when one POC has
 * other accounts and the other does not.
 *
 * SCOPED TO PLASTIC. Metal also holds a DSO Days KRA; no ruling has been given
 * on it and its buyers are different accounts, so it is left alone.
 *
 * A HAND-ENTERED ACTUAL IS NEVER OVERWRITTEN. Only rows this function wrote
 * before — identified by their note — are refreshed, the same rule the Target
 * Sheet importer follows.
 * ======================================================================== */
var DSO_NOTE_ = 'MM_CT DSO';
/* THE WORKING, STORED WITH THE NUMBER.
 *
 * "29.8 days" on a scorecard is unarguable and unexaminable at the same time.
 * Somebody rated on it should be able to see the three figures it came from
 * without asking anybody, and somebody checking it should be able to reconcile
 * it against finance in one glance.
 *
 * It lives in the PERFORMANCE row's note rather than in new columns because it
 * travels with the number: export it, audit it, or read it six months later
 * and the derivation is still attached. */
function dsoWorking_(recv, gmv, days, ships) {
  function cr(x) { return (Math.round(x / 1e5) / 100).toFixed(2) + ' Cr'; }
  var d = gmv ? Math.round(recv / gmv * days * 10) / 10 : 0;
  return DSO_NOTE_ + ' · receivable ' + cr(recv) + ' ÷ GMV ' + cr(gmv) +
    ' × ' + days + ' days = ' + d + ' days' +
    ' · ' + ships + (ships === 1 ? ' shipment' : ' shipments');
}
/* WHO COUNTS AS HOLDING DSO.
 *
 * Matching the KRA name alone missed TABESH MOHAMMAD, whose DSO sits under a
 * KRA called "Working Capital Management" — a different KRA, a different
 * kpi_id, the same measurement. He is Plastic and he is rated on DSO, so a
 * matcher that skipped him was simply wrong.
 *
 * The KPI NAME is the reliable side here: whatever the result area is called,
 * the thing being measured is "Days Sales Outstanding". The KRA name is still
 * accepted, so a future KRA that names DSO without saying so in the KPI is
 * caught too. */
var DSO_KRA_ = 'DSO DAYS';
var DSO_KPI_RE_ = /DAYS SALES OUTSTANDING|\bDSO\b/;
/* THE TEAMS DSO IS COMPUTED FOR, AND WHAT EACH ONE'S TARGET IS.
 *
 *   material  matches the shipment's buyer_category, which is what decides
 *             whose receivable it is
 *   target    the number of days to WRITE as the plan target, or null to
 *             leave whatever the Target Sheet already says
 *
 * PLASTIC had no DSO target at all, so the KRA owner's 5 days is written.
 * METAL ALREADY HAS ONE — 3 days, from the Target Sheet, on every Metal DSO
 * row. That is the authoritative source for targets and this importer has no
 * business overwriting it: the ruling asked for was the CALCULATION, not a new
 * target. So Metal gets its achievements computed the same way and keeps its
 * own 3-day bar. Change the null to a number if the KRA owner re-sets it.
 *
 * Note 3 days sits at Target 4 on the 15|10|5|3|2 ladder and 5 days at Target
 * 3, so the two teams are not being held to the same rung either — which is
 * the workbook's own design, not something introduced here. */
var DSO_TEAMS_ = {
  'PLASTIC': { material: /plastic/i, target: 5 },
  'METAL':   { material: /metal/i,   target: null }
};
/* which configured team a shipment's category belongs to, or null */
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

  /* --- who owns each buyer ---------------------------------------------- */
  var pocSh = findSheet_(src, POC_TAB), buySh = findSheet_(src, 'Raw_Buyers');
  var poc = pocSh ? readPocMap_(pocSh) : { buyerPoc: {} };
  var accB = buySh ? readAccountPoc_(buySh) : { map: {} };
  var buyerMaps = [poc.buyerPoc, accB.map];
  var emps = read_(T.EMPLOYEES), empByName = {}, teamById = idx_(read_(T.TEAMS));
  emps.forEach(function (e) { empByName[normName_(e.name)] = e; });

  /* --- who holds the DSO KRA -------------------------------------------- */
  var kras = idx_(read_(T.KRAS)), kpis = idx_(read_(T.KPIS));
  var holds = {}, teamOf = {};   /* employee_id -> [kpi_id], and -> team name */
  read_(T.ASSIGN).forEach(function (a) {
    var kra = kras[a.kra_id]; if (!kra) return;
    if (!holdsDso_(kra.name, (kpis[a.kpi_id] || {}).name)) return;
    var e = emps.filter(function (x) { return String(x.id) === String(a.employee_id); })[0];
    if (!e || isLeaver_(e.name)) return;
    var tm = normName_((teamById[e.team_id] || {}).name);
    if (!Object.prototype.hasOwnProperty.call(DSO_TEAMS_, tm)) return;
    teamOf[a.employee_id] = tm;
    /* a person could hold DSO under two KRAs; both get the same figure, which
       is right — it is one measurement of one book of receivables */
    (holds[a.employee_id] = holds[a.employee_id] || []).push(a.kpi_id);
  });
  var holders = Object.keys(holds);
  if (!holders.length) {
    return 'Nobody in ' + Object.keys(DSO_TEAMS_).join(' or ') + ' holds a DSO KPI.';
  }

  /* --- accumulate per person per month ----------------------------------- */
  var curMonth = currentMonthId_(), nInProgress = 0;
  var acc = {}, vert = {}, unattributed = 0, unattribWhy = {};
  for (var r = 1; r < lastR; r++) {
    var row = g[r];
    if (cStat >= 0) {
      var st = String(row[cStat] || '').trim().toLowerCase();
      var skip = false;
      for (var i = 0; i < SHIPMENTS_EXCLUDE_STATUS.length; i++) {
        if (st === String(SHIPMENTS_EXCLUDE_STATUS[i]).toLowerCase()) skip = true;
      }
      if (skip) continue;
    }
    var cat = String(row[cCat] || '');
    var shipTeam = dsoTeamOfCategory_(cat);
    if (!shipTeam) continue;
    var pid = periodIdFromDate_(row[cDate]);
    if (!pid || String(pid).replace('per_', '') < DSO_FROM_) continue;
    if (DSO_SKIP_CURRENT_MONTH_ && String(pid) === curMonth) { nInProgress++; continue; }

    var ap = num_(row[cTax]) || 0, aq = num_(row[cCol]) || 0, au = num_(row[cDN]) || 0;
    var wt = ap * DSO_GST_;
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
    /* the POC must be in the team the SHIPMENT belongs to — a Metal buyer
       handled by a Plastic POC is not Metal's DSO, and crediting it either way
       would move a number nobody could explain */
    if (teamOf[res.emp.id] !== shipTeam) continue;
    var key = res.emp.id + '|' + pid;
    var a2 = acc[key] || (acc[key] = { emp: res.emp, pid: pid, team: shipTeam,
      gmv: 0, recv: 0, n: 0 });
    a2.gmv += gmv; a2.recv += recv; a2.n++;
  }

  /* --- turn each bucket into a number of days ---------------------------- */
  var today = new Date();
  function dsoOf(b) {
    return b.gmv ? b.recv / b.gmv * daysElapsed_(b.pid, today) : null;
  }
  var perf = read_(T.PERF), perfById = {};
  perf.forEach(function (p) { perfById[String(p.id)] = p; });

  var writes = [], kept = [], blanks = [];
  /* ROWS THE OLD RULE ALREADY WROTE FOR THIS MONTH ARE NOW WRONG, and leaving
     them would make the ruling a no-op: the 17-day September figures are
     already in PERFORMANCE and would simply stay there. Only rows carrying
     this importer's own note are touched — a number somebody typed by hand is
     never one of ours to delete. */
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
      /* never overwrite a number somebody typed */
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

  /* --- report ------------------------------------------------------------ */
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
      /* DSO equal to the days in the period means receivables equal GMV —
         NOTHING was collected against that month's shipments. That is not a
         collections result, it is an absence of payment data, and it rates
         T0 just the same. Marked so nobody reads it as performance. */
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
    /* The same overstatement the real run had: a team whose target is left to
       the Target Sheet gets no plan row, so "the same number" was wrong here
       as well. Counted properly, and the removals are named. */
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
      /* A NULL TARGET MEANS LEAVE THE TARGET SHEET'S OWN. Metal already has 3
         days on every DSO row and the Target Sheet is the authority for
         targets; overwriting it here would make the app and the source
         disagree about a number somebody is rated against. */
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
    /* NOT writes.length for both. A team whose target is left to the Target
       Sheet gets no plan row at all, so claiming one per performance row
       overstated the write by every Metal row — 27 against the 8 that were
       really written. A log that rounds up is worse than no log. */
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

/** DRY RUN — what the Plastic DSO import would write. Writes nothing. */
function previewDsoAchievements() { return dsoAchievements_(true); }

/** THE REAL WRITE — Plastic DSO actuals and the 5-day target. Run the preview
 *  first. Re-running is safe: it refreshes its own rows and never touches a
 *  hand-entered actual. */
function importDsoAchievements() { return dsoAchievements_(false); }
/* ==========================================================================
 * CSV FEEDS FROM A DRIVE FOLDER
 *
 * Three sources, one mechanism, because none of the automated routes turned out
 * to be available:
 *
 *   Zoho Books    report scheduling is gated by plan and by role  (18 Sep)
 *   Metabase      API keys are created by admins only             (21 Sep)
 *
 * What both CAN do is export a CSV, and every plan and every role can do that.
 * So: export, drop the file in one Drive folder, and this lands it. One human
 * step per refresh, no credentials anywhere, no admin needed from anybody.
 *
 * ONE FOLDER, MATCHED BY FILENAME. A folder per feed would need three ids kept
 * in step; matching on the name needs one. The names below are the defaults and
 * each is overridable, and the dry run prints WHICH FILE MATCHED WHICH FEED
 * plus every CSV that matched nothing — so a misnamed export is visible at once
 * rather than silently ingesting as the wrong feed.
 *
 * THE FAILURE MODE OF THIS ROUTE IS A QUIETLY CHANGED COLUMN, the same trap as
 * MM_CT's AP/AQ/AU. Every run prints the header it found with column letters,
 * and says whether it differs from the run before.
 * ======================================================================== */
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
/* An override is a plain substring, not a regex: whoever sets it is naming a
   file, not writing a pattern, and a stray character in a regex would silently
   match nothing. */
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

/* Every CSV in the folder, newest first, so each feed can take its own newest
   and anything left over can be reported as unmatched. */
/* ---------------------------------------------------------------------------
 * MAKING THE FOLDER.
 *
 * Asking somebody to create a folder, find its id inside a URL and paste it
 * into Script Properties is three steps and two places to get it wrong. This
 * does all of it and prints the link.
 *
 * IT NEVER REPLACES A FOLDER THAT ALREADY WORKS. Re-running returns the
 * existing one, because a second folder would silently become the one nobody
 * is dropping files into. It only creates when the property is unset, or when
 * the id it holds can no longer be opened. */
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

/* Zoho and Metabase both put title and date-range lines above the real header,
   so the header is not always row 1. The preamble lines are short and the
   header is the full width, so take the widest of the first ten rows. */
function csvHeaderRow_(grid) {
  var at = 0, widest = 0;
  for (var r = 0; r < Math.min(10, grid.length); r++) {
    var w = grid[r].filter(function (c) { return String(c || '').trim() !== ''; }).length;
    if (w > widest) { widest = w; at = r; }
  }
  return at;
}

/* One feed: parse, profile, and land. Appends its report to out. */
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
      if (m.test(files[i].name)) { hit = files[i]; break; }   /* newest first */
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

/** DRY RUN — find every feed's CSV, profile its columns. Writes nothing. */
function previewFeeds() { return feedIngest_(true, ''); }

/** Land every feed into its staging tab. Replaces a tab, never appends. */
function importFeeds() { return feedIngest_(false, ''); }

/** DRY RUN — the Collections feed only. */
function previewZohoReport() { return feedIngest_(true, 'collections'); }

/** Land the Collections feed only. */
function importZohoReport() { return feedIngest_(false, 'collections'); }

/** READ-ONLY — profile a landed tab, one line per column with letters. */
function describeZohoTab() { return describeTab_(ss_().getId(), 'Zoho_Collections', 200); }
function describeMetaBuyer() { return describeTab_(ss_().getId(), 'Meta_Onboarding_Buyer', 200); }
function describeMetaSeller() { return describeTab_(ss_().getId(), 'Meta_Onboarding_Seller', 200); }
/* ==========================================================================
 * METABASE — ONBOARDING CASES FROM SAVED QUESTIONS 5711 / 5712
 *
 * AN API KEY, NEVER A PASSWORD.
 *
 * Metabase will also hand out a session token for an email and password, and
 * that is the wrong thing to build on: it puts one person's credentials in a
 * script property where anybody with editor access can read them, it breaks
 * the day they change their password, it inherits everything that person can
 * see rather than only this report, and it cannot be revoked without locking
 * them out of Metabase entirely. An API key is scoped, revocable on its own,
 * and survives a password change. Create one at
 *
 *     Settings > Admin > Authentication > API keys
 *
 * and put it in Script Properties as METABASE_API_KEY. It is never logged:
 * the diagnostics below print its length and nothing else.
 * ======================================================================== */
var META_URL_PROP_ = 'METABASE_URL';
var META_KEY_PROP_ = 'METABASE_API_KEY';
var META_DEFAULT_URL_ = 'https://meta.recykal.com';
/* saved question ids, given by the KRA owner 21 Sep 2026 */
var META_CARDS_ = [
  { key: 'buyer',  card: 5711, tab: 'Meta_Onboarding_Buyer' },
  { key: 'seller', card: 5712, tab: 'Meta_Onboarding_Seller' }
];
/* every case In Review on or after this date counts */
var ONBOARD_FROM_ = '2026-04-01';

/* ---------------------------------------------------------------------------
 * WHO OWNS A VERTICAL.
 *
 * FIRST MATCH WINS, and the order is the KRA owner's: Open Marketplace is
 * checked before EPR so that a vertical naming both lands with Vamsi.
 *
 * AFR AND INFRA ARE NOT ONE BUCKET. Harshita holds them as two separate KRAs
 * weighted 0.25 each, so a merged "AFR & Infra" figure could not be written to
 * either of them. Infra is Metal, per the KRA owner.
 *
 * The TAT differs by vertical and is NOT uniform: Open Marketplace is a ONE
 * day promise, the rest are three. Reading one target across all four would
 * flatter Vamsi and punish nobody.
 *
 * The ladder on all four KRAs is 0.8 | 0.85 | 0.9 | 0.95 | 1.0 — a RATIO. So
 * the achievement to record is the SHARE OF CASES MEETING TAT, not the average
 * number of days. 100% of cases within TAT is Target 5; 80% is Target 1. */
/* TWO COLUMNS DECIDE THIS, NOT ONE.
 *
 * The rule was given as "if the business vertical contains AFR & Infra". The
 * data has no such vertical: business_vertical holds only Marketplace, Open
 * Marketplace, EPR, Support and Sustainability Services. AFR and Metal live in
 * business_CATEGORY.
 *
 * Read strictly by vertical, HARSHITA would score nothing at all — and her AFR
 * and INFRA KRAs are half her scorecard at 0.25 each. So her two rules match on
 * category, which is the only column that can make them score. Vamsi's and
 * Naveen's match on vertical, as given.
 *
 * ORDER IS THE KRA OWNER'S, AND IT HAS A CONSEQUENCE. Open Marketplace, then
 * AFR & Infra, then EPR — so an EPR row whose category is Metal goes to
 * HARSHITA, not to Naveen. previewOnboardingAttribution() cross-tabs vertical
 * against category so exactly how many rows that moves is visible rather than
 * buried. Swap the EPR rule above the two category rules to reverse it.
 *
 * Re-Commerce is last: Vamsi holds a Re-Commerce KRA, so those rows have a
 * home, but it was not in the stated rule and must not outrank anything in it. */
/* A RULE MAY REQUIRE BOTH COLUMNS, and Harshita's two do.
 *
 * KRA owner, 21 Sep 2026: "In EPR there will be no Metal — if yes that should
 * go to Naveen itself. Harshita owns the categories of AFR & Infra (Metal) IN
 * MARKETPLACE." So her rules are vertical=Marketplace AND category=AFR/Metal,
 * not category alone. Reading the category on its own had already given her a
 * Support/Metal row that is not hers.
 *
 * EPR IS TESTED FIRST so that no category rule can ever take an EPR row. The
 * cross-tab shows no EPR/Metal row exists today, which makes the guarantee
 * cheap rather than unnecessary: it is the ruling, and it holds if one appears.
 *
 * Anchored patterns throughout. "Marketplace" and "Open Marketplace" are
 * separate verticals in the same column — 4,011 rows against 457 — so an
 * unanchored /MARKETPLACE/ would swallow both. */
/* NOT ONBOARDING'S WORK AT ALL.
 *
 * KRA owner, 22 Sep 2026: ignore Support. Those 157 in-scope cases were being
 * reported as a gap — "nobody is measured on them" — which was true and
 * misleading: nobody is SUPPOSED to be. Counting them as out of scope by
 * ruling keeps them visible without dressing them up as an omission.
 *
 * Matched on the vertical. Support appears as both a vertical and a category
 * on the same 198 rows, so either would do; the vertical is the one the ruling
 * named. */
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
  /* KRA owner, 22 Sep 2026, final: "Plastic, E-Waste belongs to Vamsi and TAT
     will be 1 day only."

     At one day these sit on the Open Marketplace KRA he already holds, and the
     objection to that is gone: the whole KRA is now held to a single TAT, so
     the share it produces means something. An earlier reading put Plastic at
     three days on a KRA of its own, which would have needed adding to the
     workbook and his weightages rebalanced. Nothing to add now.

     Scoped to MARKETPLACE, like Harshita's two. Sustainability Services with a
     Plastic category stays unattributed — it was not ruled on, and inferring
     it from this would be guessing. */
  { vertical: /^MARKETPLACE$/, category: /^(PLASTIC|E WASTE)$/, who: 'VAMSI', tatDays: 1,
    kra: 'Open Marketplace – Buyer & Seller Onboarding' },
  /* KRA owner, 22 Sep 2026: "Sustainability Services / Plastic goes to
     Naveen." Landed on his EPR KRA at three days, for the same reason Vamsi's
     Plastic landed on his Open Marketplace one: it is the onboarding KRA that
     person actually holds, and its TAT is already three days so the KRA stays
     held to a single one.

     Only PLASTIC was ruled on. Sustainability Services with an Other Services
     category stays unattributed rather than being swept in with it. */
  { vertical: /^SUSTAINABILITY SERVICES$/, category: /^PLASTIC$/,
    who: 'NAVEEN RANGA', tatDays: 3, kra: 'EPR – Buyer & Seller Onboarding' }
];
/* Both values are folded through normName_ first — upper case, punctuation to
   spaces — so "Re-Commerce" and "Re Commerce" are one thing. A rule with both
   a vertical and a category needs BOTH to match; one with only a vertical
   ignores the category entirely. */
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

/* The CSV a saved question returns. Read-only: this runs the question, it
   cannot alter it. */
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

/* ---------------------------------------------------------------------------
 * LANDING THE DATA.
 *
 * The TAT itself is NOT computed here. It runs from In Review to Onboarded,
 * and where a case was rejected and resubmitted it is the LATEST In Review
 * that counts — none of which can be written without knowing which columns
 * carry the status history and its timestamps. Landing the questions and
 * printing their columns is what makes that knowable. Guessing at column names
 * is how the first three DSO attempts went wrong. */
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

    /* which column looks like the vertical, so the owner rules can be tried */
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

/** DRY RUN — connect to Metabase, run both questions, profile their columns
 *  and test the owner rules against the real vertical values. Writes nothing. */
function previewMetabase() { return metaIngest_(true); }

/** Land both saved questions into their staging tabs. Replaces, never appends. */
function importMetabase() { return metaIngest_(false); }

/** READ-ONLY — the owner rules, stated plainly, with a worked example each. */
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
/* ==========================================================================
 * PROFILING THE LANDED ONBOARDING TABS
 *
 * The column list told us what exists. This tells us what is IN it, which is
 * the part the attribution and the TAT actually depend on:
 *
 *   - every distinct business_vertical, with a count, and which owner rule it
 *     matches. The rules were written from the KRA owner's words ("Open
 *     Marketplace", "AFR & Infra", "EPR") and the data says "Marketplace" — a
 *     rule that matches nothing attributes nobody, silently.
 *   - every distinct status value, so "Onboarded" can be recognised by what
 *     the column really contains rather than by the word used in conversation.
 *   - how many rows fall in the scoring window at all.
 *   - DUPLICATE COLUMN NAMES. The seller export carries level1..level4 twice,
 *     once in UTC and once at +5:30, under identical headers. Anything looking
 *     a column up BY NAME silently takes the first, which is the UTC one, and
 *     a TAT measured in days across a 5.5 hour offset can land a day out.
 *     Columns are therefore addressed by LETTER throughout.
 *
 * Read-only. Needs importFeeds() to have landed the tabs first.
 * ======================================================================== */
var ONBOARD_TABS_ = [
  { key: 'buyer',  tab: 'Meta_Onboarding_Buyer' },
  { key: 'seller', tab: 'Meta_Onboarding_Seller' }
];

/* yyyy-MM-dd out of a cell, or ''.
 *
 * THE CELL IS USUALLY A DATE OBJECT, NOT A STRING. setValues() hands Sheets the
 * text "2024-02-16T13:41:18" and Sheets helpfully parses it into a real date,
 * so when it is read back String(v) gives "Mon Feb 16 2024 13:41:18 GMT+0530"
 * and a ^yyyy-MM-dd match finds nothing. That is why the first run of this
 * profiler printed an empty DATE COVERAGE block for both tabs while every date
 * column was in fact populated: an absence that looked like missing data and
 * was really a type. */
function isoDay_(v) {
  if (v instanceof Date && !isNaN(v.getTime())) {
    return Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  }
  var t = String(v == null ? '' : v).trim();
  if (!t) return '';
  var m = t.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return m[0];
  /* a last resort for whatever else date-shaped Sheets hands back */
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

    /* --- duplicate headers ------------------------------------------------ */
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
        /* if both look like timestamps, say how far apart they are */
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

    /* --- distinct values in the columns that decide things ---------------- */
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

    /* --- do the owner rules actually fire? -------------------------------- */
    if (vert) {
      out.push('');
      out.push('  THE OWNER RULES AGAINST THOSE VALUES:');
      var matched = 0, unmatched = 0;
      vert.keys.forEach(function (v) {
        if (v === '(blank)') { unmatched += vert.seen[v]; return; }
        /* the profiler only has the vertical to hand, so a row owned by a
           CATEGORY rule shows here as unmatched. previewOnboardingAttribution()
           is the one that reads both columns. */
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

    /* --- how much of it is in the scoring window ------------------------- */
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

/* ==========================================================================
 * WHAT THE ATTRIBUTION RULES ACTUALLY DO
 *
 * A cross-tab of business_vertical against business_category, every cell
 * showing who gets it. Two things it is meant to expose:
 *
 *   - how many rows land with nobody, and which vertical/category pair they
 *     are, so an unowned corner of the book is a number rather than a shrug;
 *   - the cost of the rule ORDER. Open Marketplace before AFR & Infra before
 *     EPR means an EPR row whose category is Metal goes to Harshita. That may
 *     be right, but it should be a decision rather than a surprise, so the
 *     rows it moves are counted separately.
 *
 * Read-only. Needs importFeeds() to have landed the tabs.
 * ======================================================================== */
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
      /* EPR is tested first, so no category rule can take an EPR row. This
         counts any that somehow did, which is now a should-never rather than a
         trade-off. */
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
/* ==========================================================================
 * SELLER ONBOARDING TAT
 *
 * KRA owner's rule: from In Review to the status becoming Onboarded, and where
 * a case was rejected and resubmitted it is the REVISED In Review that counts.
 *
 * START  the latest of review_submission_date and every rejection that
 *        happened before the final approval. A rejection is what restarts the
 *        clock: the next In Review cannot precede it. Rejections AFTER the
 *        final approval are ignored — those belong to a later re-review, not
 *        to the onboarding being measured.
 * END    the LAST approval present across level1..level4. Not every case uses
 *        all four, so "level4" is not reliably the end; the latest approval is.
 *
 * UTC COLUMNS THROUGHOUT, DELIBERATELY. The export carries every level twice,
 * once in UTC (Z..AW) and once at +5:30 (AX..BU), under identical headers — so
 * a lookup by name silently takes the UTC one. review_submission_date is UTC
 * too (it matches the UTC level1, not the IST one). Mixing the two would put a
 * 5.5 hour error into a TAT measured in days. An ELAPSED time is the same in
 * either zone, so UTC is used for the arithmetic; IST is used only to decide
 * which MONTH a case counts in, which is the one place the zone matters.
 *
 * THE LADDER IS A RATIO: 0.8 | 0.85 | 0.9 | 0.95 | 1.0. So the achievement is
 * the SHARE OF CASES MEETING TAT, not the mean number of days. 100% of cases
 * within TAT is Target 5, 80% is Target 1.
 *
 * Open Marketplace is a ONE day promise; AFR, INFRA and EPR are three.
 * ======================================================================== */
var SELLER_TAB_ = 'Meta_Onboarding_Seller';
/* Addressed by LETTER, never by name, because the names are not unique. The
   expected header at each letter is checked on every run: an inserted column
   upstream moves everything, and this is the only thing that would show it. */
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

/* a Date out of a cell, or null. Sheets may hand back either a Date or text. */
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

  /* --- the columns are where we think they are -------------------------- */
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

  /* --- per case --------------------------------------------------------- */
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
    /* THE ORDER OF THESE CHECKS DECIDES WHAT EVERY COUNT MEANS.
     *
     * The owner test used to run first, so "no owner rule matches: 1556" swept
     * in every unattributed case back to 2019 and was reported as though it
     * were the in-window gap. It was quoted that way, and it was wrong: the
     * question "how many cases onboarded since 1 April 2026 belong to nobody"
     * had never been measured.
     *
     * So the cheap, date-independent tests come first (is it done, can it be
     * timed), then the WINDOW, and only then the owner. Every count below the
     * window is therefore a count of in-scope cases. */
    if (String(row[iS] || '').trim().toUpperCase() !== ONBOARD_DONE_) { skip.notDone++; continue; }

    var end = null;
    iApp.forEach(function (i) {
      var d = cellDate_(row[i]);
      if (d && (!end || d > end)) end = d;
    });
    if (!end) { skip.noApproval++; continue; }

    var sub = cellDate_(row[iSub]);
    if (!sub) { skip.noSubmit++; continue; }
    /* a rejection restarts the clock, but only one that happened BEFORE the
       approval being measured — a later rejection belongs to a re-review */
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

    /* THE WINDOW IS ON THE IN REVIEW DATE, AND IT IS THE REVISED ONE.
     *
     * KRA owner: consider the cases from 1 April 2026 onwards. That is the
     * date the case ENTERED REVIEW, not the date it was approved — this used
     * to filter on the approval, which let in a case submitted in September
     * 2025 and approved in May 2026 while excluding one submitted in March
     * 2026 and still open. Wrong population either way.
     *
     * The revised In Review is what counts, so a case first submitted in 2025
     * but rejected and resubmitted in April 2026 IS in scope: the work being
     * measured happened in the window. JVD METALS is exactly that — submitted
     * 2025-09-09, restarted 2026-02-16. */
    var startDay = Utilities.formatDate(start, Session.getScriptTimeZone(), 'yyyy-MM-dd');
    var endDay = Utilities.formatDate(end, Session.getScriptTimeZone(), 'yyyy-MM-dd');
    /* MOVING THE CUTOFF FROM THE APPROVAL TO THE IN REVIEW CHANGED NOTHING in
       the 21 Sep run — the same 21 buckets and the same 169 skipped. That is
       believable (start is always <= end, so only a case straddling 1 April
       could differ) but it is exactly the shape of a change that silently did
       not apply. So the straddlers are counted: if this is 0, identical output
       is explained rather than merely hoped for. */
    if (startDay < ONBOARD_FROM_ && endDay >= ONBOARD_FROM_) straddle++;
    if (startDay < ONBOARD_FROM_) { skip.before++; continue; }

    /* IN SCOPE from here on: completed, timeable, and in review since the
       cutoff. So an unattributed case counted here is a real gap in the
       current year rather than a historical one. */
    /* out of scope by ruling, which is not the same as unattributed */
    if (onboardingIgnored_(row[iV], row[iC])) { skip.ignored++; continue; }
    var owner = onboardingOwner_(row[iV], row[iC]);
    if (!owner) {
      skip.noOwner++;
      var gk = String(row[iV] || '(blank)').trim() + '  /  ' +
               String(row[iC] || '(blank)').trim();
      noOwnerBy[gk] = (noOwnerBy[gk] || 0) + 1;
      continue;
    }

    /* The case is BUCKETED by the month it was completed in, which is when its
       TAT became knowable. Bucketing by submission month instead would flatter
       the newest month: its unfinished cases are not COMPLETED, so they are
       excluded, leaving only the ones that were quick. */
    var day = Utilities.formatDate(end, Session.getScriptTimeZone(), 'yyyy-MM-dd');

    var days = (end - start) / 86400000;
    if (days < 0) {
      skip.negative++;
      if (negEx.length < 5) negEx.push('    ' + row[iNm] + '   approved ' +
        Math.abs(Math.round(days * 10) / 10) + ' days BEFORE its submission');
      continue;
    }

    /* A TAT OF EXACTLY ZERO IS WORTH COUNTING SEPARATELY. In this export
       review_submission_date sometimes carries the SAME timestamp, to the
       second, as level1_approved_at — so for a case whose only approval is
       level1 the elapsed time is 0 by construction rather than because
       anybody was fast. Those cases count as MET and flatter the share. */
    /* under an hour is the signal that the submission stamp may be derived
       from the approval rather than recorded when the case was submitted — a
       mean printed as "0" is rounded from these, not necessarily exact zero */
    if (days * 24 < 1) subHour++;
    if (days === 0) zero++;
    /* THE DECISIVE TEST, and it has to run on every case rather than only the
       exactly-zero ones — which is what it did at first, and none of them are
       exactly zero, so it measured nothing and reported nothing.

       If review_submission_date carries the SAME timestamp as the first
       approval, the submission stamp is derived from the approval rather than
       recorded when the case was submitted — and for a case whose only
       approval is level1 the TAT is then zero by construction and counts as
       met. If it is rarely the same, the sub-hour cases are genuinely fast. */
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

  /* --- report ----------------------------------------------------------- */
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

  /* A FUNNEL, IN THE ORDER THE TESTS RUN, so each line is a count of what
     survived the line above it rather than an independent total. */
  var total = g.length - 1;
  out.push('=== the funnel ===');
  out.push('  rows in the tab                      ' + total);
  out.push('  less not ' + ONBOARD_DONE_ + '                    -' + skip.notDone);
  out.push('  less no approval recorded            -' + skip.noApproval);
  out.push('  less no submission date              -' + skip.noSubmit);
  out.push('  less in review before ' + ONBOARD_FROM_ + '     -' + skip.before);
  out.push('     of which straddling the cutoff — in review before, approved');
  out.push('     after: ' + straddle);
  /* This note used to assert the count was 0 regardless of what it was. Once
     the skip tests were reordered more cases reached the check and it became
     6, leaving the prose contradicting the number printed above it. */
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
  /* A MONTH RATED ON ONE CASE IS NOT A MEASUREMENT. */
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

  /* --- write ------------------------------------------------------------ */
  var emps = read_(T.EMPLOYEES), kras = idx_(read_(T.KRAS)), kpis = idx_(read_(T.KPIS));
  var empByName = {};
  emps.forEach(function (e) { empByName[normName_(e.name)] = e; });
  var actor = currentEmail_() || 'system', wrote = 0, missed = [];

  keys.forEach(function (k) {
    var b = buckets[k];
    var e = empByName[normName_(b.who)];
    if (!e) { missed.push(b.who + '  (no employee of that name)'); return; }
    /* the assignment whose KRA is the one this bucket belongs to */
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

/** DRY RUN — the seller onboarding TAT, per person per KRA per month. */
function previewSellerTat() { return sellerTat_(true); }

/** Write the seller onboarding TAT as achievements. Run the preview first.
 *  Re-running refreshes its own rows; a hand-entered actual is never touched. */
function importSellerTat() { return sellerTat_(false); }
/** The Target Sheet, all tabs. Read-only. */
function inspectTargets() { return inspectWorkbook(TARGETS_SHEET_ID); }

/* ------------------------------------------------- DESCRIBING A WIDE TAB --
 * peekTab prints a grid, which works up to about 20 columns. Raw_Shipments has
 * 62: the rows wrap in the log and no value stays under its own header, so the
 * grid is unreadable exactly where the achievement columns live. Transposing
 * fixes it — one line per COLUMN, with the first few DISTINCT non-blank values
 * underneath. Distinct rather than first-n because 300 shipments in the same
 * status tell you nothing about the column's shape, and the point of looking
 * is to learn what a column can contain. Read-only. */
/* 1 -> A, 26 -> Z, 27 -> AA, 42 -> AP. */
function colLetter_(nCol) {
  var s = '', n = Number(nCol);
  if (!(n >= 1)) return '?';
  while (n > 0) { var r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = (n - r - 1) / 26; }
  return s;
}
/* A -> 1, AP -> 42. The inverse, so a column named in a formula can be found. */
function letterCol_(letters) {
  var t = String(letters || '').toUpperCase().replace(/[^A-Z]/g, ''), n = 0;
  if (!t) return 0;
  for (var i = 0; i < t.length; i++) n = n * 26 + (t.charCodeAt(i) - 64);
  return n;
}
/* ==========================================================================
 * THE OMP TRACKER, PROFILED BEFORE ANYTHING IS BUILT ON IT
 *
 * Four things decide every OMP rate, and describeOmpTracker answered none of
 * them. This answers all four, and writes nothing.
 *
 *   1. WHERE THE HEADERS ARE. Row 1 of OMP_TRACKER is not the header row. It
 *      carries banner labels that span groups of columns — DISPATCH, Reached,
 *      Delivered, Completed — and three running totals. The real headers are
 *      on row 2. An importer that assumed row 1 would read every column as
 *      "(no header)" and match nothing at all.
 *
 *   2. WHO "Control - POC" MEANS. It holds PAIRS — "Divya/Naveen",
 *      "Kalyan/Aishwarya" — not people. 21 distinct values against a team of
 *      8, so some of those names are not on Control Tower, and some may be
 *      spellings of each other. Splitting on the slash and resolving each half
 *      against the employee list is the only way to know which.
 *
 *   3. WHETHER IT JOINS TO MM_CT. Shipment ID looks like MM_CT's shipment_id
 *      in both format and sample. Looks like is not joins to, and the cost of
 *      being wrong is a rate computed over the rows that happened to match.
 *
 *   4. HOW MANY SHIPMENTS A PERSON ACTUALLY HAS IN A MONTH. Every OMP KPI is
 *      a percentage. A percentage over one shipment is not a percentage — it
 *      is 0 or 100, and it moves somebody between Target 1 and Target 5 on a
 *      single delivery. The per-person-per-month counts have to be looked at
 *      before any of this is worth scoring monthly.
 * ======================================================================== */

/* The tracker's real header row is found, not assumed: banner rows get added
   and removed by hand, and a fixed row number fails silently the first time
   somebody inserts one. */
function ompHeaderRow_(grid) {
  for (var r = 0; r < Math.min(6, grid.length); r++) {
    for (var c = 0; c < grid[r].length; c++) {
      if (/control\s*-?\s*poc/i.test(String(grid[r][c] || ''))) return r;
    }
  }
  return -1;
}

/* THE TRACKER HAS A TWO-ROW HEADER, AND THE SECOND ROW IS NOT UNIQUE.
 *
 * Row 1 carries banners spanning groups of columns — DISPATCH, Vehcile Status,
 * Reached, Delivered, Completed — and row 2 carries the column names. Two of
 * those names are the SAME WORD: AJ is "Actual" under Reached, and AN is
 * "Actual" under Delivered. Matching on row 2 alone picks whichever comes
 * first, which happens to be the right one here and would stop being so the
 * day somebody reorders the sheet. Nothing would report it; the rate would
 * just quietly start measuring delivery instead of arrival.
 *
 * So a column's identity is the BANNER PLUS THE NAME — "Reached / Actual" —
 * with the banner carried forward from the last one that was set, which is how
 * a spanning header actually works.
 *
 * A NUMBER IN ROW 1 IS NOT A BANNER. O, T, V and AZ hold running totals
 * (148034.7, 60680.95, 87353.75). Carried forward as banners they would rename
 * every column after them until the next real label. Only text counts. */
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
  /* these three MUST be matched on the banner as well, or "Actual" is
     ambiguous and "Date" is worse */
  reached:   /^reached\s*\/\s*actual$/i,
  delivered: /^delivered\s*\/\s*actual$/i,
  completed: /^completed\s*\/\s*date$/i,
  /* the categorical columns the remaining KPIs rest on. QC and DN both sit
     under the Delivered banner and their plain names are two letters, so they
     are matched on the qualified label only. */
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

  /* the banner row is the one above the headers, when there is one */
  var banners = [], carry = '';
  var brow = hr > 0 ? g[hr - 1] : [];
  for (var b = 0; b < g[hr].length; b++) {
    var bv = b < brow.length ? brow[b] : '';
    var txt = String(bv == null ? '' : bv).trim();
    /* text only: a running total is not a banner */
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
      /* the plain name OR the banner-qualified one */
      if (OMP_WANT_[k].test(h) || OMP_WANT_[k].test(labels[c])) {
        col[k] = c; letters[k] = colLetter_(c + 1) + ' "' + labels[c] + '"';
      }
    }
  }
  return { sheet: sh, grid: g, headerRow: hr, col: col, letters: letters,
           labels: labels, banners: banners };
}

/* A tracker name ("Divya", "Jithu") against the employee list. Reports
   ambiguity rather than resolving it: two people called Naveen and a guess
   between them is how an achievement lands on the wrong scorecard. */
/* THE OMP TRACKER'S OWN NAME RULINGS. Scoped to this one source on purpose —
 * see the note on POC_ALIASES/POC_IGNORE below.
 *
 * Confirmed by the KRA owner, 28 Sep 2026:
 *   Aravind IS Arvind Jakkula. 68 rows, every month, so it is a systematic
 *   spelling rather than a typo and it earns an alias.
 *   Meghraj and Kalyan are NOT on Control Tower.
 *
 * WHY NOT POC_ALIASES. That table is global and every POC lookup in the
 * project goes through it — Metal and Plastic shipment columns included. And
 * POC_IGNORE already carries 'NOMUL ARAVIND', a different person who is
 * excluded on purpose. A global ARAVIND -> ARVIND JAKKULA would quietly put
 * any bare "Aravind" in those columns onto Arvind Jakkula's scorecard. */
var OMP_POC_ALIASES_ = {
  'ARAVIND': 'ARVIND JAKKULA'
};
/* NOT the same thing as a name that failed to match. These are closed; an
 * unmatched name is open work. Counted apart, always. */
var OMP_POC_OFF_TEAM_ = {
  /* Never on the roster under any spelling — not a leaver, just not ours. */
  'KALYAN': 'not on Control Tower (confirmed 28 Sep 2026)'
};
/* MEGARAJ and RAJESWARI were briefly ruled off here too. They are in
   EMPLOYEE_LEAVERS instead: they WERE on the team, so hiding them is the
   mechanism that keeps their past rows intact. Two mechanisms saying the same
   thing is one more than can be kept true. */

/* WHAT COUNTS. Ruled by the KRA owner, 28 Sep 2026: a shipment that was
 * cancelled, never left draft, or has only reached ready-to-dispatch is not
 * something anybody can be measured on, and it leaves the DENOMINATOR — it is
 * not a miss, it is not a case.
 *
 * Both columns are tested because MM_CT says this twice and not identically:
 * shipment_status has DRAFT but no ready-to-dispatch, shipment_stage_label has
 * 'Ready to Dispatch' but buckets differently. Reading only one would let the
 * other's spelling of the same shipment through. */
var OMP_NOT_COUNTED_STATUS_ = /^\s*(CANCELLED|DRAFT)\s*$/i;
var OMP_NOT_COUNTED_STAGE_  = /^\s*(CANCELLED|DRAFT|READY[\s_-]*(TO|FOR)[\s_-]*DISPATCH)\s*$/i;
/* IN TRANSIT, AND HOW LONG IS TOO LONG. Ruled 28 Sep 2026.
 *
 *   - a shipment from the CURRENT month does not count at all. It has not had
 *     time to arrive, and counting it would mark somebody down for work still
 *     in hand;
 *   - a shipment from a PRIOR month still in transit after more than 10 days
 *     is DELAYED. It counts, and it counts as a miss.
 *
 * MEASURED TO A FIXED POINT, NOT TO "NOW". "Still in transit after more than
 * ten days" has to be ten days measured to SOMETHING, and the obvious reading
 * — today — makes a past month's rating change every time the import is run:
 * a shipment sitting at nine days when August was first scored crosses ten a
 * day later and silently marks August down. A performance record that moves
 * after the fact is not a record. So the clock stops at the END OF THE MONTH
 * BEING SCORED PLUS the grace period — every shipment gets its full ten days,
 * the month settles once and never moves again.
 *
 * This is the one part of the rule that was not stated. Reversible in one
 * place if the intent was a rolling measurement. */
var OMP_TRANSIT_GRACE_DAYS_ = 10;
var OMP_IN_TRANSIT_ = /^\s*(DISPATCHED|IN[\s_-]*TRANSIT)\s*$/i;

/* The last instant that counts when scoring monthId ('2026-08'): the end of
   that month plus the grace. */
/* graceDays is optional and defaults to the transit grace, so every existing
   caller is unchanged. The dispatch KPI passes its own 3. */
function ompCutoff_(monthId, graceDays) {
  var g = (graceDays === undefined || graceDays === null) ? OMP_TRANSIT_GRACE_DAYS_ : graceDays;
  var y = Number(String(monthId).slice(0, 4)), m = Number(String(monthId).slice(5, 7));
  if (!(y > 0) || !(m > 0)) return null;
  /* The grace-th day of the NEXT month, which IS month end plus the grace:
     31 Aug + 10 = 10 Sep, and day 1 of September is already 31 Aug + 1. */
  return new Date(y, m, g);
}

/* A value reduced to a whole calendar day, as an integer that can be
   subtracted. */
function ompDayIndex_(v) {
  var d = isoDay_(v);
  if (!d) return null;
  var p = d.split('-');
  return Math.floor(Date.UTC(Number(p[0]), Number(p[1]) - 1, Number(p[2])) / 86400000);
}

/* Still moving at the cutoff, and for how long. Returns null when the
   shipment is not in transit at all. */
function ompTransitVerdict_(status, stage, dispatchedOn, monthId) {
  var moving = OMP_IN_TRANSIT_.test(String(status == null ? '' : status)) ||
               OMP_IN_TRANSIT_.test(String(stage == null ? '' : stage));
  if (!moving) return null;
  var cut = ompCutoff_(monthId), from = cellDate_(dispatchedOn);
  if (!cut || !from) return { state: 'unknown', days: null };
  /* COUNTED IN CALENDAR DAYS, not in milliseconds. A date read from Sheets
     is local midnight and one parsed from ISO text is UTC midnight;-
     subtracting their timestamps mixes the two and the answer then depends
     on the timezone the script happens to run in. Both sides go through
     isoDay_ first, which is the project s existing way of reducing a value
     to a calendar day in the script s own timezone. */
  var a = ompDayIndex_(from), b = ompDayIndex_(cut);
  if (a === null || b === null) return { state: 'unknown', days: null };
  var days = b - a;
  /* DISPATCHED AFTER THE MONTH'S CLOCK STOPPED. Its MM Date puts it in one
     month and the lorry left after that month was already settled, so there
     is nothing about it this month can be judged on. Not 'pending': a
     negative age fell through to the pending branch and read as
     'in transit -6 days, within the grace'. */
  if (days < 0) return { state: 'after', days: days };
  return { state: days > OMP_TRANSIT_GRACE_DAYS_ ? 'delayed' : 'pending', days: days };
}

/* The month a shipment is scored in, and whether that month is closed. A
   current-month shipment is not scored at all — see above. */
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

/* Edit distance, for suggesting a near miss. Small and iterative: the inputs
 * are single forenames, so the quadratic cost is nothing. */
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
  /* canonPersonName_, NOT normName_: it runs the part through POC_ALIASES,
     which is the project's existing answer to a source that spells people
     differently from the employee list. Matching on the raw normalised form
     bypassed it and reported names as unknown that the alias table already
     knew. */
  var raw = normName_(part);
  if (!raw) return { state: 'blank' };
  /* The ruling comes FIRST. Somebody who is not on the team must not then be
     offered as a near miss for somebody who is. */
  if (OMP_POC_OFF_TEAM_[raw]) {
    return { state: 'offteam', why: OMP_POC_OFF_TEAM_[raw] };
  }
  var want = canonPersonName_(OMP_POC_ALIASES_[raw] || part);
  if (!want) return { state: 'blank' };
  var hits = [], near = [];
  emps.forEach(function (e) {
    var full = canonPersonName_(e.name);
    if (full === want) { hits.push(e); return; }
    /* whole-token match, so DIVYA matches DIVYA BOPPURI but not DIVYANSH */
    if ((' ' + full + ' ').indexOf(' ' + want + ' ') >= 0) { hits.push(e); return; }
    /* not a match — but is it one character away from one? A tracker filled
       in by hand spells ARVIND as Aravind and BHARATH as Bharat, and those
       are 68 and 1 rows of achievement going to nobody. */
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

/* ==========================================================================
 * THE CATEGORICAL COLUMNS THE REMAINING OMP KPIs REST ON
 *
 * Tracking Accuracy, CN & DN Closure and the payment KPIs are all a count of
 * "how many rows say the right thing" over "how many rows there were". Which
 * values are the right thing is a ruling, and it cannot be made from the four
 * sample values describeOmpTracker prints — the Tracking column has six
 * distinct values and three of them were never shown.
 *
 * So: every distinct value in each column, with its count, over the rows that
 * could actually be scored — a Shipment ID, a POC, and not cancelled. Counting
 * over all 399 rows instead would include rows no KPI will ever see and make
 * a rare value look rarer than it is.
 *
 * Read-only.
 * ======================================================================== */
function profileOmpCategoricals() {
  ensureSeeded_();
  var nl = String.fromCharCode(10), out = [];
  var t = ompTrackerGrid_();
  if (t.error) { Logger.log(t.error); return t.error; }

  /* MM_CT, only to drop the cancelled */
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

  /* the columns each remaining KPI would read */
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
    /* Per person, because a value that is common overall can be one person's
       habit — and a KPI is scored per person. */
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

/* ==========================================================================
 * TRACKING ACCURACY RATE
 *
 * Ruled 28 Sep 2026:
 *
 *   ON TRACK   at least one of the two tracking methods is present. One is
 *              enough; "Both" is not required.
 *   N.A        the tracker was not yet in place at the time. Not the POC's
 *              failure, so it LEAVES THE DENOMINATOR.
 *   BLANK      a miss. Nobody recorded anything.
 *
 * THE COLUMN HOLDS FIVE VALUES AND NOT ONE OF THEM IS BLANK:
 *
 *     Fastag 200 · Both 51 · N.A 37 · SIM track 36 · No 28
 *
 * So the two methods are Fastag and SIM track, Both is both of them, and the
 * ruling maps on cleanly — except for one thing. "Blank is a miss" was ruled
 * before the values were known, and there ARE no blanks. The value carrying
 * that intent is "No": 28 rows, on every POC, meaning no tracking was in
 * place. IT IS A MISS — confirmed by the KRA owner, 28 Sep 2026, after the
 * value list came back.
 *
 * ANYTHING NOT IN THAT LIST IS NOT SCORED AT ALL. A new value appearing in a
 * hand-maintained column must not default to either verdict: scoring an
 * unknown as a hit is the silent lie this exercise keeps guarding against, and
 * scoring it as a miss punishes somebody for a word nobody has ruled on. It is
 * reported instead, and the dry run prints every distinct value against the
 * verdict it received.
 *
 * THE DENOMINATOR is shipments that reached In-Transit, bucketed on the
 * DISPATCH month — there is nothing to track before a shipment moves, and the
 * tracking happens during transit. Same bucketing as the transit KPI, and for
 * the same reason.
 * ======================================================================== */
var OMP_TRACKING_NOTE_ = 'OMP tracking';
var OMP_TRACKING_KRA_ = /shipment visibility/i;
var OMP_TRACKING_KPI_ = /tracking accuracy/i;
/* "the tracker was not there yet" — excluded, not a miss */
var OMP_TRACK_NA_ = /^\s*(n\.?\s*a\.?|not\s*applicable|not\s*available)\s*$/i;
/* no tracking was in place. This is what "blank is a miss" means here. */
var OMP_TRACK_NONE_ = /^\s*(no|nil|none|not\s*tracked|not\s*done)\s*$/i;
/* THE METHODS, listed rather than inferred — an unrecognised value must not
   become a hit by default. */
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
    /* THE DISPATCH MONTH — tracking happens during transit. */
    var monthId = Utilities.formatDate(new Date(mmRow.inTransit * 86400000), 'UTC', 'yyyy-MM');
    var raw = String(row[t.col.tracking] == null ? '' : row[t.col.tracking]).trim() || '(blank)';
    var v = ompTrackingOne_(mmRow, row[t.col.tracking], monthId, today);
    /* EVERY DISTINCT VALUE AGAINST THE VERDICT IT GOT. The value list was not
       fully known when the rule was written — this is how a wrong bucket is
       caught on the first run instead of inside a rate. */
    /* ONLY WHEN THE VALUE DECIDED IT. A shipment skipped for being in the
       current month, or cancelled, never reaches the value test at all —
       tabulating those alongside made 'Fastag -> skip' appear next to
       'Fastag -> hit', which reads as the value sometimes being skipped. */
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

/** DRY RUN — writes nothing. */
function previewOmpTracking() { return ompTrackingAchievements_(true); }
/** THE REAL WRITE. Run previewOmpTracking() first. */
function importOmpTracking() { return ompTrackingAchievements_(false); }

/* ==========================================================================
 * TIMELY DISPATCH RATE
 *
 * Ruled 28 Sep 2026, and the ruling settles both halves of it:
 *
 *   WHICH SHIPMENTS COUNT — those that reached In-Transit or beyond. One that
 *   never left is excluded, not counted as a miss.
 *
 *   WHAT IS MEASURED — the gap between the matchmaking date and the IN-TRANSIT
 *   date. More than 3 days is delayed.
 *
 * THE IN-TRANSIT DATE COMES FROM MM_CT'S TIMELINE, not from the tracker's
 * hand-entered Dispatch Date. status_timeline carries the moment each stage
 * was actually reached, which is what "the In-Transit date" means; the
 * tracker's column is somebody typing it in afterwards. The two are compared
 * on every run and the disagreement is reported, because the last time two
 * sources were assumed to agree it was worth checking and this one is the
 * numerator of the rate.
 *
 * THE MONTH IS THE MATCHMAKING MONTH. The clock starts at matchmaking, so a
 * shipment matched in July and dispatched in August is a July failure — that
 * is where the delay happened.
 *
 * WHAT THE RULING COSTS, STATED ONCE. Excluding the never-dispatched means the
 * rate is computed over shipments that did eventually go. A month where half
 * the work never left the yard scores on the half that did. The count of
 * excluded shipments is printed on every run so the number is never invisible,
 * but it is not folded into the rate — that is the ruling.
 * ======================================================================== */
var OMP_DISPATCH_NOTE_ = 'OMP dispatch';
var OMP_DISPATCH_DAYS_ = 3;
var OMP_DISPATCH_KRA_ = /dispatch execution/i;
var OMP_DISPATCH_KPI_ = /timely dispatch rate/i;
/* The stage name MM_CT writes into status_timeline when a shipment goes
   In-Transit. The stage LABEL reads "In Transit"; the timeline key does not. */
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
  /* THE DENOMINATOR, as ruled: it must have reached In-Transit. */
  if (mmRow.inTransit === null || mmRow.inTransit === undefined) {
    return { out: 'skip', why: 'never reached In-Transit — not counted (ruling)' };
  }
  var mm = ompDayIndex_(matchedOn);
  if (mm === null) return { out: 'skip', why: 'no MM Date, so no clock to start' };
  var gap = mmRow.inTransit - mm;
  /* In transit BEFORE matchmaking is data, not a rating. Letting a negative
     through would arithmetic its way into a hit. */
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

  /* --- MM_CT, including the moment each shipment went In-Transit --------- */
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
        /* parseTimeline_ returns UTC milliseconds at day precision */
        inTransit: (ms === null || ms === undefined) ? null : Math.floor(ms / 86400000)
      };
    }
  } catch (e) { return 'Cannot read MM_CT  (' + (e && e.message || e) + ')'; }

  /* --- who holds it ------------------------------------------------------ */
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

  /* --- walk the tracker -------------------------------------------------- */
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

    /* DO THE TWO SOURCES AGREE ON WHEN IT LEFT? The tracker's Dispatch Date is
       typed in; MM_CT's timeline is recorded. The gap is the numerator, so a
       systematic difference between them would move every rate. */
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

  /* --- the rate ---------------------------------------------------------- */
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

  /* WHAT THE RULING COSTS, printed every run so it is never invisible. */
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

/** DRY RUN — writes nothing. */
function previewOmpDispatch() { return ompDispatchAchievements_(true); }
/** THE REAL WRITE. Run previewOmpDispatch() first. */
function importOmpDispatch() { return ompDispatchAchievements_(false); }

/* ==========================================================================
 * ON-TIME TRANSIT COMPLETION RATE
 *
 * The first OMP achievement this project computes. The rules, all ruled by the
 * KRA owner on 28 Sep 2026:
 *
 *   ON TIME      Reached/Actual  <=  Exp Date.
 *   DOES NOT COUNT   cancelled, draft, ready-to-dispatch. They leave the
 *                    DENOMINATOR — they are not misses.
 *   NOT YET SCORED   anything in the current month. It has not had time to
 *                    arrive and counting it marks somebody down for work still
 *                    in hand.
 *   DELAYED      a PRIOR month's shipment still in transit more than ten days
 *                after dispatch, measured to month end plus the grace. That is
 *                a miss, not a skip: a shipment that never arrived is the
 *                clearest possible failure of an on-time rate, and letting it
 *                sit outside the denominator for ever would make the rate
 *                flattering by construction.
 *
 * THE RATE IS A FRACTION, NOT A PERCENTAGE. The ladder reads
 * 0.8 | 0.85 | 0.9 | 0.95 | 1, and with no PLAN target in any month
 * buildModel_ compares the stored number to those bands directly (planEver).
 * Writing 87 instead of 0.87 would clear every band and rate everybody 5.
 *
 * WHICH MONTH A SHIPMENT BELONGS TO is its DISPATCH month, ruled 28 Sep 2026.
 * It was MM Date — the order date — which judged a shipment ordered on 28
 * July and dispatched on 3 August against July's clock, for transit work that
 * happened in August. A transit KPI belongs to the month the transit
 * happened.
 *
 * A shipment with no dispatch date therefore has no month, and is skipped
 * under its own reason rather than being given the order month's and failing
 * later. "We do not know when it left" is a data gap somebody can go and fix.
 * ======================================================================== */
var OMP_TRANSIT_NOTE_ = 'OMP transit';
/* Found by KRA and KPI name rather than by naming people: whoever holds this
   KPI gets a number, and a seventh person added to the team next month is
   picked up without an edit here. */
var OMP_TRANSIT_KRA_ = /in-?\s*transit delivery management/i;
var OMP_TRANSIT_KPI_ = /on-?\s*time transit completion/i;

/* One shipment, one verdict. Returned as a reason as well as an outcome, so
   the dry run can say WHY a shipment was skipped — a denominator that quietly
   shrinks is the failure mode this whole exercise has been avoiding. */
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
    /* Unreachable while the month IS the dispatch month: the age at the
       cutoff is then always at least the grace. Kept as a guard, because a
       verdict that silently cannot happen is cheaper than one that silently
       can, and omptest exercises it directly. */
    if (tv.state === 'after') {
      return { out: 'skip', why: 'dispatched ' + (-tv.days) +
        ' day(s) after this month closed' };
    }
    return { out: 'skip', why: 'in transit, no dispatch date to measure from' };
  }
  /* It arrived. The question is only whether it arrived by the expected date. */
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
  /* mmDate is deliberately absent: the month comes from the dispatch date. */
  var need = ['poc', 'shipment', 'expected', 'reached', 'dispatch'];
  var miss = need.filter(function (k) { return t.col[k] === undefined; });
  if (miss.length) {
    return 'OMP_TRACKER is missing: ' + miss.join(', ') + nl +
      'Run describeOmpTracker() and check the header row.';
  }
  out.push('columns read:');
  need.forEach(function (k) { out.push('  ' + pad_(k, 11) + t.letters[k]); });
  out.push('');

  /* --- MM_CT, the live state ------------------------------------------- */
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

  /* --- who holds the KPI ------------------------------------------------ */
  /* THE SAME RESOLVER THE PROFILER USES. It matches a forename against a full
     name by whole token, which is what the tracker actually contains:
     "Bharath" for BHARATH KUMAR. An exact lookup on the canonical name
     dropped 275 of 364 rows here and named Bharath as a holder anyway. */
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

  /* --- walk the tracker -------------------------------------------------- */
  var rows = t.grid.slice(t.headerRow + 1);
  var acc = {}, whyCount = {}, samples = [], unowned = 0, noEmp = {}, offTeam = {};
  /* Disagreements between the tracker and MM_CT about whether a shipment has
     arrived. Counted, because 22 "still in transit" verdicts are either true
     or they are MM_CT lagging, and the rate is very different either way. */
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
    if (!holds[e.id]) return;   /* owns shipments but not this KPI */
    /* THE DISPATCH MONTH, not the order month — see the note at the top. */
    var d = cellDate_(row[t.col.dispatch]);
    if (!d) {
      whyCount['skip: no Dispatch Date, so no month to score it in'] =
        (whyCount['skip: no Dispatch Date, so no month to score it in'] || 0) + 1;
      return;
    }
    var monthId = Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM');
    /* Does the TRACKER think this one arrived? Two independent signals: its
       own status column, and whether a Reached date was written down. */
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

  /* --- the numbers ------------------------------------------------------- */
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
  /* THE LADDER EACH RATE WILL BE READ AGAINST. Latest row wins: bands get
     revised and the old row stays. */
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
    /* A FRACTION. The bands are 0.8..1.0 — see the note at the top. */
    var rate = Math.round(b.hit / den * 10000) / 10000;
    (holds[b.emp.id] || []).forEach(function (kpiId) {
      var pid = 'per_' + b.month;
      var id = 'prf_' + b.emp.id + '_' + kpiId + '_' + pid;
      var prev = perfById[id];
      /* never overwrite a number somebody typed by hand */
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

  /* THE CONSEQUENCE, STATED BEFORE THE IMPORT RATHER THAN AFTER IT. This KPI
     is half of both scorecards; a month that clears no band is a zero on the
     half of somebody's rating. That is a finding about the deliveries, not a
     fault in the arithmetic — but it should be read deliberately, not
     discovered. */
  var zero = writes.filter(function (w) { return w.level === 0; });
  var thinW = writes.filter(function (w) { return w.den < 5; });
  if (zero.length || thinW.length) {
    out.push('');
    /* The same facts either way, but a real run has already written them —
       telling somebody to read this BEFORE importing, underneath a line
       saying it just imported, reads as a warning that arrived too late. */
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

/** DRY RUN — writes nothing. */
function previewOmpTransit() { return ompTransitAchievements_(true); }
/** THE REAL WRITE. Run previewOmpTransit() first. */
function importOmpTransit() { return ompTransitAchievements_(false); }

function profileOmpTracker() {
  ensureSeeded_();
  var nl = String.fromCharCode(10), out = [];
  var t = ompTrackerGrid_();
  if (t.error) { Logger.log(t.error); return t.error; }

  var emps = read_(T.EMPLOYEES).filter(function (e) { return !isLeaver_(e.name); });
  var teamById = idx_(read_(T.TEAMS));

  /* WHO IS ACTUALLY ON THE TEAM. Without this, "NO MATCH" cannot be told
     apart from "matched, but against somebody on another team" — and three
     of the tracker's names turned out to be neither. */
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
    /* A RULING THAT CONTRADICTS THE ROSTER. Ruling somebody off the team is a
       decision; ruling off somebody who IS on it is a spelling failure wearing
       a decision's clothes, and it will silently drop their work the moment
       the name reappears. */
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

  /* ---- 2. the POC column ------------------------------------------------ */
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
    /* Classified ONCE per distinct value, after every part has been walked —
       not once per part. "Kalyan/Megharaj" is two off-team names on the same
       rows and would have counted those rows twice; "Kalyan/Aishwarya" is one
       of each, and those rows are Aishwarya's, not an exclusion. */
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
    /* One row, one bucket, in this order: somebody owns it, or it is excluded
       on purpose, or it belongs to nobody. */
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
  /* THREE outcomes, three counters. Excluded on purpose is a closed question;
     belonging to nobody is open work; having no owner written down at all is
     a third thing again, and it is the one that is growing. */
  out.push('  rows with an owner           ' + attributedRows);
  out.push('  rows excluded by ruling      ' + offteamRows +
    '   (Meghraj, Kalyan — closed, not a gap)');
  out.push('  rows with an unmatched name  ' + unresolvedRows +
    '   (open: these belong to nobody)');
  out.push('  rows with no POC written     ' + blankRows +
    '   (open: nothing to attribute them by)');

  /* ---- 3. the join to MM_CT --------------------------------------------- */
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

  /* ---- 4. the volume a rate would rest on -------------------------------- */
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

  /* ---- 5. what is left once the uncountable states are removed --------- */
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

/* WHAT THE OMP TRACKER ACTUALLY HOLDS.
 *
 * Zero-argument, because the Run dropdown only offers functions it can call
 * with none. It scans 400 rows rather than the default 200: the POC column is
 * the point of the exercise and a short scan can miss a person who only
 * appears further down, which would read as 'that name is not in the tracker'.
 *
 * Read-only. */
function describeOmpTracker() {
  var txt = describeTab_(OMP_TRACKER_SHEET_ID, OMP_TRACKER_TAB, 400);
  Logger.log(txt);
  return txt;
}

/* The tab list, for when the tab is not named what the brief said it was. */
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
    /* People read a spreadsheet in LETTERS. A formula given as "AP * 1.18 -
       AU" cannot be checked against a list that only counts from c0, and
       miscounting by one column silently changes what a number means. */
    out.push(colLetter_(c + 1) + '  (c' + c + ')  ' + String(g[0][c] || '(no header)') +
      '   [' + filled + '/' + (nR - 1) + ' filled, ' + nDistinct + ' distinct]');
    out.push('      ' + (vals.length ? vals.join('  |  ') : '(all blank)'));
  }
  var txt = out.join(nl);
  Logger.log(txt);
  return txt;
}

/* Zero-argument, because the Apps Script Run dropdown only offers functions
   that take no arguments. */
function describeShipments()      { return describeTab_(SHIPMENTS_SHEET_ID, SHIPMENTS_TAB, 300); }
function describePOCData()        { return describeTab_(SHIPMENTS_SHEET_ID, 'POC_data', 300); }
function describeRawTransactions(){ return describeTab_(SHIPMENTS_SHEET_ID, 'Raw_Transactions', 300); }
function describeRawOBBuyers()    { return describeTab_(SHIPMENTS_SHEET_ID, 'Raw_OB_Buyers', 300); }
function describeRawSellers()     { return describeTab_(SHIPMENTS_SHEET_ID, 'Raw_Sellers', 300); }
function describeRawBuyers()      { return describeTab_(SHIPMENTS_SHEET_ID, 'Raw_Buyers', 300); }

/** Just the tab inventory — no header rows — so a 28-tab workbook fits inside
 *  the Apps Script log, which inspectWorkbook() overflows. Read-only.
 *    inspectTabList()          Target Sheet
 *    inspectTabList('mmct')    MM_CT Dashboard V1 */
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

/** The three Target Sheet tabs whose header is not in row 1, in one run:
 *  Metals, Plastics and Employee Directory. Read-only. */
function peekTargets() {
  var nl = String.fromCharCode(10);
  var txt = ['Metals', 'Plastics', 'Employee Directory'].map(function (t) {
    return peekTab(t, 'target', 12, 12);
  }).join(nl + nl + '----------------------------------------' + nl + nl);
  Logger.log(txt);
  return txt;
}

/** Both source workbooks, tab inventory only.
 *  This used to call inspectWorkbook for both, which prints every header row —
 *  34 tabs of that overflows the Apps Script log every single time, so the
 *  second half was never readable. Lean listing instead; use inspectTab or a
 *  peek* function for the detail of one tab. */
function inspectAllSources() {
  var nl = String.fromCharCode(10);
  var txt = inspectTabList(TARGETS_SHEET_ID) + nl + nl +
    '================================================================' + nl + nl +
    inspectTabList(SHIPMENTS_SHEET_ID);
  Logger.log(txt);
  return txt;
}

/** The Raw_Shipments tab specifically — the same profile as inspectTab, kept as
 *  its own entry point because that tab is the one the exclusion rule is for. */
function inspectShipments() { return inspectTab(SHIPMENTS_TAB, SHIPMENTS_SHEET_ID); }

/* ==========================================================================
 * CLEANING UP AFTER A HANDOVER
 *
 * When a leaver's figures are merged into somebody else, their own PLAN and
 * PERFORMANCE rows become duplicates: the same numbers now live under the
 * person who took the work on. They are invisible — buildModel_ filters
 * leavers out — but they are stale, and a stale row that nobody can see is
 * exactly the kind of thing that resurfaces years later looking authoritative.
 *
 * ONLY PLAN AND PERFORMANCE ARE TOUCHED.
 *
 *   EMPLOYEES   kept. It is who the id refers to; deleting it turns every
 *               audit entry naming that id into a riddle.
 *   ASSIGNMENTS kept, and TARGETS too. Both are rebuilt from the source
 *               workbook by refreshFrameworkFromSource(), so deleting them
 *               achieves nothing that survives the next import.
 *   AUDIT       never touched, by anything.
 *
 * One of TWO destructive operations in the file — dsoAchievements_() also
 * deletes, though only the rows it wrote itself for the month in progress. It
 * reports every row it would remove, with its value, and writes nothing unless
 * called through cleanupLeaverRows(). It is deliberately absent from
 * DIAG_FUNCTIONS_, as is the DSO importer.
 * ======================================================================== */
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

/** DRY RUN — what a leaver cleanup would delete. Writes nothing. */
function previewLeaverCleanup() { return leaverCleanup_(true); }

/** DESTRUCTIVE — deletes the rows previewLeaverCleanup() lists. Run that first. */
function cleanupLeaverRows() { return leaverCleanup_(false); }
/** READ-ONLY, ZERO ARGUMENT — every person x KRA, with how many months carry
 *  a target and how many carry an achievement.
 *
 *  explainPerson() needs a name, and the Apps Script Run dropdown can only
 *  call functions that take none — so this is the version that works from the
 *  editor, and it answers the question for all 38 people rather than one.
 *
 *  Only rows with a GAP are listed. A person whose every assignment has both
 *  is summarised in one line, because a complete row tells you nothing and
 *  three hundred of them bury the ones that do. */
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
  /* A department where SOMEBODY has a target clearly has a source. Anyone in
     it with none is therefore an omission from the Target Sheet, not a
     department the sheet does not cover — and the two need telling apart, or
     a missing person hides inside a known structural gap forever. */
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
      /* Two gaps, and only one of them is anybody's to fix.
         A missing ACHIEVEMENT against an existing target is a blank cell in
         the Target Sheet — someone can go and fill it in today.
         A missing target AND achievement means that KRA has no target source
         at all, which is true of every Collections, Onboarding and Control
         Tower KRA because the Target Sheet has only Metals and Plastics tabs.
         Listing ~75 of those one per line buried the ten that matter and
         overflowed the log, so they are counted per DEPARTMENT instead. */
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
    /* a person whose only gaps are the no-target-source kind is already
       counted by department above; listing them again says nothing new */
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
/** READ-ONLY — every row the database holds for one person, month by month.
 *
 *  "Why is this cell blank?" has four different answers and they are
 *  indistinguishable on screen: no assignment, no target, no achievement, or
 *  a value that exists but is not being scored. This prints all four at once
 *  so the question stops needing a guess.
 *
 *    ?diag=explainPerson&arg=ABHISEK SANYAL
 */
function explainPerson(name) {
  ensureSeeded_();
  var nl = String.fromCharCode(10), out = [];
  var want = canonPersonName_(name || '');
  /* RETURNING IS NOT REPORTING. Run from the editor's Run button no argument
     can be passed, so this branch is the one that fires there — and returning
     a string without logging it showed the operator an empty execution log and
     no hint at all about why. Every exit from a diagnostic logs. */
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
/* ==========================================================================
 * WHAT ONE TEAM'S SCORECARD IS MADE OF, AND WHAT IS STOPPING IT SCORING
 *
 * explainPerson answers this for ONE person and prints every month. Planning a
 * team's measurement needs the other shape: every person, at the KPI level,
 * with the months collapsed to two counts — how many have a target, how many
 * have an achievement.
 *
 * It ends with the only list that matters when the question is "what do we
 * build next": the KPIs that have nowhere for a number to come from. Those are
 * four different jobs and they must not share a counter — one is a blank cell
 * somebody can fill in today, one is a ladder nobody can rate, and two are a
 * pipeline that has to be built. Counting them together is how "half the app
 * has no target" stayed one undifferentiated number.
 *
 * Read-only. It reads the stored tables and writes nothing.
 * ======================================================================== */
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

  /* RETURNING IS NOT REPORTING — the Run button passes no argument, and a
     silent return leaves the operator with an empty execution log. */
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

  /* Months with a numeric target, and months with a numeric achievement, per
     person per KPI. A blank and a zero are different answers, and num_ keeps
     them apart — counting truthiness would read a real zero as missing. */
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
  /* the LATEST ladder, not the first: bands get revised and the old row stays */
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

  /* ---- decide every row first, then print ------------------------------
     THE SUMMARY GOES FIRST because Apps Script truncates a long execution
     log from the BOTTOM. Printed last, the one part worth reading — what the
     team still needs — is the one part that gets cut. */
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

      /* WHAT THE LADDER MEANS DEPENDS ON WHETHER A TARGET EXISTS, and saying
         otherwise is how this was got wrong. A 0.8 | 0.85 | 0.9 | 0.95 | 1
         ladder is NOT automatically "achieved / target": buildModel_ divides
         only when that person-and-KPI has a PLAN target in some month
         (planEver). With no target anywhere, the stored number IS the rate
         and it is read against the bands directly — which is how the
         Collections percentages already score. */
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
        /* The common OMP case, and it needs ONE number, not two. */
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

/* Zero-argument, because the Run dropdown only offers functions it can call
   with none — and "what does this team still need" is exactly the question
   somebody asks from the editor, where no argument can be passed. Same
   reason explainDso() takes none. */
function explainOMP() { return explainTeam('OMP'); }
function explainCollectionsTeam() { return explainTeam('Collections'); }
function explainOnboardingTeam() { return explainTeam('Onboarding'); }

/* ==========================================================================
 * WHY A DSO NUMBER IS OR IS NOT ON THE DASHBOARD
 *
 * Zero-argument, because the Apps Script Run dropdown only offers functions it
 * can call with none — and the question "why is achieved still blank" is
 * exactly the one somebody asks when they cannot pass an argument.
 *
 * It reads the STORED rows and then builds the model, and prints both side by
 * side. That is the point: if the stored actual is there and the model row is
 * empty, the fault is in the model; if neither has it, the import never wrote
 * it; if both have it, the number is on the dashboard and the question is
 * which month is being looked at.
 * ======================================================================== */
function explainDso() {
  ensureSeeded_();
  var nl = String.fromCharCode(10), out = [];
  var emps = read_(T.EMPLOYEES), teamById = idx_(read_(T.TEAMS));
  var kras = idx_(read_(T.KRAS)), kpis = idx_(read_(T.KPIS));
  var periods = read_(T.PERIODS).slice().sort(function (a, b) {
    return (num_(a.sort) || 0) - (num_(b.sort) || 0); });

  /* everybody holding a DSO KRA, in ANY team — scoping to Plastic here would
     hide the very thing somebody might be looking for */
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

  /* THE LOG TRUNCATES, and it truncated the model section — which is the only
     part that answers the question. So: only months that carry something are
     printed, people with nothing at all are reduced to one line, and the model
     section runs FIRST so it survives whatever is cut. */
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

  /* --- and what the model makes of it ----------------------------------- */
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
/* every diagnostic logs what it returns, so the editor never shows a blank run */
function logBack_(txt) { Logger.log(txt); return txt; }
/** Run from the editor when someone is denied unexpectedly. Read-only: prints the
 *  address the session resolves to and the address in every USERS row exactly as
 *  the server reads it, with lengths, so a stray space or a wrong column shows up. */
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

/** Edit the five target bands for one person's KPI. Bands are free text by
 *  design — the workbook holds "> 28 Days" and "≥ ₹9 Cr" — so validation
 *  checks interpretability and ladder direction, not numeric format. */
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
    /* the level depends on the ladder, so re-resolve it now */
    recomputeOne_(p.employee_id, p.kpi_id, p.period_id, s.name);
    audit_(s.name, 'target', id, 'edit_bands', old,
      { t1: bands[0], t2: bands[1], t3: bands[2], t4: bands[3], t5: bands[4] },
      'kind=' + parsed.kind + ' direction=' + parsed.direction);
    var _m = buildModel_(p.period_id); commit_();
    return jsonSafe_({ ok: true, parsed: parsed, model: scopeModel_(_m, s) });
  } catch (e) { return { ok: false, error: String(e && e.message || e), where: 'apiSaveTargets' }; }
}

/** Edit the KRA/KPI definition and weightage carried by one assignment. */
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
    var _m = buildModel_(p.period_id); commit_();
    return jsonSafe_({ ok: true, model: scopeModel_(_m, s) });
  } catch (e) { return { ok: false, error: String(e && e.message || e), where: 'apiSaveAssignment' }; }
}

/** Remove a KPI from one person's scorecard (the definition stays in the catalogue). */
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

/* ==========================================================================
 * THE CUSTOMERS BEHIND AN ACHIEVEMENT
 *
 * A scorecard says "GMV 7.19 Cr" and "DSO 29.8 days". Neither tells the person
 * WHICH accounts produced it, and that is the first thing anybody asks — both
 * to act on it and to check it.
 *
 * This returns one row per customer for whom the person is the POC, over the
 * chosen period, from Raw_Shipments: how many shipments, the value with tax,
 * what has been collected, the debit notes, and what is still outstanding.
 *
 * BOTH SIDES ARE REPORTED, labelled. A person can be the seller POC on some
 * accounts and the buyer POC on others, and their KRAs draw on both: seller
 * KRAs on the sell side, DSO on the buy side. Guessing one side from the KPI
 * name would silently hide half of somebody's book.
 *
 * READ-ONLY, and scoped: a viewer may only see a person they could already see
 * on the dashboard. Reads MM_CT live rather than from the model, so it is one
 * round trip and deliberately NOT part of apiModel — 324 shipment rows joined
 * to the POC maps on every dashboard load would be paid for by everybody, to
 * be looked at by almost nobody.
 * ======================================================================== */
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

    /* which months: one, or every closed month under YTD */
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
      /* a negative receivable is zero, the same rule the DSO import applies */
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
/** Record an actual (numeric ladders) or award a level (ordinal/qualitative). */
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
 * DERIVED MONTHLY TARGETS
 *
 * A few KRAs get no target typed into the Target Sheet, because the target is
 * a PERCENTAGE OF A COUNT that is only known once the month has run:
 *
 *   Transaction from Existing Sellers        rate x sellers onboarded BEFORE this month
 *   Transaction from New Onboarded Sellers   rate x sellers onboarded DURING this month
 *   Retention of Existing Transacted Sellers rate x sellers who TRANSACTED last month
 *   Transaction from New Onboarded Buyers    rate x buyers onboarded DURING this month
 *
 * THE RATE IS NOT HARDCODED.  Each KPI's own goal text already states it, and
 * the two teams do not agree: Metal asks for 50% retention while Plastic asks
 * for 70%, and the seller-side rules do not exist on Metal at all (its
 * equivalent is buyer-based).  Reading the rate off the goal keeps every team
 * correct without a second table to maintain, and it means editing the
 * workbook's wording changes the target — which is where that decision belongs.
 *
 * Rounding is UP.  "At least 70% of 7 sellers" is 4.9 sellers, and you cannot
 * hit 70% with 4 — so the target is 5.  Rounding down would hand out a target
 * that is below the stated threshold.
 * ======================================================================== */

/* Which count each KRA's target is a share of.  Keyed by the KRA name reduced
 * to lowercase words, so trailing spaces and case in the workbook do not
 * decide whether a rule fires. */
var DERIVED_BASE = {
  'transaction from existing sellers':        'sellers_onboarded_before_month',
  'transaction from new onboarded sellers':   'sellers_onboarded_in_month',
  'retention of existing transacted sellers': 'sellers_transacted_prev_month',
  'transaction from new onboarded buyers':    'buyers_onboarded_in_month'
};
function derivedBaseKey_(kraName) {
  var k = String(kraName == null ? '' : kraName).toLowerCase()
    .replace(/[^a-z]+/g, ' ').trim();
  return DERIVED_BASE[k] || null;
}

/* The rate stated in a KPI's goal text: "at least 70% of sellers ..." -> 0.7.
 * Returns null when the goal states no percentage, which is the signal that a
 * target has to be typed in rather than derived. */
function goalRate_(goal) {
  var m = String(goal == null ? '' : goal).match(/(\d+(?:\.\d+)?)\s*%/);
  if (!m) return null;
  var pct = parseFloat(m[1]);
  if (!isFinite(pct) || pct <= 0 || pct > 100) return null;
  return pct / 100;
}

/* rate x base, rounded up, never negative */
function derivedTarget_(base, rate) {
  var b = num_(base), r = num_(rate);
  if (b === null || r === null || b < 0) return null;
  return Math.ceil(b * r - 1e-9);   /* the epsilon keeps 10 x 0.5 at 5, not 6 */
}

/* The whole rule for one assignment: which count, what rate, what target.
 * `counts` is the per-person, per-month bundle that the achievements workbook
 * will supply. Returns null when this KRA is not one of the derived ones, or
 * when the count it needs is missing — a missing count must leave the target
 * blank rather than silently become zero. */
function derivedTargetFor_(kraName, goal, counts) {
  var key = derivedBaseKey_(kraName);
  if (!key) return null;
  var rate = goalRate_(goal);
  if (rate === null) return null;
  var base = counts ? counts[key] : null;
  if (base === null || base === undefined || base === '') return null;
  var target = derivedTarget_(base, rate);
  if (target === null) return null;
  return { base_key: key, base: num_(base), rate: rate, target: target };
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
    if (name.indexOf('_KKT_') === 0) return;                    /* managed tabs, not definitions */
    var last = sh.getLastRow(), lastC = Math.max(sh.getLastColumn(), 12);
    if (last < 2) return;
    var grid = sh.getRange(1, 1, last, lastC).getValues();
    blocks = blocks.concat(blocksFromGrid_(grid, name));
  });
  var people = blocks.filter(function (b) { return b.isPerson; });
  if (!people.length) throw new Error('No individual KRA/KPI blocks were found in that workbook.');

  /* "Replace" must not reach beyond what is being imported. Clearing the whole
     TARGETS table destroyed every other month: importing September wiped
     August, whose recorded actuals then had no ladder left to score against.
     And clearing every assignment deleted the scorecards of anyone absent
     from this import. So drop only this period's targets, and only for the
     people this workbook actually contains. */
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
/* ==========================================================================
 * WHICH SPREADSHEET IS THE BACKEND?
 *
 * Written on 29 Sep 2026, after ss_() spent weeks quietly minting replacement
 * backends whenever openById failed (see HANDOVER §20). Drive ended up holding
 * four candidates with near-identical names, and choosing between them by
 * eye — by date, or by which row of a search result was highlighted — put a
 * WRONG id into PERFORMOS_DB_ID twice.
 *
 * So this does not ask anybody to recognise a file. It opens every candidate
 * and reports what is actually inside it: how many employees, how many
 * assignments, how many performance rows, and when it was last touched. The
 * one with rows in it is the database. Copy its id.
 *
 * DELIBERATELY DOES NOT CALL ensureSeeded_(), and must not: that goes through
 * ss_(), which throws when the current pointer is broken — which is exactly
 * when somebody needs to run this.
 *
 * Read-only. It opens files and counts rows; it writes nothing anywhere.
 * ======================================================================== */
function findBackends() {
  var nl = String.fromCharCode(10), out = [];
  var props = PropertiesService.getScriptProperties();
  var current = props.getProperty(PROP_DB) || '(not set)';

  out.push('PERFORMOS_DB_ID is currently: ' + current);
  out.push('');

  /* Every spreadsheet whose name looks like a backend, however it was named
     when it was made — the app has been called PerformOS and Performance
     Tracker at different times. */
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
  /* and the current pointer, even if its name does not match — it may be the
     right file under a name nobody expected */
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

/* ==========================================================================
 * POINT THE APP AT THE BACKEND THAT ACTUALLY HAS THE DATA
 *
 * PERFORMOS_DB_ID was set by hand three times on 29 Sep 2026 and was wrong
 * every time — two of the three ids were not files this account could open at
 * all. That is not carelessness: a Google file id is 44 characters of noise,
 * it is copied out of a URL among a dozen open tabs, and nothing checks it
 * until the whole dashboard is blank.
 *
 * So the id stops being typed. This finds the candidate with the most
 * employees in it, sets the property to that, and then REOPENS it to prove the
 * app can reach it before reporting success.
 *
 * It writes exactly one script property and nothing else. It creates no
 * spreadsheet, touches no row, and refuses outright if no candidate has any
 * employees — there is no sense repointing at another empty file.
 * ======================================================================== */
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
      } catch (e) { /* cannot open it, so it cannot be the answer */ }
    }
  });

  out.push('looked at ' + looked + ' candidate spreadsheet(s)');
  if (!best) {
    out.push('');
    out.push('NOTHING CHANGED. No candidate has a single employee in it.');
    out.push('Rebuild instead: refreshFrameworkFromSource() then importTargets().');
    var none = out.join(nl); Logger.log(none); return none;
  }

  /* TIE-BREAK ON PERFORMANCE ROWS, not just employees. Two backends can both
     hold the full 38-person framework while only one carries the achievements
     — which is exactly the case here, and picking the wrong one would look
     right and quietly lose every imported number. */
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
  _SS = null;   /* drop the cached handle, or this run keeps the old one */

  /* PROVE IT, rather than report success on having written a string. */
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
  /* SEEDING MUST NOT EMPTY A DATABASE THAT ALREADY HAS PEOPLE IN IT.
     The eight lines below wipe every table. That is right for a new backend
     and catastrophic for a live one, and the only thing standing between them
     was a single script property: lose PERFORMOS_SEEDED and the next page load
     empties the company's scorecards. Seeding a populated database is now a
     refusal, not a silent reset — provisionAndSeed() is the deliberate way in
     and it clears the flag on purpose. */
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
    /* carries a real address: after the no_access fallback below, a re-seed with
       an empty USERS.email would lock every account out of the app */
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
  /* A HEADCOUNT IS NOT AN INVARIANT, AND ASSERTING ONE TRAINS PEOPLE TO IGNORE
     THIS TEST. These were pinned at 38 people and 208 rows — the SRC_SEED
     snapshot's figures. Both then went stale for two perfectly correct
     reasons: refreshFrameworkFromSource() took assignments to 225, and
     ABHISEK SANYAL became a leaver and is filtered out of the model. selfTest
     reported two failures for a database that was entirely healthy.

     So the counts are now REPORTED, and what is asserted is the thing that
     must hold whoever joins or leaves: every scorecard row belongs to a person
     the model knows about. An orphan row is a real fault; a changed headcount
     is a Tuesday. */
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

  /* every person's weightage must total 100 after normalisation */
  var bad = [];
  Object.keys(m.overalls).forEach(function (id) {
    var w = m.overalls[id].assigned_weightage;
    if (Math.abs(w - 100) > 0.5) bad.push(id + '=' + w);
  });
  /* 'for all 38' in the label went stale the same way. The count belongs in
     the message, where it cannot go out of date. */
  ck('weightage totals 100 for every one of ' + m.employees.length,
     bad.length ? bad.join(',') : 0, 0);

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
