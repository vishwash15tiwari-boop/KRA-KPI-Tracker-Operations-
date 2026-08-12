/**
 * 06_Engine.gs — The calculation engine.
 *
 * This is the only place in the product where a KPI number is produced. Nothing
 * else adds, divides or compares an operational value. Every dashboard, report,
 * scorecard and alert calls into here.
 *
 * The engine is a pure function of (facts, window, scope):
 *
 *      metric(metricKey, window, scope)  →  { value, contributors }
 *
 * `contributors` is what makes every number traceable — it carries the identity
 * of each underlying operational record, so a dashboard tile can be expanded all
 * the way down to the activity, the person, the timestamp, the remark and the
 * evidence link.
 *
 * Fact loading is memoised per execution in a FactSet. A dashboard that computes
 * 7 metrics × 3 windows × 13 scopes still performs exactly one read per table.
 */

var Engine = (function () {

  // =========================================================================
  // Fact set
  // =========================================================================

  var factCache_ = {};

  /**
   * Load every fact table once, decorated with the derived fields the metric
   * functions need. Scoped by category because the two categories are separate
   * businesses that never aggregate together.
   */
  function facts(category) {
    var key = 'F:' + category;
    if (factCache_[key]) return factCache_[key];

    var accounts = Repository.readAll(SHEET.ACCOUNTS)
      .filter(function (a) { return a.category === category && a.active !== false; });
    var accountByGstin = {};
    accounts.forEach(function (a) { if (a.gstin) accountByGstin[Util.key(a.gstin)] = a; });

    var shipments = Repository.readAll(SHEET.SHIPMENTS)
      .filter(function (s) { return s.category === category; })
      .map(function (s) { return decorateShipment_(s, accountByGstin); });

    var onboarding = Repository.readAll(SHEET.ONBOARDING)
      .filter(function (o) { return o.category === category; });

    var pulse = Repository.readAll(SHEET.PULSE)
      .filter(function (p) { return p.category === category; });

    var activities = Repository.readAll(SHEET.ACTIVITIES)
      .filter(function (a) { return a.category === category && !a.voided; });

    var receivables = Repository.readAll(SHEET.RECEIVABLES)
      .filter(function (r) { return r.category === category; });

    // First-transaction date per account: the "existing vs new" discriminator
    // when an account has no onboarding record (pre-platform sellers).
    var firstTxn = {};
    shipments.forEach(function (s) {
      if (!s.isValidTxn || !s.txnDate) return;
      [Util.key(s.sellerGstin), Util.key(s.buyerGstin)].forEach(function (g) {
        if (!g) return;
        if (!firstTxn[g] || s.txnDate < firstTxn[g]) firstTxn[g] = s.txnDate;
      });
    });

    // Onboarded date per GSTIN, from the onboarding fact table.
    var onboardedOn = {};
    onboarding.forEach(function (o) {
      if (Util.key(o.status) !== 'COMPLETED' || !o.onboardedDate) return;
      var g = Util.key(o.gstin);
      if (!g) return;
      if (!onboardedOn[g] || o.onboardedDate < onboardedOn[g]) onboardedOn[g] = o.onboardedDate;
    });
    // Accounts onboarded outside the synced window still carry a date on the
    // account master; use it as a fallback so history is not lost.
    accounts.forEach(function (a) {
      var g = Util.key(a.gstin);
      if (g && !onboardedOn[g] && a.onboardedDate &&
        Util.key(a.onboardingStatus) === 'COMPLETED') {
        onboardedOn[g] = a.onboardedDate;
      }
    });

    var fs = {
      category: category,
      accounts: accounts,
      accountByGstin: accountByGstin,
      shipments: shipments,
      onboarding: onboarding,
      pulse: pulse,
      activities: activities,
      receivables: receivables,
      firstTxn: firstTxn,
      onboardedOn: onboardedOn
    };
    factCache_[key] = fs;
    return fs;
  }

  /**
   * Derive the per-shipment measures the engine reads.
   * GMV basis and the realised-rate GST divisor are config-gated corrections of
   * the two inconsistencies found in the source workbook (see the analysis doc).
   */
  function decorateShipment_(s, accountByGstin) {
    var status = Util.key(s.shipmentStatus);
    var valid = INVALID_TXN_STATUSES.indexOf(status) < 0;
    var taxable = Util.num(s.invoiceTaxableAmount, 0);
    var total = Util.num(s.invoiceTotalAmount, 0);
    var gmvInr = Config.get('GMV_BASIS') === 'TOTAL' ? total : taxable;
    var tonnage = Util.num(s.invoiceQtyMT, 0);

    s.isValidTxn = valid;
    s.gmvInr = valid ? gmvInr : 0;
    s.gmvCr = valid ? gmvInr / Config.get('GMV_CR_DIVISOR') : 0;
    s.tonnageMT = valid ? tonnage : 0;
    s.ratePerKg = tonnage > 0
      ? (taxable / Config.get('RATE_GST_DIVISOR')) / (tonnage * 1000)
      : 0;

    // Resolve demand-side ownership if the sync did not stamp it.
    if (!s.buyerPocUserId && s.buyerGstin) {
      var b = accountByGstin[Util.key(s.buyerGstin)];
      if (b) { s.buyerPocUserId = b.pocUserId; s.buyerRegionId = b.regionId; }
    }

    // Lifecycle SLA measurements.
    s.dispatchLagDays = (s.txnDate && s.dispatchedDate)
      ? DateUtil.diffDays(s.txnDate, s.dispatchedDate) : null;
    s.deliveryLagDays = (s.dispatchedDate && s.receivedDate)
      ? DateUtil.diffDays(s.dispatchedDate, s.receivedDate) : null;
    return s;
  }

  function invalidate() { factCache_ = {}; }

  // =========================================================================
  // Scope
  // =========================================================================

  /**
   * A scope narrows the fact set to one slice of the organisation.
   *   { category, stream, regionId?, pocUserId?, accountId?, materialType? }
   * `stream` decides whether ownership is read from the supply or demand side of
   * a transaction — the same shipment counts for a seller's POC under SUPPLY and
   * for a buyer's POC under DEMAND.
   */
  function scope(spec) {
    return {
      category: spec.category,
      stream: spec.stream || 'BOTH',
      regionId: spec.regionId || null,
      pocUserId: spec.pocUserId || null,
      accountId: spec.accountId || null,
      gstin: spec.gstin || null,
      materialType: spec.materialType || null,
      label: spec.label || '',
      level: spec.pocUserId ? 'POC' : (spec.regionId ? 'REGION' : 'OVERALL')
    };
  }

  function shipmentOwner_(s, stream) {
    if (stream === STREAM.DEMAND) {
      return { poc: s.buyerPocUserId, region: s.buyerRegionId, gstin: s.buyerGstin, name: s.buyerName };
    }
    return { poc: s.pocUserId, region: s.regionId, gstin: s.sellerGstin, name: s.sellerName };
  }

  function shipmentInScope_(s, sc) {
    if (sc.materialType && Util.key(s.materialType) !== Util.key(sc.materialType)) return false;
    if (sc.stream === 'BOTH') {
      // An unscoped total must not double-count: attribute to the supply side.
      return matchOwner_(shipmentOwner_(s, STREAM.SUPPLY), sc);
    }
    return matchOwner_(shipmentOwner_(s, sc.stream), sc);
  }

  function matchOwner_(owner, sc) {
    if (sc.pocUserId && String(owner.poc || '') !== String(sc.pocUserId)) return false;
    if (sc.regionId && String(owner.region || '') !== String(sc.regionId)) return false;
    if (sc.gstin && Util.key(owner.gstin) !== Util.key(sc.gstin)) return false;
    return true;
  }

  function rowInScope_(row, sc) {
    if (sc.pocUserId && String(row.pocUserId || '') !== String(sc.pocUserId)) return false;
    if (sc.regionId && String(row.regionId || '') !== String(sc.regionId)) return false;
    if (sc.gstin && Util.key(row.gstin) !== Util.key(sc.gstin)) return false;
    if (sc.accountId && String(row.accountId || '') !== String(sc.accountId)) return false;
    return true;
  }

  // =========================================================================
  // Metric computation
  // =========================================================================

  /**
   * Compute one metric.
   * Returns { key, value, unit, count, contributors } where `contributors` is a
   * bounded sample of the underlying records with enough identity to drill down.
   */
  function metric(metricKey, window, sc, options) {
    options = options || {};
    var fs = facts(sc.category);
    var trace = options.trace !== false;
    var out = { key: metricKey, value: 0, count: 0, contributors: [] };

    switch (metricKey) {

      // ---- Transaction measures -----------------------------------------
      case 'TXN_COUNT':
      case 'TONNAGE_MT':
      case 'GMV_CR':
      case 'RATE_PER_KG': {
        var tonnage = 0, gmvInr = 0, taxable = 0, n = 0, rows = [];
        for (var i = 0; i < fs.shipments.length; i++) {
          var s = fs.shipments[i];
          if (!s.isValidTxn) continue;
          if (!DateUtil.inWindow(s.txnDate, window)) continue;
          if (!shipmentInScope_(s, sc)) continue;
          n++; tonnage += s.tonnageMT; gmvInr += s.gmvInr;
          taxable += Util.num(s.invoiceTaxableAmount, 0);
          if (trace) rows.push(shipmentTrace_(s, sc));
        }
        out.count = n;
        out.contributors = rows;
        if (metricKey === 'TXN_COUNT') out.value = n;
        else if (metricKey === 'TONNAGE_MT') out.value = tonnage;
        else if (metricKey === 'GMV_CR') out.value = gmvInr / Config.get('GMV_CR_DIVISOR');
        else out.value = tonnage > 0
          ? (taxable / Config.get('RATE_GST_DIVISOR')) / (tonnage * 1000) : 0;
        return out;
      }

      // ---- Onboarding ----------------------------------------------------
      case 'SELLER_ONBOARDED':
      case 'BUYER_ONBOARDED': {
        var wantType = metricKey === 'SELLER_ONBOARDED' ? 'SELLER' : 'BUYER';
        var c = 0, orows = [];
        fs.onboarding.forEach(function (o) {
          if (Util.key(o.accountType || 'SELLER') !== wantType) return;
          if (Util.key(o.status) !== 'COMPLETED') return;
          if (!DateUtil.inWindow(o.onboardedDate, window)) return;
          if (!rowInScope_(o, sc)) return;
          c++;
          if (trace) orows.push(onboardingTrace_(o));
        });
        out.value = c; out.count = c; out.contributors = orows;
        return out;
      }

      // ---- Existing / new / retained transacting accounts ----------------
      case 'EXISTING_SELLER_TXN':
      case 'NEW_SELLER_TXN':
      case 'EXISTING_BUYER_TXN':
      case 'NEW_BUYER_TXN': {
        var side = metricKey.indexOf('SELLER') >= 0 ? STREAM.SUPPLY : STREAM.DEMAND;
        var wantNew = metricKey.indexOf('NEW_') === 0;
        var sideScope = cloneScopeForStream_(sc, side);
        var seen = {}, list = [];
        fs.shipments.forEach(function (s) {
          if (!s.isValidTxn || !DateUtil.inWindow(s.txnDate, window)) return;
          if (!shipmentInScope_(s, sideScope)) return;
          var owner = shipmentOwner_(s, side);
          var g = Util.key(owner.gstin);
          if (!g || seen[g]) return;
          var onb = fs.onboardedOn[g] || null;
          // "New" = onboarded inside this window. "Existing" = onboarded before it.
          // An account with no onboarding record is treated as existing, matching
          // the workbook, which counted every onboarded seller in the denominator.
          var isNew = onb && DateUtil.inWindow(onb, window);
          if (wantNew !== !!isNew) return;
          seen[g] = 1;
          list.push({
            id: g, type: 'ACCOUNT', gstin: owner.gstin, name: owner.name,
            onboardedDate: DateUtil.isoDate(onb),
            pocUserId: owner.poc, regionId: owner.region
          });
        });
        out.value = list.length; out.count = list.length;
        out.contributors = trace ? list : [];
        return out;
      }

      case 'SELLER_RETENTION':
      case 'BUYER_RETENTION': {
        var rside = metricKey.indexOf('SELLER') >= 0 ? STREAM.SUPPLY : STREAM.DEMAND;
        var rScope = cloneScopeForStream_(sc, rside);
        // The month immediately before this window — i.e. the full month that
        // contains the day before the window starts.
        var prev = DateUtil.window('MONTH', DateUtil.addDays(window.start, -1));
        var prevSet = transactingSet_(fs, prev, rScope, rside);
        var curSet = transactingSet_(fs, window, rScope, rside);
        var retained = [];
        Object.keys(curSet).forEach(function (g) {
          if (prevSet[g]) retained.push(curSet[g]);
        });
        out.value = retained.length; out.count = retained.length;
        out.contributors = trace ? retained : [];
        out.meta = { previousBase: Object.keys(prevSet).length };
        return out;
      }

      // ---- Field visits ---------------------------------------------------
      case 'PULSE_VISITS': {
        var v = 0, prows = [];
        fs.pulse.forEach(function (p) {
          if (p.onLeave) return;
          if (!DateUtil.inWindow(p.visitDate, window)) return;
          if (!rowInScope_(p, sc)) return;
          v += Util.num(p.visitCount, 0);
          if (trace) prows.push(pulseTrace_(p));
        });
        out.value = v; out.count = prows.length; out.contributors = prows;
        return out;
      }

      case 'UNIQUE_ACCOUNT_VISITS': {
        var uniq = {}, urows = [];
        fs.pulse.forEach(function (p) {
          if (p.onLeave || !p.gstin) return;
          if (!DateUtil.inWindow(p.visitDate, window)) return;
          if (!rowInScope_(p, sc)) return;
          var g = Util.key(p.gstin);
          if (uniq[g]) return;
          uniq[g] = 1;
          urows.push(pulseTrace_(p));
        });
        out.value = urows.length; out.count = urows.length; out.contributors = urows;
        return out;
      }

      // ---- Coverage: are onboarded accounts actually being serviced? ------
      case 'ONBOARDED_VS_VISIT': {
        var onboardedSet = onboardedAccountSet_(fs, sc, window.end);
        var visited = {}, vrows = [];
        fs.pulse.forEach(function (p) {
          if (p.onLeave || !p.gstin) return;
          if (!DateUtil.inWindow(p.visitDate, window)) return;
          if (!rowInScope_(p, sc)) return;
          var g = Util.key(p.gstin);
          if (!onboardedSet[g] || visited[g]) return;
          visited[g] = 1;
          vrows.push({
            id: g, type: 'ACCOUNT', gstin: p.gstin, name: p.accountName || onboardedSet[g].name,
            lastVisit: DateUtil.isoDate(p.visitDate), pocUserId: p.pocUserId
          });
        });
        out.value = vrows.length; out.count = vrows.length; out.contributors = vrows;
        out.meta = { onboardedBase: Object.keys(onboardedSet).length };
        return out;
      }

      case 'ONBOARDED_VS_TXN': {
        var obSet = onboardedAccountSet_(fs, sc, window.end);
        var txSet = transactingSet_(fs, window, sc, sc.stream === STREAM.DEMAND ? STREAM.DEMAND : STREAM.SUPPLY);
        var hit = [];
        Object.keys(txSet).forEach(function (g) { if (obSet[g]) hit.push(txSet[g]); });
        out.value = hit.length; out.count = hit.length;
        out.contributors = trace ? hit : [];
        out.meta = { onboardedBase: Object.keys(obSet).length };
        return out;
      }

      // ---- Receivables ----------------------------------------------------
      case 'DN_PCT_OF_GMV': {
        var dn = 0, drows = [];
        fs.receivables.forEach(function (r) {
          if (!DateUtil.inWindow(r.asOnDate, window)) return;
          if (!rowInScope_(r, sc)) return;
          dn += Util.num(r.debitNoteINR, 0);
          if (trace) drows.push(receivableTrace_(r));
        });
        var gmvInrForDn = metric('GMV_CR', window, sc, { trace: false }).value *
          Config.get('GMV_CR_DIVISOR');
        out.value = Util.div(dn, gmvInrForDn, 0);
        out.count = drows.length;
        out.contributors = drows;
        out.meta = { debitNoteINR: dn, gmvINR: gmvInrForDn };
        return out;
      }

      case 'DSO_DAYS': {
        // (Average Receivables ÷ GMV) × days in the month.
        var opening = 0, closing = 0, k = 0, rrows = [];
        fs.receivables.forEach(function (r) {
          if (!DateUtil.inWindow(r.asOnDate, window)) return;
          if (!rowInScope_(r, sc)) return;
          opening += Util.num(r.openingReceivableINR, 0);
          closing += Util.num(r.closingReceivableINR, 0);
          k++;
          if (trace) rrows.push(receivableTrace_(r));
        });
        var avgReceivable = k ? (opening + closing) / 2 : 0;
        var gmvInrForDso = metric('GMV_CR', window, sc, { trace: false }).value *
          Config.get('GMV_CR_DIVISOR');
        var days = DateUtil.daysInMonth(window.start);
        out.value = Util.div(avgReceivable, gmvInrForDso, 0) * days;
        out.count = k;
        out.contributors = rrows;
        out.meta = { averageReceivableINR: avgReceivable, gmvINR: gmvInrForDso, days: days };
        return out;
      }

      case 'PAYMENT_COLLECTED_INR':
        return activityMetric_(fs, 'PAYMENT_COLLECTED', 'amountINR', window, sc, trace, out);

      // ---- Activity-sourced counters --------------------------------------
      case 'PROPOSALS_SENT':
        return activityMetric_(fs, ACTIVITY_TYPE.PROPOSAL_SENT, null, window, sc, trace, out);
      case 'LISTINGS_CREATED':
        return activityMetric_(fs, ACTIVITY_TYPE.LISTING_CREATED, null, window, sc, trace, out);
      case 'ORDERS_BOOKED':
        return activityMetric_(fs, ACTIVITY_TYPE.ORDER_BOOKED, null, window, sc, trace, out);
      case 'DOCS_COLLECTED':
        return activityMetric_(fs, ACTIVITY_TYPE.DOCUMENT_COLLECTED, null, window, sc, trace, out);
      case 'FOLLOW_UPS':
        return activityMetric_(fs, ACTIVITY_TYPE.FOLLOW_UP, null, window, sc, trace, out);
      case 'ISSUES_RESOLVED':
        return activityMetric_(fs, ACTIVITY_TYPE.ISSUE_RESOLUTION, null, window, sc, trace, out);

      // ---- Bases used by derived targets -----------------------------------
      case 'ONBOARDED_SELLERS_FYTD':
      case 'ONBOARDED_BUYERS_FYTD': {
        var t = metricKey.indexOf('SELLER') >= 0 ? 'SELLER' : 'BUYER';
        var set = onboardedAccountSet_(fs, sc, window.end, t);
        var keys = Object.keys(set);
        out.value = keys.length; out.count = keys.length;
        out.contributors = trace ? keys.map(function (g) { return set[g]; }) : [];
        return out;
      }

      case 'PREV_MONTH_TRANSACTING_SELLERS':
      case 'PREV_MONTH_TRANSACTING_BUYERS': {
        var pside = metricKey.indexOf('SELLER') >= 0 ? STREAM.SUPPLY : STREAM.DEMAND;
        var pw = DateUtil.window('MONTH', DateUtil.addDays(window.start, -1));
        var pset = transactingSet_(fs, pw, cloneScopeForStream_(sc, pside), pside);
        var pkeys = Object.keys(pset);
        out.value = pkeys.length; out.count = pkeys.length;
        out.contributors = trace ? pkeys.map(function (g) { return pset[g]; }) : [];
        return out;
      }

      default:
        fail('UNKNOWN_METRIC', 'No calculation is defined for metric "' + metricKey + '".');
    }
  }

  function cloneScopeForStream_(sc, stream) {
    return {
      category: sc.category, stream: stream, regionId: sc.regionId,
      pocUserId: sc.pocUserId, accountId: sc.accountId, gstin: sc.gstin,
      materialType: sc.materialType, label: sc.label, level: sc.level
    };
  }

  function activityMetric_(fs, activityType, measureField, window, sc, trace, out) {
    var total = 0, n = 0, rows = [];
    fs.activities.forEach(function (a) {
      if (a.activityType !== activityType) return;
      if (!DateUtil.inWindow(a.activityDate, window)) return;
      if (!rowInScope_(a, sc)) return;
      n++;
      total += measureField ? Util.num(a[measureField], 0) : Util.num(a.count, 1);
      if (trace) rows.push(activityTrace_(a));
    });
    out.value = measureField ? total : (total || n);
    out.count = n;
    out.contributors = rows;
    return out;
  }

  /** Distinct accounts that transacted in a window, keyed by normalised GSTIN. */
  function transactingSet_(fs, window, sc, side) {
    var set = {};
    fs.shipments.forEach(function (s) {
      if (!s.isValidTxn || !DateUtil.inWindow(s.txnDate, window)) return;
      if (!shipmentInScope_(s, cloneScopeForStream_(sc, side))) return;
      var owner = shipmentOwner_(s, side);
      var g = Util.key(owner.gstin);
      if (!g) return;
      if (!set[g]) {
        set[g] = {
          id: g, type: 'ACCOUNT', gstin: owner.gstin, name: owner.name,
          pocUserId: owner.poc, regionId: owner.region, txnCount: 0, gmvCr: 0
        };
      }
      set[g].txnCount++;
      set[g].gmvCr += s.gmvCr;
    });
    return set;
  }

  /** Accounts onboarded (COMPLETED) on or before `asOf`, within scope. */
  function onboardedAccountSet_(fs, sc, asOf, accountType) {
    var wantType = accountType ||
      (sc.stream === STREAM.DEMAND ? 'BUYER' : sc.stream === STREAM.SUPPLY ? 'SELLER' : null);
    var set = {};
    fs.onboarding.forEach(function (o) {
      if (Util.key(o.status) !== 'COMPLETED') return;
      if (wantType && Util.key(o.accountType || 'SELLER') !== wantType) return;
      if (!o.onboardedDate || (asOf && o.onboardedDate.getTime() >= asOf.getTime())) return;
      if (!rowInScope_(o, sc)) return;
      var g = Util.key(o.gstin);
      if (!g) return;
      set[g] = {
        id: g, type: 'ACCOUNT', gstin: o.gstin, name: o.businessName,
        onboardedDate: DateUtil.isoDate(o.onboardedDate),
        pocUserId: o.pocUserId, regionId: o.regionId
      };
    });
    return set;
  }

  // -- Traceability payloads -------------------------------------------------

  function shipmentTrace_(s, sc) {
    var owner = shipmentOwner_(s, sc && sc.stream === STREAM.DEMAND ? STREAM.DEMAND : STREAM.SUPPLY);
    return {
      id: s.shipmentKey, type: 'SHIPMENT',
      date: DateUtil.isoDate(s.txnDate),
      accountName: owner.name, gstin: owner.gstin,
      counterparty: sc && sc.stream === STREAM.DEMAND ? s.sellerName : s.buyerName,
      pocUserId: owner.poc, regionId: owner.region,
      tonnageMT: Util.round(s.tonnageMT, 4),
      gmvCr: Util.round(s.gmvCr, 9),
      ratePerKg: Util.round(s.ratePerKg, 2),
      status: s.shipmentStatus,
      invoiceNumber: s.invoiceNumber,
      materialType: s.materialType,
      evidence: s.ewayBillNumber ? ('E-Way ' + s.ewayBillNumber) : '',
      source: 'DB_Shipments'
    };
  }

  function onboardingTrace_(o) {
    return {
      id: o.onboardingKey, type: 'ONBOARDING',
      date: DateUtil.isoDate(o.onboardedDate),
      accountName: o.businessName, gstin: o.gstin,
      pocUserId: o.pocUserId, regionId: o.regionId,
      status: o.status,
      slaDays: o.onboardingSlaDays,
      slaBreached: !!o.slaBreached,
      submittedBy: o.submittedByName,
      remarks: o.decisionReason,
      source: 'DB_Onboarding'
    };
  }

  function pulseTrace_(p) {
    return {
      id: p.pulseId, type: 'FIELD_VISIT',
      date: DateUtil.isoDate(p.visitDate),
      accountName: p.accountName, gstin: p.gstin,
      pocUserId: p.pocUserId, regionId: p.regionId,
      visits: Util.num(p.visitCount, 0),
      purpose: p.purpose, outcome: p.outcome,
      remarks: p.remarks, evidence: p.evidenceUrl,
      source: 'DB_Pulse'
    };
  }

  function activityTrace_(a) {
    return {
      id: a.activityId, type: a.activityType,
      date: DateUtil.isoDate(a.activityDate),
      accountName: a.accountName, gstin: a.gstin,
      pocUserId: a.pocUserId, regionId: a.regionId,
      quantityMT: a.quantityMT, amountINR: a.amountINR, count: a.count,
      remarks: a.remarks, evidence: a.evidenceUrl,
      verification: a.verificationStatus,
      createdBy: a.createdBy, createdAt: DateUtil.isoDateTime(a.createdAt),
      source: 'DB_Activities'
    };
  }

  function receivableTrace_(r) {
    return {
      id: r.receivableId, type: 'RECEIVABLE',
      date: DateUtil.isoDate(r.asOnDate),
      accountName: r.buyerName, gstin: r.buyerGstin,
      pocUserId: r.pocUserId, regionId: r.regionId,
      openingINR: r.openingReceivableINR, closingINR: r.closingReceivableINR,
      debitNoteINR: r.debitNoteINR, overdueINR: r.overdueINR,
      remarks: r.remarks, source: 'DB_Receivables'
    };
  }

  // =========================================================================
  // Targets
  // =========================================================================

  /**
   * Resolve a KPI's target for a scope in a cycle.
   *
   * Priority: an explicit per-assignment override always wins; otherwise the
   * target is derived from the KPI's declared basis, exactly as the workbook did:
   *
   *   ACCOUNT_PLAN      Σ of the per-account monthly plan (OMP-Sellers!AE:AH)
   *   PCT_OF_METRIC     basisPct × a base metric (50% of onboarded, 70% of
   *                     last month's transacting sellers, …)
   *   BALANCE_PLUS_MTD  (annual plan − FYTD achieved) + MTD achieved
   *                     — POC-Wise!N = G + K
   *   RATE_PER_DAY      workingDays × rate, less leave when configured
   *   MANUAL            the number the Team Lead typed
   */
  function target(kpi, cycle, sc, window, assignment) {
    if (assignment && assignment.targetOverride && assignment.targetValue !== null) {
      return { value: Util.num(assignment.targetValue, 0), basis: 'OVERRIDE', detail: 'Set by Team Lead' };
    }

    switch (kpi.targetBasis) {

      case TARGET_BASIS.ACCOUNT_PLAN: {
        var plans = accountPlansFor_(cycle.cycleId, sc);
        var field = accountPlanFieldFor_(kpi.metricKey);
        var v = Util.sum(plans, function (p) { return p[field]; });
        return {
          value: v, basis: 'ACCOUNT_PLAN',
          detail: plans.length + ' account plan' + (plans.length === 1 ? '' : 's'),
          contributors: plans.map(function (p) {
            return {
              id: p.planId, type: 'ACCOUNT_PLAN', accountName: p.accountName,
              gstin: p.gstin, value: p[field], pocUserId: p.pocUserId
            };
          })
        };
      }

      case TARGET_BASIS.PCT_OF_METRIC: {
        var base = metric(kpi.basisMetric, window, sc, { trace: false });
        var pct = Util.num(kpi.basisPct, 0);
        return {
          value: base.value * pct, basis: 'PCT_OF_METRIC',
          detail: Fmt.pct(pct, 0) + ' of ' + (METRICS[kpi.basisMetric] ?
            METRICS[kpi.basisMetric].label : kpi.basisMetric) + ' (' + Util.round(base.value, 2) + ')',
          baseValue: base.value, basePct: pct
        };
      }

      case TARGET_BASIS.BALANCE_PLUS_MTD: {
        var accountType = kpi.metricKey === 'BUYER_ONBOARDED' ? 'BUYER' : 'SELLER';
        var annual = annualOnboardingPlan_(cycle, sc, accountType);
        var fytd = metric(kpi.metricKey, DateUtil.window('FYTD', window.asOf), sc, { trace: false });
        var mtd = metric(kpi.metricKey, window, sc, { trace: false });
        var balance = Math.max(0, annual - fytd.value);
        return {
          value: balance + mtd.value, basis: 'BALANCE_PLUS_MTD',
          detail: 'Annual plan ' + annual + ' − FYTD ' + fytd.value +
            ' = balance ' + balance + ', plus MTD ' + mtd.value,
          annualPlan: annual, fytdAchieved: fytd.value, balance: balance
        };
      }

      case TARGET_BASIS.RATE_PER_DAY: {
        var workingDays = Util.num(cycle.workingDays, 0) ||
          DateUtil.workingDaysInMonth(new Date(cycle.year, cycle.month - 1, 1));
        var rate = Util.num(kpi.basisPct, 0) || Config.get('PULSE_VISITS_PER_DAY');
        var leave = Config.get('PULSE_DEDUCT_LEAVE') ? leaveDays_(sc, window) : 0;
        var effective = Math.max(0, workingDays - leave);
        return {
          value: effective * rate, basis: 'RATE_PER_DAY',
          detail: effective + ' working days × ' + rate +
            (leave ? ' (after ' + leave + ' leave day' + (leave === 1 ? '' : 's') + ')' : ''),
          workingDays: workingDays, leaveDays: leave, rate: rate
        };
      }

      case TARGET_BASIS.MANUAL:
      default: {
        var t = assignment && assignment.targetValue !== null && assignment.targetValue !== undefined
          ? Util.num(assignment.targetValue, 0)
          : Util.num(kpi.target4, 0); // Target 4 = "meets 100%" in the workbook bands
        return { value: t, basis: 'MANUAL', detail: 'Entered during planning' };
      }
    }
  }

  function accountPlanFieldFor_(metricKey) {
    if (metricKey === 'TONNAGE_MT') return 'tonnageTargetMT';
    if (metricKey === 'TXN_COUNT') return 'txnTarget';
    return 'gmvTargetCr';
  }

  function accountPlansFor_(cycleId, sc) {
    return Repository.where(SHEET.ACCOUNT_PLAN, { cycleId: cycleId }).filter(function (p) {
      if (p.active === false) return false;
      if (sc.pocUserId && String(p.pocUserId) !== String(sc.pocUserId)) return false;
      if (sc.regionId && String(p.regionId) !== String(sc.regionId)) return false;
      if (sc.materialType && Util.key(p.materialType) !== Util.key(sc.materialType)) return false;
      if (sc.stream === STREAM.SUPPLY && p.accountType !== 'SELLER') return false;
      if (sc.stream === STREAM.DEMAND && p.accountType !== 'BUYER') return false;
      return true;
    });
  }

  function annualOnboardingPlan_(cycle, sc, accountType) {
    var fy = DateUtil.fiscalYearLabel(new Date(cycle.year, cycle.month - 1, 1));
    return Util.sum(
      Repository.where(SHEET.ONBOARDING_PLAN, { fiscalYear: fy, category: cycle.category })
        .filter(function (p) {
          if (accountType && p.accountType && p.accountType !== accountType) return false;
          if (sc.pocUserId && String(p.pocUserId) !== String(sc.pocUserId)) return false;
          if (sc.regionId && String(p.regionId) !== String(sc.regionId)) return false;
          return true;
        }),
      function (p) { return p.annualPlan; });
  }

  function leaveDays_(sc, window) {
    var fs = facts(sc.category);
    var days = {};
    fs.pulse.forEach(function (p) {
      if (!p.onLeave || !DateUtil.inWindow(p.visitDate, window)) return;
      if (!rowInScope_(p, sc)) return;
      days[DateUtil.isoDate(p.visitDate) + '|' + p.pocUserId] = 1;
    });
    return Object.keys(days).length;
  }

  // =========================================================================
  // Achievement, pace, rating
  // =========================================================================

  /**
   * Turn a (target, actual) pair into the full decision payload leadership
   * reads: achievement, capped achievement, weighted contribution, rating band,
   * run rates and the projected month-end landing.
   */
  function evaluate(spec) {
    var direction = spec.direction || DIRECTION.HIGHER_BETTER;
    var targetValue = Util.num(spec.target, 0);
    var actual = Util.num(spec.actual, 0);
    var cap = Config.get('ACHIEVEMENT_CAP');

    // Lower-is-better inverts the ratio so 1.0 still means "on plan".
    var achievement = direction === DIRECTION.LOWER_BETTER
      ? (actual > 0 ? Util.div(targetValue, actual, 0) : (targetValue > 0 ? cap : 0))
      : Util.div(actual, targetValue, 0);

    var capped = Math.min(achievement, cap);
    var weight = Util.num(spec.weightage, 0);

    var elapsed = spec.elapsedDays || 1;
    var remaining = spec.remainingDays === undefined ? 0 : spec.remainingDays;
    var currentDrr = Util.div(actual, elapsed, 0);
    var gap = Math.max(0, targetValue - actual);
    var requiredDrr = remaining > 0 ? Util.div(gap, remaining, 0) : gap;

    // Straight-line projection: today's run rate held to month end.
    var projected = actual + currentDrr * remaining;
    var projectedAchievement = direction === DIRECTION.LOWER_BETTER
      ? (projected > 0 ? Util.div(targetValue, projected, 0) : 0)
      : Util.div(projected, targetValue, 0);

    var paceRatio = requiredDrr > 0 ? Util.div(currentDrr, requiredDrr, 0)
      : (achievement >= 1 ? cap : 0);

    return {
      target: targetValue,
      actual: actual,
      gap: gap,
      achievement: achievement,
      cappedAchievement: capped,
      weightage: weight,
      weightedScore: capped * weight,
      maxWeightedScore: weight * cap,
      rating: ratingFor(achievement),
      ratingLabel: ratingLabelFor(achievement),
      bandLabel: bandLabelFor(achievement),
      tone: toneFor(achievement),
      currentDrr: currentDrr,
      requiredDrr: requiredDrr,
      paceRatio: paceRatio,
      paceStatus: paceStatusFor(paceRatio, achievement),
      projected: projected,
      projectedAchievement: projectedAchievement,
      elapsedDays: elapsed,
      remainingDays: remaining,
      lmtd: spec.lmtd === undefined ? null : Util.num(spec.lmtd, 0),
      growthPct: spec.lmtd === undefined ? null
        : Util.div(actual - Util.num(spec.lmtd, 0), Util.num(spec.lmtd, 0), 0),
      direction: direction
    };
  }

  function ratingFor(achievement) {
    for (var i = 0; i < RATING_SCALE.length; i++) {
      if (achievement >= RATING_SCALE[i].threshold) return RATING_SCALE[i].rating;
    }
    return 0;
  }

  function ratingLabelFor(achievement) {
    for (var i = 0; i < RATING_SCALE.length; i++) {
      if (achievement >= RATING_SCALE[i].threshold) return RATING_SCALE[i].label;
    }
    return RATING_SCALE[RATING_SCALE.length - 1].label;
  }

  function toneFor(achievement) {
    for (var i = 0; i < RATING_SCALE.length; i++) {
      if (achievement >= RATING_SCALE[i].threshold) return RATING_SCALE[i].tone;
    }
    return 'critical';
  }

  /** The legacy status string shown on the per-POC scorecard (column I). */
  function bandLabelFor(achievement) {
    for (var i = 0; i < TARGET_BAND_LABELS.length; i++) {
      if (achievement >= TARGET_BAND_LABELS[i].threshold) return TARGET_BAND_LABELS[i].label;
    }
    return 'Below 60%';
  }

  function paceStatusFor(paceRatio, achievement) {
    if (achievement >= 1) return 'ACHIEVED';
    if (paceRatio >= 1) return 'ON_TRACK';
    if (paceRatio >= Config.get('PACE_WARN_RATIO')) return 'ON_TRACK';
    if (paceRatio >= Config.get('PACE_CRITICAL_RATIO')) return 'AT_RISK';
    return 'CRITICAL';
  }

  /**
   * Roll a set of evaluated KPIs into a scorecard.
   * Reproduces BDM Summary: score = Σ(capped × weight), overall = score ÷ Σweight,
   * itself capped at 105%.
   */
  function scorecard(evaluatedKpis) {
    var totalWeight = Util.sum(evaluatedKpis, function (k) { return k.weightage; });
    var weightedScore = Util.sum(evaluatedKpis, function (k) { return k.weightedScore; });
    var denominator = totalWeight || Config.get('WEIGHTAGE_TOTAL');
    var overall = Math.min(Util.div(weightedScore, denominator, 0), Config.get('ACHIEVEMENT_CAP'));
    return {
      totalWeightage: totalWeight,
      weightedScore: Util.round(weightedScore, 6),
      maxWeightedScore: Util.round(denominator * Config.get('ACHIEVEMENT_CAP'), 2),
      overallAchievement: overall,
      rating: ratingFor(overall),
      ratingLabel: ratingLabelFor(overall),
      tone: toneFor(overall),
      kpiCount: evaluatedKpis.length,
      weightageValid: Math.abs(totalWeight - Config.get('WEIGHTAGE_TOTAL')) < 0.01
    };
  }

  return {
    facts: facts,
    invalidate: invalidate,
    scope: scope,
    metric: metric,
    target: target,
    evaluate: evaluate,
    scorecard: scorecard,
    ratingFor: ratingFor,
    ratingLabelFor: ratingLabelFor,
    bandLabelFor: bandLabelFor,
    toneFor: toneFor,
    transactingSet: transactingSet_,
    onboardedAccountSet: onboardedAccountSet_,
    accountPlansFor: accountPlansFor_
  };
})();
