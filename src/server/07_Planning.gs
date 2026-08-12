/**
 * 07_Planning.gs — "Assign Once".
 *
 * The Team Lead opens a cycle, clones the KRA/KPI library, sets weightages and
 * targets, assigns POCs and publishes. Publishing is the gate: until a cycle is
 * PUBLISHED it is invisible to POCs, and once it is LOCKED nothing may change.
 *
 * The validation rules here are the ones the spreadsheet could not enforce —
 * chiefly that weightages must total 100 per stream, without which the whole
 * weighted-score model silently breaks.
 */

var Planning = (function () {

  // =========================================================================
  // Cycles
  // =========================================================================

  function cycleId(category, year, month) {
    return 'CYC-' + Util.slug(category) + '-' + year + '-' + ('0' + month).slice(-2);
  }

  function listCycles(filterSpec) {
    var sc = Auth.scope();
    var rows = Repository.readAll(SHEET.CYCLES).filter(function (c) {
      if (sc.categories.indexOf(c.category) < 0) return false;
      if (filterSpec && filterSpec.category && c.category !== filterSpec.category) return false;
      if (filterSpec && filterSpec.status && c.status !== filterSpec.status) return false;
      // POCs never see a cycle that has not been published.
      if (sc.level === 'SELF' && c.status === CYCLE_STATUS.DRAFT) return false;
      return true;
    });
    return Util.sortBy(rows, [
      { pick: function (c) { return c.year; }, dir: 'desc' },
      { pick: function (c) { return c.month; }, dir: 'desc' }
    ]);
  }

  /** The cycle a dashboard should open on: the live one, else the most recent. */
  function activeCycle(category) {
    var cat = category || Config.get('DEFAULT_CATEGORY');
    var today = DateUtil.asOf();
    var exact = Repository.findById(SHEET.CYCLES,
      cycleId(cat, today.getFullYear(), today.getMonth() + 1));
    if (exact && exact.status !== CYCLE_STATUS.DRAFT) return exact;
    var candidates = listCycles({ category: cat }).filter(function (c) {
      return c.status !== CYCLE_STATUS.DRAFT;
    });
    return candidates.length ? candidates[0] : (exact || null);
  }

  function getCycle(id) {
    var c = Repository.findById(SHEET.CYCLES, id);
    if (!c) fail('NOT_FOUND', 'Cycle ' + id + ' was not found.');
    return c;
  }

  function createCycle(payload) {
    Auth.require(PERM.CYCLE_MANAGE);
    var category = payload.category || Config.get('DEFAULT_CATEGORY');
    var year = Util.num(payload.year, 0);
    var month = Util.num(payload.month, 0);
    assert(year > 2000 && month >= 1 && month <= 12, 'VALIDATION', 'A valid year and month are required.');
    assert(CATEGORIES.indexOf(category) >= 0, 'VALIDATION', 'Unknown category: ' + category);

    var id = cycleId(category, year, month);
    assert(!Repository.findById(SHEET.CYCLES, id), 'DUPLICATE',
      'A cycle already exists for ' + DateUtil.monthLabel(year, month) + ' · ' + category + '.');

    var start = new Date(year, month - 1, 1);
    return Repository.transaction(function () {
      var cycle = Repository.insert(SHEET.CYCLES, {
        cycleId: id, category: category, year: year, month: month,
        label: DateUtil.monthLabel(year, month) + ' · ' + category,
        status: CYCLE_STATUS.DRAFT,
        workingDays: Util.num(payload.workingDays, 0) || DateUtil.workingDaysInMonth(start),
        startDate: start,
        endDate: DateUtil.endOfMonth(start),
        notes: Util.str(payload.notes)
      });

      if (payload.cloneFrom) cloneCycleContent_(payload.cloneFrom, cycle);
      else cloneLibrary_(cycle);

      Audit.log('CYCLE_CREATE', SHEET.CYCLES, cycle.cycleId,
        'Created ' + cycle.label, null, cycle);
      return cycle;
    });
  }

  /** Copy the LIBRARY template into a new cycle. */
  function cloneLibrary_(cycle) {
    var kras = Repository.where(SHEET.KRA, { cycleId: 'LIBRARY', category: cycle.category })
      .filter(function (k) { return k.active !== false; });
    var kpis = Repository.where(SHEET.KPI, { cycleId: 'LIBRARY' });
    return copyKraSet_(kras, kpis, cycle);
  }

  function cloneCycleContent_(sourceCycleId, cycle) {
    var src = getCycle(sourceCycleId);
    var kras = Repository.where(SHEET.KRA, { cycleId: src.cycleId })
      .filter(function (k) { return k.active !== false; });
    var kpis = Repository.where(SHEET.KPI, { cycleId: src.cycleId });
    var result = copyKraSet_(kras, kpis, cycle);

    // Carry forward account plans so the Team Lead edits numbers rather than
    // rebuilding the whole book each month.
    var plans = Repository.where(SHEET.ACCOUNT_PLAN, { cycleId: src.cycleId })
      .filter(function (p) { return p.active !== false; });
    if (plans.length) {
      Repository.insertMany(SHEET.ACCOUNT_PLAN, plans.map(function (p) {
        return {
          planId: Id.next('PLAN'), cycleId: cycle.cycleId, accountId: p.accountId,
          accountType: p.accountType, gstin: p.gstin, accountName: p.accountName,
          pocUserId: p.pocUserId, regionId: p.regionId, category: p.category,
          materialType: p.materialType,
          txnTarget: p.txnTarget, tonnageTargetMT: p.tonnageTargetMT,
          ratePerKgTarget: p.ratePerKgTarget, gmvTargetCr: p.gmvTargetCr,
          remarks: '', detailedRemarks: '', blockerReason: '', active: true
        };
      }));
      result.accountPlans = plans.length;
    }
    return result;
  }

  function copyKraSet_(kras, kpis, cycle) {
    var kraIdMap = {};
    var newKras = kras.map(function (k) {
      var newId = Id.next('KRA');
      kraIdMap[k.kraId] = newId;
      return {
        kraId: newId, cycleId: cycle.cycleId, category: cycle.category,
        stream: k.stream, perspective: k.perspective, kraName: k.kraName,
        sourceOfTracking: k.sourceOfTracking, sequence: k.sequence, active: true
      };
    });
    var newKpis = kpis.filter(function (p) { return kraIdMap[p.kraId]; }).map(function (p) {
      return {
        kpiId: Id.next('KPI'), kraId: kraIdMap[p.kraId], cycleId: cycle.cycleId,
        kpiName: p.kpiName, definition: p.definition, weightage: p.weightage,
        unitOfMeasure: p.unitOfMeasure, metricKey: p.metricKey, direction: p.direction,
        targetBasis: p.targetBasis, basisMetric: p.basisMetric, basisPct: p.basisPct,
        target1: p.target1, target2: p.target2, target3: p.target3,
        target4: p.target4, target5: p.target5,
        sequence: p.sequence, active: true
      };
    });
    if (newKras.length) Repository.insertMany(SHEET.KRA, newKras);
    if (newKpis.length) Repository.insertMany(SHEET.KPI, newKpis);
    return { kras: newKras.length, kpis: newKpis.length };
  }

  function updateCycle(id, patch) {
    Auth.require(PERM.CYCLE_MANAGE);
    var cycle = getCycle(id);
    assertEditable_(cycle);
    var before = Util.pick(cycle, ['workingDays', 'notes', 'status']);
    var updated = Repository.update(SHEET.CYCLES, id, {
      workingDays: patch.workingDays === undefined ? cycle.workingDays : Util.num(patch.workingDays, 0),
      notes: patch.notes === undefined ? cycle.notes : Util.str(patch.notes)
    });
    Audit.log('CYCLE_UPDATE', SHEET.CYCLES, id, 'Updated ' + cycle.label, before, patch);
    return updated;
  }

  /**
   * Publish. This is the point at which the plan becomes binding, so every
   * structural rule is enforced here rather than at data-entry time.
   */
  function publishCycle(id) {
    Auth.require(PERM.CYCLE_MANAGE);
    var cycle = getCycle(id);
    assert(cycle.status === CYCLE_STATUS.DRAFT, 'INVALID_STATE',
      'Only a draft cycle can be published. This cycle is ' + cycle.status + '.');

    var check = validateCycle(id);
    assert(check.valid, 'VALIDATION',
      'The cycle cannot be published yet — ' + check.errors.length + ' issue(s) must be resolved.',
      check);

    return Repository.transaction(function () {
      var updated = Repository.update(SHEET.CYCLES, id, {
        status: CYCLE_STATUS.PUBLISHED,
        publishedBy: Auth.current().email,
        publishedAt: new Date()
      });
      Audit.log('CYCLE_PUBLISH', SHEET.CYCLES, id, 'Published ' + cycle.label, null, check.summary);
      return updated;
    });
  }

  function lockCycle(id) {
    Auth.require(PERM.CYCLE_MANAGE);
    var cycle = getCycle(id);
    assert(cycle.status === CYCLE_STATUS.PUBLISHED, 'INVALID_STATE',
      'Only a published cycle can be locked.');
    var updated = Repository.update(SHEET.CYCLES, id, {
      status: CYCLE_STATUS.LOCKED, lockedBy: Auth.current().email, lockedAt: new Date()
    });
    Audit.log('CYCLE_LOCK', SHEET.CYCLES, id, 'Locked ' + cycle.label);
    return updated;
  }

  function closeCycle(id) {
    Auth.require(PERM.CYCLE_MANAGE);
    var cycle = getCycle(id);
    assert(cycle.status === CYCLE_STATUS.LOCKED, 'INVALID_STATE',
      'A cycle must be locked before it can be closed.');
    var updated = Repository.update(SHEET.CYCLES, id, {
      status: CYCLE_STATUS.CLOSED, closedBy: Auth.current().email, closedAt: new Date()
    });
    Audit.log('CYCLE_CLOSE', SHEET.CYCLES, id, 'Closed ' + cycle.label);
    return updated;
  }

  function reopenCycle(id) {
    Auth.require(PERM.CYCLE_MANAGE);
    var cycle = getCycle(id);
    assert(cycle.status === CYCLE_STATUS.LOCKED, 'INVALID_STATE',
      'Only a locked cycle can be reopened.');
    var updated = Repository.update(SHEET.CYCLES, id, {
      status: CYCLE_STATUS.PUBLISHED, lockedBy: '', lockedAt: ''
    });
    Audit.log('CYCLE_REOPEN', SHEET.CYCLES, id, 'Reopened ' + cycle.label);
    return updated;
  }

  function assertEditable_(cycle) {
    assert(cycle.status === CYCLE_STATUS.DRAFT || cycle.status === CYCLE_STATUS.PUBLISHED,
      'CYCLE_LOCKED',
      cycle.label + ' is ' + cycle.status + '. Reopen it before making changes.');
  }

  function assertPlanEditable_(cycle) {
    assert(cycle.status === CYCLE_STATUS.DRAFT || cycle.status === CYCLE_STATUS.PUBLISHED,
      'CYCLE_LOCKED', 'The plan for ' + cycle.label + ' is locked.');
  }

  /**
   * Pre-publish validation. Returns every problem at once so the Team Lead can
   * fix them in one pass rather than discovering them one at a time.
   */
  function validateCycle(id) {
    var cycle = getCycle(id);
    var errors = [], warnings = [];

    var kras = Repository.where(SHEET.KRA, { cycleId: id })
      .filter(function (k) { return k.active !== false; });
    var kpis = Repository.where(SHEET.KPI, { cycleId: id })
      .filter(function (p) { return p.active !== false; });

    if (!kras.length) errors.push({ code: 'NO_KRA', message: 'The cycle has no KRAs.' });
    if (!kpis.length) errors.push({ code: 'NO_KPI', message: 'The cycle has no KPIs.' });

    // Weightage must total 100 per stream — the rule the spreadsheet assumed
    // but never checked.
    var byStream = {};
    kpis.forEach(function (p) {
      var kra = kras.filter(function (k) { return k.kraId === p.kraId; })[0];
      if (!kra) {
        errors.push({
          code: 'ORPHAN_KPI',
          message: 'KPI "' + p.kpiName + '" is not attached to an active KRA.'
        });
        return;
      }
      byStream[kra.stream] = (byStream[kra.stream] || 0) + Util.num(p.weightage, 0);
    });

    var expected = Config.get('WEIGHTAGE_TOTAL');
    if (Config.get('REQUIRE_WEIGHTAGE_100')) {
      Object.keys(byStream).forEach(function (stream) {
        if (Math.abs(byStream[stream] - expected) > 0.01) {
          errors.push({
            code: 'WEIGHTAGE_TOTAL',
            message: stream + ' weightages total ' + Util.round(byStream[stream], 2) +
              '%, but must total ' + expected + '%.'
          });
        }
      });
    }

    kpis.forEach(function (p) {
      if (!p.metricKey || !(p.metricKey in METRICS)) {
        errors.push({
          code: 'BAD_METRIC',
          message: 'KPI "' + p.kpiName + '" is not linked to a measurable metric.'
        });
      }
      if (Util.num(p.weightage, 0) <= 0) {
        errors.push({ code: 'ZERO_WEIGHT', message: 'KPI "' + p.kpiName + '" has no weightage.' });
      }
      if (p.targetBasis === TARGET_BASIS.PCT_OF_METRIC && !p.basisMetric) {
        errors.push({
          code: 'MISSING_BASIS',
          message: 'KPI "' + p.kpiName + '" derives its target from a percentage but names no base metric.'
        });
      }
    });

    // Assignments
    var assignments = Repository.where(SHEET.ASSIGNMENT, { cycleId: id })
      .filter(function (a) { return a.active !== false; });
    if (!assignments.length) {
      errors.push({ code: 'NO_ASSIGNMENT', message: 'No KPIs have been assigned to any POC.' });
    }
    var assignedPocs = Util.unique(assignments.map(function (a) { return a.pocUserId; }));
    assignedPocs.forEach(function (pocId) {
      var u = Repository.findById(SHEET.USERS, pocId);
      if (!u || u.active === false) {
        errors.push({ code: 'BAD_POC', message: 'An assignment points at an inactive user (' + pocId + ').' });
        return;
      }
      var theirs = assignments.filter(function (a) { return a.pocUserId === pocId; });
      var weight = Util.sum(theirs, function (a) {
        if (a.weightage !== null && a.weightage !== undefined && a.weightage !== '') return a.weightage;
        var kpi = Repository.findById(SHEET.KPI, a.kpiId);
        return kpi ? kpi.weightage : 0;
      });
      if (Config.get('REQUIRE_WEIGHTAGE_100') && Math.abs(weight - expected) > 0.01) {
        errors.push({
          code: 'POC_WEIGHTAGE',
          message: (u.fullName || pocId) + ' carries ' + Util.round(weight, 2) +
            '% of weightage; it must total ' + expected + '%.'
        });
      }
    });

    // Account plans — GMV targets come from here, so an empty book is fatal.
    var plans = Repository.where(SHEET.ACCOUNT_PLAN, { cycleId: id })
      .filter(function (p) { return p.active !== false; });
    var needsAccountPlan = kpis.some(function (p) { return p.targetBasis === TARGET_BASIS.ACCOUNT_PLAN; });
    if (needsAccountPlan && !plans.length) {
      errors.push({
        code: 'NO_ACCOUNT_PLAN',
        message: 'GMV and tonnage targets are derived from the account plan, which is empty.'
      });
    }
    plans.forEach(function (p) {
      if (Util.num(p.tonnageTargetMT, 0) > 0 && Util.num(p.ratePerKgTarget, 0) <= 0) {
        warnings.push({
          code: 'NO_RATE',
          message: p.accountName + ' has a tonnage target but no rate, so its GMV target is zero.'
        });
      }
      if (!p.pocUserId) {
        warnings.push({ code: 'NO_PLAN_POC', message: p.accountName + ' is not assigned to a POC.' });
      }
    });

    // Annual onboarding plan backs the BALANCE_PLUS_MTD targets.
    var needsAnnual = kpis.some(function (p) { return p.targetBasis === TARGET_BASIS.BALANCE_PLUS_MTD; });
    if (needsAnnual) {
      var fy = DateUtil.fiscalYearLabel(new Date(cycle.year, cycle.month - 1, 1));
      var annual = Repository.where(SHEET.ONBOARDING_PLAN, { fiscalYear: fy, category: cycle.category });
      if (!annual.length) {
        warnings.push({
          code: 'NO_ANNUAL_PLAN',
          message: 'No annual onboarding plan exists for ' + fy +
            ', so acquisition targets will fall back to month-to-date achievement.'
        });
      }
    }

    return {
      valid: errors.length === 0,
      errors: errors,
      warnings: warnings,
      summary: {
        kras: kras.length, kpis: kpis.length,
        assignments: assignments.length, pocs: assignedPocs.length,
        accountPlans: plans.length, weightageByStream: byStream
      }
    };
  }

  // =========================================================================
  // KRA / KPI
  // =========================================================================

  function getKraTree(cycleIdValue) {
    var kras = Repository.where(SHEET.KRA, { cycleId: cycleIdValue })
      .filter(function (k) { return k.active !== false; });
    var kpis = Repository.where(SHEET.KPI, { cycleId: cycleIdValue })
      .filter(function (p) { return p.active !== false; });
    var byKra = Util.groupBy(kpis, function (p) { return p.kraId; });
    return Util.sortBy(kras, [
      { pick: function (k) { return k.stream === STREAM.SUPPLY ? 0 : 1; } },
      { pick: function (k) { return Util.num(k.sequence, 99); } }
    ]).map(function (k) {
      var children = Util.sortBy(byKra[k.kraId] || [],
        [{ pick: function (p) { return Util.num(p.sequence, 99); } }]);
      return {
        kraId: k.kraId, stream: k.stream, perspective: k.perspective,
        kraName: k.kraName, sourceOfTracking: k.sourceOfTracking,
        sequence: k.sequence,
        totalWeightage: Util.sum(children, function (p) { return p.weightage; }),
        kpis: children.map(function (p) {
          return {
            kpiId: p.kpiId, kraId: p.kraId, kpiName: p.kpiName, definition: p.definition,
            weightage: p.weightage, unitOfMeasure: p.unitOfMeasure,
            metricKey: p.metricKey, metricLabel: METRICS[p.metricKey] ? METRICS[p.metricKey].label : p.metricKey,
            direction: p.direction, targetBasis: p.targetBasis,
            basisMetric: p.basisMetric, basisPct: p.basisPct,
            targets: [p.target1, p.target2, p.target3, p.target4, p.target5],
            sequence: p.sequence
          };
        })
      };
    });
  }

  function saveKra(payload) {
    Auth.require(PERM.KRA_MANAGE);
    var cycle = getCycle(payload.cycleId);
    assertEditable_(cycle);
    assert(!Util.isBlank(payload.kraName), 'VALIDATION', 'A KRA name is required.');
    assert(STREAMS.indexOf(payload.stream) >= 0, 'VALIDATION', 'Select Supply or Demand.');

    var row = {
      kraId: payload.kraId || Id.next('KRA'),
      cycleId: cycle.cycleId, category: cycle.category, stream: payload.stream,
      perspective: Util.str(payload.perspective), kraName: Util.str(payload.kraName),
      sourceOfTracking: Util.str(payload.sourceOfTracking) || 'Operational Activity',
      sequence: Util.num(payload.sequence, 99), active: true
    };
    var saved = Repository.upsert(SHEET.KRA, row);
    Audit.log(payload.kraId ? 'KRA_UPDATE' : 'KRA_CREATE', SHEET.KRA, saved.kraId,
      saved.kraName + ' (' + saved.stream + ')', null, saved);
    return saved;
  }

  function deleteKra(kraId) {
    Auth.require(PERM.KRA_MANAGE);
    var kra = Repository.findById(SHEET.KRA, kraId);
    assert(kra, 'NOT_FOUND', 'KRA not found.');
    assertEditable_(getCycle(kra.cycleId));
    var kpis = Repository.where(SHEET.KPI, { kraId: kraId })
      .filter(function (p) { return p.active !== false; });
    kpis.forEach(function (p) { Repository.update(SHEET.KPI, p.kpiId, { active: false }); });
    Repository.update(SHEET.KRA, kraId, { active: false });
    Audit.log('KRA_DELETE', SHEET.KRA, kraId, 'Retired ' + kra.kraName +
      ' and ' + kpis.length + ' KPI(s)');
    return { kraId: kraId, kpisRetired: kpis.length };
  }

  function saveKpi(payload) {
    Auth.require(PERM.KRA_MANAGE);
    var kra = Repository.findById(SHEET.KRA, payload.kraId);
    assert(kra, 'VALIDATION', 'Select the KRA this KPI belongs to.');
    var cycle = getCycle(kra.cycleId);
    assertEditable_(cycle);

    assert(!Util.isBlank(payload.kpiName), 'VALIDATION', 'A KPI name is required.');
    assert(payload.metricKey in METRICS, 'VALIDATION',
      'Choose how this KPI is measured — "' + payload.metricKey + '" is not a known metric.');
    var weightage = Util.num(payload.weightage, 0);
    assert(weightage > 0 && weightage <= 100, 'VALIDATION',
      'Weightage must be between 1 and 100.');

    var targets = payload.targets || [];
    var row = {
      kpiId: payload.kpiId || Id.next('KPI'),
      kraId: kra.kraId, cycleId: cycle.cycleId,
      kpiName: Util.str(payload.kpiName), definition: Util.str(payload.definition),
      weightage: weightage,
      unitOfMeasure: Util.str(payload.unitOfMeasure) || 'Percentage',
      metricKey: payload.metricKey,
      direction: payload.direction || (METRICS[payload.metricKey].direction || DIRECTION.HIGHER_BETTER),
      targetBasis: payload.targetBasis || TARGET_BASIS.MANUAL,
      basisMetric: Util.str(payload.basisMetric),
      basisPct: payload.basisPct === '' || payload.basisPct === undefined ? null : Util.num(payload.basisPct, 0),
      target1: Util.num(targets[0], 0.6), target2: Util.num(targets[1], 0.75),
      target3: Util.num(targets[2], 0.9), target4: Util.num(targets[3], 1.0),
      target5: Util.num(targets[4], 1.05),
      sequence: Util.num(payload.sequence, 99), active: true
    };
    var saved = Repository.upsert(SHEET.KPI, row);
    Audit.log(payload.kpiId ? 'KPI_UPDATE' : 'KPI_CREATE', SHEET.KPI, saved.kpiId,
      saved.kpiName + ' · ' + saved.weightage + '%', null, saved);
    return saved;
  }

  function deleteKpi(kpiId) {
    Auth.require(PERM.KRA_MANAGE);
    var kpi = Repository.findById(SHEET.KPI, kpiId);
    assert(kpi, 'NOT_FOUND', 'KPI not found.');
    assertEditable_(getCycle(kpi.cycleId));
    Repository.update(SHEET.KPI, kpiId, { active: false });
    Repository.where(SHEET.ASSIGNMENT, { kpiId: kpiId }).forEach(function (a) {
      Repository.update(SHEET.ASSIGNMENT, a.assignmentId, { active: false });
    });
    Audit.log('KPI_DELETE', SHEET.KPI, kpiId, 'Retired ' + kpi.kpiName);
    return { kpiId: kpiId };
  }

  // =========================================================================
  // Assignments
  // =========================================================================

  function listAssignments(cycleIdValue) {
    var sc = Auth.scope();
    var users = Util.indexBy(Repository.readAll(SHEET.USERS), function (u) { return u.userId; });
    var kpis = Util.indexBy(Repository.where(SHEET.KPI, { cycleId: cycleIdValue }),
      function (p) { return p.kpiId; });
    return Repository.where(SHEET.ASSIGNMENT, { cycleId: cycleIdValue })
      .filter(function (a) {
        return a.active !== false && Auth.inScope(sc, a.pocUserId, a.category, a.regionId);
      })
      .map(function (a) {
        var kpi = kpis[a.kpiId], u = users[a.pocUserId];
        return {
          assignmentId: a.assignmentId, cycleId: a.cycleId, kpiId: a.kpiId,
          kpiName: kpi ? kpi.kpiName : '(retired KPI)',
          metricKey: kpi ? kpi.metricKey : '',
          targetBasis: kpi ? kpi.targetBasis : '',
          pocUserId: a.pocUserId, pocName: u ? u.fullName : a.pocUserId,
          regionId: a.regionId, category: a.category,
          weightage: a.weightage !== null && a.weightage !== '' ? a.weightage : (kpi ? kpi.weightage : 0),
          weightageInherited: a.weightage === null || a.weightage === '',
          targetValue: a.targetValue, targetOverride: !!a.targetOverride,
          dueDate: DateUtil.isoDate(a.dueDate), notes: a.notes
        };
      });
  }

  /**
   * Assign a whole KRA set to a set of POCs in one action — the "assign once"
   * moment. Existing assignments for the same (kpi, poc) pair are updated, not
   * duplicated.
   */
  function assignKpis(payload) {
    Auth.require(PERM.ASSIGNMENT_MANAGE);
    var cycle = getCycle(payload.cycleId);
    assertEditable_(cycle);
    var pocIds = payload.pocUserIds || [];
    var kpiIds = payload.kpiIds || [];
    assert(pocIds.length, 'VALIDATION', 'Select at least one POC.');
    assert(kpiIds.length, 'VALIDATION', 'Select at least one KPI.');

    return Repository.transaction(function () {
      var existing = Repository.where(SHEET.ASSIGNMENT, { cycleId: cycle.cycleId });
      var byKey = {};
      existing.forEach(function (a) { byKey[a.kpiId + '|' + a.pocUserId] = a; });

      var toInsert = [], updated = 0;
      pocIds.forEach(function (pocId) {
        var user = Repository.findById(SHEET.USERS, pocId);
        assert(user, 'VALIDATION', 'Unknown user in the selection.');
        kpiIds.forEach(function (kpiId) {
          var kpi = Repository.findById(SHEET.KPI, kpiId);
          assert(kpi, 'VALIDATION', 'Unknown KPI in the selection.');
          var hit = byKey[kpiId + '|' + pocId];
          var patch = {
            weightage: payload.weightage === undefined || payload.weightage === ''
              ? null : Util.num(payload.weightage, 0),
            targetValue: payload.targetValue === undefined || payload.targetValue === ''
              ? null : Util.num(payload.targetValue, 0),
            targetOverride: !!payload.targetOverride,
            dueDate: payload.dueDate ? DateUtil.parse(payload.dueDate) : cycle.endDate,
            notes: Util.str(payload.notes),
            active: true
          };
          if (hit) {
            Repository.update(SHEET.ASSIGNMENT, hit.assignmentId, patch);
            updated++;
          } else {
            toInsert.push(Object.assign({
              assignmentId: Id.next('ASG'), cycleId: cycle.cycleId, kpiId: kpiId,
              pocUserId: pocId, regionId: user.regionId, category: cycle.category,
              assignedBy: Auth.current().email, assignedAt: new Date()
            }, patch));
          }
        });
      });
      if (toInsert.length) Repository.insertMany(SHEET.ASSIGNMENT, toInsert);

      Audit.log('ASSIGNMENT_SAVE', SHEET.ASSIGNMENT, cycle.cycleId,
        'Assigned ' + kpiIds.length + ' KPI(s) to ' + pocIds.length + ' POC(s)',
        null, { inserted: toInsert.length, updated: updated });
      return { inserted: toInsert.length, updated: updated };
    });
  }

  function updateAssignment(assignmentId, patch) {
    Auth.require(PERM.ASSIGNMENT_MANAGE);
    var a = Repository.findById(SHEET.ASSIGNMENT, assignmentId);
    assert(a, 'NOT_FOUND', 'Assignment not found.');
    assertEditable_(getCycle(a.cycleId));
    var updated = Repository.update(SHEET.ASSIGNMENT, assignmentId, {
      weightage: patch.weightage === '' || patch.weightage === undefined ? null : Util.num(patch.weightage, 0),
      targetValue: patch.targetValue === '' || patch.targetValue === undefined ? null : Util.num(patch.targetValue, 0),
      targetOverride: patch.targetOverride === undefined ? a.targetOverride : !!patch.targetOverride,
      dueDate: patch.dueDate ? DateUtil.parse(patch.dueDate) : a.dueDate,
      notes: patch.notes === undefined ? a.notes : Util.str(patch.notes)
    });
    Audit.log('ASSIGNMENT_UPDATE', SHEET.ASSIGNMENT, assignmentId, 'Updated assignment', a, updated);
    return updated;
  }

  function removeAssignment(assignmentId) {
    Auth.require(PERM.ASSIGNMENT_MANAGE);
    var a = Repository.findById(SHEET.ASSIGNMENT, assignmentId);
    assert(a, 'NOT_FOUND', 'Assignment not found.');
    assertEditable_(getCycle(a.cycleId));
    Repository.update(SHEET.ASSIGNMENT, assignmentId, { active: false });
    Audit.log('ASSIGNMENT_REMOVE', SHEET.ASSIGNMENT, assignmentId, 'Removed assignment');
    return { assignmentId: assignmentId };
  }

  // =========================================================================
  // Account plan (OMP-Sellers / OMP-Buyers target block)
  // =========================================================================

  function listAccountPlans(cycleIdValue, filterSpec) {
    var sc = Auth.scope();
    filterSpec = filterSpec || {};
    var users = Util.indexBy(Repository.readAll(SHEET.USERS), function (u) { return u.userId; });
    var regions = Util.indexBy(Repository.readAll(SHEET.REGIONS), function (r) { return r.regionId; });

    return Repository.where(SHEET.ACCOUNT_PLAN, { cycleId: cycleIdValue })
      .filter(function (p) {
        if (p.active === false) return false;
        if (!Auth.inScope(sc, p.pocUserId, p.category, p.regionId)) return false;
        if (filterSpec.accountType && p.accountType !== filterSpec.accountType) return false;
        if (filterSpec.pocUserId && p.pocUserId !== filterSpec.pocUserId) return false;
        if (filterSpec.regionId && p.regionId !== filterSpec.regionId) return false;
        if (filterSpec.materialType && p.materialType !== filterSpec.materialType) return false;
        if (filterSpec.search) {
          var q = Util.key(filterSpec.search);
          if (Util.key(p.accountName).indexOf(q) < 0 && Util.key(p.gstin).indexOf(q) < 0) return false;
        }
        return true;
      })
      .map(function (p) {
        return {
          planId: p.planId, cycleId: p.cycleId, accountId: p.accountId,
          accountType: p.accountType, gstin: p.gstin, accountName: p.accountName,
          pocUserId: p.pocUserId, pocName: users[p.pocUserId] ? users[p.pocUserId].fullName : '',
          regionId: p.regionId, regionName: regions[p.regionId] ? regions[p.regionId].regionName : '',
          materialType: p.materialType,
          txnTarget: Util.num(p.txnTarget, 0),
          tonnageTargetMT: Util.num(p.tonnageTargetMT, 0),
          ratePerKgTarget: Util.num(p.ratePerKgTarget, 0),
          gmvTargetCr: Util.num(p.gmvTargetCr, 0),
          remarks: p.remarks, detailedRemarks: p.detailedRemarks,
          blockerReason: p.blockerReason
        };
      });
  }

  /**
   * GMV target is always derived, never typed:
   *   GMV_Cr = Tonnage_MT × Rate_per_kg / 10,000       (OMP-Sellers!AH = AF×AG/10000)
   */
  function deriveGmvTargetCr(tonnageMT, ratePerKg) {
    return Util.num(tonnageMT, 0) * Util.num(ratePerKg, 0) / 10000;
  }

  function saveAccountPlan(payload) {
    Auth.require(PERM.PLAN_MANAGE);
    var cycle = getCycle(payload.cycleId);
    assertPlanEditable_(cycle);

    var account = payload.accountId ? Repository.findById(SHEET.ACCOUNTS, payload.accountId) : null;
    if (!account && payload.gstin) {
      account = Repository.find(SHEET.ACCOUNTS, function (a) {
        return Util.key(a.gstin) === Util.key(payload.gstin) && a.category === cycle.category;
      });
    }
    assert(account, 'VALIDATION', 'Select an account, or add it under Accounts first.');

    var user = Auth.current();
    if (!Auth.can(PERM.ACTIVITY_WRITE_ANY, user)) {
      assert(String(account.pocUserId) === String(user.userId), 'FORBIDDEN',
        'You may only plan for accounts assigned to you.');
    }

    var tonnage = Util.num(payload.tonnageTargetMT, 0);
    var rate = Util.num(payload.ratePerKgTarget, 0);
    assert(tonnage >= 0 && rate >= 0, 'VALIDATION', 'Targets cannot be negative.');

    var row = {
      planId: payload.planId || Id.next('PLAN'),
      cycleId: cycle.cycleId, accountId: account.accountId,
      accountType: account.accountType, gstin: account.gstin,
      accountName: account.businessName,
      pocUserId: payload.pocUserId || account.pocUserId,
      regionId: payload.regionId || account.regionId,
      category: cycle.category,
      materialType: payload.materialType || account.materialType,
      txnTarget: Util.num(payload.txnTarget, 0),
      tonnageTargetMT: tonnage,
      ratePerKgTarget: rate,
      gmvTargetCr: deriveGmvTargetCr(tonnage, rate),
      remarks: Util.str(payload.remarks),
      detailedRemarks: Util.str(payload.detailedRemarks),
      blockerReason: Util.str(payload.blockerReason),
      active: true
    };
    var saved = Repository.upsert(SHEET.ACCOUNT_PLAN, row);
    Audit.log(payload.planId ? 'PLAN_UPDATE' : 'PLAN_CREATE', SHEET.ACCOUNT_PLAN, saved.planId,
      saved.accountName + ' → ' + Util.round(saved.gmvTargetCr, 3) + ' Cr', null, saved);
    return saved;
  }

  /** Bulk save from the plan grid — one transaction, one write pass. */
  function saveAccountPlanBatch(cycleIdValue, rows) {
    Auth.require(PERM.PLAN_MANAGE);
    var cycle = getCycle(cycleIdValue);
    assertPlanEditable_(cycle);
    assert(rows && rows.length, 'VALIDATION', 'Nothing to save.');

    return Repository.transaction(function () {
      var accounts = Util.indexBy(
        Repository.readAll(SHEET.ACCOUNTS).filter(function (a) { return a.category === cycle.category; }),
        function (a) { return a.accountId; });
      var prepared = rows.map(function (r) {
        var account = accounts[r.accountId];
        assert(account, 'VALIDATION', 'Unknown account in row for ' + (r.accountName || r.accountId));
        var tonnage = Util.num(r.tonnageTargetMT, 0);
        var rate = Util.num(r.ratePerKgTarget, 0);
        return {
          planId: r.planId || Id.next('PLAN'),
          cycleId: cycle.cycleId, accountId: account.accountId,
          accountType: account.accountType, gstin: account.gstin,
          accountName: account.businessName,
          pocUserId: r.pocUserId || account.pocUserId,
          regionId: r.regionId || account.regionId,
          category: cycle.category,
          materialType: r.materialType || account.materialType,
          txnTarget: Util.num(r.txnTarget, 0),
          tonnageTargetMT: tonnage, ratePerKgTarget: rate,
          gmvTargetCr: deriveGmvTargetCr(tonnage, rate),
          remarks: Util.str(r.remarks), detailedRemarks: Util.str(r.detailedRemarks),
          blockerReason: Util.str(r.blockerReason),
          active: true
        };
      });
      var result = Repository.upsertMany(SHEET.ACCOUNT_PLAN, prepared);
      Audit.log('PLAN_BATCH_SAVE', SHEET.ACCOUNT_PLAN, cycle.cycleId,
        prepared.length + ' account plan rows saved', null, result);
      return result;
    });
  }

  function deleteAccountPlan(planId) {
    Auth.require(PERM.PLAN_MANAGE);
    var p = Repository.findById(SHEET.ACCOUNT_PLAN, planId);
    assert(p, 'NOT_FOUND', 'Plan row not found.');
    assertPlanEditable_(getCycle(p.cycleId));
    Repository.update(SHEET.ACCOUNT_PLAN, planId, { active: false });
    Audit.log('PLAN_DELETE', SHEET.ACCOUNT_PLAN, planId, 'Removed ' + p.accountName + ' from the plan');
    return { planId: planId };
  }

  // =========================================================================
  // Annual onboarding plan (POC-Wise column D)
  // =========================================================================

  function listOnboardingPlans(fiscalYear, category) {
    var users = Util.indexBy(Repository.readAll(SHEET.USERS), function (u) { return u.userId; });
    var regions = Util.indexBy(Repository.readAll(SHEET.REGIONS), function (r) { return r.regionId; });
    return Repository.where(SHEET.ONBOARDING_PLAN, { fiscalYear: fiscalYear, category: category })
      .map(function (p) {
        return {
          onbPlanId: p.onbPlanId, fiscalYear: p.fiscalYear, category: p.category,
          accountType: p.accountType || 'SELLER',
          pocUserId: p.pocUserId, pocName: users[p.pocUserId] ? users[p.pocUserId].fullName : '',
          regionId: p.regionId, regionName: regions[p.regionId] ? regions[p.regionId].regionName : '',
          annualPlan: Util.num(p.annualPlan, 0), notes: p.notes
        };
      });
  }

  function saveOnboardingPlan(payload) {
    Auth.require(PERM.PLAN_MANAGE);
    var user = Repository.findById(SHEET.USERS, payload.pocUserId);
    assert(user, 'VALIDATION', 'Select a POC.');
    assert(!Util.isBlank(payload.fiscalYear), 'VALIDATION', 'Select a fiscal year.');
    var row = {
      onbPlanId: payload.onbPlanId ||
        Id.natural('ONB', payload.fiscalYear, payload.category, payload.accountType || 'SELLER', payload.pocUserId),
      fiscalYear: Util.str(payload.fiscalYear),
      category: payload.category || Config.get('DEFAULT_CATEGORY'),
      accountType: payload.accountType || 'SELLER',
      pocUserId: payload.pocUserId, regionId: payload.regionId || user.regionId,
      annualPlan: Util.num(payload.annualPlan, 0), notes: Util.str(payload.notes)
    };
    var saved = Repository.upsert(SHEET.ONBOARDING_PLAN, row);
    Audit.log('ONBOARDING_PLAN_SAVE', SHEET.ONBOARDING_PLAN, saved.onbPlanId,
      user.fullName + ' → ' + saved.annualPlan + ' accounts in ' + saved.fiscalYear, null, saved);
    return saved;
  }

  // =========================================================================
  // Weekly plan
  // =========================================================================

  function listWeeklyPlan(cycleIdValue, weekStart) {
    var sc = Auth.scope();
    var ws = DateUtil.startOfWeek(weekStart || DateUtil.asOf());
    var users = Util.indexBy(Repository.readAll(SHEET.USERS), function (u) { return u.userId; });
    var rows = Repository.where(SHEET.WEEKLY_PLAN, { cycleId: cycleIdValue })
      .filter(function (r) {
        return DateUtil.isoDate(r.weekStart) === DateUtil.isoDate(ws) &&
          Auth.inScope(sc, r.pocUserId, r.category, r.regionId);
      });
    var byPoc = Util.groupBy(rows, function (r) { return r.pocUserId; });
    var days = [];
    for (var i = 0; i < 7; i++) days.push(DateUtil.addDays(ws, i));

    return {
      weekStart: DateUtil.isoDate(ws),
      days: days.map(function (d) { return DateUtil.isoDate(d); }),
      rows: Object.keys(byPoc).map(function (pocId) {
        var mine = byPoc[pocId];
        var byDay = Util.indexBy(mine, function (r) { return DateUtil.isoDate(r.planDate); });
        return {
          pocUserId: pocId,
          pocName: users[pocId] ? users[pocId].fullName : pocId,
          regionId: mine[0].regionId,
          weeklyTargetMT: Util.sum(mine, function (r) { return r.tonnageTargetMT; }),
          daily: days.map(function (d) {
            var iso = DateUtil.isoDate(d);
            var hit = byDay[iso];
            return {
              date: iso,
              weekPlanId: hit ? hit.weekPlanId : null,
              tonnageTargetMT: hit ? Util.num(hit.tonnageTargetMT, 0) : 0,
              txnTarget: hit ? Util.num(hit.txnTarget, 0) : 0
            };
          })
        };
      })
    };
  }

  function saveWeeklyPlan(cycleIdValue, entries) {
    Auth.require(PERM.PLAN_MANAGE);
    var cycle = getCycle(cycleIdValue);
    assertPlanEditable_(cycle);
    assert(entries && entries.length, 'VALIDATION', 'Nothing to save.');

    return Repository.transaction(function () {
      var prepared = entries.map(function (e) {
        var d = DateUtil.parse(e.date);
        assert(d, 'VALIDATION', 'Invalid date in the weekly plan.');
        var user = Repository.findById(SHEET.USERS, e.pocUserId);
        assert(user, 'VALIDATION', 'Unknown POC in the weekly plan.');
        return {
          weekPlanId: e.weekPlanId ||
            Id.natural('WK', cycle.cycleId, e.pocUserId, DateUtil.isoDate(d)),
          cycleId: cycle.cycleId, category: cycle.category,
          weekStart: DateUtil.startOfWeek(d), planDate: d,
          pocUserId: e.pocUserId, regionId: user.regionId,
          tonnageTargetMT: Util.num(e.tonnageTargetMT, 0),
          txnTarget: Util.num(e.txnTarget, 0),
          notes: Util.str(e.notes)
        };
      });
      var result = Repository.upsertMany(SHEET.WEEKLY_PLAN, prepared);
      Audit.log('WEEKLY_PLAN_SAVE', SHEET.WEEKLY_PLAN, cycle.cycleId,
        prepared.length + ' daily targets saved', null, result);
      return result;
    });
  }

  return {
    cycleId: cycleId,
    listCycles: listCycles,
    activeCycle: activeCycle,
    getCycle: getCycle,
    createCycle: createCycle,
    updateCycle: updateCycle,
    publishCycle: publishCycle,
    lockCycle: lockCycle,
    closeCycle: closeCycle,
    reopenCycle: reopenCycle,
    validateCycle: validateCycle,
    getKraTree: getKraTree,
    saveKra: saveKra,
    deleteKra: deleteKra,
    saveKpi: saveKpi,
    deleteKpi: deleteKpi,
    listAssignments: listAssignments,
    assignKpis: assignKpis,
    updateAssignment: updateAssignment,
    removeAssignment: removeAssignment,
    listAccountPlans: listAccountPlans,
    saveAccountPlan: saveAccountPlan,
    saveAccountPlanBatch: saveAccountPlanBatch,
    deleteAccountPlan: deleteAccountPlan,
    deriveGmvTargetCr: deriveGmvTargetCr,
    listOnboardingPlans: listOnboardingPlans,
    saveOnboardingPlan: saveOnboardingPlan,
    listWeeklyPlan: listWeeklyPlan,
    saveWeeklyPlan: saveWeeklyPlan
  };
})();
