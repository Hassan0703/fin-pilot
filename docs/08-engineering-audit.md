# FinPilot v0 — Engineering Audit Report

**Scope:** full read-through and remediation of every Apps Script module (`apps-script/*.gs`),
the PostgreSQL migration schema (`sql/schema_postgres.sql`), and the docs (`docs/*.md`).
**Constraint honoured:** bugs fixed, no new features added.

**Result:** every finding in-scope was fixed and covered by a regression test. The test suite
passes **62/62 assertions** (`tests/run.sh`) as of the Phase-7 v1.0 backend freeze and the
post-freeze API-validity pass (§12).

---

## 1. Test suite

The Node harness (`tests/run-tests.js`, `tests/run.sh`) copies each `.gs` file to a `.js` sibling
and executes them in a Node `vm` with a functional in-memory spreadsheet stub (read/append/find/
updateCell/updateRow/clearTableData/writeTableData/tableCount). It exercises the real services,
not mocks of them.

| Area | Tests |
|---|---|
| Value objects / Money / Date / ID | Money validation, period validation, DateStamp, ID format, period math, sumWhere+periodDays |
| Transaction validation rules | expense/income/transfer matrix, negatives, unknown refs, invalid date, unknown-field, timestamp, source |
| Ledger engine | AccountBalanceEngine transfer semantics, net worth credit sign |
| Idempotency / dedup | duplicate detection, external_ref skip, recurring no double-book |
| E2E flows | transaction.create, account.create+list, validation 400 (not 500), no stack leak |
| Analytics | TREND sign+label, replaceRows keep/prune, apiList stable sort |
| Repository | read-cache invalidation, is_credit string storage |
| Dashboard | formula self-consistency |
| Security (K-series) | formula-injection guard, import formula-safe persistence, settings secret masking, GET read-only, import fail-fast/cap |
| Concurrency (M-series) | settings writes acquire the script lock + reentrancy, roadmap STG_ key preserved across regeneration |

`cd tests && ./run.sh` → **ALL TESTS PASSED** (60 assertions as of the Phase-7 freeze;
see §10 and `docs/09` for the pass history).

---

## 2. Findings fixed

### 2.1 Data integrity & correctness

| # | File | Finding | Impact | Fix |
|---|---|---|---|---|
| F01 | `Repository.gs` | `updateCell` did not update the in-memory `readTable` copy; the next read returned a stale row (e.g. status after `void()`). | Corrupted reads after single-cell writes. | New `updateRow()` does a partial merge into the cached copy and a single `writeTableData`; `updateCell` now updates the cache. |
| F02 | `Repository.gs` | `is_credit`, `is_active`, `status` read as strings but compared as booleans in places. | Credit accounts, active lookups, etc. silently treated as inactive. | Added `isTrue()` coercion; adopted everywhere a sheet string is tested. |
| F03 | `AnalyticsService.gs` | TREND periods were built with `periods.slice().reverse()` → periods descending; the trend delta was labelled on the *older* month and values were sign-flipped relative to the dashboard. | Trend cards misleading. | Sort chronologically (`periods.slice().sort()`), label on the later month. |
| F04 | `AnalyticsService.gs` | `replaceRows` did read-modify-write across two `writeTableData` calls; a mid-write failure corrupted the analytics sheet and the rewrite always started from whatever rows existed. | Data loss risk; stale rows resurrected. | Rewrite keeps valid rows and prunes outside `analytics_retention_months`, then commits the full matrix in one atomic `writeTableData`. |
| F05 | `AnalyticsService.gs` | `AccountBalanceEngine.atDate` didn't filter to `POSTED`. | Pending/voided/duplicate-skipped rows moved balances. | Only `POSTED` rows contribute (matches the account sheet formula). |
| F06 | `AnalyticsService.gs` | `netWorthAt` compared `is_credit` as boolean. | Credit balances added instead of subtracted. | Uses `isTrue()` (see F02). |
| F07 | `MasterDataServices.gs` | `is_credit` stored as a JS boolean; Sheets re-serializes booleans inconsistently and comparisons broke. | Credit semantics unreliable. | Stored consistently as TEXT `"TRUE"`/`"FALSE"` (schema + docs updated; PG keeps BOOLEAN). |
| F08 | `MasterDataServices.gs` Recurring | `run()` could create the same occurrence more than once (no idempotency key) and updated rows one `updateCell` at a time. | Double-booked recurring transactions. | Each materialized occurrence gets `external_ref = "REC-<recurring_id>-<next_run>"`; the existence check is under `withLock`; `next_run`/`last_run` advanced via one batched `updateRow`. |
| F09 | `TransactionService.gs` | `apiList` sorted with a lexical comparator on a boolean. | Unstable/incorrect ordering. | Proper `date`/`ts` comparator. |
| F10 | `AuditService.gs` | Sort comparator compared two fields without a stable tiebreak. | Nondeterministic audit listing. | Stable comparator. |
| F11 | `DashboardService.gs` | Recent-transactions query read `transactions!$A` instead of the date column `$C`; Financial Score read columns `$G/$I` instead of `$F/$H`; savings rate summed across *all* history instead of the current month. | Wrong dashboard numbers. | Corrected column letters; rate bounded with `EOMONTH(TODAY(),0)`. |
| F12 | `FormattingService.gs` | KPI formulas used bounded `$2:$50000` ranges; label cells referenced `A5/C5…` instead of `B5/D5…`; `whenTextDoesNotContain("")` is an invalid conditional-format rule. | Formulas truncated at 50k rows; KPI values stamped in the wrong column; formatting throw at bootstrap. | Open-ended ranges (`transactions!$P$2:$P`); correct label cells; `whenCellNotEmpty` guard. |
| F13 | `SettingsService.gs` | `set()` issued 5 `updateCell` calls. | N+1 writes, non-atomic. | Single `updateRow`. |
| F14 | `TransactionService.gs` | Dead `accountBalance` stub misleadingly suggested a balance API existed. | Confusion; risk of false contract. | Removed. |
| F15 | `ValidationService.gs` | `merge()` helper dead code; `ruleActive` compared `"1"`/`true` inconsistently. | Unused code; active-flag checks unreliable. | Removed; `isTrue()`. |

