# FinPilot v0 — System Architecture

> **Status:** v0.1 — Production-ready workbook + Apps Script backend
> **Backend:** Google Apps Script (REST API)
> **Database:** Google Sheets (single source of truth)
> **Migration target:** PostgreSQL / Supabase / ERPNext-Frappe / Firebase

---

## 1. Design Philosophy

FinPilot is **not a spreadsheet** — it is a relational database rendered in Google Sheets,
with a serverless REST backend (Apps Script) and a reporting layer (Dashboard).

The workbook is treated as a **storage engine**, not a calculation engine.
All business logic lives in **Apps Script services** (the backend).
All human entry happens through **iPhone Shortcuts** hitting the REST API.

Three non-negotiable rules:

1. **Single Source of Truth** — exactly ONE transaction ledger (`transactions`).
   Every balance, KPI, chart, budget and goal derives from it. Nothing is duplicated.
2. **Database Thinking** — every sheet is a table, every row a record, every column a field.
   Relationships are made with **IDs**, never names or values.
3. **No Manual Calculations** — the dashboard, budgets, goals, score and roadmap
   recompute automatically via formulas + scheduled analytics.

---

## 2. Domain-Driven Design Map

The system is modelled as a set of **aggregates**, each with its own **repository** (Sheet) and **service**.

```
┌──────────────────────────────  FinPilot Domain Model  ──────────────────────────────┐
│                                                                                       │
│  AGGREGATE          ENTITIES                  VALUE OBJECTS          SERVICES        │
│  ───────────────────────────────────────────────────────────────────────────────────  │
│  Ledger            Transaction               Money{amount,currency}  TransactionSvc │
│                   (root aggregate)          Date, Timestamp          ValidationSvc  │
│                    TransactionID            TransactionStatus        DuplicateSvc   │
│                                                                      IdGenerator    │
│  Accounting        Account                  Currency, AccountType   AccountSvc      │
│                   (AccountID)              AccountStatus            BalanceEngine   │
│                                                                                      │
│  Classification    Category                 CategoryType            CategorySvc     │
│                   (CategoryID)             Icon, Color                             │
│                    IncomeSource                                                     │
│                   (IncomeSourceID)                                                   │
│  Budgeting         Budget                   MonthPeriod             BudgetSvc       │
│                                                                      BudgetEngine   │
│  Goals             Goal                     Money, Priority,        GoalSvc         │
│                                                                      GoalEngine     │
│  Recurrence        RecurringRule            Frequency, MonthPeriod  RecurringSvc    │
│  Scoring           ScoreMetric              Score                   ScoreSvc        │
│  Journey           RoadmapStage             StageStatus             RoadmapSvc      │
│  Configuration     Setting                  ValueObject<string>     SettingsSvc     │
│  Audit             AuditLog                 RequestID, Status       AuditSvc        │
│                                                                                      │
│  (cross-cutting)   LookupEntry (type-discriminated dictionary)     LookupSvc        │
│                    ValidationRule (business rule repository)                         │
└───────────────────────────────────────────────────────────────────────────────────────┘
```

**Tactical DDD rules applied:**

- Aggregates are only mutated through their **service** (Application layer). No raw sheet writes from UI.
- **ID references, not names.** `transactions.account_id → accounts.account_id`.
- **Value objects are validated on construction.** Money is never negative; currency is ISO-4217.
- **Invariants live in the aggregate root** (Transaction) and are enforced by `ValidationService`
  before any write (see Validation Rules sheet).
- **Side effects** (audit log, dashboard refresh, analytics) are domain events emitted by services.

---

