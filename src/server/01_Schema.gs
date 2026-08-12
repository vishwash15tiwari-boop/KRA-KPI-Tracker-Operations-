/**
 * 01_Schema.gs — The backend database.
 *
 * Google Sheets is the data repository during the transition phase, so the
 * schema is declared here explicitly rather than implied by whatever happens to
 * be in a tab. Every table declares its columns, types and indexes; the
 * bootstrap routine creates or migrates the physical sheets to match.
 *
 * Design rules:
 *  - Every table has a surrogate string PK as column 1.
 *  - Every mutable table carries createdAt/createdBy/updatedAt/updatedBy.
 *  - Facts are never edited in place by the sync; they are upserted on a natural
 *    key (sourceRef) so re-running a sync is idempotent.
 *  - Normalisation: an account (seller/buyer) exists once; plans, activities and
 *    facts reference it by GSTIN. Region/POC live on the account, not repeated
 *    on every fact row — but facts also snapshot them so history survives
 *    re-assignment.
 */

var SHEET = Object.freeze({
  CONFIG: 'DB_Config',
  USERS: 'DB_Users',
  REGIONS: 'DB_Regions',
  CYCLES: 'DB_Cycles',
  KRA: 'DB_KRA',
  KPI: 'DB_KPI',
  ASSIGNMENT: 'DB_KPIAssignment',
  ACCOUNTS: 'DB_Accounts',
  ACCOUNT_PLAN: 'DB_AccountPlan',
  ONBOARDING_PLAN: 'DB_OnboardingPlan',
  WEEKLY_PLAN: 'DB_WeeklyPlan',
  ACTIVITIES: 'DB_Activities',
  SHIPMENTS: 'DB_Shipments',
  ONBOARDING: 'DB_Onboarding',
  PULSE: 'DB_Pulse',
  RECEIVABLES: 'DB_Receivables',
  PIPELINE: 'DB_Pipeline',
  DOCUMENTS: 'DB_Documents',
  REVIEWS: 'DB_Reviews',
  ACTIONS: 'DB_Actions',
  SNAPSHOTS: 'DB_Snapshots',
  AUDIT: 'DB_Audit',
  SYNC_LOG: 'DB_SyncLog'
});

var T = Object.freeze({
  STR: 'string', NUM: 'number', BOOL: 'boolean', DATE: 'date',
  DATETIME: 'datetime', JSON: 'json'
});

/**
 * Table definitions. `cols` order is authoritative — it is the physical column
 * order in the sheet. Adding a column is a forward-compatible migration.
 */
