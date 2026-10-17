import type {
  AgentRecord,
  AgentRepository,
  DatabaseRoot,
  ModelConnectionRecord,
  UpdateAgentPatch,
  WorkspaceMembership,
  WorkspaceScope,
} from '@agent-workspace/core/db';
import {
  policyWidenings,
  type PolicyWidening,
  type ProjectPolicy,
} from '@indx-workspace/contracts/policy-ceiling';
import { RUN_START_PROBLEM_CODES, isRunStartProblemCode } from '@indx-workspace/contracts/runs';

import { DomainError } from '../errors';
import { RuntimeManagerError } from '../compose/runtime-manager-client';
import { takesProviderCredential } from '../compose/runtime-provider-credential';
import { createModelDiscovery, type ModelDiscovery } from '../models/discovery';
import { storedEffective, type CeilingAgent } from '../policy-ceiling/ceiling';
import { selectPreferredModel } from '../models/preferred-model';
import type { ResolvedModelConnection, WorkspaceModelsStore } from '../models/store';
import type { ModelSelection } from '../runs/environment';
import { setupSecretsOf, setupStepFailure } from '../setup/failure';
import { configureSetupRuntime, type SetupInput, type SetupResult } from '../setup/runtime';
import { runtimeNetworkPolicyRefusal, setupRuntimeNetworkPolicy } from './config';
import {
  storeSetupRuntimeConnection,
  type SetupRuntimeSecrets,
  type StoredSetupRuntimeConnection,
} from './setup-runtime-connection';
import type { InstalledModelsApi } from './types';

/**
 * First-run setup's explicit seeded default, validated against the provider connection before it
 * is stored on the initial agent.
 */

const SETUP_SEEDED_MODEL: Readonly<Record<'anthropic' | 'openai', string>> = {
  anthropic: 'claude-sonnet-4-5',
  openai: 'gpt-5.1',
};

/** The seeded agent's name (`packages/core/src/db/seed.ts`); the name is all that identifies it. */
const GENERAL_AGENT_NAME = 'General';

function isSetupProvider(provider: string): provider is 'anthropic' | 'openai' {
  return provider === 'anthropic' || provider === 'openai';
}

/**
 * Provider discovery may expose a dated model id without exposing its stable alias. Prefer the
 * alias when present; otherwise select the newest dated release of that same model family.
 */
export function selectSetupSeededModel(
  provider: 'anthropic' | 'openai',
  discoveredIds: readonly string[],
): string | null {
  return selectPreferredModel(SETUP_SEEDED_MODEL[provider], discoveredIds);
}

/** What setup reads of a model connection to decide whether a stored choice is still usable. */
export interface SetupConnectionView {
  readonly id: string;
  readonly name: string;
  readonly provider: string;
  readonly ready: boolean;
  /**
   * The provider answered `401`/`403` to this connection's key when setup checked it. Only the
   * connections a reconciliation would keep are checked; `false` means "not rejected", including
   * "not checked".
   */
  readonly credentialRejected: boolean;
}

/** What setup reads of a runtime profile to decide whether a stored choice is still usable. */
export interface SetupProfileView {
  readonly id: string;
}

/**
 * Whether a stored choice of connection is broken: gone, not ready, or its key rejected.
 *
 * **Ownership is not decided by name (PR #403 review).** Setup used to treat a row named
 * `<provider> default` / `<driver> default` as its own and replace a stored choice that pointed at
 * a different one of those. A name is not an identity — an administrator can create or rename a
 * row to that name — so a working choice could be replaced only because of what it was called.
 * Setup now replaces a stored choice only when it is actually broken, whoever made it. Setup still
 * *finds its own rows to reuse* by name (a retry must rotate its connection's key rather than add a
 * duplicate), but that only decides which row setup writes, never which choice it overrides.
 */
function isBroken(connection: SetupConnectionView | undefined): boolean {
  return connection === undefined || !connection.ready || connection.credentialRejected;
}

