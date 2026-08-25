/*******************************************************************************
 * Recykal - KRA / KPI Tracker
 * ============================================================================
 * Apps Script backend. Two files only: this and Index.html.
 *
 * The product does one job:
 *
 *   Team -> Employee -> KRA -> KPI -> Weightage -> Target -> Actual
 *        -> Achievement % -> Weighted Score -> Team / Individual view
 *
 * Everything else has been removed. What used to live here - a generic sheet
 * scanner that guessed at tab layouts, performance cycles, check-in history,
 * review workflows, assignment overrides, a health/diagnostics surface, a KPI
 * library, and a separate GMV/target-plan reader - predated the master model
 * and duplicated it. The master tables below are now the only source of truth.
 *
 * Master data (teams, people, KRAs, KPIs, weightages, thresholds, mappings) is
 * defined here and provisioned into the sheet. Targets and actuals are period
 * data and live only in the sheet, so a month can be loaded without touching
 * code.
 *******************************************************************************/

var BACKEND_SHEET_ID = '16I2P3N9k2I0e4Xa0jWWdqWl0kpgHxw6tU-Y1sviwsTw';

/* How many periods the month selector offers, counting back from the current
 * month. Three, so it reads June / July / August rather than a half-year of
 * mostly empty periods. Raise it when more history is worth comparing - the
 * trends on the profile draw from exactly this list, so widening the window
 * lengthens them and nothing else has to change. */
var MONTH_WINDOW = 3;

function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('Recykal · KRA / KPI Tracker')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
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
/**
 * Derives the six master tables from the constants at the top of this file,
 * in memory, writing nothing.
 *
 * This is the single derivation. provisionMaster() writes its output to the
 * sheet; apiMasterModel() uses it directly when the sheet has not been
 * provisioned. That distinction matters: master data is frozen in code, so the
 * sheet is a convenience for viewing and editing it, never a prerequisite for
 * the app to run. Only targets and actuals genuinely live in the sheet.
 */
function buildMaster_() {
  var teamOf = {};
  PEOPLE.forEach(function (p) { teamOf[p[0]] = p[2]; });

  var teams = TEAMS.map(function (t) { return [t[0],t[1],t[2],t[3],t[4],t[5],'TRUE']; });
  var emps  = PEOPLE.map(function (p) {
    return [p[0],p[1],p[2],p[3],p[4],p[5],'ACTIVE','','', UNMAPPED_NOTE[p[0]] || ''];
  });

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

  var byEmp = {}, issues = [];
  mapRows.forEach(function (m) { byEmp[m[1]] = (byEmp[m[1]] || 0) + Number(m[3]); });
  Object.keys(byEmp).forEach(function (e) {
    if (Math.round(byEmp[e]) !== 100) issues.push(e + ' totals ' + byEmp[e] + '%');
  });

  return { teams: teams, emps: emps, kras: kraRows, kpis: kpiRows,
           maps: mapRows, thr: thrRows, byEmp: byEmp, issues: issues };
}

/**
 * Writes the derived master into the sheet. Optional: the app runs without it.
 * Master tabs are rewritten; the three performance tabs are created but never
 * cleared, so re-freezing the master cannot destroy a month of actuals.
 */
