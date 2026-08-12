/**
 * gas-harness.js — Runs the Apps Script server code under Node.
 *
 * The application is deployed to Google Apps Script, which has no test runner.
 * This harness supplies in-memory implementations of the platform services the
 * server code touches (SpreadsheetApp, PropertiesService, LockService, Session,
 * Utilities) so the calculation engine can be exercised against the real data
 * exported from the source workbook.
 *
 * It is a faithful-enough mock: values round-trip through a two-dimensional
 * array exactly as Sheets does, including Date objects and the blank-string
 * representation of an empty cell.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SERVER_DIR = path.join(__dirname, '..', 'src', 'server');

/* -------------------------------------------------------- Sheets mock --- */

class MockRange {
  constructor(sheet, row, col, numRows, numCols) {
    Object.assign(this, { sheet, row, col, numRows, numCols });
  }
  getValues() {
    const out = [];
    for (let r = 0; r < this.numRows; r++) {
      const line = [];
      for (let c = 0; c < this.numCols; c++) {
        line.push(this.sheet._get(this.row + r, this.col + c));
      }
      out.push(line);
    }
    return out;
  }
  setValues(values) {
    values.forEach((line, r) => line.forEach((v, c) => {
      this.sheet._set(this.row + r, this.col + c, v);
    }));
    return this;
  }
  setValue(v) { this.sheet._set(this.row, this.col, v); return this; }
  getValue() { return this.sheet._get(this.row, this.col); }
  // Formatting is a no-op in the harness.
  setBackground() { return this; }
  setFontColor() { return this; }
  setFontWeight() { return this; }
  setVerticalAlignment() { return this; }
  setWrap() { return this; }
  setNumberFormat() { return this; }
  protect() { return { setDescription: () => ({ setWarningOnly: () => ({}) }) }; }
}

class MockSheet {
  constructor(name) {
    this.name = name;
    this.cells = new Map();          // "r,c" → value
    this.maxRow = 1000;
    this.maxCol = 60;
    this.sheetId = Math.floor(Math.random() * 1e9);
  }
  _key(r, c) { return r + ',' + c; }
  _get(r, c) {
    const v = this.cells.get(this._key(r, c));
    return v === undefined ? '' : v;
  }
  _set(r, c, v) {
    if (v === '' || v === null || v === undefined) this.cells.delete(this._key(r, c));
    else this.cells.set(this._key(r, c), v);
    if (r > this.maxRow) this.maxRow = r;
    if (c > this.maxCol) this.maxCol = c;
  }
  getName() { return this.name; }
  getSheetId() { return this.sheetId; }
  isSheetHidden() { return false; }
  getRange(row, col, numRows = 1, numCols = 1) {
    return new MockRange(this, row, col, numRows, numCols);
  }
  getLastRow() {
    let last = 0;
    for (const k of this.cells.keys()) last = Math.max(last, Number(k.split(',')[0]));
    return last;
  }
  getLastColumn() {
    let last = 0;
    for (const k of this.cells.keys()) last = Math.max(last, Number(k.split(',')[1]));
    return last;
  }
  getMaxRows() { return Math.max(this.maxRow, this.getLastRow() + 50); }
  getMaxColumns() { return Math.max(this.maxCol, this.getLastColumn() + 5); }
  insertRowsAfter() { return this; }
  insertColumnsAfter() { return this; }
  deleteRow(row) {
    const next = new Map();
    for (const [k, v] of this.cells) {
      const [r, c] = k.split(',').map(Number);
      if (r === row) continue;
      next.set((r > row ? r - 1 : r) + ',' + c, v);
    }
    this.cells = next;
  }
  setFrozenRows() { return this; }
  setRowHeight() { return this; }
  setColumnWidth() { return this; }
  autoResizeColumns() { return this; }
  getProtections() { return []; }
}

class MockSpreadsheet {
  constructor(id, name) { this.id = id; this.name_ = name; this.sheets = []; }
  getId() { return this.id; }
  getName() { return this.name_ || 'OMP Tracker (test)'; }
  getUrl() { return 'https://docs.google.com/spreadsheets/d/' + this.id + '/edit'; }
  getSheets() { return this.sheets; }
  getSheetByName(name) { return this.sheets.find(s => s.name === name) || null; }
  insertSheet(name) {
    const s = new MockSheet(name);
    this.sheets.push(s);
    return s;
  }
}

