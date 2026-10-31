/**
 * The wire contract for the secrets routes — spec §23, §26 — and the reason it is hand-written
 * TypeScript rather than a shared Zod schema.
 *
 * `apps/web/server/agents/contract.ts`'s header gives the reason and it applies unchanged here:
 * `zod` and `@agent-workspace/core`'s Zod schemas are not something this file reaches for, because
 * a **value** import of core from a module `apps/web/instrumentation.ts` can reach transitively
 * would drag `pg` and `node:crypto`'s heavier surface into the edge bundle Next.js also compiles
 * this file for. See `apps/web/server/agents/store.ts`'s header for the measured failure that
 * caused (`docs/adr/W1-CP-05-agents-api-has-no-core-dependency.md` records the original reasoning).
 * This module imports nothing from `@agent-workspace/core/secrets` at all, type or value. Its one
 * value import is the browser-safe `@indx-workspace/contracts/secret-reference`, for the storage
 * connection secret prefix every check shares.
 *
 * That is narrower than a claim about the whole directory, on purpose — verification round 2 (F5)
 * found an earlier version of this paragraph asserting the wider one, and it was false:
 * `memory-store.ts` and `no-audit-row.test.ts` both import `@agent-workspace/core/secrets` as a
 * **value**, deliberately (`memory-store.ts`'s own header says so — it exists to wrap the real
 * service for tests). What *is* true of every file reachable from a route —
 * `store.ts`, `runtime.ts`, `http.ts`, `handlers.ts`, this file, and both route files — is that
 * none of them holds a value import into that package; where `store.ts` needs the package's
 * *types* it says `import type`, and `apps/web/server/secrets/resolve-isolation.test.ts` checks
 * that boundary with the compiler rather than leaving it as a sentence here.
 *
 * `SECRET_NAME_PATTERN` is transcribed from `packages/core/src/db/schema/secrets.ts`'s
 * `secrets_name_shape` CHECK, not invented: `^[A-Z][A-Z0-9_]{0,127}$`. Matching it here means a
 * malformed name is a `400` naming the rule, rather than a `500` from a constraint violation the
 * caller cannot interpret.
 */

import {
  isStorageConnectionSecretName,
  STORAGE_CONNECTION_SECRET_PREFIX,
} from '@indx-workspace/contracts/secret-reference';

/** A parse either produced a value, or the reasons it could not. Never both, never neither. */
export type ParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly errors: readonly string[] };

/** Transcribed from `secrets_name_shape` in `packages/core/src/db/schema/secrets.ts`. */
export const SECRET_NAME_PATTERN = /^[A-Z][A-Z0-9_]{0,127}$/;

/**
 * Every storage connection's credential is named with this prefix and written only through
 * `/api/storage-connections`, which binds it to the connection's URL. The generic secrets routes
 * refuse to create or replace any name that carries it, and delete one only when no connection
 * owns it. The contracts define the prefix once, for every check that reads it.
 */
export { isStorageConnectionSecretName, STORAGE_CONNECTION_SECRET_PREFIX };

/**
 * A webhook's signing secret (ADR-SDK-18-N3-250 D1) is named `WEBHOOK_<id without dashes,
 * upper-case>_SIGNING_SECRET` and written only by `/api/webhooks`, at create. It is the key the
 * platform signs `run.*` events with, so whoever reads it can forge them: a tool, a connector
 * identity or a tool endpoint never resolves one, and the generic secrets routes refuse to create
 * or replace one (rotation is remove and create). Only that exact shape is reserved, so a
 * workspace's own `WEBHOOK_STRIPE_SIGNING_SECRET` stays an ordinary secret.
 */
const WEBHOOK_SIGNING_SECRET = /^WEBHOOK_[0-9A-F]{32}_SIGNING_SECRET$/u;

/** The secret name a webhook's signing secret is stored under (ADR D1). */
export function webhookSigningSecretName(webhookId: string): string {
  return `WEBHOOK_${webhookId.replaceAll('-', '').toUpperCase()}_SIGNING_SECRET`;
}

/** True when `name` is the shape {@link webhookSigningSecretName} produces. */
export function isWebhookSigningSecretName(name: string): boolean {
  return WEBHOOK_SIGNING_SECRET.test(name);
}

/**
 * True for a credential the platform owns: a storage connection's or a webhook's signing secret.
 * Such a secret is never handed to a run, whatever the tool or connector declares.
 */
export function isPlatformOwnedSecretName(name: string): boolean {
  return isStorageConnectionSecretName(name) || isWebhookSigningSecretName(name);
}

const STORAGE_CONNECTION_SECRET = new RegExp(
  `^${STORAGE_CONNECTION_SECRET_PREFIX}([0-9A-F]{8})([0-9A-F]{4})([0-9A-F]{4})([0-9A-F]{4})([0-9A-F]{12})$`,
  'u',
);

/** The connection id a secret name stands for, or `null` for any other name. */
export function storageConnectionIdOf(secretName: string): string | null {
  const parts = STORAGE_CONNECTION_SECRET.exec(secretName)?.slice(1);
  return parts === undefined ? null : parts.join('-').toLowerCase();
}

/**
 * The largest plaintext value this route accepts, in UTF-16 code units.
 *
 * Chosen, not derived from a column — `secrets.ciphertext` is unbounded `bytea`. 64 KiB is
 * generous for a credential or token (a PEM-encoded private key is a few KiB) and small enough
 * that a request could not use this route to store an arbitrary blob, which is not what §23's
 * "secrets" are for. Recorded here rather than left implicit, per ADR-0016's spirit: a bound that
 * exists only in a reviewer's head is not a bound anyone can check.
 */
