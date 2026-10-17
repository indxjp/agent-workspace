import type { WorkspaceScope } from '@agent-workspace/core/db';

import {
  runtimeConnectionSecretName,
  type RuntimeConnectionCredentialSecrets,
} from '../runtimes/connections';

/** The `SecretsService` methods setup needs to store its runtime connection; a real service satisfies it. */
export interface SetupRuntimeSecrets extends RuntimeConnectionCredentialSecrets {
  create(
    scope: WorkspaceScope,
    input: { readonly name: string; readonly value: Buffer },
  ): Promise<
    | { readonly kind: 'created'; readonly secret: { readonly id: string } }
    | { readonly kind: 'name-conflict'; readonly name: string }
  >;
  replace(
    scope: WorkspaceScope,
    id: string,
    value: Buffer,
  ): Promise<{ readonly kind: 'replaced' | 'not-found' }>;
  delete(
    scope: WorkspaceScope,
    id: string,
  ): Promise<{ readonly kind: 'deleted' | 'not-found' | 'in-use' }>;
}

export type StoredSetupRuntimeConnection =
  | Readonly<{
      ok: true;
      id: string;
      /** Takes the write back; `label` names the row by id only, so it can be logged. */
      undo: Readonly<{ label: string; run: () => Promise<boolean> }>;
    }>
  | Readonly<{ ok: false; status: 409 | 500; code: string; message: string }>;

/**
 * Store the runtime connection first-run setup was given, as the `<driver> default` secret holding
 * sealed `{endpoint, credential}` like any other runtime connection (ADR-0120 LC6). A retry rotates
 * the existing secret rather than adding a second one, and its `undo` puts the old value back. No
 * message or label carries the credential.
 */
export async function storeSetupRuntimeConnection(
  secrets: SetupRuntimeSecrets,
  scope: WorkspaceScope,
  driver: string,
  connection: Readonly<{ endpoint: string; credential: string }>,
): Promise<StoredSetupRuntimeConnection> {
  const name = runtimeConnectionSecretName(driver, `${driver} default`);
  if (name === null) {
    return {
      ok: false,
      status: 500,
      code: 'runtime_connection_unavailable',
      message: 'The setup runtime connection could not be named.',
    };
  }
  const sealed = Buffer.from(JSON.stringify(connection), 'utf8');
  const existing = (await secrets.list(scope)).find((secret) => secret.name === name);
  if (existing === undefined) {
    const created = await secrets.create(scope, { name, value: sealed });
    if (created.kind !== 'created') {
      return {
        ok: false,
        status: 409,
        code: created.kind,
        message: 'The runtime connection could not be created.',
      };
    }
    const id = created.secret.id;
    return {
      ok: true,
      id,
      undo: {
        label: `delete runtime connection ${id}`,
        run: async () => (await secrets.delete(scope, id)).kind === 'deleted',
      },
    };
  }
  const id = existing.id;
  // A value that cannot be read is never overwritten: the right master key would read it again.
  const previous = await secrets.resolveByName(scope, name).then(
    (resolved) => resolved?.value ?? null,
    () => null,
  );
  if (previous === null) {
    return {
      ok: false,
      status: 500,
      code: 'credential_unreadable',
      message:
        'The stored key of the setup runtime connection could not be read. Check that ' +
        'MASTER_ENCRYPTION_KEY is the key it was stored with and that the secrets store is ' +
        'reachable, then retry.',
    };
  }
  if ((await secrets.replace(scope, id, sealed)).kind !== 'replaced') {
    return {
      ok: false,
      status: 500,
      code: 'runtime_connection_unavailable',
      message: 'The setup runtime connection could not be updated.',
    };
  }
  return {
    ok: true,
    id,
    undo: {
      label: `restore runtime connection ${id}`,
      run: async () => (await secrets.replace(scope, id, previous)).kind === 'replaced',
    },
  };
}
