import { log } from '../telemetry/logger';
import type {
  DatabaseRoot,
  ModelConnectionRecord,
  UpdateAgentPatch,
  WorkspaceScope,
} from '@agent-workspace/core/db';

import type { ModelDiscovery } from '../models/discovery';
import type { ResolvedModelConnection, WorkspaceModelsStore } from '../models/store';
import { setupSecretsOf, setupStepFailure } from '../setup/failure';
import type { SetupInput } from '../setup/runtime';
import type { setupRuntimeNetworkPolicy } from './config';
import { reconcileSetupDefaults, type SeededSetupProvider } from './setup-reconciliation';
import {
  storeSetupRuntimeConnection,
  type SetupRuntimeSecrets,
  type StoredSetupRuntimeConnection,
} from './setup-runtime-connection';
import type { SetupFailure, SetupUndo } from './setup-undo';

/**
 * The connection setup tests, held in memory with the submitted key (issue #415). It is setup's
 * own `<provider> default` row when one exists (a retry rotates that row's key rather than adding
 * a second one), or a row not yet written. `previousCredential` is the key the existing row holds,
 * so a refusal after the key was rotated can put it back. It is `null` only when that row has no
 * secret at all; setup then repairs the row by writing it a fresh one (`repairsCredential`).
 */
export type SetupConnectionCandidate = Readonly<{
  existingId: string | null;
  previousCredential: string | null;
  repairsCredential: boolean;
  /** The config the existing row holds, so a refusal after a base URL was written can restore it. */
  storedConfig: ModelConnectionRecord['config'] | null;
  resolved: ResolvedModelConnection;
}>;

/**
 * Setup's own row has a secret that cannot be read: a wrong `MASTER_ENCRYPTION_KEY`, or the
 * secrets store failing. Setup never overwrites it (the right master key would read it again), and
 * says where to look instead.
 */
const CREDENTIAL_UNREADABLE: SetupFailure = {
  ok: false,
  status: 500,
  code: 'credential_unreadable',
  message:
    'The stored key of the setup connection could not be read. Check that MASTER_ENCRYPTION_KEY is ' +
    'the key it was stored with and that the secrets store is reachable, then retry.',
};

