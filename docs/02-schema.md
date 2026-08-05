# FinPilot v0 — Database Schema

> Every sheet is a table. First row = header (frozen). Data starts at row 2.
> All columns are `snake_case`. All IDs are text, unique, time-sortable.
> Data types map 1:1 to PostgreSQL (see `sql/schema_postgres.sql`).

**Type legend:** `PK` primary key, `FK` foreign-key reference, `ENUM` validated by lookups, `DERIVED` formula/engine-computed, `NUL` nullable.

---

## 2. transactions — the Ledger (Single Source of Truth)

Rules: never edit balances here, never delete rows, never manually total. Append-only.

| Column | Type | Notes |
|---|---|---|
| `transaction_id` | TEXT PK | `TRX_<base32time><rand>` |
| `transaction_ts` | TIMESTAMP | ISO-8601, UTC, when the event happened |
| `date` | DATE | local business date (from `transaction_ts` or supplied) |
| `type` | ENUM | `EXPENSE` \| `INCOME` \| `TRANSFER` |
| `amount` | NUMERIC(18,4) | always positive; sign is implied by `type` |
| `currency` | ENUM FK | ISO-4217 code from `lookups.currency` |
| `account_id` | FK NUL | EXPENSE: paying account · INCOME: destination account |
| `from_account_id` | FK NUL | TRANSFER source account |
| `to_account_id` | FK NUL | TRANSFER destination account |
| `category_id` | FK NUL | required for EXPENSE |
| `income_source_id` | FK NUL | required for INCOME |
| `merchant` | TEXT NUL | free text (expense/income counterparty) |
| `note` | TEXT NUL | free text |
| `tags` | TEXT NUL | comma-separated codes from `lookups.tag` |
| `external_ref` | TEXT NUL | client-supplied idempotency key (shortcut UUID, recurring `REC-<id>-<next_run>`) |
| `status` | ENUM | `PENDING` \| `POSTED` \| `VOID` \| `REJECTED` \| `DUPLICATE_SKIPPED` |
| `source` | ENUM | `SHORTCUT` \| `API` \| `SYSTEM` \| `IMPORT` |
| `created_at` | TIMESTAMP | write time (server) |
| `updated_at` | TIMESTAMP NUL | last mutation time |

**Accounting semantics**
- `EXPENSE` → debit (decreases net worth). `account_id` = account charged.
- `INCOME` → credit (increases net worth). `account_id` = account credited.
- `TRANSFER` → moves value between `from_account_id` and `to_account_id`.
  It changes neither income, expense nor net worth — only account balances.
- `amount` is never negative; reject negative/zero via validation rules.

---

## 3. accounts

| Column | Type | Notes |
|---|---|---|
| `account_id` | TEXT PK | `ACC_<base32time><rand>` |
| `name` | TEXT | display name |
| `type` | ENUM FK | `CASH` \| `BANK` \| `WALLET` \| `SAVINGS` \| `INVESTMENT` \| `BUSINESS` \| `CREDIT_CARD` \| `LOAN` \| `CRYPTO` (extensible via lookups) |
| `currency` | ENUM FK | ISO-4217 |
| `opening_balance` | NUMERIC | balance at `created_date` (may be negative for loans) |
| `current_balance` | NUMERIC DERIVED | formula: opening + SUM(transactions) — never hand-entered |
| `color` | ENUM FK | hex from `lookups.color` |
| `icon` | ENUM FK | code from `lookups.icon` |
| `status` | ENUM | `ACTIVE` \| `INACTIVE` \| `ARCHIVED` |
| `is_credit` | BOOLEAN | true for credit cards/loans (liability semantics); stored in Sheets as the TEXT `"TRUE"`/`"FALSE"` (BOOLEAN in PostgreSQL) |
| `note` | TEXT NUL | |
| `created_date` | DATE | |
| `created_at` | TIMESTAMP | |

