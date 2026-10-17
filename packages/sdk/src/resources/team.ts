import { z } from 'zod';

import {
  ApiKeyListResponseSchema,
  ApiKeyResponseSchema,
  MintedApiKeyResponseSchema,
  type ApiKeyResource,
  type CreateApiKeyInput,
  type MintedApiKeyResponse,
} from '@indx-workspace/contracts/api-keys';
import {
  AcceptedInvitationResponseSchema,
  InvitationListResponseSchema,
  InvitationResponseSchema,
  IssuedInvitationResponseSchema,
  type AcceptInvitationInput,
  type AcceptedInvitationResponse,
  type CreateInvitationInput,
  type InvitationResource,
  type IssuedInvitationResponse,
} from '@indx-workspace/contracts/invitations';
import {
  CreatedUserResponseSchema,
  MembershipListResponseSchema,
  MembershipResponseSchema,
  UserListResponseSchema,
  type AddMemberInput,
  type ChangeMembershipRoleInput,
  type CreateUserInput,
  type CreatedUserResponse,
  type MembershipResource,
  type MembershipRoleName,
  type UserResource,
} from '@indx-workspace/contracts/team';

import { segment, type HttpClient, type RequestOptions } from '../http.js';

const NoContentSchema = z.null();

/**
 * `/api/memberships/**` — spec §21's memberships: who belongs to the workspace, with which role.
 * Owner and Admin only; every other role meets `403 forbidden`.
 */
export class MembersClient {
  readonly #http: HttpClient;

  public constructor(http: HttpClient) {
    this.#http = http;
  }

  public async list(options: RequestOptions = {}): Promise<readonly MembershipResource[]> {
    const response = await this.#http.json({
      operation: 'team.members.list',
      method: 'GET',
      path: '/api/memberships',
      expect: [200],
      schema: MembershipListResponseSchema,
      signal: options.signal,
    });
    return response.memberships;
  }

  /**
   * Attach a user that already exists to the workspace. `404 no_such_user` when the address is
   * unknown (use `users.create` or an invitation instead), `409 already_a_member` when it already
   * belongs, `403 forbidden_role_conferral` for a role the caller may not confer.
   */
  public async add(
    input: AddMemberInput,
    options: RequestOptions = {},
  ): Promise<MembershipResource> {
    const body: AddMemberInput = { email: input.email, role: input.role };
    const response = await this.#http.json({
      operation: 'team.members.add',
      method: 'POST',
      path: '/api/memberships',
      body,
      expect: [201],
      schema: MembershipResponseSchema,
      signal: options.signal,
    });
    return response.membership;
  }

  /**
   * Move a member to another of §21's four roles. `409 last_owner` refuses demoting the
   * workspace's only Owner; `404 no_such_membership` for an id the workspace does not hold.
   */
  public async setRole(
    membershipId: string,
    role: MembershipRoleName,
    options: RequestOptions = {},
  ): Promise<MembershipResource> {
    const body: ChangeMembershipRoleInput = { role };
    const response = await this.#http.json({
      operation: 'team.members.setRole',
      method: 'PATCH',
      path: `/api/memberships/${segment(membershipId)}`,
      body,
      expect: [200],
      schema: MembershipResponseSchema,
      signal: options.signal,
    });
    return response.membership;
  }

  /**
   * Remove a member. `409 last_owner` refuses removing the only Owner; `409 membership_in_use`
   * refuses while the member still owns projects (reassignment is RF-202's).
   */
  public async remove(membershipId: string, options: RequestOptions = {}): Promise<void> {
    await this.#http.json({
      operation: 'team.members.remove',
      method: 'DELETE',
      path: `/api/memberships/${segment(membershipId)}`,
      expect: [204],
      schema: NoContentSchema,
      signal: options.signal,
    });
  }
}

/**
 * `/api/users` — the global user accounts behind the workspace's memberships. `create` is
 * controlled provisioning of a known person; the human onboarding path is `invitations`.
 */
export class UsersClient {
  readonly #http: HttpClient;

  public constructor(http: HttpClient) {
    this.#http = http;
  }

  /** The users who are members of the caller's workspace, and no other workspace's. */
  public async list(options: RequestOptions = {}): Promise<readonly UserResource[]> {
    const response = await this.#http.json({
      operation: 'team.users.list',
      method: 'GET',
      path: '/api/users',
      expect: [200],
      schema: UserListResponseSchema,
      signal: options.signal,
    });
    return response.users;
  }

  /**
   * Create (or reuse) the global user and make it a member in one transaction; returns both
   * rows. `409 email_taken` when the address already belongs to the workspace.
   */
  public create(
    input: CreateUserInput,
    options: RequestOptions = {},
  ): Promise<CreatedUserResponse> {
    const body: CreateUserInput = { email: input.email, name: input.name, role: input.role };
    return this.#http.json({
      operation: 'team.users.create',
      method: 'POST',
      path: '/api/users',
      body,
      expect: [201],
      schema: CreatedUserResponseSchema,
      signal: options.signal,
    });
  }
}

/**
 * `/api/invitations/**` — the human onboarding path. Every method here is refused for an API-key
 * caller (`403 api_key_not_permitted`): an invitation is sent and redeemed by a person, so these
 * need `auth: { kind: 'session' }`.
 */
export class InvitationsClient {
  readonly #http: HttpClient;

  public constructor(http: HttpClient) {
    this.#http = http;
  }

