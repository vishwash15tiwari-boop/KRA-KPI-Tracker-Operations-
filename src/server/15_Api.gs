/**
 * 15_Api.gs — The single RPC surface between the browser and the server.
 *
 * The client calls exactly one function, `api(action, payload)`. That gives one
 * place for authentication, authorisation, error shaping, timing and audit,
 * instead of scattering `google.script.run` handlers across the codebase.
 *
 * Every response has the same envelope:
 *   { ok: true,  data, meta }
 *   { ok: false, error: { code, message, details }, meta }
 *
 * The client never sees a raw stack trace; it sees a stable `code` it can branch
 * on and a message written for the person reading it.
 */

/** Action → handler. Each handler receives the (already parsed) payload. */
var API_ROUTES = {

  // ---- Session ------------------------------------------------------------
  'session.bootstrap': function () { return bootstrapPayload_(); },
  'session.me': function () { return Auth.current(); },
  'session.health': function () { Auth.require(PERM.CONFIG_MANAGE); return Bootstrap.health(); },

  // ---- Setup --------------------------------------------------------------
  'setup.run': function (p) { return Bootstrap.setup(p || {}); },
  'setup.installTriggers': function () { return Bootstrap.installTriggers(); },

  // ---- Planning: cycles ---------------------------------------------------
  'cycle.list': function (p) { return Planning.listCycles(p); },
  'cycle.active': function (p) { return Planning.activeCycle(p && p.category); },
  'cycle.get': function (p) { return Planning.getCycle(p.cycleId); },
  'cycle.create': function (p) { return Planning.createCycle(p); },
  'cycle.update': function (p) { return Planning.updateCycle(p.cycleId, p); },
  'cycle.validate': function (p) { return Planning.validateCycle(p.cycleId); },
  'cycle.publish': function (p) { return Planning.publishCycle(p.cycleId); },
  'cycle.lock': function (p) { return Planning.lockCycle(p.cycleId); },
  'cycle.close': function (p) { return Planning.closeCycle(p.cycleId); },
  'cycle.reopen': function (p) { return Planning.reopenCycle(p.cycleId); },

  // ---- Planning: KRA / KPI ------------------------------------------------
  'kra.tree': function (p) { return Planning.getKraTree(p.cycleId); },
  'kra.save': function (p) { return Planning.saveKra(p); },
  'kra.delete': function (p) { return Planning.deleteKra(p.kraId); },
  'kpi.save': function (p) { return Planning.saveKpi(p); },
  'kpi.delete': function (p) { return Planning.deleteKpi(p.kpiId); },
  'kpi.library': function () { return Bootstrap.kraLibrary(); },

  // ---- Planning: assignments ---------------------------------------------
  'assignment.list': function (p) { return Planning.listAssignments(p.cycleId); },
  'assignment.assign': function (p) { return Planning.assignKpis(p); },
  'assignment.update': function (p) { return Planning.updateAssignment(p.assignmentId, p); },
  'assignment.remove': function (p) { return Planning.removeAssignment(p.assignmentId); },

  // ---- Planning: account plan --------------------------------------------
  'accountPlan.list': function (p) { return Planning.listAccountPlans(p.cycleId, p); },
  'accountPlan.save': function (p) { return Planning.saveAccountPlan(p); },
  'accountPlan.saveBatch': function (p) { return Planning.saveAccountPlanBatch(p.cycleId, p.rows); },
  'accountPlan.delete': function (p) { return Planning.deleteAccountPlan(p.planId); },
  'accountPlan.import': function (p) { return Sync.importAccountPlan(p); },

  // ---- Planning: annual + weekly -----------------------------------------
  'onboardingPlan.list': function (p) { return Planning.listOnboardingPlans(p.fiscalYear, p.category); },
  'onboardingPlan.save': function (p) { return Planning.saveOnboardingPlan(p); },
  'weeklyPlan.get': function (p) { return Planning.listWeeklyPlan(p.cycleId, p.weekStart); },
  'weeklyPlan.save': function (p) { return Planning.saveWeeklyPlan(p.cycleId, p.entries); },
  'weeklyPlan.review': function (p) { return Reports.weeklyPlanReview(p.cycleId, p.weekStart); },

  // ---- Accounts and pipeline ---------------------------------------------
  'account.list': function (p) { return Accounts.list(p); },
  'account.get': function (p) { return Accounts.get(p.accountId); },
  'account.save': function (p) { return Accounts.save(p); },
  'account.reassign': function (p) { return Accounts.reassign(p.accountIds, p.pocUserId); },
  'pipeline.list': function (p) { return Accounts.listPipeline(p); },
  'pipeline.save': function (p) { return Accounts.savePipeline(p); },
  'pipeline.setDocument': function (p) { return Accounts.setDocument(p); },
  'receivable.list': function (p) { return Accounts.listReceivables(p.cycleId); },
  'receivable.save': function (p) { return Accounts.saveReceivable(p); },

  // ---- Execution ----------------------------------------------------------
  'activity.types': function () { return Activity.types(); },
  'activity.list': function (p) { return Activity.list(p); },
  'activity.get': function (p) { return Activity.get(p.activityId); },
  'activity.save': function (p) { return Activity.save(p); },
  'activity.saveBatch': function (p) { return Activity.saveBatch(p.entries); },
  'activity.void': function (p) { return Activity.voidActivity(p.activityId, p.reason); },
  'activity.verify': function (p) { return Activity.verify(p.activityId, p.decision, p.note); },
  'activity.markLeave': function (p) { return Activity.markLeave(p); },
  'activity.myDay': function (p) { return Activity.myDay(p && p.cycleId, p && p.date); },
  'activity.drilldown': function (p) { return Activity.drilldown(p); },

  // ---- Measurement --------------------------------------------------------
  'dashboard.executive': function (p) { return Dashboard.executive(p.cycleId, p.asOf, p); },
  'dashboard.trend': function (p) { return Dashboard.trend(p.cycleId, p.metricKey, p); },
  'dashboard.history': function (p) { return Dashboard.history(p.cycleId, p.metricKey, p); },
  'dashboard.alerts': function (p) { return Dashboard.alerts(p.cycleId, p); },
  'dashboard.dataQuality': function (p) { return Dashboard.dataQuality(p.cycleId); },
  'dashboard.snapshot': function (p) {
    Auth.require(PERM.CONFIG_MANAGE);
    return Dashboard.takeSnapshot(p.cycleId, p.asOf);
  },

  'report.dailyReview': function (p) { return Reports.dailyReview(p.cycleId, p.asOf, p); },
  'report.pocWise': function (p) { return Reports.pocWise(p.cycleId, p.asOf, p); },
  'report.regionWise': function (p) { return Reports.regionWise(p.cycleId, p.asOf, p); },
  'report.scorecard': function (p) {
    return Reports.scorecardFor(p.cycleId, p.pocUserId || Auth.current().userId);
  },
  'report.leaderboard': function (p) { return Reports.leaderboard(p.cycleId, p.asOf); },
  'report.coverage': function (p) { return Reports.coverage(p.cycleId, p.asOf, p); },
  'report.accountPerformance': function (p) { return Reports.accountPerformance(p.cycleId, p.asOf, p); },
  'report.export': function (p) { return Admin.exportReport(p.reportKey, p); },
  'report.exportCsv': function (p) { return Admin.exportCsv(p.reportKey, p); },

  // ---- Review -------------------------------------------------------------
  'review.list': function (p) { return Review.list(p); },
  'review.get': function (p) { return Review.get(p.reviewId); },
  'review.open': function (p) { return Review.open(p); },
  'review.share': function (p) { return Review.share(p.reviewId); },
  'review.acknowledge': function (p) { return Review.acknowledge(p.reviewId, p.response); },
  'review.signOff': function (p) { return Review.signOff(p.reviewId, p.note); },
  'review.pack': function (p) { return Review.reviewPack(p.cycleId); },
  'action.list': function (p) { return Review.listActions(p); },
  'action.save': function (p) { return Review.saveAction(p); },
  'action.fromAlert': function (p) { return Review.actionFromAlert(p.alert); },

  // ---- Administration -----------------------------------------------------
  'user.list': function (p) { return Admin.listUsers(p); },
  'user.save': function (p) { return Admin.saveUser(p); },
  'user.merge': function (p) { return Admin.mergeUser(p.sourceUserId, p.targetUserId); },
  'region.list': function (p) { return Admin.listRegions(p && p.category); },
  'region.save': function (p) { return Admin.saveRegion(p); },
  'config.list': function () { return Admin.listConfig(); },
  'config.set': function (p) { return Admin.setConfig(p.key, p.value); },
  'audit.recent': function (p) { return Audit.recent(p && p.limit, p); },

  // ---- Sync ---------------------------------------------------------------
  'sync.inspect': function (p) { return Sync.inspectSource(p.spreadsheetId); },
  'sync.shipments': function (p) { return Sync.syncShipments(p); },
  'sync.onboarding': function (p) { return Sync.syncOnboarding(p); },
  'sync.pulse': function (p) { return Sync.syncPulse(p); },
  'sync.all': function (p) { return Sync.syncAll(p); },
  'sync.history': function (p) { return Sync.history(p && p.limit); }
};

