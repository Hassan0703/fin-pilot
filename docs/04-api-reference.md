# FinPilot v0 — REST API Reference

> Backend: Google Apps Script web app. Base URL (after deploy):
> `https://script.google.com/macros/s/<DEPLOYMENT_ID>/exec`
>
> All requests are `POST` with a JSON body unless noted. iPhone Shortcuts can also use
> `GET` with query params for read-only actions. Responses are always JSON.
>
> **GET is enforced read-only.** Any mutating action (`*.create`, `*.void`,
> `settings.set`, `import`, `analytics.run`, `recurring.run`) received over GET is
> rejected with `405 METHOD_NOT_ALLOWED` before it can touch the workbook, so a link,
> image tag or browser prefetch can never trigger a write. Query strings also leak
> tokens into URL history/logs — prefer POST with the token in the JSON body.

---

## 1. Authentication

A static token stored in `settings.api_token_hash` (SHA-256). Apps Script web apps do
**not** expose request headers to `doGet`/`doPost`, so the token is passed in the body or
query string, never as a header:

- POST: `{ "action": "...", "token": "<api_token>", ... }`
- GET (read-only actions): `?action=health&token=<api_token>`

If `settings.api_token_hash` is empty the API is open (development only).

> Set the token with `AuthService.rotateToken("<12+-char secret>")` in the Apps Script
> editor (or via the `settings.set` API for every key except `api_token_hash`, which is
> deliberately rejected — see `docs/05-setup.md §4`).

---

## 2. Common Response Envelope

```json
{
  "ok": true,
  "data": { },
  "meta": {
    "request_id": "REQ_...",
    "ts": "2026-08-04T12:00:00.000Z",
    "duration_ms": 312,
    "api_version": "1.0.0"
  }
}
```

Errors:

```json
{
  "ok": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid payload",
    "details": [ { "rule": "EXPENSE_REQUIRES_CATEGORY", "message": "..." } ]
  },
  "meta": { ... }
}
```

---

## 3. Endpoints

### POST `/` — create a transaction

```
action: "transaction.create"
```

Body:

```json
{
  "action": "transaction.create",
  "type": "EXPENSE",
  "amount": 42.50,
  "currency": "USD",
  "account_id": "ACC_...",
  "category_id": "CAT_...",
  "merchant": "Grocery Store",
  "note": "weekly shop",
  "tags": ["groceries","food"],
  "date": "2026-08-04",
  "external_ref": "SHORTCUT-UUID-1234"
}
```

Type-specific required fields:

| type | required | forbidden |
|---|---|---|
| `EXPENSE` | `account_id`, `category_id` | `to_account_id`, `from_account_id`, `income_source_id` |
| `INCOME` | `account_id`, `income_source_id` | `from_account_id`, `to_account_id`, `category_id` |
| `TRANSFER` | `from_account_id`, `to_account_id` | `account_id`, `category_id`, `income_source_id` |

Response `data`:

```json
{
  "transaction_id": "TRX_0A1B2C3D4E5F6",
  "status": "POSTED",
  "duplicate": false
}
```

If a duplicate exists, the request still succeeds (HTTP 200) with `status` = `DUPLICATE_SKIPPED`,
`duplicate` = `true` and `duplicate_of` = the existing id — nothing is written. To force a
record anyway, pass `force: true`.

### POST `/` — list transactions

```
action: "transaction.list"
body: { "from": "2026-07-01", "to": "2026-07-31", "type": "EXPENSE",
        "category_id": "CAT_x", "limit": 50, "cursor": "..." }
```

### POST `/` — read one transaction

```
action: "transaction.get"  { "transaction_id": "TRX_..." }
```

### POST `/` — void a transaction

```
action: "transaction.void" { "transaction_id": "TRX_...", "reason": "..." }
```
Voiding sets `status=VOID` (a reversal record is not needed; void rows are excluded from
all derived metrics by filtering `status='POSTED'`). **Rows are never deleted.**

### POST `/` — accounts

```
action: "account.create" { "name": "Checking", "type": "BANK", "currency": "USD",
        "opening_balance": 0, "color": "#4285F4", "icon": "bank" }
action: "account.list"   { "status": "ACTIVE" }
action: "account.get"    { "account_id": "ACC_..." }
```

### POST `/` — categories & income sources

