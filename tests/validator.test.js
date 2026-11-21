// tests/validator.test.js
// Unit tests for the schema validator (Node's built-in test runner).
// Run: npm test

const test = require('node:test');
const assert = require('node:assert/strict');
const { validatePayload } = require('../validators/schemaValidator');

// A correct order. Each test starts from this and breaks only one thing.
function validOrder() {
  return {
    orderId: 'ORD-1',
    customerEmail: 'jane@example.com',
    total: 59.98,
    currency: 'USD',
    createdAt: '2026-11-21T10:00:00Z',
    items: [{ sku: 'SKU-1', quantity: 2, price: 29.99 }],
  };
}

// Helper: gets the issue types reported for one field
function typesFor(result, field) {
  return result.issues.filter((i) => i.field === field).map((i) => i.type);
}

test('valid payload returns VALID with no issues', () => {
  const result = validatePayload(validOrder());
  assert.equal(result.status, 'VALID');
  assert.deepEqual(result.issues, []);
});

test('optional field "notes" may be omitted or present', () => {
  const withNotes = { ...validOrder(), notes: 'gift wrap' };
  assert.equal(validatePayload(withNotes).status, 'VALID');
});

test('missing required fields are flagged as MISSING_FIELD', () => {
  const payload = validOrder();
  delete payload.customerEmail;
  delete payload.currency;

  const result = validatePayload(payload);
  assert.equal(result.status, 'DRIFT_DETECTED');
  assert.deepEqual(typesFor(result, 'customerEmail'), ['MISSING_FIELD']);
  assert.deepEqual(typesFor(result, 'currency'), ['MISSING_FIELD']);
});

test('missing required field inside an item is flagged with its path', () => {
  const payload = validOrder();
  delete payload.items[0].sku;

  const result = validatePayload(payload);
  assert.equal(result.status, 'DRIFT_DETECTED');
  assert.deepEqual(typesFor(result, 'items[0].sku'), ['MISSING_FIELD']);
});

test('wrong data types are flagged as WRONG_TYPE', () => {
  const payload = validOrder();
  payload.total = '59.98'; // string instead of number
  payload.items[0].quantity = '2'; // string instead of number

  const result = validatePayload(payload);
  assert.equal(result.status, 'DRIFT_DETECTED');
  assert.deepEqual(typesFor(result, 'total'), ['WRONG_TYPE']);
  assert.deepEqual(typesFor(result, 'items[0].quantity'), ['WRONG_TYPE']);
});

test('items must be an array, not an object', () => {
  const payload = validOrder();
  payload.items = { sku: 'SKU-1' };

  const result = validatePayload(payload);
  assert.equal(result.status, 'DRIFT_DETECTED');
  assert.deepEqual(typesFor(result, 'items'), ['WRONG_TYPE']);
});

test('renamed field (order_id instead of orderId) is detected as drift', () => {
  const payload = validOrder();
  payload.order_id = payload.orderId; // sender renamed the field
  delete payload.orderId;

  const result = validatePayload(payload);
  assert.equal(result.status, 'DRIFT_DETECTED');
  // A rename shows up as the old name missing and the new name unexpected
  assert.deepEqual(typesFor(result, 'orderId'), ['MISSING_FIELD']);
  assert.deepEqual(typesFor(result, 'order_id'), ['UNEXPECTED_FIELD']);
});

// ---------- Value rules (right type, but the value is not acceptable) ----------

test('invalid email is flagged as INVALID_VALUE', () => {
  const payload = validOrder();
  payload.customerEmail = 'not-an-email';

  const result = validatePayload(payload);
  assert.equal(result.status, 'DRIFT_DETECTED');
  assert.deepEqual(typesFor(result, 'customerEmail'), ['INVALID_VALUE']);
});

test('negative total is flagged, zero is allowed', () => {
  const negative = validOrder();
  negative.total = -5;
  assert.deepEqual(typesFor(validatePayload(negative), 'total'), ['INVALID_VALUE']);

  const zero = validOrder();
  zero.total = 0;
  assert.equal(validatePayload(zero).status, 'VALID');
});

test('item quantity must be a whole number of at least 1', () => {
  for (const bad of [0, -1, 1.5]) {
    const payload = validOrder();
    payload.items[0].quantity = bad;
    assert.deepEqual(typesFor(validatePayload(payload), 'items[0].quantity'), ['INVALID_VALUE'], `quantity ${bad}`);
  }
});

test('empty items array is flagged', () => {
  const payload = validOrder();
  payload.items = [];

  const result = validatePayload(payload);
  assert.equal(result.status, 'DRIFT_DETECTED');
  assert.deepEqual(typesFor(result, 'items'), ['INVALID_VALUE']);
});

test('currency must be a 3-letter uppercase code', () => {
  for (const bad of ['usd', 'US', 'DOLLAR']) {
    const payload = validOrder();
    payload.currency = bad;
    assert.deepEqual(typesFor(validatePayload(payload), 'currency'), ['INVALID_VALUE'], `currency ${bad}`);
  }
});

test('createdAt must be a real ISO date', () => {
  // Valid forms
  for (const good of ['2026-11-21', '2026-11-21T10:00:00Z', '2026-11-21T10:00:00.123+08:00']) {
    const payload = validOrder();
    payload.createdAt = good;
    assert.equal(validatePayload(payload).status, 'VALID', `createdAt ${good}`);
  }
  // Invalid forms (the last one is an impossible date)
  for (const bad of ['yesterday', '21/11/2026', '2026-02-30']) {
    const payload = validOrder();
    payload.createdAt = bad;
    assert.deepEqual(typesFor(validatePayload(payload), 'createdAt'), ['INVALID_VALUE'], `createdAt ${bad}`);
  }
});

test('empty orderId or sku is flagged', () => {
  const payload = validOrder();
  payload.orderId = '   ';
  payload.items[0].sku = '';

  const result = validatePayload(payload);
  assert.deepEqual(typesFor(result, 'orderId'), ['INVALID_VALUE']);
  assert.deepEqual(typesFor(result, 'items[0].sku'), ['INVALID_VALUE']);
});

test('a wrong type does not also report a value-rule issue', () => {
  const payload = validOrder();
  payload.total = '59.98'; // string, so only WRONG_TYPE should appear

  assert.deepEqual(typesFor(validatePayload(payload), 'total'), ['WRONG_TYPE']);
});

test('non-object payloads are rejected cleanly', () => {
  for (const bad of [null, 'text', 42, []]) {
    const result = validatePayload(bad);
    assert.equal(result.status, 'DRIFT_DETECTED');
    assert.equal(result.issues[0].field, '(root)');
  }
});