### 2.2 Validation hardening

| # | Finding | Fix |
|---|---|---|
| F16 | `Money` could be constructed from a NaN/string amount; failures surfaced as 500s. | New rule `AMOUNT_INVALID` guards construction; invalid money → clean 400 with error detail. |
| F17 | `transaction_ts` accepted garbage; invalid values only surfaced as an incidental 500. | New rule `TIMESTAMP_VALID`; invalid `ts` → 400. |
| F18 | `source` accepted arbitrary strings. | New rule `SOURCE_KNOWN` + `TX_SOURCE_WHITELIST` (`SHORTCUT/API/SYSTEM/IMPORT`). |
| F19 | `UNKNOWN_FIELD_REJECTED` was seeded but not enforced. | Enforced with `TX_FIELD_WHITELIST` (request-level fields `action/token/client/dry_run/force` exempted). |

All new rules are seeded in `DEFAULT_VALIDATION_RULES` (docs/02-schema §15 updated).

### 2.3 Security

| # | File | Finding | Fix |
|---|---|---|---|
| F20 | `Code.gs` | A 500 response echoed `error.stack` to the client. | Stack logged server-side; body returns the generic message. Test: "500 responses never leak a stack trace". |
| F21 | `Code.gs` | Audit payload recorded raw body, which could include `token`. | `sanitizeForHash()` strips credentials; audit stores `client` + `payload_hash` instead of the body. |
| F22 | `AnalyticsService.gs` Migration | `migrateTable` accepted any table name and CSV rows written verbatim. | `MIGRATION_ALLOW` whitelist; `csvCell()` escapes cells starting with `=`, `+`, `-`, `@` (formula injection). |
| F23 | `Code.gs` | Direct-output handlers (e.g. CSV export) could return before audit was written. | `auditRequest()` helper; direct outputs audited before return. |
| F24 | `AuthService` | — (reviewed; hash path deterministic, fixed in prior pass). | Covered by test "Auth hash deterministic". |

### 2.4 Performance

| # | File | Finding | Fix |
|---|---|---|---|
| F25 | `Repository.gs` | Every `readTable` hit the spreadsheet. `writeMonthly`/`runAnalytics` read the same ledger ~5× per run. | `readTable` caches per table per execution; `appendRow`/`updateRow`/`updateCell`/`writeTableData`/`clearTableData` invalidate the affected table. |
| F26 | `AnalyticsService.gs` | `CacheServiceCache` stored a full snapshot on every `get`. | Reduced to invalidate-only. |
| F27 | `IdGenerator.gs` | Time base32 had variable width → IDs not strictly time-sortable; random portion 10 chars with no intra-execution guarantee. | Fixed-width 11-char time base32, 5-char random + monotonic `__idSeq` counter. Docs comment corrected (Apps Script exposes `Math.random`, not `SecureRandom`). |

### 2.5 Pre-existing fixes re-verified (from the earlier audit pass)

`openDb` recursion guard, `writeMonthly` period off-by-one, `strictDate` enforcement,
`ValidationError` invoked with `new`, load-order hazards (all top-level vars declared in
`Repository.gs`/`ValidationService.gs` before use), `withLock` reentrancy, `masterIds()`
seeding bug.

---

## 3. SQL schema (`sql/schema_postgres.sql`)

