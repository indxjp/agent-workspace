/**
 * `mcpEndpoint`: the one MCP endpoint of an app (F-10, issue #1504), which agents reach as an
 * ordinary `mcp` connector that opts into the platform's signed identity assertion (ADR-0142). The
 * generated `app/api/mcp/route.ts` is one line: `export const { POST, GET, DELETE } =
 * mcpEndpoint(app);`.
 *
 * Every request, in this order: the assertion is verified against the connector id, the workspace
 * and the signing secrets of the app's environment; then a fresh stateless MCP server answers
 * `tools/list` with the app's agent tools and `tools/call` by resolving the person the assertion
 * names (`via: 'agent'`, its `runId`) and running the store as them, so the resource's `access` ∩
 * `agents.write` decides and every write's audit row carries the run. A refused assertion never
 * reaches a store, and the assertion is never written to a log or an answer.
 */
import {
  IDENTITY_ASSERTION_HEADER,
  verifyIdentity,
  type IdentityAssertionPayload,
  type IdentityAssertionProblemCode,
} from '@indx-workspace/contracts/identity-assertion';
import { createClient } from '@indx-workspace/sdk';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';

import type { DefinedApp } from '../app.js';
import { AppStoreError } from '../db/errors.js';
import { agentPerson, cachedMemberDirectory, type MemberDirectory } from './mcp-person.js';
import { agentToolsOf, callAgentTool, type AgentTool } from './mcp-tools.js';
import { NO_STORE, problem, problemFromError } from './problem.js';
import { MAX_BODY_BYTES } from './routes.js';
import { appRuntime, type AgentToolsConfig, type AppRuntime } from './runtime.js';

/** A handler of `app/api/mcp/route.ts`. */
export type McpHandler = (request: Request) => Promise<Response>;

/** The handlers of `app/api/mcp/route.ts`: `POST` serves MCP; `GET` and `DELETE` answer `405`. */
export interface McpEndpoint {
  readonly POST: McpHandler;
  readonly GET: McpHandler;
  readonly DELETE: McpHandler;
}

/** The fixed text of a tool call that failed for any reason other than a store's refusal. */
export const AGENT_TOOL_FAILURE_MESSAGE = 'The app request failed.';

const IDENTITY_MESSAGES: Readonly<Record<IdentityAssertionProblemCode, string>> = {
  identity_assertion_invalid: 'The request carries no valid identity assertion for this app.',
  identity_assertion_expired: 'The identity assertion has expired.',
  identity_audience_mismatch: 'The identity assertion was signed for another connector.',
  identity_workspace_mismatch: 'The identity assertion was signed for another workspace.',
};

const AGENT_TOOLS_MISCONFIGURED =
  'The app’s agent tools are not configured: AW_APP_CONNECTOR_ID, AW_WORKSPACE_ID, ' +
  'AW_APP_IDENTITY_SECRET and AW_APP_API_KEY must all be set and valid.';

function methodNotAllowed(): Promise<Response> {
  const response = problem(
    'method_not_allowed',
    405,
    'This endpoint is stateless: only POST is served.',
  );
  response.headers.set('allow', 'POST');
  return Promise.resolve(response);
}

/** One member directory per runtime (and so per process): the role cache lives here. */
const directories = new WeakMap<AppRuntime, MemberDirectory>();

function directoryOf(runtime: AppRuntime, config: AgentToolsConfig): MemberDirectory {
  let directory = directories.get(runtime);
  if (directory === undefined) {
    const client = createClient({
      baseUrl: runtime.awUrl,
      auth: { kind: 'api-key', apiKey: config.apiKey },
      ...(runtime.fetch === undefined ? {} : { fetch: runtime.fetch }),
    });
    directory = cachedMemberDirectory(() => client.team.members.list());
    directories.set(runtime, directory);
  }
  return directory;
}

