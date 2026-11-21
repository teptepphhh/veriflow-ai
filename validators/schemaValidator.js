// validators/schemaValidator.js
// The expected order contract, plus the functions that check a payload against it.

// Expected fields for an order.
//   type      = expected data type
//   required  = must be present
// Optional value rules (checked only when the type is already correct):
//   minLength, format ('email' | 'currency' | 'iso-date'), min, integer, minItems
const ORDER_SCHEMA = {
  orderId: { type: 'string', required: true, minLength: 1 },
  customerEmail: { type: 'string', required: true, format: 'email' },
  total: { type: 'number', required: true, min: 0 },
  currency: { type: 'string', required: true, format: 'currency' },
  createdAt: { type: 'string', required: true, format: 'iso-date' },
  items: { type: 'array', required: true, minItems: 1 },
  notes: { type: 'string', required: false },
};

// Expected fields for each object inside "items"
const ITEM_SCHEMA = {
  sku: { type: 'string', required: true, minLength: 1 },
  quantity: { type: 'number', required: true, integer: true, min: 1 },
  price: { type: 'number', required: true, min: 0 },
};

// typeof says 'object' for both arrays and null, so we handle them separately
function typeOf(value) {
  if (Array.isArray(value)) return 'array';
  if (value === null) return 'null';
  return typeof value;
}

// Simple email check: something@something.something, no spaces
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Accepts 2026-11-21 or 2026-11-21T10:00:00Z (also with milliseconds or +08:00).
// The extra Date check catches impossible dates like 2026-02-30.
function isIsoDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})(T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})?)?$/.exec(value);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

// Checks the value rules of one field (the type is already correct here).
// Returns an error text, or null if the value is fine.
function checkValueRules(value, rule) {
  if (rule.type === 'string') {
    if (rule.minLength && value.trim().length < rule.minLength) return 'must not be empty';
    if (rule.format === 'email' && !EMAIL_REGEX.test(value)) return 'must be a valid email address';
    if (rule.format === 'currency' && !/^[A-Z]{3}$/.test(value)) return 'must be a 3-letter uppercase currency code (e.g. USD)';
    if (rule.format === 'iso-date' && !isIsoDate(value)) return 'must be an ISO 8601 date (e.g. 2026-11-21T10:00:00Z)';
  }
  if (rule.type === 'number') {
    if (rule.integer && !Number.isInteger(value)) return 'must be a whole number';
    if (rule.min !== undefined && value < rule.min) return `must be at least ${rule.min}`;
  }
  if (rule.type === 'array') {
    if (rule.minItems && value.length < rule.minItems) return `must contain at least ${rule.minItems} item(s)`;
  }
  return null;
}

// Checks one object against one schema and returns a list of issues.
// prefix is used for paths like "items[0].sku".
function checkObject(obj, schema, prefix = '') {
  const issues = [];

  // Missing required fields, wrong types, and invalid values
  for (const [field, rule] of Object.entries(schema)) {
    const path = prefix + field;
    if (!(field in obj)) {
      if (rule.required) {
        issues.push({
          field: path,
          type: 'MISSING_FIELD',
          message: `Required field "${path}" is missing (expected ${rule.type}).`,
        });
      }
      continue;
    }
    const actual = typeOf(obj[field]);
    if (actual !== rule.type) {
      issues.push({
        field: path,
        type: 'WRONG_TYPE',
        message: `Field "${path}" should be ${rule.type} but got ${actual}.`,
      });
      continue; // value rules only make sense when the type is right
    }
    const problem = checkValueRules(obj[field], rule);
    if (problem) {
      issues.push({
        field: path,
        type: 'INVALID_VALUE',
        message: `Field "${path}" ${problem}.`,
      });
    }
  }

  // Schema drift: fields that are not in the contract.
  // A renamed field shows up as one MISSING_FIELD (old name) and one UNEXPECTED_FIELD (new name).
  for (const field of Object.keys(obj)) {
    if (!(field in schema)) {
      issues.push({
        field: prefix + field,
        type: 'UNEXPECTED_FIELD',
        message: `Unexpected field "${prefix + field}" is not part of the contract (possible rename or API change).`,
      });
    }
  }

  return issues;
}

// Main function used by server.js. Returns { status, issues }.
function validatePayload(payload) {
  // The payload itself must be an object (not an array, string, or null)
  if (typeOf(payload) !== 'object') {
    return {
      status: 'DRIFT_DETECTED',
      issues: [
        {
          field: '(root)',
          type: 'WRONG_TYPE',
          message: `Payload must be a JSON object but got ${typeOf(payload)}.`,
        },
      ],
    };
  }

  const issues = checkObject(payload, ORDER_SCHEMA);

  // Check each item too, but only if "items" is really an array
  if (Array.isArray(payload.items)) {
    payload.items.forEach((item, i) => {
      if (typeOf(item) !== 'object') {
        issues.push({
          field: `items[${i}]`,
          type: 'WRONG_TYPE',
          message: `Item items[${i}] should be an object but got ${typeOf(item)}.`,
        });
        return;
      }
      issues.push(...checkObject(item, ITEM_SCHEMA, `items[${i}].`));
    });
  }

  return {
    status: issues.length === 0 ? 'VALID' : 'DRIFT_DETECTED',
    issues,
  };
}

module.exports = { validatePayload, ORDER_SCHEMA, ITEM_SCHEMA };
