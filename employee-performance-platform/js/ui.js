/* ============================================================================
 * UI — application framework: state, session/RBAC, router, shell, shared
 * components, and the TargetProgress component (the product's core visual).
 * Pages register themselves on App.pages and are pure render functions that ask
 * the domain/data layers for results; no business logic lives here.
 * ========================================================================== */
window.App = (function () {
  'use strict';
  var S = { user: null, users: [], period: null, periods: [], route: 'directory', params: {}, collapsed: false, mobileOpen: false, notifOpen: false };
  var pages = {};

  /* ---- tiny DOM helpers ---- */
  function h(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return [].slice.call((root || document).querySelectorAll(sel)); }
  function initials(n) { return (n || '?').split(/\s+/).slice(0, 2).map(function (w) { return w[0]; }).join('').toUpperCase(); }

  /* ---- data cache (small dimension tables kept in memory; facts read on demand) ---- */
  var Data = {
    types: {}, units: {}, teams: {}, emps: {}, kras: {}, kpis: {}, periodsById: {}, settings: {},
    load: function () {
      return Promise.all(['org_types', 'org_units', 'teams', 'employees', 'kras', 'kpis', 'periods', 'settings'].map(function (s) { return DB.all(s); }))
        .then(function (r) {
          Data.types = idx(r[0]); Data.units = idx(r[1]); Data.teams = idx(r[2]); Data.emps = idx(r[3]);
          Data.kras = idx(r[4]); Data.kpis = idx(r[5]); Data.periodsById = idx(r[6]);
          r[7].forEach(function (s) { Data.settings[s.key] = s.value; });
          S.periods = r[6].filter(function (p) { return p.kind === 'month'; }).sort(function (a, b) { return a.sort - b.sort; });
          S.period = Data.settings.currentPeriod || (S.periods[4] && S.periods[4].id);
          return DB.get('meta', 'users');
        }).then(function (m) { S.users = (m && m.value) || []; });
    },
    emp: function (id) { return Data.emps[id]; },
    unitOf: function (e) { return e && Data.units[e.orgUnitId]; },
    teamOf: function (e) { return e && Data.teams[e.teamId]; },
    typeOf: function (e) { return e && Data.types[e.orgTypeId]; },
    period: function (id) { return Data.periodsById[id || S.period]; },
    membersOf: function (teamId) { return Object.values(Data.emps).filter(function (e) { return e.teamId === teamId; }); },
    empsInUnit: function (unitId) { return Object.values(Data.emps).filter(function (e) { return e.orgUnitId === unitId; }); }
  };
  function idx(a) { var o = {}; a.forEach(function (x) { o[x.id] = x; }); return o; }
  App_Data = Data;

  /* ---- session / RBAC ---- */
  function currentEmployee() { return S.user && S.user.employeeId ? Data.emps[S.user.employeeId] : null; }
  function can(action) { return Domain.can(S.user, action); }
  function canScopeEmp(emp) { return Domain.canScope(S.user, emp, Data.emps); }

  /* ---- toast ---- */
  function toast(msg, kind) {
    var wrap = $('#toasts') || (function () { var w = document.createElement('div'); w.id = 'toasts'; w.className = 'toasts'; document.body.appendChild(w); return w; })();
    var t = document.createElement('div'); t.className = 'toast ' + (kind || ''); t.innerHTML = '<span class="tc"></span>' + h(msg);
    wrap.appendChild(t); setTimeout(function () { t.style.opacity = '0'; t.style.transform = 'translateY(6px)'; t.style.transition = '.3s'; setTimeout(function () { t.remove(); }, 320); }, 2600);
  }

  /* ===================== TargetProgress (spec §85) ===================== */
  var TP = {
    _fill: function (level) { return level >= 1 ? (level - 1) / 4 * 100 : 0; },
    full: function (o) {
      var t = o.t || [], lvl = o.level, mt = o.measurementType, unit = o.unit;
      var cls = 'tp' + (lvl ? ' l' + lvl : '');
      var nodes = '';
      for (var i = 1; i <= 5; i++) {
        var st = lvl != null && i <= lvl ? 'done' : '', cur = lvl != null && i === lvl ? 'cur' : '';
        nodes += '<div class="tp-node ' + st + ' ' + cur + '">' +
          (cur ? '<div class="tp-marker"><b>' + Domain.LEVEL_SHORT[lvl] + '</b><span class="tri"></span></div>' : '') +
          '<div class="tp-dot">' + (st ? '✓' : i) + '</div>' +
          '<div class="tp-lab">T' + i + '</div>' +
          '<div class="tp-val">' + h(Domain.fmtValue(t[i - 1], mt, unit)) + '</div></div>';
      }
      var foot = o.hideFoot ? '' : '<div class="tp-foot">' +
        '<span class="tp-level">' + (lvl != null ? Domain.LEVEL_LABELS[lvl] : 'Pending') + '</span>' +
        (o.actual != null ? '<span class="tp-actual">Actual <b>' + h(Domain.fmtValue(o.actual, mt, unit)) + '</b></span>' : '') +
        (o.pct != null ? '<span class="tp-pct">' + o.pct + '%</span>' : '') + '</div>';
      return '<div class="' + cls + ' tp-full"><div class="tp-track"><div class="tp-line"><i style="width:' + TP._fill(lvl) + '%"></i></div>' + nodes + '</div>' + foot + '</div>';
    },
    hero: function (o) {
      var lvl = o.level, cls = 'tp' + (lvl ? ' l' + lvl : '');
      var nodes = '';
      for (var i = 1; i <= 5; i++) {
        var st = lvl != null && i <= lvl ? 'done' : '', cur = lvl != null && i === lvl ? 'cur' : '';
        nodes += '<div class="tp-node ' + st + ' ' + cur + '">' + (cur ? '<div class="tp-marker"><b>Current</b><span class="tri"></span></div>' : '') +
          '<div class="tp-dot">' + (st ? '✓' : i) + '</div><div class="tp-lab">T' + i + '</div></div>';
      }
      return '<div class="' + cls + ' tp-hero"><div class="cap">' + h(o.cap || 'Overall Level') + '</div>' +
        '<div class="tp-track" style="margin-top:30px"><div class="tp-line"><i style="width:' + TP._fill(lvl) + '%"></i></div>' + nodes + '</div>' +
        '<div class="tp-foot"><span class="tp-level" style="font-size:20px">' + (lvl != null ? Domain.LEVEL_LABELS[lvl] : 'Pending Data') + '</span>' +
        (o.score != null ? '<span class="tp-pct">weighted score ' + o.score + ' / 5</span>' : '') + '</div></div>';
    },
    ticks: function (level) {
      var cls = 'tp' + (level ? ' l' + level : ''), out = '<span class="' + cls + ' tp-ticks">';
      for (var i = 1; i <= 5; i++) { var st = level != null && i <= level ? 'done' : '', cur = level != null && i === level ? 'cur' : ''; out += '<span class="tp-tick ' + st + ' ' + cur + '">' + (st ? '✓' : i) + '</span>'; }
      return out + '</span>';
    },
    pill: function (level) {
      if (level == null) return '<span class="lvl-pill none">Pending</span>';
      return '<span class="tp l' + level + '"><span class="lvl-pill">' + Domain.LEVEL_SHORT[level] + '</span></span>';
    }
  };

  /* ===================== shared components ===================== */
  function statusBadge(status) {
    var map = { 'On Track': 'good', 'Exceeded': 'good', 'Completed': 'good', 'Approved': 'good', 'Published': 'good', 'Active': 'good',
      'At Risk': 'warn', 'Pending': 'warn', 'Submitted': 'warn', 'Draft': 'neutral', 'Below Target': 'warn',
      'Off Track': 'bad', 'Overdue': 'bad', 'Rejected': 'bad', 'Locked': 'neutral', 'Inactive': 'neutral', 'upcoming': 'neutral', 'open': 'good', 'locked': 'neutral' };
    var k = map[status] || 'neutral';
    return '<span class="badge ' + k + '"><span class="d"></span>' + h(status) + '</span>';
  }
  function person(e, sub) {
    if (!e) return '—';
    return '<div class="person"><div class="avatar">' + h(initials(e.name)) + '</div><div class="pn"><b>' + h(e.name) + '</b><span>' + h(sub != null ? sub : e.designation) + '</span></div></div>';
  }
  function emptyState(o) {
    return '<div class="state"><div class="ic">' + (o.icon || icon('inbox')) + '</div><h4>' + h(o.title) + '</h4><p>' + h(o.msg || '') + '</p>' + (o.action || '') + '</div>';
  }
  function loading() { var r = ''; for (var i = 0; i < 5; i++) r += '<div class="skel" style="height:44px;margin-bottom:8px"></div>'; return '<div class="card">' + r + '</div>'; }

  /* DataTable — sortable, paginated, row-click. cols: [{key,label,render(row),num,sortable,sortVal(row)}] */
  function Table(o) {
    var id = o.id || ('t' + Math.random().toString(36).slice(2, 7));
    Table._state = Table._state || {};
    var st = Table._state[id] || (Table._state[id] = { sort: o.sort || null, dir: o.dir || 'asc', page: 1 });
    var per = o.perPage || 12;
    var rows = o.rows.slice();
    if (st.sort) {
      var col = o.cols.filter(function (c) { return c.key === st.sort; })[0];
      if (col) rows.sort(function (a, b) { var va = col.sortVal ? col.sortVal(a) : a[col.key], vb = col.sortVal ? col.sortVal(b) : b[col.key];
        if (va == null) va = ''; if (vb == null) vb = ''; var r = typeof va === 'number' ? va - vb : String(va).localeCompare(String(vb)); return st.dir === 'asc' ? r : -r; });
    }
    var total = rows.length, pages = Math.max(1, Math.ceil(total / per));
    if (st.page > pages) st.page = pages;
    var pageRows = rows.slice((st.page - 1) * per, st.page * per);
    var thead = '<tr>' + o.cols.map(function (c) {
      return '<th class="' + (c.num ? 'num ' : '') + (c.sortable !== false ? 'sortable' : '') + '" ' + (c.sortable !== false ? 'data-tsort="' + id + '::' + c.key + '"' : '') + '>' + h(c.label) +
        (st.sort === c.key ? ' <span class="ar">' + (st.dir === 'asc' ? '▲' : '▼') + '</span>' : '') + '</th>';
    }).join('') + '</tr>';
    var tbody = pageRows.length ? pageRows.map(function (row) {
      return '<tr class="' + (o.onRow ? 'click' : '') + '"' + (o.rowAttr ? ' ' + o.rowAttr(row) : '') + '>' + o.cols.map(function (c) {
        return '<td class="' + (c.num ? 'num' : '') + '">' + (c.render ? c.render(row) : h(row[c.key])) + '</td>';
      }).join('') + '</tr>';
    }).join('') : '<tr><td colspan="' + o.cols.length + '">' + emptyState({ title: o.emptyTitle || 'No results', msg: o.emptyMsg || 'Nothing matches the current filters.' }) + '</td></tr>';
    var pager = '';
    if (pages > 1) { pager = '<div class="pager"><button data-tpage="' + id + '::' + (st.page - 1) + '" ' + (st.page === 1 ? 'disabled' : '') + '>‹</button>';
      for (var p = 1; p <= pages; p++) if (p === 1 || p === pages || Math.abs(p - st.page) <= 1) pager += '<button data-tpage="' + id + '::' + p + '" class="' + (p === st.page ? 'on' : '') + '">' + p + '</button>';
      pager += '<button data-tpage="' + id + '::' + (st.page + 1) + '" ' + (st.page === pages ? 'disabled' : '') + '>›</button></div>'; }
    return '<div class="tbl-wrap" data-table="' + id + '"><div class="tbl-scroll"><table class="tbl"><thead>' + thead + '</thead><tbody>' + tbody + '</tbody></table></div>' +
      '<div class="tbl-foot"><span>' + total + ' ' + (o.noun || 'rows') + '</span>' + pager + '</div></div>';
  }
  Table.rerender = null;

  /* Drawer + Modal overlay layer */
  var Overlay = {
    stack: [],
    _render: function () {
      var host = $('#overlays');
      if (!Overlay.stack.length) { host.innerHTML = ''; document.body.classList.remove('locked'); return; }
      document.body.classList.add('locked');
      host.innerHTML = Overlay.stack.map(function (o, i) {
        var scrim = '<div class="scrim" data-ovclose="' + i + '"></div>';
        if (o.kind === 'modal') return scrim + '<div class="modal ' + (o.wide ? 'wide' : '') + '" role="dialog" aria-modal="true"><div class="md-head"><div class="t">' + h(o.title) + '</div><button class="dw-close" data-ovclose="' + i + '">✕</button></div><div class="md-body">' + o.body + '</div>' + (o.foot ? '<div class="md-foot">' + o.foot + '</div>' : '') + '</div>';
        return scrim + '<div class="drawer ' + (o.wide ? 'wide' : '') + '" role="dialog" aria-modal="true"><div class="dw-head"><div style="min-width:0"><div class="t">' + h(o.title) + '</div>' + (o.sub ? '<div class="s">' + h(o.sub) + '</div>' : '') + '</div><button class="dw-close" data-ovclose="' + i + '">✕</button></div><div class="dw-body">' + o.body + '</div>' + (o.foot ? '<div class="dw-foot">' + o.foot + '</div>' : '') + '</div>';
      }).join('');
      if (Overlay.stack.length) { var top = Overlay.stack[Overlay.stack.length - 1]; if (top.mount) setTimeout(function () { top.mount($('#overlays')); }, 0); }
    },
    open: function (o) { Overlay.stack.push(o); Overlay._render(); },
    replace: function (o) { Overlay.stack[Overlay.stack.length - 1] = o; Overlay._render(); },
    close: function () { Overlay.stack.pop(); Overlay._render(); },
    closeAll: function () { Overlay.stack = []; Overlay._render(); }
  };
  function Drawer(o) { o.kind = 'drawer'; Overlay.open(o); }
  function Modal(o) { o.kind = 'modal'; Overlay.open(o); }

  /* ===================== icons ===================== */
  function icon(n) {
    var p = {
      directory: '<circle cx="9" cy="8" r="3.2"/><path d="M4 20a5 5 0 0 1 10 0"/><path d="M16 4.5a3 3 0 0 1 0 6M18 20a4.5 4.5 0 0 0-3-4.2"/>',
      org: '<rect x="9" y="3" width="6" height="5" rx="1"/><rect x="3" y="15" width="6" height="5" rx="1"/><rect x="15" y="15" width="6" height="5" rx="1"/><path d="M12 8v4M6 15v-2h12v2"/>',
      teams: '<circle cx="7" cy="8" r="2.4"/><circle cx="17" cy="8" r="2.4"/><path d="M3 19a4 4 0 0 1 8 0M13 19a4 4 0 0 1 8 0"/>',
      krakpi: '<path d="M4 6h16M4 12h16M4 18h10"/><circle cx="19" cy="18" r="2"/>',
      targets: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4"/><circle cx="12" cy="12" r="1" fill="currentColor" stroke="none"/>',
      perf: '<path d="M4 19V5"/><path d="M4 19h16"/><path d="M8 15l3-4 3 2 4-6"/>',
      reviews: '<path d="M4 5a2 2 0 0 1 2-2h9l5 5v11a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z"/><path d="M9 12l2 2 4-4"/>',
      leaderboard: '<path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0zM7 6H4v2a3 3 0 0 0 3 3M17 6h3v2a3 3 0 0 1-3 3"/>',
      reports: '<path d="M6 3h9l4 4v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/><path d="M9 13h6M9 17h6M9 9h2"/>',
      analytics: '<path d="M4 19V5"/><rect x="7" y="11" width="3" height="8"/><rect x="12" y="6" width="3" height="13"/><rect x="17" y="14" width="3" height="5"/>',
      notif: '<path d="M6 9a6 6 0 0 1 12 0c0 5 2 6 2 6H4s2-1 2-6z"/><path d="M10 20a2 2 0 0 0 4 0"/>',
      admin: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9L17 7M7 17l-2.1 2.1"/>',
      search: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4-4"/>', inbox: '<path d="M4 13h4l1 3h6l1-3h4"/><path d="M4 13V5a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v8"/>',
      menu: '<path d="M4 6h16M4 12h16M4 18h16"/>', chev: '<path d="M9 6l6 6-6 6"/>', plus: '<path d="M12 5v14M5 12h14"/>',
      download: '<path d="M12 3v12M7 11l5 5 5-5M5 21h14"/>', edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
      lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>'
    };
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">' + (p[n] || '') + '</svg>';
  }

  /* ===================== shell ===================== */
  var NAV = [
    { g: 'People', items: [['directory', 'Employee Directory', 'directory'], ['organization', 'Organization', 'org'], ['teams', 'Teams', 'teams']] },
    { g: 'Performance', items: [['kra-kpi', 'KRA / KPI', 'krakpi'], ['targets', 'Targets', 'targets'], ['performance', 'Performance', 'perf'], ['reviews', 'Reviews', 'reviews'], ['leaderboard', 'Leaderboard', 'leaderboard']] },
    { g: 'Analytics', items: [['reports', 'Reports', 'reports'], ['analytics', 'Performance Analytics', 'analytics']] },
    { g: 'System', items: [['notifications', 'Notifications', 'notif'], ['administration', 'Administration', 'admin']] }
  ];
  function renderShell() {
    document.body.innerHTML = '<div class="app" id="app"><aside class="sidebar" id="sidebar"></aside><div class="main"><header class="topbar" id="topbar"></header><main class="content" id="content"></main></div></div><div id="overlays"></div><div id="toasts" class="toasts"></div>';
    renderSidebar(); renderTopbar();
  }
  function renderSidebar() {
    var nav = NAV.map(function (grp) {
      return '<div class="sb-group"><div class="sb-glabel">' + h(grp.g) + '</div>' + grp.items.map(function (it) {
        var unread = it[0] === 'notifications' ? App._unread : 0;
        return '<a class="sb-item ' + (S.route === it[0] ? 'on' : '') + '" href="#/' + it[0] + '" title="' + h(it[1]) + '">' + icon(it[2]) + '<span>' + h(it[1]) + '</span>' + (unread ? '<span class="badge-n">' + unread + '</span>' : '') + '</a>';
      }).join('') + '</div>';
    }).join('');
    $('#sidebar').innerHTML = '<div class="sb-brand"><div class="sb-logo">P</div><div class="sb-name">PerformOS<small>Performance Platform</small></div></div><nav class="sb-nav">' + nav + '</nav>';
  }
  function renderTopbar() {
    var crumbs = (App._crumbs || [{ label: 'Home' }]);
    var cr = crumbs.map(function (c, i) {
      var last = i === crumbs.length - 1;
      return (i ? '<span class="sep">/</span>' : '') + (last ? '<span class="cur">' + h(c.label) + '</span>' : '<a href="' + (c.href || '#') + '">' + h(c.label) + '</a>');
    }).join('');
    var periodOpts = S.periods.map(function (p) { return '<option value="' + p.id + '"' + (p.id === S.period ? ' selected' : '') + '>' + h(p.name) + '</option>'; }).join('');
    var u = S.user || {};
    $('#topbar').innerHTML =
      '<button class="tb-collapse" data-collapse title="Toggle sidebar">' + icon('menu') + '</button>' +
      '<div class="crumbs">' + cr + '</div>' +
      '<div class="tb-search"><span>' + icon('search') + '</span><input id="gsearch" placeholder="Search employees, teams, KRAs…" autocomplete="off"><kbd>/</kbd><div id="gsr"></div></div>' +
      '<select class="tb-period" id="periodsel" title="Performance period">' + periodOpts + '</select>' +
      '<button class="tb-icon" data-notif title="Notifications">' + icon('notif') + (App._unread ? '<span class="dot"></span>' : '') + '</button>' +
      '<button class="tb-user" data-usermenu><div class="avatar sm">' + h(initials(u.name || 'U')) + '</div><div style="text-align:left"><div class="un">' + h(u.name || 'User') + '</div><div class="ur">' + h((Data.settings && '') + roleName(u.roleId)) + '</div></div></button>';
  }
  function roleName(id) { var r = { super_admin: 'Super Admin', hr_admin: 'HR / Admin', business_head: 'Business Head', team_leader: 'Team Leader', manager: 'Manager', employee: 'Employee', auditor: 'Auditor' }; return r[id] || id || ''; }

  /* ===================== router ===================== */
  function go(route) { location.hash = '#/' + route; }
  function setCrumbs(list) { App._crumbs = list; renderTopbar(); }
  function parseHash() {
    var hash = location.hash.replace(/^#\/?/, ''); var parts = hash.split('/');
    return { route: parts[0] || 'directory', params: parts.slice(1) };
  }
  function router() {
    var p = parseHash(); S.route = p.route; S.params = p.params;
    renderSidebar();
    var page = pages[p.route];
    var content = $('#content');
    if (!page) { content.innerHTML = emptyState({ title: 'Not found', msg: 'No page for “' + p.route + '”.' }); return; }
    content.innerHTML = loading();
    Promise.resolve().then(function () { return page.render(p.params); }).then(function (html) {
      content.innerHTML = html; content.scrollTop = 0;
      if (page.mount) page.mount(p.params);
    }).catch(function (e) { content.innerHTML = emptyState({ title: 'Something went wrong', msg: (e && e.message) || String(e) }); console.error(e); });
  }

  /* ===================== notifications + search + events ===================== */
  function refreshUnread() {
    return DB.all('notifications').then(function (ns) {
      var me = S.user && S.user.employeeId;
      App._notifs = ns.sort(function (a, b) { return String(b.createdAt).localeCompare(String(a.createdAt)); });
      App._unread = ns.filter(function (n) { return !n.read && (n.recipientId === 'all' || n.recipientId === me || S.user.roleId === 'super_admin' || S.user.roleId === 'hr_admin'); }).length;
      renderSidebar(); renderTopbar();
    });
  }
  function openNotifications() {
    var ns = (App._notifs || []).slice(0, 30);
    var body = ns.length ? ns.map(function (n) {
      return '<div class="drow click" data-notifopen="' + h(n.id) + '::' + h(n.entityType) + '::' + h(n.entityId) + '"><div class="dn"><b>' + h(n.title) + '</b><span>' + h(n.message) + '</span></div>' + (n.read ? '' : '<span class="badge accent">new</span>') + '</div>';
    }).join('') : emptyState({ title: 'No notifications', msg: 'You are all caught up.' });
    Drawer({ title: 'Notifications', sub: (App._unread || 0) + ' unread', body: body, foot: '<button class="btn" data-notifread>Mark all read</button>' });
  }
  function doGlobalSearch(q) {
    q = q.trim().toLowerCase(); var box = $('#gsr'); if (!box) return;
    if (q.length < 1) { box.innerHTML = ''; return; }
    var emps = Object.values(Data.emps).filter(function (e) { return e.name.toLowerCase().indexOf(q) >= 0 || e.id.toLowerCase().indexOf(q) >= 0 || (e.designation || '').toLowerCase().indexOf(q) >= 0; }).slice(0, 6);
    var teams = Object.values(Data.teams).filter(function (t) { return t.name.toLowerCase().indexOf(q) >= 0; }).slice(0, 4);
    var units = Object.values(Data.units).filter(function (u) { return u.name.toLowerCase().indexOf(q) >= 0 || u.code.toLowerCase().indexOf(q) >= 0; }).slice(0, 4);
    var kras = Object.values(Data.kras).filter(function (k) { return k.name.toLowerCase().indexOf(q) >= 0; }).slice(0, 3);
    var kpis = Object.values(Data.kpis).filter(function (k) { return k.name.toLowerCase().indexOf(q) >= 0; }).slice(0, 3);
    var out = '';
    if (emps.length) out += '<div class="grp">Employees</div>' + emps.map(function (e) { return '<div class="r" data-gsnav="emp::' + e.id + '"><div class="avatar sm">' + h(initials(e.name)) + '</div><div><b>' + h(e.name) + '</b> <span>' + h(e.id) + ' · ' + h((Data.teamOf(e) || {}).name || 'Leadership') + '</span></div></div>'; }).join('');
    if (teams.length) out += '<div class="grp">Teams</div>' + teams.map(function (t) { return '<div class="r" data-gsnav="team::' + t.id + '"><b>' + h(t.name) + '</b> <span>' + h((Data.units[t.orgUnitId] || {}).name || '') + '</span></div>'; }).join('');
    if (units.length) out += '<div class="grp">Organisation Units</div>' + units.map(function (u) { return '<div class="r" data-gsnav="unit::' + u.id + '"><b>' + h(u.name) + '</b> <span>' + h(u.code) + '</span></div>'; }).join('');
    if (kras.length) out += '<div class="grp">KRAs</div>' + kras.map(function (k) { return '<div class="r" data-gsnav="kra::' + k.id + '"><b>' + h(k.name) + '</b></div>'; }).join('');
    if (kpis.length) out += '<div class="grp">KPIs</div>' + kpis.map(function (k) { return '<div class="r" data-gsnav="kpi::' + k.id + '"><b>' + h(k.name) + '</b></div>'; }).join('');
    box.innerHTML = out || '<div class="grp">No matches</div>';
  }

  function bindEvents() {
    window.addEventListener('hashchange', router);
    document.addEventListener('click', function (e) {
      var t = e.target;
      var c = t.closest('[data-collapse]'); if (c) { if (window.innerWidth <= 860) { $('#app').classList.toggle('mobile-open'); } else { $('#app').classList.toggle('collapsed'); } return; }
      var nf = t.closest('[data-notif]'); if (nf) { openNotifications(); return; }
      var ov = t.closest('[data-ovclose]'); if (ov) { Overlay.close(); return; }
      var um = t.closest('[data-usermenu]'); if (um) { openUserMenu(); return; }
      var ts = t.closest('[data-tsort]'); if (ts) { var kv = ts.dataset.tsort.split('::'), st = Table._state[kv[0]]; if (st) { if (st.sort === kv[1]) st.dir = st.dir === 'asc' ? 'desc' : 'asc'; else { st.sort = kv[1]; st.dir = 'asc'; } if (App._rerender) App._rerender(); } return; }
      var tp = t.closest('[data-tpage]'); if (tp) { var pv = tp.dataset.tpage.split('::'), st2 = Table._state[pv[0]]; if (st2) { st2.page = +pv[1]; if (App._rerender) App._rerender(); } return; }
      var gs = t.closest('[data-gsnav]'); if (gs) { var g = gs.dataset.gsnav.split('::'); $('#gsr').innerHTML = ''; $('#gsearch').value = ''; App.navTo(g[0], g[1]); return; }
      var no = t.closest('[data-notifopen]'); if (no) { var n = no.dataset.notifopen.split('::'); DB.get('notifications', n[0]).then(function (rec) { if (rec) { rec.read = 1; DB.put('notifications', rec, { skipFk: true }).then(refreshUnread); } }); if (n[1] && n[2]) App.navTo(n[1] === 'employee' ? 'emp' : n[1], n[2]); Overlay.close(); return; }
      var nr = t.closest('[data-notifread]'); if (nr) { Promise.all((App._notifs || []).map(function (x) { x.read = 1; return DB.put('notifications', x, { skipFk: true }); })).then(refreshUnread).then(function () { Overlay.close(); }); return; }
      // let pages handle their own [data-*] via App.onClick hooks
      if (App._onClick) App._onClick(e);
    });
    document.addEventListener('input', function (e) { if (e.target.id === 'gsearch') doGlobalSearch(e.target.value); if (App._onInput) App._onInput(e); });
    document.addEventListener('change', function (e) {
      if (e.target.id === 'periodsel') { S.period = e.target.value; router(); }
      if (App._onChange) App._onChange(e);
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { if (Overlay.stack.length) Overlay.close(); }
      if (e.key === '/' && document.activeElement.tagName !== 'INPUT' && document.activeElement.tagName !== 'TEXTAREA') { e.preventDefault(); var s = $('#gsearch'); if (s) s.focus(); }
    });
    document.addEventListener('click', function (e) { if (!e.target.closest('.tb-search')) { var b = $('#gsr'); if (b) b.innerHTML = ''; } });
  }

  function openUserMenu() {
    var body = '<div class="field"><label>View the product as</label><select class="select" id="roleswitch">' +
      S.users.map(function (u) { return '<option value="' + u.id + '"' + (S.user && u.id === S.user.id ? ' selected' : '') + '>' + h(u.name) + ' — ' + roleName(u.roleId) + '</option>'; }).join('') + '</select>' +
      '<p class="help" style="margin-top:6px">Permissions are enforced by the data layer, not just the UI. Switch to see scoped views.</p></div>';
    Modal({ title: 'Session', body: body, foot: '<button class="btn" data-ovclose="x">Close</button><button class="btn primary" id="applyrole">Switch</button>',
      mount: function (root) {
        $('#applyrole', root).addEventListener('click', function () { var id = $('#roleswitch', root).value; S.user = S.users.filter(function (u) { return u.id === id; })[0]; Overlay.close(); refreshUnread(); renderTopbar(); router(); toast('Now viewing as ' + S.user.name + ' (' + roleName(S.user.roleId) + ')'); });
      } });
  }

  /* navigate helper used by search / notifications / cross-links (spec §98) */
  function navTo(kind, id) {
    if (kind === 'emp') { go('directory'); setTimeout(function () { App.pages.directory && App.openEmployee && App.openEmployee(id); }, 30); }
    else if (kind === 'team') { go('teams'); setTimeout(function () { App.openTeam && App.openTeam(id); }, 30); }
    else if (kind === 'unit') { go('organization'); setTimeout(function () { App.openUnit && App.openUnit(id); }, 30); }
    else if (kind === 'kra') { go('kra-kpi'); setTimeout(function () { App.openKra && App.openKra(id); }, 30); }
    else if (kind === 'kpi') { go('kra-kpi'); setTimeout(function () { App.openKpi && App.openKpi(id, null); }, 30); }
  }

  /* ===================== boot ===================== */
  function boot() {
    DB.open().then(function () { return Seed.ensure(); }).then(function () { return Data.load(); }).then(function () {
      S.user = S.users.filter(function (u) { return u.roleId === 'super_admin'; })[0] || S.users[0];
      renderShell(); bindEvents(); return refreshUnread();
    }).then(function () {
      if (!location.hash) location.hash = '#/directory';
      router();
    }).catch(function (e) { document.body.innerHTML = '<div style="padding:40px;font-family:system-ui"><h2>Failed to start</h2><pre>' + h((e && e.stack) || e) + '</pre></div>'; console.error(e); });
  }

  return {
    S: S, pages: pages, Data: Data, TP: TP, Table: Table, Drawer: Drawer, Modal: Modal, Overlay: Overlay,
    h: h, $: $, $$: $$, icon: icon, initials: initials, toast: toast, statusBadge: statusBadge, person: person,
    emptyState: emptyState, loading: loading, go: go, setCrumbs: setCrumbs, router: router, roleName: roleName,
    can: can, canScopeEmp: canScopeEmp, currentEmployee: currentEmployee, refreshUnread: refreshUnread, navTo: navTo,
    registerPage: function (name, def) { pages[name] = def; }, boot: boot,
    _crumbs: null, _unread: 0, _notifs: [], _onClick: null, _onInput: null, _onChange: null, _rerender: null
  };
})();
var App_Data;