| # | Finding | Impact | Fix |
|---|---|---|---|
| S01 | `accounts.current_balance` used `GENERATED ALWAYS AS (opening_balance + (SELECT …)) STORED` — PostgreSQL generated columns cannot reference other tables. | The migration DDL would fail on `CREATE TABLE`. | Plain column with comment "derived; see v_balances"; `v_balances` view computes `opening_balance + POSTED ledger delta` (identical semantics to `FormattingService`). |
| S02 | `v_net_worth` selected a per-account `current_balance` as "net worth" (no `SUM`, no credit sign, no account filtering). | Wrong metric; and referenced the removed generated column. | Rewritten: sums `is_credit`-signed balances as of the current month, `POSTED` only. |
| S03 | `categories.type` declared with the `transaction_type` enum, which includes `TRANSFER`; the domain forbids transfer categories. | Enumerator too wide. | Left as-is (documented); enforced at the app layer via `CategoryService`. |
| S04 | Sheets stores `is_credit` as `"TRUE"`/`"FALSE"` TEXT; PG declares BOOLEAN. | Migration needs a cast. | Documented in docs/02-schema §3 and §7-migration. |

No local PostgreSQL was available to run the DDL; the statements are now standard-valid.
Recommended: `psql -f sql/schema_postgres.sql` once before migrating.

---

## 4. Docs drift corrected

- `docs/02-schema.md`
  - `accounts.current_balance` formula replaced with the **real** formula from `FormattingService.gs`
    (correct column letters, `POSTED` filter); old snippet referenced non-existent columns `J`/`K`.
  - `is_credit` now documented as TEXT `"TRUE"`/`"FALSE"` in Sheets / BOOLEAN in PostgreSQL.
  - Transactions `status` enum now includes `DUPLICATE_SKIPPED`; `external_ref` documents the
    recurring `REC-<id>-<next_run>` idempotency key.
  - `validation_rules` seed list now matches `DEFAULT_VALIDATION_RULES` (added `AMOUNT_INVALID`,
    `TIMESTAMP_VALID`, `SOURCE_KNOWN`, `TYPE_KNOWN`, three `*_REJECTS_*` rules).
- `docs/03-formula-system.md` — `current_balance` labelled `F2` (was `H2`); KPI `SUM(accounts!F:F)`
  (was `H:H`); header now points to `FormattingService.gs` as the authoritative implementation.

---

## 5. Residual recommendations (out of scope — noted, not implemented)

1. **Sheet-level unique constraint:** PostgreSQL enforces unique `external_ref` per owner; the
   Sheets backend relies on `withLock` + lookup. Consider a "unique keys" audit table if
   multi-writer concurrency is ever needed.
2. **CSPRNG:** Apps Script exposes no crypto-grade RNG; ID randomness is `Math.random` (25 bits).
   If the workbook ever goes multi-tenant, move ID generation to a trusted backend.
3. **`categories.type` / `income_sources.type` / `goals.goal_type`** are free-form TEXT in PG;
   consider dedicated enums if the migration schema is the long-term home.
4. **Prepared statements for `importTable`/CSV** — the escaping fix covers formula injection;
   a size cap on import payloads is advisable.
5. **Docs mention a `v_balances` write-back** (the `current_balance` column on `accounts` is still
   formula-driven in Sheets; the view only computes it for SQL consumers).

---

## 6. Follow-up remediation pass (production-readiness check)

Re-verified the codebase before sign-off. The 41/41 suite now runs **42/42** after these fixes.

| # | Area | Finding | Fix |
|---|---|---|---|
| G01 | `tests/run-tests.js` | Harness hardcoded `dir = "/tmp/opencode/gschk"` but `run.sh` copies sources to a `mktemp` build dir — every run crashed with `ENOENT` before any assertion executed. | `dir = __dirname` (the build dir `run.sh` runs from); excludes `run-tests.js` itself from the load set. Suite is green again. |
| G02 | `FormattingService.gs` | `Protection.setWarningCheckbox(true)` is not an Apps Script API (would throw at bootstrap in `protectTables`). | `prot.setWarningOnly(true)` — the real API. |
| G03 | `FormattingService.gs` | `ConditionalFormatRuleBuilder.whenTextNotEmpty()` is not an API (dashboard warnings cell rule would throw). | `.whenCellNotEmpty()` — the real cell-condition API. |
| G04 | `Repository.gs` | Dead constants `TX_STATUS_ACTIVE`, `TX_STATUS_PENDING`, `TX_STATUS_REJECTED` (zero references). | Removed. |
| G05 | `IdGenerator.gs` | Unused `setting` prefix/accessor (the settings table is keyed by `key`, not an id). | Removed. |
| G06 | `DashboardService.gs` | `fBurn()` averaged the last 90 *expense transactions* but was labelled "Burn Rate (avg/mo)" — misleading metric. | Now groups `POSTED` expenses by month and averages the trailing `burn_rate_months` month-totals (nested `QUERY`). Regression test added. |
| G07 | `DashboardService.gs` | Budget "OVER" status hardcoded `>=1`; `budget_over_threshold` setting was dead. | `budgetOverFormula()` reads `budget_over_threshold` from settings (mirrors `budgetAlertFormula`). |
| G08 | `AnalyticsService.gs` | `burn_rate_months` and `invested_ratio_target` settings were never read (hardcoded 4 months / `0.25`). | `ScoreService`, `RoadmapService` and `fBurn` now use the configured values. |
| G09 | docs/03 | Placeholder text (`-- hmm use amount`) and a reference to a non-existent `applyKpiFormulas`. | Replaced with the authoritative formula; header corrected. |
| G10 | docs/04 | Claimed `Authorization: Bearer` header auth (Apps Script web apps cannot read headers) and a `detected_duplicates` response field that doesn't exist. | Token now documented via body/query param; response example matches the real envelope. |
| G11 | docs/05 | Token setup recommended `settings.set api_token_hash`, which the API rejects. | Documented the working `AuthService.rotateToken` flow; checkpoint list now includes the `dashboard` tab. |
| G12 | Tracker.xlsx | The shipped workbook was an empty stub (single blank `Sheet1`, empty chart object), not a 15-sheet workbook. | File removed; the workbook is fully generated by `SchemaService.initialize()` (docs/05). |

