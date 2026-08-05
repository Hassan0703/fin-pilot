# FinPilot v0 — Production Readiness Report

> **Date:** 2026-08-05
> **Scope:** Full engineering audit of the Google Apps Script backend, schema,
> formulas, charts, triggers, test harness and documentation — followed by a
> Phase-1 integration audit (re-install correctness), a Phase-2 audit of the
> accounting and recurring engines with fresh eyes, a v1.0 verification re-read
> of the entire codebase, a Phase-5 comprehensive security review, and a Phase-6
> concurrency/TOCTOU & integrity review.
> **Result:** **GO** for production.

---

## 1. Executive summary

FinPilot v0 is a database-first financial operating system built on Google Sheets
(15 tables) with a serverless Apps Script REST backend, a formula/chart-driven
dashboard, and scheduled analytics. A production-readiness audit was performed
with the mandate: **fix everything, add nothing, change no design**.

Three remediation passes were completed, followed by a full verification re-read
and a comprehensive security review:

1. **P-series (bootstrap/API/docs):** broken test harness, two invalid Apps
   Script API calls, dead code, unread configuration settings, a misleading
   dashboard metric, and documentation drift. All fixed.
2. **I-series (Phase-1 integration):** `apiSummary` dead-sheet reference, chart
   stacking on re-install, the `monthly_analytics.metric` dropdown pointing at
   the wrong lookup group, and derived formulas (`accounts.F`, `goals.G`,
   `goals.K`) never applied to post-initialization rows. All fixed.
3. **H-series (Phase-2 accounting + recurring):** net-worth credit-sign
   double-flip (treated debt as an asset), and a recurring engine that stored
   but ignored `day_of_month`/`day_of_week` and skipped missed runs. Both
   corrected.
4. **J-series (v1.0 verification re-read):** every file re-read in full from a
   fresh perspective; the dashboard Net Worth KPI still flipped credit balances
   (contradicting the corrected net-worth paths), and the goals `priority`
   dropdown was wired to the wrong column (deadline). Both corrected.
5. **K-series (Phase-5 security review):** spreadsheet formula injection was
   closed at the persistence boundary, the token hash can no longer be fetched
   through the API, mutating actions were locked down to POST-only, and bulk
   import became bounded and fail-fast. All four corrected.
6. **M-series (Phase-6 concurrency/TOCTOU & integrity):** a fresh pass over every
   mutation entry point, trigger and read-modify-write sequence. The settings
   write path (the one mutation bypassing the script lock) was serialized, and a
   proven defect was caught and fixed — `RoadmapService.update` blanked the
   roadmap `STG_...` primary key on every regeneration after the first. Both
   corrected.
7. **P7-series (Phase-7 performance, scalability & quota audit):** every read/write
   path, engine, cache, trigger and import/export path was costed; hot paths were
   measured at 1k/10k/50k/100k rows against the official platform quotas
   (`docs/08 §11`). No code changes — all findings were proven, measured and
   either verified-correct or documented as accepted limitations, and the v1.0
   backend was formally frozen in `docs/10-backend-freeze.md`.

The regression suite passes **60/60** and the workbook initializes cleanly from
an empty spreadsheet.

**Go/No-Go: GO.**

---

## 2. Issues found and fixes

### Pass 1 — bootstrap, API validity, dead code, docs (P01–P15)

#### Critical (would crash or falsify results)

| ID | Location | Finding | Fix |
|---|---|---|---|
| P01 | `tests/run-tests.js:5-6` | Harness hardcoded `dir = "/tmp/opencode/gschk"` while `run.sh` builds in a `mktemp` dir — every run failed with `ENOENT` before any assertion. | `dir = __dirname` (the build dir `run.sh` runs from); the load set now excludes `run-tests.js` itself. |
| P02 | `apps-script/FormattingService.gs:110` | `Protection.setWarningCheckbox(true)` is not an Apps Script API — `protectTables()` would throw at workbook bootstrap. | `prot.setWarningOnly(true)`. |
| P03 | `apps-script/FormattingService.gs:169` | `ConditionalFormatRuleBuilder.whenTextNotEmpty()` is not an Apps Script API — the dashboard warnings rule would throw. | `.whenCellNotEmpty()`. |

