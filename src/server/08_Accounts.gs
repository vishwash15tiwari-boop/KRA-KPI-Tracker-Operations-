/**
 * 08_Accounts.gs — Sellers, buyers, the onboarding pipeline and its document
 * checklist.
 *
 * An account exists exactly once, keyed by GSTIN, and everything else points at
 * it. The source workbook repeated seller identity across five sheets; here the
 * plan, the activity, the shipment fact and the pipeline row all reference the
 * same record.
 */

var Accounts = (function () {

  function normaliseGstin(v) {
    return Util.str(v).toUpperCase().replace(/\s+/g, '');
  }

  /** Structural GSTIN check: 2-digit state, 10-char PAN, entity, Z, checksum. */
  function isValidGstin(v) {
    return /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/.test(normaliseGstin(v));
  }

  function list(filterSpec) {
    filterSpec = filterSpec || {};
    var sc = Auth.scope();
    var users = Util.indexBy(Repository.readAll(SHEET.USERS), function (u) { return u.userId; });
    var regions = Util.indexBy(Repository.readAll(SHEET.REGIONS), function (r) { return r.regionId; });
    var q = filterSpec.search ? Util.key(filterSpec.search) : null;

    var rows = Repository.readAll(SHEET.ACCOUNTS).filter(function (a) {
      if (a.active === false && !filterSpec.includeInactive) return false;
      if (!Auth.inScope(sc, a.pocUserId, a.category, a.regionId)) return false;
      if (filterSpec.category && a.category !== filterSpec.category) return false;
      if (filterSpec.accountType && a.accountType !== filterSpec.accountType) return false;
      if (filterSpec.pocUserId && a.pocUserId !== filterSpec.pocUserId) return false;
      if (filterSpec.regionId && a.regionId !== filterSpec.regionId) return false;
      if (filterSpec.materialType && a.materialType !== filterSpec.materialType) return false;
      if (filterSpec.onboardingStatus && a.onboardingStatus !== filterSpec.onboardingStatus) return false;
      if (q) {
        var hay = Util.key(a.businessName) + ' ' + Util.key(a.gstin) + ' ' +
          Util.key(a.city) + ' ' + Util.key(a.state);
        if (hay.indexOf(q) < 0) return false;
      }
      return true;
    });

    var mapped = rows.map(function (a) { return shape_(a, users, regions); });
    return filterSpec.limit ? mapped.slice(0, filterSpec.limit) : mapped;
  }

  function shape_(a, users, regions) {
    var dormantAfter = Config.get('DORMANCY_DAYS');
    var lastActivity = a.lastTxnDate || a.lastVisitDate || a.onboardedDate;
    var idleDays = lastActivity ? DateUtil.diffDays(lastActivity, DateUtil.asOf()) : null;
    return {
      accountId: a.accountId, accountType: a.accountType, gstin: a.gstin,
      externalId: a.externalId, businessName: a.businessName, category: a.category,
      regionId: a.regionId, regionName: regions[a.regionId] ? regions[a.regionId].regionName : '',
      pocUserId: a.pocUserId, pocName: users[a.pocUserId] ? users[a.pocUserId].fullName : '',
      contactPerson: a.contactPerson, mobile: a.mobile, email: a.email,
      state: a.state, city: a.city,
      accountSubType: a.accountSubType, materialType: a.materialType,
      paymentTerms: a.paymentTerms, counterpartyName: a.counterpartyName,
      onboardingStatus: a.onboardingStatus,
      onboardedDate: DateUtil.isoDate(a.onboardedDate),
      firstTxnDate: DateUtil.isoDate(a.firstTxnDate),
      lastTxnDate: DateUtil.isoDate(a.lastTxnDate),
      lastVisitDate: DateUtil.isoDate(a.lastVisitDate),
      businessVintage: a.businessVintage,
      blockerReason: a.blockerReason, remarks: a.remarks,
      active: a.active !== false,
      idleDays: idleDays,
      dormant: idleDays !== null && idleDays > dormantAfter,
      neverTransacted: !a.firstTxnDate
    };
  }

  function get(accountId) {
    var a = Repository.findById(SHEET.ACCOUNTS, accountId);
    assert(a, 'NOT_FOUND', 'Account not found.');
    var users = Util.indexBy(Repository.readAll(SHEET.USERS), function (u) { return u.userId; });
    var regions = Util.indexBy(Repository.readAll(SHEET.REGIONS), function (r) { return r.regionId; });
    return shape_(a, users, regions);
  }

  function findByGstin(gstin, category) {
    var g = normaliseGstin(gstin);
    if (!g) return null;
    return Repository.find(SHEET.ACCOUNTS, function (a) {
      return normaliseGstin(a.gstin) === g && (!category || a.category === category);
    });
  }

  function save(payload) {
    Auth.require(PERM.PIPELINE_MANAGE);
    var user = Auth.current();
    var gstin = normaliseGstin(payload.gstin);
    assert(!Util.isBlank(payload.businessName), 'VALIDATION', 'A business name is required.');
    assert(['SELLER', 'BUYER'].indexOf(payload.accountType) >= 0, 'VALIDATION',
      'Select whether this is a seller or a buyer.');
    if (gstin) {
      assert(isValidGstin(gstin), 'VALIDATION',
        'That does not look like a valid GSTIN (expected 15 characters, e.g. 27AAKCA0967H1ZI).');
      var clash = findByGstin(gstin, payload.category || Config.get('DEFAULT_CATEGORY'));
      assert(!clash || clash.accountId === payload.accountId, 'DUPLICATE',
        'GSTIN ' + gstin + ' already belongs to "' + (clash && clash.businessName) + '".');
    }

    var pocUserId = payload.pocUserId || user.userId;
    if (!Auth.can(PERM.ACTIVITY_WRITE_ANY, user)) pocUserId = user.userId;
    var poc = Repository.findById(SHEET.USERS, pocUserId);

    var row = {
      accountId: payload.accountId || Id.next('ACC'),
      accountType: payload.accountType,
      gstin: gstin,
      externalId: Util.str(payload.externalId),
      businessName: Util.str(payload.businessName),
      category: payload.category || Config.get('DEFAULT_CATEGORY'),
      regionId: payload.regionId || (poc ? poc.regionId : ''),
      pocUserId: pocUserId,
      contactPerson: Util.str(payload.contactPerson),
      mobile: Util.str(payload.mobile),
      email: Util.str(payload.email),
      state: Util.str(payload.state),
      city: Util.str(payload.city),
      accountSubType: Util.str(payload.accountSubType),
      materialType: Util.str(payload.materialType),
      paymentTerms: Util.str(payload.paymentTerms),
      counterpartyName: Util.str(payload.counterpartyName),
      onboardingStatus: payload.onboardingStatus || ONBOARDING_STATUS.DRAFT,
      onboardedDate: payload.onboardedDate ? DateUtil.parse(payload.onboardedDate) : null,
      businessVintage: Util.str(payload.businessVintage),
      blockerReason: Util.str(payload.blockerReason),
      remarks: Util.str(payload.remarks),
      active: payload.active === undefined ? true : !!payload.active,
      sourceSystem: 'APP'
    };

    // Preserve system-maintained fields on update.
    if (payload.accountId) {
      var existing = Repository.findById(SHEET.ACCOUNTS, payload.accountId);
      assert(existing, 'NOT_FOUND', 'Account not found.');
      row.firstTxnDate = existing.firstTxnDate;
      row.lastTxnDate = existing.lastTxnDate;
      row.lastVisitDate = existing.lastVisitDate;
      row.sourceSystem = existing.sourceSystem || 'APP';
      if (!row.onboardedDate) row.onboardedDate = existing.onboardedDate;
    }

    var saved = Repository.upsert(SHEET.ACCOUNTS, row);
    Engine.invalidate();
    Audit.log(payload.accountId ? 'ACCOUNT_UPDATE' : 'ACCOUNT_CREATE', SHEET.ACCOUNTS,
      saved.accountId, saved.businessName + ' (' + saved.accountType + ')', null, saved);
    return saved;
  }

  function reassign(accountIds, pocUserId) {
    Auth.require(PERM.PLAN_MANAGE);
    var poc = Repository.findById(SHEET.USERS, pocUserId);
    assert(poc, 'VALIDATION', 'Select a POC to reassign to.');
    var n = 0;
    Repository.transaction(function () {
      (accountIds || []).forEach(function (id) {
        var a = Repository.findById(SHEET.ACCOUNTS, id);
        if (!a) return;
        Repository.update(SHEET.ACCOUNTS, id, { pocUserId: pocUserId, regionId: poc.regionId });
        n++;
      });
    });
    Engine.invalidate();
    Audit.log('ACCOUNT_REASSIGN', SHEET.ACCOUNTS, '',
      n + ' account(s) reassigned to ' + poc.fullName, null, { accountIds: accountIds });
    return { reassigned: n, pocUserId: pocUserId };
  }

  // =========================================================================
  // Pipeline — 📋 Aug Buyer Plan and the prospect lists
  // =========================================================================

  function listPipeline(filterSpec) {
    filterSpec = filterSpec || {};
    var sc = Auth.scope();
    var users = Util.indexBy(Repository.readAll(SHEET.USERS), function (u) { return u.userId; });
    var regions = Util.indexBy(Repository.readAll(SHEET.REGIONS), function (r) { return r.regionId; });
    var docs = Util.groupBy(Repository.readAll(SHEET.DOCUMENTS), function (d) { return d.pipelineId; });

    return Repository.readAll(SHEET.PIPELINE)
      .filter(function (p) {
        if (p.active === false) return false;
        if (!Auth.inScope(sc, p.pocUserId, p.category, p.regionId)) return false;
        if (filterSpec.category && p.category !== filterSpec.category) return false;
        if (filterSpec.accountType && p.accountType !== filterSpec.accountType) return false;
        if (filterSpec.stage && p.stage !== filterSpec.stage) return false;
        if (filterSpec.pocUserId && p.pocUserId !== filterSpec.pocUserId) return false;
        if (filterSpec.search) {
          var q = Util.key(filterSpec.search);
          if (Util.key(p.businessName).indexOf(q) < 0) return false;
        }
        return true;
      })
      .map(function (p) {
        var mine = docs[p.pipelineId] || [];
        var required = DOCUMENT_SLOTS.filter(function (s) { return s.required; });
        var collected = mine.filter(function (d) { return d.collected; });
        var collectedRequired = required.filter(function (s) {
          return mine.some(function (d) { return d.slotKey === s.key && d.collected; });
        });
        var docStatus = collectedRequired.length === 0 ? 'Not Collected'
          : collectedRequired.length < required.length ? 'Partially Collected'
            : 'Collected';
        return {
          pipelineId: p.pipelineId, accountType: p.accountType, category: p.category,
          businessName: p.businessName, gstin: p.gstin, commodity: p.commodity,
          regionId: p.regionId, regionName: regions[p.regionId] ? regions[p.regionId].regionName : '',
          state: p.state, city: p.city, mobile: p.mobile, contactPerson: p.contactPerson,
          pocUserId: p.pocUserId, pocName: users[p.pocUserId] ? users[p.pocUserId].fullName : '',
          paymentTerms: p.paymentTerms, stage: p.stage,
          documentStatus: docStatus,
          documentsCollected: collected.length,
          documentsRequired: required.length,
          documentsComplete: collectedRequired.length === required.length,
          expectedTonnageMT: Util.num(p.expectedTonnageMT, 0),
          expectedOnboardDate: DateUtil.isoDate(p.expectedOnboardDate),
          onboardedDate: DateUtil.isoDate(p.onboardedDate),
          currentOrders: Util.num(p.currentOrders, 0),
          blockerReason: p.blockerReason, remarks: p.remarks,
          lastActionDate: DateUtil.isoDate(p.lastActionDate),
          nextActionDate: DateUtil.isoDate(p.nextActionDate),
          overdue: p.nextActionDate && p.nextActionDate < DateUtil.today() &&
            p.stage !== PIPELINE_STAGE.ONBOARDED && p.stage !== PIPELINE_STAGE.DROPPED,
          documents: DOCUMENT_SLOTS.map(function (slot) {
            var hit = mine.filter(function (d) { return d.slotKey === slot.key; })[0];
            return {
              slotKey: slot.key, slotLabel: slot.label, required: slot.required,
              collected: hit ? !!hit.collected : false,
              evidenceUrl: hit ? hit.evidenceUrl : '',
              collectedDate: hit ? DateUtil.isoDate(hit.collectedDate) : '',
              documentId: hit ? hit.documentId : null
            };
          })
        };
      });
  }

  function savePipeline(payload) {
    Auth.require(PERM.PIPELINE_MANAGE);
    var user = Auth.current();
    assert(!Util.isBlank(payload.businessName), 'VALIDATION', 'A business name is required.');
    var pocUserId = payload.pocUserId || user.userId;
    if (!Auth.can(PERM.ACTIVITY_WRITE_ANY, user)) pocUserId = user.userId;
    var poc = Repository.findById(SHEET.USERS, pocUserId);

    var row = {
      pipelineId: payload.pipelineId || Id.next('PIPE'),
      accountType: payload.accountType || 'BUYER',
      category: payload.category || Config.get('DEFAULT_CATEGORY'),
      businessName: Util.str(payload.businessName),
      gstin: normaliseGstin(payload.gstin),
      commodity: Util.str(payload.commodity),
      regionId: payload.regionId || (poc ? poc.regionId : ''),
      state: Util.str(payload.state), city: Util.str(payload.city),
      mobile: Util.str(payload.mobile), contactPerson: Util.str(payload.contactPerson),
      pocUserId: pocUserId,
      paymentTerms: Util.str(payload.paymentTerms),
      stage: payload.stage || PIPELINE_STAGE.PROSPECT,
      expectedTonnageMT: Util.num(payload.expectedTonnageMT, 0),
      expectedOnboardDate: payload.expectedOnboardDate ? DateUtil.parse(payload.expectedOnboardDate) : null,
      onboardedDate: payload.onboardedDate ? DateUtil.parse(payload.onboardedDate) : null,
      currentOrders: Util.num(payload.currentOrders, 0),
      blockerReason: Util.str(payload.blockerReason),
      remarks: Util.str(payload.remarks),
      lastActionDate: DateUtil.today(),
      nextActionDate: payload.nextActionDate ? DateUtil.parse(payload.nextActionDate) : null,
      active: true
    };

    // Gate: a pipeline row cannot be marked ONBOARDED until every required
    // document is collected. This is the rule the emoji checklist implied.
    if (row.stage === PIPELINE_STAGE.ONBOARDED && payload.pipelineId) {
      var docs = Repository.where(SHEET.DOCUMENTS, { pipelineId: payload.pipelineId });
      var missing = DOCUMENT_SLOTS.filter(function (s) {
        return s.required && !docs.some(function (d) { return d.slotKey === s.key && d.collected; });
      });
      assert(!missing.length, 'VALIDATION',
        'Cannot mark as onboarded — missing: ' +
        missing.map(function (m) { return m.label; }).join(', ') + '.');
      if (!row.onboardedDate) row.onboardedDate = DateUtil.today();
    }

    var saved = Repository.upsert(SHEET.PIPELINE, row);

    // Promote to a real account the moment onboarding completes.
    if (saved.stage === PIPELINE_STAGE.ONBOARDED && saved.gstin) {
      promoteToAccount_(saved);
    }

    Audit.log(payload.pipelineId ? 'PIPELINE_UPDATE' : 'PIPELINE_CREATE', SHEET.PIPELINE,
      saved.pipelineId, saved.businessName + ' → ' + saved.stage, null, saved);
    return saved;
  }

  function promoteToAccount_(p) {
    var existing = findByGstin(p.gstin, p.category);
    var row = {
      accountId: existing ? existing.accountId : Id.next('ACC'),
      accountType: p.accountType, gstin: p.gstin, businessName: p.businessName,
      category: p.category, regionId: p.regionId, pocUserId: p.pocUserId,
      contactPerson: p.contactPerson, mobile: p.mobile,
      state: p.state, city: p.city, materialType: p.commodity,
      paymentTerms: p.paymentTerms,
      onboardingStatus: ONBOARDING_STATUS.COMPLETED,
      onboardedDate: p.onboardedDate || DateUtil.today(),
      remarks: p.remarks, active: true, sourceSystem: 'PIPELINE'
    };
    if (existing) {
      row.firstTxnDate = existing.firstTxnDate;
      row.lastTxnDate = existing.lastTxnDate;
      row.lastVisitDate = existing.lastVisitDate;
    }
    var account = Repository.upsert(SHEET.ACCOUNTS, row);

    // Onboarding is a KPI-bearing fact, so it must land in the fact table too.
    Repository.upsert(SHEET.ONBOARDING, {
      onboardingKey: Id.natural('ONBK', p.category, p.gstin),
      accountType: p.accountType, category: p.category,
      gstin: p.gstin, businessName: p.businessName,
      regionId: p.regionId, pocUserId: p.pocUserId,
      status: ONBOARDING_STATUS.COMPLETED,
      contactPerson: p.contactPerson, mobile: p.mobile,
      state: p.state, city: p.city,
      createdDate: p.createdAt || new Date(),
      onboardedDate: row.onboardedDate,
      syncedAt: new Date(), syncBatch: 'PIPELINE'
    });
    Engine.invalidate();
    return account;
  }

  function setDocument(payload) {
    Auth.require(PERM.PIPELINE_MANAGE);
    var pipeline = Repository.findById(SHEET.PIPELINE, payload.pipelineId);
    assert(pipeline, 'NOT_FOUND', 'Pipeline record not found.');
    var slot = DOCUMENT_SLOTS.filter(function (s) { return s.key === payload.slotKey; })[0];
    assert(slot, 'VALIDATION', 'Unknown document slot.');
    if (payload.collected) {
      assert(!Util.isBlank(payload.evidenceUrl), 'VALIDATION',
        'Attach a link to the ' + slot.label + ' before marking it collected.');
      assertEvidenceUrl_(payload.evidenceUrl);
    }
    var row = {
      documentId: payload.documentId || Id.natural('DOC', payload.pipelineId, payload.slotKey),
      pipelineId: pipeline.pipelineId,
      accountId: payload.accountId || '',
      slotKey: slot.key, slotLabel: slot.label,
      collected: !!payload.collected,
      evidenceUrl: Util.str(payload.evidenceUrl),
      collectedDate: payload.collected ? (DateUtil.parse(payload.collectedDate) || DateUtil.today()) : null,
      expiryDate: payload.expiryDate ? DateUtil.parse(payload.expiryDate) : null,
      remarks: Util.str(payload.remarks)
    };
    var saved = Repository.upsert(SHEET.DOCUMENTS, row);
    Repository.update(SHEET.PIPELINE, pipeline.pipelineId, { lastActionDate: DateUtil.today() });
    Audit.log('DOCUMENT_SET', SHEET.DOCUMENTS, saved.documentId,
      pipeline.businessName + ' · ' + slot.label + (saved.collected ? ' collected' : ' cleared'));
    return saved;
  }

  function assertEvidenceUrl_(url) {
    var pattern = new RegExp(Config.get('EVIDENCE_URL_PATTERN'));
    assert(pattern.test(Util.str(url)), 'VALIDATION',
      'Evidence must be a link starting with https://');
  }

  // =========================================================================
  // Receivables (feeds DSO and DN % of GMV)
  // =========================================================================

  function listReceivables(cycleIdValue) {
    var sc = Auth.scope();
    var users = Util.indexBy(Repository.readAll(SHEET.USERS), function (u) { return u.userId; });
    return Repository.where(SHEET.RECEIVABLES, { cycleId: cycleIdValue })
      .filter(function (r) { return Auth.inScope(sc, r.pocUserId, r.category, r.regionId); })
      .map(function (r) {
        return {
          receivableId: r.receivableId, cycleId: r.cycleId,
          buyerGstin: r.buyerGstin, buyerName: r.buyerName,
          pocUserId: r.pocUserId, pocName: users[r.pocUserId] ? users[r.pocUserId].fullName : '',
          regionId: r.regionId, asOnDate: DateUtil.isoDate(r.asOnDate),
          openingReceivableINR: Util.num(r.openingReceivableINR, 0),
          closingReceivableINR: Util.num(r.closingReceivableINR, 0),
          debitNoteINR: Util.num(r.debitNoteINR, 0),
          creditNoteINR: Util.num(r.creditNoteINR, 0),
          overdueINR: Util.num(r.overdueINR, 0),
          remarks: r.remarks
        };
      });
  }

  function saveReceivable(payload) {
    Auth.require(PERM.PLAN_MANAGE);
    var cycle = Planning.getCycle(payload.cycleId);
    var account = payload.accountId ? Repository.findById(SHEET.ACCOUNTS, payload.accountId)
      : findByGstin(payload.buyerGstin, cycle.category);
    assert(account, 'VALIDATION', 'Select the buyer this receivable belongs to.');
    var row = {
      receivableId: payload.receivableId ||
        Id.natural('RCV', cycle.cycleId, account.gstin, DateUtil.isoDate(payload.asOnDate || DateUtil.asOf())),
      cycleId: cycle.cycleId, category: cycle.category,
      buyerGstin: account.gstin, buyerName: account.businessName,
      pocUserId: account.pocUserId, regionId: account.regionId,
      asOnDate: DateUtil.parse(payload.asOnDate) || DateUtil.asOf(),
      openingReceivableINR: Util.num(payload.openingReceivableINR, 0),
      closingReceivableINR: Util.num(payload.closingReceivableINR, 0),
      debitNoteINR: Util.num(payload.debitNoteINR, 0),
      creditNoteINR: Util.num(payload.creditNoteINR, 0),
      overdueINR: Util.num(payload.overdueINR, 0),
      remarks: Util.str(payload.remarks)
    };
    var saved = Repository.upsert(SHEET.RECEIVABLES, row);
    Engine.invalidate();
    Audit.log('RECEIVABLE_SAVE', SHEET.RECEIVABLES, saved.receivableId,
      saved.buyerName + ' as on ' + DateUtil.isoDate(saved.asOnDate), null, saved);
    return saved;
  }

  return {
    normaliseGstin: normaliseGstin,
    isValidGstin: isValidGstin,
    list: list,
    get: get,
    findByGstin: findByGstin,
    save: save,
    reassign: reassign,
    listPipeline: listPipeline,
    savePipeline: savePipeline,
    setDocument: setDocument,
    listReceivables: listReceivables,
    saveReceivable: saveReceivable,
    assertEvidenceUrl: assertEvidenceUrl_
  };
})();