export async function setupConnectionCandidate(
  store: WorkspaceModelsStore,
  workspaceId: string,
  provider: SeededSetupProvider,
  apiKey: string,
  baseUrl: string | undefined,
): Promise<SetupConnectionCandidate | SetupFailure> {
  const name = `${provider} default`;
  const existing = (await store.list()).find((entry) => entry.name === name);
  const configOf = (stored: ModelConnectionRecord['config']): ModelConnectionRecord['config'] =>
    baseUrl === undefined ? stored : { ...stored, baseUrl };
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

/** The runtime key setup was given, with the storage the handler checked is available. */
export type SetupRuntimeConnection = Readonly<{
  secrets: SetupRuntimeSecrets;
  endpoint: string;
  credential: string;
}>;

export type PersistedSetup = Readonly<{
  ok: true;
  agentId: string;
  modelConnectionId: string;
  runtimeProfileId: string;
  runtimeConnectionId: string | null;
}>;

/**
 * Write what setup decided: the connection and its key, the runtime profile, the wizard's agent,
 * then the workspace default and the General repair. It runs only after every check passed, and
 * each write pushes its undo onto `undo` as soon as it has landed.
 */
export async function persistSetup(context: {
  root: DatabaseRoot;
  input: SetupInput & { provider: SeededSetupProvider };
  member: { workspaceId: string; principalId: string; userId: string };
  scope: WorkspaceScope;
  workspaceModels: WorkspaceModelsStore;
  discover: ModelDiscovery;
  candidate: SetupConnectionCandidate;
  seededModel: string;
  runtimeNetworkPolicy: ReturnType<typeof setupRuntimeNetworkPolicy>;
  /** The submitted runtime key, its endpoint and where to store them; `null` when setup was given none. */
  runtimeConnection: SetupRuntimeConnection | null;
  undo: SetupUndo;
}): Promise<PersistedSetup | SetupFailure> {
  const { root, input, member, scope, workspaceModels, candidate, seededModel, undo } = context;

  let connectionId: string;
  if (candidate.existingId === null) {
    const created = await workspaceModels.create({
      name: candidate.resolved.connection.name,
      provider: input.provider,
      apiKey: input.providerApiKey,
      config: candidate.resolved.connection.config,
    });
    if (created.kind !== 'created')
      return {
        ok: false,
        status: 409,
        code: created.kind,
        message: 'The model connection could not be created.',
      };
    const createdId = created.connection.id;
    connectionId = createdId;
    undo.push({
      label: `delete connection ${createdId}`,
      run: async () => (await workspaceModels.delete(createdId)).kind === 'deleted',
    });
  } else {
    // The row an earlier refused attempt left (deployed 0.2.0, issue #415) is repaired here: it
    // gets the key that just passed the provider test, so it is reused, never joined by a second.
    const existingId = candidate.existingId;
    connectionId = existingId;
    const stored = candidate.storedConfig;
    const config = candidate.resolved.connection.config;
    if (stored !== null && stored.baseUrl !== config.baseUrl) {
      const updated = await workspaceModels.update(existingId, { config });
      if (updated.kind !== 'updated')
        return {
          ok: false,
          status: 409,
          code: updated.kind,
          message: 'The model connection could not be updated.',
        };
      undo.push({
        label: `restore config of connection ${existingId}`,
        run: async () =>
          (await workspaceModels.update(existingId, { config: stored })).kind === 'updated',
      });
    }
    // A row with no secret at all is given a fresh one under the same id; a row with a readable
    // secret has it rotated. An unreadable secret never reaches here (`credential_unreadable`).
    const written = candidate.repairsCredential
      ? await workspaceModels.writeCredential(existingId, input.providerApiKey)
      : await workspaceModels.replaceCredential(existingId, input.providerApiKey);
    if (!written)
      return {
        ok: false,
        status: 500,
        code: 'credential_missing',
        message: 'The setup-owned provider credential could not be reconciled.',
      };
    const previous = candidate.previousCredential;
    if (previous !== null) {
      undo.push({
        label: `restore credential of connection ${existingId}`,
        run: () => workspaceModels.writeCredential(existingId, previous),
      });
    }
  }

  // Written before the profile that points at it, so the newest-first undo removes the profile
  // (whose foreign key references the secret) before the secret.
  let runtimeConnectionId: string | null = null;
  if (context.runtimeConnection !== null) {
    const { secrets, endpoint, credential } = context.runtimeConnection;
    let stored: StoredSetupRuntimeConnection;
    try {
      stored = await storeSetupRuntimeConnection(secrets, scope, input.runtime, {
        endpoint,
        credential,
      });
    } catch (error) {
      return setupStepFailure('secrets store', error, setupSecretsOf(input));
    }
    if (!stored.ok) return stored;
    runtimeConnectionId = stored.id;
    undo.push(stored.undo);
  }

  const profiles = root.runtimeProfiles.forScope(scope);
  const profileName = `${input.runtime} default`;
  const profileDefinition = {
    name: profileName,
    driver: input.runtime as Parameters<typeof profiles.create>[0]['driver'],
    runtimeConnectionId,
    cpu: null,
    memoryMb: null,
    diskMb: null,
    networkPolicy: context.runtimeNetworkPolicy,
    allowedDomains: null,
    filesystem: 'read-write' as const,
    persistPaths: null,
    timeoutSeconds: null,
    idleTimeoutSeconds: null,
    driverConfig: null,
  };
  const existingProfile = (await profiles.list()).find((entry) => entry.name === profileName);
  let profileId: string;
  if (existingProfile === undefined) {
    const created = await profiles.create(profileDefinition);
    if (created.kind !== 'created')
      return {
        ok: false,
        status: 409,
        code: created.kind,
        message: 'The runtime profile could not be created.',
      };
    const createdId = created.profile.id;
    profileId = createdId;
    undo.push({
      label: `delete runtime profile ${createdId}`,
      run: async () => (await profiles.delete(createdId)).kind === 'deleted',
    });
  } else {
    const existingId = existingProfile.id;
    profileId = existingId;
    const updated = await profiles.update(existingId, profileDefinition);
    if (updated.kind !== 'updated')
      return {
        ok: false,
        status: 409,
        code: updated.kind,
        message: 'The existing setup runtime profile could not be reconciled.',
      };
    // Put back every field this update overwrote.
    const previous = {
      name: existingProfile.name,
      driver: existingProfile.driver,
      runtimeConnectionId: existingProfile.runtimeConnectionId,
      cpu: existingProfile.cpu,
      memoryMb: existingProfile.memoryMb,
      diskMb: existingProfile.diskMb,
      networkPolicy: existingProfile.networkPolicy,
      allowedDomains: existingProfile.allowedDomains,
      filesystem: existingProfile.filesystem,
      persistPaths: existingProfile.persistPaths,
      timeoutSeconds: existingProfile.timeoutSeconds,
      idleTimeoutSeconds: existingProfile.idleTimeoutSeconds,
      driverConfig: existingProfile.driverConfig,
    };
    undo.push({
      label: `restore runtime profile ${existingId}`,
      run: async () => (await profiles.update(existingId, previous)).kind === 'updated',
    });
  }

  const agentRepository = root.agents.forScope(scope);
  const agentName = input.agentName.trim();
  const existingAgents = await agentRepository.list();
  // A built-in agent (the Builder) is the platform's, never setup's to overwrite: skipping it makes
  // the create below meet the name collision and answer 409, like any other taken name.
  const existingAgent = existingAgents.find(
    (entry) => entry.name === agentName && entry.builtin === undefined,
  );
  const definition = {
    instructions: input.agentInstructions,
    modelConnectionId: connectionId,
    model: seededModel,
    runtimeProfileId: profileId,
    permissions: SETUP_AGENT_PERMISSIONS,
  } as const;
  let agentId: string;
  if (existingAgent === undefined) {
    // issue #117: every create path stamps `created_by`; first-run setup attributes the
    // default agent to the bootstrap administrator whose membership this request just verified.
    const created = await agentRepository.create({
      name: agentName,
      ...definition,
      ownerPrincipalId: member.principalId,
      createdBy: member.userId,
    });
    if (created.kind !== 'created')
      return {
        ok: false,
        status: 409,
        code: created.kind,
        message: 'The first agent could not be created.',
      };
    const createdId = created.agent.id;
    agentId = createdId;
    undo.push({
      label: `delete agent ${createdId}`,
      run: async () => (await agentRepository.delete(createdId)).kind === 'deleted',
    });
  } else {
    const existingId = existingAgent.id;
    agentId = existingId;
    const updated = await agentRepository.update(existingId, definition);
    if (updated.kind !== 'updated')
      return {
        ok: false,
        status: 409,
        code: updated.kind,
        message: 'The existing first agent could not be updated.',
      };
    const previous: UpdateAgentPatch = {
      instructions: existingAgent.instructions,
      modelConnectionId: existingAgent.modelConnectionId,
      model: existingAgent.model,
      runtimeProfileId: existingAgent.runtimeProfileId,
      permissions: existingAgent.permissions,
    };
    undo.push({
      label: `restore agent ${existingId}`,
      run: async () => (await agentRepository.update(existingId, previous)).kind === 'updated',
    });
  }

  const reconciliation = await reconcileSetupDefaults({
    root,
    workspaceId: member.workspaceId,
    agents: agentRepository,
    existingAgents,
    configuredAgentId: agentId,
    models: workspaceModels,
    discover: context.discover,
    profiles: await profiles.list(),
    connectionId,
    model: seededModel,
    runtimeProfileId: profileId,
    undo,
  });
  if (reconciliation !== null) return reconciliation;

  // The admin chose this runtime in the wizard, so it is the workspace default an agent version
  // naming no profile resolves to (ADR-0101, issue #504). Without it every `aw push` leaves the
  // agent with no runtime profile. A default someone already chose is kept. A refusal writes
  // nothing here, and the caller's `rollBack(undo)` takes back every earlier write of this attempt.
  const defaulted = await profiles.ensureWorkspaceDefault(profileDefinition, {
    adoptable: () => true,
  });
  if (defaulted.kind === 'name-conflict' || defaulted.kind === 'not-adoptable')
    return {
      ok: false,
      status: 409,
      code: defaulted.kind,
      message: 'The runtime profile could not be made the workspace default.',
    };
  return {
    ok: true,
    agentId,
    modelConnectionId: connectionId,
    runtimeProfileId: profileId,
    runtimeConnectionId,
  };
}

/** The permissions setup gives the first agent. */
export const SETUP_AGENT_PERMISSIONS = {
  readFiles: true,
  writeFiles: false,
  runCommands: false,
  unrestrictedNetwork: false,
} as const;
