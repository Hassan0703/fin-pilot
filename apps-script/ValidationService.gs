/**
 * FinPilot v0 — Validation Service (domain invariants).
 *
 * Business rules are declared in the `validation_rules` table (the rule repository)
 * and enforced here at the aggregate boundary. Nothing invalid reaches the ledger.
 *
 * Rule semantics (per spec):
 *   EXPENSE  → requires category + account, rejects destination account
 *   INCOME   → requires income source + account, rejects from account
 *   TRANSFER → requires from + to account, rejects same account
 *   All      → reject zero/negative amount, invalid date, unknown references
 */

var DEFAULT_VALIDATION_RULES = [
  ["TRANSACTION", "EXPENSE_REQUIRES_CATEGORY", "ERROR", "Expense transactions require a category_id.", '{"type":"EXPENSE"}'],
  ["TRANSACTION", "EXPENSE_REQUIRES_ACCOUNT", "ERROR", "Expense transactions require an account_id.", '{"type":"EXPENSE"}'],
  ["TRANSACTION", "EXPENSE_REJECTS_DESTINATION", "ERROR", "Expense transactions must not carry a to_account_id.", '{"type":"EXPENSE"}'],
  ["TRANSACTION", "EXPENSE_REJECTS_TRANSFER_FIELDS", "ERROR", "Expense transactions must not carry from_account_id or income_source_id.", '{"type":"EXPENSE"}'],
  ["TRANSACTION", "INCOME_REQUIRES_SOURCE", "ERROR", "Income transactions require an income_source_id.", '{"type":"INCOME"}'],
  ["TRANSACTION", "INCOME_REQUIRES_ACCOUNT", "ERROR", "Income transactions require an account_id.", '{"type":"INCOME"}'],
  ["TRANSACTION", "INCOME_REJECTS_FROM", "ERROR", "Income transactions must not carry a from_account_id.", '{"type":"INCOME"}'],
  ["TRANSACTION", "INCOME_REJECTS_CATEGORY", "ERROR", "Income transactions must not carry a category_id.", '{"type":"INCOME"}'],
  ["TRANSACTION", "TRANSFER_REQUIRES_SOURCE", "ERROR", "Transfers require a from_account_id.", '{"type":"TRANSFER"}'],
  ["TRANSACTION", "TRANSFER_REQUIRES_DESTINATION", "ERROR", "Transfers require a to_account_id.", '{"type":"TRANSFER"}'],
  ["TRANSACTION", "TRANSFER_REJECTS_SAME_ACCOUNT", "ERROR", "Transfers must move money between two different accounts.", '{"type":"TRANSFER"}'],
  ["TRANSACTION", "TRANSFER_REJECTS_EXTRA_FIELDS", "ERROR", "Transfers must not carry account_id, category_id or income_source_id.", '{"type":"TRANSFER"}'],
   ["TRANSACTION", "AMOUNT_POSITIVE", "ERROR", "Amount must be greater than zero.", '{}'],
   ["TRANSACTION", "AMOUNT_NOT_ZERO", "ERROR", "Amount must not be zero.", '{}'],
   ["TRANSACTION", "AMOUNT_INVALID", "ERROR", "Amount/currency must form a valid Money value.", '{}'],
   ["TRANSACTION", "DATE_VALID", "ERROR", "Date must be a valid calendar date.", '{}'],
   ["TRANSACTION", "TIMESTAMP_VALID", "ERROR", "transaction_ts must be a valid ISO-8601 timestamp.", '{}'],
   ["TRANSACTION", "SOURCE_KNOWN", "ERROR", "source must be a known entry point (SHORTCUT, API, SYSTEM, IMPORT).", '{}'],
   ["TRANSACTION", "CATEGORY_EXISTS", "ERROR", "category_id must reference an active category.", '{}'],
   ["TRANSACTION", "ACCOUNT_EXISTS", "ERROR", "account_id must reference an active account.", '{}'],
   ["TRANSACTION", "INCOME_SOURCE_EXISTS", "ERROR", "income_source_id must reference an active income source.", '{}'],
   ["TRANSACTION", "CURRENCY_KNOWN", "ERROR", "currency must exist in the currency lookup.", '{}'],
   ["TRANSACTION", "TYPE_KNOWN", "ERROR", "type must be EXPENSE, INCOME or TRANSFER.", '{}'],
   ["TRANSACTION", "UNKNOWN_FIELD_REJECTED", "ERROR", "Payload contains a field that is not part of the transaction schema.", '{}']
];

/**
 * Request-level fields accepted alongside transaction fields. These live on the
 * API body and must not trip UNKNOWN_FIELD_REJECTED.
 */
var TX_FIELD_WHITELIST = [
  "action", "token", "client", "type", "amount", "currency", "date",
  "transaction_ts", "account_id", "from_account_id", "to_account_id",
  "category_id", "income_source_id", "merchant", "note", "tags",
  "external_ref", "source", "dry_run", "force"
];

