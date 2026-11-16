import type { DatabaseRoot, WorkspaceScope } from '@agent-workspace/core/db';
import type { ModelDiscovery } from '../models/discovery';
import type { WorkspaceModelsStore } from '../models/store';
import { setupSecretsOf, setupStepFailure } from '../setup/failure';
import { type SetupInput } from '../setup/runtime';
import type { setupRuntimeNetworkPolicy } from './config';
import { reconcileSetupDefaults, type SeededSetupProvider } from './setup-reconciliation';
import {
  storeSetupRuntimeConnection,
  type SetupRuntimeSecrets,
  type StoredSetupRuntimeConnection,
} from './setup-runtime-connection';
import type { SetupFailure, SetupUndo } from './setup-undo';
import type { SetupConnectionCandidate } from './setup-connection-candidate';
import { persistModelConnection } from './setup-model-write';
import { persistRuntimeProfile } from './setup-profile-write';
import { persistFirstAgent } from './setup-agent-write';
export { SETUP_AGENT_PERMISSIONS } from './setup-agent-write';
export {
  setupConnectionCandidate,
  type SetupConnectionCandidate,
} from './setup-connection-candidate';

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

export async function persistSetup(
  context: SetupPersistenceContext,
): Promise<PersistedSetup | SetupFailure> {
  const { root, member, workspaceModels, seededModel, undo } = context;
  const connection = await persistModelConnection(context);
  if (!connection.ok) return connection;
  const { connectionId } = connection;
  const runtime = await persistRuntimeConnection(context);
  if (!runtime.ok) return runtime;
  const { runtimeConnectionId } = runtime;
  const profile = await persistRuntimeProfile(context, runtimeConnectionId);
  if (!profile.ok) return profile;
  const { profileId, profiles, profileDefinition } = profile;
  const agent = await persistFirstAgent(context, connectionId, profileId);
  if (!agent.ok) return agent;
  const { agentId, agentRepository, existingAgents } = agent;

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
      ok: false as const,
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

export type SetupPersistenceContext = {
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
};

async function persistRuntimeConnection(context: SetupPersistenceContext) {
  const { scope, input, undo } = context;

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
  return { ok: true as const, runtimeConnectionId };
}
