import type {
  McpArgs,
  McpAuthType,
  McpTransport,
  ToolConfig,
  ToolConnectorKind,
} from '../schema/mcp-servers.js';
import type { WorkspaceScope } from './scope.js';

/** One connector row, with `timestamptz` columns as `Date` and `args` parsed. */
export interface McpServerRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly name: string;
  readonly transport: McpTransport;
  readonly command: string | null;
  readonly args: McpArgs | null;
  readonly url: string | null;
  readonly authType: McpAuthType;
  /** A reference into `secrets`, never a value. `null` exactly when `authType === 'none'`. */
  readonly credentialSecretId: string | null;
  /** The name of the workspace secret that signs the identity assertion; `null` is no opt-in. */
  readonly identitySecretName: string | null;
  readonly enabled: boolean;
  /** Compatibility attribution for a membership principal. */
  readonly createdBy: string | null;
  /** Exact human or API-key owner. */
  readonly ownerPrincipalId: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * Everything an insert supplies. The workspace is not among them — it comes from the scope.
 *
 * `ownerPrincipalId` is resolved from the authenticated actor. `createdBy` is compatibility
 * attribution for membership principals only; API-key principals leave it null.
 */
export interface CreateMcpServerInput {
  readonly name: string;
  readonly transport: McpTransport;
  readonly command: string | null;
  readonly args: McpArgs | null;
  readonly url: string | null;
  readonly authType: McpAuthType;
  readonly credentialSecretId: string | null;
  readonly identitySecretName?: string | null;
  readonly enabled: boolean;
  readonly ownerPrincipalId: string;
  readonly createdBy?: string | null;
}

/** What creating a connector can produce. */
export type CreateMcpServerOutcome =
  | { readonly kind: 'created'; readonly server: McpServerRecord }
  | { readonly kind: 'name-conflict'; readonly name: string }
  | { readonly kind: 'unknown-credential-secret'; readonly secretId: string };

/**
 * A field update. Every field is optional; an absent field is left as it is. The workspace, the
 * transport, the owner and the creator are not among them — an update can never move them.
 * `credentialSecretId` changes only together with `authType` (`mcp_servers_credential_required`).
 */
export interface UpdateMcpServerInput {
  readonly name?: string;
  readonly enabled?: boolean;
  readonly command?: string;
  readonly args?: McpArgs | null;
  readonly url?: string;
  readonly authType?: McpAuthType;
  readonly credentialSecretId?: string | null;
  /** `null` removes the identity opt-in. */
  readonly identitySecretName?: string | null;
}

/** What updating a connector can produce. */
export type UpdateMcpServerOutcome =
  | { readonly kind: 'updated'; readonly server: McpServerRecord }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'name-conflict'; readonly name: string }
  | { readonly kind: 'unknown-credential-secret'; readonly secretId: string };

/** What deleting a connector can produce. Deletion is not idempotent: a second call is `not-found`. */
export type DeleteMcpServerOutcome = { readonly kind: 'deleted' } | { readonly kind: 'not-found' };

/**
 * One tool connector row (`kind` is `openapi` or `postgres`). It has no transport and no
 * authentication type: a tool connector's authentication lives in `toolConfig`, and its credential
 * is the reference `credentialSecretId`.
 */
export interface ToolConnectorRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly name: string;
  readonly kind: ToolConnectorKind;
  /** The kind's configuration, parsed as a JSON object. Its per-kind shape is the server's. */
  readonly toolConfig: Readonly<Record<string, unknown>>;
  /** A reference into `secrets`, never a value. Always set for `postgres`. */
  readonly credentialSecretId: string | null;
  /** The name of the workspace secret that signs the identity assertion; `null` is no opt-in. */
  readonly identitySecretName: string | null;
  readonly enabled: boolean;
  readonly createdBy: string | null;
  readonly ownerPrincipalId: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** Everything a tool connector insert supplies. The workspace comes from the scope. */
