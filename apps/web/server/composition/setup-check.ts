import { RUN_START_PROBLEM_CODES, isRunStartProblemCode } from '@indx-workspace/contracts/runs';
import { DomainError } from '../errors';
import { RuntimeManagerError } from '../compose/runtime-manager-client';
import { takesProviderCredential } from '../compose/runtime-provider-credential';
import { type ModelDiscovery } from '../models/discovery';
import { readVertexDefaults } from '../models/vertex-defaults';
import type { WorkspaceModelsStore } from '../models/store';
import { RUNTIME_MANAGER_FORBIDDEN, setupSecretsOf, setupStepFailure } from '../setup/failure';
import type { SetupInput, SetupResult } from '../setup/runtime';
import { runtimeNetworkPolicyRefusal } from './config';
import { setupConnectionCandidate, type SetupConnectionCandidate } from './setup-persist';
import {
  selectSetupSeededModel,
  SETUP_SEEDED_MODEL,
  type SeededSetupProvider,
} from './setup-reconciliation';
import { type SetupFailure } from './setup-undo';

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

type SupportedSetupInput = SetupInput & { provider: SeededSetupProvider };

interface SetupCheckContext {
  readonly workspaceModels: WorkspaceModelsStore;
  readonly workspaceId: string;
  readonly probeDiscover: ModelDiscovery;
  readonly probeModelConnection: typeof import('../models/probe').probeModelConnection;
  readonly currentWebRuntimeRegistry: typeof import('../runtimes/registry').currentWebRuntimeRegistry;
  readonly runtimeTestTimeoutMs: number;
}

async function checkSetupModel(
  input: SupportedSetupInput,
  context: SetupCheckContext,
): Promise<SetupFailure | CheckedSetup> {
  const { workspaceModels, workspaceId, probeDiscover, probeModelConnection } = context;

  // issue #415: everything setup decides is decided before anything is written. The submitted
  // key is probed, and the seeded model discovered, on a candidate held in memory; a refusal
  // leaves the workspace exactly as it was, including the key on a connection that works.
  const candidate = await setupConnectionCandidate(
    workspaceModels,
    workspaceId,
    input.provider,
    input.providerApiKey,
    input.providerBaseUrl,
    readVertexDefaults(process.env),
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

  return { candidate, seededModel };
}

function setupRuntimeTestFailure(
  error: unknown,
  input: SupportedSetupInput,
  checked: CheckedSetup,
): SetupFailure | CheckedSetup {
  const { candidate, seededModel } = checked;

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
  const failure = setupStepFailure(
    'runtime test',
    error,
    setupSecretsOf(input),
    error instanceof RuntimeManagerError ? error.safeCause : undefined,
  );
  return isFrontEndForbidden(error) ? { ...failure, code: RUNTIME_MANAGER_FORBIDDEN } : failure;
}

/** The platform's HTML `403` in front of the manager (an IAM grant not yet in effect), not the manager's own refusal. */
function isFrontEndForbidden(error: unknown): boolean {
  return (
    error instanceof RuntimeManagerError && error.status === 403 && error.code === 'non_json_html'
  );
}

async function checkSetupRuntime(
  input: SupportedSetupInput,
  checked: CheckedSetup,
  context: SetupCheckContext,
): Promise<SetupFailure | CheckedSetup> {
  const { currentWebRuntimeRegistry, runtimeTestTimeoutMs, workspaceId } = context;
  const { candidate, seededModel } = checked;
  const registry = currentWebRuntimeRegistry();
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
    return setupRuntimeTestFailure(error, input, checked);
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

async function checkSetup(
  input: SupportedSetupInput,
  context: SetupCheckContext,
): Promise<SetupFailure | CheckedSetup> {
  const checked = await checkSetupModel(input, context);
  return 'ok' in checked ? checked : checkSetupRuntime(input, checked, context);
}
export { withinDeadline, checkSetup, type CheckedSetup };