function provisionMaster() {
  var M = buildMaster_();
  var teams = M.teams, emps = M.emps, kraRows = M.kras, kpiRows = M.kpis,
      mapRows = M.maps, thrRows = M.thr, byEmp = M.byEmp, issues = M.issues;

  mWrite_(M_TAB.TEAM, teams);
  mWrite_(M_TAB.EMP, emps);
  mWrite_(M_TAB.KRA, kraRows);
  mWrite_(M_TAB.KPI, kpiRows);
  mWrite_(M_TAB.MAP, mapRows);
  mWrite_(M_TAB.THR, thrRows);
  mTab_(M_TAB.TGT); mTab_(M_TAB.ACT); mTab_(M_TAB.PERF);

  /* Controlled enumerations, applied by COLUMN NAME rather than index, so a
   * schema change moves the rule with the column instead of stranding it. */
  var REGIONS = TEAMS.length ? uniq_(PEOPLE.map(function (p) { return p[4]; }).filter(String)) : [];
  mValidate_(M_TAB.EMP, 'region', REGIONS);
  mValidate_(M_TAB.EMP, 'employment_status', ['ACTIVE', 'INACTIVE']);
  mValidate_(M_TAB.KPI, 'measurement_type', ['CR', 'MT', 'COUNT', 'PERCENT', 'DAYS']);
  mValidate_(M_TAB.KPI, 'direction', ['HIGHER_IS_BETTER', 'LOWER_IS_BETTER']);
  mValidate_(M_TAB.TGT, 'target_unit', ['CR', 'MT', 'COUNT', 'PERCENT', 'DAYS']);
  mValidate_(M_TAB.ACT, 'actual_unit', ['CR', 'MT', 'COUNT', 'PERCENT', 'DAYS']);

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
function uniq_(list) {
  var seen = {}, out = [];
  list.forEach(function (v) { if (v !== '' && v != null && !seen[v]) { seen[v] = 1; out.push(v); } });
  return out;
}
function mTab_(name) {
  var ss = bkSS_(), sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  var h = M_SCHEMA[name];
  /* Clear any validation the sheet is already carrying BEFORE writing.
   * A rule survives a schema change and then rejects perfectly correct data:
   * an earlier version of this backend put region in column 7, so that column
   * held an East/South/Central rule, and writing the current column 7 -
   * employment_status - failed with "the data you entered violates the data
   * validation rules". Provisioning owns the shape of these tabs, so it clears
   * first and re-applies afterwards against the CURRENT schema. */
  sh.getRange(1, 1, sh.getMaxRows(), sh.getMaxColumns()).clearDataValidations();
  /* A tab that already exists may be narrower than the schema - someone tidied
   * it, or an older version had fewer columns - and getRange past the edge
   * throws rather than growing the sheet. Widen before writing. */
  if (sh.getMaxColumns() < h.length) sh.insertColumnsAfter(sh.getMaxColumns(), h.length - sh.getMaxColumns());
  sh.getRange(1, 1, 1, h.length).setValues([h]).setFontWeight('bold').setBackground('#F2F0E8');
  sh.setFrozenRows(1);
  return sh;
}
function mWrite_(name, rows) {
  var sh = mTab_(name), h = M_SCHEMA[name];
  /* Same for height: 322 threshold rows do not fit a sheet trimmed to 50. */
  var need = rows.length + 1;
  if (sh.getMaxRows() < need) sh.insertRowsAfter(sh.getMaxRows(), need - sh.getMaxRows());
  if (sh.getLastRow() > 1) sh.getRange(2, 1, sh.getLastRow() - 1, h.length).clearContent();
  if (rows.length) sh.getRange(2, 1, rows.length, h.length).setValues(rows);
  return rows.length;
}

/* Validation is applied AFTER the data, and only to columns that exist in the
 * current schema. Applying it before writing is what made provisioning
 * self-defeating: the rule rejected the very rows provisioning was placing. */
function mValidate_(name, colName, list) {
  var h = M_SCHEMA[name], col = h.indexOf(colName) + 1;
  if (!col) return;
  var sh = bkSS_().getSheetByName(name);
  if (!sh) return;
  if (!list || !list.length) return;
  var rule = SpreadsheetApp.newDataValidation()
    .requireValueInList(list, true).setAllowInvalid(false).build();
  /* Never ask for more rows than the sheet has. Math.max(maxRows-1, 200) reads
   * as a sensible floor but reaches past the last row on any sheet shorter
   * than 201, and getRange throws rather than clamping. */
  var rows = sh.getMaxRows() - 1;
  if (rows > 0) sh.getRange(2, col, rows, 1).setDataValidation(rule);
}
/* Reads are non-fatal. An unreachable or unprovisioned sheet means "no period
 * data yet", not a broken app - the master is in code, so structure renders
 * either way and only targets and actuals are missing. */
function mRead_(name) {
  var ss = null;
  try { ss = bkSS_(); } catch (e) { return []; }
  var sh = ss.getSheetByName(name);
  if (!sh || sh.getLastRow() < 2) return [];
  var h = M_SCHEMA[name], v = sh.getRange(2, 1, sh.getLastRow() - 1, h.length).getValues();
  return v.filter(function (r) { return String(r[0]).trim() !== ''; })
          .map(function (r) { var o = {}; h.forEach(function (k, i) { o[k] = r[i]; }); return o; });
}

/**
 * The record shape the frontend consumes. It carries no business logic: every
 * derived value is already computed here, so the UI only ever visualises.
 */
/**
 * Entry point the client calls. google.script.run hands the browser `null`
 * when a server function throws OR when its return value cannot be serialised,
 * and the client cannot tell those apart - which is exactly how a real failure
 * arrived on screen as a useless "returned no data". So the whole body runs
 * inside a guard that converts any throw into a plain, serialisable object the
 * UI can actually show.
 */
function apiMasterModel(teamId, month) {
  try {
    return jsonSafe_(buildModel_(teamId, month));
  } catch (e) {
    return { ok: false,
             error: String(e && e.message || e),
             where: 'apiMasterModel',
             stack: String(e && e.stack || '').split('\n').slice(0, 4).join(' | ') };
  }
}

/** Smallest possible round trip. If this succeeds and apiMasterModel does not,
 *  the problem is the payload, not the deployment or permissions. */
function apiPing() {
  return { ok: true, ping: 'ok', teams: TEAMS.length, people: PEOPLE.length,
           assignments: ASSIGNMENTS.length, at: new Date().toISOString() };
}

function buildModel_(teamId, month) {
  /* Master comes from the sheet when it has been provisioned, and from the
   * frozen definitions in this file when it has not. Either way the structure
   * is identical, because provisionMaster() writes exactly what buildMaster_()
   * returns. This is why the app needs no setup step to render. */
  var teams = mRead_(M_TAB.TEAM), emps = mRead_(M_TAB.EMP);
  var kras = mRead_(M_TAB.KRA), kpis = mRead_(M_TAB.KPI), maps = mRead_(M_TAB.MAP);
  var fromSheet = emps.length > 0 && maps.length > 0;
  if (!fromSheet) {
    var M = buildMaster_(), asObj = function (rows, schema) {
      return rows.map(function (r) { var o = {}; schema.forEach(function (k, i) { o[k] = r[i]; }); return o; });
    };
    teams  = asObj(M.teams, M_SCHEMA[M_TAB.TEAM]);
    emps   = asObj(M.emps,  M_SCHEMA[M_TAB.EMP]);
    kras   = asObj(M.kras,  M_SCHEMA[M_TAB.KRA]);
    kpis   = asObj(M.kpis,  M_SCHEMA[M_TAB.KPI]);
    maps   = asObj(M.maps,  M_SCHEMA[M_TAB.MAP]);
  }
  var kraById = {}; kras.forEach(function (k) { kraById[k.kra_id] = k; });
  var kpiById = {}; kpis.forEach(function (k) { kpiById[k.kpi_id] = k; });
  /* Targets and actuals only ever come from the sheet - they are period data,
   * never frozen in code. Absent means "not loaded yet", not zero. */
  var tgt = mRead_(M_TAB.TGT), act = mRead_(M_TAB.ACT);
  tgt.forEach(function (r) { r.month = monthKey_(r.month); });
  act.forEach(function (r) { r.month = monthKey_(r.month); });

  /* The month this model is built for is resolved ONCE, here, before anything
   * reads it - so the data and the header can never disagree. An explicit
   * selection wins; absent that the anchor is the newest month that actually
   * HAS data, never the server's wall clock. (An earlier version left month
   * null on first load: find() then dropped its filter and matched the first
   * row of ANY month - target and actual independently, so a card could even
   * mix two periods - while the header was labelled the latest month. And a
   * clock-based default made the landing period a synthetic, empty month
   * whenever the newest data lagged the server date.) */
  var dataSeen = {}, dataMonths = [];
  tgt.concat(act).forEach(function (r) {
    if (r.month && !dataSeen[r.month]) { dataSeen[r.month] = 1; dataMonths.push(r.month); }
  });
  dataMonths.sort();
  var anchor = dataMonths.length ? dataMonths[dataMonths.length - 1]
                                 : Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM');
  var effMonth = month || anchor;

  function find(list, empId, kpiId) {
    var h = list.filter(function (r) { return r.employee_id === empId && r.kpi_id === kpiId && r.month === effMonth; })[0];
    return h || null;
  }
  var scorecards = emps
    .filter(function (e) { return !teamId || e.team_id === teamId; })
    .map(function (e) {
      var rows = maps.filter(function (m) { return m.employee_id === e.employee_id && String(m.applicable).toUpperCase() !== 'FALSE'; })
        .map(function (m) {
          var kpi = kpiById[m.kpi_id] || {}, kra = kraById[kpi.kra_id] || {};
          var t = find(tgt, e.employee_id, m.kpi_id), a = find(act, e.employee_id, m.kpi_id);
          var tv = t ? numOrNull_(t.target_value) : null, av = a ? numOrNull_(a.actual_value) : null;
          var ach = (tv == null || av == null) ? null : achievementPct_(tv, av, kpi.direction, kpi.measurement_type);
          var wt = numOrNull_(m.weightage);
          var ws = wt == null ? null : weightedScore_(wt, ach);
          var lvl = ach == null ? null : (ach >= 100 ? 5 : ach >= 90 ? 4 : ach >= 75 ? 3 : ach >= 60 ? 2 : 1);
          /* Deliberately lean: every field here is read by the UI, nothing is
           * sent "in case". */
          return { kpi_id: String(m.kpi_id),
                   perspective: String(kra.perspective || ''),
                   kra: String(kra.kra_name || ''),
                   kpi: String(kpi.kpi_name || ''),
                   weightage: wt == null ? 0 : wt,
                   goal: String(kpi.goal_description || ''),
                   source: String(kpi.source_of_tracking || ''),
                   unit: String(kpi.measurement_type || ''),
                   direction: String(kpi.direction || ''),
                   target: tv, actual: av, achievement: ach,
                   variance: (tv == null || av == null) ? null : round1_(av - tv),
                   weighted_score: ws, level: lvl,
                   status: statusFor_(ach, lvl) };
        });
      var earned = 0, measured = 0;
      rows.forEach(function (r) {
        if (r.weighted_score == null || !isFinite(r.weighted_score)) return;
        earned += r.weighted_score; measured += Number(r.weightage) || 0;
      });
      /* A person's own achievement is the weighted score restated over the
       * weightage actually measured, so it sits on the same 0-105 scale as a
       * KPI and can carry the same status label on the flowchart node. */
      var memberAch = measured > 0 ? Math.round(earned / measured * 1000) / 10 : null;
      return { employee_id: e.employee_id, employee_name: e.employee_name, team_id: e.team_id,
               designation: e.designation, region: e.region,
               reporting_manager: String(e.reporting_manager || ''),
               kpis: rows,
               measured_weightage: measured,
               overall_score: measured > 0 ? Math.round(earned * 10) / 10 : null,
               kpi_achievement: memberAch,
               status: statusFor_(memberAch, null) };
    });
  /* Periods: the data months plus a look-back, trimmed to the last MONTH_WINDOW.
   *
   * The look-back is anchored to the newest month that HAS data - not the wall
   * clock - so the selector stays correct even when the newest data lags the
   * server date. The window is the last MONTH_WINDOW periods and no more; two
   * sources feed the list (sheet rows and the look-back) and either could widen
   * it, so the trim is applied after they are merged rather than to one of them.
   * Nothing is pinned to a literal month: the window rolls forward on its own as
   * the sheet grows. */
  var seen = {}, months = [];
  dataMonths.forEach(function (mk) { if (!seen[mk]) { seen[mk] = 1; months.push(mk); } });
  var ay = Number(anchor.slice(0, 4)), am = Number(anchor.slice(5, 7));
  for (var i = 0; i < MONTH_WINDOW; i++) {
    var back = Utilities.formatDate(new Date(ay, am - 1 - i, 1), Session.getScriptTimeZone(), 'yyyy-MM');
    if (!seen[back]) { seen[back] = 1; months.push(back); }
  }
  months.sort();
  if (months.length > MONTH_WINDOW) months = months.slice(months.length - MONTH_WINDOW);
  /* Freshness metadata, named exactly as the client reads it (generated_at,
   * source, records) so the data-freshness panel is wired, not guessing.
   * records is the count of KPI instances that actually have a result this
   * period - the honest measure of how much data backs the numbers on screen. */
  var records = scorecards.reduce(function (s, sc) {
    return s + sc.kpis.filter(function (k) { return k.achievement != null; }).length;
  }, 0);
  return { ok: true, month: effMonth, months: months,
           teams: teams, scorecards: scorecards,
           source: fromSheet ? 'Google Sheet' : 'Master data (in code)',
           records: records,
           generated_at: new Date().toISOString() };
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

/* Null-safe rounding to one decimal. Null in, null out - a missing measurement
 * must stay missing rather than becoming a confident zero. */
function round1_(x) { return x == null || isNaN(x) ? null : Math.round(Number(x) * 10) / 10; }

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
function achievementPct_(target, actual, direction, unit) {
  var t = Number(target), a = Number(actual);
  if (!isFinite(t) || !isFinite(a)) return null;
  if (t === 0) return null;
  if (direction === 'LOWER_IS_BETTER') {
    /* Zero is not a real measurement for a DAYS KPI (a DSO of 0 days means "not
     * recorded"), but for a rate that is lower-is-better - a debit-note rate of
     * exactly 0% - it is the best possible outcome and must score full marks,
     * not drop out. t/0 -> Infinity -> capped at 105. */
    if (a === 0 && unit === 'DAYS') return null;
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

/* The single status contract for the whole product (UI/UX spec §12): a KPI or a
 * person is Exceeded / On Track / At Risk / Off Track, or Pending Data when no
 * actual has arrived. The thresholds live here and nowhere else, so every
 * surface - flowchart node, performance chart, drawer pill, dashboard filter -
 * labels the same number the same way. `level` is retained for the colour tone
 * the client already derives; the label is driven by achievement directly. */
function statusFor_(achPct, level) {
  if (achPct == null) return 'Pending Data';
  if (achPct >= 100) return 'Exceeded';
  if (achPct >= 90) return 'On Track';
  if (achPct >= 75) return 'At Risk';
  return 'Off Track';
}

/* ---------------------------------------------------------------------------
 * Why these two exist: google.script.run cannot serialize NaN or Infinity. A
 * single one anywhere in the payload does not throw and does not arrive as
 * null in that field - it makes the WHOLE return arrive as null, which the UI
 * can only report as "the server function returned nothing". A sheet cell
 * holding "-", "TBD" or "40%" was enough to blank the entire dashboard.
 *
 * numOrNull_  stops NaN at the point a cell is read.
 * jsonSafe_   is the backstop: nothing leaves this file non-serializable,
 *             whatever a future field does.
 * ------------------------------------------------------------------------ */
function numOrNull_(v) {
  if (v === null || v === undefined || v === '') return null;
  var n = typeof v === 'number' ? v : Number(String(v).replace(/[,\s%]/g, ''));
  return isFinite(n) ? n : null;
}

/**
 * A "month" cell in MONTHLY_TARGETS / ACTUAL_PERFORMANCE arrives as a real
 * Date whenever Sheets auto-detects the typed value as a date (which it does
 * for "07/2026", "Jul 2026", etc) - getValues() then hands back a JS Date,
 * not text. Left alone, that Date rides all the way to the client, where
 * jsonSafe_ stringifies it to a full ISO timestamp: the month selector shows
 * "2026-07-01T00:00:00.000Z" instead of "July 2026", sort() orders months by
 * weekday name instead of chronologically, and - the real damage - equality
 * filtering in find() (Date !== the string the client echoes back) silently
 * stops matching targets/actuals to any explicitly-selected month.
 * Normalized once here, at the only place a month value enters the system,
 * so everything downstream can assume a plain 'YYYY-MM' string.
 */
function monthKey_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM');
  var s = String(v == null ? '' : v).trim();
  var iso = /^(\d{4})-(\d{1,2})/.exec(s);
  if (iso) return iso[1] + '-' + ('0' + iso[2]).slice(-2);
  var mdy = /^(\d{1,2})[\/\-](\d{4})$/.exec(s);
  if (mdy) return mdy[2] + '-' + ('0' + mdy[1]).slice(-2);
  return s;
}

function jsonSafe_(o) {
  if (o === null || o === undefined) return null;
  var t = typeof o;
  if (t === 'number') return isFinite(o) ? o : null;
  if (t === 'string' || t === 'boolean') return o;
  if (o instanceof Date) return o.toISOString();
  if (Object.prototype.toString.call(o) === '[object Array]') {
    var a = [];
    for (var i = 0; i < o.length; i++) a.push(jsonSafe_(o[i]));
    return a;
  }
  if (t === 'object') {
    var out = {};
    for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) {
      var v = jsonSafe_(o[k]);
      if (v !== undefined) out[k] = v;
    }
    return out;
  }
  return null;                                  /* functions and the like */
}
