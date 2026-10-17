/**
 * The public A2A routes (ADR-0135): the order every call meets its checks in, then the version's
 * handlers. The credential, the tenant, the agent and the role are all settled before a body is read.
 */
import { buildA2aAgentCard } from '@indx-workspace/contracts/a2a';

import { resolveAgentRunOwnership } from '../agents/run-ownership';
import { readPublicUrl } from '../endpoints/public-url';
import { endpointCredentialKey, readCappedBody } from '../endpoints/request';
import { a2aResourcePath, bearerChallenge, resourceUrl } from '../oauth/resource';
import { decide } from '../rbac/decide';
import { parseRole } from '../rbac/roles';
import { getRunApi } from '../runs/environment';
import { apiError } from '../runs/http';
import { getA2a, type A2aEnvironment, type A2aIdentity, type PublishedAgent } from './env';
import { admitA2aCall, admitA2aCardFetch } from './limits';
import { A2A_BLOCKING_WAIT_MS, handleV03, rateLimited, type A2aCall } from './v0_3/rpc';

/** The largest JSON-RPC body read; a prompt is capped far below this by the run API. */
export const A2A_MAX_BODY_BYTES = 262_144;

const NOT_FOUND = (): Response =>
  apiError(404, 'a2a_agent_not_found', 'no published agent by that name.');

type Authorised =
  | { readonly ok: true; readonly call: Omit<A2aCall, 'request'>; readonly identity: A2aIdentity }
  | { readonly ok: false; readonly response: Response };

const refuse = (response: Response): Authorised => ({ ok: false, response });

function unauthenticated(agentName: string): Response {
  const response = apiError(
    401,
    'unauthenticated',
    'this endpoint requires an API key or an OAuth access token.',
  );
  response.headers.set('WWW-Authenticate', bearerChallenge(a2aResourcePath(agentName)));
  return response;
}

/** A valid access token presented at a URL it was not issued for (RFC 8707, RFC 9728). */
function wrongAudience(agentName: string): Response {
  const response = apiError(
    401,
    'invalid_token',
    'the access token is not valid for this endpoint.',
  );
  response.headers.set(
    'WWW-Authenticate',
    bearerChallenge(a2aResourcePath(agentName), 'invalid_token'),
  );
  return response;
}

/** No `Authorization` and no cookie: no credential at all, so 401 whatever is installed. */
const carriesNoCredential = (request: Request): boolean =>
  request.headers.get('Authorization') === null && request.headers.get('Cookie') === null;

/** A browser page is never the caller of a server-to-server protocol: refuse any Origin. */
function refuseOrigin(request: Request): Response | null {
  return request.headers.get('Origin') === null
    ? null
    : apiError(403, 'origin_not_allowed', 'browser origins cannot call this endpoint.');
}

/**
 * Who is calling, whether they are within their rate, and whether they may run this agent (a key
 * not bound to the agent is told 404, like an unknown name; a role without the right, 403). The rate
 * is spent right after the credential, so a refusal for an unknown or forbidden agent costs budget
 * and no agent lookup runs for an over-limit key.
 */
async function authorise(
  request: Request,
  a2a: A2aEnvironment,
  agentName: string,
  /** Refusals that need no tenant lookup, met after the credential and before the agent. */
  precheck: (request: Request) => Response | null = refuseOrigin,
): Promise<Authorised> {
  const runs = getRunApi();
  if (runs === null) {
    return refuse(apiError(503, 'run_api_not_configured', 'the run API is not configured.'));
  }
  const identity = await a2a.identify(request);
  if (identity === null) return refuse(unauthenticated(agentName));
  if (identity.via !== 'api-key' && identity.via !== 'oauth-token') {
    return refuse(
      apiError(
        403,
        'a2a_credential_not_accepted',
        'this endpoint accepts an API key or an OAuth access token only.',
      ),
    );
  }
  const { principal } = identity;
  const credentialId = endpointCredentialKey(identity);
  const admission = admitA2aCall(credentialId, a2a.now());
  if (!admission.admitted) return refuse(rateLimited(admission.retryAfterSeconds));
  if (
    identity.oauth !== null &&
    identity.oauth.audience !== resourceUrl(a2aResourcePath(agentName))
  ) {
    return refuse(wrongAudience(agentName));
  }

  const early = precheck(request);
  if (early !== null) return refuse(early);
  const agent: PublishedAgent | null = await a2a.findPublishedAgent(
    principal.workspaceId,
    agentName,
  );
  if (agent === null) return refuse(NOT_FOUND());
  const agentRef = await runs.findAgent(principal, agent.agentId);
  if (agentRef === null) return refuse(NOT_FOUND());

  const role = parseRole(principal.role);
  if (role === null) {
    return refuse(apiError(403, 'forbidden', 'the authenticated identity has no recognised role.'));
  }
  const decision = decide({
    role,
    method: 'POST',
    path: `/api/agents/${agent.agentId}/runs`,
    ownership: await resolveAgentRunOwnership(principal, agent.agentId),
    scope: principal.scope ?? null,
  });
  if (decision.effect !== 'allow') {
    // A scope refusal means the key is not bound to this agent: answer as for an unknown name, so a
    // scoped key cannot learn which other names exist. A role refusal stays a 403.
    if (decision.effect === 'deny' && decision.code === 'token_out_of_scope') {
      return refuse(NOT_FOUND());
    }
    return refuse(
      apiError(
        decision.effect === 'deny' ? 403 : 500,
        decision.effect === 'deny' ? (decision.code ?? 'forbidden') : 'authorisation_undecidable',
        decision.because,
      ),
    );
  }

  return {
    ok: true,
    identity,
    call: {
      runs,
      principal,
      credentialId,
      agent,
      agentRef,
      now: () => a2a.now(),
      blockingWaitMs: A2A_BLOCKING_WAIT_MS,
    },
  };
}

