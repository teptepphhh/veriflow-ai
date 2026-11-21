# Veriflow

API payload and schema drift triage tool. You paste a JSON payload, and Veriflow checks it against an order contract:

- `VALID` - required fields, types, and values all match the contract.
- `DRIFT_DETECTED` - something is wrong (missing field, wrong type, invalid value, or an unexpected/renamed field). Veriflow explains the likely root cause and a fix, optionally sends a Slack/Discord alert, and saves an audit log.

Built with Node.js + Express (backend) and plain HTML/CSS/JS (dashboard). No database needed.

## How it works

```
Dashboard  --POST /api/validate-->  Express
                                      |
                              schemaValidator   (contract check)
                                      |
                        VALID --------+-------- DRIFT_DETECTED
                          |                          |
                          |            aiTriageService  (Gemini, or rule-based fallback)
                          |                          |
                          |            webhookService   (Slack/Discord, skipped if not set)
                          |                          |
                          +------> logStore (data/logs.json) <------+
```

The app does not crash when something external fails:

| Situation | What happens |
|---|---|
| `GEMINI_API_KEY` empty, or Gemini errors / times out / gives a bad answer | Uses the rule-based explanation (`rule-based` label) |
| Gemini answers `503` (server busy) | Tries one more time, then uses the rule-based explanation if it fails again. Other errors (404, timeout) are not retried |
| `WEBHOOK_URL` empty | Alert is skipped |
| Webhook returns an error | Logged in the console, validation still succeeds |
| Invalid JSON typed in the editor | Clear message in the dashboard, nothing is sent |
| Invalid JSON sent to the API | `400` with a message |
| `data/logs.json` is corrupted | Reads as an empty list |

## Validation rules

The contract is in `validators/schemaValidator.js` (`ORDER_SCHEMA` and `ITEM_SCHEMA`). The dashboard's "View expected contract" panel reads it from `GET /api/schema`.

| Issue type | Meaning |
|---|---|
| `MISSING_FIELD` | A required field is not in the payload |
| `WRONG_TYPE` | The field has the wrong data type (e.g. `total` is a string) |
| `INVALID_VALUE` | Right type, but the value breaks a rule |
| `UNEXPECTED_FIELD` | A field that is not in the contract (a renamed field shows up as one `MISSING_FIELD` plus one `UNEXPECTED_FIELD`) |

Value rules: `orderId` and `sku` not empty, `customerEmail` is a valid email, `total` and `price` are at least 0, `quantity` is a whole number of at least 1, `currency` is a 3-letter uppercase code, `createdAt` is a real ISO 8601 date, and `items` has at least 1 item.

## Setup (Node 20 or newer)

Developed and tested on Node 22.

```powershell
npm install
Copy-Item .env.example .env
npm start
```

On macOS/Linux use `cp .env.example .env` instead of `Copy-Item`.

Open http://localhost:3000. The app works without any keys (see the configuration table below). `data/logs.json` is created automatically on the first run.

## Configuration (`.env`)

| Variable | Purpose |
|---|---|
| `PORT` | Server port (default 3000) |
| `API_KEY` | Required `x-api-key` for `POST /api/validate` and `DELETE /api/logs` (default `veriflow-local-key`) |
| `GEMINI_API_KEY` | Optional. Empty or failing = rule-based explanation |
| `GEMINI_MODEL` | Optional. Defaults to `gemini-3.5-flash-lite`. Change it if Google retires the model (you will see `HTTP 404` in the server log) |
| `GEMINI_TIMEOUT_MS` | Optional. How long to wait for Gemini before using the fallback (default `20000` = 20 seconds) |
| `WEBHOOK_URL` | Optional Slack (`https://hooks.slack.com/services/...`) or Discord webhook. Empty = no alerts |

If you change `API_KEY`, also change the `API_KEY` constant at the top of `public/app.js`.

## Using the dashboard

