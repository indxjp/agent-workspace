/**
 * The `openapi` executor: one MCP tool per exposed operation (C17), called upstream with the
 * connector's own credential through the platform egress policy. The caller's headers, and so the
 * run token, are never forwarded. No text this module returns names the upstream URL, its host or
 * the credential, and nothing here logs.
 */
import {
  guardedFetch,
  loadEgressPolicyFromEnv,
  type EgressPolicyConfig,
} from '@agent-workspace/core';
import {
  OPENAPI_AUTH_HEADER_REFUSED_NAMES,
  TOOL_GATEWAY_PROBLEM_CODES,
  type OpenApiToolConfig,
  type ToolGatewayProblemCode,
} from '@indx-workspace/contracts/tool-connectors';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';

import type { ToolParameter } from './authorize.js';

export const TOOL_UPSTREAM_TIMEOUT_MS = 30_000;
export const TOOL_RESPONSE_MAX_BYTES = 256 * 1024;
const TRUNCATION_MARKER = `\n[truncated: the response exceeded ${String(TOOL_RESPONSE_MAX_BYTES)} bytes]`;

/** The locations a value can be sent in. A `cookie` parameter is neither advertised nor sent. */
const SENT_LOCATIONS: ReadonlySet<string> = new Set(['path', 'query', 'header']);
const REFUSED_HEADERS: ReadonlySet<string> = new Set<string>(OPENAPI_AUTH_HEADER_REFUSED_NAMES);

export type ToolCallOptions = {
  readonly transport?: typeof fetch;
  readonly timeoutMs?: number;
  readonly policy?: EgressPolicyConfig;
};

/**
 * ponytail: only the default query serialisation (`form`, exploded) is built; a stored
 * spaceDelimited/pipeDelimited/deepObject style is treated like a cookie parameter (not advertised,
 * not sent). `explode: false` is not persisted by S2-02c, so it cannot be detected here. Upgrade:
 * persist `explode` in the normaliser and serialise per style.
 */
function isSent(parameter: ToolParameter): boolean {
  if (!SENT_LOCATIONS.has(parameter.in)) return false;
  return parameter.in !== 'query' || parameter.style === undefined || parameter.style === 'form';
}

function sentParameters(parameters: readonly ToolParameter[] | undefined): ToolParameter[] {
  return (parameters ?? []).filter(isSent);
}

/**
 * ponytail: parameter schemas are advertised, not validated in the gateway (only required/unknown/
 * scalar checks); the upstream validates. Upgrade: ajv, already a dependency of the MCP SDK.
 */
export function listTools(
  config: OpenApiToolConfig,
  parameters: Readonly<Record<string, readonly ToolParameter[]>>,
): Tool[] {
  return config.operations.map((operation) => {
    const sent = sentParameters(parameters[operation.name]);
    return {
      name: operation.name,
      description: `${operation.method} ${operation.path}`,
      inputSchema: {
        type: 'object',
        properties: Object.fromEntries(sent.map((p) => [p.name, p.schema ?? {}])),
        required: sent.filter((p) => p.required).map((p) => p.name),
        additionalProperties: false,
      },
    };
  });
}

export function textResult(text: string, isError: boolean): CallToolResult {
  return { content: [{ type: 'text', text }], isError };
}

export function upstreamFailure(code: ToolGatewayProblemCode, message: string): CallToolResult {
  const status = TOOL_GATEWAY_PROBLEM_CODES[code];
  return {
    ...textResult(`${code} (${String(status)}): ${message}`, true),
    structuredContent: { error: { code, status } },
  };
}

type Scalar = string | number | boolean;