```
action: "category.create" { "name": "Groceries", "type": "EXPENSE",
        "parent_category_id": "CAT_...", "icon": "cart", "color": "#34A853" }
action: "category.list"   { "type": "EXPENSE" }
action: "income_source.create" { "name": "Freelance", "type": "FREELANCE" }
action: "income_source.list"
```

### POST `/` — budgets

```
action: "budget.create" { "category_id": "CAT_...", "period": "2026-08",
        "budget_amount": 600, "currency": "USD" }
action: "budget.list"   { "period": "2026-08" }
```

### POST `/` — goals

```
action: "goal.create" { "name": "Emergency Fund", "goal_type": "EMERGENCY_FUND",
        "target_amount": 6000, "currency": "USD", "linked_account_id": "ACC_...",
        "monthly_contribution": 250, "priority": "HIGH", "deadline": "2027-06-01" }
action: "goal.list"
```

### POST `/` — recurring rules

```
action: "recurring.create" { "name": "Netflix", "type": "EXPENSE", "amount": 15.99,
        "frequency": "MONTHLY", "day_of_month": 1, "account_id": "ACC_...",
        "category_id": "CAT_..." }
action: "recurring.list"
```

### POST `/` — dashboard / analytics

```
action: "dashboard.summary"         → KPIs for today's dashboard
action: "analytics.run"             → force regenerate monthly_analytics + score + roadmap
action: "analytics.status"
```

### POST `/` — configuration

```
action: "settings.get"   { "key": "base_currency" }   (omit key → all non-secret)
action: "settings.set"   { "key": "budget_alert_threshold", "value": "0.9" }
action: "lookups.list"   { "group": "currency" }
action: "health"         → ping, returns version + time + row counts
```

### POST `/` — audit

```
action: "audit.list"   { "limit": 100, "status": "FAILED" }
```

---

## 4. Error Codes

| code | meaning |
|---|---|
| `VALIDATION_ERROR` | one or more rules failed (see `details`) |
| `NOT_FOUND` | record does not exist |
| `AUTH_REQUIRED` | missing/invalid token |
| `METHOD_NOT_ALLOWED` | mutating action sent over GET (POST required) |
| `BAD_ACTION` | unknown action |
| `BAD_JSON` | malformed body |
| `SERVER_ERROR` | unexpected failure (generic message; stack logged server-side, error message in `audit_logs`) |

Duplicate detections are **not** an error: the request succeeds with `duplicate: true`
(see above).

### Security properties

- **Secrets never leave the API.** `settings.get` returns the value of every non-secret
  key, but secret keys (`is_secret`) are returned as `****`, whether requested by key or
  in the full listing. The raw `api_token_hash` is only readable by the Apps Script
  backend itself.
- **Formula injection is neutralized at the write boundary.** Any string value that
  begins with `=`, `+` or `@` is stored with a leading `'` so the Sheets service can
  never evaluate imported/API text as a formula. The same guard applies to CSV export
  (`csvCell`).
- **Import is bounded and fail-fast.** `import` accepts at most `MAX_IMPORT_ROWS` (1000)
  rows per request and rejects any non-object row with `VALIDATION_ERROR` *before* a
  single row is written — a malformed bulk payload can never leave a partial import.
- **All writes are serialized.** Mutating handlers run inside a script lock, so
  concurrent requests cannot interleave ledger/analytics writes.

---

## 5. Rate Limits & Size

- Apps Script quota: ~20k URL-fetch / 6h, 6 min execution. Sufficient for personal use.
- Keep payloads < 10 KB. Do not batch > 50 records per request.

---

## 6. Idempotency & Duplicate Detection

- **Hard duplicate:** same `external_ref` already exists → return existing record.
- **Soft duplicate:** within `duplicate_window_minutes` (default 2880 = 48h), a transaction
  with identical `amount|currency|type|account(s)|category|date` AND matching
  `merchant`/`note` fuzzy hash is flagged. Response sets `duplicate:true` unless
  `force:true` is passed.

---

## 7. Example cURL

```bash
curl -X POST 'https://script.google.com/macros/s/DEPLOY_ID/exec' \
  -H 'Content-Type: application/json' \
  -d '{"action":"transaction.create","token":"<token>","type":"EXPENSE","amount":42.5,
       "currency":"USD","account_id":"ACC_x","category_id":"CAT_y",
       "merchant":"Groceries","date":"2026-08-04","external_ref":"cb-1"}'
```

Apps Script web apps cannot read HTTP headers, so the token travels in the JSON body
(omit it entirely while the API is open in development, i.e. empty `api_token_hash`).