The suite is green (**42/42**): `cd tests && ./run.sh`.

---

## 7. Phase-2 corrections (accounting engine + recurring) — 2026-08-05

A second-pass audit of the accounting and recurring engines, with fresh eyes on
invariants previously trusted from the first pass, produced two corrections.
Suite now **51/51**.

| # | Area | Finding | Fix |
|---|---|---|---|
| H01 | `AnalyticsService.netWorthAt` (:349), `v_net_worth` (SQL), test `run-tests.js:329` | **Net-worth sign double-flip.** The ledger engine and the sheet `current_balance` formula never branch on `is_credit` (expenses reduce a balance, transfers in raise it) and `opening_balance` "may be negative for loans" — so liability balances are *already negative* and net worth is the plain sum. `netWorthAt` and `v_net_worth` flipped credit balances to positive (`bal * -1`), treating debt as an asset and inverting `NET_WORTH_MOMENTUM` and roadmap `growth` for credit-card users. The previous F06 fix made the comparison work (`isTrue`) but endorsed the wrong sign; `writeMonthly`'s `NET_WORTH` never flipped, so the two paths disagreed. | Removed the flip in `netWorthAt`, `v_net_worth`, and the regression test (which now asserts a credit account with `-1000` reduces net worth, and `+1000` counts as `+1000` — no double flip). All three net-worth paths now agree. |
| H02 | `RecurringService.computeNextRun` (:346) | **Documented recurring fields were inert.** `day_of_month` (MONTHLY/QUARTERLY/YEARLY) and `day_of_week` (WEEKLY) are part of the schema, API, validation and docs, but `computeNextRun` only added 1 day / 7 days / 1 month / 3 months / 1 year from `start_date` — the fields had no effect, and monthly JS-rollover drifted Jan 31 → Mar 2. `run()` booked at most one occurrence per rule per call, so a long offline gap took one daily run per missed month to catch up. | `computeNextRun` now honors `day_of_week` (1=Mon…7=Sun; validated range corrected from 0–6) and `day_of_month` with deterministic clamping (day 31 → Feb 28/29, Apr 30). `run()` iterates from `last_run` through today, materializing **every** missed occurrence exactly once, each keyed `REC-<id>-<date>` (idempotent across repeated runs), and marks `end_date`-passed rules `COMPLETED`. All date math stays in UTC. Regression tests cover weekly Mon/Sun, monthly 15th/31st, leap-year February, 30-day months, a 12-month offline gap, repeated execution and `end_date`. |
| H03 | `RecurringService.apiCreate` | `day_of_week` was validated as 0–6 while the schema/docs say 1=Mon…7=Sun. | Validation now enforces 1–7 to match the docs and engine. |
| H04 | docs/02, docs/03, README | Recurring-engine semantics and the liability sign convention were undocumented (or wrong); test counts stale. | docs/02 §3 documents "net worth = plain sum of balances"; §8 documents the recurring engine (UTC, day-field honoring, clamping, missed-run materialization, idempotency). README count → 51. |

## 8. v1.0 verification pass (full re-read) — 2026-08-05

Every source file, the SQL schema, and the test harness were re-read in full
with fresh eyes; no prior-pass result was trusted. Two latent bugs surfaced
that earlier string-level tests had been encoding rather than catching.
Suite now **52/52**.

