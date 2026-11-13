import crypto from 'node:crypto';

import { afterAll, beforeAll } from 'vitest';

import { createSecretsService, type SecretsService } from '../../secrets/index.js';
import { memberships } from '../schema/memberships.js';
import { users } from '../schema/users.js';
import { workspacePrincipals } from '../schema/workspace-principals.js';
import { workspaces } from '../schema/workspaces.js';
import {
  createDatabaseMcpServerRepositoryProvider,
  type CreateMcpServerInput,
  type CreateToolConnectorInput,
} from './mcp-servers.js';
import { createDatabaseWorkspaceScopeResolver, type WorkspaceScope } from './scope.js';
import { createIsolatedTestDatabase, type IsolatedTestDatabase } from './testing.js';

export const openapiConfig = {
  specUrl: 'https://api.example.test/openapi.json',
  auth: { type: 'none' },
};
export const postgresConfig = { readOnly: true };

type ConnectorOverrides = Pick<CreateMcpServerInput, 'name' | 'ownerPrincipalId'> &
  Partial<CreateMcpServerInput>;

/** An enabled http connector with no credential; `overrides` names it and sets what differs. */
export const httpConnector = (overrides: ConnectorOverrides): CreateMcpServerInput => ({
  transport: 'http',
  command: null,
  args: null,
  url: 'https://mcp.example.test/mcp',
  authType: 'none',
  credentialSecretId: null,
  enabled: true,
  ...overrides,
});

/** An enabled stdio connector running `true`, with no credential. */
export const stdioConnector = (overrides: ConnectorOverrides): CreateMcpServerInput => ({
  transport: 'stdio',
  command: 'true',
  args: null,
  url: null,
  authType: 'none',
  credentialSecretId: null,
  enabled: true,
  ...overrides,
});

const isCreated = <T extends { readonly kind: string }>(
  outcome: T,
): outcome is Extract<T, { readonly kind: 'created' }> => outcome.kind === 'created';

/** The created branch of a setup step's outcome; any other outcome fails the test's setup. */
export function created<T extends { readonly kind: string }>(
  outcome: T,
): Extract<T, { readonly kind: 'created' }> {
  if (!isCreated(outcome)) throw new Error(`fixture setup failed: ${outcome.kind}`);
  return outcome;
}

type Database = IsolatedTestDatabase['db'];

/** `created_by` is tenant-paired to `memberships` (issue #117); one owner per workspace. */
function tenant(slug: string, name: string, ownerName: string) {
  return {
    workspace: { id: crypto.randomUUID(), slug, name },
    owner: { id: crypto.randomUUID(), name: ownerName },
    membershipId: crypto.randomUUID(),
    principalId: crypto.randomUUID(),
  };
}

type Tenant = ReturnType<typeof tenant>;

async function seedTenants(db: Database, tenants: readonly Tenant[]): Promise<void> {
  await db.insert(workspaces).values(tenants.map((t) => t.workspace));
  await db
    .insert(users)
    .values(tenants.map(({ owner }) => ({ ...owner, email: `${owner.id}@example.test` })));
  await db.transaction(async (tx) => {
    await tx.insert(memberships).values(
      tenants.map((t) => ({
        id: t.membershipId,
        workspaceId: t.workspace.id,
        userId: t.owner.id,
        role: 'owner' as const,
      })),
    );
    await tx.insert(workspacePrincipals).values(
      tenants.map((t) => ({
        id: t.principalId,
        workspaceId: t.workspace.id,
        kind: 'membership' as const,
        membershipId: t.membershipId,
      })),
    );
  });
}

/** A scope minted the same way a request's would be — through the resolver, never a cast. */
async function resolveScope(db: Database, workspaceId: string): Promise<WorkspaceScope> {
  const scope = await createDatabaseWorkspaceScopeResolver(db).forWorkspaceId(workspaceId);
  if (scope === null) throw new Error('fixture setup failed: workspace scope did not resolve');
  return scope;
}

async function seal(
  secretsService: SecretsService,
  scope: WorkspaceScope,
  secret: { readonly name: string; readonly value: string },
): Promise<string> {
  const sealed = await secretsService.create(scope, {
    name: secret.name,
    value: Buffer.from(secret.value, 'utf8'),
  });
  return created(sealed).secret.id;
}

