/**
 * The deployment master key — spec §23: "The default implementation may encrypt values in
 * PostgreSQL using a deployment-level master key."
 *
 * ## Where the value comes from
 *
 * `MASTER_ENCRYPTION_KEY`, read from `.env.example`'s own comment: *"Spec §23's key for encrypting
 * stored secrets at rest … Generate with: `openssl rand -hex 32`."* That fixes the wire format
 * this module accepts — 64 lowercase-or-uppercase hex characters, decoding to exactly 32 bytes —
 * rather than this task inventing a second format `.env.example` does not describe. `.env.example`
 * itself is outside this task's `Owns:` globs; its comment currently
 * reads "NOT READ BY ANY CODE IN THIS REPOSITORY YET", which this module makes false, and that
 * staleness is declared on this task's PR rather than silently left for someone to trip over.
 *
 * ## The one property this file exists to guarantee
 *
 * **The master key's absence, or its being unusable, is a startup failure — never a fallback to
 * storing plaintext, and never a fallback to a generated or default key.** `loadMasterKey` is a
 * positive assertion in the ADR-0015 shape: a key is returned because the environment variable was
 * present, decoded as hex, and was exactly 32 bytes — never because nothing about it looked wrong.
 * Every rejection is a thrown, named `Error`; there is no branch that returns a degraded value.
 *
 * `packages/core/src/secrets/service.ts` calls this **before** it does anything else — before it
 * opens a database connection, before it answers any request — so that a deployment with no master
 * key fails at construction time ("startup"), not on the first secret a caller happens to touch.
 * `master-key.test.ts` asserts this function's own rejections in isolation (missing, blank,
 * non-hex, wrong length); `service.test.ts` is what asserts the subsystem-construction claim —
 * that `createSecretsService` with no key throws before any database connection is attempted.
 */
import { createHash } from 'node:crypto';

/** AES-256 key length, in bytes. */
const MASTER_KEY_BYTES = 32;

/** The environment variable this module reads. Named once, so an error message cannot drift. */
export const MASTER_KEY_ENV_VAR = 'MASTER_ENCRYPTION_KEY';

/** A validated master key: the raw key bytes, and a non-secret id that names which key this is. */
export interface MasterKey {
  /** The 32-byte AES-256 key. Never logged, never serialised, never returned from a route. */
  readonly key: Buffer;
  /**
   * A stable, non-secret fingerprint of {@link key} — the first 16 hex characters of its SHA-256
   * digest. This is what `secrets.master_key_id` records: it lets a later read notice that the
   * configured master key is not the one that wrapped a given row's data key (a rotation in
   * progress, or a misconfigured deployment) and refuse cleanly, rather than attempting AES-GCM
   * with the wrong key and reporting a generic authentication failure. It is derived from the key
   * rather than separately configured, so there is no second variable to forget to set.
   */
  readonly id: string;
}

function describe(value: unknown): string {
  if (value === undefined) return 'unset';
  if (value === null) return 'null';
  if (typeof value === 'string') return value.trim() === '' ? 'blank' : 'a string';
  return `a ${typeof value}`;
}

/** SHA-256 of `key`, first 16 hex characters. A fingerprint, not a secret — see {@link MasterKey.id}. */
function fingerprint(key: Buffer): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 16);
}

/** Validate a hex-encoded AES-256 key obtained from a named configuration boundary. */
export function parseMasterKeyHex(raw: unknown, source: string): MasterKey {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new Error(
      `${source} is ${describe(raw)}. The secrets subsystem refuses to start without a ` +
        'deployment master key — there is no fallback to storing values unencrypted.',
    );
  }
  const trimmed = raw.trim();
  if (!/^[0-9a-fA-F]+$/.test(trimmed)) {
    throw new Error(`${source} is not hex-encoded (it contains a character outside 0-9a-fA-F).`);
  }
  if (trimmed.length !== MASTER_KEY_BYTES * 2) {
    throw new Error(
      `${source} decodes to ${String(trimmed.length / 2)} bytes; AES-256 requires exactly ` +
        `${String(MASTER_KEY_BYTES)}.`,
    );
  }
  const key = Buffer.from(trimmed, 'hex');
  if (key.length !== MASTER_KEY_BYTES) {
    throw new Error(
      `${source} decoded to ${String(key.length)} bytes, not ${String(MASTER_KEY_BYTES)}.`,
    );
  }
  return { key, id: fingerprint(key) };
}

/**
 * Construct a master key from bytes already authenticated by a provider.
 *
 * The copy prevents a cloud SDK's response buffer from being retained and later mutated by its
 * owner. Rejections deliberately describe only the byte count: provider ciphertext and plaintext
 * never belong in an error or log line.
 */
export function masterKeyFromBytes(value: Uint8Array): MasterKey {
  const key = Buffer.from(value);
  if (key.length !== MASTER_KEY_BYTES) {
    throw new Error(
      `The master-key provider returned ${String(key.length)} bytes; AES-256 requires exactly ` +
        `${String(MASTER_KEY_BYTES)}.`,
    );
  }
  return { key, id: fingerprint(key) };
}

/**
 * Read and validate the deployment master key from the environment. Throws, with a named reason,
 * rather than returning anything when the key is missing or malformed.
 *
 * Every rejection names {@link MASTER_KEY_ENV_VAR} and never echoes the value: an error message
 * that quoted a malformed key would put a partial secret in a log line, which is exactly what §23
 * exists to prevent.
 */
export function loadMasterKey(
  env: Readonly<Record<string, string | undefined>> = process.env,
): MasterKey {
  try {
    return parseMasterKeyHex(env[MASTER_KEY_ENV_VAR], MASTER_KEY_ENV_VAR);
  } catch (error) {
    const message = error instanceof Error ? error.message : `${MASTER_KEY_ENV_VAR} is invalid.`;
    throw new Error(`${message} Generate one with: openssl rand -hex 32`, { cause: error });
  }
}