function nameOf(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

/** A store's refusal as a tool result: `<code>: <message>`, naming the fields or rule refused. */
function refusalResult(error: AppStoreError): CallToolResult {
  const details = error.details === undefined ? '' : ` (${error.details.join(', ')})`;
  return {
    isError: true,
    content: [{ type: 'text', text: `${error.code}: ${error.message}${details}` }],
    structuredContent: {
      error: {
        code: error.code,
        message: error.message,
        ...(error.details === undefined ? {} : { details: [...error.details] }),
      },
    },
  };
}

function unknownTool(): CallToolResult {
  return {
    isError: true,
    content: [{ type: 'text', text: 'unknown_tool: This app has no agent tool of that name.' }],
  };
}

interface CallContext {
  readonly runtime: AppRuntime;
  readonly directory: MemberDirectory;
  readonly payload: IdentityAssertionPayload;
}

async function call(tool: AgentTool, args: unknown, context: CallContext): Promise<CallToolResult> {
  try {
    const person = await agentPerson(context.payload, context.directory);
    const result = await callAgentTool(tool, args, person, context.runtime.storeOf(tool.resource));
    return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
  } catch (error) {
    if (error instanceof AppStoreError && error.code !== 'internal_error') {
      return refusalResult(error);
    }
    console.error(`[@indx-workspace/app] an agent tool call failed (${nameOf(error)})`);
    // The SDK would answer a thrown error with its own text, which may name a host or a secret.
    throw new McpError(ErrorCode.InternalError, AGENT_TOOL_FAILURE_MESSAGE);
  }
}

async function serveMcp(
  request: Request,
  tools: readonly AgentTool[],
  context: CallContext,
): Promise<Response> {
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const mcp = new McpServer(
    { name: 'agent-workspace-app', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );
  mcp.server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    })),
  }));
  mcp.server.setRequestHandler(CallToolRequestSchema, ({ params }) => {
    const tool = byName.get(params.name);
    return tool === undefined ? unknownTool() : call(tool, params.arguments, context);
  });
  // No `sessionIdGenerator`: the SDK's stateless mode, so no client is ever handed a session id.
  const transport = new WebStandardStreamableHTTPServerTransport({
    enableJsonResponse: true,
    maxRequestBodySize: MAX_BODY_BYTES,
  });
  await mcp.connect(transport);
  try {
    const response = await transport.handleRequest(request);
    response.headers.set('cache-control', NO_STORE);
    return response;
  } finally {
    await mcp.close();
  }
}

async function serve(request: Request, tools: readonly AgentTool[]): Promise<Response> {
  if (request.method.toUpperCase() !== 'POST') return methodNotAllowed();
  let runtime: AppRuntime;
  try {
    runtime = appRuntime();
  } catch (error) {
    return problemFromError(error);
  }
  const config = runtime.agentTools;
  if (config === undefined) return problem('app_misconfigured', 500, AGENT_TOOLS_MISCONFIGURED);
  const assertion = request.headers.get(IDENTITY_ASSERTION_HEADER) ?? '';
  // Verified before anything else is touched; a refusal is its code, never the header's text.
  const verified =
    assertion === ''
      ? ({ ok: false, code: 'identity_assertion_invalid' } as const)
      : await verifyIdentity(assertion, config.identitySecrets, new Date(), {
          audience: config.connectorId,
          workspace: config.workspaceId,
        });
  if (!verified.ok) return problem(verified.code, 401, IDENTITY_MESSAGES[verified.code]);
  return serveMcp(request, tools, {
    runtime,
    directory: directoryOf(runtime, config),
    payload: verified.payload,
  });
}

/**
 * The MCP endpoint of `app`, for `app/api/mcp/route.ts`: its agent tools (`<name>_list`,
 * `<name>_get`, `<name>_search`, `<name>_update`) behind the identity assertion.
 *
 * | Status | Code                                                                                     |
 * | ------ | ---------------------------------------------------------------------------------------- |
 * | 401    | `identity_assertion_invalid` (missing or bad), `identity_assertion_expired`, `identity_audience_mismatch`, `identity_workspace_mismatch` |
 * | 405    | `method_not_allowed` (`GET`, `DELETE`; `allow: POST`)                                    |
 * | 500    | `app_misconfigured` (the app's or the agent tools' environment)                         |
 *
 * A tool call the store refuses is a tool result with `isError: true` and the text
 * `<code>: <message> (<details>)`; any other failure is the MCP error `InternalError` with the
 * fixed text {@link AGENT_TOOL_FAILURE_MESSAGE}.
 */
export function mcpEndpoint(app: DefinedApp): McpEndpoint {
  const tools = agentToolsOf(app);
  return {
    POST: (request) => serve(request, tools),
    GET: () => methodNotAllowed(),
    DELETE: () => methodNotAllowed(),
  };
}
