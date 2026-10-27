/**
 * The `mcp_servers` repository — spec §8, §27. Copies `./agents.ts`'s shape exactly (see that
 * file's header and `./index.ts`'s: "a new resource copies the shape rather than the code").
 *
 * ## Why this file exists outside W2-CP-05's dispatched `Owns:` globs, declared here rather than
 * worked around (ADR-0018, reaffirmed for Wave 2's derived globs by ADR-0023 decision 2)
 *
 * `packages/core/src/db/schema/mcp-servers.ts` already ships the table — W2-DB-01 built it and its
 * own header says plainly: *"The pull request declares the unguarded column [`args`] as a gap for
 * its first consumer, W2-CP-05."* That sentence has no reading in which the table's repository
 * does not exist yet and no track owns writing one. `DatabaseRoot` (`./root.ts`) has no `mcpServers`
 * field, and `@agent-workspace/core/db`'s barrel re-exports only from `./repositories/index.ts`
 * (`database-reachability.test.ts` enforces exactly that shape) — so there is no way for
 * `apps/web/server/connectors/**` to reach this table's rows at all until a repository exists on
 * this side of that barrel, the same problem `docs/adr/W2-CP-02-envelope-encryption-and-its-own-connection.md`
 * records W2-CP-02 hitting for `secrets`.
 *
 * Two things distinguish this from the composition-root/manifest files ADR-0038 puts at the
 * integration level, and are why this file is added here rather than only stated as a gap:
 *
 *   1. **It is new and disjoint.** No sibling 2b-2 track (`W2-CP-04`, skills) touches
 *      `packages/core/src/db/repositories/**` — skills persist through `@agent-workspace/core/storage`,
 *      already shipped and already exported. This file, and the small additive lines it needs in
 *      `./index.ts`, `./root.ts` and `../index.ts`, collide with nothing another 2b-2 PR changes.
 *   2. **It needs no new `package.json` export.** `@agent-workspace/core/db` already exists and
 *      already re-exports "everything `./repositories/index.ts` exports" by construction — adding
 *      a repository here is *exactly* the shape that barrel was built to grow by (`./index.ts`'s own
 *      header: *"A new resource copies the shape … a line on `DatabaseRoot`"*). No manifest changes.
 *
 * What is genuinely this task's protocol's to leave alone, and is left alone: `apps/web/instrumentation.ts`
 * (the call that wires `DatabaseRoot.mcpServers` into `configureConnectorsRuntime` is this task's
 * own ADR, not a line in that file), every `package.json` and `pnpm-lock.yaml` (no dependency and no
 * export subpath is added anywhere for this file — see this task's own `docs/adr/W2-CP-05-*.md` for
 * what *is* declared-but-not-added).
 *
 * ## The one column this file reads defensively
 *
 * `args` is `jsonb` with no `jsonb_typeof` CHECK (the schema file's own declared gap). Every read
 * below parses it with `parseMcpArgs`, which throws on anything that is not `string[]` — the same
 * "the type is a compile-time hint, not a database guarantee" treatment `agents.ts` gives
 * `permissions`.
 *
 * ## Two surfaces over one table (issue #527, S2-02b, ADR-0113 C15)
 *
 * Since migration 0036 a row is an MCP connector or a tool connector (`kind`). The original
 * methods (`list`, `get`, `create`, `update`) read and write `kind = 'mcp'` rows only, so their
 * shape — a non-null `transport` included — is unchanged; the `*ToolConnector*` methods read and
 * write `kind <> 'mcp'` rows only, with `tool_config` parsed as a JSON object. Neither surface can
 * reach the other's rows. `delete` is by id and kind-agnostic. The name is unique across kinds, so
 * both surfaces answer `name-conflict` against a row of the other kind.
 */
import { and, asc, eq, ne, type SQL } from 'drizzle-orm';

import type { Database } from '../client.js';
import {
  connectorKinds,
  mcpAuthTypes,
  mcpServers,
  mcpTransports,
  parseMcpArgs,
  parseToolConfig,
  remoteMcpTransports,
  toolConnectorKinds,
  type ConnectorKind,
  type McpArgs,
  type McpAuthType,
  type McpTransport,
  type ToolConfig,
  type ToolConnectorKind,
} from '../schema/mcp-servers.js';
import { requireWorkspaceScope, type WorkspaceScope } from './scope.js';
import { postgresViolations } from './violations.js';

// Re-exported by name, the same way `./runs.ts` re-exports `runStatuses` from the schema — a
// consumer of this repository (`apps/web/server/connectors/contract.ts`) needs the transport and
// auth-type enums to validate a request body, and re-exporting them here means it needs one import
// (`@agent-workspace/core/db`) rather than a new schema subpath this task does not own.
export { connectorKinds, mcpAuthTypes, mcpTransports, remoteMcpTransports, toolConnectorKinds };
export type { ConnectorKind, McpAuthType, McpTransport, ToolConnectorKind };

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

