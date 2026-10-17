/**
 * `/api/endpoint-clients` — issue #949, ADR-0134 part 1: the clients an external platform reaches
 * one MCP project or one A2A agent through, and the endpoint-scoped API keys bound to them.
 *
 * Every handler begins with `authorise()`. A route with an `:id` resolves the client first, so a
 * client in another workspace answers the same `404` as an id that never existed. The body is read
 * after `authorise`, since no ownership fact comes from it.
 *
 * A key's plaintext appears in exactly one response, `mintKey`'s `201`. No audit row, log line or
 * other response carries it.
 */
import { isUuid } from '@indx-workspace/contracts';
import {
  CreateEndpointClientRequestSchema,
  ENDPOINT_CLIENT_PROBLEM_CODES,
  MintEndpointKeyRequestSchema,
  UpdateEndpointClientRequestSchema,
  type EndpointClientProblemCode,
  type EndpointClientResource,
} from '@indx-workspace/contracts/endpoint-clients';
import type { ZodError } from 'zod';

import {
  refusingLocalRuntimeKey,
  reservedKeyNameRefusal,
} from '../cli-auth/local-runtime-key-guard';
import { decide } from '../rbac/decide';
import {
  authorise,
  problem,
  readJsonBody,
  type ApiResult,
  type OwnershipResolver,
} from '../rbac/http';
import type { Principal } from '../rbac/principal';
import { mintClientSecret } from '../oauth/tokens';
import { closeEndpointToolSandbox } from '../tool-endpoint/close';
import { currentEndpointClientsRuntime, type EndpointClientsRuntime } from './runtime';

const notConfigured = (): ApiResult =>
  problem(
    503,
    'endpoint_clients_runtime_not_configured',
    'The endpoint-client routes have no runtime installed.',
  );

function domainProblem(code: EndpointClientProblemCode, detail: string): ApiResult {
  return problem(ENDPOINT_CLIENT_PROBLEM_CODES[code], code, detail);
}

/** One answer for a client that is absent, in another workspace, or not an id at all. */
const clientNotFound = (id: string): ApiResult =>
  domainProblem('endpoint_client_not_found', `no endpoint client ${id} in this workspace.`);

function invalidField(error: ZodError): ApiResult {
  return problem(
    400,
    'invalid_field',
    error.issues
      .map((issue) => `${issue.path.map(String).join('.') || '$'}: ${issue.message}`)
      .join('; '),
  );
}

/**
 * Whose client a request names, for the `endpoint-clients` cell of §21's table. A client acts for
 * the member that created it, so that member's owner principal is the owner.
 */
function ownershipOfClient(id: string): OwnershipResolver {
  return async (principal: Principal) => {
    const runtime = currentEndpointClientsRuntime();
    if (runtime === null) return { kind: 'refuse', result: notConfigured() };
    if (!isUuid(id)) return { kind: 'refuse', result: clientNotFound(id) };
    const client = await runtime.get(principal.workspaceId, id);
    if (client === null) return { kind: 'refuse', result: clientNotFound(id) };
    return {
      kind: 'ownership',
      ownership: client.actsForPrincipalId === principal.ownerPrincipalId ? 'own' : 'other',
    };
  };
}

/**
 * The first agent id `principal` could not itself start a run on, or `null`. An agent that is
 * absent or in another workspace is `unknown` and is refused for every role, so the answer does not
 * tell the two apart.
 */
async function unrunnableAgent(
  runtime: EndpointClientsRuntime,
  principal: Principal,
  agentIds: readonly string[],
): Promise<string | null> {
  for (const agentId of agentIds) {
    const ownership = await runtime.agentOwnership(principal, agentId);
    const decision = decide({
      role: principal.role,
      method: 'POST',
      path: `/api/agents/${agentId}/runs`,
      ownership,
      scope: null,
    });
    if (ownership === 'unknown' || decision.effect !== 'allow') return agentId;
  }
  return null;
}

const agentNotRunnable = (agentId: string): ApiResult =>
  domainProblem(
    'endpoint_client_agent_not_runnable',
    `agent ${agentId} does not exist in this workspace or you may not run it, so it cannot be bound to an endpoint client.`,
  );

const apiKeyRefusal = (): ApiResult =>
  problem(
    403,
    'api_key_not_permitted',
    'An API key cannot create endpoint clients; a client is created by a member, whom it then acts for. Use a session.',
  );

const bodyOf = (client: EndpointClientResource) => ({ endpointClient: client });

export async function list(request: Request): Promise<ApiResult> {
  return authorise(request, 'not-applicable', async ({ principal }) => {
    const runtime = currentEndpointClientsRuntime();
    if (runtime === null) return notConfigured();
    return {
      status: 200,
      body: { endpointClients: await runtime.list(principal.workspaceId) },
    };
  });
}