interface Seeded {
  readonly isolated: IsolatedTestDatabase;
  readonly secretsService: SecretsService;
  readonly scopeA: WorkspaceScope;
  readonly scopeB: WorkspaceScope;
  readonly secretInA: string;
  readonly secretInB: string;
}

/**
 * Both workspaces with their owners, and a real `GITHUB_TOKEN` in each sealed by the secrets
 * service against the same isolated database.
 */
async function seed(a: Tenant, b: Tenant): Promise<Seeded> {
  const isolated = await createIsolatedTestDatabase('aw_w2cp05_mcp_servers');
  await seedTenants(isolated.db, [a, b]);
  const scopeA = await resolveScope(isolated.db, a.workspace.id);
  const scopeB = await resolveScope(isolated.db, b.workspace.id);
  const secretsService = await createSecretsService({
    DATABASE_URL: isolated.url,
    MASTER_ENCRYPTION_KEY: crypto.randomBytes(32).toString('hex'),
  });
  const secretInA = await seal(secretsService, scopeA, {
    name: 'GITHUB_TOKEN',
    value: 'gh-real-token',
  });
  const secretInB = await seal(secretsService, scopeB, {
    name: 'GITHUB_TOKEN',
    value: 'gh-real-token-b',
  });
  return { isolated, secretsService, scopeA, scopeB, secretInA, secretInB };
}

/** A workspace of its own, so list assertions see only one test's rows. */
export interface FreshWorkspace {
  readonly workspaceId: string;
  readonly principalId: string;
  readonly secretId: string;
  readonly scope: WorkspaceScope;
}

async function freshWorkspace({ isolated, secretsService }: Seeded): Promise<FreshWorkspace> {
  const fresh = tenant(`kinds-${crypto.randomUUID().slice(0, 8)}`, 'Kinds', 'Kinds owner');
  await seedTenants(isolated.db, [fresh]);
  const scope = await resolveScope(isolated.db, fresh.workspace.id);
  const secretId = await seal(secretsService, scope, {
    name: 'DATABASE_URL',
    value: 'postgres://example',
  });
  return { workspaceId: fresh.workspace.id, principalId: fresh.principalId, secretId, scope };
}

/** Workspaces A and B, each with one owner and a real secret, in an isolated database. */
export function createMcpServerFixture() {
  let seeded: Seeded;
  const a = tenant('w2cp05-a', 'A', 'Owner A');
  const b = tenant('w2cp05-b', 'B', 'Owner B');

  beforeAll(async () => {
    seeded = await seed(a, b);
  }, 180_000);

  afterAll(async () => {
    await seeded.secretsService.close();
    await seeded.isolated.close();
  });

  return {
    get isolated() {
      return seeded.isolated;
    },
    get secretsService() {
      return seeded.secretsService;
    },
    get scopeA() {
      return seeded.scopeA;
    },
    get scopeB() {
      return seeded.scopeB;
    },
    get secretInA() {
      return seeded.secretInA;
    },
    get secretInB() {
      return seeded.secretInB;
    },
    workspaceA: a.workspace,
    userA: a.owner.id,
    userB: b.owner.id,
    principalA: a.principalId,
    principalB: b.principalId,
    /** A connector repository for `scope`, from a fresh provider as a request would build it. */
    repo: (scope: WorkspaceScope) =>
      createDatabaseMcpServerRepositoryProvider(seeded.isolated.db).forScope(scope),
    /** An enabled tool connector owned in workspace A, with its kind's config and no credential. */
    toolConnector: (
      overrides: Pick<CreateToolConnectorInput, 'name' | 'kind'> &
        Partial<CreateToolConnectorInput>,
    ): CreateToolConnectorInput => ({
      toolConfig: overrides.kind === 'openapi' ? openapiConfig : postgresConfig,
      credentialSecretId: null,
      enabled: true,
      ownerPrincipalId: a.principalId,
      ...overrides,
    }),
    freshWorkspace: () => freshWorkspace(seeded),
  };
}

export type McpServerFixture = ReturnType<typeof createMcpServerFixture>;
