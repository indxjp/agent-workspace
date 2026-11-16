import type { ToolSandboxUpstream } from './tool-sandbox.js';
import { type IncomingMessage, type ServerResponse } from 'node:http';
import {
  body,
  forward,
  json,
  ManagerRequestError,
  providerCredentialOf,
  segment,
} from './manager-support.js';
import {
  parseToolSandboxRequest,
  ToolSandboxUnavailableError,
  type ToolSandboxes,
} from './tool-sandbox.js';
import type { RunnerManagerOptions } from './manager-options.js';

// An allocation may carry a session's tool bundles, base64 inside JSON (ADR-0118 TS2).

// The gateway caps a tool request at 4 MiB (ADR-0118 TS3); the manager route accepts no more.
const MAX_TOOL_REQUEST_BYTES = 4 * 1024 * 1024;

/** The request headers the gateway sets for a tool sandbox, which the manager route passes on. */
const TOOL_SANDBOX_HEADERS = ['mcp-protocol-version', 'x-aw-agent', 'x-aw-run-id'];

/**
 * On the manager's tool route `authorization` carries the manager token, so the gateway sends the
 * tool host's per-run bearer here; it is passed on as the host's `authorization` (ADR-0132).
 */
const TOOL_RUN_AUTHORIZATION = 'x-aw-tool-authorization';

export function sandboxRequest(value: unknown): ReturnType<typeof parseToolSandboxRequest> {
  try {
    return parseToolSandboxRequest(value);
  } catch (error) {
    throw new ManagerRequestError(
      'invalid_tool_sandbox',
      error instanceof Error ? error.message : 'invalid toolSandbox',
      { cause: error },
    );
  }
}

/** `POST /tool-sandboxes/<id>/mcp`: true when the path was this route's, whatever the answer. */
async function serveToolSandbox(input: {
  req: IncomingMessage;
  res: ServerResponse;
  requestUrl: URL;
  toolSandboxes: ToolSandboxes | undefined;
  doFetch: typeof globalThis.fetch;
}): Promise<boolean> {
  const { req, res, requestUrl, toolSandboxes, doFetch } = input;
  const route = /^\/tool-sandboxes\/([^/]+)\/mcp$/u.exec(requestUrl.pathname);
  if (route === null) return false;
  const runAuthorization = req.headers[TOOL_RUN_AUTHORIZATION];
  if (typeof runAuthorization !== 'string' || !/^Bearer\s+\S/u.test(runAuthorization)) {
    json(res, 401, { error: 'unauthorized' });
    return true;
  }
  const upstream: ToolSandboxUpstream | undefined =
    req.method === 'POST' ? toolSandboxes?.upstream?.(route[1] ?? '') : undefined;
  if (upstream === undefined) {
    json(res, 404, { error: 'tool_sandbox_not_found' });
    return true;
  }
  const passed: Record<string, string> = {};
  for (const name of TOOL_SANDBOX_HEADERS) {
    const value = req.headers[name];
    if (typeof value === 'string') passed[name] = value;
  }
  await forward(
    req,
    res,
    upstream.url,
    doFetch,
    { ...passed, authorization: runAuthorization, ...upstream.headers },
    MAX_TOOL_REQUEST_BYTES,
  );
  return true;
}

/**
 * `POST /tool-sandboxes` (ADR-0134 part 2): starts (or reuses) the tool sandbox of a project
 * endpoint client with no agent runtime beside it. The client id is the session, so two clients
 * never share a sandbox, and the answer is the origin the control plane signs into a grant.
 */
