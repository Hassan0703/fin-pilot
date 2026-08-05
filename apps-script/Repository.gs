/**
 * FinPilot v0 — Repository layer (persistence adapter).
 *
 * Turns Google Sheets into a relational database:
 *   - a TABLE is a sheet
 *   - a RECORD is a row
 *   - a FIELD is a column
 *   - relationships are ID references
 *
 * The domain layer never touches sheets directly; it goes through this adapter.
 * Swapping this adapter = migrating to PostgreSQL (see docs/07-migration.md).
 */

/** Every table and its column schema. Header row is row 1; data starts at row 2. */
var TABLES = {
  transactions: {
    sheet: "transactions",
    cols: [
      "transaction_id", "transaction_ts", "date", "type", "amount", "currency",
      "account_id", "from_account_id", "to_account_id", "category_id",
      "income_source_id", "merchant", "note", "tags", "external_ref",
      "status", "source", "created_at", "updated_at"
    ]
  },
  accounts: {
    sheet: "accounts",
    cols: [
      "account_id", "name", "type", "currency", "opening_balance",
      "current_balance", "color", "icon", "status", "is_credit",
      "note", "created_date", "created_at"
    ]
  },
  categories: {
    sheet: "categories",
    cols: [
      "category_id", "parent_category_id", "name", "type", "icon",
      "color", "monthly_budget", "sort_order", "status", "created_at"
    ]
  },
  income_sources: {
    sheet: "income_sources",
    cols: [
      "income_source_id", "name", "type", "icon", "color",
      "sort_order", "status", "created_at"
    ]
  },
  budgets: {
    sheet: "budgets",
    cols: [
      "budget_id", "category_id", "period", "budget_amount",
      "currency", "status", "created_at"
    ]
  },
  goals: {
    sheet: "goals",
    cols: [
      "goal_id", "name", "goal_type", "target_amount", "currency",
      "linked_account_id", "current_amount", "deadline", "priority",
      "monthly_contribution", "projected_completion", "status", "created_at"
    ]
  },
  recurring: {
    sheet: "recurring",
    cols: [
      "recurring_id", "name", "type", "amount", "currency", "frequency",
      "day_of_month", "day_of_week", "start_date", "end_date",
      "next_run", "last_run", "account_id", "from_account_id",
      "to_account_id", "category_id", "income_source_id",
      "status", "created_at"
    ]
  },
  monthly_analytics: {
    sheet: "monthly_analytics",
    cols: [
      "analytics_id", "period", "metric", "dimension", "rank", "value", "generated_at"
    ]
  },
  financial_score: {
    sheet: "financial_score",
    cols: [
      "metric_code", "metric_name", "weight", "current_value",
      "target_value", "score", "status", "remarks", "updated_at"
    ]
  },
  roadmap: {
    sheet: "roadmap",
    cols: [
      "stage_id", "stage_order", "stage_name", "description",
      "requirement_rule", "status", "progress", "recommendation",
      "achieved_date", "updated_at"
    ]
  },
  settings: {
    sheet: "settings",
    cols: ["key", "value", "value_type", "description", "is_secret", "updated_at"]
  },
  audit_logs: {
    sheet: "audit_logs",
    cols: [
      "audit_id", "ts", "request_id", "endpoint", "method", "client",
      "payload_hash", "status", "response_code", "error",
      "record_id", "duplicate_of", "created_at"
    ]
  },
  lookups: {
    sheet: "lookups",
    cols: [
      "lookup_id", "lookup_group", "code", "label",
      "display_order", "is_active", "meta"
    ]
  },
  validation_rules: {
    sheet: "validation_rules",
    cols: [
      "rule_id", "entity", "rule_code", "severity", "description",
      "applies_when", "params_json", "is_active", "created_at", "updated_at"
    ]
  }
};

/** Business states. Everything else derives from these. */
var TX_STATUS_POSTED = "POSTED";
var TX_STATUS_VOID = "VOID";
var TX_STATUS_DUPLICATE = "DUPLICATE_SKIPPED";

var TX_TYPES = ["EXPENSE", "INCOME", "TRANSFER"];

/**
 * Coerces a cell value to a strict boolean. Sheets stores booleans natively
 * but also as "TRUE"/"FALSE" strings; never trust raw === comparisons.
 */
function isTrue(v) {
  if (typeof v === "boolean") return v;
  return String(v).toUpperCase() === "TRUE";
}

/**
 * Neutralizes spreadsheet formula injection at the persistence boundary.
 * The Sheets service evaluates any string written with setValue/appendRow that
 * starts with "=" as a FORMULA in the workbook owner's session; legacy Excel
 * "+"/"@" prefixes are treated the same when the file is opened elsewhere.
 * Prefixed values are stored and read back as literal text, exactly like the
 * CSV guard (csvCell) neutralizes them on export. Non-strings pass through
 * untouched so numeric/boolean cells are never altered.
 */
function guardFormula(v) {
  if (typeof v === "string" && /^[=+@]/.test(v)) return "'" + v;
  return v;
}

/**
 * Per-execution read cache. Apps Script runs each request in a fresh instance,
 * so a module-level cache can never go stale across requests. Any write to a
 * table invalidates its entry, keeping the cache correct within an execution.
 */
var __readCache = {};
function invalidateCache(table) {
  if (table && __readCache[table]) delete __readCache[table];
  else __readCache = {};
}

