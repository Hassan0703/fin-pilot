# FinPilot v0 — Formula System

> Every report, balance, KPI and chart is formula-driven. No manual calculation, ever.
> Formulas read from the tables and render on the Dashboard / derived columns.
> **Authoritative implementation:** `apps-script/FormattingService.gs` (`applyDerivedFormulas`,
> plus the per-row `applyAccountFormula` / `applyGoalFormulas` used on every create)
> and `apps-script/DashboardService.gs` (`buildLayout`, `installCharts` — which removes
> previously installed charts before inserting, so re-runs never stack duplicates).
> The snippets below are the design rationale, not the live formulas.

---

## 1. Derived Account Balance (accounts.current_balance)

**Income/Expense** moves an account, **Transfer** moves value between two accounts.

```
accounts!F2 (current_balance) =
  opening_balance
  + IN to account        (INCOME into account_id)      + TRANSFER to_account_id
  - OUT of account       (EXPENSE from account_id)     - TRANSFER from_account_id
```

**Accounts columns:** col A=account_id, col E=opening_balance, col F=current_balance.
**Transactions columns:** col C=date, col D=type, col E=amount, col G=account_id,
col H=from_account_id, col I=to_account_id, col P=status.

The authoritative formula lives in `FormattingService.applyDerivedFormulas()`:

```
accounts!F2 =
=IF(ISNUMBER($E2),
    $E2
    + SUMPRODUCT((transactions!$P$2:$P="POSTED")*((transactions!$G$2:$G=$A2)*(transactions!$D$2:$D="INCOME")
     +(transactions!$I$2:$I=$A2)*(transactions!$D$2:$D="TRANSFER"))*transactions!$E$2:$E)
    - SUMPRODUCT((transactions!$P$2:$P="POSTED")*((transactions!$G$2:$G=$A2)*(transactions!$D$2:$D="EXPENSE")
     +(transactions!$H$2:$H=$A2)*(transactions!$D$2:$D="TRANSFER"))*transactions!$E$2:$E),
    "")
```

Income adds to `account_id`, expense subtracts from `account_id`, a transfer subtracts from
`from_account_id` and adds to `to_account_id`; only `POSTED` rows count. This is the same
semantics as the SQL view `FinPilot.v_balances` in `sql/schema_postgres.sql`.

---

## 2. Monthly Metrics (period rollups)

All read `transactions.date`, bucket by `YYYY-MM` via `TEXT(date,"YYYY-MM")`.

```
INCOME(period)      = SUMIFS(transactions.amount, transactions.type,"INCOME",   TEXT(date,"YYYY-MM"), period)
EXPENSE(period)     = SUMIFS(transactions.amount, transactions.type,"EXPENSE",  TEXT(date,"YYYY-MM"), period)
SAVINGS(period)     = INCOME - EXPENSE
SAVINGS_RATE        = SAVINGS / INCOME
CASH_FLOW          = SUM of (income - expense) over trailing N months
BURN_RATE          = avg monthly expense over trailing 3 months
AVG_DAILY_SPEND    = EXPENSE(period) / DAY(EOMONTH(period,0))
```

Examples (period in cell P1):

```
=SUMIFS(transactions!$E:$E, transactions!$D:$D, "INCOME",  transactions!$C:$C, ">="&DATEVALUE(P1&"-01"), transactions!$C:$C, "<="&EOMONTH(DATEVALUE(P1&"-01"),0))
=SUMIFS(transactions!$E:$E, transactions!$D:$D, "EXPENSE", transactions!$C:$C, ">="&DATEVALUE(P1&"-01"), transactions!$C:$C, "<="&EOMONTH(DATEVALUE(P1&"-01"),0))
```

Better: build a `period` helper column in transactions (`=TEXT($C2,"YYYY-MM")`) and use
`SUMIFS(amount, period, P1, type, "EXPENSE")`. This is the **recommended** approach.

---

## 3. Category Analysis (top spend)

