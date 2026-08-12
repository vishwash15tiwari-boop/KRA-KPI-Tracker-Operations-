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

    // Standalone deployment (not bound to a container spreadsheet): fall back
    // to the connected workbook rather than failing outright, so the in-app
    // Setup wizard's "Run setup" button works on first load with no editor visit.
    if (DEFAULT_DB_SPREADSHEET_ID) {
      try {
        ssCache_ = SpreadsheetApp.openById(DEFAULT_DB_SPREADSHEET_ID);
        PropertiesService.getScriptProperties().setProperty(PROP.DB_ID, ssCache_.getId());
        return ssCache_;
      } catch (e2) {
        fail('DB_NOT_CONFIGURED',
          'No backend spreadsheet is configured, and the default could not be opened. ' +
          'Run Bootstrap.setup() first.', { cause: String(e2) });
      }
    }

    fail('DB_NOT_CONFIGURED',
      'No backend spreadsheet is configured. Run Bootstrap.setup() first.');
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
