# FinPilot v0 — Future Migration Strategy

> The schema is designed so that migrating to PostgreSQL / Supabase / ERPNext-Frappe /
> Firebase is a **data port + adapter swap**, not a redesign.

---

## 1. Why the schema already is a SQL schema

| Sheets concept | PostgreSQL equivalent |
|---|---|
| Sheet = table | `CREATE TABLE` |
| Header row = columns | `COLUMN` definitions |
| Row = record | `ROW` |
| `*_id` columns | `PRIMARY KEY` / `FOREIGN KEY` |
| `lookups` group | enum types / reference tables |
| `validation_rules` | CHECK constraints + app rules |
| `transactions.status` | `status` enum, void rows excluded in views |
| Derived balances | `SUM()` in a view — never stored |

The `sql/schema_postgres.sql` file ships an equivalent DDL. Column names and types are
kept identical so a simple ETL (`sheet → CSV → COPY`) works with zero transforms.

---

## 2. Migration path options

### A. Supabase (recommended first stop)
1. Create tables from `schema_postgres.sql`.
2. Add RLS policies keyed by `user_id` (add `owner_id` column).
3. Export each sheet as CSV (`GET` on the Apps Script `export` action) and `COPY`/import.
4. Replace `SheetRepository` with a `SupabaseRepository` implementing the same interface
   (row get/append/query). Domain services unchanged.
5. Analytics move to Postgres views + a cron/`pg_cron` job (mirroring `AnalyticsService`).
6. iPhone Shortcuts now POST to a Supabase Edge Function with the exact same payloads.

### B. ERPNext / Frappe
- `transactions` → mapped to `Journal Entry` / a custom DocType `WealthTransaction`
  (fields identical). `accounts` → `Account`. `categories` → `Expense Claim Type` +
  custom `Category`. `income_sources` → custom DocType.
- Use Frappe's REST API as the new backend; keep the same Shortcut payloads.
- Balanced entries for EXPENSE/INCOME/TRANSFER can be generated at import time
  (see Accounting Rules below).

### C. Firebase (NoSQL)
- One document per aggregate root: `users/{uid}/ledger/{trxId}`, `accounts/{accId}`.
- Keep the same field names; `lookups` becomes static config. Analytics → Cloud
  Functions scheduled like the current triggers.

---

## 3. Schema transformation table

| Sheet | PG table | Key change |
|---|---|---|
| transactions | `transactions` | add `owner_id`, `version`, `tx_hash` |
| accounts | `accounts` | add `owner_id` |
| categories | `categories` | self-join `parent_category_id` FK |
| income_sources | `income_sources` | |
| budgets | `budgets` | unique `(category_id, period)` |
| goals | `goals` | |
| recurring | `recurring` | |
| monthly_analytics | `analytics_facts` | split into wide view + facts table |
| financial_score | `score_metrics` | |
| roadmap | `roadmap_stages` | |
| settings | `app_settings` | |
| audit_logs | `audit_logs` | add `owner_id`, index on `ts` |
| lookups | `lookups` + enum types | |
| validation_rules | `validation_rules` | |

---

## 4. Data export endpoint

```
action: "export"  { "table": "transactions", "format": "csv" | "json" }
```
Returns rows in header order. Used by the migration tooling. There is also
`action: "import"` (with `dry_run: true`) to restore data.

---

## 5. Handling accounting correctness in any target

- EXPENSE: `debit: expense` … `credit: account`. Net worth ↓.
- INCOME: `debit: account` … `credit: income`. Net worth ↑.
- TRANSFER: `debit: to_account` … `credit: from_account`. Net worth unchanged.
- A `POSTED` transaction always implies these balanced entries; `VOID`/`REJECTED`
  rows are excluded via `status` filters in every view.

---

## 6. Checklist before migration

- [ ] Freeze schema (`settings.schema_version`).
- [ ] Export full `transactions` CSV + verify row count equals `COUNT(*)` of POSTED+VOID.
- [ ] Create `settings`, `lookups` CSV exports.
- [ ] Validate: every `*_id` in transactions resolves in its master table (no orphans).
- [ ] Run `action: "analytics.run"` and compare dashboard KPIs pre/post import.
- [ ] Cut over Shortcuts URL to the new endpoint (keep old web app for 30 days).
