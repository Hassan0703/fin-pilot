/**
 * FinPilot v0 — REST API entry points.
 *
 * Google Sheets is the DATABASE. This file is the HTTP boundary.
 * All requests are authenticated, routed, executed, audited and answered as JSON.
 *
 * @fileoverview doGet / doPost + ApiRouter + response envelope + EventBus.
 */

var API_VERSION = "1.0.0";
var SCHEMA_VERSION = "1.0.0";

/** @typedef {{action:string, token?:string, ...}} FinPilot.ApiRequest */

/**
 * GET handler (used by Shortcuts for read-only actions and health checks).
 * Query params mirror the POST body.
 * @param {Object} e
 * @return {GoogleAppsScript.Content.TextOutput}
 */
function doGet(e) {
  var params = e && e.parameter ? e.parameter : {};
  var body = {};
  Object.keys(params).forEach(function (k) { body[k] = params[k]; });
  return handleRequest(body, "GET");
}

/**
 * POST handler — primary entry for iPhone Shortcuts.
 * @param {Object} e
 * @return {GoogleAppsScript.Content.TextOutput}
 */
function doPost(e) {
  var raw = "";
  try {
    raw = e && e.postData && e.postData.contents ? e.postData.contents : "{}";
  } catch (err) {
    raw = "{}";
  }
  var body = {};
  try {
    body = JSON.parse(raw);
  } catch (err) {
    return jsonResponse(400, false, { code: "BAD_JSON", message: "Malformed JSON body: " + err.message });
  }
  if (!body || typeof body !== "object") body = {};
  return handleRequest(body, "POST");
}

/**
 * Request pipeline: auth -> route -> audit -> respond.
 * @param {Object} body
 * @param {string} method
 * @return {GoogleAppsScript.Content.TextOutput}
 */
function handleRequest(body, method) {
  var requestId = IdGenerator.requestId();
  var started = new Date();
  var action = String(body.action || "");
  var token = String(body.token || "");
  var client = String(body.client || "shortcut");
  var payloadHash = AuthService.hash(JSON.stringify(sanitizeForHash(body)));

  try {
    if (!action) {
      return respond(400, requestId, started, method, action, null, {
        code: "BAD_ACTION", message: "Missing 'action' field."
      }, null, [], null, client, payloadHash);
    }

    if (!AuthService.authorize(token)) {
      return respond(401, requestId, started, method, action, null, {
        code: "AUTH_REQUIRED", message: "Invalid or missing API token."
      }, null, [], null, client, payloadHash);
    }

    if (method === "GET" && !READ_ONLY_ACTIONS[action]) {
      return respond(405, requestId, started, method, action, null, {
        code: "METHOD_NOT_ALLOWED",
        message: "Action '" + action + "' mutates state and requires POST."
      }, null, [], null, client, payloadHash);
    }

    var handler = getActionHandler(action);
    if (!handler) {
      return respond(400, requestId, started, method, action, null, {
        code: "BAD_ACTION", message: "Unknown action '" + action + "'."
      }, null, [], null, client, payloadHash);
    }

    var result = handler(body);
    if (result && typeof result.getContent === "function") {
      // direct output (e.g. CSV export) — audit it before returning
      auditRequest(requestId, started, method, action, client, payloadHash,
        "SUCCESS", 200, null, null, "");
      return result;
    }
    var data = (result && result.data) ? result.data : (result || {});
    var warn = (result && result.warnings) ? result.warnings : [];
    return respond(200, requestId, started, method, action, null, null, data, warn,
      result ? result.auditStatus : null, client, payloadHash);
  } catch (err) {
    if (err && err.isValidation) {
      return respond(400, requestId, started, method, action, null, {
        code: "VALIDATION_ERROR",
        message: err.message,
        details: err.validationErrors || []
      }, null, err.validationWarnings || [], null, client, payloadHash);
    }
    Logger.log("server error: " + (err && err.stack ? err.stack : err.message));
    return respond(500, requestId, started, method, action, null, {
      code: "SERVER_ERROR",
      message: err.message
    }, null, [], null, client, payloadHash);
  }
}

/** Copy of the body with the auth token removed, for hashing/logging. */
function sanitizeForHash(body) {
  var out = {};
  Object.keys(body || {}).forEach(function (k) {
    if (k !== "token") out[k] = body[k];
  });
  return out;
}

/** Writes one audit row. Never throws. */
function auditRequest(requestId, started, method, action, client, payloadHash,
                     logStatus, status, recordId, dupOf, error) {
  try {
    AuditService.log({
      ts: new Date().toISOString(),
      request_id: requestId,
      endpoint: action,
      method: method,
      client: client,
      payload_hash: payloadHash,
      status: logStatus,
      response_code: status,
      error: error || "",
      record_id: recordId || null,
      duplicate_of: dupOf || null
    });
  } catch (auditErr) {
    Logger.log("audit failed: " + auditErr.message);
  }
}

/**
 * Central response writer. Always audits, always returns JSON.
 */
