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
