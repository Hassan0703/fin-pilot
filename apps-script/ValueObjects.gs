/**
 * FinPilot v0 — Value Objects (DDD) and primitive validators.
 *
 * Money, Currency, Period, DateStamp are value objects: immutable, self-validating,
 * compared by value. They are constructed at the boundary and enforced by the
 * ValidationService before any aggregate mutation.
 */

/** Money value object. Amount is a decimal number, currency an ISO-4217 code. */
function Money(amount, currency) {
  if (typeof amount === "string") amount = Number(amount);
  if (!isFinite(amount)) throw new Error("Money: amount is not a number: " + amount);
  this.amount = Math.round((amount + Number.EPSILON) * 10000) / 10000;
  this.currency = String(currency || "").toUpperCase();
  if (!/^[A-Z]{3}$/.test(this.currency)) {
    throw new Error("Money: invalid currency code '" + this.currency + "'");
  }
}
Money.prototype.isNegative = function () { return this.amount < 0; };
Money.prototype.isZero = function () { return Math.abs(this.amount) < 1e-9; };
Money.prototype.toNumber = function () { return this.amount; };
Money.prototype.equals = function (other) {
  return this.amount === other.amount && this.currency === other.currency;
};

/** Month period value object, "YYYY-MM". */
function Period(value) {
  this.value = String(value || "");
  if (!/^\d{4}-\d{2}$/.test(this.value) || this.value.slice(5) > "12" || this.value.slice(5) < "01") {
    throw new Error("Period: invalid format '" + this.value + "', expected YYYY-MM");
  }
}
Period.prototype.toString = function () { return this.value; };

/** Strict calendar-date parser. Rejects impossible dates like 2026-02-30. */
function strictDate(value) {
  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value));
  if (!m) return null;
  var y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  var dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return dt;
}

/** Calendar date value object, "YYYY-MM-DD". */
function DateStamp(value) {
  this.value = String(value || "");
  var dt = strictDate(this.value);
  if (!dt) throw new Error("DateStamp: not a real calendar date: " + this.value);
  this.date = dt;
}
DateStamp.prototype.toString = function () { return this.value; };

/** ISO timestamp helper. */
function isoNow() { return new Date().toISOString(); }

/** Convert Date -> "YYYY-MM-DD" (UTC). */
function dateStamp(d) {
  var y = d.getUTCFullYear();
  var m = ("0" + (d.getUTCMonth() + 1)).slice(-2);
  var day = ("0" + d.getUTCDate()).slice(-2);
  return y + "-" + m + "-" + day;
}

/** Convert Date -> "YYYY-MM". */
function monthStamp(d) {
  var y = d.getUTCFullYear();
  var m = ("0" + (d.getUTCMonth() + 1)).slice(-2);
  return y + "-" + m;
}

/** Today's date stamp in UTC. */
function todayStamp() { return dateStamp(new Date()); }

/** First day of a month period. */
function periodStart(period) { return period + "-01"; }

/** Last day of a month period. */
function periodEnd(period) {
  var parts = period.split("-");
  var y = Number(parts[0]), m = Number(parts[1]);
  var d = new Date(Date.UTC(y, m, 0));
  return dateStamp(d);
}

/** Next month period after a given one. */
function nextPeriod(period) {
  var parts = period.split("-");
  var d = new Date(Date.UTC(Number(parts[0]), Number(parts[1]) - 1, 1));
  d.setUTCMonth(d.getUTCMonth() + 1);
  return monthStamp(d);
}

/** Previous month period before a given one. */
function prevPeriod(period) {
  var parts = period.split("-");
  var d = new Date(Date.UTC(Number(parts[0]), Number(parts[1]) - 1, 1));
  d.setUTCMonth(d.getUTCMonth() - 1);
  return monthStamp(d);
}

/** Difference in whole calendar months (positive when target after base). */
function monthDiff(targetStamp, baseStamp) {
  var t = new Date(targetStamp + "T00:00:00Z");
  var b = new Date(baseStamp + "T00:00:00Z");
  return (t.getUTCFullYear() - b.getUTCFullYear()) * 12 + (t.getUTCMonth() - b.getUTCMonth());
}

/**
 * Convert a fuzzy input into an ISO-8601 UTC string, or throw.
 * Accepts: ISO string, Date object, number (ms epoch).
 */
function normalizeIso(v) {
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "number") return new Date(v).toISOString();
  var s = String(v);
  var d = new Date(s);
  if (isNaN(d.getTime())) throw new Error("Invalid timestamp: " + s);
  return d.toISOString();
}

/** Convert input to "YYYY-MM-DD" or throw. Accepts YYYY-MM-DD or ISO datetime. */
function normalizeDate(v) {
  if (v instanceof Date) return dateStamp(v);
  var s = String(v);
  var dt = strictDate(s);
  if (dt) return s;
  var m = /^(\d{4}-\d{2}-\d{2})T/.exec(s);
  if (m && strictDate(m[1])) {
    var d = new Date(s);
    if (!isNaN(d.getTime())) return m[1];
  }
  throw new Error("Invalid date: " + s);
}
