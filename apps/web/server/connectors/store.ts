export { byCreatedThenId } from './store-mapping';
import {
  listConnectors,
  getConnector,
  readConnectorDocument,
  readConnectorIdentityKey,
  resolveConnectorProbe,
} from './store-queries';
import { deleteConnector, rotateConnectorCredential } from './store-credentials';
import { createToolConnector, replaceToolConnector } from './store-tools';

import { createConnector, updateConnector } from './store-credential-writes';
/** Workspace-scoped connector CRUD and server-only credential resolution.
 * Routes receive only their required capability; decrypted credentials never enter wire resources.
 */

import {
  UnknownWorkspaceError,
  type CreateMcpServerOutcome as CoreCreateMcpServerOutcome,
  type DeleteMcpServerOutcome as CoreDeleteMcpServerOutcome,
  type McpServerRepositoryProvider as CoreMcpServerRepositoryProvider,
  type McpAuthType,
  type McpTransport,
  type WorkspaceScope as CoreWorkspaceScope,
  type WorkspaceScopeResolver as CoreWorkspaceScopeResolver,
} from '@agent-workspace/core/db';
import type { SecretsService as CoreSecretsService } from '@agent-workspace/core/secrets';
import type { ConnectorIdentity } from '@indx-workspace/contracts/identity-assertion';

import {
  type AnyConnectorResource,
  type ConnectorResource,
  type ParsedCreateConnectorInput,
  type ToolConnectorResource,
} from './contract';
import type { TestConnectionConfig } from './test-connection';
import type { ToolConnectorWrite } from './tools';

export type CreateConnectorOutcome = CoreCreateMcpServerOutcome;
export type DeleteConnectorOutcome = CoreDeleteMcpServerOutcome;
/**
 * A validated field update (`PATCH /api/connectors/:id`, S-20). The handler has already checked it
 * against the connector's transport and its current `authType`, so the store only applies it.
 * No field names the owner, the workspace or the transport: an update cannot move them.
 */
export interface ConnectorFieldPatch {
  readonly name?: string;
  readonly enabled?: boolean;
  readonly command?: string;
  readonly args?: readonly string[] | null;
  readonly url?: string;
  readonly authType?: McpAuthType;
  /** A replacement credential, sealed as a secret; never returned. */
  readonly credential?: string;
  /** The identity opt-in: a secret NAME to set, or `null` to opt out. */
  readonly identity?: ConnectorIdentity | null;
}

export type UpdateConnectorOutcome =
  | { readonly kind: 'updated'; readonly connector: ConnectorResource }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'name-conflict'; readonly name: string };

export type CreateToolConnectorOutcome =
  | { readonly kind: 'created'; readonly connector: ToolConnectorResource }
  | { readonly kind: 'name-conflict'; readonly name: string };

/** A tool connector change: a full replacement (the create body's write), or `name`/`enabled`. */
export type ToolConnectorChange =
  | ToolConnectorWrite
  | { readonly kind?: undefined; readonly name?: string; readonly enabled?: boolean };

export type UpdateToolConnectorOutcome =
  | { readonly kind: 'updated'; readonly connector: ToolConnectorResource }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'name-conflict'; readonly name: string };

export type RotateConnectorCredentialOutcome =
  | { readonly kind: 'rotated'; readonly connector: ConnectorResource }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'credential-not-configured' };

/** CRUD operations for exactly one workspace's connectors. No field or method here can produce a
 *  decrypted credential — see this file's header for why `resolveForProbe` is a separate type. */
export interface WorkspaceConnectorsStore {
  /** Every connector of every kind, oldest first, ties broken by id. */
  list(): Promise<readonly AnyConnectorResource[]>;
  get(id: string): Promise<AnyConnectorResource | null>;
  /**
   * `createdBy` is `memberships.user_id`, resolved by the route layer from the authenticated
   * principal (issue #117) — never a value the client's request body may supply.
   */
  create(
    input: ParsedCreateConnectorInput,
    owner: { readonly principalId: string; readonly userId: string | null },
  ): Promise<CreateConnectorOutcome>;
  delete(id: string): Promise<DeleteConnectorOutcome>;
  rotateCredential(id: string, credential: string): Promise<RotateConnectorCredentialOutcome>;
  update(id: string, patch: ConnectorFieldPatch): Promise<UpdateConnectorOutcome>;
  /** Create a tool connector from an admitted body (`./tools.ts`); its credential is sealed. */
  createToolConnector(
    write: ToolConnectorWrite,
    owner: { readonly principalId: string; readonly userId: string | null },
  ): Promise<CreateToolConnectorOutcome>;
  /** Replace a tool connector (the kind never changes), or change its name or enabled flag. */
  replaceToolConnector(
    id: string,
    change: ToolConnectorChange,
  ): Promise<UpdateToolConnectorOutcome>;
  /**
   * The OpenAPI text an `openapi` connector was registered with, or `null` when it has none (not
   * an openapi connector, not in this workspace, or registered before documents were kept). Never
   * part of a resource: only a platform export reads it.
   */
  openapiDocument(id: string): Promise<string | null>;
}

