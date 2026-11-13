/**
 * The PostgreSQL schema an app's data lives in, `app_<name>` (F-10), and the identifiers derived
 * from it. Pure: the in-memory store and the generators use it without a database.
 */
import { NAME_KEY_PATTERN } from '@indx-workspace/contracts/project-file';

import { IDENTIFIER_MAX } from '../names.js';

const SCHEMA_PREFIX = 'app_';

/**
 * The schema of the app named `appName` (a lower-case kebab name key, `service-desk`), with its
 * hyphens as underscores: `app_service_desk`.
 *
 * @throws {RangeError} when `appName` is not a name key that fits a 63-byte identifier, so nothing
 *   unvalidated is ever spliced into SQL.
 */
export function appSchemaName(appName: string): string {
  if (!NAME_KEY_PATTERN.test(appName) || appName.length > IDENTIFIER_MAX - SCHEMA_PREFIX.length) {
    throw new RangeError(
      `an app name is lower-case kebab of at most ${String(IDENTIFIER_MAX - SCHEMA_PREFIX.length)} characters`,
    );
  }
  return `${SCHEMA_PREFIX}${appName.replaceAll('-', '_')}`;
}

/** FNV-1a over the name, as 8 hex digits: a stable tag for a shortened identifier. */
function hashOf(text: string): string {
  let hash = 0x811c9dc5;
  for (const char of text) {
    hash ^= char.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/**
 * A constraint or index name, `<table>_<suffix>`. When that would pass the identifier limit (which
 * PostgreSQL truncates silently, so two long names could collide), the table part is shortened and
 * tagged with a hash of the full name.
 */
export function derivedIdentifier(table: string, suffix: string): string {
  const full = `${table}_${suffix}`;
  if (full.length <= IDENTIFIER_MAX) return full;
  const tag = hashOf(full);
  const room = IDENTIFIER_MAX - suffix.length - tag.length - 2;
  return `${table.slice(0, Math.max(room, 1))}_${tag}_${suffix}`.slice(0, IDENTIFIER_MAX);
}
