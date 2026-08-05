const fs = require("fs");
const vm = require("vm");
const crypto = require("crypto");

const dir = __dirname;
const files = fs.readdirSync(dir).filter(f => f.endsWith(".js") && f !== "test.js" && f !== "run-tests.js").sort();

const Logger = { log: () => {} };
const Utilities = {
  Charset: { UTF_8: "utf8" },
  DigestAlgorithm: { SHA_256: "SHA_256" },
  computeDigest(algo, input) {
    return Array.from(crypto.createHash("sha256").update(String(input), "utf8").digest());
  }
};
const CacheService = { getScriptCache: () => ({ put() {}, get() { return null; }, removeAll() {} }) };
const LockService = { getScriptLock: () => ({ tryLock() { return true; }, releaseLock() {} }) };
const PropertiesService = {
  getScriptProperties: () => ({ getProperty: () => null, setProperty: () => {}, removeAll: () => {} })
};
const ScriptApp = {
  getProjectTriggers: () => [],
  newTrigger: () => ({ timeBased: () => ({ everyDays: () => ({ atHour: () => ({ create() {} }) }),
                                            everyWeeks: () => ({ onWeekDay: () => ({ atHour: () => ({ create() {} }) }) }) }) }),
  WeekDay: {}
};
const ContentService = {
  MimeType: { JSON: "application/json", CSV: "text/csv" },
  createTextOutput: (s) => ({ s, setMimeType() { return this; }, toString() { return s; } })
};

const STUB = {
  tables: {}
};

const ctx = {
  console, Logger, Utilities, CacheService, LockService, PropertiesService,
  ScriptApp, ContentService,
  SpreadsheetApp: {}, UrlFetchApp: {}, JSON, Date, Math, Object, Array, String,
  Number, Boolean, RegExp, Error, isFinite, setTimeout, clearTimeout,
  STUB
};
vm.createContext(ctx);

files.forEach(f => {
  vm.runInContext(fs.readFileSync(`${dir}/${f}`, "utf8"), ctx, { filename: f });
});

// Keep a handle on the real Repository readTable so the read-cache can be
// unit tested even though the harness stubs it out for service tests.
ctx.__realReadTable = ctx.readTable;
// Same for appendRow — used to prove the persistence-layer formula guard.
ctx.__realAppendRow = ctx.appendRow;

// Re-inject storage stubs AFTER load so Repository's globals are overridden.
function run(expr) { return vm.runInContext(expr, ctx); }

Object.assign(ctx, {
  readTable: (t) => STUB.tables[t] || [],
  appendRow: (t, r) => { (STUB.tables[t] = STUB.tables[t] || []).push(r); return 1; },
  tableSheet: (t) => ({ getLastRow: () => 1, getLastColumn: () => 1 }),
  findRow: (t, col, val) => {
    const rows = STUB.tables[t] || [];
    for (let i = 0; i < rows.length; i++) {
      if (String(rows[i][col]) === String(val)) return i + 2;
    }
    return 0;
  },
  updateCell: (t, row, col, value) => {
    const r = (STUB.tables[t] || [])[row - 2];
    if (r) r[col] = value;
  },
  updateRow: (t, row, rec) => {
    const r = (STUB.tables[t] || [])[row - 2];
    if (r) Object.keys(rec).forEach(k => { r[k] = rec[k]; });
    return row;
  },
  clearTableData: (t) => { STUB.tables[t] = []; },
  writeTableData: (t, matrix) => {
    const def = ctx.TABLES[t];
    STUB.tables[t] = matrix.map(row => {
      const o = {};
      def.cols.forEach((c, i) => { o[c] = row[i]; });
      return o;
    });
  },
  tableCount: (t) => (STUB.tables[t] || []).length,
  openDb: () => ({ getId: () => "TEST_ID", getSheetByName: () => null, insertSheet: () => ({}) })
});

run(`
  STUB.tables.accounts = [
    {account_id:"ACC_1", name:"Main", type:"BANK", currency:"USD", opening_balance:100, status:"ACTIVE", is_credit:false},
    {account_id:"ACC_2", name:"Savings", type:"SAVINGS", currency:"USD", opening_balance:0, status:"ACTIVE", is_credit:false}
  ];
  STUB.tables.categories = [{category_id:"CAT_1", name:"Food", type:"EXPENSE", status:"ACTIVE"}];
  STUB.tables.income_sources = [{income_source_id:"SRC_1", name:"Salary", status:"ACTIVE"}];
  STUB.tables.lookups = [
    {lookup_group:"currency", code:"USD", is_active:true},
    {lookup_group:"account_type", code:"BANK", is_active:true},
  {lookup_group:"account_type", code:"CREDIT_CARD", is_active:true},
    {lookup_group:"frequency", code:"MONTHLY", is_active:true},
    {lookup_group:"priority", code:"HIGH", is_active:true},
    {lookup_group:"income_source_type", code:"EMPLOYMENT", is_active:true},
    {lookup_group:"status", code:"ACTIVE", is_active:true}
  ];
  STUB.tables.settings = [
    {key:"base_currency", value:"USD", value_type:"STRING"},
    {key:"duplicate_window_minutes", value:"2880", value_type:"NUMBER"},
    {key:"savings_rate_target", value:"0.10", value_type:"NUMBER"},
    {key:"emergency_fund_months_target", value:"3", value_type:"NUMBER"}
  ];
`);

let failures = 0;
function assert(name, fn) {
  try { fn(); console.log("PASS:", name); }
  catch (e) { failures++; console.error("FAIL:", name, "->", e.message); }
}
function t(expr) { return run(expr); }
function throws(expr) { try { run(expr); return false; } catch (e) { return true; } }

assert("Money validation", () => {
  if (t("new Money(42.5,'USD').amount") !== 42.5) throw new Error("amount");
  if (t("new Money('0.1','EUR').amount") !== 0.1) throw new Error("string amount");
  if (t("new Money(-5,'USD').isNegative()") !== true) throw new Error("isNegative");
  if (t("new Money(0,'USD').isZero()") !== true) throw new Error("isZero");
  if (!throws("new Money(5,'US')")) throw new Error("bad currency not rejected");
  if (!throws("new Money('abc','USD')")) throw new Error("non-numeric accepted");
});

assert("Period validation", () => {
  if (t("new Period('2026-08').toString()") !== "2026-08") throw new Error("format");
  if (!throws("new Period('2026-13')")) throw new Error("month 13 accepted");
});

