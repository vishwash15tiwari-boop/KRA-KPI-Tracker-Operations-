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