/** Transcribed from `migrations/0001_w2_resources.sql`, the artefact PostgreSQL reports. */
const NAME_CONFLICT_CONSTRAINTS: ReadonlySet<string> = new Set(['mcp_servers_workspace_name_key']);
const CREDENTIAL_SECRET_CONSTRAINTS: ReadonlySet<string> = new Set([
  'mcp_servers_credential_secret_workspace_fk',
]);

const UNIQUE_VIOLATION = '23505';
const FOREIGN_KEY_VIOLATION = '23503';

/**
 * Classify a write failure, or answer `null` so the caller re-throws (ADR-0015) — the same
 * two-fact positive assertion `agents.ts`'s `classifyWriteFailure` makes.
 */
function classifyWriteFailure(
  error: unknown,
): 'name-conflict' | 'unknown-credential-secret' | null {
  for (const failure of postgresViolations(error)) {
    if (failure.code === UNIQUE_VIOLATION && NAME_CONFLICT_CONSTRAINTS.has(failure.constraint)) {
      return 'name-conflict';
    }
    if (
      failure.code === FOREIGN_KEY_VIOLATION &&
      CREDENTIAL_SECRET_CONSTRAINTS.has(failure.constraint)
    ) {
      return 'unknown-credential-secret';
    }
  }
  return null;
}

const MCP_SERVER_COLUMNS = {
  id: mcpServers.id,
  workspaceId: mcpServers.workspaceId,
  name: mcpServers.name,
  transport: mcpServers.transport,
  command: mcpServers.command,
  args: mcpServers.args,
  url: mcpServers.url,
  authType: mcpServers.authType,
  credentialSecretId: mcpServers.credentialSecretId,
  identitySecretName: mcpServers.identitySecretName,
  enabled: mcpServers.enabled,
  createdBy: mcpServers.createdBy,
  ownerPrincipalId: mcpServers.ownerPrincipalId,
  createdAt: mcpServers.createdAt,
  updatedAt: mcpServers.updatedAt,
} as const;

const TOOL_CONNECTOR_COLUMNS = {
  id: mcpServers.id,
  workspaceId: mcpServers.workspaceId,
  name: mcpServers.name,
  kind: mcpServers.kind,
  toolConfig: mcpServers.toolConfig,
  credentialSecretId: mcpServers.credentialSecretId,
  identitySecretName: mcpServers.identitySecretName,
  enabled: mcpServers.enabled,
  createdBy: mcpServers.createdBy,
  ownerPrincipalId: mcpServers.ownerPrincipalId,
  createdAt: mcpServers.createdAt,
  updatedAt: mcpServers.updatedAt,
} as const;

/**
 * The canonical textual UUID. An id that does not match names no row, so the tool connector
 * methods answer it as absent rather than letting PostgreSQL raise 22P02.
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** A tool kind read back from the database, narrowed by a positive assertion (ADR-0015). */
function parseToolConnectorKind(value: string): ToolConnectorKind {
  for (const kind of toolConnectorKinds) {
    if (kind === value) return kind;
  }
  throw new Error(`mcp_servers.kind holds ${JSON.stringify(value)}, which is not a tool kind`);
}

