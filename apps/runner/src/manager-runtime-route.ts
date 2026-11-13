import { type IncomingMessage, type ServerResponse } from 'node:http';
import {
  RUN_FILES_MAX_ARCHIVE_BYTES,
  RUN_FILES_MAX_BYTES,
} from '@agent-workspace/runtime/transfer';
import {
  allocationBody,
  forward,
  isHandleProbe,
  json,
  providerCredentialOf,
  toolSessionOf,
  type Allocation,
} from './manager-support.js';
import type { ManagerContext } from './manager-context.js';

export async function serveAllocation(
  context: ManagerContext,
  req: IncomingMessage,
  res: ServerResponse,
  requestUrl: URL,
): Promise<boolean> {
  const { options, allocations, runtimeRequestUrl, doFetch, authHeaders } = context;
  const allocationOf = (id: string): Allocation | undefined => {
    if (options.driver.recover === undefined) return allocations.get(id);
    const handle = options.driver.recover(id);
    return handle === undefined ? undefined : { handle, sessionKey: '' };
  };
  const match = /^\/runtimes\/([^/]+)(?:\/(run|interrupt|files))?$/u.exec(requestUrl.pathname);
  if (match === null) return false;
  const id = match[1] ?? '';
  const operation = match[2];
  const allocation = allocationOf(id);
  if (allocation === undefined) {
    // A stateless manager keeps no table, so an expired id and one it never sealed look
    // alike; both answer the contract's `live: false`, which tells nothing about which ids
    // ever existed. Everything else on the id stays a 404.
    if (isHandleProbe(req.method, operation, options.driver.recover !== undefined)) {
      json(res, 200, { live: false });
      return true;
    }
    json(res, 404, { error: 'runtime_not_found' });
    return true;
  }
  if (operation === undefined && req.method === 'GET') {
    json(res, 200, {
      ...allocationBody(allocation, requestUrl),
      live: await options.driver.isLive(allocation.handle),
    });
    return true;
  }
  if (operation === undefined && req.method === 'DELETE') {
    await deleteAllocation(context, req, allocation, id);
    res.writeHead(204).end();
    return true;
  }
  if (operation !== undefined) {
    await forward(
      req,
      res,
      runtimeRequestUrl(allocation.handle, `/${operation}${requestUrl.search}`),
      doFetch,
      await authHeaders(allocation.handle),
      // A `/files` body is a tar archive: its framing is on top of the payload limit.
      operation === 'files' ? RUN_FILES_MAX_ARCHIVE_BYTES : RUN_FILES_MAX_BYTES,
    );
    return true;
  }
  return false;
}

async function deleteAllocation(
  context: ManagerContext,
  req: IncomingMessage,
  allocation: Allocation,
  id: string,
): Promise<void> {
  const { options, allocations, bySession } = context;
  // A runtime that fails to stop must not leak its tool sandbox and the secrets in it.
  const [runtime, tools] = await Promise.allSettled([
    options.driver.destroy(allocation.handle, providerCredentialOf(req)),
    options.toolSandboxes?.close(
      toolSessionOf(options.workspacesRoot, allocation),
      providerCredentialOf(req),
    ),
  ]);
  if (runtime.status === 'rejected') throw runtime.reason;
  // The runtime is gone: drop the allocation before surfacing a tool close error, so the
  // session is not stuck on a dead runtime.
  allocations.delete(id);
  if (bySession.get(allocation.sessionKey) === id) bySession.delete(allocation.sessionKey);
  if (tools.status === 'rejected') throw tools.reason;
}