/* ------------------------------------------------------------ Sandbox --- */

function createEnvironment(options = {}) {
  const spreadsheet = new MockSpreadsheet(options.spreadsheetId || 'TEST_DB');
  const createdSpreadsheets = [];   // spreadsheets made via SpreadsheetApp.create()
  const properties = new Map();
  const userEmail = options.userEmail || 'lead@omp.test';
  const now = options.now ? new Date(options.now) : new Date();

  const RealDate = Date;
  class FrozenDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(now.getTime());
      else super(...args);
    }
    static now() { return now.getTime(); }
  }

  const sandbox = {
    console,
    Date: options.now ? FrozenDate : Date,
    Math, JSON, Object, Array, String, Number, Boolean, RegExp, Error, isFinite, isNaN,
    parseInt, parseFloat, encodeURIComponent, decodeURIComponent,

    SpreadsheetApp: {
      openById: (id) => {
        const found = [spreadsheet, ...createdSpreadsheets].find(s => s.id === id);
        if (!found) throw new Error('No spreadsheet with id ' + id);
        return found;
      },
      // options.standalone simulates a script with no bound container — the
      // situation a fresh standalone web app deployment is in before its
      // first Setup run.
      getActiveSpreadsheet: () => (options.standalone ? null : spreadsheet),
      create: (name) => {
        const created = new MockSpreadsheet('CREATED_' + (createdSpreadsheets.length + 1), name);
        createdSpreadsheets.push(created);
        return created;
      },
      flush: () => { },
      ProtectionType: { RANGE: 'RANGE' },
      getUi: () => { throw new Error('No UI in the harness'); }
    },

    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (k) => (properties.has(k) ? properties.get(k) : null),
        setProperty: (k, v) => { properties.set(k, String(v)); },
        deleteProperty: (k) => { properties.delete(k); }
      })
    },

    LockService: {
      getDocumentLock: () => ({ tryLock: () => true, releaseLock: () => { } })
    },

    Session: {
      getActiveUser: () => ({ getEmail: () => userEmail }),
      getEffectiveUser: () => ({ getEmail: () => userEmail })
    },

    Utilities: {
      formatDate(date, tz, format) {
        const d = new RealDate(date);
        const pad = (n, w = 2) => String(n).padStart(w, '0');
        const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
          'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
        return format
          .replace(/yyyy/g, d.getFullYear())
          .replace(/MMMM/g, ['January', 'February', 'March', 'April', 'May', 'June', 'July',
            'August', 'September', 'October', 'November', 'December'][d.getMonth()])
          .replace(/MMM/g, months[d.getMonth()])
          .replace(/MM/g, pad(d.getMonth() + 1))
          .replace(/dd/g, pad(d.getDate()))
          .replace(/EEE/g, days[d.getDay()])
          .replace(/HH/g, pad(d.getHours()))
          .replace(/mm/g, pad(d.getMinutes()))
          .replace(/ss/g, pad(d.getSeconds()))
          .replace(/yy/g, pad(d.getFullYear() % 100))
          .replace(/'/g, '');
      },
      getUuid: () => 'uuid-' + Math.random().toString(36).slice(2)
    },

    ScriptApp: {
      getProjectTriggers: () => [],
      deleteTrigger: () => { },
      newTrigger: () => ({
        timeBased: () => ({
          atHour: () => ({ everyDays: () => ({ inTimezone: () => ({ create: () => { } }) }) })
        })
      }),
      getService: () => ({ getUrl: () => 'https://script.google.com/macros/s/TEST/exec' })
    },

    MailApp: { sendEmail: () => { } },
    HtmlService: {
      createTemplateFromFile: () => ({ evaluate: () => ({}) }),
      createHtmlOutputFromFile: () => ({ getContent: () => '' })
    }
  };
  sandbox.globalThis = sandbox;

  const context = vm.createContext(sandbox);

  fs.readdirSync(SERVER_DIR)
    .filter(f => f.endsWith('.gs'))
    .sort()
    .forEach(file => {
      const code = fs.readFileSync(path.join(SERVER_DIR, file), 'utf8');
      try {
        vm.runInContext(code, context, { filename: file });
      } catch (e) {
        throw new Error('Failed loading ' + file + ': ' + e.message);
      }
    });

  return { sandbox, spreadsheet, properties, createdSpreadsheets };
}

module.exports = { createEnvironment, MockSpreadsheet, MockSheet };
