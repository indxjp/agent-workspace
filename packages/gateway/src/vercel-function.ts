/**
 * The gateway as a Vercel Function (ADR-0126, ADR-0120 clause 7): the same application
 * `startGateway` serves, behind a Web `fetch` export. The stores are opened by the first request
 * and shared by the invocations that instance serves; a failed start is not kept, so the next
 * request tries again instead of a broken instance answering every call.
 */
import { createGatewayFromEnvironment, type GatewayFromEnvironment } from './index.js';

type Environment = Readonly<Record<string, string | undefined>>;

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
): { fetch(request: Request): Promise<Response> } {
  let started: Promise<GatewayFromEnvironment> | undefined;
  return {
    async fetch(request) {
      started ??= create(env);
      let gateway: GatewayFromEnvironment;
      try {
        gateway = await started;
      } catch (error) {
        started = undefined;
        process.stderr.write(
          `gateway failed to start: ${error instanceof Error ? error.message : String(error)}\n`,
        );
        return failed();
      }
      try {
        return await gateway.application.fetch(request);
      } catch {
        return failed();
      }
    },
  };
}
