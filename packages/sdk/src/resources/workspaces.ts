import {
  SharingPolicySchema,
  WorkspaceListResponseSchema,
  WorkspaceMembershipResponseSchema,
  WorkspaceResponseSchema,
  WorkspaceSwitchResponseSchema,
  type CreateWorkspaceInput,
  type SharingPolicy,
  type UpdateSharingPolicyInput,
  type UpdateWorkspacePatch,
  type WorkspaceMembershipView,
  type WorkspaceResource,
} from '@indx-workspace/contracts/workspaces';

import { segment, type HttpClient, type RequestOptions } from '../http.js';

/**
 * `/api/sharing-policies` — spec §5.1's last row. The policy belongs to the caller's current
 * workspace (the API key's, or the session's), which is why the routes take no id.
 */
export class SharingPolicyClient {
  readonly #http: HttpClient;

  public constructor(http: HttpClient) {
    this.#http = http;
  }

  /** Whether the workspace lets a member publish a public share. Every role may read it. */
  public get(options: RequestOptions = {}): Promise<SharingPolicy> {
    return this.#http.json({
      operation: 'workspaces.sharingPolicy.get',
      method: 'GET',
      path: '/api/sharing-policies',
      expect: [200],
      schema: SharingPolicySchema,
      signal: options.signal,
    });
  }

  /** Turn public sharing on or off. Owner only: any other role is `403 forbidden`. */
  public set(
    input: UpdateSharingPolicyInput,
    options: RequestOptions = {},
  ): Promise<SharingPolicy> {
    const body: UpdateSharingPolicyInput = { publicSharing: input.publicSharing };
    return this.#http.json({
      operation: 'workspaces.sharingPolicy.set',
      method: 'PATCH',
      path: '/api/sharing-policies',
      body,
      expect: [200],
      schema: SharingPolicySchema,
      signal: options.signal,
    });
  }
}

/**
 * `/api/workspaces/**` — spec §25's tenant boundary as a resource.
 *
 * **A person only.** Every route behind `list`, `get`, `create` and `update` refuses an
 * API-key principal with `403 api_key_not_permitted`: an API key acts for one workspace with a
 * fixed role and has no human membership to list, create or administer workspace records against.
 * Build the client with
 * `auth: { kind: 'session' }` in a browser, or `{ kind: 'user-token' }` with the token `aw login`
 * holds (issue #242), to use any of them. `sharingPolicy` is the exception: its routes belong to
 * the caller's current workspace and serve every principal.
 */
export class WorkspacesClient {
  readonly #http: HttpClient;
  public readonly sharingPolicy: SharingPolicyClient;

  public constructor(http: HttpClient) {
    this.#http = http;
    this.sharingPolicy = new SharingPolicyClient(http);
  }

  /** Every workspace the caller belongs to, with the role held in each. */
  public async list(options: RequestOptions = {}): Promise<readonly WorkspaceMembershipView[]> {
    const response = await this.#http.json({
      operation: 'workspaces.list',
      method: 'GET',
      path: '/api/workspaces',
      expect: [200],
      schema: WorkspaceListResponseSchema,
      signal: options.signal,
    });
    return response.workspaces;
  }

  public async get(
    workspaceId: string,
    options: RequestOptions = {},
  ): Promise<WorkspaceMembershipView> {
    const response = await this.#http.json({
      operation: 'workspaces.get',
      method: 'GET',
      path: `/api/workspaces/${segment(workspaceId)}`,
      expect: [200],
      schema: WorkspaceMembershipResponseSchema,
      signal: options.signal,
    });
    return response.workspace;
  }

  /** Create a workspace; the caller becomes its first Owner in the same transaction. */
  public async create(
    input: CreateWorkspaceInput,
    options: RequestOptions = {},
  ): Promise<WorkspaceMembershipView> {
    const response = await this.#http.json({
      operation: 'workspaces.create',
      method: 'POST',
      path: '/api/workspaces',
      body: input,
      expect: [201],
      schema: WorkspaceMembershipResponseSchema,
      signal: options.signal,
    });
    return response.workspace;
  }

  /** Rename, archive, and/or restore. */
  public async update(
    workspaceId: string,
    patch: UpdateWorkspacePatch,
    options: RequestOptions = {},
  ): Promise<WorkspaceResource> {
    const response = await this.#http.json({
      operation: 'workspaces.update',
      method: 'PATCH',
      path: `/api/workspaces/${segment(workspaceId)}`,
      body: patch,
      expect: [200],
      schema: WorkspaceResponseSchema,
      signal: options.signal,
    });
    return response.workspace;
  }

  /**
   * Switch the session's current workspace (issue #236, SDK-04, S-2) — `idOrSlug` is either half
   * of {@link WorkspaceMembershipView}'s pair. `POST /api/auth/workspace` with `Content-Type:
   * application/json`, which answers `200 { workspace }` and a new session `Set-Cookie` rather
   * than the browser-form path's `303` redirect. A `user-token` client (issue #242) calls
   * `POST /api/auth/cli-workspace` instead, which moves the token itself to the workspace. An
   * API-key or a browser-token client answers `401 session_expired`, because neither carries a
   * session to switch.
   */
  public async select(
    idOrSlug: string,
    options: RequestOptions = {},
  ): Promise<WorkspaceMembershipView> {
    const response = await this.#http.json({
      operation: 'workspaces.select',
      method: 'POST',
      // A `user-token` client (issue #242) moves its own token instead of a session cookie.
      path:
        this.#http.authKind === 'user-token' ? '/api/auth/cli-workspace' : '/api/auth/workspace',
      body: { workspace: idOrSlug },
      expect: [200],
      schema: WorkspaceSwitchResponseSchema,
      signal: options.signal,
    });
    return response.workspace;
  }
}
