-- ============================================================================
-- FinPilot v0 — PostgreSQL schema (migration target)
--
-- Mirrors the Google Sheets schema 1:1 so data can be ported without transforms.
-- Add an `owner_id` column (uuid) and RLS policies when going multi-tenant.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE SCHEMA IF NOT EXISTS FinPilot;

CREATE TABLE FinPilot.users (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email        TEXT UNIQUE NOT NULL,
  display_name TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- enums (mirror lookups) ------------------------------------------
CREATE TYPE FinPilot.transaction_type AS ENUM ('EXPENSE','INCOME','TRANSFER');
CREATE TYPE FinPilot.tx_status      AS ENUM ('PENDING','POSTED','VOID','REJECTED','DUPLICATE_SKIPPED');
CREATE TYPE FinPilot.record_status  AS ENUM ('ACTIVE','INACTIVE','ARCHIVED','COMPLETED','PAUSED');
CREATE TYPE FinPilot.account_type   AS ENUM ('CASH','BANK','WALLET','SAVINGS','INVESTMENT','BUSINESS','CREDIT_CARD','LOAN','CRYPTO');
CREATE TYPE FinPilot.source_channel AS ENUM ('SHORTCUT','API','SYSTEM','IMPORT');
CREATE TYPE FinPilot.severity       AS ENUM ('ERROR','WARN');

-- ---------- transactions ------------------------------------------------------
CREATE TABLE FinPilot.transactions (
  transaction_id   TEXT PRIMARY KEY,            -- TRX_<base32>
  owner_id         UUID REFERENCES FinPilot.users(id),
  transaction_ts   TIMESTAMPTZ NOT NULL DEFAULT now(),
  date             DATE NOT NULL,
  type             FinPilot.transaction_type NOT NULL,
  amount           NUMERIC(18,4) NOT NULL CHECK (amount > 0),
  currency         CHAR(3) NOT NULL,
  account_id       TEXT REFERENCES FinPilot.accounts(account_id),
  from_account_id  TEXT REFERENCES FinPilot.accounts(account_id),
  to_account_id    TEXT REFERENCES FinPilot.accounts(account_id),
  category_id      TEXT REFERENCES FinPilot.categories(category_id),
  income_source_id TEXT REFERENCES FinPilot.income_sources(income_source_id),
  merchant         TEXT,
  note             TEXT,
  tags             TEXT[],
  external_ref     TEXT,
  status           FinPilot.tx_status NOT NULL DEFAULT 'POSTED',
  source           FinPilot.source_channel NOT NULL DEFAULT 'API',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ,
  CONSTRAINT chk_amount_positive   CHECK (amount > 0),
  CONSTRAINT chk_currency          CHECK (currency ~ '^[A-Z]{3}$'),
  -- accounting integrity: expense needs account, income needs account, transfer needs both
  CONSTRAINT chk_type_consistent CHECK (
    (type = 'EXPENSE'  AND account_id IS NOT NULL AND category_id IS NOT NULL AND to_account_id IS NULL AND from_account_id IS NULL) OR
    (type = 'INCOME'   AND account_id IS NOT NULL AND income_source_id IS NOT NULL AND to_account_id IS NULL AND from_account_id IS NULL) OR
    (type = 'TRANSFER' AND from_account_id IS NOT NULL AND to_account_id IS NOT NULL AND from_account_id <> to_account_id AND account_id IS NULL)
  )
);
CREATE INDEX idx_tx_date        ON FinPilot.transactions (date);
CREATE INDEX idx_tx_account     ON FinPilot.transactions (account_id);
CREATE INDEX idx_tx_category    ON FinPilot.transactions (category_id);
CREATE INDEX idx_tx_status      ON FinPilot.transactions (status);
CREATE UNIQUE INDEX idx_tx_extref ON FinPilot.transactions (owner_id, external_ref)
  WHERE external_ref IS NOT NULL;

-- ---------- accounts ---------------------------------------------------------
CREATE TABLE FinPilot.accounts (
  account_id      TEXT PRIMARY KEY,
  owner_id        UUID REFERENCES FinPilot.users(id),
  name            TEXT NOT NULL,
  type            FinPilot.account_type NOT NULL,
  currency        CHAR(3) NOT NULL,
  opening_balance NUMERIC(18,4) NOT NULL DEFAULT 0,
  current_balance NUMERIC(18,4) NOT NULL DEFAULT 0,  -- derived; see v_balances
  color           TEXT,
  icon            TEXT,
  status          FinPilot.record_status NOT NULL DEFAULT 'ACTIVE',
  is_credit       BOOLEAN NOT NULL DEFAULT FALSE,
  note            TEXT,
  created_date    DATE NOT NULL DEFAULT CURRENT_DATE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- categories (hierarchical) ---------------------------------------
CREATE TABLE FinPilot.categories (
  category_id       TEXT PRIMARY KEY,
  owner_id          UUID REFERENCES FinPilot.users(id),
  parent_category_id TEXT REFERENCES FinPilot.categories(category_id),
  name              TEXT NOT NULL,
  type              FinPilot.transaction_type NOT NULL,
  icon              TEXT,
  color             TEXT,
  monthly_budget    NUMERIC(18,4),
  sort_order        INT NOT NULL DEFAULT 0,
  status            FinPilot.record_status NOT NULL DEFAULT 'ACTIVE',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- income sources ---------------------------------------------------
CREATE TABLE FinPilot.income_sources (
  income_source_id TEXT PRIMARY KEY,
  owner_id         UUID REFERENCES FinPilot.users(id),
  name             TEXT NOT NULL,
  type             TEXT NOT NULL,
  icon             TEXT,
  color            TEXT,
  sort_order       INT NOT NULL DEFAULT 0,
  status           FinPilot.record_status NOT NULL DEFAULT 'ACTIVE',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- budgets ----------------------------------------------------------
CREATE TABLE FinPilot.budgets (
  budget_id     TEXT PRIMARY KEY,
  owner_id      UUID REFERENCES FinPilot.users(id),
  category_id   TEXT NOT NULL REFERENCES FinPilot.categories(category_id),
  period        TEXT NOT NULL,                -- 'YYYY-MM'
  budget_amount NUMERIC(18,4) NOT NULL CHECK (budget_amount > 0),
  currency      CHAR(3) NOT NULL,
  status        FinPilot.record_status NOT NULL DEFAULT 'ACTIVE',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_budget_category_period UNIQUE (category_id, period)
);

-- ---------- goals ------------------------------------------------------------
CREATE TABLE FinPilot.goals (
  goal_id             TEXT PRIMARY KEY,
  owner_id            UUID REFERENCES FinPilot.users(id),
  name                TEXT NOT NULL,
  goal_type           TEXT NOT NULL,
  target_amount       NUMERIC(18,4) NOT NULL CHECK (target_amount > 0),
  currency            CHAR(3) NOT NULL,
  linked_account_id   TEXT REFERENCES FinPilot.accounts(account_id),
  current_amount      NUMERIC(18,4),           -- view-derived from linked account
  deadline            DATE,
  priority            TEXT NOT NULL DEFAULT 'MEDIUM',
  monthly_contribution NUMERIC(18,4) NOT NULL DEFAULT 0,
  projected_completion DATE,                   -- view-derived
  status              FinPilot.record_status NOT NULL DEFAULT 'ACTIVE',
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- recurring --------------------------------------------------------
CREATE TABLE FinPilot.recurring (
  recurring_id     TEXT PRIMARY KEY,
  owner_id         UUID REFERENCES FinPilot.users(id),
  name             TEXT NOT NULL,
  type             FinPilot.transaction_type NOT NULL,
  amount           NUMERIC(18,4) NOT NULL CHECK (amount > 0),
  currency         CHAR(3) NOT NULL,
  frequency        TEXT NOT NULL CHECK (frequency IN ('DAILY','WEEKLY','MONTHLY','QUARTERLY','YEARLY')),
  day_of_month     INT,
  day_of_week      INT,
  start_date       DATE NOT NULL,
  end_date         DATE,
  next_run         DATE,
  last_run         DATE,
  account_id       TEXT REFERENCES FinPilot.accounts(account_id),
  from_account_id  TEXT REFERENCES FinPilot.accounts(account_id),
  to_account_id    TEXT REFERENCES FinPilot.accounts(account_id),
  category_id      TEXT REFERENCES FinPilot.categories(category_id),
  income_source_id TEXT REFERENCES FinPilot.income_sources(income_source_id),
  status           FinPilot.record_status NOT NULL DEFAULT 'ACTIVE',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- monthly analytics (facts) ---------------------------------------
CREATE TABLE FinPilot.monthly_analytics (
  analytics_id  TEXT PRIMARY KEY,
  owner_id      UUID REFERENCES FinPilot.users(id),
  period        TEXT NOT NULL,
  metric        TEXT NOT NULL,
  dimension     TEXT,
  rank          INT,
  value         NUMERIC(18,4) NOT NULL,
  generated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_ana_period ON FinPilot.monthly_analytics (period);

-- ---------- financial score --------------------------------------------------
CREATE TABLE FinPilot.financial_score (
  metric_code   TEXT PRIMARY KEY,
  owner_id      UUID REFERENCES FinPilot.users(id),
  metric_name   TEXT NOT NULL,
  weight        NUMERIC(5,2) NOT NULL,
  current_value NUMERIC(18,4),
  target_value  NUMERIC(18,4),
  score         NUMERIC(5,2),
  status        TEXT,
  remarks       TEXT,
  updated_at    TIMESTAMPTZ
);

-- ---------- roadmap ----------------------------------------------------------
CREATE TABLE FinPilot.roadmap (
  stage_id        TEXT PRIMARY KEY,
  owner_id        UUID REFERENCES FinPilot.users(id),
  stage_order     INT NOT NULL,
  stage_name      TEXT NOT NULL,
  description     TEXT,
  requirement_rule TEXT,
  status          TEXT,
  progress        NUMERIC(5,2),
  recommendation  TEXT,
  achieved_date   DATE,
  updated_at      TIMESTAMPTZ
);

-- ---------- settings / lookups / validation rules ----------------------------
CREATE TABLE FinPilot.app_settings (
  key          TEXT PRIMARY KEY,
  owner_id     UUID REFERENCES FinPilot.users(id),
  value        TEXT,
  value_type   TEXT,
  description  TEXT,
  is_secret    BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at   TIMESTAMPTZ
);

CREATE TABLE FinPilot.lookups (
  lookup_id     TEXT PRIMARY KEY,
  lookup_group  TEXT NOT NULL,
  code          TEXT NOT NULL,
  label         TEXT NOT NULL,
  display_order INT NOT NULL DEFAULT 0,
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  meta          JSONB,
  CONSTRAINT uq_lookup_group_code UNIQUE (lookup_group, code)
);

CREATE TABLE FinPilot.validation_rules (
  rule_id      TEXT PRIMARY KEY,
  entity       TEXT NOT NULL,
  rule_code    TEXT NOT NULL,
  severity     FinPilot.severity NOT NULL,
  description  TEXT,
  applies_when JSONB,
  params_json  JSONB,
  is_active    BOOLEAN NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ,
  CONSTRAINT uq_rule_code UNIQUE (rule_code)
);

-- ---------- audit ------------------------------------------------------------
CREATE TABLE FinPilot.audit_logs (
  audit_id     TEXT PRIMARY KEY,
  owner_id     UUID REFERENCES FinPilot.users(id),
  ts           TIMESTAMPTZ NOT NULL DEFAULT now(),
  request_id   TEXT,
  endpoint     TEXT,
  method       TEXT,
  client       TEXT,
  payload_hash TEXT,
  status       TEXT,
  response_code INT,
  error        TEXT,
  record_id    TEXT,
  duplicate_of TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_audit_ts ON FinPilot.audit_logs (ts);

-- ============================================================================
-- Views: derived dashboard outputs (the Sheet formulas, expressed in SQL)
-- ============================================================================
CREATE VIEW FinPilot.v_balances AS
SELECT a.account_id, a.name, a.type, a.currency, a.opening_balance,
       a.opening_balance + COALESCE(b.delta, 0) AS current_balance
FROM FinPilot.accounts a
LEFT JOIN LATERAL (
  SELECT SUM(CASE
    WHEN t.type = 'INCOME'   AND t.account_id       = a.account_id THEN  t.amount
    WHEN t.type = 'EXPENSE'  AND t.account_id       = a.account_id THEN -t.amount
    WHEN t.type = 'TRANSFER' AND t.to_account_id    = a.account_id THEN  t.amount
    WHEN t.type = 'TRANSFER' AND t.from_account_id  = a.account_id THEN -t.amount
    ELSE 0 END) AS delta
  FROM FinPilot.transactions t
  WHERE t.status = 'POSTED'
) b ON TRUE
WHERE a.status = 'ACTIVE';

CREATE VIEW FinPilot.v_monthly AS
SELECT date_trunc('month', t.date)::date AS period,
       t.type,
       SUM(t.amount) AS total
FROM FinPilot.transactions t
WHERE t.status = 'POSTED'
GROUP BY 1, 2;

CREATE VIEW FinPilot.v_net_worth AS
SELECT date_trunc('month', CURRENT_DATE)::date AS period,
       SUM(a.opening_balance + COALESCE(b.delta, 0)) AS net_worth
FROM FinPilot.accounts a
LEFT JOIN LATERAL (
  SELECT SUM(CASE
    WHEN t.type = 'INCOME'   AND t.account_id       = a.account_id THEN  t.amount
    WHEN t.type = 'EXPENSE'  AND t.account_id       = a.account_id THEN -t.amount
    WHEN t.type = 'TRANSFER' AND t.to_account_id    = a.account_id THEN  t.amount
    WHEN t.type = 'TRANSFER' AND t.from_account_id  = a.account_id THEN -t.amount
    ELSE 0 END) AS delta
  FROM FinPilot.transactions t
  WHERE t.status = 'POSTED'
    AND t.date <= date_trunc('month', CURRENT_DATE)
) b ON TRUE
WHERE a.status = 'ACTIVE';
