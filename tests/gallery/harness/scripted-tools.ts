import { canonicalCall, needsApproval } from '@indx-workspace/contracts/agents';
import type { RunApprovalCall } from '@indx-workspace/contracts/runs';
import { signedHeaders } from './identity.ts';
import type { McpToolResult } from './mcp-client.ts';
import { frame } from './scripted-frames.ts';
import type {
  BuiltinTools,
  ScriptContext,
  ScriptedConnector,
  ScriptedOptions,
} from './scripted-workspace-types.ts';
const HANDOFF_TOOL_NAME = 'mcp__agent-workspace__handoff_to_person';

/** Thrown when the engine stops a run before executing an unapproved call. */
export class PausedForApproval extends Error {}

export function createScriptRecorder(
  events: string[],
  gated: readonly string[],
  approved: readonly RunApprovalCall[],
) {
  const state: { pending: RunApprovalCall | null; handoff: string | null } = {
    pending: null,
    handoff: null,
  };
  const consumed = new Set<string>();
  const record = async (
    name: string,
    args: Record<string, unknown>,
    answer: () => Promise<McpToolResult>,
  ): Promise<McpToolResult> => {
    if (state.pending !== null) throw new PausedForApproval();
    const toolCallId = `call_${String(events.length)}`;
    events.push(frame('agent.tool.call', { toolCallId, name, kind: 'other', input: args }));
    const result = await gate(name, args, toolCallId, answer);
    events.push(
      frame('agent.tool.result', {
        toolCallId,
        status: result.isError ? 'failed' : 'completed',
        output: result.text,
        isError: result.isError,
      }),
    );
    return result;
  };
  // `decideToolPermission` (packages/engine-claude-agent-sdk/src/boundary.ts), call for call.
  const gate = async (
    name: string,
    args: Record<string, unknown>,
    toolCallId: string,
    answer: () => Promise<McpToolResult>,
  ): Promise<McpToolResult> => {
    if (!needsApproval(gated, name)) return answer();
    const call = canonicalCall(name, args);
    if (approved.some((candidate) => candidate.canonicalCall === call)) {
      if (consumed.has(call)) {
        return {
          text: `approval_already_used: the approval for this ${name} call was already used.`,
          isError: true,
        };
      }
      consumed.add(call);
      return answer();
    }
    if (approved.length > 0) {
      return {
        text: `approval_call_mismatch: ${name} was called with arguments nobody approved.`,
        isError: true,
      };
    }
    return pause(toolCallId, name, args);
  };
  // The run stops at this call: it asks for approval, and nothing after it runs.
  const pause = (toolCallId: string, name: string, args: Record<string, unknown>): never => {
    const call = canonicalCall(name, args);
    events.push(
      frame('agent.approval.requested', { toolCallId, toolName: name, canonicalCall: call }),
    );
    state.pending = { toolName: name, canonicalCall: call };
    throw new PausedForApproval();
  };

  return { state, record };
}

export function createScriptContext(settings: {
  readonly prompt: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly subject: string | null;
  readonly approved: readonly RunApprovalCall[];
  readonly fileScope: readonly string[] | null;
  readonly connectors: Readonly<Record<string, ScriptedConnector>>;
  readonly builtins: BuiltinTools;
  readonly options: ScriptedOptions;
  readonly files: Map<string, Uint8Array>;
  readonly toolName: (connector: string, tool: string) => string;
  readonly recorder: ReturnType<typeof createScriptRecorder>;
}): ScriptContext {
  const {
    prompt,
    sessionId,
    runId,
    subject,
    approved,
    fileScope,
    connectors,
    builtins,
    options,
    files,
    toolName,
  } = settings;
  const { state, record } = settings.recorder;
  return {
    prompt: prompt,
    sessionId,
    tool: async (connector, tool, args) => {
      const target = connectors[connector];
      if (target === undefined) throw new Error(`no scripted connector named ${connector}`);
      const headers =
        target.identityKey === undefined || subject === null
          ? {}
          : await signedHeaders({
              key: target.identityKey,
              connectorId: target.id,
              subject,
              runId,
            });
      return record(toolName(connector, tool), args, () =>
        target.session.call(tool, args, {
          headers,
          approvedToolCalls: approved.map((call) => call.canonicalCall),
        }),
      );
    },
    builtin: (tool, args) => {
      const answer = builtins[tool];
      if (answer === undefined) throw new Error(`no built-in tool named ${tool}`);
      return record(`mcp__agent-workspace__${tool}`, args, () => answer(args, { fileScope }));
    },
    native: (name, input) =>
      record(name, input, () => Promise.resolve({ text: 'ok', isError: false })),
    handoff: (reason) => {
      if (options.handoff !== true) throw new Error('this agent has no handoff_to_person tool');
      return record(HANDOFF_TOOL_NAME, { reason }, () => {
        state.handoff ??= reason;
        return Promise.resolve({
          text: 'The conversation is handed to a person.',
          isError: false,
        });
      });
    },
    write: (name, body) => {
      files.set(
        `runs/${runId}/outputs/${name}`,
        typeof body === 'string' ? new TextEncoder().encode(body) : body,
      );
    },
  };
}