/**
 * Opens the workbook. Reads the id from Script Properties (set at bootstrap) so
 * there is no circular dependency back through the settings table. Falls back to
 * the active spreadsheet when container-bound.
 * @return {SpreadsheetApp.Spreadsheet}
 */
function openDb() {
  try {
    var id = PropertiesService.getScriptProperties().getProperty("database_id");
    if (id) return SpreadsheetApp.openById(id);
  } catch (e) {
    Logger.log("openDb by id failed: " + e.message);
  }
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (ss) return ss;
  throw new Error("Cannot resolve database spreadsheet. Set 'database_id'.");
}

/**
 * Resolves a table name -> Sheet object. Creates the sheet if missing.
 * @param {string} tableName
 * @return {GoogleAppsScript.Spreadsheet.Sheet}
 */
function tableSheet(tableName) {
  var def = TABLES[tableName];
  if (!def) throw new Error("Unknown table: " + tableName);
  var ss = openDb();
  var sheet = ss.getSheetByName(def.sheet);
  if (!sheet) sheet = ensureSheet(ss, def);
  return sheet;
}

/** Creates a sheet with the header row if it doesn't exist. Idempotent. */
function ensureSheet(ss, def) {
  var sheet = ss.getSheetByName(def.sheet);
  if (!sheet) {
    sheet = ss.insertSheet(def.sheet);
  }
  var header = sheet.getRange(1, 1, 1, def.cols.length);
  if (header.getValues()[0].join("") === "") {
    header.setValues([def.cols]);
  }
  return sheet;
}

/**
 * Reads an entire table into an array of objects keyed by column name.
 * @param {string} tableName
 * @param {boolean=} includeHeaders
 * @return {Array<Object>}
 */
function readTable(tableName) {
  if (__readCache[tableName]) return __readCache[tableName].slice();
  var def = TABLES[tableName];
  var sheet = tableSheet(tableName);
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    __readCache[tableName] = [];
    return [];
  }
  var width = def.cols.length;
  var values = sheet.getRange(2, 1, lastRow - 1, width).getValues();
  var rows = values.map(function (row) {
    var rec = {};
    def.cols.forEach(function (col, i) { rec[col] = row[i]; });
    return rec;
  });
  __readCache[tableName] = rows;
  return rows.slice();
}

/**
 * Appends one record to a table.
 * @param {string} tableName
 * @param {Object} rec
 * @return {number} row index appended
 */
function appendRow(tableName, rec) {
  var def = TABLES[tableName];
  var sheet = tableSheet(tableName);
  var values = def.cols.map(function (col) {
    var v = rec[col];
    return (v === undefined || v === null) ? "" : guardFormula(v);
  });
  sheet.appendRow(values);
  invalidateCache(tableName);
  return sheet.getLastRow();
}

/**
 * Writes an entire table's data block (rows 2..N) in one call.
 * @param {string} tableName
 * @param {Array<Array<*>>} matrix rows of values aligned to table columns
 */
function writeTableData(tableName, matrix) {
  var def = TABLES[tableName];
  var sheet = tableSheet(tableName);
  if (matrix.length === 0) return;
  var width = def.cols.length;
  var range = sheet.getRange(2, 1, matrix.length, width);
  range.setValues(matrix.map(function (row) { return row.map(guardFormula); }));
  invalidateCache(tableName);
}

/** Clears all data rows of a table (keeps header + formatting). */
function clearTableData(tableName) {
  var sheet = tableSheet(tableName);
  var lastRow = sheet.getLastRow();
  if (lastRow >= 2) sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).clearContent();
  invalidateCache(tableName);
}

/** Finds the first row index where a column equals a value (0 = not found). */
function findRow(tableName, col, value) {
  var def = TABLES[tableName];
  var sheet = tableSheet(tableName);
  var idx = def.cols.indexOf(col);
  if (idx < 0) throw new Error("Unknown column " + col + " in " + tableName);
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return 0;
  var values = sheet.getRange(2, idx + 1, lastRow - 1, 1).getValues();
  for (var r = 0; r < values.length; r++) {
    if (String(values[r][0]) === String(value)) return r + 2;
  }
  return 0;
}

/** Updates one cell of an existing record. */
function updateCell(tableName, row, col, value) {
  var def = TABLES[tableName];
  var sheet = tableSheet(tableName);
  var idx = def.cols.indexOf(col);
  if (idx < 0) throw new Error("Unknown column " + col + " in " + tableName);
  sheet.getRange(row, idx + 1).setValue(guardFormula(value));
  invalidateCache(tableName);
}

/**
 * Updates a whole row in a single write. Accepts a partial record: missing
 * columns are merged from the current row so nothing is blanked.
 */
function updateRow(tableName, row, rec) {
  var def = TABLES[tableName];
  var sheet = tableSheet(tableName);
  var cur = readTable(tableName).filter(function (r, i) { return i + 2 === row; })[0] || {};
  var values = def.cols.map(function (col) {
    var v = Object.prototype.hasOwnProperty.call(rec, col) ? rec[col] : cur[col];
    return (v === undefined || v === null) ? "" : guardFormula(v);
  });
  sheet.getRange(row, 1, 1, def.cols.length).setValues([values]);
  invalidateCache(tableName);
  return row;
}

/** Count of data rows in a table. */
function tableCount(tableName) {
  var sheet = tableSheet(tableName);
  var n = sheet.getLastRow();
  return n > 1 ? n - 1 : 0;
}