assert("DateStamp validation", () => {
  if (t("new DateStamp('2026-02-28').toString()") !== "2026-02-28") throw new Error("format");
  if (!throws("new DateStamp('2026-02-30')")) throw new Error("bad date accepted");
});

assert("ID generation format", () => {
  if (!/^TRX_[A-Z0-9]+$/.test(t("IdGenerator.transaction()"))) throw new Error("trx");
  if (!/^ACC_[A-Z0-9]+$/.test(t("IdGenerator.account()"))) throw new Error("acc");
  if (t("IdGenerator.transaction()") === t("IdGenerator.transaction()")) throw new Error("collision");
});

assert("Duplicate fingerprint determinism", () => {
  const a = t(`DuplicateDetectionService.fingerprint({type:"EXPENSE",amount:10,currency:"USD",account_id:"ACC_1",category_id:"CAT_1",date:"2026-08-04",merchant:"Test",note:""})`);
  const b = t(`DuplicateDetectionService.fingerprint({type:"EXPENSE",amount:10,currency:"USD",account_id:"ACC_1",category_id:"CAT_1",date:"2026-08-04",merchant:" Test ",note:""})`);
  if (a !== b) throw new Error("whitespace changed fingerprint");
});

assert("Expense validation OK", () => {
  run(`var R1 = ValidationService.validateTransaction({type:"EXPENSE",amount:10,currency:"USD",account_id:"ACC_1",category_id:"CAT_1",date:"2026-08-04"});`);
  if (t("R1.valid") !== true) throw new Error(JSON.stringify(t("R1.errors")));
});

assert("Expense missing category rejected", () => {
  run(`var R2 = ValidationService.validateTransaction({type:"EXPENSE",amount:10,currency:"USD",account_id:"ACC_1",date:"2026-08-04"});`);
  if (t("R2.valid") !== false) throw new Error("not invalid");
  if (!t("R2.errors.some(function(e){return e.rule==='EXPENSE_REQUIRES_CATEGORY';})")) throw new Error("rule");
});

assert("Expense rejects to_account", () => {
  run(`var R3 = ValidationService.validateTransaction({type:"EXPENSE",amount:10,currency:"USD",account_id:"ACC_1",category_id:"CAT_1",to_account_id:"ACC_2",date:"2026-08-04"});`);
  if (t("R3.valid") !== false) throw new Error("destination accepted");
});

assert("Income validation OK", () => {
  run(`var R4 = ValidationService.validateTransaction({type:"INCOME",amount:100,currency:"USD",account_id:"ACC_1",income_source_id:"SRC_1",date:"2026-08-04"});`);
  if (t("R4.valid") !== true) throw new Error(JSON.stringify(t("R4.errors")));
});

assert("Income rejects from_account", () => {
  run(`var R5 = ValidationService.validateTransaction({type:"INCOME",amount:100,currency:"USD",account_id:"ACC_1",income_source_id:"SRC_1",from_account_id:"ACC_2",date:"2026-08-04"});`);
  if (t("R5.valid") !== false) throw new Error("from accepted");
});

assert("Transfer validation OK", () => {
  run(`var R6 = ValidationService.validateTransaction({type:"TRANSFER",amount:50,currency:"USD",from_account_id:"ACC_1",to_account_id:"ACC_2",date:"2026-08-04"});`);
  if (t("R6.valid") !== true) throw new Error(JSON.stringify(t("R6.errors")));
});

assert("Transfer rejects same account", () => {
  run(`var R7 = ValidationService.validateTransaction({type:"TRANSFER",amount:50,currency:"USD",from_account_id:"ACC_1",to_account_id:"ACC_1",date:"2026-08-04"});`);
  if (t("R7.valid") !== false) throw new Error("same-account transfer accepted");
});

assert("Negative amount rejected", () => {
  run(`var R8 = ValidationService.validateTransaction({type:"EXPENSE",amount:-5,currency:"USD",account_id:"ACC_1",category_id:"CAT_1",date:"2026-08-04"});`);
  if (t("R8.valid") !== false) throw new Error("negative accepted");
});

assert("Unknown account rejected", () => {
  run(`var R9 = ValidationService.validateTransaction({type:"EXPENSE",amount:5,currency:"USD",account_id:"NOPE",category_id:"CAT_1",date:"2026-08-04"});`);
  if (!t("R9.errors.some(function(e){return e.rule==='ACCOUNT_EXISTS';})")) throw new Error("rule missing");
});

assert("Invalid date rejected", () => {
  run(`var R10 = ValidationService.validateTransaction({type:"EXPENSE",amount:5,currency:"USD",account_id:"ACC_1",category_id:"CAT_1",date:"2026-02-30"});`);
  if (t("R10.valid") !== false) throw new Error("bad date accepted");
});

assert("Transaction normalize type fields", () => {
  run(`var N1 = TransactionService.normalize({type:"TRANSFER",amount:10,currency:"USD",from_account_id:"ACC_1",to_account_id:"ACC_2",account_id:"ACC_3",category_id:"CAT_1"}, {});`);
  if (t("N1.from_account_id") !== "ACC_1") throw new Error("from");
  if (t("N1.to_account_id") !== "ACC_2") throw new Error("to");
  if (t("N1.account_id") !== "") throw new Error("account should be cleared");
  if (t("N1.category_id") !== "") throw new Error("category should be cleared");
  if (t("N1.status") !== "POSTED") throw new Error("status");
});

assert("AccountBalanceEngine transfer semantics", () => {
  run(`var LEDGER = [
    {type:"INCOME",amount:1000,currency:"USD",account_id:"ACC_1",date:"2026-08-01",status:"POSTED"},
    {type:"EXPENSE",amount:100,currency:"USD",account_id:"ACC_1",date:"2026-08-02",status:"POSTED"},
    {type:"TRANSFER",amount:200,currency:"USD",from_account_id:"ACC_1",to_account_id:"ACC_2",date:"2026-08-03",status:"POSTED"}
  ];`);
  run(`var BAL1 = AccountBalanceEngine.atDate(STUB.tables.accounts[0], LEDGER, "2026-08-04");`);
  run(`var BAL2 = AccountBalanceEngine.atDate(STUB.tables.accounts[1], LEDGER, "2026-08-04");`);
  if (t("BAL1") !== 800) throw new Error("ACC_1 expected 800 got " + t("BAL1"));
  if (t("BAL2") !== 200) throw new Error("ACC_2 expected 200 got " + t("BAL2"));
});

