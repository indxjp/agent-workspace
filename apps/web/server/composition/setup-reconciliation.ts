import type {
  AgentRecord,
  AgentRepository,
  DatabaseRoot,
  UpdateAgentPatch,
} from '@agent-workspace/core/db';
import type { SetupProvider } from '@indx-workspace/contracts/setup';

import type { ModelDiscovery } from '../models/discovery';
import { selectPreferredModel } from '../models/preferred-model';
import type { WorkspaceModelsStore } from '../models/store';
import type { ModelSelection } from '../runs/environment';
import type { SetupUndo } from './setup-undo';

/**
 * First-run setup's explicit seeded default, validated against the provider connection before it
 * is stored on the initial agent.
 */
export type SeededSetupProvider = Extract<SetupProvider, 'anthropic' | 'openai'>;

export const SETUP_SEEDED_MODEL: Readonly<Record<SeededSetupProvider, string>> = {
  anthropic: 'claude-sonnet-4-5',
  openai: 'gpt-5.1',
};

/** The seeded agent's name (`packages/core/src/db/seed.ts`); the name is all that identifies it. */
const GENERAL_AGENT_NAME = 'General';

export function isSetupProvider(provider: string): provider is SeededSetupProvider {
  return Object.hasOwn(SETUP_SEEDED_MODEL, provider);
}

/**
 * Provider discovery may expose a dated model id without exposing its stable alias. Prefer the
 * alias when present; otherwise select the newest dated release of that same model family.
 */
export function selectSetupSeededModel(
  provider: SeededSetupProvider,
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

export async function reconcileSetupDefaults(input: {
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