**Liability sign convention.** Liability accounts (`is_credit = true`) carry
negative balances: a credit card / loan balance is the amount owed, stored as a
negative number (see `opening_balance`, "may be negative for loans"). The ledger
engine and the `current_balance` formula never branch on `is_credit` — expenses
reduce an account's balance, transfers in raise it — so **net worth is the plain
sum of all account balances** (credit balances already subtract). `netWorthAt`
and the SQL `v_net_worth` view follow this rule; credit balances are never
flipped to positive.

**current_balance formula (sheet):**
```
=IF(ISNUMBER($E2),
  $E2
  +SUMPRODUCT((transactions!$P$2:$P="POSTED")*((transactions!$G$2:$G=$A2)*(transactions!$D$2:$D="INCOME")+(transactions!$I$2:$I=$A2)*(transactions!$D$2:$D="TRANSFER"))*transactions!$E$2:$E)
  -SUMPRODUCT((transactions!$P$2:$P="POSTED")*((transactions!$G$2:$G=$A2)*(transactions!$D$2:$D="EXPENSE")+(transactions!$H$2:$H=$A2)*(transactions!$D$2:$D="TRANSFER"))*transactions!$E$2:$E)
  ,"")
```
Where accounts: col A=account_id, col E=opening_balance, col F=current_balance; transactions:
col D=type, col E=amount, col G=account_id, col H=from_account_id, col I=to_account_id, col P=status.
(Income adds to account_id, expense subtracts from account_id, transfer subtracts from
from_account_id and adds to to_account_id; only POSTED rows count.)

The formula is applied by `FormattingService.applyAccountFormula(row)` both at initialization
(for existing rows) and on every `account.create`, so accounts added later are never missing
their balance.

---

## 4. categories

| Column | Type | Notes |
|---|---|---|
| `category_id` | TEXT PK | `CAT_...` |
| `parent_category_id` | FK NUL | self-reference → unlimited sub-categories |
| `name` | TEXT | |
| `type` | ENUM | `EXPENSE` \| `INCOME` (what it labels) |
| `icon` | ENUM FK | |
| `color` | ENUM FK | |
| `monthly_budget` | NUMERIC NUL | default budget; `budgets` overrides per period |
| `sort_order` | INT | ordering for dropdowns/reports |
| `status` | ENUM | `ACTIVE` \| `INACTIVE` \| `ARCHIVED` |
| `created_at` | TIMESTAMP | |

---

## 5. income_sources

| Column | Type | Notes |
|---|---|---|
| `income_source_id` | TEXT PK | `SRC_...` |
| `name` | TEXT | Salary, Freelance, Business, Gift, Refund, Dividend, Bonus, Interest, Other |
| `type` | ENUM | `EMPLOYMENT` \| `FREELANCE` \| `BUSINESS` \| `PASSIVE` \| `OTHER` |
| `icon` / `color` | ENUM FK | |
| `sort_order`, `status` | | |
| `created_at` | TIMESTAMP | |

---

## 6. budgets

| Column | Type | Notes |
|---|---|---|
| `budget_id` | TEXT PK | `BUD_...` |
| `category_id` | FK | category being budgeted |
| `period` | TEXT | `YYYY-MM` (future: `YYYY` for yearly budgets) |
| `budget_amount` | NUMERIC | monthly cap |
| `currency` | ENUM FK | |
| `status` | ENUM | `ACTIVE` \| `ARCHIVED` |
| `created_at` | TIMESTAMP | |

**Effective budget = `budgets.budget_amount` for the period, else `categories.monthly_budget`.**
Remaining / used % are DERIVED formulas on the Dashboard.

---

## 7. goals