assert("sumWhere + periodDays", () => {
  run(`var TX = [{type:"INCOME",amount:100},{type:"INCOME",amount:50},{type:"EXPENSE",amount:30}];`);
  if (t("sumWhere(TX,'INCOME')") !== 150) throw new Error("income");
  if (t("sumWhere(TX,'EXPENSE')") !== 30) throw new Error("expense");
  if (t("periodDays('2026-02')") !== 28) throw new Error("feb");
  if (t("periodDays('2026-08')") !== 31) throw new Error("aug");
});

assert("period math", () => {
  if (t("nextPeriod('2026-12')") !== "2027-01") throw new Error("next year rollover: " + t("nextPeriod('2026-12')"));
  if (t("prevPeriod('2026-01')") !== "2025-12") throw new Error("prev year rollover: " + t("prevPeriod('2026-01')"));
  if (t("monthDiff('2026-08-04','2026-05-04')") !== 3) throw new Error("monthDiff");
});

assert("Auth hash deterministic", () => {
  const h1 = t(`AuthService.hash("secret-token")`);
  const h2 = t(`AuthService.hash("secret-token")`);
  if (h1 !== h2) throw new Error("non-deterministic");
  if (h1.length !== 64) throw new Error("length");
  // dev mode: empty hash = open
  if (t(`AuthService.authorize("")`) !== true) throw new Error("dev mode should pass");
  // set a token hash and verify the gate
  run(`STUB.tables.settings.push({key:"api_token_hash", value:"` + h1 + `", value_type:"STRING"});`);
  if (t(`AuthService.authorize("wrong")`) !== false) throw new Error("wrong token accepted");
  if (t(`AuthService.authorize("secret-token")`) !== true) throw new Error("valid token rejected");
  run(`STUB.tables.settings.pop();`);
});

assert("Response envelope (health)", () => {
  const out = JSON.parse(t(`handleRequest({action:"health"}, "GET").toString()`));
  if (out.ok !== true) throw new Error("not ok");
  if (!out.meta.request_id) throw new Error("no request id");
  if (out.data.status !== "ok") throw new Error("health status");
});

assert("Unknown action rejected", () => {
  const out = JSON.parse(t(`handleRequest({action:"nope"}, "POST").toString()`));
  if (out.ok !== false || out.error.code !== "BAD_ACTION") throw new Error("bad action not rejected");
});

assert("Duplicate detection finds match", () => {
  run(`STUB.tables.transactions = [
    {transaction_id:"TRX_A", type:"EXPENSE", amount:10, currency:"USD", account_id:"ACC_1",
     from_account_id:"", to_account_id:"", category_id:"CAT_1", income_source_id:"",
     merchant:"Test", note:"", date:"2026-08-04", transaction_ts:new Date().toISOString(), status:"POSTED"}
  ];`);
  run(`var DUP = DuplicateDetectionService.findDuplicate({type:"EXPENSE",amount:10,currency:"USD",account_id:"ACC_1",category_id:"CAT_1",date:"2026-08-04",merchant:"Test",note:""}, STUB.tables.transactions);`);
  if (t("DUP === null")) throw new Error("should have matched");
});

assert("E2E transaction.create pipeline", () => {
  run(`STUB.tables.transactions = []; STUB.tables.audit_logs = [];`);
  const out = JSON.parse(t(`handleRequest({
    action:"transaction.create", type:"EXPENSE", amount:42.5, currency:"USD",
    account_id:"ACC_1", category_id:"CAT_1", merchant:"Groceries",
    date:"2026-08-04", external_ref:"e2e-1"
  }, "POST").toString()`));
  if (out.ok !== true) throw new Error(JSON.stringify(out.error));
  if (out.data.status !== "POSTED") throw new Error("status: " + out.data.status);
  if (out.data.duplicate !== false) throw new Error("false duplicate");
  if (!/^TRX_/.test(out.data.transaction_id)) throw new Error("bad id");
  if (t("STUB.tables.transactions.length") !== 1) throw new Error("ledger count");
  if (t("STUB.tables.audit_logs.length") !== 1) throw new Error("audit count");
});

assert("E2E duplicate by external_ref skips write", () => {
  run(`var ref = DuplicateDetectionService.findByExternalRef("e2e-1");`);
  if (t("ref === null")) throw new Error("expected existing external_ref");
  const out = JSON.parse(t(`handleRequest({
    action:"transaction.create", type:"EXPENSE", amount:42.5, currency:"USD",
    account_id:"ACC_1", category_id:"CAT_1", merchant:"Groceries",
    date:"2026-08-04", external_ref:"e2e-1"
  }, "POST").toString()`));
  if (out.data.duplicate !== true) throw new Error("should be flagged duplicate");
  if (t("STUB.tables.transactions.length") !== 1) throw new Error("ledger must NOT grow");
});

assert("E2E validation failure returns 400 + details", () => {
  const out = JSON.parse(t(`handleRequest({
    action:"transaction.create", type:"EXPENSE", amount:42.5, currency:"USD",
    account_id:"ACC_1", date:"2026-08-04"
  }, "POST").toString()`));
  if (out.ok !== false) throw new Error("should fail");
  if (out.error.code !== "VALIDATION_ERROR") throw new Error("wrong code: " + out.error.code);
  if (!out.error.details.some(d => d.rule === "EXPENSE_REQUIRES_CATEGORY")) throw new Error("rule missing");
});

assert("E2E account.create + list", () => {
  const out = JSON.parse(t(`handleRequest({
    action:"account.create", name:"New Bank", type:"BANK", currency:"USD", opening_balance:0
  }, "POST").toString()`));
  if (out.ok !== true) throw new Error(JSON.stringify(out.error));
  if (!/^ACC_/.test(out.data.account_id)) throw new Error("bad id");
  if (t("STUB.tables.accounts.length") !== 3) throw new Error("account count");
});

assert("account.create stores is_credit as TRUE/FALSE", () => {
  run(`handleRequest({
    action:"account.create", name:"Credit Card", type:"CREDIT_CARD", currency:"USD", is_credit:true
  }, "POST").toString()`);
  const rec = t(`STUB.tables.accounts[STUB.tables.accounts.length-1]`);
  if (rec.is_credit !== "TRUE") throw new Error("expected is_credit='TRUE' got " + rec.is_credit);
  const rec2 = t(`STUB.tables.accounts[2]`); // "New Bank" created without is_credit
  if (rec2.is_credit !== "FALSE") throw new Error("expected is_credit='FALSE'");
});

