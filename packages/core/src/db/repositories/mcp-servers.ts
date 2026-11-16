/**
 * Tenant-scoped MCP and tool connectors share one table and one name constraint.
 * MCP operations require kind = 'mcp'; tool operations exclude it. Reads validate persisted JSON.
 * Delete is intentionally kind-agnostic.
 */
import { and, asc, eq, ne, type SQL } from 'drizzle-orm';

import type { Database } from '../client.js';
import {
  mcpServers,
  parseMcpArgs,
  parseToolConfig,
  toolConnectorKinds,
  type McpAuthType,
  type McpTransport,
  type ToolConnectorKind,
} from '../schema/mcp-servers.js';
import { requireWorkspaceScope, type WorkspaceScope } from './scope.js';
import { postgresViolations } from './violations.js';

// Re-exported by name, the same way `./runs.ts` re-exports `runStatuses` from the schema — a
// consumer of this repository (`apps/web/server/connectors/contract.ts`) needs the transport and
// auth-type enums to validate a request body, and re-exporting them here means it needs one import
// (`@agent-workspace/core/db`) rather than a new schema subpath this task does not own.
export {
  connectorKinds,
  mcpAuthTypes,
  mcpTransports,
  remoteMcpTransports,
  toolConnectorKinds,
} from '../schema/mcp-servers.js';
export type {
  ConnectorKind,
  McpAuthType,
  McpTransport,
  ToolConnectorKind,
} from '../schema/mcp-servers.js';

import type {
  McpServerRecord,
  CreateMcpServerInput,
  CreateMcpServerOutcome,
  UpdateMcpServerInput,
  UpdateMcpServerOutcome,
  DeleteMcpServerOutcome,
  ToolConnectorRecord,
  CreateToolConnectorInput,
  CreateToolConnectorOutcome,
  UpdateToolConnectorInput,
  UpdateToolConnectorOutcome,
  McpServerRepository,
  McpServerRepositoryProvider,
} from './mcp-server-contract.js';
export type {
  McpServerRecord,
  CreateMcpServerInput,
  CreateMcpServerOutcome,
  UpdateMcpServerInput,
  UpdateMcpServerOutcome,
  DeleteMcpServerOutcome,
  ToolConnectorRecord,
  CreateToolConnectorInput,
  CreateToolConnectorOutcome,
  UpdateToolConnectorInput,
  UpdateToolConnectorOutcome,
  McpServerRepository,
  McpServerRepositoryProvider,
} from './mcp-server-contract.js';

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
function classifiedOutcome(
  error: unknown,
  name: string | undefined,
  secretId: string | null | undefined,
):
  | { readonly kind: 'name-conflict'; readonly name: string }
  | { readonly kind: 'unknown-credential-secret'; readonly secretId: string } {
  const classified = classifyWriteFailure(error);
  if (classified === 'name-conflict') return { kind: 'name-conflict', name: name ?? '' };
  if (classified === 'unknown-credential-secret') {
    return { kind: 'unknown-credential-secret', secretId: secretId ?? '' };
  }
  throw error;
}

class DatabaseMcpServerRepository implements McpServerRepository {
  private readonly db: Database;
  private readonly workspaceId: string;
  private readonly tenant: SQL;
  private readonly isMcp = eq(mcpServers.kind, 'mcp');
  private readonly isTool = ne(mcpServers.kind, 'mcp');

  constructor(db: Database, workspaceId: string) {
    this.db = db;
    this.workspaceId = workspaceId;
    this.tenant = eq(mcpServers.workspaceId, workspaceId);
  }

  private within(rest: SQL): SQL {
    const combined = and(this.tenant, rest);
    if (combined === undefined) throw new Error('the workspace predicate could not be built');
    return combined;
  }

  private withinKind(kind: SQL, rest: SQL): SQL {
    const combined = and(this.tenant, kind, rest);
    if (combined === undefined) throw new Error('the workspace predicate could not be built');
    return combined;
  }

