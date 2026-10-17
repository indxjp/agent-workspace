/**
 * The opaque `cursor` / `nextCursor` of `GET /api/sessions` and `GET /api/audit-events` (S-5,
 * ADR-0079).
 *
 * On the wire a cursor is base64url of `{"v":1,"k":<list>,"w":<workspace id>,"t":<created_at>,
 * "i":<row id>}`. Clients must treat it as opaque; the server reads it back strictly:
 *
 * - **Tenant-bound.** `w` must equal the workspace `authorise` (or the session gate) verified for
 *   this request, and `k` must name this list. A cursor minted for another workspace, or for the
 *   other list, is `400 invalid_cursor` — never quietly re-read as a position in this one.
 * - **Tamper-evident as far as the text goes.** The encoding must be canonical base64url, the JSON
 *   an object with exactly those five keys, `t` a timestamp in the exact shape the store prints and
 *   `i` a UUID. Anything else is `400 invalid_cursor`, never "start over" (ADR-0015).
 *
 * It is a position, not a capability: every page is still read through the caller's workspace
 * scope and visibility filter, so an edited-but-well-formed cursor can only move a caller within
 * rows it may already read. That is why it carries no signature.
 */
import type { KeysetPosition } from '@agent-workspace/core/db';

import { isUuid } from '../runs/http';
import { isKeysetTimestamp } from './keyset-timestamp';

/** The lists whose cursors this module mints. A cursor of one is refused by the other. */
export type ListCursorKind = 'sessions' | 'audit-events';

const CURSOR_VERSION = 1;
const CURSOR_KEYS = ['i', 'k', 't', 'v', 'w'] as const;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

/** What `nextCursor` a page renders for `position`, bound to one list of one workspace. */
export function encodeListCursor(
  kind: ListCursorKind,
  workspaceId: string,
  position: KeysetPosition,
): string {
  return Buffer.from(
    JSON.stringify({
      v: CURSOR_VERSION,
      k: kind,
      w: workspaceId,
      t: position.createdAt,
      i: position.id,
    }),
    'utf8',
  ).toString('base64url');
}

export type ListCursorRead =
  | { readonly kind: 'absent' }
  | { readonly kind: 'ok'; readonly position: KeysetPosition }
  | { readonly kind: 'invalid'; readonly reason: string };

function invalid(reason: string): ListCursorRead {
  return { kind: 'invalid', reason };
}

function decodeJson(raw: string): unknown {
  // `Buffer.from(…, 'base64url')` never throws: it skips what it cannot read. So the text is
  // checked against the alphabet and must re-encode to itself, or an edited byte would decode to
  // some other, still-plausible cursor.
  if (!BASE64URL.test(raw)) return undefined;
  const bytes = Buffer.from(raw, 'base64url');
  if (bytes.toString('base64url') !== raw) return undefined;
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    return undefined;
  }
}

function hasExactlyCursorKeys(value: object): boolean {
  const keys = Object.keys(value).sort();
  return keys.length === CURSOR_KEYS.length && keys.every((key, at) => key === CURSOR_KEYS[at]);
}

/**
 * Read a `cursor` query parameter for `kind` in `workspaceId`. `null` (absent) is the first page;
 * every present value is either a position this list minted for this workspace or refused.
 */
export function readListCursor(
  raw: string | null,
  kind: ListCursorKind,
  workspaceId: string,
): ListCursorRead {
  if (raw === null) return { kind: 'absent' };
  const value = decodeJson(raw);
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return invalid('the cursor is not one this server minted.');
  }
  if (!hasExactlyCursorKeys(value)) return invalid('the cursor is not one this server minted.');
  const record = value as Record<string, unknown>;
  if (record['v'] !== CURSOR_VERSION) return invalid('the cursor is from an unknown version.');
  if (record['k'] !== kind || record['w'] !== workspaceId) {
    return invalid('the cursor was minted for another list or another workspace.');
  }
  const createdAt = record['t'];
  const id = record['i'];
  if (typeof createdAt !== 'string' || !isKeysetTimestamp(createdAt) || !isUuid(id)) {
    return invalid('the cursor is not one this server minted.');
  }
  return { kind: 'ok', position: { createdAt, id } };
}
