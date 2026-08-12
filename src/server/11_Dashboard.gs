/**
 * 11_Dashboard.gs — Executive dashboard, trends, forecasts and alerts.
 *
 * The dashboard answers the four questions leadership actually asks, in order:
 *   What has been achieved?   → headline tiles with target, actual, pace
 *   What is pending?          → gap and required run rate
 *   Who owns it?              → region and POC breakdown, ranked
 *   Why, and what next?       → alerts with the blocking reason and an owner
 *
 * Every tile carries a `drill` payload so the UI can open the underlying
 * operational records without another round of guessing.
 */

var Dashboard = (function () {

  /** The six headline measures on the executive view. */
  var HEADLINE = [
    { key: 'GMV_CR', label: 'GMV', unit: 'CR', planField: 'gmvTargetCr', primary: true },
    { key: 'TONNAGE_MT', label: 'Tonnage', unit: 'MT', planField: 'tonnageTargetMT' },
    { key: 'TXN_COUNT', label: 'Transactions', unit: 'COUNT', planField: 'txnTarget' },
    { key: 'SELLER_ONBOARDED', label: 'Sellers Onboarded', unit: 'COUNT', target: 'BALANCE_PLUS_MTD' },
    { key: 'PULSE_VISITS', label: 'Pulse Visits', unit: 'COUNT', target: 'PULSE' },
    { key: 'ONBOARDED_VS_TXN', label: 'Accounts Transacting', unit: 'COUNT', target: 'ONBOARDED_BASE' }
  ];

  function executive(cycleIdValue, asOfValue, options) {
    Auth.require(PERM.DASHBOARD_VIEW);
    options = options || {};
    var ctx = Reports.context(cycleIdValue, asOfValue);
    var sc = Auth.scope();
    var stream = options.stream || STREAM.SUPPLY;

    // A POC's dashboard is scoped to their own book automatically; a Regional
    // Head's to their region. Explicit filters still apply on top.
    var scopedRegion = (sc.level === 'REGION' && sc.regionIds && sc.regionIds.length)
      ? sc.regionIds[0] : null;
    var baseScope = {
      category: ctx.cycle.category, stream: stream,
      regionId: options.regionId || scopedRegion,
      pocUserId: options.pocUserId || (sc.level === 'SELF' ? sc.user.userId : null),
      materialType: options.materialType || null
    };
    var engineScope = Engine.scope(baseScope);

    var tiles = HEADLINE.map(function (h) {
      var actual = Engine.metric(h.key, ctx.windows.mtd, engineScope, { trace: false });
      var lmtd = Engine.metric(h.key, ctx.windows.lmtd, engineScope, { trace: false });
      var targetValue = headlineTarget_(ctx, engineScope, h);
      var evaluation = Engine.evaluate({
        target: targetValue, actual: actual.value, lmtd: lmtd.value, weightage: 0,
        direction: DIRECTION.HIGHER_BETTER,
        elapsedDays: ctx.elapsedDays, remainingDays: ctx.remainingDays
      });
      return {
        metricKey: h.key, label: h.label, unit: h.unit, primary: !!h.primary,
        target: Util.round(evaluation.target, 6),
        actual: Util.round(evaluation.actual, 6),
        gap: Util.round(evaluation.gap, 6),
        achievement: evaluation.achievement,
        lmtd: Util.round(evaluation.lmtd, 6),
        growthPct: evaluation.growthPct,
        currentDrr: Util.round(evaluation.currentDrr, 6),
        requiredDrr: Util.round(evaluation.requiredDrr, 6),
        paceStatus: evaluation.paceStatus,
        tone: evaluation.tone,
        projected: Util.round(evaluation.projected, 6),
        projectedAchievement: evaluation.projectedAchievement,
        drill: {
          metricKey: h.key, cycleId: ctx.cycle.cycleId, stream: stream,
          regionId: baseScope.regionId, pocUserId: baseScope.pocUserId
        }
      };
    });

    return {
      cycle: {
        cycleId: ctx.cycle.cycleId, label: ctx.cycle.label,
        status: ctx.cycle.status, category: ctx.cycle.category,
        year: ctx.cycle.year, month: ctx.cycle.month
      },
      stream: stream,
      asOf: DateUtil.isoDate(ctx.asOf),
      asOfLabel: 'As Of ' + DateUtil.display(ctx.asOf),
      progress: {
        elapsedDays: ctx.elapsedDays,
        remainingDays: ctx.remainingDays,
        daysInMonth: ctx.daysInMonth,
        monthProgressPct: Util.div(ctx.elapsedDays, ctx.daysInMonth, 0)
      },
      tiles: tiles,
      scopeLabel: scopeLabel_(ctx, baseScope),
      dataQuality: dataQuality(ctx.cycle.cycleId),
      basis: {
        gmvBasis: Config.get('GMV_BASIS'),
        rateGstDivisor: Config.get('RATE_GST_DIVISOR'),
        reportingLagDays: Config.get('REPORTING_LAG_DAYS')
      }
    };
  }

  function headlineTarget_(ctx, engineScope, h) {
    if (h.planField) {
      var plans = Engine.accountPlansFor(ctx.cycle.cycleId, engineScope);
      return Util.sum(plans, function (p) { return p[h.planField]; });
    }
    if (h.target === 'PULSE') {
      var workingDays = Util.num(ctx.cycle.workingDays, 0) ||
        DateUtil.workingDaysInMonth(new Date(ctx.cycle.year, ctx.cycle.month - 1, 1));
      var pocs = engineScope.pocUserId ? 1 : activePocCount_(ctx, engineScope);
      return workingDays * Config.get('PULSE_VISITS_PER_DAY') * pocs;
    }
    if (h.target === 'ONBOARDED_BASE') {
      var m = Engine.metric(h.key, ctx.windows.mtd, engineScope, { trace: false });
      return (m.meta && m.meta.onboardedBase) || 0;
    }
    if (h.target === 'BALANCE_PLUS_MTD') {
      return Engine.target(
        { metricKey: h.key, targetBasis: TARGET_BASIS.BALANCE_PLUS_MTD, target4: 0 },
        ctx.cycle, engineScope, ctx.windows.mtd, null).value;
    }
    return 0;
  }

  function activePocCount_(ctx, engineScope) {
    var ids = Util.unique(Repository.where(SHEET.ASSIGNMENT, { cycleId: ctx.cycle.cycleId })
      .filter(function (a) {
        if (a.active === false) return false;
        if (engineScope.regionId && a.regionId !== engineScope.regionId) return false;
        return true;
      }).map(function (a) { return a.pocUserId; }));
    return ids.length || 1;
  }

  function scopeLabel_(ctx, s) {
    if (s.pocUserId) {
      var u = Repository.findById(SHEET.USERS, s.pocUserId);
      return u ? u.fullName : s.pocUserId;
    }
    if (s.regionId) {
      var r = Repository.findById(SHEET.REGIONS, s.regionId);
      return r ? r.regionName + ' region' : s.regionId;
    }
    return ctx.cycle.category + ' — all regions';
  }

  // =========================================================================
  // Trend and forecast
  // =========================================================================

  /**
   * Daily cumulative actual against a straight-line plan, plus the projected
   * landing. Reads the snapshot table when available and falls back to replaying
   * the facts, so the chart works from day one.
   */
  function trend(cycleIdValue, metricKey, options) {
    Auth.require(PERM.DASHBOARD_VIEW);
    options = options || {};
    var ctx = Reports.context(cycleIdValue, options.asOf);
    var engineScope = Engine.scope({
      category: ctx.cycle.category, stream: options.stream || STREAM.SUPPLY,
      regionId: options.regionId, pocUserId: options.pocUserId
    });

    var monthStart = new Date(ctx.cycle.year, ctx.cycle.month - 1, 1);
    var target = headlineTarget_(ctx, engineScope,
      { key: metricKey, planField: planFieldFor_(metricKey) });

    var points = [], cumulative = 0, lmtdCumulative = 0;
    var prevMonthStart = DateUtil.addMonths(monthStart, -1);

    for (var d = 1; d <= ctx.daysInMonth; d++) {
      var day = new Date(ctx.cycle.year, ctx.cycle.month - 1, d);
      var future = day > ctx.asOf;
      if (!future) {
        cumulative += Engine.metric(metricKey,
          { kind: 'DAY', start: day, end: DateUtil.addDays(day, 1), asOf: day },
          engineScope, { trace: false }).value;
      }
      var prevDay = new Date(prevMonthStart.getFullYear(), prevMonthStart.getMonth(), d);
      if (prevDay.getMonth() === prevMonthStart.getMonth()) {
        lmtdCumulative += Engine.metric(metricKey,
          { kind: 'DAY', start: prevDay, end: DateUtil.addDays(prevDay, 1), asOf: prevDay },
          engineScope, { trace: false }).value;
      }
      points.push({
        date: DateUtil.isoDate(day),
        day: d,
        actual: future ? null : Util.round(cumulative, 4),
        plan: Util.round(target * d / ctx.daysInMonth, 4),
        lastMonth: Util.round(lmtdCumulative, 4),
        future: future
      });
    }

    var runRate = Util.div(cumulative, ctx.elapsedDays, 0);
    var projected = cumulative + runRate * ctx.remainingDays;

    // Extend the projection line forward from today.
    points.forEach(function (p) {
      if (!p.future) { p.projection = p.actual; return; }
      p.projection = Util.round(cumulative + runRate * (p.day - ctx.elapsedDays), 4);
    });

    return {
      cycleId: ctx.cycle.cycleId, metricKey: metricKey,
      metricLabel: METRICS[metricKey] ? METRICS[metricKey].label : metricKey,
      unit: METRICS[metricKey] ? METRICS[metricKey].unit : '',
      target: Util.round(target, 4),
      actual: Util.round(cumulative, 4),
      projected: Util.round(projected, 4),
      projectedAchievement: Util.div(projected, target, 0),
      currentDrr: Util.round(runRate, 4),
      requiredDrr: Util.round(Util.div(Math.max(0, target - cumulative), ctx.remainingDays || 1, 0), 4),
      points: points
    };
  }

  function planFieldFor_(metricKey) {
    if (metricKey === 'TONNAGE_MT') return 'tonnageTargetMT';
    if (metricKey === 'TXN_COUNT') return 'txnTarget';
    if (metricKey === 'GMV_CR') return 'gmvTargetCr';
    return null;
  }

  /** Month-on-month history across the fiscal year for one metric. */
  function history(cycleIdValue, metricKey, options) {
    Auth.require(PERM.DASHBOARD_VIEW);
    options = options || {};
    var ctx = Reports.context(cycleIdValue, options.asOf);
    var engineScope = Engine.scope({
      category: ctx.cycle.category, stream: options.stream || STREAM.SUPPLY,
      regionId: options.regionId, pocUserId: options.pocUserId
    });
    var months = Util.num(options.months, 6);
    var out = [];
    for (var back = months - 1; back >= 0; back--) {
      var m = DateUtil.addMonths(new Date(ctx.cycle.year, ctx.cycle.month - 1, 1), -back);
      var w = back === 0 ? ctx.windows.mtd : DateUtil.window('MONTH', m);
      out.push({
        label: Utilities.formatDate(m, APP.TIMEZONE, 'MMM yy'),
        month: m.getMonth() + 1, year: m.getFullYear(),
        value: Util.round(Engine.metric(metricKey, w, engineScope, { trace: false }).value, 4),
        partial: back === 0
      });
    }
    return {
      metricKey: metricKey,
      metricLabel: METRICS[metricKey] ? METRICS[metricKey].label : metricKey,
      points: out
    };
  }

  // =========================================================================
  // Alerts — "what needs attention, and why"
  // =========================================================================

  /**
   * Generate the action list. Each alert names the owner, quantifies the gap and
   * states the next step, so a review meeting starts from decisions rather than
   * from data gathering.
   */
  function alerts(cycleIdValue, options) {
    Auth.require(PERM.DASHBOARD_VIEW);
    options = options || {};
    var ctx = Reports.context(cycleIdValue, options.asOf);
    var sc = Auth.scope();
    var out = [];

    // 1. KPIs behind pace, per POC.
    var pocIds = Util.unique(Repository.where(SHEET.ASSIGNMENT, { cycleId: ctx.cycle.cycleId })
      .filter(function (a) { return a.active !== false; })
      .map(function (a) { return a.pocUserId; }))
      .filter(function (id) {
        var u = ctx.users[id];
        return u && Auth.inScope(sc, id, ctx.cycle.category, u.regionId);
      });

    pocIds.forEach(function (pid) {
      var card = Reports.scorecardFor(ctx.cycle.cycleId, pid, ctx);
      card.kpis.forEach(function (k) {
        if (k.evaluation.paceStatus !== 'AT_RISK' && k.evaluation.paceStatus !== 'CRITICAL') return;
        out.push({
          id: 'PACE:' + pid + ':' + k.kpiId,
          kind: 'KPI_OFF_PACE',
          severity: k.evaluation.paceStatus === 'CRITICAL' ? 'P1' : 'P2',
          title: card.poc.fullName + ' — ' + k.kpiName + ' behind pace',
          detail: 'Achieved ' + Util.round(k.evaluation.actual, 2) + ' against a target of ' +
            Util.round(k.evaluation.target, 2) + ' (' + Fmt.pct(k.evaluation.achievement) + ').',
          nextStep: k.evaluation.remainingDays > 0
            ? 'Needs ' + Util.round(k.evaluation.requiredDrr, 2) + ' per day for the remaining ' +
            k.evaluation.remainingDays + ' day(s); currently at ' +
            Util.round(k.evaluation.currentDrr, 2) + ' per day.'
            : 'The cycle has ended — record the shortfall reason in the review.',
          ownerUserId: pid, ownerName: card.poc.fullName,
          regionId: card.poc.regionId,
          kpiId: k.kpiId, metricKey: k.metricKey,
          drill: k.drill
        });
      });
    });

    // 2. Accounts with a plan but no transaction this cycle.
    var plans = Repository.where(SHEET.ACCOUNT_PLAN, { cycleId: ctx.cycle.cycleId })
      .filter(function (p) {
        return p.active !== false && Util.num(p.gmvTargetCr, 0) > 0 &&
          Auth.inScope(sc, p.pocUserId, p.category, p.regionId);
      });
    plans.forEach(function (p) {
      var es = Engine.scope({
        category: ctx.cycle.category,
        stream: p.accountType === 'BUYER' ? STREAM.DEMAND : STREAM.SUPPLY,
        gstin: p.gstin
      });
      var achieved = Engine.metric('GMV_CR', ctx.windows.mtd, es, { trace: false }).value;
      if (achieved > 0) return;
      out.push({
        id: 'NOPLAN:' + p.planId,
        kind: 'PLANNED_NOT_TRANSACTED',
        severity: Util.num(p.gmvTargetCr, 0) >= 0.5 ? 'P1' : 'P2',
        title: p.accountName + ' has a plan but no transaction',
        detail: 'Planned ' + Fmt.cr(p.gmvTargetCr) + ' this cycle; nothing recorded so far.',
        nextStep: p.blockerReason
          ? 'Recorded blocker: ' + p.blockerReason + '. ' + (p.detailedRemarks || '')
          : 'No blocker recorded — confirm the reason with the POC and log it against the account.',
        ownerUserId: p.pocUserId,
        ownerName: ctx.users[p.pocUserId] ? ctx.users[p.pocUserId].fullName : '',
        regionId: p.regionId, accountId: p.accountId,
        drill: {
          metricKey: 'GMV_CR', cycleId: ctx.cycle.cycleId,
          gstin: p.gstin, pocUserId: p.pocUserId
        }
      });
    });

    // 3. Dormant accounts.
    var dormantDays = Config.get('DORMANCY_DAYS');
    var fs = Engine.facts(ctx.cycle.category);
    fs.accounts.forEach(function (a) {
      if (Util.key(a.onboardingStatus) !== 'COMPLETED') return;
      if (!Auth.inScope(sc, a.pocUserId, a.category, a.regionId)) return;
      var last = a.lastTxnDate || a.lastVisitDate || a.onboardedDate;
      if (!last) return;
      var idle = DateUtil.diffDays(last, ctx.asOf);
      if (idle === null || idle <= dormantDays) return;
      out.push({
        id: 'DORMANT:' + a.accountId,
        kind: 'DORMANT_ACCOUNT',
        severity: idle > dormantDays * 2 ? 'P2' : 'P3',
        title: a.businessName + ' idle for ' + idle + ' days',
        detail: 'No transaction or visit since ' + DateUtil.display(last) + '.',
        nextStep: 'Schedule a visit and record the outcome, or mark the account inactive with a reason.',
        ownerUserId: a.pocUserId,
        ownerName: ctx.users[a.pocUserId] ? ctx.users[a.pocUserId].fullName : '',
        regionId: a.regionId, accountId: a.accountId
      });
    });

    // 4. Onboarding SLA breaches.
    fs.onboarding.forEach(function (o) {
      if (!o.slaBreached) return;
      if (!Auth.inScope(sc, o.pocUserId, o.category, o.regionId)) return;
      if (!DateUtil.inWindow(o.onboardedDate || o.createdDate, ctx.windows.mtd)) return;
      out.push({
        id: 'SLA:' + o.onboardingKey,
        kind: 'ONBOARDING_SLA',
        severity: 'P3',
        title: o.businessName + ' onboarding took ' + o.onboardingSlaDays + ' days',
        detail: 'Target is ' + Config.get('SLA_ONBOARDING_DAYS') + ' days from creation to completion.',
        nextStep: 'Review where the case waited and remove the bottleneck.',
        ownerUserId: o.pocUserId,
        ownerName: ctx.users[o.pocUserId] ? ctx.users[o.pocUserId].fullName : '',
        regionId: o.regionId
      });
    });

    // 5. Pipeline rows past their next action date.
    Repository.readAll(SHEET.PIPELINE).forEach(function (p) {
      if (p.active === false) return;
      if (p.stage === PIPELINE_STAGE.ONBOARDED || p.stage === PIPELINE_STAGE.DROPPED) return;
      if (!p.nextActionDate || p.nextActionDate >= DateUtil.today()) return;
      if (!Auth.inScope(sc, p.pocUserId, p.category, p.regionId)) return;
      out.push({
        id: 'PIPE:' + p.pipelineId,
        kind: 'PIPELINE_OVERDUE',
        severity: 'P2',
        title: p.businessName + ' — follow-up overdue',
        detail: 'Next action was due ' + DateUtil.display(p.nextActionDate) +
          '; stage is still ' + p.stage + '.',
        nextStep: p.blockerReason ? 'Blocker: ' + p.blockerReason : 'Update the stage and set the next action date.',
        ownerUserId: p.pocUserId,
        ownerName: ctx.users[p.pocUserId] ? ctx.users[p.pocUserId].fullName : '',
        regionId: p.regionId, pipelineId: p.pipelineId
      });
    });

    // 6. Evidence awaiting verification.
    var pending = Repository.readAll(SHEET.ACTIVITIES).filter(function (a) {
      return !a.voided && a.cycleId === ctx.cycle.cycleId &&
        a.verificationStatus === 'PENDING' &&
        Auth.inScope(sc, a.pocUserId, a.category, a.regionId);
    });
    if (pending.length && Auth.can(PERM.ACTIVITY_VERIFY)) {
      out.push({
        id: 'VERIFY:' + ctx.cycle.cycleId,
        kind: 'EVIDENCE_PENDING',
        severity: 'P3',
        title: pending.length + ' activity record(s) awaiting evidence verification',
        detail: 'Unverified records still count towards KPIs but are flagged in the audit trail.',
        nextStep: 'Open Activity → Pending verification and review the attachments.',
        count: pending.length
      });
    }

    // 7. Overdue action items.
    Repository.where(SHEET.ACTIONS, { cycleId: ctx.cycle.cycleId }).forEach(function (t) {
      if (['DONE', 'CANCELLED'].indexOf(t.status) >= 0) return;
      if (!t.dueDate || t.dueDate >= DateUtil.today()) return;
      if (!Auth.inScope(sc, t.ownerUserId, t.category, t.regionId)) return;
      out.push({
        id: 'ACTION:' + t.actionId,
        kind: 'ACTION_OVERDUE',
        severity: 'P1',
        title: 'Overdue action — ' + t.title,
        detail: 'Due ' + DateUtil.display(t.dueDate) + ', still ' + t.status + '.',
        nextStep: t.description || 'Update the status or move the due date with a reason.',
        ownerUserId: t.ownerUserId,
        ownerName: ctx.users[t.ownerUserId] ? ctx.users[t.ownerUserId].fullName : '',
        actionId: t.actionId
      });
    });

    var order = { P1: 0, P2: 1, P3: 2 };
    var sorted = Util.sortBy(out, [{ pick: function (a) { return order[a.severity] || 3; } }]);
    var limited = options.limit ? sorted.slice(0, options.limit) : sorted;

    return {
      cycleId: ctx.cycle.cycleId,
      asOf: DateUtil.isoDate(ctx.asOf),
      counts: {
        total: sorted.length,
        p1: sorted.filter(function (a) { return a.severity === 'P1'; }).length,
        p2: sorted.filter(function (a) { return a.severity === 'P2'; }).length,
        p3: sorted.filter(function (a) { return a.severity === 'P3'; }).length
      },
      alerts: limited
    };
  }

  // =========================================================================
  // Data quality
  // =========================================================================

  /**
   * Surface the gaps that would otherwise silently distort a number. The source
   * workbook carried unmapped regions and POC-less sellers with no signal at all.
   */
  function dataQuality(cycleIdValue) {
    var cycle = Planning.getCycle(cycleIdValue);
    var issues = [];

    var accounts = Repository.readAll(SHEET.ACCOUNTS)
      .filter(function (a) { return a.category === cycle.category && a.active !== false; });
    var noPoc = accounts.filter(function (a) { return !a.pocUserId; });
    var noRegion = accounts.filter(function (a) { return !a.regionId; });
    var noGstin = accounts.filter(function (a) { return !a.gstin; });

    if (noPoc.length) {
      issues.push({
        code: 'ACCOUNT_NO_POC', severity: 'P2', count: noPoc.length,
        message: noPoc.length + ' account(s) have no POC, so their transactions are not attributed to anyone.',
        sample: noPoc.slice(0, 5).map(function (a) { return a.businessName; })
      });
    }
    if (noRegion.length) {
      issues.push({
        code: 'ACCOUNT_NO_REGION', severity: 'P3', count: noRegion.length,
        message: noRegion.length + ' account(s) are not mapped to a region.',
        sample: noRegion.slice(0, 5).map(function (a) { return a.businessName; })
      });
    }
    if (noGstin.length) {
      issues.push({
        code: 'ACCOUNT_NO_GSTIN', severity: 'P2', count: noGstin.length,
        message: noGstin.length + ' account(s) have no GSTIN, so transactions cannot be matched to them.',
        sample: noGstin.slice(0, 5).map(function (a) { return a.businessName; })
      });
    }

    // Shipments whose GSTIN matches no account — the number exists but has no owner.
    var byGstin = {};
    accounts.forEach(function (a) { if (a.gstin) byGstin[Util.key(a.gstin)] = true; });
    var orphanShipments = Repository.readAll(SHEET.SHIPMENTS).filter(function (s) {
      return s.category === cycle.category && s.sellerGstin && !byGstin[Util.key(s.sellerGstin)];
    });
    if (orphanShipments.length) {
      issues.push({
        code: 'SHIPMENT_ORPHAN', severity: 'P1', count: orphanShipments.length,
        message: orphanShipments.length +
          ' shipment(s) reference a seller GSTIN with no matching account record.',
        sample: Util.unique(orphanShipments.map(function (s) { return s.sellerName; })).slice(0, 5)
      });
    }

    // Plan rows with tonnage but no rate produce a zero GMV target.
    var badPlans = Repository.where(SHEET.ACCOUNT_PLAN, { cycleId: cycle.cycleId })
      .filter(function (p) {
        return p.active !== false && Util.num(p.tonnageTargetMT, 0) > 0 &&
          Util.num(p.ratePerKgTarget, 0) <= 0;
      });
    if (badPlans.length) {
      issues.push({
        code: 'PLAN_NO_RATE', severity: 'P2', count: badPlans.length,
        message: badPlans.length + ' plan row(s) have a tonnage target but no rate, so their GMV target is zero.',
        sample: badPlans.slice(0, 5).map(function (p) { return p.accountName; })
      });
    }

    var lastSync = Util.sortBy(Repository.readAll(SHEET.SYNC_LOG),
      [{ pick: function (s) { return s.startedAt ? s.startedAt.getTime() : 0; }, dir: 'desc' }])[0];
    if (lastSync && lastSync.finishedAt) {
      var age = DateUtil.diffDays(lastSync.finishedAt, DateUtil.today());
      if (age > 1) {
        issues.push({
          code: 'SYNC_STALE', severity: 'P1', count: age,
          message: 'Source data was last synced ' + age + ' days ago (' +
            DateUtil.display(lastSync.finishedAt) + ').'
        });
      }
    } else if (!lastSync) {
      issues.push({
        code: 'SYNC_NEVER', severity: 'P2', count: 0,
        message: 'No source sync has run yet — transaction and onboarding facts may be missing.'
      });
    }

    return {
      ok: issues.length === 0,
      lastSyncAt: lastSync ? DateUtil.isoDateTime(lastSync.finishedAt || lastSync.startedAt) : null,
      issues: issues
    };
  }

  // =========================================================================
  // Snapshots — freeze daily values so trends survive fact corrections
  // =========================================================================

  function takeSnapshot(cycleIdValue, asOfValue) {
    var ctx = Reports.context(cycleIdValue, asOfValue);
    var snapDate = ctx.asOf;
    var rows = [];

    function record(scopeName, scopeKey, engineScope) {
      Reports.REVIEW_METRICS.forEach(function (m) {
        var actual = Engine.metric(m.key, ctx.windows.mtd, engineScope, { trace: false });
        var lmtd = Engine.metric(m.key, ctx.windows.lmtd, engineScope, { trace: false });
        var plans = Engine.accountPlansFor(ctx.cycle.cycleId, engineScope);
        var targetValue = 0;
        if (m.target && m.target.indexOf('ACCOUNT_PLAN:') === 0) {
          var f = m.target.split(':')[1];
          targetValue = Util.sum(plans, function (p) { return p[f]; });
        }
        rows.push({
          snapshotId: Id.natural('SNAP', DateUtil.isoDate(snapDate), ctx.cycle.cycleId, scopeName, scopeKey, m.key),
          snapshotDate: snapDate, cycleId: ctx.cycle.cycleId, category: ctx.cycle.category,
          scope: scopeName, scopeKey: scopeKey, metricKey: m.key,
          targetValue: Util.round(targetValue, 4),
          actualValue: Util.round(actual.value, 4),
          lmtdValue: Util.round(lmtd.value, 4),
          achievementPct: Util.div(actual.value, targetValue, 0),
          createdAt: new Date()
        });
      });
    }

    record('OVERALL', ctx.cycle.category,
      Engine.scope({ category: ctx.cycle.category, stream: STREAM.SUPPLY }));

    Repository.readAll(SHEET.REGIONS)
      .filter(function (r) { return r.category === ctx.cycle.category && r.active !== false; })
      .forEach(function (r) {
        record('REGION', r.regionId,
          Engine.scope({ category: ctx.cycle.category, stream: STREAM.SUPPLY, regionId: r.regionId }));
      });

    Util.unique(Repository.where(SHEET.ASSIGNMENT, { cycleId: ctx.cycle.cycleId })
      .filter(function (a) { return a.active !== false; })
      .map(function (a) { return a.pocUserId; }))
      .forEach(function (pid) {
        record('POC', pid,
          Engine.scope({ category: ctx.cycle.category, stream: STREAM.SUPPLY, pocUserId: pid }));
      });

    var result = Repository.upsertMany(SHEET.SNAPSHOTS, rows);
    Audit.log('SNAPSHOT_TAKE', SHEET.SNAPSHOTS, ctx.cycle.cycleId,
      rows.length + ' metric snapshots for ' + DateUtil.isoDate(snapDate), null, result);
    return { date: DateUtil.isoDate(snapDate), rows: rows.length, result: result };
  }

  return {
    executive: executive,
    trend: trend,
    history: history,
    alerts: alerts,
    dataQuality: dataQuality,
    takeSnapshot: takeSnapshot,
    HEADLINE: HEADLINE
  };
})();
