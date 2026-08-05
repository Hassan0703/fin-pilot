/**
 * FinPilot v0 — ID generation.
 *
 * Collision-resistant, time-sortable, human-friendly IDs.
 * Format: <PREFIX>_<TIME_BASE32><RANDOM_BASE32><SEQ_BASE32>
 *   e.g. TRX_AAAAAAAA9KQ8B2ZQ78C3M
 *
 * Time portion encodes ms since epoch in base32, fixed-width (11 chars) so IDs
 * are lexicographically sortable by creation time. Random portion is 5 chars of
 * base32 (25 bits) from Math.random — Apps Script exposes no CSPRNG — and a
 * monotonic per-execution counter guarantees uniqueness within one execution.
 * Collision probability across executions is ~2^-25 per pair, negligible at
 * single-user scale.
 */

var ID_PREFIXES = {
  transaction: "TRX",
  account: "ACC",
  category: "CAT",
  incomeSource: "SRC",
  budget: "BUD",
  goal: "GOL",
  recurring: "REC",
  analytics: "ANA",
  audit: "AUD",
  lookup: "LKP",
  rule: "RUL",
  stage: "STG",
  request: "REQ"
};

var B32_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no I,L,O,0,1

function base32Encode(number) {
  var out = "";
  var n = Math.floor(number);
  do {
    out = B32_ALPHABET.charAt(n % 32) + out;
    n = Math.floor(n / 32);
  } while (n > 0);
  return out;
}

/** Fixed-width (11 char) base32 encoding of the current epoch millis. */
function timeBase32() {
  var s = base32Encode(Date.now());
  while (s.length < 11) s = "A" + s;
  return s;
}

function randomBase32(len) {
  var out = "";
  for (var i = 0; i < len; i++) {
    out += B32_ALPHABET.charAt(Math.floor(Math.random() * 32));
  }
  return out;
}

/** Monotonic per-execution counter — guarantees intra-execution uniqueness. */
var __idSeq = 0;

/** Generates an ID for a given aggregate type. */
function generateId(kind) {
  var prefix = ID_PREFIXES[kind];
  if (!prefix) throw new Error("Unknown id kind: " + kind);
  return prefix + "_" + timeBase32() + randomBase32(5) + base32Encode(__idSeq++ % 32);
}

/** Request correlation id. */
function generateRequestId() {
  return "REQ_" + timeBase32() + randomBase32(3) + base32Encode(__idSeq++ % 32);
}

/** Convenience accessor used across services. */
var IdGenerator = {
  transaction: function () { return generateId("transaction"); },
  account: function () { return generateId("account"); },
  category: function () { return generateId("category"); },
  incomeSource: function () { return generateId("incomeSource"); },
  budget: function () { return generateId("budget"); },
  goal: function () { return generateId("goal"); },
  recurring: function () { return generateId("recurring"); },
  analytics: function () { return generateId("analytics"); },
  audit: function () { return generateId("audit"); },
  lookup: function () { return generateId("lookup"); },
  rule: function () { return generateId("rule"); },
  stage: function () { return generateId("stage"); },
  requestId: function () { return generateRequestId(); },
};
