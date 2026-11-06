import { toResource, buildTestConfig, toToolUpdateOutcome } from './store-mapping';
import {
  createConnector,
  updateConnector,
  sealCredential,
  discardSealed,
  retireReplacedCredential,
} from './store-credential-writes';
/**
 * The port the connector routes talk to, and the adapter onto `@agent-workspace/core/db`'s
 * `mcpServers` repository plus `@agent-workspace/core/secrets`. Copies `apps/web/server/agents/store.ts`
 * and `apps/web/server/secrets/store.ts`'s shape: a store is obtained *for a workspace id*, and no
 * method on the result takes one, so there is no call site at which spec §25's tenant filter can be
 * forgotten.
 *
 * ## The credential split: two interfaces on one object, never one route holding both
 *
 * {@link WorkspaceConnectorsStore} is what `handlers.ts`'s CRUD operations call — `list`, `get`,
 * `create`, `delete` — and nothing on it can produce a decrypted credential. {@link
 * WorkspaceConnectorsProbeSource} is the one extra method, `resolveForProbe`, that decrypts a
 * saved connector's credential so `POST /api/connectors/:id/test-connection` can run the real MCP
 * handshake against it — spec §23's write-only rule applied to connectors the way
 * `packages/core/src/secrets/service.ts`'s header applies it to `resolveByName`: *"the one
 * legitimate caller in this wave's plan is W2-CP-05's connector credential resolution, running
 * server-side, never as the direct response to an HTTP request."* {@link ResolvedConnectorProbeConfig}
 * carries the decrypted value; nothing here serialises it, logs it, or returns it from a route —
 * `test-connection.ts`'s own header repeats the same promise about what it does with it.
 *
 * `createRepositoryConnectorsStoreProvider`'s returned object satisfies BOTH interfaces at once
 * (the same object, not two), and each caller's OWN parameter type is what keeps the two apart:
 * `handlers.ts`'s CRUD functions take `WorkspaceConnectorsStore`, and only the test-connection
 * handler takes the wider type. TypeScript's structural typing is what makes this a real
 * boundary — a CRUD handler that tried to call `resolveForProbe` would need to widen its own
 * parameter type first, which is a reviewable one-line change, not an accident.
 */
import { isPlatformOwnedSecretName } from '../secrets/contract';

import {
  UnknownWorkspaceError,
  type CreateMcpServerOutcome as CoreCreateMcpServerOutcome,
  type CreateToolConnectorInput as CoreCreateToolConnectorInput,
  type DeleteMcpServerOutcome as CoreDeleteMcpServerOutcome,
  type McpServerRepository as CoreMcpServerRepository,
  type McpServerRepositoryProvider as CoreMcpServerRepositoryProvider,
  type ToolConnectorRecord as CoreToolConnectorRecord,
  type UpdateToolConnectorInput as CoreUpdateToolConnectorInput,
  type UpdateToolConnectorOutcome as CoreUpdateToolConnectorOutcome,
  type McpAuthType,
  type McpTransport,
  type WorkspaceScope as CoreWorkspaceScope,
  type WorkspaceScopeResolver as CoreWorkspaceScopeResolver,
} from '@agent-workspace/core/db';
import type { SecretsService as CoreSecretsService } from '@agent-workspace/core/secrets';
import type { ConnectorIdentity } from '@indx-workspace/contracts/identity-assertion';

