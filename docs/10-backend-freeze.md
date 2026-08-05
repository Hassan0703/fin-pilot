# FinPilot v0 — Backend Freeze (v1.0)

**Status:** FROZEN — 2026-08-05
**Applies to:** the runtime contract of the FinPilot v0 backend as verified by
Passes 1–7 (`docs/09`) and the engineering audit (`docs/08`). This document is the
binding freeze for anything that reads or writes the backend: the iPhone Shortcuts
(`docs/06`), API clients (`docs/04`), the migration path (`docs/07`), and any future
extension.

**Scope & governance.** From this point, the artifacts below are *contract*: a change
to any frozen item is a breaking change and follows §12. Unfrozen items are listed in
§14 (extension points) and may evolve without a breaking-change bump as long as they
remain additive. Nothing here adds features or changes behavior — this pass only
proved, measured and locked the existing v1.0 behavior.

---

## 1. Purpose & definition of "frozen"

A **frozen** item is one the backend's correctness depends on: renaming, reordering,
re-typing or re-semanticizing it risks silent data corruption, a broken client, or a
broken migration. Freezing means:

- **Readers** (docs, Shortcuts, tests, the freeze itself) treat the item as stable;
- **Maintainers** treat any modification as a breaking change (§12) requiring
  migration + a version bump (§13);
- **Tests** encode the item's key invariants (60/60 today).

The freeze is enforced by the suite in `tests/` and by review of any diff touching
`apps-script/`, `sql/`, or the frozen docs.

---

## 2. Backend freeze summary

| Layer | Freeze location | Status |
|---|---|---|
| Schema (tables, columns, order) | `Repository.gs` `TABLES` (14 data tables) | FROZEN |
| Sheets & tabs | 14 data sheets + `dashboard` derived tab | FROZEN |
| API surface (actions, envelope, verbs) | `Code.gs` `getActionHandler`, `READ_ONLY_ACTIONS` | FROZEN |
| Formulas | `FormattingService.gs` + `docs/03` | FROZEN |
| Validation | `ValidationService.gs` + `validation_rules` seed | FROZEN |
| Business rules | `TransactionService.gs`, `AnalyticsService.gs`, `RecurringService.gs` | FROZEN |
| ID formats | `IdGenerator.gs` `ID_PREFIXES` | FROZEN |
| Shortcut payload contract | `docs/06` | FROZEN |
| Migration compatibility | `sql/schema_postgres.sql`, `docs/07` | FROZEN |

---

## 3. Schema freeze

The 14 data tables are defined in `Repository.gs` `TABLES` and mirrored 1:1 by
`sql/schema_postgres.sql` and `docs/02-schema.md`. Frozen: table name, column set,
column **order** (sheet order IS the record order — a reorder breaks every reader),
and value types.

| Table | Key | Notes |
|---|---|---|
| `transactions` | `transaction_id` | Ledger aggregate root; 19 columns; append-only (§7). |
| `accounts` | `account_id` | `current_balance` is a FORMULA, never stored. |
| `categories` | `category_id` | `type` limited to EXPENSE/INCOME at app layer. |
| `income_sources` | `income_source_id` | |
| `budgets` | `budget_id` | per `category_id × period`. |
| `goals` | `goal_id` | `current_amount`/`projected_completion` are formulas. |
| `recurring` | `recurring_id` | engine semantics frozen in `docs/02 §8`. |
| `monthly_analytics` | `analytics_id` | derived, never hand-edited. |
| `financial_score` | `metric_code` | derived. |
| `roadmap` | `stage_id` | `stage_id` preserved across regeneration (M2). |
| `settings` | `key` | `api_token_hash` is a reserved secret key. |
| `audit_logs` | `audit_id` | append-only, best-effort. |
| `lookups` | `lookup_id` | dropdown source. |
| `validation_rules` | `rule_id` | seeded from `DEFAULT_VALIDATION_RULES`. |

`is_credit` is TEXT `"TRUE"`/`"FALSE"` in Sheets and BOOLEAN in PostgreSQL (S04,
cast required at migration). `accounts.current_balance` is a plain column in PG
computed by the `v_balances` view (S01).

---

## 4. Sheets & columns freeze

