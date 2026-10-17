/**
 * A scripted fake gateway, for proving an adapter without a provider credential (ENG-04, #303).
 *
 * The conformance kit has to be runnable in CI, on a laptop and inside a pull request from a
 * fork, so it cannot reach a model. What it *can* do is stand in front of the adapter as the
 * thing the adapter believes the gateway to be: something that receives an HTTP request in a
 * declared wire protocol and answers with a recorded response.
 *
 * Two properties make it evidence rather than decoration:
 *
 *   * **it records what it was asked.** An adapter that never calls the gateway, or that calls it
 *     with the wrong bearer, is a passing run under a fake that only replays — so every request
 *     is kept and the scenarios assert on them.
 *   * **it answers per wire protocol.** `anthropic-messages` and the two OpenAI ingresses have
 *     different response envelopes, and an adapter compiled against the wrong one would fail
 *     against the real gateway while passing against a fake that always answered the same shape.
 */
import type { EngineGatewayConnection } from '../port.js';

/** One request the gateway received, as the adapter sent it. */
export type RecordedGatewayRequest = {
  readonly protocol: string;
  readonly path: string;
  readonly authorization: string | null;
  readonly body: unknown;
};

/** One scripted answer. `status` is the HTTP status the adapter should observe. */
export type ScriptedGatewayResponse = {
  readonly status: number;
  readonly body: unknown;
};

export type ScriptedGateway = {
  /** What to hand an adapter as its {@link EngineGatewayConnection}. */
  readonly connection: EngineGatewayConnection;
  /** Every request this gateway received, oldest first. */
  requests(): readonly RecordedGatewayRequest[];
  /** Serve one request. Returns the next scripted response, or a 500 naming the exhaustion. */
  handle(request: Omit<RecordedGatewayRequest, 'protocol'>): ScriptedGatewayResponse;
};

/** The default body for each ingress, so a scenario that does not care need not script one. */
const DEFAULT_RESPONSES: Readonly<Record<string, unknown>> = {
  'anthropic-messages': {
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text: 'scripted' }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 1, output_tokens: 1 },
  },
  'openai-responses': {
    object: 'response',
    output: [
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'scripted' }] },
    ],
    usage: { input_tokens: 1, output_tokens: 1 },
  },
  'openai-chat-completions': {
    object: 'chat.completion',
    choices: [
      { index: 0, message: { role: 'assistant', content: 'scripted' }, finish_reason: 'stop' },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  },
};

export type ScriptedGatewayOptions = {
  readonly protocol?: string;
  readonly baseUrl?: string;
  readonly token?: string;
  /** Responses to serve, in order. After the last one the gateway answers 500 by name. */
  readonly script?: readonly ScriptedGatewayResponse[];
};

/**
 * Build a scripted gateway.
 *
 * The token defaults to a fixed, obviously-fake string rather than a random one: a scenario that
 * asserts *"the sandbox environment's credential-shaped variables all hold the run token"* is
 * easier to read — and easier to debug when it fails — when the token in the assertion and the
 * token in the failure message are the same visible literal.
 */
export function createScriptedGateway(options: ScriptedGatewayOptions = {}): ScriptedGateway {
  const protocol = options.protocol ?? 'anthropic-messages';
  const connection: EngineGatewayConnection = {
    baseUrl: options.baseUrl ?? 'http://gateway.invalid',
    token: options.token ?? 'run-token-for-conformance',
    protocol,
  };
  const received: RecordedGatewayRequest[] = [];
  const script = [...(options.script ?? [])];
  let served = 0;

  return {
    connection,
    requests: () => [...received],
    handle(request) {
      received.push({ ...request, protocol });
      const scripted = script[served];
      served += 1;
      if (scripted !== undefined) return scripted;
      const body = DEFAULT_RESPONSES[protocol];
      if (body === undefined) {
        return {
          status: 500,
          body: {
            error: 'unscripted_protocol',
            message: `this scripted gateway has no default response for wire protocol ${JSON.stringify(protocol)}; pass one in \`script\`.`,
          },
        };
      }
      return { status: 200, body };
    },
  };
}