assert("netWorthAt never double-flips credit balances", () => {
  run(`var NW = netWorthAt([
    {account_id:"ACC_1", opening_balance:-1000, is_credit:"TRUE"},
    {account_id:"ACC_2", opening_balance:200, is_credit:false}
  ], [], "2026-08-04");`);
  if (t("NW") !== -800) throw new Error("negative liability expected -800 got " + t("NW"));
  run(`var NW2 = netWorthAt([
    {account_id:"ACC_1", opening_balance:1000, is_credit:"TRUE"},
    {account_id:"ACC_2", opening_balance:200, is_credit:false}
  ], [], "2026-08-04");`);
  if (t("NW2") !== 1200) throw new Error("no-flip expected 1200 got " + t("NW2"));
});

assert("UNKNOWN_FIELD_REJECTED enforced", () => {
  run(`var U = ValidationService.validateTransaction({type:"EXPENSE",amount:10,currency:"USD",account_id:"ACC_1",category_id:"CAT_1",date:"2026-08-04",magic:"x"});`);
  if (t("U.valid") !== false) throw new Error("unknown field accepted");
  if (!t("U.errors.some(function(e){return e.rule==='UNKNOWN_FIELD_REJECTED';})")) throw new Error("rule missing");
});

assert("TIMESTAMP_VALID enforced", () => {
  run(`var TS = ValidationService.validateTransaction({type:"EXPENSE",amount:10,currency:"USD",account_id:"ACC_1",category_id:"CAT_1",date:"2026-08-04",transaction_ts:"not-a-time"});`);
  if (t("TS.valid") !== false) throw new Error("bad timestamp accepted");
  if (!t("TS.errors.some(function(e){return e.rule==='TIMESTAMP_VALID';})")) throw new Error("rule missing");
});

assert("SOURCE_KNOWN enforced", () => {
  run(`var S1 = ValidationService.validateTransaction({type:"EXPENSE",amount:10,currency:"USD",account_id:"ACC_1",category_id:"CAT_1",date:"2026-08-04",source:"HACKED"});`);
  if (t("S1.valid") !== false) throw new Error("bad source accepted");
  run(`var S2 = ValidationService.validateTransaction({type:"EXPENSE",amount:10,currency:"USD",account_id:"ACC_1",category_id:"CAT_1",date:"2026-08-04",source:"SYSTEM"});`);
  if (t("S2.valid") !== true) throw new Error("valid source rejected: " + JSON.stringify(t("S2.errors")));
});

assert("transaction.get with invalid ts -> 400 not 500", () => {
  const out = JSON.parse(t(`handleRequest({
    action:"transaction.create", type:"EXPENSE", amount:10, currency:"USD",
    account_id:"ACC_1", category_id:"CAT_1", date:"2026-08-04", transaction_ts:"bogus"
  }, "POST").toString()`));
  if (out.ok !== false) throw new Error("should fail");
  if (out.error.code !== "VALIDATION_ERROR") throw new Error("expected VALIDATION_ERROR got " + out.error.code);
});

assert("500 responses never leak a stack trace", () => {
  const out = JSON.parse(t(`handleRequest({action:"transaction.get", transaction_id:"MISSING"}, "POST").toString()`));
  if (out.ok !== false || out.error.code !== "SERVER_ERROR") throw new Error("expected server error");
  if (JSON.stringify(out).indexOf(" at ") >= 0) throw new Error("stack leaked");
});

assert("apiList sorts by date desc with stable comparator", () => {
  run(`STUB.tables.transactions = [
    {transaction_id:"T1", type:"EXPENSE", date:"2026-08-04"},
    {transaction_id:"T2", type:"EXPENSE", date:"2026-08-04"},
    {transaction_id:"T3", type:"EXPENSE", date:"2026-08-01"}
  ];`);
  run(`var LIST = TransactionService.apiList({}).data;`);
  if (t("LIST[0].date") !== "2026-08-04") throw new Error("first not newest");
  if (t("LIST[2].date") !== "2026-08-01") throw new Error("last not oldest");
  if (t("LIST.length") !== 3) throw new Error("missing rows");
});

assert("Recurring run never double-books an occurrence", () => {
  const today = t("todayStamp()");
  run(`STUB.tables.transactions = [];
  STUB.tables.recurring = [{
    recurring_id:"REC_1", name:"Rent", type:"EXPENSE", amount:100, currency:"USD",
    frequency:"MONTHLY", start_date:"2026-08-01", end_date:"", next_run:"${today}",
    last_run:"", account_id:"ACC_1", category_id:"CAT_1", status:"ACTIVE"
  }];`);
  t(`RecurringService.run()`);
  t(`RecurringService.run()`);
  if (t("STUB.tables.transactions.length") !== 1) throw new Error("double-booked: " + t("STUB.tables.transactions.length"));
  if (t("STUB.tables.transactions[0].external_ref") !== "REC-REC_1-" + today) throw new Error("bad ext ref");
  if (t("STUB.tables.recurring[0].next_run") === today) throw new Error("next_run not advanced");
});

assert("computeNextRun WEEKLY honors day_of_week (1=Mon..7=Sun)", () => {
  const c = (rule, from) => t(`RecurringService.computeNextRun(${JSON.stringify(rule)}, "EXPENSE", "${from}")`);
  // 2026-08-06 is a Thursday
  if (c({frequency:"WEEKLY", day_of_week:1}, "2026-08-06") !== "2026-08-10") throw new Error("next Monday");
  if (c({frequency:"WEEKLY", day_of_week:7}, "2026-08-06") !== "2026-08-09") throw new Error("next Sunday");
  if (c({frequency:"WEEKLY", day_of_week:7}, "2026-08-09") !== "2026-08-16") throw new Error("Sunday stays Sunday");
  if (c({frequency:"WEEKLY", day_of_week:""}, "2026-08-06") !== "2026-08-13") throw new Error("default keeps weekday");
});

