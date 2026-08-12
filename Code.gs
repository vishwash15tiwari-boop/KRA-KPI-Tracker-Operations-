/**
 * Code.gs — OMP Operations KRA/KPI Tracker
 *
 * Single-file server build. This is a straight concatenation of the modular
 * source in src/server/ (00_Config.gs .. 16_Code.gs), in the same load order,
 * for projects that prefer one Code.gs over 19 files in the Apps
 * Script editor. Behaviour is identical either way. The section markers below
 * name the original file each block came from.
 */

// ============================================================================
// 00_Config.gs
// ============================================================================

/**
 * 00_Config.gs — Application constants, enumerations and tunable business rules.
 *
 * Everything in this file is a decision extracted from the source workbook
 * (see docs/WORKBOOK-ANALYSIS.md). Nothing here is invented. Where the workbook
 * contained an inconsistency, the corrected behaviour is exposed as a config key
 * whose default restores the intended business meaning and whose alternate value
 * reproduces the legacy spreadsheet number exactly.
 *
 * Runtime overrides live in the DB_Config sheet and are read through
 * Config.get(); this file supplies the shipped defaults.
 */

var APP = Object.freeze({
  NAME: 'OMP Operations KRA/KPI Tracker',
  SHORT_NAME: 'OMP Ops Tracker',
  VERSION: '1.0.0',
  SCHEMA_VERSION: 4,
  TIMEZONE: 'Asia/Kolkata',
  SUPPORT: 'operations-tools@omp.internal'
});

/** Property keys used in ScriptProperties. */
var PROP = Object.freeze({
  DB_ID: 'OMP_DB_SPREADSHEET_ID',
  SCHEMA_VERSION: 'OMP_SCHEMA_VERSION',
  BOOTSTRAP_ADMIN: 'OMP_BOOTSTRAP_ADMIN'
});

// ---------------------------------------------------------------------------
// Dimensions
// ---------------------------------------------------------------------------

/** Business categories the platform serves. Partition key on every fact row. */
var CATEGORY = Object.freeze({
  PLASTIC: 'Plastic',
  METAL: 'Metal'
});
var CATEGORIES = [CATEGORY.PLASTIC, CATEGORY.METAL];

/** Supply serves sellers; Demand serves buyers. Each carries its own KRA set. */
var STREAM = Object.freeze({
  SUPPLY: 'SUPPLY',
  DEMAND: 'DEMAND',
  GENERAL: 'GENERAL' // single-stream business functions (Onboarding, Collections, …)
});
var STREAMS = [STREAM.SUPPLY, STREAM.DEMAND, STREAM.GENERAL];

/**
 * How a business function's KRAs are grouped into streams. SUPPLY_DEMAND is
 * OMP's two-sided seller/buyer split; SINGLE is one undifferentiated stream
 * (STREAM.GENERAL) for functions with no natural two-sided structure.
 */
var STREAM_MODE = Object.freeze({
  SUPPLY_DEMAND: 'SUPPLY_DEMAND',
  SINGLE: 'SINGLE'
});

/**
 * How a business function's metrics are computed. LEGACY means Engine.metric()
 * dispatches to the hand-written OMP switch (legacyMetric_); GENERIC means it
 * dispatches to GenericEngine.metric(), which interprets DB_MetricDef rows —
 * the config-only path a new business function uses with no engine code.
 */
var CALCULATOR_MODE = Object.freeze({
  LEGACY: 'LEGACY',
  GENERIC: 'GENERIC'
});

/** Aggregation kinds a GENERIC business function's DB_MetricDef row can declare. */
var AGGREGATION = Object.freeze({
  COUNT: 'COUNT',
  SUM: 'SUM',
  DISTINCT_COUNT: 'DISTINCT_COUNT',
  RATIO: 'RATIO',
  DERIVED: 'DERIVED'
});

/**
 * Roles, ordered by authority. Higher rank implies every capability of the
 * ranks below it within the same category scope.
 */
var ROLE = Object.freeze({
  ADMIN: 'ADMIN',             // platform owner; schema, users, config
  LEADERSHIP: 'LEADERSHIP',   // read-everything, review, sign-off
  TEAM_LEAD: 'TEAM_LEAD',     // owns planning for a category
  RH: 'RH',                   // regional head; plans and reviews one region
  POC: 'POC',                 // executes; updates own activities only
  VIEWER: 'VIEWER'            // read-only, scoped
});
var ROLE_RANK = Object.freeze({
  ADMIN: 60, LEADERSHIP: 50, TEAM_LEAD: 40, RH: 30, POC: 20, VIEWER: 10
});

/** Cycle lifecycle. Activities may only be booked against PUBLISHED cycles. */
var CYCLE_STATUS = Object.freeze({
  DRAFT: 'DRAFT',          // being planned; invisible to POCs
  PUBLISHED: 'PUBLISHED',   // live; POCs execute against it
  LOCKED: 'LOCKED',        // month ended; no new activity, scores frozen for review
  CLOSED: 'CLOSED'         // reviewed and signed off
});

/** Direction of goodness for a KPI. Drives achievement and rating maths. */
var DIRECTION = Object.freeze({
  HIGHER_BETTER: 'HIGHER_BETTER',
  LOWER_BETTER: 'LOWER_BETTER'
});

/** Where a KPI's target comes from. */
var TARGET_BASIS = Object.freeze({
  MANUAL: 'MANUAL',                 // Team Lead types the number
  ACCOUNT_PLAN: 'ACCOUNT_PLAN',     // Σ of per-account monthly plan
  PCT_OF_METRIC: 'PCT_OF_METRIC',   // e.g. 50% of YTD onboarded sellers
  BALANCE_PLUS_MTD: 'BALANCE_PLUS_MTD', // POC-Wise!N = (annual plan − YTD) + MTD
  RATE_PER_DAY: 'RATE_PER_DAY'      // e.g. pulse visits = working days × 3
});

// ---------------------------------------------------------------------------
// Source-system vocabularies (verbatim from the workbook)
// ---------------------------------------------------------------------------

var SHIPMENT_STATUS = Object.freeze({
  DRAFT: 'DRAFT',
  DISPATCHED: 'DISPATCHED',
  REACHED: 'REACHED',
  RECEIVED_BY_RECYCLER: 'RECEIVED_BY_RECYCLER',
  COMPLETED: 'COMPLETED',
  CANCELLED: 'CANCELLED'
});

/**
 * The universal transaction filter, reproduced from ~40 COUNTIFS/SUMIFS in the
 * workbook: status <> "Draft" AND <> "Cancelled" AND <> "" (blank).
 */
var INVALID_TXN_STATUSES = Object.freeze(['DRAFT', 'CANCELLED', '']);

var ONBOARDING_STATUS = Object.freeze({
  DRAFT: 'DRAFT',
  IN_REVIEW: 'IN_REVIEW',
  COMPLETED: 'COMPLETED',
  REJECTED: 'REJECTED'
});

var MATERIAL_TYPE = Object.freeze({
  PET: 'PET',
  FLAKES: 'Flakes',
  OTHERS: 'Others (Granules/Fibre)'
});
var MATERIAL_TYPES = [MATERIAL_TYPE.PET, MATERIAL_TYPE.FLAKES, MATERIAL_TYPE.OTHERS];

var SELLER_TYPES = Object.freeze([
  'Baler', 'Trader', 'Baler Cum Trader', 'Manufacturer', 'Aggregator'
]);

var PAYMENT_TERMS = Object.freeze([
  'POD', 'Spot Payment', 'D+3', 'D+5', 'D+10', 'D+15', 'D+30',
  'NBFC', 'Under Negotiation'
]);

/** Document slots gating buyer onboarding (Aug Buyer Plan!M:R). */
var DOCUMENT_SLOTS = Object.freeze([
  { key: 'GST_CERTIFICATE', label: 'GST Certificate', required: true },
  { key: 'PAN_CARD', label: 'PAN Card', required: true },
  { key: 'PWM_CTE', label: 'PWM Certificate CTE', required: true },
  { key: 'PWM_CTO', label: 'PWM Certificate CTO', required: true },
  { key: 'CANCELLED_CHEQUE', label: 'Cancelled Cheque', required: true }
]);

var PIPELINE_STAGE = Object.freeze({
  PROSPECT: 'PROSPECT',
  FOLLOWUP: 'FOLLOWUP',
  DOCS_PENDING: 'DOCS_PENDING',
  UNDER_PROCESS: 'UNDER_PROCESS',
  ONBOARDED: 'ONBOARDED',
  DROPPED: 'DROPPED'
});

/** Blocker reason codes distilled from the free-text Remarks columns. */
var BLOCKER_REASONS = Object.freeze([
  'Working with Trader / Competitor',
  'GST Payment Pending',
  'Cash-only Seller',
  'Spot Payment Only',
  'Payment Terms Not Agreed',
  'Documents Pending',
  'Price Mismatch',
  'Quality Rejection',
  'Capacity Constraint',
  'Under Negotiation',
  'Awaiting NBFC Approval',
  'No Response',
  'Other'
]);

// ---------------------------------------------------------------------------
// Activity taxonomy — the single surface a POC touches ("Update Once")
// ---------------------------------------------------------------------------

/**
 * Each activity type declares which metric it feeds, what it measures, and which
 * evidence it demands. Recording an activity is the ONLY way a number enters the
 * system; the engine derives everything else.
 *
 *  measures      : numeric fields captured on the activity row
 *  requiresAccount: an account (seller/buyer) must be selected
 *  evidence      : NONE | OPTIONAL | REQUIRED
 *  systemOwned   : true when rows arrive from the source-system sync and are
 *                  therefore read-only in the UI (POCs annotate, never edit)
 */
var ACTIVITY_TYPE = Object.freeze({
  FIELD_VISIT: 'FIELD_VISIT',
  SELLER_ONBOARDING: 'SELLER_ONBOARDING',
  BUYER_ONBOARDING: 'BUYER_ONBOARDING',
  PROPOSAL_SENT: 'PROPOSAL_SENT',
  LISTING_CREATED: 'LISTING_CREATED',
  ORDER_BOOKED: 'ORDER_BOOKED',
  SHIPMENT: 'SHIPMENT',
  PAYMENT_COLLECTED: 'PAYMENT_COLLECTED',
  DOCUMENT_COLLECTED: 'DOCUMENT_COLLECTED',
  FOLLOW_UP: 'FOLLOW_UP',
  ISSUE_RESOLUTION: 'ISSUE_RESOLUTION'
});

var ACTIVITY_TYPES = Object.freeze([
  {
    key: ACTIVITY_TYPE.FIELD_VISIT,
    label: 'Field Visit (Pulse)',
    icon: 'pin',
    stream: 'BOTH',
    metrics: ['PULSE_VISITS', 'UNIQUE_ACCOUNT_VISITS'],
    measures: [{ key: 'count', label: 'Visits', unit: 'visits', default: 1 }],
    requiresAccount: true,
    evidence: 'REQUIRED',
    systemOwned: false,
    help: 'One row per seller or buyer visited. Feeds Pulse Visits and coverage.'
  },
  {
    key: ACTIVITY_TYPE.SELLER_ONBOARDING,
    label: 'Seller Onboarding',
    icon: 'building',
    stream: STREAM.SUPPLY,
    metrics: ['SELLER_ONBOARDED'],
    measures: [],
    requiresAccount: true,
    evidence: 'REQUIRED',
    systemOwned: true,
    help: 'Counts only when the onboarding reaches COMPLETED. Synced from the ops system.'
  },
  {
    key: ACTIVITY_TYPE.BUYER_ONBOARDING,
    label: 'Buyer Onboarding',
    icon: 'handshake',
    stream: STREAM.DEMAND,
    metrics: ['BUYER_ONBOARDED'],
    measures: [],
    requiresAccount: true,
    evidence: 'REQUIRED',
    systemOwned: false,
    help: 'Document checklist must be complete before the buyer can be marked onboarded.'
  },
  {
    key: ACTIVITY_TYPE.PROPOSAL_SENT,
    label: 'Proposal Sent',
    icon: 'mail',
    stream: 'BOTH',
    metrics: ['PROPOSALS_SENT'],
    measures: [
      { key: 'quantityMT', label: 'Offered Qty', unit: 'MT' },
      { key: 'ratePerKg', label: 'Offered Rate', unit: '₹/kg' }
    ],
    requiresAccount: true,
    evidence: 'OPTIONAL',
    systemOwned: false,
    help: 'A priced offer to a seller or buyer.'
  },
  {
    key: ACTIVITY_TYPE.LISTING_CREATED,
    label: 'Listing Created',
    icon: 'list',
    stream: STREAM.SUPPLY,
    metrics: ['LISTINGS_CREATED'],
    measures: [{ key: 'quantityMT', label: 'Listed Qty', unit: 'MT' }],
    requiresAccount: true,
    evidence: 'OPTIONAL',
    systemOwned: true,
    help: 'Seller listing raised on the marketplace.'
  },
  {
    key: ACTIVITY_TYPE.ORDER_BOOKED,
    label: 'Order Booked',
    icon: 'clipboard',
    stream: 'BOTH',
    metrics: ['ORDERS_BOOKED'],
    measures: [
      { key: 'quantityMT', label: 'Booked Qty', unit: 'MT' },
      { key: 'ratePerKg', label: 'Rate', unit: '₹/kg' }
    ],
    requiresAccount: true,
    evidence: 'OPTIONAL',
    systemOwned: true,
    help: 'Order confirmed between a seller and a buyer.'
  },
  {
    key: ACTIVITY_TYPE.SHIPMENT,
    label: 'Shipment / Transaction',
    icon: 'truck',
    stream: 'BOTH',
    metrics: ['TXN_COUNT', 'TONNAGE_MT', 'GMV_CR'],
    measures: [
      { key: 'quantityMT', label: 'Invoice Qty', unit: 'MT' },
      { key: 'amountINR', label: 'Invoice Taxable Amount', unit: '₹' }
    ],
    requiresAccount: true,
    evidence: 'OPTIONAL',
    systemOwned: true,
    help: 'The transaction fact. Counts only when status is neither Draft nor Cancelled.'
  },
  {
    key: ACTIVITY_TYPE.PAYMENT_COLLECTED,
    label: 'Payment Collected',
    icon: 'rupee',
    stream: STREAM.DEMAND,
    metrics: ['PAYMENT_COLLECTED_INR'],
    measures: [{ key: 'amountINR', label: 'Amount', unit: '₹' }],
    requiresAccount: true,
    evidence: 'REQUIRED',
    systemOwned: false,
    help: 'Feeds DSO and DN% of GMV.'
  },
  {
    key: ACTIVITY_TYPE.DOCUMENT_COLLECTED,
    label: 'Document Collected',
    icon: 'file',
    stream: 'BOTH',
    metrics: ['DOCS_COLLECTED'],
    measures: [],
    requiresAccount: true,
    evidence: 'REQUIRED',
    systemOwned: false,
    help: 'Advances the onboarding document checklist.'
  },
  {
    key: ACTIVITY_TYPE.FOLLOW_UP,
    label: 'Follow-up',
    icon: 'phone',
    stream: 'BOTH',
    metrics: ['FOLLOW_UPS'],
    measures: [],
    requiresAccount: true,
    evidence: 'OPTIONAL',
    systemOwned: false,
    help: 'Call, message or meeting that moved an account forward.'
  },
  {
    key: ACTIVITY_TYPE.ISSUE_RESOLUTION,
    label: 'Issue Resolution',
    icon: 'alert',
    stream: 'BOTH',
    metrics: ['ISSUES_RESOLVED'],
    measures: [],
    requiresAccount: false,
    evidence: 'REQUIRED',
    systemOwned: false,
    help: 'Quality rejection, payment dispute, logistics failure and similar.'
  }
]);

// ---------------------------------------------------------------------------
// Metric registry — every number the engine can produce
// ---------------------------------------------------------------------------

/**
 * unit:  COUNT | MT | CR | PCT | DAYS | INR | RATE
 * A metric is a pure function of (facts, window, scope). Nothing else.
 */
var METRICS = Object.freeze({
  SELLER_ONBOARDED:      { label: 'Sellers Onboarded', unit: 'COUNT', stream: STREAM.SUPPLY },
  BUYER_ONBOARDED:       { label: 'Buyers Onboarded', unit: 'COUNT', stream: STREAM.DEMAND },
  TXN_COUNT:             { label: 'Transactions', unit: 'COUNT', stream: 'BOTH' },
  TONNAGE_MT:            { label: 'Tonnage', unit: 'MT', stream: 'BOTH' },
  GMV_CR:                { label: 'GMV', unit: 'CR', stream: 'BOTH' },
  RATE_PER_KG:           { label: 'Realised Rate', unit: 'RATE', stream: 'BOTH' },
  EXISTING_SELLER_TXN:   { label: 'Existing Sellers Transacted', unit: 'COUNT', stream: STREAM.SUPPLY },
  NEW_SELLER_TXN:        { label: 'New Sellers Transacted', unit: 'COUNT', stream: STREAM.SUPPLY },
  SELLER_RETENTION:      { label: 'Sellers Retained', unit: 'COUNT', stream: STREAM.SUPPLY },
  EXISTING_BUYER_TXN:    { label: 'Existing Buyers Transacted', unit: 'COUNT', stream: STREAM.DEMAND },
  NEW_BUYER_TXN:         { label: 'New Buyers Transacted', unit: 'COUNT', stream: STREAM.DEMAND },
  BUYER_RETENTION:       { label: 'Buyers Retained', unit: 'COUNT', stream: STREAM.DEMAND },
  DN_PCT_OF_GMV:         { label: 'DN % of GMV', unit: 'PCT', stream: STREAM.DEMAND, direction: DIRECTION.LOWER_BETTER },
  DSO_DAYS:              { label: 'DSO', unit: 'DAYS', stream: STREAM.DEMAND, direction: DIRECTION.LOWER_BETTER },
  PULSE_VISITS:          { label: 'Pulse Visits', unit: 'COUNT', stream: 'BOTH' },
  UNIQUE_ACCOUNT_VISITS: { label: 'Unique Accounts Visited', unit: 'COUNT', stream: 'BOTH' },
  ONBOARDED_VS_VISIT:    { label: 'Onboarded Accounts Visited', unit: 'COUNT', stream: 'BOTH' },
  ONBOARDED_VS_TXN:      { label: 'Onboarded Accounts Transacted', unit: 'COUNT', stream: 'BOTH' },
  PROPOSALS_SENT:        { label: 'Proposals Sent', unit: 'COUNT', stream: 'BOTH' },
  LISTINGS_CREATED:      { label: 'Listings Created', unit: 'COUNT', stream: STREAM.SUPPLY },
  ORDERS_BOOKED:         { label: 'Orders Booked', unit: 'COUNT', stream: 'BOTH' },
  PAYMENT_COLLECTED_INR: { label: 'Payments Collected', unit: 'INR', stream: STREAM.DEMAND },
  DOCS_COLLECTED:        { label: 'Documents Collected', unit: 'COUNT', stream: 'BOTH' },
  FOLLOW_UPS:            { label: 'Follow-ups', unit: 'COUNT', stream: 'BOTH' },
  ISSUES_RESOLVED:       { label: 'Issues Resolved', unit: 'COUNT', stream: 'BOTH' }
});

// ---------------------------------------------------------------------------
// Rating scale (KRA & KPI sheet rows 19–23)
// ---------------------------------------------------------------------------

var RATING_SCALE = Object.freeze([
  { rating: 5, label: 'Exceeds Expectation', threshold: 1.05, tone: 'excellent' },
  { rating: 4, label: 'Above Expectation', threshold: 1.00, tone: 'good' },
  { rating: 3, label: 'Meets Expectation', threshold: 0.90, tone: 'ok' },
  { rating: 2, label: 'Below Expectation', threshold: 0.75, tone: 'warn' },
  { rating: 1, label: 'Needs Improvement', threshold: 0.60, tone: 'bad' },
  { rating: 0, label: 'Below 60%', threshold: -Infinity, tone: 'critical' }
]);

/** Legacy status label shown on the scorecard (per-POC sheet, column I). */
var TARGET_BAND_LABELS = Object.freeze([
  { threshold: 1.05, label: '105% Target' },
  { threshold: 1.00, label: '100% Target' },
  { threshold: 0.90, label: '90% Target' },
  { threshold: 0.75, label: '75% Target' },
  { threshold: 0.60, label: '60% Target' },
  { threshold: -Infinity, label: 'Below 60%' }
]);

// ---------------------------------------------------------------------------
// Tunable business rules — defaults, overridable via DB_Config
// ---------------------------------------------------------------------------