/**
 * The workspace default model setup should write, or `null` to keep the stored one (issue #393).
 *
 * The seeded General agent inherits this default, so a default that cannot run makes General — an
 * agent the composer offers — fail on its first message. Setup therefore writes its own selection
 * when there is no default, or when the stored one names a connection that is gone, not ready, or
 * whose key the provider rejects. A default that still works is kept, whoever chose it.
 */
export function selectWorkspaceDefaultReconciliation(
  existing: ModelSelection | null,
  connections: readonly SetupConnectionView[],
  setup: ModelSelection,
): ModelSelection | null {
  if (existing === null) return setup;
  const current = connections.find((connection) => connection.id === existing.connectionId);
  return isBroken(current) ? setup : null;
}

/**
 * The patch that makes the seeded General agent runnable, or `null` when it already is.
 *
 * A runtime has no inheritance layer, so General gets setup's runtime profile when it has none or
 * when the one it names no longer exists. Its model is left to inherit the workspace default (see
 * {@link selectWorkspaceDefaultReconciliation}) unless it names a connection of its own that is
 * broken (gone, not ready, or its key rejected) — then it is pointed at setup's connection and
 * model. A runtime profile or model connection that still works is never replaced.
 */
export function selectGeneralReconciliation(
  agent: Pick<AgentRecord, 'name' | 'runtimeProfileId' | 'modelConnectionId'>,
  profiles: readonly SetupProfileView[],
  connections: readonly SetupConnectionView[],
  setup: {
    readonly runtimeProfileId: string;
    readonly connectionId: string;
    readonly model: string;
  },
): UpdateAgentPatch | null {
  if (agent.name !== GENERAL_AGENT_NAME) return null;
  const replaceRuntime =
    agent.runtimeProfileId === null ||
    !profiles.some((entry) => entry.id === agent.runtimeProfileId);
  const replaceModel =
    agent.modelConnectionId !== null &&
    isBroken(connections.find((entry) => entry.id === agent.modelConnectionId));
  if (!replaceRuntime && !replaceModel) return null;
  return {
    ...(replaceRuntime ? { runtimeProfileId: setup.runtimeProfileId } : {}),
    ...(replaceModel ? { modelConnectionId: setup.connectionId, model: setup.model } : {}),
  };
}

type SetupReconciliationFailure = Readonly<{
  ok: false;
  status: 409 | 500;
  code:
    | 'workspace_default_reconciliation_failed'
    | 'general_agent_reconciliation_failed'
    | 'setup_agent_missing';
  message: string;
}>;

/**
 * The workspace's connections as setup judges them: each one a reconciliation would otherwise keep
 * (`checkIds`, minus setup's own, which was just probed) is asked for its model list, and a
 * `401`/`403` marks its key rejected. Any other discovery failure says nothing about the key, so it
 * leaves the choice in place.
 */
async function setupConnectionViews(
  models: WorkspaceModelsStore,
  discover: ModelDiscovery,
  checkIds: ReadonlySet<string>,
): Promise<readonly SetupConnectionView[]> {
  const connections = await models.list();
  return Promise.all(
    connections.map(async (connection): Promise<SetupConnectionView> => {
      const view = {
        id: connection.id,
        name: connection.name,
        provider: connection.provider,
        ready: connection.ready,
        credentialRejected: false,
      };
      if (!connection.ready || !checkIds.has(connection.id)) return view;
      const resolved = await models.resolve(connection.id);
      if (resolved === null) return view;
      const discovered = await discover(resolved);
      return {
        ...view,
        credentialRejected: !discovered.ok && discovered.failure.kind === 'credential-rejected',
      };
    }),
  );
}

