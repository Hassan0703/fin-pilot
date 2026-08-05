# FinPilot v0 — iPhone Shortcuts Integration

> Users never type into the workbook. They tap a Shortcut; the Shortcut POSTs to the API.

---

## 1. How it works

1. In the Shortcuts app create a new shortcut with a **"Get Contents of URL"** action.
2. Set method **POST**, URL = web app URL, header `Content-Type: application/json`.
   Include `"token": "<your api token>"` inside the JSON body (Apps Script web apps
   cannot read request headers, so the token travels in the body or query string).
3. Body: JSON text (see templates below). Use **"Dictionary"** actions so you can prompt
   the user for amount / category / account at runtime.
4. Parse the JSON response and show a friendly notification.

## 2. Get your web app URL

Apps Script → Deploy → New deployment → **Web app** →
Execute as: **Me**, Access: **Anyone** → copy the `/exec` URL.

## 3. Security recommendation

Lock the API with a token: in the Apps Script editor run
`AuthService.rotateToken("<12+-char secret>")` once (it stores only the SHA-256 hash in
`settings.api_token_hash`; the raw token is never persisted). Then every request must send
`"token": "<secret>"` in its body (or `?token=...` for GET). Keep the web app on "Anyone"
(Shortcuts can't pass Google auth), but gate every request on the token. Leave the hash
empty only during development.

**GET is read-only — enforced by the backend.** Every write action (`transaction.create`,
`account.create`, `settings.set`, `import`, `recurring.run`, …) returns
`405 METHOD_NOT_ALLOWED` when invoked over GET; only the read actions listed in
`docs/04` accept GET. Prefer POST for everything: a token in a GET query string can leak
through URL history, shared links, browser prefetch and proxy logs. The Shortcut reads
below work over GET only because they never mutate data.

---

## 4. Shortcut templates (JSON bodies)

### Log an expense (prompts for amount + picker for category/account)

```json
{
  "action": "transaction.create",
  "type": "EXPENSE",
  "amount": "{{Amount}}",
  "currency": "{{Currency}}",
  "account_id": "{{AccountID}}",
  "category_id": "{{CategoryID}}",
  "merchant": "{{Merchant}}",
  "note": "{{Note}}",
  "date": "{{Current Date ISO}}",
  "external_ref": "{{Shortcut Input UUID}}"
}
```

### Log income

```json
{
  "action": "transaction.create",
  "type": "INCOME",
  "amount": "{{Amount}}",
  "currency": "{{Currency}}",
  "account_id": "{{AccountID}}",
  "income_source_id": "{{SourceID}}",
  "note": "Salary",
  "date": "{{Current Date ISO}}",
  "external_ref": "{{Shortcut Input UUID}}"
}
```

### Transfer between accounts

```json
{
  "action": "transaction.create",
  "type": "TRANSFER",
  "amount": "{{Amount}}",
  "currency": "{{Currency}}",
  "from_account_id": "{{FromAccountID}}",
  "to_account_id": "{{ToAccountID}}",
  "note": "Savings top-up",
  "date": "{{Current Date ISO}}",
  "external_ref": "{{Shortcut Input UUID}}"
}
```

### Quick reads (use GET)

```
https://script.google.com/macros/s/ID/exec?action=account.list&token=...
https://script.google.com/macros/s/ID/exec?action=dashboard.summary&token=...
```

---

## 5. Recommended Shortcut set

| Shortcut | Action | Notes |
|---|---|---|
| "Log Expense" | transaction.create (EXPENSE) | asks amount, merchant |
| "Log Income" | transaction.create (INCOME) | asks amount, source |
| "Transfer" | transaction.create (TRANSFER) | asks amount, from/to |
| "Add Category" | category.create | maintenance |
| "Add Account" | account.create | maintenance |
| "Week in Review" | dashboard.summary | shows KPIs |

Each shortcut should set `external_ref` to a random UUID so re-tapping never double-books.

---

## 6. Response handling in Shortcuts

- Check `ok == true`. If `duplicate == true`, notify "Already logged".
- Show `transaction_id` and the new account balance (from `data.balance` if returned).
- On `ok == false`, surface `error.details` messages.

---

## 7. Testing

- `action: health` — verify connectivity and version.
- `action: analytics.run` — regenerate reports.
- Use `dry_run: true` on `transaction.create` to validate without writing.