var CONFIG_DEFAULTS = Object.freeze({
  // -- Fiscal calendar -----------------------------------------------------
  FY_START_MONTH: 4,                  // April–March (Indian FY)

  // -- Reporting lag -------------------------------------------------------
  // WhatsApp!B3 = "As Of " & TEXT(TODAY()-1). Source imports lag one day, so
  // every MTD window ends at (today − REPORTING_LAG_DAYS).
  REPORTING_LAG_DAYS: 1,

  // -- GMV basis -----------------------------------------------------------
  // Workbook defect #1: FYTD used Invoice_Total_Amount (incl. GST) while
  // MTD/target used Invoice_Taxable_Amount. TAXABLE makes all windows
  // comparable and matches how targets are quoted. Set TOTAL to reproduce the
  // legacy FYTD figure.
  GMV_BASIS: 'TAXABLE',               // TAXABLE | TOTAL
  GMV_CR_DIVISOR: 10000000,           // ₹ → ₹ Crore

  // -- Rate realisation ----------------------------------------------------
  // Workbook defect #2: legacy divided an ex-GST amount by 1.18. Set 1.18 to
  // reproduce the legacy ₹/kg.
  RATE_GST_DIVISOR: 1,
  GST_RATE: 0.18,

  // -- Scoring -------------------------------------------------------------
  ACHIEVEMENT_CAP: 1.05,              // MIN(F,1.05) in every weighted-score cell
  REQUIRE_WEIGHTAGE_100: true,        // block publish unless each stream sums to 100
  WEIGHTAGE_TOTAL: 100,

  // -- Derived KPI targets (percentages from the KRA definitions) ----------
  EXISTING_TXN_TARGET_PCT: 0.50,      // 50% of onboarded should transact
  NEW_TXN_TARGET_PCT: 0.20,           // 20% of this month's onboarded should transact
  RETENTION_TARGET_PCT: 0.70,         // 70% of last month's transacted should repeat
  DN_TARGET_PCT_OF_GMV: 0.01,         // DN should be 1% of GMV

  // -- Pulse ---------------------------------------------------------------
  PULSE_VISITS_PER_DAY: 3,            // WhatsApp!C38 = 25*3
  PULSE_DEFAULT_WORKING_DAYS: 25,
  PULSE_DEDUCT_LEAVE: true,           // workbook did not deduct leave; corrected

  // -- SLAs (days) — measured off the onboarding lifecycle stamps ----------
  SLA_ONBOARDING_DAYS: 7,             // Created_Date → Onboarded_Date
  SLA_REVIEW_SUBMISSION_DAYS: 2,      // Created_Date → Review_Submission_Date
  SLA_DISPATCH_DAYS: 3,               // Draft_Date → Dispatched_Date
  SLA_DELIVERY_DAYS: 7,               // Dispatched_Date → Received_By_Recycler_Date
  DORMANCY_DAYS: 30,                  // no listing/txn for N days ⇒ dormant

  // -- Alerting thresholds -------------------------------------------------
  PACE_WARN_RATIO: 0.90,              // currentDRR / requiredDRR below this ⇒ at risk
  PACE_CRITICAL_RATIO: 0.70,

  // -- Operational limits --------------------------------------------------
  MAX_ROWS_PER_READ: 20000,
  CACHE_TTL_SECONDS: 300,
  ACTIVITY_BACKDATE_DAYS: 7,          // how far back a POC may log work
  EVIDENCE_URL_PATTERN: '^https://',

  // -- Data source -----------------------------------------------------------
  // The operational workbook Sync reads from when a call does not name a
  // spreadsheet explicitly. Leave '' to have Sync read from this same
  // spreadsheet instead (source tabs living alongside the DB_* tables).
  SOURCE_SPREADSHEET_ID: '1h0MGbmtOriH-T-cxQOGgcXBeydcNqv-bqT2AlLnWDdU',

  // -- Presentation --------------------------------------------------------
  DEFAULT_CATEGORY: CATEGORY.PLASTIC,
  CURRENCY_SYMBOL: '₹'
});

/**
 * Config accessor. Reads DB_Config once per execution and layers it over the
 * shipped defaults. Values are coerced to the type of the default.
 */
var Config = (function () {
  var cache_ = null;

  function load_() {
    if (cache_) return cache_;
    var merged = {};
    Object.keys(CONFIG_DEFAULTS).forEach(function (k) { merged[k] = CONFIG_DEFAULTS[k]; });
    // Publish the defaults before reading the sheet: Repository.readAll itself
    // calls Config.get(), so an unset cache here would recurse forever.
    cache_ = merged;
    try {
      Repository.readAll(SHEET.CONFIG).forEach(function (r) {
        var key = String(r.key || '').trim();
        if (!key || !(key in CONFIG_DEFAULTS)) return;
        merged[key] = coerce_(r.value, CONFIG_DEFAULTS[key]);
      });
    } catch (e) {
      // The config sheet may not exist yet during bootstrap; defaults stand.
    }
    return cache_;
  }

  function coerce_(raw, sample) {
    if (raw === '' || raw === null || raw === undefined) return sample;
    if (typeof sample === 'number') {
      var n = Number(raw);
      return isNaN(n) ? sample : n;
    }
    if (typeof sample === 'boolean') {
      var s = String(raw).trim().toLowerCase();
      return s === 'true' || s === 'yes' || s === '1';
    }
    return String(raw);
  }

  return {
    get: function (key) {
      var v = load_()[key];
      return v === undefined ? CONFIG_DEFAULTS[key] : v;
    },
    all: function () { return load_(); },
    invalidate: function () { cache_ = null; }
  };
})();

// ============================================================================
// 01_Schema.gs
// ============================================================================

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
  BUSINESS_FUNCTIONS: 'DB_BusinessFunctions',
  ACTIVITY_TYPE_DEF: 'DB_ActivityTypeDef',
  METRIC_DEF: 'DB_MetricDef',
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

  /**
   * Business Function registry — the config-driven partition that replaced the
   * hardcoded Plastic/Metal CATEGORY enum. `businessFunctionId` is the exact
   * value stored in every table's `category` column; OMP's two functions keep
   * their historical literal codes ('Plastic', 'Metal') so no existing install
   * needs a data migration.
   */
  DB_BusinessFunctions: {
    pk: 'businessFunctionId',
    cols: [
      { name: 'businessFunctionId', type: T.STR, note: 'stored as `category` on every fact/plan table' },
      { name: 'name', type: T.STR, width: 200 },
      { name: 'description', type: T.STR, width: 400 },
      { name: 'icon', type: T.STR },
      { name: 'color', type: T.STR },
      { name: 'sequence', type: T.NUM },
      { name: 'active', type: T.BOOL },
      { name: 'calculatorMode', type: T.STR, note: 'LEGACY | GENERIC' },
      { name: 'streamMode', type: T.STR, note: 'SUPPLY_DEMAND | SINGLE' },
      { name: 'streamLabels', type: T.JSON, note: '{streamKey: label}' },
      { name: 'hasAccountPlan', type: T.BOOL, note: 'true only for OMP — gates the tonnage/rate/GMV planning tabs' },
      { name: 'createdAt', type: T.DATETIME },
      { name: 'createdBy', type: T.STR },
      { name: 'updatedAt', type: T.DATETIME },
      { name: 'updatedBy', type: T.STR }
    ]
  },

  /**
   * Declarative activity taxonomy for GENERIC business functions — the
   * config-only analog of the hardcoded ACTIVITY_TYPES array in 00_Config.gs.
   * A LEGACY function (OMP) never has rows here; its taxonomy stays in code.
   */
  DB_ActivityTypeDef: {
    pk: 'activityTypeId',
    index: ['businessFunctionId'],
    cols: [
      { name: 'activityTypeId', type: T.STR, note: 'the key stored in DB_Activities.activityType' },
      { name: 'businessFunctionId', type: T.STR },
      { name: 'label', type: T.STR, width: 200 },
      { name: 'icon', type: T.STR },
      { name: 'measures', type: T.JSON, note: 'array of {key,label,unit,column,default}; column is count|measureA|measureB|measureC' },
      { name: 'requiresAccount', type: T.BOOL },
      { name: 'evidence', type: T.STR, note: 'NONE | OPTIONAL | REQUIRED' },
      { name: 'systemOwned', type: T.BOOL },
      { name: 'sequence', type: T.NUM },
      { name: 'active', type: T.BOOL },
      { name: 'help', type: T.STR, width: 400 },
      { name: 'createdAt', type: T.DATETIME },
      { name: 'createdBy', type: T.STR },
      { name: 'updatedAt', type: T.DATETIME },
      { name: 'updatedBy', type: T.STR }
    ]
  },

  /**
   * Declarative metric registry for GENERIC business functions — the
   * config-only analog of the hardcoded METRICS object in 00_Config.gs. The
   * generic engine (06b_GenericEngine.gs) is a pure interpreter of these rows.
   */
  DB_MetricDef: {
    pk: 'metricKey',
    index: ['businessFunctionId'],
    cols: [
      { name: 'metricKey', type: T.STR, note: 'globally unique; referenced by DB_KPI.metricKey' },
      { name: 'businessFunctionId', type: T.STR },
      { name: 'label', type: T.STR, width: 200 },
      { name: 'unit', type: T.STR, note: 'COUNT | SUM | PCT | INR | DAYS | RATE' },
      { name: 'direction', type: T.STR, enum: Object.keys(DIRECTION) },
      { name: 'aggregation', type: T.STR, note: 'COUNT | SUM | DISTINCT_COUNT | RATIO | DERIVED' },
      { name: 'sourceActivityType', type: T.STR, note: 'for COUNT | SUM | DISTINCT_COUNT' },
      { name: 'measureField', type: T.STR, note: 'for SUM (measureA..C) and DISTINCT_COUNT (field to distinct on)' },
      { name: 'numeratorMetric', type: T.STR, note: 'for RATIO' },
      { name: 'denominatorMetric', type: T.STR, note: 'for RATIO' },
      { name: 'multiplier', type: T.NUM, note: 'for RATIO; 100 for a percentage, 1 for a plain ratio' },
      { name: 'expression', type: T.STR, width: 300, note: 'for DERIVED — arithmetic over other metric keys' },
      { name: 'active', type: T.BOOL },
      { name: 'createdAt', type: T.DATETIME },
      { name: 'createdBy', type: T.STR },
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
      { name: 'updatedBy', type: T.STR },
      // -- Generic measures (GENERIC business functions; additive, OMP never
      //    populates these — its three measures keep their named columns above) --
      { name: 'subjectName', type: T.STR, width: 280, note: 'free-text subject for functions with no DB_Accounts counterpart' },
      { name: 'measureA', type: T.NUM },
      { name: 'measureB', type: T.NUM },
      { name: 'measureC', type: T.NUM }
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
  SHEET.CONFIG, SHEET.BUSINESS_FUNCTIONS, SHEET.ACTIVITY_TYPE_DEF, SHEET.METRIC_DEF,
  SHEET.USERS, SHEET.REGIONS, SHEET.CYCLES, SHEET.KRA, SHEET.KPI,
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

// ============================================================================
// 02_Util.gs
// ============================================================================

/**
 * 02_Util.gs — Errors, identifiers, dates, numbers and the fiscal calendar.
 *
 * The date helpers are the exact translations of the workbook's window
 * expressions. They are the only place in the codebase that decides what "MTD"
 * or "LMTD" means, so a change to the reporting convention is a one-line change.
 */

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Typed application error. `code` is stable and safe to branch on in the UI. */
function AppError(code, message, details) {
  this.name = 'AppError';
  this.code = code || 'ERROR';
  this.message = message || code;
  this.details = details || null;
  this.stack = (new Error(message)).stack;
}
AppError.prototype = Object.create(Error.prototype);
AppError.prototype.constructor = AppError;

function fail(code, message, details) { throw new AppError(code, message, details); }

function assert(condition, code, message, details) {
  if (!condition) fail(code, message, details);
}

// ---------------------------------------------------------------------------
// Identifiers
// ---------------------------------------------------------------------------

var Id = (function () {
  var counter_ = 0;
  return {
    /** Sortable, collision-resistant id: PFX-<base36 ms>-<seq>-<rand>. */
    next: function (prefix) {
      counter_ = (counter_ + 1) % 100000;
      return [
        prefix || 'ID',
        Date.now().toString(36).toUpperCase(),
        ('0000' + counter_.toString(36).toUpperCase()).slice(-4),
        Math.floor(Math.random() * 1296).toString(36).toUpperCase()
      ].join('-');
    },
    /** Deterministic id from natural-key parts; used for idempotent upserts. */
    natural: function (prefix) {
      var parts = Array.prototype.slice.call(arguments, 1)
        .map(function (p) { return Util.slug(p); })
        .filter(function (p) { return p !== ''; });
      return prefix + '-' + parts.join('-');
    }
  };
})();

// ---------------------------------------------------------------------------
// General utilities
// ---------------------------------------------------------------------------

var Util = {

  tz: function () { return APP.TIMEZONE; },

  isBlank: function (v) {
    return v === null || v === undefined || (typeof v === 'string' && v.trim() === '');
  },

  str: function (v) {
    if (v === null || v === undefined) return '';
    if (v instanceof Date) return Util.isoDate(v);
    return String(v).trim();
  },

  /** Normalised comparison key: trimmed, collapsed whitespace, upper-cased. */
  key: function (v) {
    return Util.str(v).replace(/\s+/g, ' ').toUpperCase();
  },

  slug: function (v) {
    return Util.str(v).toUpperCase().replace(/[^A-Z0-9]+/g, '');
  },

  num: function (v, fallback) {
    if (v === null || v === undefined || v === '') return fallback === undefined ? 0 : fallback;
    if (typeof v === 'number') return isFinite(v) ? v : (fallback === undefined ? 0 : fallback);
    var n = Number(String(v).replace(/[₹,\s]/g, ''));
    return isNaN(n) || !isFinite(n) ? (fallback === undefined ? 0 : fallback) : n;
  },

  bool: function (v) {
    if (typeof v === 'boolean') return v;
    var s = Util.str(v).toLowerCase();
    return s === 'true' || s === 'yes' || s === 'y' || s === '1' || s === '✅';
  },

  /**
   * Safe division mirroring the workbook's ubiquitous IFERROR(a/b, 0).
   * A zero or missing denominator yields the fallback, never an error.
   */
  div: function (numerator, denominator, fallback) {
    var d = Util.num(denominator, 0);
    if (d === 0) return fallback === undefined ? 0 : fallback;
    var r = Util.num(numerator, 0) / d;
    return isFinite(r) ? r : (fallback === undefined ? 0 : fallback);
  },

  round: function (v, places) {
    var p = Math.pow(10, places === undefined ? 2 : places);
    return Math.round(Util.num(v, 0) * p) / p;
  },

  clamp: function (v, lo, hi) { return Math.min(Math.max(v, lo), hi); },

  sum: function (arr, pick) {
    var t = 0;
    for (var i = 0; i < arr.length; i++) t += Util.num(pick ? pick(arr[i]) : arr[i], 0);
    return t;
  },

  unique: function (arr) {
    var seen = {}, out = [];
    for (var i = 0; i < arr.length; i++) {
      var k = String(arr[i]);
      if (!seen[k]) { seen[k] = 1; out.push(arr[i]); }
    }
    return out;
  },

  groupBy: function (arr, pick) {
    var out = {};
    for (var i = 0; i < arr.length; i++) {
      var k = String(pick(arr[i]));
      (out[k] || (out[k] = [])).push(arr[i]);
    }
    return out;
  },

  indexBy: function (arr, pick) {
    var out = {};
    for (var i = 0; i < arr.length; i++) out[String(pick(arr[i]))] = arr[i];
    return out;
  },

  /** Stable sort by a list of {pick, dir} comparators. */
  sortBy: function (arr, comparators) {
    return arr.slice().sort(function (a, b) {
      for (var i = 0; i < comparators.length; i++) {
        var c = comparators[i], av = c.pick(a), bv = c.pick(b);
        if (av === bv) continue;
        var lt = (av === null || av === undefined) ? true
          : (bv === null || bv === undefined) ? false
            : av < bv;
        return (lt ? -1 : 1) * (c.dir === 'desc' ? -1 : 1);
      }
      return 0;
    });
  },

  pick: function (obj, keys) {
    var out = {};
    keys.forEach(function (k) { if (k in obj) out[k] = obj[k]; });
    return out;
  },

  /**
   * Competition ranking, matching Excel RANK(x, range, 0):
   * descending, ties share the better rank, the next rank skips.
   */
  rank: function (values) {
    var sorted = values.slice().sort(function (a, b) { return b - a; });
    return values.map(function (v) { return sorted.indexOf(v) + 1; });
  },

  truncate: function (s, n) {
    s = Util.str(s);
    return s.length > n ? s.slice(0, n - 1) + '…' : s;
  }
};

// ---------------------------------------------------------------------------
// Dates — the workbook's window algebra
// ---------------------------------------------------------------------------

var DateUtil = {

  /** Coerce anything the sheet may hold into a Date, or null. */
  parse: function (v) {
    if (v === null || v === undefined || v === '') return null;
    if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
    if (typeof v === 'number') {
      // Sheets serial date (days since 1899-12-30).
      if (v > 20000 && v < 80000) return new Date(Math.round((v - 25569) * 86400000));
      return null;
    }
    var s = String(v).trim();
    if (!s) return null;
    // dd/mm/yyyy — the format used by Invoice_Date in the source workbook.
    var m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (m) return new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]));
    var d = new Date(s);
    return isNaN(d.getTime()) ? null : d;
  },

  /** Midnight of the given date, in the app timezone. */
  startOfDay: function (d) {
    var x = DateUtil.parse(d);
    if (!x) return null;
    return new Date(x.getFullYear(), x.getMonth(), x.getDate());
  },

  today: function () { return DateUtil.startOfDay(new Date()); },

  /**
   * The "as of" date every dashboard reports through.
   * Workbook: TEXT(TODAY()-1) — source imports lag one day.
   */
  asOf: function () {
    return DateUtil.addDays(DateUtil.today(), -Config.get('REPORTING_LAG_DAYS'));
  },

  addDays: function (d, n) {
    var x = DateUtil.startOfDay(d);
    return new Date(x.getFullYear(), x.getMonth(), x.getDate() + n);
  },

  addMonths: function (d, n) {
    var x = DateUtil.startOfDay(d);
    return new Date(x.getFullYear(), x.getMonth() + n, x.getDate());
  },

  startOfMonth: function (d) {
    var x = DateUtil.startOfDay(d);
    return new Date(x.getFullYear(), x.getMonth(), 1);
  },

  /** Exclusive upper bound of the month — equivalent to EOMONTH(d,0)+1. */
  startOfNextMonth: function (d) {
    var x = DateUtil.startOfDay(d);
    return new Date(x.getFullYear(), x.getMonth() + 1, 1);
  },

  endOfMonth: function (d) {
    return DateUtil.addDays(DateUtil.startOfNextMonth(d), -1);
  },

  daysInMonth: function (d) { return DateUtil.endOfMonth(d).getDate(); },

  /** Whole days between two dates (b − a). */
  diffDays: function (a, b) {
    var x = DateUtil.startOfDay(a), y = DateUtil.startOfDay(b);
    if (!x || !y) return null;
    return Math.round((y.getTime() - x.getTime()) / 86400000);
  },

  isoDate: function (d) {
    var x = DateUtil.parse(d);
    if (!x) return '';
    return Utilities.formatDate(x, APP.TIMEZONE, 'yyyy-MM-dd');
  },

  isoDateTime: function (d) {
    var x = DateUtil.parse(d);
    if (!x) return '';
    return Utilities.formatDate(x, APP.TIMEZONE, "yyyy-MM-dd'T'HH:mm:ss");
  },

  display: function (d) {
    var x = DateUtil.parse(d);
    return x ? Utilities.formatDate(x, APP.TIMEZONE, 'dd-MMM-yyyy') : '';
  },

  monthLabel: function (year, month) {
    return Utilities.formatDate(new Date(year, month - 1, 1), APP.TIMEZONE, 'MMM yyyy');
  },

  /** Fiscal year containing d, as a start-year number (FY2026-27 → 2026). */
  fiscalYear: function (d) {
    var x = DateUtil.startOfDay(d || new Date());
    var fyStart = Config.get('FY_START_MONTH');
    return (x.getMonth() + 1) >= fyStart ? x.getFullYear() : x.getFullYear() - 1;
  },

  fiscalYearLabel: function (d) {
    var y = DateUtil.fiscalYear(d);
    return 'FY' + y + '-' + String((y + 1) % 100).replace(/^(\d)$/, '0$1');
  },

  startOfFiscalYear: function (d) {
    return new Date(DateUtil.fiscalYear(d), Config.get('FY_START_MONTH') - 1, 1);
  },

  /** Monday-anchored week start. */
  startOfWeek: function (d) {
    var x = DateUtil.startOfDay(d);
    var dow = (x.getDay() + 6) % 7; // Mon = 0
    return DateUtil.addDays(x, -dow);
  },

  /** Working days (Mon–Sat, the team's pattern) in the month containing d. */
  workingDaysInMonth: function (d) {
    var start = DateUtil.startOfMonth(d), end = DateUtil.endOfMonth(d), n = 0;
    for (var i = start.getDate(); i <= end.getDate(); i++) {
      var day = new Date(start.getFullYear(), start.getMonth(), i).getDay();
      if (day !== 0) n++; // Sunday off
    }
    return n;
  },

  /**
   * The window algebra. Every window is a half-open interval [start, end).
   *
   *   MTD    [1st of asOf's month, asOf + 1)      — includes the as-of day
   *   LMTD   [1st of prev month, same day prev month + 1)
   *   MONTH  [1st, 1st of next month)             — the full calendar month
   *   FYTD   [1 Apr of FY, asOf + 1)
   *
   * The workbook expressed MTD as `< TODAY()`; because our asOf is already
   * `TODAY() − lag`, the equivalent exclusive bound is `asOf + 1`. Both cover
   * the same days.
   */
  window: function (kind, refDate) {
    var asOf = DateUtil.startOfDay(refDate || DateUtil.asOf());
    switch (kind) {
      case 'MTD':
        return { kind: kind, start: DateUtil.startOfMonth(asOf), end: DateUtil.addDays(asOf, 1), asOf: asOf };
      case 'LMTD': {
        var prev = DateUtil.addMonths(DateUtil.startOfMonth(asOf), -1);
        var dim = DateUtil.daysInMonth(prev);
        var sameDay = new Date(prev.getFullYear(), prev.getMonth(), Math.min(asOf.getDate(), dim));
        return { kind: kind, start: prev, end: DateUtil.addDays(sameDay, 1), asOf: sameDay };
      }
      case 'MONTH':
        return { kind: kind, start: DateUtil.startOfMonth(asOf), end: DateUtil.startOfNextMonth(asOf), asOf: asOf };
      case 'PREV_MONTH': {
        var p = DateUtil.addMonths(DateUtil.startOfMonth(asOf), -1);
        return { kind: kind, start: p, end: DateUtil.startOfNextMonth(p), asOf: DateUtil.endOfMonth(p) };
      }
      case 'FYTD':
        return { kind: kind, start: DateUtil.startOfFiscalYear(asOf), end: DateUtil.addDays(asOf, 1), asOf: asOf };
      case 'WTD': {
        var ws = DateUtil.startOfWeek(asOf);
        return { kind: kind, start: ws, end: DateUtil.addDays(asOf, 1), asOf: asOf };
      }
      case 'TODAY':
        return { kind: kind, start: asOf, end: DateUtil.addDays(asOf, 1), asOf: asOf };
      default:
        fail('BAD_WINDOW', 'Unknown window kind: ' + kind);
    }
  },

  /** Explicit month window for a planning cycle. */
  cycleWindow: function (year, month, asOfDate) {
    var start = new Date(year, month - 1, 1);
    var monthEnd = new Date(year, month, 1);
    var asOf = DateUtil.startOfDay(asOfDate || DateUtil.asOf());
    // Clamp: a past cycle reports the full month; the live cycle reports MTD.
    var end = (asOf >= monthEnd) ? monthEnd
      : (asOf < start) ? start
        : DateUtil.addDays(asOf, 1);
    return { kind: 'CYCLE_MTD', start: start, end: end, monthEnd: monthEnd, asOf: asOf };
  },

  /** Same-window-last-month counterpart of a cycle window. */
  cycleLmtdWindow: function (year, month, asOfDate) {
    var w = DateUtil.cycleWindow(year, month, asOfDate);
    var prevStart = new Date(year, month - 2, 1);
    var elapsed = DateUtil.diffDays(w.start, w.end); // days covered by MTD
    var dim = DateUtil.daysInMonth(prevStart);
    var prevEnd = new Date(prevStart.getFullYear(), prevStart.getMonth(), Math.min(elapsed, dim) + 1);
    return { kind: 'CYCLE_LMTD', start: prevStart, end: prevEnd, asOf: DateUtil.addDays(prevEnd, -1) };
  },

  inWindow: function (d, w) {
    var x = DateUtil.startOfDay(d);
    if (!x || !w) return false;
    return x.getTime() >= w.start.getTime() && x.getTime() < w.end.getTime();
  },

  /** Elapsed days in the window — the DRR denominator. */
  elapsedDays: function (w) {
    return Math.max(1, DateUtil.diffDays(w.start, w.end));
  },

  /** Remaining days from the window's end to the end of its month. */
  remainingDays: function (w) {
    var monthEnd = w.monthEnd || DateUtil.startOfNextMonth(w.start);
    return Math.max(0, DateUtil.diffDays(w.end, monthEnd));
  }
};