/**
 * The RPC entry point. Called from the client as
 *   google.script.run.withSuccessHandler(...).api(action, payload)
 */
function api(action, payload) {
  var started = Date.now();
  try {
    var handler = API_ROUTES[action];
    if (!handler) fail('UNKNOWN_ACTION', 'Unknown action: ' + action);

    // session.bootstrap checks Bootstrap.health() itself and returns
    // { needsSetup: true } instead of an identity when the schema does not
    // exist yet — it must run before any identity lookup is possible.
    // setup.run is how that schema gets created in the first place.
    if (action !== 'setup.run' && action !== 'session.bootstrap') Auth.current();

    var data = handler(payload || {});
    return {
      ok: true,
      data: data === undefined ? null : data,
      meta: { action: action, ms: Date.now() - started, serverTime: DateUtil.isoDateTime(new Date()) }
    };
  } catch (e) {
    var code = (e && e.code) || 'ERROR';
    var message = (e && e.message) || String(e);
    if (code === 'ERROR') console.error(action + ' failed: ' + message + '\n' + (e && e.stack));
    return {
      ok: false,
      error: {
        code: code,
        message: message,
        details: (e && e.details) || null
      },
      meta: { action: action, ms: Date.now() - started }
    };
  } finally {
    // Fact caches are per-execution; clearing them keeps a warm instance honest.
    Engine.invalidate();
    Repository.invalidate();
  }
}

