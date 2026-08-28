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
  TGT:'MONTHLY_TARGETS', ACT:'ACTUAL_PERFORMANCE', PERF:'KPI_PERFORMANCE',
  /* Transactional tabs written by the closed-loop layer (actions, comments,
   * reviews, audit). Created on first write; never rewritten wholesale. */
  ACTION:'ACTIONS', COMMENT:'KPI_COMMENTS', REVIEW:'REVIEWS', AUDIT:'AUDIT_LOG',
  /* Per (team, month) planning state for the monthly target lifecycle
   * (Planning -> Open -> Closed -> Reopened). Created on first state change. */
  MONTHSTATE:'MONTH_STATE'
};

var M_SCHEMA = {};
M_SCHEMA[M_TAB.TEAM] = ['team_id','team_name','team_short_code','team_type','team_lead','category_head','active'];
M_SCHEMA[M_TAB.EMP]  = ['employee_id','employee_name','team_id','designation','region','reporting_manager','employment_status','active_from','active_to','notes'];
M_SCHEMA[M_TAB.KRA]  = ['kra_id','team_id','perspective','kra_name','goal_description','active'];
M_SCHEMA[M_TAB.KPI]  = ['kpi_id','kra_id','kpi_name','goal_description','weightage','source_of_tracking','measurement_type','direction','target_type','threshold_set','active'];
M_SCHEMA[M_TAB.MAP]  = ['mapping_id','employee_id','kpi_id','weightage','effective_from','effective_to','applicable'];
M_SCHEMA[M_TAB.THR]  = ['threshold_id','kpi_id','level','threshold_value','threshold_unit','label','comparison_operator','threshold_not_defined'];
/* Lifecycle columns are APPENDED (never reordered): mRead_ maps by position, so
 * an older sheet that only has the first nine columns still reads correctly and
 * the new fields simply come back blank until a target is (re)saved. */