| Column | Type | Notes |
|---|---|---|
| `goal_id` | TEXT PK | `GOL_...` |
| `name` | TEXT | Emergency Fund, Laptop, Car, House, Vacation… |
| `goal_type` | ENUM | `EMERGENCY_FUND` \| `SAVINGS` \| `ASSET` \| `INVESTMENT` \| `VACATION` \| `DEBT_FREE` \| `CUSTOM` |
| `target_amount` | NUMERIC | goal amount |
| `currency` | ENUM FK | |
| `linked_account_id` | FK NUL | savings account the fund lives in |
| `current_amount` | NUMERIC DERIVED | linked account balance minus opening (auto) OR 0 || `deadline` | DATE NUL | |
| `priority` | ENUM | `HIGH` \| `MEDIUM` \| `LOW` |
| `monthly_contribution` | NUMERIC | planned monthly top-up |
| `projected_completion` | DATE DERIVED | `=EDATE(TODAY(), CEILING((target-current)/monthly_contribution))` |
| `status` | ENUM | `ACTIVE` \| `PAUSED` \| `COMPLETED` |
| `created_at` | TIMESTAMP | |

`current_amount` (G) and `projected_completion` (K) are formulas applied by
`FormattingService.applyGoalFormulas(row)` at initialization and on every `goal.create`.

---

## 8. recurring

| Column | Type | Notes |
|---|---|---|
| `recurring_id` | TEXT PK | `REC_...` |
| `name` | TEXT | Rent, Salary, Netflix… |
| `type` | ENUM | `EXPENSE` \| `INCOME` |
| `amount` | NUMERIC | |
| `currency` | ENUM FK | |
| `frequency` | ENUM | `DAILY` \| `WEEKLY` \| `MONTHLY` \| `QUARTERLY` \| `YEARLY` |
| `day_of_month` | INT NUL | for MONTHLY/QUARTERLY/YEARLY; if the target month is shorter, the run is clamped to the last valid day (day 31 → Feb 28/29; Apr 30) |
| `day_of_week` | INT NUL | for WEEKLY (1=Mon … 7=Sun) |
| `start_date` | DATE | |
| `end_date` | DATE NUL | |
| `next_run` | DATE DERIVED | engine computed |
| `last_run` | DATE NUL | engine recorded |
| `account_id` | FK NUL | expense paying account / income destination |
| `from_account_id` / `to_account_id` | FK NUL | for transfer-type recurrence (optional) |
| `category_id` | FK NUL | expense category |
| `income_source_id` | FK NUL | income source |
| `status` | ENUM | `ACTIVE` \| `PAUSED` \| `COMPLETED` |
| `created_at` | TIMESTAMP | |

