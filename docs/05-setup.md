# FinPilot v0 — Setup Guide

> 15 minutes, no code editor required. Everything is configured through the API.

## Prerequisites

- A Google account (personal Google Drive).
- The Google Sheets workbook created from this project (or an empty spreadsheet).

## 1. Create the workbook

Open Google Sheets → New spreadsheet. Name it **FinPilot**. (You can keep it
private; the API is the only entry point.)

## 2. Attach the Apps Script backend

1. In the spreadsheet: **Extensions → Apps Script**.
2. Name the project `FinPilot`.
3. Create one `.gs` file per file in [`apps-script/`](../apps-script) and paste the
   contents. Keep the file names:
   - `Code.gs`
   - `Repository.gs`
   - `ValueObjects.gs`
   - `IdGenerator.gs`
   - `AuthService.gs`
   - `AuditService.gs`
   - `SettingsService.gs`
   - `LookupService.gs`
   - `ValidationService.gs`
   - `DuplicateDetectionService.gs`
   - `TransactionService.gs`
   - `MasterDataServices.gs`
   - `AnalyticsService.gs`
   - `SchemaService.gs`
   - `FormattingService.gs`
   - `DashboardService.gs`
   - `Triggers.gs`
4. Also add `appsscript.json` (replace the default one): **Project Settings →
   Show "appsscript.json" manifest file**, paste the JSON.

## 3. Initialize the workbook

1. Reload the spreadsheet.
2. You should see a **FinPilot** menu. Click **FinPilot → Initialize Workbook**.
3. Authorize the requested scopes (read/write your spreadsheet + scripts).
4. The bootstrap creates every table sheet, seeds lookups/settings/validation
   rules, builds the Dashboard with charts, installs triggers, and runs analytics.

> **Checkpoint:** the `dashboard`, `transactions`, `accounts`, `categories`, `income_sources`,
> `budgets`, `goals`, `recurring`, `monthly_analytics`, `financial_score`,
> `roadmap`, `settings`, `audit_logs`, `lookups`, `validation_rules` tabs exist.

## 4. Deploy the web app (the REST API)

1. **Deploy → New deployment → Web app.**
2. Execute as: **Me** · Access: **Anyone** (the API token gates requests).
3. Copy the `/exec` URL — this is your `FinPilot_API_URL`.
4. Optional but **recommended**: set an API token (12+ chars).
   The API deliberately rejects `settings.set` for the key `api_token_hash`; the only path
   is `AuthService.rotateToken`, which hashes the token server-side:
   - Call `health` first to confirm connectivity:
     ```
     GET <FinPilot_API_URL>?action=health
     ```
   - Open **Extensions → Apps Script**, and in the editor console run:
     ```
     AuthService.rotateToken("your-long-secret")
     ```
   - The SHA-256 hash is stored in `settings.api_token_hash`; the raw token never touches
     the workbook. From now on every request must include `"token":"your-long-secret"` in
     the POST body or `?token=...` for GET. When the hash is empty the API stays open
     (development only).

## 5. Create your first data through the API

```
POST <FinPilot_API_URL>
{
  "action": "category.create",
  "name": "Groceries", "type": "EXPENSE", "color": "#34A853"
}
```
Then:
```
{
  "action": "account.create",
  "name": "Main Bank", "type": "BANK", "currency": "USD", "opening_balance": 500
}
```
Then log a transaction:
```
{
  "action": "transaction.create",
  "type": "EXPENSE", "amount": 42.50, "currency": "USD",
  "account_id": "<account_id from above>",
  "category_id": "<category_id from above>",
  "merchant": "Grocery Store", "external_ref": "setup-test-1"
}
```

## 6. Test the whole system

| Test | Expected |
|---|---|
| `?action=health` | `{"ok":true,"data":{"status":"ok",...}}` |
| `transaction.create` valid expense | 200, `duplicate:false` |
| Re-send same `external_ref` | 200, `duplicate:true`, nothing written |
| `transaction.create` with bad category | 400, `details` lists rules |
| `dashboard.summary` | KPIs as numbers |
| `analytics.run` | regenerates all derived sheets |

## 7. Install iPhone Shortcuts

See [`docs/06-shortcuts.md`](06-shortcuts.md) for the JSON templates.

## 8. What not to do

- Never type into the workbook manually (except configuration tables if you must).
- Never delete rows in `transactions` or `audit_logs` — use `transaction.void`.
- Never hardcode values in formulas — always reference the tables or `settings`.

## Troubleshooting

- **"Exception: Cannot resolve database spreadsheet"** — the script isn't bound.
  Bind it (Extensions → Apps Script inside the spreadsheet) or set
  `settings.database_id` to your spreadsheet id.
- **401 on every request** — token mismatch; the hash must be the SHA-256 of the
  token you send. Reset it via `AuthService.rotateToken`.
- **Dashboard empty** — run **FinPilot → Initialize Workbook** again (idempotent).
- **Analytics stale** — run `?action=analytics.run` or wait for the Sunday trigger.