Util.isoDate = DateUtil.isoDate;

// ---------------------------------------------------------------------------
// Formatting helpers shared with the client via bootstrap payloads
// ---------------------------------------------------------------------------

var Fmt = {
  pct: function (v, places) {
    if (v === null || v === undefined || !isFinite(v)) return '—';
    return Util.round(v * 100, places === undefined ? 1 : places) + '%';
  },
  cr: function (v) {
    if (v === null || v === undefined || !isFinite(v)) return '—';
    return '₹' + Util.round(v, 2) + ' Cr';
  },
  mt: function (v) {
    if (v === null || v === undefined || !isFinite(v)) return '—';
    return Util.round(v, 2) + ' MT';
  },
  count: function (v) { return String(Util.round(v, 0)); }
};

// ============================================================================
// 03_Repository.gs
// ============================================================================

/**
 * 03_Repository.gs — Sheets-backed data access layer.
 *
 * All sheet I/O funnels through here. The rest of the application deals only in
 * plain objects keyed by the schema column names, and never sees a range, a row
 * index or an A1 notation string.
 *
 * Performance model: one `getValues()` per table per execution, memoised for the
 * life of the request. Writes are batched — an upsert of 500 rows is a single
 * `setValues()`. A document lock serialises mutations so two concurrent POC
 * submissions cannot interleave a read-modify-write.
 */

var Repository = (function () {

  var memo_ = {};        // sheetName → array of row objects
  var ssCache_ = null;

  // -- Spreadsheet handle --------------------------------------------------

  function db() {
    if (ssCache_) return ssCache_;
    var id = PropertiesService.getScriptProperties().getProperty(PROP.DB_ID);
    if (id) {
      try {
        ssCache_ = SpreadsheetApp.openById(id);
        return ssCache_;
      } catch (e) {
        fail('DB_UNREACHABLE',
          'The configured backend spreadsheet could not be opened. Run Setup again.',
          { id: id, cause: String(e) });
      }
    }
    var active = SpreadsheetApp.getActiveSpreadsheet();
    if (active) {
      ssCache_ = active;
      PropertiesService.getScriptProperties().setProperty(PROP.DB_ID, active.getId());
      return ssCache_;
    }

    // Standalone deployment (not bound to a container spreadsheet) with
    // nothing configured yet: create a dedicated backend spreadsheet rather
    // than failing outright, so the in-app Setup wizard's "Run setup" button
    // works on first load with no editor visit. It is owned by whoever the
    // script executes as, so — unlike opening someone else's existing sheet
    // — this never runs into a sharing/permission wall.
    ssCache_ = SpreadsheetApp.create(APP.NAME + ' — Backend');
    PropertiesService.getScriptProperties().setProperty(PROP.DB_ID, ssCache_.getId());
    return ssCache_;
  }

  function sheet(name) {
    var sh = db().getSheetByName(name);
    if (!sh) fail('SHEET_MISSING', 'Backend sheet "' + name + '" does not exist. Run Setup.');
    return sh;
  }

  // -- Type coercion -------------------------------------------------------

  function toStore(value, col) {
    if (value === undefined || value === null) return '';
    switch (col.type) {
      case T.NUM: return value === '' ? '' : Util.num(value, 0);
      case T.BOOL: return Util.bool(value);
      case T.DATE: {
        var d = DateUtil.startOfDay(value);
        return d || '';
      }
      case T.DATETIME: {
        var dt = DateUtil.parse(value);
        return dt || '';
      }
      case T.JSON:
        if (typeof value === 'string') return value;
        try { return JSON.stringify(value); } catch (e) { return ''; }
      default:
        return typeof value === 'string' ? value : String(value);
    }
  }

  function fromStore(value, col) {
    switch (col.type) {
      case T.NUM: return value === '' || value === null ? null : Util.num(value, 0);
      case T.BOOL: return Util.bool(value);
      case T.DATE:
      case T.DATETIME: return DateUtil.parse(value);
      case T.JSON: {
        if (Util.isBlank(value)) return null;
        try { return JSON.parse(String(value)); } catch (e) { return null; }
      }
      default: return value === null || value === undefined ? '' : String(value).trim();
    }
  }

  // -- Read ----------------------------------------------------------------

  /**
   * Read an entire table as row objects. Each object carries a non-enumerable
   * `_row` (1-based physical row) so updates need no second lookup.
   */
  function readAll(sheetName, options) {
    options = options || {};
    if (!options.fresh && memo_[sheetName]) return memo_[sheetName];

    var def = schemaFor(sheetName);
    var sh = sheet(sheetName);
    var lastRow = sh.getLastRow();
    if (lastRow < 2) { memo_[sheetName] = []; return memo_[sheetName]; }

    var maxRows = Config.get('MAX_ROWS_PER_READ');
    var count = Math.min(lastRow - 1, maxRows);
    var values = sh.getRange(2, 1, count, def.cols.length).getValues();

    var out = new Array(values.length);
    var n = 0;
    for (var i = 0; i < values.length; i++) {
      var raw = values[i];
      // A blank primary key marks an unused row; the sheet is sparse-tolerant.
      if (raw[0] === '' || raw[0] === null) continue;
      var obj = {};
      for (var c = 0; c < def.cols.length; c++) obj[def.cols[c].name] = fromStore(raw[c], def.cols[c]);
      Object.defineProperty(obj, '_row', { value: i + 2, enumerable: false, writable: true });
      Object.defineProperty(obj, '_sheet', { value: sheetName, enumerable: false, writable: true });
      out[n++] = obj;
    }
    out.length = n;
    memo_[sheetName] = out;
    return out;
  }

  function find(sheetName, predicate) {
    var rows = readAll(sheetName);
    for (var i = 0; i < rows.length; i++) if (predicate(rows[i])) return rows[i];
    return null;
  }

  function findById(sheetName, id) {
    if (Util.isBlank(id)) return null;
    var pk = schemaFor(sheetName).pk;
    var target = String(id);
    return find(sheetName, function (r) { return String(r[pk]) === target; });
  }

  function filter(sheetName, predicate) {
    return readAll(sheetName).filter(predicate);
  }

  /**
   * Filter by an equality spec, e.g. {cycleId: 'CYC-…', active: true}.
   * `undefined` values in the spec are ignored, which keeps call sites clean.
   */
  function where(sheetName, spec) {
    var keys = Object.keys(spec || {}).filter(function (k) { return spec[k] !== undefined; });
    if (!keys.length) return readAll(sheetName);
    return readAll(sheetName).filter(function (r) {
      for (var i = 0; i < keys.length; i++) {
        var k = keys[i], want = spec[k], got = r[k];
        if (want instanceof Date) {
          if (!got || DateUtil.isoDate(got) !== DateUtil.isoDate(want)) return false;
        } else if (typeof want === 'boolean') {
          if (Util.bool(got) !== want) return false;
        } else if (String(got) !== String(want)) {
          return false;
        }
      }
      return true;
    });
  }

  // -- Write ---------------------------------------------------------------

  function rowValues_(def, obj) {
    return def.cols.map(function (c) { return toStore(obj[c.name], c); });
  }

  /**
   * Stamp the audit columns. Assignment is unconditional — `rowValues_` only
   * writes columns the schema declares, so a table without these columns simply
   * ignores them.
   */
  function stamp_(obj, isNew) {
    var now = new Date();
    var who = 'system';
    try { who = Auth.currentEmail() || 'system'; } catch (e) { who = 'system'; }
    if (isNew) {
      obj.createdAt = obj.createdAt || now;
      obj.createdBy = obj.createdBy || who;
    }
    obj.updatedAt = now;
    obj.updatedBy = who;
    return obj;
  }

  function insert(sheetName, obj) {
    return insertMany(sheetName, [obj])[0];
  }

  function insertMany(sheetName, objs) {
    if (!objs || !objs.length) return [];
    var def = schemaFor(sheetName);
    var sh = sheet(sheetName);
    var prepared = objs.map(function (o) {
      var row = {};
      def.cols.forEach(function (c) { row[c.name] = o[c.name]; });
      if (Util.isBlank(row[def.pk])) row[def.pk] = Id.next(pkPrefix_(sheetName));
      return stamp_(row, true);
    });
    var start = Math.max(sh.getLastRow() + 1, 2);
    sh.getRange(start, 1, prepared.length, def.cols.length)
      .setValues(prepared.map(function (o) { return rowValues_(def, o); }));
    invalidate(sheetName);
    return prepared;
  }

  function update(sheetName, id, patch) {
    var def = schemaFor(sheetName);
    var existing = findById(sheetName, id);
    if (!existing) fail('NOT_FOUND', sheetName + ' record ' + id + ' was not found.');
    var merged = {};
    def.cols.forEach(function (c) { merged[c.name] = existing[c.name]; });
    Object.keys(patch || {}).forEach(function (k) {
      if (k === def.pk) return;                   // primary keys are immutable
      if (k in merged) merged[k] = patch[k];
    });
    stamp_(merged, false);
    sheet(sheetName).getRange(existing._row, 1, 1, def.cols.length)
      .setValues([rowValues_(def, merged)]);
    invalidate(sheetName);
    return merged;
  }

  /** Insert or update on the primary key. */
  function upsert(sheetName, obj) {
    var pk = schemaFor(sheetName).pk;
    if (!Util.isBlank(obj[pk]) && findById(sheetName, obj[pk])) {
      return update(sheetName, obj[pk], obj);
    }
    return insert(sheetName, obj);
  }

  /**
   * Bulk upsert on the primary key — one read, one append and one contiguous
   * rewrite of the changed region. Used by the sync jobs, where thousands of
   * rows arrive at once and per-row writes would blow the execution budget.
   */
  function upsertMany(sheetName, objs) {
    if (!objs || !objs.length) return { inserted: 0, updated: 0 };
    var def = schemaFor(sheetName);
    var sh = sheet(sheetName);
    var existing = readAll(sheetName);
    var byId = {};
    existing.forEach(function (r) { byId[String(r[def.pk])] = r; });

    var updates = [], inserts = [];
    objs.forEach(function (o) {
      var id = Util.str(o[def.pk]);
      if (id && byId[id]) {
        var cur = byId[id];
        var merged = {};
        def.cols.forEach(function (c) {
          merged[c.name] = (o[c.name] === undefined) ? cur[c.name] : o[c.name];
        });
        stamp_(merged, false);
        merged._row = cur._row;
        updates.push(merged);
      } else {
        var row = {};
        def.cols.forEach(function (c) { row[c.name] = o[c.name]; });
        if (Util.isBlank(row[def.pk])) row[def.pk] = Id.next(pkPrefix_(sheetName));
        stamp_(row, true);
        inserts.push(row);
        byId[String(row[def.pk])] = row;
      }
    });

    // Contiguous runs keep setValues() calls to a minimum.
    if (updates.length) {
      updates.sort(function (a, b) { return a._row - b._row; });
      var runStart = 0;
      for (var i = 1; i <= updates.length; i++) {
        var breaks = (i === updates.length) || (updates[i]._row !== updates[i - 1]._row + 1);
        if (!breaks) continue;
        var run = updates.slice(runStart, i);
        sh.getRange(run[0]._row, 1, run.length, def.cols.length)
          .setValues(run.map(function (o) { return rowValues_(def, o); }));
        runStart = i;
      }
    }
    if (inserts.length) {
      var start = Math.max(sh.getLastRow() + 1, 2);
      var needed = start + inserts.length - 1;
      if (needed > sh.getMaxRows()) sh.insertRowsAfter(sh.getMaxRows(), needed - sh.getMaxRows() + 100);
      sh.getRange(start, 1, inserts.length, def.cols.length)
        .setValues(inserts.map(function (o) { return rowValues_(def, o); }));
    }
    invalidate(sheetName);
    return { inserted: inserts.length, updated: updates.length };
  }

  /**
   * Soft delete where the table has an `active` or `voided` flag; hard delete
   * otherwise. Operational history is never silently destroyed.
   */
  function remove(sheetName, id) {
    var def = schemaFor(sheetName);
    var names = def.cols.map(function (c) { return c.name; });
    if (names.indexOf('active') >= 0) return update(sheetName, id, { active: false });
    if (names.indexOf('voided') >= 0) return update(sheetName, id, { voided: true });
    var row = findById(sheetName, id);
    if (!row) fail('NOT_FOUND', sheetName + ' record ' + id + ' was not found.');
    sheet(sheetName).deleteRow(row._row);
    invalidate(sheetName);
    return { deleted: id };
  }

  function removeWhere(sheetName, predicate) {
    var rows = readAll(sheetName).filter(predicate);
    if (!rows.length) return 0;
    var sh = sheet(sheetName);
    // Delete bottom-up so earlier row indexes stay valid.
    rows.sort(function (a, b) { return b._row - a._row; })
      .forEach(function (r) { sh.deleteRow(r._row); });
    invalidate(sheetName);
    return rows.length;
  }

  function pkPrefix_(sheetName) {
    return sheetName.replace(/^DB_/, '').replace(/[^A-Za-z]/g, '').slice(0, 4).toUpperCase();
  }

  function invalidate(sheetName) {
    if (sheetName) delete memo_[sheetName]; else memo_ = {};
  }

  /**
   * Serialise a mutation across concurrent executions. Every write path that
   * does read-modify-write must run inside this.
   */
  function transaction(fn) {
    var lock = LockService.getDocumentLock();
    if (!lock.tryLock(20000)) {
      fail('BUSY', 'Another update is in progress. Please retry in a moment.');
    }
    try {
      invalidate();
      return fn();
    } finally {
      try { SpreadsheetApp.flush(); } catch (e) { /* nothing to flush */ }
      lock.releaseLock();
    }
  }

  return {
    db: db,
    sheet: sheet,
    readAll: readAll,
    find: find,
    findById: findById,
    filter: filter,
    where: where,
    insert: insert,
    insertMany: insertMany,
    update: update,
    upsert: upsert,
    upsertMany: upsertMany,
    remove: remove,
    removeWhere: removeWhere,
    invalidate: invalidate,
    transaction: transaction
  };
})();

// ============================================================================
// 03b_BusinessFunction.gs
// ============================================================================

/**
 * 03b_BusinessFunction.gs — The Business Function registry.
 *
 * Replaces the hardcoded Plastic/Metal CATEGORY enum as the source of truth for
 * what business functions exist and how each is calculated. The physical
 * `category` column is untouched — it stays the field name on all 18 tables that
 * already carry it — this registry only governs which values are valid today and
 * what each one means (its calculator, its stream shape, whether it plans an
 * account-level target).
 *
 * A LEGACY function's metrics are computed by hand-written code in 06_Engine.gs
 * (Plastic and Metal — unchanged). A GENERIC function's metrics are computed by
 * GenericEngine.metric() purely from DB_MetricDef rows — adding a function of
 * this kind is a configuration act, not a code change.
 */

var BusinessFunction = (function () {

  /**
   * Shipped defaults, used both to seed DB_BusinessFunctions on first run and as
   * a fallback before that seeding has happened (a fresh bootstrap, or a test
   * harness that reads the engine without running Bootstrap.setup() first) so
   * nothing downstream has to special-case "the table doesn't exist yet."
   */
  var DEFAULTS_ = Object.freeze([
    {
      businessFunctionId: CATEGORY.PLASTIC, name: 'OMP — Plastic',
      description: 'Plastic recycling materials marketplace — sellers and buyers.',
      icon: 'recycle', color: '#2f7a52', sequence: 1, active: true,
      calculatorMode: CALCULATOR_MODE.LEGACY, streamMode: STREAM_MODE.SUPPLY_DEMAND,
      streamLabels: { SUPPLY: 'Supply — Sellers', DEMAND: 'Demand — Buyers' },
      hasAccountPlan: true
    },
    {
      businessFunctionId: CATEGORY.METAL, name: 'OMP — Metal',
      description: 'Metal recycling materials marketplace — sellers and buyers.',
      icon: 'recycle', color: '#4a6a95', sequence: 2, active: true,
      calculatorMode: CALCULATOR_MODE.LEGACY, streamMode: STREAM_MODE.SUPPLY_DEMAND,
      streamLabels: { SUPPLY: 'Supply — Sellers', DEMAND: 'Demand — Buyers' },
      hasAccountPlan: true
    },
    {
      businessFunctionId: 'ONBOARDING', name: 'Onboarding',
      description: 'Partner and account onboarding operations.',
      icon: 'user-plus', color: '#7d5aa6', sequence: 3, active: true,
      calculatorMode: CALCULATOR_MODE.GENERIC, streamMode: STREAM_MODE.SINGLE,
      streamLabels: { GENERAL: 'Onboarding' },
      hasAccountPlan: false
    },
    {
      businessFunctionId: 'COLLECTIONS', name: 'Collections',
      description: 'Receivables follow-up and collection operations.',
      icon: 'wallet', color: '#a06a3f', sequence: 4, active: true,
      calculatorMode: CALCULATOR_MODE.GENERIC, streamMode: STREAM_MODE.SINGLE,
      streamLabels: { GENERAL: 'Collections' },
      hasAccountPlan: false
    }
  ]);

  var cache_ = null;

  /** Every row currently in the registry — DB rows if seeded, defaults otherwise. */
  function all() {
    if (cache_) return cache_;
    var rows;
    try { rows = Repository.readAll(SHEET.BUSINESS_FUNCTIONS); } catch (e) { rows = []; }
    cache_ = rows.length ? rows : DEFAULTS_;
    return cache_;
  }

  /** Active business functions, in display order — the normal read path. */
  function list() {
    return Util.sortBy(
      all().filter(function (r) { return r.active !== false; }),
      [{ pick: function (r) { return Util.num(r.sequence, 50); } }]
    );
  }

  /**
   * A single function's config, by code. Never throws: an unknown or
   * not-yet-seeded code degrades to a LEGACY-shaped default (matching the two
   * OMP categories' actual behavior today) rather than breaking a read.
   */
  function get(code) {
    var found = all().filter(function (r) { return r.businessFunctionId === code; })[0];
    if (found) return found;
    return {
      businessFunctionId: code, name: code, active: true,
      calculatorMode: CALCULATOR_MODE.LEGACY, streamMode: STREAM_MODE.SUPPLY_DEMAND,
      streamLabels: { SUPPLY: 'Supply', DEMAND: 'Demand' }, hasAccountPlan: true
    };
  }

  function codes() {
    return list().map(function (r) { return r.businessFunctionId; });
  }

  /** True when the function's metrics are computed by DB_MetricDef, not code. */
  function isGeneric(code) {
    return get(code).calculatorMode === CALCULATOR_MODE.GENERIC;
  }

  /** The stream keys a KRA may declare for this function. */
  function streamsFor(code) {
    var bf = get(code);
    return bf.streamMode === STREAM_MODE.SINGLE ? [STREAM.GENERAL] : [STREAM.SUPPLY, STREAM.DEMAND];
  }

  /**
   * Create or update a business function. Only ADMIN may configure the
   * platform's structure. New functions are always GENERIC — LEGACY is reserved
   * for the two OMP functions whose calculator is hand-written code, not
   * something an admin screen can grant.
   */
  function save(payload) {
    Auth.require(PERM.CONFIG_MANAGE);
    var code = Util.str(payload.businessFunctionId).toUpperCase();
    assert(!Util.isBlank(code), 'VALIDATION', 'A code is required.');
    assert(/^[A-Z][A-Z0-9_]*$/.test(code), 'VALIDATION',
      'The code must start with a letter and contain only letters, numbers and underscores.');
    assert(!Util.isBlank(payload.name), 'VALIDATION', 'A name is required.');

    var existing = Repository.findById(SHEET.BUSINESS_FUNCTIONS, code);
    var isNew = !existing;
    if (isNew) {
      assert(CATEGORIES.indexOf(code) < 0, 'VALIDATION',
        code + ' is reserved for an OMP category.');
    }

    var streamMode = payload.streamMode === STREAM_MODE.SUPPLY_DEMAND
      ? STREAM_MODE.SUPPLY_DEMAND : STREAM_MODE.SINGLE;
    var streamLabels = streamMode === STREAM_MODE.SUPPLY_DEMAND
      ? { SUPPLY: Util.str(payload.supplyLabel) || 'Supply', DEMAND: Util.str(payload.demandLabel) || 'Demand' }
      : { GENERAL: Util.str(payload.generalLabel) || Util.str(payload.name) };

    var row = {
      businessFunctionId: code,
      name: Util.str(payload.name),
      description: Util.str(payload.description),
      icon: Util.str(payload.icon) || 'briefcase',
      color: Util.str(payload.color) || '#4f6f8f',
      sequence: Util.num(payload.sequence, 50),
      active: payload.active === undefined ? true : !!payload.active,
      calculatorMode: existing ? existing.calculatorMode : CALCULATOR_MODE.GENERIC,
      streamMode: streamMode,
      streamLabels: streamLabels,
      hasAccountPlan: existing ? Util.bool(existing.hasAccountPlan) : false
    };
    var saved = Repository.upsert(SHEET.BUSINESS_FUNCTIONS, row);
    invalidate();
    Audit.log(isNew ? 'BUSINESS_FUNCTION_CREATE' : 'BUSINESS_FUNCTION_UPDATE',
      SHEET.BUSINESS_FUNCTIONS, saved.businessFunctionId, saved.name, existing || null, saved);
    return saved;
  }

  function invalidate() { cache_ = null; }

  return {
    all: all, list: list, get: get, codes: codes, isGeneric: isGeneric,
    streamsFor: streamsFor, save: save, invalidate: invalidate,
    DEFAULTS: DEFAULTS_
  };
})();