- **Presets:** "Load valid order", "Load broken (drift) order", and a "More scenarios" list (missing fields, wrong types, renamed fields, invalid values, empty items).
- **Run demo:** asks for confirmation, then validates all 7 scenarios one after another with a progress bar ("Running scenario 2 of 7..."). Good for a quick walkthrough.
- **Apply fix to editor:** on a drift result, this button (in the Suggested Fix card) puts a corrected version of the payload into the editor: renamed fields are renamed back, wrong types are converted, unexpected fields are removed, bad values are repaired, and missing required fields get placeholder values (the app tells you which ones to replace). It does not validate by itself, so you can click Validate payload (or Ctrl + Enter) to show the before and after.
- **Format JSON / Copy:** buttons in the editor title bar. Format re-indents the JSON (or explains the syntax error), Copy copies the editor text.
- **Ctrl + Enter** inside the editor validates the payload.
- **Loading feedback:** the Validate button shows a spinner and "Validating & triaging...", the Result panel shows a loading card with a seconds counter, and the buttons are disabled so nothing is clicked twice.
- **Toast messages:** small notices (validation done, exported, cleared, copied, invalid JSON, network errors) slide in at the bottom right. Click one to dismiss it.
- **Confirmation dialogs:** "Clear logs" and "Run demo" ask first (Cancel, Esc, or a click outside closes the dialog). Clear logs shows how many entries will be deleted.
- **View expected contract:** shows the fields, types, required/optional, and value rules.
- **Audit log:** filter by All / Valid / Drift, click a row to see the original payload, the issues, the suggested fix (with Copy buttons), and whether an alert was sent.
- **Export JSON / CSV** and **Clear logs**. Only the newest 200 logs are kept.

## API

| Method | Route | Needs `x-api-key` | Purpose |
|---|---|---|---|
| POST | `/api/validate` | yes | Validate a payload, returns the saved log |
| GET | `/api/logs` | no | List audit logs (newest first) |
| DELETE | `/api/logs` | yes | Clear all logs |
| GET | `/api/schema` | no | The expected contract |
| GET | `/api/health` | no | Server status (never shows keys) |

```powershell
curl.exe -X POST http://localhost:3000/api/validate -H "Content-Type: application/json" -H "x-api-key: veriflow-local-key" -d '{\"orderId\":\"1\"}'
curl.exe http://localhost:3000/api/health
```

## Tests

```powershell
npm test
```

Uses Node's built-in test runner (no extra packages). Tests never touch the real `data/logs.json` (they use a temp file) and never call the real Gemini or Slack (the network is mocked).

Latest result: **63 tests, 63 passing, 0 failing.**

| File | Tests | What it covers |
|---|---|---|
| `tests/validator.test.js` | 16 | valid payload, missing fields, wrong types, renamed fields, invalid email / total / quantity / currency / date, empty items, non-object payloads |
| `tests/services.test.js` | 15 | Gemini 404, network error, bad answer, and good answer (fallback behavior); retry once on 503, no retry on 404 or timeout, timeout setting; webhook skipped when empty, Slack vs Discord body, failing webhook |
| `tests/api.test.js` | 9 | API key check (401), valid and drift results, malformed JSON (400), array payload, schema, health, delete logs |
| `tests/fixer.test.js` | 17 | "Apply fix to editor": renames, type conversion, value repair, placeholders, contract field order, original payload not changed, and every fixed payload passes the real validator |
| `tests/logStore.test.js` | 6 | empty store, id and timestamp, newest first, clear, corrupted file, 200-log limit |

## Project structure

```
server.js                      Express app, API key check, routes
validators/schemaValidator.js  Contract + drift detection
services/aiTriageService.js    Gemini triage + rule-based fallback
services/webhookService.js     Slack/Discord alert
storage/logStore.js            Read/append/clear data/logs.json
public/                        Dashboard (index.html, styles.css, app.js), fixer.js (apply-fix logic), logo.png (header logo + favicon)
tests/                         node:test test files
data/                          logs.json is created here at runtime (not in git)
.env.example                   Sample configuration (copy to .env)
```

## Known limitations

- The API key is in `public/app.js` because there is no login, so it is not really secret. This is fine for a local tool; a real deployment would need proper authentication.
- `GET /api/logs` has no API key, and the logs contain the payloads that were validated. Do not use real customer data with it.
- When a payload is drifted, the payload is sent to Gemini to write the explanation. A real project would remove or mask sensitive fields first.
- Logs are stored in a JSON file, which is simple but not meant for many users or high traffic (a real project would use a database). The file is written directly, so a crash in the middle of a write could damage it.
- Gemini and the Slack alert run inside the request, so a slow Gemini response makes the request wait (up to the timeout) before the result is shown.
- There is one fixed contract (the order). Supporting multiple or editable contracts, or comparing against older versions, would be a next step.
