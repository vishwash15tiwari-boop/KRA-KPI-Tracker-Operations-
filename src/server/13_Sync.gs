/**
 * 13_Sync.gs — Import from the existing operational workbook.
 *
 * During the transition, Google Sheets remains the data repository the ops teams
 * already feed. This module reads those sheets — `🚚 Overall Shipments`,
 * `🏢 Seller Onboarding`, `📍 MTD Pulse Summary` — and normalises them into the
 * application's fact tables.
 *
 * Properties that matter:
 *   - **Idempotent.** Rows upsert on their natural key (Shipment_ID, Seller_ID,
 *     employee+date), so a re-run corrects rather than duplicates.
 *   - **Self-healing dimensions.** Unknown sellers, buyers, regions and POCs are
 *     created as they are encountered, and matched by name alias thereafter.
 *   - **Loud about ambiguity.** Anything it cannot resolve is written to the sync
 *     log and surfaced in the Data Quality panel, never silently dropped.
 */

var Sync = (function () {

  /** Column headers as they appear in the source workbook. */
  var SHIPMENT_MAP = {
    'Business_Category': 'category',
    'Overall_Business_Week': 'businessWeek',
    'Calendar_Month_Week': 'monthWeek',
    'Created_Date': 'createdDate',
    'Requisition_ID': 'requisitionId',
    'Buyer_Name': 'buyerName',
    'Buyer_GSTIN': 'buyerGstin',
    'Listing_ID': 'listingId',
    'Seller_Name': 'sellerName',
    'Seller_GSTIN': 'sellerGstin',
    'HSN_Code': 'hsnCode',
    'Item_Names': 'itemNames',
    'Requested_Qty_MT': 'requestedQtyMT',
    'Booked_Qty_MT': 'bookedQtyMT',
    'Final_Price_Per_MT': 'finalRatePerKg',
    'Invoice_Date': 'invoiceDate',
    'Invoice_Number': 'invoiceNumber',
    'Invoice_Eway_Bill_Number': 'ewayBillNumber',
    'Invoice_Qty_MT': 'invoiceQtyMT',
    'Invoice_Taxable_Amount': 'invoiceTaxableAmount',
    'Invoice_GST_Amount': 'invoiceGstAmount',
    'Invoice_Total_Amount': 'invoiceTotalAmount',
    'Payment_Terms_Days': 'paymentTermsDays',
    'Payment_Term_Bucket': 'paymentTermBucket',
    'Sales_Order_ID': 'salesOrderId',
    'Shipment_ID': 'shipmentKey',
    'Shipment_Status': 'shipmentStatus',
    'Order_Status': 'orderStatus',
    'Draft_Date': 'txnDate',
    'Order_Verified_Date': 'orderVerifiedDate',
    'Dispatched_Date': 'dispatchedDate',
    'Reached_Date': 'reachedDate',
    'Received_By_Recycler_Date': 'receivedDate',
    'Completed_Date': 'completedDate',
    'Cancelled_Date': 'cancelledDate',
    'Rejected_Date': 'rejectedDate',
    'Region': '_regionName',
    'POC': '_pocName'
  };

  var ONBOARDING_MAP = {
    'Business_Vertical': 'businessVertical',
    'Business_Category': 'category',
    'Region': '_regionName',
    'RH_Name': 'rhName',
    'Seller_ID': 'onboardingKey',
    'Seller_Business_Name': 'businessName',
    'Seller_GST_Number': 'gstin',
    'Effective_Date_Of_Registration': 'effectiveRegistrationDate',
    'Business_Vintage': 'businessVintage',
    'Seller_Type': 'accountSubType',
    'Seller_Status': 'status',
    'Contact Person Name {Seller POC}': 'contactPerson',
    'Seller_Mobile_Number': 'mobile',
    'Seller_Email': 'email',
    'Seller_State': 'state',
    'Seller_City': 'city',
    'Created_Date': 'createdDate',
    'Onboarded_Date': 'onboardedDate',
    'Review_Submission_Date {First Submission}': 'reviewSubmissionDate',
    'Updated_Date {Last Edit}': 'updatedDate',
    'Reject_Reason': 'decisionReason',
    'Created_By_Name': 'createdByName',
    'Updated_By_Name': 'updatedByName',
    'Submitted_By_Name': 'submittedByName',
    'Total_Listings': 'totalListings',
    'Approved_Listings': 'approvedListings',
    'Closed_Listings': 'closedListings',
    'Expired_Listings': 'expiredListings',
    'Rejected_Listings': 'rejectedListings',
    'Listings_Converted_To_Order': 'listingsConverted',
    'Listings_Not_Converted': 'listingsNotConverted',
    'Last_Listing_Date': 'lastListingDate',
    'Days_Inactive_Since_Last_Listing_Or_Onboarding': 'daysInactive',
    'Total_Orders': 'totalOrders',
    'Total_Shipments': 'totalShipments',
    'Dispatched': 'shipDispatched',
    'Reached': 'shipReached',
    'Received_By_Recycler': 'shipReceived',
    'Completed': 'shipCompleted',
    'Cancelled': 'shipCancelled',
    'Cancelled_Before_Shipment': 'cancelledBeforeShipment',
    'POC': '_pocName'
  };

  // =========================================================================
  // Source access
  // =========================================================================

  function openSource_(spreadsheetId, sheetName) {
    var ss;
    try {
      ss = spreadsheetId ? SpreadsheetApp.openById(spreadsheetId) : Repository.db();
    } catch (e) {
      fail('SOURCE_UNREACHABLE',
        'The source spreadsheet could not be opened. Check the ID and that you have access.',
        { spreadsheetId: spreadsheetId, cause: String(e) });
    }
    var sh = ss.getSheetByName(sheetName);
    if (!sh) {
      fail('SOURCE_SHEET_MISSING',
        'Sheet "' + sheetName + '" was not found in the source spreadsheet.',
        { available: ss.getSheets().map(function (s) { return s.getName(); }) });
    }
    return sh;
  }

  /**
   * Read a source sheet into row objects using its header row. Header matching
   * is whitespace- and case-insensitive because the imported headers carry
   * inconsistent spacing.
   */
  function readSource_(sheet, headerRow, columnMap) {
    var lastRow = sheet.getLastRow(), lastCol = sheet.getLastColumn();
    if (lastRow <= headerRow) return { rows: [], unmapped: [] };

    var headers = sheet.getRange(headerRow, 1, 1, lastCol).getValues()[0]
      .map(function (h) { return Util.str(h).replace(/\s+/g, ' '); });

    var lookup = {};
    Object.keys(columnMap).forEach(function (k) {
      lookup[Util.key(k)] = columnMap[k];
    });

    var index = {}, unmapped = [];
    headers.forEach(function (h, i) {
      var field = lookup[Util.key(h)];
      if (field) index[field] = i;
      else if (h) unmapped.push(h);
    });

    var values = sheet.getRange(headerRow + 1, 1, lastRow - headerRow, lastCol).getValues();
    var rows = [];
    values.forEach(function (raw) {
      var obj = {}, any = false;
      Object.keys(index).forEach(function (field) {
        var v = raw[index[field]];
        obj[field] = v;
        if (v !== '' && v !== null && v !== undefined) any = true;
      });
      if (any) rows.push(obj);
    });
    return { rows: rows, unmapped: unmapped, headers: headers };
  }

  // =========================================================================
  // Dimension resolution
  // =========================================================================

  /**
   * Resolve a person's display name (as it appears in the source system) to a
   * user record. Matching is by exact name, then alias, then email prefix. An
   * unrecognised name creates a provisional POC so the transaction is never
   * orphaned; the Data Quality panel prompts an admin to complete the profile.
   */
  function resolveUser_(name, cache, warnings) {
    var n = Util.key(name);
    if (!n || n === 'NOT MAPPED') return '';
    if (cache.byName[n]) return cache.byName[n];

    var created = Repository.insert(SHEET.USERS, {
      email: '', fullName: Util.str(name), role: ROLE.POC,
      category: 'ALL', stream: 'BOTH', active: true,
      aliases: Util.str(name)
    });
    cache.byName[n] = created.userId;
    warnings.push('Created a provisional user for "' + Util.str(name) +
      '" — set their email and region under Administration → Users.');
    return created.userId;
  }

  function resolveRegion_(name, category, cache, warnings) {
    var n = Util.key(name);
    if (!n || n === 'NOT MAPPED') n = 'UNASSIGNED';
    var key = category + '|' + n;
    if (cache.byRegion[key]) return cache.byRegion[key];

    var created = Repository.insert(SHEET.REGIONS, {
      regionId: Id.natural('RGN', category, n),
      regionName: Util.str(name) || 'Unassigned',
      category: category, active: true, sequence: 50
    });
    cache.byRegion[key] = created.regionId;
    warnings.push('Created region "' + created.regionName + '" for ' + category + '.');
    return created.regionId;
  }

  function buildCache_() {
    var cache = { byName: {}, byRegion: {}, byGstin: {} };
    Repository.readAll(SHEET.USERS).forEach(function (u) {
      if (u.active === false) return;
      if (u.fullName) cache.byName[Util.key(u.fullName)] = u.userId;
      String(u.aliases || '').split('|').forEach(function (a) {
        if (a.trim()) cache.byName[Util.key(a)] = u.userId;
      });
      if (u.email) cache.byName[Util.key(u.email.split('@')[0].replace(/[._]/g, ' '))] = u.userId;
    });
    Repository.readAll(SHEET.REGIONS).forEach(function (r) {
      if (r.active === false) return;
      cache.byRegion[r.category + '|' + Util.key(r.regionName)] = r.regionId;
    });
    Repository.readAll(SHEET.ACCOUNTS).forEach(function (a) {
      if (a.gstin) cache.byGstin[a.category + '|' + Util.key(a.gstin)] = a;
    });
    return cache;
  }

  /** Create or refresh the account master row a fact row implies. */
  function ensureAccount_(spec, cache, warnings) {
    var gstin = Accounts.normaliseGstin(spec.gstin);
    if (!gstin) return null;
    var key = spec.category + '|' + Util.key(gstin);
    var existing = cache.byGstin[key];

    var row = {
      accountId: existing ? existing.accountId : Id.next('ACC'),
      accountType: spec.accountType, gstin: gstin,
      externalId: Util.str(spec.externalId) || (existing ? existing.externalId : ''),
      businessName: Util.str(spec.businessName) || (existing ? existing.businessName : gstin),
      category: spec.category,
      regionId: spec.regionId || (existing ? existing.regionId : ''),
      pocUserId: spec.pocUserId || (existing ? existing.pocUserId : ''),
      contactPerson: Util.str(spec.contactPerson) || (existing ? existing.contactPerson : ''),
      mobile: Util.str(spec.mobile) || (existing ? existing.mobile : ''),
      email: Util.str(spec.email) || (existing ? existing.email : ''),
      state: Util.str(spec.state) || (existing ? existing.state : ''),
      city: Util.str(spec.city) || (existing ? existing.city : ''),
      accountSubType: Util.str(spec.accountSubType) || (existing ? existing.accountSubType : ''),
      materialType: Util.str(spec.materialType) || (existing ? existing.materialType : ''),
      paymentTerms: existing ? existing.paymentTerms : '',
      counterpartyName: Util.str(spec.counterpartyName) || (existing ? existing.counterpartyName : ''),
      onboardingStatus: spec.onboardingStatus || (existing ? existing.onboardingStatus : ONBOARDING_STATUS.DRAFT),
      onboardedDate: spec.onboardedDate || (existing ? existing.onboardedDate : null),
      firstTxnDate: existing ? existing.firstTxnDate : null,
      lastTxnDate: existing ? existing.lastTxnDate : null,
      lastVisitDate: existing ? existing.lastVisitDate : null,
      businessVintage: Util.str(spec.businessVintage) || (existing ? existing.businessVintage : ''),
      remarks: existing ? existing.remarks : '',
      active: true,
      sourceSystem: 'SYNC'
    };
    if (spec.txnDate) {
      if (!row.firstTxnDate || spec.txnDate < row.firstTxnDate) row.firstTxnDate = spec.txnDate;
      if (!row.lastTxnDate || spec.txnDate > row.lastTxnDate) row.lastTxnDate = spec.txnDate;
    }
    var saved = Repository.upsert(SHEET.ACCOUNTS, row);
    cache.byGstin[key] = saved;
    return saved;
  }

  // =========================================================================
  // Shipments
  // =========================================================================

  function syncShipments(options) {
    Auth.require(PERM.SYNC_RUN);
    options = options || {};
    var batch = Id.next('SYNC');
    var started = new Date();
    var warnings = [];

    try {
      var sheet = openSource_(options.spreadsheetId, options.sheetName || '🚚 Overall Shipments');
      var read = readSource_(sheet, options.headerRow || 1, SHIPMENT_MAP);
      var cache = buildCache_();
      var defaultCategory = options.category || Config.get('DEFAULT_CATEGORY');

      var prepared = [], skipped = 0;
      read.rows.forEach(function (r) {
        // An order that has not yet produced a shipment carries no Shipment_ID.
        // Dropping those rows would lose the pipeline they represent, so fall
        // back to the order and listing identifiers to build a stable key.
        var key = Util.str(r.shipmentKey) ||
          Id.natural('SHIP', r.salesOrderId, r.requisitionId, r.listingId);
        if (key === 'SHIP-') { skipped++; return; }
        var category = Util.str(r.category) || defaultCategory;
        var regionId = resolveRegion_(r._regionName, category, cache, warnings);
        var pocUserId = resolveUser_(r._pocName, cache, warnings);
        var txnDate = DateUtil.startOfDay(r.txnDate);
        var status = Util.key(r.shipmentStatus);

        var sellerAccount = ensureAccount_({
          accountType: 'SELLER', gstin: r.sellerGstin, businessName: r.sellerName,
          category: category, regionId: regionId, pocUserId: pocUserId,
          counterpartyName: r.buyerName,
          materialType: inferMaterial_(r.itemNames),
          txnDate: INVALID_TXN_STATUSES.indexOf(status) < 0 ? txnDate : null
        }, cache, warnings);

        var buyerAccount = ensureAccount_({
          accountType: 'BUYER', gstin: r.buyerGstin, businessName: r.buyerName,
          category: category, counterpartyName: r.sellerName,
          materialType: inferMaterial_(r.itemNames),
          txnDate: INVALID_TXN_STATUSES.indexOf(status) < 0 ? txnDate : null
        }, cache, warnings);

        var row = {};
        Object.keys(SHIPMENT_MAP).forEach(function (h) {
          var f = SHIPMENT_MAP[h];
          if (f.charAt(0) === '_') return;
          row[f] = r[f];
        });
        row.shipmentKey = key;
        row.hasShipmentId = !!Util.str(r.shipmentKey);
        row.category = category;
        row.sellerGstin = Accounts.normaliseGstin(r.sellerGstin);
        row.buyerGstin = Accounts.normaliseGstin(r.buyerGstin);
        row.materialType = inferMaterial_(r.itemNames);
        row.txnDate = txnDate;
        row.regionId = regionId;
        row.pocUserId = pocUserId;
        row.buyerRegionId = buyerAccount ? buyerAccount.regionId : '';
        row.buyerPocUserId = buyerAccount ? buyerAccount.pocUserId : '';
        row.isValidTxn = INVALID_TXN_STATUSES.indexOf(status) < 0;
        row.syncedAt = new Date();
        row.syncBatch = batch;

        if (!row.txnDate) {
          warnings.push('Shipment ' + key + ' has no Draft_Date and will not appear in any window.');
        }
        if (!sellerAccount) {
          warnings.push('Shipment ' + key + ' has no seller GSTIN — it cannot be attributed.');
        }
        prepared.push(row);
      });

      var result = Repository.upsertMany(SHEET.SHIPMENTS, prepared);
      Engine.invalidate();

      var log = writeLog_({
        syncId: batch, source: 'SHIPMENTS',
        spreadsheetId: options.spreadsheetId, sheetName: sheet.getName(),
        startedAt: started, rowsRead: read.rows.length,
        inserted: result.inserted, updated: result.updated, skipped: skipped,
        warnings: warnings, status: 'SUCCESS'
      });
      return log;
    } catch (e) {
      return writeLog_({
        syncId: batch, source: 'SHIPMENTS',
        spreadsheetId: options.spreadsheetId, sheetName: options.sheetName,
        startedAt: started, status: 'FAILED', errorMessage: String(e.message || e),
        warnings: warnings
      });
    }
  }

  /** Derive the material bucket from the free-text item description. */
  function inferMaterial_(itemNames) {
    var s = Util.key(itemNames);
    if (!s) return '';
    if (s.indexOf('FLAKE') >= 0) return MATERIAL_TYPE.FLAKES;
    if (s.indexOf('GRANULE') >= 0 || s.indexOf('FIBRE') >= 0 || s.indexOf('FIBER') >= 0) {
      return MATERIAL_TYPE.OTHERS;
    }
    if (s.indexOf('PET') >= 0 || s.indexOf('BOTTLE') >= 0) return MATERIAL_TYPE.PET;
    return MATERIAL_TYPE.OTHERS;
  }

  // =========================================================================
  // Onboarding
  // =========================================================================

  function syncOnboarding(options) {
    Auth.require(PERM.SYNC_RUN);
    options = options || {};
    var batch = Id.next('SYNC');
    var started = new Date();
    var warnings = [];

    try {
      var sheet = openSource_(options.spreadsheetId, options.sheetName || '🏢 Seller Onboarding');
      var read = readSource_(sheet, options.headerRow || 1, ONBOARDING_MAP);
      var cache = buildCache_();
      var defaultCategory = options.category || Config.get('DEFAULT_CATEGORY');
      var accountType = options.accountType || 'SELLER';
      var slaTarget = Config.get('SLA_ONBOARDING_DAYS');

      var prepared = [], skipped = 0;
      read.rows.forEach(function (r) {
        var key = Util.str(r.onboardingKey);
        if (!key) { skipped++; return; }
        var category = Util.str(r.category) || defaultCategory;
        var regionId = resolveRegion_(r._regionName, category, cache, warnings);
        var pocUserId = resolveUser_(r._pocName, cache, warnings);
        var status = Util.key(r.status);
        var created = DateUtil.parse(r.createdDate);
        var onboarded = DateUtil.startOfDay(r.onboardedDate);
        var slaDays = (created && onboarded) ? DateUtil.diffDays(created, onboarded) : null;

        var row = {};
        Object.keys(ONBOARDING_MAP).forEach(function (h) {
          var f = ONBOARDING_MAP[h];
          if (f.charAt(0) === '_') return;
          row[f] = r[f];
        });
        row.onboardingKey = key;
        row.accountType = accountType;
        row.category = category;
        row.gstin = Accounts.normaliseGstin(r.gstin);
        row.status = status;
        row.regionId = regionId;
        row.pocUserId = pocUserId;
        row.onboardedDate = onboarded;
        // Reject_Reason carries approval text with inconsistent case and
        // trailing whitespace; normalise it so it reads as a decision.
        row.decisionReason = Util.str(r.decisionReason).replace(/\s+/g, ' ');
        row.onboardingSlaDays = slaDays;
        row.slaBreached = slaDays !== null && slaDays > slaTarget;
        row.syncedAt = new Date();
        row.syncBatch = batch;

        if (status === 'COMPLETED' && !onboarded) {
          warnings.push(row.businessName + ' is marked Completed but has no onboarded date, ' +
            'so it will not count in any month.');
        }

        ensureAccount_({
          accountType: accountType, gstin: r.gstin, externalId: key,
          businessName: r.businessName, category: category,
          regionId: regionId, pocUserId: pocUserId,
          contactPerson: r.contactPerson, mobile: r.mobile, email: r.email,
          state: r.state, city: r.city, accountSubType: r.accountSubType,
          businessVintage: r.businessVintage,
          onboardingStatus: status, onboardedDate: onboarded
        }, cache, warnings);

        prepared.push(row);
      });

      var result = Repository.upsertMany(SHEET.ONBOARDING, prepared);
      Engine.invalidate();

      return writeLog_({
        syncId: batch, source: 'ONBOARDING',
        spreadsheetId: options.spreadsheetId, sheetName: sheet.getName(),
        startedAt: started, rowsRead: read.rows.length,
        inserted: result.inserted, updated: result.updated, skipped: skipped,
        warnings: warnings, status: 'SUCCESS'
      });
    } catch (e) {
      return writeLog_({
        syncId: batch, source: 'ONBOARDING',
        spreadsheetId: options.spreadsheetId, sheetName: options.sheetName,
        startedAt: started, status: 'FAILED', errorMessage: String(e.message || e),
        warnings: warnings
      });
    }
  }

  // =========================================================================
  // Pulse — the wide daily grid is normalised to one row per person per day
  // =========================================================================

  /**
   * `📍 MTD Pulse Summary` stacks two month blocks. Each block has an
   * `Employee ID` header row followed by one row per employee, with one column
   * per calendar day holding either a visit count or the literal `L` (leave).
   */
  function syncPulse(options) {
    Auth.require(PERM.SYNC_RUN);
    options = options || {};
    var batch = Id.next('SYNC');
    var started = new Date();
    var warnings = [];

    try {
      var sheet = openSource_(options.spreadsheetId, options.sheetName || '📍 MTD Pulse Summary');
      var lastRow = sheet.getLastRow(), lastCol = sheet.getLastColumn();
      var grid = sheet.getRange(1, 1, lastRow, lastCol).getValues();
      var cache = buildCache_();
      var category = options.category || Config.get('DEFAULT_CATEGORY');

      // Locate every header row: the one containing "Employee Name".
      var headerRows = [];
      grid.forEach(function (row, i) {
        var hasName = row.some(function (c) { return Util.key(c) === 'EMPLOYEE NAME'; });
        if (hasName) headerRows.push(i);
      });
      assert(headerRows.length, 'SOURCE_FORMAT',
        'Could not find an "Employee Name" header row in the pulse sheet.');

      var prepared = [], rowsRead = 0;

      headerRows.forEach(function (hr, blockIndex) {
        var header = grid[hr];
        var nameCol = -1, codeCol = -1;
        var dateCols = [];
        header.forEach(function (cell, c) {
          var k = Util.key(cell);
          if (k === 'EMPLOYEE NAME') nameCol = c;
          else if (k === 'EMPLOYEE ID') codeCol = c;
          else {
            var d = DateUtil.parse(cell);
            if (d && d.getFullYear() > 2000) dateCols.push({ col: c, date: DateUtil.startOfDay(d) });
          }
        });
        if (nameCol < 0 || !dateCols.length) return;

        // A block runs until the next header row or a run of blank name cells.
        var stop = (blockIndex + 1 < headerRows.length) ? headerRows[blockIndex + 1] : grid.length;
        // Columns can repeat dates (the trailing rolling-week block); keep the
        // first occurrence of each date so visits are not double counted.
        var seenDate = {};
        dateCols = dateCols.filter(function (dc) {
          var iso = DateUtil.isoDate(dc.date);
          if (seenDate[iso]) return false;
          seenDate[iso] = true;
          return true;
        });

        for (var r = hr + 1; r < stop; r++) {
          var name = Util.str(grid[r][nameCol]);
          if (!name) continue;
          rowsRead++;
          var pocUserId = resolveUser_(name, cache, warnings);
          var employeeCode = codeCol >= 0 ? Util.str(grid[r][codeCol]) : '';
          var user = pocUserId ? Repository.findById(SHEET.USERS, pocUserId) : null;

          dateCols.forEach(function (dc) {
            var raw = grid[r][dc.col];
            if (raw === '' || raw === null || raw === undefined) return;
            var isLeave = Util.key(raw) === 'L';
            var count = isLeave ? 0 : Util.num(raw, 0);
            if (!isLeave && count <= 0) return;
            prepared.push({
              pulseId: Id.natural('PLS', 'SYNC', pocUserId || name, DateUtil.isoDate(dc.date)),
              category: category,
              visitDate: dc.date,
              pocUserId: pocUserId,
              employeeCode: employeeCode,
              regionId: user ? user.regionId : '',
              visitCount: count,
              onLeave: isLeave,
              purpose: isLeave ? 'LEAVE' : 'FIELD_VISIT',
              sourceSystem: 'SYNC:PULSE',
              sourceRef: sheet.getName() + '!R' + (r + 1),
              createdAt: new Date(),
              createdBy: 'sync'
            });
          });
        }
      });

      // The aggregate pulse sheet does not name the account visited; per-account
      // coverage therefore relies on visits recorded in the app.
      if (prepared.length) {
        warnings.push('The pulse sheet reports daily totals per person without naming the ' +
          'account visited. Per-account coverage uses visits recorded in the application.');
      }

      var result = Repository.upsertMany(SHEET.PULSE, prepared);
      Engine.invalidate();

      return writeLog_({
        syncId: batch, source: 'PULSE',
        spreadsheetId: options.spreadsheetId, sheetName: sheet.getName(),
        startedAt: started, rowsRead: rowsRead,
        inserted: result.inserted, updated: result.updated, skipped: 0,
        warnings: warnings, status: 'SUCCESS'
      });
    } catch (e) {
      return writeLog_({
        syncId: batch, source: 'PULSE',
        spreadsheetId: options.spreadsheetId, sheetName: options.sheetName,
        startedAt: started, status: 'FAILED', errorMessage: String(e.message || e),
        warnings: warnings
      });
    }
  }

  // =========================================================================
  // Account plan import (the manual target columns of OMP-Sellers/Buyers)
  // =========================================================================

  /**
   * Import the human-entered target block so a month already planned in the
   * spreadsheet does not have to be retyped. Only the three input columns are
   * read; GMV is recomputed.
   */
  function importAccountPlan(options) {
    Auth.require(PERM.PLAN_MANAGE);
    options = options || {};
    var cycle = Planning.getCycle(options.cycleId);
    var batch = Id.next('SYNC');
    var started = new Date();
    var warnings = [];

    try {
      var sheet = openSource_(options.spreadsheetId, options.sheetName || '🏢 OMP-Sellers');
      var headerRow = options.headerRow || 4;   // banded header: row 4 in the source
      var map = options.accountType === 'BUYER' ? {
        'Buyer_GST_Number': 'gstin', 'Buyer_Business_Name': 'accountName',
        'POC': '_pocName', 'Material Type': 'materialType',
        'Txn Target {Count}': 'txnTarget', 'Tonnage_Mt (Target)': 'tonnageTargetMT',
        'Rate per KG (Target)': 'ratePerKgTarget',
        'Remarks': 'remarks', 'Detailed Remarks': 'detailedRemarks'
      } : {
        'Seller_GST_Number': 'gstin', 'Seller_Business_Name': 'accountName',
        'POC': '_pocName', 'Material Type': 'materialType', 'Region': '_regionName',
        'Txn Target {Count}': 'txnTarget', 'Tonnage_Mt (Target)': 'tonnageTargetMT',
        'Rate per KG (Target)': 'ratePerKgTarget',
        'Remarks': 'remarks', 'Detailed Remarks': 'detailedRemarks'
      };

      var read = readSource_(sheet, headerRow, map);
      var cache = buildCache_();
      var accountType = options.accountType || 'SELLER';

      var prepared = [], skipped = 0;
      read.rows.forEach(function (r) {
        var gstin = Accounts.normaliseGstin(r.gstin);
        if (!gstin) { skipped++; return; }
        var pocUserId = resolveUser_(r._pocName, cache, warnings);
        var regionId = r._regionName
          ? resolveRegion_(r._regionName, cycle.category, cache, warnings) : '';

        var account = ensureAccount_({
          accountType: accountType, gstin: gstin, businessName: r.accountName,
          category: cycle.category, regionId: regionId, pocUserId: pocUserId,
          materialType: r.materialType
        }, cache, warnings);
        if (!account) { skipped++; return; }

        var tonnage = Util.num(r.tonnageTargetMT, 0);
        var rate = Util.num(r.ratePerKgTarget, 0);
        prepared.push({
          planId: Id.natural('PLAN', cycle.cycleId, gstin),
          cycleId: cycle.cycleId, accountId: account.accountId,
          accountType: accountType, gstin: gstin, accountName: account.businessName,
          pocUserId: account.pocUserId, regionId: account.regionId,
          category: cycle.category, materialType: account.materialType,
          txnTarget: Util.num(r.txnTarget, 0),
          tonnageTargetMT: tonnage, ratePerKgTarget: rate,
          gmvTargetCr: Planning.deriveGmvTargetCr(tonnage, rate),
          remarks: Util.str(r.remarks), detailedRemarks: Util.str(r.detailedRemarks),
          active: true
        });
      });

      var result = Repository.upsertMany(SHEET.ACCOUNT_PLAN, prepared);
      Engine.invalidate();

      return writeLog_({
        syncId: batch, source: 'ACCOUNT_PLAN',
        spreadsheetId: options.spreadsheetId, sheetName: sheet.getName(),
        startedAt: started, rowsRead: read.rows.length,
        inserted: result.inserted, updated: result.updated, skipped: skipped,
        warnings: warnings, status: 'SUCCESS'
      });
    } catch (e) {
      return writeLog_({
        syncId: batch, source: 'ACCOUNT_PLAN',
        spreadsheetId: options.spreadsheetId, sheetName: options.sheetName,
        startedAt: started, status: 'FAILED', errorMessage: String(e.message || e),
        warnings: warnings
      });
    }
  }

  // =========================================================================
  // Orchestration
  // =========================================================================

  function syncAll(options) {
    Auth.require(PERM.SYNC_RUN);
    options = options || {};
    return Repository.transaction(function () {
      var results = {
        onboarding: syncOnboarding(options.onboarding || options),
        shipments: syncShipments(options.shipments || options),
        pulse: syncPulse(options.pulse || options)
      };
      Engine.invalidate();
      results.ok = ['onboarding', 'shipments', 'pulse'].every(function (k) {
        return results[k].status === 'SUCCESS';
      });
      return results;
    });
  }

  function writeLog_(spec) {
    var row = {
      syncId: spec.syncId,
      source: spec.source,
      sourceSpreadsheetId: Util.str(spec.spreadsheetId),
      sourceSheetName: Util.str(spec.sheetName),
      startedAt: spec.startedAt,
      finishedAt: new Date(),
      rowsRead: Util.num(spec.rowsRead, 0),
      rowsInserted: Util.num(spec.inserted, 0),
      rowsUpdated: Util.num(spec.updated, 0),
      rowsSkipped: Util.num(spec.skipped, 0),
      warnings: Util.truncate(Util.unique(spec.warnings || []).join(' | '), 3000),
      status: spec.status,
      errorMessage: Util.str(spec.errorMessage),
      triggeredBy: Auth.currentEmail() || 'system'
    };
    Repository.insert(SHEET.SYNC_LOG, row);
    Audit.log('SYNC_' + spec.source, SHEET.SYNC_LOG, spec.syncId,
      spec.status + ' — read ' + row.rowsRead + ', inserted ' + row.rowsInserted +
      ', updated ' + row.rowsUpdated, null, null,
      spec.status === 'SUCCESS', row.errorMessage);
    return {
      syncId: row.syncId, source: row.source, status: row.status,
      rowsRead: row.rowsRead, rowsInserted: row.rowsInserted,
      rowsUpdated: row.rowsUpdated, rowsSkipped: row.rowsSkipped,
      warnings: Util.unique(spec.warnings || []).slice(0, 50),
      errorMessage: row.errorMessage,
      startedAt: DateUtil.isoDateTime(row.startedAt),
      finishedAt: DateUtil.isoDateTime(row.finishedAt)
    };
  }

  function history(limit) {
    Auth.require(PERM.SYNC_RUN);
    return Util.sortBy(Repository.readAll(SHEET.SYNC_LOG),
      [{ pick: function (s) { return s.startedAt ? s.startedAt.getTime() : 0; }, dir: 'desc' }])
      .slice(0, limit || 50)
      .map(function (s) {
        return {
          syncId: s.syncId, source: s.source, status: s.status,
          rowsRead: s.rowsRead, rowsInserted: s.rowsInserted, rowsUpdated: s.rowsUpdated,
          rowsSkipped: s.rowsSkipped,
          warnings: s.warnings, errorMessage: s.errorMessage,
          startedAt: DateUtil.isoDateTime(s.startedAt),
          finishedAt: DateUtil.isoDateTime(s.finishedAt),
          triggeredBy: s.triggeredBy
        };
      });
  }

  /** Read a source spreadsheet's tab list — used by the setup wizard. */
  function inspectSource(spreadsheetId) {
    Auth.require(PERM.SYNC_RUN);
    var ss;
    try { ss = SpreadsheetApp.openById(spreadsheetId); }
    catch (e) {
      fail('SOURCE_UNREACHABLE', 'Could not open that spreadsheet. Check the ID and your access.');
    }
    return {
      name: ss.getName(), spreadsheetId: ss.getId(),
      sheets: ss.getSheets().map(function (s) {
        return {
          name: s.getName(), rows: s.getLastRow(), cols: s.getLastColumn(),
          hidden: s.isSheetHidden()
        };
      })
    };
  }

  return {
    syncShipments: syncShipments,
    syncOnboarding: syncOnboarding,
    syncPulse: syncPulse,
    importAccountPlan: importAccountPlan,
    syncAll: syncAll,
    history: history,
    inspectSource: inspectSource,
    SHIPMENT_MAP: SHIPMENT_MAP,
    ONBOARDING_MAP: ONBOARDING_MAP
  };
})();
