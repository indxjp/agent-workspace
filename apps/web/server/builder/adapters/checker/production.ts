import type { AgentStoreProvider } from '../../../agents/store';
import { createAgentFromVersion } from '../../../agent-versions/create-from-version';
import { agentNotFound, refuseBuiltinWrite } from '../../../agents/handlers';
import {
  createAgentVersion,
  type CreateAgentVersionDependencies,
} from '../../../agent-versions/handlers';
import type { AgentVersionStoreProvider } from '../../../agent-versions/store';
import type { ApiResult } from '../../../http/result';
import type { CallContext, CheckerPort, CheckResult } from '../../ports';
import { mayCheck } from './access';
import { failedCheck, FORBIDDEN, NO_CALLER } from './failure';

export interface CheckerDependencies {
  readonly agents: AgentStoreProvider;
  readonly versions: AgentVersionStoreProvider;
  /** The request-scoped pipeline inputs (ceiling, tool bundles, storage connections, tool host). */
  readonly pipeline: (ctx: CallContext) => Omit<CreateAgentVersionDependencies, 'store'>;
}

// A dry run stores neither; the draft schema only requires them.
const DRAFT = { summary: 'Builder draft check', via: 'api' } as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

type Failed = Extract<CheckResult, { ok: false }>;

/** A 4xx `{error}` from the version pipeline, passed through with its code; `null` for anything else. */
export function failureOf(result: ApiResult): Failed | null {
  const { body } = result;
  const error = isRecord(body) ? body['error'] : undefined;
  if (result.status >= 400 && result.status < 500 && isRecord(error)) {
    const { code, message, details } = error;
    if (typeof code === 'string' && typeof message === 'string') {
      const lines = Array.isArray(details) ? details.filter((d) => typeof d === 'string') : [];
      return failedCheck(code, message, lines);
    }
  }
  return null;
}

/** 200 is the pipeline's `{ok, number}`; a 4xx is its `{error}` passed through. Anything else is not the model's to see. */
export function toCheckResult(result: ApiResult): CheckResult {
  const { body } = result;
  if (result.status === 200 && isRecord(body) && typeof body['number'] === 'number') {
    return { ok: true, number: body['number'] };
  }
  const failed = failureOf(result);
  if (failed !== null) return failed;
  throw new Error(`The version pipeline answered ${String(result.status)} to a dry run.`);
}

export function createChecker(deps: CheckerDependencies): CheckerPort {
  return {
    async check(ctx, agentId, body) {
      if (ctx.caller.kind === 'none') return NO_CALLER;
      const { principal } = ctx.caller;
      const store = await deps.versions.forWorkspace(ctx.workspaceId);
      if (store === null) {
        throw new Error('The version store does not resolve a workspace RBAC verified.');
      }
      const agents = deps.agents.forWorkspace(ctx.workspaceId);
      const pipeline = deps.pipeline(ctx);

      if (agentId === undefined) {
        if (!mayCheck(principal, undefined)) return FORBIDDEN;
        return toCheckResult(
          await createAgentFromVersion(
            { version: { body, ...DRAFT }, dryRun: true },
            {
              principalId: principal.principalId,
              ownerPrincipalId: principal.ownerPrincipalId,
              userId: principal.userId,
              actorLabel: 'Builder',
            },
            { ...pipeline, store, agents },
          ),
        );
      }
      const agent = await agents.get(agentId);
      if (agent === null) return toCheckResult(agentNotFound());
      // The console route refuses a built-in agent before RBAC, so a dry run of it does too.
      const readOnly = refuseBuiltinWrite(agent, 'create-version');
      if (readOnly !== null) return toCheckResult(readOnly);
      if (!mayCheck(principal, agent)) return FORBIDDEN;
      return toCheckResult(
        await createAgentVersion({ body, ...DRAFT, dryRun: true }, agent, principal.principalId, {
          ...pipeline,
          store,
        }),
      );
    },
  };
}
