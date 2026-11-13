/**
 * @template T
 * @param {T | null | undefined} value
 * @param {string} invariant
 * @returns {T}
 */
export function requiredValue(value, invariant) {
  if (value === undefined || value === null) throw new Error(invariant);
  return value;
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
export function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
