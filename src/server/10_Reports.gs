/**
 * 10_Reports.gs — Generated outputs. Nothing here is ever typed by a human.
 *
 * Each function replaces a sheet that used to be maintained by hand:
 *
 *   scorecardFor()      → the ten per-POC scorecard sheets
 *   leaderboard()       → BDM Summary
 *   pocWise()           → POC-Wise
 *   regionWise()        → Region-Wise
 *   dailyReview()       → WhatsApp Summary
 *   weeklyPlanReview()  → Weekly Plan vs Achievement
 *   coverage()          → Onboarded Sellers VS Pulse
 *
 * Every figure carries enough identity for the UI to request a drill-down.
 */

var Reports = (function () {

  // =========================================================================
  // Shared context
  // =========================================================================

  /**
   * Build the once-per-request context: cycle, windows, day counts and the
   * lookup tables. Every report below shares it, so a page that renders four
   * reports still reads each table once.
   */
  function context(cycleIdValue, asOfValue) {
    var cycle = Planning.getCycle(cycleIdValue);
    var asOf = DateUtil.parse(asOfValue) || DateUtil.asOf();
    var mtd = DateUtil.cycleWindow(cycle.year, cycle.month, asOf);
    var lmtd = DateUtil.cycleLmtdWindow(cycle.year, cycle.month, asOf);
    var fytd = DateUtil.window('FYTD', mtd.asOf);

    var monthStart = new Date(cycle.year, cycle.month - 1, 1);
    var daysInMonth = DateUtil.daysInMonth(monthStart);
    var elapsedDays = DateUtil.elapsedDays(mtd);
    var remainingDays = Math.max(0, daysInMonth - elapsedDays);

    return {
      cycle: cycle,
      asOf: mtd.asOf,
      windows: { mtd: mtd, lmtd: lmtd, fytd: fytd },
      daysInMonth: daysInMonth,
      elapsedDays: elapsedDays,
      remainingDays: remainingDays,
      users: Util.indexBy(Repository.readAll(SHEET.USERS), function (u) { return u.userId; }),
      regions: Util.indexBy(Repository.readAll(SHEET.REGIONS), function (r) { return r.regionId; })
    };
  }

  function userName(ctx, userId) {
    return ctx.users[userId] ? ctx.users[userId].fullName : (userId || '—');
  }

  function regionName(ctx, regionId) {
    return ctx.regions[regionId] ? ctx.regions[regionId].regionName : (regionId || 'Unassigned');
  }

  // =========================================================================
  // Scorecard — replaces the ten per-POC sheets
  // =========================================================================

  /**
   * Evaluate every KPI assigned to a POC for a cycle and roll it into the
   * weighted score, exactly as the workbook's scorecard did:
   *
   *   Achievement %  = Actual ÷ Target
   *   Weighted Score = MIN(Achievement, 1.05) × Weightage
   *   Overall        = MIN(Σ Weighted ÷ Σ Weightage, 1.05)
   */
  function scorecardFor(cycleIdValue, pocUserId, ctxIn) {
    var ctx = ctxIn || context(cycleIdValue);
    var sc = Auth.scope();
    assert(Auth.inScope(sc, pocUserId, ctx.cycle.category, null) ||
      Auth.can(PERM.SCORECARD_VIEW_ALL), 'FORBIDDEN', 'That scorecard is outside your scope.');

    var user = ctx.users[pocUserId];
    var assignments = Repository.where(SHEET.ASSIGNMENT,
      { cycleId: ctx.cycle.cycleId, pocUserId: pocUserId })
      .filter(function (a) { return a.active !== false; });

    var evaluated = [];
    assignments.forEach(function (a) {
      var kpi = Repository.findById(SHEET.KPI, a.kpiId);
      if (!kpi || kpi.active === false) return;
      var kra = Repository.findById(SHEET.KRA, kpi.kraId);
      if (!kra || kra.active === false) return;

      var engineScope = Engine.scope({
        category: ctx.cycle.category, stream: kra.stream, pocUserId: pocUserId,
        regionId: null, label: userName(ctx, pocUserId)
      });

      var targetInfo = Engine.target(kpi, ctx.cycle, engineScope, ctx.windows.mtd, a);
      var actual = Engine.metric(kpi.metricKey, ctx.windows.mtd, engineScope, { trace: false });
      var lmtd = Engine.metric(kpi.metricKey, ctx.windows.lmtd, engineScope, { trace: false });

      var weightage = (a.weightage !== null && a.weightage !== undefined && a.weightage !== '')
        ? Util.num(a.weightage, 0) : Util.num(kpi.weightage, 0);

      var evaluation = Engine.evaluate({
        target: targetInfo.value, actual: actual.value, lmtd: lmtd.value,
        weightage: weightage, direction: kpi.direction,
        elapsedDays: ctx.elapsedDays, remainingDays: ctx.remainingDays
      });

      evaluated.push({
        assignmentId: a.assignmentId,
        kpiId: kpi.kpiId, kraId: kra.kraId,
        kraName: kra.kraName, perspective: kra.perspective, stream: kra.stream,
        kpiName: kpi.kpiName, definition: kpi.definition,
        metricKey: kpi.metricKey,
        unit: METRICS[kpi.metricKey] ? METRICS[kpi.metricKey].unit : '',
        unitOfMeasure: kpi.unitOfMeasure,
        direction: kpi.direction,
        weightage: weightage,
        targetBasis: targetInfo.basis,
        targetDetail: targetInfo.detail,
        targetBands: [kpi.target1, kpi.target2, kpi.target3, kpi.target4, kpi.target5],
        dueDate: DateUtil.isoDate(a.dueDate),
        evaluation: evaluation,
        drill: {
          metricKey: kpi.metricKey, stream: kra.stream,
          pocUserId: pocUserId, cycleId: ctx.cycle.cycleId
        }
      });
    });

    evaluated = Util.sortBy(evaluated, [
      { pick: function (k) { return k.stream === STREAM.SUPPLY ? 0 : 1; } },
      { pick: function (k) { return -k.weightage; } }
    ]);

    var roll = Engine.scorecard(evaluated.map(function (k) { return k.evaluation; }));

    return {
      cycleId: ctx.cycle.cycleId,
      cycleLabel: ctx.cycle.label,
      category: ctx.cycle.category,
      asOf: DateUtil.isoDate(ctx.asOf),
      poc: {
        userId: pocUserId,
        fullName: user ? user.fullName : pocUserId,
        employeeCode: user ? user.employeeCode : '',
        regionId: user ? user.regionId : '',
        regionName: user ? regionName(ctx, user.regionId) : ''
      },
      summary: {
        totalWeightage: roll.totalWeightage,
        weightedScore: roll.weightedScore,
        maxWeightedScore: roll.maxWeightedScore,
        overallAchievement: roll.overallAchievement,
        rating: roll.rating,
        ratingLabel: roll.ratingLabel,
        tone: roll.tone,
        kpiCount: roll.kpiCount,
        weightageValid: roll.weightageValid,
        elapsedDays: ctx.elapsedDays,
        remainingDays: ctx.remainingDays,
        daysInMonth: ctx.daysInMonth
      },
      kpis: evaluated
    };
  }

  /** BDM Summary — every POC's score, ranked. */
  function leaderboard(cycleIdValue, asOfValue) {
    Auth.require(PERM.SCORECARD_VIEW_ALL);
    var ctx = context(cycleIdValue, asOfValue);
    var sc = Auth.scope();

    var pocIds = Util.unique(
      Repository.where(SHEET.ASSIGNMENT, { cycleId: ctx.cycle.cycleId })
        .filter(function (a) { return a.active !== false; })
        .map(function (a) { return a.pocUserId; })
    ).filter(function (id) {
      var u = ctx.users[id];
      return u && Auth.inScope(sc, id, ctx.cycle.category, u.regionId);
    });

    var cards = pocIds.map(function (id) { return scorecardFor(ctx.cycle.cycleId, id, ctx); });

    // Competition ranking, matching Excel RANK(…, 0).
    var scores = cards.map(function (c) { return c.summary.overallAchievement; });
    var ranks = Util.rank(scores);

    var rows = cards.map(function (c, i) {
      var byMetric = {};
      c.kpis.forEach(function (k) {
        byMetric[k.metricKey] = {
          target: k.evaluation.target, actual: k.evaluation.actual,
          achievement: k.evaluation.achievement
        };
      });
      return {
        rank: ranks[i],
        pocUserId: c.poc.userId, pocName: c.poc.fullName,
        regionId: c.poc.regionId, regionName: c.poc.regionName,
        weightedScore: c.summary.weightedScore,
        overallAchievement: c.summary.overallAchievement,
        rating: c.summary.rating, ratingLabel: c.summary.ratingLabel, tone: c.summary.tone,
        kpiCount: c.summary.kpiCount,
        onPace: c.kpis.filter(function (k) {
          return k.evaluation.paceStatus === 'ON_TRACK' || k.evaluation.paceStatus === 'ACHIEVED';
        }).length,
        atRisk: c.kpis.filter(function (k) {
          return k.evaluation.paceStatus === 'AT_RISK' || k.evaluation.paceStatus === 'CRITICAL';
        }).length,
        metrics: byMetric
      };
    });

    return {
      cycleId: ctx.cycle.cycleId, cycleLabel: ctx.cycle.label,
      asOf: DateUtil.isoDate(ctx.asOf),
      rows: Util.sortBy(rows, [{ pick: function (r) { return r.rank; } }]),
      teamAverage: rows.length
        ? Util.round(Util.sum(rows, function (r) { return r.overallAchievement; }) / rows.length, 4)
        : 0
    };
  }

  // =========================================================================
  // The seven-metric grid — the WhatsApp Summary decision grammar
  // =========================================================================

  /**
   * The metric set leadership reads every morning, in the workbook's order.
   * Each entry declares how its target is obtained; the actual always comes
   * from the engine.
   */
  var REVIEW_METRICS = [
    { key: 'PULSE_VISITS', label: 'Overall Pulse Visits', unit: 'COUNT', target: 'PULSE' },
    { key: 'ONBOARDED_VS_VISIT', label: 'Onboarded vs Visit', unit: 'COUNT', target: 'ONBOARDED_BASE' },
    { key: 'ONBOARDED_VS_TXN', label: 'Onboarded vs Transaction', unit: 'COUNT', target: 'ONBOARDED_BASE' },
    { key: 'SELLER_ONBOARDED', label: 'Sellers Onboarded', unit: 'COUNT', target: 'BALANCE_PLUS_MTD' },
    { key: 'TXN_COUNT', label: 'Seller Txns', unit: 'COUNT', target: 'ACCOUNT_PLAN:txnTarget' },
    { key: 'TONNAGE_MT', label: 'Tonnage (MT)', unit: 'MT', target: 'ACCOUNT_PLAN:tonnageTargetMT' },
    { key: 'GMV_CR', label: 'GMV (₹ Cr)', unit: 'CR', target: 'ACCOUNT_PLAN:gmvTargetCr' }
  ];

  function reviewGrid_(ctx, engineScope, scopeMeta) {
    return REVIEW_METRICS.map(function (m) {
      var actual = Engine.metric(m.key, ctx.windows.mtd, engineScope, { trace: false });
      var lmtd = Engine.metric(m.key, ctx.windows.lmtd, engineScope, { trace: false });
      var targetValue = reviewTarget_(ctx, engineScope, m, actual);

      var evaluation = Engine.evaluate({
        target: targetValue.value, actual: actual.value, lmtd: lmtd.value,
        weightage: 0, direction: DIRECTION.HIGHER_BETTER,
        elapsedDays: ctx.elapsedDays, remainingDays: ctx.remainingDays
      });

      return {
        metricKey: m.key, label: m.label, unit: m.unit,
        target: Util.round(evaluation.target, 6),
        achieved: Util.round(evaluation.actual, 6),
        achievementPct: evaluation.achievement,
        currentDrr: Util.round(evaluation.currentDrr, 6),
        requiredDrr: Util.round(evaluation.requiredDrr, 6),
        lmtd: Util.round(evaluation.lmtd, 6),
        growthPct: evaluation.growthPct,
        paceStatus: evaluation.paceStatus,
        tone: evaluation.tone,
        projected: Util.round(evaluation.projected, 6),
        projectedAchievement: evaluation.projectedAchievement,
        targetBasis: targetValue.basis,
        drill: {
          metricKey: m.key, cycleId: ctx.cycle.cycleId,
          regionId: scopeMeta.regionId || null,
          pocUserId: scopeMeta.pocUserId || null,
          stream: engineScope.stream
        }
      };
    });
  }

  function reviewTarget_(ctx, engineScope, m, actual) {
    if (m.target === 'PULSE') {
      var workingDays = Util.num(ctx.cycle.workingDays, 0) ||
        DateUtil.workingDaysInMonth(new Date(ctx.cycle.year, ctx.cycle.month - 1, 1));
      var pocCount = engineScope.pocUserId ? 1 : countPocs_(ctx, engineScope);
      var rate = Config.get('PULSE_VISITS_PER_DAY');
      return { value: workingDays * rate * pocCount, basis: 'RATE_PER_DAY' };
    }
    if (m.target === 'ONBOARDED_BASE') {
      // Target = every onboarded account should be serviced.
      var meta = Engine.metric(m.key, ctx.windows.mtd, engineScope, { trace: false });
      return { value: (meta.meta && meta.meta.onboardedBase) || 0, basis: 'ONBOARDED_BASE' };
    }
    if (m.target === 'BALANCE_PLUS_MTD') {
      var pseudoKpi = {
        metricKey: m.key, targetBasis: TARGET_BASIS.BALANCE_PLUS_MTD,
        target4: 0, basisPct: null, basisMetric: ''
      };
      var t = Engine.target(pseudoKpi, ctx.cycle, engineScope, ctx.windows.mtd, null);
      return { value: t.value, basis: t.basis };
    }
    if (m.target.indexOf('ACCOUNT_PLAN:') === 0) {
      var field = m.target.split(':')[1];
      var plans = Engine.accountPlansFor(ctx.cycle.cycleId, engineScope);
      return { value: Util.sum(plans, function (p) { return p[field]; }), basis: 'ACCOUNT_PLAN' };
    }
    return { value: 0, basis: 'NONE' };
  }

  function countPocs_(ctx, engineScope) {
    var ids = Util.unique(
      Repository.where(SHEET.ASSIGNMENT, { cycleId: ctx.cycle.cycleId })
        .filter(function (a) {
          if (a.active === false) return false;
          if (engineScope.regionId && a.regionId !== engineScope.regionId) return false;
          return true;
        })
        .map(function (a) { return a.pocUserId; })
    );
    return ids.length || 1;
  }

  /**
   * Daily Review — the generated replacement for the WhatsApp Summary sheet.
   * Overall → per region → per POC, each as the same seven-metric grid.
   */
  function dailyReview(cycleIdValue, asOfValue, options) {
    Auth.require(PERM.DASHBOARD_VIEW);
    options = options || {};
    var ctx = context(cycleIdValue, asOfValue);
    var sc = Auth.scope();
    var stream = options.stream || STREAM.SUPPLY;

    var overall = reviewGrid_(ctx,
      Engine.scope({ category: ctx.cycle.category, stream: stream }),
      {});

    var regionIds = Util.unique(
      Repository.readAll(SHEET.REGIONS)
        .filter(function (r) { return r.category === ctx.cycle.category && r.active !== false; })
        .map(function (r) { return r.regionId; })
    ).filter(function (rid) { return !sc.regionIds || sc.regionIds.indexOf(rid) >= 0; });

    var assignments = Repository.where(SHEET.ASSIGNMENT, { cycleId: ctx.cycle.cycleId })
      .filter(function (a) { return a.active !== false; });
    var pocByRegion = {};
    assignments.forEach(function (a) {
      var u = ctx.users[a.pocUserId];
      if (!u || !Auth.inScope(sc, a.pocUserId, ctx.cycle.category, u.regionId)) return;
      var rid = u.regionId || 'UNASSIGNED';
      (pocByRegion[rid] || (pocByRegion[rid] = {}))[a.pocUserId] = true;
    });

    var regions = regionIds.map(function (rid) {
      var pocIds = Object.keys(pocByRegion[rid] || {});
      return {
        regionId: rid, regionName: regionName(ctx, rid),
        rhUserId: ctx.regions[rid] ? ctx.regions[rid].rhUserId : '',
        rhName: ctx.regions[rid] ? userName(ctx, ctx.regions[rid].rhUserId) : '',
        pocCount: pocIds.length,
        metrics: reviewGrid_(ctx,
          Engine.scope({ category: ctx.cycle.category, stream: stream, regionId: rid }),
          { regionId: rid }),
        pocs: pocIds.map(function (pid) {
          return {
            pocUserId: pid, pocName: userName(ctx, pid),
            metrics: reviewGrid_(ctx,
              Engine.scope({ category: ctx.cycle.category, stream: stream, pocUserId: pid }),
              { pocUserId: pid, regionId: rid })
          };
        })
      };
    }).filter(function (r) { return r.pocCount > 0 || options.includeEmptyRegions; });

    return {
      title: ctx.cycle.category + ' Category — Daily Performance Review',
      asOfLabel: 'As Of ' + DateUtil.display(ctx.asOf),
      cycleId: ctx.cycle.cycleId, cycleLabel: ctx.cycle.label,
      category: ctx.cycle.category, stream: stream,
      elapsedDays: ctx.elapsedDays, remainingDays: ctx.remainingDays,
      daysInMonth: ctx.daysInMonth,
      columns: ['Target', 'Achieved', 'Achievement %', 'Current DRR', 'Required DRR', 'LMTD', 'MTD Growth %'],
      overall: overall,
      regions: regions,
      generatedAt: DateUtil.isoDateTime(new Date())
    };
  }

  // =========================================================================
  // POC-Wise and Region-Wise
  // =========================================================================

  /**
   * POC-Wise — onboarding block, transaction block, target-vs-achieved block
   * and the material split, all derived.
   */
  function pocWise(cycleIdValue, asOfValue, options) {
    Auth.require(PERM.DASHBOARD_VIEW);
    options = options || {};
    var ctx = context(cycleIdValue, asOfValue);
    var sc = Auth.scope();
    var stream = options.stream || STREAM.SUPPLY;
    var accountType = stream === STREAM.DEMAND ? 'BUYER' : 'SELLER';
    var onboardMetric = stream === STREAM.DEMAND ? 'BUYER_ONBOARDED' : 'SELLER_ONBOARDED';
    var fy = DateUtil.fiscalYearLabel(new Date(ctx.cycle.year, ctx.cycle.month - 1, 1));

    var pocIds = Util.unique(
      Repository.where(SHEET.ASSIGNMENT, { cycleId: ctx.cycle.cycleId })
        .filter(function (a) { return a.active !== false; })
        .map(function (a) { return a.pocUserId; })
    ).filter(function (id) {
      var u = ctx.users[id];
      return u && Auth.inScope(sc, id, ctx.cycle.category, u.regionId);
    });

    var annualPlans = Repository.where(SHEET.ONBOARDING_PLAN,
      { fiscalYear: fy, category: ctx.cycle.category });

    var rows = pocIds.map(function (pid) {
      var u = ctx.users[pid];
      var es = Engine.scope({ category: ctx.cycle.category, stream: stream, pocUserId: pid });

      // Onboarding block
      var annual = Util.sum(annualPlans.filter(function (p) {
        return p.pocUserId === pid && (!p.accountType || p.accountType === accountType);
      }), function (p) { return p.annualPlan; });
      var fytdOnboarded = Engine.metric(onboardMetric, ctx.windows.fytd, es, { trace: false }).value;
      var mtdOnboarded = Engine.metric(onboardMetric, ctx.windows.mtd, es, { trace: false }).value;
      var lmtdOnboarded = Engine.metric(onboardMetric, ctx.windows.lmtd, es, { trace: false }).value;
      var balance = Math.max(0, annual - fytdOnboarded);
      var monthlyOnboardTarget = balance + mtdOnboarded;   // POC-Wise!N = G + K

      // Transaction block
      var mtdTxn = Engine.metric('TXN_COUNT', ctx.windows.mtd, es, { trace: false }).value;
      var mtdTon = Engine.metric('TONNAGE_MT', ctx.windows.mtd, es, { trace: false }).value;
      var mtdGmv = Engine.metric('GMV_CR', ctx.windows.mtd, es, { trace: false }).value;
      var lmtdTxn = Engine.metric('TXN_COUNT', ctx.windows.lmtd, es, { trace: false }).value;
      var lmtdTon = Engine.metric('TONNAGE_MT', ctx.windows.lmtd, es, { trace: false }).value;
      var lmtdGmv = Engine.metric('GMV_CR', ctx.windows.lmtd, es, { trace: false }).value;
      var fytdTxn = Engine.metric('TXN_COUNT', ctx.windows.fytd, es, { trace: false }).value;
      var fytdTon = Engine.metric('TONNAGE_MT', ctx.windows.fytd, es, { trace: false }).value;
      var fytdGmv = Engine.metric('GMV_CR', ctx.windows.fytd, es, { trace: false }).value;

      var plans = Engine.accountPlansFor(ctx.cycle.cycleId, es);
      var txnTarget = Util.sum(plans, function (p) { return p.txnTarget; });
      var tonTarget = Util.sum(plans, function (p) { return p.tonnageTargetMT; });
      var gmvTarget = Util.sum(plans, function (p) { return p.gmvTargetCr; });

      // Material split — PET / Flakes / Others
      var materials = MATERIAL_TYPES.map(function (mt) {
        var ms = Engine.scope({
          category: ctx.cycle.category, stream: stream, pocUserId: pid, materialType: mt
        });
        var mPlans = Engine.accountPlansFor(ctx.cycle.cycleId, ms);
        return {
          materialType: mt,
          tonnageTargetMT: Util.round(Util.sum(mPlans, function (p) { return p.tonnageTargetMT; }), 3),
          tonnageAchievedMT: Util.round(Engine.metric('TONNAGE_MT', ctx.windows.mtd, ms, { trace: false }).value, 3),
          gmvTargetCr: Util.round(Util.sum(mPlans, function (p) { return p.gmvTargetCr; }), 4),
          gmvAchievedCr: Util.round(Engine.metric('GMV_CR', ctx.windows.mtd, ms, { trace: false }).value, 4)
        };
      });

      return {
        pocUserId: pid, pocName: userName(ctx, pid),
        regionId: u.regionId, regionName: regionName(ctx, u.regionId),
        rhUserId: ctx.regions[u.regionId] ? ctx.regions[u.regionId].rhUserId : '',
        rhName: ctx.regions[u.regionId] ? userName(ctx, ctx.regions[u.regionId].rhUserId) : '',

        onboarding: {
          annualPlan: annual,
          fytdOnboarded: fytdOnboarded,
          annualAchievementPct: Util.div(fytdOnboarded, annual, 0),
          balanceToDo: balance,
          mtdOnboarded: mtdOnboarded,
          lmtdOnboarded: lmtdOnboarded,
          mtdGrowthPct: Util.div(mtdOnboarded - lmtdOnboarded, lmtdOnboarded, 0),
          monthlyTarget: monthlyOnboardTarget,
          monthlyAchievementPct: Util.div(mtdOnboarded, monthlyOnboardTarget, 0)
        },

        fytd: {
          txnCount: fytdTxn,
          tonnageMT: Util.round(fytdTon, 3),
          gmvCr: Util.round(fytdGmv, 6)
        },

        mtd: {
          txnTarget: txnTarget, txnAchieved: mtdTxn,
          txnAchievementPct: Util.div(mtdTxn, txnTarget, 0),
          tonnageTargetMT: Util.round(tonTarget, 3),
          tonnageAchievedMT: Util.round(mtdTon, 3),
          tonnageAchievementPct: Util.div(mtdTon, tonTarget, 0),
          gmvTargetCr: Util.round(gmvTarget, 6),
          gmvAchievedCr: Util.round(mtdGmv, 6),
          gmvAchievementPct: Util.div(mtdGmv, gmvTarget, 0),
          ratePerKg: Util.round(Engine.metric('RATE_PER_KG', ctx.windows.mtd, es, { trace: false }).value, 2)
        },

        lmtd: {
          txnCount: lmtdTxn,
          tonnageMT: Util.round(lmtdTon, 3),
          gmvCr: Util.round(lmtdGmv, 6)
        },

        growth: {
          txnPct: Util.div(mtdTxn - lmtdTxn, lmtdTxn, 0),
          tonnagePct: Util.div(mtdTon - lmtdTon, lmtdTon, 0),
          gmvPct: Util.div(mtdGmv - lmtdGmv, lmtdGmv, 0)
        },

        materials: materials,
        accountPlanCount: plans.length
      };
    });

    return {
      cycleId: ctx.cycle.cycleId, cycleLabel: ctx.cycle.label,
      category: ctx.cycle.category, stream: stream,
      asOf: DateUtil.isoDate(ctx.asOf),
      rows: Util.sortBy(rows, [
        { pick: function (r) { return r.regionName; } },
        { pick: function (r) { return -r.mtd.gmvAchievedCr; } }
      ]),
      totals: totalsFor_(rows)
    };
  }

  function totalsFor_(rows) {
    var t = {
      annualPlan: 0, fytdOnboarded: 0, balanceToDo: 0, mtdOnboarded: 0,
      monthlyTarget: 0, txnTarget: 0, txnAchieved: 0,
      tonnageTargetMT: 0, tonnageAchievedMT: 0, gmvTargetCr: 0, gmvAchievedCr: 0,
      lmtdTxn: 0, lmtdTonnageMT: 0, lmtdGmvCr: 0
    };
    rows.forEach(function (r) {
      t.annualPlan += r.onboarding.annualPlan;
      t.fytdOnboarded += r.onboarding.fytdOnboarded;
      t.balanceToDo += r.onboarding.balanceToDo;
      t.mtdOnboarded += r.onboarding.mtdOnboarded;
      t.monthlyTarget += r.onboarding.monthlyTarget;
      t.txnTarget += r.mtd.txnTarget;
      t.txnAchieved += r.mtd.txnAchieved;
      t.tonnageTargetMT += r.mtd.tonnageTargetMT;
      t.tonnageAchievedMT += r.mtd.tonnageAchievedMT;
      t.gmvTargetCr += r.mtd.gmvTargetCr;
      t.gmvAchievedCr += r.mtd.gmvAchievedCr;
      t.lmtdTxn += r.lmtd.txnCount;
      t.lmtdTonnageMT += r.lmtd.tonnageMT;
      t.lmtdGmvCr += r.lmtd.gmvCr;
    });
    t.txnAchievementPct = Util.div(t.txnAchieved, t.txnTarget, 0);
    t.tonnageAchievementPct = Util.div(t.tonnageAchievedMT, t.tonnageTargetMT, 0);
    t.gmvAchievementPct = Util.div(t.gmvAchievedCr, t.gmvTargetCr, 0);
    t.gmvGrowthPct = Util.div(t.gmvAchievedCr - t.lmtdGmvCr, t.lmtdGmvCr, 0);
    ['tonnageTargetMT', 'tonnageAchievedMT', 'lmtdTonnageMT'].forEach(function (k) {
      t[k] = Util.round(t[k], 3);
    });
    ['gmvTargetCr', 'gmvAchievedCr', 'lmtdGmvCr'].forEach(function (k) {
      t[k] = Util.round(t[k], 6);
    });
    return t;
  }

  /** Region-Wise — a pure roll-up of POC-Wise, exactly as in the workbook. */
  function regionWise(cycleIdValue, asOfValue, options) {
    var poc = pocWise(cycleIdValue, asOfValue, options);
    var byRegion = Util.groupBy(poc.rows, function (r) { return r.regionId || 'UNASSIGNED'; });

    var rows = Object.keys(byRegion).map(function (rid) {
      var members = byRegion[rid];
      var totals = totalsFor_(members);
      var materials = MATERIAL_TYPES.map(function (mt) {
        var acc = { materialType: mt, tonnageTargetMT: 0, tonnageAchievedMT: 0, gmvTargetCr: 0, gmvAchievedCr: 0 };
        members.forEach(function (m) {
          var hit = m.materials.filter(function (x) { return x.materialType === mt; })[0];
          if (!hit) return;
          acc.tonnageTargetMT += hit.tonnageTargetMT;
          acc.tonnageAchievedMT += hit.tonnageAchievedMT;
          acc.gmvTargetCr += hit.gmvTargetCr;
          acc.gmvAchievedCr += hit.gmvAchievedCr;
        });
        acc.tonnageTargetMT = Util.round(acc.tonnageTargetMT, 3);
        acc.tonnageAchievedMT = Util.round(acc.tonnageAchievedMT, 3);
        acc.gmvTargetCr = Util.round(acc.gmvTargetCr, 6);
        acc.gmvAchievedCr = Util.round(acc.gmvAchievedCr, 6);
        return acc;
      });
      return {
        regionId: rid,
        regionName: members[0].regionName,
        rhUserId: members[0].rhUserId, rhName: members[0].rhName,
        pocCount: members.length,
        totals: totals,
        materials: materials,
        pocs: members.map(function (m) {
          return {
            pocUserId: m.pocUserId, pocName: m.pocName,
            gmvAchievedCr: m.mtd.gmvAchievedCr, gmvTargetCr: m.mtd.gmvTargetCr,
            gmvAchievementPct: m.mtd.gmvAchievementPct
          };
        })
      };
    });

    return {
      cycleId: poc.cycleId, cycleLabel: poc.cycleLabel,
      category: poc.category, stream: poc.stream, asOf: poc.asOf,
      rows: Util.sortBy(rows, [{ pick: function (r) { return r.regionName; } }]),
      totals: poc.totals
    };
  }

  // =========================================================================
  // Weekly plan vs achievement — achievement is now computed
  // =========================================================================

  function weeklyPlanReview(cycleIdValue, weekStartValue) {
    Auth.require(PERM.DASHBOARD_VIEW);
    var ctx = context(cycleIdValue);
    var sc = Auth.scope();
    var ws = DateUtil.startOfWeek(weekStartValue || ctx.asOf);
    var days = [];
    for (var i = 0; i < 7; i++) days.push(DateUtil.addDays(ws, i));

    var plans = Repository.where(SHEET.WEEKLY_PLAN, { cycleId: ctx.cycle.cycleId })
      .filter(function (p) {
        return DateUtil.isoDate(p.weekStart) === DateUtil.isoDate(ws) &&
          Auth.inScope(sc, p.pocUserId, p.category, p.regionId);
      });
    var byPoc = Util.groupBy(plans, function (p) { return p.pocUserId; });

    var rows = Object.keys(byPoc).map(function (pid) {
      var mine = byPoc[pid];
      var byDate = Util.indexBy(mine, function (p) { return DateUtil.isoDate(p.planDate); });
      var es = Engine.scope({ category: ctx.cycle.category, stream: STREAM.SUPPLY, pocUserId: pid });

      var daily = days.map(function (d) {
        var iso = DateUtil.isoDate(d);
        var hit = byDate[iso];
        var dayWindow = { kind: 'DAY', start: d, end: DateUtil.addDays(d, 1), asOf: d };
        var achieved = d <= ctx.asOf
          ? Engine.metric('TONNAGE_MT', dayWindow, es, { trace: false }).value : null;
        var target = hit ? Util.num(hit.tonnageTargetMT, 0) : 0;
        return {
          date: iso,
          dayLabel: Utilities.formatDate(d, APP.TIMEZONE, 'EEE dd'),
          target: Util.round(target, 3),
          achieved: achieved === null ? null : Util.round(achieved, 3),
          achievementPct: achieved === null ? null : Util.div(achieved, target, 0),
          future: d > ctx.asOf
        };
      });

      var weekTarget = Util.sum(daily, function (d) { return d.target; });
      var weekAchieved = Util.sum(daily, function (d) { return d.achieved || 0; });
      return {
        pocUserId: pid, pocName: userName(ctx, pid),
        regionId: mine[0].regionId, regionName: regionName(ctx, mine[0].regionId),
        weeklyTargetMT: Util.round(weekTarget, 3),
        weeklyAchievedMT: Util.round(weekAchieved, 3),
        achievementPct: Util.div(weekAchieved, weekTarget, 0),
        daily: daily
      };
    });

    return {
      cycleId: ctx.cycle.cycleId, cycleLabel: ctx.cycle.label,
      weekStart: DateUtil.isoDate(ws),
      weekEnd: DateUtil.isoDate(DateUtil.addDays(ws, 6)),
      asOf: DateUtil.isoDate(ctx.asOf),
      days: days.map(function (d) {
        return { date: DateUtil.isoDate(d), label: Utilities.formatDate(d, APP.TIMEZONE, 'EEE dd MMM') };
      }),
      rows: Util.sortBy(rows, [{ pick: function (r) { return r.regionName; } },
      { pick: function (r) { return r.pocName; } }]),
      totals: {
        targetMT: Util.round(Util.sum(rows, function (r) { return r.weeklyTargetMT; }), 3),
        achievedMT: Util.round(Util.sum(rows, function (r) { return r.weeklyAchievedMT; }), 3)
      }
    };
  }

  // =========================================================================
  // Coverage — Onboarded Sellers VS Pulse
  // =========================================================================

  function coverage(cycleIdValue, asOfValue, options) {
    Auth.require(PERM.DASHBOARD_VIEW);
    options = options || {};
    var ctx = context(cycleIdValue, asOfValue);
    var sc = Auth.scope();
    var accountType = options.accountType || 'SELLER';
    var fs = Engine.facts(ctx.cycle.category);

    var visitsByGstin = {}, lmtdVisitsByGstin = {}, lastVisit = {};
    fs.pulse.forEach(function (p) {
      if (p.onLeave || !p.gstin) return;
      var g = Util.key(p.gstin);
      if (DateUtil.inWindow(p.visitDate, ctx.windows.mtd)) {
        visitsByGstin[g] = (visitsByGstin[g] || 0) + Util.num(p.visitCount, 0);
      }
      if (DateUtil.inWindow(p.visitDate, ctx.windows.lmtd)) {
        lmtdVisitsByGstin[g] = (lmtdVisitsByGstin[g] || 0) + Util.num(p.visitCount, 0);
      }
      if (!lastVisit[g] || p.visitDate > lastVisit[g]) lastVisit[g] = p.visitDate;
    });

    var txnByGstin = {};
    fs.shipments.forEach(function (s) {
      if (!s.isValidTxn || !DateUtil.inWindow(s.txnDate, ctx.windows.mtd)) return;
      var g = Util.key(accountType === 'BUYER' ? s.buyerGstin : s.sellerGstin);
      if (g) txnByGstin[g] = (txnByGstin[g] || 0) + 1;
    });

    var rows = fs.accounts
      .filter(function (a) {
        return a.accountType === accountType &&
          Auth.inScope(sc, a.pocUserId, a.category, a.regionId) &&
          (!options.pocUserId || a.pocUserId === options.pocUserId) &&
          (!options.regionId || a.regionId === options.regionId);
      })
      .map(function (a) {
        var g = Util.key(a.gstin);
        return {
          accountId: a.accountId, gstin: a.gstin, businessName: a.businessName,
          regionId: a.regionId, regionName: regionName(ctx, a.regionId),
          pocUserId: a.pocUserId, pocName: userName(ctx, a.pocUserId),
          onboardingStatus: a.onboardingStatus,
          onboardedDate: DateUtil.isoDate(a.onboardedDate),
          mtdVisits: visitsByGstin[g] || 0,
          lmtdVisits: lmtdVisitsByGstin[g] || 0,
          lastVisitDate: DateUtil.isoDate(lastVisit[g] || a.lastVisitDate),
          mtdTxns: txnByGstin[g] || 0,
          visited: (visitsByGstin[g] || 0) > 0,
          transacted: (txnByGstin[g] || 0) > 0
        };
      });

    var onboarded = rows.filter(function (r) {
      return Util.key(r.onboardingStatus) === 'COMPLETED';
    });

    return {
      cycleId: ctx.cycle.cycleId, cycleLabel: ctx.cycle.label,
      asOf: DateUtil.isoDate(ctx.asOf), accountType: accountType,
      summary: {
        onboardedCount: onboarded.length,
        visitedCount: onboarded.filter(function (r) { return r.visited; }).length,
        transactedCount: onboarded.filter(function (r) { return r.transacted; }).length,
        visitCoveragePct: Util.div(onboarded.filter(function (r) { return r.visited; }).length, onboarded.length, 0),
        txnCoveragePct: Util.div(onboarded.filter(function (r) { return r.transacted; }).length, onboarded.length, 0),
        neitherCount: onboarded.filter(function (r) { return !r.visited && !r.transacted; }).length
      },
      rows: Util.sortBy(rows, [
        { pick: function (r) { return r.mtdTxns; } },
        { pick: function (r) { return r.mtdVisits; } }
      ])
    };
  }

  // =========================================================================
  // Account performance — OMP-Sellers / OMP-Buyers, fully generated
  // =========================================================================

  function accountPerformance(cycleIdValue, asOfValue, options) {
    Auth.require(PERM.DASHBOARD_VIEW);
    options = options || {};
    var ctx = context(cycleIdValue, asOfValue);
    var sc = Auth.scope();
    var accountType = options.accountType || 'SELLER';
    var stream = accountType === 'BUYER' ? STREAM.DEMAND : STREAM.SUPPLY;

    var plans = Util.indexBy(
      Repository.where(SHEET.ACCOUNT_PLAN, { cycleId: ctx.cycle.cycleId })
        .filter(function (p) { return p.active !== false && p.accountType === accountType; }),
      function (p) { return Util.key(p.gstin); });

    var fs = Engine.facts(ctx.cycle.category);

    // Month-on-month series for the trailing four months.
    var monthWindows = [];
    for (var back = 3; back >= 0; back--) {
      var m = DateUtil.addMonths(new Date(ctx.cycle.year, ctx.cycle.month - 1, 1), -back);
      monthWindows.push({
        label: Utilities.formatDate(m, APP.TIMEZONE, 'MMM yy'),
        window: back === 0 ? ctx.windows.mtd : DateUtil.window('MONTH', m)
      });
    }

    var rows = fs.accounts
      .filter(function (a) {
        return a.accountType === accountType &&
          Auth.inScope(sc, a.pocUserId, a.category, a.regionId) &&
          (!options.pocUserId || a.pocUserId === options.pocUserId) &&
          (!options.regionId || a.regionId === options.regionId) &&
          (!options.materialType || a.materialType === options.materialType);
      })
      .map(function (a) {
        var es = Engine.scope({
          category: ctx.cycle.category, stream: stream, gstin: a.gstin
        });
        var plan = plans[Util.key(a.gstin)] || {};
        var mtdTxn = Engine.metric('TXN_COUNT', ctx.windows.mtd, es, { trace: false }).value;
        var mtdTon = Engine.metric('TONNAGE_MT', ctx.windows.mtd, es, { trace: false }).value;
        var mtdGmv = Engine.metric('GMV_CR', ctx.windows.mtd, es, { trace: false }).value;
        var lmtdTxn = Engine.metric('TXN_COUNT', ctx.windows.lmtd, es, { trace: false }).value;
        var lmtdTon = Engine.metric('TONNAGE_MT', ctx.windows.lmtd, es, { trace: false }).value;
        var lmtdGmv = Engine.metric('GMV_CR', ctx.windows.lmtd, es, { trace: false }).value;

        return {
          accountId: a.accountId, gstin: a.gstin, accountName: a.businessName,
          regionId: a.regionId, regionName: regionName(ctx, a.regionId),
          pocUserId: a.pocUserId, pocName: userName(ctx, a.pocUserId),
          materialType: a.materialType, state: a.state, city: a.city,
          counterpartyName: a.counterpartyName, paymentTerms: a.paymentTerms,
          fytd: {
            txnCount: Engine.metric('TXN_COUNT', ctx.windows.fytd, es, { trace: false }).value,
            tonnageMT: Util.round(Engine.metric('TONNAGE_MT', ctx.windows.fytd, es, { trace: false }).value, 3),
            gmvCr: Util.round(Engine.metric('GMV_CR', ctx.windows.fytd, es, { trace: false }).value, 4)
          },
          monthly: monthWindows.map(function (mw) {
            return {
              label: mw.label,
              txnCount: Engine.metric('TXN_COUNT', mw.window, es, { trace: false }).value,
              tonnageMT: Util.round(Engine.metric('TONNAGE_MT', mw.window, es, { trace: false }).value, 3),
              gmvCr: Util.round(Engine.metric('GMV_CR', mw.window, es, { trace: false }).value, 6)
            };
          }),
          target: {
            txnTarget: Util.num(plan.txnTarget, 0),
            tonnageTargetMT: Util.num(plan.tonnageTargetMT, 0),
            ratePerKgTarget: Util.num(plan.ratePerKgTarget, 0),
            gmvTargetCr: Util.num(plan.gmvTargetCr, 0)
          },
          achieved: {
            txnCount: mtdTxn,
            tonnageMT: Util.round(mtdTon, 3),
            gmvCr: Util.round(mtdGmv, 6),
            ratePerKg: Util.round(Engine.metric('RATE_PER_KG', ctx.windows.mtd, es, { trace: false }).value, 2)
          },
          lmtd: { txnCount: lmtdTxn, tonnageMT: Util.round(lmtdTon, 3), gmvCr: Util.round(lmtdGmv, 6) },
          achievementPct: {
            txn: Util.div(mtdTxn, plan.txnTarget, 0),
            tonnage: Util.div(mtdTon, plan.tonnageTargetMT, 0),
            gmv: Util.div(mtdGmv, plan.gmvTargetCr, 0)
          },
          growthPct: {
            txn: Util.div(mtdTxn - lmtdTxn, lmtdTxn, 0),
            tonnage: Util.div(mtdTon - lmtdTon, lmtdTon, 0),
            gmv: Util.div(mtdGmv - lmtdGmv, lmtdGmv, 0)
          },
          remarks: plan.remarks || a.remarks || '',
          detailedRemarks: plan.detailedRemarks || '',
          blockerReason: plan.blockerReason || a.blockerReason || ''
        };
      });

    return {
      cycleId: ctx.cycle.cycleId, cycleLabel: ctx.cycle.label,
      accountType: accountType, asOf: DateUtil.isoDate(ctx.asOf),
      monthLabels: monthWindows.map(function (m) { return m.label; }),
      rows: Util.sortBy(rows, [{ pick: function (r) { return -r.achieved.gmvCr; } }]),
      totals: {
        txnTarget: Util.sum(rows, function (r) { return r.target.txnTarget; }),
        txnAchieved: Util.sum(rows, function (r) { return r.achieved.txnCount; }),
        tonnageTargetMT: Util.round(Util.sum(rows, function (r) { return r.target.tonnageTargetMT; }), 3),
        tonnageAchievedMT: Util.round(Util.sum(rows, function (r) { return r.achieved.tonnageMT; }), 3),
        gmvTargetCr: Util.round(Util.sum(rows, function (r) { return r.target.gmvTargetCr; }), 6),
        gmvAchievedCr: Util.round(Util.sum(rows, function (r) { return r.achieved.gmvCr; }), 6)
      }
    };
  }

  return {
    context: context,
    scorecardFor: scorecardFor,
    leaderboard: leaderboard,
    dailyReview: dailyReview,
    pocWise: pocWise,
    regionWise: regionWise,
    weeklyPlanReview: weeklyPlanReview,
    coverage: coverage,
    accountPerformance: accountPerformance,
    REVIEW_METRICS: REVIEW_METRICS
  };
})();