// ============================================================================
// 04_Auth.gs
// ============================================================================

/**
 * 04_Auth.gs — Identity, role-based access control and data scoping.
 *
 * Two distinct questions are answered here, and they must never be conflated:
 *
 *   can(permission)   — is this user allowed to perform this kind of action?
 *   scope(user)       — which rows may this user see or touch?
 *
 * A POC has ACTIVITY_WRITE, but their scope is their own POC key. A Regional
 * Head has the same permission with a wider scope. Every service applies both.
 */

var PERM = Object.freeze({
  // Planning
  CYCLE_MANAGE: 'CYCLE_MANAGE',
  KRA_MANAGE: 'KRA_MANAGE',
  ASSIGNMENT_MANAGE: 'ASSIGNMENT_MANAGE',
  PLAN_MANAGE: 'PLAN_MANAGE',
  PLAN_VIEW: 'PLAN_VIEW',
  // Execution
  ACTIVITY_WRITE: 'ACTIVITY_WRITE',
  ACTIVITY_WRITE_ANY: 'ACTIVITY_WRITE_ANY',
  ACTIVITY_VERIFY: 'ACTIVITY_VERIFY',
  ACTIVITY_VOID: 'ACTIVITY_VOID',
  PIPELINE_MANAGE: 'PIPELINE_MANAGE',
  // Measurement
  DASHBOARD_VIEW: 'DASHBOARD_VIEW',
  DASHBOARD_VIEW_ALL: 'DASHBOARD_VIEW_ALL',
  SCORECARD_VIEW_ALL: 'SCORECARD_VIEW_ALL',
  REPORT_EXPORT: 'REPORT_EXPORT',
  // Review
  REVIEW_MANAGE: 'REVIEW_MANAGE',
  REVIEW_ACKNOWLEDGE: 'REVIEW_ACKNOWLEDGE',
  ACTION_MANAGE: 'ACTION_MANAGE',
  ACTION_OWN: 'ACTION_OWN',
  // Administration
  USER_MANAGE: 'USER_MANAGE',
  CONFIG_MANAGE: 'CONFIG_MANAGE',
  SYNC_RUN: 'SYNC_RUN',
  AUDIT_VIEW: 'AUDIT_VIEW'
});

var ROLE_PERMISSIONS = Object.freeze({
  ADMIN: ['*'],

  LEADERSHIP: [
    PERM.PLAN_VIEW, PERM.DASHBOARD_VIEW, PERM.DASHBOARD_VIEW_ALL,
    PERM.SCORECARD_VIEW_ALL, PERM.REPORT_EXPORT, PERM.REVIEW_MANAGE,
    PERM.ACTION_MANAGE, PERM.AUDIT_VIEW, PERM.ACTIVITY_VERIFY
  ],

  TEAM_LEAD: [
    PERM.CYCLE_MANAGE, PERM.KRA_MANAGE, PERM.ASSIGNMENT_MANAGE,
    PERM.PLAN_MANAGE, PERM.PLAN_VIEW,
    PERM.ACTIVITY_WRITE, PERM.ACTIVITY_WRITE_ANY, PERM.ACTIVITY_VERIFY,
    PERM.ACTIVITY_VOID, PERM.PIPELINE_MANAGE,
    PERM.DASHBOARD_VIEW, PERM.DASHBOARD_VIEW_ALL, PERM.SCORECARD_VIEW_ALL,
    PERM.REPORT_EXPORT, PERM.REVIEW_MANAGE, PERM.ACTION_MANAGE,
    PERM.SYNC_RUN, PERM.AUDIT_VIEW
  ],

  RH: [
    PERM.PLAN_MANAGE, PERM.PLAN_VIEW,
    PERM.ACTIVITY_WRITE, PERM.ACTIVITY_WRITE_ANY, PERM.ACTIVITY_VERIFY,
    PERM.PIPELINE_MANAGE,
    PERM.DASHBOARD_VIEW, PERM.SCORECARD_VIEW_ALL, PERM.REPORT_EXPORT,
    PERM.REVIEW_MANAGE, PERM.ACTION_MANAGE
  ],

  POC: [
    PERM.PLAN_VIEW, PERM.ACTIVITY_WRITE, PERM.PIPELINE_MANAGE,
    PERM.DASHBOARD_VIEW, PERM.REVIEW_ACKNOWLEDGE, PERM.ACTION_OWN
  ],

  VIEWER: [PERM.PLAN_VIEW, PERM.DASHBOARD_VIEW]
});

var Auth = (function () {

  var user_ = null;

  function currentEmail() {
    var e = '';
    try { e = Session.getActiveUser().getEmail() || ''; } catch (x) { e = ''; }
    if (!e) {
      try { e = Session.getEffectiveUser().getEmail() || ''; } catch (x2) { e = ''; }
    }
    return String(e).trim().toLowerCase();
  }

  /**
   * Resolve the signed-in Google account to a DB_Users row.
   * The very first sign-in on an empty user table is promoted to ADMIN so the
   * platform can be configured; every later account must be provisioned.
   */
  function current() {
    if (user_) return user_;
    var email = currentEmail();
    if (!email) {
      fail('NO_IDENTITY',
        'Your Google identity could not be determined. Open the application from your work account.');
    }

    var users = Repository.readAll(SHEET.USERS);
    var match = null;
    for (var i = 0; i < users.length; i++) {
      if (String(users[i].email || '').toLowerCase() === email) { match = users[i]; break; }
    }

    if (!match) {
      var bootstrapAdmin = PropertiesService.getScriptProperties()
        .getProperty(PROP.BOOTSTRAP_ADMIN);
      var noUsersYet = users.filter(function (u) { return u.active !== false; }).length === 0;
      if (noUsersYet || (bootstrapAdmin && bootstrapAdmin.toLowerCase() === email)) {
        match = Repository.insert(SHEET.USERS, {
          email: email,
          fullName: email.split('@')[0],
          role: ROLE.ADMIN,
          category: 'ALL',
          stream: 'BOTH',
          active: true
        });
        Audit.log('USER_BOOTSTRAP', SHEET.USERS, match.userId,
          'First administrator provisioned automatically', null, { email: email });
      } else {
        fail('NOT_PROVISIONED',
          'Your account (' + email + ') has not been granted access to ' + APP.NAME +
          '. Ask your Team Lead to add you under Administration → Users.');
      }
    }

    if (match.active === false) {
      fail('ACCOUNT_DISABLED', 'Your access to ' + APP.NAME + ' has been disabled.');
    }

    user_ = decorate_(match);
    return user_;
  }

  function decorate_(row) {
    var perms = ROLE_PERMISSIONS[row.role] || [];
    var region = row.regionId ? Repository.findById(SHEET.REGIONS, row.regionId) : null;
    return {
      userId: row.userId,
      email: row.email,
      fullName: row.fullName || row.email,
      employeeCode: row.employeeCode || '',
      role: row.role,
      roleRank: ROLE_RANK[row.role] || 0,
      category: row.category || 'ALL',
      regionId: row.regionId || '',
      regionName: region ? region.regionName : '',
      stream: row.stream || 'BOTH',
      reportsTo: row.reportsTo || '',
      aliases: String(row.aliases || '').split('|').map(function (s) { return s.trim(); })
        .filter(function (s) { return s; }),
      permissions: perms.indexOf('*') >= 0 ? Object.keys(PERM) : perms
    };
  }

  function can(permission, user) {
    var u = user || current();
    if (u.role === ROLE.ADMIN) return true;
    return u.permissions.indexOf(permission) >= 0;
  }

  function require(permission, user) {
    var u = user || current();
    if (!can(permission, u)) {
      fail('FORBIDDEN',
        'Your role (' + u.role + ') does not permit this action.',
        { permission: permission });
    }
    return u;
  }

  /**
   * The data scope a user may read.
   *   level: ALL | REGION | SELF
   *   categories: which business categories are visible
   *   pocUserIds: null when unrestricted, otherwise the allowed POC set
   */
  function scope(user) {
    var u = user || current();
    var categories = (u.category === 'ALL' || !u.category) ? CATEGORIES.slice() : [u.category];

    if (u.role === ROLE.ADMIN || u.role === ROLE.LEADERSHIP || u.role === ROLE.TEAM_LEAD) {
      return { level: 'ALL', categories: categories, regionIds: null, pocUserIds: null, user: u };
    }
    if (u.role === ROLE.RH) {
      var members = Repository.where(SHEET.USERS, { regionId: u.regionId })
        .filter(function (r) { return r.active !== false; })
        .map(function (r) { return r.userId; });
      if (members.indexOf(u.userId) < 0) members.push(u.userId);
      return {
        level: 'REGION', categories: categories,
        regionIds: [u.regionId], pocUserIds: members, user: u
      };
    }
    if (u.role === ROLE.VIEWER) {
      return {
        level: 'REGION', categories: categories,
        regionIds: u.regionId ? [u.regionId] : null, pocUserIds: null, user: u
      };
    }
    return {
      level: 'SELF', categories: categories,
      regionIds: u.regionId ? [u.regionId] : null, pocUserIds: [u.userId], user: u
    };
  }

  /** True when `sc` permits reading rows owned by `pocUserId` in `category`. */
  function inScope(sc, pocUserId, category, regionId) {
    if (category && sc.categories.indexOf(category) < 0) return false;
    if (sc.regionIds && regionId && sc.regionIds.indexOf(regionId) < 0) return false;
    if (sc.pocUserIds && pocUserId && sc.pocUserIds.indexOf(pocUserId) < 0) return false;
    return true;
  }

  /** Guard for writes: a POC may only write rows they own. */
  function requireOwnership(pocUserId, user) {
    var u = user || current();
    if (can(PERM.ACTIVITY_WRITE_ANY, u)) return u;
    if (String(pocUserId) !== String(u.userId)) {
      fail('FORBIDDEN', 'You may only record work against your own name.');
    }
    return u;
  }

  function reset() { user_ = null; }

  return {
    currentEmail: currentEmail,
    current: current,
    can: can,
    require: require,
    scope: scope,
    inScope: inScope,
    requireOwnership: requireOwnership,
    reset: reset
  };
})();

/**
 * Audit trail. Every mutation records who, when, what and the before/after
 * state. Reads are not logged; writes always are, including failures.
 */
var Audit = (function () {

  function log(action, entity, entityId, summary, before, after, success, errorMessage) {
    try {
      var u = null;
      try { u = Auth.current(); } catch (e) { u = null; }
      Repository.insert(SHEET.AUDIT, {
        auditId: Id.next('AUD'),
        timestamp: new Date(),
        userEmail: u ? u.email : Auth.currentEmail(),
        userId: u ? u.userId : '',
        role: u ? u.role : '',
        action: action,
        entity: entity || '',
        entityId: entityId || '',
        summary: Util.truncate(summary || '', 400),
        before: before ? Util.truncate(JSON.stringify(before), 3000) : '',
        after: after ? Util.truncate(JSON.stringify(after), 3000) : '',
        success: success === undefined ? true : !!success,
        errorMessage: errorMessage || ''
      });
    } catch (e) {
      // Auditing must never break the operation it is recording.
      console.error('Audit failure: ' + e);
    }
  }

  /** Wrap a mutation so success and failure are both recorded. */
  function around(action, entity, entityId, summary, fn) {
    try {
      var result = fn();
      var id = entityId;
      if (!id && result && typeof result === 'object') {
        var def = SCHEMA[entity];
        if (def) id = result[def.pk];
      }
      log(action, entity, id, summary, null, result, true);
      return result;
    } catch (e) {
      log(action, entity, entityId, summary, null, null, false, String(e && e.message || e));
      throw e;
    }
  }

  function recent(limit, filterSpec) {
    Auth.require(PERM.AUDIT_VIEW);
    var rows = Repository.readAll(SHEET.AUDIT);
    if (filterSpec) {
      rows = rows.filter(function (r) {
        if (filterSpec.entity && r.entity !== filterSpec.entity) return false;
        if (filterSpec.entityId && r.entityId !== filterSpec.entityId) return false;
        if (filterSpec.userEmail && r.userEmail !== filterSpec.userEmail) return false;
        return true;
      });
    }
    return Util.sortBy(rows, [{ pick: function (r) { return r.timestamp; }, dir: 'desc' }])
      .slice(0, limit || 200);
  }

  return { log: log, around: around, recent: recent };
})();

// ============================================================================
// 05_Bootstrap.gs
// ============================================================================

/**
 * 05_Bootstrap.gs — Database creation, migration and seeding.
 *
 * `Bootstrap.setup()` is idempotent: run it on a blank spreadsheet to create the
 * schema, or on an existing one to migrate it forward. It never drops a column
 * and never deletes data; new columns are appended and back-filled with blanks.
 *
 * Seeding installs the KRA/KPI library exactly as defined in the source
 * workbook's `🎯 OMP-Supply & Demand KRA & KPI` sheet, including weightages,
 * the five target bands and the direction of each KPI.
 */

