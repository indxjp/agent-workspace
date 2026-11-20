/**
 * The parts of the OpenAI Agents boundary that name no SDK type: the rejected-key failure, the
 * bearer token, the patch-operation mapping and the run's usage meter. `./boundary.ts` is the only
 * file that imports the SDK; everything here is plain data in, plain data out.
 */
import type { OpenAiAgentsCompiled, OpenAiAgentsMcpServer } from './compile.js';
import { credentialRejectedError, isGatewayTokenRefusal } from '@agent-workspace/engine';

import { addResponseUsage, type OpenAiAgentsUsage } from './frames.js';

/**
 * The failure a run ends with when a model call came back `401` or `403` from the provider
 * (issue #690), or `null` for any other error. The adapter never holds the model key, so this is
 * the first moment it can see the key is wrong. A gateway refusal of the run token carries a
 * `token_*` code (`packages/gateway/src/auth.ts`) and is left alone, so nobody is told to replace
 * a good key. Only the status is read: no key and no provider text reaches the message.
 */
export function rejectedKeyFailure(error: unknown): Error | null {
  if (typeof error !== 'object' || error === null) return null;
  // The OpenAI client names the status `status`, the AI SDK's Anthropic client `statusCode`.
  const status = 'status' in error ? error.status : 'statusCode' in error ? error.statusCode : null;
  if (status !== 401 && status !== 403) return null;
  const code = 'code' in error ? error.code : null;
  const body = 'responseBody' in error ? error.responseBody : null;
  const gatewayRefusal =
    (typeof code === 'string' && code.startsWith('token_')) ||
    (typeof body === 'string' && isGatewayTokenRefusal(body));
  return gatewayRefusal ? null : credentialRejectedError(status);
}

const BEARER_PREFIX = 'Bearer ';

/** The run token out of an `Authorization` header value. */
export function bearerTokenOf(authorization: string): string {
  return authorization.startsWith(BEARER_PREFIX)
    ? authorization.slice(BEARER_PREFIX.length)
    : authorization;
}

/** What a run has spent so far: its own turns, and the usage of those and of its subagents. */
export type OpenAiAgentsUsageMeter = {
  /**
   * Add one model response's usage. `ownTurn` is false for a subagent's, which is reported usage
   * but not one of the run's turns.
   */
  readonly record: (raw: unknown, ownTurn: boolean) => void;
  readonly turns: () => number;
  readonly usage: () => OpenAiAgentsUsage | null;
};

export function createUsageMeter(): OpenAiAgentsUsageMeter {
  // An object, so reads after the stream loop are not narrowed away by the closure's writes.
  const state: { usage: OpenAiAgentsUsage | null; turns: number } = { usage: null, turns: 0 };
  return {
    record: (raw, ownTurn) => {
      const data = raw as { type?: unknown; response?: { usage?: unknown } };
      if (data.type !== 'response_done') return;
      if (ownTurn) state.turns += 1;
      state.usage = addResponseUsage(state.usage, data.response?.usage);
    },
    turns: () => state.turns,
    usage: () => state.usage,
  };
}

/** The SDK's `modelSettings` for a compiled agent; a setting the run left open is left out. */
export function modelSettingsOf(settings: OpenAiAgentsCompiled['agent']['modelSettings']) {
  const { parallelToolCalls, reasoningEffort } = settings;
  return {
    ...(parallelToolCalls === null ? {} : { parallelToolCalls }),
    ...(reasoningEffort === null ? {} : { reasoning: { effort: reasoningEffort } }),
  };
}

/** The connector as the options of the SDK class its transport selects. */
export function mcpConnectionOf(
  server: OpenAiAgentsMcpServer,
  env: Readonly<Record<string, string>>,
) {
  const common = {
    name: server.name,
    ...(server.timeoutMs === null ? {} : { timeout: server.timeoutMs }),
    ...(server.blockedTools.length === 0
      ? {}
      : { toolFilter: { blockedToolNames: [...server.blockedTools] } }),
  };
  if (server.transport === 'stdio') {
    return {
      transport: server.transport,
      options: {
        ...common,
        command: server.command,
        args: [...server.args],
        env: { ...env, ...server.env },
      },
    };
  }
  return {
    transport: server.transport,
    options: { ...common, url: server.url, requestInit: { headers: { ...server.headers } } },
  };
}
