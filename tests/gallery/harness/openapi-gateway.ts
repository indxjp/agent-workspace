/**
 * The platform's tool gateway for an `openapiTool()`, as a session the scripted workspace can call
 * (`packages/gateway/src/tools/openapi.ts`, `authorize.ts`). What it assumes, read from the gateway
 * and `apps/web/server/openapi/normalise.ts`: one tool per operation the `allow` rules admit, named
 * by its `operationId`; arguments are the operation's parameters by name; the result is the upstream
 * body as text, an error when the status is not 2xx; the credential is the connector's, sent as
 * `Authorization: Bearer`. A Claude run names the tools `mcp__<connector>__<operationId>`.
 *
 * A write operation (`POST`, `PUT`, `PATCH`, `DELETE`) takes its JSON request body as the `body`
 * argument and is gated as the gateway gates it (`authorize.ts`, `isApprovedCall`): it runs only
 * when its canonical call is in `approvedToolCalls` (fixed at setup) or in the call's own
 * `options.approvedToolCalls` (the run's approved calls, as the gateway reads them from the run),
 * else the result is the error `approval_required` and the upstream is never dialled. The gate is
 * made of the contract's own `toolApprovalRules`, `needsApproval` and `canonicalCall`. The session
 * exposes those `approvalRules`, because on the server the engine gates the same calls first
 * (`compose/run-request.ts`, `enginePolicyArmFor`).
 *
 * A connector that opted in to the identity assertion (ADR-0142) also gets `x-aw-identity` on each
 * call: the scripted workspace passes the signed header as the call's `options.headers`
 * (`./identity.ts`), exactly as it does for an MCP connector.
 */
import { canonicalCall, needsApproval } from '@indx-workspace/contracts/agents';
import {
  selectAllowedOperations,
  toolApprovalRules,
  TOOL_OPERATION_METHODS,
  type ToolOperationMethod,
} from '@indx-workspace/contracts/tool-connectors';

import type { McpCallOptions, McpSession, McpToolResult } from './mcp-client.ts';

export interface Operation {
  readonly method: string;
  readonly path: string;
  readonly operationId: string;
  readonly parameters: readonly { readonly name: string; readonly in: string }[];
}

/** The part of an OpenAPI document the gateway reads. */
export interface OpenApiDocument {
  readonly paths: Readonly<
    Record<
      string,
      Readonly<Record<string, { operationId: string; parameters?: Operation['parameters'] }>>
    >
  >;
}

export interface OpenApiGatewaySetup {
  readonly document: OpenApiDocument;
  /** The connector's `allow` rules, e.g. `erpTool.allow`. */
  readonly allow: Parameters<typeof selectAllowedOperations>[0];
  readonly baseUrl: string;
  /** The connector's credential; `null` sends none. */
  readonly token: string | null;
  /** The connector's MCP server key in the run, `toolServerKey(name)`; it names the approval rules. */
  readonly serverKey: string;
  /** The canonical text of the calls a person approved (`runs.approved_tool_calls`). Default: none. */
  readonly approvedToolCalls?: readonly string[];
}

/** Every operation `document` declares. */
export function operationsOf(document: OpenApiDocument): Operation[] {
  return Object.entries(document.paths).flatMap(([template, methods]) =>
    Object.entries(methods).map(([method, operation]) => ({
      method: method.toUpperCase(),
      path: template,
      operationId: operation.operationId,
      parameters: operation.parameters ?? [],
    })),
  );
}

/** Whether `method` (upper case) is one of the contract's tool operation methods. */
export const isToolMethod = (method: string): method is ToolOperationMethod =>
  TOOL_OPERATION_METHODS.some((known) => known === method);

/** The gateway as a session; `approvalRules` are what compose merges into the engine's `requireApproval`. */
export type OpenApiGatewaySession = Omit<McpSession, 'post'> & {
  readonly approvalRules: readonly string[];
};

export function openapiGateway(setup: OpenApiGatewaySetup): OpenApiGatewaySession {
  const admitted = selectAllowedOperations(setup.allow, operationsOf(setup.document)).admitted;
  const approvalRules = toolApprovalRules(
    setup.serverKey,
    admitted.flatMap((operation) =>
      isToolMethod(operation.method)
        ? [{ name: operation.operationId, method: operation.method }]
        : [],
    ),
  );
  async function call(
    name: string,
    args: Record<string, unknown>,
    options?: McpCallOptions,
  ): Promise<McpToolResult> {
    const operation = admitted.find((candidate) => candidate.operationId === name);
    if (operation === undefined)
      return { text: `unknown tool ${JSON.stringify(name)}`, isError: true };
    const toolName = `mcp__${setup.serverKey}__${name}`;
    if (needsApproval(approvalRules, toolName)) {
      const call = canonicalCall(toolName, args);
      const approved = [...(setup.approvedToolCalls ?? []), ...(options?.approvedToolCalls ?? [])];
      if (!approved.includes(call)) return { text: 'approval_required', isError: true };
    }
    let route = operation.path;
    const query = new URLSearchParams();
    for (const parameter of operation.parameters) {
      const value = args[parameter.name];
      if (value === undefined) continue;
      if (typeof value !== 'string') {
        return { text: `invalid arguments: ${parameter.name} must be a string`, isError: true };
      }
      if (parameter.in === 'path')
        route = route.replace(`{${parameter.name}}`, encodeURIComponent(value));
      else query.set(parameter.name, value);
    }
    const search = query.size === 0 ? '' : `?${query.toString()}`;
    const hasBody = args['body'] !== undefined && !['GET', 'HEAD'].includes(operation.method);
    const response = await fetch(`${setup.baseUrl}${route}${search}`, {
      method: operation.method,
      headers: {
        ...(setup.token === null ? {} : { authorization: `Bearer ${setup.token}` }),
        ...(hasBody ? { 'content-type': 'application/json' } : {}),
        ...options?.headers,
      },
      ...(hasBody ? { body: JSON.stringify(args['body']) } : {}),
    });
    return { text: await response.text(), isError: !response.ok };
  }
  return {
    tools: () => Promise.resolve(admitted.map((operation) => operation.operationId)),
    call,
    callJson: async <T = unknown>(
      name: string,
      args: Record<string, unknown>,
      options?: McpCallOptions,
    ): Promise<T> => {
      const result = await call(name, args, options);
      if (result.isError) throw new Error(`${name} refused: ${result.text}`);
      return JSON.parse(result.text) as T;
    },
    close: () => undefined,
    approvalRules,
  };
}
