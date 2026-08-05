/**
 * FinPilot v0 — Settings Service (configuration aggregate).
 *
 * Every configurable value lives here — nothing is hardcoded.
 * Keys: base_currency, country, theme, fiscal_year_start, budget_alert_threshold,
 * duplicate_window_minutes, timezone, api_token_hash, schema_version, api_version, ...
 */

var DEFAULT_SETTINGS = [
  { key: "database_id", value: "", value_type: "STRING", description: "Spreadsheet id this workbook lives in (leave blank when container-bound).", is_secret: false },
  { key: "base_currency", value: "USD", value_type: "STRING", description: "ISO-4217 reporting currency.", is_secret: false },
  { key: "country", value: "US", value_type: "STRING", description: "ISO-3166 country code.", is_secret: false },
  { key: "theme", value: "dark", value_type: "STRING", description: "Dashboard theme: dark | light.", is_secret: false },
  { key: "fiscal_year_start", value: "01", value_type: "STRING", description: "Fiscal year start month (01-12).", is_secret: false },
  { key: "budget_alert_threshold", value: "0.8", value_type: "NUMBER", description: "Fraction of budget used that triggers a WARNING.", is_secret: false },
  { key: "budget_over_threshold", value: "1.0", value_type: "NUMBER", description: "Fraction that triggers an OVER warning.", is_secret: false },
  { key: "duplicate_window_minutes", value: "2880", value_type: "NUMBER", description: "Duplicate-detection window (2880 = 48h).", is_secret: false },
  { key: "timezone", value: "UTC", value_type: "STRING", description: "Timezone used for business dates.", is_secret: false },
  { key: "emergency_fund_months_target", value: "3", value_type: "NUMBER", description: "Months of expenses to hold as an emergency fund.", is_secret: false },
  { key: "savings_rate_target", value: "0.10", value_type: "NUMBER", description: "Target savings rate for scoring.", is_secret: false },
  { key: "burn_rate_months", value: "3", value_type: "NUMBER", description: "Trailing months used to compute burn rate.", is_secret: false },
  { key: "analytics_retention_months", value: "36", value_type: "NUMBER", description: "How many months of analytics to retain.", is_secret: false },
  { key: "burn_rate_ratio_target", value: "0.5", value_type: "NUMBER", description: "Score target: monthly burn vs income (lower is better).", is_secret: false },
  { key: "debt_ratio_target", value: "0.36", value_type: "NUMBER", description: "Score target: debt service vs income (lower is better).", is_secret: false },
  { key: "net_worth_growth_target", value: "0.05", value_type: "NUMBER", description: "Score target: 6-month net worth growth.", is_secret: false },
  { key: "expense_control_target", value: "0.8", value_type: "NUMBER", description: "Score target: expense vs budget ratio (higher budget adherence = better).", is_secret: false },
  { key: "invested_ratio_target", value: "0.25", value_type: "NUMBER", description: "Roadmap: invested share of net worth to reach INVESTMENT stage.", is_secret: false },
  { key: "api_token_hash", value: "", value_type: "STRING", description: "SHA-256 of API bearer token. Empty = open API.", is_secret: true },
  { key: "schema_version", value: "1.0.0", value_type: "STRING", description: "Schema version of this workbook.", is_secret: false },
  { key: "api_version", value: "1.0.0", value_type: "STRING", description: "API version.", is_secret: false },
  { key: "ai_coach_enabled", value: "false", value_type: "BOOL", description: "Enable AI coaching remarks in the score sheet.", is_secret: false }
];

var SettingsService = {
  /** Ensure settings rows exist with defaults. Idempotent. */
  ensureDefaults: function () {
    var existing = {};
    readTable("settings").forEach(function (r) { existing[r.key] = r; });
    DEFAULT_SETTINGS.forEach(function (s) {
      if (!existing[s.key]) {
        appendRow("settings", {
          key: s.key, value: s.value, value_type: s.value_type,
          description: s.description, is_secret: s.is_secret,
          updated_at: isoNow()
        });
      }
    });
  },

  /** Raw string value for a key ('' when missing). */
  getRaw: function (key) {
    var rows = readTable("settings");
    for (var i = 0; i < rows.length; i++) {
      if (String(rows[i].key) === key) return String(rows[i].value);
    }
    return "";
  },

  /** Typed value for a key (string|number|boolean|null). */
  get: function (key) {
    var rows = readTable("settings");
    for (var i = 0; i < rows.length; i++) {
      if (String(rows[i].key) !== key) continue;
      var t = String(rows[i].value_type).toUpperCase();
      var v = rows[i].value;
      if (t === "NUMBER") { var n = Number(v); return isFinite(n) ? n : 0; }
      if (t === "BOOL") return String(v).toLowerCase() === "true";
      return String(v);
    }
    return null;
  },

  /** Set a key. Upserts by key. Serialized under the script lock. */
  set: function (key, value, valueType, description, isSecret) {
    return withLock(function () {
      var row = findRow("settings", "key", key);
      var rec = {
        key: key,
        value: String(value),
        value_type: valueType || (typeof value === "number" ? "NUMBER" : typeof value === "boolean" ? "BOOL" : "STRING"),
        description: description || "",
        is_secret: !!isSecret,
        updated_at: isoNow()
      };
      if (row) {
        updateRow("settings", row, rec);
      } else {
        appendRow("settings", rec);
      }
      return rec;
    });
  },

  /** All settings (secrets masked). */
  all: function () {
    return readTable("settings").map(function (r) {
      var o = {};
      Object.keys(r).forEach(function (k) { o[k] = r[k]; });
      if (o.is_secret && String(o.value)) o.value = "****";
      return o;
    });
  },

  apiGet: function (body) {
    if (body.key) {
      var rows = readTable("settings");
      for (var i = 0; i < rows.length; i++) {
        if (String(rows[i].key) === String(body.key)) {
          if (isTrue(rows[i].is_secret) && rows[i].value != null && String(rows[i].value) !== "") {
            return { data: { key: String(body.key), value: "****" } };
          }
          return { data: { key: String(body.key), value: SettingsService.get(body.key) } };
        }
      }
      return { data: { key: String(body.key), value: SettingsService.get(body.key) } };
    }
    return { data: SettingsService.all() };
  },

  apiSet: function (body) {
    if (!body.key) throw new Error("settings.set requires 'key'.");
    var key = String(body.key);
    if (key === "api_token_hash") throw new Error("Use the dedicated token rotation endpoint.");
    var rec = SettingsService.set(key, body.value, body.value_type, body.description, body.is_secret);
    return { data: { key: rec.key, value: rec.is_secret ? "****" : rec.value } };
  }
};