export async function create(request: Request): Promise<ApiResult> {
  return authorise(request, 'not-applicable', async ({ principal }) => {
    const runtime = currentEndpointClientsRuntime();
    if (runtime === null) return notConfigured();
    if (principal.via === 'api-key') return apiKeyRefusal();
    const raw = await readJsonBody(request);
    if (!raw.ok) return raw.result;
    const parsed = CreateEndpointClientRequestSchema.safeParse(raw.value);
    if (!parsed.success) return invalidField(parsed.error);
    const input = parsed.data;

    const refused = await unrunnableAgent(runtime, principal, input.agentIds);
    if (refused !== null) return agentNotRunnable(refused);

    const outcome = await runtime.create(principal.workspaceId, {
      name: input.name,
      kind: input.kind,
      agentIds: input.agentIds,
      toolNames: input.toolNames ?? null,
      actsForPrincipalId: principal.ownerPrincipalId,
      createdByPrincipalId: principal.ownerPrincipalId,
    });
    if (outcome.kind === 'name-taken') {
      return domainProblem(
        'endpoint_client_name_taken',
        `this workspace already has a ${input.kind} endpoint client named ${JSON.stringify(input.name)}.`,
      );
    }
    await runtime.audit(principal, {
      action: 'endpoint-client-created',
      subjectId: outcome.client.id,
      subjectLabel: outcome.client.name,
    });
    return { status: 201, body: bodyOf(outcome.client) };
  });
}

export async function get(request: Request, id: unknown): Promise<ApiResult> {
  const clientId = String(id);
  return authorise(request, ownershipOfClient(clientId), async ({ principal }) => {
    const runtime = currentEndpointClientsRuntime();
    if (runtime === null) return notConfigured();
    const client = await runtime.get(principal.workspaceId, clientId);
    return client === null ? clientNotFound(clientId) : { status: 200, body: bodyOf(client) };
  });
}

export async function update(request: Request, id: unknown): Promise<ApiResult> {
  const clientId = String(id);
  return authorise(request, ownershipOfClient(clientId), async ({ principal }) => {
    const runtime = currentEndpointClientsRuntime();
    if (runtime === null) return notConfigured();
    const raw = await readJsonBody(request);
    if (!raw.ok) return raw.result;
    const parsed = UpdateEndpointClientRequestSchema.safeParse(raw.value);
    if (!parsed.success) return invalidField(parsed.error);
    const patch = parsed.data;

    const client = await runtime.get(principal.workspaceId, clientId);
    if (client === null) return clientNotFound(clientId);
    if (client.revokedAt !== null) {
      return domainProblem(
        'endpoint_client_revoked',
        'a revoked endpoint client cannot be changed.',
      );
    }
    if (client.kind === 'a2a-agent') {
      const agents = patch.agentIds === undefined ? 1 : new Set(patch.agentIds).size;
      if (agents !== 1 || (patch.toolNames !== undefined && patch.toolNames !== null)) {
        return domainProblem(
          'endpoint_client_invalid',
          'an a2a-agent client names exactly one agent and no toolNames.',
        );
      }
    }
    if (patch.agentIds !== undefined) {
      const refused = await unrunnableAgent(runtime, principal, patch.agentIds);
      if (refused !== null) return agentNotRunnable(refused);
    }

    const outcome = await runtime.update(principal.workspaceId, clientId, patch);
    if (outcome.kind === 'not-found') return clientNotFound(clientId);
    // Revoked between the read above and the repository's row lock.
    if (outcome.kind === 'revoked') {
      return domainProblem(
        'endpoint_client_revoked',
        'a revoked endpoint client cannot be changed.',
      );
    }
    const changed = outcome.client;
    await runtime.audit(principal, {
      action: 'endpoint-client-changed',
      subjectId: changed.id,
      subjectLabel: changed.name,
    });
    return { status: 200, body: bodyOf(changed) };
  });
}