function toToolRecord(row: {
  id: string;
  workspaceId: string;
  name: string;
  kind: string;
  toolConfig: unknown;
  credentialSecretId: string | null;
  identitySecretName: string | null;
  enabled: boolean;
  createdBy: string | null;
  ownerPrincipalId: string;
  createdAt: Date;
  updatedAt: Date;
}): ToolConnectorRecord {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    name: row.name,
    kind: parseToolConnectorKind(row.kind),
    toolConfig: parseToolConfig(row.toolConfig),
    credentialSecretId: row.credentialSecretId,
    identitySecretName: row.identitySecretName,
    enabled: row.enabled,
    createdBy: row.createdBy,
    ownerPrincipalId: row.ownerPrincipalId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toRecord(row: {
  id: string;
  workspaceId: string;
  name: string;
  transport: string | null;
  command: string | null;
  args: unknown;
  url: string | null;
  authType: string;
  credentialSecretId: string | null;
  identitySecretName: string | null;
  enabled: boolean;
  createdBy: string | null;
  ownerPrincipalId: string;
  createdAt: Date;
  updatedAt: Date;
}): McpServerRecord {
  // Every read filters `kind = 'mcp'`, and `mcp_servers_transport_by_kind` makes the transport
  // non-null for exactly those rows. A NULL here is a broken invariant, not a value to map.
  if (row.transport === null) {
    throw new Error(`mcp_servers row ${row.id} is an MCP connector with no transport`);
  }
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    name: row.name,
    transport: row.transport as McpTransport,
    command: row.command,
    args: row.args === null || row.args === undefined ? null : parseMcpArgs(row.args),
    url: row.url,
    authType: row.authType as McpAuthType,
    credentialSecretId: row.credentialSecretId,
    identitySecretName: row.identitySecretName,
    enabled: row.enabled,
    createdBy: row.createdBy,
    ownerPrincipalId: row.ownerPrincipalId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** The PostgreSQL {@link McpServerRepositoryProvider}. */
export function createDatabaseMcpServerRepositoryProvider(
  db: Database,
): McpServerRepositoryProvider {
  return {
    forScope(scope: WorkspaceScope): McpServerRepository {
      const checked = requireWorkspaceScope(scope, 'McpServerRepositoryProvider');
      const tenant = eq(mcpServers.workspaceId, checked.workspaceId);
      const within = (rest: SQL): SQL => {
        const combined = and(tenant, rest);
        if (combined === undefined) throw new Error('the workspace predicate could not be built');
        return combined;
      };
      const isMcp = eq(mcpServers.kind, 'mcp');
      const isTool = ne(mcpServers.kind, 'mcp');
      /** The tenant predicate, this surface's kind predicate, and one more. */
      const withinKind = (kind: SQL, rest: SQL): SQL => {
        const combined = and(tenant, kind, rest);
        if (combined === undefined) throw new Error('the workspace predicate could not be built');
        return combined;
      };
      const classifiedOutcome = (
        error: unknown,
        name: string | undefined,
        secretId: string | null | undefined,
      ):
        | { readonly kind: 'name-conflict'; readonly name: string }
        | { readonly kind: 'unknown-credential-secret'; readonly secretId: string } => {
        const classified = classifyWriteFailure(error);
        if (classified === 'name-conflict') return { kind: 'name-conflict', name: name ?? '' };
        if (classified === 'unknown-credential-secret') {
          return { kind: 'unknown-credential-secret', secretId: secretId ?? '' };
        }
        throw error;
      };

      return {
        async list(): Promise<readonly McpServerRecord[]> {
          const rows = await db
            .select(MCP_SERVER_COLUMNS)
            .from(mcpServers)
            .where(within(isMcp))
            .orderBy(asc(mcpServers.createdAt), asc(mcpServers.id));
          return rows.map(toRecord);
        },

        async get(id: string): Promise<McpServerRecord | null> {
          const rows = await db
            .select(MCP_SERVER_COLUMNS)
            .from(mcpServers)
            .where(withinKind(isMcp, eq(mcpServers.id, id)))
            .limit(1);
          const row = rows[0];
          return row === undefined ? null : toRecord(row);
        },

        async create(input: CreateMcpServerInput): Promise<CreateMcpServerOutcome> {
          try {
            const rows = await db
              .insert(mcpServers)
              .values({
                workspaceId: checked.workspaceId,
                name: input.name,
                kind: 'mcp',
                transport: input.transport,
                command: input.command,
                args: input.args,
                url: input.url,
                authType: input.authType,
                credentialSecretId: input.credentialSecretId,
                identitySecretName: input.identitySecretName ?? null,
                enabled: input.enabled,
                ownerPrincipalId: input.ownerPrincipalId,
                createdBy: input.createdBy ?? null,
              })
              .returning(MCP_SERVER_COLUMNS);
            const row = rows[0];
            if (row === undefined) throw new Error('the insert returned no row');
            return { kind: 'created', server: toRecord(row) };
          } catch (error) {
            const classified = classifyWriteFailure(error);
            if (classified === 'name-conflict') return { kind: 'name-conflict', name: input.name };
            if (classified === 'unknown-credential-secret') {
              return {
                kind: 'unknown-credential-secret',
                secretId: input.credentialSecretId ?? '',
              };
            }
            throw error;
          }
        },

        async update(id: string, input: UpdateMcpServerInput): Promise<UpdateMcpServerOutcome> {
          const set = {
            ...(input.name === undefined ? {} : { name: input.name }),
            ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
            ...(input.command === undefined ? {} : { command: input.command }),
            ...(input.args === undefined ? {} : { args: input.args }),
            ...(input.url === undefined ? {} : { url: input.url }),
            ...(input.authType === undefined ? {} : { authType: input.authType }),
            ...(input.credentialSecretId === undefined
              ? {}
              : { credentialSecretId: input.credentialSecretId }),
            ...(input.identitySecretName === undefined
              ? {}
              : { identitySecretName: input.identitySecretName }),
          };
          try {
            const rows = await db
              .update(mcpServers)
              .set({ ...set, updatedAt: new Date() })
              .where(withinKind(isMcp, eq(mcpServers.id, id)))
              .returning(MCP_SERVER_COLUMNS);
            const row = rows[0];
            return row === undefined
              ? { kind: 'not-found' }
              : { kind: 'updated', server: toRecord(row) };
          } catch (error) {
            const classified = classifyWriteFailure(error);
            if (classified === 'name-conflict') {
              return { kind: 'name-conflict', name: input.name ?? '' };
            }
            if (classified === 'unknown-credential-secret') {
              return {
                kind: 'unknown-credential-secret',
                secretId: input.credentialSecretId ?? '',
              };
            }
            throw error;
          }
        },

        async delete(id: string): Promise<DeleteMcpServerOutcome> {
          const rows = await db
            .delete(mcpServers)
            .where(within(eq(mcpServers.id, id)))
            .returning({ id: mcpServers.id });
          return rows.length > 0 ? { kind: 'deleted' } : { kind: 'not-found' };
        },

        async listToolConnectors(): Promise<readonly ToolConnectorRecord[]> {
          const rows = await db
            .select(TOOL_CONNECTOR_COLUMNS)
            .from(mcpServers)
            .where(within(isTool))
            .orderBy(asc(mcpServers.createdAt), asc(mcpServers.id));
          return rows.map(toToolRecord);
        },

        async getToolConnector(id: string): Promise<ToolConnectorRecord | null> {
          if (!UUID_PATTERN.test(id)) return null;
          const rows = await db
            .select(TOOL_CONNECTOR_COLUMNS)
            .from(mcpServers)
            .where(withinKind(isTool, eq(mcpServers.id, id)))
            .limit(1);
          const row = rows[0];
          return row === undefined ? null : toToolRecord(row);
        },

        async createToolConnector(
          input: CreateToolConnectorInput,
        ): Promise<CreateToolConnectorOutcome> {
          const kind = parseToolConnectorKind(input.kind);
          const toolConfig = parseToolConfig(input.toolConfig);
          if (input.credentialSecretId !== null && !UUID_PATTERN.test(input.credentialSecretId)) {
            return { kind: 'unknown-credential-secret', secretId: input.credentialSecretId };
          }
          try {
            const rows = await db
              .insert(mcpServers)
              .values({
                workspaceId: checked.workspaceId,
                name: input.name,
                kind,
                transport: null,
                command: null,
                args: null,
                url: null,
                toolConfig,
                openapiDocument: input.openapiDocument ?? null,
                authType: 'none',
                credentialSecretId: input.credentialSecretId,
                identitySecretName: input.identitySecretName ?? null,
                enabled: input.enabled,
                ownerPrincipalId: input.ownerPrincipalId,
                createdBy: input.createdBy ?? null,
              })
              .returning(TOOL_CONNECTOR_COLUMNS);
            const row = rows[0];
            if (row === undefined) throw new Error('the insert returned no row');
            return { kind: 'created', connector: toToolRecord(row) };
          } catch (error) {
            return classifiedOutcome(error, input.name, input.credentialSecretId);
          }
        },

        async updateToolConnector(
          id: string,
          input: UpdateToolConnectorInput,
        ): Promise<UpdateToolConnectorOutcome> {
          if (!UUID_PATTERN.test(id)) return { kind: 'not-found' };
          const secretId = input.credentialSecretId;
          if (typeof secretId === 'string' && !UUID_PATTERN.test(secretId)) {
            return { kind: 'unknown-credential-secret', secretId };
          }
          const set = {
            ...(input.name === undefined ? {} : { name: input.name }),
            ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
            ...(input.toolConfig === undefined
              ? {}
              : { toolConfig: parseToolConfig(input.toolConfig) }),
            ...(input.openapiDocument === undefined
              ? {}
              : { openapiDocument: input.openapiDocument }),
            ...(input.credentialSecretId === undefined
              ? {}
              : { credentialSecretId: input.credentialSecretId }),
            ...(input.identitySecretName === undefined
              ? {}
              : { identitySecretName: input.identitySecretName }),
          };
          try {
            const rows = await db
              .update(mcpServers)
              .set({ ...set, updatedAt: new Date() })
              .where(withinKind(isTool, eq(mcpServers.id, id)))
              .returning(TOOL_CONNECTOR_COLUMNS);
            const row = rows[0];
            return row === undefined
              ? { kind: 'not-found' }
              : { kind: 'updated', connector: toToolRecord(row) };
          } catch (error) {
            return classifiedOutcome(error, input.name, input.credentialSecretId);
          }
        },

        async getOpenApiDocument(id: string): Promise<string | null> {
          if (!UUID_PATTERN.test(id)) return null;
          const rows = await db
            .select({ openapiDocument: mcpServers.openapiDocument })
            .from(mcpServers)
            .where(withinKind(isTool, eq(mcpServers.id, id)))
            .limit(1);
          return rows[0]?.openapiDocument ?? null;
        },
      };
    },
  };
}
