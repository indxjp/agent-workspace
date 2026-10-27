import type { ModelConnectionConfig } from '@indx-workspace/contracts/models';
import type { ModelProvider } from '@indx-workspace/contracts/runs';
import type { RegisteredProviderId } from './providers/registry.js';
import type { GatewayRouter, RequestContext, WireProtocol } from './types.js';
import type { RunTokenClaims, RunTokenCodec } from './tokens/run-token.js';
import { extractResponseUsage } from './usage/index.js';

type ActiveRunResolution = {
  readonly state: 'active';
  readonly providerId: RegisteredProviderId;
  readonly connectionProvider: ModelProvider;
  readonly credential: string;
  readonly settings?: ModelConnectionConfig;
};

export type RunResolution =
  | ActiveRunResolution
  | { readonly state: 'deleted' }
  | { readonly state: 'missing' }
  | { readonly state: 'revoked' };

export interface GatewayRunResolver {
  resolve(claims: RunTokenClaims, tokenHash: string): Promise<RunResolution>;
}

export type GatewayAuthentication =
  | {
      readonly ok: true;
      readonly claims: RunTokenClaims;
      readonly connectionProvider: ModelProvider;
      readonly context: RequestContext;
    }
  | { readonly ok: false; readonly response: Response };

export interface UsageRecorder {
  record(usage: GatewayUsageRecord): Promise<void>;
  /**
   * A provider response was captured but could not be turned into settlement data at all — no
   * measurable usage fields, or no identifiable model (issue #134). Never called when
   * {@link record} could be; that always carries strictly more information.
   */
  fail(runId: string, reason: string): Promise<void>;
}

export type GatewayUsageRecord = Readonly<{
  runId: string;
  providerResponseId: string;
  provider: ModelProvider;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  toolCalls: number;
  /** The dialect this response was served in, recorded on `run_usage_records.wire_protocol`. */
  wireProtocol: WireProtocol;
  /**
   * The counters above were measured. `false` means the upstream finished and reported nothing
   * usable — the named `openai-compatible` risk — so the recorder settles the run as unpriced
   * (`unavailable`) rather than claiming a measured zero (ADR-0068 D9). Only the two relayed OpenAI
   * dialects ever record such a row; an unmetered `anthropic-messages` response fails instead.
   */
  metered: boolean;
}>;

/** The gateway's own refusals. Every run-token code starts `token_` and a provider's `401` is
 * relayed unchanged, never under that prefix: the Claude engine adapter relies on it to tell a
 * refused run token from a rejected provider key (issue #661). */
function problem(
  status: number,
  code: string,
  message: string,
): { readonly ok: false; readonly response: Response } {
  return {
    ok: false,
    response: Response.json(
      { type: 'error', error: { type: 'authentication_error', code, message } },
      { status },
    ),
  };
}

