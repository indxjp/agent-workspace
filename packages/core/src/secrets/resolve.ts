/**
 * Reading a secret's **envelope** — the one place in this subsystem that is allowed to see
 * ciphertext, and the reason it is its own file rather than a method on `repository.ts`.
 *
 * `repository.ts`'s `SecretsRepository` is what `apps/web/app/api/secrets/**` calls, directly or
 * through `service.ts`'s write-facing methods, and nothing on it can produce an envelope — the
 * type doesn't have the fields. This module exists for the caller the Wave 2 plan names
 * explicitly: *"Other subsystems resolve a secret by reference server-side. W2-CP-05 (connectors)
 * will consume you through that server-side path."* A connector's "Test Connection" needs the
 * actual credential value; nothing reachable from an HTTP route ever does.
 *
 * ## The separation this buys, stated so it can be checked rather than trusted
 *
 * * **No non-allow-listed file under `apps/web/app/api/secrets/**` or `apps/web/server/secrets/**`
 *   can import its way to a live secrets service — directly, or through any chain of hops.**
 *   `apps/web/server/secrets/resolve-isolation.test.ts` asserts this with the compiler, not a text
 *   match: it resolves every static and literal-argument-dynamic import/require specifier in those
 *   two directories with `ts.resolveModuleName`, then walks the resolved graph **transitively**,
 *   following every **value** edge (a `type`-only one is erased before anything runs) until it
 *   either reaches this package or leaves the set of files worth following, and fails by name on
 *   any root outside an explicit allow-list (`memory-store.ts` and test files) whose chain reaches
 *   it. Verification round 2 found the first version of that gate — `text.includes`, checked for
 *   the literal identifier `resolveByName` — walked past by a route that built the identifier at
 *   run time and imported `createSecretsService` directly (ADR-0030). Verification round 3 found
 *   the *fix* for that — a one-hop compiler check — walked past by re-exporting
 *   `createSecretsService` from the allow-listed `memory-store.ts` and importing it from there
 *   instead; the walk is transitive precisely because that gap is not an adversarial edge case, it
 *   is an ordinary refactor. That gate's own header states what it still cannot decide: a property
 *   access on a value some *other* file already holds, an unrecognised alias of `require`, and a
 *   chain that only completes inside a third-party package under `node_modules`.
 * * **The return type carries plaintext.** `ResolvedSecret.value` is a `Buffer`. Nothing here
 *   serialises it, logs it, or hands it to `JSON.stringify` — callers are trusted with it in the
 *   same sense `apps/runner`'s own environment variables are: this is the one function meant to
 *   see a secret value, on the server, for the purpose spec §23 names ("the runtime receives only
 *   the secrets required by that particular agent").
 *
 * Like `repository.ts`, this reads `../db/**` by relative path from inside the package that owns
 * the database layer — permitted, and for the same reason; see `repository.ts`'s header.
 */
import { and, eq } from 'drizzle-orm';

import type { Database } from '../db/client.js';
import { secrets } from '../db/schema/secrets.js';
import { requireWorkspaceScope, type WorkspaceScope } from '../db/repositories/scope.js';
import { openSecret, type SecretEnvelope } from './envelope.js';
import type { MasterKey } from './master-key.js';

/** A secret, fully decrypted. Handle it the way any credential deserves: never log it, never
 * echo it, never put it anywhere that ends up in an HTTP response. */
export interface ResolvedSecret {
  readonly name: string;
  readonly value: Buffer;
}

/** The one column set this module reads that `repository.ts` never does: every envelope column. */
const ENVELOPE_COLUMNS = {
  name: secrets.name,
  algorithm: secrets.algorithm,
  masterKeyId: secrets.masterKeyId,
  wrappedDataKey: secrets.wrappedDataKey,
  wrappedDataKeyNonce: secrets.wrappedDataKeyNonce,
  wrappedDataKeyTag: secrets.wrappedDataKeyTag,
  ciphertext: secrets.ciphertext,
  ciphertextNonce: secrets.ciphertextNonce,
  ciphertextTag: secrets.ciphertextTag,
} as const;

/**
 * Read one secret's envelope by name, scoped to `scope`'s workspace, and decrypt it.
 *
 * Answers `null` for a name this workspace has no secret under — including a name that exists in
 * a *different* workspace, the same "not found rather than forbidden" choice `agents.ts` makes,
 * for the same reason: reporting "forbidden" would confirm the name exists somewhere.
 *
 * Propagates {@link ../secrets/envelope.js!MasterKeyMismatchError} and any AES-GCM authentication
 * failure rather than catching either — a resolution that cannot verify the value it read must not
 * hand back a guess about what that value was (ADR-0015).
 */
export async function resolveSecretByName(
  db: Database,
  scope: WorkspaceScope,
  masterKey: MasterKey,
  name: string,
): Promise<ResolvedSecret | null> {
  const checked = requireWorkspaceScope(scope, 'resolveSecretByName');
  const rows = await db
    .select(ENVELOPE_COLUMNS)
    .from(secrets)
    .where(and(eq(secrets.workspaceId, checked.workspaceId), eq(secrets.name, name)))
    .limit(1);
  const row = rows[0];
  if (row === undefined) return null;

  const envelope: SecretEnvelope = {
    algorithm: row.algorithm,
    masterKeyId: row.masterKeyId,
    wrappedDataKey: row.wrappedDataKey,
    wrappedDataKeyNonce: row.wrappedDataKeyNonce,
    wrappedDataKeyTag: row.wrappedDataKeyTag,
    ciphertext: row.ciphertext,
    ciphertextNonce: row.ciphertextNonce,
    ciphertextTag: row.ciphertextTag,
  };
  return { name: row.name, value: openSecret(masterKey, envelope) };
}