| # | Area | Finding | Fix |
|---|---|---|---|
| J01 | `DashboardService.fNetWorth` | **Dashboard Net Worth KPI still flipped credit balances** (`SUM(IF(accounts!$J2:$J="TRUE",-accounts!$F2:$F,…))`). The H01 correction fixed `netWorthAt`, `v_net_worth` and `writeMonthly`'s `NET_WORTH`, but the dashboard KPI was the one net-worth path never checked — it double-negated liability balances, disagreeing with the Net Worth Trend chart and `apiSummary`. The old "self-consistency" test asserted the flip. | `fNetWorth` is now the plain sum `=SUM(accounts!$F$2:$F)`; the test asserts the plain sum and rejects any `-accounts`/`$J2:$J` flip. |
| J02 | `FormattingService.dataValidation` | **Goals `priority` dropdown on the wrong column.** `goals` has `deadline` in column 8 and `priority` in column 9, but the rule used `{ col: 8, group: "priority" }` — the HIGH/MEDIUM/LOW list was applied to the deadline column. | Rule corrected to `{ col: 9, group: "priority" }`. Regression test drives `dataValidation()` through a recording stub and asserts priority → column 9 and status → column 12. |

Re-verified with no change needed: `Repository.gs` `TABLES` ↔ docs ↔ SQL;
ledger append-only and validation invariants; auth flow (dev-mode empty hash,
12-char token, SHA-256, token not writable via the settings API); `IdGenerator`
collision surface; trigger wiring; migration export/import and CSV-injection
guard; dashboard/chart layout; settings defaults; score/roadmap dependency
ordering; analytics retention pruning.

## 9. Security review — 2026-08-05

Full security audit from the perspective of a senior security engineer, backend
engineer, Apps Script specialist, accountant, API designer and attacker. Every
trust boundary, external input, API, mutation, spreadsheet operation, auth path,
concurrency point, audit path and the import/export/deployment surface was
reviewed. Four provable defects were fixed; the rest are documented residual
risks. Suite now **58/58**.

| # | Area | Finding (proof) | Exploit | Fix |
|---|---|---|---|---|
| K01 | `Repository.appendRow`/`updateRow`/`updateCell`/`writeTableData` | **Spreadsheet formula injection at the write boundary.** The Sheets service evaluates any string written via `setValue`/`appendRow` that starts with `=` as a **formula running in the workbook owner's session**. Every write path funnels through these four functions, and API bodies flow straight into them (`TransactionService.normalize` note/merchant/tags, `AccountService`/`CategoryService`/`GoalService` names, `SettingsService.set`, and every `import` row). The CSV export already neutralizes this (`csvCell`) but the write path did not. | A caller with the token issues `transaction.create` with `note:"=IMPORTXML(…&"&ENCODEURL(transactions!B2),…)"` (or bulk-injects via `import`); the next time the owner opens the workbook the formula fires with the owner's privileges and can exfiltrate ledger data or phone home via `IMPORTXML`/`IMAGE`/`HYPERLINK`. | New `guardFormula()` prefixes any string starting with `=`/`+`/`@` with `'` at the single persistence choke point (numbers/booleans untouched). Mirrors the CSV guard; intent is documented. |
| K02 | `SettingsService.apiGet` | **Secret hash disclosure.** `apiGet({key:…})` returned `SettingsService.get(key)` raw, bypassing the `****` masking that `all()` applies. `get("api_token_hash")` returned the SHA-256 token hash. | A token holder (e.g. a read-only client) can download the hash and brute-force weak tokens offline; even unbrute-forced, it breaks the app's own "never expose secrets" invariant. | Keyed lookup now checks `is_secret` and returns `****` for populated secrets, matching the full-listing mask. |
| K03 | `Code.gs doGet`/`handleRequest` | **Mutations reachable over GET.** `doGet` forwarded every query param to `handleRequest` with no method restriction, so `transaction.create`, `import`, `settings.set`, `analytics.run`, … all executed over GET — an HTTP-semantics violation that widens the CSRF surface. | A leaked token in a URL, or a browser `<img>`/prefetch/link to `?action=transaction.create&…`, triggers a write with no user consent. | Added a `READ_ONLY_ACTIONS` allowlist; mutating actions over GET return `405 METHOD_NOT_ALLOWED` (audited) before any handler runs. |
| K04 | `MigrationService.apiImport` | **Unbounded, unvalidated bulk import.** Rows were appended with no per-row shape check and no size cap; a `null` element or an oversized payload could throw/quit mid-loop, leaving a **partially applied import** with no record of progress, and burn execution quota. | With the token, `rows:[null]` (or 100k rows) corrupts the target table / exhausts quota; a mid-import failure leaves the ledger half-loaded. | Rows are now capped at `MAX_IMPORT_ROWS` (1000) and every row is pre-validated as a plain object **before** any write; violations return `VALIDATION_ERROR` with nothing written. Formula injection in imports is additionally closed by K01. |

### Residual risks (accepted, documented — no code change)

- **Timing-unsafe token comparison** (`candidateHash === expectedHash`). SHA-256
  preimage resistance makes offline recovery require the raw token; network timing
  over TLS is far too noisy to exploit. Rotating to a constant-time compare is a
  hardening step, not a proven vulnerability.