15 tabs total: the 14 table sheets above plus the **`dashboard`** derived tab
(no backing table). Frozen:

- Tab **names** (repository lookups `getSheetByName`, cross-sheet formulas and the
  dashboard reference them by name — a rename breaks every formula).
- **Header row 1** exactly equal to each table's column list, in order.
- **Data starts at row 2**.
- Dashboard layout anchor cells read by `DashboardService.readCell` (KPI cells
  `B6/D6/F6/H6/J6`) and the chart set installed by `installCharts` (re-install must
  be idempotent — no chart stacking, I2).

---

## 5. Formula freeze

`FormattingService.gs` is the authoritative implementation (`docs/03`). Frozen
formulas:

- **`accounts.current_balance`** (column F): opening balance + POSTED ledger
  movements via `SUMPRODUCT` (income/transfer in, expense/transfer out), `""` when
  opening balance is not numeric.
- **`goals.current_amount`** (column G): linked account balance − opening balance.
- **`goals.projected_completion`** (column K): `TODAY()` if target reached, else
  `EDATE(TODAY(), CEILING((target−current)/monthly))`.
- **Dashboard KPIs** (`dashboard.summary`): net worth as a **plain sum** of
  `accounts!F:F` (J1 — no credit flip), `fBurn` monthly burn rate (P04), TREND
  sign semantics (P04/H1).

Formulas use open-ended `$A$2:$A`-style ranges over `transactions`/`accounts`;
batch-written with `setFormulas` (F25/P02/P03). Spreadsheet formula **injection is
neutralized** at the persistence boundary by `guardFormula` (K1) and on CSV export
by `csvCell`.

---

## 6. Validation freeze

Frozen at `ValidationService.gs` + the `validation_rules` seed list
(`docs/02`, `DEFAULT_VALIDATION_RULES`). Key invariants:

- **Money** bounds (finite, ≤ 1e12) and currency `[A-Z]{3}`.
- **Dates** are strict calendar dates (`DateStamp`) and periods `YYYY-MM`
  (`Period`); the ledger accepts no invalid calendar day.
- **Per-type field rules**: EXPENSE requires category, rejects `to_account`;
  INCOME requires `income_source`, rejects `from_account`; TRANSFER requires both
  `from_account` and `to_account`, rejects category/source; unknown fields are
  rejected; `timestamp`/`source` are validated.
- **Status/source enums** and `external_ref` idempotency keys (`REC-<id>-<date>`).
- Errors are surfaced as `ValidationError` (HTTP 400) — never as a server error.
- Import (`apiImport`) is a raw restore path: shape-checked, `MAX_IMPORT_ROWS=1000`,
  fail-fast before any write (K4).

---

## 7. Business-rules freeze

Frozen domain invariants (see `docs/02`, `docs/08 §7`):

- **Ledger is append-only**: rows are never deleted; `transaction.void` sets
  `status=VOID`; REJECTED/VOID rows are excluded from balances and analytics.
- **Statuses**: POSTED (default), VOID, DUPLICATE_SKIPPED. REJECTED used for
  validation failures.
- **Duplicate protection**: hard dedupe on `external_ref` (always); soft dedupe on
  SHA-256 fingerprint within `duplicate_window_minutes` (default 2880 = 48h);
  `force:true` overrides the soft check only.
- **Analytics**: derived tables regenerated by `analytics.run`/weekly trigger
  (`replaceRows` clear+write inside the lock, retention window
  `analytics_retention_months`, default 36); net worth = plain sum of POSTED
  balances (no credit flip); liability sign convention in `docs/02 §3`.
- **Recurring**: catch-up loop materializes up to 10,000 occurrences/rule, keyed
  `REC-<id>-<date>` so re-runs never double-book; honors `end_date` (H2/H3).
- **Auth**: token hashed (SHA-256), compared in `authorize`; empty `api_token_hash`
  = dev mode; min token 12 chars; `settings.set` rejects the `api_token_hash` key.
- **Serialization**: every mutation runs under `withLock` (tryLock 10 s, reentrant);
  reads are lock-free by design.

---

## 8. ID-format freeze