function bearer(request: Request): string | null {
  const authorization = request.headers.get('authorization');
  if (authorization === null) return null;
  const match = /^Bearer\s+([^\s]+)$/iu.exec(authorization);
  return match?.[1] ?? null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export type RunTokenVerificationOutcome =
  | { readonly ok: true; readonly claims: RunTokenClaims; readonly tokenHash: string }
  | { readonly ok: false; readonly response: Response };

/**
 * The bearer and signature steps every run-token route shares. It reads nothing but the request
 * and the codec, so a route that never needs the model key (the tool route) can stop here.
 */
export async function verifyRunToken(
  request: Request,
  tokens: RunTokenCodec,
): Promise<RunTokenVerificationOutcome> {
  const token = bearer(request);
  if (token === null) return problem(401, 'token_missing', 'A gateway run token is required.');
  const verification = await tokens.verify(token);
  if (!verification.ok) {
    return verification.reason === 'expired'
      ? problem(401, 'token_expired', 'The gateway run token has expired.')
      : problem(401, 'token_invalid', 'The gateway run token is invalid.');
  }
  return { ok: true, claims: verification.claims, tokenHash: await sha256(token) };
}

/** Resolve one bearer token all the way to a provider credential held outside the sandbox. */
export async function authenticateGatewayRequest(
  request: Request,
  tokens: RunTokenCodec,
  resolver: GatewayRunResolver,
  expectedRunId?: string,
): Promise<GatewayAuthentication> {
  const verified = await verifyRunToken(request, tokens);
  if (!verified.ok) return verified;
  const { claims } = verified;
  if (expectedRunId !== undefined && claims.runId !== expectedRunId) {
    return problem(403, 'token_run_mismatch', 'The gateway token belongs to a different run.');
  }
  const resolved = await resolver.resolve(claims, verified.tokenHash);
  if (resolved.state === 'revoked') {
    return problem(401, 'token_revoked', 'The gateway run token has been revoked.');
  }
  if (resolved.state === 'deleted') {
    return problem(410, 'run_deleted', 'The run named by this gateway token was deleted.');
  }
  if (resolved.state === 'missing') {
    return problem(404, 'run_not_found', 'The run named by this gateway token does not exist.');
  }
  return {
    ok: true,
    claims,
    connectionProvider: resolved.connectionProvider,
    context: {
      providerId: resolved.providerId,
      credential: resolved.credential,
      requestId: `run_${claims.runId}_${crypto.randomUUID()}`,
      settings: resolved.settings ?? {},
      signal: request.signal,
    },
  };
}

/**
 * Whether a finished-but-unmetered response of this dialect is recorded at unpriced zeros instead of
 * failing the run's accounting (ADR-0068 D9).
 *
 * True for the two relayed OpenAI dialects, where a compatible upstream that ignores
 * `stream_options.include_usage` genuinely finishes without reporting anything. False for
 * `anthropic-messages`: that is the pre-existing rule, and widening it would silently change how the
 * gateway's original dialect settles.
 */
function isUnpricedWhenUnmetered(protocol: WireProtocol): boolean {
  return protocol === 'openai-responses' || protocol === 'openai-chat-completions';
}

async function recordResponseUsage(
  response: Response,
  identity: Readonly<{
    runId: string;
    provider: ModelProvider;
    requestId: string;
    requestedModel: string | null;
    wireProtocol: WireProtocol;
  }>,
  recorder: UsageRecorder,
): Promise<void> {
  const extracted = await extractResponseUsage(response, identity.wireProtocol);
  const model = extracted.model ?? identity.requestedModel;

  // Nothing was measured, and this dialect has no unpriced settlement for that (ADR-0068 D9):
  //
  //   * On `anthropic-messages` a 200 reporting no `usage` is a settlement failure whether or not
  //     the response declared itself finished — and every real one does, a non-streaming body
  //     through `type: "message"` and a stream through `message_stop`. This is the rule the gateway
  //     had before it spoke three dialects, and it is deliberately unchanged.
  //   * On the two OpenAI dialects only, a response that finished without reporting usage is
  //     recorded at unmeasured zeros below, which settles the run `unavailable`. A stream that
  //     stopped before any terminal frame is still a failure.
  if (
    !extracted.metered &&
    (!extracted.completed || !isUnpricedWhenUnmetered(identity.wireProtocol))
  ) {
    const reason = `provider response for run ${identity.runId} contained no authoritative usage fields`;
    await recorder.fail(identity.runId, reason).catch(() => undefined);
    throw new Error(reason);
  }
  if (model === null || model.length === 0) {
    const reason = `provider response for run ${identity.runId} did not identify its model`;
    await recorder.fail(identity.runId, reason).catch(() => undefined);
    throw new Error(reason);
  }
  await recorder.record({
    runId: identity.runId,
    providerResponseId: extracted.responseId ?? identity.requestId,
    provider: identity.provider,
    model,
    inputTokens: extracted.inputTokens,
    outputTokens: extracted.outputTokens,
    cacheReadInputTokens: extracted.cacheReadInputTokens,
    cacheCreationInputTokens: extracted.cacheCreationInputTokens,
    toolCalls: extracted.toolCalls,
    wireProtocol: identity.wireProtocol,
    metered: extracted.metered,
  });
}

/** How long a streamed response's true end-of-body waits for its settlement write before closing
 * anyway (issue #134: "Timing out leaves pending, not complete"). The DB write itself keeps
 * running in the background past the timeout — this bound only stops the caller waiting on it. */
const DEFAULT_SETTLEMENT_TIMEOUT_MS = 5_000;

/**
 * Forward `source` byte-for-byte as it arrives — no buffering, so streaming latency is
 * unaffected — and hold the stream open past the origin's own end-of-body until `settlement`
 * finishes or `timeoutMs` elapses, whichever comes first. `settlement` must never reject (its
 * caller already routes failures through `onUsageError`); a rejecting promise passed here would
 * error the stream instead of just closing it.
 *
 * This is how "the run's transition to a terminal state waits on [settlement], with a bounded
 * timeout" is implemented without buffering the response: the bytes the caller reads are
 * identical and timed identically to today, but the stream is not reported *finished* until
 * settlement has had its chance to land.
 */
function gateBodyOnSettlement(
  source: ReadableStream<Uint8Array>,
  settlement: Promise<void>,
  timeoutMs: number,
): ReadableStream<Uint8Array> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      reader = source.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value !== undefined) controller.enqueue(value);
        }
      } catch (error) {
        controller.error(error);
        return;
      }
      await Promise.race([
        settlement,
        new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, timeoutMs);
          (timer as { unref?: () => void }).unref?.();
        }),
      ]);
      controller.close();
    },
    cancel(reason) {
      return reader?.cancel(reason);
    },
  });
}

