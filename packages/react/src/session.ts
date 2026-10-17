/**
 * The hosted surface page's session bootstrap and feedback post, client side (ADR-0105 slice 1;
 * S1-17, issue #455; C18 and C19, issue #540): `POST /p/s/<name>/sessions`, with no body for a
 * plain first open or a {@link SurfaceSessionRequest} to resume or switch agent, and
 * `POST /api/runs/:id/feedback` with the session's token. A value that crossed the network is
 * parsed, never trusted, so an answer that is neither what was asked for nor a problem is reported
 * as such rather than handed on.
 */
import { ApiProblemSchema } from '@indx-workspace/contracts';
import {
  RunFeedbackRequestSchema,
  type RunFeedbackRequest,
} from '@indx-workspace/contracts/feedback';
import {
  SurfaceSessionRequestSchema,
  SurfaceSessionResponseSchema,
  type SurfaceSessionRequest,
  type SurfaceSessionResponse,
} from '@indx-workspace/contracts/surfaces';

/** A refusal the server answered with, read through the problem contract. */
interface SurfaceProblem {
  readonly kind: 'problem';
  readonly status: number;
  readonly code: string;
  readonly message: string;
  /** The answer's `Retry-After` in seconds, as a `429` carries it; else `null`. */
  readonly retryAfterSeconds: number | null;
}

/** The request did not complete, or the answer was not one the contract describes. */
interface SurfaceRequestFailed {
  readonly kind: 'failed';
  readonly message: string;
  /**
   * `fetch` itself rejected: no answer was readable. A browser reports an origin the server does
   * not admit by CORS exactly like a network failure (`Failed to fetch`), so this is either.
   */
  readonly unreachable?: true;
}

/** What the bootstrap answered. */
export type SurfaceSessionResult =
  | { readonly kind: 'opened'; readonly session: SurfaceSessionResponse }
  | SurfaceProblem
  | SurfaceRequestFailed;

/** What the feedback route answered. */
export type RunFeedbackResult = { readonly kind: 'sent' } | SurfaceProblem | SurfaceRequestFailed;

/** The bootstrap's path for surface `name`. */
export function surfaceSessionsPath(name: string): string {
  return `/p/s/${encodeURIComponent(name)}/sessions`;
}

/**
 * `path` on the Agent Workspace at `baseUrl`, keeping the base's own path prefix as the SDK
 * client's `resolveApiUrl` does, so the bootstrap and the runs reach the same place; `path` itself
 * when there is no `baseUrl`, the page's own origin.
 */
export function surfaceUrl(baseUrl: string | undefined, path: string): string {
  if (baseUrl === undefined) return path;
  const base = new URL(baseUrl);
  return new URL(`${base.pathname.replace(/\/+$/u, '')}${path}`, base.origin).href;
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return (await response.json()) as unknown;
  } catch {
    return undefined;
  }
}

/** POST `init` to `path`, or the reason the `what` request did not complete. */
async function post(
  fetchImpl: typeof fetch,
  path: string,
  init: RequestInit,
  what: string,
): Promise<Response | SurfaceRequestFailed> {
  try {
    return await fetchImpl(path, { method: 'POST', cache: 'no-store', ...init });
  } catch (error) {
    return {
      kind: 'failed',
      message: error instanceof Error ? error.message : `The ${what} request did not complete.`,
      unreachable: true,
    };
  }
}

function retryAfterOf(response: Response): number | null {
  const header = response.headers.get('retry-after');
  const seconds = header === null ? Number.NaN : Number(header);
  return Number.isInteger(seconds) && seconds >= 0 ? seconds : null;
}

function problemOf(
  response: Response,
  body: unknown,
  what: string,
): SurfaceProblem | SurfaceRequestFailed {
  const problem = ApiProblemSchema.safeParse(body);
  return problem.success
    ? {
        kind: 'problem',
        status: response.status,
        code: problem.data.error.code,
        message: problem.data.error.message,
        retryAfterSeconds: retryAfterOf(response),
      }
    : {
        kind: 'failed',
        message: `The ${what} request failed with HTTP ${String(response.status)}.`,
      };
}

/**
 * Open a session of surface `name`'s agent, on `baseUrl` or the page's own origin. An empty
 * `request` sends no body, as a slice-1 page does. No cookie is sent to another origin.
 */
export async function openSurfaceSession(
  name: string,
  fetchImpl: typeof fetch = fetch,
  request: SurfaceSessionRequest = {},
  baseUrl?: string,
): Promise<SurfaceSessionResult> {
  const body =
    Object.keys(request).length === 0
      ? {}
      : {
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(SurfaceSessionRequestSchema.parse(request)),
        };
  const response = await post(
    fetchImpl,
    surfaceUrl(baseUrl, surfaceSessionsPath(name)),
    { credentials: 'same-origin', ...body },
    'session',
  );
  if (!(response instanceof Response)) return response;
  const answer = await readJson(response);
  if (response.status === 201) {
    const session = SurfaceSessionResponseSchema.safeParse(answer);
    return session.success
      ? { kind: 'opened', session: session.data }
      : { kind: 'failed', message: 'The session answer did not match its contract.' };
  }
  return problemOf(response, answer, 'session');
}

/**
 * Rate run `runId` with the session's browser `token` (C19): `204` is `sent`. There is no SDK
 * method for it, so this is a plain `fetch` like the bootstrap's.
 */
export async function postRunFeedback(
  runId: string,
  token: string,
  request: RunFeedbackRequest,
  fetchImpl: typeof fetch = fetch,
  baseUrl?: string,
): Promise<RunFeedbackResult> {
  const response = await post(
    fetchImpl,
    surfaceUrl(baseUrl, `/api/runs/${encodeURIComponent(runId)}/feedback`),
    {
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(RunFeedbackRequestSchema.parse(request)),
    },
    'feedback',
  );
  if (!(response instanceof Response)) return response;
  if (response.status === 204) return { kind: 'sent' };
  return problemOf(response, await readJson(response), 'feedback');
}