export interface CreateToolConnectorInput {
  readonly name: string;
  readonly kind: ToolConnectorKind;
  readonly toolConfig: ToolConfig;
  /** An `openapi` connector's registered document text. Absent or `null` stores none. */
  readonly openapiDocument?: string | null;
  readonly credentialSecretId: string | null;
  readonly identitySecretName?: string | null;
  readonly enabled: boolean;
  readonly ownerPrincipalId: string;
  readonly createdBy?: string | null;
}

/** What creating a tool connector can produce. */
export type CreateToolConnectorOutcome =
  | { readonly kind: 'created'; readonly connector: ToolConnectorRecord }
  | { readonly kind: 'name-conflict'; readonly name: string }
  | { readonly kind: 'unknown-credential-secret'; readonly secretId: string };

/**
 * A tool connector field update. An absent field is left as it is. The kind, the workspace, the
 * owner and the creator are not among them — an update can never move them.
 *
 * Caller precondition: a `postgres` connector's `credentialSecretId` is never cleared to `null`.
 * The database refuses it (`mcp_servers_tool_credential`) and the repository re-throws that CHECK
 * violation as it is (ADR-0015); the server's admission (S2-02c) validates the patch first.
 */
export interface UpdateToolConnectorInput {
  readonly name?: string;
  readonly enabled?: boolean;
  readonly toolConfig?: ToolConfig;
  /** Replaces the stored document text; absent leaves it as it is. */
  readonly openapiDocument?: string | null;
  readonly credentialSecretId?: string | null;
  /** `null` removes the identity opt-in. */
  readonly identitySecretName?: string | null;
}

/** What updating a tool connector can produce. */
export type UpdateToolConnectorOutcome =
  | { readonly kind: 'updated'; readonly connector: ToolConnectorRecord }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'name-conflict'; readonly name: string }
  | { readonly kind: 'unknown-credential-secret'; readonly secretId: string };

/**
 * Connector persistence for exactly one workspace. No method takes a workspace id or can produce a
 * secret's value — every field here is either public metadata or a reference by id.
 */
export interface McpServerRepository {
  /** Every MCP connector in this workspace, oldest first, ties broken by id. */
  list(): Promise<readonly McpServerRecord[]>;
  /** One MCP connector in this workspace, or `null` if this workspace has no MCP connector with that id. */
  get(id: string): Promise<McpServerRecord | null>;
  create(input: CreateMcpServerInput): Promise<CreateMcpServerOutcome>;
  /** Update an MCP connector. A tool connector's id is `not-found`. */
  update(id: string, input: UpdateMcpServerInput): Promise<UpdateMcpServerOutcome>;
  /** Delete a connector of any kind by id. */
  delete(id: string): Promise<DeleteMcpServerOutcome>;
  /** Every tool connector in this workspace, oldest first, ties broken by id. */
  listToolConnectors(): Promise<readonly ToolConnectorRecord[]>;
  /** One tool connector in this workspace, or `null` (an MCP connector's id included). */
  getToolConnector(id: string): Promise<ToolConnectorRecord | null>;
  createToolConnector(input: CreateToolConnectorInput): Promise<CreateToolConnectorOutcome>;
  /** Update a tool connector. Its kind never changes; an MCP connector's id is `not-found`. */
  updateToolConnector(
    id: string,
    input: UpdateToolConnectorInput,
  ): Promise<UpdateToolConnectorOutcome>;
  /**
   * The document text an `openapi` connector was registered with, or `null` when this workspace
   * has no such connector or none was stored (a row created before migration 0052). Deliberately
   * not part of {@link ToolConnectorRecord}: no list or get ever carries it.
   */
  getOpenApiDocument(id: string): Promise<string | null>;
}

/** Hands out an {@link McpServerRepository} bound to one workspace. */
export interface McpServerRepositoryProvider {
  forScope(scope: WorkspaceScope): McpServerRepository;
}