function respond(status, requestId, started, method, action, dupOf, err, data, warnings, auditStatus, client, payloadHash) {
  var durationMs = new Date().getTime() - started.getTime();
  var logStatus = auditStatus ||
    (status === 200 ? "SUCCESS" : status === 409 ? "DUPLICATE" : status === 400 ? "REJECTED" : "FAILED");

  auditRequest(requestId, started, method, action, client || "api", payloadHash || "",
    logStatus, status, data && data.transaction_id ? data.transaction_id :
      (data && data.id ? data.id : null), dupOf,
    err ? (err.message || JSON.stringify(err)) : "");

  var payload = {
    ok: status >= 200 && status < 300,
    data: err ? null : (data || null),
    warnings: warnings || []
  };
  if (err) payload.error = err;
  payload.meta = {
    request_id: requestId,
    ts: new Date().toISOString(),
    duration_ms: durationMs,
    api_version: API_VERSION
  };

  return ContentService
    .createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * Builds a standard JSON output with explicit HTTP-ish status.
 */
function jsonResponse(status, ok, error, data, warnings) {
  var requestId = IdGenerator.requestId();
  var payload = { ok: ok, data: data || null, warnings: warnings || [] };
  if (error) payload.error = error;
  payload.meta = {
    request_id: requestId,
    ts: new Date().toISOString(),
    api_version: API_VERSION
  };
  return ContentService
    .createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * Actions safe to invoke over GET. Everything else mutates state and must
 * arrive via POST so a link/image-tag/prefetch can never trigger a write.
 */
var READ_ONLY_ACTIONS = {
  "health": 1, "settings.get": 1, "lookups.list": 1, "analytics.status": 1,
  "transaction.get": 1, "transaction.list": 1,
  "account.list": 1, "account.get": 1, "category.list": 1, "income_source.list": 1,
  "budget.list": 1, "goal.list": 1, "recurring.list": 1,
  "dashboard.summary": 1, "audit.list": 1, "export": 1
};

/**
 * Lazy action registry — resolved at request time so file load order never matters.
 */
function getActionHandler(action) {  var map = {
    // system
    "health": ApiHealth.health,
    "settings.get": SettingsService.apiGet,
    "settings.set": SettingsService.apiSet,
    "lookups.list": LookupService.apiList,
    "analytics.run": AnalyticsService.apiRun,
    "analytics.status": AnalyticsService.apiStatus,
    "export": MigrationService.apiExport,
    "import": MigrationService.apiImport,

    // transactions
    "transaction.create": TransactionService.apiCreate,
    "transaction.get": TransactionService.apiGet,
    "transaction.list": TransactionService.apiList,
    "transaction.void": TransactionService.apiVoid,

    // master data
    "account.create": AccountService.apiCreate,
    "account.list": AccountService.apiList,
    "account.get": AccountService.apiGet,
    "category.create": CategoryService.apiCreate,
    "category.list": CategoryService.apiList,
    "income_source.create": IncomeSourceService.apiCreate,
    "income_source.list": IncomeSourceService.apiList,
    "budget.create": BudgetService.apiCreate,
    "budget.list": BudgetService.apiList,
    "goal.create": GoalService.apiCreate,
    "goal.list": GoalService.apiList,
    "recurring.create": RecurringService.apiCreate,
    "recurring.list": RecurringService.apiList,
    "recurring.run": RecurringService.apiRun,

    // reporting
    "dashboard.summary": DashboardService.apiSummary,
    "audit.list": AuditService.apiList
  };
  return map[action];
}

/** Simple EventBus — subscribers run after a successful mutation. */
var EVENT_SUBSCRIBERS = {
  "transaction.created": ["AnalyticsService.onLedgerChanged", "DashboardService.onLedgerChanged"],
  "ledger.changed": ["AnalyticsService.onLedgerChanged", "DashboardService.onLedgerChanged"],
  "account.created": [],
  "category.created": [],
  "setup.complete": ["AnalyticsService.onLedgerChanged"]
};

/**
 * Emits a domain event. Subscribers are resolved lazily by name so file load
 * order never matters. Never throws — failures are logged, not fatal.
 * @param {string} event
 * @param {Object} payload
 */
function emit(event, payload) {
  var subs = EVENT_SUBSCRIBERS[event] || [];
  for (var i = 0; i < subs.length; i++) {
    try {
      var parts = subs[i].split(".");
      var obj = this[parts[0]];
      if (!obj) continue;
      obj[parts[1]](payload);
    } catch (err) {
      Logger.log("event '" + event + "' subscriber failed: " + err.message);
    }
  }
}

/** Global guard so concurrent web requests can't corrupt the ledger. */
var __lockDepth = 0;
function withLock(fn) {
  if (__lockDepth > 0) return fn(); // reentrant within the same execution
  var lock = LockService.getScriptLock();
  var acquired = lock.tryLock(10000);
  if (!acquired) {
    throw new Error("Ledger lock timeout — try again.");
  }
  __lockDepth++;
  try {
    return fn();
  } finally {
    __lockDepth--;
    lock.releaseLock();
  }
}