/**
 * The dialect a route speaks, or `null` for a route that speaks none.
 *
 * `/v1/models` and `/v1/messages/count_tokens` carry no model turn, so they are not metered at all.
 * That also repairs a pre-existing defect: a model listing on a run with a recorder attached used
 * to reach `recorder.fail` and mark the run's accounting failed.
 */
function meteredProtocol(pathname: string): WireProtocol | null {
  if (pathname === '/v1/messages') return 'anthropic-messages';
  if (pathname === '/v1/responses') return 'openai-responses';
  if (pathname === '/v1/chat/completions') return 'openai-chat-completions';
  return null;
}

/** Put authentication and usage accounting in front of the gateway's real provider router. */
export function createAuthenticatedGateway(
  router: GatewayRouter,
  tokens: RunTokenCodec,
  resolver: GatewayRunResolver,
  usage?: UsageRecorder,
  onUsageError: (error: unknown, request: Request) => void = () => undefined,
  settlementTimeoutMs = DEFAULT_SETTLEMENT_TIMEOUT_MS,
): Pick<GatewayRouter, 'fetch'> {
  return {
    async fetch(request) {
      const authentication = await authenticateGatewayRequest(request, tokens, resolver);
      if (!authentication.ok) return authentication.response;
      const wireProtocol = meteredProtocol(new URL(request.url).pathname);
      let requestedModel: string | null = null;
      try {
        const body: unknown = await request.clone().json();
        if (isRecord(body) && typeof body['model'] === 'string') requestedModel = body['model'];
      } catch {
        // Provider validation owns malformed request bodies. Usage parsing will require the model
        // from the successful provider response if it was not available here.
      }
      const response = await router.fetch(request, authentication.context);
      if (usage === undefined || wireProtocol === null || !response.ok) return response;

      const identity = {
        runId: authentication.claims.runId,
        provider: authentication.connectionProvider,
        requestId: authentication.context.requestId,
        requestedModel,
        wireProtocol,
      };
      const isStream = response.headers.get('content-type')?.includes('text/event-stream') ?? false;
      if (!isStream || response.body === null) {
        // Non-streaming: already fully buffered by the provider client, so awaiting here before
        // returning costs nothing extra — and closes exactly the gap issue #134 names: "the
        // process between the response being returned and the ledger insert".
        await recordResponseUsage(response.clone(), identity, usage).catch((error: unknown) => {
          onUsageError(error, request);
        });
        return response;
      }

      // Streaming: tee so the caller's bytes and the settlement read are independent — reading
      // one never waits on the other — then gate only the caller's *end-of-stream* signal on
      // settlement, bounded by `settlementTimeoutMs`.
      const [forward, capture] = response.body.tee();
      const settlement = recordResponseUsage(
        new Response(capture, { headers: response.headers }),
        identity,
        usage,
      ).catch((error: unknown) => {
        onUsageError(error, request);
      });
      return new Response(gateBodyOnSettlement(forward, settlement, settlementTimeoutMs), {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    },
  };
}