import {
  toToolConnectorResource,
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
export function byCreatedThenId(
  a: { readonly createdAt: string; readonly id: string },
  b: { readonly createdAt: string; readonly id: string },
): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

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

/** The repository's tool connector methods under the short names this store uses. */
function toolRepository(repository: CoreMcpServerRepository) {
  return {
    list: () => repository.listToolConnectors(),
    get: (id: string) => repository.getToolConnector(id),
    create: (input: CoreCreateToolConnectorInput) => repository.createToolConnector(input),
    update: (id: string, input: CoreUpdateToolConnectorInput) =>
      repository.updateToolConnector(id, input),
    openapiDocument: (id: string) => repository.getOpenApiDocument(id),
  };
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

      return {
        async list(): Promise<readonly AnyConnectorResource[]> {
          const resolved = await scope();
          const repository = dependencies.mcpServers.forScope(resolved);
          const [mcp, tools] = await Promise.all([
            repository.list(),
            toolRepository(repository).list(),
          ]);
          return [...mcp.map(toResource), ...tools.map(toToolConnectorResource)].sort(
            byCreatedThenId,
          );
        },

        async get(id: string): Promise<AnyConnectorResource | null> {
          const resolved = await scope();
          const repository = dependencies.mcpServers.forScope(resolved);
          const row = await repository.get(id);
          if (row !== null) return toResource(row);
          const tool = await toolRepository(repository).get(id);
          return tool === null ? null : toToolConnectorResource(tool);
        },

        create: (input, owner) => createConnector({ dependencies, scope }, input, owner),

        async delete(id: string): Promise<DeleteConnectorOutcome> {
          const resolved = await scope();
          const repository = dependencies.mcpServers.forScope(resolved);
          const existing: { readonly credentialSecretId: string | null } | null =
            (await repository.get(id)) ?? (await toolRepository(repository).get(id));
          if (existing === null) return { kind: 'not-found' };
          const outcome = await repository.delete(id);
          if (outcome.kind === 'deleted' && existing.credentialSecretId !== null) {
            const cleanup = await dependencies.secrets.delete(
              resolved,
              existing.credentialSecretId,
            );
            if (cleanup.kind !== 'deleted' && cleanup.kind !== 'not-found') {
              throw new Error(
                `deleted connector ${id}, but its credential is still ${cleanup.kind}`,
              );
            }
          }
          return outcome;
        },

        async rotateCredential(id, credential): Promise<RotateConnectorCredentialOutcome> {
          const resolved = await scope();
          const repository = dependencies.mcpServers.forScope(resolved);
          const existing = await repository.get(id);
          if (existing === null) return { kind: 'not-found' };
          if (existing.credentialSecretId === null || existing.authType === 'none') {
            return { kind: 'credential-not-configured' };
          }
          const replaced = await dependencies.secrets.replace(
            resolved,
            existing.credentialSecretId,
            Buffer.from(credential, 'utf8'),
          );
          if (replaced.kind === 'not-found') return { kind: 'credential-not-configured' };
          const updated = await repository.get(id);
          if (updated === null) return { kind: 'not-found' };
          return { kind: 'rotated', connector: toResource(updated) };
        },

        update: (id, patch) => updateConnector({ dependencies, scope }, id, patch),

        async createToolConnector(write, owner): Promise<CreateToolConnectorOutcome> {
          const resolved = await scope();
          const tools = toolRepository(dependencies.mcpServers.forScope(resolved));
          const secretId =
            write.credential === null
              ? null
              : await sealCredential(dependencies.secrets, resolved, write.credential);
          let outcome: Awaited<ReturnType<typeof tools.create>>;
          try {
            outcome = await tools.create({
              name: write.name,
              kind: write.kind,
              toolConfig: { ...write.toolConfig },
              openapiDocument: write.openapiDocument,
              credentialSecretId: secretId,
              identitySecretName: write.identity?.secret ?? null,
              enabled: true,
              ownerPrincipalId: owner.principalId,
              createdBy: owner.userId,
            });
          } catch (error) {
            if (secretId !== null) await discardSealed(dependencies.secrets, resolved, secretId);
            throw error;
          }
          if (outcome.kind === 'created') {
            return { kind: 'created', connector: toToolConnectorResource(outcome.connector) };
          }
          if (secretId !== null) await discardSealed(dependencies.secrets, resolved, secretId);
          if (outcome.kind === 'name-conflict') return outcome;
          throw new Error('a tool connector named a credential secret that does not exist');
        },

        async replaceToolConnector(id, change): Promise<UpdateToolConnectorOutcome> {
          const resolved = await scope();
          const tools = toolRepository(dependencies.mcpServers.forScope(resolved));
          const existing: CoreToolConnectorRecord | null = await tools.get(id);
          if (existing === null) return { kind: 'not-found' };
          if (change.kind === undefined) {
            return toToolUpdateOutcome(
              await tools.update(id, {
                ...(change.name === undefined ? {} : { name: change.name }),
                ...(change.enabled === undefined ? {} : { enabled: change.enabled }),
              }),
            );
          }
          // A full replacement: a credential sent with it is sealed fresh and lands in the same row
          // update as the new document or host (ADR-0077 D5); the replaced secret is retired after.
          const secretId =
            change.credential === null
              ? null
              : await sealCredential(dependencies.secrets, resolved, change.credential);
          let updated: CoreUpdateToolConnectorOutcome;
          try {
            updated = await tools.update(id, {
              name: change.name,
              toolConfig: { ...change.toolConfig },
              openapiDocument: change.openapiDocument,
              credentialSecretId: secretId,
              identitySecretName: change.identity?.secret ?? null,
            });
          } catch (error) {
            if (secretId !== null) await discardSealed(dependencies.secrets, resolved, secretId);
            throw error;
          }
          if (updated.kind !== 'updated') {
            if (secretId !== null) await discardSealed(dependencies.secrets, resolved, secretId);
          } else if (existing.credentialSecretId !== null) {
            await retireReplacedCredential(
              dependencies.secrets,
              resolved,
              id,
              existing.credentialSecretId,
            );
          }
          return toToolUpdateOutcome(updated);
        },

        async openapiDocument(id: string): Promise<string | null> {
          const resolved = await scope();
          return toolRepository(dependencies.mcpServers.forScope(resolved)).openapiDocument(id);
        },

        async resolveIdentityKey(id: string): Promise<string | null | undefined> {
          const resolved = await scope();
          const repository = dependencies.mcpServers.forScope(resolved);
          const record = (await repository.get(id)) ?? (await toolRepository(repository).get(id));
          if (record === null || record.identitySecretName === null) return undefined;
          // Never a platform-owned credential, even on a row stored before it was refused.
          if (isPlatformOwnedSecretName(record.identitySecretName)) return null;
          const secret = await dependencies.secrets.resolveByName(
            resolved,
            record.identitySecretName,
          );
          return secret === null ? null : secret.value.toString('utf8');
        },

        // ponytail: dry run is the tool kinds' test; a saved tool connector has no probe (404).
        async resolveForProbe(id: string): Promise<ResolvedConnectorProbeConfig | null> {
          const resolved = await scope();
          const record = await dependencies.mcpServers.forScope(resolved).get(id);
          if (record === null) return null;
          if (record.credentialSecretId === null) return buildTestConfig(record, null);

          // The credential is resolved directly by its stored id — server-side only, the W2-CP-05
          // caller this wave's plan names. A missing or foreign id answers `null`.
          const resolvedSecret = await dependencies.secrets.resolveById(
            resolved,
            record.credentialSecretId,
          );
          if (resolvedSecret === null) return buildTestConfig(record, null);
          return buildTestConfig(record, resolvedSecret.value.toString('utf8'));
        },
      };
    },
  };
}

// Re-exported so `handlers.ts` and route files can name the two auxiliary schema types without a
// second import of `@agent-workspace/core/db`.
export type { McpAuthType, McpTransport };