var SCHEMA = Object.freeze({

  // -- Configuration -------------------------------------------------------
  DB_Config: {
    pk: 'key',
    cols: [
      { name: 'key', type: T.STR, width: 240 },
      { name: 'value', type: T.STR, width: 200 },
      { name: 'description', type: T.STR, width: 420 },
      { name: 'updatedAt', type: T.DATETIME },
      { name: 'updatedBy', type: T.STR }
    ]
  },

  // -- Identity & org ------------------------------------------------------
  DB_Users: {
    pk: 'userId',
    index: ['email', 'fullName'],
    cols: [
      { name: 'userId', type: T.STR },
      { name: 'email', type: T.STR, width: 240 },
      { name: 'fullName', type: T.STR, width: 200 },
      { name: 'employeeCode', type: T.STR },
      { name: 'role', type: T.STR, enum: Object.keys(ROLE) },
      { name: 'category', type: T.STR, note: 'Plastic | Metal | ALL' },
      { name: 'regionId', type: T.STR },
      { name: 'stream', type: T.STR, note: 'SUPPLY | DEMAND | BOTH' },
      { name: 'reportsTo', type: T.STR, note: 'userId of manager' },
      { name: 'phone', type: T.STR },
      { name: 'active', type: T.BOOL },
      { name: 'aliases', type: T.STR, note: 'pipe-separated names used in source systems' },
      { name: 'createdAt', type: T.DATETIME },
      { name: 'createdBy', type: T.STR },
      { name: 'updatedAt', type: T.DATETIME },
      { name: 'updatedBy', type: T.STR }
    ]
  },

  DB_Regions: {
    pk: 'regionId',
    index: ['regionName'],
    cols: [
      { name: 'regionId', type: T.STR },
      { name: 'regionName', type: T.STR, width: 180 },
      { name: 'category', type: T.STR },
      { name: 'rhUserId', type: T.STR, note: 'Regional Head' },
      { name: 'states', type: T.STR, note: 'comma-separated' },
      { name: 'active', type: T.BOOL },
      { name: 'sequence', type: T.NUM },
      { name: 'createdAt', type: T.DATETIME },
      { name: 'updatedAt', type: T.DATETIME },
      { name: 'updatedBy', type: T.STR }
    ]
  },

  // -- Planning ------------------------------------------------------------
  DB_Cycles: {
    pk: 'cycleId',
    index: ['category', 'year', 'month'],
    cols: [
      { name: 'cycleId', type: T.STR, note: 'CYC-<Category>-<YYYY>-<MM>' },
      { name: 'category', type: T.STR },
      { name: 'year', type: T.NUM },
      { name: 'month', type: T.NUM, note: '1-12' },
      { name: 'label', type: T.STR, note: 'Aug 2026 · Plastic' },
      { name: 'status', type: T.STR, enum: Object.keys(CYCLE_STATUS) },
      { name: 'workingDays', type: T.NUM },
      { name: 'startDate', type: T.DATE },
      { name: 'endDate', type: T.DATE },
      { name: 'notes', type: T.STR, width: 400 },
      { name: 'publishedBy', type: T.STR },
      { name: 'publishedAt', type: T.DATETIME },
      { name: 'lockedBy', type: T.STR },
      { name: 'lockedAt', type: T.DATETIME },
      { name: 'closedBy', type: T.STR },
      { name: 'closedAt', type: T.DATETIME },
      { name: 'createdAt', type: T.DATETIME },
      { name: 'createdBy', type: T.STR },
      { name: 'updatedAt', type: T.DATETIME },
      { name: 'updatedBy', type: T.STR }
    ]
  },

  DB_KRA: {
    pk: 'kraId',
    index: ['cycleId'],
    cols: [
      { name: 'kraId', type: T.STR },
      { name: 'cycleId', type: T.STR },
      { name: 'category', type: T.STR },
      { name: 'stream', type: T.STR, enum: STREAMS },
      { name: 'perspective', type: T.STR, note: 'Sales | Scale | Customer | Process' },
      { name: 'kraName', type: T.STR, width: 320 },
      { name: 'sourceOfTracking', type: T.STR },
      { name: 'sequence', type: T.NUM },
      { name: 'active', type: T.BOOL },
      { name: 'createdAt', type: T.DATETIME },
      { name: 'createdBy', type: T.STR },
      { name: 'updatedAt', type: T.DATETIME },
      { name: 'updatedBy', type: T.STR }
    ]
  },

  DB_KPI: {
    pk: 'kpiId',
    index: ['cycleId', 'kraId'],
    cols: [
      { name: 'kpiId', type: T.STR },
      { name: 'kraId', type: T.STR },
      { name: 'cycleId', type: T.STR },
      { name: 'kpiName', type: T.STR, width: 300 },
      { name: 'definition', type: T.STR, width: 520 },
      { name: 'weightage', type: T.NUM },
      { name: 'unitOfMeasure', type: T.STR, note: 'Percentage | Days | Count | MT | Cr' },
      { name: 'metricKey', type: T.STR, note: 'key into METRICS' },
      { name: 'direction', type: T.STR, enum: Object.keys(DIRECTION) },
      { name: 'targetBasis', type: T.STR, enum: Object.keys(TARGET_BASIS) },
      { name: 'basisMetric', type: T.STR, note: 'metric the % applies to, for PCT_OF_METRIC' },
      { name: 'basisPct', type: T.NUM },
      { name: 'target1', type: T.NUM },
      { name: 'target2', type: T.NUM },
      { name: 'target3', type: T.NUM },
      { name: 'target4', type: T.NUM },
      { name: 'target5', type: T.NUM },
      { name: 'sequence', type: T.NUM },
      { name: 'active', type: T.BOOL },
      { name: 'createdAt', type: T.DATETIME },
      { name: 'createdBy', type: T.STR },
      { name: 'updatedAt', type: T.DATETIME },
      { name: 'updatedBy', type: T.STR }
    ]
  },

  DB_KPIAssignment: {
    pk: 'assignmentId',
    index: ['cycleId', 'pocUserId', 'kpiId'],
    cols: [
      { name: 'assignmentId', type: T.STR },
      { name: 'cycleId', type: T.STR },
      { name: 'kpiId', type: T.STR },
      { name: 'pocUserId', type: T.STR },
      { name: 'regionId', type: T.STR },
      { name: 'category', type: T.STR },
      { name: 'weightage', type: T.NUM, note: 'override; blank inherits the KPI weightage' },
      { name: 'targetValue', type: T.NUM, note: 'blank when derived' },
      { name: 'targetOverride', type: T.BOOL },
      { name: 'dueDate', type: T.DATE },
      { name: 'notes', type: T.STR, width: 320 },
      { name: 'active', type: T.BOOL },
      { name: 'assignedBy', type: T.STR },
      { name: 'assignedAt', type: T.DATETIME },
      { name: 'updatedAt', type: T.DATETIME },
      { name: 'updatedBy', type: T.STR }
    ]
  },

  // -- Accounts (sellers and buyers, one table, discriminated) -------------
  DB_Accounts: {
    pk: 'accountId',
    index: ['gstin', 'accountType', 'pocUserId'],
    cols: [
      { name: 'accountId', type: T.STR },
      { name: 'accountType', type: T.STR, enum: ['SELLER', 'BUYER'] },
      { name: 'gstin', type: T.STR, width: 190, note: 'natural key; joins to facts' },
      { name: 'externalId', type: T.STR, note: 'Seller_ID / Buyer_ID in the ops system' },
      { name: 'businessName', type: T.STR, width: 320 },
      { name: 'category', type: T.STR },
      { name: 'regionId', type: T.STR },
      { name: 'pocUserId', type: T.STR },
      { name: 'contactPerson', type: T.STR },
      { name: 'mobile', type: T.STR },
      { name: 'email', type: T.STR },
      { name: 'state', type: T.STR },
      { name: 'city', type: T.STR },
      { name: 'accountSubType', type: T.STR, note: 'Baler | Trader | Manufacturer …' },
      { name: 'materialType', type: T.STR },
      { name: 'paymentTerms', type: T.STR },
      { name: 'counterpartyName', type: T.STR, note: 'linked buyer for a seller and vice versa' },
      { name: 'onboardingStatus', type: T.STR, enum: Object.keys(ONBOARDING_STATUS) },
      { name: 'onboardedDate', type: T.DATE },
      { name: 'firstTxnDate', type: T.DATE },
      { name: 'lastTxnDate', type: T.DATE },
      { name: 'lastVisitDate', type: T.DATE },
      { name: 'businessVintage', type: T.STR },
      { name: 'blockerReason', type: T.STR },
      { name: 'remarks', type: T.STR, width: 400 },
      { name: 'active', type: T.BOOL },
      { name: 'sourceSystem', type: T.STR },
      { name: 'createdAt', type: T.DATETIME },
      { name: 'createdBy', type: T.STR },
      { name: 'updatedAt', type: T.DATETIME },
      { name: 'updatedBy', type: T.STR }
    ]
  },

  /** Monthly per-account plan — OMP-Sellers!AE:AH and OMP-Buyers!AC:AF. */
  DB_AccountPlan: {
    pk: 'planId',
    index: ['cycleId', 'accountId', 'pocUserId'],
    cols: [
      { name: 'planId', type: T.STR },
      { name: 'cycleId', type: T.STR },
      { name: 'accountId', type: T.STR },
      { name: 'accountType', type: T.STR },
      { name: 'gstin', type: T.STR },
      { name: 'accountName', type: T.STR, width: 300 },
      { name: 'pocUserId', type: T.STR },
      { name: 'regionId', type: T.STR },
      { name: 'category', type: T.STR },
      { name: 'materialType', type: T.STR },
      { name: 'txnTarget', type: T.NUM },
      { name: 'tonnageTargetMT', type: T.NUM },
      { name: 'ratePerKgTarget', type: T.NUM },
      { name: 'gmvTargetCr', type: T.NUM, note: 'derived = tonnage × rate / 10000' },
      { name: 'remarks', type: T.STR, width: 260 },
      { name: 'detailedRemarks', type: T.STR, width: 480 },
      { name: 'blockerReason', type: T.STR },
      { name: 'active', type: T.BOOL },
      { name: 'createdAt', type: T.DATETIME },
      { name: 'createdBy', type: T.STR },
      { name: 'updatedAt', type: T.DATETIME },
      { name: 'updatedBy', type: T.STR }
    ]
  },

  /** Annual onboarding plan — POC-Wise!D (Total Onboarding Sellers Plan). */
  DB_OnboardingPlan: {
    pk: 'onbPlanId',
    index: ['fiscalYear', 'pocUserId'],
    cols: [
      { name: 'onbPlanId', type: T.STR },
      { name: 'fiscalYear', type: T.STR, note: 'FY2026-27' },
      { name: 'category', type: T.STR },
      { name: 'accountType', type: T.STR },
      { name: 'pocUserId', type: T.STR },
      { name: 'regionId', type: T.STR },
      { name: 'annualPlan', type: T.NUM },
      { name: 'notes', type: T.STR },
      { name: 'createdAt', type: T.DATETIME },
      { name: 'createdBy', type: T.STR },
      { name: 'updatedAt', type: T.DATETIME },
      { name: 'updatedBy', type: T.STR }
    ]
  },

  /** Weekly Plan vs Achievement — target only; achievement is computed. */
  DB_WeeklyPlan: {
    pk: 'weekPlanId',
    index: ['cycleId', 'pocUserId', 'planDate'],
    cols: [
      { name: 'weekPlanId', type: T.STR },
      { name: 'cycleId', type: T.STR },
      { name: 'category', type: T.STR },
      { name: 'weekStart', type: T.DATE },
      { name: 'planDate', type: T.DATE },
      { name: 'pocUserId', type: T.STR },
      { name: 'regionId', type: T.STR },
      { name: 'tonnageTargetMT', type: T.NUM },
      { name: 'txnTarget', type: T.NUM },
      { name: 'notes', type: T.STR },
      { name: 'createdAt', type: T.DATETIME },
      { name: 'createdBy', type: T.STR },
      { name: 'updatedAt', type: T.DATETIME },
      { name: 'updatedBy', type: T.STR }
    ]
  },

  // -- Execution -----------------------------------------------------------
  /**
   * The single operational record. Every dashboard number traces to a row here
   * or to a synced fact row (DB_Shipments / DB_Onboarding) that also has a
   * mirror row here.
   */
  DB_Activities: {
    pk: 'activityId',
    index: ['cycleId', 'pocUserId', 'activityDate', 'activityType'],
    cols: [
      { name: 'activityId', type: T.STR },
      { name: 'cycleId', type: T.STR },
      { name: 'category', type: T.STR },
      { name: 'stream', type: T.STR },
      { name: 'activityType', type: T.STR },
      { name: 'activityDate', type: T.DATE },
      { name: 'pocUserId', type: T.STR },
      { name: 'regionId', type: T.STR },
      { name: 'accountId', type: T.STR },
      { name: 'accountType', type: T.STR },
      { name: 'gstin', type: T.STR },
      { name: 'accountName', type: T.STR, width: 280 },
      { name: 'kraId', type: T.STR },
      { name: 'kpiId', type: T.STR },
      { name: 'metricKey', type: T.STR },
      { name: 'count', type: T.NUM },
      { name: 'quantityMT', type: T.NUM },
      { name: 'ratePerKg', type: T.NUM },
      { name: 'amountINR', type: T.NUM },
      { name: 'status', type: T.STR },
      { name: 'blockerReason', type: T.STR },
      { name: 'remarks', type: T.STR, width: 480 },
      { name: 'evidenceUrl', type: T.STR, width: 300 },
      { name: 'evidenceType', type: T.STR },
      { name: 'verificationStatus', type: T.STR, enum: ['PENDING', 'VERIFIED', 'REJECTED', 'NOT_REQUIRED'] },
      { name: 'verifiedBy', type: T.STR },
      { name: 'verifiedAt', type: T.DATETIME },
      { name: 'verifyNote', type: T.STR },
      { name: 'sourceSystem', type: T.STR, note: 'APP | SYNC:<sheet>' },
      { name: 'sourceRef', type: T.STR, note: 'natural key for idempotent sync' },
      { name: 'voided', type: T.BOOL },
      { name: 'voidReason', type: T.STR },
      { name: 'createdAt', type: T.DATETIME },
      { name: 'createdBy', type: T.STR },
      { name: 'updatedAt', type: T.DATETIME },
      { name: 'updatedBy', type: T.STR }
    ]
  },

  /** Transaction facts — mirror of 🚚 Overall Shipments. */
  DB_Shipments: {
    pk: 'shipmentKey',
    index: ['sellerGstin', 'buyerGstin', 'txnDate', 'pocUserId'],
    cols: [
      { name: 'shipmentKey', type: T.STR, note: 'Shipment_ID (natural key)' },
      { name: 'category', type: T.STR },
      { name: 'requisitionId', type: T.STR },
      { name: 'listingId', type: T.STR },
      { name: 'salesOrderId', type: T.STR },
      { name: 'buyerGstin', type: T.STR },
      { name: 'buyerName', type: T.STR, width: 280 },
      { name: 'sellerGstin', type: T.STR },
      { name: 'sellerName', type: T.STR, width: 280 },
      { name: 'hsnCode', type: T.STR },
      { name: 'itemNames', type: T.STR, width: 280 },
      { name: 'materialType', type: T.STR },
      { name: 'requestedQtyMT', type: T.NUM },
      { name: 'bookedQtyMT', type: T.NUM },
      { name: 'finalRatePerKg', type: T.NUM, note: 'source header says per MT; values are per kg' },
      { name: 'invoiceDate', type: T.DATE },
      { name: 'invoiceNumber', type: T.STR },
      { name: 'ewayBillNumber', type: T.STR },
      { name: 'invoiceQtyMT', type: T.NUM },
      { name: 'invoiceTaxableAmount', type: T.NUM },
      { name: 'invoiceGstAmount', type: T.NUM },
      { name: 'invoiceTotalAmount', type: T.NUM },
      { name: 'paymentTermsDays', type: T.NUM },
      { name: 'paymentTermBucket', type: T.STR },
      { name: 'shipmentStatus', type: T.STR },
      { name: 'orderStatus', type: T.STR },
      { name: 'txnDate', type: T.DATE, note: 'Draft_Date — the window basis' },
      { name: 'createdDate', type: T.DATETIME },
      { name: 'orderVerifiedDate', type: T.DATETIME },
      { name: 'dispatchedDate', type: T.DATETIME },
      { name: 'reachedDate', type: T.DATETIME },
      { name: 'receivedDate', type: T.DATETIME },
      { name: 'completedDate', type: T.DATETIME },
      { name: 'cancelledDate', type: T.DATETIME },
      { name: 'rejectedDate', type: T.DATETIME },
      { name: 'businessWeek', type: T.STR },
      { name: 'monthWeek', type: T.STR },
      { name: 'regionId', type: T.STR, note: 'supply-side region' },
      { name: 'pocUserId', type: T.STR, note: 'supply-side (seller) POC' },
      { name: 'buyerRegionId', type: T.STR },
      { name: 'buyerPocUserId', type: T.STR, note: 'demand-side (buyer) POC' },
      { name: 'isValidTxn', type: T.BOOL, note: 'status ∉ {DRAFT, CANCELLED, blank}' },
      { name: 'hasShipmentId', type: T.BOOL, note: 'false when keyed off the order — no shipment raised yet' },
      { name: 'syncedAt', type: T.DATETIME },
      { name: 'syncBatch', type: T.STR }
    ]
  },

  /** Onboarding facts — mirror of 🏢 Seller Onboarding. */
  DB_Onboarding: {
    pk: 'onboardingKey',
    index: ['gstin', 'pocUserId', 'onboardedDate'],
    cols: [
      { name: 'onboardingKey', type: T.STR, note: 'Seller_ID / Buyer_ID' },
      { name: 'accountType', type: T.STR },
      { name: 'category', type: T.STR },
      { name: 'businessVertical', type: T.STR },
      { name: 'gstin', type: T.STR },
      { name: 'businessName', type: T.STR, width: 300 },
      { name: 'regionId', type: T.STR },
      { name: 'rhName', type: T.STR },
      { name: 'pocUserId', type: T.STR },
      { name: 'accountSubType', type: T.STR },
      { name: 'status', type: T.STR },
      { name: 'contactPerson', type: T.STR },
      { name: 'mobile', type: T.STR },
      { name: 'email', type: T.STR },
      { name: 'state', type: T.STR },
      { name: 'city', type: T.STR },
      { name: 'effectiveRegistrationDate', type: T.DATE },
      { name: 'businessVintage', type: T.STR },
      { name: 'createdDate', type: T.DATETIME },
      { name: 'reviewSubmissionDate', type: T.DATETIME },
      { name: 'onboardedDate', type: T.DATE },
      { name: 'updatedDate', type: T.DATETIME },
      { name: 'decisionReason', type: T.STR },
      { name: 'createdByName', type: T.STR },
      { name: 'submittedByName', type: T.STR },
      { name: 'updatedByName', type: T.STR },
      { name: 'totalListings', type: T.NUM },
      { name: 'approvedListings', type: T.NUM },
      { name: 'closedListings', type: T.NUM },
      { name: 'expiredListings', type: T.NUM },
      { name: 'rejectedListings', type: T.NUM },
      { name: 'listingsConverted', type: T.NUM },
      { name: 'listingsNotConverted', type: T.NUM },
      { name: 'lastListingDate', type: T.DATE },
      { name: 'daysInactive', type: T.NUM },
      { name: 'totalOrders', type: T.NUM },
      { name: 'totalShipments', type: T.NUM },
      { name: 'shipDispatched', type: T.NUM },
      { name: 'shipReached', type: T.NUM },
      { name: 'shipReceived', type: T.NUM },
      { name: 'shipCompleted', type: T.NUM },
      { name: 'shipCancelled', type: T.NUM },
      { name: 'cancelledBeforeShipment', type: T.NUM },
      { name: 'onboardingSlaDays', type: T.NUM, note: 'created → onboarded' },
      { name: 'slaBreached', type: T.BOOL },
      { name: 'syncedAt', type: T.DATETIME },
      { name: 'syncBatch', type: T.STR }
    ]
  },

  /** Field-visit facts — normalised from 📍 MTD Pulse Summary. */
  DB_Pulse: {
    pk: 'pulseId',
    index: ['pocUserId', 'visitDate'],
    cols: [
      { name: 'pulseId', type: T.STR },
      { name: 'category', type: T.STR },
      { name: 'visitDate', type: T.DATE },
      { name: 'pocUserId', type: T.STR },
      { name: 'employeeCode', type: T.STR },
      { name: 'regionId', type: T.STR },
      { name: 'accountId', type: T.STR },
      { name: 'gstin', type: T.STR },
      { name: 'accountName', type: T.STR, width: 280 },
      { name: 'visitCount', type: T.NUM },
      { name: 'onLeave', type: T.BOOL },
      { name: 'purpose', type: T.STR },
      { name: 'outcome', type: T.STR },
      { name: 'remarks', type: T.STR, width: 400 },
      { name: 'evidenceUrl', type: T.STR },
      { name: 'sourceSystem', type: T.STR },
      { name: 'sourceRef', type: T.STR },
      { name: 'createdAt', type: T.DATETIME },
      { name: 'createdBy', type: T.STR }
    ]
  },

  /** Receivables — feeds DSO Days and DN % of GMV (Demand KRAs). */
  DB_Receivables: {
    pk: 'receivableId',
    index: ['cycleId', 'buyerGstin'],
    cols: [
      { name: 'receivableId', type: T.STR },
      { name: 'cycleId', type: T.STR },
      { name: 'category', type: T.STR },
      { name: 'buyerGstin', type: T.STR },
      { name: 'buyerName', type: T.STR, width: 280 },
      { name: 'pocUserId', type: T.STR },
      { name: 'regionId', type: T.STR },
      { name: 'asOnDate', type: T.DATE },
      { name: 'openingReceivableINR', type: T.NUM },
      { name: 'closingReceivableINR', type: T.NUM },
      { name: 'debitNoteINR', type: T.NUM, note: 'DN' },
      { name: 'creditNoteINR', type: T.NUM },
      { name: 'overdueINR', type: T.NUM },
      { name: 'remarks', type: T.STR },
      { name: 'createdAt', type: T.DATETIME },
      { name: 'createdBy', type: T.STR },
      { name: 'updatedAt', type: T.DATETIME },
      { name: 'updatedBy', type: T.STR }
    ]
  },

  /** Onboarding pipeline — 📋 Aug Buyer Plan + prospect lists. */
  DB_Pipeline: {
    pk: 'pipelineId',
    index: ['category', 'pocUserId', 'stage'],
    cols: [
      { name: 'pipelineId', type: T.STR },
      { name: 'accountType', type: T.STR },
      { name: 'category', type: T.STR },
      { name: 'businessName', type: T.STR, width: 320 },
      { name: 'gstin', type: T.STR },
      { name: 'commodity', type: T.STR },
      { name: 'regionId', type: T.STR },
      { name: 'state', type: T.STR },
      { name: 'city', type: T.STR },
      { name: 'mobile', type: T.STR },
      { name: 'contactPerson', type: T.STR },
      { name: 'pocUserId', type: T.STR },
      { name: 'paymentTerms', type: T.STR },
      { name: 'stage', type: T.STR, enum: Object.keys(PIPELINE_STAGE) },
      { name: 'documentStatus', type: T.STR, note: 'derived from DB_Documents' },
      { name: 'expectedTonnageMT', type: T.NUM },
      { name: 'expectedOnboardDate', type: T.DATE },
      { name: 'onboardedDate', type: T.DATE },
      { name: 'currentOrders', type: T.NUM },
      { name: 'blockerReason', type: T.STR },
      { name: 'remarks', type: T.STR, width: 480 },
      { name: 'lastActionDate', type: T.DATE },
      { name: 'nextActionDate', type: T.DATE },
      { name: 'active', type: T.BOOL },
      { name: 'createdAt', type: T.DATETIME },
      { name: 'createdBy', type: T.STR },
      { name: 'updatedAt', type: T.DATETIME },
      { name: 'updatedBy', type: T.STR }
    ]
  },

  /** Document checklist slots — replaces the ⬜/✅ glyph grid. */
  DB_Documents: {
    pk: 'documentId',
    index: ['pipelineId', 'slotKey'],
    cols: [
      { name: 'documentId', type: T.STR },
      { name: 'pipelineId', type: T.STR },
      { name: 'accountId', type: T.STR },
      { name: 'slotKey', type: T.STR },
      { name: 'slotLabel', type: T.STR },
      { name: 'collected', type: T.BOOL },
      { name: 'evidenceUrl', type: T.STR, width: 300 },
      { name: 'collectedDate', type: T.DATE },
      { name: 'expiryDate', type: T.DATE },
      { name: 'verifiedBy', type: T.STR },
      { name: 'verifiedAt', type: T.DATETIME },
      { name: 'remarks', type: T.STR },
      { name: 'updatedAt', type: T.DATETIME },
      { name: 'updatedBy', type: T.STR }
    ]
  },

  // -- Review --------------------------------------------------------------
  DB_Reviews: {
    pk: 'reviewId',
    index: ['cycleId', 'subjectUserId'],
    cols: [
      { name: 'reviewId', type: T.STR },
      { name: 'cycleId', type: T.STR },
      { name: 'category', type: T.STR },
      { name: 'reviewLevel', type: T.STR, enum: ['POC', 'REGION', 'TEAM'] },
      { name: 'subjectUserId', type: T.STR },
      { name: 'subjectRegionId', type: T.STR },
      { name: 'reviewDate', type: T.DATE },
      { name: 'weightedScore', type: T.NUM },
      { name: 'overallAchievement', type: T.NUM },
      { name: 'rating', type: T.NUM },
      { name: 'ratingLabel', type: T.STR },
      { name: 'strengths', type: T.STR, width: 480 },
      { name: 'gaps', type: T.STR, width: 480 },
      { name: 'leadershipNote', type: T.STR, width: 480 },
      { name: 'pocResponse', type: T.STR, width: 480 },
      { name: 'status', type: T.STR, enum: ['DRAFT', 'SHARED', 'ACKNOWLEDGED', 'SIGNED_OFF'] },
      { name: 'snapshot', type: T.JSON, note: 'frozen scorecard at review time' },
      { name: 'reviewedBy', type: T.STR },
      { name: 'reviewedAt', type: T.DATETIME },
      { name: 'acknowledgedAt', type: T.DATETIME },
      { name: 'createdAt', type: T.DATETIME },
      { name: 'createdBy', type: T.STR },
      { name: 'updatedAt', type: T.DATETIME },
      { name: 'updatedBy', type: T.STR }
    ]
  },

  DB_Actions: {
    pk: 'actionId',
    index: ['cycleId', 'ownerUserId', 'status'],
    cols: [
      { name: 'actionId', type: T.STR },
      { name: 'cycleId', type: T.STR },
      { name: 'category', type: T.STR },
      { name: 'reviewId', type: T.STR },
      { name: 'sourceType', type: T.STR, note: 'REVIEW | ALERT | MANUAL' },
      { name: 'sourceRef', type: T.STR },
      { name: 'title', type: T.STR, width: 380 },
      { name: 'description', type: T.STR, width: 520 },
      { name: 'ownerUserId', type: T.STR },
      { name: 'regionId', type: T.STR },
      { name: 'accountId', type: T.STR },
      { name: 'kpiId', type: T.STR },
      { name: 'priority', type: T.STR, enum: ['P1', 'P2', 'P3'] },
      { name: 'dueDate', type: T.DATE },
      { name: 'status', type: T.STR, enum: ['OPEN', 'IN_PROGRESS', 'BLOCKED', 'DONE', 'CANCELLED'] },
      { name: 'closureRemarks', type: T.STR, width: 400 },
      { name: 'evidenceUrl', type: T.STR },
      { name: 'closedAt', type: T.DATETIME },
      { name: 'createdAt', type: T.DATETIME },
      { name: 'createdBy', type: T.STR },
      { name: 'updatedAt', type: T.DATETIME },
      { name: 'updatedBy', type: T.STR }
    ]
  },

  /** Daily frozen metric values — powers trend and forecast without replay. */
  DB_Snapshots: {
    pk: 'snapshotId',
    index: ['snapshotDate', 'cycleId', 'scope', 'scopeKey'],
    cols: [
      { name: 'snapshotId', type: T.STR },
      { name: 'snapshotDate', type: T.DATE },
      { name: 'cycleId', type: T.STR },
      { name: 'category', type: T.STR },
      { name: 'scope', type: T.STR, enum: ['OVERALL', 'REGION', 'POC', 'ACCOUNT'] },
      { name: 'scopeKey', type: T.STR },
      { name: 'metricKey', type: T.STR },
      { name: 'targetValue', type: T.NUM },
      { name: 'actualValue', type: T.NUM },
      { name: 'lmtdValue', type: T.NUM },
      { name: 'achievementPct', type: T.NUM },
      { name: 'createdAt', type: T.DATETIME }
    ]
  },

  // -- Governance ----------------------------------------------------------
  DB_Audit: {
    pk: 'auditId',
    index: ['timestamp', 'userEmail', 'entity'],
    cols: [
      { name: 'auditId', type: T.STR },
      { name: 'timestamp', type: T.DATETIME },
      { name: 'userEmail', type: T.STR },
      { name: 'userId', type: T.STR },
      { name: 'role', type: T.STR },
      { name: 'action', type: T.STR },
      { name: 'entity', type: T.STR },
      { name: 'entityId', type: T.STR },
      { name: 'summary', type: T.STR, width: 420 },
      { name: 'before', type: T.JSON, width: 400 },
      { name: 'after', type: T.JSON, width: 400 },
      { name: 'success', type: T.BOOL },
      { name: 'errorMessage', type: T.STR }
    ]
  },

  DB_SyncLog: {
    pk: 'syncId',
    index: ['startedAt', 'source'],
    cols: [
      { name: 'syncId', type: T.STR },
      { name: 'source', type: T.STR },
      { name: 'sourceSpreadsheetId', type: T.STR },
      { name: 'sourceSheetName', type: T.STR },
      { name: 'startedAt', type: T.DATETIME },
      { name: 'finishedAt', type: T.DATETIME },
      { name: 'rowsRead', type: T.NUM },
      { name: 'rowsInserted', type: T.NUM },
      { name: 'rowsUpdated', type: T.NUM },
      { name: 'rowsSkipped', type: T.NUM },
      { name: 'warnings', type: T.STR, width: 480 },
      { name: 'status', type: T.STR },
      { name: 'errorMessage', type: T.STR, width: 400 },
      { name: 'triggeredBy', type: T.STR }
    ]
  }
});

/** Ordered list of physical sheets, used by bootstrap. */
var SCHEMA_ORDER = [
  SHEET.CONFIG, SHEET.USERS, SHEET.REGIONS, SHEET.CYCLES, SHEET.KRA, SHEET.KPI,
  SHEET.ASSIGNMENT, SHEET.ACCOUNTS, SHEET.ACCOUNT_PLAN, SHEET.ONBOARDING_PLAN,
  SHEET.WEEKLY_PLAN, SHEET.ACTIVITIES, SHEET.SHIPMENTS, SHEET.ONBOARDING,
  SHEET.PULSE, SHEET.RECEIVABLES, SHEET.PIPELINE, SHEET.DOCUMENTS,
  SHEET.REVIEWS, SHEET.ACTIONS, SHEET.SNAPSHOTS, SHEET.AUDIT, SHEET.SYNC_LOG
];

function schemaFor(sheetName) {
  var def = SCHEMA[sheetName];
  if (!def) throw new AppError('SCHEMA_MISSING', 'No schema defined for ' + sheetName);
  return def;
}

function schemaHeaders(sheetName) {
  return schemaFor(sheetName).cols.map(function (c) { return c.name; });
}