/** `0.3` is the only version; an absent or empty header means it. The header outranks the query. */
function requestedVersion(request: Request): string {
  const header = request.headers.get('A2A-Version');
  if (header !== null) return header.trim();
  return new URL(request.url).searchParams.get('A2A-Version')?.trim() ?? '';
}

const notConfigured = (): Response =>
  apiError(503, 'a2a_not_configured', 'the A2A endpoint is not configured.');

/** POST /api/a2a/agents/:agentName */
export async function serveA2aRpc(request: Request, agentName: string): Promise<Response> {
  if (carriesNoCredential(request)) return unauthenticated(agentName);
  const a2a = getA2a();
  if (a2a === null) return notConfigured();

  const authorised = await authorise(request, a2a, agentName, (req) => {
    const origin = refuseOrigin(req);
    if (origin !== null) return origin;
    const version = requestedVersion(req);
    return version === '' || version === '0.3' || version === '0.3.0'
      ? null
      : apiError(400, 'a2a_version_unsupported', 'this endpoint speaks A2A 0.3 only.');
  });
  if (!authorised.ok) return authorised.response;
  const body = await readCappedBody(request, A2A_MAX_BODY_BYTES);
  if (body.kind === 'too_large') {
    return apiError(
      413,
      'a2a_body_too_large',
      `the request body exceeds ${String(A2A_MAX_BODY_BYTES)} bytes.`,
    );
  }
  if (body.kind === 'unreadable') {
    return apiError(400, 'invalid_body', 'the request body could not be read.');
  }
  return handleV03({ request, ...authorised.call }, body.text);
}

function cardResponse(agent: PublishedAgent): Response {
  const publicUrl = readPublicUrl(process.env);
  if (!publicUrl.ok) {
    return apiError(
      503,
      'a2a_public_url_not_configured',
      'AW_PUBLIC_URL is not set; the agent card cannot name its address.',
    );
  }
  const card = buildA2aAgentCard({
    name: agent.name,
    description: null,
    url: `${publicUrl.origin}/api/a2a/agents/${encodeURIComponent(agent.name)}`,
    version: String(agent.versionNumber),
  });
  return new Response(JSON.stringify(card), {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'private, no-store',
    },
  });
}

/**
 * GET /api/a2a/agents/:agentName/.well-known/agent-card.json
 *
 * The card is A2A discovery metadata (issue #1076, ADR-0135 amendment): name, skills and the
 * security scheme a caller must use, with no secret and no id. A request carrying no credential is
 * served for the deployment's workspace, counted per client address; any other path of this
 * protocol still answers it 401. A request with a credential keeps every check of {@link authorise},
 * so a caller of another workspace still gets that workspace's card.
 */
export async function serveA2aCard(request: Request, agentName: string): Promise<Response> {
  if (carriesNoCredential(request)) return servePublicCard(request, agentName);
  const a2a = getA2a();
  if (a2a === null) return notConfigured();
  const authorised = await authorise(request, a2a, agentName);
  if (!authorised.ok) return authorised.response;
  return cardResponse(authorised.call.agent);
}

async function servePublicCard(request: Request, agentName: string): Promise<Response> {
  const origin = refuseOrigin(request);
  if (origin !== null) return origin;
  const a2a = getA2a();
  if (a2a === null) return notConfigured();
  const admission = admitA2aCardFetch(request.headers, a2a.now());
  if (!admission.admitted) return rateLimited(admission.retryAfterSeconds);
  const agent = await a2a.findDeploymentAgent(agentName);
  return agent === null ? NOT_FOUND() : cardResponse(agent);
}
