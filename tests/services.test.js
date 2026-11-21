// tests/services.test.js
// Tests the "no crash" fallbacks of the AI triage and webhook services.
// fetch is replaced with a fake (mock), so no real internet call is made.

const test = require('node:test');
const assert = require('node:assert/strict');

const { triageDrift } = require('../services/aiTriageService');
const { sendDriftAlert } = require('../services/webhookService');

// Sample validation issues (a renamed field plus a wrong type)
const issues = [
  { field: 'orderId', type: 'MISSING_FIELD', message: 'missing' },
  { field: 'order_id', type: 'UNEXPECTED_FIELD', message: 'unexpected' },
  { field: 'total', type: 'WRONG_TYPE', message: 'wrong type' },
];

// Fake Gemini response in the same shape as the real API
function geminiReply(obj) {
  return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(obj) }] } }] }) };
}

// Each test sets the env vars it needs, then they are put back
const saved = {};
const VARS = ['GEMINI_API_KEY', 'GEMINI_MODEL', 'GEMINI_TIMEOUT_MS', 'GEMINI_RETRY_DELAY_MS', 'WEBHOOK_URL'];
test.beforeEach(() => VARS.forEach((v) => { saved[v] = process.env[v]; delete process.env[v]; }));
test.afterEach(() => VARS.forEach((v) => {
  if (saved[v] === undefined) delete process.env[v];
  else process.env[v] = saved[v];
}));

// ---------- AI triage ----------

test('triage: no GEMINI_API_KEY uses rule-based and makes no network call', async (t) => {
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => { throw new Error('should not be called'); });

  const result = await triageDrift({}, issues);
  assert.equal(result.source, 'rule-based');
  assert.match(result.rootCause, /rename/i); // missing + unexpected = possible rename
  assert.equal(fetchMock.mock.callCount(), 0);
});

test('triage: Gemini HTTP 404 falls back to rule-based instead of crashing', async (t) => {
  process.env.GEMINI_API_KEY = 'fake-key';
  t.mock.method(console, 'warn', () => {}); // hide the expected warning
  t.mock.method(globalThis, 'fetch', async () => ({ ok: false, status: 404 }));

  const result = await triageDrift({}, issues);
  assert.equal(result.source, 'rule-based');
});

test('triage: network error falls back to rule-based', async (t) => {
  process.env.GEMINI_API_KEY = 'fake-key';
  t.mock.method(console, 'warn', () => {});
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('network down'); });

  const result = await triageDrift({}, issues);
  assert.equal(result.source, 'rule-based');
});

test('triage: unusable Gemini answer falls back to rule-based', async (t) => {
  process.env.GEMINI_API_KEY = 'fake-key';
  t.mock.method(console, 'warn', () => {});
  t.mock.method(globalThis, 'fetch', async () => geminiReply({ unexpected: 'shape' })); // missing rootCause/suggestedFix

  const result = await triageDrift({}, issues);
  assert.equal(result.source, 'rule-based');
});

test('triage: a good Gemini answer is used, with the configured model', async (t) => {
  process.env.GEMINI_API_KEY = 'fake-key';
  process.env.GEMINI_MODEL = 'my-test-model';
  const fetchMock = t.mock.method(globalThis, 'fetch', async () =>
    geminiReply({ rootCause: 'AI cause', suggestedFix: 'AI fix' }));

  const result = await triageDrift({}, issues);
  assert.deepEqual(result, { source: 'gemini', rootCause: 'AI cause', suggestedFix: 'AI fix' });

  const [url] = fetchMock.mock.calls[0].arguments;
  assert.match(url, /models\/my-test-model:generateContent/);
});

// ---------- Retry on 503 and timeout setting ----------

test('triage: 503 then success retries once and uses the Gemini answer', async (t) => {
  process.env.GEMINI_API_KEY = 'fake-key';
  process.env.GEMINI_RETRY_DELAY_MS = '0'; // no waiting in tests
  t.mock.method(console, 'warn', () => {});
  let calls = 0;
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => {
    calls += 1;
    return calls === 1 ? { ok: false, status: 503 } : geminiReply({ rootCause: 'AI cause', suggestedFix: 'AI fix' });
  });

  const result = await triageDrift({}, issues);
  assert.equal(result.source, 'gemini');
  assert.equal(fetchMock.mock.callCount(), 2);
});