## 3. Layered Architecture

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│  PRESENTATION      iPhone Shortcuts ── HTTP ──► Google Apps Script Web App     │
│  ──────────────────────────────────────────────────────────────────────────────── │
│  APPLICATION       doPost()/doGet()  →  ApiRouter  →  Service layer            │
│  (backend)         TransactionService, AccountService, BudgetService, ...       │
│  ──────────────────────────────────────────────────────────────────────────────── │
│  DOMAIN            ValidationService, DuplicateDetectionService,                │
│  (business rules)  IdGenerator, Money/Period value objects, invariants          │
│  ──────────────────────────────────────────────────────────────────────────────── │
│  INFRASTRUCTURE    SheetRepository (persistence adapter), AuditService,         │
│  (storage)         SettingsService, LookupService, cache                       │
│  ──────────────────────────────────────────────────────────────────────────────── │
│  REPORTING         Google Sheets formulas, charts, conditional formatting,     │
│  (derived data)    Dashboard, Monthly Analytics, Financial Score, Roadmap       │
└─────────────────────────────────────────────────────────────────────────────────┘
```

**Dependency rule:** Presentation → Application → Domain → Infrastructure.
Reporting never writes; it only reads.

---

## 4. Table Map (Sheet = Table)

| # | Sheet | Role | Kind |
|---|-------|------|------|
| 1 | `dashboard` | Executive summary | Reporting (view) |
| 2 | `transactions` | Single source of truth ledger | **Core table** |
| 3 | `accounts` | Account master | Master data |
| 4 | `categories` | Expense/Income categories (hierarchical) | Master data |
| 5 | `income_sources` | Income source master | Master data |
| 6 | `budgets` | Monthly category budgets | Master data |
| 7 | `goals` | Financial goals | Master data |
| 8 | `recurring` | Recurring rule engine | Master data |
| 9 | `monthly_analytics` | Generated period metrics (OLAP-ish) | Generated data |
| 10 | `financial_score` | Scoring engine | Generated data |
| 11 | `roadmap` | Financial progression engine | Generated data |
| 12 | `settings` | Config key/value | Configuration |
| 13 | `audit_logs` | API request log | Logging |
| 14 | `lookups` | Dictionaries (types, currencies, colors…) | Master data |
| 15 | `validation_rules` | Business rule repository | Configuration |

---

## 5. Entity Relationships

```
accounts ──┐
categories ─┤        ┌────────────────┐
income_sources ──────►   transactions  │◄───  lookups (currency, type, status)
            │        └────────────────┘        └──────────────────┐
            └────► budgets ──category_id                          │
             │     goals ──linked_account_id                      │
             │     recurring ──account/category/income_source_id   │
             │     monthly_analytics (metrics)                     │
             │     financial_score (metrics)                       │
             │     roadmap (recommendations)                       │
             └────► audit_logs (record_id)                         │
                        validation_rules (entity, rule_code) ──────┘
```

All relationships are **one-way ID references** (foreign-key style). No joins at the sheet
level; joins happen in Apps Script or in the future SQL engine.

---

## 6. Data Flow

```
 iPhone Shortcut
   │  HTTP POST (JSON)
   ▼
 Google Apps Script Web App (doPost)
   │
   ├─► ApiRouter — authenticate (token from settings) , parse JSON
   ├─► ValidationService — structural + business rules (from validation_rules)
   │      - type-specific required fields
   │      - unknown IDs rejected (account/category/income_source)
   │      - amount > 0, valid date, currency in lookups
   ├─► DuplicateDetectionService — near-duplicate within configured window
   │      - fingerprint: amount|currency|account|category|date-bucket|note-hash
   ├─► IdGenerator — TransactionID (time-sortable, collision-free)
   ├─► SheetRepository.append — write to transactions table
   ├─► AuditService — append audit_logs row (status, payload hash, result)
   └─► EventBus — emit TRANSACTION_CREATED → refresh caches → dashboard updates
                 (formulas update automatically; triggers handle analytics)
   │
   ▼
 JSON response → Shortcut shows result to user
```

**Idempotency contract:** clients may send `external_ref` (e.g. shortcut-generated UUID).
If a transaction with the same `external_ref` exists, the API returns `duplicate:true`
with the existing record — never double-books.

---

## 7. Separation of Responsibilities

| Concern | Owner |
|---------|-------|
| Input | iPhone Shortcuts → REST API only |
| Processing | Apps Script services (transaction lifecycle) |
| Configuration | `settings`, `lookups`, `validation_rules` |
| Master data | `accounts`, `categories`, `income_sources`, `budgets`, `goals`, `recurring` |
| Analytics | `monthly_analytics`, `financial_score`, `roadmap` (generated) |
| Reporting | `dashboard` (formulas + charts, read-only) |
| Validation | `validation_rules` + `ValidationService` + sheet data validation |
| Logging | `audit_logs` |
| Cleanup | Archive (manual, gated by status ≠ never delete rows) |

---

## 8. Naming & Extension Conventions

- Sheets: `snake_case`, singular table names.
- Columns: `snake_case`, always an ID column named `<entity>_id` for the PK.
- Enums are stored as UPPER_SNAKE codes (`EXPENSE`, `MONTHLY`) and defined in `lookups`.
- IDs: `<PREFIX>_<BASE32TIME><RANDOM>` — `TRX_`, `ACC_`, `CAT_`, `SRC_`, `BUD_`, `GOL_`,
  `REC_`, `ANA_`, `AUD_`, `LKP_`, `RUL_`, `STG_`, `REQ_`.
- Adding a field = adding a column (with header) and a validator; no downstream edits needed.
- Adding an entity type = adding a `lookups` row (e.g. new account type) — no code change.
- **Extension strategy:** services are separated per aggregate; to add a domain event just
  add a subscriber in `EventBus`. To migrate to SQL, swap `SheetRepository` for a Postgres
  adapter — the domain layer is unchanged (see `07-migration.md`).

---

## 9. Versioning

- `settings` stores `schema_version` and `api_version`.
- Schema bootstrap is idempotent: it creates missing tables/columns and never destroys data.
- Analytics/score/roadmap runs are timestamped (`generated_at`) and append-only per period.
