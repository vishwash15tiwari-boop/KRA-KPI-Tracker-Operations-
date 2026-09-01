/* ============================================================================
 * PAGES — the 12 modules and the contextual drill-downs. Views only: they read
 * from Data / DB / Domain and render; every write goes through save*() helpers
 * that persist, recompute, audit, notify, then refresh. Progressive disclosure:
 * concise lists → drawers for detail → modals for actions (spec §06).
 * ========================================================================== */
(function () {
  'use strict';
  var h = App.h, $ = App.$, TP = App.TP, D = App.Data, icon = App.icon, badge = App.statusBadge, person = App.person;
  var LS = Domain.LEVEL_SHORT, LL = Domain.LEVEL_LABELS;

  /* ---------- shared joins / context ---------- */
  function ctx(emp) {
    return { type: D.typeOf(emp), unit: D.unitOf(emp), team: D.teamOf(emp),
      manager: emp && D.emps[emp.managerId], head: emp && D.emps[emp.functionalHeadId] };
  }
  function perfOf(empId, periodId) { return DB.by('performance', 'empPeriod', empId + '|' + (periodId || App.S.period)); }
  function fmt(v, kpi) { return Domain.fmtValue(v, kpi && kpi.measurementType, kpi && kpi.unit); }
  function levelPill(l) { return TP.pill(l); }

  function overall(empId, periodId) { return Domain.overallFor(empId, periodId || App.S.period); }
  function kraLevelMap(ov) { var m = {}; if (ov && ov.kraResults) ov.kraResults.forEach(function (k) { m[k.ref] = k.level; }); return m; }

  /* group an employee's performance records by KRA */
  function groupByKra(recs) {
    var by = {}, order = [];
    recs.forEach(function (r) { var k = r.kraId; if (!by[k]) { by[k] = []; order.push(k); } by[k].push(r); });
    return order.map(function (k) { return { kra: D.kras[k], recs: by[k] }; });
  }

  /* ========================================================================
   * CORE WRITE PATH — save an actual, recompute, audit, notify, refresh.
   * This is the single place the acceptance journey (§96 steps 15–24) runs.
   * ====================================================================== */
  function saveActual(empId, kpiId, periodId, value, opts) {
    opts = opts || {};
    var emp = D.emps[empId], per = D.period(periodId);
    if (!App.canScopeEmp(emp)) return Promise.reject(new Error('You do not have permission to edit this employee’s performance.'));
    if (per && per.status === 'locked' && App.S.user.roleId !== 'super_admin' && App.S.user.roleId !== 'hr_admin') return Promise.reject(new Error('Period ' + per.name + ' is locked.'));
    return DB.first('performance', 'empKpiPeriod', empId + '|' + kpiId + '|' + periodId).then(function (rec) {
      if (!rec) throw new Error('No performance record for this KPI/period.');
      var old = rec.actual, prevLevel = rec.highestLevel;
      rec.actual = value === '' || value == null ? null : Number(value);
      rec.status = 'submitted'; rec.updatedAt = Domain.nowIso();
      return DB.put('performance', rec, { skipFk: true }).then(function () { return Domain.recompute(empId, periodId, App.S.user.employeeId || 'system'); })
        .then(function (sum) {
          return DB.first('performance', 'empKpiPeriod', empId + '|' + kpiId + '|' + periodId).then(function (fresh) {
            Domain.audit(App.S.user.employeeId, 'performance', rec.id, 'edit_actual', { actual: old }, { actual: rec.actual, level: fresh.highestLevel });
            var jobs = [];
            if (fresh.highestLevel === 5 && prevLevel !== 5) jobs.push(Domain.notify(emp.managerId || 'all', 'Target 5 Achieved', 'Target 5 achieved', emp.name + ' achieved Target 5 for ' + (D.kpis[kpiId] || {}).name + ' (' + (per ? per.name : periodId) + ').', { type: 'employee', id: empId }));
            return Promise.all(jobs).then(function () { return App.refreshUnread(); }).then(function () { return sum; });
          });
        });
    });
  }

  function refreshAfterWrite(reopen) {
    App.router();
    if (reopen) setTimeout(reopen, 40);
  }

  /* ========================================================================
   * DRILL-DOWN DRAWERS
   * ====================================================================== */
  App.openEmployee = function (id) { App.go('emp/' + id); };

  App.openKra = function (empId, kraId, periodId) {
    periodId = periodId || App.S.period;
    Promise.all([perfOf(empId, periodId), overall(empId, periodId)]).then(function (r) {
      var recs = r[0].filter(function (x) { return x.kraId === kraId; }), kra = D.kras[kraId], kmap = kraLevelMap(r[1]);
      var body = '<dl class="kv"><dt>KRA</dt><dd>' + h(kra.name) + '</dd><dt>Weight</dt><dd>' + h(kra.weight) + '%</dd>' +
        '<dt>KRA Level</dt><dd>' + levelPill(kmap[kraId]) + '</dd></dl>' +
        '<p class="help" style="margin-top:8px">' + h(kra.description || '') + '</p>' +
        '<div class="subh">KPIs</div>' + recs.map(function (rec) {
          var kpi = D.kpis[rec.kpiId];
          return '<div class="drow click" data-kpi="' + empId + '::' + rec.kpiId + '::' + periodId + '"><div class="dn"><b>' + h(kpi.name) + '</b><span>' + h(kpi.description || '') + '</span></div>' + levelPill(rec.highestLevel) + '<span class="chev">' + icon('chev') + '</span></div>';
        }).join('');
      App.Drawer({ title: kra.name, sub: 'KRA · ' + (D.period(periodId) || {}).name, body: body });
    });
  };

  App.openKpi = function (empId, kpiId, periodId) {
    periodId = periodId || App.S.period;
    DB.first('performance', 'empKpiPeriod', empId + '|' + kpiId + '|' + periodId).then(function (rec) {
      var kpi = D.kpis[kpiId], emp = D.emps[empId], per = D.period(periodId);
      if (!rec) { App.Drawer({ title: kpi.name, sub: 'KPI', body: App.emptyState({ title: 'Not assigned', msg: kpi.name + ' is not assigned to ' + emp.name + ' for this period.' }) }); return; }
      var res = Domain.levelFor([rec.t1, rec.t2, rec.t3, rec.t4, rec.t5], rec.actual, rec.direction);
      var dirLabel = { higher_is_better: 'Higher is better', lower_is_better: 'Lower is better', range: 'Target range', exact: 'Exact / threshold' }[rec.direction] || rec.direction;
      var editable = App.canScopeEmp(emp) && !(per && per.status === 'locked' && App.S.user.roleId !== 'super_admin' && App.S.user.roleId !== 'hr_admin');
      var body = '<dl class="kv"><dt>Definition</dt><dd style="font-weight:500">' + h(kpi.description || '—') + '</dd>' +
        '<dt>Unit</dt><dd>' + h(kpi.unit || '—') + '</dd><dt>Frequency</dt><dd>' + h(kpi.frequency || '—') + '</dd><dt>Direction</dt><dd>' + h(dirLabel) + '</dd></dl>' +
        '<div class="subh">Target Progress</div>' +
        TP.full({ t: [rec.t1, rec.t2, rec.t3, rec.t4, rec.t5], level: rec.highestLevel, actual: rec.actual, pct: rec.pct, measurementType: kpi.measurementType, unit: kpi.unit }) +
        '<div class="card" style="margin-top:14px;padding:12px 14px"><div class="row"><div><div class="muted" style="font-size:11px;font-weight:600">HIGHEST TARGET</div><div style="font-size:16px;font-weight:750" class="tp l' + (rec.highestLevel || 0) + '"><span style="color:var(--h)">' + (rec.highestLevel != null ? LL[rec.highestLevel] : 'Pending') + '</span></div></div>' +
        '<div style="margin-left:auto;text-align:right"><div class="muted" style="font-size:11px;font-weight:600">ACHIEVEMENT</div><div style="font-size:16px;font-weight:750">' + (rec.pct != null ? rec.pct + '%' : '—') + '</div></div></div></div>';
      if (editable) {
        body += '<div class="subh">Enter / update actual</div><div class="field"><label>Actual value <span class="opt">(' + h(kpi.unit || '') + ')</span></label>' +
          '<input class="input" id="kpi-actual" inputmode="decimal" value="' + (rec.actual == null ? '' : h(rec.actual)) + '"><div class="help" id="kpi-preview"></div></div>';
      }
      var foot = editable ? '<button class="btn" data-ovclose="x">Cancel</button><button class="btn primary" id="kpi-save">Save actual</button>' : '';
      App.Drawer({ title: kpi.name, sub: emp.name + ' · ' + (per || {}).name, wide: false, body: body, foot: foot, mount: function (root) {
        if (!editable) return;
        var inp = $('#kpi-actual', root), prev = $('#kpi-preview', root);
        function upd() { var r2 = Domain.levelFor([rec.t1, rec.t2, rec.t3, rec.t4, rec.t5], inp.value, rec.direction); prev.innerHTML = 'Current level → <b class="tp l' + (r2.level || 0) + '" style="color:var(--h)">' + (r2.level != null ? LL[r2.level] : 'Pending') + '</b>' + (r2.pct != null ? ' · ' + r2.pct + '%' : ''); }
        inp.addEventListener('input', upd); upd();
        $('#kpi-save', root).addEventListener('click', function () {
          var btn = this; btn.disabled = true; btn.textContent = 'Saving…';
          saveActual(empId, kpiId, periodId, inp.value).then(function () {
            App.toast('Actual saved · levels recomputed', 'good'); App.Overlay.close();
            refreshAfterWrite(function () { App.openKpi(empId, kpiId, periodId); });
          }).catch(function (e) { btn.disabled = false; btn.textContent = 'Save actual'; App.toast(e.message, 'bad'); });
        });
      } });
    });
  };

  App.openTarget = function (empId, kpiId, periodId) {
    periodId = periodId || App.S.period;
    Promise.all([DB.first('targets', 'empKpiPeriod', empId + '|' + kpiId + '|' + periodId), DB.first('performance', 'empKpiPeriod', empId + '|' + kpiId + '|' + periodId)]).then(function (r) {
      var tgt = r[0], perf = r[1], kpi = D.kpis[kpiId], emp = D.emps[empId], per = D.period(periodId);
      if (!tgt) { App.Drawer({ title: kpi.name, sub: 'Target', body: App.emptyState({ title: 'No target set', msg: 'No target for this KPI/period yet.' }) }); return; }
      var body = '<dl class="kv"><dt>Employee</dt><dd>' + h(emp.name) + '</dd><dt>KRA</dt><dd>' + h((D.kras[kpi.kraId] || {}).name) + '</dd><dt>KPI</dt><dd>' + h(kpi.name) + '</dd><dt>Period</dt><dd>' + h((per || {}).name) + '</dd><dt>Status</dt><dd>' + badge(cap(tgt.status)) + ' · v' + h(tgt.version || 1) + '</dd></dl>' +
        '<div class="subh">Target levels</div>' +
        TP.full({ t: [tgt.t1, tgt.t2, tgt.t3, tgt.t4, tgt.t5], level: perf ? perf.highestLevel : null, actual: perf ? perf.actual : null, pct: perf ? perf.pct : null, measurementType: kpi.measurementType, unit: kpi.unit });
      var canEdit = App.can('edit') && App.canScopeEmp(emp) && !(per && per.status === 'locked');
      var foot = canEdit ? '<button class="btn" data-target-hist="' + h(tgt.id) + '">History</button><button class="btn primary" data-target-edit="' + empId + '::' + kpiId + '::' + periodId + '">Edit target</button>' : '';
      App.Drawer({ title: kpi.name + ' — Target', sub: emp.name + ' · ' + (per || {}).name, body: body, foot: foot });
    });
  };

  App.openReview = function (empId, periodId) {
    periodId = periodId || App.S.period;
    Promise.all([DB.first('reviews', 'empPeriod', empId + '|' + periodId), overall(empId, periodId)]).then(function (r) {
      var rev = r[0], ov = r[1], emp = D.emps[empId], per = D.period(periodId);
      var mr = (rev && rev.managerReview) || {}, er = (rev && rev.employeeReview) || {};
      var body = '<div class="tp-hero-wrap">' + TP.hero({ cap: 'Overall Level · ' + (per || {}).name, level: ov ? ov.overallLevel : null, score: ov ? ov.overallScore : null }) + '</div>' +
        '<dl class="kv" style="margin-top:14px"><dt>Employee</dt><dd>' + h(emp.name) + '</dd><dt>Status</dt><dd>' + badge(rev ? rev.status : 'Draft') + '</dd></dl>' +
        '<div class="subh">Manager review</div>' + textBlock('Achievements', mr.achievements) + textBlock('Strengths', mr.strengths) + textBlock('Areas for improvement', mr.improvements) +
        '<div class="subh">Employee self-assessment</div>' + textBlock('Self assessment', er.selfAssessment) + textBlock('Challenges', er.challenges) + textBlock('Support required', er.support);
      var canEdit = App.canScopeEmp(emp);
      var foot = canEdit ? '<button class="btn primary" data-review-edit="' + empId + '::' + periodId + '">' + (rev ? 'Edit review' : 'Create review') + '</button>' : '';
      App.Drawer({ title: 'Performance Review', sub: emp.name + ' · ' + (per || {}).name, wide: true, body: body, foot: foot });
    });
  };
  function textBlock(label, v) { return '<div style="margin-bottom:8px"><div class="muted" style="font-size:11.5px;font-weight:600">' + h(label) + '</div><div style="font-size:13px">' + (v ? h(v) : '<span class="faint">Not provided</span>') + '</div></div>'; }
  function cap(s) { return s ? s[0].toUpperCase() + s.slice(1) : s; }

  App.openUnit = function (unitId) {
    var unit = D.units[unitId], type = D.types[unit.orgTypeId], teams = Object.values(D.teams).filter(function (t) { return t.orgUnitId === unitId; });
    var emps = D.empsInUnit(unitId), head = D.emps[unit.headId];
    Promise.all(emps.map(function (e) { return overall(e.id); })).then(function (ovs) {
      var levels = ovs.filter(Boolean).map(function (o) { return o.overallLevel; }).filter(function (x) { return x != null; });
      var avg = levels.length ? Math.round(levels.reduce(function (a, b) { return a + b; }, 0) / levels.length) : null;
      var body = '<dl class="kv"><dt>Type</dt><dd><span class="otype" style="color:' + type.color + ';background:' + type.color + '18">' + h(type.name) + '</span></dd>' +
        '<dt>Head</dt><dd>' + (head ? h(head.name) : '—') + '</dd><dt>Teams</dt><dd>' + teams.length + '</dd><dt>Employees</dt><dd>' + emps.length + '</dd>' +
        '<dt>Overall Level</dt><dd>' + levelPill(avg) + '</dd></dl>' +
        '<div class="subh">Teams</div>' + (teams.length ? teams.map(function (t) { return '<div class="drow click" data-team="' + t.id + '"><div class="dn"><b>' + h(t.name) + '</b><span>' + D.membersOf(t.id).length + ' members</span></div><span class="chev">' + icon('chev') + '</span></div>'; }).join('') : '<p class="help">No teams defined for this unit yet.</p>');
      App.Drawer({ title: unit.name, sub: unit.code + ' · ' + type.name, body: body });
    });
  };

  App.openTeam = function (id) { App.go('team/' + id); };

  /* ========================================================================
   * PAGE: Employee Directory (spec §28)
   * ====================================================================== */
  App.registerPage('directory', {
    render: function () {
      App.setCrumbs([{ label: 'People' }, { label: 'Employee Directory' }]);
      var emps = Object.values(D.emps).filter(function (e) { return e.teamId || e.orgTypeId !== 'ot_lead'; });
      return Promise.all(emps.map(function (e) { return overall(e.id).then(function (o) { return { e: e, level: o ? o.overallLevel : null }; }); })).then(function (rows) {
        var f = App._dirFilter || (App._dirFilter = {});
        return page({
          title: 'Employee Directory', sub: 'The master employee database · ' + rows.length + ' people',
          actions: (App.can('create') ? btn('primary', 'plus', 'Add Employee', 'data-add-emp') : '') + btn('', 'download', 'Export', 'data-export="employees"'),
          body: dirFilters(f) + '<div id="dir-table"></div>'
        });
      });
    },
    mount: function () { App._dirRender(); }
  });
  function dirFilters(f) {
    function opt(list, cur) { return '<option value="">All</option>' + list.map(function (x) { return '<option value="' + h(x.v) + '"' + (cur === x.v ? ' selected' : '') + '>' + h(x.l) + '</option>'; }).join(''); }
    var units = Object.values(D.units).map(function (u) { return { v: u.id, l: u.name }; });
    var teams = Object.values(D.teams).map(function (t) { return { v: t.id, l: t.name }; });
    var types = Object.values(D.types).map(function (t) { return { v: t.id, l: t.name }; });
    return '<div class="filterbar">' +
      '<input class="input sinput" id="dir-q" placeholder="Search ID, name, designation…" value="' + h(f.q || '') + '">' +
      sel('dir-type', 'Type', opt(types, f.type)) + sel('dir-unit', 'Unit', opt(units, f.unit)) + sel('dir-team', 'Team', opt(teams, f.team)) +
      '</div>';
  }
  App._dirRender = function () {
    var f = App._dirFilter || {};
    var emps = Object.values(D.emps).filter(function (e) { return e.teamId || e.orgTypeId !== 'ot_lead'; });
    Promise.all(emps.map(function (e) { return overall(e.id).then(function (o) { return { e: e, level: o ? o.overallLevel : null }; }); })).then(function (rows) {
      rows = rows.filter(function (r) {
        var e = r.e;
        if (f.q && (e.name + ' ' + e.id + ' ' + e.designation).toLowerCase().indexOf(f.q.toLowerCase()) < 0) return false;
        if (f.type && e.orgTypeId !== f.type) return false;
        if (f.unit && e.orgUnitId !== f.unit) return false;
        if (f.team && e.teamId !== f.team) return false;
        return true;
      });
      var host = $('#dir-table'); if (!host) return;
      App._rerender = function () { host.innerHTML = dirTable(rows); };
      host.innerHTML = dirTable(rows);
    });
  };
  function dirTable(rows) {
    return App.Table({
      id: 'dir', noun: 'employees', rows: rows, sort: 'name',
      cols: [
        { key: 'id', label: 'Employee ID', sortVal: function (r) { return r.e.id; }, render: function (r) { return '<span class="idcell">' + h(r.e.id) + '</span>'; } },
        { key: 'name', label: 'Employee', sortVal: function (r) { return r.e.name; }, render: function (r) { return person(r.e); } },
        { key: 'desig', label: 'Designation', sortVal: function (r) { return r.e.designation; }, render: function (r) { return h(r.e.designation); } },
        { key: 'unit', label: 'Organisation Unit', sortVal: function (r) { return (D.unitOf(r.e) || {}).name || ''; }, render: function (r) { return h((D.unitOf(r.e) || {}).name || '—'); } },
        { key: 'team', label: 'Team', sortVal: function (r) { return (D.teamOf(r.e) || {}).name || ''; }, render: function (r) { return h((D.teamOf(r.e) || {}).name || '—'); } },
        { key: 'mgr', label: 'Manager', sortVal: function (r) { return (D.emps[r.e.managerId] || {}).name || ''; }, render: function (r) { return h((D.emps[r.e.managerId] || {}).name || '—'); } },
        { key: 'level', label: 'Overall Level', sortVal: function (r) { return r.level || 0; }, render: function (r) { return TP.ticks(r.level); } },
        { key: 'status', label: 'Status', sortVal: function (r) { return r.e.employmentStatus; }, render: function (r) { return badge(r.e.employmentStatus); } }
      ],
      onRow: true, rowAttr: function (r) { return 'data-emp="' + r.e.id + '"'; }
    });
  }

  /* ========================================================================
   * PAGE: Employee Profile (contextual workspace, spec §29–§31) — route emp/:id
   * ====================================================================== */
  App.registerPage('emp', {
    render: function (params) {
      var id = params[0], emp = D.emps[id];
      if (!emp) return App.emptyState({ title: 'Employee not found', msg: 'No employee “' + id + '”.' });
      var c = ctx(emp), tab = (App._empTab && App._empTab[id]) || 'overview';
      App.setCrumbs([{ label: 'People', href: '#/directory' }, { label: 'Employee Directory', href: '#/directory' }, { label: emp.name }]);
      return Promise.all([perfOf(id), overall(id)]).then(function (r) {
        var recs = r[0], ov = r[1], kmap = kraLevelMap(ov);
        var header = '<div class="card" style="display:flex;gap:16px;align-items:center;margin-bottom:16px">' +
          '<div class="avatar lg">' + h(App.initials(emp.name)) + '</div>' +
          '<div style="min-width:0"><div style="font-size:19px;font-weight:750">' + h(emp.name) + '</div>' +
          '<div class="muted" style="font-size:13px">' + h(emp.designation) + ' · <span class="idcell">' + h(emp.id) + '</span></div>' +
          '<div class="row wrap" style="gap:6px;margin-top:8px">' +
            chipmeta(c.type ? c.type.name : 'Leadership') + chipmeta((c.unit || {}).name || '—') + chipmeta((c.team || {}).name || '—') +
            '<span class="badge neutral"><span class="d"></span>' + h(emp.employmentStatus) + '</span></div></div>' +
          '<div style="margin-left:auto;text-align:right"><div class="muted" style="font-size:11px;font-weight:600">REPORTS TO</div><div style="font-weight:650">' + h((c.manager || {}).name || '—') + '</div>' +
          '<div class="muted" style="font-size:11px;font-weight:600;margin-top:6px">FUNCTIONAL HEAD</div><div style="font-weight:650">' + h((c.head || {}).name || '—') + '</div></div></div>';
        var tabs = tabbar(id, ['overview::Overview', 'krakpi::KRA / KPI', 'targets::Targets', 'performance::Performance', 'reviews::Reviews', 'history::History'], tab);
        var body = tabBody(tab, emp, recs, ov, kmap);
        return header + tabs + '<div id="emp-tabbody">' + body + '</div>';
      });
    }
  });
  function chipmeta(t) { return '<span class="badge neutral"><span class="d"></span>' + h(t) + '</span>'; }
  function tabbar(id, tabs, cur) {
    return '<div class="tabs">' + tabs.map(function (t) { var kv = t.split('::'); return '<button data-emptab="' + id + '::' + kv[0] + '" class="' + (cur === kv[0] ? 'on' : '') + '">' + h(kv[1]) + '</button>'; }).join('') + '</div>';
  }
  function tabBody(tab, emp, recs, ov, kmap) {
    if (tab === 'overview') {
      var groups = groupByKra(recs);
      var kras = groups.map(function (g) {
        return '<div class="drow click" data-kra="' + emp.id + '::' + g.kra.id + '::' + App.S.period + '"><div class="dn"><b>' + h(g.kra.name) + '</b><span>' + g.recs.length + ' KPIs · weight ' + h(g.kra.weight) + '%</span></div>' + levelPill(kmap[g.kra.id]) + '<span class="chev">' + icon('chev') + '</span></div>';
      }).join('');
      return '<div class="cards grid-2" style="align-items:start"><div>' + TP.hero({ cap: 'Overall Level · ' + (D.period() || {}).name, level: ov ? ov.overallLevel : null, score: ov ? ov.overallScore : null }) + '</div>' +
        '<div class="card"><div class="sect-h"><h3>KRA summary</h3><span class="r">click to open</span></div>' + (kras || '<p class="help">No KRAs assigned for this period.</p>') + '</div></div>' +
        '<div class="card" style="margin-top:14px"><div class="sect-h"><h3>KPI performance</h3><span class="r">' + recs.length + ' KPIs</span></div>' + kpiMiniList(emp, recs) + '</div>';
    }
    if (tab === 'krakpi') {
      return groupByKra(recs).map(function (g) {
        return '<div class="card" style="margin-bottom:12px"><div class="sect-h"><h3>' + h(g.kra.name) + '</h3><span class="r">' + levelPillInline(kmap[g.kra.id]) + '</span></div>' +
          g.recs.map(function (rec) { var kpi = D.kpis[rec.kpiId];
            return '<div class="drow click" data-kpi="' + emp.id + '::' + rec.kpiId + '::' + App.S.period + '"><div class="dn"><b>' + h(kpi.name) + '</b><span>' + h(kpi.description || '') + '</span></div>' + TP.ticks(rec.highestLevel) + '<span class="chev">' + icon('chev') + '</span></div>'; }).join('') + '</div>';
      }).join('') || App.emptyState({ title: 'No KPIs assigned', msg: 'No KPIs have been assigned to this employee for this period.' });
    }
    if (tab === 'targets') {
      return '<div class="card pad0">' + App.Table({ id: 'emptgt', noun: 'targets', rows: recs, sort: 'kpi',
        cols: [ { key: 'kra', label: 'KRA', sortVal: function (r) { return (D.kras[r.kraId] || {}).name; }, render: function (r) { return h((D.kras[r.kraId] || {}).name); } },
          { key: 'kpi', label: 'KPI', sortVal: function (r) { return (D.kpis[r.kpiId] || {}).name; }, render: function (r) { return h((D.kpis[r.kpiId] || {}).name); } },
          { key: 't', label: 'T1 – T5', render: function (r) { var k = D.kpis[r.kpiId]; return '<span class="muted tnum" style="font-size:12px">' + [r.t1, r.t2, r.t3, r.t4, r.t5].map(function (x) { return fmt(x, k); }).join(' · ') + '</span>'; } },
          { key: 'lvl', label: 'Level', num: true, sortVal: function (r) { return r.highestLevel || 0; }, render: function (r) { return levelPill(r.highestLevel); } } ],
        onRow: true, rowAttr: function (r) { return 'data-target="' + emp.id + '::' + r.kpiId + '::' + App.S.period + '"'; } }) + '</div>';
    }
    if (tab === 'performance') {
      return '<div class="row" style="margin-bottom:12px"><div class="muted">Enter or update actuals for ' + h((D.period() || {}).name) + '.</div>' +
        (App.canScopeEmp(emp) ? '<button class="btn primary" style="margin-left:auto" data-perf-entry="' + emp.id + '::' + App.S.period + '">' + icon('edit') + 'Enter performance</button>' : '') + '</div>' +
        '<div class="card">' + kpiMiniList(emp, recs, true) + '</div>';
    }
    if (tab === 'reviews') {
      return '<div class="card"><div class="sect-h"><h3>Reviews</h3>' + (App.canScopeEmp(emp) ? '<button class="btn sm primary" style="margin-left:auto" data-review-edit="' + emp.id + '::' + App.S.period + '">Open review</button>' : '') + '</div>' +
        '<div class="drow click" data-review="' + emp.id + '::' + App.S.period + '"><div class="dn"><b>' + h((D.period() || {}).name) + ' review</b><span>Overall ' + (ov ? LS[ov.overallLevel] : '—') + '</span></div><span class="chev">' + icon('chev') + '</span></div></div>';
    }
    if (tab === 'history') {
      return '<div id="emp-history">' + App.loading() + '</div>';
    }
    return '';
  }
  function levelPillInline(l) { return '<span class="tp l' + (l || 0) + '"><span class="lvl-pill' + (l == null ? ' none' : '') + '">' + (l != null ? LS[l] : 'Pending') + '</span></span>'; }
  function kpiMiniList(emp, recs, showBar) {
    if (!recs.length) return '<p class="help">No KPIs assigned.</p>';
    return recs.map(function (rec) { var kpi = D.kpis[rec.kpiId];
      return '<div class="drow click" data-kpi="' + emp.id + '::' + rec.kpiId + '::' + App.S.period + '"><div class="dn"><b>' + h(kpi.name) + '</b><span>Actual ' + fmt(rec.actual, kpi) + (rec.pct != null ? ' · ' + rec.pct + '%' : '') + '</span></div>' +
        (showBar ? '<div style="width:220px">' + TP.full({ t: [rec.t1, rec.t2, rec.t3, rec.t4, rec.t5], level: rec.highestLevel, hideFoot: true, measurementType: kpi.measurementType, unit: kpi.unit }) + '</div>' : '') +
        levelPill(rec.highestLevel) + '<span class="chev">' + icon('chev') + '</span></div>';
    }).join('');
  }
  function loadHistory(empId) {
    var host = $('#emp-history'); if (!host) return;
    Promise.all(App.S.periods.map(function (p) { return overall(empId, p.id).then(function (o) { return { p: p, o: o }; }); })).then(function (list) {
      list = list.filter(function (x) { return x.o; });
      host.innerHTML = '<div class="card"><div class="sect-h"><h3>Performance history</h3></div>' +
        (list.length ? list.slice().reverse().map(function (x) { return '<div class="drow click" data-month="' + x.p.id + '::' + empId + '"><div class="dn"><b>' + h(x.p.name) + '</b><span>Overall score ' + (x.o.overallScore || '—') + '</span></div>' + levelPill(x.o.overallLevel) + '</div>'; }).join('') : '<p class="help">No history yet.</p>') + '</div>';
    });
  }

  /* ========================================================================
   * PAGE: Organization (spec §25) — structure view with category cards
   * ====================================================================== */
  App.registerPage('organization', {
    render: function () {
      App.setCrumbs([{ label: 'People' }, { label: 'Organization' }]);
      var types = Object.values(D.types).sort(function (a, b) { return a.sort - b.sort; });
      var lead = Object.values(D.emps).filter(function (e) { return e.orgTypeId === 'ot_lead'; });
      var ceo = lead.filter(function (e) { return e.id === 'EMP-00001'; })[0];
      var leadCards = '<div class="org-cat" style="background:var(--c-lead-soft)"><div class="org-cat-h"><span class="n" style="background:var(--c-lead)">01</span><span class="t" style="color:var(--c-lead)">Leadership</span></div>' +
        '<div style="display:grid;place-items:center;margin-bottom:12px"><div class="leader-card" style="min-width:280px"><span class="lr-role" style="background:var(--c-lead)">CEO</span><b>' + h(ceo.name) + '</b><span>' + h(ceo.designation) + '</span></div></div>' +
        '<div class="org-units" style="grid-template-columns:repeat(auto-fill,minmax(200px,1fr))">' + lead.filter(function (e) { return e.id !== 'EMP-00001'; }).map(function (e) {
          var code = e.designation.match(/^(C\w+O|CBIO|CPTO|CSO|CIO|CFO|COO)/); return '<div class="leader-card"><span class="lr-role" style="background:var(--c-lead)">' + h((e.email.match(/^(\w+)/) || [])[0] ? codeOf(e) : '') + '</span><b>' + h(e.name) + '</b><span>' + h(e.designation) + '</span></div>';
        }).join('') + '</div></div>';
      var cats = types.filter(function (t) { return t.id !== 'ot_lead'; }).map(function (t, i) {
        var units = Object.values(D.units).filter(function (u) { return u.orgTypeId === t.id; });
        var soft = { ot_bu: 'var(--c-bu-soft)', ot_cf: 'var(--c-cf-soft)', ot_sf: 'var(--c-sf-soft)' }[t.id];
        return '<div class="org-cat" style="background:' + soft + '"><div class="org-cat-h"><span class="n" style="background:' + t.color + '">0' + (i + 2) + '</span><span class="t" style="color:' + t.color + '">' + h(t.name) + 's</span><span class="c" style="color:' + t.color + '">' + units.length + ' units</span></div>' +
          '<div class="org-units">' + units.map(function (u) { return '<div class="ou-card" style="--oc:' + t.color + '" data-unit="' + u.id + '"><div class="oc-code">' + h(u.code) + '</div><div class="oc-name">' + h(u.name) + '</div><div class="oc-meta"><span><b>' + Object.values(D.teams).filter(function (x) { return x.orgUnitId === u.id; }).length + '</b> teams</span><span><b>' + D.empsInUnit(u.id).length + '</b> people</span></div></div>'; }).join('') + '</div></div>';
      }).join('');
      return page({ title: 'Organization', sub: 'Company structure · FY 2026–27', actions: '<div class="seg"><button class="on">Structure</button><button data-org-list>List</button></div>', body: leadCards + cats });
    }
  });
  function codeOf(e) { var m = { 'EMP-00002': 'CBIO', 'EMP-00003': 'COO', 'EMP-00004': 'CFO', 'EMP-00005': 'CPTO', 'EMP-00006': 'CSO', 'EMP-00007': 'CIO' }; return m[e.id] || ''; }

  /* ========================================================================
   * PAGE: Teams (spec §26)
   * ====================================================================== */
  App.registerPage('teams', {
    render: function () {
      App.setCrumbs([{ label: 'People' }, { label: 'Teams' }]);
      var teams = Object.values(D.teams);
      return Promise.all(teams.map(function (t) {
        var members = D.membersOf(t.id);
        return Promise.all(members.map(function (m) { return DB.by('performance', 'empPeriod', m.id + '|' + App.S.period); })).then(function (all) {
          var levels = [], t5 = 0;
          all.forEach(function (recs, i) { var ml = []; recs.forEach(function (r) { if (r.highestLevel != null) { ml.push(r.highestLevel); if (r.highestLevel === 5) t5++; } }); });
          return overallsFor(members).then(function (ovs) {
            var lv = ovs.map(function (o) { return o && o.overallLevel; }).filter(function (x) { return x != null; });
            return { t: t, members: members.length, level: lv.length ? Math.round(lv.reduce(function (a, b) { return a + b; }, 0) / lv.length) : null, t5: t5 };
          });
        });
      })).then(function (rows) {
        var tbl = App.Table({ id: 'teams', noun: 'teams', rows: rows, sort: 'name',
          cols: [ { key: 'name', label: 'Team', sortVal: function (r) { return r.t.name; }, render: function (r) { return '<b>' + h(r.t.name) + '</b>'; } },
            { key: 'unit', label: 'Organisation Unit', sortVal: function (r) { return (D.units[r.t.orgUnitId] || {}).name; }, render: function (r) { return h((D.units[r.t.orgUnitId] || {}).name); } },
            { key: 'leader', label: 'Team Leader', sortVal: function (r) { return (D.emps[r.t.leaderId] || {}).name; }, render: function (r) { return h((D.emps[r.t.leaderId] || {}).name || '—'); } },
            { key: 'members', label: 'Employees', num: true, sortVal: function (r) { return r.members; }, render: function (r) { return r.members; } },
            { key: 'level', label: 'Team Level', sortVal: function (r) { return r.level || 0; }, render: function (r) { return TP.ticks(r.level); } },
            { key: 't5', label: 'Target 5 Hits', num: true, sortVal: function (r) { return r.t5; }, render: function (r) { return '<b>' + r.t5 + '</b>'; } },
            { key: 'status', label: 'Status', render: function (r) { return badge(r.t.status); } } ],
          onRow: true, rowAttr: function (r) { return 'data-team="' + r.t.id + '"'; } });
        return page({ title: 'Teams', sub: rows.length + ' operational teams', actions: App.can('create') ? btn('primary', 'plus', 'Add Team', 'data-add-team') : '', body: '<div id="teams-table">' + tbl + '</div>' });
      });
    }
  });
  function overallsFor(members) { return Promise.all(members.map(function (m) { return overall(m.id); })); }

  /* ========================================================================
   * PAGE: Team Detail — route team/:id (spec §26, §27)
   * ====================================================================== */
  App.registerPage('team', {
    render: function (params) {
      var id = params[0], team = D.teams[id];
      if (!team) return App.emptyState({ title: 'Team not found', msg: 'No team “' + id + '”.' });
      var unit = D.units[team.orgUnitId], members = D.membersOf(id), leader = D.emps[team.leaderId];
      App.setCrumbs([{ label: 'People', href: '#/teams' }, { label: 'Teams', href: '#/teams' }, { label: team.name }]);
      return overallsFor(members).then(function (ovs) {
        var byId = {}; members.forEach(function (m, i) { byId[m.id] = ovs[i]; });
        var lv = ovs.map(function (o) { return o && o.overallLevel; }).filter(function (x) { return x != null; });
        var teamLevel = lv.length ? Math.round(lv.reduce(function (a, b) { return a + b; }, 0) / lv.length) : null;
        var header = '<div class="card" style="display:flex;gap:16px;align-items:center;margin-bottom:16px"><div class="avatar lg" style="border-radius:12px;background:linear-gradient(135deg,#c7d2fe,#bfdbfe)">' + h(team.code.slice(0, 2)) + '</div>' +
          '<div><div style="font-size:19px;font-weight:750">' + h(team.name) + '</div><div class="muted">' + h(unit.name) + ' · Led by ' + h((leader || {}).name || '—') + '</div></div>' +
          '<div style="margin-left:auto">' + TP.hero({ cap: 'Team Level', level: teamLevel }) + '</div></div>';
        // hierarchy: leader → members
        var tree = '<div class="tree"><div class="tnode root">' + tcard(leader) +
          '<div style="margin-top:4px">' + members.filter(function (m) { return m.id !== team.leaderId; }).map(function (m) { return '<div class="tnode">' + tcard(m, byId[m.id]) + '</div>'; }).join('') + '</div></div></div>';
        var rows = members.map(function (m) { return { m: m, o: byId[m.id] }; });
        var tbl = App.Table({ id: 'teammembers', noun: 'members', rows: rows, sort: 'level', dir: 'desc',
          cols: [ { key: 'name', label: 'Employee', sortVal: function (r) { return r.m.name; }, render: function (r) { return person(r.m); } },
            { key: 'desig', label: 'Designation', sortVal: function (r) { return r.m.designation; }, render: function (r) { return h(r.m.designation); } },
            { key: 'level', label: 'Overall Level', sortVal: function (r) { return (r.o && r.o.overallLevel) || 0; }, render: function (r) { return TP.ticks(r.o && r.o.overallLevel); } },
            { key: 'score', label: 'Score', num: true, sortVal: function (r) { return (r.o && r.o.overallScore) || 0; }, render: function (r) { return (r.o && r.o.overallScore) || '—'; } } ],
          onRow: true, rowAttr: function (r) { return 'data-emp="' + r.m.id + '"'; } });
        return App.setCrumbs([{ label: 'People', href: '#/teams' }, { label: 'Teams', href: '#/teams' }, { label: team.name }]), header +
          tabbar('team-' + id, ['members::Employees', 'hierarchy::Hierarchy'], (App._teamTab && App._teamTab[id]) || 'members') +
          '<div id="team-tabbody">' + ((App._teamTab && App._teamTab[id]) === 'hierarchy' ? tree : '<div class="card pad0">' + tbl + '</div>') + '</div>';
      });
    }
  });
  function tcard(e, o) { if (!e) return ''; return '<div class="tcard" data-emp="' + e.id + '"><div class="avatar sm">' + h(App.initials(e.name)) + '</div><div class="tn"><b>' + h(e.name) + '</b><span>' + h(e.designation) + '</span></div>' + (o ? TP.ticks(o.overallLevel) : '') + '</div>'; }

  /* ========================================================================
   * PAGE: KRA / KPI framework (spec §34)
   * ====================================================================== */
  App.registerPage('kra-kpi', {
    render: function () {
      App.setCrumbs([{ label: 'Performance' }, { label: 'KRA / KPI' }]);
      var kras = Object.values(D.kras);
      var body = kras.map(function (kra) {
        var kpis = Object.values(D.kpis).filter(function (k) { return k.kraId === kra.id; });
        return '<div class="card" style="margin-bottom:12px"><div class="sect-h"><h3>' + h(kra.name) + '</h3><span class="badge neutral">' + h(kra.code) + '</span><span class="badge accent">weight ' + h(kra.weight) + '%</span><span class="r">' + kpis.length + ' KPIs</span></div>' +
          '<p class="help" style="margin:-4px 0 10px">' + h(kra.description) + '</p>' +
          kpis.map(function (k) { return '<div class="drow"><div class="dn"><b>' + h(k.name) + '</b><span>' + h(k.description) + '</span></div>' +
            '<span class="badge neutral">' + h(dirShort(k.direction)) + '</span><span class="badge neutral">' + h(cap(k.measurementType)) + '</span><span class="badge accent">' + h(k.weight) + '%</span></div>'; }).join('') + '</div>';
      }).join('');
      return page({ title: 'KRA / KPI', sub: kras.length + ' KRAs · ' + Object.keys(D.kpis).length + ' KPIs · the performance framework',
        actions: (App.can('create') ? btn('primary', 'plus', 'Create KRA', 'data-add-kra') + btn('', 'plus', 'Create KPI', 'data-add-kpi') : ''), body: body });
    }
  });
  function dirShort(d) { return { higher_is_better: 'Higher', lower_is_better: 'Lower', range: 'Range', exact: 'Exact' }[d] || d; }

  /* ========================================================================
   * PAGE: Targets (spec §36)
   * ====================================================================== */
  App.registerPage('targets', {
    render: function () {
      App.setCrumbs([{ label: 'Performance' }, { label: 'Targets' }]);
      return DB.by('performance', 'periodId', App.S.period).then(function (recs) {
        var rows = recs.map(function (r) { return r; });
        var tbl = App.Table({ id: 'targets', noun: 'targets', rows: rows, sort: 'emp',
          cols: [ { key: 'emp', label: 'Employee', sortVal: function (r) { return (D.emps[r.employeeId] || {}).name; }, render: function (r) { return person(D.emps[r.employeeId]); } },
            { key: 'kra', label: 'KRA', sortVal: function (r) { return (D.kras[r.kraId] || {}).name; }, render: function (r) { return h((D.kras[r.kraId] || {}).name); } },
            { key: 'kpi', label: 'KPI', sortVal: function (r) { return (D.kpis[r.kpiId] || {}).name; }, render: function (r) { return h((D.kpis[r.kpiId] || {}).name); } },
            { key: 'level', label: 'Current Level', sortVal: function (r) { return r.highestLevel || 0; }, render: function (r) { return levelPill(r.highestLevel); } },
            { key: 'status', label: 'Status', render: function (r) { return badge(cap(r.status)); } } ],
          onRow: true, rowAttr: function (r) { return 'data-target="' + r.employeeId + '::' + r.kpiId + '::' + App.S.period + '"'; } });
        return page({ title: 'Targets', sub: 'Period-specific target levels · ' + (D.period() || {}).name, actions: App.can('create') ? btn('primary', 'plus', 'Create Target', 'data-add-target') + btn('', 'download', 'Copy previous period', 'data-copy-targets') : '', body: '<div id="targets-table">' + tbl + '</div>' });
      });
    }
  });

  /* ========================================================================
   * PAGE: Performance (spec §41)
   * ====================================================================== */
  App.registerPage('performance', {
    render: function () {
      App.setCrumbs([{ label: 'Performance' }, { label: 'Performance' }]);
      var emps = Object.values(D.emps).filter(function (e) { return e.teamId; });
      return Promise.all(emps.map(function (e) { return Promise.all([overall(e.id), perfOf(e.id)]).then(function (r) { return { e: e, o: r[0], recs: r[1] }; }); })).then(function (rows) {
        var tbl = App.Table({ id: 'perf', noun: 'employees', rows: rows, sort: 'level', dir: 'desc',
          cols: [ { key: 'emp', label: 'Employee', sortVal: function (r) { return r.e.name; }, render: function (r) { return person(r.e); } },
            { key: 'team', label: 'Team', sortVal: function (r) { return (D.teamOf(r.e) || {}).name; }, render: function (r) { return h((D.teamOf(r.e) || {}).name || '—'); } },
            { key: 'level', label: 'Overall Level', sortVal: function (r) { return (r.o && r.o.overallLevel) || 0; }, render: function (r) { return TP.ticks(r.o && r.o.overallLevel); } },
            { key: 'done', label: 'Completion', num: true, sortVal: function (r) { var d = r.recs.filter(function (x) { return x.actual != null; }).length; return r.recs.length ? d / r.recs.length : 0; }, render: function (r) { var d = r.recs.filter(function (x) { return x.actual != null; }).length; return '<span class="tnum">' + d + ' / ' + r.recs.length + '</span>'; } },
            { key: 'act', label: '', render: function (r) { return App.canScopeEmp(r.e) ? '<button class="btn sm" data-perf-entry="' + r.e.id + '::' + App.S.period + '">Enter</button>' : ''; } } ],
          onRow: true, rowAttr: function (r) { return 'data-emp="' + r.e.id + '"'; } });
        return page({ title: 'Performance', sub: 'Actual entry & review · ' + (D.period() || {}).name, body: '<div id="perf-table">' + tbl + '</div>' });
      });
    }
  });

  /* ========================================================================
   * PAGE: Reviews (spec §45)
   * ====================================================================== */
  App.registerPage('reviews', {
    render: function () {
      App.setCrumbs([{ label: 'Performance' }, { label: 'Reviews' }]);
      var emps = Object.values(D.emps).filter(function (e) { return e.teamId; });
      return Promise.all(emps.map(function (e) { return Promise.all([overall(e.id), DB.first('reviews', 'empPeriod', e.id + '|' + App.S.period)]).then(function (r) { return { e: e, o: r[0], rev: r[1] }; }); })).then(function (rows) {
        var tbl = App.Table({ id: 'reviews', noun: 'reviews', rows: rows, sort: 'emp',
          cols: [ { key: 'emp', label: 'Employee', sortVal: function (r) { return r.e.name; }, render: function (r) { return person(r.e); } },
            { key: 'period', label: 'Period', render: function () { return h((D.period() || {}).name); } },
            { key: 'level', label: 'Overall Level', sortVal: function (r) { return (r.o && r.o.overallLevel) || 0; }, render: function (r) { return levelPill(r.o && r.o.overallLevel); } },
            { key: 'status', label: 'Review Status', sortVal: function (r) { return (r.rev && r.rev.status) || 'Not Started'; }, render: function (r) { return badge((r.rev && r.rev.status) || 'Draft'); } } ],
          onRow: true, rowAttr: function (r) { return 'data-review="' + r.e.id + '::' + App.S.period + '"'; } });
        return page({ title: 'Reviews', sub: 'Quantitative results + qualitative assessment', body: '<div class="card pad0">' + tbl + '</div>' });
      });
    }
  });

  /* ========================================================================
   * PAGE: Leaderboard (spec §46–§51)
   * ====================================================================== */
  App.registerPage('leaderboard', {
    render: function () {
      App.setCrumbs([{ label: 'Performance' }, { label: 'Leaderboard' }]);
      var view = App._lbView || 'overall';
      return Domain.leaderboard(App.S.period).then(function (lb) {
        var seg = '<div class="seg">' + [['overall', 'Overall'], ['t5', 'Target 5'], ['t4plus', 'Target 4+']].map(function (v) { return '<button class="' + (view === v[0] ? 'on' : '') + '" data-lbview="' + v[0] + '">' + v[1] + '</button>'; }).join('') + '</div>';
        var rows = lb.slice();
        if (view === 't5') rows.sort(function (a, b) { return b.t5 - a.t5 || (b.overallScore || 0) - (a.overallScore || 0); });
        else if (view === 't4plus') rows.sort(function (a, b) { return b.t4plus - a.t4plus || (b.overallScore || 0) - (a.overallScore || 0); });
        rows.forEach(function (r, i) { r._rank = i + 1; });
        var cols = [ { key: 'rank', label: '#', sortable: false, render: function (r) { return '<b>' + r._rank + '</b>'; } },
          { key: 'emp', label: 'Employee', sortable: false, render: function (r) { return person(r.employee, r.employee.id); } },
          { key: 'team', label: 'Team', sortable: false, render: function (r) { return h((D.teamOf(r.employee) || {}).name || '—'); } },
          { key: 'level', label: 'Overall Level', sortable: false, render: function (r) { return TP.ticks(r.overallLevel); } } ];
        if (view !== 't4plus') cols.push({ key: 't5', label: 'Target 5 Hits', num: true, sortable: false, render: function (r) { return '<b>' + r.t5 + '</b> <span class="muted">/ ' + r.eligible + '</span>'; } });
        if (view === 't5') cols.push({ key: 'rate', label: 'T5 Rate', num: true, sortable: false, render: function (r) { return r.t5rate + '%'; } });
        else cols.push({ key: 't4', label: 'Target 4+ Hits', num: true, sortable: false, render: function (r) { return '<b>' + r.t4plus + '</b>'; } });
        var tbl = App.Table({ id: 'lb', noun: 'people', rows: rows, perPage: 15, cols: cols, onRow: true, rowAttr: function (r) { return 'data-emp="' + r.employee.id + '"'; } });
        return page({ title: 'Leaderboard', sub: 'Ranked by overall score, then Target 5, then Target 4+ · ' + (D.period() || {}).name, actions: seg, body: '<div id="lb-table">' + tbl + '</div>' });
      });
    }
  });

  /* ========================================================================
   * PAGE: Reports (spec §52)
   * ====================================================================== */
  App.registerPage('reports', {
    render: function () {
      App.setCrumbs([{ label: 'Analytics' }, { label: 'Reports' }]);
      var cats = [['employee', 'Employee performance', 'Per-employee target levels across KRAs/KPIs'], ['team', 'Team performance', 'Team-level rollups and Target 5 hits'], ['kra', 'KRA / KPI', 'Distribution of levels by KRA and KPI'], ['leaderboard', 'Leaderboard', 'Ranked performance export'], ['summary', 'Summary', 'Organisation-wide level distribution']];
      var body = '<div class="cards grid-3">' + cats.map(function (c) { return '<div class="card" style="cursor:pointer" data-report="' + c[0] + '"><div class="sect-h"><h3>' + h(c[1]) + '</h3></div><p class="help">' + h(c[2]) + '</p><div class="row" style="margin-top:12px"><span class="btn sm">Preview</span><span class="btn sm">' + icon('download') + 'Excel</span></div></div>'; }).join('') + '</div>';
      return page({ title: 'Reports', sub: 'Structured output from live performance records', body: body });
    }
  });

  /* ========================================================================
   * PAGE: Performance Analytics (spec §53) — target-level distributions
   * ====================================================================== */
  App.registerPage('analytics', {
    render: function () {
      App.setCrumbs([{ label: 'Analytics' }, { label: 'Performance Analytics' }]);
      return Promise.all([Domain.analytics(App.S.period), teamCompare(), Domain.leaderboard(App.S.period)]).then(function (r) {
        var a = r[0], teams = r[1], lb = r[2];
        var colors = ['var(--t0)', 'var(--t1)', 'var(--t2)', 'var(--t3)', 'var(--t4)', 'var(--t5)'], labels = ['Below T1', 'T1', 'T2', 'T3', 'T4', 'T5'];
        var total = a.count || 1;
        var dist = '<div class="dist">' + [0, 1, 2, 3, 4, 5].map(function (l) { var n = a.scored[l], w = n / total * 100; return w > 0 ? '<div class="seg" data-distlevel="' + l + '" style="background:' + colors[l] + ';flex:' + n + '" title="' + labels[l] + ': ' + n + '">' + (w > 6 ? n : '') + '</div>' : ''; }).join('') + '</div>' +
          '<div class="legend">' + [0, 1, 2, 3, 4, 5].map(function (l) { return '<span class="li"><span class="sw" style="background:' + colors[l] + '"></span>' + labels[l] + ' <b>' + a.scored[l] + '</b></span>'; }).join('') + '</div>';
        var stats = '<div class="cards grid-4" style="margin-bottom:16px">' +
          stat('Target 5 rate', a.t5rate + '%', a.scored[5] + ' records at T5') + stat('Target 4+ rate', a.t4plus + '%', (a.scored[4] + a.scored[5]) + ' records at T4+') +
          stat('Scored records', a.count, 'of ' + a.total + ' total') + stat('Top performer', lb[0] ? lb[0].employee.name.split(' ')[0] : '—', lb[0] ? lb[0].t5 + ' T5 hits' : '') + '</div>';
        var teamBars = '<div class="bars">' + teams.map(function (t) { var w = (t.avg || 0) / 5 * 100; return '<div class="bar-row"><span>' + h(t.name) + '</span><div class="bar-track"><div class="bar-fill tp l' + (Math.round(t.avg) || 0) + '" style="width:' + w + '%;background:var(--h)"></div></div><b class="tnum">' + (t.avg != null ? LS[Math.round(t.avg)] : '—') + '</b></div>'; }).join('') + '</div>';
        return page({ title: 'Performance Analytics', sub: 'Target-level distribution & comparisons · ' + (D.period() || {}).name, body:
          stats + '<div class="card" style="margin-bottom:16px"><div class="sect-h"><h3>Level distribution</h3><span class="r">click a segment to drill in</span></div>' + dist + '</div>' +
          '<div class="cards grid-2"><div class="card"><div class="sect-h"><h3>Team comparison</h3></div>' + teamBars + '</div>' +
          '<div class="card"><div class="sect-h"><h3>Target 5 leaders</h3></div>' + lb.slice(0, 6).map(function (r, i) { return '<div class="drow click" data-emp="' + r.employee.id + '"><span class="idcell">#' + (i + 1) + '</span><div class="dn" style="margin-left:8px"><b>' + h(r.employee.name) + '</b><span>' + h((D.teamOf(r.employee) || {}).name || '') + '</span></div><b>' + r.t5 + '</b> <span class="muted">T5</span></div>'; }).join('') + '</div></div>' });
      });
    }
  });
  function teamCompare() {
    var teams = Object.values(D.teams);
    return Promise.all(teams.map(function (t) { return overallsFor(D.membersOf(t.id)).then(function (ovs) { var lv = ovs.map(function (o) { return o && o.overallLevel; }).filter(function (x) { return x != null; }); return { name: t.name, avg: lv.length ? lv.reduce(function (a, b) { return a + b; }, 0) / lv.length : null }; }); }));
  }

  /* ========================================================================
   * PAGE: Notifications (spec §55)
   * ====================================================================== */
  App.registerPage('notifications', {
    render: function () {
      App.setCrumbs([{ label: 'System' }, { label: 'Notifications' }]);
      return DB.all('notifications').then(function (ns) {
        ns.sort(function (a, b) { return String(b.createdAt).localeCompare(String(a.createdAt)); });
        var body = ns.length ? '<div class="card pad0" style="padding:8px">' + ns.map(function (n) { return '<div class="drow click" data-notifopen="' + h(n.id) + '::' + h(n.entityType) + '::' + h(n.entityId) + '"><div class="dn"><b>' + h(n.title) + '</b><span>' + h(n.message) + '</span></div><span class="badge ' + (n.read ? 'neutral' : 'accent') + '">' + (n.read ? 'read' : 'new') + '</span></div>'; }).join('') + '</div>' : App.emptyState({ title: 'No notifications', msg: 'Events like published targets and Target 5 achievements will appear here.' });
        return page({ title: 'Notifications', sub: (App._unread || 0) + ' unread', actions: btn('', '', 'Mark all read', 'data-notifread'), body: body });
      });
    }
  });

  /* ========================================================================
   * PAGE: Administration (spec §56)
   * ====================================================================== */
  App.registerPage('administration', {
    render: function () {
      App.setCrumbs([{ label: 'System' }, { label: 'Administration' }]);
      if (!App.can('admin')) return page({ title: 'Administration', sub: 'Configuration', body: App.emptyState({ title: 'No permission', msg: 'Administration is available to HR / Admin and Super Admin roles. Switch role from the user menu.' }) });
      var sections = [['User Management', Object.keys(D.emps).length + ' employees · ' + App.S.users.length + ' users'], ['Roles & Permissions', '7 roles configured'], ['Scoring Rules', 'Weighted mean aggregation'], ['Performance Cycles', 'FY 2026–27 · 12 months'], ['Target Settings', 'Levels are configurable per KPI'], ['Audit Logs', 'All changes tracked']];
      return DB.all('audit').then(function (audits) {
        audits.sort(function (a, b) { return String(b.ts).localeCompare(String(a.ts)); });
        var cards = '<div class="cards grid-3">' + sections.map(function (s) { return '<div class="card" data-admin="' + h(s[0]) + '" style="cursor:pointer"><div class="sect-h"><h3>' + h(s[0]) + '</h3>' + icon('chev') + '</div><p class="help">' + h(s[1]) + '</p></div>'; }).join('') + '</div>';
        var scoring = Data_settings('aggregation'), ranking = Data_settings('ranking'), consistency = Data_settings('consistency');
        var rules = '<div class="card" style="margin-top:16px"><div class="sect-h"><h3>Scoring &amp; ranking rules</h3><span class="r">configurable</span></div><dl class="kv"><dt>Aggregation</dt><dd>' + h(scoring.description) + '</dd><dt>Ranking</dt><dd>' + h(ranking.description) + '</dd><dt>Consistency</dt><dd>' + h(consistency.description) + '</dd></dl></div>';
        var log = '<div class="card" style="margin-top:16px"><div class="sect-h"><h3>Audit log</h3><span class="r">' + audits.length + ' entries</span></div>' + (audits.slice(0, 12).map(function (a) { return '<div class="drow"><div class="dn"><b>' + h(a.action.replace(/_/g, ' ')) + ' · ' + h(a.entityType) + '</b><span>' + h(a.entityId) + ' · ' + h((D.emps[a.actorId] || {}).name || a.actorId) + '</span></div><span class="muted" style="font-size:11px">' + h(String(a.ts).slice(0, 16).replace('T', ' ')) + '</span></div>'; }).join('') || '<p class="help">No changes recorded yet.</p>') + '</div>';
        return page({ title: 'Administration', sub: 'Configuration & governance', actions: btn('danger', '', 'Reset demo data', 'data-reset'), body: cards + rules + log });
      });
    }
  });
  function Data_settings(k) { return D.settings[k] || {}; }

  /* ---------- small render helpers ---------- */
  function page(o) {
    return '<div class="page-head"><div><h1 class="page-title">' + h(o.title) + '</h1>' + (o.sub ? '<div class="page-sub">' + h(o.sub) + '</div>' : '') + '</div>' + (o.actions ? '<div class="page-actions">' + o.actions + '</div>' : '') + '</div>' + o.body;
  }
  function btn(cls, ic, label, attr) { return '<button class="btn ' + cls + '" ' + (attr || '') + '>' + (ic ? icon(ic) : '') + h(label) + '</button>'; }
  function sel(id, label, opts) { return '<select class="select" id="' + id + '" aria-label="' + h(label) + '">' + opts + '</select>'; }
  function stat(l, v, s) { return '<div class="card stat"><div class="l">' + h(l) + '</div><div class="v">' + h(v) + '</div><div class="s">' + h(s || '') + '</div></div>'; }
  App._page = page; App._btn = btn; App._stat = stat;

  /* expose for cross-nav from search/notifications */
  App.openKpiPublic = App.openKpi;

  /* mount hooks: per-page mount for tables that need re-render on sort/paginate */
  var origRouter = App.router;
  // history tab loader + team tab handled in click handler below

  /* register global click handler for all page/drawer/data actions */
  App._onClick = function (e) {
    var t = e.target, el;
    if ((el = t.closest('[data-emp]'))) { App.openEmployee(el.dataset.emp); return; }
    if ((el = t.closest('[data-team]'))) { App.openTeam(el.dataset.team); return; }
    if ((el = t.closest('[data-unit]'))) { App.openUnit(el.dataset.unit); return; }
    if ((el = t.closest('[data-kra]'))) { var k = el.dataset.kra.split('::'); App.openKra(k[0], k[1], k[2]); return; }
    if ((el = t.closest('[data-kpi]'))) { var p = el.dataset.kpi.split('::'); App.openKpi(p[0], p[1], p[2]); return; }
    if ((el = t.closest('[data-target]'))) { var q = el.dataset.target.split('::'); App.openTarget(q[0], q[1], q[2]); return; }
    if ((el = t.closest('[data-review]'))) { var rv = el.dataset.review.split('::'); App.openReview(rv[0], rv[1]); return; }
    if ((el = t.closest('[data-month]'))) { var mo = el.dataset.month.split('::'); App.S.period = mo[0]; App.go('emp/' + mo[1]); return; }
    if ((el = t.closest('[data-emptab]'))) { var et = el.dataset.emptab.split('::'); App._empTab = App._empTab || {}; App._empTab[et[0]] = et[1]; App.router(); if (et[1] === 'history') setTimeout(function () { loadHistory(et[0]); }, 20); return; }
    if ((el = t.closest('[data-lbview]'))) { App._lbView = el.dataset.lbview; App.router(); return; }
    if ((el = t.closest('[data-perf-entry]'))) { var pe = el.dataset.perfEntry.split('::'); openPerfEntry(pe[0], pe[1]); return; }
    if ((el = t.closest('[data-review-edit]'))) { var re = el.dataset.reviewEdit.split('::'); openReviewEdit(re[0], re[1]); return; }
    if ((el = t.closest('[data-add-emp]'))) { openEmpModal(); return; }
    if ((el = t.closest('[data-add-team]'))) { App.toast('Team creation — use Administration → Team Settings (demo).'); return; }
    if ((el = t.closest('[data-add-kra]'))) { openKraModal(); return; }
    if ((el = t.closest('[data-add-kpi]'))) { openKpiModal(); return; }
    if ((el = t.closest('[data-add-target]')) || (el = t.closest('[data-target-edit]'))) { var te = (el.dataset.targetEdit || '').split('::'); openTargetModal(te[0], te[1], te[2]); return; }
    if ((el = t.closest('[data-copy-targets]'))) { App.toast('Targets copied from previous period (demo).'); return; }
    if ((el = t.closest('[data-report]'))) { openReport(el.dataset.report); return; }
    if ((el = t.closest('[data-distlevel]'))) { openDistDrill(+el.dataset.distlevel); return; }
    if ((el = t.closest('[data-admin]'))) { App.toast(el.dataset.admin + ' — configuration section (demo).'); return; }
    if ((el = t.closest('[data-reset]'))) { if (confirm('Reset all demo data? This clears the local database and reseeds.')) { DB.deleteDatabase().then(function () { location.reload(); }); } return; }
    if ((el = t.closest('[data-export]'))) { exportCsv(el.dataset.export); return; }
    if ((el = t.closest('[data-org-list]'))) { App.toast('List view (demo) — the structure view is the primary experience.'); return; }
  };
  App._onInput = function (e) {
    if (e.target.id === 'dir-q') { App._dirFilter.q = e.target.value; App._dirRender(); }
  };
  App._onChange = function (e) {
    if (e.target.id === 'dir-type') { App._dirFilter.type = e.target.value; App._dirRender(); }
    if (e.target.id === 'dir-unit') { App._dirFilter.unit = e.target.value; App._dirRender(); }
    if (e.target.id === 'dir-team') { App._dirFilter.team = e.target.value; App._dirRender(); }
  };

  /* re-render current table after sort/paginate: re-run the page render */
  App._rerender = function () { App.router(); };

  /* ---------- Performance Entry modal (spec §42) ---------- */
  function openPerfEntry(empId, periodId) {
    var emp = D.emps[empId], per = D.period(periodId);
    perfOf(empId, periodId).then(function (recs) {
      var body = '<div class="muted" style="margin-bottom:12px">' + h(emp.name) + ' · <span class="idcell">' + h(emp.id) + '</span> · ' + h((D.teamOf(emp) || {}).name || '') + ' · ' + h((per || {}).name) + '</div>' +
        recs.map(function (rec) { var kpi = D.kpis[rec.kpiId];
          return '<div class="card" style="margin-bottom:10px" data-pe-kpi="' + rec.kpiId + '"><div class="row"><b>' + h(kpi.name) + '</b><span class="badge neutral" style="margin-left:auto">' + h((D.kras[rec.kraId] || {}).name) + '</span></div>' +
            '<div class="muted tnum" style="font-size:11.5px;margin:4px 0 8px">T1 ' + fmt(rec.t1, kpi) + ' · T2 ' + fmt(rec.t2, kpi) + ' · T3 ' + fmt(rec.t3, kpi) + ' · T4 ' + fmt(rec.t4, kpi) + ' · T5 ' + fmt(rec.t5, kpi) + '</div>' +
            '<div class="row"><input class="input pe-actual" data-kpi="' + rec.kpiId + '" style="max-width:180px" inputmode="decimal" placeholder="Actual (' + h(kpi.unit || '') + ')" value="' + (rec.actual == null ? '' : h(rec.actual)) + '"><div class="pe-preview" style="margin-left:12px">' + previewLevel(rec, rec.actual) + '</div></div></div>';
        }).join('');
      App.Modal({ title: 'Enter performance', wide: true, body: body, foot: '<button class="btn" data-ovclose="x">Cancel</button><button class="btn primary" id="pe-save">Save all &amp; recompute</button>',
        mount: function (root) {
          App.$$('.pe-actual', root).forEach(function (inp) { inp.addEventListener('input', function () { var rec = recs.filter(function (x) { return x.kpiId === inp.dataset.kpi; })[0]; inp.closest('.card').querySelector('.pe-preview').innerHTML = previewLevel(rec, inp.value); }); });
          App.$('#pe-save', root).addEventListener('click', function () {
            var btn = this; btn.disabled = true; btn.textContent = 'Saving…';
            var jobs = App.$$('.pe-actual', root).map(function (inp) { return { kpiId: inp.dataset.kpi, val: inp.value }; }).filter(function (x) { return x.val !== ''; });
            saveMany(empId, periodId, jobs).then(function () { App.toast('Performance saved · levels recomputed', 'good'); App.Overlay.close(); refreshAfterWrite(); })
              .catch(function (e) { btn.disabled = false; btn.textContent = 'Save all & recompute'; App.toast(e.message, 'bad'); });
          });
        } });
    });
  }
  function previewLevel(rec, val) { var r = Domain.levelFor([rec.t1, rec.t2, rec.t3, rec.t4, rec.t5], val, rec.direction); return r.level != null ? '<span class="tp l' + r.level + '"><span class="lvl-pill">' + LS[r.level] + '</span></span> <span class="muted" style="font-size:12px">' + (r.pct != null ? r.pct + '%' : '') + '</span>' : '<span class="lvl-pill none">Pending</span>'; }
  function saveMany(empId, periodId, jobs) {
    var emp = D.emps[empId], per = D.period(periodId);
    if (!App.canScopeEmp(emp)) return Promise.reject(new Error('No permission to edit this employee.'));
    if (per && per.status === 'locked' && App.S.user.roleId !== 'super_admin' && App.S.user.roleId !== 'hr_admin') return Promise.reject(new Error('Period ' + per.name + ' is locked.'));
    return jobs.reduce(function (p, j) { return p.then(function () {
      return DB.first('performance', 'empKpiPeriod', empId + '|' + j.kpiId + '|' + periodId).then(function (rec) { if (!rec) return; rec.actual = Number(j.val); rec.status = 'submitted'; return DB.put('performance', rec, { skipFk: true }); });
    }); }, Promise.resolve()).then(function () { return Domain.recompute(empId, periodId, App.S.user.employeeId || 'system'); })
      .then(function () { return Domain.audit(App.S.user.employeeId, 'performance', empId + '|' + periodId, 'enter_performance', null, { kpis: jobs.length }); })
      .then(function () {
        return perfOf(empId, periodId).then(function (recs) { var t5 = recs.filter(function (r) { return r.highestLevel === 5; }); if (t5.length) return Domain.notify(emp.managerId || 'all', 'Performance Submitted', 'Performance submitted', emp.name + ' submitted performance for ' + (per || {}).name + '.', { type: 'employee', id: empId }).then(App.refreshUnread); });
      });
  }

  /* ---------- Review edit modal (spec §45) ---------- */
  function openReviewEdit(empId, periodId) {
    var emp = D.emps[empId], per = D.period(periodId);
    DB.first('reviews', 'empPeriod', empId + '|' + periodId).then(function (rev) {
      rev = rev || { id: 'rev_' + empId + '_' + periodId, employeeId: empId, periodId: periodId, status: 'Draft', managerReview: {}, employeeReview: {}, actionPlan: [], reviewerId: App.S.user.employeeId || '' };
      var mr = rev.managerReview || {}, er = rev.employeeReview || {};
      var body = ta('Achievements', 'r-ach', mr.achievements) + ta('Strengths', 'r-str', mr.strengths) + ta('Areas for improvement', 'r-imp', mr.improvements) +
        '<div class="subh">Employee self-assessment</div>' + ta('Self assessment', 'r-self', er.selfAssessment) + ta('Support required', 'r-sup', er.support) +
        '<div class="field"><label>Status</label><select class="select" id="r-status">' + ['Draft', 'Pending', 'Submitted', 'Completed'].map(function (s) { return '<option' + (rev.status === s ? ' selected' : '') + '>' + s + '</option>'; }).join('') + '</select></div>';
      App.Modal({ title: 'Performance review — ' + emp.name, wide: true, body: body, foot: '<button class="btn" data-ovclose="x">Cancel</button><button class="btn primary" id="r-save">Save review</button>',
        mount: function (root) { App.$('#r-save', root).addEventListener('click', function () {
          rev.managerReview = { achievements: val('r-ach', root), strengths: val('r-str', root), improvements: val('r-imp', root) };
          rev.employeeReview = { selfAssessment: val('r-self', root), support: val('r-sup', root) };
          rev.status = App.$('#r-status', root).value; rev.updatedAt = Domain.nowIso();
          DB.put('reviews', rev, { skipFk: true }).then(function () { return Domain.audit(App.S.user.employeeId, 'review', rev.id, 'save_review', null, { status: rev.status }); })
            .then(function () { return Domain.notify(empId, 'Review Completed', 'Review updated', 'Your ' + (per || {}).name + ' review was updated (' + rev.status + ').', { type: 'review', id: rev.id }); })
            .then(App.refreshUnread).then(function () { App.toast('Review saved', 'good'); App.Overlay.close(); refreshAfterWrite(); });
        }); } });
    });
  }
  function ta(label, id, v) { return '<div class="field"><label>' + h(label) + '</label><textarea class="input" id="' + id + '">' + h(v || '') + '</textarea></div>'; }
  function val(id, root) { var e = App.$('#' + id, root); return e ? e.value : ''; }

  /* ---------- KRA / KPI / Target / Employee creation modals ---------- */
  function openKraModal() {
    var body = fld('Name', '<input class="input" id="k-name">') + fld('Code', '<input class="input" id="k-code">') + fld('Weight (%)', '<input class="input" id="k-weight" type="number" value="20">') + fld('Description', '<textarea class="input" id="k-desc"></textarea>');
    App.Modal({ title: 'Create KRA', body: body, foot: cancelSave('kra-save'), mount: function (root) { App.$('#kra-save', root).addEventListener('click', function () {
      var name = val('k-name', root); if (!name) return App.toast('Name is required', 'bad');
      var kra = { id: 'kra_' + Domain.uid('').slice(-6), name: name, code: val('k-code', root) || name.slice(0, 3).toUpperCase(), weight: +val('k-weight', root) || 0, description: val('k-desc', root), status: 'Active', effectiveFrom: '2026-04-01' };
      DB.put('kras', kra).then(function () { D.kras[kra.id] = kra; return Domain.audit(App.S.user.employeeId, 'kra', kra.id, 'create', null, kra); }).then(function () { App.toast('KRA created', 'good'); App.Overlay.close(); App.router(); });
    }); } });
  }
  function openKpiModal() {
    var kraOpts = Object.values(D.kras).map(function (k) { return '<option value="' + k.id + '">' + h(k.name) + '</option>'; }).join('');
    var body = fld('KRA', '<select class="select" id="k-kra">' + kraOpts + '</select>') + fld('Name', '<input class="input" id="k-name">') +
      fld('Measurement type', '<select class="select" id="k-mt">' + ['number', 'currency', 'percentage', 'count', 'ratio', 'time', 'rating', 'boolean'].map(function (m) { return '<option value="' + m + '">' + cap(m) + '</option>'; }).join('') + '</select>') +
      fld('Direction', '<select class="select" id="k-dir">' + [['higher_is_better', 'Higher is better'], ['lower_is_better', 'Lower is better'], ['range', 'Target range']].map(function (d) { return '<option value="' + d[0] + '">' + d[1] + '</option>'; }).join('') + '</select>') +
      fld('Weight (%)', '<input class="input" id="k-weight" type="number" value="20">') + fld('Definition', '<textarea class="input" id="k-desc"></textarea>');
    App.Modal({ title: 'Create KPI', body: body, foot: cancelSave('kpi-save'), mount: function (root) { App.$('#kpi-save', root).addEventListener('click', function () {
      var name = val('k-name', root); if (!name) return App.toast('Name is required', 'bad');
      var kpi = { id: 'kpi_' + Domain.uid('').slice(-6), kraId: App.$('#k-kra', root).value, name: name, code: name.slice(0, 3).toUpperCase(), description: val('k-desc', root), measurementType: App.$('#k-mt', root).value, unit: '', frequency: 'Monthly', direction: App.$('#k-dir', root).value, weight: +val('k-weight', root) || 0, status: 'Active' };
      DB.put('kpis', kpi).then(function () { D.kpis[kpi.id] = kpi; return Domain.audit(App.S.user.employeeId, 'kpi', kpi.id, 'create', null, kpi); }).then(function () { App.toast('KPI created', 'good'); App.Overlay.close(); App.router(); });
    }); } });
  }
  function openTargetModal(empId, kpiId, periodId) {
    Promise.all([DB.first('targets', 'empKpiPeriod', empId + '|' + kpiId + '|' + periodId), DB.first('performance', 'empKpiPeriod', empId + '|' + kpiId + '|' + periodId)]).then(function (r) {
      var tgt = r[0] || {}, perf = r[1], kpi = D.kpis[kpiId], emp = D.emps[empId];
      var body = '<div class="muted" style="margin-bottom:10px">' + h(emp.name) + ' · ' + h(kpi.name) + ' · ' + h((D.period(periodId) || {}).name) + '</div>' +
        '<div class="cards grid-2">' + [1, 2, 3, 4, 5].map(function (i) { return fld('Target ' + i, '<input class="input tgt-in" data-i="' + i + '" type="number" value="' + (tgt['t' + i] != null ? tgt['t' + i] : '') + '">'); }).join('') + '</div>' +
        '<div class="field"><div class="err-msg" id="tgt-err"></div></div>';
      App.Modal({ title: 'Edit target', body: body, foot: cancelSave('tgt-save'), mount: function (root) { App.$('#tgt-save', root).addEventListener('click', function () {
        var vals = {}; App.$$('.tgt-in', root).forEach(function (inp) { vals['t' + inp.dataset.i] = inp.value === '' ? null : Number(inp.value); });
        var dir = kpi.direction, err = '';
        if (dir === 'higher_is_better') { for (var i = 2; i <= 5; i++) if (vals['t' + i] != null && vals['t' + (i - 1)] != null && vals['t' + i] < vals['t' + (i - 1)]) err = 'For higher-is-better, T' + i + ' must be ≥ T' + (i - 1) + '.'; }
        if (dir === 'lower_is_better') { for (var j = 2; j <= 5; j++) if (vals['t' + j] != null && vals['t' + (j - 1)] != null && vals['t' + j] > vals['t' + (j - 1)]) err = 'For lower-is-better, T' + j + ' must be ≤ T' + (j - 1) + '.'; }
        if (err) { App.$('#tgt-err', root).textContent = err; return; }
        var old = { t1: tgt.t1, t2: tgt.t2, t3: tgt.t3, t4: tgt.t4, t5: tgt.t5 };
        var rec = Object.assign({ id: tgt.id || ('tgt_' + empId + '_' + kpiId + '_' + periodId), employeeId: empId, kpiId: kpiId, periodId: periodId, unit: kpi.unit, direction: dir, status: 'published', version: (tgt.version || 0) + 1, approvedBy: App.S.user.employeeId }, vals);
        DB.put('targets', rec, { skipFk: true }).then(function () {
          if (perf) { Object.assign(perf, vals); return DB.put('performance', perf, { skipFk: true }); }
        }).then(function () { return Domain.recompute(empId, periodId, App.S.user.employeeId); })
          .then(function () { return Domain.audit(App.S.user.employeeId, 'target', rec.id, 'edit_target', old, vals, 'Target revision v' + rec.version); })
          .then(function () { App.toast('Target saved · levels recomputed', 'good'); App.Overlay.close(); refreshAfterWrite(); });
      }); } });
    });
  }
  function openEmpModal() {
    var unitOpts = Object.values(D.units).map(function (u) { return '<option value="' + u.id + '">' + h(u.name) + '</option>'; }).join('');
    var teamOpts = Object.values(D.teams).map(function (t) { return '<option value="' + t.id + '">' + h(t.name) + '</option>'; }).join('');
    var body = fld('Employee ID', '<input class="input" id="e-id" placeholder="EMP-00200">') + fld('Name', '<input class="input" id="e-name">') + fld('Designation', '<input class="input" id="e-desig" value="Executive">') +
      fld('Organisation Unit', '<select class="select" id="e-unit">' + unitOpts + '</select>') + fld('Team', '<select class="select" id="e-team">' + teamOpts + '</select>');
    App.Modal({ title: 'Add Employee', body: body, foot: cancelSave('e-save'), mount: function (root) { App.$('#e-save', root).addEventListener('click', function () {
      var id = val('e-id', root), name = val('e-name', root);
      if (!/^EMP-\d{5}$/.test(id)) return App.toast('Employee ID must look like EMP-00200', 'bad');
      if (D.emps[id]) return App.toast('Employee ID already exists', 'bad');
      if (!name) return App.toast('Name is required', 'bad');
      var unit = D.units[App.$('#e-unit', root).value], team = D.teams[App.$('#e-team', root).value];
      var emp = { id: id, name: name, designation: val('e-desig', root), orgTypeId: unit.orgTypeId, orgUnitId: unit.id, teamId: team.id, managerId: team.leaderId, functionalHeadId: unit.headId, employmentStatus: 'Active', employmentType: 'Full-time', dateOfJoining: '2026-08-01', location: 'Hyderabad', roleId: 'employee', email: '', photo: '' };
      DB.put('employees', emp).then(function () { D.emps[id] = emp; return Domain.audit(App.S.user.employeeId, 'employee', id, 'create', null, { name: name }); }).then(function () { App.toast('Employee added', 'good'); App.Overlay.close(); App.router(); })
        .catch(function (e) { App.toast(e.message, 'bad'); });
    }); } });
  }
  function fld(label, control) { return '<div class="field"><label>' + h(label) + '</label>' + control + '</div>'; }
  function cancelSave(id) { return '<button class="btn" data-ovclose="x">Cancel</button><button class="btn primary" id="' + id + '">Save</button>'; }

  /* ---------- reports / export / drill ---------- */
  function openReport(kind) {
    DB.by('performance', 'periodId', App.S.period).then(function (recs) {
      var body, title = { employee: 'Employee performance', team: 'Team performance', kra: 'KRA / KPI', leaderboard: 'Leaderboard', summary: 'Summary' }[kind] || 'Report';
      if (kind === 'summary') { var dist = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }; recs.forEach(function (r) { if (r.highestLevel != null) dist[r.highestLevel]++; });
        body = '<div class="kv">' + [0, 1, 2, 3, 4, 5].map(function (l) { return '<dt>' + LL[l] + '</dt><dd>' + dist[l] + ' records</dd>'; }).join('') + '</div>'; }
      else { var rows = recs.slice(0, 40); body = '<div class="tbl-scroll"><table class="tbl"><thead><tr><th>Employee</th><th>KPI</th><th class="num">Level</th></tr></thead><tbody>' + rows.map(function (r) { return '<tr><td>' + h((D.emps[r.employeeId] || {}).name) + '</td><td>' + h((D.kpis[r.kpiId] || {}).name) + '</td><td class="num">' + (r.highestLevel != null ? LS[r.highestLevel] : '—') + '</td></tr>'; }).join('') + '</tbody></table></div>'; }
      App.Modal({ title: title + ' report', wide: true, body: '<div class="muted" style="margin-bottom:10px">Live data · ' + (D.period() || {}).name + '</div>' + body, foot: '<button class="btn" data-ovclose="x">Close</button><button class="btn primary" id="rep-exp">' + icon('download') + 'Export CSV</button>',
        mount: function (root) { App.$('#rep-exp', root).addEventListener('click', function () { exportCsv('performance'); }); } });
    });
  }
  function openDistDrill(level) {
    DB.by('performance', 'periodId', App.S.period).then(function (recs) {
      var hits = recs.filter(function (r) { return r.highestLevel === level; });
      var body = hits.length ? hits.map(function (r) { return '<div class="drow click" data-emp="' + r.employeeId + '"><div class="dn"><b>' + h((D.emps[r.employeeId] || {}).name) + '</b><span>' + h((D.kpis[r.kpiId] || {}).name) + '</span></div>' + levelPill(level) + '</div>'; }).join('') : App.emptyState({ title: 'None at this level', msg: '' });
      App.Drawer({ title: LL[level] + ' — ' + hits.length + ' records', sub: (D.period() || {}).name, body: body });
    });
  }
  function exportCsv(kind) {
    var storeMap = { employees: 'employees', performance: 'performance' };
    DB.all(storeMap[kind] || 'performance').then(function (rows) {
      if (!rows.length) return App.toast('Nothing to export', 'bad');
      var cols = Object.keys(rows[0]).filter(function (k) { return typeof rows[0][k] !== 'object'; });
      var csv = cols.join(',') + '\n' + rows.map(function (r) { return cols.map(function (c) { return JSON.stringify(r[c] == null ? '' : r[c]); }).join(','); }).join('\n');
      try {
        var blob = new Blob([csv], { type: 'text/csv' }), a = document.createElement('a');
        a.href = URL.createObjectURL(blob); a.download = kind + '_' + App.S.period + '.csv'; a.click();
        App.toast('Exported ' + rows.length + ' rows', 'good');
      } catch (e) { App.toast('Export blocked in this view — data is available via the report preview.', 'bad'); }
    });
  }
})();
