/* ============================================================================
 * DOMAIN — the performance business logic. Pure calculation functions plus
 * DB-backed services. No view code imports the other way: components ask this
 * layer for results; this layer never touches the DOM. The target-level engine
 * is the heart of the product (spec §67) and is fully reproducible from stored
 * targets + actuals, so the same input always yields the same level and score.
 * ========================================================================== */
window.Domain = (function () {
  'use strict';

  var LEVEL_LABELS = { 0: 'Below T1', 1: 'Target 1', 2: 'Target 2', 3: 'Target 3', 4: 'Target 4', 5: 'Target 5' };
  var LEVEL_SHORT = { 0: '—', 1: 'T1', 2: 'T2', 3: 'T3', 4: 'T4', 5: 'T5' };

  /* ---- core: which Target level did an actual reach? (spec §13, §14) --------
   * targets = [t1,t2,t3,t4,t5]; returns the highest CONSECUTIVE level cleared
   * from T1, the per-level achieved flags, and a supporting percentage. Never
   * assumes higher-is-better — the KPI's direction drives the comparison. */
  function levelFor(targets, actual, direction) {
    var t = (targets || []).map(function (x) { return x == null || x === '' ? null : Number(x); });
    if (actual == null || actual === '' || isNaN(Number(actual))) {
      return { level: null, achieved: [false, false, false, false, false], pct: null, status: 'Pending' };
    }
    var a = Number(actual), dir = direction || 'higher_is_better';
    var achieved = [false, false, false, false, false], level = 0;

    if (dir === 'lower_is_better') {
      for (var i = 0; i < 5; i++) achieved[i] = t[i] != null && a <= t[i];
    } else if (dir === 'range') {
      /* t1 = min acceptable, t5 = max acceptable, t3 = ideal. Outside [t1,t5] is
       * below target; inside, closeness to the ideal raises the level. */
      var lo = t[0], hi = t[4], mid = t[2];
      if (lo != null && hi != null && a >= lo && a <= hi) {
        var half = Math.max(Math.abs(mid - lo), Math.abs(hi - mid)) || 1;
        var closeness = 1 - Math.abs(a - mid) / half;              // 1 at ideal, 0 at edge
        var rlevel = Math.max(1, Math.min(5, Math.round(1 + closeness * 4)));
        for (var r = 0; r < rlevel; r++) achieved[r] = true;
      }
    } else { /* higher_is_better (also exact/threshold) */
      for (var h = 0; h < 5; h++) achieved[h] = t[h] != null && a >= t[h];
    }
    for (var k = 0; k < 5; k++) { if (achieved[k]) level = k + 1; else break; }

    /* supporting percentage against the top target, direction-aware, capped */
    var pct = null, top = t[4] != null ? t[4] : t[2];
    if (top != null && top !== 0) {
      pct = dir === 'lower_is_better' ? (a === 0 ? 100 : top / a * 100) : a / top * 100;
      pct = Math.round(Math.min(pct, 999) * 10) / 10;
    }
    var status = level >= 4 ? 'On Track' : level >= 2 ? 'At Risk' : level >= 1 ? 'Below Target' : 'Off Track';
    return { level: level, achieved: achieved, pct: pct, status: status };
  }

  /* ---- aggregation (spec §16, §17): weighted mean of levels -> overall level.
   * Keeps the components so the result can always be explained, never a black box. */
  function aggregate(items) {
    var comps = items.filter(function (it) { return it.level != null && Number(it.weight) > 0; });
    if (!comps.length) return { level: null, score: null, components: [] };
    var wsum = 0, acc = 0;
    comps.forEach(function (it) { var w = Number(it.weight) || 0; wsum += w; acc += it.level * w; });
    var score = wsum > 0 ? acc / wsum : 0;
    return { level: Math.max(1, Math.min(5, Math.round(score))), score: Math.round(score * 100) / 100,
             components: comps.map(function (it) { return { ref: it.ref, level: it.level, weight: it.weight }; }) };
  }

  /* ---- value formatting by measurement type (₹ in lakhs/crore for the demo) -- */
  function fmtValue(v, measurementType, unit) {
    if (v == null || v === '') return '—';
    var n = Number(v); if (isNaN(n)) return String(v);
    switch (measurementType) {
      case 'currency':
        if (Math.abs(n) >= 100) return '₹' + trim(n / 100) + ' Cr';        // value stored in lakhs
        return '₹' + trim(n) + ' L';
      case 'percentage': return trim(n) + '%';
      case 'time': return trim(n) + ' ' + (unit || 'days');
      case 'ratio': return trim(n) + (unit ? ' ' + unit : '');
      case 'rating': return trim(n) + ' / 5';
      case 'count': case 'quantity': case 'number': return trim(n) + (unit ? ' ' + unit : '');
      case 'boolean': return n ? 'Yes' : 'No';
      default: return trim(n) + (unit ? ' ' + unit : '');
    }
  }
  function trim(n) { var r = Math.round(n * 100) / 100; return (r % 1 === 0) ? String(r) : String(r); }

  /* ---- audit + notifications (spec §69, §55) -------------------------------- */
  function uid(p) { return (p || 'id') + '-' + Date.now().toString(36) + '-' + Math.floor(Math.random() * 1e6).toString(36); }
  function nowIso() { return new Date().toISOString(); }

  function audit(actorId, entityType, entityId, action, oldValue, newValue, reason) {
    return DB.put('audit', { id: uid('aud'), actorId: actorId || 'system', entityType: entityType, entityId: String(entityId),
      action: action, oldValue: oldValue == null ? '' : JSON.stringify(oldValue), newValue: newValue == null ? '' : JSON.stringify(newValue),
      reason: reason || '', ts: nowIso() }, { skipFk: true });
  }
  function notify(recipientId, type, title, message, entity) {
    return DB.put('notifications', { id: uid('ntf'), recipientId: recipientId || 'all', type: type, title: title, message: message,
      entityType: (entity && entity.type) || '', entityId: (entity && entity.id) || '', read: 0, createdAt: nowIso() }, { skipFk: true });
  }

  /* ---- RBAC (spec §57): permissions enforced here, not just hidden in the UI - */
  var ROLE_PERMS = {
    super_admin: ['*'],
    hr_admin: ['view', 'create', 'edit', 'delete', 'approve', 'publish', 'export', 'lock', 'admin'],
    business_head: ['view', 'create', 'edit', 'approve', 'publish', 'export'],
    team_leader: ['view', 'create', 'edit', 'approve', 'export'],
    manager: ['view', 'create', 'edit', 'export'],
    employee: ['view', 'edit_own'],
    auditor: ['view', 'export']
  };
  function can(user, action) {
    if (!user) return false;
    var perms = ROLE_PERMS[user.roleId] || [];
    return perms.indexOf('*') >= 0 || perms.indexOf(action) >= 0;
  }
  /* scope: can this user act on this employee's data? */
  function canScope(user, targetEmployee, employeesById) {
    if (!user) return false;
    if (can(user, 'admin') || user.roleId === 'super_admin' || user.roleId === 'hr_admin' || user.roleId === 'business_head') return true;
    if (!user.employeeId || !targetEmployee) return false;
    if (user.employeeId === targetEmployee.id) return true;                    // own
    // manager / team leader: anyone reporting up the chain to me
    var e = targetEmployee, guard = 0;
    while (e && guard++ < 30) { if (e.managerId === user.employeeId) return true; e = employeesById[e.managerId]; }
    return false;
  }

  /* ========================================================================
   * SERVICES — DB-backed. Load, compute, persist, emit events. The single
   * entry point recompute() rebuilds every derived value for an employee in a
   * period from targets + actuals, so leaderboard and analytics (which read
   * performance records) are always consistent with the raw data.
   * ====================================================================== */

  /* Recompute one employee's period: for each performance record compute its
   * KPI level from its targets+actual, roll up per KRA, and compute the overall
   * employee level. Persists the computed fields back onto the records + writes
   * an overall snapshot into meta. Returns the computed summary. */
  function recompute(employeeId, periodId, actorId) {
    return Promise.all([
      DB.by('performance', 'empPeriod', employeeId + '|' + periodId),
      DB.get('employees', employeeId),
      DB.all('kpis'), DB.all('kras')
    ]).then(function (r) {
      var recs = r[0], emp = r[1], kpis = r[2], kras = r[3];
      var kpiById = index(kpis), kraById = index(kras);
      var writes = [];
      var kpiResults = [];   // {ref, level, weight, kraId}
      recs.forEach(function (rec) {
        var kpi = kpiById[rec.kpiId] || {};
        var res = levelFor([rec.t1, rec.t2, rec.t3, rec.t4, rec.t5], rec.actual, rec.direction || kpi.direction);
        rec.highestLevel = res.level;
        rec.levelsAchieved = res.achieved;
        rec.pct = res.pct;
        rec.score = res.level;
        rec.computedAt = nowIso();
        writes.push(DB.put('performance', rec, { skipFk: true }));
        if (res.level != null) kpiResults.push({ ref: rec.kpiId, level: res.level, weight: Number(kpi.weight) || Number(rec.weight) || 1, kraId: rec.kraId });
      });
      // KRA rollups
      var byKra = {};
      kpiResults.forEach(function (k) { (byKra[k.kraId] = byKra[k.kraId] || []).push(k); });
      var kraResults = Object.keys(byKra).map(function (kraId) {
        var agg = aggregate(byKra[kraId]);
        return { ref: kraId, level: agg.level, weight: Number((kraById[kraId] || {}).weight) || 1, score: agg.score };
      });
      // overall (weighted by KRA weight over KRA levels; equivalent explainable form)
      var overall = aggregate(kraResults.map(function (k) { return { ref: k.ref, level: k.level, weight: k.weight }; }));
      var summary = { employeeId: employeeId, periodId: periodId, overallLevel: overall.level, overallScore: overall.score,
        kraResults: kraResults, kpiCount: kpiResults.length, computedAt: nowIso() };
      writes.push(DB.put('meta', { key: 'overall|' + employeeId + '|' + periodId, value: summary }, { skipFk: true }));
      return Promise.all(writes).then(function () { return summary; });
    });
  }

  function overallFor(employeeId, periodId) {
    return DB.get('meta', 'overall|' + employeeId + '|' + periodId).then(function (m) { return m ? m.value : null; });
  }

  /* Leaderboard derived from performance records (spec §46–§51, §68): never a
   * stored rank — always reproducible. Ranking is deterministic: overall score,
   * then T5 hits, then T4+ hits, then name. */
  function leaderboard(periodId) {
    return Promise.all([DB.by('performance', 'periodId', periodId), DB.all('employees'), DB.all('meta')]).then(function (r) {
      var recs = r[0], emps = r[1], metas = r[2];
      var overallByEmp = {};
      metas.forEach(function (m) { if (m.key.indexOf('overall|') === 0) { var v = m.value; if (v.periodId === periodId) overallByEmp[v.employeeId] = v; } });
      var byEmp = {};
      recs.forEach(function (rec) {
        var e = byEmp[rec.employeeId] || (byEmp[rec.employeeId] = { t5: 0, t4plus: 0, eligible: 0, levelsum: 0, scored: 0 });
        e.eligible++;
        if (rec.highestLevel != null) { e.scored++; e.levelsum += rec.highestLevel; if (rec.highestLevel === 5) e.t5++; if (rec.highestLevel >= 4) e.t4plus++; }
      });
      var rows = emps.filter(function (e) { return byEmp[e.id]; }).map(function (e) {
        var s = byEmp[e.id], ov = overallByEmp[e.id];
        return { employee: e, overallLevel: ov ? ov.overallLevel : (s.scored ? Math.round(s.levelsum / s.scored) : null),
          overallScore: ov ? ov.overallScore : (s.scored ? Math.round(s.levelsum / s.scored * 100) / 100 : null),
          t5: s.t5, t4plus: s.t4plus, eligible: s.eligible, t5rate: s.eligible ? Math.round(s.t5 / s.eligible * 100) : 0 };
      });
      rows.sort(function (a, b) {
        return (b.overallScore || 0) - (a.overallScore || 0) || b.t5 - a.t5 || b.t4plus - a.t4plus || a.employee.name.localeCompare(b.employee.name);
      });
      rows.forEach(function (row, i) { row.rank = i + 1; });
      return rows;
    });
  }

  /* Analytics: level distribution + rates from real records (spec §53). */
  function analytics(periodId) {
    return DB.by('performance', 'periodId', periodId).then(function (recs) {
      var dist = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }, scored = 0;
      recs.forEach(function (rec) { if (rec.highestLevel != null) { dist[rec.highestLevel]++; scored++; } });
      return { total: recs.length, scored: dist, count: scored,
        t5rate: scored ? Math.round(dist[5] / scored * 100) : 0,
        t4plus: scored ? Math.round((dist[4] + dist[5]) / scored * 100) : 0 };
    });
  }

  function index(arr) { var o = {}; arr.forEach(function (x) { o[x.id] = x; }); return o; }

  return {
    LEVEL_LABELS: LEVEL_LABELS, LEVEL_SHORT: LEVEL_SHORT,
    levelFor: levelFor, aggregate: aggregate, fmtValue: fmtValue,
    audit: audit, notify: notify, can: can, canScope: canScope, ROLE_PERMS: ROLE_PERMS,
    recompute: recompute, overallFor: overallFor, leaderboard: leaderboard, analytics: analytics,
    uid: uid, nowIso: nowIso, index: index
  };
})();
