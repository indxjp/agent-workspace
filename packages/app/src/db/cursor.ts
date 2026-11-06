/**
 * The opaque `cursor` of a resource list (issue #1502), with the semantics of the platform's
 * list cursor (ADR-0079 D1, D3), re-implemented here because the app kit may not import server
 * code. Pure and Web-standard (`btoa`, `atob`, `TextEncoder`): it runs on Node and in a browser.
 *
 * On the wire a cursor is base64url of `{"v":1,"k":<list>,"w":<workspace id>,"t":<created_at>,
 * "i":<record id>}`; `k` is `<app>.<plural>` (a search names `<app>.<plural>:search`). It is read
 * back strictly: a cursor of another list or another workspace, a non-canonical encoding, an extra
 * key, a timestamp that is not an instant or an id that is not a UUID is refused, never read as
 * "start over". It is a position, not a capability: every page is still read through the
 * workspace scope and the access filter, so it carries no signature.
 */

/** Where a page starts: the `(created_at, id)` of the last record of the page before. */
export interface KeysetPosition {
  readonly createdAt: string;
  readonly id: string;
}

/** What reading a cursor gave: a position, or a refusal. */
export type CursorRead =
  { readonly ok: true; readonly position: KeysetPosition } | { readonly ok: false };

const CURSOR_VERSION = 1;
const CURSOR_KEYS = ['i', 'k', 't', 'v', 'w'] as const;
const BASE64URL = /^[A-Za-z0-9_-]+$/u;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{1,6}Z$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

function fromBase64Url(raw: string): string | undefined {
  if (!BASE64URL.test(raw) || raw.length % 4 === 1) return undefined;
  try {
    const binary = atob(raw.replaceAll('-', '+').replaceAll('_', '/'));
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    // Only the canonical spelling is accepted: an edited trailing character that decodes to the
    // same bytes is still a cursor this code did not mint.
    return toBase64Url(text) === raw ? text : undefined;
  } catch {
    return undefined;
  }
}

/** Whether `text` is a `created_at` as the stores print it, naming a real instant. */
export function isKeysetTimestamp(text: string): boolean {
  if (!TIMESTAMP.test(text) || text.startsWith('0000')) return false;
  const instant = new Date(`${text.slice(0, 19)}.000Z`);
  return (
    !Number.isNaN(instant.getTime()) && instant.toISOString().slice(0, 19) === text.slice(0, 19)
  );
}

/** The `nextCursor` of a page that ends at `position`, bound to one list of one workspace. */
export function encodeCursor(list: string, workspaceId: string, position: KeysetPosition): string {
  return toBase64Url(
    JSON.stringify({
      v: CURSOR_VERSION,
      k: list,
      w: workspaceId,
      t: position.createdAt,
      i: position.id,
    }),
  );
}

function hasExactlyCursorKeys(value: object): boolean {
  const keys = Object.keys(value).sort();
  return keys.length === CURSOR_KEYS.length && keys.every((key, at) => key === CURSOR_KEYS[at]);
}

function parsed(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Reads a `cursor` minted by {@link encodeCursor} for `list` in `workspaceId`, or refuses it. */
export function readCursor(raw: string, list: string, workspaceId: string): CursorRead {
  const text = fromBase64Url(raw);
  const value = text === undefined ? undefined : parsed(text);
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return { ok: false };
  if (!hasExactlyCursorKeys(value)) return { ok: false };
  const record = value as Record<string, unknown>;
  const { v, k, w, t, i } = record;
  if (v !== CURSOR_VERSION || k !== list || w !== workspaceId) return { ok: false };
  if (typeof t !== 'string' || !isKeysetTimestamp(t)) return { ok: false };
  if (typeof i !== 'string' || !UUID.test(i)) return { ok: false };
  return { ok: true, position: { createdAt: t, id: i } };
}
