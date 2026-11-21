// tests/fixer.test.js
// Tests for the "Apply fix to editor" logic (public/fixer.js).
// Main idea: after the fix, the validator must say VALID.

const test = require('node:test');
const assert = require('node:assert/strict');
const { applyContractFix } = require('../public/fixer');
const { validatePayload, ORDER_SCHEMA, ITEM_SCHEMA } = require('../validators/schemaValidator');

const NOW = new Date('2026-11-21T12:00:00.000Z'); // fixed time so results are predictable

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

// Applies the fix, then checks the result with the real validator
function fixAndCheck(payload) {
  const result = applyContractFix(payload, ORDER_SCHEMA, ITEM_SCHEMA, NOW);
  assert.ok(result, 'the payload should be fixable');
  const check = validatePayload(result.fixed);
  assert.equal(check.status, 'VALID', `still has issues: ${JSON.stringify(check.issues)}`);
  return result;
}

test('a valid payload has nothing to fix', () => {
  const result = fixAndCheck(validOrder());
  assert.deepEqual(result.changes, []);
  assert.deepEqual(result.fixed, validOrder());
});

test('the sample "drift" payload becomes VALID', () => {
  const result = fixAndCheck({
    order_id: 'ORD-1002',
    customerEmail: 'john@example.com',
    total: '59.98',
    createdAt: '2026-11-21T10:05:00Z',
    items: [{ sku: 'SKU-2', quantity: '1', price: 59.98 }],
    coupon: 'SAVE10',
  });
  assert.equal(result.fixed.orderId, 'ORD-1002');   // renamed, value kept
  assert.equal(result.fixed.total, 59.98);          // "59.98" -> 59.98
  assert.equal(result.fixed.items[0].quantity, 1);  // "1" -> 1
  assert.equal(result.fixed.currency, 'USD');       // missing -> placeholder
  assert.ok(!('coupon' in result.fixed));           // unexpected field removed
  assert.deepEqual(result.placeholders, ['currency']);
});

test('missing required fields are added as placeholders', () => {
  const payload = validOrder();
  delete payload.customerEmail;
  delete payload.currency;

  const result = fixAndCheck(payload);
  assert.deepEqual(result.placeholders.sort(), ['currency', 'customerEmail']);
});

test('renamed fields (snake_case) are renamed back and keep their values', () => {
  const result = fixAndCheck({
    order_id: 'ORD-1005',
    customer_email: 'maria@example.com',
    total: 35.5,
    currency: 'PHP',
    createdAt: '2026-11-21T10:20:00Z',
    items: [{ sku: 'SKU-5', quantity: 1, price: 35.5 }],
  });
  assert.equal(result.fixed.orderId, 'ORD-1005');
  assert.equal(result.fixed.customerEmail, 'maria@example.com');
  assert.deepEqual(result.placeholders, []); // nothing had to be invented
});

test('a renamed field inside an item is fixed too', () => {
  const payload = validOrder();
  payload.items = [{ sku: 'SKU-1', quantity: 2, PRICE: 12.5 }]; // same name, different writing

  const result = fixAndCheck(payload);
  assert.equal(result.fixed.items[0].price, 12.5);
});

test('a field with a really different name is not guessed, it is replaced', () => {
  const payload = validOrder();
  payload.items = [{ sku: 'SKU-1', quantity: 2, unit_price: 12.5 }];

  const result = fixAndCheck(payload);
  assert.equal(result.fixed.items[0].price, 0);                 // placeholder for the missing price
  assert.ok(!('unit_price' in result.fixed.items[0]));          // unknown field removed
  assert.ok(result.placeholders.includes('items[0].price'));    // and the user is told
});

test('wrong types are converted when possible, replaced when not', () => {
  const result = fixAndCheck({
    ...validOrder(),
    total: 'fifty',                                            // cannot be converted
    items: [{ sku: 'SKU-4', quantity: '2', price: '29.99' }],  // can be converted
  });
  assert.equal(result.fixed.total, 0);
  assert.equal(result.fixed.items[0].quantity, 2);
  assert.equal(result.fixed.items[0].price, 29.99);
  assert.deepEqual(result.placeholders, ['total']);
});

test('invalid values are repaired', () => {
  const result = fixAndCheck({
    orderId: 'ORD-1006',
    customerEmail: 'jane-at-example',
    total: -10,
    currency: 'usd',
    createdAt: 'yesterday',
    items: [{ sku: '', quantity: 0, price: 5 }],
  });
  assert.equal(result.fixed.total, 10);          // negative -> positive
  assert.equal(result.fixed.currency, 'USD');    // uppercase
  assert.equal(result.fixed.createdAt, NOW.toISOString());
  assert.equal(result.fixed.items[0].quantity, 1);
  assert.ok(result.placeholders.includes('customerEmail'));
  assert.ok(result.placeholders.includes('items[0].sku'));
});

test('an empty items list gets one default item', () => {
  const result = fixAndCheck({ ...validOrder(), items: [] });
  assert.equal(result.fixed.items.length, 1);
});

test('items that are not an array or not objects are repaired', () => {
  fixAndCheck({ ...validOrder(), items: 'three items' });
  fixAndCheck({ ...validOrder(), items: [5, 'x'] });
  const single = fixAndCheck({ ...validOrder(), items: { sku: 'SKU-9', quantity: 1, price: 3 } });
  assert.equal(single.fixed.items[0].sku, 'SKU-9'); // a single object is wrapped in an array
});

test('a decimal quantity is rounded to a whole number', () => {
  const payload = validOrder();
  payload.items[0].quantity = 1.6;
  assert.equal(fixAndCheck(payload).fixed.items[0].quantity, 2);
});

test('a readable date is rewritten as an ISO date', () => {
  const payload = validOrder();
  payload.createdAt = '21 Nov 2026 10:00 UTC';
  const result = fixAndCheck(payload);
  assert.match(result.fixed.createdAt, /^2026-11-21T/);
});

test('an optional field with the wrong type is converted, not removed', () => {
  const result = fixAndCheck({ ...validOrder(), notes: 5 });
  assert.equal(result.fixed.notes, '5');
});

test('fixed fields follow the contract order', () => {
  const result = fixAndCheck({
    items: [{ price: 1, quantity: 1, sku: 'A' }],
    currency: 'USD',
    total: 1,
    customerEmail: 'a@b.co',
    orderId: 'X',
    createdAt: '2026-11-21',
  });
  assert.deepEqual(Object.keys(result.fixed), ['orderId', 'customerEmail', 'total', 'currency', 'createdAt', 'items']);
  assert.deepEqual(Object.keys(result.fixed.items[0]), ['sku', 'quantity', 'price']);
});

test('the original payload is not changed', () => {
  const payload = { order_id: 'A', total: '5', items: [{ sku: 'S', quantity: '1', price: 1 }], coupon: 'x' };
  const before = JSON.stringify(payload);
  applyContractFix(payload, ORDER_SCHEMA, ITEM_SCHEMA, NOW);
  assert.equal(JSON.stringify(payload), before);
});

test('a payload that is not a JSON object cannot be fixed', () => {
  for (const bad of [[1, 2], 'text', 42, null]) {
    assert.equal(applyContractFix(bad, ORDER_SCHEMA, ITEM_SCHEMA, NOW), null);
  }
});

test('an empty object becomes a complete valid order', () => {
  const result = fixAndCheck({});
  assert.ok(result.placeholders.includes('orderId'));
});
