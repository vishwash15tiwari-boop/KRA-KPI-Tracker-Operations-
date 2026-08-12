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