M_SCHEMA[M_TAB.TGT]  = ['target_id','month','team_id','employee_id','kpi_id','target_value','target_unit','target_source','approved','status','version','measurement_criteria','set_by','set_at','waived'];
M_SCHEMA[M_TAB.ACT]  = ['actual_id','month','team_id','employee_id','kpi_id','actual_value','actual_unit','source','updated_at'];
M_SCHEMA[M_TAB.PERF] = ['performance_id','month','team_id','employee_id','kpi_id','target','actual','achievement_percentage','variance','weighted_score','performance_level','status'];
M_SCHEMA[M_TAB.ACTION]  = ['action_id','created_at','updated_at','month','team_id','employee_id','kpi_id','title','root_cause','priority','status','due_date','resolution','created_by'];
M_SCHEMA[M_TAB.COMMENT] = ['comment_id','created_at','month','team_id','employee_id','kpi_id','author','kind','text'];
M_SCHEMA[M_TAB.REVIEW]  = ['review_id','cycle','month','team_id','employee_id','self_rating','self_comment','mgr_rating','mgr_comment','final_rating','status','reviewer','submitted_at','finalized_at','updated_at'];
M_SCHEMA[M_TAB.AUDIT]   = ['audit_id','at','actor','object_type','object_id','action','detail'];
M_SCHEMA[M_TAB.MONTHSTATE] = ['state_id','month','team_id','state','note','changed_by','changed_at'];

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
  /* Closed-loop data: corrective actions and KPI comments/evidence. Flat lists
   * the client filters by employee / KPI; kept whole so cross-cutting views
   * (Action Tracker, overdue counts) need no extra round trip. */
  var actions = mRead_(M_TAB.ACTION); actions.forEach(function (r) { r.month = monthKey_(r.month); });
  var comments = mRead_(M_TAB.COMMENT); comments.forEach(function (r) { r.month = monthKey_(r.month); });
  var reviews = mRead_(M_TAB.REVIEW); reviews.forEach(function (r) { r.month = monthKey_(r.month); });
  var auditAll = mRead_(M_TAB.AUDIT); var audit = auditAll.slice(Math.max(0, auditAll.length - 80)).reverse();

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
          var unit = String(kpi.measurement_type || '');
          var sup = suppressTarget_(unit, tv);
          var ach = (sup || tv == null || av == null) ? null : achievementPct_(tv, av, kpi.direction, unit, kpi.target_type);
          var wt = numOrNull_(m.weightage);
          var ws = wt == null ? null : weightedScore_(wt, ach);
          var lvl = ach == null ? null : (ach >= 100 ? 5 : ach >= 90 ? 4 : ach >= 75 ? 3 : ach >= 60 ? 2 : 1);
          /* Deliberately lean: every field here is read by the UI, nothing is
           * sent "in case". target_* carry the lifecycle so the Targets screen
           * can show whether a month's target is a draft or an approved baseline. */
          return { kpi_id: String(m.kpi_id),
                   perspective: String(kra.perspective || ''),
                   kra: String(kra.kra_name || ''),
                   kpi: String(kpi.kpi_name || ''),
                   weightage: wt == null ? 0 : wt,
                   goal: String(kpi.goal_description || ''),
                   source: String(kpi.source_of_tracking || ''),
                   unit: unit,
                   direction: String(kpi.direction || ''),
                   target: tv, actual: av, achievement: ach,
                   variance: (tv == null || av == null) ? null : round1_(av - tv),
                   weighted_score: ws, level: lvl,
                   status: statusFor_(ach, lvl),
                   target_status: targetStatus_(t),
                   target_version: t ? (numOrNull_(t.version) || '') : '',
                   criteria: t ? String(t.measurement_criteria || '') : '',
                   waived: t ? (String(t.waived).toUpperCase() === 'TRUE') : false,
                   suppressed: sup };
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
  var model = { ok: true, month: effMonth, months: months,
           teams: teams, scorecards: scorecards,
           actions: actions, comments: comments, reviews: reviews, audit: audit,
           source: fromSheet ? 'Google Sheet' : 'Master data (in code)',
           records: records,
           generated_at: new Date().toISOString() };
  /* Overlay each employee's individual KRA/KPI configuration from the dedicated
   * config sheet. Defensive: if that sheet is missing, unshared or empty, the
   * base model passes through untouched. */
  try { applyTeamAssignments_(model); } catch (e) { model.config_note = String(e && e.message || e); }
  try { applyIndividualConfig_(model, effMonth); } catch (e) { model.config_note = String(e && e.message || e); }
  /* Monthly-target lifecycle: attach each team's planning state for this month,
   * then apply the close policy (a missing actual becomes a 0% miss once a month
   * is Closed, unless the target was explicitly waived). Both are no-ops until a
   * month is actually advanced, so untouched data behaves exactly as before. */
  try { model.month_states = readMonthStates_(effMonth); applyMonthClosePolicy_(model, effMonth); }
  catch (e) { model.month_state_note = String(e && e.message || e); }
  return model;
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
function achievementPct_(target, actual, direction, unit, calcType) {
  var t = Number(target), a = Number(actual);
  if (!isFinite(t) || !isFinite(a)) return null;
  /* Zero-defect / must-be-zero KPIs (e.g. "safety incidents = 0"): a zero target
   * is a real, different kind of goal, not "not asked this period". Nothing hits
   * this branch unless a KPI explicitly declares target_type ZERO, so no existing
   * score moves - it only opens the path the design calls for. */
  if (calcType === 'ZERO') return a <= 0 ? 100 : 0;
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

/* A COUNT target of less than one whole unit (the real "0.2 sellers = 20% of 1"
 * case) cannot be measured honestly: a single event reads as 500% and, capped,
 * hands over a full weighting on noise. Such a KPI is SUPPRESSED - excluded from
 * the weighted denominator and shown as not-scored - and its weight rebases onto
 * the KPIs that can be measured. Only COUNT KPIs with a fractional sub-1 target
 * hit this, so nothing else is affected. */
function suppressTarget_(unit, target) {
  return unit === 'COUNT' && target != null && isFinite(target) && target > 0 && target < 1;
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

/* ============================================================================
 * CLOSED-LOOP WRITE LAYER
 * ----------------------------------------------------------------------------
 * Capture actuals, raise and track corrective actions, add comments/evidence -
 * each persisted to a sheet tab, permission-checked against the caller's
 * resolved session, and appended to an immutable audit log. Every write returns
 * the freshly recomputed model so the client updates in one round trip. Reads
 * stay non-fatal; writes need edit access to the backend sheet and say so
 * plainly if they do not have it.
 * ==========================================================================*/

/* Emails with HR/Admin rights. Empty on a fresh deployment, which (with no
 * per-user email map yet) makes every caller an admin who can view as any role
 * so the app is usable immediately. Lock down by listing real admin emails and
 * populating an email->employee map in Admin (a later phase). */
var ADMIN_EMAILS = [];

function currentUserEmail_() {
  try { return (Session.getActiveUser().getEmail() || Session.getEffectiveUser().getEmail() || '').toLowerCase(); }
  catch (e) { return ''; }
}
function nowIso_() { return new Date().toISOString(); }

/* Who is calling, and what they may do. Role is derived from the caller's
 * position when their email maps to an employee; otherwise they fall back to an
 * admin who may "view as" any role (documented first-run behaviour). */
function resolveSession_() {
  var emps = mRead_(M_TAB.EMP);
  if (!emps.length) {
    var M = buildMaster_();
    emps = M.emps.map(function (r) { var o = {}; M_SCHEMA[M_TAB.EMP].forEach(function (k, i) { o[k] = r[i]; }); return o; });
  }
  var byId = {}, hasReports = {};
  emps.forEach(function (e) { byId[e.employee_id] = e; });
  emps.forEach(function (e) { if (e.reporting_manager) hasReports[e.reporting_manager] = true; });
  var email = currentUserEmail_();
  var me = null;
  emps.forEach(function (e) { if (email && String(e.email || '').toLowerCase() === email) me = e; });
  var isAdmin = !email || ADMIN_EMAILS.indexOf(email) >= 0 || !me;
  var role;
  if (isAdmin) role = 'HR';
  else if (!me.reporting_manager && hasReports[me.employee_id]) role = 'Management';
  else if (hasReports[me.employee_id]) role = 'Manager';
  else role = 'Employee';
  return { email: email || '(unknown)', employee_id: me ? me.employee_id : null,
           name: me ? me.employee_name : (email || 'Administrator'), role: role,
           admin: isAdmin, canSwitch: isAdmin || role === 'Management' || role === 'Manager',
           _byId: byId };
}

function apiSession() {
  try {
    var s = resolveSession_();
    return { ok: true, email: s.email, employee_id: s.employee_id, name: s.name,
             role: s.role, admin: s.admin, canSwitch: s.canSwitch };
  } catch (e) { return { ok: false, error: String(e && e.message || e), where: 'apiSession' }; }
}

/* mgrId is at or above empId in the reporting chain. */
function isManagerChain_(mgrId, empId, byId) {
  var e = byId[empId], guard = 0;
  while (e && guard++ < 50) { if (e.reporting_manager === mgrId) return true; e = byId[e.reporting_manager]; }
  return false;
}
function canWriteFor_(s, empId) {
  if (s.admin || s.role === 'HR' || s.role === 'Management') return true;
  if (s.employee_id && s.employee_id === empId) return true;
  if (s.employee_id && isManagerChain_(s.employee_id, empId, s._byId)) return true;
  return false;
}
function requireWrite_(s, empId, what) {
  if (!canWriteFor_(s, empId)) throw new Error('You do not have permission to ' + (what || 'make this change') + '.');
}

/* append / upsert for transactional tabs (mWrite_ rewrites wholesale; these do not) */
function mAppendRow_(name, obj) {
  var sh = mTab_(name), h = M_SCHEMA[name];
  sh.appendRow(h.map(function (k) { var v = obj[k]; return v == null ? '' : v; }));
  return obj;
}
function mUpsertRow_(name, obj) {
  var sh = mTab_(name), h = M_SCHEMA[name], id = obj[h[0]], at = -1, last = sh.getLastRow();
  if (id && last >= 2) {
    var ids = sh.getRange(2, 1, last - 1, 1).getValues();
    for (var i = 0; i < ids.length; i++) if (String(ids[i][0]) === String(id)) { at = i + 2; break; }
  }
  var row = h.map(function (k) { var v = obj[k]; return v == null ? '' : v; });
  if (at > 0) sh.getRange(at, 1, 1, h.length).setValues([row]); else sh.appendRow(row);
  return obj;
}
function audit_(actor, objType, objId, action, detail) {
  try {
    mAppendRow_(M_TAB.AUDIT, { audit_id: Utilities.getUuid(), at: nowIso_(), actor: actor,
      object_type: objType, object_id: objId, action: action, detail: detail || '' });
  } catch (e) { /* the audit trail must never break the write it records */ }
}

/* --- Capture an actual (Core Loop step 3) --- */
function apiSaveActual(p) {
  try {
    p = p || {};
    var s = resolveSession_();
    requireWrite_(s, p.employee_id, 'update this actual');
    var emp = s._byId[p.employee_id]; if (!emp) throw new Error('Unknown employee.');
    var month = monthKey_(p.month); if (!month) throw new Error('Choose a period first.');
    var val = numOrNull_(p.value); if (val == null) throw new Error('Enter a numeric actual value.');
    var id = 'ACT-' + month + '-' + p.employee_id + '-' + p.kpi_id;   /* one actual per emp+kpi+month */
    mUpsertRow_(M_TAB.ACT, { actual_id: id, month: month, team_id: emp.team_id, employee_id: p.employee_id,
      kpi_id: p.kpi_id, actual_value: val, actual_unit: p.unit || '', source: p.source || 'Manual entry',
      updated_at: nowIso_() });
    if (String(p.note || '').trim())
      mAppendRow_(M_TAB.COMMENT, { comment_id: Utilities.getUuid(), created_at: nowIso_(), month: month,
        team_id: emp.team_id, employee_id: p.employee_id, kpi_id: p.kpi_id, author: s.name, kind: 'note', text: p.note });
    audit_(s.name, 'actual', id, 'save', p.kpi_id + ' = ' + val + ' (' + month + ')');
    return jsonSafe_({ ok: true, id: id, model: buildModel_(null, month) });
  } catch (e) { return { ok: false, error: String(e && e.message || e), where: 'apiSaveActual' }; }
}

/* --- Corrective action: create / update / close (Core Loop step 6) --- */
var ACTION_STATUSES = ['Open', 'In Progress', 'Blocked', 'Completed', 'Cancelled'];
function apiSaveAction(p) {
  try {
    p = p || {};
    var s = resolveSession_();
    requireWrite_(s, p.employee_id, 'manage this action');
    var emp = s._byId[p.employee_id]; if (!emp) throw new Error('Unknown employee.');
    if (!String(p.title || '').trim()) throw new Error('Give the action a title.');
    var status = ACTION_STATUSES.indexOf(p.status) >= 0 ? p.status : 'Open';
    if ((status === 'Cancelled' || status === 'Blocked') && !String(p.resolution || '').trim())
      throw new Error('A ' + status.toLowerCase() + ' action needs a short reason.');
    var id = p.action_id || ('ACN-' + Utilities.getUuid().slice(0, 8));
    var existing = null;
    if (p.action_id) mRead_(M_TAB.ACTION).forEach(function (a) { if (a.action_id === p.action_id) existing = a; });
    mUpsertRow_(M_TAB.ACTION, { action_id: id, created_at: existing ? existing.created_at : nowIso_(),
      updated_at: nowIso_(), month: monthKey_(p.month || ''), team_id: emp.team_id, employee_id: p.employee_id,
      kpi_id: p.kpi_id || '', title: p.title, root_cause: p.root_cause || '',
      priority: (['High', 'Medium', 'Low'].indexOf(p.priority) >= 0 ? p.priority : 'Medium'),
      status: status, due_date: p.due_date || '', resolution: p.resolution || '',
      created_by: existing ? existing.created_by : s.name });
    audit_(s.name, 'action', id, p.action_id ? 'update' : 'create', p.title + ' [' + status + ']');
    return jsonSafe_({ ok: true, id: id, model: buildModel_(null, p.month || null) });
  } catch (e) { return { ok: false, error: String(e && e.message || e), where: 'apiSaveAction' }; }
}

/* --- Comment / evidence / root cause on a KPI --- */
function apiSaveComment(p) {
  try {
    p = p || {};
    var s = resolveSession_();
    requireWrite_(s, p.employee_id, 'comment here');
    if (!String(p.text || '').trim()) throw new Error('Nothing to save.');
    var emp = s._byId[p.employee_id]; if (!emp) throw new Error('Unknown employee.');
    var id = Utilities.getUuid();
    mAppendRow_(M_TAB.COMMENT, { comment_id: id, created_at: nowIso_(), month: monthKey_(p.month || ''),
      team_id: emp.team_id, employee_id: p.employee_id, kpi_id: p.kpi_id || '', author: s.name,
      kind: (['comment', 'evidence', 'root_cause'].indexOf(p.kind) >= 0 ? p.kind : 'comment'), text: p.text });
    audit_(s.name, 'comment', id, 'add', (p.kind || 'comment') + ' on ' + (p.kpi_id || ''));
    return jsonSafe_({ ok: true, id: id, model: buildModel_(null, p.month || null) });
  } catch (e) { return { ok: false, error: String(e && e.message || e), where: 'apiSaveComment' }; }
}

/* --- Performance review: self + manager assessment, finalize, lock (Core Loop
 * step 7). One review per employee per cycle; a cycle defaults to the period.
 * Sections are permission-scoped (employee writes self, manager/HR write the
 * manager side and finalize) and a Finalized review is immutable until an HR
 * reopen - the audit trail records every transition. `action` drives the state
 * machine: save | submit_self | submit_mgr | finalize | reopen. --- */
function apiSaveReview(p) {
  try {
    p = p || {};
    var s = resolveSession_();
    var empId = p.employee_id, emp = s._byId[empId]; if (!emp) throw new Error('Unknown employee.');
    var cycle = String(p.cycle || monthKey_(p.month) || 'current');
    var id = 'RVW-' + cycle + '-' + empId;
    var existing = null; mRead_(M_TAB.REVIEW).forEach(function (r) { if (r.review_id === id) existing = r; });
    var action = p.action || 'save';
    if (existing && String(existing.status) === 'Finalized' && action !== 'reopen')
      throw new Error('This review is finalized and locked. HR can reopen it to make changes.');
    var rec = existing || { review_id: id, cycle: cycle, month: monthKey_(p.month) || '', team_id: emp.team_id,
      employee_id: empId, self_rating: '', self_comment: '', mgr_rating: '', mgr_comment: '', final_rating: '',
      status: 'Not Started', reviewer: '', submitted_at: '', finalized_at: '' };
    var isSelf = s.employee_id && s.employee_id === empId;
    var isMgr = s.admin || s.role === 'HR' || s.role === 'Management' || (s.employee_id && isManagerChain_(s.employee_id, empId, s._byId));
    if (p.self_rating !== undefined || p.self_comment !== undefined) {
      if (!(isSelf || s.admin || s.role === 'HR')) throw new Error('Only the employee can write the self-assessment.');
      if (p.self_rating !== undefined) rec.self_rating = p.self_rating;
      if (p.self_comment !== undefined) rec.self_comment = p.self_comment;
    }
    if (p.mgr_rating !== undefined || p.mgr_comment !== undefined) {
      if (!isMgr) throw new Error('Only the manager or HR can write the manager assessment.');
      if (p.mgr_rating !== undefined) rec.mgr_rating = p.mgr_rating;
      if (p.mgr_comment !== undefined) rec.mgr_comment = p.mgr_comment;
    }
    if (action === 'submit_self') {
      if (!(isSelf || s.admin || s.role === 'HR')) throw new Error('Not permitted.');
      if (!String(rec.self_rating).trim()) throw new Error('Add your self rating first.');
      rec.status = 'Self Submitted'; rec.submitted_at = nowIso_();
    } else if (action === 'submit_mgr') {
      if (!isMgr) throw new Error('Not permitted.');
      if (!String(rec.mgr_rating).trim()) throw new Error('Add a manager rating first.');
      rec.status = 'Manager Submitted';
    } else if (action === 'finalize') {
      if (!isMgr) throw new Error('Only a manager or HR can finalize a review.');
      var fr = String(p.final_rating || rec.mgr_rating || '').trim();
      if (!fr) throw new Error('Set the final rating before finalizing.');
      rec.final_rating = fr; rec.status = 'Finalized'; rec.finalized_at = nowIso_(); rec.reviewer = s.name;
    } else if (action === 'reopen') {
      if (!(s.admin || s.role === 'HR')) throw new Error('Only HR can reopen a finalized review.');
      rec.status = rec.mgr_rating ? 'Manager Submitted' : (rec.self_rating ? 'Self Submitted' : 'Draft'); rec.finalized_at = '';
    } else if (rec.status === 'Not Started') { rec.status = 'Draft'; }
    rec.updated_at = nowIso_();
    mUpsertRow_(M_TAB.REVIEW, rec);
    audit_(s.name, 'review', id, action, 'status ' + rec.status + (rec.final_rating ? ' final ' + rec.final_rating : ''));
    return jsonSafe_({ ok: true, id: id, model: buildModel_(null, p.month || null) });
  } catch (e) { return { ok: false, error: String(e && e.message || e), where: 'apiSaveReview' }; }
}

/* ======================================================================
 * INDIVIDUAL KRA / KPI CONFIGURATION  ·  dedicated config sheet
 * ----------------------------------------------------------------------
 * A second spreadsheet is the controlled source of truth for individually
 * configured KRA/KPIs and their full change history. The app keeps reading its
 * base model from the primary backend (BACKEND_SHEET_ID); this layer overlays
 * each employee's individual configuration on top, so an edit shows up live,
 * while every change is written with who / when / old value / new value /
 * version — nothing is overwritten without a trace.
 *
 * Seven tabs, one responsibility each:
 *   Employees          reference roster (synced from the primary backend)
 *   KRA_KPI_Master     catalogue of KPI definitions (shared + individually owned)
 *   Individual_KRA_KPI the live per-employee assignment: weightage, target, params
 *   KRA_KPI_History    append-only change log: field, old -> new, version, actor
 *   Users_Access       who may view / edit configuration
 *   Lookup_Master      controlled dropdown values (units, directions, statuses …)
 *   System_Log         provisioning / errors / integration events
 * ====================================================================== */

var CONFIG_SHEET_ID = '1n-yGh70aDJy6ejabFZOFbpbubLi2nApF6-ciRZs10cM';

var C_TAB = {
  EMP: 'Employees', MASTER: 'KRA_KPI_Master', INDIV: 'Individual_KRA_KPI',
  HIST: 'KRA_KPI_History', USERS: 'Users_Access', LOOKUP: 'Lookup_Master', SYSLOG: 'System_Log'
};
var C_SCHEMA = {};
C_SCHEMA[C_TAB.EMP]    = ['employee_id', 'employee_name', 'team_id', 'team_name', 'designation', 'reporting_manager', 'status', 'assigned_team_id', 'assigned_team_name', 'team_updated_by', 'team_updated_at', 'synced_at'];
C_SCHEMA[C_TAB.MASTER] = ['kpi_id', 'kra_name', 'perspective', 'kpi_name', 'measurement_type', 'direction', 'default_weightage', 'source_of_tracking', 'goal_description', 'owner_scope', 'active', 'created_at', 'created_by', 'updated_at', 'updated_by', 'version'];
C_SCHEMA[C_TAB.INDIV]  = ['config_id', 'employee_id', 'kpi_id', 'kra_name', 'perspective', 'kpi_name', 'weightage', 'target_value', 'target_unit', 'measurement_type', 'direction', 'source_of_tracking', 'goal_description', 'status', 'effective_from', 'effective_to', 'version', 'created_at', 'created_by', 'updated_at', 'updated_by', 'active'];
C_SCHEMA[C_TAB.HIST]   = ['history_id', 'changed_at', 'changed_by', 'employee_id', 'employee_name', 'config_id', 'kpi_id', 'kpi_name', 'field', 'old_value', 'new_value', 'action', 'version', 'effective_period', 'note'];
C_SCHEMA[C_TAB.USERS]  = ['user_id', 'email', 'name', 'role', 'can_view', 'can_edit_config', 'scope', 'active', 'updated_at'];
C_SCHEMA[C_TAB.LOOKUP] = ['lookup_id', 'category', 'value', 'label', 'sort_order', 'active'];
C_SCHEMA[C_TAB.SYSLOG] = ['log_id', 'at', 'actor', 'level', 'event', 'detail'];

/* ---- config-sheet accessors (isolated from the primary backend helpers) -- */
function cfgSS_() {
  try { return SpreadsheetApp.openById(CONFIG_SHEET_ID); }
  catch (e) { throw new Error('Cannot open the configuration spreadsheet ' + CONFIG_SHEET_ID +
    '. Share it (Editor) with the account running this web app.'); }
}
function cfgTab_(name) {
  var ss = cfgSS_(), sh = ss.getSheetByName(name), h = C_SCHEMA[name];
  if (!sh) sh = ss.insertSheet(name);
  var head = sh.getRange(1, 1, 1, h.length).getValues()[0];
  var blank = head.every(function (v) { return v === '' || v == null; });
  if (blank) sh.getRange(1, 1, 1, h.length).setValues([h]).setFontWeight('bold').setBackground('#EAF0FB');
  if (sh.getFrozenRows() < 1) sh.setFrozenRows(1);
  return sh;
}
function cfgRead_(name) {
  var sh = cfgTab_(name), h = C_SCHEMA[name], last = sh.getLastRow();
  if (last < 2) return [];
  return sh.getRange(2, 1, last - 1, h.length).getValues().map(function (r) {
    var o = {}; h.forEach(function (k, i) { o[k] = r[i]; }); return o;
  });
}
function cfgAppend_(name, obj) {
  var sh = cfgTab_(name), h = C_SCHEMA[name];
  sh.appendRow(h.map(function (k) { var v = obj[k]; return v == null ? '' : v; }));
  return obj;
}
function cfgUpsert_(name, obj) {   // by first-column id
  var sh = cfgTab_(name), h = C_SCHEMA[name], id = obj[h[0]], at = -1, last = sh.getLastRow();
  if (id && last >= 2) {
    var ids = sh.getRange(2, 1, last - 1, 1).getValues();
    for (var i = 0; i < ids.length; i++) if (String(ids[i][0]) === String(id)) { at = i + 2; break; }
  }
  var row = h.map(function (k) { var v = obj[k]; return v == null ? '' : v; });
  if (at > 0) sh.getRange(at, 1, 1, h.length).setValues([row]); else sh.appendRow(row);
  return obj;
}
function cfgFind_(name, match) {
  return cfgRead_(name).filter(function (o) {
    for (var k in match) if (String(o[k]) !== String(match[k])) return false; return true;
  });
}
function sysLog_(actor, level, event, detail) {
  try { cfgAppend_(C_TAB.SYSLOG, { log_id: Utilities.getUuid(), at: nowIso_(), actor: actor || 'system',
    level: level || 'info', event: event || '', detail: detail || '' }); } catch (e) {}
}

/* One history row per field that actually changed (old -> new), plus add / remove
 * markers. The version is the config row's version AFTER the change. */
function histRow_(actor, emp, cfgId, kpiId, kpiName, field, oldV, newV, action, version, period) {
  cfgAppend_(C_TAB.HIST, { history_id: Utilities.getUuid(), changed_at: nowIso_(), changed_by: actor,
    employee_id: emp.employee_id, employee_name: emp.employee_name, config_id: cfgId, kpi_id: kpiId,
    kpi_name: kpiName, field: field, old_value: oldV == null ? '' : String(oldV),
    new_value: newV == null ? '' : String(newV), action: action, version: version,
    effective_period: period || '', note: '' });
}

/* ---- provisioning: create all seven tabs and seed the reference data ----- */
function provisionConfigSheet() {
  var out = [];
  Object.keys(C_TAB).forEach(function (k) { cfgTab_(C_TAB[k]); out.push(C_TAB[k]); });

  // Employees + KRA_KPI_Master snapshots come from the primary backend model.
  var model = buildModel_(null, null);
  var now = nowIso_();
  var empRows = model.scorecards.map(function (s) {
    var team = model.teams.filter(function (t) { return t.team_id === s.team_id; })[0] || {};
    return { employee_id: s.employee_id, employee_name: s.employee_name, team_id: s.team_id,
      team_name: team.team_name || '', designation: s.designation || '', reporting_manager: s.reporting_manager || '',
      status: 'ACTIVE', synced_at: now };
  });
  cfgReplaceAll_(C_TAB.EMP, empRows);

  var seenKpi = {}, masterRows = [];
  model.scorecards.forEach(function (s) {
    s.kpis.forEach(function (k) {
      if (seenKpi[k.kpi_id]) return; seenKpi[k.kpi_id] = 1;
      masterRows.push({ kpi_id: k.kpi_id, kra_name: k.kra, perspective: k.perspective, kpi_name: k.kpi,
        measurement_type: k.unit, direction: k.direction, default_weightage: k.weightage,
        source_of_tracking: k.source, goal_description: k.goal, owner_scope: 'shared', active: 'TRUE',
        created_at: now, created_by: 'provision', updated_at: now, updated_by: 'provision', version: 1 });
    });
  });
  cfgReplaceAll_(C_TAB.MASTER, masterRows);

  // Users_Access seeded from the roster's resolved roles.
  var userRows = model.scorecards.map(function (s, i) {
    var role = !s.reporting_manager ? 'Management' : 'Employee';
    return { user_id: 'U' + ('000' + (i + 1)).slice(-3), email: '', name: s.employee_name, role: role,
      can_view: 'TRUE', can_edit_config: (role === 'Management' || role === 'HR') ? 'TRUE' : 'FALSE',
      scope: s.team_id, active: 'TRUE', updated_at: now };
  });
  cfgReplaceAll_(C_TAB.USERS, userRows);

  // Lookup_Master: the controlled vocabularies the editor offers.
  var lk = [], seq = 0;
  function lkAdd(cat, val, label) { lk.push({ lookup_id: 'LK' + ('000' + (++seq)).slice(-3), category: cat, value: val, label: label || val, sort_order: seq, active: 'TRUE' }); }
  ['CR', 'MT', 'COUNT', 'PERCENT', 'DAYS'].forEach(function (u) { lkAdd('measurement_type', u); });
  lkAdd('direction', 'HIGHER_IS_BETTER', 'Higher is better'); lkAdd('direction', 'LOWER_IS_BETTER', 'Lower is better');
  ['Active', 'Draft', 'Inactive'].forEach(function (s) { lkAdd('status', s); });
  ['Financial', 'Customer', 'Internal Process', 'Learning & Growth', 'Supply', 'Demand', 'Growth', 'Operations', 'Quality', 'Process', 'Finance'].forEach(function (p) { lkAdd('perspective', p); });
  ['Management', 'HR', 'Manager', 'Employee'].forEach(function (r) { lkAdd('role', r); });
  cfgReplaceAll_(C_TAB.LOOKUP, lk);

  sysLog_('provision', 'info', 'provisionConfigSheet', out.length + ' tabs; ' + empRows.length + ' employees, ' + masterRows.length + ' KPIs seeded');
  return 'Config sheet ready: ' + out.join(', ') + '\nEmployees: ' + empRows.length +
    '\nKRA_KPI_Master: ' + masterRows.length + '\nUsers_Access: ' + userRows.length + '\nLookup values: ' + lk.length;
}
function cfgReplaceAll_(name, objs) {
  var sh = cfgTab_(name), h = C_SCHEMA[name];
  if (sh.getLastRow() > 1) sh.getRange(2, 1, sh.getLastRow() - 1, h.length).clearContent();
  if (objs.length) sh.getRange(2, 1, objs.length, h.length)
    .setValues(objs.map(function (o) { return h.map(function (k) { var v = o[k]; return v == null ? '' : v; }); }));
}

/* ---- access control (Users_Access first, role logic as the fallback) ----- */
function canEditConfig_(s, empId) {
  try {
    var email = String(s.email || '').toLowerCase();
    if (email && email !== '(unknown)') {
      var u = cfgFind_(C_TAB.USERS, { email: email }).filter(function (r) { return String(r.active).toUpperCase() !== 'FALSE'; })[0];
      if (u) return String(u.can_edit_config).toUpperCase() === 'TRUE';
    }
  } catch (e) { /* fall through to role logic */ }
  return s.admin || s.role === 'HR' || s.role === 'Management' ||
    (s.employee_id && isManagerChain_(s.employee_id, empId, s._byId));
}
function requireEditConfig_(s, empId) {
  if (!canEditConfig_(s, empId)) throw new Error('You do not have permission to configure this employee’s KRA / KPIs.');
}

/* ---- overlay: fold the individual config onto the base model -------------
 * Called at the end of buildModel_. Defensive: any failure (sheet not shared,
 * not provisioned) leaves the base model exactly as it was. */
function applyIndividualConfig_(model, month) {
  var indiv;
  try { indiv = cfgRead_(C_TAB.INDIV); } catch (e) { return model; }
  if (!indiv || !indiv.length) return model;
  var byEmp = {};
  indiv.forEach(function (r) {
    if (String(r.active).toUpperCase() === 'FALSE') return;
    (byEmp[r.employee_id] = byEmp[r.employee_id] || []).push(r);
  });
  /* Month-scoped target values live in MONTHLY_TARGETS, not the config sheet: the
   * config carries the DEFAULT target for the assignment, but a specific month's
   * target (and its Draft/Approved lifecycle) is period data. Prefer the month's
   * target when one has been set, so a configured person's targets vary by month
   * exactly like everyone else's. */
  var tgtBy = {};
  try { mRead_(M_TAB.TGT).forEach(function (r) { if (monthKey_(r.month) === month) tgtBy[r.employee_id + '|' + r.kpi_id] = r; }); } catch (e) {}
  model.scorecards.forEach(function (sc) {
    var rows = byEmp[sc.employee_id]; if (!rows || !rows.length) return;
    var actualBy = {}; sc.kpis.forEach(function (k) { actualBy[k.kpi_id] = k; });   // actuals stay on the primary backend
    var kpis = rows.map(function (r) {
      var base = actualBy[r.kpi_id] || {};
      var mt = tgtBy[sc.employee_id + '|' + r.kpi_id];
      var tv = mt ? numOrNull_(mt.target_value) : numOrNull_(r.target_value);
      var av = base.actual != null ? base.actual : null;
      var dir = r.direction || base.direction || 'HIGHER_IS_BETTER', unit = r.measurement_type || r.target_unit || base.unit || '';
      var sup = suppressTarget_(unit, tv);
      var ach = (sup || tv == null || av == null) ? null : achievementPct_(tv, av, dir, unit);
      var wt = numOrNull_(r.weightage) || 0;
      var ws = ach == null ? null : weightedScore_(wt, ach);
      var lvl = ach == null ? null : (ach >= 100 ? 5 : ach >= 90 ? 4 : ach >= 75 ? 3 : ach >= 60 ? 2 : 1);
      return { kpi_id: String(r.kpi_id), config_id: String(r.config_id), perspective: String(r.perspective || ''),
        kra: String(r.kra_name || ''), kpi: String(r.kpi_name || ''), weightage: wt, goal: String(r.goal_description || ''),
        source: String(r.source_of_tracking || ''), unit: unit, direction: dir, target: tv, actual: av,
        achievement: ach, variance: (tv == null || av == null) ? null : round1_(av - tv),
        weighted_score: ws, level: lvl, status: statusFor_(ach, lvl), configured: true,
        target_status: targetStatus_(mt), target_version: mt ? (numOrNull_(mt.version) || '') : '',
        criteria: mt ? String(mt.measurement_criteria || '') : '', waived: mt ? (String(mt.waived).toUpperCase() === 'TRUE') : false,
        suppressed: sup };
    });
    var earned = 0, measured = 0;
    kpis.forEach(function (r) { if (r.weighted_score != null && isFinite(r.weighted_score)) { earned += r.weighted_score; measured += Number(r.weightage) || 0; } });
    var memberAch = measured > 0 ? Math.round(earned / measured * 1000) / 10 : null;
    sc.kpis = kpis; sc.measured_weightage = measured;
    sc.overall_score = measured > 0 ? Math.round(earned * 10) / 10 : null;
    sc.kpi_achievement = memberAch; sc.status = statusFor_(memberAch, null); sc.configured = true;
  });
  model.records = model.scorecards.reduce(function (s, sc) { return s + sc.kpis.filter(function (k) { return k.achievement != null; }).length; }, 0);
  return model;
}

/* ---- READ one employee's editable config (seeded from base on first edit) - */
function apiKpiConfig(p) {
  try {
    p = p || {};
    var s = resolveSession_();
    var empId = p.employee_id, month = monthKey_(p.month) || '';
    var model = buildModel_(null, month || null);      // already overlaid with any saved config
    var sc = model.scorecards.filter(function (x) { return x.employee_id === empId; })[0];
    if (!sc) throw new Error('Unknown employee.');
    var items = sc.kpis.map(function (k) {
      return { kpi_id: k.kpi_id, config_id: k.config_id || '', kra: k.kra, perspective: k.perspective,
        kpi: k.kpi, weightage: k.weightage, target: k.target, unit: k.unit, direction: k.direction,
        source: k.source, goal: k.goal, configured: !!k.configured };
    });
    var hist = [];
    try { hist = cfgFind_(C_TAB.HIST, { employee_id: empId }); } catch (e) {}
    hist = hist.sort(function (a, b) { return String(b.changed_at).localeCompare(String(a.changed_at)); }).slice(0, 40);
    var lookups = {};
    try { cfgRead_(C_TAB.LOOKUP).forEach(function (l) { if (String(l.active).toUpperCase() === 'FALSE') return; (lookups[l.category] = lookups[l.category] || []).push({ value: l.value, label: l.label }); }); } catch (e) {}
    return jsonSafe_({ ok: true, employee_id: empId, employee_name: sc.employee_name, month: month || model.month,
      can_edit: canEditConfig_(s, empId), items: items, history: hist, lookups: lookups });
  } catch (e) { return { ok: false, error: String(e && e.message || e), where: 'apiKpiConfig' }; }
}

/* ---- SAVE: reconcile the desired list, write history + version + log ------ */
function apiSaveKpiConfig(p) {
  try {
    p = p || {};
    var s = resolveSession_();
    var empId = p.employee_id;
    requireEditConfig_(s, empId);

    var base = buildModel_(null, null);
    var sc = base.scorecards.filter(function (x) { return x.employee_id === empId; })[0];
    if (!sc) throw new Error('Unknown employee.');
    var team = base.teams.filter(function (t) { return t.team_id === sc.team_id; })[0] || {};
    var emp = { employee_id: empId, employee_name: sc.employee_name };
    var month = monthKey_(p.month) || monthKey_(base.month) || '';
    var period = month;

    var items = (p.items || []).filter(function (it) { return it && !it._remove; });
    if (!items.length) throw new Error('An employee needs at least one KRA / KPI.');
    var total = 0; items.forEach(function (it) { total += Number(it.weightage) || 0; });
    if (Math.round(total) !== 100) throw new Error('Weightages must total 100% (currently ' + Math.round(total) + '%).');
    items.forEach(function (it) { if (!String(it.kpi || '').trim()) throw new Error('Every KPI needs a name.'); });

    // current active config for this employee, indexed by config_id
    var prior = {};
    cfgFind_(C_TAB.INDIV, { employee_id: empId }).forEach(function (r) { if (String(r.active).toUpperCase() !== 'FALSE') prior[r.config_id] = r; });
    var now = nowIso_(), actor = s.name, seen = {}, changes = 0;
    var FIELDS = [['kra', 'kra_name'], ['perspective', 'perspective'], ['kpi', 'kpi_name'], ['weightage', 'weightage'],
      ['target', 'target_value'], ['unit', 'measurement_type'], ['direction', 'direction'], ['source', 'source_of_tracking'], ['goal', 'goal_description']];

    items.forEach(function (it) {
      var cfgId = it.config_id, existing = cfgId ? prior[cfgId] : null;
      var kpiId = it.kpi_id || existing && existing.kpi_id || ('KPI-CFG-' + uid8_());
      var unit = ['CR', 'MT', 'COUNT', 'PERCENT', 'DAYS'].indexOf(it.unit) >= 0 ? it.unit : 'PERCENT';
      var dir = it.direction === 'LOWER_IS_BETTER' ? 'LOWER_IS_BETTER' : 'HIGHER_IS_BETTER';
      var desired = { kra_name: String(it.kra || 'General').trim(), perspective: String(it.perspective || ''),
        kpi_name: String(it.kpi).trim(), weightage: Number(it.weightage) || 0,
        target_value: (it.target == null || it.target === '') ? '' : Number(it.target), target_unit: unit,
        measurement_type: unit, direction: dir, source_of_tracking: String(it.source || ''), goal_description: String(it.goal || '') };

      if (!existing) {                                   // NEW individual assignment
        cfgId = 'CFG-' + uid8_();
        var rowN = { config_id: cfgId, employee_id: empId, kpi_id: kpiId, kra_name: desired.kra_name,
          perspective: desired.perspective, kpi_name: desired.kpi_name, weightage: desired.weightage,
          target_value: desired.target_value, target_unit: unit, measurement_type: unit, direction: dir,
          source_of_tracking: desired.source_of_tracking, goal_description: desired.goal_description,
          status: 'Active', effective_from: period, effective_to: '', version: 1,
          created_at: now, created_by: actor, updated_at: now, updated_by: actor, active: 'TRUE' };
        cfgUpsert_(C_TAB.INDIV, rowN);
        ensureMaster_(kpiId, desired, empId, actor, now);
        histRow_(actor, emp, cfgId, kpiId, desired.kpi_name, 'assignment', '', 'created', it.kpi_id ? 'assign' : 'create', 1, period);
        changes++;
      } else {                                           // MODIFY existing
        var diffs = [];
        FIELDS.forEach(function (f) {
          var col = f[1], oldV = existing[col], newV = desired[col];
          if (String(oldV == null ? '' : oldV) !== String(newV == null ? '' : newV)) diffs.push([col, oldV, newV, f[0]]);
        });
        if (diffs.length) {
          var version = (Number(existing.version) || 1) + 1;
          var upd = {}; C_SCHEMA[C_TAB.INDIV].forEach(function (k) { upd[k] = existing[k]; });
          Object.keys(desired).forEach(function (k) { upd[k] = desired[k]; });
          upd.version = version; upd.updated_at = now; upd.updated_by = actor; upd.active = 'TRUE'; upd.status = 'Active';
          cfgUpsert_(C_TAB.INDIV, upd);
          diffs.forEach(function (d) { histRow_(actor, emp, existing.config_id, kpiId, desired.kpi_name, d[3], d[1], d[2], 'update', version, period); });
          // definition change also refreshes this employee's owned master entry
          if (diffs.some(function (d) { return ['kra_name', 'perspective', 'kpi_name', 'measurement_type', 'direction', 'source_of_tracking', 'goal_description'].indexOf(d[0]) >= 0; }))
            ensureMaster_(kpiId, desired, empId, actor, now);
          changes++;
        }
        cfgId = existing.config_id;
      }
      seen[cfgId] = 1;
    });

    // retire dropped assignments (present before, absent now)
    Object.keys(prior).forEach(function (cid) {
      if (seen[cid]) return;
      var r = prior[cid], version = (Number(r.version) || 1) + 1;
      var upd = {}; C_SCHEMA[C_TAB.INDIV].forEach(function (k) { upd[k] = r[k]; });
      upd.active = 'FALSE'; upd.status = 'Inactive'; upd.effective_to = period; upd.version = version; upd.updated_at = now; upd.updated_by = actor;
      cfgUpsert_(C_TAB.INDIV, upd);
      histRow_(actor, emp, cid, r.kpi_id, r.kpi_name, 'assignment', 'active', 'removed', 'remove', version, period);
      changes++;
    });

    sysLog_(actor, 'info', 'apiSaveKpiConfig', empId + ' — ' + changes + ' change(s), weightage 100%');
    return jsonSafe_({ ok: true, changes: changes, model: buildModel_(null, month || null) });
  } catch (e) { return { ok: false, error: String(e && e.message || e), where: 'apiSaveKpiConfig' }; }
}

function ensureMaster_(kpiId, d, empId, actor, now) {
  var existing = cfgFind_(C_TAB.MASTER, { kpi_id: kpiId })[0];
  var version = existing ? (Number(existing.version) || 1) + 1 : 1;
  cfgUpsert_(C_TAB.MASTER, { kpi_id: kpiId, kra_name: d.kra_name, perspective: d.perspective, kpi_name: d.kpi_name,
    measurement_type: d.measurement_type, direction: d.direction, default_weightage: d.weightage,
    source_of_tracking: d.source_of_tracking, goal_description: d.goal_description,
    owner_scope: (existing && existing.owner_scope === 'shared') ? 'shared' : empId, active: 'TRUE',
    created_at: existing ? existing.created_at : now, created_by: existing ? existing.created_by : actor,
    updated_at: now, updated_by: actor, version: version });
}

/* ==========================================================================
 * MONTHLY TARGET & ACHIEVEMENT — target lifecycle + month planning state
 * --------------------------------------------------------------------------
 * Targets are month-scoped and versioned: an authorised user sets a Draft, the
 * team approves it as the month's baseline, and any later change to an approved
 * target writes a new version while the audit trail keeps the original. A month
 * moves Planning -> Open -> Closed -> Reopened; closing freezes the numbers and
 * turns a still-missing actual into a 0% miss (unless the target was waived).
 * Every write is permission-checked, audited, and returns the recomputed model
 * so the client adopts the new scores in one round trip.
 * ======================================================================== */

/* Draft until approved. An older sheet carried only the boolean `approved`
 * column, so fall back to it when `status` has not been written yet. */
function targetStatus_(t) {
  if (!t) return '';
  var s = String(t.status || '').trim();
  if (s) return s;
  return String(t.approved).toUpperCase() === 'TRUE' ? 'Approved' : 'Draft';
}

var MONTH_STATES = ['Planning', 'Open', 'Closed', 'Reopened'];
function stateId_(month, teamId) { return 'MS-' + month + '-' + (teamId || 'ALL'); }
function prevMonth_(mk) {
  var y = Number(String(mk).slice(0, 4)), m = Number(String(mk).slice(5, 7));
  return Utilities.formatDate(new Date(y, m - 2, 1), Session.getScriptTimeZone(), 'yyyy-MM');
}

/* Every team's planning state for one month as { team_id: {state,...} }. A team
 * with no row is Open, so nothing that has not been explicitly planned or closed
 * changes behaviour. */
function readMonthStates_(month) {
  var out = {};
  try {
    mRead_(M_TAB.MONTHSTATE).forEach(function (r) {
      if (monthKey_(r.month) !== month) return;
      out[String(r.team_id || 'ALL')] = { state: String(r.state || 'Open'), note: String(r.note || ''),
        changed_by: String(r.changed_by || ''), changed_at: String(r.changed_at || '') };
    });
  } catch (e) {}
  return out;
}
function monthStateFor_(states, teamId) {
  var r = states && (states[teamId] || states.ALL);
  return r ? r.state : 'Open';
}

/* Close policy: once a team's month is Closed, a KPI that has a target but still
 * no actual is scored 0% (a miss), not left Pending - so a bad number cannot be
 * dodged by never entering it. A target explicitly waived is excluded and its
 * weight rebased. Runs last, over the final (base or config-overlaid) kpis, and
 * recomputes the person's rollup. A no-op for Planning / Open / Reopened. */
function applyMonthClosePolicy_(model, month) {
  var states = model.month_states || {};
  (model.scorecards || []).forEach(function (sc) {
    if (monthStateFor_(states, sc.team_id) !== 'Closed') return;
    sc.kpis.forEach(function (k) {
      if (k.suppressed) return;
      if (k.target != null && k.actual == null && !k.waived) {
        k.achievement = 0; k.level = 1; k.status = 'Off Track';
        k.weighted_score = weightedScore_(Number(k.weightage) || 0, 0);
        k.missed_at_close = true;
      }
    });
    var earned = 0, measured = 0;
    sc.kpis.forEach(function (k) {
      if (k.weighted_score == null || !isFinite(k.weighted_score)) return;
      earned += k.weighted_score; measured += Number(k.weightage) || 0;
    });
    sc.measured_weightage = measured;
    sc.overall_score = measured > 0 ? Math.round(earned * 10) / 10 : null;
    sc.kpi_achievement = measured > 0 ? Math.round(earned / measured * 1000) / 10 : null;
    sc.status = statusFor_(sc.kpi_achievement, null);
    sc.month_closed = true;
  });
  model.records = (model.scorecards || []).reduce(function (s, sc) {
    return s + sc.kpis.filter(function (k) { return k.achievement != null; }).length; }, 0);
  return model;
}

/* --- permissions -----------------------------------------------------------
 * Setting a target is a manager / management act, never self-service: a person
 * does not set the bar they are judged against. */
function canSetTarget_(s, empId) {
  if (s.admin || s.role === 'HR' || s.role === 'Management') return true;
  if (s.employee_id && isManagerChain_(s.employee_id, empId, s._byId)) return true;
  return false;
}
function requireSetTarget_(s, empId) {
  if (!canSetTarget_(s, empId)) throw new Error('Only a manager or management can set this person’s target.');
}
function canManageMonth_(s) { return !!(s.admin || s.role === 'HR' || s.role === 'Management' || s.role === 'Manager'); }
function requireManageMonth_(s) {
  if (!canManageMonth_(s)) throw new Error('Only a manager or management can change the month’s state.');
}

/* --- set / edit / approve one month's target for one KPI -------------------- */
function apiSaveTarget(p) {
  try {
    p = p || {};
    var s = resolveSession_();
    requireSetTarget_(s, p.employee_id);
    var emp = s._byId[p.employee_id]; if (!emp) throw new Error('Unknown employee.');
    var month = monthKey_(p.month); if (!month) throw new Error('Choose a period first.');
    if (!p.kpi_id) throw new Error('Which KPI is this target for?');
    var val = numOrNull_(p.value); if (val == null) throw new Error('Enter a numeric target value.');
    if (val < 0) throw new Error('A target cannot be negative.');
    var action = ['save', 'approve', 'revise'].indexOf(p.action) >= 0 ? p.action : 'save';
    var id = 'TGT-' + month + '-' + p.employee_id + '-' + p.kpi_id;   /* one target per emp+kpi+month */
    var prior = mRead_(M_TAB.TGT).filter(function (r) { return String(r.target_id) === id; })[0] || null;
    var priorStatus = targetStatus_(prior), priorVal = prior ? numOrNull_(prior.target_value) : null;
    var version = prior ? (numOrNull_(prior.version) || 1) : 1;
    /* Changing an already-approved baseline is a revision: bump the version so
     * the audit keeps the original rather than overwriting it silently. */
    if (prior && priorStatus === 'Approved' && priorVal !== val) version += 1;
    var status = action === 'approve' ? 'Approved' : (action === 'revise' ? 'Draft' : (prior ? priorStatus : 'Draft'));
    mUpsertRow_(M_TAB.TGT, { target_id: id, month: month, team_id: emp.team_id, employee_id: p.employee_id,
      kpi_id: p.kpi_id, target_value: val, target_unit: p.unit || '', target_source: p.source || 'Manual entry',
      approved: status === 'Approved' ? 'TRUE' : 'FALSE', status: status, version: version,
      measurement_criteria: (p.criteria != null && p.criteria !== '') ? p.criteria : (prior ? prior.measurement_criteria : '') || '',
      set_by: s.name, set_at: nowIso_(), waived: p.waived ? 'TRUE' : ((prior ? prior.waived : '') || '') });
    audit_(s.name, 'target', id, action, p.kpi_id + ' target ' + (priorVal == null ? '' : priorVal + ' → ') + val +
      ' (' + month + ', ' + status + ' v' + version + ')');
    return jsonSafe_({ ok: true, id: id, status: status, model: buildModel_(null, month) });
  } catch (e) { return { ok: false, error: String(e && e.message || e), where: 'apiSaveTarget' }; }
}

/* --- set many targets at once (the team-month bulk grid) -------------------- */
function apiSaveTargetsBulk(p) {
  try {
    p = p || {};
    var s = resolveSession_();
    var month = monthKey_(p.month); if (!month) throw new Error('Choose a period first.');
    var items = (p.items || []).filter(function (it) { return it && it.employee_id && it.kpi_id && numOrNull_(it.value) != null; });
    if (!items.length) throw new Error('Nothing to save — enter at least one target value.');
    var action = p.action === 'approve' ? 'approve' : 'save';
    var priorBy = {}; mRead_(M_TAB.TGT).forEach(function (r) { priorBy[String(r.target_id)] = r; });
    var wrote = 0;
    items.forEach(function (it) {
      if (!canSetTarget_(s, it.employee_id)) return;   /* skip silently what this user may not set */
      var emp = s._byId[it.employee_id]; if (!emp) return;
      var val = numOrNull_(it.value); if (val == null || val < 0) return;
      var id = 'TGT-' + month + '-' + it.employee_id + '-' + it.kpi_id;
      var prior = priorBy[id] || null, priorStatus = targetStatus_(prior);
      var version = prior ? (numOrNull_(prior.version) || 1) : 1;
      if (prior && priorStatus === 'Approved' && numOrNull_(prior.target_value) !== val) version += 1;
      var status = action === 'approve' ? 'Approved' : (prior ? priorStatus : 'Draft');
      mUpsertRow_(M_TAB.TGT, { target_id: id, month: month, team_id: emp.team_id, employee_id: it.employee_id,
        kpi_id: it.kpi_id, target_value: val, target_unit: it.unit || '', target_source: 'Bulk entry',
        approved: status === 'Approved' ? 'TRUE' : 'FALSE', status: status, version: version,
        measurement_criteria: (prior ? prior.measurement_criteria : '') || '', set_by: s.name, set_at: nowIso_(),
        waived: (prior ? prior.waived : '') || '' });
      wrote++;
    });
    audit_(s.name, 'target', 'bulk-' + month, action, wrote + ' targets ' + (action === 'approve' ? 'approved' : 'saved') + ' (' + month + ')');
    return jsonSafe_({ ok: true, wrote: wrote, model: buildModel_(null, month) });
  } catch (e) { return { ok: false, error: String(e && e.message || e), where: 'apiSaveTargetsBulk' }; }
}

/* --- advance a team's month through the planning lifecycle ------------------ */
function apiSetMonthState(p) {
  try {
    p = p || {};
    var s = resolveSession_();
    requireManageMonth_(s);
    var month = monthKey_(p.month); if (!month) throw new Error('Choose a period first.');
    var state = MONTH_STATES.indexOf(p.state) >= 0 ? p.state : null;
    if (!state) throw new Error('Unknown month state.');
    if (state === 'Reopened' && !String(p.note || '').trim()) throw new Error('Reopening a closed month needs a reason.');
    var teamId = p.team_id || 'ALL';
    var id = stateId_(month, teamId);
    mUpsertRow_(M_TAB.MONTHSTATE, { state_id: id, month: month, team_id: teamId, state: state,
      note: p.note || '', changed_by: s.name, changed_at: nowIso_() });
    audit_(s.name, 'month', id, 'state', teamId + ' ' + month + ' → ' + state + (p.note ? ' (' + p.note + ')' : ''));
    return jsonSafe_({ ok: true, id: id, state: state, model: buildModel_(null, month) });
  } catch (e) { return { ok: false, error: String(e && e.message || e), where: 'apiSetMonthState' }; }
}

/* --- seed a new month from the previous one (roll-forward) ------------------ */
function apiRollForwardTargets(p) {
  try {
    p = p || {};
    var s = resolveSession_();
    requireManageMonth_(s);
    var to = monthKey_(p.to_month); if (!to) throw new Error('Choose the month to seed.');
    var from = monthKey_(p.from_month) || prevMonth_(to);
    var teamId = p.team_id || null;
    var all = mRead_(M_TAB.TGT), existing = {};
    all.forEach(function (r) { if (monthKey_(r.month) === to) existing[r.employee_id + '|' + r.kpi_id] = true; });
    var seeded = 0;
    all.filter(function (r) { return monthKey_(r.month) === from && (!teamId || String(r.team_id) === teamId); })
      .forEach(function (r) {
        var key = r.employee_id + '|' + r.kpi_id;
        if (existing[key]) return;                     /* never overwrite a target already set for the new month */
        if (!canSetTarget_(s, r.employee_id)) return;
        var id = 'TGT-' + to + '-' + r.employee_id + '-' + r.kpi_id;
        mUpsertRow_(M_TAB.TGT, { target_id: id, month: to, team_id: r.team_id, employee_id: r.employee_id,
          kpi_id: r.kpi_id, target_value: numOrNull_(r.target_value), target_unit: r.target_unit || '',
          target_source: 'Rolled forward from ' + from, approved: 'FALSE', status: 'Draft', version: 1,
          measurement_criteria: r.measurement_criteria || '', set_by: s.name, set_at: nowIso_(), waived: '' });
        existing[key] = true; seeded++;
      });
    audit_(s.name, 'target', 'roll-' + to, 'roll_forward', seeded + ' targets seeded into ' + to + ' from ' + from);
    return jsonSafe_({ ok: true, seeded: seeded, from: from, to: to, model: buildModel_(null, to) });
  } catch (e) { return { ok: false, error: String(e && e.message || e), where: 'apiRollForwardTargets' }; }
}
/* ======================================================================
 * EMPLOYEE DIRECTORY — map an employee to a team
 * ----------------------------------------------------------------------
 * Team assignment is configuration, so it lives on the config sheet (the
 * primary roster is never rewritten): a reassignment records assigned_team_id
 * on the Employees tab + a KRA_KPI_History row (field 'team', old -> new), and
 * applyTeamAssignments_ overlays it onto the model so the person moves teams
 * everywhere at once. An employee always belongs to exactly one team, so a move
 * replaces the assignment — there is no way to create a duplicate.
 * ====================================================================== */
function apiAssignTeam(p) {
  try {
    p = p || {};
    var s = resolveSession_();
    requireEditConfig_(s, p.employee_id);
    var base = buildModel_(null, null);
    var sc = base.scorecards.filter(function (x) { return x.employee_id === p.employee_id; })[0];
    if (!sc) throw new Error('Unknown employee.');
    var team = base.teams.filter(function (t) { return t.team_id === p.team_id; })[0];
    if (!team) throw new Error('Choose a valid team.');
    if (sc.team_id === p.team_id) throw new Error(sc.employee_name + ' is already on ' + (team.team_name || p.team_id) + '.');
    var fromTeam = base.teams.filter(function (t) { return t.team_id === sc.team_id; })[0] || {};
    var now = nowIso_(), actor = s.name;

    var existing = cfgFind_(C_TAB.EMP, { employee_id: p.employee_id })[0];
    var row = {};
    C_SCHEMA[C_TAB.EMP].forEach(function (k) { row[k] = existing ? existing[k] : ''; });
    row.employee_id = p.employee_id; row.employee_name = sc.employee_name;
    row.team_id = existing && existing.team_id ? existing.team_id : sc.team_id;   // original team, preserved
    row.team_name = existing && existing.team_name ? existing.team_name : (fromTeam.team_name || '');
    row.designation = sc.designation || ''; row.reporting_manager = sc.reporting_manager || ''; row.status = 'ACTIVE';
    row.assigned_team_id = p.team_id; row.assigned_team_name = team.team_name || p.team_id;
    row.team_updated_by = actor; row.team_updated_at = now; row.synced_at = now;
    cfgUpsert_(C_TAB.EMP, row);

    histRow_(actor, { employee_id: p.employee_id, employee_name: sc.employee_name }, '', '', sc.employee_name,
      'team', (fromTeam.team_name || sc.team_id), (team.team_name || p.team_id), 'reassign', 1, '');
    sysLog_(actor, 'info', 'apiAssignTeam', sc.employee_name + ' → ' + (team.team_name || p.team_id));
    return jsonSafe_({ ok: true, model: buildModel_(null, null) });
  } catch (e) { return { ok: false, error: String(e && e.message || e), where: 'apiAssignTeam' }; }
}

/* Overlay team reassignments onto the model (before the KPI overlay). Defensive:
 * a missing / unshared config sheet leaves the roster untouched. */
function applyTeamAssignments_(model) {
  var rows;
  try { rows = cfgRead_(C_TAB.EMP); } catch (e) { return model; }
  if (!rows || !rows.length) return model;
  var teamName = {}; model.teams.forEach(function (t) { teamName[t.team_id] = t.team_name; });
  var moveTo = {};
  rows.forEach(function (r) { if (r.assigned_team_id && teamName[r.assigned_team_id] != null) moveTo[r.employee_id] = r.assigned_team_id; });
  model.scorecards.forEach(function (sc) {
    var to = moveTo[sc.employee_id];
    if (to && to !== sc.team_id) { sc.team_id = to; sc.team_assigned = true; }
  });
  return model;
}