function isScalar(value: unknown): value is Scalar {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

class InvalidArgumentError extends Error {}

/** A WHATWG dot segment: `.` or `..`, with any dot written as `%2e`/`%2E`. */
function isDotSegment(segment: string): boolean {
  const dots = segment.replace(/%2e/giu, '.');
  return dots === '.' || dots === '..';
}

function decodedOnce(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** The operation path up to its first template, which every resolved path must keep. */
function literalPrefix(path: string): string {
  const brace = path.indexOf('{');
  return brace === -1 ? path : path.slice(0, brace);
}

/** `base` + `path` set through the WHATWG pathname setter, so both sides compare normalised. */
function joinedPathname(base: URL, path: string): string {
  const url = new URL(base);
  url.pathname = `${base.pathname.replace(/\/$/u, '')}${path}`;
  return url.pathname;
}

/** The credential header the connector's `auth` names, lower-cased, or `null` for `none`. */
function credentialHeaderName(auth: OpenApiToolConfig['auth']): string | null {
  if (auth === 'none') return null;
  if (auth === 'bearer') return 'authorization';
  return auth.header.toLowerCase();
}

function buildRequest(
  config: OpenApiToolConfig,
  path: string,
  parameters: readonly ToolParameter[],
  args: Readonly<Record<string, unknown>>,
  credential: string | null,
): { readonly url: string; readonly headers: Headers } {
  const known = new Set(parameters.map((p) => p.name));
  for (const name of Object.keys(args)) {
    if (!known.has(name)) {
      throw new InvalidArgumentError(`unknown argument ${JSON.stringify(name)}`);
    }
  }
  const authHeader = credentialHeaderName(config.auth);
  const headers = new Headers({ accept: 'application/json' });
  const query: [string, string][] = [];
  let resolvedPath = path;
  for (const parameter of parameters) {
    const value = args[parameter.name];
    if (value === undefined) {
      if (parameter.required) {
        throw new InvalidArgumentError(`missing argument ${JSON.stringify(parameter.name)}`);
      }
      continue;
    }
    if (parameter.in === 'query') {
      const values: unknown[] = Array.isArray(value) ? value : [value];
      if (!values.every(isScalar)) {
        throw new InvalidArgumentError(
          `${JSON.stringify(parameter.name)} must be a scalar or a list of scalars`,
        );
      }
      for (const item of values) query.push([parameter.name, String(item)]);
      continue;
    }
    if (!isScalar(value)) {
      throw new InvalidArgumentError(
        `${JSON.stringify(parameter.name)} must be a string, number or boolean`,
      );
    }
    if (parameter.in === 'path') {
      // A dot segment would let the pathname setter climb out of the operation and the baseUrl
      // path while the connector credential is attached.
      const raw = String(value);
      if (isDotSegment(raw) || isDotSegment(decodedOnce(raw))) {
        throw new InvalidArgumentError(
          `${JSON.stringify(parameter.name)} cannot be a dot path segment`,
        );
      }
      resolvedPath = resolvedPath.replaceAll(
        `{${parameter.name}}`,
        encodeURIComponent(String(value)),
      );
      continue;
    }
    const header = parameter.name.toLowerCase();
    if (REFUSED_HEADERS.has(header) || header === authHeader) {
      throw new InvalidArgumentError(`header ${JSON.stringify(parameter.name)} cannot be set`);
    }
    try {
      headers.set(header, String(value));
    } catch {
      throw new InvalidArgumentError(
        `header ${JSON.stringify(parameter.name)} has an invalid value`,
      );
    }
  }
  if (authHeader !== null && credential !== null) {
    headers.set(authHeader, config.auth === 'bearer' ? `Bearer ${credential}` : credential);
  }
  if (resolvedPath.split('/').some(isDotSegment)) {
    throw new InvalidArgumentError('the path arguments form a dot path segment');
  }
  const url = new URL(config.baseUrl);
  const expectedPrefix = joinedPathname(url, literalPrefix(path));
  url.pathname = joinedPathname(url, resolvedPath);
  if (!url.pathname.startsWith(expectedPrefix)) {
    throw new InvalidArgumentError('the path arguments leave the operation path');
  }
  for (const [name, value] of query) url.searchParams.append(name, value);
  return { url: url.toString(), headers };
}

/** Read at most {@link TOOL_RESPONSE_MAX_BYTES}, then cancel the rest of the body. */
export async function cappedText(response: Response): Promise<string> {
  if (response.body === null) return '';
  const reader: ReadableStreamDefaultReader<Uint8Array> = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.byteLength;
    if (size > TOOL_RESPONSE_MAX_BYTES) {
      truncated = true;
      await reader.cancel();
      break;
    }
  }
  const text = new TextDecoder().decode(
    Buffer.concat(chunks).subarray(0, TOOL_RESPONSE_MAX_BYTES),
    {
      stream: true, // drops a multi-byte character cut by the cap instead of emitting U+FFFD
    },
  );
  return truncated ? `${text}${TRUNCATION_MARKER}` : text;
}

function isTimeout(error: unknown): boolean {
  return error instanceof Error && error.name === 'TimeoutError';
}

/**
 * Call one operation. Argument problems and upstream failures are MCP tool errors (`isError`),
 * not transport errors: MCP reports tool execution failures in the result, and a client that sees
 * a 5xx on the JSON-RPC POST may drop the server for the rest of the run.
 */
export async function callTool(
  config: OpenApiToolConfig,
  parameters: Readonly<Record<string, readonly ToolParameter[]>>,
  credential: () => Promise<string | null>,
  name: string,
  args: Readonly<Record<string, unknown>> | undefined,
  options: ToolCallOptions = {},
): Promise<CallToolResult> {
  const operation = config.operations.find((candidate) => candidate.name === name);
  if (operation === undefined) return textResult(`unknown tool ${JSON.stringify(name)}`, true);

  let secret: string | null = null;
  if (config.auth !== 'none') {
    secret = await credential();
    if (secret === null) {
      return upstreamFailure('tool_upstream_failed', 'the connector credential is unavailable');
    }
  }
  let request: { readonly url: string; readonly headers: Headers };
  try {
    request = buildRequest(
      config,
      operation.path,
      sentParameters(parameters[name]),
      args ?? {},
      secret,
    );
  } catch (error) {
    if (error instanceof InvalidArgumentError)
      return textResult(`invalid arguments: ${error.message}`, true);
    throw error;
  }

  const signal = AbortSignal.timeout(options.timeoutMs ?? TOOL_UPSTREAM_TIMEOUT_MS);
  try {
    const response = await guardedFetch(
      request.url,
      { method: operation.method, headers: request.headers, signal },
      options.policy ?? loadEgressPolicyFromEnv(),
      options.transport,
    );
    return textResult(await cappedText(response), !response.ok);
  } catch (error) {
    // The thrown message may name the host (an egress refusal) or the URL; it is never echoed.
    return isTimeout(error)
      ? upstreamFailure('tool_upstream_timeout', 'the upstream call timed out')
      : upstreamFailure('tool_upstream_failed', 'the upstream call failed');
  }
}
