import { z } from 'zod';

/**
 * RFC 9562 canonical textual form, any version. Every resource id the control plane issues is a
 * `uuid` column, so a path or body id is parsed before it is looked up — never passed through to a
 * store to see what happens.
 */
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

/** A resource identifier as the API mints it. */
export const UuidSchema = z.string().regex(UUID_PATTERN, 'must be a UUID');

/**
 * An ISO-8601 instant as every response renders it: persistence `Date` values cross the wire as
 * strings, never as epoch numbers.
 */
export const IsoDateTimeSchema = z.iso.datetime();