async function reconcileSetupDefaults(input: {
  root: DatabaseRoot;
  workspaceId: string;
  agents: AgentRepository;
  existingAgents: readonly AgentRecord[];
  configuredAgentId: string;
  models: WorkspaceModelsStore;
  discover: ModelDiscovery;
  profiles: readonly SetupProfileView[];
  connectionId: string;
  model: string;
  runtimeProfileId: string;
  undo: SetupUndo;
}): Promise<SetupReconciliationFailure | null> {
  const existingDefault = await input.root.getWorkspaceModelDefault(input.workspaceId);
  // The composer selects this agent before the user chooses one (PR #403 review): the agent the
  // wizard just configured and tested, marked on the agent row rather than guessed from its name.
  // A rollback hands the mark back to the agent that held it before (issue #415).
  const previousSetupAgentId = await input.root.getWorkspaceSetupAgentId(input.workspaceId);
  if (previousSetupAgentId !== input.configuredAgentId) {
    input.undo.push(
      previousSetupAgentId === null
        ? {
            label: `clear setup mark on agent ${input.configuredAgentId}`,
            run: () =>
              input.root.clearWorkspaceSetupAgentId(input.workspaceId, input.configuredAgentId),
          }
        : {
            label: `move setup mark from agent ${input.configuredAgentId} back to agent ${previousSetupAgentId}`,
            run: async () => {
              const cleared = await input.root.clearWorkspaceSetupAgentId(
                input.workspaceId,
                input.configuredAgentId,
              );
              const restored = await input.root.setWorkspaceSetupAgentId(
                input.workspaceId,
                previousSetupAgentId,
              );
              return cleared && restored;
            },
          },
    );
  }
  if (!(await input.root.setWorkspaceSetupAgentId(input.workspaceId, input.configuredAgentId))) {
    return {
      ok: false,
      status: 409,
      code: 'setup_agent_missing',
      message: 'The configured agent could not be marked as the setup agent.',
    };
  }
  const general = input.existingAgents.find((entry) => entry.name === GENERAL_AGENT_NAME);
  const checkIds = new Set(
    [existingDefault?.connectionId, general?.modelConnectionId].filter(
      (id): id is string => typeof id === 'string' && id !== input.connectionId,
    ),
  );
  const connections = await setupConnectionViews(input.models, input.discover, checkIds);
  const workspaceDefault = selectWorkspaceDefaultReconciliation(existingDefault, connections, {
    connectionId: input.connectionId,
    model: input.model,
  });
  if (workspaceDefault !== null) {
    input.undo.push({
      label: `restore workspace default of ${input.workspaceId}`,
      run: () => input.root.setWorkspaceModelDefault(input.workspaceId, existingDefault),
    });
  }
  if (
    workspaceDefault !== null &&
    !(await input.root.setWorkspaceModelDefault(input.workspaceId, workspaceDefault))
  ) {
    return {
      ok: false,
      status: 500,
      code: 'workspace_default_reconciliation_failed',
      message: 'The workspace default model could not be configured.',
    };
  }

  if (general === undefined || general.id === input.configuredAgentId) return null;
  const patch = selectGeneralReconciliation(general, input.profiles, connections, {
    runtimeProfileId: input.runtimeProfileId,
    connectionId: input.connectionId,
    model: input.model,
  });
  if (patch === null) return null;
  const updated = await input.agents.update(general.id, patch);
  if (updated.kind === 'updated') return null;
  return {
    ok: false,
    status: 409,
    code: 'general_agent_reconciliation_failed',
    message: 'The General agent could not be made runnable.',
  };
}

type SetupFailure = Readonly<{ ok: false; status: number; code: string; message: string }>;

/**
 * One write a setup attempt made, as the step that takes it back (issue #415). `label` names the
 * step and the row by id only, never a value, so it can be logged; `run` answers whether it worked.
 */
type SetupUndoStep = Readonly<{ label: string; run: () => Promise<boolean> }>;
type SetupUndo = SetupUndoStep[];

/**
 * Take back an attempt's writes, newest first. A step that fails or throws does not stop the rest;
 * the labels of the steps that failed are logged together, with the error's name only, since a
 * provider or storage error could carry a value.
 */
async function rollBack(undo: SetupUndo): Promise<void> {
  const failed: string[] = [];
  for (const step of undo.toReversed()) {
    try {
      if (!(await step.run())) failed.push(step.label);
    } catch (error) {
      failed.push(`${step.label} (${error instanceof Error ? error.name : 'non-error thrown'})`);
    }
  }
  if (failed.length > 0) {
    console.error(
      `[setup] rolling back a refused setup attempt left writes in place: ${failed.join('; ')}`,
    );
  }
}