var Bootstrap = (function () {

  var HEADER_BG = '#0f2f4f';
  var HEADER_FG = '#ffffff';

  // -- Schema ---------------------------------------------------------------

  function setup(options) {
    options = options || {};
    var ss = Repository.db();
    var created = [], migrated = [];

    SCHEMA_ORDER.forEach(function (name) {
      var def = schemaFor(name);
      var sh = ss.getSheetByName(name);
      if (!sh) {
        sh = ss.insertSheet(name);
        writeHeader_(sh, def);
        created.push(name);
      } else if (migrateSheet_(sh, def)) {
        migrated.push(name);
      }
      styleSheet_(sh, def);
    });

    PropertiesService.getScriptProperties()
      .setProperty(PROP.SCHEMA_VERSION, String(APP.SCHEMA_VERSION));
    PropertiesService.getScriptProperties().setProperty(PROP.DB_ID, ss.getId());

    Repository.invalidate();
    Config.invalidate();

    seedConfig_();
    if (options.seedReference !== false) {
      seedBusinessFunctions_();
      seedRegions_();
      seedActivityTypeDefs_();
      seedMetricDefs_();
      seedKraLibrary_();
    }

    Audit.log('BOOTSTRAP_SETUP', 'SCHEMA', String(APP.SCHEMA_VERSION),
      'Created ' + created.length + ', migrated ' + migrated.length + ' sheets',
      null, { created: created, migrated: migrated });

    return {
      spreadsheetId: ss.getId(),
      spreadsheetUrl: ss.getUrl(),
      schemaVersion: APP.SCHEMA_VERSION,
      created: created,
      migrated: migrated
    };
  }

  function writeHeader_(sh, def) {
    var headers = def.cols.map(function (c) { return c.name; });
    sh.getRange(1, 1, 1, headers.length).setValues([headers]);
  }

  /**
   * Forward-only migration: append any column present in the schema but absent
   * from the sheet, preserving existing column positions and data.
   */
  function migrateSheet_(sh, def) {
    var width = Math.max(sh.getLastColumn(), 1);
    var existing = sh.getRange(1, 1, 1, width).getValues()[0]
      .map(function (h) { return String(h || '').trim(); });
    var wanted = def.cols.map(function (c) { return c.name; });

    var missing = wanted.filter(function (w) { return existing.indexOf(w) < 0; });
    if (!missing.length && existing.length >= wanted.length) return false;

    if (sh.getMaxColumns() < wanted.length) {
      sh.insertColumnsAfter(sh.getMaxColumns(), wanted.length - sh.getMaxColumns());
    }
    // Only rewrite the header row; column order in SCHEMA is append-only, so
    // positions of pre-existing columns are unchanged.
    sh.getRange(1, 1, 1, wanted.length).setValues([wanted]);
    return true;
  }

  function styleSheet_(sh, def) {
    var n = def.cols.length;
    var header = sh.getRange(1, 1, 1, n);
    header.setBackground(HEADER_BG).setFontColor(HEADER_FG).setFontWeight('bold')
      .setVerticalAlignment('middle').setWrap(false);
    sh.setFrozenRows(1);
    sh.setRowHeight(1, 30);
    def.cols.forEach(function (c, i) {
      try { sh.setColumnWidth(i + 1, c.width || defaultWidth_(c.type)); } catch (e) { /* best effort */ }
      if (c.type === T.DATE) {
        sh.getRange(2, i + 1, Math.max(sh.getMaxRows() - 1, 1), 1).setNumberFormat('yyyy-mm-dd');
      } else if (c.type === T.DATETIME) {
        sh.getRange(2, i + 1, Math.max(sh.getMaxRows() - 1, 1), 1).setNumberFormat('yyyy-mm-dd hh:mm:ss');
      }
    });
    // Protect the header from accidental edits by operators browsing the backend.
    try {
      var existing = sh.getProtections(SpreadsheetApp.ProtectionType.RANGE);
      var already = existing.some(function (p) { return p.getDescription() === 'schema-header'; });
      if (!already) {
        sh.getRange(1, 1, 1, n).protect()
          .setDescription('schema-header')
          .setWarningOnly(true);
      }
    } catch (e) { /* protections unavailable in some contexts */ }
  }

  function defaultWidth_(type) {
    switch (type) {
      case T.NUM: return 110;
      case T.BOOL: return 90;
      case T.DATE: return 110;
      case T.DATETIME: return 160;
      case T.JSON: return 260;
      default: return 160;
    }
  }

  // -- Seeds ----------------------------------------------------------------

  function seedConfig_() {
    var existing = Repository.readAll(SHEET.CONFIG);
    if (existing.length) return { skipped: true };
    var descriptions = {
      FY_START_MONTH: 'First month of the fiscal year (4 = April).',
      REPORTING_LAG_DAYS: 'Dashboards report through today minus this many days.',
      GMV_BASIS: 'TAXABLE (ex-GST, recommended) or TOTAL (incl. GST, legacy FYTD basis).',
      RATE_GST_DIVISOR: 'Set to 1.18 to reproduce the legacy realised-rate calculation.',
      ACHIEVEMENT_CAP: 'Maximum achievement credited towards the weighted score.',
      REQUIRE_WEIGHTAGE_100: 'Block cycle publish unless each stream sums to 100.',
      EXISTING_TXN_TARGET_PCT: 'Share of onboarded accounts expected to transact.',
      NEW_TXN_TARGET_PCT: 'Share of newly onboarded accounts expected to transact same month.',
      RETENTION_TARGET_PCT: 'Share of last month\'s transacting accounts expected to repeat.',
      PULSE_VISITS_PER_DAY: 'Field visits expected per working day per POC.',
      PULSE_DEDUCT_LEAVE: 'Reduce the pulse target by recorded leave days.',
      DORMANCY_DAYS: 'Days without a listing or transaction before an account is dormant.',
      PACE_WARN_RATIO: 'Current DRR ÷ required DRR below this shows as At Risk.'
    };
    var rows = Object.keys(CONFIG_DEFAULTS).map(function (k) {
      return {
        key: k,
        value: String(CONFIG_DEFAULTS[k]),
        description: descriptions[k] || '',
        updatedAt: new Date(),
        updatedBy: 'bootstrap'
      };
    });
    Repository.insertMany(SHEET.CONFIG, rows);
    Config.invalidate();
    return { inserted: rows.length };
  }

  /**
   * Regions observed in the source workbook, plus an explicit unassigned
   * bucket, cross-multiplied across every business function. Skips per
   * function so a function added after initial setup still gets seeded.
   */
  function seedRegions_() {
    var existingByCode = Util.groupBy(Repository.readAll(SHEET.REGIONS), function (r) { return r.category; });
    var seed = [
      { regionName: 'North', sequence: 1 },
      { regionName: 'South', sequence: 2 },
      { regionName: 'East', sequence: 3 },
      { regionName: 'West', sequence: 4 },
      { regionName: 'North East', sequence: 5 },
      { regionName: 'Unassigned', sequence: 99 }
    ];
    var rows = [];
    BusinessFunction.codes().forEach(function (code) {
      if (existingByCode[code] && existingByCode[code].length) return;
      seed.forEach(function (r) {
        rows.push({
          regionId: Id.natural('RGN', code, r.regionName),
          regionName: r.regionName,
          category: code,
          active: true,
          sequence: r.sequence,
          createdAt: new Date()
        });
      });
    });
    if (rows.length) Repository.insertMany(SHEET.REGIONS, rows);
    return { inserted: rows.length };
  }

  /**
   * The KRA/KPI library for a business function — the template a Team Lead
   * clones into each new cycle (`cycleId` is blank on library rows). LEGACY
   * functions (OMP) get their exact historical content, unchanged. GENERIC
   * functions get starter content that exercises every aggregation kind the
   * generic engine supports; a genuinely new (5th+) function with no library
   * here starts from an empty list — a Team Lead builds it from scratch via
   * the existing "Add KRA" flow in Planning, no seed required.
   */
  function kraLibraryFor(code) {
    if (BusinessFunction.get(code).calculatorMode === CALCULATOR_MODE.LEGACY) return omKraLibrary_();
    if (code === 'ONBOARDING') return onboardingKraLibrary_();
    if (code === 'COLLECTIONS') return collectionsKraLibrary_();
    return [];
  }

  /** Backward-compatible alias — the OMP library, unqualified by category. */
  function kraLibrary() { return omKraLibrary_(); }

  /** The KRA/KPI library, transcribed from the workbook. Unchanged. */
  function omKraLibrary_() {
    return [
      // ---- SUPPLY (seller side) — weights sum to 100 -----------------------
      {
        stream: STREAM.SUPPLY, perspective: 'Sales',
        kraName: 'Transaction from Existing Sellers',
        sourceOfTracking: 'Monthly MIS Report', sequence: 1,
        kpis: [{
          kpiName: 'Existing Seller Transactions',
          definition: '50% of total onboarded sellers should transact in the current month.',
          weightage: 15, unitOfMeasure: 'Percentage',
          metricKey: 'EXISTING_SELLER_TXN', direction: DIRECTION.HIGHER_BETTER,
          targetBasis: TARGET_BASIS.PCT_OF_METRIC,
          basisMetric: 'ONBOARDED_SELLERS_FYTD', basisPct: 0.50,
          targets: [0.6, 0.75, 0.9, 1.0, 1.05], sequence: 1
        }]
      },
      {
        stream: STREAM.SUPPLY, perspective: 'Sales',
        kraName: 'Transaction from New Onboarded Sellers',
        sourceOfTracking: 'Monthly MIS Report', sequence: 2,
        kpis: [{
          kpiName: 'New Seller Transactions',
          definition: '20% of sellers onboarded this month should transact in the same month.',
          weightage: 15, unitOfMeasure: 'Percentage',
          metricKey: 'NEW_SELLER_TXN', direction: DIRECTION.HIGHER_BETTER,
          targetBasis: TARGET_BASIS.PCT_OF_METRIC,
          basisMetric: 'SELLER_ONBOARDED', basisPct: 0.20,
          targets: [0.6, 0.75, 0.9, 1.0, 1.05], sequence: 1
        }]
      },
      {
        stream: STREAM.SUPPLY, perspective: 'Sales',
        kraName: 'New Seller Acquisition',
        sourceOfTracking: 'Monthly MIS Report', sequence: 3,
        kpis: [{
          kpiName: 'Sellers Onboarded',
          definition: 'As per monthly target.',
          weightage: 15, unitOfMeasure: 'Percentage',
          metricKey: 'SELLER_ONBOARDED', direction: DIRECTION.HIGHER_BETTER,
          targetBasis: TARGET_BASIS.BALANCE_PLUS_MTD,
          targets: [0.6, 0.75, 0.9, 1.0, 1.05], sequence: 1
        }]
      },
      {
        stream: STREAM.SUPPLY, perspective: 'Sales',
        kraName: 'GMV',
        sourceOfTracking: 'Monthly MIS Report', sequence: 4,
        kpis: [{
          kpiName: 'Supply GMV (₹ Cr)',
          definition: 'As per monthly target.',
          weightage: 40, unitOfMeasure: 'Percentage',
          metricKey: 'GMV_CR', direction: DIRECTION.HIGHER_BETTER,
          targetBasis: TARGET_BASIS.ACCOUNT_PLAN,
          targets: [0.6, 0.75, 0.9, 1.0, 1.05], sequence: 1
        }]
      },
      {
        stream: STREAM.SUPPLY, perspective: 'Sales',
        kraName: 'Retention of Existing Transacted Sellers',
        sourceOfTracking: 'Monthly MIS Report', sequence: 5,
        kpis: [{
          kpiName: 'Seller Retention',
          definition: '70% of the sellers who transacted in the previous month should transact again during the current month.',
          weightage: 15, unitOfMeasure: 'Percentage',
          metricKey: 'SELLER_RETENTION', direction: DIRECTION.HIGHER_BETTER,
          targetBasis: TARGET_BASIS.PCT_OF_METRIC,
          basisMetric: 'PREV_MONTH_TRANSACTING_SELLERS', basisPct: 0.70,
          targets: [0.6, 0.75, 0.9, 1.0, 1.05], sequence: 1
        }]
      },

      // ---- DEMAND (buyer side) — weights sum to 100 ------------------------
      {
        stream: STREAM.DEMAND, perspective: 'Sales',
        kraName: 'Transaction from Existing Buyers',
        sourceOfTracking: 'Monthly MIS Report', sequence: 1,
        kpis: [{
          kpiName: 'Existing Buyer Transactions',
          definition: '50% of onboarded buyers should transact in the current month.',
          weightage: 15, unitOfMeasure: 'Percentage',
          metricKey: 'EXISTING_BUYER_TXN', direction: DIRECTION.HIGHER_BETTER,
          targetBasis: TARGET_BASIS.PCT_OF_METRIC,
          basisMetric: 'ONBOARDED_BUYERS_FYTD', basisPct: 0.50,
          targets: [0.6, 0.75, 0.9, 1.0, 1.05], sequence: 1
        }]
      },
      {
        stream: STREAM.DEMAND, perspective: 'Scale',
        kraName: 'Transaction from New Onboarded Buyers',
        sourceOfTracking: 'Monthly MIS Report', sequence: 2,
        kpis: [{
          kpiName: 'New Buyer Transactions',
          definition: '20% of buyers onboarded in the current month should transact in the same month.',
          weightage: 15, unitOfMeasure: 'Percentage',
          metricKey: 'NEW_BUYER_TXN', direction: DIRECTION.HIGHER_BETTER,
          targetBasis: TARGET_BASIS.PCT_OF_METRIC,
          basisMetric: 'BUYER_ONBOARDED', basisPct: 0.20,
          targets: [0.6, 0.75, 0.9, 1.0, 1.05], sequence: 1
        }]
      },
      {
        stream: STREAM.DEMAND, perspective: 'Customer',
        kraName: 'New Buyer Acquisition',
        sourceOfTracking: 'Monthly MIS Report', sequence: 3,
        kpis: [{
          kpiName: 'Buyers Onboarded',
          definition: 'As per monthly target.',
          weightage: 15, unitOfMeasure: 'Percentage',
          metricKey: 'BUYER_ONBOARDED', direction: DIRECTION.HIGHER_BETTER,
          targetBasis: TARGET_BASIS.BALANCE_PLUS_MTD,
          targets: [0.6, 0.75, 0.9, 1.0, 1.05], sequence: 1
        }]
      },
      {
        stream: STREAM.DEMAND, perspective: 'Process',
        kraName: 'GMV',
        sourceOfTracking: 'Monthly MIS Report', sequence: 4,
        kpis: [{
          kpiName: 'Demand GMV (₹ Cr)',
          definition: 'As per monthly target.',
          weightage: 30, unitOfMeasure: 'Percentage',
          metricKey: 'GMV_CR', direction: DIRECTION.HIGHER_BETTER,
          targetBasis: TARGET_BASIS.ACCOUNT_PLAN,
          targets: [0.6, 0.75, 0.9, 1.0, 1.05], sequence: 1
        }]
      },
      {
        stream: STREAM.DEMAND, perspective: 'Customer',
        kraName: 'DN % of GMV',
        sourceOfTracking: 'Monthly MIS Report', sequence: 5,
        kpis: [{
          kpiName: 'Debit Note as % of GMV',
          definition: "DN should be 1% of the buyer's current-month GMV.",
          weightage: 10, unitOfMeasure: 'Percentage',
          metricKey: 'DN_PCT_OF_GMV', direction: DIRECTION.LOWER_BETTER,
          targetBasis: TARGET_BASIS.MANUAL,
          // Bands descend: 1.3% is the worst acceptable, 0.6% is best.
          targets: [0.013, 0.012, 0.01, 0.008, 0.006], sequence: 1
        }]
      },
      {
        stream: STREAM.DEMAND, perspective: 'Process',
        kraName: 'DSO Days',
        sourceOfTracking: 'Monthly MIS Report', sequence: 6,
        kpis: [{
          kpiName: 'Days Sales Outstanding',
          definition: '(Average Receivables ÷ GMV) × Number of Days in the Month.',
          weightage: 15, unitOfMeasure: 'Days',
          metricKey: 'DSO_DAYS', direction: DIRECTION.LOWER_BETTER,
          targetBasis: TARGET_BASIS.MANUAL,
          targets: [15, 10, 5, 3, 2], sequence: 1
        }]
      }
    ];
  }

  /**
   * Onboarding — starter KRA/KPI content proving COUNT, SUM-backed RATIO and
   * MANUAL/RATE_PER_DAY target bases all work with zero engine code. Single
   * stream (GENERAL); weights sum to 100. A Team Lead edits or replaces this
   * exactly as they would an OMP KRA — nothing here is special-cased.
   */
  function onboardingKraLibrary_() {
    return [
      {
        stream: STREAM.GENERAL, perspective: 'Scale',
        kraName: 'Onboarding Volume', sourceOfTracking: 'Activity Log', sequence: 1,
        kpis: [{
          kpiName: 'Onboardings Completed',
          definition: 'Applications approved and onboarded this month, against the monthly target.',
          weightage: 40, unitOfMeasure: 'Count',
          metricKey: 'ONBOARDINGS_APPROVED', direction: DIRECTION.HIGHER_BETTER,
          targetBasis: TARGET_BASIS.MANUAL,
          targets: [6, 8, 9, 10, 11], sequence: 1
        }]
      },
      {
        stream: STREAM.GENERAL, perspective: 'Process',
        kraName: 'Onboarding Quality', sourceOfTracking: 'Activity Log', sequence: 2,
        kpis: [{
          kpiName: 'Approval Rate %',
          definition: 'Share of received applications that were approved and onboarded.',
          weightage: 30, unitOfMeasure: 'Percentage',
          metricKey: 'APPROVAL_RATE_PCT', direction: DIRECTION.HIGHER_BETTER,
          targetBasis: TARGET_BASIS.MANUAL,
          targets: [60, 70, 80, 85, 90], sequence: 1
        }]
      },
      {
        stream: STREAM.GENERAL, perspective: 'Customer',
        kraName: 'Turnaround Time', sourceOfTracking: 'Activity Log', sequence: 3,
        kpis: [{
          kpiName: 'Average Onboarding TAT (Days)',
          definition: 'Average days from application received to onboarding approval.',
          weightage: 30, unitOfMeasure: 'Days',
          metricKey: 'AVG_TAT_DAYS', direction: DIRECTION.LOWER_BETTER,
          targetBasis: TARGET_BASIS.MANUAL,
          targets: [10, 8, 6, 5, 4], sequence: 1
        }]
      }
    ];
  }

  /**
   * Collections — starter KRA/KPI content, additionally exercising the
   * RATE_PER_DAY target basis (follow-ups expected per working day). Single
   * stream (GENERAL); weights sum to 100.
   */
  function collectionsKraLibrary_() {
    return [
      {
        stream: STREAM.GENERAL, perspective: 'Sales',
        kraName: 'Collection Efficiency', sourceOfTracking: 'Activity Log', sequence: 1,
        kpis: [{
          kpiName: 'Amount Collected (₹)',
          definition: 'Payments collected this month, against the monthly target.',
          weightage: 40, unitOfMeasure: 'INR',
          metricKey: 'AMOUNT_COLLECTED_INR', direction: DIRECTION.HIGHER_BETTER,
          targetBasis: TARGET_BASIS.MANUAL,
          targets: [300000, 400000, 450000, 500000, 550000], sequence: 1
        }]
      },
      {
        stream: STREAM.GENERAL, perspective: 'Process',
        kraName: 'Collection Outreach', sourceOfTracking: 'Activity Log', sequence: 2,
        kpis: [{
          kpiName: 'Follow-ups Completed',
          definition: 'Two follow-up calls per working day per POC.',
          weightage: 30, unitOfMeasure: 'Count',
          metricKey: 'FOLLOW_UPS_MADE', direction: DIRECTION.HIGHER_BETTER,
          targetBasis: TARGET_BASIS.RATE_PER_DAY, basisPct: 2,
          targets: [0.6, 0.75, 0.9, 1.0, 1.05], sequence: 1
        }]
      },
      {
        stream: STREAM.GENERAL, perspective: 'Customer',
        kraName: 'Dispute Management', sourceOfTracking: 'Activity Log', sequence: 3,
        kpis: [{
          kpiName: 'Dispute Resolution Rate %',
          definition: 'Share of logged disputes resolved and closed this month.',
          weightage: 30, unitOfMeasure: 'Percentage',
          metricKey: 'DISPUTE_RESOLUTION_RATE_PCT', direction: DIRECTION.HIGHER_BETTER,
          targetBasis: TARGET_BASIS.MANUAL,
          targets: [60, 70, 80, 90, 95], sequence: 1
        }]
      }
    ];
  }

  /**
   * Install the library as template rows (cycleId = 'LIBRARY'). Cloning a
   * library KRA into a cycle copies the row and rewrites cycleId. Skips
   * per-function, not globally, so seeding a new function later (Onboarding,
   * Collections, or a 5th) never gets blocked by OMP's library already existing.
   */
  function seedKraLibrary_() {
    var existingByCode = Util.groupBy(
      Repository.where(SHEET.KRA, { cycleId: 'LIBRARY' }),
      function (r) { return r.category; }
    );
    var kraRows = [], kpiRows = [];
    BusinessFunction.codes().forEach(function (code) {
      if (existingByCode[code] && existingByCode[code].length) return;
      kraLibraryFor(code).forEach(function (k) {
        var kraId = Id.natural('KRA', 'LIB', code, k.stream, k.kraName);
        kraRows.push({
          kraId: kraId, cycleId: 'LIBRARY', category: code, stream: k.stream,
          perspective: k.perspective, kraName: k.kraName,
          sourceOfTracking: k.sourceOfTracking, sequence: k.sequence,
          active: true, createdAt: new Date(), createdBy: 'bootstrap'
        });
        k.kpis.forEach(function (p) {
          kpiRows.push({
            kpiId: Id.natural('KPI', 'LIB', code, k.stream, p.kpiName),
            kraId: kraId, cycleId: 'LIBRARY',
            kpiName: p.kpiName, definition: p.definition,
            weightage: p.weightage, unitOfMeasure: p.unitOfMeasure,
            metricKey: p.metricKey, direction: p.direction,
            targetBasis: p.targetBasis,
            basisMetric: p.basisMetric || '', basisPct: p.basisPct === undefined ? null : p.basisPct,
            target1: p.targets[0], target2: p.targets[1], target3: p.targets[2],
            target4: p.targets[3], target5: p.targets[4],
            sequence: p.sequence, active: true,
            createdAt: new Date(), createdBy: 'bootstrap'
          });
        });
      });
    });
    if (kraRows.length) Repository.insertMany(SHEET.KRA, kraRows);
    if (kpiRows.length) Repository.insertMany(SHEET.KPI, kpiRows);
    return { kras: kraRows.length, kpis: kpiRows.length };
  }

  /** The Business Function registry itself — seeded once, per code. */
  function seedBusinessFunctions_() {
    var existingCodes = Repository.readAll(SHEET.BUSINESS_FUNCTIONS)
      .map(function (r) { return r.businessFunctionId; });
    var rows = BusinessFunction.DEFAULTS
      .filter(function (d) { return existingCodes.indexOf(d.businessFunctionId) < 0; })
      .map(function (d) {
        return {
          businessFunctionId: d.businessFunctionId, name: d.name, description: d.description,
          icon: d.icon, color: d.color, sequence: d.sequence, active: d.active,
          calculatorMode: d.calculatorMode, streamMode: d.streamMode, streamLabels: d.streamLabels,
          hasAccountPlan: d.hasAccountPlan, createdAt: new Date(), createdBy: 'bootstrap'
        };
      });
    if (rows.length) Repository.insertMany(SHEET.BUSINESS_FUNCTIONS, rows);
    BusinessFunction.invalidate();
    return { inserted: rows.length };
  }

  /** Declarative activity taxonomy for Onboarding and Collections. */
  function onboardingActivityTypes_() {
    var bf = 'ONBOARDING';
    return [
      { activityTypeId: 'APPLICATION_RECEIVED', businessFunctionId: bf, label: 'Application Received',
        icon: 'inbox', measures: [], requiresAccount: false, evidence: 'NONE', sequence: 1,
        help: 'A new onboarding application received.' },
      { activityTypeId: 'DOCUMENT_VERIFIED', businessFunctionId: bf, label: 'Document Verified',
        icon: 'file', measures: [], requiresAccount: false, evidence: 'OPTIONAL', sequence: 2,
        help: 'A required document was checked and verified.' },
      { activityTypeId: 'ONBOARDING_APPROVED', businessFunctionId: bf, label: 'Onboarding Approved',
        icon: 'check', measures: [{ key: 'tatDays', label: 'Turnaround Time', unit: 'days', column: 'measureA' }],
        requiresAccount: false, evidence: 'REQUIRED', sequence: 3,
        help: 'Onboarding approved and activated. Record the days from application to approval.' },
      { activityTypeId: 'ONBOARDING_REJECTED', businessFunctionId: bf, label: 'Onboarding Rejected',
        icon: 'x', measures: [], requiresAccount: false, evidence: 'REQUIRED', sequence: 4,
        help: 'Application rejected — record the reason in remarks.' },
      { activityTypeId: 'ONBOARDING_FOLLOW_UP', businessFunctionId: bf, label: 'Follow-up',
        icon: 'phone', measures: [], requiresAccount: false, evidence: 'OPTIONAL', sequence: 5,
        help: 'A call, message or meeting to move an application forward.' }
    ];
  }

  function collectionsActivityTypes_() {
    var bf = 'COLLECTIONS';
    return [
      { activityTypeId: 'PAYMENT_RECEIVED', businessFunctionId: bf, label: 'Payment Received',
        icon: 'rupee', measures: [{ key: 'amount', label: 'Amount Collected', unit: '₹', column: 'measureA' }],
        requiresAccount: false, evidence: 'REQUIRED', sequence: 1,
        help: 'A payment received from a debtor account.' },
      { activityTypeId: 'FOLLOW_UP_CALL', businessFunctionId: bf, label: 'Follow-up Call',
        icon: 'phone', measures: [], requiresAccount: false, evidence: 'OPTIONAL', sequence: 2,
        help: 'A call made to a debtor to request payment.' },
      { activityTypeId: 'REMINDER_SENT', businessFunctionId: bf, label: 'Reminder Sent',
        icon: 'mail', measures: [], requiresAccount: false, evidence: 'OPTIONAL', sequence: 3,
        help: 'A payment reminder sent — email, message or notice.' },
      { activityTypeId: 'DISPUTE_LOGGED', businessFunctionId: bf, label: 'Dispute Logged',
        icon: 'alert', measures: [], requiresAccount: false, evidence: 'REQUIRED', sequence: 4,
        help: 'A payment dispute raised by the debtor, logged for resolution.' },
      { activityTypeId: 'DISPUTE_RESOLVED', businessFunctionId: bf, label: 'Dispute Resolved',
        icon: 'check', measures: [], requiresAccount: false, evidence: 'REQUIRED', sequence: 5,
        help: 'A logged dispute resolved and closed.' }
    ];
  }

  function seedActivityTypeDefs_() {
    var existingIds = Repository.readAll(SHEET.ACTIVITY_TYPE_DEF).map(function (r) { return r.activityTypeId; });
    var defs = onboardingActivityTypes_().concat(collectionsActivityTypes_());
    var rows = defs
      .filter(function (d) { return existingIds.indexOf(d.activityTypeId) < 0; })
      .map(function (d) {
        return {
          activityTypeId: d.activityTypeId, businessFunctionId: d.businessFunctionId,
          label: d.label, icon: d.icon, measures: d.measures, requiresAccount: d.requiresAccount,
          evidence: d.evidence, systemOwned: false, sequence: d.sequence, active: true, help: d.help,
          createdAt: new Date(), createdBy: 'bootstrap'
        };
      });
    if (rows.length) Repository.insertMany(SHEET.ACTIVITY_TYPE_DEF, rows);
    ActivityTypeDef.invalidate();
    return { inserted: rows.length };
  }

  /** Declarative metric registry for Onboarding and Collections. */
  function onboardingMetricDefs_() {
    var bf = 'ONBOARDING';
    return [
      { metricKey: 'APPLICATIONS_RECEIVED', businessFunctionId: bf, label: 'Applications Received',
        unit: 'COUNT', direction: DIRECTION.HIGHER_BETTER, aggregation: AGGREGATION.COUNT,
        sourceActivityType: 'APPLICATION_RECEIVED' },
      { metricKey: 'DOCS_VERIFIED', businessFunctionId: bf, label: 'Documents Verified',
        unit: 'COUNT', direction: DIRECTION.HIGHER_BETTER, aggregation: AGGREGATION.COUNT,
        sourceActivityType: 'DOCUMENT_VERIFIED' },
      { metricKey: 'ONBOARDINGS_APPROVED', businessFunctionId: bf, label: 'Onboardings Approved',
        unit: 'COUNT', direction: DIRECTION.HIGHER_BETTER, aggregation: AGGREGATION.COUNT,
        sourceActivityType: 'ONBOARDING_APPROVED' },
      { metricKey: 'ONBOARDINGS_REJECTED', businessFunctionId: bf, label: 'Onboardings Rejected',
        unit: 'COUNT', direction: DIRECTION.LOWER_BETTER, aggregation: AGGREGATION.COUNT,
        sourceActivityType: 'ONBOARDING_REJECTED' },
      { metricKey: 'TOTAL_TAT_DAYS', businessFunctionId: bf, label: 'Total Turnaround Days',
        unit: 'DAYS', direction: DIRECTION.LOWER_BETTER, aggregation: AGGREGATION.SUM,
        sourceActivityType: 'ONBOARDING_APPROVED', measureField: 'measureA' },
      { metricKey: 'AVG_TAT_DAYS', businessFunctionId: bf, label: 'Average Turnaround (Days)',
        unit: 'DAYS', direction: DIRECTION.LOWER_BETTER, aggregation: AGGREGATION.RATIO,
        numeratorMetric: 'TOTAL_TAT_DAYS', denominatorMetric: 'ONBOARDINGS_APPROVED', multiplier: 1 },
      { metricKey: 'APPROVAL_RATE_PCT', businessFunctionId: bf, label: 'Approval Rate %',
        unit: 'PCT', direction: DIRECTION.HIGHER_BETTER, aggregation: AGGREGATION.RATIO,
        numeratorMetric: 'ONBOARDINGS_APPROVED', denominatorMetric: 'APPLICATIONS_RECEIVED', multiplier: 100 }
    ];
  }

  function collectionsMetricDefs_() {
    var bf = 'COLLECTIONS';
    return [
      { metricKey: 'AMOUNT_COLLECTED_INR', businessFunctionId: bf, label: 'Amount Collected',
        unit: 'INR', direction: DIRECTION.HIGHER_BETTER, aggregation: AGGREGATION.SUM,
        sourceActivityType: 'PAYMENT_RECEIVED', measureField: 'measureA' },
      { metricKey: 'FOLLOW_UPS_MADE', businessFunctionId: bf, label: 'Follow-ups Made',
        unit: 'COUNT', direction: DIRECTION.HIGHER_BETTER, aggregation: AGGREGATION.COUNT,
        sourceActivityType: 'FOLLOW_UP_CALL' },
      { metricKey: 'REMINDERS_SENT', businessFunctionId: bf, label: 'Reminders Sent',
        unit: 'COUNT', direction: DIRECTION.HIGHER_BETTER, aggregation: AGGREGATION.COUNT,
        sourceActivityType: 'REMINDER_SENT' },
      { metricKey: 'DISPUTES_LOGGED', businessFunctionId: bf, label: 'Disputes Logged',
        unit: 'COUNT', direction: DIRECTION.LOWER_BETTER, aggregation: AGGREGATION.COUNT,
        sourceActivityType: 'DISPUTE_LOGGED' },
      { metricKey: 'DISPUTES_RESOLVED', businessFunctionId: bf, label: 'Disputes Resolved',
        unit: 'COUNT', direction: DIRECTION.HIGHER_BETTER, aggregation: AGGREGATION.COUNT,
        sourceActivityType: 'DISPUTE_RESOLVED' },
      { metricKey: 'DISPUTE_RESOLUTION_RATE_PCT', businessFunctionId: bf, label: 'Dispute Resolution Rate %',
        unit: 'PCT', direction: DIRECTION.HIGHER_BETTER, aggregation: AGGREGATION.RATIO,
        numeratorMetric: 'DISPUTES_RESOLVED', denominatorMetric: 'DISPUTES_LOGGED', multiplier: 100 }
    ];
  }

  function seedMetricDefs_() {
    var existingKeys = Repository.readAll(SHEET.METRIC_DEF).map(function (r) { return r.metricKey; });
    var defs = onboardingMetricDefs_().concat(collectionsMetricDefs_());
    var rows = defs
      .filter(function (d) { return existingKeys.indexOf(d.metricKey) < 0; })
      .map(function (d) {
        return {
          metricKey: d.metricKey, businessFunctionId: d.businessFunctionId, label: d.label,
          unit: d.unit, direction: d.direction, aggregation: d.aggregation,
          sourceActivityType: d.sourceActivityType || '', measureField: d.measureField || '',
          numeratorMetric: d.numeratorMetric || '', denominatorMetric: d.denominatorMetric || '',
          multiplier: d.multiplier === undefined ? 1 : d.multiplier, expression: d.expression || '',
          active: true, createdAt: new Date(), createdBy: 'bootstrap'
        };
      });
    if (rows.length) Repository.insertMany(SHEET.METRIC_DEF, rows);
    MetricDef.invalidate();
    return { inserted: rows.length };
  }

  // -- Health ---------------------------------------------------------------

  function health() {
    var ss;
    try { ss = Repository.db(); } catch (e) {
      return { ok: false, reason: String(e.message || e) };
    }
    var missing = SCHEMA_ORDER.filter(function (n) { return !ss.getSheetByName(n); });
    var counts = {};
    SCHEMA_ORDER.forEach(function (n) {
      if (missing.indexOf(n) >= 0) return;
      try { counts[n] = Repository.readAll(n).length; } catch (e) { counts[n] = -1; }
    });
    var stored = PropertiesService.getScriptProperties().getProperty(PROP.SCHEMA_VERSION);
    return {
      ok: missing.length === 0,
      spreadsheetId: ss.getId(),
      spreadsheetUrl: ss.getUrl(),
      schemaVersion: APP.SCHEMA_VERSION,
      installedVersion: stored ? Number(stored) : null,
      needsMigration: !stored || Number(stored) < APP.SCHEMA_VERSION,
      missingSheets: missing,
      rowCounts: counts
    };
  }

  /** Install the time-driven jobs that keep dashboards fresh. */
  function installTriggers() {
    Auth.require(PERM.CONFIG_MANAGE);
    var wanted = [
      { fn: 'jobNightlySync', hour: 2 },
      { fn: 'jobDailySnapshot', hour: 6 },
      { fn: 'jobDailyAlerts', hour: 8 }
    ];
    var existing = ScriptApp.getProjectTriggers();
    existing.forEach(function (t) {
      if (wanted.some(function (w) { return w.fn === t.getHandlerFunction(); })) {
        ScriptApp.deleteTrigger(t);
      }
    });
    wanted.forEach(function (w) {
      ScriptApp.newTrigger(w.fn).timeBased().atHour(w.hour).everyDays(1)
        .inTimezone(APP.TIMEZONE).create();
    });
    Audit.log('TRIGGERS_INSTALLED', 'SCHEMA', '', wanted.map(function (w) { return w.fn; }).join(', '));
    return { installed: wanted.map(function (w) { return w.fn; }) };
  }

  return {
    setup: setup,
    health: health,
    kraLibrary: kraLibrary,
    kraLibraryFor: kraLibraryFor,
    installTriggers: installTriggers,
    seedConfig: seedConfig_,
    seedBusinessFunctions: seedBusinessFunctions_,
    seedRegions: seedRegions_,
    seedActivityTypeDefs: seedActivityTypeDefs_,
    seedMetricDefs: seedMetricDefs_,
    seedKraLibrary: seedKraLibrary_
  };
})();

