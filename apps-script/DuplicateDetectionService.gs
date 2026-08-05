/**
 * FinPilot v0 — Duplicate Detection Service.
 *
 * Protects the ledger from double-booking caused by:
 *   1. Shortcut re-taps (same external_ref) → hard duplicate, always caught.
 *   2. Near-identical submissions within a time window → soft duplicate.
 *
 * Window is configurable via settings.duplicate_window_minutes (default 2880 = 48h).
 */

var DuplicateDetectionService = {
  /**
   * Builds a canonical fingerprint for a transaction payload.
   * @param {Object} t normalized transaction fields
   * @return {string} sha256 fingerprint
   */
  fingerprint: function (t) {
    var canonical = [
      String(t.type || ""),
      String(Number(t.amount) || "0"),
      String(t.currency || ""),
      String(t.account_id || ""),
      String(t.from_account_id || ""),
      String(t.to_account_id || ""),
      String(t.category_id || ""),
      String(t.income_source_id || ""),
      String(t.date || ""),
      DuplicateDetectionService.normalizeText(t.merchant),
      DuplicateDetectionService.normalizeText(t.note)
    ].join("|");
    var digest = Utilities.computeDigest(
      Utilities.DigestAlgorithm.SHA_256, canonical, Utilities.Charset.UTF_8);
    return digest.map(function (b) {
      var hex = (b < 0 ? b + 256 : b).toString(16);
      return hex.length === 1 ? "0" + hex : hex;
    }).join("");
  },

  normalizeText: function (s) {
    return String(s || "").trim().toLowerCase().replace(/\s+/g, " ");
  },

  /**
   * Looks for an existing POSTED/PENDING transaction matching the fingerprint
   * within the duplicate window (configurable).
   * @param {Object} t normalized payload
   * @param {Array<Object>} ledger loaded transactions (or null to read)
   * @return {Object|null} matched transaction record
   */
  findDuplicate: function (t, ledger) {
    var windowMinutes = SettingsService.get("duplicate_window_minutes") || 2880;
    var fp = DuplicateDetectionService.fingerprint(t);

    var rows = ledger || readTable("transactions");
    var now = Date.now();
    var cutoff = now - windowMinutes * 60 * 1000;

    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      var st = String(r.status).toUpperCase();
      if (st === "VOID" || st === "REJECTED") continue;
      if (DuplicateDetectionService.fingerprint(r) !== fp) continue;
      var ts = new Date(String(r.transaction_ts || r.created_at || "1970")).getTime();
      if (isNaN(ts)) ts = 0;
      if (ts >= cutoff) return r;
    }
    return null;
  },

  /** Hard duplicate check by client idempotency key. */
  findByExternalRef: function (externalRef) {
    if (!externalRef) return null;
    var rows = readTable("transactions");
    for (var i = 0; i < rows.length; i++) {
      if (String(rows[i].external_ref) === String(externalRef)) return rows[i];
    }
    return null;
  }
};