assert("computeNextRun MONTHLY honors day_of_month with clamping", () => {
  const c = (rule, from) => t(`RecurringService.computeNextRun(${JSON.stringify(rule)}, "EXPENSE", "${from}")`);
  if (c({frequency:"MONTHLY", day_of_month:15}, "2026-08-20") !== "2026-09-15") throw new Error("monthly 15th");
  if (c({frequency:"MONTHLY", day_of_month:31}, "2026-01-31") !== "2026-02-28") throw new Error("31st clamps Feb");
  if (c({frequency:"MONTHLY", day_of_month:31}, "2026-08-15") !== "2026-09-30") throw new Error("31st clamps 30-day Sep");
  if (c({frequency:"MONTHLY", day_of_month:31}, "2024-01-31") !== "2024-02-29") throw new Error("leap Feb 29");
  if (c({frequency:"MONTHLY", day_of_month:31}, "2026-03-15") !== "2026-04-30") throw new Error("30-day April clamp");
  if (c({frequency:"MONTHLY", day_of_month:""}, "2026-01-31") !== "2026-02-28") throw new Error("default dom clamps");
});

assert("computeNextRun QUARTERLY/YEARLY clamp deterministically", () => {
  const c = (rule, from) => t(`RecurringService.computeNextRun(${JSON.stringify(rule)}, "EXPENSE", "${from}")`);
  if (c({frequency:"QUARTERLY", day_of_month:30}, "2026-04-30") !== "2026-07-30") throw new Error("quarterly 30th");
  if (c({frequency:"QUARTERLY", day_of_month:31}, "2026-11-30") !== "2027-02-28") throw new Error("quarterly clamps Feb");
  if (c({frequency:"YEARLY", day_of_month:29}, "2024-02-29") !== "2025-02-28") throw new Error("yearly leap -> Feb 28");
  if (c({frequency:"YEARLY", day_of_month:29}, "2023-02-28") !== "2024-02-29") throw new Error("yearly into leap year");
  if (c({frequency:"YEARLY", day_of_month:31}, "2026-08-15") !== "2027-08-31") throw new Error("yearly dom preserved");
  if (c({frequency:"DAILY", day_of_month:""}, "2026-08-06") !== "2026-08-07") throw new Error("daily +1");
});

assert("Recurring missed runs materialized exactly once across a long gap", () => {
  const now = new Date();
  const y = now.getUTCFullYear(), m = now.getUTCMonth();
  const stamp = (yy, mm, dd) => new Date(Date.UTC(yy, mm, dd)).toISOString().slice(0, 10);
  // occurrences: the 5th of each month from next_run through today
  const expected = [];
  for (let i = 12; i >= 0; i--) {
    const d = new Date(Date.UTC(y, m - i, 5));
    if (d <= now) expected.push(stamp(d.getUTCFullYear(), d.getUTCMonth(), 5));
  }
  const firstNext = expected[0];
  run(`STUB.tables.transactions = [];
  STUB.tables.recurring = [{
    recurring_id:"REC_2", name:"Sub", type:"EXPENSE", amount:9.99, currency:"USD",
    frequency:"MONTHLY", day_of_month:5, start_date:"2020-01-01", end_date:"",
    next_run:"${firstNext}", last_run:"", account_id:"ACC_1", category_id:"CAT_1", status:"ACTIVE"
  }];`);
  const res1 = t(`RecurringService.run()`);
  if (res1.data.materialized !== expected.length) throw new Error("expected " + expected.length + " got " + res1.data.materialized);
  const rows1 = t("STUB.tables.transactions");
  if (rows1.length !== expected.length) throw new Error("row count " + rows1.length + " != " + expected.length);
  const dates = rows1.map(r => r.date).sort();
  expected.sort();
  for (let i = 0; i < expected.length; i++) {
    if (dates[i] !== expected[i]) throw new Error("missing " + expected[i] + " got " + dates.join(","));
  }
  const extRefs = rows1.map(r => r.external_ref);
  if (new Set(extRefs).size !== extRefs.length) throw new Error("duplicate extRefs");
  if (rows1.some(r => r.external_ref !== "REC-REC_2-" + r.date)) throw new Error("extRef date mismatch");
});

assert("Recurring repeated execution stays idempotent", () => {
  const now = new Date();
  const y = now.getUTCFullYear(), m = now.getUTCMonth();
  const firstNext = new Date(Date.UTC(y, m - 3, 5)).toISOString().slice(0, 10);
  run(`STUB.tables.transactions = [];
  STUB.tables.recurring = [{
    recurring_id:"REC_3", name:"Rent", type:"EXPENSE", amount:100, currency:"USD",
    frequency:"MONTHLY", day_of_month:5, start_date:"2020-01-01", end_date:"",
    next_run:"${firstNext}", last_run:"", account_id:"ACC_1", category_id:"CAT_1", status:"ACTIVE"
  }];`);
  const r1 = t(`RecurringService.run()`).data.materialized;
  const c1 = t("STUB.tables.transactions.length");
  const r2 = t(`RecurringService.run()`).data.materialized;
  const c2 = t("STUB.tables.transactions.length");
  const r3 = t(`RecurringService.run()`).data.materialized;
  const c3 = t("STUB.tables.transactions.length");
  if (!(r1 > 0)) throw new Error("first run should materialize");
  if (r2 !== 0 || r3 !== 0) throw new Error("repeat runs must book nothing");
  if (c1 !== c2 || c2 !== c3) throw new Error("transaction count changed: " + c1 + "," + c2 + "," + c3);
});

assert("Recurring end_date marks rule COMPLETED without overbooking", () => {
  const now = new Date();
  const y = now.getUTCFullYear(), m = now.getUTCMonth();
  const stamp = (yy, mm, dd) => new Date(Date.UTC(yy, mm, dd)).toISOString().slice(0, 10);
  const end = new Date(Date.UTC(y, m - 2, 1)); // ends two months ago
  const first = new Date(Date.UTC(y, m - 4, 1));
  run(`STUB.tables.transactions = [];
  STUB.tables.recurring = [{
    recurring_id:"REC_4", name:"Ends", type:"EXPENSE", amount:50, currency:"USD",
    frequency:"MONTHLY", day_of_month:1, start_date:"2020-01-01", end_date:"${stamp(end.getUTCFullYear(), end.getUTCMonth(), 1)}",
    next_run:"${stamp(first.getUTCFullYear(), first.getUTCMonth(), 1)}", last_run:"",
    account_id:"ACC_1", category_id:"CAT_1", status:"ACTIVE"
  }];`);
  t(`RecurringService.run()`);
  if (t("STUB.tables.recurring[0].status") !== "COMPLETED") throw new Error("not COMPLETED");
  if (t("STUB.tables.recurring[0].next_run") !== "") throw new Error("next_run not cleared");
  const rows = t("STUB.tables.transactions");
  if (rows.length !== 3) throw new Error("expected 3 occurrences got " + rows.length);
  const last = rows[rows.length - 1].date;
  if (last !== stamp(end.getUTCFullYear(), end.getUTCMonth(), 1)) throw new Error("overbooked past end_date: " + last);
});

