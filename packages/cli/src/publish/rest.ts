/**
 * The REST half of the executors that publish with a vendor API instead of a vendor CLI: one JSON
 * call with a bearer token, and the token itself, which the vendor's own login tool prints. The
 * token is concealed from the moment it is read; a failure names the method, the URL without its
 * query and the status, never the response body and never the token.
 */
import { z } from 'zod';

import { isMissingTool } from '../deploy/runner.ts';
import {
  PublishRefusedError,
  runPublishTool,
  type PublishContext,
  type PublishTool,
} from './kit.ts';

export interface VendorRequest {
  readonly method: 'GET' | 'POST' | 'PATCH';
  readonly url: string;
  readonly token: string;
  readonly body?: unknown;
  /** Statuses that return instead of throwing (a 404 that means "not there yet"). */
  readonly accept?: readonly number[];
}

export interface VendorResponse {
  readonly status: number;
  /** Parsed only when the response says it is JSON; `undefined` otherwise. */
  readonly json: unknown;
}

// Google's `error.status` ("PERMISSION_DENIED") or a numeric/string `error.code`.
const VendorErrorSchema = z.looseObject({
  error: z.looseObject({
    status: z.string().optional(),
    code: z.union([z.string(), z.number()]).optional(),
  }),
});

function vendorErrorCode(json: unknown): string {
  const parsed = VendorErrorSchema.safeParse(json);
  if (!parsed.success) return '';
  const { status, code } = parsed.data.error;
  const found = status ?? code;
  return found === undefined ? '' : ` ${String(found)}`;
}

function withoutQuery(url: string): string {
  const { origin, pathname } = new URL(url);
  return `${origin}${pathname}`;
}

/** One JSON call with a bearer token; the token is already concealed by the caller. */
export async function callVendorJson(
  context: PublishContext,
  request: VendorRequest,
): Promise<VendorResponse> {
  const response = await context.fetch(request.url, {
    method: request.method,
    headers: {
      authorization: `Bearer ${request.token}`,
      'content-type': 'application/json',
    },
    ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
    signal: context.signal,
  });
  const isJson = (response.headers.get('content-type') ?? '').includes('application/json');
  const json: unknown = isJson ? await response.json().catch(() => undefined) : undefined;
  if (!response.ok && request.accept?.includes(response.status) !== true) {
    throw new Error(
      `${request.method} ${withoutQuery(request.url)} answered ${String(response.status)}${vendorErrorCode(json)}`,
    );
  }
  return { status: response.status, json };
}

/**
 * Runs a tool whose stdout is an access token (never shown), trims it, conceals it and returns it.
 * `login` is the command that fixes a failed or empty answer.
 */
export async function accessToken(
  context: PublishContext,
  tool: PublishTool,
  args: readonly string[],
  login: string,
): Promise<string> {
  let stdout: string;
  try {
    ({ stdout } = await runPublishTool(context, tool, args, { show: false }));
  } catch (error) {
    // A missing tool already carries its install line; only a failed call is a login problem.
    if (error instanceof Error && isMissingTool(error.cause)) throw error;
    throw new PublishRefusedError(`${tool.name} could not print an access token`, login);
  }
  const token = stdout.trim();
  if (token === '') throw new PublishRefusedError(`${tool.name} printed no access token`, login);
  return token;
}