test('triage: 503 twice retries only once, then falls back to rule-based', async (t) => {
  process.env.GEMINI_API_KEY = 'fake-key';
  process.env.GEMINI_RETRY_DELAY_MS = '0';
  t.mock.method(console, 'warn', () => {});
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => ({ ok: false, status: 503 }));

  const result = await triageDrift({}, issues);
  assert.equal(result.source, 'rule-based');
  assert.equal(fetchMock.mock.callCount(), 2); // first try + one retry, not more
});

test('triage: HTTP 404 is not retried', async (t) => {
  process.env.GEMINI_API_KEY = 'fake-key';
  process.env.GEMINI_RETRY_DELAY_MS = '0';
  t.mock.method(console, 'warn', () => {});
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => ({ ok: false, status: 404 }));

  const result = await triageDrift({}, issues);
  assert.equal(result.source, 'rule-based');
  assert.equal(fetchMock.mock.callCount(), 1);
});

test('triage: a timeout is not retried', async (t) => {
  process.env.GEMINI_API_KEY = 'fake-key';
  process.env.GEMINI_RETRY_DELAY_MS = '0';
  t.mock.method(console, 'warn', () => {});
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => {
    throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
  });

  const result = await triageDrift({}, issues);
  assert.equal(result.source, 'rule-based');
  assert.equal(fetchMock.mock.callCount(), 1);
});

test('triage: the timeout defaults to 20 seconds and can be changed in .env', async (t) => {
  process.env.GEMINI_API_KEY = 'fake-key';
  t.mock.method(console, 'warn', () => {});
  const timeoutMock = t.mock.method(AbortSignal, 'timeout', () => new AbortController().signal);
  t.mock.method(globalThis, 'fetch', async () => geminiReply({ rootCause: 'c', suggestedFix: 'f' }));

  await triageDrift({}, issues);
  assert.equal(timeoutMock.mock.calls[0].arguments[0], 20000);

  process.env.GEMINI_TIMEOUT_MS = '5000';
  await triageDrift({}, issues);
  assert.equal(timeoutMock.mock.calls[1].arguments[0], 5000);
});

test('triage: the rule-based text mentions invalid values', async () => {
  const result = await triageDrift({}, [{ field: 'customerEmail', type: 'INVALID_VALUE', message: 'bad email' }]);
  assert.equal(result.source, 'rule-based');
  assert.match(result.rootCause, /customerEmail/);
});

// ---------- Webhook ----------

const entry = { issues, triage: { rootCause: 'cause', suggestedFix: 'fix' } };

test('webhook: empty WEBHOOK_URL is skipped without a network call', async (t) => {
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => { throw new Error('should not be called'); });

  const result = await sendDriftAlert(entry);
  assert.equal(result.sent, false);
  assert.equal(fetchMock.mock.callCount(), 0);
});

test('webhook: Slack URL gets exactly { text }', async (t) => {
  process.env.WEBHOOK_URL = 'https://hooks.slack.com/services/T000/B000/XXXX';
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => ({ ok: true, status: 200 }));

  const result = await sendDriftAlert(entry);
  assert.equal(result.sent, true);

  const [, options] = fetchMock.mock.calls[0].arguments;
  const body = JSON.parse(options.body);
  assert.deepEqual(Object.keys(body), ['text']);
  assert.match(body.text, /DRIFT_DETECTED/);
});

test('webhook: Discord URL gets { content, text }', async (t) => {
  process.env.WEBHOOK_URL = 'https://discord.com/api/webhooks/123/abc';
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => ({ ok: true, status: 204 }));

  await sendDriftAlert(entry);
  const body = JSON.parse(fetchMock.mock.calls[0].arguments[1].body);
  assert.ok(body.content && body.text);
});

test('webhook: a failing webhook returns sent:false and does not throw', async (t) => {
  process.env.WEBHOOK_URL = 'https://hooks.slack.com/services/T000/B000/XXXX';
  t.mock.method(console, 'warn', () => {});
  t.mock.method(globalThis, 'fetch', async () => ({ ok: false, status: 500 }));

  const result = await sendDriftAlert(entry);
  assert.equal(result.sent, false);
});