/**
 * Everything the shell needs to render on first paint, in one round trip:
 * identity, permissions, the active cycle, reference data and enumerations.
 */
function bootstrapPayload_() {
  var health = Bootstrap.health();
  if (!health.ok) {
    return {
      needsSetup: true,
      health: health,
      app: { name: APP.NAME, version: APP.VERSION, timezone: APP.TIMEZONE }
    };
  }

  var user = Auth.current();
  var category = user.category === 'ALL' ? Config.get('DEFAULT_CATEGORY') : user.category;
  var cycle = Planning.activeCycle(category);
  var cycles = Planning.listCycles({});

  return {
    needsSetup: false,
    app: {
      name: APP.NAME, shortName: APP.SHORT_NAME, version: APP.VERSION,
      timezone: APP.TIMEZONE, support: APP.SUPPORT
    },
    user: {
      userId: user.userId, email: user.email, fullName: user.fullName,
      role: user.role, roleRank: user.roleRank, category: user.category,
      regionId: user.regionId, regionName: user.regionName,
      stream: user.stream, permissions: user.permissions
    },
    scope: (function () {
      var s = Auth.scope();
      return { level: s.level, categories: s.categories, regionIds: s.regionIds };
    })(),
    activeCycle: cycle ? {
      cycleId: cycle.cycleId, label: cycle.label, status: cycle.status,
      category: cycle.category, year: cycle.year, month: cycle.month,
      workingDays: cycle.workingDays,
      startDate: DateUtil.isoDate(cycle.startDate),
      endDate: DateUtil.isoDate(cycle.endDate)
    } : null,
    cycles: cycles.map(function (c) {
      return {
        cycleId: c.cycleId, label: c.label, status: c.status,
        category: c.category, year: c.year, month: c.month
      };
    }),
    reference: {
      categories: CATEGORIES,
      streams: STREAMS,
      roles: Object.keys(ROLE),
      cycleStatuses: Object.keys(CYCLE_STATUS),
      materialTypes: MATERIAL_TYPES,
      sellerTypes: SELLER_TYPES,
      paymentTerms: PAYMENT_TERMS,
      blockerReasons: BLOCKER_REASONS,
      pipelineStages: Object.keys(PIPELINE_STAGE),
      documentSlots: DOCUMENT_SLOTS,
      activityTypes: Activity.types(),
      metrics: Object.keys(METRICS).map(function (k) {
        return {
          key: k, label: METRICS[k].label, unit: METRICS[k].unit,
          stream: METRICS[k].stream, direction: METRICS[k].direction || DIRECTION.HIGHER_BETTER
        };
      }),
      targetBases: Object.keys(TARGET_BASIS),
      ratingScale: RATING_SCALE,
      regions: Admin.listRegions(),
      users: Admin.listUsers({}),
      exportable: Admin.EXPORTABLE
    },
    settings: {
      asOf: DateUtil.isoDate(DateUtil.asOf()),
      today: DateUtil.isoDate(DateUtil.today()),
      fiscalYear: DateUtil.fiscalYearLabel(new Date()),
      achievementCap: Config.get('ACHIEVEMENT_CAP'),
      gmvBasis: Config.get('GMV_BASIS'),
      reportingLagDays: Config.get('REPORTING_LAG_DAYS'),
      backdateDays: Config.get('ACTIVITY_BACKDATE_DAYS'),
      currencySymbol: Config.get('CURRENCY_SYMBOL')
    }
  };
}