/** Oldest first, ties broken by id: the repository's own order, kept across the two kinds. */

/** What Test Connection needs for a connector already on file — the same shape
 *  `test-connection.ts`'s `TestConnectionConfig` takes, so a caller passes it straight through. */
export type ResolvedConnectorProbeConfig = TestConnectionConfig;

/** The one extra capability `POST /api/connectors/:id/test-connection` needs. Never handed to a
 *  CRUD handler — see this file's header. */
export interface WorkspaceConnectorsProbeSource {
  /** `null` when this workspace has no connector with that id, OR when it has one but its
   *  credential secret could not be resolved (a dangling reference is reported as "not found"
   *  rather than crashing the probe — the same "not found rather than forbidden" caution
   *  `resolveSecretByName`'s own header explains). */
  resolveForProbe(id: string): Promise<ResolvedConnectorProbeConfig | null>;
  /**
   * The key that signs the identity assertion for a connector of either kind (ADR-0142 D1):
   * `undefined` when it has not opted in (or does not exist), `null` when it opted in but its
   * secret cannot be resolved (the caller fails closed), otherwise the secret's value.
   */
  resolveIdentityKey(id: string): Promise<string | null | undefined>;
}

/** Hands out a {@link WorkspaceConnectorsStore} (and, on the same object, a
 *  {@link WorkspaceConnectorsProbeSource}) bound to one workspace. */
export interface ConnectorsStoreProvider {
  forWorkspace(workspaceId: string): WorkspaceConnectorsStore & WorkspaceConnectorsProbeSource;
}

/** What {@link createRepositoryConnectorsStoreProvider} needs. */
export interface RepositoryConnectorsStoreDependencies {
  readonly mcpServers: CoreMcpServerRepositoryProvider;
  /** The whole secrets subsystem, including `resolveByName` — the one legitimate caller this
   *  wave's plan names. Never handed to anything outside this module. */
  readonly secrets: CoreSecretsService;
  readonly scopes: CoreWorkspaceScopeResolver;
}

/**
 * The {@link ConnectorsStoreProvider} backed by `@agent-workspace/core/db`'s `mcpServers`
 * repository and `@agent-workspace/core/secrets`.
 */
export function createRepositoryConnectorsStoreProvider(
  dependencies: RepositoryConnectorsStoreDependencies,
): ConnectorsStoreProvider {
  return {
    forWorkspace(workspaceId: string): WorkspaceConnectorsStore & WorkspaceConnectorsProbeSource {
      let pending: Promise<CoreWorkspaceScope> | null = null;
      const scope = (): Promise<CoreWorkspaceScope> => {
        pending ??= (async (): Promise<CoreWorkspaceScope> => {
          const resolved = await dependencies.scopes.forWorkspaceId(workspaceId);
          if (resolved === null) throw new UnknownWorkspaceError(workspaceId);
          return resolved;
        })();
        return pending;
      };

      const context = { dependencies, scope };
      return {
        list: () => listConnectors(context),
        get: (id) => getConnector(context, id),
        openapiDocument: (id) => readConnectorDocument(context, id),
        resolveIdentityKey: (id) => readConnectorIdentityKey(context, id),
        resolveForProbe: (id) => resolveConnectorProbe(context, id),

        create: (input, owner) => createConnector({ dependencies, scope }, input, owner),
        delete: (id) => deleteConnector(context, id),
        rotateCredential: (id, credential) => rotateConnectorCredential(context, id, credential),

        update: (id, patch) => updateConnector({ dependencies, scope }, id, patch),
        createToolConnector: (write, owner) => createToolConnector(context, write, owner),
        replaceToolConnector: (id, change) => replaceToolConnector(context, id, change),
      };
    },
  };
}

// Re-exported so `handlers.ts` and route files can name the two auxiliary schema types without a
// second import of `@agent-workspace/core/db`.
export type { McpAuthType, McpTransport };

export interface WorkspaceConnectorContext {
  readonly dependencies: RepositoryConnectorsStoreDependencies;
  readonly scope: () => Promise<CoreWorkspaceScope>;
}
