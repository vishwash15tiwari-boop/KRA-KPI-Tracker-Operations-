/* ============================================================================
 * DB — a small relational engine over IndexedDB.
 *
 * IndexedDB is a real, transactional, indexed, persistent browser database; it
 * is the durable store for this application (data survives refresh, per device).
 * This module gives it a relational feel: typed stores from EPM_SCHEMA, indexed
 * lookups, foreign-key enforcement on write, composite indexes, and an audit
 * hook. The domain layer (domain.js) is the only place business rules live; this
 * file is pure persistence + integrity, the equivalent of an ORM + DB driver.
 * ========================================================================== */
window.DB = (function () {
  'use strict';
  var S = window.EPM_SCHEMA;
  var _db = null;

  /* composite index values are derived from other fields so equality lookups
   * (one employee's KPI in one period) are a single indexed read, not a scan. */
  function derive(store, o) {
    if (store === 'targets') o.empKpiPeriod = o.employeeId + '|' + o.kpiId + '|' + o.periodId;
    if (store === 'performance') { o.empPeriod = o.employeeId + '|' + o.periodId; o.empKpiPeriod = o.employeeId + '|' + o.kpiId + '|' + o.periodId; }
    if (store === 'reviews') o.empPeriod = o.employeeId + '|' + o.periodId;
    return o;
  }

  function open() {
    if (_db) return Promise.resolve(_db);
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open(S.name, S.version);
      req.onupgradeneeded = function (e) {
        var db = e.target.result;
        Object.keys(S.stores).forEach(function (name) {
          var def = S.stores[name], st;
          if (!db.objectStoreNames.contains(name)) st = db.createObjectStore(name, { keyPath: def.key });
          else st = e.target.transaction.objectStore(name);
          (def.indexes || []).forEach(function (ix) {
            var field = ix, opts = { unique: false };
            if (!st.indexNames.contains(field)) st.createIndex(field, field, opts);
          });
        });
      };
      req.onsuccess = function () { _db = req.result; resolve(_db); };
      req.onerror = function () { reject(req.error); };
    });
  }

  function txStore(store, mode) { return _db.transaction(store, mode).objectStore(store); }
  function reqP(r) { return new Promise(function (res, rej) { r.onsuccess = function () { res(r.result); }; r.onerror = function () { rej(r.error); }; }); }

  function all(store) { return open().then(function () { return reqP(txStore(store, 'readonly').getAll()); }); }
  function get(store, key) { return open().then(function () { return reqP(txStore(store, 'readonly').get(key)); }); }
  function count(store) { return open().then(function () { return reqP(txStore(store, 'readonly').count()); }); }
  function by(store, index, value) {
    return open().then(function () {
      var ix = txStore(store, 'readonly').index(index);
      return reqP(ix.getAll(IDBKeyRange.only(value)));
    });
  }
  function first(store, index, value) { return by(store, index, value).then(function (rows) { return rows[0] || null; }); }
  function where(store, pred) { return all(store).then(function (rows) { return rows.filter(pred); }); }

  /* Foreign-key enforcement. A key ending in '?' is nullable — an empty value is
   * allowed, a present value must resolve. Missing references throw before write,
   * so the database can never hold a dangling relationship. */
  function checkFk(store, o) {
    var fk = (S.stores[store] || {}).fk || {}, checks = [];
    Object.keys(fk).forEach(function (field) {
      var target = fk[field], nullable = target.slice(-1) === '?';
      var t = nullable ? target.slice(0, -1) : target;
      var val = o[field];
      if (val == null || val === '') { if (!nullable) checks.push(Promise.reject(new Error('FK ' + store + '.' + field + ' is required'))); return; }
      checks.push(get(t, val).then(function (row) { if (!row) throw new Error('FK violation: ' + store + '.' + field + ' -> ' + t + ' "' + val + '" not found'); }));
    });
    return Promise.all(checks);
  }

  function put(store, obj, opts) {
    opts = opts || {};
    derive(store, obj);
    var pre = opts.skipFk ? Promise.resolve() : checkFk(store, obj);
    return pre.then(function () {
      return open().then(function () {
        return new Promise(function (res, rej) {
          var tx = _db.transaction(store, 'readwrite');
          tx.objectStore(store).put(obj);
          tx.oncomplete = function () { res(obj); };
          tx.onerror = function () { rej(tx.error); };
          tx.onabort = function () { rej(tx.error); };
        });
      });
    });
  }

  /* Bulk write in one transaction — used by the seeder. Skips per-row FK checks
   * (the seed is internally consistent) for speed, but still derives indexes. */
  function bulkPut(store, arr) {
    if (!arr || !arr.length) return Promise.resolve(0);
    return open().then(function () {
      return new Promise(function (res, rej) {
        var tx = _db.transaction(store, 'readwrite'), os = tx.objectStore(store);
        arr.forEach(function (o) { os.put(derive(store, o)); });
        tx.oncomplete = function () { res(arr.length); };
        tx.onerror = function () { rej(tx.error); };
        tx.onabort = function () { rej(tx.error); };
      });
    });
  }

  function del(store, key) {
    return open().then(function () {
      return new Promise(function (res, rej) {
        var tx = _db.transaction(store, 'readwrite');
        tx.objectStore(store).delete(key);
        tx.oncomplete = function () { res(true); };
        tx.onerror = function () { rej(tx.error); };
      });
    });
  }

  function clearAll() {
    return open().then(function () {
      var names = Object.keys(S.stores);
      return new Promise(function (res, rej) {
        var tx = _db.transaction(names, 'readwrite');
        names.forEach(function (n) { tx.objectStore(n).clear(); });
        tx.oncomplete = function () { res(true); };
        tx.onerror = function () { rej(tx.error); };
      });
    });
  }

  function deleteDatabase() {
    if (_db) { _db.close(); _db = null; }
    return new Promise(function (res) { var r = indexedDB.deleteDatabase(S.name); r.onsuccess = r.onerror = function () { res(true); }; });
  }

  return { open: open, all: all, get: get, by: by, first: first, where: where, count: count,
           put: put, bulkPut: bulkPut, del: del, clearAll: clearAll, deleteDatabase: deleteDatabase, derive: derive };
})();