```
=QUERY(transactions, 
 "SELECT L, SUM(E) WHERE D='EXPENSE' AND L IS NOT NULL 
  GROUP BY L ORDER BY SUM(E) DESC LIMIT 10 LABEL SUM(E) ''", 1)
```
Where L = category_id (join label via CATEGORY lookup) and E = amount.

---

## 4. Budget Engine

```
effective_budget(cat, period) = 
  IFERROR(VLOOKUP(cat, budgets[category_id,period,amount], 3, 0), 
          VLOOKUP(cat, categories[category_id,monthly_budget], 2, 0))

used(cat, period) = SUMIFS(transactions.amount, category_id, cat, period, period, type, "EXPENSE")
remaining        = effective_budget - used
pct_used         = used / effective_budget
warning          = IF(pct_used >= settings.budget_alert_threshold, "OVER", IF(pct_used >= 0.8, "WARN", "OK"))
```

---

## 5. Goal Engine

```
current(goal)  = SUMIFS(transactions.amount, transactions.to_account_id, goal.linked_account_id)
                 - account.opening_balance(linked_account)   // fund growth only
progress       = current / target_amount
months_needed  = CEILING((target - current) / monthly_contribution)
projected      = EDATE(TODAY(), months_needed)              // deadline for screen
```

---

## 6. Financial Score

Score per metric, then weighted total:

```
score_m = MIN(100, ROUND(100 * current / target))            // higher-is-better
score_m = MAX(0, ROUND(100 * target / current))              // lower-is-better (burn rate)
overall = SUMPRODUCT(score_m, weight) / SUM(weight)
status  = IF(score_m >= 80,"ON_TRACK", IF(score_m >= 50,"WARNING","FAIL"))
```

---

## 7. Roadmap Progress

Each stage defines a requirement computed from live metrics:

```
SURVIVAL        income > expense (last 90d)
EMERGENCY_FUND  emergency_fund_months >= 1        → 3
DEBT_FREE       loans balance = 0
STABLE          savings_rate >= 10%
GROWTH          net_worth growth 6m positive
INVESTMENT      invested % of net worth >= 25%
FINANCIAL_FREEDOM  passive_income / expenses >= 100%
progress = MIN(100, current_metric / required_metric * 100)
```

---

## 8. Dashboard layout (recommended)

```
        ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐
        │ Net     │ │ Income  │ │ Expense │ │ Savings │ │ Burn    │
        │ Worth   │ │ (month) │ │ (month) │ │ Rate    │ │ Rate    │
        └─────────┘ └─────────┘ └─────────┘ └─────────┘ └─────────┘
  Row: monthly income/expense bar chart        Row: category donut
  Row: goal progress bars                      Row: budget progress bars + warnings
  Row: recent transactions (QUERY last 8)      Row: roadmap stepper + warnings
```

KPI formulas (cell C5 = Net Worth):
```
=SUM(accounts!F:F)                       -- sum of current_balance column
=SUMIFS(transactions.amount,type,"INCOME",period, curPeriod)    -- income
=SUMIFS(transactions.amount,type,"EXPENSE",period,curPeriod)   -- expense
=IFERROR(income/expense)                 -- savings rate
=AVERAGE(last 3 months expense)          -- burn rate
```

Warnings column (text cell, conditional format turns red):
```
=IF(pct_used >= threshold, "Budget overrun: "&category, "")
=IF(emergency_fund_months < 3, "Emergency fund below 3 months", "")
=IF(no expense category recorded this week, "Missing categories", "")
```

---

## 9. Charts

- **Monthly Income vs Expense** — stacked column over `monthly_analytics` (INCOME, EXPENSE rows).
- **Spending by Category** — pie/donut over category query.
- **Net Worth Trend** — line over `monthly_analytics` NET_WORTH rows.
- **Budget progress** — bar over budget remaining.

All charts reference ranges produced by formulas/QUERY so they update on data change.
