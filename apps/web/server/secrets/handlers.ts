/**
 * The three secret operations this task ships, as functions of a store and a parsed body — spec
 * §23, §26. Nothing here touches `Request` or `Response`; see `apps/web/server/agents/handlers.ts`
 * for why that split exists.
 *
 * ## The three, and only the three (spec §23's "write-only" rule)
 *
 *   POST   /api/secrets        {@link createSecret}
 *   GET    /api/secrets        {@link listSecrets}
 *   PUT    /api/secrets/:id    {@link replaceSecret}
 *   DELETE /api/secrets/:id    {@link deleteSecret}
 *
 * There is no `GET /api/secrets/:id`. That is not an oversight this file works around; it is the
 * whole of what "write-only" means as a route surface. §34 lists no secrets route at all (its
 * introductory word is "Examples", not the closed set — ADR-0026), so all three carry a `mandate`
 * in `tests/route-declarations/W2-CP-02.ts` citing §23.
 *
 * Every value returned below is built from {@link toSecretResource}, whose input type
 * (`SecretRecord` / `SecretMetadata`) has no field a ciphertext, a nonce, a tag or a wrapped data
 * key could occupy — the same "the type cannot hold it" property the schema and the repository
 * layer use. This file could not accidentally return a value if it tried to.
 */
import { formatInUseReferrer, type InUseReferrer } from '@indx-workspace/contracts';

import {
  isStorageConnectionSecretName,
  isUuid,
  isWebhookSigningSecretName,
  parseCreateSecretBody,
  parseReplaceSecretBody,
  storageConnectionIdOf,
  toSecretResource,
  type SecretResource,
} from './contract';
import type { SecretReferrers, WorkspaceSecretsStore } from './store';
import { problem, type ApiResult } from '../http/result';

/** Validate a path id before it reaches the store. `secrets.id` is a `uuid` column. */
export function requireSecretId(
  raw: unknown,
): { ok: true; id: string } | { ok: false; result: ApiResult } {
  if (isUuid(raw)) return { ok: true, id: raw };
  return {
    ok: false,
    result: problem(400, 'invalid_secret_id', 'The secret id in the path is not a UUID.'),
  };
}

/** `POST /api/secrets` — 201 with the created secret's metadata (never its value), or 400 / 409. */
export async function createSecret(
  store: WorkspaceSecretsStore,
  rawBody: unknown,
): Promise<ApiResult> {
  const parsed = parseCreateSecretBody(rawBody);
  if (!parsed.ok) {
    return problem(
      400,
      'invalid_body',
      'The secret could not be created from this body.',
      parsed.errors,
    );
  }
  // A bare credential under a connection's name would never be bound to the connection's URL.
  if (isStorageConnectionSecretName(parsed.value.name)) {
    return problem(
      409,
      'secret_name_conflict',
      'Secret names starting with STORAGE_CONNECTION_ are reserved for storage-connection credentials. Create the connection with POST /api/storage-connections.',
    );
  }
  // A webhook's signing secret is minted by `POST /api/webhooks` and only ever written there.
  if (isWebhookSigningSecretName(parsed.value.name)) {
    return problem(
      409,
      'secret_name_conflict',
      'Secret names of the form WEBHOOK_<id>_SIGNING_SECRET are reserved for webhook signing secrets. Create the webhook with POST /api/webhooks.',
    );
  }
  const outcome = await store.create({
    name: parsed.value.name,
    value: Buffer.from(parsed.value.value, 'utf8'),
  });
  switch (outcome.kind) {
    case 'created':
      return { status: 201, body: toSecretResource(outcome.secret) };
    case 'name-conflict':
      return problem(
        409,
        'secret_name_conflict',
        `This workspace already has a secret named ${JSON.stringify(outcome.name)}.`,
      );
    default: {
      const unreachable: never = outcome;
      return problem(
        500,
        'unhandled_store_outcome',
        `The store returned an outcome this route does not handle: ${JSON.stringify(unreachable)}.`,
      );
    }
  }
}

/**
 * `GET /api/secrets` — 200 with this workspace's secret **metadata**. §23's whole point: this
 * array never carries a `value` field, for any secret, under any circumstance.
 */
export async function listSecrets(
  store: WorkspaceSecretsStore,
  name?: string | null,
): Promise<ApiResult> {
  const secrets = await store.list();
  // ADR-0114 S4: `?name=` narrows the list to the exact name, and a name that matches nothing
  // answers the family's `404 secret_not_found`.
  const named = name == null ? secrets : secrets.filter((secret) => secret.name === name);
  if (named.length === 0 && name != null) return secretNotFound();
  const items: SecretResource[] = named.map(toSecretResource);
  return { status: 200, body: { secrets: items } };
}

