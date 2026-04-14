/**
 * validate.js — lightweight request body validation helpers.
 *
 * Each function throws with a 400-status error on failure so routes
 * can simply call them inside their try/catch block.
 */

function fail(msg) {
  const err = new Error(msg);
  err.status = 400;
  throw err;
}

export function requireString(obj, field, { maxLen = 10000, optional = false } = {}) {
  const v = obj[field];
  if (v === undefined || v === null) {
    if (optional) return undefined;
    fail(`${field} is required`);
  }
  if (typeof v !== 'string') fail(`${field} must be a string`);
  if (v.length > maxLen) fail(`${field} exceeds max length (${maxLen})`);
  return v;
}

export function requireEnum(obj, field, allowed, { optional = false } = {}) {
  const v = obj[field];
  if (v === undefined || v === null) {
    if (optional) return undefined;
    fail(`${field} is required`);
  }
  if (!allowed.includes(v)) fail(`${field} must be one of: ${allowed.join(', ')}`);
  return v;
}

export function requireArray(obj, field, { optional = false, maxLen = 5000 } = {}) {
  const v = obj[field];
  if (v === undefined || v === null) {
    if (optional) return undefined;
    fail(`${field} is required`);
  }
  if (!Array.isArray(v)) fail(`${field} must be an array`);
  if (v.length > maxLen) fail(`${field} exceeds max length (${maxLen})`);
  return v;
}

export function requireBool(obj, field, { optional = false } = {}) {
  const v = obj[field];
  if (v === undefined || v === null) {
    if (optional) return undefined;
    fail(`${field} is required`);
  }
  if (typeof v !== 'boolean') fail(`${field} must be a boolean`);
  return v;
}

export function requireNumber(obj, field, { optional = false, min, max } = {}) {
  const v = obj[field];
  if (v === undefined || v === null) {
    if (optional) return undefined;
    fail(`${field} is required`);
  }
  if (typeof v !== 'number' || Number.isNaN(v)) fail(`${field} must be a number`);
  if (min !== undefined && v < min) fail(`${field} must be >= ${min}`);
  if (max !== undefined && v > max) fail(`${field} must be <= ${max}`);
  return v;
}
