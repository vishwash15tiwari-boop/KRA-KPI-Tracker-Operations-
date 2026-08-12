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
  DEMAND: 'DEMAND'
});
var STREAMS = [STREAM.SUPPLY, STREAM.DEMAND];

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
