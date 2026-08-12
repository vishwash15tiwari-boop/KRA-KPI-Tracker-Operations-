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
