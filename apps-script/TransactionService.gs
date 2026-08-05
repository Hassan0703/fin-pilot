/**
 * FinPilot v0 — Transaction Service.
 *
 * The Ledger aggregate root. This is the ONLY path that writes to the
 * `transactions` table. Enforces invariants, emits domain events, returns
 * normalized records to the API layer.
 */

var TransactionService = {
  /**
   * Create a transaction through the full pipeline:
   *   validate → duplicate detection → id → persist → events
   * @param {Object} body API payload
   * @return {{data:Object, warnings:Array, auditStatus:string}}
   */
  apiCreate: function (body) {
    return withLock(function () {
      var dryRun = body.dry_run === true || body.dry_run === "true";

      // validate
      var result = ValidationService.validateTransaction(body);
      if (!result.valid) {
        throw new ValidationError(result.errors, result.warnings);
      }

      // normalize
      var t = TransactionService.normalize(body, result);

      // duplicate detection
      if (body.force !== true) {
        var byRef = DuplicateDetectionService.findByExternalRef(t.external_ref);
        if (byRef) {
          return {
            data: { transaction_id: byRef.transaction_id, status: TX_STATUS_DUPLICATE,
                    duplicate: true, duplicate_of: byRef.transaction_id },
            warnings: ["external_ref already recorded; nothing written."],
            auditStatus: "DUPLICATE"
          };
        }
        var soft = DuplicateDetectionService.findDuplicate(t, null);
        if (soft) {
          return {
            data: { transaction_id: t.transaction_id, status: TX_STATUS_DUPLICATE,
                    duplicate: true, duplicate_of: soft.transaction_id, preview: t },
            warnings: ["near-duplicate detected within window; use force:true to record anyway."],
            auditStatus: "DUPLICATE"
          };
        }
      }

      if (dryRun) {
        return {
          data: { dry_run: true, valid: true, preview: t },
          warnings: result.warnings,
          auditStatus: "SUCCESS"
        };
      }

      var record = TransactionService.persist(t);

      // post-commit events
      emit("transaction.created", { transaction: record });

      return {
        data: {
          transaction_id: record.transaction_id,
          status: record.status,
          duplicate: false
        },
        warnings: result.warnings,
        auditStatus: "SUCCESS"
      };
    });
  },

  /** Converts a validated payload into a normalized transaction record. */
  normalize: function (body, result) {
    var now = isoNow();
    var date = body.__date || normalizeDate(body.date || todayStamp());
    var type = String(body.type).toUpperCase();
    var currency = String(body.currency || SettingsService.getRaw("base_currency")).toUpperCase();

    var rec = {
      transaction_id: IdGenerator.transaction(),
      transaction_ts: body.transaction_ts ? normalizeIso(body.transaction_ts) : now,
      date: date,
      type: type,
      amount: Number(body.amount),
      currency: currency,
      account_id: body.account_id || "",
      from_account_id: body.from_account_id || "",
      to_account_id: body.to_account_id || "",
      category_id: body.category_id || "",
      income_source_id: body.income_source_id || "",
      merchant: String(body.merchant || "").trim(),
      note: String(body.note || "").trim(),
      tags: TransactionService.normalizeTags(body.tags),
      external_ref: String(body.external_ref || "").trim(),
      status: TX_STATUS_POSTED,
      source: String(body.source || "SHORTCUT").toUpperCase(),
      created_at: now,
      updated_at: ""
    };
    // Only retain fields meaningful for the type (keeps schema clean).
    if (type === "EXPENSE") {
      rec.from_account_id = ""; rec.to_account_id = ""; rec.income_source_id = "";
    } else if (type === "INCOME") {
      rec.from_account_id = ""; rec.to_account_id = ""; rec.category_id = "";
    } else { // TRANSFER
      rec.account_id = ""; rec.category_id = ""; rec.income_source_id = "";
    }
    return rec;
  },

  normalizeTags: function (tags) {
    if (!tags) return "";
    if (Array.isArray(tags)) return tags.join(",");
    return String(tags).split(",").map(function (s) { return s.trim(); })
      .filter(Boolean).join(",");
  },

  /** Appends the transaction row. */
  persist: function (rec) {
    appendRow("transactions", rec);
    return rec;
  },

  apiGet: function (body) {
    if (!body.transaction_id) throw new Error("transaction.get requires 'transaction_id'.");
    var rows = readTable("transactions");
    for (var i = 0; i < rows.length; i++) {
      if (String(rows[i].transaction_id) === String(body.transaction_id)) {
        return { data: rows[i] };
      }
    }
    throw new Error("Transaction not found: " + body.transaction_id);
  },

  apiList: function (body) {
    var rows = readTable("transactions");
    var out = rows;
    if (body.type) out = out.filter(function (r) { return String(r.type) === String(body.type).toUpperCase(); });
    if (body.from && body.to) {
      out = out.filter(function (r) {
        var d = String(r.date);
        return d >= body.from && d <= body.to;
      });
    } else if (body.from) {
      out = out.filter(function (r) { return String(r.date) >= body.from; });
    } else if (body.to) {
      out = out.filter(function (r) { return String(r.date) <= body.to; });
    }
    if (body.category_id) out = out.filter(function (r) { return String(r.category_id) === String(body.category_id); });
    if (body.status) out = out.filter(function (r) { return String(r.status) === String(body.status).toUpperCase(); });
    out.sort(function (a, b) {
      var da = String(a.date), db = String(b.date);
      if (da < db) return 1;
      if (da > db) return -1;
      return 0;
    });
    var limit = body.limit ? Math.min(Number(body.limit) || 50, 500) : 50;
    return { data: out.slice(0, limit) };
  },

  /** Void a transaction (status=VOID). Rows are never deleted. */
  apiVoid: function (body) {
    return withLock(function () {
      if (!body.transaction_id) throw new Error("transaction.void requires 'transaction_id'.");
      var row = findRow("transactions", "transaction_id", body.transaction_id);
      if (!row) throw new Error("Transaction not found: " + body.transaction_id);
      updateCell("transactions", row, "status", TX_STATUS_VOID);
      updateCell("transactions", row, "updated_at", isoNow());
      var rec = readTable("transactions")
        .filter(function (r) { return String(r.transaction_id) === String(body.transaction_id); })[0];
      emit("ledger.changed", { voided: rec });
      return { data: { transaction_id: body.transaction_id, status: TX_STATUS_VOID } };
    });
  }
};

/** Error type carrying validation failures (surfaced to the API). */
function ValidationError(errors, warnings) {
  var inst = new Error("Validation failed.");
  inst.name = "ValidationError";
  inst.validationErrors = errors || [];
  inst.validationWarnings = warnings || [];
  inst.isValidation = true;
  return inst;
}
