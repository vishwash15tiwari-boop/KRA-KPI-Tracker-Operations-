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
      seedRegions_();
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

  /** Regions observed in the source workbook, plus an explicit unassigned bucket. */
  function seedRegions_() {
    var existing = Repository.readAll(SHEET.REGIONS);
    if (existing.length) return { skipped: true };
    var seed = [
      { regionName: 'North', sequence: 1 },
      { regionName: 'South', sequence: 2 },
      { regionName: 'East', sequence: 3 },
      { regionName: 'West', sequence: 4 },
      { regionName: 'North East', sequence: 5 },
      { regionName: 'Unassigned', sequence: 99 }
    ];
    var rows = [];
    CATEGORIES.forEach(function (cat) {
      seed.forEach(function (r) {
        rows.push({
          regionId: Id.natural('RGN', cat, r.regionName),
          regionName: r.regionName,
          category: cat,
          active: true,
          sequence: r.sequence,
          createdAt: new Date()
        });
      });
    });
    Repository.insertMany(SHEET.REGIONS, rows);
    return { inserted: rows.length };
  }

  /**
   * The KRA/KPI library, transcribed from the workbook. This is the template a
   * Team Lead clones into each new cycle; `cycleId` is blank on library rows.
   */
  function kraLibrary() {
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
   * Install the library as template rows (cycleId = 'LIBRARY'). Cloning a
   * library KRA into a cycle copies the row and rewrites cycleId.
   */
  function seedKraLibrary_() {
    var existing = Repository.where(SHEET.KRA, { cycleId: 'LIBRARY' });
    if (existing.length) return { skipped: true };

    var kraRows = [], kpiRows = [];
    CATEGORIES.forEach(function (category) {
      kraLibrary().forEach(function (k) {
        var kraId = Id.natural('KRA', 'LIB', category, k.stream, k.kraName);
        kraRows.push({
          kraId: kraId, cycleId: 'LIBRARY', category: category, stream: k.stream,
          perspective: k.perspective, kraName: k.kraName,
          sourceOfTracking: k.sourceOfTracking, sequence: k.sequence,
          active: true, createdAt: new Date(), createdBy: 'bootstrap'
        });
        k.kpis.forEach(function (p) {
          kpiRows.push({
            kpiId: Id.natural('KPI', 'LIB', category, k.stream, p.kpiName),
            kraId: kraId, cycleId: 'LIBRARY',
            kpiName: p.kpiName, definition: p.definition,
            weightage: p.weightage, unitOfMeasure: p.unitOfMeasure,
            metricKey: p.metricKey, direction: p.direction,
            targetBasis: p.targetBasis,
            basisMetric: p.basisMetric || '', basisPct: p.basisPct || null,
            target1: p.targets[0], target2: p.targets[1], target3: p.targets[2],
            target4: p.targets[3], target5: p.targets[4],
            sequence: p.sequence, active: true,
            createdAt: new Date(), createdBy: 'bootstrap'
          });
        });
      });
    });
    Repository.insertMany(SHEET.KRA, kraRows);
    Repository.insertMany(SHEET.KPI, kpiRows);
    return { kras: kraRows.length, kpis: kpiRows.length };
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
    installTriggers: installTriggers,
    seedConfig: seedConfig_,
    seedRegions: seedRegions_,
    seedKraLibrary: seedKraLibrary_
  };
})();
