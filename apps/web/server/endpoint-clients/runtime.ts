/**
 * The seam between `/api/endpoint-clients` (issue #949, ADR-0134) and the database layer: the
 * endpoint-client repository, the key directory and the audit trail. The same shape as
 * `apps/web/server/tokens/runtime.ts`, for the same reason — `apps/web/server/rbac/**` is
 * deliberately narrow and knows no endpoint clients.
 *
 * Every method takes the caller's workspace id and answers only for that workspace, so a row in
 * another workspace is indistinguishable from one that does not exist.
 */
import type { ApiKeyResource } from '@indx-workspace/contracts/api-keys';
import type { EndpointClientResource } from '@indx-workspace/contracts/endpoint-clients';

import type { Ownership } from '../rbac/decide';
import type { Principal } from '../rbac/principal';

export interface NewEndpointClient {
  readonly name: string;
  readonly kind: EndpointClientResource['kind'];
  readonly agentIds: readonly string[];
  readonly toolNames: readonly string[] | null;
  readonly actsForPrincipalId: string;
  readonly createdByPrincipalId: string;
}

export interface EndpointClientPatchInput {
  readonly agentIds?: readonly string[] | undefined;
  readonly toolNames?: readonly string[] | null | undefined;
  readonly redirectUris?: readonly string[] | undefined;
}

export type MintKeyOutcome =
  | { readonly kind: 'created'; readonly apiKey: ApiKeyResource; readonly presented: string }
  | { readonly kind: 'name-taken'; readonly name: string }
  | { readonly kind: 'expiry-in-the-past'; readonly expiresAt: string }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'revoked' };

/** An audit row's subject. The trail has no place for a secret and none is passed. */
export interface EndpointClientAuditEvent {
  readonly action:
    | 'endpoint-client-created'
    | 'endpoint-client-changed'
    | 'endpoint-client-revoked'
    | 'api-key-created'
    | 'api-key-revoked'
    | 'endpoint-tool-called'
    | 'oauth-client-secret-rotated'
    | 'oauth-grant-issued'
    | 'oauth-grant-revoked';
  readonly subjectId: string;
  readonly subjectLabel: string;
}

export interface EndpointClientsRuntime {
  list(workspaceId: string): Promise<readonly EndpointClientResource[]>;
  get(workspaceId: string, id: string): Promise<EndpointClientResource | null>;
  create(
    workspaceId: string,
    input: NewEndpointClient,
  ): Promise<
    | { readonly kind: 'created'; readonly client: EndpointClientResource }
    | { readonly kind: 'name-taken' }
  >;
  /** `revoked` when the client was revoked before the change could take its row lock. */
  update(
    workspaceId: string,
    id: string,
    patch: EndpointClientPatchInput,
  ): Promise<
    | { readonly kind: 'updated'; readonly client: EndpointClientResource }
    | { readonly kind: 'not-found' }
    | { readonly kind: 'revoked' }
  >;
  /**
   * Revokes the client and every key bound to it; idempotent. `revokedKeys` lists the keys this
   * call revoked (none on a repeat). `null` when absent.
   */
  revoke(
    workspaceId: string,
    id: string,
  ): Promise<{
    readonly client: EndpointClientResource;
    readonly revokedKeys: readonly { readonly id: string; readonly name: string }[];
  } | null>;
  /** Replace the OAuth client secret's hash; the old secret stops working at once. */
  rotateSecret(
    workspaceId: string,
    id: string,
    secretHash: string,
  ): Promise<
    | { readonly kind: 'rotated'; readonly client: EndpointClientResource }
    | { readonly kind: 'not-found' }
    | { readonly kind: 'revoked' }
  >;
  mintKey(
    workspaceId: string,
    id: string,
    input: { readonly name: string; readonly expiresAt: string | null },
  ): Promise<MintKeyOutcome>;
  /** Whether `principal` may run `agentId`, as `decide()` reads it for `POST /api/agents/:id/runs`. */
  agentOwnership(principal: Principal, agentId: string): Promise<Ownership>;
  audit(
    principal: Pick<Principal, 'workspaceId' | 'principalId' | 'userId' | 'label'>,
    event: EndpointClientAuditEvent,
  ): Promise<void>;
}

interface Registry {
  __agentWorkspaceEndpointClientsRuntime__?: EndpointClientsRuntime;
}
const registry = globalThis as typeof globalThis & Registry;

export function configureEndpointClientsRuntime(runtime: EndpointClientsRuntime): void {
  registry.__agentWorkspaceEndpointClientsRuntime__ = runtime;
}

export function clearEndpointClientsRuntime(): void {
  delete registry.__agentWorkspaceEndpointClientsRuntime__;
}

export function currentEndpointClientsRuntime(): EndpointClientsRuntime | null {
  return registry.__agentWorkspaceEndpointClientsRuntime__ ?? null;
}
