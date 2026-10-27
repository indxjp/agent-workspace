/**
 * An in-memory {@link ConnectorsStoreProvider} — for `routes.test.ts` and any other test in this
 * directory that needs a connectors store with no database, no `MASTER_ENCRYPTION_KEY` and no
 * `@agent-workspace/core` value import at all.
 *
 * Unlike `apps/web/server/secrets/memory-store.ts`, this one does NOT wrap the real
 * `@agent-workspace/core/secrets` — it keeps its own `Map<id, credential>`, in plaintext, entirely
 * inside this process's memory. That is fine for what this store exists to test (the routes' shape,
 * validation and outcome handling) and is never installed by `apps/web/instrumentation.ts` as a
 * deployment mode, the same "not a fallback" posture `apps/web/server/agents/memory-store.ts`'s
 * header states. `store.test.ts` (the real, DB-backed adapter's own conformance suite, gated on
 * `TEST_DATABASE_URL`) is what stands in for a real encrypted secret — this file is not trying to.
 *
 * Mirrors `mcp_servers`' own constraints:
 *   * `mcp_servers_workspace_name_key` — a name is unique within a workspace.
 *   * ids are generated here; a caller never supplies one.
 */
import {
  credentialFieldFor,
  credentialHeaderValue,
  identityOf,
  toToolConnectorResource,
  type AnyConnectorResource,
  type ConnectorResource,
  type McpAuthType,
  type McpTransport,
  type ParsedCreateConnectorInput,
  type ToolConnectorRow,
} from './contract';
import {
  byCreatedThenId,
  type ConnectorsStoreProvider,
  type CreateConnectorOutcome,
  type CreateToolConnectorOutcome,
  type ConnectorFieldPatch,
  type DeleteConnectorOutcome,
  type ResolvedConnectorProbeConfig,
  type UpdateConnectorOutcome,
  type UpdateToolConnectorOutcome,
  type WorkspaceConnectorsProbeSource,
  type WorkspaceConnectorsStore,
} from './store';

/** A tool connector row; `credential` is the raw value, kept only in this process's memory. */
interface StoredToolConnector extends Omit<
  ToolConnectorRow,
  'credentialSecretId' | 'identitySecretName' | 'name' | 'enabled' | 'toolConfig' | 'updatedAt'
> {
  identitySecretName: string | null;
  name: string;
  enabled: boolean;
  toolConfig: Readonly<Record<string, unknown>>;
  openapiDocument: string | null;
  credential: string | null;
  updatedAt: Date;
}

function toolResource(row: StoredToolConnector) {
  return toToolConnectorResource({
    ...row,
    credentialSecretId: row.credential === null ? null : `mem-secret-${row.id}`,
  });
}

interface StoredConnector {
  readonly id: string;
  readonly workspaceId: string;
  name: string;
  readonly transport: McpTransport;
  command: string | null;
  args: readonly string[] | null;
  url: string | null;
  authType: McpAuthType;
  /** The raw credential, kept ONLY in this process's memory — see this file's header. */
  credential: string | null;
  identitySecretName: string | null;
  enabled: boolean;
  readonly createdBy: string | null;
  readonly ownerPrincipalId: string;
  readonly createdAt: Date;
  updatedAt: Date;
}

function toResource(row: StoredConnector): ConnectorResource {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    name: row.name,
    transport: row.transport,
    command: row.command,
    args: row.args,
    url: row.url,
    authType: row.authType,
    hasCredential: row.credential !== null,
    enabled: row.enabled,
    createdBy: row.createdBy,
    ownerPrincipalId: row.ownerPrincipalId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    ...identityOf(row.identitySecretName),
  };
}

function toProbeConfig(row: StoredConnector): ResolvedConnectorProbeConfig {
  const field = credentialFieldFor(row.transport, row.authType);
  const credentialConfigured = field !== null && row.credential !== null;
  if (row.transport === 'stdio') {
    const env: Record<string, string> = {};
    if (field?.kind === 'env' && row.credential !== null) env[field.name] = row.credential;
    return {
      transport: 'stdio',
      command: row.command ?? '',
      args: row.args ?? [],
      env,
      credentialConfigured,
    };
  }
  const headers: Record<string, string> = {};
  if (field?.kind === 'header' && row.credential !== null) {
    headers[field.name] = credentialHeaderValue(row.authType, row.credential);
  }
  return { transport: row.transport, url: row.url ?? '', headers, credentialConfigured };
}