`IdGenerator.gs` `ID_PREFIXES` + format
`<PREFIX>_<TIME_BASE32(11)><RANDOM_BASE32(5)><SEQ_BASE32>` (requests:
`REQ_<TIME>(11)<RANDOM>(3)<SEQ>`). Frozen prefixes:

`TRX` transactions · `ACC` accounts · `CAT` categories · `SRC` income sources ·
`BUD` budgets · `GOL` goals · `REC` recurring · `ANA` analytics · `AUD` audit ·
`LKP` lookups · `RUL` rules · `STG` roadmap stages · `REQ` request correlation.

Properties (frozen): time-sortable (fixed-width time base32), unique within an
execution (monotonic seq), collision-resistant at single-user scale; alphabet is
base32 without I/L/O/0/1. Any new prefix is an extension (§14) — changing or
re-using an existing prefix is breaking.

---

## 9. Shortcut payload freeze

The iPhone Shortcuts contract (`docs/06`). Frozen:

- **Transport**: POST to the `/exec` URL, JSON body `{action, token, ...payload}`;
  GET allowed only for `READ_ONLY_ACTIONS` (`health`, `settings.get`,
  `lookups.list`, `analytics.status`, `transaction.get/list`, `account.list/get`,
  `category.list`, `income_source.list`, `budget.list`, `goal.list`,
  `recurring.list`, `dashboard.summary`, `audit.list`, `export`) — a GET on any
  other action returns 405 (K3).
- **Envelope**: every response is JSON `{ok, data, warnings, meta}` with
  `meta.request_id`, `meta.ts`, `meta.duration_ms`, `meta.api_version`; errors are
  `{ok:false, data:null, error, warnings}`; validation failures are HTTP 400 with
  `error.code=VALIDATION_ERROR` and `error.details`.
- **Auth**: token in `token`; URL query-token works for GETs but is deprecated
  (leaks via logs/history — P12). Token never returned or echoed.
- `transaction.create` returns `duplicate:false|true` and `duplicate_of`; `dry_run`
  and `force:true` are supported, documented fields.

---

## 10. Migration compatibility

The PostgreSQL schema (`sql/schema_postgres.sql`) is the frozen migration target
(`docs/07`). Guarantees:

- Same table names and columns as §3; same primary keys.
- `v_balances` reproduces `accounts.current_balance` semantics; `v_net_worth` is
  the plain-sum POSTED net worth (S02/H1).
- Known casts documented (S04: `is_credit` TEXT→BOOLEAN; `date` as TEXT; money as
  NUMERIC).
- Export/import API (`MIGRATION_ALLOW`: transactions, accounts, categories,
  income_sources, budgets, goals, recurring) round-trips between Sheets and any
  target; CSV export is formula-safe (`csvCell`).
- Recommendation stands: run `psql -f sql/schema_postgres.sql` once before migrating.

---

## 11. Backward-compatibility policy

- The backend guarantees **forward compatibility for stored data and frozen
  consumers**: a newer version reads data written by every earlier v1.0.x build,
  and existing Shortcuts keep working until a §12 bump.
- Additive changes (new optional payload fields, new read-only actions, new lookup
  rows, new settings keys with defaults) do **not** break old clients and are
  allowed without a bump.
- Derived sheets (`monthly_analytics`, `financial_score`, `roadmap`, dashboard) may
  be regenerated at any time; their *schema* is frozen but their *contents* are not
  a compat surface.
- Any fix that alters observable behavior must be accompanied by a regression test
  and a changelog entry before landing (proven-defect rule from Phase 7).

---

## 12. Breaking-change policy

A change is **breaking** if it: renames/reorders/removes a table, column, tab,
action, envelope field, status value, prefix, or frozen formula; changes validation
semantics so previously-accepted data becomes invalid (or vice-versa); changes the
balance/net-worth sign conventions; or changes the dedupe/void/recurring invariants.

Procedure for a breaking change:

1. Requires a major version bump (§13) and a migration plan (`docs/07`).
2. Must ship with a schema/API freeze revision in this document and an updated
   `docs/02`/`docs/04`.
3. Must provide either a data migration or an explicit, documented export path
   (`apiExport`) before the cutover.
4. Must be covered by new tests; the full suite must pass.
5. Forwards-compatible: old clients must fail loudly with a clear error rather than
   corrupt data.

