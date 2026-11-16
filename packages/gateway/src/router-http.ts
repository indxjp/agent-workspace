import { z } from 'zod';

import type { AnthropicMessageRequest, RequestContext } from './types.js';

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' } as const;
const GatewayRequestSchema = z.object({ model: z.string().trim().min(1) }).catchall(z.unknown());

export type GatewayErrorType =
  | 'gateway_context_required'
  | 'invalid_request_error'
  | 'method_not_allowed'
  | 'model_connection_incomplete'
  | 'model_credential_unavailable'
  | 'not_found_error'
  | 'provider_not_registered'
  | 'provider_operation_not_supported';

/** What a typed error response may carry beyond its status, type and message. */
export type ProblemOptions = {
  readonly context?: RequestContext | undefined;
  readonly headers?: Readonly<Record<string, string>>;
};

function requestId(context?: RequestContext): string {
  return context?.requestId ?? `gateway_${crypto.randomUUID()}`;
}

export function json(
  body: unknown,
  status = 200,
  headers?: Readonly<Record<string, string>>,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...JSON_HEADERS, ...headers },
  });
}

/** The gateway's typed error envelope; it never carries upstream text or credentials. */
export function problem(
  status: number,
  type: GatewayErrorType,
  message: string,
  options: ProblemOptions = {},
): Response {
  return json(
    {
      type: 'error',
      error: { type, message },
      request_id: requestId(options.context),
    },
    status,
    options.headers,
  );
}

/** The request body as a JSON object, or the typed refusal response when it is not one. */
async function jsonObject(
  request: Request,
  context?: RequestContext,
): Promise<Record<string, unknown> | Response> {
  const contentType = request.headers.get('content-type');
  if (contentType === null || !contentType.toLowerCase().startsWith('application/json')) {
    return problem(
      415,
      'invalid_request_error',
      'This endpoint accepts application/json request bodies.',
      { context },
    );
  }

  let value: unknown;
  try {
    value = await request.json();
  } catch {
    return problem(400, 'invalid_request_error', 'The request body is not valid JSON.', {
      context,
    });
  }

  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return problem(400, 'invalid_request_error', 'The request body must be a JSON object.', {
      context,
    });
  }
  return value as Record<string, unknown>;
}

function gatewayRequest(
  value: Record<string, unknown>,
  context?: RequestContext,
): AnthropicMessageRequest | Response {
  const parsed = GatewayRequestSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  return problem(
    400,
    'invalid_request_error',
    'The request body must include a non-empty string "model".',
    { context },
  );
}

/** The request body validated as a gateway request, or the typed refusal response. */
export async function readGatewayRequest(
  request: Request,
  context?: RequestContext,
): Promise<AnthropicMessageRequest | Response> {
  const body = await jsonObject(request, context);
  if (body instanceof Response) return body;
  return gatewayRequest(body, context);
}
