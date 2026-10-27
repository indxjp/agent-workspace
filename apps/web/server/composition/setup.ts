import { log } from '../telemetry/logger';
import type { DatabaseRoot, WorkspaceMembership, WorkspaceScope } from '@agent-workspace/core/db';
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
import type { ResolvedModelConnection, WorkspaceModelsStore } from '../models/store';
import { setupSecretsOf, setupStepFailure } from '../setup/failure';
import type { Setup, SetupInput, SetupResult, SetupRuntime } from '../setup/runtime';
import { runtimeNetworkPolicyRefusal, setupRuntimeNetworkPolicy } from './config';
import {
  persistSetup,
  SETUP_AGENT_PERMISSIONS,
  setupConnectionCandidate,
  type PersistedSetup,
  type SetupConnectionCandidate,
  type SetupRuntimeConnection,
} from './setup-persist';
import {
  isSetupProvider,
  selectSetupSeededModel,
  SETUP_SEEDED_MODEL,
  type SeededSetupProvider,
} from './setup-reconciliation';
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

/** What setup's checks decided; `runtimeRefusal` is set when the runtime refused its test (ADR-0131). */
type CheckedSetup = Readonly<{
  candidate: SetupConnectionCandidate;
  seededModel: string;
  runtimeRefusal?: NonNullable<Extract<SetupResult, { ok: true }>['runtimeRefusal']>;
}>;

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
   * The checks that need the network: the submitted key against the provider, the seeded model
   * against discovery, and the runtime. They run before the workspace's setup lock is taken, so a
   * slow provider never holds up another setup.
   */
  async function check(
    input: SetupInput & { provider: SeededSetupProvider },
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
    input: SetupInput & { provider: SeededSetupProvider },
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
  };
  log.info(
    '[compose] setup API installed: idempotent provider, runtime profile, administrator, and first-agent workflow',
  );
  return { kind: 'serving', runtime };
}