/**
 * The connection setup tests, held in memory with the submitted key (issue #415). It is setup's
 * own `<provider> default` row when one exists (a retry rotates that row's key rather than adding
 * a second one), or a row not yet written. `previousCredential` is the key the existing row holds,
 * so a refusal after the key was rotated can put it back. It is `null` only when that row has no
 * secret at all; setup then repairs the row by writing it a fresh one (`repairsCredential`).
 */
type SetupConnectionCandidate = Readonly<{
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

async function setupConnectionCandidate(
  store: WorkspaceModelsStore,
  workspaceId: string,
  provider: 'anthropic' | 'openai',
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
      console.error(
        `[setup] the stored key of connection ${existing.id} could not be read (${
          error instanceof Error ? error.name : 'non-error thrown'
        })`,
      );
      return CREDENTIAL_UNREADABLE;
    }
    if (stored === null) {
      console.error(`[setup] the stored key of connection ${existing.id} could not be read`);
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

/** How long a setup waits behind another setup of the same workspace before it gives up. */
const SETUP_LOCK_WAIT_MS = 30_000;

/** How long the runtime test (start, echo, destroy) may take: it may pull an image first. */
const SETUP_RUNTIME_TEST_TIMEOUT_MS = 120_000;

const SETUP_IN_PROGRESS: SetupFailure = {
  ok: false,
  status: 409,
  code: 'setup_in_progress',
  message:
    'Another setup of this workspace is still running. Wait for it to finish, then retry setup.',
};

const SETUP_CONFLICT: SetupFailure = {
  ok: false,
  status: 409,
  code: 'setup_conflict',
  message:
    'The setup connection was changed while this setup was checking it. Retry setup to check it again.',
};

/** Whether two readings of the setup connection reach the provider the same way. */
function sameEndpoint(left: ResolvedModelConnection, right: ResolvedModelConnection): boolean {
  return (
    left.connection.provider === right.connection.provider &&
    JSON.stringify(left.connection.config) === JSON.stringify(right.connection.config)
  );
}

/** `promise`'s value, or `null` when it has not settled within `ms`. A rejection still rejects. */
async function withinDeadline<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), Math.max(0, ms));
  });
  try {
    return await Promise.race([promise, expired]);
  } finally {
    clearTimeout(timer);
  }
}

/** The runtime key setup was given, with the storage the handler checked is available. */
type SetupRuntimeConnection = Readonly<{
  secrets: SetupRuntimeSecrets;
  endpoint: string;
  credential: string;
}>;

/** What setup's checks decided; `runtimeRefusal` is set when the runtime refused its test (ADR-0131). */
type CheckedSetup = Readonly<{
  candidate: SetupConnectionCandidate;
  seededModel: string;
  runtimeRefusal?: NonNullable<Extract<SetupResult, { ok: true }>['runtimeRefusal']>;
}>;

