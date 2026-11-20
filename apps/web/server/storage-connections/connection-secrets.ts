import type { StorageConnectionCredential } from '@indx-workspace/contracts/storage-connections';
import type { SecretsService } from '@agent-workspace/core/secrets';

import { STORAGE_CONNECTION_SECRET_PREFIX } from '../secrets';
import { log } from '../telemetry/logger';
import { sealedCredential, storedCredential } from './credential-codec';

// @story US-STO-12
export function storageConnectionSecretName(id: string): string {
  return `${STORAGE_CONNECTION_SECRET_PREFIX}${id.replace(/-/g, '').toUpperCase()}`;
}

type WorkspaceScope = Parameters<SecretsService['list']>[0];

/** The workspace's secrets: what the connection secret helpers act on. */
export type SecretsContext = {
  readonly secrets: SecretsService;
  readonly scope: WorkspaceScope;
};

/** A credential to store: the connection it belongs to, the URL it is bound to, and its value. */
export type CredentialWrite = {
  readonly id: string;
  readonly url: string;
  readonly credential: StorageConnectionCredential;
  /** Write only while the stored value is still exactly these bytes. */
  readonly onlyOver?: Buffer;
};

export async function credentialNames({ secrets, scope }: SecretsContext) {
  return new Set((await secrets.list(scope)).map((secret) => secret.name));
}

export async function findSecret({ secrets, scope }: SecretsContext, id: string) {
  const name = storageConnectionSecretName(id);
  return (await secrets.list(scope)).find((secret) => secret.name === name);
}

/**
 * Store the credential, bound to its URL, as the connection's secret, replacing the one it had. With
 * `onlyOver`, the write happens only while the stored value is still exactly those bytes, read
 * again just before the write: `skipped` when another writer has replaced it since.
 */
export async function writeCredential(
  ctx: SecretsContext,
  { id, url, credential, onlyOver }: CredentialWrite,
): Promise<'written' | 'skipped'> {
  const { secrets, scope } = ctx;
  const value = sealedCredential(url, credential);
  const existing = await findSecret(ctx, id);
  if (onlyOver !== undefined) {
    const current = await secrets.resolveByName(scope, storageConnectionSecretName(id));
    if (existing === undefined || current === null || !current.value.equals(onlyOver)) {
      return 'skipped';
    }
  }
  const sealed =
    existing === undefined
      ? await secrets.create(scope, { name: storageConnectionSecretName(id), value })
      : await secrets.replace(scope, existing.id, value);
  if (sealed.kind !== 'created' && sealed.kind !== 'replaced') {
    throw new Error(`the storage-connection secret was refused: ${sealed.kind}`);
  }
  return 'written';
}

/** Bind a pre-binding (bare) secret to `url`, so a later change of the row's target cannot carry it. */
export async function bindBareCredential(
  ctx: SecretsContext,
  id: string,
  url: string,
): Promise<void> {
  const secret = await ctx.secrets.resolveByName(ctx.scope, storageConnectionSecretName(id));
  const stored = storedCredential(secret?.value);
  // Only over the same bare bytes: a rotation since the read above is never undone.
  if (secret !== null && stored !== null && stored.target === null) {
    await writeCredential(ctx, { id, url, credential: stored.credential, onlyOver: secret.value });
  }
}

/** Best effort: a failed secret delete is logged, never raised. */
export async function removeConnectionSecret(ctx: SecretsContext, id: string): Promise<void> {
  try {
    const secret = await findSecret(ctx, id);
    if (secret === undefined) return;
    const outcome = await ctx.secrets.delete(ctx.scope, secret.id);
    if (outcome.kind !== 'deleted') {
      log.error('[storage-connections] the secret of a deleted connection was not removed', {
        connectionId: id,
        outcome: outcome.kind,
      });
    }
  } catch (error) {
    log.error('[storage-connections] the secret of a deleted connection was not removed', {
      connectionId: id,
      error,
    });
  }
}