assert("writeMonthly TREND labeled on later month with correct sign", () => {
  run(`STUB.tables.monthly_analytics = [];
  STUB.tables.transactions = [
    {type:"INCOME", amount:100, account_id:"ACC_1", date:"2026-07-15", status:"POSTED"},
    {type:"INCOME", amount:200, account_id:"ACC_1", date:"2026-08-15", status:"POSTED"}
  ];`);
  t(`AnalyticsService.writeMonthly(["2026-07","2026-08"])`);
  const rows = t(`STUB.tables.monthly_analytics`);
  const trend = rows.filter(r => r.metric === "TREND_INCOME" && r.period === "2026-08");
  if (trend.length !== 1) throw new Error("TREND_INCOME for 2026-08 missing");
  if (Math.abs(trend[0].value - 1) > 1e-9) throw new Error("expected +1.0 got " + trend[0].value);
  if (rows.some(r => r.metric === "TREND_INCOME" && r.period === "2026-07")) throw new Error("trend on older month");
});

assert("replaceRows never corrupts kept rows", () => {
  run(`STUB.tables.monthly_analytics = [
    {analytics_id:"A1", period:"2026-01", metric:"INCOME", dimension:"", rank:"", value:100, generated_at:"x"},
    {analytics_id:"A2", period:"2026-02", metric:"INCOME", dimension:"", rank:"", value:200, generated_at:"x"}
  ];`);
  t(`AnalyticsService.replaceRows(["2026-02"], [["NEW","2026-02","INCOME","","","300","gen"]])`);
  const rows = t(`STUB.tables.monthly_analytics`);
  if (rows.length !== 2) throw new Error("expected 2 rows got " + rows.length);
  const kept = rows.filter(r => r.analytics_id === "A1");
  if (kept.length !== 1 || kept[0].value !== 100) throw new Error("kept row corrupted");
  const fresh = rows.filter(r => r.period === "2026-02" && Number(r.value) === 300);
  if (fresh.length !== 1) throw new Error("new matrix missing");
});

assert("replaceRows prunes rows outside retention window", () => {
  run(`STUB.tables.monthly_analytics = [
    {analytics_id:"OLD", period:"2026-01", metric:"INCOME", dimension:"", rank:"", value:100, generated_at:"x"}
  ];`);
  run(`STUB.tables.settings.push({key:"analytics_retention_months", value:"1", value_type:"NUMBER"});`);
  t(`AnalyticsService.replaceRows(["2026-08"], [["NEW","2026-08","INCOME","","","300","gen"]])`);
  const rows = t(`STUB.tables.monthly_analytics`);
  if (rows.some(r => r.period === "2026-01")) throw new Error("old period not pruned");
  if (rows.length !== 1) throw new Error("expected exactly the fresh row");
  run(`STUB.tables.settings.pop();`);
});

assert("Repository readTable caches and invalidates", () => {
  run(`__sheetCalls = 0;
  __savedSheet = tableSheet;
  tableSheet = function(t){ __sheetCalls++; return {getLastRow:function(){return 1;}, getLastColumn:function(){return 1;}}; };
  __realReadTable("transactions");
  __realReadTable("transactions");
  __c1 = __sheetCalls;
  invalidateCache("transactions");
  __realReadTable("transactions");
  __c2 = __sheetCalls;
  tableSheet = __savedSheet;`);
  if (t("__c1") !== 1) throw new Error("expected 1 sheet read for 2 calls, got " + t("__c1"));
  if (t("__c2") !== 2) throw new Error("cache not invalidated: " + t("__c2"));
});

assert("Dashboard formulas are self-consistent", () => {
  const nw = t(`DashboardService.fNetWorth()`);
  if (nw.indexOf("-accounts") >= 0 || nw.indexOf('$J2:$J') >= 0) throw new Error("fNetWorth must not flip credit balances");
  if (nw.indexOf("SUM(accounts!$F$2:$F)") < 0) throw new Error("fNetWorth must be plain sum of balances");
  const sr = t(`DashboardService.fMetric("SAVINGS_RATE")`);
  if (sr.indexOf("EOMONTH(TODAY(),0)") < 0) throw new Error("savings rate not bounded to current month");
  const inc = t(`DashboardService.fMetric("INCOME")`);
  if (inc.indexOf('SUMIFS(transactions!$E:$E,transactions!$D:$D,"INCOME"') < 0) throw new Error("fMetric income");
});

assert("Data validation applies priority dropdown to goals column 9 (deadline is 8)", () => {
  run(`__dv = [];
  __origSheet = tableSheet;
  __origSA = SpreadsheetApp;
  SpreadsheetApp = { newDataValidation: function() {
    return { lists: [], requireValueInList: function(l){ this.lists.push(l); return this; },
             setAllowInvalid: function(){ return this; },
             build: function(){ var lists = this.lists; return { get list(){ return lists[lists.length-1]; } }; } };
  } };
  tableSheet = function(name){
    return { getLastRow: function(){return 9;}, getLastColumn: function(){return 13;},
      getRange: function(r, c){ __dv.push({name:name, col:c, list:null});
        return { setDataValidation: function(rule){ __dv[__dv.length-1].list = rule.list; } }; } };
  };
  FormattingService.dataValidation();
  tableSheet = __origSheet;
  SpreadsheetApp = __origSA;`);
  const dv = t("__dv");
  const goals = dv.filter(d => d.name === "goals");
  if (goals.length !== 3) throw new Error("expected 3 goals dropdowns got " + goals.length);
  const pri = goals.filter(d => d.list && d.list.indexOf("HIGH") >= 0);
  if (pri.length !== 1) throw new Error("priority dropdown missing");
  if (pri[0].col !== 9) throw new Error("priority dropdown on column " + pri[0].col + " (must be 9)");
  const st = goals.filter(d => d.list && d.list.indexOf("ACTIVE") >= 0);
  if (st.length !== 1 || st[0].col !== 12) throw new Error("goals status dropdown must be column 12");
});

