/**
 * 09_Activity.gs — "Update Once".
 *
 * This is the only place a POC types anything during execution. They record the
 * work they did; the engine derives every KPI, percentage, score and dashboard
 * from these rows. No POC ever updates a tracker, a report or a dashboard.
 *
 * Three invariants make traceability real:
 *   1. An activity always carries who, when, which account, which KPI, the
 *      remark and — where the activity type demands it — the evidence link.
 *   2. Activities are never deleted; they are voided with a reason, so a number
 *      that changed can always be explained.
 *   3. System-synced facts (shipments, onboarding) are read-only here. A POC
 *      annotates them; they cannot invent a transaction.
 */

var Activity = (function () {

  function typeDef(key) {
    var t = ACTIVITY_TYPES.filter(function (x) { return x.key === key; })[0];
    assert(t, 'VALIDATION', 'Unknown activity type: ' + key);
    return t;
  }

  function types() {
    return ACTIVITY_TYPES.map(function (t) {
      return {
        key: t.key, label: t.label, icon: t.icon, stream: t.stream,
        measures: t.measures, requiresAccount: t.requiresAccount,
        evidence: t.evidence, systemOwned: t.systemOwned, help: t.help,
        metrics: t.metrics
      };
    });
  }

  // =========================================================================
  // Read
  // =========================================================================

  function list(filterSpec) {
    filterSpec = filterSpec || {};
    var sc = Auth.scope();
    var users = Util.indexBy(Repository.readAll(SHEET.USERS), function (u) { return u.userId; });
    var from = filterSpec.from ? DateUtil.parse(filterSpec.from) : null;
    var to = filterSpec.to ? DateUtil.parse(filterSpec.to) : null;

    var rows = Repository.readAll(SHEET.ACTIVITIES).filter(function (a) {
      if (a.voided && !filterSpec.includeVoided) return false;
      if (!Auth.inScope(sc, a.pocUserId, a.category, a.regionId)) return false;
      if (filterSpec.cycleId && a.cycleId !== filterSpec.cycleId) return false;
      if (filterSpec.category && a.category !== filterSpec.category) return false;
      if (filterSpec.pocUserId && a.pocUserId !== filterSpec.pocUserId) return false;
      if (filterSpec.regionId && a.regionId !== filterSpec.regionId) return false;
      if (filterSpec.activityType && a.activityType !== filterSpec.activityType) return false;
      if (filterSpec.accountId && a.accountId !== filterSpec.accountId) return false;
      if (filterSpec.kpiId && a.kpiId !== filterSpec.kpiId) return false;
      if (filterSpec.verificationStatus && a.verificationStatus !== filterSpec.verificationStatus) return false;
      if (from && (!a.activityDate || a.activityDate < from)) return false;
      if (to && (!a.activityDate || a.activityDate > to)) return false;
      if (filterSpec.search) {
        var q = Util.key(filterSpec.search);
        var hay = Util.key(a.accountName) + ' ' + Util.key(a.remarks) + ' ' + Util.key(a.gstin);
        if (hay.indexOf(q) < 0) return false;
      }
      return true;
    });

    rows = Util.sortBy(rows, [
      { pick: function (a) { return a.activityDate ? a.activityDate.getTime() : 0; }, dir: 'desc' },
      { pick: function (a) { return a.createdAt ? a.createdAt.getTime() : 0; }, dir: 'desc' }
    ]);

    var limited = filterSpec.limit ? rows.slice(0, filterSpec.limit) : rows;
    return limited.map(function (a) { return shape_(a, users); });
  }

  function shape_(a, users) {
    var t = ACTIVITY_TYPES.filter(function (x) { return x.key === a.activityType; })[0];
    return {
      activityId: a.activityId, cycleId: a.cycleId, category: a.category, stream: a.stream,
      activityType: a.activityType,
      activityTypeLabel: t ? t.label : a.activityType,
      activityDate: DateUtil.isoDate(a.activityDate),
      pocUserId: a.pocUserId,
      pocName: users && users[a.pocUserId] ? users[a.pocUserId].fullName : a.pocUserId,
      regionId: a.regionId,
      accountId: a.accountId, accountType: a.accountType,
      gstin: a.gstin, accountName: a.accountName,
      kraId: a.kraId, kpiId: a.kpiId, metricKey: a.metricKey,
      count: Util.num(a.count, 0),
      quantityMT: Util.num(a.quantityMT, 0),
      ratePerKg: Util.num(a.ratePerKg, 0),
      amountINR: Util.num(a.amountINR, 0),
      status: a.status, blockerReason: a.blockerReason,
      remarks: a.remarks, evidenceUrl: a.evidenceUrl, evidenceType: a.evidenceType,
      verificationStatus: a.verificationStatus, verifiedBy: a.verifiedBy,
      verifiedAt: DateUtil.isoDateTime(a.verifiedAt), verifyNote: a.verifyNote,
      sourceSystem: a.sourceSystem, sourceRef: a.sourceRef,
      systemOwned: !!(t && t.systemOwned) || String(a.sourceSystem || '').indexOf('SYNC') === 0,
      voided: !!a.voided, voidReason: a.voidReason,
      createdBy: a.createdBy, createdAt: DateUtil.isoDateTime(a.createdAt),
      updatedBy: a.updatedBy, updatedAt: DateUtil.isoDateTime(a.updatedAt)
    };
  }

  function get(activityId) {
    var a = Repository.findById(SHEET.ACTIVITIES, activityId);
    assert(a, 'NOT_FOUND', 'Activity not found.');
    var sc = Auth.scope();
    assert(Auth.inScope(sc, a.pocUserId, a.category, a.regionId), 'FORBIDDEN',
      'That activity is outside your scope.');
    return shape_(a, Util.indexBy(Repository.readAll(SHEET.USERS), function (u) { return u.userId; }));
  }

  // =========================================================================
  // Write
  // =========================================================================

  /**
   * Record work. Validation is deliberately strict at the point of entry —
   * catching a missing evidence link now is far cheaper than reconciling an
   * unexplained dashboard number at the monthly review.
   */
  function save(payload) {
    var user = Auth.require(PERM.ACTIVITY_WRITE);
    var def = typeDef(payload.activityType);

    assert(!def.systemOwned || Auth.can(PERM.ACTIVITY_WRITE_ANY, user), 'FORBIDDEN',
      def.label + ' records are created by the system sync and cannot be entered by hand. ' +
      'Add a remark against the synced record instead.');

    var cycle = Planning.getCycle(payload.cycleId);
    assert(cycle.status === CYCLE_STATUS.PUBLISHED, 'CYCLE_NOT_OPEN',
      cycle.label + ' is ' + cycle.status + '. Work can only be recorded against a published cycle.');

    var pocUserId = payload.pocUserId || user.userId;
    Auth.requireOwnership(pocUserId, user);
    var poc = Repository.findById(SHEET.USERS, pocUserId);
    assert(poc, 'VALIDATION', 'The selected POC does not exist.');

    var activityDate = DateUtil.parse(payload.activityDate) || DateUtil.today();
    assertDateAllowed_(activityDate, cycle, user);

    var account = null;
    if (def.requiresAccount) {
      account = payload.accountId ? Repository.findById(SHEET.ACCOUNTS, payload.accountId) : null;
      if (!account && payload.gstin) account = Accounts.findByGstin(payload.gstin, cycle.category);
      assert(account, 'VALIDATION',
        'Select the seller or buyer this ' + def.label.toLowerCase() + ' relates to.');
    }

    if (def.evidence === 'REQUIRED') {
      assert(!Util.isBlank(payload.evidenceUrl), 'VALIDATION',
        def.label + ' requires supporting evidence. Paste the link to the photo, ' +
        'document or system record.');
      Accounts.assertEvidenceUrl(payload.evidenceUrl);
    } else if (!Util.isBlank(payload.evidenceUrl)) {
      Accounts.assertEvidenceUrl(payload.evidenceUrl);
    }

    assert(!Util.isBlank(payload.remarks), 'VALIDATION',
      'Add a short remark describing what happened. This is what leadership reads at review.');

    def.measures.forEach(function (m) {
      var v = payload[m.key];
      if (v === undefined || v === '') return;
      assert(Util.num(v, -1) >= 0, 'VALIDATION', m.label + ' cannot be negative.');
    });

    // Resolve the KPI this activity feeds, so the dashboard tile can drill
    // straight back to it.
    var link = resolveKpiLink_(cycle, def, pocUserId, payload);

    var row = {
      activityId: payload.activityId || Id.next('ACT'),
      cycleId: cycle.cycleId, category: cycle.category,
      stream: link.stream || (def.stream === 'BOTH' ? '' : def.stream),
      activityType: def.key, activityDate: activityDate,
      pocUserId: pocUserId, regionId: poc.regionId || (account ? account.regionId : ''),
      accountId: account ? account.accountId : '',
      accountType: account ? account.accountType : '',
      gstin: account ? account.gstin : '',
      accountName: account ? account.businessName : Util.str(payload.accountName),
      kraId: link.kraId, kpiId: link.kpiId, metricKey: link.metricKey,
      count: Util.num(payload.count, def.measures.length ? 0 : 1) || (def.measures.length ? 0 : 1),
      quantityMT: Util.num(payload.quantityMT, 0),
      ratePerKg: Util.num(payload.ratePerKg, 0),
      amountINR: Util.num(payload.amountINR, 0),
      status: Util.str(payload.status) || 'RECORDED',
      blockerReason: Util.str(payload.blockerReason),
      remarks: Util.str(payload.remarks),
      evidenceUrl: Util.str(payload.evidenceUrl),
      evidenceType: Util.str(payload.evidenceType) || (payload.evidenceUrl ? 'LINK' : ''),
      verificationStatus: def.evidence === 'REQUIRED' ? 'PENDING' : 'NOT_REQUIRED',
      sourceSystem: 'APP',
      sourceRef: Util.str(payload.sourceRef),
      voided: false
    };

    if (payload.activityId) {
      var existing = Repository.findById(SHEET.ACTIVITIES, payload.activityId);
      assert(existing, 'NOT_FOUND', 'Activity not found.');
      assert(!existing.voided, 'INVALID_STATE', 'A voided activity cannot be edited.');
      Auth.requireOwnership(existing.pocUserId, user);
      assert(String(existing.sourceSystem || '').indexOf('SYNC') !== 0 ||
        Auth.can(PERM.ACTIVITY_WRITE_ANY, user), 'FORBIDDEN',
        'Synced records cannot be edited.');
      row.verificationStatus = existing.verificationStatus === 'VERIFIED'
        ? 'PENDING' : row.verificationStatus;  // an edit re-opens verification
      row.createdAt = existing.createdAt;
      row.createdBy = existing.createdBy;
    }

    var saved = Repository.transaction(function () {
      var out = Repository.upsert(SHEET.ACTIVITIES, row);
      if (account) touchAccount_(account, def, activityDate);
      // A field visit is also a pulse fact, so coverage metrics see it.
      if (def.key === ACTIVITY_TYPE.FIELD_VISIT) writePulse_(out, poc, account);
      return out;
    });

    Engine.invalidate();
    Audit.log(payload.activityId ? 'ACTIVITY_UPDATE' : 'ACTIVITY_CREATE', SHEET.ACTIVITIES,
      saved.activityId,
      def.label + ' · ' + (saved.accountName || '—') + ' · ' + DateUtil.isoDate(activityDate),
      null, saved);
    return shape_(saved, null);
  }

  /**
   * A POC may log today and a short window backwards; anything older needs a
   * Team Lead. Without this, a month's numbers would never settle.
   */
  function assertDateAllowed_(activityDate, cycle, user) {
    var today = DateUtil.today();
    assert(activityDate <= today, 'VALIDATION', 'Work cannot be recorded for a future date.');
    assert(activityDate >= cycle.startDate && activityDate <= cycle.endDate, 'VALIDATION',
      'The date must fall inside ' + cycle.label + '.');
    if (Auth.can(PERM.ACTIVITY_WRITE_ANY, user)) return;
    var maxBack = Config.get('ACTIVITY_BACKDATE_DAYS');
    var age = DateUtil.diffDays(activityDate, today);
    assert(age <= maxBack, 'VALIDATION',
      'You can record work up to ' + maxBack + ' days back. Ask your Team Lead to add older entries.');
  }

  /** Find the assigned KPI whose metric this activity feeds. */
  function resolveKpiLink_(cycle, def, pocUserId, payload) {
    if (payload.kpiId) {
      var explicit = Repository.findById(SHEET.KPI, payload.kpiId);
      if (explicit) {
        var kraX = Repository.findById(SHEET.KRA, explicit.kraId);
        return {
          kpiId: explicit.kpiId, kraId: explicit.kraId,
          metricKey: explicit.metricKey, stream: kraX ? kraX.stream : ''
        };
      }
    }
    var assignments = Repository.where(SHEET.ASSIGNMENT,
      { cycleId: cycle.cycleId, pocUserId: pocUserId })
      .filter(function (a) { return a.active !== false; });
    for (var i = 0; i < assignments.length; i++) {
      var kpi = Repository.findById(SHEET.KPI, assignments[i].kpiId);
      if (!kpi || kpi.active === false) continue;
      if (def.metrics.indexOf(kpi.metricKey) < 0) continue;
      var kra = Repository.findById(SHEET.KRA, kpi.kraId);
      return {
        kpiId: kpi.kpiId, kraId: kpi.kraId,
        metricKey: kpi.metricKey, stream: kra ? kra.stream : ''
      };
    }
    // Not every activity maps to an assigned KPI (a follow-up may simply be
    // context). Record the primary metric so it is still traceable.
    return { kpiId: '', kraId: '', metricKey: def.metrics[0] || '', stream: '' };
  }

  function touchAccount_(account, def, activityDate) {
    var patch = {};
    if (def.key === ACTIVITY_TYPE.FIELD_VISIT) {
      if (!account.lastVisitDate || activityDate > account.lastVisitDate) {
        patch.lastVisitDate = activityDate;
      }
    }
    if (def.key === ACTIVITY_TYPE.SHIPMENT) {
      if (!account.firstTxnDate || activityDate < account.firstTxnDate) patch.firstTxnDate = activityDate;
      if (!account.lastTxnDate || activityDate > account.lastTxnDate) patch.lastTxnDate = activityDate;
    }
    if (Object.keys(patch).length) Repository.update(SHEET.ACCOUNTS, account.accountId, patch);
  }

  function writePulse_(activity, poc, account) {
    Repository.upsert(SHEET.PULSE, {
      pulseId: Id.natural('PLS', activity.activityId),
      category: activity.category,
      visitDate: activity.activityDate,
      pocUserId: activity.pocUserId,
      employeeCode: poc ? poc.employeeCode : '',
      regionId: activity.regionId,
      accountId: activity.accountId,
      gstin: activity.gstin,
      accountName: activity.accountName,
      visitCount: Util.num(activity.count, 1) || 1,
      onLeave: false,
      purpose: activity.status,
      outcome: activity.blockerReason ? 'BLOCKED' : 'DONE',
      remarks: activity.remarks,
      evidenceUrl: activity.evidenceUrl,
      sourceSystem: 'APP',
      sourceRef: activity.activityId
    });
  }

  /** Bulk entry — the "log my day in one screen" path. */
  function saveBatch(entries) {
    Auth.require(PERM.ACTIVITY_WRITE);
    assert(entries && entries.length, 'VALIDATION', 'Nothing to save.');
    assert(entries.length <= 100, 'VALIDATION', 'Save at most 100 entries at a time.');
    var saved = [], errors = [];
    entries.forEach(function (e, i) {
      try { saved.push(save(e)); }
      catch (err) { errors.push({ index: i, message: err.message || String(err), entry: e }); }
    });
    return { saved: saved.length, errors: errors, activities: saved };
  }

  /**
   * Void, never delete. The row stays with its reason so a metric that moved can
   * always be explained after the fact.
   */
  function voidActivity(activityId, reason) {
    var user = Auth.require(PERM.ACTIVITY_WRITE);
    var a = Repository.findById(SHEET.ACTIVITIES, activityId);
    assert(a, 'NOT_FOUND', 'Activity not found.');
    assert(!a.voided, 'INVALID_STATE', 'That activity is already voided.');
    assert(!Util.isBlank(reason), 'VALIDATION', 'Give a reason for voiding this record.');
    if (!Auth.can(PERM.ACTIVITY_VOID, user)) Auth.requireOwnership(a.pocUserId, user);

    var cycle = Planning.getCycle(a.cycleId);
    assert(cycle.status === CYCLE_STATUS.PUBLISHED || Auth.can(PERM.ACTIVITY_VOID, user),
      'CYCLE_LOCKED', 'This cycle is closed for changes.');

    var updated = Repository.transaction(function () {
      var out = Repository.update(SHEET.ACTIVITIES, activityId,
        { voided: true, voidReason: Util.str(reason) });
      Repository.removeWhere(SHEET.PULSE, function (p) { return p.sourceRef === activityId; });
      return out;
    });
    Engine.invalidate();
    Audit.log('ACTIVITY_VOID', SHEET.ACTIVITIES, activityId,
      'Voided: ' + Util.truncate(reason, 200), a, updated);
    return shape_(updated, null);
  }

  /** Team Lead / RH verification of evidence-bearing activities. */
  function verify(activityId, decision, note) {
    Auth.require(PERM.ACTIVITY_VERIFY);
    var a = Repository.findById(SHEET.ACTIVITIES, activityId);
    assert(a, 'NOT_FOUND', 'Activity not found.');
    assert(['VERIFIED', 'REJECTED'].indexOf(decision) >= 0, 'VALIDATION',
      'Decision must be VERIFIED or REJECTED.');
    if (decision === 'REJECTED') {
      assert(!Util.isBlank(note), 'VALIDATION', 'Explain why the evidence was rejected.');
    }
    var updated = Repository.update(SHEET.ACTIVITIES, activityId, {
      verificationStatus: decision,
      verifiedBy: Auth.current().email,
      verifiedAt: new Date(),
      verifyNote: Util.str(note)
    });
    Audit.log('ACTIVITY_VERIFY', SHEET.ACTIVITIES, activityId,
      decision + ' — ' + Util.truncate(note || '', 200), a, updated);
    return shape_(updated, null);
  }

  /** Record a leave day so the pulse target is reduced fairly. */
  function markLeave(payload) {
    var user = Auth.require(PERM.ACTIVITY_WRITE);
    var pocUserId = payload.pocUserId || user.userId;
    Auth.requireOwnership(pocUserId, user);
    var poc = Repository.findById(SHEET.USERS, pocUserId);
    var d = DateUtil.parse(payload.date);
    assert(d, 'VALIDATION', 'Select the date.');
    var saved = Repository.upsert(SHEET.PULSE, {
      pulseId: Id.natural('PLS', 'LEAVE', pocUserId, DateUtil.isoDate(d)),
      category: payload.category || Config.get('DEFAULT_CATEGORY'),
      visitDate: d, pocUserId: pocUserId,
      employeeCode: poc ? poc.employeeCode : '',
      regionId: poc ? poc.regionId : '',
      visitCount: 0, onLeave: true,
      purpose: 'LEAVE', remarks: Util.str(payload.remarks),
      sourceSystem: 'APP'
    });
    Engine.invalidate();
    Audit.log('LEAVE_MARK', SHEET.PULSE, saved.pulseId,
      (poc ? poc.fullName : pocUserId) + ' on leave ' + DateUtil.isoDate(d));
    return saved;
  }

  /**
   * The POC's daily worklist: what is assigned, what has been done today, and
   * what needs attention. This is the screen the "under ten minutes a day"
   * promise depends on.
   */
  function myDay(cycleIdValue, dateValue) {
    var user = Auth.current();
    var cycle = cycleIdValue ? Planning.getCycle(cycleIdValue)
      : Planning.activeCycle(user.category === 'ALL' ? Config.get('DEFAULT_CATEGORY') : user.category);
    assert(cycle, 'NOT_FOUND', 'No planning cycle is open yet.');
    var day = DateUtil.parse(dateValue) || DateUtil.today();

    var todays = list({
      cycleId: cycle.cycleId, pocUserId: user.userId,
      from: DateUtil.isoDate(day), to: DateUtil.isoDate(day)
    });

    var scorecard = Reports.scorecardFor(cycle.cycleId, user.userId);
    var accounts = Accounts.list({ category: cycle.category, pocUserId: user.userId });

    // What needs attention today, in priority order.
    var attention = [];
    scorecard.kpis.forEach(function (k) {
      if (k.evaluation.paceStatus === 'CRITICAL' || k.evaluation.paceStatus === 'AT_RISK') {
        attention.push({
          kind: 'KPI_OFF_PACE', severity: k.evaluation.paceStatus === 'CRITICAL' ? 'P1' : 'P2',
          title: k.kpiName + ' is behind pace',
          detail: 'Achieved ' + Util.round(k.evaluation.actual, 2) + ' of ' +
            Util.round(k.evaluation.target, 2) + '. Needs ' +
            Util.round(k.evaluation.requiredDrr, 2) + '/day for the remaining ' +
            k.evaluation.remainingDays + ' day(s); currently running at ' +
            Util.round(k.evaluation.currentDrr, 2) + '/day.',
          kpiId: k.kpiId
        });
      }
    });
    var dormantDays = Config.get('DORMANCY_DAYS');
    accounts.filter(function (a) { return a.dormant; })
      .slice(0, 10).forEach(function (a) {
        attention.push({
          kind: 'DORMANT_ACCOUNT', severity: 'P2',
          title: a.businessName + ' has been idle ' + a.idleDays + ' days',
          detail: 'No transaction or visit for more than ' + dormantDays + ' days.',
          accountId: a.accountId
        });
      });
    accounts.filter(function (a) {
      return a.onboardingStatus === ONBOARDING_STATUS.COMPLETED && a.neverTransacted;
    }).slice(0, 10).forEach(function (a) {
      attention.push({
        kind: 'NEVER_TRANSACTED', severity: 'P3',
        title: a.businessName + ' has never transacted',
        detail: 'Onboarded ' + (a.onboardedDate || '—') + ' but no shipment yet.',
        accountId: a.accountId
      });
    });
    Repository.where(SHEET.ACTIONS, { ownerUserId: user.userId })
      .filter(function (t) { return ['OPEN', 'IN_PROGRESS', 'BLOCKED'].indexOf(t.status) >= 0; })
      .forEach(function (t) {
        var overdue = t.dueDate && t.dueDate < DateUtil.today();
        attention.push({
          kind: 'ACTION_ITEM', severity: overdue ? 'P1' : t.priority || 'P3',
          title: (overdue ? 'Overdue: ' : '') + t.title,
          detail: 'Due ' + (DateUtil.isoDate(t.dueDate) || '—') + ' · ' + t.status,
          actionId: t.actionId
        });
      });

    var order = { P1: 0, P2: 1, P3: 2 };
    attention = Util.sortBy(attention, [{ pick: function (x) { return order[x.severity] || 3; } }]);

    return {
      cycle: { cycleId: cycle.cycleId, label: cycle.label, status: cycle.status },
      date: DateUtil.isoDate(day),
      user: { userId: user.userId, fullName: user.fullName, role: user.role },
      loggedToday: todays,
      loggedTodayCount: todays.length,
      scorecard: scorecard.summary,
      kpis: scorecard.kpis.map(function (k) {
        return {
          kpiId: k.kpiId, kpiName: k.kpiName, unit: k.unit,
          target: k.evaluation.target, actual: k.evaluation.actual,
          achievement: k.evaluation.achievement, tone: k.evaluation.tone,
          paceStatus: k.evaluation.paceStatus,
          currentDrr: k.evaluation.currentDrr, requiredDrr: k.evaluation.requiredDrr
        };
      }),
      accounts: accounts,
      attention: attention.slice(0, 25),
      activityTypes: types().filter(function (t) { return !t.systemOwned; })
    };
  }

  /**
   * Drill-down: given a metric, a scope and a window, return every operational
   * record behind the number. This is the mechanism that makes each dashboard
   * tile auditable.
   */
  function drilldown(request) {
    var cycle = Planning.getCycle(request.cycleId);
    var sc = Auth.scope();
    assert(Auth.inScope(sc, request.pocUserId, cycle.category, request.regionId), 'FORBIDDEN',
      'That slice is outside your scope.');

    var window = request.window === 'LMTD'
      ? DateUtil.cycleLmtdWindow(cycle.year, cycle.month, request.asOf)
      : DateUtil.cycleWindow(cycle.year, cycle.month, request.asOf);

    var engineScope = Engine.scope({
      category: cycle.category, stream: request.stream || 'BOTH',
      regionId: request.regionId, pocUserId: request.pocUserId,
      gstin: request.gstin, materialType: request.materialType
    });

    var result = Engine.metric(request.metricKey, window, engineScope, { trace: true });
    var users = Util.indexBy(Repository.readAll(SHEET.USERS), function (u) { return u.userId; });

    return {
      metricKey: request.metricKey,
      metricLabel: METRICS[request.metricKey] ? METRICS[request.metricKey].label : request.metricKey,
      unit: METRICS[request.metricKey] ? METRICS[request.metricKey].unit : '',
      window: {
        kind: window.kind,
        from: DateUtil.isoDate(window.start),
        to: DateUtil.isoDate(DateUtil.addDays(window.end, -1))
      },
      value: Util.round(result.value, 4),
      recordCount: result.count,
      meta: result.meta || null,
      records: (result.contributors || []).map(function (c) {
        c.pocName = c.pocUserId && users[c.pocUserId] ? users[c.pocUserId].fullName : '';
        return c;
      }).slice(0, 500)
    };
  }

  return {
    types: types,
    typeDef: typeDef,
    list: list,
    get: get,
    save: save,
    saveBatch: saveBatch,
    voidActivity: voidActivity,
    verify: verify,
    markLeave: markLeave,
    myDay: myDay,
    drilldown: drilldown
  };
})();
