/**
 * 12_Review.gs — "Review → Improve".
 *
 * A review freezes the scorecard as it stood on the review date, so a later
 * correction to a fact cannot rewrite history. Every gap raised in a review can
 * become an action item with an owner and a due date, and those action items
 * feed straight back into the POC's daily worklist — closing the
 * Plan → Execute → Track → Measure → Review → Improve loop.
 */

var Review = (function () {

  function list(filterSpec) {
    filterSpec = filterSpec || {};
    var sc = Auth.scope();
    var users = Util.indexBy(Repository.readAll(SHEET.USERS), function (u) { return u.userId; });
    return Repository.readAll(SHEET.REVIEWS)
      .filter(function (r) {
        if (filterSpec.cycleId && r.cycleId !== filterSpec.cycleId) return false;
        if (filterSpec.subjectUserId && r.subjectUserId !== filterSpec.subjectUserId) return false;
        if (filterSpec.status && r.status !== filterSpec.status) return false;
        // A POC sees only reviews about themselves.
        if (sc.level === 'SELF' && r.subjectUserId !== sc.user.userId) return false;
        return Auth.inScope(sc, r.subjectUserId, r.category, r.subjectRegionId);
      })
      .map(function (r) {
        return {
          reviewId: r.reviewId, cycleId: r.cycleId, category: r.category,
          reviewLevel: r.reviewLevel,
          subjectUserId: r.subjectUserId,
          subjectName: users[r.subjectUserId] ? users[r.subjectUserId].fullName : r.subjectUserId,
          subjectRegionId: r.subjectRegionId,
          reviewDate: DateUtil.isoDate(r.reviewDate),
          weightedScore: Util.num(r.weightedScore, 0),
          overallAchievement: Util.num(r.overallAchievement, 0),
          rating: Util.num(r.rating, 0), ratingLabel: r.ratingLabel,
          strengths: r.strengths, gaps: r.gaps,
          leadershipNote: r.leadershipNote, pocResponse: r.pocResponse,
          status: r.status,
          reviewedBy: r.reviewedBy, reviewedAt: DateUtil.isoDateTime(r.reviewedAt),
          acknowledgedAt: DateUtil.isoDateTime(r.acknowledgedAt)
        };
      });
  }

  function get(reviewId) {
    var r = Repository.findById(SHEET.REVIEWS, reviewId);
    assert(r, 'NOT_FOUND', 'Review not found.');
    var sc = Auth.scope();
    assert(sc.level !== 'SELF' || r.subjectUserId === sc.user.userId, 'FORBIDDEN',
      'That review is not about you.');
    var shaped = list({ cycleId: r.cycleId, subjectUserId: r.subjectUserId })
      .filter(function (x) { return x.reviewId === reviewId; })[0];
    shaped.snapshot = r.snapshot;
    shaped.actions = Repository.where(SHEET.ACTIONS, { reviewId: reviewId })
      .map(shapeAction_);
    return shaped;
  }

  /**
   * Open a review for a POC. The scorecard is captured verbatim at this moment;
   * the review is the record of what was discussed, not a live view.
   */
  function open(payload) {
    Auth.require(PERM.REVIEW_MANAGE);
    var cycle = Planning.getCycle(payload.cycleId);
    var subject = Repository.findById(SHEET.USERS, payload.subjectUserId);
    assert(subject, 'VALIDATION', 'Select the person being reviewed.');

    var card = Reports.scorecardFor(cycle.cycleId, subject.userId);
    var reviewId = payload.reviewId ||
      Id.natural('REV', cycle.cycleId, subject.userId);

    var existing = Repository.findById(SHEET.REVIEWS, reviewId);
    assert(!existing || existing.status !== 'SIGNED_OFF', 'INVALID_STATE',
      'That review has been signed off and cannot be reopened.');

    var row = {
      reviewId: reviewId, cycleId: cycle.cycleId, category: cycle.category,
      reviewLevel: payload.reviewLevel || 'POC',
      subjectUserId: subject.userId, subjectRegionId: subject.regionId,
      reviewDate: DateUtil.parse(payload.reviewDate) || DateUtil.today(),
      weightedScore: card.summary.weightedScore,
      overallAchievement: card.summary.overallAchievement,
      rating: card.summary.rating,
      ratingLabel: card.summary.ratingLabel,
      strengths: Util.str(payload.strengths),
      gaps: Util.str(payload.gaps),
      leadershipNote: Util.str(payload.leadershipNote),
      pocResponse: existing ? existing.pocResponse : '',
      status: payload.status || 'DRAFT',
      snapshot: {
        asOf: card.asOf,
        summary: card.summary,
        kpis: card.kpis.map(function (k) {
          return {
            kpiId: k.kpiId, kpiName: k.kpiName, kraName: k.kraName,
            weightage: k.weightage,
            target: k.evaluation.target, actual: k.evaluation.actual,
            achievement: k.evaluation.achievement,
            weightedScore: k.evaluation.weightedScore,
            rating: k.evaluation.rating, bandLabel: k.evaluation.bandLabel
          };
        })
      },
      reviewedBy: Auth.current().email,
      reviewedAt: new Date()
    };

    var saved = Repository.upsert(SHEET.REVIEWS, row);
    Audit.log(existing ? 'REVIEW_UPDATE' : 'REVIEW_OPEN', SHEET.REVIEWS, saved.reviewId,
      subject.fullName + ' · ' + cycle.label + ' · ' + Fmt.pct(saved.overallAchievement),
      null, Util.pick(saved, ['status', 'overallAchievement', 'rating']));
    return get(saved.reviewId);
  }

  function share(reviewId) {
    Auth.require(PERM.REVIEW_MANAGE);
    var r = Repository.findById(SHEET.REVIEWS, reviewId);
    assert(r, 'NOT_FOUND', 'Review not found.');
    assert(r.status === 'DRAFT', 'INVALID_STATE', 'Only a draft review can be shared.');
    var updated = Repository.update(SHEET.REVIEWS, reviewId, { status: 'SHARED' });
    Audit.log('REVIEW_SHARE', SHEET.REVIEWS, reviewId, 'Shared with the POC');
    return updated;
  }

  function acknowledge(reviewId, response) {
    var user = Auth.require(PERM.REVIEW_ACKNOWLEDGE);
    var r = Repository.findById(SHEET.REVIEWS, reviewId);
    assert(r, 'NOT_FOUND', 'Review not found.');
    assert(String(r.subjectUserId) === String(user.userId), 'FORBIDDEN',
      'Only the person reviewed can acknowledge it.');
    assert(r.status === 'SHARED', 'INVALID_STATE', 'This review is not open for acknowledgement.');
    var updated = Repository.update(SHEET.REVIEWS, reviewId, {
      status: 'ACKNOWLEDGED', pocResponse: Util.str(response), acknowledgedAt: new Date()
    });
    Audit.log('REVIEW_ACKNOWLEDGE', SHEET.REVIEWS, reviewId, 'Acknowledged by ' + user.fullName);
    return updated;
  }

  function signOff(reviewId, note) {
    Auth.require(PERM.REVIEW_MANAGE);
    var r = Repository.findById(SHEET.REVIEWS, reviewId);
    assert(r, 'NOT_FOUND', 'Review not found.');
    assert(['SHARED', 'ACKNOWLEDGED'].indexOf(r.status) >= 0, 'INVALID_STATE',
      'Share the review before signing it off.');
    var updated = Repository.update(SHEET.REVIEWS, reviewId, {
      status: 'SIGNED_OFF',
      leadershipNote: Util.isBlank(note) ? r.leadershipNote : Util.str(note)
    });
    Audit.log('REVIEW_SIGNOFF', SHEET.REVIEWS, reviewId, 'Signed off');
    return updated;
  }

  // =========================================================================
  // Action items
  // =========================================================================

  function shapeAction_(t) {
    var users = Util.indexBy(Repository.readAll(SHEET.USERS), function (u) { return u.userId; });
    var overdue = t.dueDate && t.dueDate < DateUtil.today() &&
      ['DONE', 'CANCELLED'].indexOf(t.status) < 0;
    return {
      actionId: t.actionId, cycleId: t.cycleId, category: t.category,
      reviewId: t.reviewId, sourceType: t.sourceType, sourceRef: t.sourceRef,
      title: t.title, description: t.description,
      ownerUserId: t.ownerUserId,
      ownerName: users[t.ownerUserId] ? users[t.ownerUserId].fullName : t.ownerUserId,
      regionId: t.regionId, accountId: t.accountId, kpiId: t.kpiId,
      priority: t.priority, dueDate: DateUtil.isoDate(t.dueDate),
      status: t.status, overdue: !!overdue,
      ageDays: t.createdAt ? DateUtil.diffDays(t.createdAt, DateUtil.today()) : null,
      closureRemarks: t.closureRemarks, evidenceUrl: t.evidenceUrl,
      closedAt: DateUtil.isoDateTime(t.closedAt),
      createdBy: t.createdBy, createdAt: DateUtil.isoDateTime(t.createdAt)
    };
  }

  function listActions(filterSpec) {
    filterSpec = filterSpec || {};
    var sc = Auth.scope();
    return Repository.readAll(SHEET.ACTIONS)
      .filter(function (t) {
        if (filterSpec.cycleId && t.cycleId !== filterSpec.cycleId) return false;
        if (filterSpec.ownerUserId && t.ownerUserId !== filterSpec.ownerUserId) return false;
        if (filterSpec.status && t.status !== filterSpec.status) return false;
        if (filterSpec.priority && t.priority !== filterSpec.priority) return false;
        if (filterSpec.openOnly && ['DONE', 'CANCELLED'].indexOf(t.status) >= 0) return false;
        return Auth.inScope(sc, t.ownerUserId, t.category, t.regionId);
      })
      .map(shapeAction_)
      .sort(function (a, b) {
        if (a.overdue !== b.overdue) return a.overdue ? -1 : 1;
        var order = { P1: 0, P2: 1, P3: 2 };
        var pa = order[a.priority] === undefined ? 3 : order[a.priority];
        var pb = order[b.priority] === undefined ? 3 : order[b.priority];
        if (pa !== pb) return pa - pb;
        return String(a.dueDate).localeCompare(String(b.dueDate));
      });
  }

  function saveAction(payload) {
    var user = Auth.current();
    var isOwnerUpdate = payload.actionId && !Auth.can(PERM.ACTION_MANAGE, user);
    if (!isOwnerUpdate) Auth.require(PERM.ACTION_MANAGE, user);

    assert(!Util.isBlank(payload.title), 'VALIDATION', 'Give the action a title.');
    var owner = Repository.findById(SHEET.USERS, payload.ownerUserId);
    assert(owner, 'VALIDATION', 'Assign the action to someone.');
    var cycle = payload.cycleId ? Planning.getCycle(payload.cycleId) : null;

    if (isOwnerUpdate) {
      var existing = Repository.findById(SHEET.ACTIONS, payload.actionId);
      assert(existing, 'NOT_FOUND', 'Action not found.');
      assert(String(existing.ownerUserId) === String(user.userId), 'FORBIDDEN',
        'You can only update actions assigned to you.');
      // An owner may move status and add closure notes, nothing else.
      var patch = {
        status: payload.status || existing.status,
        closureRemarks: Util.str(payload.closureRemarks),
        evidenceUrl: Util.str(payload.evidenceUrl)
      };
      if (patch.status === 'DONE') {
        assert(!Util.isBlank(patch.closureRemarks), 'VALIDATION',
          'Describe what was done before closing this action.');
        patch.closedAt = new Date();
      }
      var upd = Repository.update(SHEET.ACTIONS, payload.actionId, patch);
      Audit.log('ACTION_UPDATE_OWNER', SHEET.ACTIONS, payload.actionId,
        existing.title + ' → ' + patch.status, existing, upd);
      return shapeAction_(upd);
    }

    var row = {
      actionId: payload.actionId || Id.next('ACTN'),
      cycleId: cycle ? cycle.cycleId : '',
      category: cycle ? cycle.category : (payload.category || Config.get('DEFAULT_CATEGORY')),
      reviewId: Util.str(payload.reviewId),
      sourceType: payload.sourceType || 'MANUAL',
      sourceRef: Util.str(payload.sourceRef),
      title: Util.str(payload.title),
      description: Util.str(payload.description),
      ownerUserId: owner.userId,
      regionId: payload.regionId || owner.regionId,
      accountId: Util.str(payload.accountId),
      kpiId: Util.str(payload.kpiId),
      priority: payload.priority || 'P2',
      dueDate: DateUtil.parse(payload.dueDate) || DateUtil.addDays(DateUtil.today(), 7),
      status: payload.status || 'OPEN',
      closureRemarks: Util.str(payload.closureRemarks),
      evidenceUrl: Util.str(payload.evidenceUrl),
      closedAt: payload.status === 'DONE' ? new Date() : null
    };
    var saved = Repository.upsert(SHEET.ACTIONS, row);
    Audit.log(payload.actionId ? 'ACTION_UPDATE' : 'ACTION_CREATE', SHEET.ACTIONS,
      saved.actionId, saved.title + ' → ' + owner.fullName, null, saved);
    return shapeAction_(saved);
  }

  /** Turn a dashboard alert into a tracked action in one click. */
  function actionFromAlert(alert) {
    Auth.require(PERM.ACTION_MANAGE);
    assert(alert && alert.title, 'VALIDATION', 'Nothing to convert.');
    return saveAction({
      cycleId: alert.cycleId,
      sourceType: 'ALERT',
      sourceRef: alert.id,
      title: alert.title,
      description: [alert.detail, alert.nextStep].filter(function (x) { return x; }).join(' — '),
      ownerUserId: alert.ownerUserId,
      regionId: alert.regionId,
      accountId: alert.accountId,
      kpiId: alert.kpiId,
      priority: alert.severity || 'P2',
      dueDate: DateUtil.isoDate(DateUtil.addDays(DateUtil.today(), alert.severity === 'P1' ? 2 : 7))
    });
  }

  /**
   * Review pack: everything needed to run the monthly meeting, assembled in one
   * call so the meeting starts on the first slide rather than on a data hunt.
   */
  function reviewPack(cycleIdValue) {
    Auth.require(PERM.REVIEW_MANAGE);
    var ctx = Reports.context(cycleIdValue);
    var board = Reports.leaderboard(ctx.cycle.cycleId);
    var regional = Reports.regionWise(ctx.cycle.cycleId);
    var alertList = Dashboard.alerts(ctx.cycle.cycleId, { limit: 30 });
    var quality = Dashboard.dataQuality(ctx.cycle.cycleId);
    var openActions = listActions({ cycleId: ctx.cycle.cycleId, openOnly: true });
    var reviews = list({ cycleId: ctx.cycle.cycleId });

    var top = board.rows.slice(0, 3);
    var bottom = board.rows.slice(-3).reverse();

    return {
      cycle: {
        cycleId: ctx.cycle.cycleId, label: ctx.cycle.label,
        status: ctx.cycle.status, category: ctx.cycle.category
      },
      asOf: DateUtil.isoDate(ctx.asOf),
      headline: Dashboard.executive(ctx.cycle.cycleId).tiles,
      leaderboard: board,
      topPerformers: top,
      needsSupport: bottom,
      regions: regional,
      alerts: alertList,
      dataQuality: quality,
      openActions: openActions,
      reviews: reviews,
      completion: {
        reviewsExpected: board.rows.length,
        reviewsDone: reviews.filter(function (r) {
          return ['SHARED', 'ACKNOWLEDGED', 'SIGNED_OFF'].indexOf(r.status) >= 0;
        }).length,
        actionsOpen: openActions.length,
        actionsOverdue: openActions.filter(function (a) { return a.overdue; }).length
      }
    };
  }

  return {
    list: list,
    get: get,
    open: open,
    share: share,
    acknowledge: acknowledge,
    signOff: signOff,
    listActions: listActions,
    saveAction: saveAction,
    actionFromAlert: actionFromAlert,
    reviewPack: reviewPack
  };
})();