export const SECRET_VALUE_MAX_LENGTH = 64 * 1024;

/** One secret's metadata as JSON. There is no `value` field on this type — see this file's header. */
export interface SecretResource {
  readonly id: string;
  readonly name: string;
  readonly algorithm: string;
  readonly masterKeyId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** `POST /api/secrets`. */
export interface CreateSecretBody {
  readonly name: string;
  readonly value: string;
}

/** `PUT /api/secrets/:id`. The name is immutable through this route — see `store.ts`. */
export interface ReplaceSecretBody {
  readonly value: string;
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  const type = typeof value;
  if (type === 'string') return 'a string';
  if (type === 'object') return 'an object';
  return `a ${type}`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function hasKey(body: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(body, key);
}

/** `secrets.name`: uppercase, digits and underscores, starting with a letter, 1-128 characters. */
export function parseSecretName(raw: unknown): ParseResult<string> {
  if (typeof raw !== 'string') {
    return { ok: false, errors: [`name must be a string; received ${describe(raw)}.`] };
  }
  if (!SECRET_NAME_PATTERN.test(raw)) {
    return {
      ok: false,
      errors: [
        'name must be uppercase letters, digits and underscores, starting with a letter, at ' +
          `most 128 characters (e.g. ANTHROPIC_API_KEY); received ${JSON.stringify(raw)}.`,
      ],
    };
  }
  return { ok: true, value: raw };
}

/** `secrets.*` value columns, from the caller's side: a non-empty string, within the bound. */
export function parseSecretValue(raw: unknown): ParseResult<string> {
  if (typeof raw !== 'string') {
    return { ok: false, errors: [`value must be a string; received ${describe(raw)}.`] };
  }
  if (raw.length === 0) {
    return { ok: false, errors: ['value must not be empty.'] };
  }
  if (raw.length > SECRET_VALUE_MAX_LENGTH) {
    return {
      ok: false,
      errors: [
        `value must be at most ${String(SECRET_VALUE_MAX_LENGTH)} characters; received ${String(raw.length)}.`,
      ],
    };
  }
  return { ok: true, value: raw };
}

const CREATE_FIELDS = ['name', 'value'] as const;

/** `POST /api/secrets` — both fields required. */
export function parseCreateSecretBody(raw: unknown): ParseResult<CreateSecretBody> {
  if (!isPlainObject(raw)) {
    return {
      ok: false,
      errors: [`the request body must be a JSON object; received ${describe(raw)}.`],
    };
  }
  const errors: string[] = [];
  for (const key of Object.keys(raw)) {
    if (!(CREATE_FIELDS as readonly string[]).includes(key)) {
      errors.push(`${key} is not a field of this request; expected name, value.`);
    }
  }
  const name = parseSecretName(raw['name']);
  if (!name.ok) errors.push(...name.errors);
  const value = parseSecretValue(raw['value']);
  if (!value.ok) errors.push(...value.errors);
  if (errors.length > 0) return { ok: false, errors };
  if (!name.ok || !value.ok) {
    // Unreachable — kept for the same reason `agents/contract.ts` keeps its equivalent: the accept
    // path is reached only after every field is known good, never after a type assertion.
    return { ok: false, errors: ['the request body could not be parsed.'] };
  }
  return { ok: true, value: { name: name.value, value: value.value } };
}

const REPLACE_FIELDS = ['value'] as const;

/** `PUT /api/secrets/:id` — only `value`. Sending `name` here is a 400, not a silent no-op rename. */
export function parseReplaceSecretBody(raw: unknown): ParseResult<ReplaceSecretBody> {
  if (!isPlainObject(raw)) {
    return {
      ok: false,
      errors: [`the request body must be a JSON object; received ${describe(raw)}.`],
    };
  }
  const errors: string[] = [];
  for (const key of Object.keys(raw)) {
    if (!(REPLACE_FIELDS as readonly string[]).includes(key)) {
      errors.push(
        `${key} is not a field of this request; expected value. A secret's name cannot be ` +
          'changed through this route.',
      );
    }
  }
  if (!hasKey(raw, 'value')) errors.push('value is required.');
  const value = hasKey(raw, 'value') ? parseSecretValue(raw['value']) : null;
  if (value !== null && !value.ok) errors.push(...value.errors);
  if (errors.length > 0) return { ok: false, errors };
  if (value === null || !value.ok) {
    return { ok: false, errors: ['the request body could not be parsed.'] };
  }
  return { ok: true, value: { value: value.value } };
}

/** One secret's metadata as {@link SecretMetadata} (see `store.ts`), serialised for the wire. */
export function toSecretResource(secret: {
  readonly id: string;
  readonly name: string;
  readonly algorithm: string;
  readonly masterKeyId: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}): SecretResource {
  return {
    id: secret.id,
    name: secret.name,
    algorithm: secret.algorithm,
    masterKeyId: secret.masterKeyId,
    createdAt: secret.createdAt.toISOString(),
    updatedAt: secret.updatedAt.toISOString(),
  };
}

/**
 * The canonical textual form of a UUID, any version. Transcribed from
 * `apps/web/server/agents/contract.ts` — `secrets.id` is the same column shape.
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}