// ============================================================================
// 06_Engine.gs
// ============================================================================

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
   *
   * Dispatches on the owning business function's calculator: LEGACY routes to
   * the hand-written switch below (legacyMetric_ — OMP, unchanged); GENERIC
   * routes to GenericEngine.metric(), which interprets a DB_MetricDef row. This
   * is the one seam that lets a new business function compute its own metrics
   * from configuration alone.
   */
  function metric(metricKey, window, sc, options) {
    if (BusinessFunction.isGeneric(sc.category)) {
      var def = MetricDef.get(metricKey);
      if (!def) fail('UNKNOWN_METRIC', 'No calculation is defined for metric "' + metricKey + '".');
      return GenericEngine.metric(def, window, sc, options);
    }
    return legacyMetric_(metricKey, window, sc, options);
  }

  function legacyMetric_(metricKey, window, sc, options) {
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
        var gmvInrForDn = legacyMetric_('GMV_CR', window, sc, { trace: false }).value *
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
        var gmvInrForDso = legacyMetric_('GMV_CR', window, sc, { trace: false }).value *
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
      accountName: a.accountName || a.subjectName || '', gstin: a.gstin,
      pocUserId: a.pocUserId, regionId: a.regionId,
      quantityMT: a.quantityMT, amountINR: a.amountINR, count: a.count,
      measureA: a.measureA, measureB: a.measureB, measureC: a.measureC,
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
          detail: Fmt.pct(pct, 0) + ' of ' + Metrics.label(kpi.basisMetric) +
            ' (' + Util.round(base.value, 2) + ')',
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
    accountPlansFor: accountPlansFor_,
    // Exposed for GenericEngine (06b_GenericEngine.gs), which reuses the same
    // scope-matching and traceability-payload logic for GENERIC business
    // functions rather than duplicating it.
    rowInScope: rowInScope_,
    activityTrace: activityTrace_
  };
})();

// ============================================================================
// 06b_GenericEngine.gs
// ============================================================================

/**
 * 06b_GenericEngine.gs — Declarative metric calculator for GENERIC business
 * functions.
 *
 * Where 06_Engine.gs hand-computes each OMP metric in a switch statement, this
 * file *interprets* a DB_MetricDef row. A business function on this path
 * (BusinessFunction.isGeneric(code) === true — Onboarding and Collections today)
 * never needs a line of engine code for a new metric: only a new DB_MetricDef
 * row, authored through the Admin UI or seeded once at bootstrap. This is what
 * makes onboarding a fifth business function later a configuration act.
 *
 * Supported aggregations, each a pure function of (metricDef, window, scope):
 *   COUNT           number of DB_Activities rows of a given activityType
 *   SUM             Σ of a measure field (count | measureA | measureB | measureC)
 *   DISTINCT_COUNT  distinct values of a row field among matching rows
 *   RATIO           numeratorMetric ÷ denominatorMetric × multiplier, both
 *                   resolved recursively through Engine.metric() — so a ratio
 *                   may reference a LEGACY metric too (e.g. a Collections KPI
 *                   expressed against an OMP figure)
 *   DERIVED         a small arithmetic expression over other metric keys
 *
 * Every branch returns the same { key, value, count, contributors, meta } shape
 * the legacy engine returns, reusing its activityTrace_ payload builder
 * (exposed as Engine.activityTrace), so drill-down works identically regardless
 * of which engine produced the number.
 */

// =============================================================================
// Declarative activity-type registry (config-only analog of ACTIVITY_TYPES)
// =============================================================================

var ActivityTypeDef = (function () {
  var cache_ = null;

  function all() {
    if (cache_) return cache_;
    try {
      cache_ = Repository.readAll(SHEET.ACTIVITY_TYPE_DEF).filter(function (r) { return r.active !== false; });
    } catch (e) {
      cache_ = [];
    }
    return cache_;
  }

  function forFunction(businessFunctionId) {
    return Util.sortBy(
      all().filter(function (r) { return r.businessFunctionId === businessFunctionId; }),
      [{ pick: function (r) { return Util.num(r.sequence, 50); } }]
    );
  }

  function get(activityTypeId) {
    return all().filter(function (r) { return r.activityTypeId === activityTypeId; })[0] || null;
  }

  /** Coerce a stored row into the same shape a static ACTIVITY_TYPES entry has. */
  function toDef(row) {
    var measures = row.measures;
    if (typeof measures === 'string') {
      try { measures = JSON.parse(measures); } catch (e) { measures = []; }
    }
    return {
      key: row.activityTypeId,
      label: row.label,
      icon: row.icon || 'circle',
      stream: STREAM.GENERAL,
      businessFunctionId: row.businessFunctionId,
      metrics: [],
      measures: measures || [],
      requiresAccount: Util.bool(row.requiresAccount),
      evidence: row.evidence || 'NONE',
      systemOwned: Util.bool(row.systemOwned),
      help: row.help || ''
    };
  }

  function save(payload) {
    Auth.require(PERM.CONFIG_MANAGE);
    assert(!Util.isBlank(payload.businessFunctionId), 'VALIDATION', 'Choose a business function.');
    assert(BusinessFunction.isGeneric(payload.businessFunctionId), 'VALIDATION',
      'Activity types can only be authored for a GENERIC business function.');
    assert(!Util.isBlank(payload.label), 'VALIDATION', 'A label is required.');

    var key = Util.str(payload.activityTypeId).toUpperCase() ||
      Id.natural('AT', payload.businessFunctionId, payload.label);
    assert(/^[A-Z][A-Z0-9_]*$/.test(key), 'VALIDATION',
      'The activity type key must start with a letter and contain only letters, numbers and underscores.');
    assert(!ACTIVITY_TYPES.some(function (t) { return t.key === key; }), 'VALIDATION',
      key + ' collides with a built-in OMP activity type key.');

    var measures = payload.measures;
    if (typeof measures === 'string') { try { measures = JSON.parse(measures); } catch (e) { measures = []; } }
    measures = (measures || []).filter(function (m) { return m && m.key; }).map(function (m) {
      return {
        key: m.key, label: Util.str(m.label) || m.key, unit: Util.str(m.unit),
        column: ['count', 'measureA', 'measureB', 'measureC'].indexOf(m.column) >= 0 ? m.column : 'measureA',
        default: m.default === undefined ? undefined : Util.num(m.default, undefined)
      };
    });

    var row = {
      activityTypeId: key,
      businessFunctionId: payload.businessFunctionId,
      label: Util.str(payload.label),
      icon: Util.str(payload.icon) || 'circle',
      measures: measures,
      requiresAccount: !!payload.requiresAccount,
      evidence: ['NONE', 'OPTIONAL', 'REQUIRED'].indexOf(payload.evidence) >= 0 ? payload.evidence : 'NONE',
      systemOwned: false,
      sequence: Util.num(payload.sequence, 50),
      active: payload.active === undefined ? true : !!payload.active,
      help: Util.str(payload.help)
    };
    var saved = Repository.upsert(SHEET.ACTIVITY_TYPE_DEF, row);
    invalidate();
    Audit.log(payload.activityTypeId ? 'ACTIVITY_TYPE_DEF_UPDATE' : 'ACTIVITY_TYPE_DEF_CREATE',
      SHEET.ACTIVITY_TYPE_DEF, saved.activityTypeId, saved.label, null, saved);
    return saved;
  }

  function invalidate() { cache_ = null; }

  return { all: all, forFunction: forFunction, get: get, toDef: toDef, save: save, invalidate: invalidate };
})();

// =============================================================================
// Declarative metric registry (config-only analog of METRICS)
// =============================================================================

var MetricDef = (function () {
  var cache_ = null;

  function all() {
    if (cache_) return cache_;
    try {
      cache_ = Repository.readAll(SHEET.METRIC_DEF).filter(function (r) { return r.active !== false; });
    } catch (e) {
      cache_ = [];
    }
    return cache_;
  }

  function forFunction(businessFunctionId) {
    return all().filter(function (r) { return r.businessFunctionId === businessFunctionId; });
  }

  function get(metricKey) {
    return all().filter(function (r) { return r.metricKey === metricKey; })[0] || null;
  }

  function exists(metricKey) { return !!get(metricKey); }

  function save(payload) {
    Auth.require(PERM.CONFIG_MANAGE);
    assert(!Util.isBlank(payload.businessFunctionId), 'VALIDATION', 'Choose a business function.');
    assert(BusinessFunction.isGeneric(payload.businessFunctionId), 'VALIDATION',
      'Metrics can only be authored for a GENERIC business function.');
    assert(!Util.isBlank(payload.label), 'VALIDATION', 'A label is required.');
    assert(Object.keys(AGGREGATION).indexOf(payload.aggregation) >= 0, 'VALIDATION',
      'Choose how this metric is aggregated.');

    var key = Util.str(payload.metricKey).toUpperCase() ||
      Id.natural('MET', payload.businessFunctionId, payload.label);
    assert(/^[A-Z][A-Z0-9_]*$/.test(key), 'VALIDATION',
      'The metric key must start with a letter and contain only letters, numbers and underscores.');
    assert(!(key in METRICS), 'VALIDATION', key + ' collides with a built-in OMP metric key.');

    if (payload.aggregation === AGGREGATION.COUNT || payload.aggregation === AGGREGATION.SUM ||
      payload.aggregation === AGGREGATION.DISTINCT_COUNT) {
      assert(!Util.isBlank(payload.sourceActivityType), 'VALIDATION',
        'Choose the activity type this metric counts or sums.');
    }
    if (payload.aggregation === AGGREGATION.RATIO) {
      assert(!Util.isBlank(payload.numeratorMetric) && !Util.isBlank(payload.denominatorMetric), 'VALIDATION',
        'A ratio metric needs both a numerator and a denominator metric.');
    }
    if (payload.aggregation === AGGREGATION.DERIVED) {
      assert(!Util.isBlank(payload.expression), 'VALIDATION', 'A derived metric needs an expression.');
      GenericEngine.validateExpression(payload.expression); // throws BAD_EXPRESSION on a malformed formula
    }

    var row = {
      metricKey: key,
      businessFunctionId: payload.businessFunctionId,
      label: Util.str(payload.label),
      unit: Util.str(payload.unit) || 'COUNT',
      direction: Object.keys(DIRECTION).indexOf(payload.direction) >= 0 ? payload.direction : DIRECTION.HIGHER_BETTER,
      aggregation: payload.aggregation,
      sourceActivityType: Util.str(payload.sourceActivityType),
      measureField: Util.str(payload.measureField),
      numeratorMetric: Util.str(payload.numeratorMetric),
      denominatorMetric: Util.str(payload.denominatorMetric),
      multiplier: payload.multiplier === '' || payload.multiplier === undefined ? 1 : Util.num(payload.multiplier, 1),
      expression: Util.str(payload.expression),
      active: payload.active === undefined ? true : !!payload.active
    };
    var saved = Repository.upsert(SHEET.METRIC_DEF, row);
    invalidate();
    Audit.log(payload.metricKey ? 'METRIC_DEF_UPDATE' : 'METRIC_DEF_CREATE',
      SHEET.METRIC_DEF, saved.metricKey, saved.label, null, saved);
    return saved;
  }

  function invalidate() { cache_ = null; }

  return { all: all, forFunction: forFunction, get: get, exists: exists, save: save, invalidate: invalidate };
})();

// =============================================================================
// Merged metric reference (static METRICS ∪ DB_MetricDef) — used by Planning
// validation and the client's KPI metric picker.
// =============================================================================

var Metrics = (function () {
  function exists(key) { return !!METRICS[key] || MetricDef.exists(key); }

  function label(key) {
    if (METRICS[key]) return METRICS[key].label;
    var d = MetricDef.get(key);
    return d ? d.label : key;
  }

  function unit(key) {
    if (METRICS[key]) return METRICS[key].unit;
    var d = MetricDef.get(key);
    return d ? d.unit : '';
  }

  function direction(key) {
    if (METRICS[key]) return METRICS[key].direction || DIRECTION.HIGHER_BETTER;
    var d = MetricDef.get(key);
    return (d && d.direction) || DIRECTION.HIGHER_BETTER;
  }

  function registry() {
    var out = Object.keys(METRICS).map(function (k) {
      return {
        key: k, label: METRICS[k].label, unit: METRICS[k].unit,
        stream: METRICS[k].stream || 'BOTH',
        direction: METRICS[k].direction || DIRECTION.HIGHER_BETTER
      };
    });
    MetricDef.all().forEach(function (m) {
      out.push({
        key: m.metricKey, label: m.label, unit: m.unit, stream: STREAM.GENERAL,
        direction: m.direction || DIRECTION.HIGHER_BETTER,
        businessFunctionId: m.businessFunctionId
      });
    });
    return out;
  }

  return { exists: exists, label: label, unit: unit, direction: direction, registry: registry };
})();

// =============================================================================
// The generic calculator
// =============================================================================

var GenericEngine = (function () {

  var MAX_METRIC_DEPTH = 6;

  function metric(def, window, sc, options, depth) {
    options = options || {};
    depth = depth || 0;
    assert(depth < MAX_METRIC_DEPTH, 'METRIC_CYCLE',
      'Metric "' + def.metricKey + '" is defined in terms of itself — check its RATIO/DERIVED configuration.');

    var trace = options.trace !== false;
    var out = { key: def.metricKey, value: 0, count: 0, contributors: [] };

    switch (def.aggregation) {
      case AGGREGATION.COUNT: return countMetric_(def, window, sc, trace, out);
      case AGGREGATION.SUM: return sumMetric_(def, window, sc, trace, out);
      case AGGREGATION.DISTINCT_COUNT: return distinctCountMetric_(def, window, sc, trace, out);
      case AGGREGATION.RATIO: return ratioMetric_(def, window, sc, options, out, depth);
      case AGGREGATION.DERIVED: return derivedMetric_(def, window, sc, options, out, depth);
      default:
        fail('BAD_METRIC_DEF', 'Metric "' + def.metricKey + '" has an unrecognised aggregation "' + def.aggregation + '".');
    }
  }

  function activityRows_(def, window, sc) {
    return Repository.readAll(SHEET.ACTIVITIES).filter(function (a) {
      if (a.voided) return false;
      if (a.category !== sc.category) return false;
      if (a.activityType !== def.sourceActivityType) return false;
      if (!DateUtil.inWindow(a.activityDate, window)) return false;
      return Engine.rowInScope(a, sc);
    });
  }

  function countMetric_(def, window, sc, trace, out) {
    var rows = activityRows_(def, window, sc);
    out.value = rows.length;
    out.count = rows.length;
    out.contributors = trace ? rows.map(Engine.activityTrace) : [];
    return out;
  }

  function sumMetric_(def, window, sc, trace, out) {
    var rows = activityRows_(def, window, sc);
    var field = def.measureField || 'count';
    var total = 0;
    rows.forEach(function (a) { total += Util.num(a[field], 0); });
    out.value = total;
    out.count = rows.length;
    out.contributors = trace ? rows.map(Engine.activityTrace) : [];
    return out;
  }

  function distinctCountMetric_(def, window, sc, trace, out) {
    var rows = activityRows_(def, window, sc);
    var field = def.measureField || 'pocUserId';
    var seen = {}, unique = [];
    rows.forEach(function (a) {
      var k = Util.key(a[field]);
      if (!k || seen[k]) return;
      seen[k] = 1;
      unique.push(a);
    });
    out.value = unique.length;
    out.count = unique.length;
    out.contributors = trace ? unique.map(Engine.activityTrace) : [];
    return out;
  }

  function ratioMetric_(def, window, sc, options, out, depth) {
    var num = resolveMetric_(def.numeratorMetric, window, sc, options, depth + 1);
    var den = resolveMetric_(def.denominatorMetric, window, sc, options, depth + 1);
    var multiplier = (def.multiplier === '' || def.multiplier === null || def.multiplier === undefined)
      ? 1 : Util.num(def.multiplier, 1);
    out.value = Util.div(num.value, den.value, 0) * multiplier;
    out.count = num.count;
    out.contributors = num.contributors;
    out.meta = {
      numerator: { key: def.numeratorMetric, value: num.value },
      denominator: { key: def.denominatorMetric, value: den.value }
    };
    return out;
  }

  function derivedMetric_(def, window, sc, options, out, depth) {
    var refs = referencedKeys_(def.expression);
    var values = {};
    refs.forEach(function (key) {
      values[key] = resolveMetric_(key, window, sc, options, depth + 1).value;
    });
    out.value = evalExpr_(def.expression, values);
    out.meta = { expression: def.expression, values: values };
    return out;
  }

  /** Resolve any metric key through the same dispatcher Engine.metric() uses. */
  function resolveMetric_(metricKey, window, sc, options, depth) {
    assert(!Util.isBlank(metricKey), 'BAD_METRIC_DEF', 'A RATIO/DERIVED metric is missing a referenced metric key.');
    var def = MetricDef.get(metricKey);
    if (def) return metric(def, window, sc, options, depth);
    // A generic metric may legitimately reference a LEGACY (OMP) metric.
    return Engine.metric(metricKey, window, sc, options);
  }

  // -- A small, safe arithmetic evaluator for DERIVED metrics ---------------
  // Grammar: expr := term (('+'|'-') term)* ; term := factor (('*'|'/') factor)*
  //          factor := NUMBER | IDENT | '(' expr ')' | '-' factor
  // No eval()/Function() — admin-authored expressions are parsed, not executed.

  function referencedKeys_(expression) {
    var m = String(expression || '').match(/[A-Za-z_][A-Za-z0-9_]*/g) || [];
    return Util.unique(m);
  }

  function tokenize_(expression) {
    var s = String(expression || '');
    var re = /\s*(\d+(?:\.\d+)?|[A-Za-z_][A-Za-z0-9_]*|[+\-*/()])/g;
    var tokens = [], m, i = 0;
    while ((m = re.exec(s))) {
      if (m.index !== i) fail('BAD_EXPRESSION', 'Unrecognised character near "' + s.slice(i) + '" in: ' + s);
      tokens.push(m[1]);
      i = re.lastIndex;
    }
    if (i !== s.length) fail('BAD_EXPRESSION', 'Unrecognised character near "' + s.slice(i) + '" in: ' + s);
    assert(tokens.length > 0, 'BAD_EXPRESSION', 'Expression is empty.');
    return tokens;
  }

  function parseExpr_(tokens, pos, values) {
    var v = parseTerm_(tokens, pos, values);
    while (tokens[pos.i] === '+' || tokens[pos.i] === '-') {
      var op = tokens[pos.i++];
      var rhs = parseTerm_(tokens, pos, values);
      v = op === '+' ? v + rhs : v - rhs;
    }
    return v;
  }

  function parseTerm_(tokens, pos, values) {
    var v = parseFactor_(tokens, pos, values);
    while (tokens[pos.i] === '*' || tokens[pos.i] === '/') {
      var op = tokens[pos.i++];
      var rhs = parseFactor_(tokens, pos, values);
      v = op === '*' ? v * rhs : Util.div(v, rhs, 0);
    }
    return v;
  }

  function parseFactor_(tokens, pos, values) {
    var t = tokens[pos.i];
    assert(t !== undefined, 'BAD_EXPRESSION', 'Expression ended unexpectedly.');
    if (t === '(') {
      pos.i++;
      var v = parseExpr_(tokens, pos, values);
      assert(tokens[pos.i] === ')', 'BAD_EXPRESSION', 'Missing closing parenthesis.');
      pos.i++;
      return v;
    }
    if (t === '-') { pos.i++; return -parseFactor_(tokens, pos, values); }
    pos.i++;
    if (/^[0-9]/.test(t)) return Number(t);
    if (values && (t in values)) return Util.num(values[t], 0);
    fail('BAD_EXPRESSION', 'Unknown metric key "' + t + '" in expression.');
  }

  function evalExpr_(expression, values) {
    var tokens = tokenize_(expression);
    var pos = { i: 0 };
    var value = parseExpr_(tokens, pos, values);
    assert(pos.i === tokens.length, 'BAD_EXPRESSION', 'Unexpected token in expression: ' + expression);
    return value;
  }

  /** Syntax-only check used when an admin saves a DERIVED metric definition. */
  function validateExpression(expression) {
    var values = {};
    referencedKeys_(expression).forEach(function (k) { values[k] = 0; });
    evalExpr_(expression, values);
    return true;
  }

  return { metric: metric, validateExpression: validateExpression };
})();

