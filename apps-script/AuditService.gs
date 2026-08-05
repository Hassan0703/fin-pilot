/**
 * FinPilot v0 — Audit Service.
 *
 * Every API request is logged (append-only). Rows are never deleted.
 * Useful for debugging, security review and rebuilding the ledger if needed.
 */

var AuditService = {
  /**
   * @param {Object} entry
   */
  log: function (entry) {
    var rec = {
      audit_id: IdGenerator.audit(),
      ts: entry.ts || isoNow(),
      request_id: entry.request_id || "",
      endpoint: entry.endpoint || "",
      method: entry.method || "POST",
      client: entry.client || "",
      payload_hash: entry.payload_hash || "",
      status: entry.status || "SUCCESS",
      response_code: entry.response_code || 200,
      error: entry.error || "",
      record_id: entry.record_id || "",
      duplicate_of: entry.duplicate_of || "",
      created_at: isoNow()
    };
    return appendRow("audit_logs", rec);
  },

  /** Returns recent audit rows, newest first. */
  list: function (opts) {
    var rows = readTable("audit_logs");
    rows.sort(function (a, b) {
      var ta = String(a.ts), tb = String(b.ts);
      if (ta < tb) return 1;
      if (ta > tb) return -1;
      return 0;
    });
    var limit = opts && opts.limit ? Math.min(Number(opts.limit) || 100, 500) : 100;
    var status = opts && opts.status ? String(opts.status) : "";
    if (status) rows = rows.filter(function (r) { return String(r.status) === status; });
    return rows.slice(0, limit);
  },

  apiList: function (body) {
    return { data: AuditService.list(body), auditStatus: "SUCCESS" };
  }
};
