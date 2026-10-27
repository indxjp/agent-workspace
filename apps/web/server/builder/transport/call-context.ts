import { randomBytes } from 'node:crypto';

import { builderPromptVersionOf } from '../agent/prompt-version';
import type { CallContext } from '../ports';
import type { RunCallerPrincipal, RunIdentity } from './run-caller';

/** What the run row says about the turn making the call: who answers it and which Builder it is. */
export interface BuilderRun {
  readonly modelId: string;
  /** The agent version the run's session pins. */
  readonly agentVersion: {
    readonly id: string;
    readonly number: number;
    readonly summary: string;
  };
}

/** Reads the run a verified token names; `null` when the row lacks its model or its version. */
export type BuilderRunReader = (
  run: Pick<RunIdentity, 'workspaceId' | 'runId' | 'agentId'>,
) => Promise<BuilderRun | null>;

/**
 * The core's view of one call. Workspace, run and caller come from the verified run token only,
 * model and version from the run row. The trace id is minted here for every call and never read
 * from the request or its span: a framework adopts an inbound `traceparent` as the span's parent, so
 * the span's id may be one the caller chose, and a row must not join a trace the caller picked.
 */
export function toCallContext(
  runCaller: RunCallerPrincipal | RunIdentity,
  run: BuilderRun,
): CallContext {
  // A person-edited version (or one saved before #1848) records no prompt version: its id stands in.
  const promptVersion = builderPromptVersionOf(run.agentVersion.summary) ?? run.agentVersion.id;
  return {
    workspaceId: runCaller.workspaceId,
    door: { kind: 'run', agentId: runCaller.agentId, agentVersion: run.agentVersion.number },
    runId: runCaller.runId,
    traceId: randomBytes(16).toString('hex'),
    caller:
      runCaller.kind === 'run-caller'
        ? {
            kind: 'person',
            principal: {
              workspaceId: runCaller.workspaceId,
              principalId: runCaller.principalId,
              ownerPrincipalId: runCaller.principalId,
              userId: runCaller.userId,
              role: runCaller.role,
            },
          }
        : { kind: 'none' },
    modelId: run.modelId,
    promptVersion,
  };
}