// ============================================================================
// 07_Planning.gs
// ============================================================================

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
    assert(BusinessFunction.codes().indexOf(category) >= 0, 'VALIDATION', 'Unknown business function: ' + category);

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
      if (!p.metricKey || !Metrics.exists(p.metricKey)) {
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
            metricKey: p.metricKey, metricLabel: Metrics.label(p.metricKey),
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
    var allowedStreams = BusinessFunction.streamsFor(cycle.category);
    assert(allowedStreams.indexOf(payload.stream) >= 0, 'VALIDATION',
      'Select a valid stream for this business function (' + allowedStreams.join(' or ') + ').');

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
    assert(Metrics.exists(payload.metricKey), 'VALIDATION',
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
      direction: payload.direction || Metrics.direction(payload.metricKey),
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

// ============================================================================
// 08_Accounts.gs
// ============================================================================

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

// ============================================================================
// 09_Activity.gs
// ============================================================================

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

  /**
   * Look up an activity type's definition. Static OMP types (ACTIVITY_TYPES,
   * 00_Config.gs) are checked first; a GENERIC business function's types come
   * from DB_ActivityTypeDef, coerced to the same shape — the rest of this file
   * never needs to know which source a definition came from.
   */
  function typeDef(key) {
    var t = ACTIVITY_TYPES.filter(function (x) { return x.key === key; })[0];
    if (t) return t;
    var row = ActivityTypeDef.get(key);
    assert(row, 'VALIDATION', 'Unknown activity type: ' + key);
    return ActivityTypeDef.toDef(row);
  }

  function types() {
    var omp = ACTIVITY_TYPES.map(function (t) {
      return {
        key: t.key, label: t.label, icon: t.icon, stream: t.stream,
        measures: t.measures, requiresAccount: t.requiresAccount,
        evidence: t.evidence, systemOwned: t.systemOwned, help: t.help,
        metrics: t.metrics, businessFunctionIds: [CATEGORY.PLASTIC, CATEGORY.METAL]
      };
    });
    var generic = ActivityTypeDef.all().map(function (row) {
      var d = ActivityTypeDef.toDef(row);
      return {
        key: d.key, label: d.label, icon: d.icon, stream: d.stream,
        measures: d.measures, requiresAccount: d.requiresAccount,
        evidence: d.evidence, systemOwned: d.systemOwned, help: d.help,
        metrics: d.metrics, businessFunctionIds: [d.businessFunctionId]
      };
    });
    return omp.concat(generic);
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
    var tRow = t ? null : ActivityTypeDef.get(a.activityType);
    var label = t ? t.label : (tRow ? tRow.label : a.activityType);
    var systemOwnedType = t ? t.systemOwned : (tRow ? Util.bool(tRow.systemOwned) : false);
    return {
      activityId: a.activityId, cycleId: a.cycleId, category: a.category, stream: a.stream,
      activityType: a.activityType,
      activityTypeLabel: label,
      activityDate: DateUtil.isoDate(a.activityDate),
      pocUserId: a.pocUserId,
      pocName: users && users[a.pocUserId] ? users[a.pocUserId].fullName : a.pocUserId,
      regionId: a.regionId,
      accountId: a.accountId, accountType: a.accountType,
      gstin: a.gstin, accountName: a.accountName || a.subjectName,
      subjectName: a.subjectName,
      kraId: a.kraId, kpiId: a.kpiId, metricKey: a.metricKey,
      count: Util.num(a.count, 0),
      quantityMT: Util.num(a.quantityMT, 0),
      ratePerKg: Util.num(a.ratePerKg, 0),
      amountINR: Util.num(a.amountINR, 0),
      measureA: Util.num(a.measureA, 0),
      measureB: Util.num(a.measureB, 0),
      measureC: Util.num(a.measureC, 0),
      status: a.status, blockerReason: a.blockerReason,
      remarks: a.remarks, evidenceUrl: a.evidenceUrl, evidenceType: a.evidenceType,
      verificationStatus: a.verificationStatus, verifiedBy: a.verifiedBy,
      verifiedAt: DateUtil.isoDateTime(a.verifiedAt), verifyNote: a.verifyNote,
      sourceSystem: a.sourceSystem, sourceRef: a.sourceRef,
      systemOwned: systemOwnedType || String(a.sourceSystem || '').indexOf('SYNC') === 0,
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
    if (!account && !Util.isBlank(payload.subjectName)) {
      // A GENERIC business function may have no seller/buyer account at all —
      // subjectName is the free-text stand-in (e.g. an applicant, a debtor).
      assert(payload.subjectName.length <= 280, 'VALIDATION', 'Subject name is too long.');
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
      subjectName: account ? '' : Util.str(payload.subjectName),
      kraId: link.kraId, kpiId: link.kpiId, metricKey: link.metricKey,
      count: Util.num(payload.count, def.measures.length ? 0 : 1) || (def.measures.length ? 0 : 1),
      quantityMT: Util.num(payload.quantityMT, 0),
      ratePerKg: Util.num(payload.ratePerKg, 0),
      amountINR: Util.num(payload.amountINR, 0),
      measureA: 0, measureB: 0, measureC: 0,
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

    // A GENERIC business function's measures name their own logical key (e.g.
    // "amount") but must land in one of the schema's generic numeric slots —
    // each measure declares which one via `column`. OMP's measures already
    // name a real column directly (quantityMT, ratePerKg, amountINR, count),
    // so they fall through here unchanged (col === m.key, already set above).
    def.measures.forEach(function (m) {
      var col = m.column || m.key;
      if (['measureA', 'measureB', 'measureC', 'count'].indexOf(col) < 0) return;
      var fallback = m.default === undefined ? row[col] : Util.num(m.default, 0);
      row[col] = Util.num(payload[m.key], fallback);
    });

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
      if (!metricFedByActivityType_(kpi.metricKey, def)) continue;
      var kra = Repository.findById(SHEET.KRA, kpi.kraId);
      return {
        kpiId: kpi.kpiId, kraId: kpi.kraId,
        metricKey: kpi.metricKey, stream: kra ? kra.stream : ''
      };
    }
    // Not every activity maps to an assigned KPI (a follow-up may simply be
    // context). Record the primary metric so it is still traceable.
    return { kpiId: '', kraId: '', metricKey: primaryMetricFor_(def), stream: '' };
  }

  /**
   * True when recording an activity of `def`'s type should move `metricKey`.
   * OMP declares the mapping forward, on the activity type (def.metrics);
   * a GENERIC business function declares it backward, on the metric itself
   * (DB_MetricDef.sourceActivityType) — both directions are checked here so
   * callers never need to know which one applies.
   */
  function metricFedByActivityType_(metricKey, def) {
    if (def.metrics && def.metrics.indexOf(metricKey) >= 0) return true;
    var mdef = MetricDef.get(metricKey);
    return !!(mdef && mdef.sourceActivityType === def.key);
  }

  function primaryMetricFor_(def) {
    if (def.metrics && def.metrics.length) return def.metrics[0];
    var mdef = MetricDef.all().filter(function (m) { return m.sourceActivityType === def.key; })[0];
    return mdef ? mdef.metricKey : '';
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
      activityTypes: types().filter(function (t) {
        return !t.systemOwned && t.businessFunctionIds.indexOf(cycle.category) >= 0;
      })
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
      metricLabel: Metrics.label(request.metricKey),
      unit: Metrics.unit(request.metricKey),
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

// ============================================================================
// 10_Reports.gs
// ============================================================================

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

// ============================================================================
// 11_Dashboard.gs
// ============================================================================

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

    // The HEADLINE list below is OMP's hand-picked six metrics with OMP-specific
    // target derivations (account plan sums, pulse rate, BALANCE_PLUS_MTD) — it
    // has no meaning for a GENERIC business function. Build the executive tiles
    // from the cycle's own KRA/KPI structure instead; no engine code is added
    // for a new business function's dashboard, same as everywhere else.
    if (BusinessFunction.isGeneric(ctx.cycle.category)) return genericExecutive_(ctx, sc, options);

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

  /**
   * The executive view for a GENERIC business function: one tile per KPI in
   * the cycle (up to a sane display limit), each computed the same way the
   * scorecard computes it — Engine.metric for the actual, Engine.target for
   * the target, Engine.evaluate for pace and rating. No metric is hand-picked;
   * whatever KRAs/KPIs a Team Lead configured are what shows here.
   */
  function genericExecutive_(ctx, sc, options) {
    var scopedRegion = (sc.level === 'REGION' && sc.regionIds && sc.regionIds.length)
      ? sc.regionIds[0] : null;
    var baseScope = {
      category: ctx.cycle.category, stream: STREAM.GENERAL,
      regionId: options.regionId || scopedRegion,
      pocUserId: options.pocUserId || (sc.level === 'SELF' ? sc.user.userId : null)
    };
    var engineScope = Engine.scope(baseScope);

    var kpis = Repository.where(SHEET.KPI, { cycleId: ctx.cycle.cycleId })
      .filter(function (p) { return p.active !== false; });

    var tiles = Util.sortBy(kpis, [{ pick: function (k) { return Util.num(k.sequence, 99); } }])
      .slice(0, 8).map(function (kpi, i) {
        var actual = Engine.metric(kpi.metricKey, ctx.windows.mtd, engineScope, { trace: false });
        var lmtd = Engine.metric(kpi.metricKey, ctx.windows.lmtd, engineScope, { trace: false });
        var targetValue = Engine.target(kpi, ctx.cycle, engineScope, ctx.windows.mtd, null).value;
        var evaluation = Engine.evaluate({
          target: targetValue, actual: actual.value, lmtd: lmtd.value, weightage: 0,
          direction: kpi.direction || DIRECTION.HIGHER_BETTER,
          elapsedDays: ctx.elapsedDays, remainingDays: ctx.remainingDays
        });
        return {
          metricKey: kpi.metricKey, label: kpi.kpiName, unit: Metrics.unit(kpi.metricKey), primary: i === 0,
          target: Util.round(evaluation.target, 6), actual: Util.round(evaluation.actual, 6),
          gap: Util.round(evaluation.gap, 6), achievement: evaluation.achievement,
          lmtd: Util.round(evaluation.lmtd, 6), growthPct: evaluation.growthPct,
          currentDrr: Util.round(evaluation.currentDrr, 6), requiredDrr: Util.round(evaluation.requiredDrr, 6),
          paceStatus: evaluation.paceStatus, tone: evaluation.tone,
          projected: Util.round(evaluation.projected, 6), projectedAchievement: evaluation.projectedAchievement,
          drill: {
            metricKey: kpi.metricKey, cycleId: ctx.cycle.cycleId,
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
      stream: STREAM.GENERAL,
      asOf: DateUtil.isoDate(ctx.asOf),
      asOfLabel: 'As Of ' + DateUtil.display(ctx.asOf),
      progress: {
        elapsedDays: ctx.elapsedDays, remainingDays: ctx.remainingDays, daysInMonth: ctx.daysInMonth,
        monthProgressPct: Util.div(ctx.elapsedDays, ctx.daysInMonth, 0)
      },
      tiles: tiles,
      scopeLabel: scopeLabel_(ctx, baseScope),
      dataQuality: dataQuality(ctx.cycle.cycleId),
      basis: { gmvBasis: null, rateGstDivisor: null, reportingLagDays: Config.get('REPORTING_LAG_DAYS') }
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

// ============================================================================
// 12_Review.gs
// ============================================================================

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

// ============================================================================
// 13_Sync.gs
// ============================================================================

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
    var id = spreadsheetId || Config.get('SOURCE_SPREADSHEET_ID');
    var ss;
    try {
      ss = id ? SpreadsheetApp.openById(id) : Repository.db();
    } catch (e) {
      fail('SOURCE_UNREACHABLE',
        'The source spreadsheet could not be opened. Check the ID and that you have access.',
        { spreadsheetId: id, cause: String(e) });
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
    options.spreadsheetId = options.spreadsheetId || Config.get('SOURCE_SPREADSHEET_ID');
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
    options.spreadsheetId = options.spreadsheetId || Config.get('SOURCE_SPREADSHEET_ID');
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
    options.spreadsheetId = options.spreadsheetId || Config.get('SOURCE_SPREADSHEET_ID');
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
    options.spreadsheetId = options.spreadsheetId || Config.get('SOURCE_SPREADSHEET_ID');
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
    var id = spreadsheetId || Config.get('SOURCE_SPREADSHEET_ID');
    if (!id) {
      fail('VALIDATION',
        'No spreadsheet ID given and no SOURCE_SPREADSHEET_ID is configured under Settings.');
    }
    var ss;
    try { ss = SpreadsheetApp.openById(id); }
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

// ============================================================================
// 14_Admin.gs
// ============================================================================

/**
 * 14_Admin.gs — Users, regions, configuration and exports.
 */

var Admin = (function () {

  // =========================================================================
  // Users
  // =========================================================================

  function listUsers(filterSpec) {
    filterSpec = filterSpec || {};
    var sc = Auth.scope();
    var regions = Util.indexBy(Repository.readAll(SHEET.REGIONS), function (r) { return r.regionId; });
    var all = Repository.readAll(SHEET.USERS);
    var byId = Util.indexBy(all, function (u) { return u.userId; });

    return all
      .filter(function (u) {
        if (u.active === false && !filterSpec.includeInactive) return false;
        if (filterSpec.role && u.role !== filterSpec.role) return false;
        if (filterSpec.regionId && u.regionId !== filterSpec.regionId) return false;
        if (filterSpec.category && u.category !== 'ALL' && u.category !== filterSpec.category) return false;
        // Non-admins see the people in their own scope, so they can assign work.
        if (!Auth.can(PERM.USER_MANAGE) && sc.pocUserIds &&
          sc.pocUserIds.indexOf(u.userId) < 0) return false;
        return true;
      })
      .map(function (u) {
        return {
          userId: u.userId, email: u.email, fullName: u.fullName,
          employeeCode: u.employeeCode, role: u.role, category: u.category,
          regionId: u.regionId,
          regionName: regions[u.regionId] ? regions[u.regionId].regionName : '',
          stream: u.stream, reportsTo: u.reportsTo,
          reportsToName: byId[u.reportsTo] ? byId[u.reportsTo].fullName : '',
          phone: u.phone, aliases: u.aliases, active: u.active !== false,
          provisional: !u.email
        };
      });
  }

  function saveUser(payload) {
    Auth.require(PERM.USER_MANAGE);
    assert(!Util.isBlank(payload.fullName), 'VALIDATION', 'A full name is required.');
    assert(payload.role in ROLE_RANK, 'VALIDATION', 'Select a valid role.');

    var email = Util.str(payload.email).toLowerCase();
    if (email) {
      assert(/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email), 'VALIDATION', 'Enter a valid email address.');
      var clash = Repository.find(SHEET.USERS, function (u) {
        return String(u.email || '').toLowerCase() === email && u.userId !== payload.userId;
      });
      assert(!clash, 'DUPLICATE', email + ' is already registered to ' + (clash && clash.fullName) + '.');
    }

    // Only an admin may create another admin.
    if (payload.role === ROLE.ADMIN) {
      assert(Auth.current().role === ROLE.ADMIN, 'FORBIDDEN',
        'Only an administrator can grant administrator access.');
    }
    if (payload.role === ROLE.RH || payload.role === ROLE.POC) {
      assert(!Util.isBlank(payload.regionId), 'VALIDATION',
        'A ' + payload.role + ' must belong to a region.');
    }

    var row = {
      userId: payload.userId || Id.next('USR'),
      email: email,
      fullName: Util.str(payload.fullName),
      employeeCode: Util.str(payload.employeeCode),
      role: payload.role,
      category: payload.category || 'ALL',
      regionId: Util.str(payload.regionId),
      stream: payload.stream || 'BOTH',
      reportsTo: Util.str(payload.reportsTo),
      phone: Util.str(payload.phone),
      aliases: Util.str(payload.aliases),
      active: payload.active === undefined ? true : !!payload.active
    };

    // Guard against locking everyone out.
    if (payload.userId) {
      var existing = Repository.findById(SHEET.USERS, payload.userId);
      assert(existing, 'NOT_FOUND', 'User not found.');
      if (existing.role === ROLE.ADMIN && (row.role !== ROLE.ADMIN || !row.active)) {
        var otherAdmins = Repository.readAll(SHEET.USERS).filter(function (u) {
          return u.role === ROLE.ADMIN && u.active !== false && u.userId !== payload.userId;
        });
        assert(otherAdmins.length > 0, 'VALIDATION',
          'At least one active administrator must remain.');
      }
    }

    var saved = Repository.upsert(SHEET.USERS, row);
    Auth.reset();
    Audit.log(payload.userId ? 'USER_UPDATE' : 'USER_CREATE', SHEET.USERS, saved.userId,
      saved.fullName + ' · ' + saved.role, null, saved);
    return saved;
  }

  /** Merge a provisional user created by the sync into a real account. */
  function mergeUser(sourceUserId, targetUserId) {
    Auth.require(PERM.USER_MANAGE);
    var source = Repository.findById(SHEET.USERS, sourceUserId);
    var target = Repository.findById(SHEET.USERS, targetUserId);
    assert(source && target, 'NOT_FOUND', 'Both users must exist.');
    assert(sourceUserId !== targetUserId, 'VALIDATION', 'Choose two different users.');

    var moved = { accounts: 0, activities: 0, shipments: 0, onboarding: 0, pulse: 0, assignments: 0 };
    Repository.transaction(function () {
      [[SHEET.ACCOUNTS, 'pocUserId', 'accountId', 'accounts'],
      [SHEET.ACTIVITIES, 'pocUserId', 'activityId', 'activities'],
      [SHEET.SHIPMENTS, 'pocUserId', 'shipmentKey', 'shipments'],
      [SHEET.ONBOARDING, 'pocUserId', 'onboardingKey', 'onboarding'],
      [SHEET.PULSE, 'pocUserId', 'pulseId', 'pulse'],
      [SHEET.ASSIGNMENT, 'pocUserId', 'assignmentId', 'assignments']
      ].forEach(function (spec) {
        var sheetName = spec[0], field = spec[1], pk = spec[2], counter = spec[3];
        Repository.readAll(sheetName).forEach(function (r) {
          if (String(r[field]) !== String(sourceUserId)) return;
          var patch = {};
          patch[field] = targetUserId;
          Repository.update(sheetName, r[pk], patch);
          moved[counter]++;
        });
      });

      // Carry the source name forward as an alias so future syncs resolve it.
      var aliases = String(target.aliases || '').split('|')
        .concat([source.fullName], String(source.aliases || '').split('|'))
        .map(function (s) { return s.trim(); })
        .filter(function (s) { return s; });
      Repository.update(SHEET.USERS, targetUserId, { aliases: Util.unique(aliases).join('|') });
      Repository.update(SHEET.USERS, sourceUserId, { active: false });
    });

    Engine.invalidate();
    Auth.reset();
    Audit.log('USER_MERGE', SHEET.USERS, targetUserId,
      'Merged ' + source.fullName + ' into ' + target.fullName, null, moved);
    return { merged: true, moved: moved };
  }

  // =========================================================================
  // Regions
  // =========================================================================

  function listRegions(category) {
    var users = Util.indexBy(Repository.readAll(SHEET.USERS), function (u) { return u.userId; });
    return Repository.readAll(SHEET.REGIONS)
      .filter(function (r) {
        return r.active !== false && (!category || r.category === category);
      })
      .map(function (r) {
        return {
          regionId: r.regionId, regionName: r.regionName, category: r.category,
          rhUserId: r.rhUserId,
          rhName: users[r.rhUserId] ? users[r.rhUserId].fullName : '',
          states: r.states, sequence: Util.num(r.sequence, 50)
        };
      })
      .sort(function (a, b) { return a.sequence - b.sequence; });
  }

  function saveRegion(payload) {
    Auth.require(PERM.USER_MANAGE);
    assert(!Util.isBlank(payload.regionName), 'VALIDATION', 'A region name is required.');
    var category = payload.category || Config.get('DEFAULT_CATEGORY');
    var row = {
      regionId: payload.regionId || Id.natural('RGN', category, payload.regionName),
      regionName: Util.str(payload.regionName),
      category: category,
      rhUserId: Util.str(payload.rhUserId),
      states: Util.str(payload.states),
      sequence: Util.num(payload.sequence, 50),
      active: payload.active === undefined ? true : !!payload.active
    };
    var saved = Repository.upsert(SHEET.REGIONS, row);
    Audit.log(payload.regionId ? 'REGION_UPDATE' : 'REGION_CREATE', SHEET.REGIONS,
      saved.regionId, saved.regionName + ' · ' + saved.category, null, saved);
    return saved;
  }

  // =========================================================================
  // Configuration
  // =========================================================================

  function listConfig() {
    Auth.require(PERM.CONFIG_MANAGE);
    var stored = Util.indexBy(Repository.readAll(SHEET.CONFIG), function (c) { return c.key; });
    return Object.keys(CONFIG_DEFAULTS).map(function (k) {
      var row = stored[k];
      return {
        key: k,
        value: Config.get(k),
        defaultValue: CONFIG_DEFAULTS[k],
        type: typeof CONFIG_DEFAULTS[k],
        description: row ? row.description : '',
        modified: String(Config.get(k)) !== String(CONFIG_DEFAULTS[k]),
        updatedAt: row ? DateUtil.isoDateTime(row.updatedAt) : '',
        updatedBy: row ? row.updatedBy : ''
      };
    });
  }

  function setConfig(key, value) {
    Auth.require(PERM.CONFIG_MANAGE);
    assert(key in CONFIG_DEFAULTS, 'VALIDATION', 'Unknown configuration key: ' + key);
    var before = Config.get(key);
    var saved = Repository.upsert(SHEET.CONFIG, {
      key: key, value: String(value),
      description: (Repository.findById(SHEET.CONFIG, key) || {}).description || ''
    });
    Config.invalidate();
    Engine.invalidate();
    Audit.log('CONFIG_SET', SHEET.CONFIG, key,
      key + ': ' + before + ' → ' + value, { value: before }, { value: value });
    return { key: key, value: Config.get(key), previous: before, saved: !!saved };
  }

  // =========================================================================
  // Export
  // =========================================================================

  /**
   * Materialise a generated report into a spreadsheet tab. The product removes
   * the need for exports, but finance and HR still ask for a file at month end.
   */
  function exportReport(reportKey, params) {
    Auth.require(PERM.REPORT_EXPORT);
    params = params || {};
    var built = buildExport_(reportKey, params);
    var ss = Repository.db();
    var tabName = 'EXPORT_' + reportKey + '_' +
      Utilities.formatDate(new Date(), APP.TIMEZONE, 'yyyyMMdd_HHmm');
    var sh = ss.insertSheet(tabName);
    sh.getRange(1, 1, 1, built.headers.length).setValues([built.headers])
      .setFontWeight('bold').setBackground('#0f2f4f').setFontColor('#ffffff');
    if (built.rows.length) {
      sh.getRange(2, 1, built.rows.length, built.headers.length).setValues(built.rows);
    }
    sh.setFrozenRows(1);
    sh.autoResizeColumns(1, built.headers.length);

    Audit.log('REPORT_EXPORT', 'REPORT', reportKey,
      built.rows.length + ' rows exported to ' + tabName);
    return {
      reportKey: reportKey, sheetName: tabName, rows: built.rows.length,
      url: ss.getUrl() + '#gid=' + sh.getSheetId()
    };
  }

  function exportCsv(reportKey, params) {
    Auth.require(PERM.REPORT_EXPORT);
    var built = buildExport_(reportKey, params || {});
    var lines = [built.headers].concat(built.rows).map(function (row) {
      return row.map(function (cell) {
        var s = cell === null || cell === undefined ? '' : String(cell);
        return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
      }).join(',');
    });
    return {
      reportKey: reportKey,
      filename: reportKey + '_' + Utilities.formatDate(new Date(), APP.TIMEZONE, 'yyyyMMdd') + '.csv',
      csv: lines.join('\n'),
      rows: built.rows.length
    };
  }

  function buildExport_(reportKey, params) {
    switch (reportKey) {
      case 'POC_WISE': {
        var p = Reports.pocWise(params.cycleId, params.asOf, params);
        return {
          headers: ['Region', 'RH', 'POC', 'Annual Plan', 'FYTD Onboarded', 'Balance To Do',
            'MTD Onboarded', 'Monthly Target', 'Onboarding Ach %',
            'Txn Target', 'Txn Achieved', 'Txn Ach %',
            'Tonnage Target (MT)', 'Tonnage Achieved (MT)', 'Tonnage Ach %',
            'GMV Target (Cr)', 'GMV Achieved (Cr)', 'GMV Ach %',
            'LMTD GMV (Cr)', 'GMV Growth %'],
          rows: p.rows.map(function (r) {
            return [r.regionName, r.rhName, r.pocName,
              r.onboarding.annualPlan, r.onboarding.fytdOnboarded, r.onboarding.balanceToDo,
              r.onboarding.mtdOnboarded, r.onboarding.monthlyTarget, r.onboarding.monthlyAchievementPct,
              r.mtd.txnTarget, r.mtd.txnAchieved, r.mtd.txnAchievementPct,
              r.mtd.tonnageTargetMT, r.mtd.tonnageAchievedMT, r.mtd.tonnageAchievementPct,
              r.mtd.gmvTargetCr, r.mtd.gmvAchievedCr, r.mtd.gmvAchievementPct,
              r.lmtd.gmvCr, r.growth.gmvPct];
          })
        };
      }
      case 'REGION_WISE': {
        var g = Reports.regionWise(params.cycleId, params.asOf, params);
        return {
          headers: ['Region', 'RH', 'POCs', 'Annual Plan', 'FYTD Onboarded', 'MTD Onboarded',
            'Txn Target', 'Txn Achieved', 'Tonnage Target (MT)', 'Tonnage Achieved (MT)',
            'GMV Target (Cr)', 'GMV Achieved (Cr)', 'GMV Ach %', 'GMV Growth %'],
          rows: g.rows.map(function (r) {
            return [r.regionName, r.rhName, r.pocCount,
              r.totals.annualPlan, r.totals.fytdOnboarded, r.totals.mtdOnboarded,
              r.totals.txnTarget, r.totals.txnAchieved,
              r.totals.tonnageTargetMT, r.totals.tonnageAchievedMT,
              r.totals.gmvTargetCr, r.totals.gmvAchievedCr,
              r.totals.gmvAchievementPct, r.totals.gmvGrowthPct];
          })
        };
      }
      case 'LEADERBOARD': {
        var b = Reports.leaderboard(params.cycleId, params.asOf);
        return {
          headers: ['Rank', 'POC', 'Region', 'Weighted Score', 'Overall Achievement %',
            'Rating', 'Rating Label', 'KPIs', 'On Pace', 'At Risk'],
          rows: b.rows.map(function (r) {
            return [r.rank, r.pocName, r.regionName, r.weightedScore, r.overallAchievement,
              r.rating, r.ratingLabel, r.kpiCount, r.onPace, r.atRisk];
          })
        };
      }
      case 'SCORECARD': {
        var c = Reports.scorecardFor(params.cycleId, params.pocUserId);
        return {
          headers: ['KRA', 'KPI', 'Definition', 'Weightage', 'Target', 'Actual',
            'Achievement %', 'Weighted Score', 'Status', 'Rating', 'Target Basis'],
          rows: c.kpis.map(function (k) {
            return [k.kraName, k.kpiName, k.definition, k.weightage,
              k.evaluation.target, k.evaluation.actual, k.evaluation.achievement,
              k.evaluation.weightedScore, k.evaluation.bandLabel,
              k.evaluation.ratingLabel, k.targetDetail];
          }).concat([[], ['TOTAL', '', '', c.summary.totalWeightage, '', '',
            c.summary.overallAchievement, c.summary.weightedScore, '',
            c.summary.ratingLabel, '']])
        };
      }
      case 'ACTIVITIES': {
        var acts = Activity.list(params);
        return {
          headers: ['Date', 'POC', 'Type', 'Account', 'GSTIN', 'Qty (MT)', 'Amount (₹)',
            'Remarks', 'Evidence', 'Verification', 'Recorded By', 'Recorded At'],
          rows: acts.map(function (a) {
            return [a.activityDate, a.pocName, a.activityTypeLabel, a.accountName, a.gstin,
              a.quantityMT, a.amountINR, a.remarks, a.evidenceUrl,
              a.verificationStatus, a.createdBy, a.createdAt];
          })
        };
      }
      case 'ACCOUNT_PERFORMANCE': {
        var ap = Reports.accountPerformance(params.cycleId, params.asOf, params);
        return {
          headers: ['Account', 'GSTIN', 'Region', 'POC', 'Material',
            'Txn Target', 'Txn Achieved', 'Tonnage Target (MT)', 'Tonnage Achieved (MT)',
            'Rate Target (₹/kg)', 'Rate Achieved (₹/kg)',
            'GMV Target (Cr)', 'GMV Achieved (Cr)', 'GMV Ach %',
            'LMTD GMV (Cr)', 'GMV Growth %', 'Remarks', 'Blocker'],
          rows: ap.rows.map(function (r) {
            return [r.accountName, r.gstin, r.regionName, r.pocName, r.materialType,
              r.target.txnTarget, r.achieved.txnCount,
              r.target.tonnageTargetMT, r.achieved.tonnageMT,
              r.target.ratePerKgTarget, r.achieved.ratePerKg,
              r.target.gmvTargetCr, r.achieved.gmvCr, r.achievementPct.gmv,
              r.lmtd.gmvCr, r.growthPct.gmv, r.remarks, r.blockerReason];
          })
        };
      }
      case 'DAILY_REVIEW': {
        var dr = Reports.dailyReview(params.cycleId, params.asOf, params);
        var headers = ['Scope', 'Level', 'Metric', 'Target', 'Achieved', 'Achievement %',
          'Current DRR', 'Required DRR', 'LMTD', 'MTD Growth %', 'Pace'];
        var rows = [];
        function push(scopeName, level, metrics) {
          metrics.forEach(function (m) {
            rows.push([scopeName, level, m.label, m.target, m.achieved, m.achievementPct,
              m.currentDrr, m.requiredDrr, m.lmtd, m.growthPct, m.paceStatus]);
          });
        }
        push(dr.category, 'OVERALL', dr.overall);
        dr.regions.forEach(function (r) {
          push(r.regionName, 'REGION', r.metrics);
          r.pocs.forEach(function (p) { push(p.pocName, 'POC', p.metrics); });
        });
        return { headers: headers, rows: rows };
      }
      case 'AUDIT': {
        var entries = Audit.recent(params.limit || 1000, params);
        return {
          headers: ['Timestamp', 'User', 'Role', 'Action', 'Entity', 'Entity ID', 'Summary', 'Success'],
          rows: entries.map(function (e) {
            return [DateUtil.isoDateTime(e.timestamp), e.userEmail, e.role, e.action,
              e.entity, e.entityId, e.summary, e.success];
          })
        };
      }
      default:
        fail('VALIDATION', 'Unknown report: ' + reportKey);
    }
  }

  var EXPORTABLE = [
    { key: 'DAILY_REVIEW', label: 'Daily Review (all scopes)' },
    { key: 'POC_WISE', label: 'POC-Wise Performance' },
    { key: 'REGION_WISE', label: 'Region-Wise Performance' },
    { key: 'LEADERBOARD', label: 'Scorecard Leaderboard' },
    { key: 'SCORECARD', label: 'Individual Scorecard' },
    { key: 'ACCOUNT_PERFORMANCE', label: 'Account Performance' },
    { key: 'ACTIVITIES', label: 'Activity Log' },
    { key: 'AUDIT', label: 'Audit Trail' }
  ];

  return {
    listUsers: listUsers,
    saveUser: saveUser,
    mergeUser: mergeUser,
    listRegions: listRegions,
    saveRegion: saveRegion,
    listConfig: listConfig,
    setConfig: setConfig,
    exportReport: exportReport,
    exportCsv: exportCsv,
    EXPORTABLE: EXPORTABLE
  };
})();

// ============================================================================
// 15_Api.gs
// ============================================================================

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
  'kpi.library': function (p) { return Bootstrap.kraLibraryFor((p && p.category) || Config.get('DEFAULT_CATEGORY')); },

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

  // ---- Business Functions (the config-driven platform layer) -------------
  // Adding a business function beyond OMP-Metal/Plastic is these three
  // actions plus Planning's existing KRA/KPI editor — no engine code.
  'businessFunction.list': function (p) {
    return (p && p.includeInactive) ? BusinessFunction.all() : BusinessFunction.list();
  },
  'businessFunction.save': function (p) { return BusinessFunction.save(p); },
  'activityTypeDef.list': function (p) {
    return (p && p.businessFunctionId) ? ActivityTypeDef.forFunction(p.businessFunctionId) : ActivityTypeDef.all();
  },
  'activityTypeDef.save': function (p) { return ActivityTypeDef.save(p); },
  'metricDef.list': function (p) {
    return (p && p.businessFunctionId) ? MetricDef.forFunction(p.businessFunctionId) : MetricDef.all();
  },
  'metricDef.save': function (p) { return MetricDef.save(p); },

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
      // Every active business function's code — OMP's two plus any GENERIC
      // ones an admin has configured. Existing <select> bindings (User,
      // Region, Sync forms) keep working unchanged; they just gain options.
      categories: BusinessFunction.codes(),
      businessFunctions: BusinessFunction.list(),
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
      metrics: Metrics.registry(),
      targetBases: Object.keys(TARGET_BASIS),
      aggregations: Object.keys(AGGREGATION),
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

// ============================================================================
// 16_Code.gs
// ============================================================================

/**
 * 16_Code.gs — Web app entry point, spreadsheet menu and scheduled jobs.
 */

/** Serve the single-page application. */
function doGet(e) {
  var template = HtmlService.createTemplateFromFile('Index');
  template.initialRoute = (e && e.parameter && e.parameter.route) || '';
  return template.evaluate()
    .setTitle(APP.NAME)
    .setFaviconUrl('https://ssl.gstatic.com/docs/spreadsheets/forms/favicon_qp2.png')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/** Server-side partial include, used to compose the client bundle. */
function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

/** Menu inside the backend spreadsheet, for administrators. */
function onOpen() {
  try {
    SpreadsheetApp.getUi()
      .createMenu('⚙️ ' + APP.SHORT_NAME)
      .addItem('Open application', 'showAppSidebar')
      .addSeparator()
      .addItem('Run setup / migrate schema', 'menuSetup')
      .addItem('Install scheduled jobs', 'menuInstallTriggers')
      .addSeparator()
      .addItem('Sync source data now', 'menuSyncAll')
      .addItem('Take daily snapshot', 'menuSnapshot')
      .addSeparator()
      .addItem('Health check', 'menuHealth')
      .addToUi();
  } catch (e) {
    // onOpen also fires in contexts without a UI; nothing to do there.
  }
}

function showAppSidebar() {
  var url = ScriptApp.getService().getUrl();
  var html = HtmlService.createHtmlOutput(
    '<div style="font:14px/1.6 system-ui,-apple-system,sans-serif;padding:16px">' +
    '<h3 style="margin:0 0 8px">' + APP.NAME + '</h3>' +
    (url
      ? '<p>Open the application in a new tab:</p><p><a href="' + url +
      '" target="_blank" rel="noopener">' + url + '</a></p>'
      : '<p>Deploy this project as a web app first (Deploy → New deployment → Web app).</p>') +
    '</div>')
    .setTitle(APP.SHORT_NAME);
  SpreadsheetApp.getUi().showSidebar(html);
}

function menuSetup() {
  var ui = SpreadsheetApp.getUi();
  try {
    var result = Bootstrap.setup({});
    ui.alert('Setup complete',
      'Schema version ' + result.schemaVersion + '.\n' +
      'Created: ' + (result.created.join(', ') || 'none') + '\n' +
      'Migrated: ' + (result.migrated.join(', ') || 'none'),
      ui.ButtonSet.OK);
  } catch (e) {
    ui.alert('Setup failed', String(e.message || e), ui.ButtonSet.OK);
  }
}

function menuInstallTriggers() {
  var ui = SpreadsheetApp.getUi();
  try {
    var r = Bootstrap.installTriggers();
    ui.alert('Scheduled jobs installed', r.installed.join('\n'), ui.ButtonSet.OK);
  } catch (e) {
    ui.alert('Could not install jobs', String(e.message || e), ui.ButtonSet.OK);
  }
}

function menuSyncAll() {
  var ui = SpreadsheetApp.getUi();
  try {
    var r = Sync.syncAll({});
    var lines = ['onboarding', 'shipments', 'pulse'].map(function (k) {
      var s = r[k];
      return k + ': ' + s.status + ' — read ' + s.rowsRead +
        ', inserted ' + s.rowsInserted + ', updated ' + s.rowsUpdated;
    });
    ui.alert('Sync finished', lines.join('\n'), ui.ButtonSet.OK);
  } catch (e) {
    ui.alert('Sync failed', String(e.message || e), ui.ButtonSet.OK);
  }
}

function menuSnapshot() {
  var ui = SpreadsheetApp.getUi();
  try {
    var cycle = Planning.activeCycle();
    if (!cycle) { ui.alert('No active cycle to snapshot.'); return; }
    var r = Dashboard.takeSnapshot(cycle.cycleId);
    ui.alert('Snapshot taken', r.rows + ' metric rows for ' + r.date, ui.ButtonSet.OK);
  } catch (e) {
    ui.alert('Snapshot failed', String(e.message || e), ui.ButtonSet.OK);
  }
}

function menuHealth() {
  var ui = SpreadsheetApp.getUi();
  var h = Bootstrap.health();
  var counts = Object.keys(h.rowCounts || {})
    .map(function (k) { return k + ': ' + h.rowCounts[k]; }).join('\n');
  ui.alert(h.ok ? 'Healthy' : 'Attention needed',
    'Schema version: ' + h.schemaVersion + ' (installed ' + h.installedVersion + ')\n' +
    (h.missingSheets.length ? 'Missing sheets: ' + h.missingSheets.join(', ') + '\n\n' : '\n') +
    counts, ui.ButtonSet.OK);
}

// ---------------------------------------------------------------------------
// Scheduled jobs
// ---------------------------------------------------------------------------

/** Nightly: pull the source workbooks so the morning dashboard is current. */
function jobNightlySync() {
  try {
    var result = Sync.syncAll({});
    console.log('Nightly sync: ' + JSON.stringify({
      onboarding: result.onboarding.status,
      shipments: result.shipments.status,
      pulse: result.pulse.status
    }));
  } catch (e) {
    console.error('Nightly sync failed: ' + e);
    Audit.log('JOB_SYNC', 'JOB', 'jobNightlySync', 'Nightly sync failed',
      null, null, false, String(e.message || e));
  }
}

/** Daily: freeze metric values so trends survive later fact corrections. */
function jobDailySnapshot() {
  try {
    CATEGORIES.forEach(function (category) {
      var cycle = Planning.activeCycle(category);
      if (!cycle || cycle.status === CYCLE_STATUS.DRAFT) return;
      var r = Dashboard.takeSnapshot(cycle.cycleId);
      console.log('Snapshot ' + category + ': ' + r.rows + ' rows for ' + r.date);
    });
  } catch (e) {
    console.error('Snapshot job failed: ' + e);
    Audit.log('JOB_SNAPSHOT', 'JOB', 'jobDailySnapshot', 'Snapshot failed',
      null, null, false, String(e.message || e));
  }
}

/**
 * Daily: email the people who own something that needs attention. Alerts are
 * grouped per owner so nobody receives seven separate messages.
 */
function jobDailyAlerts() {
  try {
    CATEGORIES.forEach(function (category) {
      var cycle = Planning.activeCycle(category);
      if (!cycle || cycle.status !== CYCLE_STATUS.PUBLISHED) return;

      var payload = Dashboard.alerts(cycle.cycleId, {});
      var byOwner = Util.groupBy(
        payload.alerts.filter(function (a) { return a.ownerUserId; }),
        function (a) { return a.ownerUserId; });

      Object.keys(byOwner).forEach(function (ownerId) {
        var owner = Repository.findById(SHEET.USERS, ownerId);
        if (!owner || !owner.email || owner.active === false) return;
        var mine = byOwner[ownerId];
        var p1 = mine.filter(function (a) { return a.severity === 'P1'; });
        if (!p1.length && mine.length < 3) return;   // do not nag over trivia

        var body = [
          'Good morning ' + (owner.fullName || '') + ',',
          '',
          cycle.label + ' — ' + mine.length + ' item(s) need your attention.',
          ''
        ];
        mine.slice(0, 15).forEach(function (a, i) {
          body.push((i + 1) + '. [' + a.severity + '] ' + a.title);
          if (a.detail) body.push('   ' + a.detail);
          if (a.nextStep) body.push('   Next: ' + a.nextStep);
          body.push('');
        });
        var url = ScriptApp.getService().getUrl();
        if (url) body.push('Open the tracker: ' + url);

        MailApp.sendEmail({
          to: owner.email,
          subject: '[' + APP.SHORT_NAME + '] ' + cycle.label + ' — ' +
            mine.length + ' item(s) need attention',
          body: body.join('\n')
        });
      });
      console.log('Alert emails sent for ' + category + ': ' + Object.keys(byOwner).length + ' owner(s)');
    });
  } catch (e) {
    console.error('Alert job failed: ' + e);
    Audit.log('JOB_ALERTS', 'JOB', 'jobDailyAlerts', 'Alert job failed',
      null, null, false, String(e.message || e));
  }
}

// ---------------------------------------------------------------------------
// One-off setup helper, runnable from the Apps Script editor
// ---------------------------------------------------------------------------

/**
 * Run once from the editor on a fresh project. Creates the schema, seeds the
 * KRA library and nominates the running account as the first administrator.
 */
function setupFirstRun() {
  var email = Session.getEffectiveUser().getEmail();
  PropertiesService.getScriptProperties().setProperty(PROP.BOOTSTRAP_ADMIN, email);
  var result = Bootstrap.setup({});
  Auth.current();                       // provisions the bootstrap administrator
  console.log('Setup complete: ' + JSON.stringify(result));
  console.log('Administrator: ' + email);
  return result;
}
