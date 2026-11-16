/**
 * The pure decisions of composing a run request (refactoring plan part 07, step 3): which model
 * connection and model the run uses, where its sandbox is, what an attachment grants, how
 * attachments narrow the portable permissions, and the run's environment. No store, token issuer,
 * resource loader or clock: every input is passed in. `../run-request.ts`'s `buildRunRequestFor`
 * loads the facts, calls these, and assembles the `RunRequest`.
 */
import type { AgentPermissions } from '@indx-workspace/contracts/agents';

/** A connection and a model chosen together (the shape `runs/environment.ts`'s `ModelSelection` has). */
export interface ChosenModel {
  readonly connectionId: string;
  readonly model: string;
}

/** Every place a run's model can come from, most specific first. */
export interface RunModelSources {
  /** The model resolution `startRun` already ran (issue #129), if any. */
  readonly resolved?: ChosenModel | undefined;
  /** A per-run override (`LaunchContext.modelOverride`). */
  readonly override?: ChosenModel | null | undefined;
  /** The pre-#129 per-run connection id, which never carries a model of its own. */
  readonly legacyConnectionId?: string | null | undefined;
  /** The agent's own connection and model. */
  readonly agent: {
    readonly id: string;
    readonly modelConnectionId: string | null;
    readonly model: string | null;
  };
}

/** The run's model connection and model. Throws when no layer names a connection. */
export function runModelFor(sources: RunModelSources): {
  readonly modelConnectionId: string;
  readonly model: string | null;
} {
  const modelConnectionId =
    sources.resolved?.connectionId ??
    sources.override?.connectionId ??
    sources.legacyConnectionId ??
    sources.agent.modelConnectionId;
  if (modelConnectionId === null) {
    throw new Error(
      `agent ${sources.agent.id} has no model connection; a run-scoped gateway token cannot be resolved`,
    );
  }
  // The legacy connection id (pre-#129) never carries a model of its own — only the newer
  // resolved/override pairs do.
  const model = sources.resolved?.model ?? sources.override?.model ?? sources.agent.model;
  return { modelConnectionId, model };
}

const SAFE_PATH_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_-]*$/u;

/**
 * The run's working directory under the runner's workspace root, and its project key. The
 * session id becomes a path segment, so anything that could climb out of it is refused.
 */
export function sandboxFor(
  workspaceRoot: string,
  workspaceId: string,
  sessionId: string,
): { cwd: string; projectKey: string } {
  if (!SAFE_PATH_SEGMENT.test(sessionId)) {
    throw new Error(`session ${JSON.stringify(sessionId)} is not safe to use as a path segment`);
  }
  return { cwd: `${workspaceRoot}/${workspaceId}/${sessionId}`, projectKey: workspaceId };
}

/** An attachment as the run sees it. */
export interface RunAttachment {
  readonly path: string;
  readonly kind: 'file' | 'directory';
}

/**
 * ADR-0146 Decisions 2 and 3: an attachment is a read-only grant whose bytes never ride in the
 * request (the runner's `POST /files` hydrate writes them).
 */
export function attachmentGrantsFor(attachments: readonly RunAttachment[]): readonly {
  readonly path: string;
  readonly kind: 'file' | 'directory';
  readonly access: 'read';
}[] {
  return attachments.map(({ path, kind }) => ({ path, kind, access: 'read' }));
}

/**
 * The portable permissions with the shell removal a read grant causes, applied for every engine
 * whenever the run carries an attachment (ADR-0146).
 */
export function portablePermissionsFor(
  met: AgentPermissions,
  attachmentCount: number,
): AgentPermissions {
  return attachmentCount === 0 ? met : { ...met, runCommands: false };
}

/**
 * The run's subprocess environment: the agent's secrets, then the gateway's credential (A.11)
 * under the names the Claude Agent SDK's bundled CLI reads, the transcript-mirroring token, and
 * the proxy switch.
 */
export function runEnvironment(
  agentSecrets: Readonly<Record<string, string>>,
  gatewayBaseUrl: string,
  token: string,
): Record<string, string> {
  return {
    ...agentSecrets,
    ANTHROPIC_BASE_URL: gatewayBaseUrl,
    ANTHROPIC_AUTH_TOKEN: token,
    // The same signed, registered per-run claim authenticates transcript mirroring. It is
    // bound to workspace/run/session and contains no provider credential.
    AW_SESSION_MIRROR_TOKEN: token,
    NODE_USE_ENV_PROXY: '1',
  };
}
