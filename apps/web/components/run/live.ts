/**
 * The browser side of `POST /api/agents/:id/runs` and `GET /api/runs/:id/events` — spec §19, §34.
 *
 * This is what `home-chat.tsx` calls after **Send** to make W1-UI-05's run path real: start a run,
 * then follow its event stream until the server's own `done` frame. Everything here is transport —
 * the SDK's `runs.start` and `runs.follow` — and nothing here decides what a frame *means*; that is
 * the composer's fold over `@indx-workspace/react/run-model`, so it stays testable without a network.
 *
 * What stays here is the screen's own transport policy: how `home-chat.tsx` learns about a
 * dropped connection, and the project-session ordering a first run in a project has to respect.
 */
import {
  ApiProblemError,
  type AgentWorkspaceClient,
  type RunEventFrame,
} from '@indx-workspace/sdk';

import type { RunApprovalDecision, RunStatus } from '@indx-workspace/contracts/runs';

import { browserClient } from '../../lib/browser-client';

/** What this screen does with a live run's event stream. Called for every frame this module reads. */
export interface RunEventStreamHandlers {
  /** A classified frame that is not the stream's own `done` — a relayed event, or a control frame. */
  onFrame(frame: RunEventFrame): void;
  /** The server's `done` frame arrived: nothing further will be delivered. Read `sse.ts`'s own words
   *  for what `done` does and does not say about whether the run succeeded. */
  onDone(): void;
  /** The connection itself failed, or ended without a `done` frame — reported, never guessed past. */
  onTransportError(message: string): void;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Follow run `runId`'s events through the SDK's `runs.follow` until `done` arrives or the
 * connection fails.
 *
 * `maxReconnects: 0` keeps the composer's semantics: a dropped connection is reported as one
 * transport error rather than resumed with `Last-Event-ID`. A resume can answer `stream-reset`,
 * which would oblige this screen to discard and rebuild a transcript it only ever appends to.
 *
 * Returns a function that aborts the read — call it on unmount so a screen nobody is looking at
 * stops holding a connection open.
 */
export function followRunEvents(
  runId: string,
  handlers: RunEventStreamHandlers,
  client: AgentWorkspaceClient = browserClient(),
): () => void {
  const controller = new AbortController();

  void (async (): Promise<void> => {
    try {
      for await (const frame of client.runs.follow(runId, {
        signal: controller.signal,
        maxReconnects: 0,
      })) {
        handlers.onFrame(frame);
      }
    } catch (error) {
      if (controller.signal.aborted) return;
      handlers.onTransportError(
        error instanceof ApiProblemError
          ? `the events endpoint answered ${String(error.status)} instead of opening a stream`
          : `this run's event stream ended unexpectedly: ${describeError(error)}`,
      );
      return;
    }
    handlers.onDone();
  })();

  return () => {
    controller.abort();
  };
}

/** What `POST /api/agents/:id/runs` answered, once the network and the JSON parse are both done. */
export type StartRunOutcome =
  | {
      readonly kind: 'started';
      readonly status: unknown;
      readonly runId: string;
      readonly sessionId: string | null;
    }
  | {
      readonly kind: 'rejected';
      readonly status: number;
      readonly code: string;
      readonly message: string;
    }
  | { readonly kind: 'transport-error'; readonly message: string };

type StartProjectSessionOutcome =
  | { readonly kind: 'started'; readonly sessionId: string }
  | {
      readonly kind: 'rejected';
      readonly status: number;
      readonly code: string;
      readonly message: string;
    }
  | { readonly kind: 'transport-error'; readonly message: string };

/** A refusal as the server worded it, or any other failure as a transport problem `failed` names. */
function failureOutcome(
  error: unknown,
  failed: string,
):
  | {
      readonly kind: 'rejected';
      readonly status: number;
      readonly code: string;
      readonly message: string;
    }
  | { readonly kind: 'transport-error'; readonly message: string } {
  if (error instanceof ApiProblemError) {
    return { kind: 'rejected', status: error.status, code: error.code, message: error.message };
  }
  return { kind: 'transport-error', message: `${failed}: ${describeError(error)}` };
}

/**
 * `POST /api/agents/:id/runs`, spec §34. Always starts a new session — §19.5.1 rule 4 is
 * `selectAgent`'s rule for the picker; this is its counterpart for the network call, and the two
 * agree by both never carrying a prior session id.
 *
 * `modelOverride` is issue #130's own out-of-glob addition to this pre-#129 signature (see
 * `docs/adr/W9-MODEL-130-composer-run-client-sends-the-connection-model-pair.md`): the body
 * `server/runs/api.ts`'s `parseStartRunBody` actually accepts is `modelConnectionId` and `model`
 * together or neither — sending a bare `modelConnectionId` with no `model` (this function's
 * pre-#130 shape) is a `400`. `null` means "no run override; resolution falls through to the
 * agent's own default, then the project's, then the workspace's."
 */
export async function startAgentRun(
  agentId: string,
  prompt: string,
  modelOverride: { readonly connectionId: string; readonly model: string } | null = null,
  sessionId: string | null = null,
  client: AgentWorkspaceClient = browserClient(),
  attachments: readonly string[] = [],
  version: number | null = null,
  fileScope: readonly string[] = [],
): Promise<StartRunOutcome> {
  try {
    const { run } = await client.runs.start(agentId, {
      prompt,
      sessionId,
      ...(version === null ? {} : { version }),
      ...(modelOverride === null ? {} : { modelOverride }),
      ...(attachments.length === 0
        ? {}
        : { attachments: attachments.map((fileId) => ({ fileId })) }),
      // RF-502: the home chat's picked files narrow the run (ADR-0147); none keeps every grant.
      ...(fileScope.length === 0 ? {} : { fileScope }),
    });
    return { kind: 'started', status: run.status, runId: run.id, sessionId: run.sessionId };
  } catch (error) {
    return failureOutcome(error, 'the request to start this run failed');
  }
}

/**
 * Create the project-owned session before starting its first run. The ordering is an invariant:
 * once a session has a run, the project API intentionally refuses to move it because doing so
 * would rewrite historical attribution.
 */
async function startProjectSession(
  projectId: string,
  agentId: string,
  client: AgentWorkspaceClient,
): Promise<StartProjectSessionOutcome> {
  try {
    const { id } = await client.projects.startSession(projectId, { agentId });
    return { kind: 'started', sessionId: id };
  } catch (error) {
    return failureOutcome(error, 'the request to start a session in this project failed');
  }
}

/** Start a first run, atomically preserving project attribution by opening its session first. */
export async function startAgentRunInProject(
  agentId: string,
  prompt: string,
  modelOverride: { readonly connectionId: string; readonly model: string } | null,
  projectId: string | null,
  client: AgentWorkspaceClient = browserClient(),
  version: number | null = null,
  fileScope: readonly string[] = [],
): Promise<StartRunOutcome> {
  if (projectId === null) {
    return startAgentRun(agentId, prompt, modelOverride, null, client, [], version, fileScope);
  }
  const session = await startProjectSession(projectId, agentId, client);
  if (session.kind !== 'started') return session;
  return startAgentRun(
    agentId,
    prompt,
    modelOverride,
    session.sessionId,
    client,
    [],
    version,
    fileScope,
  );
}

/**
 * Resume an existing session, or preserve project attribution while starting a replacement. The
 * `attachments` are file ids uploaded into the resumed session (issue #1680). `version` pins a new
 * session only: a resumed one keeps the version it started on, so it is not sent.
 */
export function startAgentRunForSession(
  agentId: string,
  prompt: string,
  modelOverride: { readonly connectionId: string; readonly model: string } | null,
  sessionId: string | null,
  projectId: string | null,
  client: AgentWorkspaceClient = browserClient(),
  attachments: readonly string[] = [],
  version: number | null = null,
  fileScope: readonly string[] = [],
): Promise<StartRunOutcome> {
  return sessionId === null
    ? startAgentRunInProject(agentId, prompt, modelOverride, projectId, client, version, fileScope)
    : startAgentRun(
        agentId,
        prompt,
        modelOverride,
        sessionId,
        client,
        attachments,
        null,
        fileScope,
      );
}

/** What `POST /api/runs/:id/approval` answered (issue #1490, ADR-0145). */
export type RunApprovalOutcome =
  // The continuation's status from the 202 (`queued` or `running`): the chat shows it at once, so the
  // run reads as live, and holds the follow-up, before its stream says anything.
  | { readonly kind: 'continued'; readonly runId: string; readonly status: RunStatus }
  | {
      readonly kind: 'rejected';
      readonly status: number;
      readonly code: string;
      readonly message: string;
    }
  | { readonly kind: 'transport-error'; readonly message: string };

/**
 * Approve or reject the tool call run `runId` paused on. The decision starts a continuation run in
 * the same session; `continued` names it so the screen follows it into the same transcript. A
 * refusal (the three `409`s, or any other problem) is returned, never retried; a `202` whose body
 * is not the published contract is a transport error, because the SDK validates it.
 */
export async function decideRunApproval(
  runId: string,
  decision: RunApprovalDecision,
  comment: string | undefined,
  client: AgentWorkspaceClient = browserClient(),
): Promise<RunApprovalOutcome> {
  const input = comment === undefined ? {} : { comment };
  try {
    const { run } = await (decision === 'approve'
      ? client.runs.approve(runId, input)
      : client.runs.reject(runId, input));
    return { kind: 'continued', runId: run.id, status: run.status };
  } catch (error) {
    return failureOutcome(error, 'the request to decide this approval failed');
  }
}
