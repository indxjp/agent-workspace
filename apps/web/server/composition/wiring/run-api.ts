import { wireRunCredentials } from './run-api-credentials';
import { wireRunFeedback } from './run-api-feedback';
import { wireRunEvaluations } from './run-api-evaluations';
import { wireRunSessions } from './run-api-sessions';
import { createRunTokenRevoker } from './run-api-credentials';
import { wireRunDailyCostCap } from './run-api-daily-cost';
/**
 * The run API (`ApplicationContext.runs`) and the five domains that exist only with a run runtime:
 * the A2A and tool endpoints, `POST /api/tokens`, the triggers and the public surfaces. Built after
 * `wireRunRuntime` answers a runtime; with none, every one of them is `disabled` (503 by name).
 */

import { log } from '../../telemetry/logger';
import { cronSecretFrom } from '../../http/cron';
import { createJsonLogger } from '@agent-workspace/core/telemetry';

import type { ApplicationContext } from '../../application-context';
import type { RunApiEnvironment, RunPrincipal } from '../../runs/environment';
import { admitSurfaceVisitorWrite } from '../../surfaces/public/limits';
import type { AgentsWiring } from './agents';
import { wireEndpoints } from './endpoints';
import { createCompositionRunLauncher } from './run-launcher';
import type { RunResourcesWiring } from './run-resources';
import type { RunRuntimeWiring, wireRunRuntime } from './run-runtime';
import { wireRuntimeResolver, type RuntimeResolverWiring } from './runtime-resolver';
import type { SubsystemsWiring } from './subsystems';
import { createTokensRuntime, wireSurfaces } from './tokens-surfaces';
import { wireTriggers } from './triggers';

/** Everything the composition root has wired before the run domains. */
type RunDomainsWiring = AgentsWiring &
  SubsystemsWiring &
  RunResourcesWiring &
  RunRuntimeWiring &
  Pick<Parameters<typeof wireRunRuntime>[0], 'root' | 'policyCeiling' | 'stopOnClose'>;

/** The context fields that need a run runtime. */
export type RunDomains = Pick<
  ApplicationContext,
  'a2a' | 'runs' | 'surfaces' | 'tokens' | 'toolEndpoint' | 'triggers'
>;

/** A deployment with no run runtime: each of these routes answers its own named 503. */
export const RUN_DOMAINS_DISABLED: RunDomains = {
  a2a: { kind: 'disabled' },
  runs: { kind: 'disabled' },
  surfaces: { kind: 'disabled' },
  tokens: { kind: 'disabled' },
  toolEndpoint: { kind: 'disabled' },
  triggers: { kind: 'disabled' },
};

/** Build the run domains, all serving. Starts the trigger schedule driver. */
export function wireRunDomains(wired: RunDomainsWiring): RunDomains {
  const resolver = wireRuntimeResolver(wired);
  const triggers = wireTriggers(wired.root, wired.secretsService, {
    cronSecret: cronSecretFrom(process.env) ?? undefined,
    log,
    stopOnClose: wired.stopOnClose,
  });
  const { evaluationsOf, a2a, toolEndpoint } = wireEndpoints(wired);
  const tokens = createTokensRuntime(wired);
  const surfaces = wireSurfaces({ ...wired, tokens });
  const environment = wireRunApi({ ...wired, ...resolver, evaluationsOf });
  const { runtime } = wired;
  log.info(
    `[compose] run API installed: agent runtime profiles select registered launch targets; ` +
      (runtime.ok
        ? `local relays through ${runtime.settings.runnerUrl} (spec §14.3)`
        : `no "local" target ("${runtime.reason}"); the runner manager provides the rest`),
  );
  return {
    a2a: { kind: 'serving', environment: a2a },
    runs: { kind: 'serving', environment },
    surfaces: { kind: 'serving', runtime: surfaces },
    tokens: { kind: 'serving', runtime: tokens },
    toolEndpoint: { kind: 'serving', environment: toolEndpoint },
    triggers: { kind: 'serving', runtime: triggers },
  };
}

/** The run API environment every run route reads from `ApplicationContext.runs`. */
export type RunApiWiring = RunDomainsWiring &
  RuntimeResolverWiring &
  Pick<ReturnType<typeof wireEndpoints>, 'evaluationsOf'>;
export type RevokeRunTokens = (
  principal: RunPrincipal,
  runId: string,
) => Promise<{ readonly revoked: number; readonly outcome: string }>;

export function wireRunApi(wired: RunApiWiring): RunApiEnvironment {
  const { identify, withCeiling, runs, runPreflight, runStartPreflight, spendLimitFor } = wired;
  const revokeAllRunTokensFor = createRunTokenRevoker(wired);
  const withDailyCostCap = wireRunDailyCostCap(wired);
  return {
    ...withCeiling,

    ...withDailyCostCap,

    store: runs,

    authenticate: async (request: Request): Promise<RunPrincipal | null> => identify(request),
    ...wireRunCredentials(wired, revokeAllRunTokensFor),
    ...wireRunFeedback(wired),

    // Issue #622 (#606): a surface visitor's turns and ratings are rate-limited and capped.
    admitVisitorWrite: admitSurfaceVisitorWrite,
    ...wireRunEvaluations(wired),

    describeRunTarget: (workspaceId, agentId) => runPreflight.describe(workspaceId, agentId),

    preflight: runStartPreflight,

    spendLimitFor,
    ...wireRunSessions(wired),

    logger: createJsonLogger({ service: 'web' }),

    launch: createCompositionRunLauncher({ ...wired, revokeAllRunTokensFor }),
  };
}