export interface InMemoryConnectorsStoreOptions {
  readonly now?: (() => Date) | undefined;
  readonly newId?: (() => string) | undefined;
  /** Identity secret NAME to value; a name absent here is an unresolvable secret. */
  readonly identityKeys?: Readonly<Record<string, string>> | undefined;
}

export function createInMemoryConnectorsStoreProvider(
  options: InMemoryConnectorsStoreOptions = {},
): ConnectorsStoreProvider {
  const byWorkspace = new Map<string, Map<string, StoredConnector>>();
  const toolsByWorkspace = new Map<string, Map<string, StoredToolConnector>>();
  const now = options.now ?? ((): Date => new Date());
  const newId = options.newId ?? ((): string => crypto.randomUUID());

  function bucketOf<T>(all: Map<string, Map<string, T>>, workspaceId: string): Map<string, T> {
    const existing = all.get(workspaceId);
    if (existing !== undefined) return existing;
    const created = new Map<string, T>();
    all.set(workspaceId, created);
    return created;
  }
  const bucket = (workspaceId: string): Map<string, StoredConnector> =>
    bucketOf(byWorkspace, workspaceId);
  const toolBucket = (workspaceId: string): Map<string, StoredToolConnector> =>
    bucketOf(toolsByWorkspace, workspaceId);

  /** `mcp_servers_workspace_name_key`: a name is unique across every kind in a workspace. */
  function nameTaken(workspaceId: string, name: string): boolean {
    return [...bucket(workspaceId).values(), ...toolBucket(workspaceId).values()].some(
      (row) => row.name === name,
    );
  }

  return {
    forWorkspace(workspaceId: string): WorkspaceConnectorsStore & WorkspaceConnectorsProbeSource {
      return {
        list(): Promise<readonly AnyConnectorResource[]> {
          const resources: AnyConnectorResource[] = [
            ...[...bucket(workspaceId).values()].map(toResource),
            ...[...toolBucket(workspaceId).values()].map(toolResource),
          ];
          return Promise.resolve(resources.sort(byCreatedThenId));
        },

        get(id: string): Promise<AnyConnectorResource | null> {
          const row = bucket(workspaceId).get(id);
          if (row !== undefined) return Promise.resolve(toResource(row));
          const tool = toolBucket(workspaceId).get(id);
          return Promise.resolve(tool === undefined ? null : toolResource(tool));
        },

        createToolConnector(write, owner): Promise<CreateToolConnectorOutcome> {
          if (nameTaken(workspaceId, write.name)) {
            return Promise.resolve({ kind: 'name-conflict', name: write.name });
          }
          const timestamp = now();
          const row: StoredToolConnector = {
            id: newId(),
            workspaceId,
            name: write.name,
            kind: write.kind,
            toolConfig: write.toolConfig,
            openapiDocument: write.openapiDocument,
            credential: write.credential,
            identitySecretName: write.identity?.secret ?? null,
            enabled: true,
            createdBy: owner.userId,
            ownerPrincipalId: owner.principalId,
            createdAt: timestamp,
            updatedAt: timestamp,
          };
          toolBucket(workspaceId).set(row.id, row);
          return Promise.resolve({ kind: 'created', connector: toolResource(row) });
        },

        openapiDocument(id: string): Promise<string | null> {
          return Promise.resolve(toolBucket(workspaceId).get(id)?.openapiDocument ?? null);
        },

        replaceToolConnector(id, change): Promise<UpdateToolConnectorOutcome> {
          const row = toolBucket(workspaceId).get(id);
          if (row === undefined) return Promise.resolve({ kind: 'not-found' });
          const name = change.name;
          if (name !== undefined && name !== row.name && nameTaken(workspaceId, name)) {
            return Promise.resolve({ kind: 'name-conflict', name });
          }
          if (name !== undefined) row.name = name;
          if (change.kind === undefined) {
            if (change.enabled !== undefined) row.enabled = change.enabled;
          } else {
            row.toolConfig = change.toolConfig;
            row.openapiDocument = change.openapiDocument;
            row.credential = change.credential;
            row.identitySecretName = change.identity?.secret ?? null;
          }
          row.updatedAt = now();
          return Promise.resolve({ kind: 'updated', connector: toolResource(row) });
        },

        create(
          input: ParsedCreateConnectorInput,
          owner: { readonly principalId: string; readonly userId: string | null },
        ): Promise<CreateConnectorOutcome> {
          const rows = bucket(workspaceId);
          if (nameTaken(workspaceId, input.name)) {
            return Promise.resolve({ kind: 'name-conflict', name: input.name });
          }
          const timestamp = now();
          const row: StoredConnector = {
            id: newId(),
            workspaceId,
            name: input.name,
            transport: input.transport,
            command: input.command,
            args: input.args,
            url: input.url,
            authType: input.authType,
            credential: input.credential,
            identitySecretName: input.identity?.secret ?? null,
            enabled: true,
            createdBy: owner.userId,
            ownerPrincipalId: owner.principalId,
            createdAt: timestamp,
            updatedAt: timestamp,
          };
          rows.set(row.id, row);
          return Promise.resolve({
            kind: 'created',
            server: {
              id: row.id,
              workspaceId: row.workspaceId,
              name: row.name,
              transport: row.transport,
              command: row.command,
              args: row.args === null ? null : [...row.args],
              url: row.url,
              authType: row.authType,
              credentialSecretId: row.credential !== null ? `mem-secret-${row.id}` : null,
              identitySecretName: row.identitySecretName,
              enabled: row.enabled,
              createdBy: row.createdBy,
              ownerPrincipalId: row.ownerPrincipalId,
              createdAt: row.createdAt,
              updatedAt: row.updatedAt,
            },
          });
        },

        delete(id: string): Promise<DeleteConnectorOutcome> {
          const deleted = bucket(workspaceId).delete(id) || toolBucket(workspaceId).delete(id);
          return Promise.resolve(deleted ? { kind: 'deleted' } : { kind: 'not-found' });
        },

        rotateCredential(id: string, credential: string) {
          const row = bucket(workspaceId).get(id);
          if (row === undefined) return Promise.resolve({ kind: 'not-found' as const });
          if (row.authType === 'none' || row.credential === null) {
            return Promise.resolve({ kind: 'credential-not-configured' as const });
          }
          row.credential = credential;
          row.updatedAt = now();
          return Promise.resolve({ kind: 'rotated' as const, connector: toResource(row) });
        },

        update(id: string, patch: ConnectorFieldPatch): Promise<UpdateConnectorOutcome> {
          const rows = bucket(workspaceId);
          const row = rows.get(id);
          if (row === undefined) return Promise.resolve({ kind: 'not-found' });
          if (
            patch.name !== undefined &&
            patch.name !== row.name &&
            nameTaken(workspaceId, patch.name)
          ) {
            return Promise.resolve({ kind: 'name-conflict', name: patch.name });
          }
          if (patch.name !== undefined) row.name = patch.name;
          if (patch.enabled !== undefined) row.enabled = patch.enabled;
          if (patch.command !== undefined) row.command = patch.command;
          if (patch.args !== undefined) row.args = patch.args === null ? null : [...patch.args];
          if (patch.url !== undefined) row.url = patch.url;
          if (patch.authType !== undefined) row.authType = patch.authType;
          if (patch.identity !== undefined) {
            row.identitySecretName = patch.identity === null ? null : patch.identity.secret;
          }
          if (row.authType === 'none') row.credential = null;
          else if (patch.credential !== undefined) row.credential = patch.credential;
          row.updatedAt = now();
          return Promise.resolve({ kind: 'updated', connector: toResource(row) });
        },

        resolveIdentityKey(id: string): Promise<string | null | undefined> {
          const name = (bucket(workspaceId).get(id) ?? toolBucket(workspaceId).get(id))
            ?.identitySecretName;
          if (name === null || name === undefined) return Promise.resolve(undefined);
          return Promise.resolve(options.identityKeys?.[name] ?? null);
        },

        resolveForProbe(id: string): Promise<ResolvedConnectorProbeConfig | null> {
          const row = bucket(workspaceId).get(id);
          return Promise.resolve(row === undefined ? null : toProbeConfig(row));
        },
      };
    },
  };
}
