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
