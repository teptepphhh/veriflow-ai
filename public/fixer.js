// public/fixer.js
// Builds a corrected copy of a payload using the contract (schema).
// The "Apply fix to editor" button uses it. It is a plain function with no
// DOM code, so the Node tests can load it too (see tests/fixer.test.js).

(function (root) {
  const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const CURRENCY_REGEX = /^[A-Z]{3}$/;
  const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})?)?$/;

  function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  function typeOf(value) {
    if (Array.isArray(value)) return 'array';
    if (value === null) return 'null';
    return typeof value;
  }

  // "order_id", "Order-Id" and "orderId" all become "orderid",
  // so a renamed field can be matched with the field in the contract
  function normalizeName(name) {
    return String(name).replace(/[_\-\s]/g, '').toLowerCase();
  }

  // Same idea as the validator: true if the text is a real ISO date
  function isIsoDate(value) {
    const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
    if (!match || !ISO_DATE_REGEX.test(value)) return false;
    const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
  }

  // A safe starting value for a field that is missing or cannot be repaired.
  // These are placeholders, so the app tells the user to replace them.
  function defaultValue(name, rule, ctx, path) {
    if (rule.type === 'string') {
      if (rule.format === 'email') return 'customer@example.com';
      if (rule.format === 'currency') return 'USD';
      if (rule.format === 'iso-date') return ctx.now.toISOString();
      if (name === 'orderId') return 'ORD-0001';
      if (name === 'sku') return 'SKU-0001';
      return rule.minLength ? 'TEXT' : '';
    }
    if (rule.type === 'number') {
      const min = rule.min !== undefined ? rule.min : 0;
      return rule.integer ? Math.max(min, 1) : min;
    }
    if (rule.type === 'array') {
      // An array with a minimum size gets one default item
      return rule.minItems ? [defaultItem(ctx, `${path}[0].`)] : [];
    }
    return null;
  }

  // One item built only from the required fields of the item contract
  function defaultItem(ctx, prefix) {
    return fixObject({}, ctx.itemSchema, ctx, prefix);
  }

  // Tries to convert a value to the expected type ("59.98" -> 59.98).
  // Returns undefined when there is no sensible conversion.
  function convertType(value, rule) {
    if (rule.type === 'number' && typeof value === 'string' && value.trim() !== '') {
      const number = Number(value.trim());
      return Number.isFinite(number) ? number : undefined;
    }
    if (rule.type === 'string' && (typeof value === 'number' || typeof value === 'boolean')) {
      return String(value);
    }
    if (rule.type === 'array' && isPlainObject(value)) return [value];
    return undefined;
  }

  // Fixes one value: wrong type first, then the value rules
  function fixValue(value, name, rule, path, ctx) {
    // 1) Wrong type: convert it, or use a placeholder
    if (typeOf(value) !== rule.type) {
      const converted = convertType(value, rule);
      if (converted === undefined) {
        ctx.changes.push(`Replaced "${path}" (wrong type) with a placeholder`);
        ctx.placeholders.push(path);
        return defaultValue(name, rule, ctx, path);
      }
      ctx.changes.push(`Converted "${path}" to ${rule.type}`);
      value = converted;
    }

    // 2) Value rules
    if (rule.type === 'string') {
      if (rule.minLength && value.trim().length < rule.minLength) {
        ctx.changes.push(`Filled empty "${path}" with a placeholder`);
        ctx.placeholders.push(path);
        return defaultValue(name, rule, ctx, path);
      }
      if (rule.format === 'email' && !EMAIL_REGEX.test(value)) {
        ctx.changes.push(`Replaced invalid email in "${path}" with a placeholder`);
        ctx.placeholders.push(path);
        return defaultValue(name, rule, ctx, path);
      }
      if (rule.format === 'currency' && !CURRENCY_REGEX.test(value)) {
        const upper = value.trim().toUpperCase();
        if (CURRENCY_REGEX.test(upper)) {
          ctx.changes.push(`Changed "${path}" to uppercase`);
          return upper;
        }
        ctx.changes.push(`Replaced invalid currency in "${path}" with USD`);
        ctx.placeholders.push(path);
        return defaultValue(name, rule, ctx, path);
      }
      if (rule.format === 'iso-date' && !isIsoDate(value)) {
        // Keep the date if JavaScript can read it, otherwise use the current time
        const time = /\d{4}/.test(value) ? Date.parse(value) : NaN;
        if (!Number.isNaN(time)) {
          ctx.changes.push(`Rewrote "${path}" as an ISO date`);
          return new Date(time).toISOString();
        }
        ctx.changes.push(`Replaced invalid date in "${path}" with the current time`);
        ctx.placeholders.push(path);
        return defaultValue(name, rule, ctx, path);
      }
    }

    if (rule.type === 'number') {
      if (rule.integer && !Number.isInteger(value)) {
        ctx.changes.push(`Rounded "${path}" to a whole number`);
        value = Math.round(value);
      }
      if (rule.min !== undefined && value < rule.min) {
        // A negative number is probably a typo for the positive one
        const fixed = Math.abs(value) >= rule.min ? Math.abs(value) : rule.min;
        ctx.changes.push(`Changed "${path}" from ${value} to ${fixed} (minimum is ${rule.min})`);
        value = fixed;
      }
    }

    if (rule.type === 'array') {
      // Each element is an item object
      value = value.map((item, i) => {
        const itemPath = `${path}[${i}]`;
        if (isPlainObject(item)) return fixObject(item, ctx.itemSchema, ctx, `${itemPath}.`);
        ctx.changes.push(`Replaced "${itemPath}" (not an object) with a default item`);
        ctx.placeholders.push(itemPath);
        return defaultItem(ctx, `${itemPath}.`);
      });
      if (rule.minItems && value.length < rule.minItems) {
        ctx.changes.push(`Added a default item to "${path}"`);
        ctx.placeholders.push(`${path}[0]`);
        value.push(defaultItem(ctx, `${path}[${value.length}].`));
      }
    }

    return value;
  }

  // Builds a fixed copy of one object, following the contract.
  // The result also uses the contract's field order, so it is easy to read.
  function fixObject(source, schema, ctx, prefix) {
    const out = {};
    const rest = { ...source }; // fields not used yet

    for (const [name, rule] of Object.entries(schema)) {
      const path = prefix + name;
      let found = false;
      let value;

      if (name in rest) {
        value = rest[name];
        delete rest[name];
        found = true;
      } else {
        // Missing, but maybe the sender renamed it (order_id -> orderId)
        const renamed = Object.keys(rest).find(
          (key) => !(key in schema) && normalizeName(key) === normalizeName(name)
        );
        if (renamed !== undefined) {
          value = rest[renamed];
          delete rest[renamed];
          found = true;
          ctx.changes.push(`Renamed "${prefix + renamed}" to "${path}"`);
        }
      }

      if (!found) {
        if (!rule.required) continue; // optional fields can stay out
        ctx.changes.push(`Added missing "${path}"`);
        ctx.placeholders.push(path);
        out[name] = defaultValue(name, rule, ctx, path);
        continue;
      }
      out[name] = fixValue(value, name, rule, path, ctx);
    }

    // Anything left over is not in the contract
    for (const key of Object.keys(rest)) {
      ctx.changes.push(`Removed unexpected "${prefix + key}"`);
    }
    return out;
  }

  // Main function. Returns { fixed, changes, placeholders },
  // or null if the payload is not a JSON object (nothing to fix).
  // The original payload is not changed.
  function applyContractFix(payload, orderSchema, itemSchema, now = new Date()) {
    if (!isPlainObject(payload)) return null;
    const ctx = { itemSchema, now, changes: [], placeholders: [] };
    const fixed = fixObject(payload, orderSchema, ctx, '');
    return { fixed, changes: ctx.changes, placeholders: ctx.placeholders };
  }

  root.applyContractFix = applyContractFix;
})(typeof module !== 'undefined' && module.exports ? module.exports : window);
