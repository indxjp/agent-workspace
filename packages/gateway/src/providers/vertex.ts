/**
 * Claude on Vertex AI as a target of the Anthropic adapter: same wire, a different URL, a bearer
 * token from the workload identity and a body mapping. There is no new client (plan D-1).
 */
import { VERTEX_CLAUDE_MODELS, type VertexLocation } from '@indx-workspace/contracts/models';

import type { AnthropicMessageRequest, ModelInfo, RequestContext } from '../types.js';
import type { AnthropicTarget, UpstreamCall } from './anthropic.js';

const HOSTS: Readonly<Record<VertexLocation, string>> = {
  global: 'https://aiplatform.googleapis.com',
  us: 'https://aiplatform.us.rep.googleapis.com',
  eu: 'https://aiplatform.eu.rep.googleapis.com',
};

const MODEL_ID = /^[a-z0-9.@-]+$/u;
const VERTEX_ANTHROPIC_VERSION = 'vertex-2023-10-16';
const CURRENT_ANTHROPIC_VERSION = '2026-10-21';
const UNSUPPORTED_TOOL_PREFIXES = ['code_execution', 'web_fetch', 'advisor'] as const;
const UNSUPPORTED_BODY_FIELDS = ['mcp_servers', 'container', 'fallbacks'] as const;

export type VertexTargetConfig = {
  readonly projectId: string;
  readonly location: VertexLocation;
};

/** The static model list: Vertex has no Models API. */
export function vertexModels(): ModelInfo[] {
  return VERTEX_CLAUDE_MODELS.map((model) => ({
    id: model.id,
    type: 'model',
    display_name: model.displayName,
    created_at: '1970-01-01T00:00:00Z',
  }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function errorResponse(
  status: number,
  type: string,
  code: string | undefined,
  message: string,
): Response {
  return Response.json(
    { type: 'error', error: { type, ...(code === undefined ? {} : { code }), message } },
    { status },
  );
}

function unsupported(field: string): Response {
  return errorResponse(
    400,
    'invalid_request_error',
    'vertex_unsupported_feature',
    `${field} is not supported for Claude on Vertex AI.`,
  );
}

/** The first image or document block fed by a URL or a file id, anywhere in the content. */
function unsupportedSource(content: unknown): string | null {
  if (!Array.isArray(content)) return null;
  for (const block of content) {
    if (!isRecord(block)) continue;
    const { type, source } = block;
    if (
      (type === 'image' || type === 'document') &&
      isRecord(source) &&
      (source['type'] === 'url' || source['type'] === 'file')
    ) {
      return `${String(type)} content with source.type "${String(source['type'])}"`;
    }
    const nested = unsupportedSource(block['content']);
    if (nested !== null) return nested;
  }
  return null;
}

/** The name of the first request feature Vertex does not serve, or `null`. */
function unsupportedFeature(body: AnthropicMessageRequest): string | null {
  for (const field of UNSUPPORTED_BODY_FIELDS) {
    if (body[field] !== undefined) return field;
  }
  if (Array.isArray(body['tools'])) {
    for (const tool of body['tools']) {
      const type = isRecord(tool) ? tool['type'] : undefined;
      if (
        typeof type === 'string' &&
        UNSUPPORTED_TOOL_PREFIXES.some((prefix) => type.startsWith(prefix))
      ) {
        return `tools of type "${type}"`;
      }
    }
  }
  if (Array.isArray(body['messages'])) {
    for (const message of body['messages']) {
      const found = isRecord(message) ? unsupportedSource(message['content']) : null;
      if (found !== null) return found;
    }
  }
  return null;
}

const GOOGLE_ERROR_TYPES: Readonly<Record<number, string>> = {
  400: 'invalid_request_error',
  401: 'authentication_error',
  403: 'permission_error',
  404: 'not_found_error',
  413: 'request_too_large',
  429: 'rate_limit_error',
  503: 'overloaded_error',
  529: 'overloaded_error',
};

/**
 * Google answers `{error: {code, status, message}}`; the Claude SDK retries on the Anthropic error
 * types, so the shape is translated. An Anthropic-shaped body is relayed unchanged. The upstream
 * message is Google's own text about the request, never the bearer token.
 */
async function mapGoogleError(upstream: Response): Promise<Response> {
  const text = await upstream.text();
  const headers = new Headers({ 'content-type': 'application/json' });
  const retryAfter = upstream.headers.get('retry-after');
  if (retryAfter !== null) headers.set('retry-after', retryAfter);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    parsed = undefined;
  }
  const first: unknown = Array.isArray(parsed) ? (parsed[0] as unknown) : parsed;
  if (isRecord(first) && first['type'] === 'error') {
    return new Response(text, { status: upstream.status, headers });
  }
  const googleError = isRecord(first) ? first['error'] : undefined;
  const message =
    isRecord(googleError) && typeof googleError['message'] === 'string'
      ? googleError['message']
      : `Vertex AI answered HTTP ${String(upstream.status)}.`;
  const type = GOOGLE_ERROR_TYPES[upstream.status] ?? 'api_error';
  return new Response(JSON.stringify({ type: 'error', error: { type, message } }), {
    status: upstream.status,
    headers,
  });
}

export function vertexTarget(config: VertexTargetConfig): AnthropicTarget {
  return {
    prepare(body: AnthropicMessageRequest, context: RequestContext): UpstreamCall | Response {
      const refused = unsupportedFeature(body);
      if (refused !== null) return unsupported(refused);
      const { model, ...rest } = body;
      if (!MODEL_ID.test(model)) {
        return errorResponse(
          400,
          'invalid_request_error',
          'vertex_invalid_model',
          'The model id is not a valid Vertex AI Claude model id.',
        );
      }
      const operation = body['stream'] === true ? 'streamRawPredict' : 'rawPredict';
      const path =
        `/v1/projects/${encodeURIComponent(config.projectId)}` +
        `/locations/${encodeURIComponent(config.location)}` +
        `/publishers/anthropic/models/${encodeURIComponent(model)}:${operation}`;
      const headers = new Headers({
        'content-type': 'application/json',
        authorization: `Bearer ${context.credential}`,
      });
      const beta = context.requestHeaders?.get('anthropic-beta');
      if (beta !== null && beta !== undefined) headers.set('anthropic-beta', beta);
      const version =
        context.requestHeaders?.get('anthropic-version') === CURRENT_ANTHROPIC_VERSION
          ? CURRENT_ANTHROPIC_VERSION
          : VERTEX_ANTHROPIC_VERSION;
      return {
        url: `${HOSTS[config.location]}${path}`,
        headers,
        body: JSON.stringify({ ...rest, anthropic_version: version }),
      };
    },
    mapError: mapGoogleError,
  };
}
