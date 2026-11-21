// tests/api.test.js
// End-to-end tests of the Express API. The app is started on a random port.
// Gemini and the webhook are turned off, and logs go to a temp file.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Set the environment BEFORE loading the app
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'veriflow-api-'));
process.env.LOG_FILE = path.join(tempDir, 'logs.json');
process.env.API_KEY = 'test-key';
process.env.GEMINI_API_KEY = ''; // forces the rule-based fallback (no internet call)
process.env.WEBHOOK_URL = '';    // alert is skipped

const app = require('../server');
const { clearLogs } = require('../storage/logStore');

let server;
let base;

test.before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, resolve); // port 0 = any free port
  });
  base = `http://localhost:${server.address().port}`;
});
test.after(() => {
  server.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});
test.beforeEach(() => clearLogs());

const headers = { 'Content-Type': 'application/json', 'x-api-key': 'test-key' };

const validOrder = {
  orderId: 'ORD-1',
  customerEmail: 'jane@example.com',
  total: 59.98,
  currency: 'USD',
  createdAt: '2026-11-21T10:00:00Z',
  items: [{ sku: 'SKU-1', quantity: 2, price: 29.99 }],
};

test('POST /api/validate without API key returns 401', async () => {
  const res = await fetch(`${base}/api/validate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(validOrder),
  });
  assert.equal(res.status, 401);
});

test('POST /api/validate with a wrong API key returns 401', async () => {
  const res = await fetch(`${base}/api/validate`, {
    method: 'POST',
    headers: { ...headers, 'x-api-key': 'wrong' },
    body: JSON.stringify(validOrder),
  });
  assert.equal(res.status, 401);
});

test('valid payload returns VALID with no triage, and is logged', async () => {
  const res = await fetch(`${base}/api/validate`, { method: 'POST', headers, body: JSON.stringify(validOrder) });
  assert.equal(res.status, 200);

  const log = await res.json();
  assert.equal(log.status, 'VALID');
  assert.deepEqual(log.issues, []);
  assert.equal(log.triage, null);

  const logs = await (await fetch(`${base}/api/logs`)).json();
  assert.equal(logs.length, 1);
});

test('drifted payload returns DRIFT_DETECTED with rule-based triage', async () => {
  const drift = { ...validOrder, order_id: 'ORD-2', total: '59.98' };
  delete drift.orderId;

  const res = await fetch(`${base}/api/validate`, { method: 'POST', headers, body: JSON.stringify(drift) });
  const log = await res.json();

  assert.equal(log.status, 'DRIFT_DETECTED');
  assert.ok(log.issues.length >= 3);
  assert.equal(log.triage.source, 'rule-based'); // no Gemini key in this test
  assert.ok(log.triage.rootCause.length > 0);
  assert.equal(log.webhookSent, false); // no WEBHOOK_URL, skipped without error
});

test('malformed JSON body returns a clean 400', async () => {
  const res = await fetch(`${base}/api/validate`, { method: 'POST', headers, body: '{bad json' });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.error, /Malformed JSON/);
});

test('a JSON array as payload is reported as drift, not a crash', async () => {
  const res = await fetch(`${base}/api/validate`, { method: 'POST', headers, body: '[1,2,3]' });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).status, 'DRIFT_DETECTED');
});

test('GET /api/schema returns the contract', async () => {
  const body = await (await fetch(`${base}/api/schema`)).json();
  assert.equal(body.order.orderId.type, 'string');
  assert.equal(body.item.quantity.integer, true);
});

test('GET /api/health reports status without exposing keys', async () => {
  const body = await (await fetch(`${base}/api/health`)).json();
  assert.equal(body.status, 'ok');
  assert.match(body.gemini, /not configured/);
  assert.match(body.webhook, /not configured/);
  assert.ok(!JSON.stringify(body).includes('test-key'));
});

test('DELETE /api/logs needs the API key, then clears the logs', async () => {
  await fetch(`${base}/api/validate`, { method: 'POST', headers, body: JSON.stringify(validOrder) });

  const denied = await fetch(`${base}/api/logs`, { method: 'DELETE' });
  assert.equal(denied.status, 401);

  const ok = await fetch(`${base}/api/logs`, { method: 'DELETE', headers });
  assert.equal(ok.status, 200);

  const logs = await (await fetch(`${base}/api/logs`)).json();
  assert.deepEqual(logs, []);
});