var TX_SOURCE_WHITELIST = ["SHORTCUT", "API", "SYSTEM", "IMPORT"];

/** Result of validation: {valid:boolean, errors:[], warnings:[]} */
function ValidationResult() {
  this.errors = [];
  this.warnings = [];
  this.valid = true;
}
ValidationResult.prototype.addError = function (rule, message) {
  this.valid = false;
  this.errors.push({ rule: rule, message: message, severity: "ERROR" });
};
ValidationResult.prototype.addWarning = function (rule, message) {
  this.warnings.push({ rule: rule, message: message, severity: "WARN" });
};

var ValidationService = {
  /** Ensures the rule repository is seeded. */
  ensureDefaults: function () {
    var existing = {};
    readTable("validation_rules").forEach(function (r) { existing[r.rule_code] = true; });
    DEFAULT_VALIDATION_RULES.forEach(function (d) {
      if (existing[d[1]]) return;
      appendRow("validation_rules", {
        rule_id: IdGenerator.rule(),
        entity: d[0],
        rule_code: d[1],
        severity: d[2],
        description: d[3],
        applies_when: d[4],
        params_json: "",
        is_active: true,
        created_at: isoNow(),
        updated_at: isoNow()
      });
    });
  },

  /** Whether a rule is active in the repository. */
  ruleActive: function (ruleCode) {
    var rows = readTable("validation_rules");
    for (var i = 0; i < rows.length; i++) {
      if (String(rows[i].rule_code) === ruleCode) {
        return isTrue(rows[i].is_active);
      }
    }
    return true; // unknown rules default to enforced
  },

  /** List of active rule codes. */
  activeRules: function () {
    return readTable("validation_rules")
      .filter(function (r) { return isTrue(r.is_active); })
      .map(function (r) { return String(r.rule_code); });
  },

  /**
   * Validates a transaction payload against all business rules.
   * @param {Object} t raw payload
   * @return {ValidationResult}
   */
  validateTransaction: function (t) {
    var result = new ValidationResult();
    var type = String(t.type || "").toUpperCase();

    // structural / reference caches (single reads per request)
    var accounts = masterIds("accounts");
    var categories = masterIds("categories");
    var sources = masterIds("income_sources");

    // -- cross-cutting rules ----------------------------------------------
    if (ValidationService.ruleActive("TYPE_KNOWN") && TX_TYPES.indexOf(type) < 0) {
      result.addError("TYPE_KNOWN", "type must be EXPENSE, INCOME or TRANSFER (got '" + type + "').");
    }
    var money = null;
    try {
      money = new Money(t.amount, t.currency || SettingsService.getRaw("base_currency"));
    } catch (err) {
      result.addError("AMOUNT_INVALID", "amount/currency invalid: " + err.message);
    }
    if (money) {
      if (ValidationService.ruleActive("AMOUNT_NOT_ZERO") && money.isZero()) {
        result.addError("AMOUNT_NOT_ZERO", "amount must not be zero.");
      }
      if (ValidationService.ruleActive("AMOUNT_POSITIVE") && money.isNegative()) {
        result.addError("AMOUNT_POSITIVE", "amount must be positive (got " + money.amount + ").");
      }
    }
    if (ValidationService.ruleActive("CURRENCY_KNOWN")) {
      var cur = t.currency || SettingsService.getRaw("base_currency");
      if (!LookupService.has("currency", cur)) {
        result.addError("CURRENCY_KNOWN", "unknown currency '" + cur + "'.");
      }
    }
    if (ValidationService.ruleActive("DATE_VALID")) {
      try {
        var d = t.date ? normalizeDate(t.date) : todayStamp();
        t.__date = d;
      } catch (err) {
        result.addError("DATE_VALID", err.message);
      }
    }
    if (ValidationService.ruleActive("TIMESTAMP_VALID") &&
        t.transaction_ts != null && String(t.transaction_ts) !== "") {
      try {
        normalizeIso(t.transaction_ts);
      } catch (err) {
        result.addError("TIMESTAMP_VALID", err.message);
      }
    }
    if (ValidationService.ruleActive("SOURCE_KNOWN") &&
        t.source != null && String(t.source).trim() !== "") {
      if (TX_SOURCE_WHITELIST.indexOf(String(t.source).toUpperCase()) < 0) {
        result.addError("SOURCE_KNOWN",
          "Unknown source '" + t.source + "'. Allowed: " + TX_SOURCE_WHITELIST.join(", ") + ".");
      }
    }
    if (ValidationService.ruleActive("UNKNOWN_FIELD_REJECTED")) {
      Object.keys(t).forEach(function (k) {
        if (k.indexOf("__") === 0) return; // internal markers
        if (TX_FIELD_WHITELIST.indexOf(k) < 0) {
          result.addError("UNKNOWN_FIELD_REJECTED",
            "Unknown field '" + k + "' is not part of the transaction schema.");
        }
      });
    }

    // -- type-specific rules ----------------------------------------------
    if (type === "EXPENSE") {
      if (ValidationService.ruleActive("EXPENSE_REQUIRES_CATEGORY") && !t.category_id) {
        result.addError("EXPENSE_REQUIRES_CATEGORY", "Expense requires a category_id.");
      }
      if (ValidationService.ruleActive("EXPENSE_REQUIRES_ACCOUNT") && !t.account_id) {
        result.addError("EXPENSE_REQUIRES_ACCOUNT", "Expense requires an account_id.");
      }
      if (ValidationService.ruleActive("EXPENSE_REJECTS_DESTINATION") && t.to_account_id) {
        result.addError("EXPENSE_REJECTS_DESTINATION", "Expense must not set to_account_id.");
      }
      if (ValidationService.ruleActive("EXPENSE_REJECTS_TRANSFER_FIELDS") &&
          (t.from_account_id || t.income_source_id)) {
        result.addError("EXPENSE_REJECTS_TRANSFER_FIELDS",
          "Expense must not set from_account_id or income_source_id.");
      }
      if (ValidationService.ruleActive("CATEGORY_EXISTS") && t.category_id &&
          categories.indexOf(String(t.category_id)) < 0) {
        result.addError("CATEGORY_EXISTS", "Unknown category_id '" + t.category_id + "'.");
      }
    } else if (type === "INCOME") {
      if (ValidationService.ruleActive("INCOME_REQUIRES_SOURCE") && !t.income_source_id) {
        result.addError("INCOME_REQUIRES_SOURCE", "Income requires an income_source_id.");
      }
      if (ValidationService.ruleActive("INCOME_REQUIRES_ACCOUNT") && !t.account_id) {
        result.addError("INCOME_REQUIRES_ACCOUNT", "Income requires an account_id.");
      }
      if (ValidationService.ruleActive("INCOME_REJECTS_FROM") && t.from_account_id) {
        result.addError("INCOME_REJECTS_FROM", "Income must not set from_account_id.");
      }
      if (ValidationService.ruleActive("INCOME_REJECTS_CATEGORY") && t.category_id) {
        result.addError("INCOME_REJECTS_CATEGORY", "Income must not set category_id.");
      }
      if (ValidationService.ruleActive("INCOME_SOURCE_EXISTS") && t.income_source_id &&
          sources.indexOf(String(t.income_source_id)) < 0) {
        result.addError("INCOME_SOURCE_EXISTS", "Unknown income_source_id '" + t.income_source_id + "'.");
      }
    } else if (type === "TRANSFER") {
      if (ValidationService.ruleActive("TRANSFER_REQUIRES_SOURCE") && !t.from_account_id) {
        result.addError("TRANSFER_REQUIRES_SOURCE", "Transfer requires a from_account_id.");
      }
      if (ValidationService.ruleActive("TRANSFER_REQUIRES_DESTINATION") && !t.to_account_id) {
        result.addError("TRANSFER_REQUIRES_DESTINATION", "Transfer requires a to_account_id.");
      }
      if (ValidationService.ruleActive("TRANSFER_REJECTS_SAME_ACCOUNT") &&
          t.from_account_id && t.to_account_id && String(t.from_account_id) === String(t.to_account_id)) {
        result.addError("TRANSFER_REJECTS_SAME_ACCOUNT",
          "Transfer source and destination must differ.");
      }
      if (ValidationService.ruleActive("TRANSFER_REJECTS_EXTRA_FIELDS") &&
          (t.account_id || t.category_id || t.income_source_id)) {
        result.addError("TRANSFER_REJECTS_EXTRA_FIELDS",
          "Transfer must not set account_id, category_id or income_source_id.");
      }
    } else {
      result.addError("TYPE_KNOWN", "Cannot validate unknown type '" + type + "'.");
    }

    // -- account existence for any account-bearing field ------------------
    if (ValidationService.ruleActive("ACCOUNT_EXISTS")) {
      ["account_id", "from_account_id", "to_account_id"].forEach(function (f) {
        if (t[f] && accounts.indexOf(String(t[f])) < 0) {
          result.addError("ACCOUNT_EXISTS", "Unknown account_id '" + t[f] + "' (field " + f + ").");
        }
      });
    }

    return result;
  }
};

/** Active IDs for a master table (used by validation + duplicate detection). */
var MASTER_ID_COL = {
  accounts: "account_id",
  categories: "category_id",
  income_sources: "income_source_id"
};
function masterIds(table) {
  var idCol = MASTER_ID_COL[table];
  if (!idCol) throw new Error("No id column mapped for " + table);
  return readTable(table)
    .filter(function (r) { return String(r.status).toUpperCase() !== "ARCHIVED"; })
    .map(function (r) { return String(r[idCol]); });
}
