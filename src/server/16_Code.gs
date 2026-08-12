/**
 * 16_Code.gs — Web app entry point, spreadsheet menu and scheduled jobs.
 */

/** Serve the single-page application. */
function doGet(e) {
  var template = HtmlService.createTemplateFromFile('Index');
  template.initialRoute = (e && e.parameter && e.parameter.route) || '';
  return template.evaluate()
    .setTitle(APP.NAME)
    .setFaviconUrl('https://ssl.gstatic.com/docs/spreadsheets/forms/favicon_qp2.png')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/** Server-side partial include, used to compose the client bundle. */
function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

/** Menu inside the backend spreadsheet, for administrators. */
function onOpen() {
  try {
    SpreadsheetApp.getUi()
      .createMenu('⚙️ ' + APP.SHORT_NAME)
      .addItem('Open application', 'showAppSidebar')
      .addSeparator()
      .addItem('Run setup / migrate schema', 'menuSetup')
      .addItem('Install scheduled jobs', 'menuInstallTriggers')
      .addSeparator()
      .addItem('Sync source data now', 'menuSyncAll')
      .addItem('Take daily snapshot', 'menuSnapshot')
      .addSeparator()
      .addItem('Health check', 'menuHealth')
      .addToUi();
  } catch (e) {
    // onOpen also fires in contexts without a UI; nothing to do there.
  }
}

function showAppSidebar() {
  var url = ScriptApp.getService().getUrl();
  var html = HtmlService.createHtmlOutput(
    '<div style="font:14px/1.6 system-ui,-apple-system,sans-serif;padding:16px">' +
    '<h3 style="margin:0 0 8px">' + APP.NAME + '</h3>' +
    (url
      ? '<p>Open the application in a new tab:</p><p><a href="' + url +
      '" target="_blank" rel="noopener">' + url + '</a></p>'
      : '<p>Deploy this project as a web app first (Deploy → New deployment → Web app).</p>') +
    '</div>')
    .setTitle(APP.SHORT_NAME);
  SpreadsheetApp.getUi().showSidebar(html);
}

function menuSetup() {
  var ui = SpreadsheetApp.getUi();
  try {
    var result = Bootstrap.setup({});
    ui.alert('Setup complete',
      'Schema version ' + result.schemaVersion + '.\n' +
      'Created: ' + (result.created.join(', ') || 'none') + '\n' +
      'Migrated: ' + (result.migrated.join(', ') || 'none'),
      ui.ButtonSet.OK);
  } catch (e) {
    ui.alert('Setup failed', String(e.message || e), ui.ButtonSet.OK);
  }
}

function menuInstallTriggers() {
  var ui = SpreadsheetApp.getUi();
  try {
    var r = Bootstrap.installTriggers();
    ui.alert('Scheduled jobs installed', r.installed.join('\n'), ui.ButtonSet.OK);
  } catch (e) {
    ui.alert('Could not install jobs', String(e.message || e), ui.ButtonSet.OK);
  }
}

function menuSyncAll() {
  var ui = SpreadsheetApp.getUi();
  try {
    var r = Sync.syncAll({});
    var lines = ['onboarding', 'shipments', 'pulse'].map(function (k) {
      var s = r[k];
      return k + ': ' + s.status + ' — read ' + s.rowsRead +
        ', inserted ' + s.rowsInserted + ', updated ' + s.rowsUpdated;
    });
    ui.alert('Sync finished', lines.join('\n'), ui.ButtonSet.OK);
  } catch (e) {
    ui.alert('Sync failed', String(e.message || e), ui.ButtonSet.OK);
  }
}

function menuSnapshot() {
  var ui = SpreadsheetApp.getUi();
  try {
    var cycle = Planning.activeCycle();
    if (!cycle) { ui.alert('No active cycle to snapshot.'); return; }
    var r = Dashboard.takeSnapshot(cycle.cycleId);
    ui.alert('Snapshot taken', r.rows + ' metric rows for ' + r.date, ui.ButtonSet.OK);
  } catch (e) {
    ui.alert('Snapshot failed', String(e.message || e), ui.ButtonSet.OK);
  }
}

function menuHealth() {
  var ui = SpreadsheetApp.getUi();
  var h = Bootstrap.health();
  var counts = Object.keys(h.rowCounts || {})
    .map(function (k) { return k + ': ' + h.rowCounts[k]; }).join('\n');
  ui.alert(h.ok ? 'Healthy' : 'Attention needed',
    'Schema version: ' + h.schemaVersion + ' (installed ' + h.installedVersion + ')\n' +
    (h.missingSheets.length ? 'Missing sheets: ' + h.missingSheets.join(', ') + '\n\n' : '\n') +
    counts, ui.ButtonSet.OK);
}

// ---------------------------------------------------------------------------
// Scheduled jobs
// ---------------------------------------------------------------------------

/** Nightly: pull the source workbooks so the morning dashboard is current. */
function jobNightlySync() {
  try {
    var result = Sync.syncAll({});
    console.log('Nightly sync: ' + JSON.stringify({
      onboarding: result.onboarding.status,
      shipments: result.shipments.status,
      pulse: result.pulse.status
    }));
  } catch (e) {
    console.error('Nightly sync failed: ' + e);
    Audit.log('JOB_SYNC', 'JOB', 'jobNightlySync', 'Nightly sync failed',
      null, null, false, String(e.message || e));
  }
}

/** Daily: freeze metric values so trends survive later fact corrections. */
function jobDailySnapshot() {
  try {
    CATEGORIES.forEach(function (category) {
      var cycle = Planning.activeCycle(category);
      if (!cycle || cycle.status === CYCLE_STATUS.DRAFT) return;
      var r = Dashboard.takeSnapshot(cycle.cycleId);
      console.log('Snapshot ' + category + ': ' + r.rows + ' rows for ' + r.date);
    });
  } catch (e) {
    console.error('Snapshot job failed: ' + e);
    Audit.log('JOB_SNAPSHOT', 'JOB', 'jobDailySnapshot', 'Snapshot failed',
      null, null, false, String(e.message || e));
  }
}

/**
 * Daily: email the people who own something that needs attention. Alerts are
 * grouped per owner so nobody receives seven separate messages.
 */
function jobDailyAlerts() {
  try {
    CATEGORIES.forEach(function (category) {
      var cycle = Planning.activeCycle(category);
      if (!cycle || cycle.status !== CYCLE_STATUS.PUBLISHED) return;

      var payload = Dashboard.alerts(cycle.cycleId, {});
      var byOwner = Util.groupBy(
        payload.alerts.filter(function (a) { return a.ownerUserId; }),
        function (a) { return a.ownerUserId; });

      Object.keys(byOwner).forEach(function (ownerId) {
        var owner = Repository.findById(SHEET.USERS, ownerId);
        if (!owner || !owner.email || owner.active === false) return;
        var mine = byOwner[ownerId];
        var p1 = mine.filter(function (a) { return a.severity === 'P1'; });
        if (!p1.length && mine.length < 3) return;   // do not nag over trivia

        var body = [
          'Good morning ' + (owner.fullName || '') + ',',
          '',
          cycle.label + ' — ' + mine.length + ' item(s) need your attention.',
          ''
        ];
        mine.slice(0, 15).forEach(function (a, i) {
          body.push((i + 1) + '. [' + a.severity + '] ' + a.title);
          if (a.detail) body.push('   ' + a.detail);
          if (a.nextStep) body.push('   Next: ' + a.nextStep);
          body.push('');
        });
        var url = ScriptApp.getService().getUrl();
        if (url) body.push('Open the tracker: ' + url);

        MailApp.sendEmail({
          to: owner.email,
          subject: '[' + APP.SHORT_NAME + '] ' + cycle.label + ' — ' +
            mine.length + ' item(s) need attention',
          body: body.join('\n')
        });
      });
      console.log('Alert emails sent for ' + category + ': ' + Object.keys(byOwner).length + ' owner(s)');
    });
  } catch (e) {
    console.error('Alert job failed: ' + e);
    Audit.log('JOB_ALERTS', 'JOB', 'jobDailyAlerts', 'Alert job failed',
      null, null, false, String(e.message || e));
  }
}

// ---------------------------------------------------------------------------
// One-off setup helper, runnable from the Apps Script editor
// ---------------------------------------------------------------------------

/**
 * Run once from the editor on a fresh project. Creates the schema, seeds the
 * KRA library and nominates the running account as the first administrator.
 */
function setupFirstRun() {
  var email = Session.getEffectiveUser().getEmail();
  PropertiesService.getScriptProperties().setProperty(PROP.BOOTSTRAP_ADMIN, email);
  var result = Bootstrap.setup({});
  Auth.current();                       // provisions the bootstrap administrator
  console.log('Setup complete: ' + JSON.stringify(result));
  console.log('Administrator: ' + email);
  return result;
}