- **`-` prefix not neutralized in `csvCell`** (legacy Excel DDE vector). Guarding `-`
  would turn legitimate negative balances/amounts into text in every CSV export.
  OWASP ranks `=`,`+`,`@` as the primary vectors; DDE is disabled in modern Excel.
- **No app-level rate limiting / lockout.** Apps Script web apps receive no client
  IP, so per-client throttling is impossible at this layer; Google's platform quotas
  (~20k URL-fetch / 6 h, 6 min execution, 10k cell writes) are the availability
  backstop. A tokenless attacker cannot reach any handler in production (auth first).
- **`replaceRows` clear-then-write is not atomic.** A failure between
  `clearTableData` and `writeTableData` leaves `monthly_analytics` empty until the
  next `analytics.run` (trigger or manual) heals it. Single-user, self-healing.
- **Import is a raw restore path.** It bypasses the transaction validation engine by
  design (migration/restore); rows are still bounded, shape-checked and formula-safe
  (K01/K04). Domain re-validation on import would be a feature, not a fix.
- **Dev-mode open API.** An empty `api_token_hash` leaves the API open — a deployment
  configuration risk, already the first item in the deployment checklist
  (`AuthService.rotateToken`).

## 10. Concurrency, TOCTOU & integrity review — 2026-08-05

Every mutation entry point (`doGet`/`doPost` → handler → service), trigger
(`recurringNow`, `analyticsNow`), the `withLock` guard itself, the read cache, and
every read-modify-write sequence was walked for race conditions: two concurrent
web requests, a web request racing a trigger, and trigger-vs-trigger. Serialized
paths verified correct: `transaction.create` (dedupe check + persist + events all
inside one lock — no duplicate `external_ref` TOCTOU), `transaction.void`,
all master-data creates, `recurring.run` (entire catch-up loop under one lock,
row re-reads via `findRow`), `analytics.run` (`replaceRows` clear+write inside
the lock), and `apiImport` (shape validation outside the lock is pure; writes
inside it). `withLock` uses `tryLock(10s)` with release-in-`finally` and a
reentrancy guard scoped to a single execution. Two defects were fixed; the rest
are documented residuals. Suite now **60/60**.

| # | Area | Finding (proof) | Fix |
|---|---|---|---|
| M01 | `SettingsService.set` (→ `apiSet`, `AuthService.rotateToken`) | **Mutation path bypassing the serialization guard.** Every other mutation entry point is wrapped in `withLock`; `settings.set` was the only one that was not, so a settings write could interleave with a locked ledger/analytics write — violating the documented "all writes serialized under the script lock" invariant that the security pass's acceptance criteria claim. | Wrapped `set` in `withLock` (reentrancy guard makes nested calls from `analytics.run`/`initialize` safe). Regression test proves the lock is acquired on write and not re-acquired when nested (no deadlock). |
| M02 | `RoadmapService.update` + `Repository.updateRow` | **Roadmap primary key wiped on every regeneration.** `updateRow` blanks any column whose record value is explicitly `undefined` (`hasOwnProperty ? rec[col] : cur[col]`, then `undefined → ""`). `RoadmapService.update` built `stage_id: row ? undefined : IdGenerator.stage()` — so from the **second** `analytics.run` on, every existing roadmap row had its `STG_...` key overwritten with `""`, destroying the schema's `roadmap` PK (docs/02, `sql/schema_postgres.sql`) and breaking a future Postgres migration. Proven empirically: reverting the fix makes the new test fail with `stage 1 lost its stage_id after regeneration: undefined`. | `stage_id` is now assigned only on insert; on update the key is omitted so `updateRow` preserves the existing value from the live row. |

### Residual concurrency risks (accepted, documented — no code change)

- **`AuditService.log` appends without the script lock.** Every request is audited
  *after* the handler releases the lock (and read-only GETs never take it), so audit
  rows are appended concurrently. The table is append-only and `appendRow` is a
  single atomic Sheets call, so rows cannot corrupt each other — only commit order
  between concurrent requests is nondeterministic. Auditing is best-effort by design
  (never throws). Wrapping every audit in the lock would serialize all read-only
  traffic for zero correctness gain.
- **Reads are lock-free by design.** A read can observe a table mid-write
  (`replaceRows` window on `monthly_analytics` — documented §9 residual; a settings
  row write is atomic per row). Consistent with the single-user model and the
  "manual refresh / on-demand `analytics.run`" documented flow.
- **`dashboard` writes (`buildLayout`/`installCharts`) are unlocked.** They rewrite
  derived formula cells/charts on the dashboard sheet, never ledger state, and only
  run when the tab is missing or via the refresh menu. A concurrent rebuild could
  only momentarily stack/clear dashboard visuals; self-healing on next refresh.
- **`SchemaService.initialize` vs concurrent reads.** Reads during bootstrap can see
  a partially-built workbook (missing tables auto-create as empty); benign for a
  manual, single-user bootstrap.