assert("Conditional rules install on the SHEET, not the Range (Sheet.setConditionalFormatRules)", () => {
  run(`__cr = {};
  __origOpenDb = openDb;
  __origSheet = tableSheet;
  __origSA = SpreadsheetApp;
  openDb = function(){ return { getSheetByName: function(name){
    if (name !== "dashboard") return null;
    return { getRange: function(){ return {}; },
             setConditionalFormatRules: function(rules){ __cr.dashboard = rules.length; } };
  } }; };
  tableSheet = function(name){
    var last = name === "financial_score" ? 5 : name === "transactions" ? 9 : 1;
    return { getLastRow: function(){ return last; },
             getRange: function(){ return {}; },
             setConditionalFormatRules: function(rules){ __cr[name] = rules.length; } };
  };
  SpreadsheetApp = { newConditionalFormatRule: function() {
    return { whenCellNotEmpty: function(){ return this; },
             whenTextEqualTo: function(){ return this; },
             setBackground: function(){ return this; },
             setFontColor: function(){ return this; },
             setRanges: function(){ return this; },
             build: function(){ return {}; } };
  } };
  FormattingService.conditionalRules();
  openDb = __origOpenDb;
  tableSheet = __origSheet;
  SpreadsheetApp = __origSA;`);
  const cr = t("__cr");
  if (cr.dashboard !== 1) throw new Error("dashboard should get 1 rule, got " + cr.dashboard);
  if (cr.financial_score !== 3) throw new Error("financial_score should get 3 rules, got " + cr.financial_score);
  if (cr.transactions !== 3) throw new Error("transactions should get 3 rules, got " + cr.transactions);
  // The range stubs have NO setConditionalFormatRules (the API is Sheet-only); the
  // old Range call would throw, be swallowed by the try/catch, and install nothing.
  if (Object.keys(cr).length !== 3) throw new Error("rules not installed via Sheet API: " + JSON.stringify(cr));
});

assert("Warning-only protections never mutate editor lists (invalid API)", () => {
  run(`__prot = { calls: [], editorsTouched: false, warningOnly: 0 };
  __origSheet = tableSheet;
  tableSheet = function(){
    return { protect: function(){
      var prot = { setDescription: function(){ return this; },
                   setWarningOnly: function(v){ if (v) __prot.warningOnly++; return this; },
                   canEdit: function(){ __prot.editorsTouched = true; return true; },
                   getEditors: function(){ __prot.editorsTouched = true; return []; },
                   removeEditors: function(){ __prot.editorsTouched = true; } };
      __prot.calls.push("protected");
      return prot;
    } };
  };
  FormattingService.protectTables();
  tableSheet = __origSheet;`);
  const p = t("__prot");
  if (p.calls.length !== Object.keys(t("TABLES")).length) {
    throw new Error("expected every data table protected, got " + p.calls.length);
  }
  if (p.warningOnly !== p.calls.length) throw new Error("warning-only not applied to every protection");
  if (p.editorsTouched) throw new Error("editor-list APIs must never be called on warning-only protections");
});

assert("fBurn reports monthly burn, not per-transaction average", () => {
  const burn = t(`DashboardService.fBurn()`);
  if (burn.indexOf("GROUP BY") < 0) throw new Error("fBurn must group expenses by month");
  if (burn.indexOf("YEAR(Col1), MONTH(Col1)") < 0) throw new Error("fBurn must aggregate per month");
  if (burn.indexOf("LIMIT 3") < 0) throw new Error("fBurn must use burn_rate_months (default 3)");
  if (burn.indexOf("LIMIT 90") >= 0) throw new Error("fBurn still averages raw transactions");
});

assert("Analytics metric lookup group covers every metric", () => {
  const metrics = ["INCOME","EXPENSE","SAVINGS","CASH_FLOW","SAVINGS_RATE","AVG_DAILY_SPEND",
    "CATEGORY_SPEND","MERCHANT_SPEND","ACCOUNT_BALANCE","NET_WORTH","BURN_RATE",
    "TREND_INCOME","TREND_EXPENSE","TREND_NET_WORTH"];
  metrics.forEach(m => {
    if (!t(`DEFAULT_LOOKUPS.some(function(l){return l[0]==="metric" && l[1]==="${m}";})`)) {
      throw new Error("metric lookup missing: " + m);
    }
  });
});

assert("Row-level formula helpers are safe when the sheet is unavailable", () => {
  if (t(`(function(){try{FormattingService.applyAccountFormula(2);return "ok";}catch(e){return "threw:"+e.message;}})()`) !== "ok") throw new Error("applyAccountFormula threw");
  if (t(`(function(){try{FormattingService.applyGoalFormulas(2);return "ok";}catch(e){return "threw:"+e.message;}})()`) !== "ok") throw new Error("applyGoalFormulas threw");
});

assert("E2E goal.create + list", () => {
  run(`STUB.tables.goals = [];`);
  const out = JSON.parse(t(`handleRequest({
    action:"goal.create", name:"Emergency Fund", goal_type:"EMERGENCY_FUND", target_amount:3000,
    currency:"USD", linked_account_id:"ACC_1", priority:"HIGH", monthly_contribution:200
  }, "POST").toString()`));
  if (out.ok !== true) throw new Error(JSON.stringify(out.error));
  if (!/^GOL_/.test(out.data.goal_id)) throw new Error("bad id");
  if (t("STUB.tables.goals.length") !== 1) throw new Error("goal count");
});

assert("guardFormula neutralizes spreadsheet formula injection", () => {
  if (t(`guardFormula("=1+1")`) !== "'=1+1") throw new Error("= not neutralized");
  if (t(`guardFormula("+1+1")`) !== "'+1+1") throw new Error("+ not neutralized");
  if (t(`guardFormula("@SUM(A1)")`) !== "'@SUM(A1)") throw new Error("@ not neutralized");
  if (t(`guardFormula("plain")`) !== "plain") throw new Error("plain string altered");
  if (t(`guardFormula("=already'=quoted")`) !== "'=already'=quoted") throw new Error("quoted case");
  if (t(`guardFormula(42)`) !== 42) throw new Error("number altered");
  if (t(`guardFormula(true)`) !== true) throw new Error("boolean altered");
});