async function openEndpointToolSandbox(input: {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly requestUrl: URL;
  readonly options: RunnerManagerOptions;
  readonly maxAllocationBodyBytes: number;
}): Promise<void> {
  const { toolSandboxes } = input.options;
  if (toolSandboxes === undefined) {
    throw new ToolSandboxUnavailableError(
      input.options.toolSandboxRefusal ??
        'this runner manager has no tool sandbox configured (set AGENT_WORKSPACE_TOOL_HOST_IMAGE)',
    );
  }
  const raw = await body(input.req, input.maxAllocationBodyBytes);
  const request = sandboxRequest(raw['toolSandbox']);
  const clientId = segment(raw['clientId'], 'clientId', 'invalid_session_id');
  const credential = providerCredentialOf(input.req);
  const origin = await toolSandboxes.open(
    {
      key: `endpoint:${clientId}`,
      workspaceId: segment(raw['workspaceId'], 'workspaceId', 'invalid_workspace_id'),
      sessionId: clientId,
      workspacesRoot: input.options.workspacesRoot,
      publicBase: `${input.requestUrl.protocol}//${input.requestUrl.host}`,
      ...(credential === undefined ? {} : { providerCredential: credential }),
    },
    request,
  );
  json(input.res, 200, { toolSandbox: { origin } });
}

/**
 * `DELETE /tool-sandboxes/sessions/<clientId>?workspaceId=<id>`: closes the endpoint sandbox that
 * `POST /tool-sandboxes` opened. The key is rebuilt here from the client id, so a caller can never
 * name another sandbox's key. With no tool sandboxes configured nothing can be open: 204.
 */
async function closeEndpointToolSandbox(input: {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly requestUrl: URL;
  readonly clientId: string;
  readonly options: RunnerManagerOptions;
  readonly maxAllocationBodyBytes: number;
}): Promise<void> {
  const clientId = segment(input.clientId, 'clientId', 'invalid_session_id');
  const workspaceId = segment(
    input.requestUrl.searchParams.get('workspaceId'),
    'workspaceId',
    'invalid_workspace_id',
  );
  await input.options.toolSandboxes?.close(
    { key: `endpoint:${clientId}`, workspaceId, sessionId: clientId },
    providerCredentialOf(input.req),
  );
  input.res.writeHead(204).end();
}

/**
 * `DELETE /tool-sandboxes/runs/<runId>?workspaceId=<id>` (issue #832): removes the tool sandboxes
 * that run started, and nothing else. The session's agent runtime, and a tool sandbox the run only
 * reused, stay up for the session's other runs. With no tool sandboxes configured: 204. True when
 * the request was this route's.
 */
async function releaseRunToolSandboxes(input: {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly requestUrl: URL;
  readonly options: RunnerManagerOptions;
  readonly maxAllocationBodyBytes: number;
}): Promise<boolean> {
  const route = /^\/tool-sandboxes\/runs\/([^/]+)$/u.exec(input.requestUrl.pathname);
  if (input.req.method !== 'DELETE' || route === null) return false;
  await input.options.toolSandboxes?.release?.(
    {
      workspaceId: segment(
        input.requestUrl.searchParams.get('workspaceId'),
        'workspaceId',
        'invalid_workspace_id',
      ),
      runId: segment(route[1], 'runId', 'invalid_run_id'),
    },
    providerCredentialOf(input.req),
  );
  input.res.writeHead(204).end();
  return true;
}

export async function serveToolEndpoints(input: {
  req: IncomingMessage;
  res: ServerResponse;
  requestUrl: URL;
  options: RunnerManagerOptions;
  doFetch: typeof globalThis.fetch;
  maxAllocationBodyBytes: number;
}): Promise<boolean> {
  const { req, res, requestUrl, options, doFetch } = input;
  if (
    await serveToolSandbox({ req, res, requestUrl, toolSandboxes: options.toolSandboxes, doFetch })
  )
    return true;
  if (req.method === 'POST' && requestUrl.pathname === '/tool-sandboxes') {
    await openEndpointToolSandbox(input);
    return true;
  }
  const closing = /^\/tool-sandboxes\/sessions\/([^/]+)$/u.exec(requestUrl.pathname);
  if (req.method === 'DELETE' && closing !== null) {
    await closeEndpointToolSandbox({ ...input, clientId: closing[1] ?? '' });
    return true;
  }
  return releaseRunToolSandboxes(input);
}