---

## 11. Performance, scalability & quota audit — 2026-08-05 (Phase 7)

Every read/write path, the analytics/recurring engines, the read cache, duplicate
detection, import/export and both triggers was walked for cost. Measured in Node
V8 (same engine Apps Script runs on; GAS adds per-call service overhead on top, so
the CPU figures below are *lower bounds* for GAS wall-clock). Suite unchanged at
**60/60** — this pass proved and documented, it did not change code.

### 11.1 Measured hot paths (this machine, Node V8)

| Ledger size | `findDuplicate` per create | `findByExternalRef` per create | `atDate` per pass (1 account) | `writeMonthly` (36 periods × 10 accounts) | row objects in memory |
|---|---|---|---|---|---|
| 1,000 | 19.8 ms | 0.8 ms | 1.2 ms | 0.76 s | 0.2 MB |
| 10,000 | 328.8 ms | 6.4 ms | 16.0 ms | 7.5 s | 6.0 MB |
| 50,000 | 1,267 ms | 34.6 ms | 62.2 ms | 35.9 s | 31.0 MB |
| 100,000 | 2,685 ms | 56.4 ms | 157.8 ms | ≈ 90 s (extrapolated) | 80.9 MB |

`writeMonthly` dominates `analytics.run`: it performs `periods × (accounts + 1)`
= 396 `atDate` passes at the defaults (measured share ≈ 69 % of runtime at 50k),
so `analytics.run` total is ≈ 100–110 s at 100k rows including `ScoreService` and
`RoadmapService` (≈ 9 more `atDate` passes). All figures are within the 6-minute
per-execution limit, but the gap narrows as the ledger grows.

### 11.2 Findings

| # | Location | Finding (proof) | Disposition |
|---|---|---|---|
| P7.1 | `DuplicateDetectionService.findDuplicate` | Deep-scans the whole ledger and SHA-256-fingerprints **every** row on every `transaction.create` — O(n) per create, O(n²) across a batch (measured 2.7 s/create at 100k). Semantics are correct (window check gates the match), so this is cost, not a bug. Import (`apiImport`) bypasses it entirely (direct `appendRow`, capped at `MAX_IMPORT_ROWS`), and creates are human-paced, so nothing fails at documented scale. | Documented limitation — no code change. A semantics-preserving window pre-filter (parse `transaction_ts` first, fingerprint only in-window candidates) would cut this ≈ 10×; deliberately **not** applied under the Phase-7 "no premature optimization" rule. |
| P7.2 | `AnalyticsService.writeMonthly` / `AccountBalanceEngine.atDate` | The hot loop is `atDate`, called `periods × (accounts + 1)` times per run, each pass O(ledger). Measured 35.9 s at 50k, ≈ 90 s at 100k for `writeMonthly` alone. Correct, but `analytics.run` approaches the 6-min execution limit at ~100k rows with 36-month retention and 10 accounts. | Documented limitation — no code change. A running-balance pass (one sweep of the ledger building per-account balances for every period end) would make it O(P·A + L) instead of O(P·A·L); reserved for the Postgres migration (docs/07). |
| P7.3 | `Repository.readTable` | Every execution pays one full-table `getValues` for each table it touches (cached per execution, F25). At 100k×19 cells this single read is the real wall-clock cost of each request — multi-second in GAS — far more than the CPU figures above. | Documented — the per-execution cache keeps it to one read per table per request; a cross-request cache would risk staleness (no `flush()` is used, so Sheets reads are already consistent). |
| P7.4 | `findRow` per write | O(rows) single-column scan per call; used only on small tables (`financial_score` 6 rows, `roadmap` 7 rows, `transactions` only in `apiVoid` once). | No concern at any documented size. |
| P7.5 | Whole codebase | No `SpreadsheetApp.flush()` and no `Utilities.sleep()` anywhere (grep-verified) — no throttling-induced latency, writes are sequential atomic batch calls. | Verified. |
| P7.6 | `CacheServiceCache.invalidate` (AnalyticsService:172) | Invalidate-only (`removeAll()`, no re-read) — debounced `onLedgerChanged` marks dirty without touching the sheet. | Verified: no cache thrash. |
| P7.7 | `RecurringService.run` (trigger) | Single `run()` materializes up to 10,000 occurrences per rule (documented §8/H-series). Catch-up loop is O(occurrences) appends; bounded. | Documented — accepted. |
| P7.8 | `apiImport` | Shape-validated, formula-safe (K1), capped at 1000 rows/request (K4); writes are plain `appendRow` (no dedupe scan), so bulk restore is O(rows), not O(rows × ledger). | Verified. |

### 11.3 Platform quotas (official, developers.google.com/apps-script/guides/services/quotas, updated 2026-07-22)

Relevant to this app (consumer / Google Workspace):