/**
 * `PUT /api/secrets/:id` — replace (rotate) a secret's value. 200 with the updated metadata, or
 * 400 / 404. The name is immutable through this route; `contract.ts`'s `parseReplaceSecretBody`
 * rejects a body that tries to send one.
 */
export async function replaceSecret(
  store: WorkspaceSecretsStore,
  rawId: unknown,
  rawBody: unknown,
): Promise<ApiResult> {
  const id = requireSecretId(rawId);
  if (!id.ok) return id.result;
  const parsed = parseReplaceSecretBody(rawBody);
  if (!parsed.ok) {
    return problem(
      400,
      'invalid_body',
      'The secret could not be replaced from this body.',
      parsed.errors,
    );
  }
  const reserved = await reservedSecret(store, id.id);
  if (reserved !== null) return reserved;
  const outcome = await store.replace(id.id, Buffer.from(parsed.value.value, 'utf8'));
  switch (outcome.kind) {
    case 'replaced':
      return { status: 200, body: toSecretResource(outcome.secret) };
    case 'not-found':
      return secretNotFound();
    case 'in-use':
      return problem(
        409,
        'secret_in_use',
        'This secret is the credential of a storage connection. Rotate it with PUT /api/storage-connections/:id/credential.',
        secretReferrerDetails(outcome.referrers),
      );
    default: {
      const unreachable: never = outcome;
      return problem(
        500,
        'unhandled_store_outcome',
        `The store returned an outcome this route does not handle: ${JSON.stringify(unreachable)}.`,
      );
    }
  }
}

/**
 * `DELETE /api/secrets/:id` — 204 once the secret is gone, `409 secret_in_use` naming every
 * connector and model connection that still references it (ADR-0077), or 400 / 404. The value is
 * never read, so nothing about it can be echoed.
 */
export async function deleteSecret(
  store: WorkspaceSecretsStore,
  rawId: unknown,
): Promise<ApiResult> {
  const id = requireSecretId(rawId);
  if (!id.ok) return id.result;
  // A storage connection's credential is refused by the store while its connection exists; an
  // orphan (left by a failed connection delete) can be removed, which sends no credential anywhere.
  const outcome = await store.remove(id.id);
  switch (outcome.kind) {
    case 'deleted':
      return { status: 204, body: null };
    case 'not-found':
      return secretNotFound();
    case 'in-use':
      return problem(
        409,
        'secret_in_use',
        'This secret is still referenced. Remove or re-point every referrer in details, then retry.',
        secretReferrerDetails(outcome.referrers),
      );
    default: {
      const unreachable: never = outcome;
      return problem(
        500,
        'unhandled_store_outcome',
        `The store returned an outcome this route does not handle: ${JSON.stringify(unreachable)}.`,
      );
    }
  }
}

/**
 * `409 secret_in_use` for replacing a storage connection's credential, whether or not the
 * connection still exists: only `/api/storage-connections` writes one, bound to the connection's
 * URL. The same for a webhook's signing secret, which only `/api/webhooks` writes. `null` for any
 * other secret.
 */
async function reservedSecret(store: WorkspaceSecretsStore, id: string): Promise<ApiResult | null> {
  const secret = (await store.list()).find((row) => row.id === id);
  if (secret === undefined) return null;
  // A webhook's signing secret is rotated by removing and re-creating the webhook (ADR D1), never
  // here: a value written here could be one the platform cannot sign with.
  if (isWebhookSigningSecretName(secret.name)) {
    return problem(
      409,
      'secret_in_use',
      'This secret is reserved for a webhook signing secret. Rotate it by removing and re-creating the webhook with /api/webhooks.',
    );
  }
  if (!isStorageConnectionSecretName(secret.name)) return null;
  const connectionId = storageConnectionIdOf(secret.name);
  return problem(
    409,
    'secret_in_use',
    'This secret is reserved for a storage connection credential. Rotate it with PUT /api/storage-connections/:id/credential.',
    secretReferrerDetails({
      connectorIds: [],
      modelConnectionIds: [],
      storageConnectionIds: connectionId === null ? [] : [connectionId],
    }),
  );
}

function secretReferrerDetails(referrers: SecretReferrers): readonly string[] {
  const all: InUseReferrer[] = [
    ...referrers.connectorIds.map((id) => ({ kind: 'connector' as const, id })),
    ...referrers.modelConnectionIds.map((id) => ({ kind: 'model-connection' as const, id })),
    ...referrers.storageConnectionIds.map((id) => ({ kind: 'storage-connection' as const, id })),
  ];
  return all.map(formatInUseReferrer);
}

/**
 * The one 404 the secrets routes emit. Deliberately does not distinguish "no such secret" from
 * "a secret you cannot see" — the same choice `agents/handlers.ts` makes, for the same reason.
 */
export function secretNotFound(): ApiResult {
  return problem(404, 'secret_not_found', 'This workspace has no secret with that id or name.');
}
