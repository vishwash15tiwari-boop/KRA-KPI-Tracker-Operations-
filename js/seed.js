/* ============================================================================
 * SEED — realistic fictional data. The organisation structure is authoritative
 * (from the supplied org chart); people, targets and performance are generated
 * deterministically so the spread of target levels (Below T1 … T5) is stable and
 * reproducible. Rahul Sharma (EMP-00124) is hard-set to the spec's demo values.
 * ========================================================================== */
window.Seed = (function () {
  'use strict';
  var uid = Domain.uid, now = Domain.nowIso;

  /* deterministic RNG so a reseed reproduces the same dataset */
  function rng(seed) { var s = seed >>> 0; return function () { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
  function pick(r, arr) { return arr[Math.floor(r() * arr.length)]; }

  var ORG_TYPES = [
    { id: 'ot_lead', name: 'Leadership', code: 'LEAD', color: '#B8860B', sort: 0 },
    { id: 'ot_bu', name: 'Business Unit', code: 'BU', color: '#2E7D52', sort: 1 },
    { id: 'ot_cf', name: 'Central Function', code: 'CF', color: '#7C4DBC', sort: 2 },
    { id: 'ot_sf', name: 'Support Function', code: 'SF', color: '#2f74d0', sort: 3 }
  ];

  var LEADERSHIP = [
    { id: 'EMP-00001', name: 'Abhay Deshpande', designation: 'Chief Executive Officer · Founder', code: 'CEO' },
    { id: 'EMP-00002', name: 'Ekta Narain', designation: 'Chief Business & Impact Officer', code: 'CBIO' },
    { id: 'EMP-00003', name: 'Abhishek Deshpande', designation: 'Chief Operating Officer', code: 'COO' },
    { id: 'EMP-00004', name: 'Vijay Vanparthi', designation: 'Chief Financial Officer', code: 'CFO' },
    { id: 'EMP-00005', name: 'Vikram Prabhakar', designation: 'Chief Product & Technology Officer', code: 'CPTO' },
    { id: 'EMP-00006', name: 'Anirudha Jalan', designation: 'Chief Strategy Officer', code: 'CSO' },
    { id: 'EMP-00007', name: 'Sujan Parthasaradhi', designation: 'Chief Innovation Officer', code: 'CIO' }
  ];

  /* org units: {name, code, typeId, headEmpId}. Heads map to leadership. */
  var UNITS = [
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

  var ROLES = [
    { id: 'super_admin', name: 'Super Admin' }, { id: 'hr_admin', name: 'HR / Admin' },
    { id: 'business_head', name: 'Business Head' }, { id: 'team_leader', name: 'Team Leader' },
    { id: 'manager', name: 'Manager' }, { id: 'employee', name: 'Employee' }, { id: 'auditor', name: 'Auditor' }
  ];

  /* KRA/KPI framework (shared). direction covers higher / lower / range. */
  var KRAS = [
    { id: 'kra_rev', name: 'Revenue', code: 'REV', weight: 40, description: 'Top-line revenue delivered across new and existing business.' },
    { id: 'kra_ca', name: 'Customer Acquisition', code: 'CA', weight: 30, description: 'Growth of the customer base and conversion effectiveness.' },
    { id: 'kra_prod', name: 'Productivity', code: 'PROD', weight: 30, description: 'Operational efficiency, throughput and quality of delivery.' }
  ];
  var KPIS = [
    { id: 'kpi_ms', kraId: 'kra_rev', name: 'Monthly Sales', code: 'MS', measurementType: 'currency', unit: 'L', frequency: 'Monthly', direction: 'higher_is_better', weight: 40, description: 'Total sales value closed in the period.' },
    { id: 'kpi_ncr', kraId: 'kra_rev', name: 'New Customer Revenue', code: 'NCR', measurementType: 'currency', unit: 'L', frequency: 'Monthly', direction: 'higher_is_better', weight: 30, description: 'Revenue from customers acquired this period.' },
    { id: 'kpi_col', kraId: 'kra_rev', name: 'Collection', code: 'COL', measurementType: 'currency', unit: 'L', frequency: 'Monthly', direction: 'higher_is_better', weight: 30, description: 'Payments collected against outstanding invoices.' },
    { id: 'kpi_na', kraId: 'kra_ca', name: 'New Accounts', code: 'NA', measurementType: 'count', unit: 'accounts', frequency: 'Monthly', direction: 'higher_is_better', weight: 60, description: 'Number of new accounts onboarded.' },
    { id: 'kpi_lc', kraId: 'kra_ca', name: 'Lead Conversion', code: 'LC', measurementType: 'percentage', unit: '%', frequency: 'Monthly', direction: 'higher_is_better', weight: 40, description: 'Share of qualified leads converted.' },
    { id: 'kpi_ut', kraId: 'kra_prod', name: 'Utilization', code: 'UT', measurementType: 'percentage', unit: '%', frequency: 'Monthly', direction: 'higher_is_better', weight: 50, description: 'Productive utilisation of available capacity.' },
    { id: 'kpi_ct', kraId: 'kra_prod', name: 'Cycle Time', code: 'CT', measurementType: 'time', unit: 'days', frequency: 'Monthly', direction: 'lower_is_better', weight: 25, description: 'Average days to complete the core workflow (lower is better).' },
    { id: 'kpi_qs', kraId: 'kra_prod', name: 'Quality Score', code: 'QS', measurementType: 'number', unit: 'pts', frequency: 'Monthly', direction: 'range', weight: 25, description: 'Balanced quality index; the ideal sits mid-band.' }
  ];
  /* per-KPI target ladders [t1..t5] used for generation (Rahul overridden below) */
  var LADDER = {
    kpi_ms: [10, 15, 20, 25, 30], kpi_ncr: [10, 15, 20, 25, 30], kpi_col: [5, 8, 10, 12, 15],
    kpi_na: [5, 10, 15, 20, 25], kpi_lc: [40, 50, 60, 70, 80],
    kpi_ut: [60, 70, 80, 90, 95], kpi_ct: [30, 25, 20, 15, 10], kpi_qs: [60, 70, 80, 90, 100]
  };

  function actualForLevel(t, level, dir) {
    function mid(a, b) { return a + (b - a) * 0.5; }
    if (dir === 'lower_is_better') {
      if (level <= 0) return Math.round(t[0] * 1.2);
      if (level >= 5) return Math.round(t[4] * 0.9 * 10) / 10;
      return Math.round(mid(t[level - 1], t[level]) * 10) / 10;
    }
    if (dir === 'range') { // aim near ideal (t3) for high level; edges for low
      var lo = t[0], hi = t[4], m = t[2];
      if (level <= 0) return Math.round(lo - (hi - lo) * 0.2);
      var frac = (5 - level) / 5;                    // level5 -> at ideal, level1 -> near edge
      return Math.round(m + (hi - m) * frac);
    }
    if (level <= 0) return Math.round(t[0] * 0.8 * 10) / 10;
    if (level >= 5) return Math.round((t[4] + (t[4] - t[3]) * 0.4) * 10) / 10;
    return Math.round(mid(t[level - 1], t[level]) * 10) / 10;
  }

  var FIRST = ['Aarav', 'Vivaan', 'Aditya', 'Vihaan', 'Arjun', 'Sai', 'Reyansh', 'Krishna', 'Ishaan', 'Kabir', 'Ananya', 'Diya', 'Aadhya', 'Saanvi', 'Pari', 'Anika', 'Neha', 'Priya', 'Riya', 'Kavya', 'Rohan', 'Karan', 'Nikhil', 'Varun', 'Rahul', 'Amit', 'Sneha', 'Pooja', 'Deepak', 'Manish', 'Suresh', 'Meera', 'Divya', 'Tanvi', 'Ishita', 'Farhan', 'Zoya', 'Aliya'];
  var LAST = ['Sharma', 'Verma', 'Patel', 'Reddy', 'Nair', 'Iyer', 'Rao', 'Singh', 'Gupta', 'Mehta', 'Kulkarni', 'Bose', 'Das', 'Menon', 'Kapoor', 'Malhotra', 'Chopra', 'Bhat', 'Pillai', 'Joshi'];
  var DESIGS = ['Executive', 'Senior Executive', 'Associate', 'Senior Associate', 'Assistant Manager', 'Manager'];
  var EMP_TYPES = ['Full-time', 'Full-time', 'Full-time', 'Contract'];

  function build() {
    var employees = [], teams = [], assignments = [], targets = [], performance = [], reviews = [], notifications = [];
    var users = [], settings = [], cycles = [], periods = [];
    var r = rng(20260827);

    // leadership employees (org type leadership, no unit/team)
    LEADERSHIP.forEach(function (l, i) {
      employees.push({ id: l.id, name: l.name, designation: l.designation, orgTypeId: 'ot_lead', orgUnitId: '', teamId: '',
        managerId: i === 0 ? '' : 'EMP-00001', functionalHeadId: '', employmentStatus: 'Active', employmentType: 'Full-time',
        dateOfJoining: '2019-04-01', location: 'Hyderabad', roleId: i === 0 ? 'super_admin' : 'business_head', email: slug(l.name) + '@recykal.com', photo: '' });
    });

    // cycle + periods (FY 2026-27 months + quarters + FY)
    cycles.push({ id: 'cy_fy2627', name: 'FY 2026–27', type: 'financial_year' });
    var months = [['2026-04', 'April 2026'], ['2026-05', 'May 2026'], ['2026-06', 'June 2026'], ['2026-07', 'July 2026'], ['2026-08', 'August 2026'],
      ['2026-09', 'September 2026'], ['2026-10', 'October 2026'], ['2026-11', 'November 2026'], ['2026-12', 'December 2026'],
      ['2027-01', 'January 2027'], ['2027-02', 'February 2027'], ['2027-03', 'March 2027']];
    var CURRENT = 'per_2026-08';
    months.forEach(function (m, i) {
      periods.push({ id: 'per_' + m[0], cycleId: 'cy_fy2627', name: m[1], kind: 'month', code: m[0], sort: i,
        status: i < 4 ? 'locked' : i === 4 ? 'open' : 'upcoming', startDate: m[0] + '-01' });
    });
    ['Q1', 'Q2', 'Q3', 'Q4', 'FY'].forEach(function (q, i) { periods.push({ id: 'per_' + q, cycleId: 'cy_fy2627', name: 'FY 2026–27 · ' + q, kind: q === 'FY' ? 'fy' : 'quarter', code: q, sort: 100 + i, status: 'open', startDate: '2026-04-01' }); });

    // active months we generate performance for (history for trend)
    var HIST = ['per_2026-04', 'per_2026-05', 'per_2026-06', 'per_2026-07', 'per_2026-08'];

    // teams: a spread across units; INFRA gets Metals (Rahul). Give ~5 units real teams.
    var TEAMSPEC = [
      { unit: 'INFRA', name: 'Metals Team', code: 'METAL' },
      { unit: 'INFRA', name: 'Cement & Aggregates', code: 'CEMENT' },
      { unit: 'OMP', name: 'Marketplace Sales', code: 'OMPSALES' },
      { unit: 'EPR', name: 'EPR Compliance Desk', code: 'EPRDESK' },
      { unit: 'ONBC', name: 'Onboarding Ops', code: 'ONBOPS' },
      { unit: 'RECOM', name: 'Recommerce Trade', code: 'RCTRADE' }
    ];
    /* generated IDs start at 200 so they never collide with the reserved
     * hard-coded IDs (Amit Sharma EMP-00120, Rahul Sharma EMP-00124). */
    var empNo = 200;
    function nextId() { empNo++; return 'EMP-' + ('00000' + empNo).slice(-5); }

    TEAMSPEC.forEach(function (ts, ti) {
      var teamId = 'team_' + ts.code.toLowerCase();
      // team leader
      var leaderId = ts.code === 'METAL' ? 'EMP-00120' : nextId();
      var leaderName = ts.code === 'METAL' ? 'Amit Sharma' : (pick(r, FIRST) + ' ' + pick(r, LAST));
      teams.push({ id: teamId, orgUnitId: unitId(ts.unit), name: ts.name, code: ts.code, leaderId: leaderId,
        description: ts.name + ' — ' + unitName(ts.unit), status: 'Active' });
      employees.push(mkEmp(leaderId, leaderName, 'Team Leader', ts.unit, teamId, funcHead(ts.unit), 'team_leader', r));

      // members (Rahul is member #1 of Metals)
      var count = 5 + Math.floor(r() * 2);
      for (var mi = 0; mi < count; mi++) {
        var id, name, roleId, desig;
        if (ts.code === 'METAL' && mi === 0) { id = 'EMP-00124'; name = 'Rahul Sharma'; desig = 'Senior Executive'; roleId = 'employee'; }
        else { id = nextId(); name = pick(r, FIRST) + ' ' + pick(r, LAST); desig = pick(r, DESIGS); roleId = mi === 1 ? 'manager' : 'employee'; }
        employees.push(mkEmp(id, name, desig, ts.unit, teamId, leaderId, roleId, r));
      }
    });

    // demo users mapped to employees for role-based auth
    users.push({ id: 'u_admin', name: 'Platform Admin', email: 'admin@recykal.com', roleId: 'super_admin', employeeId: 'EMP-00001' });
    users.push({ id: 'u_hr', name: 'Ekta Narain', email: 'ekta.narain@recykal.com', roleId: 'hr_admin', employeeId: 'EMP-00002' });
    users.push({ id: 'u_lead', name: 'Amit Sharma', email: 'amit.sharma@recykal.com', roleId: 'team_leader', employeeId: 'EMP-00120' });
    users.push({ id: 'u_emp', name: 'Rahul Sharma', email: 'rahul.sharma@recykal.com', roleId: 'employee', employeeId: 'EMP-00124' });
    users.push({ id: 'u_audit', name: 'Auditor', email: 'auditor@recykal.com', roleId: 'auditor', employeeId: '' });

    // assignments + targets + performance for every team member across HIST months
    var members = employees.filter(function (e) { return e.teamId; });
    members.forEach(function (emp, idx) {
      var er = rng(hash(emp.id));
      KPIS.forEach(function (kpi) {
        assignments.push({ id: uid('asg'), employeeId: emp.id, kpiId: kpi.id, kraId: kpi.kraId, source: 'team', weight: kpi.weight, status: 'Active', effectiveFrom: '2026-04-01', effectiveTo: '' });
        var ladder = LADDER[kpi.id];
        HIST.forEach(function (periodId, hi) {
          // choose a target level for this emp/kpi/month; Rahul hard-set for Aug
          var level = chooseLevel(emp, kpi, periodId, er, hi);
          var actual = actualForLevel(ladder, level, kpi.direction);
          var override = rahulActual(emp.id, kpi.id, periodId);
          if (override != null) actual = override;
          // one approved target row per emp/kpi/period
          targets.push({ id: 'tgt_' + emp.id + '_' + kpi.id + '_' + periodId, employeeId: emp.id, kpiId: kpi.id, periodId: periodId,
            t1: ladder[0], t2: ladder[1], t3: ladder[2], t4: ladder[3], t5: ladder[4], unit: kpi.unit, direction: kpi.direction,
            status: periodId === CURRENT ? 'published' : 'locked', version: 1, createdBy: 'EMP-00120', approvedBy: 'EMP-00003', approvedAt: '2026-03-28T10:00:00Z' });
          performance.push({ id: 'prf_' + emp.id + '_' + kpi.id + '_' + periodId, employeeId: emp.id, teamId: emp.teamId, kraId: kpi.kraId, kpiId: kpi.id, periodId: periodId,
            t1: ladder[0], t2: ladder[1], t3: ladder[2], t4: ladder[3], t5: ladder[4], direction: kpi.direction, weight: kpi.weight,
            actual: actual, highestLevel: null, levelsAchieved: null, pct: null, score: null,
            status: periodId === CURRENT ? 'submitted' : 'locked', submittedAt: '2026-08-30T09:00:00Z' });
        });
      });
    });

    // a few reviews (current period)
    ['EMP-00124', 'EMP-00120'].forEach(function (id) {
      reviews.push({ id: 'rev_' + id + '_' + CURRENT, employeeId: id, periodId: CURRENT, status: id === 'EMP-00124' ? 'Submitted' : 'Draft',
        managerReview: { achievements: '', strengths: '', improvements: '', concerns: '', comments: '' },
        employeeReview: { selfAssessment: '', comments: '', challenges: '', support: '' }, actionPlan: [],
        reviewerId: 'EMP-00120', createdAt: now(), updatedAt: now() });
    });

    // notifications
    notifications.push({ id: uid('ntf'), recipientId: 'EMP-00120', type: 'Target 5 Achieved', title: 'Target 5 achieved', message: 'Rahul Sharma achieved Target 5 for New Customer Revenue (August 2026).', entityType: 'employee', entityId: 'EMP-00124', read: 0, createdAt: now() });
    notifications.push({ id: uid('ntf'), recipientId: 'EMP-00120', type: 'Performance Submitted', title: 'Performance submitted', message: 'Rahul Sharma submitted performance for August 2026.', entityType: 'employee', entityId: 'EMP-00124', read: 0, createdAt: now() });
    notifications.push({ id: uid('ntf'), recipientId: 'all', type: 'Target Published', title: 'Targets published', message: 'August 2026 targets have been published for all active teams.', entityType: 'period', entityId: CURRENT, read: 0, createdAt: now() });
    notifications.push({ id: uid('ntf'), recipientId: 'EMP-00124', type: 'Review Pending', title: 'Review pending', message: 'Your August 2026 performance review is pending manager sign-off.', entityType: 'review', entityId: 'rev_EMP-00124_' + CURRENT, read: 0, createdAt: now() });

    // settings (configurable business rules — spec §89)
    settings.push({ key: 'aggregation', value: { method: 'weighted_mean', rounding: 'nearest', description: 'Overall = round( Σ(level × weight) ÷ Σ weight ), by KRA weight.' } });
    settings.push({ key: 'ranking', value: { order: ['overallScore', 't5', 't4plus', 'name'], description: 'Rank by overall score, then Target 5 hits, then Target 4+ hits, then name.' } });
    settings.push({ key: 'consistency', value: { level: 4, periods: 3, description: 'Consistent = Target 4+ for 3 consecutive periods.' } });
    settings.push({ key: 'currentPeriod', value: CURRENT });
    settings.push({ key: 'cycle', value: 'cy_fy2627' });

    return { org_types: ORG_TYPES, roles: ROLES, org_units: unitRows(), teams: teams, employees: employees,
      kras: KRAS, kpis: KPIS, cycles: cycles, periods: periods, assignments: assignments, targets: targets,
      performance: performance, reviews: reviews, notifications: notifications, users: users, settings: settings,
      meta: [{ key: 'seeded', value: true }, { key: 'seededAt', value: now() }] };
  }

  /* ---- helpers ---- */
  function slug(n) { return n.toLowerCase().replace(/[^a-z]+/g, '.').replace(/^\.|\.$/g, ''); }
  function hash(s) { var h = 0; for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) & 0x7fffffff; return h; }
  function unitId(code) { return 'ou_' + code.toLowerCase(); }
  function unitName(code) { for (var i = 0; i < UNITS.length; i++) if (UNITS[i][0] === code) return UNITS[i][1]; return code; }
  function funcHead(code) { for (var i = 0; i < UNITS.length; i++) if (UNITS[i][0] === code) return UNITS[i][3]; return ''; }
  function unitRows() { return UNITS.map(function (u) { return { id: unitId(u[0]), orgTypeId: u[2], name: u[1], code: u[0], headId: u[3], status: 'Active' }; }); }
  function mkEmp(id, name, desig, unitCode, teamId, managerId, roleId, r) {
    return { id: id, name: name, designation: desig, orgTypeId: typeOfUnit(unitCode), orgUnitId: unitId(unitCode), teamId: teamId,
      managerId: managerId, functionalHeadId: funcHead(unitCode), employmentStatus: 'Active', employmentType: pick(r, EMP_TYPES),
      dateOfJoining: '2023-0' + (1 + Math.floor(r() * 8)) + '-15', location: pick(r, ['Hyderabad', 'Bengaluru', 'Mumbai', 'Delhi', 'Pune']),
      roleId: roleId, email: slug(name) + (id.slice(-3)) + '@recykal.com', photo: '' };
  }
  function typeOfUnit(code) { for (var i = 0; i < UNITS.length; i++) if (UNITS[i][0] === code) return UNITS[i][2]; return 'ot_bu'; }

  /* choose a target level with a realistic spread; ensure the full range appears */
  function chooseLevel(emp, kpi, periodId, er, hi) {
    // trend: earlier months slightly lower, so "most improved" & history read well
    var base = er();
    var bucket = base < 0.08 ? 0 : base < 0.22 ? 1 : base < 0.42 ? 2 : base < 0.68 ? 3 : base < 0.88 ? 4 : 5;
    var drift = Math.round((hi - 2) * 0.4 * (er() < 0.6 ? 1 : 0)); // gentle upward drift over time
    return Math.max(0, Math.min(5, bucket + drift));
  }
  /* Rahul's exact demo actuals (spec §77/§78), August 2026 */
  function rahulActual(empId, kpiId, periodId) {
    if (empId !== 'EMP-00124' || periodId !== 'per_2026-08') return null;
    var map = { kpi_ms: 27, kpi_ncr: 32, kpi_col: 11, kpi_na: 26, kpi_lc: 72, kpi_ut: 92, kpi_ct: 13, kpi_qs: 88 };
    return map[kpiId] != null ? map[kpiId] : null;
  }

  function run() {
    var data = build();
    return DB.clearAll().then(function () {
      var order = ['org_types', 'roles', 'org_units', 'teams', 'employees', 'kras', 'kpis', 'cycles', 'periods',
        'assignments', 'targets', 'performance', 'reviews', 'notifications', 'settings', 'meta'];
      // users stored in settings-like store? we keep a dedicated approach: put into 'meta' + a users store is absent; store in settings
      return chain(order.map(function (store) { return function () { return DB.bulkPut(store, data[store] || []); }; }))
        .then(function () { return DB.put('meta', { key: 'users', value: data.users }, { skipFk: true }); })
        .then(function () { return recomputeAll(data); });
    });
  }
  function recomputeAll(data) {
    // compute every generated performance record's level + each employee's overall
    var pairs = {};
    (data.performance || []).forEach(function (p) { pairs[p.employeeId + '|' + p.periodId] = { e: p.employeeId, p: p.periodId }; });
    var list = Object.keys(pairs).map(function (k) { return pairs[k]; });
    return chain(list.map(function (x) { return function () { return Domain.recompute(x.e, x.p, 'system'); }; }));
  }
  function chain(fns) { return fns.reduce(function (p, f) { return p.then(f); }, Promise.resolve()); }

  function ensure() {
    return DB.get('meta', 'seeded').then(function (m) { if (m && m.value) return false; return run().then(function () { return true; }); });
  }

  return { run: run, ensure: ensure, build: build };
})();