  /** Every invitation the workspace has sent, newest first; state is derived from timestamps. */
  public async list(options: RequestOptions = {}): Promise<readonly InvitationResource[]> {
    const response = await this.#http.json({
      operation: 'team.invitations.list',
      method: 'GET',
      path: '/api/invitations',
      expect: [200],
      schema: InvitationListResponseSchema,
      signal: options.signal,
    });
    return response.invitations;
  }

  /**
   * Invite an address. The `token` and `link` in the answer are shown once and never again;
   * `409 already_invited` while a pending invitation to the address exists.
   */
  public create(
    input: CreateInvitationInput,
    options: RequestOptions = {},
  ): Promise<IssuedInvitationResponse> {
    const body: CreateInvitationInput = { email: input.email, role: input.role };
    return this.#http.json({
      operation: 'team.invitations.create',
      method: 'POST',
      path: '/api/invitations',
      body,
      expect: [201],
      schema: IssuedInvitationResponseSchema,
      signal: options.signal,
    });
  }

  /**
   * Rotate the token and extend the expiry; the previous token stops working. `409
   * already_accepted` and `409 invitation_revoked` for a row that is no longer pending.
   */
  public async resend(
    invitationId: string,
    options: RequestOptions = {},
  ): Promise<IssuedInvitationResponse> {
    return this.#http.json({
      operation: 'team.invitations.resend',
      method: 'POST',
      path: `/api/invitations/${segment(invitationId)}/resend`,
      expect: [200],
      schema: IssuedInvitationResponseSchema,
      signal: options.signal,
    });
  }

  /** Revoke; a second revoke answers the same `200`. `409 already_accepted` once redeemed. */
  public async revoke(
    invitationId: string,
    options: RequestOptions = {},
  ): Promise<InvitationResource> {
    const response = await this.#http.json({
      operation: 'team.invitations.revoke',
      method: 'DELETE',
      path: `/api/invitations/${segment(invitationId)}`,
      expect: [200],
      schema: InvitationResponseSchema,
      signal: options.signal,
    });
    return response.invitation;
  }

  /**
   * Redeem an invitation as the invitee. The route proves identity through the invitation
   * cookie the OIDC sign-in set — not through a bearer or a workspace session — so this works
   * only from the browser that completed that sign-in, with `auth: { kind: 'session' }`. A
   * wrong id, token or address is `404 invitation_not_valid` alike; `410 invitation_expired`,
   * `410 invitation_revoked`, `409 invitation_already_used`, and `409 already_a_member` when the
   * invitee already belonged (the invitation is consumed either way).
   */
  public async accept(
    invitationId: string,
    token: string,
    options: RequestOptions = {},
  ): Promise<AcceptedInvitationResponse> {
    const body: AcceptInvitationInput = { token };
    return this.#http.json({
      operation: 'team.invitations.accept',
      method: 'POST',
      path: `/api/invitations/${segment(invitationId)}/accept`,
      body,
      expect: [200],
      schema: AcceptedInvitationResponseSchema,
      signal: options.signal,
    });
  }
}

/**
 * `/api/api-keys/**` — spec §22. A key is minted once with its plaintext in the `201` and never
 * shown again; every other answer is metadata validated by a schema with no field for a secret.
 */
export class ApiKeysClient {
  readonly #http: HttpClient;

  public constructor(http: HttpClient) {
    this.#http = http;
  }

  /** Every key of the workspace, revoked ones included. Prefixes and timestamps; never a secret. */
  public async list(options: RequestOptions = {}): Promise<readonly ApiKeyResource[]> {
    const response = await this.#http.json({
      operation: 'team.apiKeys.list',
      method: 'GET',
      path: '/api/api-keys',
      expect: [200],
      schema: ApiKeyListResponseSchema,
      signal: options.signal,
    });
    return response.apiKeys;
  }

  /**
   * Mint a key. `key` in the answer is the whole credential and this is the only time it exists
   * outside the caller's hands. `409 name_taken` for a duplicate name; `400 invalid_field` for a
   * blank or oversized name, an unparseable `expiresAt`, or one that is not later than now.
   */
  public create(
    input: CreateApiKeyInput,
    options: RequestOptions = {},
  ): Promise<MintedApiKeyResponse> {
    const body: Required<CreateApiKeyInput> = {
      name: input.name,
      role: input.role,
      expiresAt: input.expiresAt ?? null,
    };
    return this.#http.json({
      operation: 'team.apiKeys.create',
      method: 'POST',
      path: '/api/api-keys',
      body,
      expect: [201],
      schema: MintedApiKeyResponseSchema,
      signal: options.signal,
    });
  }

  /**
   * Revoke a key: `revokedAt` is written, the row stays, and the next request with the key is a
   * `401`. Idempotent — a second revoke returns the same row. `404 no_such_api_key` otherwise.
   */
  public async revoke(apiKeyId: string, options: RequestOptions = {}): Promise<ApiKeyResource> {
    const response = await this.#http.json({
      operation: 'team.apiKeys.revoke',
      method: 'DELETE',
      path: `/api/api-keys/${segment(apiKeyId)}`,
      expect: [200],
      schema: ApiKeyResponseSchema,
      signal: options.signal,
    });
    return response.apiKey;
  }
}

/** Principals — spec §5.2 `aw.team`: members, users, invitations and API keys. */
export class TeamClient {
  public readonly members: MembersClient;
  public readonly users: UsersClient;
  public readonly invitations: InvitationsClient;
  public readonly apiKeys: ApiKeysClient;

  public constructor(http: HttpClient) {
    this.members = new MembersClient(http);
    this.users = new UsersClient(http);
    this.invitations = new InvitationsClient(http);
    this.apiKeys = new ApiKeysClient(http);
  }
}