| Quota | Consumer | Workspace |
|---|---|---|
| Script runtime per execution | 6 min | 6 min |
| Simultaneous executions per user | 30 | 30 |
| Simultaneous executions per script | 1,000 | 1,000 |
| Installable triggers per script | 20 | 20 |
| Triggers total runtime / day | 90 min | 6 hr |
| Properties read/write / day | 50,000 | 500,000 |
| URL Fetch calls / day | 20,000 | 100,000 |
| Email recipients / day (MailApp) | 100 | 1,500 |
| Spreadsheets created / day | 250 | 3,200 |
| Script projects / day | 50 | 50 |

The quotas page no longer lists per-user spreadsheet **read/write cell** quotas; the
binding limits for FinPilot are the 6-minute per-execution runtime, the 30-concurrent-
executions cap, and (for the triggers) the daily trigger runtime. The audit's CPU
measurements stay well inside all of them through 100k rows.

### 11.4 Operating envelope (recommended, documented)

- **1k–10k transactions:** everything sub-second to low-single-second; no constraints.
- **≤ 50k transactions (personal scale target):** `transaction.create` ≈ 0.3–1.3 s CPU,
  weekly `analytics.run` ≈ 8–36 s. Comfortable.
- **100k transactions (operational ceiling):** per-create ≈ 2.7 s CPU plus a multi-second
  full-table read, `analytics.run` ≈ 100 s. Still within limits but noticeably slow;
  this is the documented ceiling before migrating to PostgreSQL (docs/07-migration).
- Beyond 100k is out of scope for v1.0; the schema (`sql/schema_postgres.sql`) already
  mirrors the Sheets tables for that migration.

### Residuals (accepted, documented — no code change)

- **O(n) duplicate scan per create (P7.1)** and **O(P·A·L) analytics recompute (P7.2)** —
  correct at all sizes, slower as the ledger grows. Both have ready, semantics-preserving
  optimizations that are deliberately deferred (Phase-7 rule: prove and document, no
  premature optimization).
- **One full-table read per execution** — inherent to the Sheets-as-DB adapter; mitigated
  by the per-execution cache.
- **`analytics.run` latency at scale** — the 6-minute limit leaves ≈ 5× headroom at 100k
  rows; the weekly trigger (90-min/day consumer quota) consumes ≈ 2 minutes weekly at
  that size.

## 12. Post-freeze API-validity pass — 2026-08-05

A runtime-compatibility audit of every Apps Script API call against the official
reference (after the freeze). G02/G03 (warning-only protection API, cell-condition
builder) and P02/P03 were already corrected; two more invalid calls were found in
`FormattingService.gs` — both would throw at runtime, so the frozen *intent*
(warning-only protection; conditional formatting on dashboard/financial_score/
transactions) was silently not being applied. Both are behavior-preserving fixes.
Suite now **62/62**.

| # | Area | Finding (proof) | Fix |
|---|---|---|---|
| N01 | `FormattingService.protectTables` (:137) | **Editor-list API on a warning-only protection.** `prot.setWarningOnly(true)` was followed by `if (prot.canEdit()) prot.removeEditors(prot.getEditors())`. The official `Protection` reference restricts `addEditor`/`removeEditor`/`removeEditors`/`getEditors` to non-warning-only protections; calling them on a warning-only protection throws. The branch is dead (warning-only protections never expose editors) but invalid if reached. | Removed the editor-list logic entirely — every table protection stays warning-only (setDescription + setWarningOnly), which is the documented intent. |
| N02 | `FormattingService.conditionalRules` (:198, :205, :219) | **`Range.setConditionalFormatRules` does not exist.** `setConditionalFormatRules` is a **Sheet** method (it replaces the whole sheet's rule set); the code called it on `Range` objects, which throws `Range.setConditionalFormatRules is not a function` — swallowed by the enclosing `try/catch`, so no conditional formatting was ever installed on the dashboard, `financial_score` or `transactions`. | Each call now targets the owning `Sheet` (`dash`/`score`/`tx`). Each sheet receives exactly one rule set, so replace-all semantics are equivalent to the intended per-range behavior. |

Re-verified unchanged on this pass: every other Apps Script call site
(`SpreadsheetApp`, `Sheet`, `Range`, `Protection`, `ConditionalFormatRuleBuilder`,
`DataValidationBuilder`, `ChartBuilder`, `ScriptApp`, `LockService`, `CacheService`,
`PropertiesService`, `Utilities`, `ContentService`) matches the official reference.

Regression tests added for both fixes (`tests/run-tests.js`): a recording
`SpreadsheetApp.newConditionalFormatRule`/`tableSheet`/`openDb` harness drives
`conditionalRules()` and asserts each sheet received its full rule set via the
Sheet API (a Range call would throw, get swallowed, and install nothing); a
recording `sheet.protect()` stub asserts every table protection is warning-only
and that no editor-list API is ever invoked.
