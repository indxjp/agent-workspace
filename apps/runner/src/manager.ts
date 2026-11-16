import { serveAllocation } from './manager-runtime-route.js';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { authorized, json, requestUrlOf } from './manager-support.js';
import { createManagerContext, type ManagerContext } from './manager-context.js';
import type { RunnerManagerOptions } from './manager-options.js';
import { allocateRuntime } from './manager-allocation.js';
import { serveToolEndpoints } from './manager-tools.js';
import { verifyRuntime } from './manager-verification.js';
import { sendManagerFailure } from './manager-errors.js';
export type { RunnerManagerOptions } from './manager-options.js';

// Allocation JSON may carry base64 tool bundles; it is not a file-transfer limit.
const MAX_ALLOCATION_BODY_BYTES = 128 * 1024 * 1024;

/** Runner-owned runtime lifecycle and private reverse proxy. */
export function createRunnerManagerServer(options: RunnerManagerOptions): Server {
  return createServer(createRunnerManagerListener(options));
}

/** Request handler for Node servers and provider functions that own their listener. */
export function createRunnerManagerListener(
  options: RunnerManagerOptions,
): (req: IncomingMessage, res: ServerResponse) => void {
  const context = createManagerContext(options, MAX_ALLOCATION_BODY_BYTES);
  return (req, res) => {
    void handleManagerRequest(context, req, res).catch((error: unknown) =>
      sendManagerFailure(req, res, error),
    );
  };
}

async function handleManagerRequest(
  context: ManagerContext,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const { expectedToken, allocations } = context;
  // Reverse proxies terminate TLS; generated runner URLs retain the caller's forwarded scheme.
  const requestUrl = requestUrlOf(req);
  if (req.method === 'GET' && requestUrl.pathname === '/healthz') {
    json(res, 200, { status: 'ok', allocations: allocations.size });
    return;
  }
  if (!authorized(req, expectedToken)) {
    json(res, 401, { error: 'unauthorized' });
    return;
  }
  if (await serveToolEndpoints({ ...context, req, res, requestUrl })) return;
  if (req.method === 'POST' && requestUrl.pathname === '/runtimes') {
    await allocateRuntime({ ...context, req, res, requestUrl });
    return;
  }
  if (req.method === 'POST' && requestUrl.pathname === '/verify') {
    await verifyRuntime(context, req, res);
    return;
  }
  if (await serveAllocation(context, req, res, requestUrl)) return;
  json(res, 404, { error: 'not_found' });
}