export async function revoke(request: Request, id: unknown): Promise<ApiResult> {
  const clientId = String(id);
  return authorise(request, ownershipOfClient(clientId), async ({ principal }) => {
    const runtime = currentEndpointClientsRuntime();
    if (runtime === null) return notConfigured();
    const before = await runtime.get(principal.workspaceId, clientId);
    if (before === null) return clientNotFound(clientId);
    const revocation = await runtime.revoke(principal.workspaceId, clientId);
    if (revocation === null) return clientNotFound(clientId);
    const revoked = revocation.client;
    // A repeat revoke is a no-op and leaves no second audit row.
    if (before.revokedAt === null) {
      await runtime.audit(principal, {
        action: 'endpoint-client-revoked',
        subjectId: revoked.id,
        subjectLabel: revoked.name,
      });
    }
    // Only the call that revoked them lists the bound keys, so each gets one row.
    for (const key of revocation.revokedKeys) {
      await runtime.audit(principal, {
        action: 'api-key-revoked',
        subjectId: key.id,
        subjectLabel: key.name,
      });
    }
    if (before.revokedAt === null && revoked.kind === 'mcp-project') {
      await closeEndpointToolSandbox(principal.workspaceId, revoked.id);
    }
    return { status: 200, body: bodyOf(revoked) };
  });
}

/**
 * A minted key outlives the run, so the local runtime's key (ADR-0109, S1-21) is refused here as on
 * `POST /api/api-keys`, and a key name may not carry its reserved prefix.
 */
export async function mintKey(request: Request, id: unknown): Promise<ApiResult> {
  const clientId = String(id);
  const ownership = refusingLocalRuntimeKey(ownershipOfClient(clientId));
  return authorise(request, ownership, async ({ principal }) => {
    const runtime = currentEndpointClientsRuntime();
    if (runtime === null) return notConfigured();
    const raw = await readJsonBody(request);
    if (!raw.ok) return raw.result;
    const reserved = reservedKeyNameRefusal(raw.value);
    if (reserved !== null) return reserved;
    const parsed = MintEndpointKeyRequestSchema.safeParse(raw.value);
    if (!parsed.success) return invalidField(parsed.error);

    const outcome = await runtime.mintKey(principal.workspaceId, clientId, {
      name: parsed.data.name,
      expiresAt: parsed.data.expiresAt ?? null,
    });
    switch (outcome.kind) {
      case 'created':
        await runtime.audit(principal, {
          action: 'api-key-created',
          subjectId: outcome.apiKey.id,
          subjectLabel: outcome.apiKey.name,
        });
        return {
          status: 201,
          body: {
            apiKey: outcome.apiKey,
            key: outcome.presented,
            warning:
              'This is the only time this key is shown. Only its hash is stored; it cannot be ' +
              'recovered, only revoked and replaced.',
          },
        };
      case 'name-taken':
        return problem(
          409,
          'name_taken',
          `This workspace already has an API key named ${JSON.stringify(outcome.name)}.`,
        );
      case 'expiry-in-the-past':
        return problem(
          400,
          'invalid_field',
          `"expiresAt" is ${outcome.expiresAt}, which is not later than now.`,
        );
      case 'not-found':
        return clientNotFound(clientId);
      case 'revoked':
        return domainProblem(
          'endpoint_client_revoked',
          'a revoked endpoint client cannot mint keys.',
        );
      default: {
        const unreachable: never = outcome;
        throw new Error(`unhandled mintKey outcome ${JSON.stringify(unreachable)}`);
      }
    }
  });
}

/**
 * Rotate the OAuth client secret (ADR-0134 part 3). The secret is a credential that outlives the
 * request, so an API key is refused as on `create`, and so is the local runtime's key. Its plaintext
 * appears in this `201` only.
 */
export async function rotateSecret(request: Request, id: unknown): Promise<ApiResult> {
  const clientId = String(id);
  const ownership = refusingLocalRuntimeKey(ownershipOfClient(clientId));
  return authorise(request, ownership, async ({ principal }) => {
    const runtime = currentEndpointClientsRuntime();
    if (runtime === null) return notConfigured();
    if (principal.via === 'api-key') {
      return problem(
        403,
        'api_key_not_permitted',
        'An API key cannot rotate an OAuth client secret. Use a session.',
      );
    }
    const minted = await mintClientSecret();
    const outcome = await runtime.rotateSecret(principal.workspaceId, clientId, minted.secretHash);
    switch (outcome.kind) {
      case 'rotated':
        await runtime.audit(principal, {
          action: 'oauth-client-secret-rotated',
          subjectId: outcome.client.id,
          subjectLabel: outcome.client.name,
        });
        return {
          status: 201,
          body: {
            clientId: outcome.client.id,
            clientSecret: minted.presented,
            warning:
              'This is the only time this secret is shown. Only its hash is stored; the previous ' +
              'secret no longer works. Rotate again to replace it.',
          },
        };
      case 'not-found':
        return clientNotFound(clientId);
      case 'revoked':
        return domainProblem(
          'endpoint_client_revoked',
          'a revoked endpoint client cannot rotate its secret.',
        );
      default: {
        const unreachable: never = outcome;
        throw new Error(`unhandled rotateSecret outcome ${JSON.stringify(unreachable)}`);
      }
    }
  });
}