#### Functional (wrong values or dead config)

| ID | Location | Finding | Fix |
|---|---|---|---|
| P04 | `apps-script/DashboardService.gs:157` | `fBurn()` averaged the last 90 *expense transactions* while labelled "Burn Rate (avg/mo)". | Groups `POSTED` EXPENSE rows by `YEAR, MONTH` and averages the trailing `burn_rate_months` month-totals (nested `QUERY`). |
| P05 | `apps-script/DashboardService.gs:69,135` | Budget "OVER" status hardcoded `>=1`; `budget_over_threshold` setting was never read. | `budgetOverFormula()` reads the setting via `VLOOKUP`. |
| P06 | `apps-script/AnalyticsService.gs` | `burn_rate_months` (score + roadmap + analytics) and `invested_ratio_target` (roadmap) were hardcoded. | Both now read from `settings` with sensible fallbacks. |
| P07 | `apps-script/Repository.gs` | Unused `TX_STATUS_ACTIVE/PENDING/REJECTED` constants. | Removed. |
| P08 | `apps-script/IdGenerator.gs` | Unused `setting` ID prefix/accessor. | Removed. |

#### Documentation drift

| ID | Location | Finding | Fix |
|---|---|---|---|
| P09 | `docs/03-formula-system.md` | Placeholder text; referenced a non-existent `applyKpiFormulas`. | Documented the authoritative implementation. |
| P10 | `docs/04-api-reference.md` | Claimed `Authorization: Bearer` header auth (Apps Script web apps cannot read headers) and a non-existent `detected_duplicates` field. | Token via body/query param; envelope and error codes now match the router. |
| P11 | `docs/05-setup.md` | Token setup used a rejected `settings.set` flow; checkpoint missed the `dashboard` tab. | Documents `AuthService.rotateToken`; checkpoint lists all 15 tabs. |
| P12 | `docs/06-shortcuts.md` | Same auth misdocumentation. | Rewritten to the real token transport. |
| P13 | `docs/01-architecture.md` | ID prefix list contained removed `SET_`, omitted `ANA_`/`STG_`. | Matches `IdGenerator`. |
| P14 | `README.md` | Claimed "27 assertions". | Now matches the real count. |
| P15 | `docs/08-engineering-audit.md` | F12 referenced the invalid `whenTextNotEmpty`. | Corrected; §6 remediation table added. |

### Pass 2 — integration audit: re-install + post-init rows (I1–I4)

| ID | Location | Finding | Fix |
|---|---|---|---|
| I1 | `DashboardService.apiSummary` | `if (!sheet) DashboardService.buildLayout();` left `sheet` null (buildLayout returns the sheet) — every KPI `readCell` returned null on a missing `dashboard` tab. | `sheet = DashboardService.buildLayout();` |
| I2 | `DashboardService.installCharts` | Existing charts were never removed before inserting — every re-install stacked a fresh copy of each chart. | Remove all existing charts (in try/catch) before rebuilding. |
| I3 | `FormattingService.dataValidation` + `LookupService` | `monthly_analytics.metric` dropdown pointed at the `transaction_type` lookup group; no `metric` group existed. | Added the `metric` lookup group (incl. `BURN_RATE` per docs) and pointed the dropdown at it; verified every dropdown entry is a valid 2-arg tuple. |
| I4 | `FormattingService` + `MasterDataServices` | Derived formulas (`accounts.current_balance`, `goals.current_amount`, `goals.projected_completion`) were applied only at init — rows created later via API never got them. | Extracted formula builders + row helpers (`applyAccountFormula`, `applyGoalFormulas`); wired into `AccountService.apiCreate` and `GoalService.apiCreate`. |

### Pass 3 — accounting + recurring engines (H1–H4)