---

## 13. Versioning

- `API_VERSION` and `SCHEMA_VERSION` are both `1.0.0` (`Code.gs`), returned in
  every `meta` block and via `health`.
- `meta.api_version` is the client-visible contract version. Minor (additive)
  changes keep `1.0.x`; breaking changes (§12) bump to `1.1`, `2.0`, etc.
- Deployments are versioned web-app deployments; the token, workbook id
  (`database_id` Script Property) and schema version are verified at bootstrap.
- Every release must update `docs/09` test results and this freeze's certification
  (§15).

---

## 14. Extension points

Unfrozen (additive evolution allowed without a §12 bump):

- **EventBus** (`Code.gs` `EVENT_SUBSCRIBERS`): new subscribers to
  `transaction.created` / `ledger.changed` / `account.created` /
  `category.created` / `setup.complete` — additive.
- **ScoreService.METRICS**: adding a metric config is additive; removing/reweighing
  a metric changes derived rows (minor, documented).
- **RoadmapService.STAGES**: adding a stage is additive; reordering changes
  `stage_order` semantics (breaking).
- **Settings keys**: new keys with defaults are additive (secret keys remain
  rejected at `settings.set`).
- **Lookups / dropdowns** (`lookups` table): new lookup groups/rows are additive.
- **`MIGRATION_ALLOW`**: adding a table to export/import is additive.
- **Triggers**: new installable triggers are additive; the two frozen triggers
  (daily `recurringNow`, weekly `analyticsNow`) stay.
- The two deferred optimizations from `docs/08 §11` (duplicate-scan window
  pre-filter P7.1; running-balance analytics sweep P7.2) are semantics-preserving
  and can land as non-breaking perf fixes with regression tests.

---

## 15. Known limitations & platform quotas

Accepted, non-blocking residuals (full proofs in `docs/08 §9–§11`, `docs/09 §6`):

- **Scale ceiling ≈ 100k transactions** (measured, Node V8): `transaction.create`
  ≈ 2.7 s CPU (O(ledger) duplicate scan), `analytics.run` ≈ 100 s
  (O(periods × accounts × ledger)). ≤ 50k is the comfortable personal-scale
  envelope. Beyond → PostgreSQL (`sql/schema_postgres.sql`).
- **One full-table read per execution** (Sheets-as-DB; per-execution cache).
- **Analytics staleness**: derived sheets are weekly-trigger fresh; on-demand
  `analytics.run` available.
- **No app-level rate limiting** (no client IP on web apps); platform quotas backstop.
- **Anyone-with-token model**: single shared token hash; no per-user model.
- **Lock-free reads / unlocked audit appends**: benign, documented.
- **`replaceRows` clear-then-write window**; **timing-unsafe hash compare**;
  **`fBurn` returns 0 with insufficient history**; **`no_debt` >100 with negative
  net worth**; **recurring catch-up bound (10k/rule)**; **CSV `-` DDE legacy
  note** — all accepted and documented.

Platform quotas (official, updated 2026-07-22; consumer / Workspace):

| Quota | Consumer | Workspace |
|---|---|---|
| Script runtime / execution | 6 min | 6 min |
| Simultaneous executions / user | 30 | 30 |
| Simultaneous executions / script | 1,000 | 1,000 |
| Triggers / script | 20 | 20 |
| Triggers total runtime / day | 90 min | 6 hr |
| Properties read/write / day | 50,000 | 500,000 |
| URL Fetch / day | 20,000 | 100,000 |
| Email recipients / day | 100 | 1,500 |
| Spreadsheets created / day | 250 | 3,200 |

---

## Certification

- Test suite: **60/60 PASS** (`cd tests && ./run.sh`).
- Backend freeze sections 1–15 verified against the code in Passes 1–7
  (`docs/08`, `docs/09`). No open defects; every residual is measured and
  accepted above.
- Quota usage stays inside all platform limits through 100k transactions
  (measured, `docs/08 §11`).
- **Recommendation: GO.** FinPilot v0 backend is certified and frozen at v1.0.0.
  Future work — performance optimizations (P7.1/P7.2) or PostgreSQL cutover —
  proceeds only as non-breaking changes under §11–§14.