**Engine behavior (RecurringService):**
- All dates are computed in **UTC** (the project's canonical timezone) — no DST drift.
- `day_of_week` is honored for WEEKLY (1=Mon … 7=Sun); if absent the run keeps
  the start date's weekday.
- `day_of_month` is honored for MONTHLY/QUARTERLY/YEARLY; if absent the run keeps
  the anchor date's day-of-month. Short months clamp to the last valid day
  (deterministic across leap years).
- `run()` materializes **every missed occurrence exactly once**: it iterates from
  `last_run` (or `next_run` when never run) through today, so results are
  identical whether the trigger fires daily, weekly or after months offline.
- Idempotency: each occurrence carries `external_ref = REC-<id>-<date>`; a
  duplicate reference is never re-booked, so running `run()` twice never
  double-books. Rules whose `end_date` has passed are marked `COMPLETED`.

---

## 9. monthly_analytics (generated — read-only)

Normalized fact table, one row per (period × metric [× dimension]).

| Column | Type | Notes |
|---|---|---|
| `analytics_id` | TEXT PK | `ANA_...` |
| `period` | TEXT | `YYYY-MM` |
| `metric` | ENUM | `INCOME`, `EXPENSE`, `SAVINGS`, `CASH_FLOW`, `BURN_RATE`, `AVG_DAILY_SPEND`, `SAVINGS_RATE`, `NET_WORTH`, `CATEGORY_SPEND`, `MERCHANT_SPEND`, `ACCOUNT_BALANCE`, `TREND_INCOME`, `TREND_EXPENSE`, `TREND_NET_WORTH` |
| `dimension` | TEXT NUL | `category_id` / `merchant` / `account_id` / NULL for totals |
| `rank` | INT NUL | ordering within a dimension group (top-N) |
| `value` | NUMERIC | computed amount / rate |
| `generated_at` | TIMESTAMP | |

All rows are produced by `AnalyticsService` (scheduled + on-demand). Never hand-edited.

---

## 10. financial_score (generated — read-only)

| Column | Type | Notes |
|---|---|---|
| `metric_code` | TEXT PK | `SAVINGS_RATE`, `EMERGENCY_FUND_MONTHS`, `BURN_RATE`, `DEBT_TO_INCOME`, `NET_WORTH_MOMENTUM`, `EXPENSE_CONTROL` |
| `metric_name` | TEXT | human label |
| `weight` | NUMERIC | 0–100; sum of weights = 100 |
| `current_value` | NUMERIC DERIVED | formula referencing `monthly_analytics` / `accounts` |
| `target_value` | NUMERIC | from `settings` target defaults |
| `score` | NUMERIC DERIVED | 0–100 scaled vs target |
| `status` | ENUM DERIVED | `ON_TRACK` \| `WARNING` \| `FAIL` |
| `remarks` | TEXT DERIVED | generated coaching text (AI-ready) |
| `updated_at` | TIMESTAMP | |

`score = MIN(100, ROUND(100 * current_value / target_value))` (higher-is-better metrics) or inverse for lower-is-better. Overall score = weighted sum on the Dashboard.

---

## 11. roadmap (generated — read-only)

| Column | Type | Notes |
|---|---|---|
| `stage_id` | TEXT PK | `STG_...` |
| `stage_order` | INT | 1..7 |
| `stage_name` | ENUM | `SURVIVAL` \| `EMERGENCY_FUND` \| `DEBT_FREE` \| `STABLE` \| `GROWTH` \| `INVESTMENT` \| `FINANCIAL_FREEDOM` |
| `description` | TEXT | |
| `requirement_rule` | TEXT | human-readable condition, e.g. `emergency_fund_months >= 3` |
| `status` | ENUM DERIVED | `LOCKED` \| `CURRENT` \| `COMPLETED` |
| `progress` | NUMERIC DERIVED | 0–100 vs requirement |
| `recommendation` | TEXT DERIVED | next action, generated |
| `achieved_date` | DATE NUL | |
| `updated_at` | TIMESTAMP | |

Current stage is derived by `RoadmapService` from live metrics (emergency fund months, debt balance, savings rate).

---

## 12. settings (configuration)

| Column | Type | Notes |
|---|---|---|
| `key` | TEXT PK | `base_currency`, `country`, `theme`, `fiscal_year_start`, `budget_alert_threshold`, `duplicate_window_minutes`, `timezone`, `api_token_hash`, `schema_version`, `api_version`, `ai_coach_enabled`… |
| `value` | TEXT | raw string value |
| `value_type` | ENUM | `STRING` \| `NUMBER` \| `BOOL` \| `JSON` |
| `description` | TEXT | documentation of the key |
| `is_secret` | BOOL | mask in audit/log output |
| `updated_at` | TIMESTAMP | |

---

## 13. audit_logs (append-only)

| Column | Type | Notes |
|---|---|---|
| `audit_id` | TEXT PK | `AUD_...` |
| `ts` | TIMESTAMP | |
| `request_id` | TEXT | correlation id |
| `endpoint` | TEXT | action name |
| `method` | TEXT | GET/POST |
| `client` | TEXT | shortcut name / caller |
| `payload_hash` | TEXT | SHA-256 of canonical payload |
| `status` | ENUM | `SUCCESS` \| `FAILED` \| `DUPLICATE` \| `REJECTED` |
| `response_code` | INT | HTTP-style code |
| `error` | TEXT NUL | error message |
| `record_id` | TEXT NUL | created/updated record |
| `duplicate_of` | TEXT NUL | matched transaction_id |
| `created_at` | TIMESTAMP | |

---

## 14. lookups (dictionaries)

Type-discriminated table: one row per dictionary entry.

| Column | Type | Notes |
|---|---|---|
| `lookup_id` | TEXT PK | `LKP_...` |
| `lookup_group` | ENUM | `transaction_type` \| `account_type` \| `currency` \| `country` \| `month` \| `icon` \| `color` \| `status` \| `tag` \| `frequency` \| `payment_method` \| `goal_type` \| `priority` \| `metric` |
| `code` | TEXT | stored value, UPPER_SNAKE |
| `label` | TEXT | human label |
| `display_order` | INT | |
| `is_active` | BOOL | |
| `meta` | TEXT NUL | JSON (e.g. currency symbol, icon glyph) |

No dropdown in the workbook hardcodes these; sheet data validation reads this table.

---

## 15. validation_rules (business rule repository)

| Column | Type | Notes |
|---|---|---|
| `rule_id` | TEXT PK | `RUL_...` |
| `entity` | ENUM | `TRANSACTION` \| `ACCOUNT` \| `CATEGORY` \| `BUDGET` \| `GOAL` \| `RECURRING` |
| `rule_code` | TEXT | unique code, e.g. `EXPENSE_REQUIRES_CATEGORY` |
| `severity` | ENUM | `ERROR` \| `WARN` |
| `description` | TEXT | business meaning |
| `applies_when` | TEXT NUL | JSON conditions (e.g. `{"type":"EXPENSE"}`) |
| `params_json` | TEXT NUL | rule parameters |
| `is_active` | BOOL | |
| `created_at` / `updated_at` | | |

**Seed rules (all ERROR):**

| rule_code | description |
|---|---|
| `EXPENSE_REQUIRES_CATEGORY` | expense must have a `category_id` |
| `EXPENSE_REQUIRES_ACCOUNT` | expense must have an `account_id` |
| `EXPENSE_REJECTS_DESTINATION` | expense must NOT have `to_account_id` |
| `EXPENSE_REJECTS_TRANSFER_FIELDS` | expense must NOT have `from_account_id`/`income_source_id` |
| `INCOME_REQUIRES_SOURCE` | income must have an `income_source_id` |
| `INCOME_REQUIRES_ACCOUNT` | income must have an `account_id` |
| `INCOME_REJECTS_FROM` | income must NOT have `from_account_id` |
| `INCOME_REJECTS_CATEGORY` | income must NOT have `category_id` |
| `TRANSFER_REQUIRES_SOURCE` | transfer must have `from_account_id` |
| `TRANSFER_REQUIRES_DESTINATION` | transfer must have `to_account_id` |
| `TRANSFER_REJECTS_SAME_ACCOUNT` | transfer from != to |
| `TRANSFER_REJECTS_EXTRA_FIELDS` | transfer must NOT have `account_id`/`category_id`/`income_source_id` |
| `AMOUNT_POSITIVE` | amount > 0 |
| `AMOUNT_NOT_ZERO` | amount != 0 |
| `AMOUNT_INVALID` | amount/currency must form a valid `Money` value |
| `DATE_VALID` | date is a valid calendar date, not future-beyond-allowance |
| `TIMESTAMP_VALID` | `transaction_ts` is a valid ISO-8601 timestamp |
| `SOURCE_KNOWN` | `source` is one of `SHORTCUT`/`API`/`SYSTEM`/`IMPORT` |
| `TYPE_KNOWN` | `type` is `EXPENSE`/`INCOME`/`TRANSFER` |
| `CATEGORY_EXISTS` | `category_id` exists & active |
| `ACCOUNT_EXISTS` | `account_id` exists & active |
| `INCOME_SOURCE_EXISTS` | `income_source_id` exists & active |
| `CURRENCY_KNOWN` | currency in lookups |
| `UNKNOWN_FIELD_REJECTED` | reject unknown payload fields |
