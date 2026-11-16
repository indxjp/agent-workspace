import { log } from '../telemetry/logger';

import { isKeylessProvider } from '@indx-workspace/contracts/models';
import type { VertexDefaults } from '../models/vertex-defaults';
import type { ResolvedModelConnection, WorkspaceModelsStore } from '../models/store';
import { setupConnectionName } from '../setup/runtime';
import { type SeededSetupProvider } from './setup-reconciliation';
import type { SetupFailure } from './setup-undo';

export type SetupConnectionCandidate = Readonly<{
  existingId: string | null;
  previousCredential: string | null;
  repairsCredential: boolean;
  /** The config the existing row holds, so a refusal after a base URL was written can restore it. */
  storedConfig: ModelConnectionRecord['config'] | null;
  resolved: ResolvedModelConnection;
}>;

const CREDENTIAL_UNREADABLE: SetupFailure = {
  ok: false,
  status: 500,
  code: 'credential_unreadable',
  message:
    'The stored key of the setup connection could not be read. Check that MASTER_ENCRYPTION_KEY is ' +
    'the key it was stored with and that the secrets store is reachable, then retry.',
};

const VERTEX_NOT_CONFIGURED: SetupFailure = {
  ok: false,
  status: 422,
  code: 'vertex_not_configured',
  message:
    'Claude on Vertex AI needs a Google Cloud project; add the connection on the Models screen.',
};

export async function setupConnectionCandidate(
  store: WorkspaceModelsStore,
  workspaceId: string,
  provider: SeededSetupProvider,
  apiKey: string,
  baseUrl: string | undefined,
  vertexDefaults: VertexDefaults,
): Promise<SetupConnectionCandidate | SetupFailure> {
  const name = setupConnectionName(provider);
  const existing = (await store.list()).find((entry) => entry.name === name);
  const configOf = (stored: ModelConnectionRecord['config']): ModelConnectionRecord['config'] =>
    baseUrl === undefined ? stored : { ...stored, baseUrl };
  if (isKeylessProvider(provider))
    return keylessConnectionCandidate({ existing, workspaceId, name, provider, vertexDefaults });
  if (existing !== undefined && !existing.hasCredential) {
    // The row has no secret at all, so there is nothing to lose: it is repaired in place.
    return {
      existingId: existing.id,
      previousCredential: null,
      repairsCredential: true,
      storedConfig: existing.config,
      resolved: {
        connection: {
          id: existing.id,
          workspaceId,
          name: existing.name,
          provider: existing.provider,
          config: configOf(existing.config),
          createdAt: new Date(existing.createdAt),
          updatedAt: new Date(existing.updatedAt),
        },
        credential: apiKey,
      },
    };
  }
  if (existing !== undefined) {
    let stored: ResolvedModelConnection | null;
    try {
      stored = await store.resolve(existing.id);
    } catch (error) {
      log.error(`[setup] the stored key of connection ${existing.id} could not be read`, {
        errorName: error instanceof Error ? error.name : 'non-error thrown',
      });
      return CREDENTIAL_UNREADABLE;
    }
    if (stored === null) {
      log.error(`[setup] the stored key of connection ${existing.id} could not be read`);
      return CREDENTIAL_UNREADABLE;
    }
    return {
      existingId: existing.id,
      previousCredential: stored.credential,
      repairsCredential: false,
      storedConfig: stored.connection.config,
      resolved: {
        connection: { ...stored.connection, config: configOf(stored.connection.config) },
        credential: apiKey,
      },
    };
  }
  const now = new Date();
  return {
    existingId: null,
    previousCredential: null,
    repairsCredential: false,
    storedConfig: null,
    resolved: {
      connection: {
        id: crypto.randomUUID(),
        workspaceId,
        name,
        provider,
        config: configOf({}),
        createdAt: now,
        updatedAt: now,
      },
      credential: apiKey,
    },
  };
}
function keylessConnectionCandidate({
  existing,
  workspaceId,
  name,
  provider,
  vertexDefaults,
}: {
  existing: Awaited<ReturnType<WorkspaceModelsStore['list']>>[number] | undefined;
  workspaceId: string;
  name: string;
  provider: SeededSetupProvider;
  vertexDefaults: VertexDefaults;
}): SetupConnectionCandidate | SetupFailure {
  // No secret to rotate or repair. An existing row is kept exactly as the Owner left it, so a
  // second setup never overwrites a later edit; a new one takes the install's project and location.
  const defaults = vertexDefaults;
  const config: ModelConnectionRecord['config'] =
    existing?.config ??
    (defaults.projectId === undefined
      ? {}
      : { projectId: defaults.projectId, location: defaults.location ?? 'global' });
  if (config.projectId === undefined) return VERTEX_NOT_CONFIGURED;
  const now = new Date();
  return {
    existingId: existing?.id ?? null,
    previousCredential: null,
    repairsCredential: false,
    storedConfig: existing?.config ?? null,
    resolved: {
      connection: {
        id: existing?.id ?? crypto.randomUUID(),
        workspaceId,
        name,
        provider,
        config,
        createdAt: existing === undefined ? now : new Date(existing.createdAt),
        updatedAt: existing === undefined ? now : new Date(existing.updatedAt),
      },
      credential: '',
    },
  };
}

type ModelConnectionRecord = ResolvedModelConnection['connection'];
