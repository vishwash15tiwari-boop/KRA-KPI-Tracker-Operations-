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
