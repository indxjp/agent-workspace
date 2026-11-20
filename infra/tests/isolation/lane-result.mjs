/**
 * The vocabulary every lane evaluation shares: the shape of one result, the prefix that marks a
 * security failure, and the helpers that read untyped JSON and errors safely. Nothing here does I/O.
 */

/** Marks a result that proves a denied destination was reached. */
export const SECURITY_PREFIX = 'SECURITY:';

/** @param {string} title @param {'pass'|'fail'|'inconclusive'|'n/a'} outcome @param {string} detail */
export const result = (title, outcome, detail) => ({ title, outcome, detail });

/** The message of anything that was thrown. */
export const message = (error) => (error instanceof Error ? error.message : String(error));

/** True for a plain JSON object (not null, not an array). */
export const isRecord = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** The result of a probe whose positive control failed, so nothing it measured can be trusted. */
export const blindResult = (title, reason) => result(title, 'inconclusive', reason);