assert("Import writes formula-safe values through the persistence layer", () => {
  run(`__capValues = null;
  __savedAppendRow = appendRow;
  __savedTableSheet = tableSheet;
  appendRow = __realAppendRow;
  tableSheet = function(name){
    return { getLastRow: function(){return 1;}, getLastColumn: function(){return 1;},
      appendRow: function(v){ __capValues = v; },
      getRange: function(){ return { setValues: function(){} }; } };
  };
  MigrationService.apiImport({table:"categories", rows:[{name:"=1+1", type:"EXPENSE", status:"ACTIVE"}]});
  appendRow = __savedAppendRow;
  tableSheet = __savedTableSheet;`);
  const v = t("__capValues");
  const name = v[t(`TABLES.categories.cols.indexOf("name")`)];
  if (name !== "'=1+1") throw new Error("name not neutralized: " + name);
  const type = v[t(`TABLES.categories.cols.indexOf("type")`)];
  if (type !== "EXPENSE") throw new Error("plain field altered: " + type);
});

assert("settings.get masks secret values", () => {
  run(`STUB.tables.settings.push({key:"api_token_hash", value:"deadbeef", value_type:"STRING", is_secret:true, description:"", updated_at:"x"});`);
  const masked = t(`SettingsService.apiGet({key:"api_token_hash"}).data.value`);
  if (masked !== "****") throw new Error("secret not masked: " + masked);
  const all = t(`SettingsService.apiGet({}).data.filter(function(s){return s.key==="api_token_hash";})[0].value`);
  if (all !== "****") throw new Error("all() leaked secret: " + all);
  const open = t(`SettingsService.apiGet({key:"base_currency"}).data.value`);
  if (open !== "USD") throw new Error("non-secret altered: " + open);
  run(`STUB.tables.settings.pop();`);
});

assert("GET only permits read-only actions; mutations require POST", () => {
  run(`STUB.tables.transactions = [];`);
  const denied = JSON.parse(t(`handleRequest({
    action:"transaction.create", type:"EXPENSE", amount:1, currency:"USD",
    account_id:"ACC_1", category_id:"CAT_1", date:"2026-08-04"
  }, "GET").toString()`));
  if (denied.ok !== false || denied.error.code !== "METHOD_NOT_ALLOWED") {
    throw new Error("mutation over GET not blocked: " + JSON.stringify(denied.error));
  }
  if (t("STUB.tables.transactions.length") !== 0) throw new Error("GET mutated the ledger");
  const imp = JSON.parse(t(`handleRequest({action:"import", table:"transactions", rows:[]}, "GET").toString()`));
  if (imp.error && imp.error.code === "METHOD_NOT_ALLOWED" && imp.ok === false) {
    // expected blocked
  } else throw new Error("import over GET not blocked");
  const ok = JSON.parse(t(`handleRequest({action:"health"}, "GET").toString()`));
  if (ok.ok !== true) throw new Error("read-only GET blocked: " + JSON.stringify(ok.error));
  const post = JSON.parse(t(`handleRequest({action:"health"}, "POST").toString()`));
  if (post.ok !== true) throw new Error("read-only POST blocked");
});

assert("Import rejects malformed rows before writing anything", () => {
  run(`STUB.tables.transactions = [];`);
  const out = JSON.parse(t(`handleRequest({action:"import", table:"transactions", rows:[null]}, "POST").toString()`));
  if (out.ok !== false || out.error.code !== "VALIDATION_ERROR") {
    throw new Error("null row accepted: " + JSON.stringify(out.error));
  }
  if (t("STUB.tables.transactions.length") !== 0) throw new Error("partial write on invalid import");
  const rowArr = JSON.parse(t(`handleRequest({action:"import", table:"transactions", rows:[[1,2]]}, "POST").toString()`));
  if (rowArr.ok !== false || rowArr.error.code !== "VALIDATION_ERROR") throw new Error("array row accepted");
  if (t("STUB.tables.transactions.length") !== 0) throw new Error("array row wrote data");
});

assert("Import enforces a per-request row cap", () => {
  run(`STUB.tables.transactions = [];`);
  const big = [];
  for (let i = 0; i < t(`MAX_IMPORT_ROWS`) + 1; i++) big.push({});
  const out = JSON.parse(t(`handleRequest({action:"import", table:"transactions", rows:${JSON.stringify(big)}}, "POST").toString()`));
  if (out.ok !== false || out.error.code !== "VALIDATION_ERROR") {
    throw new Error("oversized import accepted: " + JSON.stringify(out.error));
  }
  if (t("STUB.tables.transactions.length") !== 0) throw new Error("oversized import wrote data");
});

assert("Settings writes acquire the script lock (and are reentrant-safe)", () => {
  let acquires = 0;
  const savedLock = ctx.LockService;
  ctx.LockService = { getScriptLock: () => ({
    tryLock() { acquires++; return true; },
    releaseLock() {}
  }) };
  run(`STUB.tables.settings.push({key:"lock_probe", value:"", value_type:"STRING", is_secret:false});`);
  try {
    t(`SettingsService.set("lock_probe", "v", "STRING", "d", false)`);
    if (acquires !== 1) throw new Error("settings.set did not acquire the script lock (" + acquires + ")");
    const beforeNested = acquires;
    t(`withLock(function(){ return SettingsService.set("lock_probe", "w", "STRING", "d", false); })`);
    if (acquires !== beforeNested + 1) {
      throw new Error("nested settings.set re-acquired the lock (deadlock risk)");
    }
    if (t(`STUB.tables.settings.filter(function(s){return s.key==="lock_probe";})[0].value`) !== "w") {
      throw new Error("nested set did not persist");
    }
  } finally {
    ctx.LockService = savedLock;
    run(`STUB.tables.settings = STUB.tables.settings.filter(function(s){return s.key!=="lock_probe";});`);
  }
});

assert("Roadmap regeneration preserves the STG_ stage_id primary key", () => {
  run(`STUB.tables.roadmap = [];
  STUB.tables.transactions = [];
  STUB.tables.monthly_analytics = [];`);
  t(`RoadmapService.update()`);
  t(`RoadmapService.update()`);
  const rows = t(`STUB.tables.roadmap`);
  if (rows.length !== 7) throw new Error("expected 7 roadmap stages, got " + rows.length);
  rows.forEach((r, i) => {
    if (!r.stage_id || !/^STG_[A-Z0-9]+$/.test(String(r.stage_id))) {
      throw new Error("stage " + (i + 1) + " lost its stage_id after regeneration: " + r.stage_id);
    }
    if (String(r.stage_order) !== String(i + 1)) throw new Error("stage_order mismatch on regen");
  });
});

console.log(failures === 0 ? "\nALL TESTS PASSED" : `\n${failures} TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