type PersistedSetup = Readonly<{
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
async function persistSetup(context: {
  root: DatabaseRoot;
  input: SetupInput & { provider: 'anthropic' | 'openai' };
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
  const existingAgent = existingAgents.find((entry) => entry.name === agentName);
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
const SETUP_AGENT_PERMISSIONS = {
  readFiles: true,
  writeFiles: false,
  runCommands: false,
  unrestrictedNetwork: false,
} as const;

/**
 * The agent of the wizard's name as stored before setup runs (issue #535): its id, its stored
 * policy and the names of its connectors. `persistSetup` updates it in place and keeps both.
 */
export interface SetupStoredAgent {
  readonly id: string;
  readonly policy: CeilingAgent['policy'];
  readonly tools: readonly string[];
}

/**
 * Read {@link SetupStoredAgent} for `name`, or `null` when setup will create the agent. Connector
 * names are read only when the ceiling has `tools`.
 */
async function storedSetupAgent(
  root: DatabaseRoot,
  scope: WorkspaceScope,
  name: string,
  policy: ProjectPolicy,
): Promise<SetupStoredAgent | null> {
  const agent = (await root.agents.forScope(scope).list()).find((entry) => entry.name === name);
  if (agent === undefined) return null;
  if (policy.tools === undefined) return { id: agent.id, policy: agent.policy, tools: [] };
  const assignments = await root.agentResources.forScope(scope).get(agent.id);
  const connectors = root.mcpServers.forScope(scope);
  const names = await Promise.all(
    (assignments?.connectorIds ?? []).map(async (id) => (await connectors.get(id))?.name ?? null),
  );
  return {
    id: agent.id,
    policy: agent.policy,
    tools: names.filter((entry): entry is string => entry !== null),
  };
}

/**
 * Issue #535: the deployment ceiling over what setup writes — {@link SETUP_AGENT_PERMISSIONS} and
 * `seededModel`, on the agent as it will be stored: a new agent on the default engine with no
 * limits and no tools, or the `stored` agent of the same name, whose policy and connectors setup
 * keeps. The General agent's reconciliation writes the same model and no permissions, so this one
 * judgement covers it. `null` when it fits or there is no ceiling.
 */
export function setupCeilingRefusal(
  seededModel: string,
  policy: ProjectPolicy | null,
  stored: SetupStoredAgent | null,
): Readonly<{ failure: SetupFailure; widenings: readonly PolicyWidening[] }> | null {
  const widenings = policyWidenings(
    storedEffective(
      { permissions: SETUP_AGENT_PERMISSIONS, policy: stored?.policy ?? null },
      seededModel,
      stored?.tools ?? [],
    ),
    policy,
  );
  if (widenings.length === 0) return null;
  return {
    failure: {
      ok: false,
      status: 403,
      code: 'policy_cannot_widen',
      message: `The first agent would be wider than this deployment's policy ceiling allows: ${widenings.join(', ')}`,
    },
    widenings,
  };
}

export async function installSetupApi(
  root: DatabaseRoot,
  modelsApi: InstalledModelsApi | null,
  options: {
    /** The deployment's policy ceiling (issue #535); absent or `null` means none. */
    readonly policyCeiling?: ProjectPolicy | null;
    /**
     * Discovery for the key setup checks before anything is written. It keeps no cache (issue
     * #415): the candidate connection may never be written, so a list cached under its id would
     * never be read again. Tests pass their own.
     */
    readonly probeDiscover?: ModelDiscovery;
    /** How long a setup waits for another setup of its workspace to finish writing. */
    readonly lockWaitMs?: number;
    /** How long the runtime test may take. */
    readonly runtimeTestTimeoutMs?: number;
    /** Encrypted storage for the runtime key setup may be given; absent when secrets are unavailable. */
    readonly runtimeSecrets?: SetupRuntimeSecrets | null;
  } = {},
): Promise<void> {
  if (modelsApi === null) {
    console.error('[compose] setup API NOT installed: encrypted model storage is unavailable.');
    return;
  }
  const { models, discover } = modelsApi;
  const probeDiscover = options.probeDiscover ?? createModelDiscovery({ cache: false });
  const lockWaitMs = options.lockWaitMs ?? SETUP_LOCK_WAIT_MS;
  const runtimeTestTimeoutMs = options.runtimeTestTimeoutMs ?? SETUP_RUNTIME_TEST_TIMEOUT_MS;
  const runtimeSecrets = options.runtimeSecrets ?? null;
  const [{ signIn, readBootstrapAdmin }, { probeModelConnection }, registryModule] =
    await Promise.all([
      import('../auth/session'),
      import('../models/probe'),
      import('../runtimes/registry'),
    ]);
  /**
   * The checks that need the network: the submitted key against the provider, the seeded model
   * against discovery, and the runtime. They run before the workspace's setup lock is taken, so a
   * slow provider never holds up another setup.
   */
  async function check(
    input: SetupInput & { provider: 'anthropic' | 'openai' },
    workspaceModels: WorkspaceModelsStore,
    workspaceId: string,
  ): Promise<SetupFailure | CheckedSetup> {
    // issue #415: everything setup decides is decided before anything is written. The submitted
    // key is probed, and the seeded model discovered, on a candidate held in memory; a refusal
    // leaves the workspace exactly as it was, including the key on a connection that works.
    const candidate = await setupConnectionCandidate(
      workspaceModels,
      workspaceId,
      input.provider,
      input.providerApiKey,
      input.providerBaseUrl,
    );
    if ('ok' in candidate) return candidate;
    const probe = await probeModelConnection(candidate.resolved);
    if (!probe.ok)
      return { ok: false, status: 422, code: 'provider_test_failed', message: probe.message };

    // issue #129: the setup-seeded model id is validated against this exact connection's
    // discovery, rather than written unconditionally. A reachable, credentialed connection
    // whose account genuinely lacks the seeded model (a restricted API key, a deprecated model)
    // fails setup closed here, naming the model, instead of creating an agent whose first run
    // fails opaquely at the gateway.
    const preferredModel = SETUP_SEEDED_MODEL[input.provider];
    const discovered = await probeDiscover(candidate.resolved);
    const discoveredIds = discovered.ok
      ? discovered.models.map((model) => model.providerModelId)
      : [];
    const seededModel = selectSetupSeededModel(input.provider, discoveredIds);
    if (seededModel === null) {
      return {
        ok: false,
        status: 422,
        code: 'seeded_model_unavailable',
        message: discovered.ok
          ? `The default model "${preferredModel}" is not available at this connection.`
          : `The default model "${preferredModel}" could not be validated: model discovery failed (${discovered.reason}).`,
      };
    }

    const registry = registryModule.currentWebRuntimeRegistry();
    if (registry === null)
      return {
        ok: false,
        status: 503,
        code: 'runtime_registry_unavailable',
        message: 'Runtime detection is unavailable.',
      };
    const runtimeEntry = (await registry.list()).find((entry) => entry.id === input.runtime);
    if (runtimeEntry === undefined || runtimeEntry.state !== 'enabled')
      return {
        ok: false,
        status: 422,
        code: 'runtime_unavailable',
        message: runtimeEntry?.reason ?? 'The selected runtime is unavailable.',
      };
    let runtimeTest;
    try {
      runtimeTest = await withinDeadline(
        registry.test(input.runtime, 'agent-workspace-setup-runtime-test', {
          workspaceId,
          // The key is tested before it is stored, so a refused setup writes nothing.
          ...(input.runtimeCredential === undefined
            ? {}
            : { providerCredential: input.runtimeCredential }),
        }),
        runtimeTestTimeoutMs,
      );
    } catch (error) {
      // A provider driver with no usable runtime connection is a configuration refusal the wizard
      // shows, the same 422 a run start answers; anything else is still an infrastructure failure.
      if (error instanceof DomainError && isRunStartProblemCode(error.code))
        return {
          ok: false,
          status: RUN_START_PROBLEM_CODES[error.code],
          code: error.code,
          message:
            error.code === 'runtime_connection_missing' &&
            input.runtimeCredential === undefined &&
            takesProviderCredential(input.runtime)
              ? `runtime_connection_missing: Runtime ${input.runtime} needs its provider key at first-run setup. Send runtimeCredential and runtimeEndpoint with the setup request.`
              : error.publicMessage,
        };
      // ADR-0131: a driver that declares no network policy refuses the test like every run. That
      // is its recorded state, not a broken setup; runs stay refused with the same typed code.
      if (error instanceof RuntimeManagerError && error.code === 'network_policy_unsupported')
        return {
          candidate,
          seededModel,
          runtimeRefusal: {
            code: error.code,
            message:
              runtimeNetworkPolicyRefusal(input.runtime) ??
              `${input.runtime} refuses the network policy its runtime test runs under: runs are refused with network_policy_unsupported until a policy is declared.`,
          },
        };
      return setupStepFailure(
        'runtime test',
        error,
        setupSecretsOf(input),
        error instanceof RuntimeManagerError ? error.safeCause : undefined,
      );
    }
    if (runtimeTest === null)
      return {
        ok: false,
        status: 422,
        code: 'runtime_test_timeout',
        message: `The runtime test did not finish within ${String(Math.round(runtimeTestTimeoutMs / 1000))} seconds.`,
      };
    if (!runtimeTest.destroyed)
      return {
        ok: false,
        status: 422,
        code: 'runtime_test_failed',
        message: 'The runtime did not cleanly destroy its test allocation.',
      };
    return { candidate, seededModel };
  }

  /**
   * The writes, with the workspace's setup lock held. The candidate is read again first: another
   * setup may have written or repaired the row since {@link check} read it. The new reading is the
   * one written to, as long as it still reaches the provider the way the probed one did;
   * otherwise the probe proved nothing about it and this setup is refused.
   */
  async function persist(
    input: SetupInput & { provider: 'anthropic' | 'openai' },
    member: WorkspaceMembership,
    scope: WorkspaceScope,
    workspaceModels: WorkspaceModelsStore,
    checked: CheckedSetup,
    runtimeConnection: SetupRuntimeConnection | null,
  ): Promise<PersistedSetup | SetupFailure> {
    const candidate = await setupConnectionCandidate(
      workspaceModels,
      member.workspaceId,
      input.provider,
      input.providerApiKey,
      input.providerBaseUrl,
    );
    if ('ok' in candidate) return candidate;
    if (!sameEndpoint(candidate.resolved, checked.candidate.resolved)) return SETUP_CONFLICT;

    // Every check passed; now persist. The writes span the model-connection secret's own pool
    // and the application pool, so they cannot share one transaction
    // (docs/adr/W9-PROV-126-atomicity-within-owns-globs.md). Each write this attempt creates
    // registers its undo instead, and a refusal or a throw part-way runs them in reverse.
    const undo: SetupUndo = [];
    try {
      const persisted = await persistSetup({
        root,
        input,
        member,
        scope,
        workspaceModels,
        discover,
        candidate,
        seededModel: checked.seededModel,
        runtimeNetworkPolicy: setupRuntimeNetworkPolicy(input.runtime, process.env),
        runtimeConnection,
        undo,
      });
      if (!persisted.ok) await rollBack(undo);
      return persisted;
    } catch (error) {
      await rollBack(undo);
      return setupStepFailure('persistence', error, setupSecretsOf(input));
    }
  }

  /**
   * Per-process queue of each workspace's setups: the tail every new setup waits behind. A setup
   * that is not at the front by `deadline` gives up its place and runs nothing.
   */
  const queues = new Map<string, Promise<void>>();
  async function serialise<T>(
    workspaceId: string,
    deadline: number,
    work: () => Promise<T>,
  ): Promise<Readonly<{ ran: true; value: T }> | Readonly<{ ran: false }>> {
    const previous = queues.get(workspaceId) ?? Promise.resolve();
    let done = (): void => undefined;
    const mine = new Promise<void>((resolve) => (done = resolve));
    const tail = previous.then(() => mine);
    queues.set(workspaceId, tail);
    void tail.then(() => {
      if (queues.get(workspaceId) === tail) queues.delete(workspaceId);
    });
    try {
      const reached = await withinDeadline(
        previous.then(() => true),
        deadline - Date.now(),
      );
      if (reached === null) return { ran: false };
      return { ran: true, value: await work() };
    } finally {
      done();
    }
  }

  configureSetupRuntime({
    async complete(input) {
      if (!isSetupProvider(input.provider)) {
        return {
          ok: false,
          status: 400,
          code: 'provider_requires_advanced_configuration',
          message:
            'First-run setup supports Anthropic and OpenAI; configure custom endpoints after sign-in.',
        };
      }
      if (input.providerApiKey.length === 0 || input.agentName.trim() === '') {
        return {
          ok: false,
          status: 400,
          code: 'invalid_setup',
          message: 'Credential and agent name are required.',
        };
      }
      const authentication = await signIn({
        email: input.adminEmail,
        password: input.adminPassword,
      });
      if (!authentication.ok) {
        return {
          ok: false,
          status: authentication.code === 'server_not_configured' ? 503 : 401,
          code: authentication.code,
          message:
            authentication.code === 'server_not_configured'
              ? 'Bootstrap sign-in is not configured.'
              : 'Administrator credentials did not match.',
        };
      }
      const configured = readBootstrapAdmin(process.env);
      if (!configured.ok)
        return {
          ok: false,
          status: 503,
          code: 'server_not_configured',
          message: 'Bootstrap sign-in is not configured.',
        };
      const member = await root.resolveMembership(
        input.adminEmail.trim().toLowerCase(),
        configured.admin.workspaceSlug,
      );
      if (member === null)
        return {
          ok: false,
          status: 409,
          code: 'administrator_missing',
          message: 'The seeded administrator membership is missing; rerun the idempotent seed.',
        };
      const scope = await root.scopes.forWorkspaceId(member.workspaceId);
      if (scope === null)
        return {
          ok: false,
          status: 409,
          code: 'workspace_missing',
          message: 'The setup workspace is missing.',
        };

      // After the sign-in, so only the administrator can have setup store or send a runtime key.
      let runtimeConnection: SetupRuntimeConnection | null = null;
      if (input.runtimeCredential !== undefined) {
        if (!takesProviderCredential(input.runtime)) {
          return {
            ok: false,
            status: 400,
            code: 'invalid_setup',
            message: `Runtime ${input.runtime} takes no provider key; remove runtimeCredential and runtimeEndpoint.`,
          };
        }
        if (runtimeSecrets === null) {
          return {
            ok: false,
            status: 503,
            code: 'setup_unavailable',
            message: 'Encrypted runtime connection storage is unavailable.',
          };
        }
        if (input.runtimeEndpoint !== undefined) {
          runtimeConnection = {
            secrets: runtimeSecrets,
            endpoint: input.runtimeEndpoint,
            credential: input.runtimeCredential,
          };
        }
      }
      const setupInput = { ...input, provider: input.provider };
      const workspaceModels = models.forWorkspace(member.workspaceId);
      const checked = await check(setupInput, workspaceModels, member.workspaceId);
      if ('ok' in checked) return checked;
      // Issue #535: refused before the setup lock and before any write; the refusal is audited.
      // The agent setup will update is judged as stored, with its policy and connectors.
      // ponytail: check-then-write race until V-2, same as SD11
      const policyCeiling = options.policyCeiling ?? null;
      const stored =
        policyCeiling === null
          ? null
          : await storedSetupAgent(root, scope, input.agentName.trim(), policyCeiling);
      const overCeiling = setupCeilingRefusal(checked.seededModel, policyCeiling, stored);
      if (overCeiling !== null) {
        // ponytail: refusal audited as agent-changed, a dedicated action needs a core migration (core lane)
        await root.recordAuditEvent({
          workspaceId: member.workspaceId,
          actorPrincipalId: member.principalId,
          actorUserId: member.userId,
          actorLabel: member.userLabel,
          action: 'agent-changed',
          subjectId: stored?.id ?? null,
          subjectLabel: `${input.agentName.trim()}: refused policy_cannot_widen ${overCeiling.widenings.join(', ')}`,
        });
        return overCeiling.failure;
      }

      // Issue #415: one setup per workspace writes at a time — in this process by a queue, and
      // across replicas by a PostgreSQL advisory lock — so two concurrent setups never interleave
      // their writes or roll back each other's rows. Both waits share one deadline.
      const deadline = Date.now() + lockWaitMs;
      const queued = await serialise(member.workspaceId, deadline, () =>
        root.withWorkspaceSetupLock(member.workspaceId, deadline - Date.now(), () =>
          persist(setupInput, member, scope, workspaceModels, checked, runtimeConnection),
        ),
      );
      if (!queued.ran || !queued.value.acquired) return SETUP_IN_PROGRESS;
      const persisted = queued.value.value;
      if (!persisted.ok) return persisted;
      return {
        ...persisted,
        ...(checked.runtimeRefusal === undefined ? {} : { runtimeRefusal: checked.runtimeRefusal }),
        token: authentication.token,
        cookie: authentication.cookie,
      };
    },
  });
  console.log(
    '[compose] setup API installed: idempotent provider, runtime profile, administrator, and first-agent workflow',
  );
}