| ID | Location | Finding | Fix |
|---|---|---|---|
| H1 | `AnalyticsService.netWorthAt:349`, `v_net_worth` (SQL), test | **Net-worth sign double-flip.** The ledger engine and the sheet `current_balance` formula never branch on `is_credit` (expenses reduce a balance, transfers in raise it) and `opening_balance` "may be negative for loans" — liability balances are *already negative*, so net worth is the plain sum. `netWorthAt` and `v_net_worth` flipped credit balances to positive, treating debt as an asset and inverting `NET_WORTH_MOMENTUM` and roadmap `growth` for credit-card users; `writeMonthly`'s `NET_WORTH` never flipped, so the two paths disagreed. | Removed the flip in `netWorthAt`, `v_net_worth`, and the regression test. All three net-worth paths now agree. |
| H2 | `RecurringService.computeNextRun:346` | **Documented recurring fields were inert.** `day_of_month` (MONTHLY/QUARTERLY/YEARLY) and `day_of_week` (WEEKLY) are part of the schema/API/validation/docs but `computeNextRun` ignored them (monthly JS-rollover drifted Jan 31 → Mar 2). `run()` booked at most one occurrence per rule per call, so long offline gaps caught up one month per daily run. | `computeNextRun` honors `day_of_week` (1=Mon…7=Sun) and `day_of_month` with deterministic clamping (day 31 → Feb 28/29, Apr 30). `run()` iterates from `last_run` through today, materializing **every** missed occurrence exactly once, each keyed `REC-<id>-<date>` (idempotent across repeated runs), and marks `end_date`-passed rules `COMPLETED`. All math stays in UTC. |
| H3 | `RecurringService.apiCreate` | `day_of_week` validated 0–6 while schema/docs say 1=Mon…7=Sun. | Validation now enforces 1–7. |
| H4 | docs/02, README | Recurring-engine semantics and the liability sign convention were undocumented or wrong; test counts stale. | docs/02 §3 documents "net worth = plain sum of balances"; §8 documents the recurring engine; README count → 51. |

### Pass 4 — v1.0 verification re-read (J1–J2)

Every `.gs` file, the SQL schema, and the test harness were re-read in full with
fresh eyes (no prior-pass result trusted). Two latent bugs surfaced that the
string-level tests had been encoding rather than catching.

| ID | Location | Finding | Fix |
|---|---|---|---|
| J1 | `DashboardService.fNetWorth` | **The dashboard Net Worth KPI still flipped credit balances** (`SUM(IF(accounts!$J2:$J="TRUE",-accounts!$F2:$F,…))`). The Phase-2 H1 correction removed the flip from `netWorthAt`, `v_net_worth` and `writeMonthly`'s `NET_WORTH`, but the dashboard KPI formula was the one path never checked — it double-negated liability balances, so the KPI disagreed with the Net Worth Trend chart and `apiSummary`. The old regression test even asserted the flip as "self-consistency". | `fNetWorth` is now the plain sum `=SUM(accounts!$F$2:$F)` (liabilities already negative). The test now asserts the plain sum and the absence of any `-accounts`/`$J2:$J` flip. |
| J2 | `FormattingService.dataValidation` | **Goals `priority` dropdown wired to the wrong column.** The goals table puts `deadline` in column 8 and `priority` in column 9, but the rule used `{ col: 8, group: "priority" }`, so the HIGH/MEDIUM/LOW list was applied to the deadline column. | Rule corrected to `{ col: 9, group: "priority" }`. New regression test drives `dataValidation()` through a recording stub and asserts the priority list lands on column 9 (and status on 12). |

Re-verified with no change needed during the re-read: `Repository.gs` `TABLES`
matches docs and SQL; ledger append-only + validation invariants; auth hash
flow (dev-mode empty hash, 12-char token, SHA-256, token field non-writable via
settings API); `IdGenerator` collision surface; trigger wiring; migration
export/import and CSV-injection guard; dashboard/chart layout; settings
loading with defaults; score/roadmap dependency ordering; monthly analytics
retention pruning.

