import { withinDeadline, checkSetup, type CheckedSetup } from './setup-check';
import { log } from '../telemetry/logger';
import type { DatabaseRoot, WorkspaceMembership, WorkspaceScope } from '@agent-workspace/core/db';
import {
  policyWidenings,
  type PolicyWidening,
  type ProjectPolicy,
} from '@indx-workspace/contracts/policy-ceiling';
import { takesProviderCredential } from '../compose/runtime-provider-credential';
import { isKeylessProvider } from '@indx-workspace/contracts/models';
import { createModelDiscovery, type ModelDiscovery } from '../models/discovery';
import { readVertexDefaults } from '../models/vertex-defaults';
import { storedEffective, type CeilingAgent } from '../policy-ceiling/ceiling';
import type { ResolvedModelConnection, WorkspaceModelsStore } from '../models/store';
import { setupSecretsOf, setupStepFailure } from '../setup/failure';
import type { Setup, SetupInput, SetupRuntime } from '../setup/runtime';
import { setupRuntimeNetworkPolicy } from './config';
import {
  persistSetup,
  SETUP_AGENT_PERMISSIONS,
  setupConnectionCandidate,
  type PersistedSetup,
  type SetupRuntimeConnection,
} from './setup-persist';
import { isSetupProvider, type SeededSetupProvider } from './setup-reconciliation';
import type { SetupRuntimeSecrets } from './setup-runtime-connection';
import { rollBack, type SetupFailure, type SetupUndo } from './setup-undo';
import type { InstalledModelsApi } from './types';

export {
  selectGeneralReconciliation,
  selectSetupSeededModel,
  selectWorkspaceDefaultReconciliation,
} from './setup-reconciliation';

export type { SetupConnectionView, SetupProfileView } from './setup-reconciliation';

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

type SupportedSetupInput = SetupInput & { provider: SeededSetupProvider };

async function persistCheckedSetup(context: {
  readonly root: DatabaseRoot;
  readonly discover: ModelDiscovery;
  readonly input: SupportedSetupInput;
  readonly member: WorkspaceMembership;
  readonly scope: WorkspaceScope;
  readonly workspaceModels: WorkspaceModelsStore;
  readonly checked: CheckedSetup;
  readonly runtimeConnection: SetupRuntimeConnection | null;
}): Promise<PersistedSetup | SetupFailure> {
  const { root, discover, input, member, scope, workspaceModels, checked, runtimeConnection } =
    context;

  const candidate = await setupConnectionCandidate(
    workspaceModels,
    member.workspaceId,
    input.provider,
    input.providerApiKey,
    input.providerBaseUrl,
    readVertexDefaults(process.env),
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

function createSetupQueue() {
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
  return serialise;
}

async function authenticateSetupAdministrator(
  input: SetupInput,
  root: DatabaseRoot,
  auth: Pick<typeof import('../auth/session'), 'signIn' | 'readBootstrapAdmin'>,
): Promise<
  | SetupFailure
  | {
      readonly authentication: Extract<Awaited<ReturnType<typeof auth.signIn>>, { ok: true }>;
      readonly member: WorkspaceMembership;
      readonly scope: WorkspaceScope;
    }
> {
  const authentication = await auth.signIn({
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
  const configured = auth.readBootstrapAdmin(process.env);
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

  return { authentication, member, scope };
}

function setupRuntimeConnection(
  input: SetupInput,
  runtimeSecrets: SetupRuntimeSecrets | null,
): SetupRuntimeConnection | SetupFailure | null {
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

  return runtimeConnection;
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
): Promise<Setup> {
  if (modelsApi === null) {
    log.error('[compose] setup API NOT installed: encrypted model storage is unavailable.');
    return { kind: 'unavailable' };
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
   * Per-process queue of each workspace's setups: the tail every new setup waits behind. A setup
   * that is not at the front by `deadline` gives up its place and runs nothing.
   */
  const serialise = createSetupQueue();

  const runtime: SetupRuntime = {
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
      if (
        (input.providerApiKey.length === 0 && !isKeylessProvider(input.provider)) ||
        input.agentName.trim() === ''
      ) {
        return {
          ok: false,
          status: 400,
          code: 'invalid_setup',
          message: 'Credential and agent name are required.',
        };
      }
      const administrator = await authenticateSetupAdministrator(input, root, {
        signIn,
        readBootstrapAdmin,
      });
      if ('ok' in administrator) return administrator;
      const { authentication, member, scope } = administrator;

      // Only an authenticated administrator can store or send a runtime key.
      const runtimeConnection = setupRuntimeConnection(input, runtimeSecrets);
      if (runtimeConnection !== null && 'ok' in runtimeConnection) return runtimeConnection;
      const setupInput = { ...input, provider: input.provider };
      const workspaceModels = models.forWorkspace(member.workspaceId);
      const checked = await checkSetup(setupInput, {
        workspaceModels,
        workspaceId: member.workspaceId,
        probeDiscover,
        probeModelConnection,
        currentWebRuntimeRegistry: registryModule.currentWebRuntimeRegistry,
        runtimeTestTimeoutMs,
      });
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
          persistCheckedSetup({
            root,
            discover,
            input: setupInput,
            member,
            scope,
            workspaceModels,
            checked,
            runtimeConnection,
          }),
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
  };
  log.info(
    '[compose] setup API installed: idempotent provider, runtime profile, administrator, and first-agent workflow',
  );
  return { kind: 'serving', runtime };
}
