/**
 * The gateway as a Vercel Function (ADR-0126, ADR-0120 clause 7): the same application
 * `startGateway` serves, behind a Web `fetch` export. The stores are opened by the first request
 * and shared by the invocations that instance serves; a failed start is not kept, so the next
 * request tries again instead of a broken instance answering every call.
 */
import { createJsonLogger, type Logger } from '@agent-workspace/core/telemetry';
import { startTracing, type Tracing } from '@agent-workspace/core/tracing';

import { createGatewayFromEnvironment, type GatewayFromEnvironment } from './index.js';
import { adoptTrace, fetchInSpan, requestLogger } from './server.js';

type Environment = Readonly<Record<string, string | undefined>>;

/**
 * How long a response waits for its spans to export. An instance may be frozen once it answers, so
 * the batch timer cannot be relied on; a slow collector delays a response by at most this much.
 */
const SPAN_FLUSH_TIMEOUT_MS = 200;

function failed(): Response {
  return new Response(
    JSON.stringify({
      type: 'error',
      error: { type: 'gateway_internal_error', message: 'The gateway request failed.' },
      request_id: `gateway_${crypto.randomUUID()}`,
    }),
    { status: 500, headers: { 'content-type': 'application/json; charset=utf-8' } },
  );
}

export function createGatewayFunction(
  env: Environment = process.env,
  create: (env: Environment) => Promise<GatewayFromEnvironment> = createGatewayFromEnvironment,
  logger: Logger = createJsonLogger({ service: 'gateway' }),
): { fetch(request: Request): Promise<Response> } {
  let started: Promise<GatewayFromEnvironment> | undefined;
  // Started once per instance, before the first span; a failure leaves spans off, never the gateway.
  let tracing: Promise<Tracing | null> | undefined;
  return {
    async fetch(incoming) {
      // The same trace adoption the Node server does while it builds its `Request` (F-04).
      const headers = new Headers(incoming.headers);
      adoptTrace(headers);
      const request = new Request(incoming, { headers });
      tracing ??= startTracing('agent-workspace-gateway', env, logger);
      const spans = await tracing;
      started ??= create(env);
      let gateway: GatewayFromEnvironment;
      try {
        gateway = await started;
      } catch (error) {
        started = undefined;
        requestLogger(logger, request).error('gateway failed to start', { error });
        return failed();
      }
      try {
        return await fetchInSpan(gateway.application, request);
      } catch (error) {
        requestLogger(logger, request).error('gateway request failed', { error });
        return failed();
      } finally {
        await spans?.flush(SPAN_FLUSH_TIMEOUT_MS);
      }
    },
  };
}