### Pass 5 — security review (K1–K4)

Comprehensive security audit from the perspective of a senior security engineer,
backend engineer, Apps Script specialist, accountant, API designer and attacker.
Every trust boundary, external input, API, mutation, spreadsheet operation, auth
path, concurrency point, audit path and the import/export/deployment surface was
reviewed. Four provable defects were fixed (see `docs/08 §9` for the full proofs
and exploit walk-throughs); the remainder are documented residual risks.

| ID | Location | Finding | Fix |
|---|---|---|---|
| K1 | `Repository` write functions | **Spreadsheet formula injection at the write boundary.** The Sheets service evaluates any string written via `setValue`/`appendRow` that starts with `=` as a formula running in the workbook owner's session. All API text (notes, merchant, names, settings values, `import` rows) flows into these functions raw; only CSV *export* was guarded (`csvCell`). A crafted `note:"=IMPORTXML(…)"` or bulk import fires with owner privileges when the workbook is opened. | New `guardFormula()` prefixes strings starting with `=`/`+`/`@` with `'` at the single persistence choke point (`appendRow`, `updateRow`, `updateCell`, `writeTableData`). Numbers/booleans untouched. |
| K2 | `SettingsService.apiGet` | **Secret hash disclosure.** Keyed `settings.get` returned the raw `api_token_hash` (SHA-256), bypassing the `****` mask that the full listing applies — enabling offline brute-force of weak tokens and violating the app's own secret policy. | Keyed lookups now mask `is_secret` values exactly like the full listing. |
| K3 | `Code.gs` GET handling | **Mutations over GET.** `doGet` dispatched *every* action (`transaction.create`, `import`, `settings.set`, `analytics.run`, …) with no method restriction — a link, `<img>` tag or prefetch (or a URL with a leaked token) could trigger writes. | `READ_ONLY_ACTIONS` allowlist; mutating actions over GET return `405 METHOD_NOT_ALLOWED` (audited) before any handler runs. |
| K4 | `MigrationService.apiImport` | **Unbounded, unvalidated bulk import.** No per-row shape check and no size cap; a `null` element or oversized payload could abort mid-loop, leaving a partially applied import and burning quota. | Rows capped at `MAX_IMPORT_ROWS` (1000) and pre-validated as plain objects before any write; violations are `VALIDATION_ERROR` with nothing written. |

Security acceptance criteria — **all satisfied**: every external input is bounded
and validated at its boundary; no secret can be read through the API; no mutation
can be triggered by a GET; all writes are serialized under the script lock and
audited; import/export cannot introduce formulas or partial bulk loads; auth is
checked before routing; the deployment checklist still leads with token rotation.
Residual items (timing-safe compare, CSV `-` prefix, app-level rate limiting,
`replaceRows` atomicity, import as a raw restore path, dev-mode open API) are
documented with rationale in `docs/08 §9` and the risks section below.

### Pass 6 — concurrency, TOCTOU & integrity review (M1–M2)

Every mutation entry point (web handlers, both triggers), the `withLock` guard
itself, the per-execution read cache, and every read-modify-write sequence was
walked for races: two concurrent web requests, request-vs-trigger, trigger-vs-
trigger. Serialized paths were verified correct (dedupe + persist + events under
one lock; the entire `recurring.run` catch-up loop under one lock; `replaceRows`
inside the lock; import writes inside the lock). Two defects were addressed —
see `docs/08 §10` for the full walk-through and proofs:

| ID | Location | Finding | Fix |
|---|---|---|---|
| M1 | `SettingsService.set` (→ `apiSet`, `rotateToken`) | **The only mutation entry point bypassing `withLock`.** The documented invariant — "all writes serialized under the script lock" — was false for settings writes, so a settings write could interleave with locked ledger/analytics writes. | Wrapped `set` in `withLock`; the reentrancy guard makes nested calls (from `analytics.run`/`initialize`) safe. |
| M2 | `RoadmapService.update` + `Repository.updateRow` | **Roadmap primary key wiped on every regeneration.** `stage_id: row ? undefined : IdGenerator.stage()` combined with `updateRow`'s "explicit undefined → blank" semantics erased the `STG_...` key from every existing roadmap row from the second `analytics.run` onward. Proven empirically — reverting the fix fails the new test (`stage 1 lost its stage_id after regeneration`). | `stage_id` assigned only on insert; `updateRow` preserves the existing value on update. |

Lock-free reads, the append-only unlocked audit path, and dashboard derived-view
writes were audited and are documented residuals — no corruption was proven, and
locking them would serialize read-only traffic for zero correctness gain.

### Investigation (no change needed)

- **Tracker.xlsx** — unpacked: an empty stub (one blank `Sheet1`, empty chart
  object), not the 15-sheet workbook. The real workbook is generated entirely by
  `SchemaService.initialize()`. Removed from the repo.
- **Schema drift** — `Repository.gs` `TABLES` matches `docs/02-schema.md` and
  `sql/schema_postgres.sql`; `v_balances` mirrors the current-balance formula
  semantics. No drift.
- **API surface** — every router handler exists; all chart calls use valid
  Apps Script APIs.
- **Ledger invariants** — re-walked `TransactionService` + `ValidationService`
  with fresh eyes: append-only, per-type field rules, unknown-field rejection,
  `Money` bounds, strict calendar dates, idempotency keys, event-driven cache
  invalidation all hold.

### Pass 7 — performance, scalability & quota audit (P7.1–P7.8)

Every read/write path, both engines, the read cache, duplicate detection,
import/export and both triggers was costed. Hot paths were measured in Node V8
(GAS's engine) at 1k/10k/50k/100k transactions. Full tables and proofs are in
`docs/08 §11`; the result set is `docs/10-backend-freeze.md`.

| ID | Location | Finding | Disposition |
|---|---|---|---|
| P7.1 | `DuplicateDetectionService.findDuplicate` | Every `transaction.create` deep-scans and SHA-256-fingerprints **all** rows — measured 19.8 ms @1k, 328.8 ms @10k, 1,267 ms @50k, 2,685 ms @100k per create. Semantics correct (window gates the match); import bypasses it (direct `appendRow`, capped 1000); creates are human-paced. | Documented limitation — no code change. A window pre-filter would cut it ≈ 10× but is deferred under the no-premature-optimization rule. |
| P7.2 | `AnalyticsService.writeMonthly` (`atDate`) | O(periods × accounts × ledger): 396 `atDate` passes at defaults. Measured 0.76 s @1k, 7.5 s @10k, 35.9 s @50k, ≈ 90 s @100k; `analytics.run` ≈ 100–110 s @100k — inside the 6-min limit but the dominant cost. | Documented limitation — a running-balance sweep (O(P·A + L)) is reserved for the Postgres migration. |
| P7.3–P7.8 | `readTable` per-execution read, `findRow` on small tables only, no `flush()`/`sleep()` anywhere, invalidate-only cache (no thrash), bounded recurring loop, O(rows) import | All verified cheap or bounded. | Verified, documented. |

**Operating envelope:** 1k–10k trivial; ≤ 50k comfortable (create ≈ 0.3–1.3 s, weekly
analytics ≈ 8–36 s); 100k is the documented ceiling (create ≈ 2.7 s CPU + multi-second
full-table read, analytics ≈ 100 s). Beyond → PostgreSQL (`sql/schema_postgres.sql`).

**Platform quotas** (official, updated 2026-07-22): 6-min/execution, 30 simultaneous
executions/user, 1000/script, 20 triggers, trigger runtime 90 min/day (consumer) /
6 hr (Workspace), 50k Properties read/write/day. All measured usage stays inside them
through 100k rows. No app-level rate limiting is possible (web apps get no client IP);
platform quotas are the backstop.

### Pass 8 — post-freeze API-validity audit (N1–N2)

Every Apps Script API call in the codebase was re-checked against the official
runtime reference (GAS does not support TypeScript; calls are only caught at
runtime). Two more invalid calls were found — both in `FormattingService.gs`,
both throwing inside swallowed `try/catch`, so the frozen intent was silently not
applied. Both fixes are behavior-preserving. Suite now **62/62**.

| ID | Location | Finding | Fix |
|---|---|---|---|
| N1 | `FormattingService.gs:137` (`protectTables`) | `Protection.removeEditors`/`getEditors`/`canEdit` are restricted to **non-warning-only** protections per the official `Protection` reference; this warning-only path could throw. | Removed the editor-list logic; every table protection stays `setWarningOnly(true)`. |
| N2 | `FormattingService.gs:198,205,219` (`conditionalRules`) | `Range.setConditionalFormatRules` is **not** an API — `setConditionalFormatRules` lives on `Sheet` (replaces the whole sheet's rule set). The calls threw, so dashboard/financial_score/transactions never got their conditional formatting. | Calls now target the owning `Sheet` (`dash`/`score`/`tx`); each sheet gets exactly its intended rule set, so replace-all semantics are equivalent. |

---

## 3. Files modified

| File | Change |
|---|---|
| `apps-script/DashboardService.gs` | I1 `apiSummary` sheet reassignment; I2 chart removal before install; P04 `fBurn` monthly burn; P05 `budgetOverFormula`; J1 `fNetWorth` plain sum (no credit flip). |
| `apps-script/AnalyticsService.gs` | H1 `netWorthAt` no-flip; P06 settings wiring; K4 `apiImport` row cap + fail-fast validation; `MAX_IMPORT_ROWS`; M2 roadmap `stage_id` preserved on regeneration. |
| `apps-script/MasterDataServices.gs` | H2 `computeNextRun` + `run()` rework; H3 day_of_week range; I4 formula wiring on `account.create`/`goal.create`. |
| `apps-script/FormattingService.gs` | P02/P03 API fixes; I3 metric dropdown; I4 derived-formula row helpers + builders; J2 goals `priority` dropdown col 9; N1 warning-only protection cleanup (no editor-list APIs); N2 conditional rules via `Sheet.setConditionalFormatRules`. |
| `apps-script/LookupService.gs` | I3 `metric` lookup group. |
| `apps-script/Repository.gs` | P07 dead constants removed; K1 `guardFormula` at write boundary (appendRow/updateRow/updateCell/writeTableData). |
| `apps-script/IdGenerator.gs` | P08 unused prefix removed. |
| `apps-script/Code.gs` | K3 `READ_ONLY_ACTIONS` + GET 405 enforcement. |
| `apps-script/SettingsService.gs` | K2 secret masking in keyed `settings.get`; M1 `set` serialized under the script lock. |
| `sql/schema_postgres.sql` | H1 `v_net_worth` no-flip. |
| `tests/run-tests.js` | P01 harness fix; P04 fBurn test; I3/I4 tests; H1 net-worth test; H2 recurring date/missed-run/idempotency/end-date tests; J1 fNetWorth plain-sum test; J2 dropdown-column test (+ `status` lookup stub); K1 guard + import-persistence tests; K2 secret-masking test; K3 GET read-only test; K4 import fail-fast + cap tests (+ `__realAppendRow` capture); M1 lock-acquisition + reentrancy test; M2 roadmap `stage_id` preservation test; N1 warning-only-protection regression test; N2 Sheet-level conditional-rules regression test. Suite now 62 assertions. |
| `README.md` | Test count → 62. |
| `docs/01-architecture.md` | P13 ID prefix list. |
| `docs/02-schema.md` | H4 liability sign convention (§3) + recurring engine semantics (§8); I3 `metric` enum. |
| `docs/03-formula-system.md` | P09 authoritative formulas; I2 chart-removal note. |
| `docs/04-api-reference.md` | P10 auth contract; K-series security properties, `METHOD_NOT_ALLOWED`, GET read-only enforcement, import bounds. |
| `docs/05-setup.md` | P11 token flow + 15-tab checkpoint. |
| `docs/06-shortcuts.md` | P12 token transport; K3 GET read-only enforcement + URL-token warning. |
| `docs/08-engineering-audit.md` | P15 + §7 Phase-2 corrections (H1–H4) + §8 v1.0 verification pass (J1–J2) + §9 security review (K1–K4 + residual risks) + §10 concurrency/TOCTOU & integrity (M1–M2 + residuals) + §11 performance, scalability & quota audit (P7.1–P7.8 + measured table + official quotas + operating envelope). |
| `docs/09-production-readiness-report.md` | This report (Pass 7 added). |
| `docs/10-backend-freeze.md` | **New** — the v1.0 backend freeze: all 15 required sections (schema/API/sheets & columns/formulas/validation/business rules/ID/shortcut payload freezes, migration compat, compatibility policies, versioning, extension points, known limitations & quotas) + certification and GO/NO-GO. |

No new files were added to `apps-script/`; no design or feature changes were made.
Pass 7 proved and documented; it changed **no application code** and therefore the
suite assertion count is unchanged.

---

## 4. Test results

```
cd tests && ./run.sh
```
**Result: ALL TESTS PASSED — 62/62.**

Coverage: value objects (Money/Period/DateStamp), ID format, duplicate
fingerprints, per-type validation invariants, balance-engine transfer semantics,
period math, auth hashing, response envelope, unknown-action rejection, E2E
`transaction.create` (happy path, `external_ref` dedupe, validation 400,
unknown-field/timestamp/source rules), net-worth credit sign (no double-flip),
recurring engine (weekly Mon/Sun, monthly 15th/31st, leap-year February,
30-day months, quarterly/yearly clamping, 12-month offline gap materialized
exactly once, repeated-execution idempotency, `end_date` completion,
no-double-book), analytics TREND sign, row retention, repository caching,
dashboard formula self-consistency (incl. plain-sum net worth — no credit flip),
data-validation dropdown column mapping (goals `priority` → column 9, status →
12), monthly burn-rate regression, lookup/dropdown coverage, row-level
formula-helper safety, **the security suite** (formula-injection guard,
formula-safe import through the persistence layer, secret masking in
`settings.get`, GET read-only enforcement, import fail-fast/cap validation),
**the concurrency suite** (settings writes acquire the script lock without
re-acquiring when nested; roadmap regeneration preserves the `STG_` primary
key across repeated runs), **and the post-freeze API-validity suite**:
conditional rules install through the Sheet API (a Range call throws, gets
swallowed, and installs nothing) and warning-only protections never touch the
editor-list APIs.

**Pass 7 (performance/scalability/quota audit):** the suite assertion count is
unchanged (no app-code changes were made), but the hot paths were measured at
1k/10k/50k/100k rows and every operation, engine, cache, trigger and import/export
path was costed against the official platform quotas (see `docs/08 §11` and
`docs/10`).

**Pass 8 (post-freeze API-validity audit):** two invalid Apps Script calls in
`FormattingService.gs` were proven against the official reference, fixed
(behavior-preserving), and locked with regression tests; the suite grew 60 → 62
(see `docs/08 §12`).

---

## 5. Deployment checklist (for the live workbook)

1. Add the 17 `.gs` files + `appsscript.json` to the bound project.
2. Run **FinPilot → Initialize Workbook** from an empty spreadsheet.
   Verify all 15 tabs + charts exist (re-running must not stack charts).
3. Verify triggers: daily 02:00 `recurringNow`, weekly Sunday 03:00 `analyticsNow`.
4. Deploy as web app: Execute as **Me**, Access **Anyone**; save the `/exec` URL.
5. Run `AuthService.rotateToken("<12+-char secret>")` in the editor.
6. Smoke-test: `?action=health` → POST `category.create` / `account.create` /
   `transaction.create` → confirm 200 `duplicate:false`, then re-send the same
   `external_ref` → 200 `duplicate:true`.
7. Install the Shortcuts (docs/06) with `token` in the body.
8. Back up the workbook (File → Make a copy) for disaster recovery.

---

## 6. Risks and follow-ups (accepted, non-blocking)

- **Burn-rate edge case:** `fBurn` returns 0 while fewer than `burn_rate_months`
  of months have data. Displayed honestly as 0; acceptable for v0.
- **Analytics triggers:** run weekly, so derived sheets may be up to 7 days stale
  between runs; `?action=analytics.run` is available on demand.
- **Anyone-with-token access:** gated solely by the token hash. Rotating the token
  (or emptying the hash in dev) is the only lock control; no per-user model yet.
- **No transaction row deletion** by design (void instead) — archive growth is
  handled by the retention window in `replaceRows`.
- **Sheet volume:** formulas use open-ended `$A$2:$A` ranges over `transactions`/
  `accounts`; fine for personal scale, revisit before multi-million-row growth.
- **Recurring catch-up bound:** a single `run()` materializes up to 10,000
  occurrences per rule (≈27 years of daily runs); a rule misconfigured past its
  validation (e.g. missing category) is retried on the next run rather than
  skipped, and the ledger stays consistent because each occurrence is keyed
  `REC-<id>-<date>`.
- **Roadmap `no_debt` sign edge:** with negative net worth the `no_debt` progress
  can exceed 100 (clamped on the low side only). Cosmetic for v0; revisit if
  debt-heavy profiles matter.
- **Timing-unsafe token comparison:** `AuthService.authorize` compares hashes with
  `===`. SHA-256 preimage resistance plus TLS noise make network timing impractical;
  a constant-time compare is future hardening, not a proven hole.
- **CSV `-` prefix (legacy Excel DDE):** `csvCell` neutralizes `=`,`+`,`@` but not
  `-` so negative balances export as text-compatible numbers; DDE is disabled in
  modern Excel.
- **No app-level rate limiting:** web apps receive no client IP, so per-client
  throttling is impossible here; Google platform quotas are the backstop and auth
  runs before any handler.
- **Scaling cost (P7.1/P7.2):** `transaction.create` does an O(ledger) duplicate
  scan (≈ 2.7 s CPU at 100k rows) and `analytics.run` does an O(periods × accounts ×
  ledger) recompute (≈ 100 s at 100k). Correct at all sizes, but 100k rows is the
  documented ceiling before PostgreSQL; the semantics-preserving optimizations
  (window pre-filter, running-balance sweep) are deliberately deferred.
- **`replaceRows` clear-then-write:** a failure between clear and write leaves
  `monthly_analytics` empty until the next `analytics.run` heals it (self-healing).
- **Import is a raw restore path:** it bypasses transaction domain validation by
  design; rows are bounded, shape-checked and formula-safe (K1/K4).
- **Unlocked audit appends:** `AuditService.log` runs after handlers release the
  lock (and read-only GETs never take it). Append-only table + atomic `appendRow`
  ⇒ no corruption, only nondeterministic commit order between concurrent
  requests; auditing is best-effort by design.
- **Lock-free reads:** a read can observe a table mid-write (the `replaceRows`
  window; settings row writes are per-row atomic). Consistent with single-user
  use and the documented manual-refresh flow.

---

## 7. Verdict

**GO.** Zero runtime errors, zero invalid APIs, zero schema/formula/chart/trigger
drift, clean bootstrap from an empty sheet, a re-install-safe dashboard, an
accounting engine whose net-worth paths agree (including the dashboard KPI),
a recurring engine that honors its documented fields and never loses or
double-books an occurrence, data-validation dropdowns mapped to the correct
columns, a security posture that closes formula injection, secret disclosure,
GET-side mutations and unbounded imports, a concurrency posture that serializes
every mutation under the script lock and preserves primary keys across
regeneration, a measured performance profile that stays inside every platform
quota through 100k transactions, 62/62 tests passing, and every documentation
claim verified against the code. The v1.0 backend is now formally frozen in
`docs/10-backend-freeze.md`. FinPilot v0 is production-ready.
