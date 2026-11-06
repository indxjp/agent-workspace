import type { AgentVersionBody } from '@indx-workspace/contracts/agent-versions';
import type { RunApprovalCall, RunResource } from '@indx-workspace/contracts/runs';
import type { TriggerResource } from '@indx-workspace/contracts/triggers';
import type { AgentWorkspaceClient } from '@indx-workspace/sdk';
import type { RecordedRequest } from '@indx-workspace/sdk/testing';
import type { McpSession, McpToolResult } from './mcp-client.ts';

/** The connector a scripted call goes to, and the `mcpServers` key a Claude run gives it. */
export interface ScriptedConnector {
  readonly id: string;
  readonly session: Pick<McpSession, 'call'> & {
    /** Write rules the engine gates on top of `requireApproval`: an OpenAPI gateway's. */
    readonly approvalRules?: readonly string[];
  };
  /** The signing secret the connector opted in with (`identity: { secret }`); none, no header. */
  readonly identityKey?: string;
}

export interface ScriptContext {
  /** The prompt the backend sent. */
  readonly prompt: string;
  /** The session the run belongs to; the same id across turns of one conversation. */
  readonly sessionId: string;
  /** Call `tool` on `connector`, as the model would, and record the call and its real result. */
  readonly tool: (
    connector: string,
    tool: string,
    args: Record<string, unknown>,
  ) => Promise<McpToolResult>;
  /**
   * Call the platform's built-in tool `tool` (`search_files`), as the model would. The call is
   * recorded under the name a run reports, `mcp__agent-workspace__<tool>`.
   */
  readonly builtin: (tool: string, args: Record<string, unknown>) => Promise<McpToolResult>;
  /**
   * Call the Claude built-in tool `name` (`Write`) with `input`, as the model would. It is gated
   * like any tool named in `requireApproval`; an ungated or approved call is answered `ok`.
   */
  readonly native: (name: string, input: Record<string, unknown>) => Promise<McpToolResult>;
  /**
   * Call `handoff_to_person({ reason })`. Throws unless the workspace was given `handoff: true`;
   * the first call wins, as in the engine.
   */
  readonly handoff: (reason: string) => Promise<McpToolResult>;
  /** Leave `name` in the run's `outputs/` directory, as a script the agent ran would. */
  readonly write: (name: string, body: string | Uint8Array) => void;
}

/** The platform's own tools a script may call: the tool's name, and what answers it. */
export type BuiltinTools = Readonly<
  Record<
    string,
    (
      args: Record<string, unknown>,
      run: { readonly fileScope: readonly string[] | null },
    ) => Promise<McpToolResult>
  >
>;

/** The engine settings a script's gates follow: pass the use case's own, never a literal. */
export interface ScriptedOptions {
  readonly requireApproval?: readonly string[] | undefined;
  readonly handoff?: boolean | undefined;
  /**
   * The agent as pushed (issue #1571): `body` is its `toAgentVersionBody`, saved as version 1 with
   * `local` pointing at it, so each run reports `agentVersion: 1`, `GET /api/agents/:id/versions`
   * lists it, and `GET /api/skills/:name` answers one published revision per entry of
   * `skillFileCounts` (the skill's real file count). Without it the runs are legacy: `null`.
   */
  readonly version?:
    | {
        readonly body: AgentVersionBody;
        readonly skillFileCounts: Readonly<Record<string, number>>;
      }
    | undefined;
}

/** What a sender gets back: `202 { run }`, or the problem code of a miss (`404 trigger_not_found`). */
export interface FireAnswer {
  readonly status: number;
  readonly run: RunResource | null;
  readonly code: string | null;
}

/** What a script answers: its final text, and the value for the `outputSchema` it was asked for. */
export type ScriptAnswer = string | { readonly text: string; readonly structured: unknown };

/** What the model "does" for one run: call tools, then return its final answer. */
export type Script = (context: ScriptContext) => Promise<ScriptAnswer>;

export interface ScriptedWorkspace {
  readonly aw: AgentWorkspaceClient;
  readonly agentId: string;
  readonly calls: RecordedRequest[];
  /** The runs started so far, in order, with the prompt each was given. */
  readonly runs: readonly {
    readonly id: string;
    readonly prompt: string;
    readonly sessionId: string;
    /** The `subject` the backend sent; `null` when it sent none. */
    readonly subject: string | null;
    /** The `outputSchema` the backend sent, as JSON Schema; `null` when it asked for none. */
    readonly outputSchema: Readonly<Record<string, unknown>> | null;
    /** The calls the decision that started this run admitted; `[]` for a run nobody decided on. */
    readonly approvedToolCalls: readonly RunApprovalCall[];
    /** The `fileScope` the backend sent; `null` when it sent none. */
    readonly fileScope: readonly string[] | null;
  }[];
  /** Where senders post: the trigger's `firePath` is relative to this. */
  readonly baseUrl: string;
  /** A sender (Graph, a mail provider, the workflow system) calling a webhook trigger's `firePath`. */
  readonly fire: (
    firePath: string,
    body: unknown,
    options?: { readonly idempotencyKey?: string },
  ) => Promise<FireAnswer>;
  /** The schedule pass's tick for a schedule trigger: start its run now, with an empty body. */
  readonly fireSchedule: (triggerId: string) => Promise<RunResource>;
  /** The triggers created so far. */
  readonly triggers: readonly TriggerResource[];
  /** The tool name a Claude run reports for `tool` on `connector`: `mcp__<key>__<tool>`, the key being the connector's name (`connectorServerKey`). */
  readonly toolName: (connector: string, tool: string) => string;
}