  async list(): Promise<readonly McpServerRecord[]> {
    const rows = await this.db
      .select(MCP_SERVER_COLUMNS)
      .from(mcpServers)
      .where(this.within(this.isMcp))
      .orderBy(asc(mcpServers.createdAt), asc(mcpServers.id));
    return rows.map(toRecord);
  }
  async get(id: string): Promise<McpServerRecord | null> {
    const rows = await this.db
      .select(MCP_SERVER_COLUMNS)
      .from(mcpServers)
      .where(this.withinKind(this.isMcp, eq(mcpServers.id, id)))
      .limit(1);
    const row = rows[0];
    return row === undefined ? null : toRecord(row);
  }
  async create(input: CreateMcpServerInput): Promise<CreateMcpServerOutcome> {
    try {
      const rows = await this.db
        .insert(mcpServers)
        .values({
          workspaceId: this.workspaceId,
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
      return classifiedOutcome(error, input.name, input.credentialSecretId);
    }
  }
  async update(id: string, input: UpdateMcpServerInput): Promise<UpdateMcpServerOutcome> {
    const set = {
      name: input.name,
      enabled: input.enabled,
      command: input.command,
      args: input.args,
      url: input.url,
      authType: input.authType,
      credentialSecretId: input.credentialSecretId,
      identitySecretName: input.identitySecretName,
    };
    try {
      const rows = await this.db
        .update(mcpServers)
        .set({ ...set, updatedAt: new Date() })
        .where(this.withinKind(this.isMcp, eq(mcpServers.id, id)))
        .returning(MCP_SERVER_COLUMNS);
      const row = rows[0];
      return row === undefined ? { kind: 'not-found' } : { kind: 'updated', server: toRecord(row) };
    } catch (error) {
      return classifiedOutcome(error, input.name, input.credentialSecretId);
    }
  }
  async delete(id: string): Promise<DeleteMcpServerOutcome> {
    const rows = await this.db
      .delete(mcpServers)
      .where(this.within(eq(mcpServers.id, id)))
      .returning({ id: mcpServers.id });
    return rows.length > 0 ? { kind: 'deleted' } : { kind: 'not-found' };
  }
  async listToolConnectors(): Promise<readonly ToolConnectorRecord[]> {
    const rows = await this.db
      .select(TOOL_CONNECTOR_COLUMNS)
      .from(mcpServers)
      .where(this.within(this.isTool))
      .orderBy(asc(mcpServers.createdAt), asc(mcpServers.id));
    return rows.map(toToolRecord);
  }
  async getToolConnector(id: string): Promise<ToolConnectorRecord | null> {
    if (!UUID_PATTERN.test(id)) return null;
    const rows = await this.db
      .select(TOOL_CONNECTOR_COLUMNS)
      .from(mcpServers)
      .where(this.withinKind(this.isTool, eq(mcpServers.id, id)))
      .limit(1);
    const row = rows[0];
    return row === undefined ? null : toToolRecord(row);
  }
  async createToolConnector(input: CreateToolConnectorInput): Promise<CreateToolConnectorOutcome> {
    const kind = parseToolConnectorKind(input.kind);
    const toolConfig = parseToolConfig(input.toolConfig);
    if (input.credentialSecretId !== null && !UUID_PATTERN.test(input.credentialSecretId)) {
      return { kind: 'unknown-credential-secret', secretId: input.credentialSecretId };
    }
    try {
      const rows = await this.db
        .insert(mcpServers)
        .values({
          workspaceId: this.workspaceId,
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
  }
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
      ...(input.toolConfig === undefined ? {} : { toolConfig: parseToolConfig(input.toolConfig) }),
      ...(input.openapiDocument === undefined ? {} : { openapiDocument: input.openapiDocument }),
      ...(input.credentialSecretId === undefined
        ? {}
        : { credentialSecretId: input.credentialSecretId }),
      ...(input.identitySecretName === undefined
        ? {}
        : { identitySecretName: input.identitySecretName }),
    };
    try {
      const rows = await this.db
        .update(mcpServers)
        .set({ ...set, updatedAt: new Date() })
        .where(this.withinKind(this.isTool, eq(mcpServers.id, id)))
        .returning(TOOL_CONNECTOR_COLUMNS);
      const row = rows[0];
      return row === undefined
        ? { kind: 'not-found' }
        : { kind: 'updated', connector: toToolRecord(row) };
    } catch (error) {
      return classifiedOutcome(error, input.name, input.credentialSecretId);
    }
  }
  async getOpenApiDocument(id: string): Promise<string | null> {
    if (!UUID_PATTERN.test(id)) return null;
    const rows = await this.db
      .select({ openapiDocument: mcpServers.openapiDocument })
      .from(mcpServers)
      .where(this.withinKind(this.isTool, eq(mcpServers.id, id)))
      .limit(1);
    return rows[0]?.openapiDocument ?? null;
  }
}

export function createDatabaseMcpServerRepositoryProvider(
  db: Database,
): McpServerRepositoryProvider {
  return {
    forScope(scope: WorkspaceScope): McpServerRepository {
      const checked = requireWorkspaceScope(scope, 'McpServerRepositoryProvider');
      const repository = new DatabaseMcpServerRepository(db, checked.workspaceId);
      return {
        list: () => repository.list(),
        get: (id) => repository.get(id),
        create: (input) => repository.create(input),
        update: (id, input) => repository.update(id, input),
        delete: (id) => repository.delete(id),
        listToolConnectors: () => repository.listToolConnectors(),
        getToolConnector: (id) => repository.getToolConnector(id),
        createToolConnector: (input) => repository.createToolConnector(input),
        updateToolConnector: (id, input) => repository.updateToolConnector(id, input),
        getOpenApiDocument: (id) => repository.getOpenApiDocument(id),
      };
    },
  };
}
