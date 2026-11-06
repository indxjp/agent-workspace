/**
 * The PostgreSQL harness shared by the `store.postgres*.test.ts` suites: the `TEST_DATABASE_URL`
 * switch, the isolated database, and the fixtures that insert the rows a `runs` row references.
 *
 * Each suite calls {@link useRunDatabase} inside its own `describe.skipIf(!hasDatabase)` block, so
 * the hooks it registers are skipped with the block when no database is configured.
 *
 * The **declared** escape, not the public surface: a conformance suite has to insert the rows the
 * repository under test reads — workspaces, users, memberships, a model connection — and it cannot
 * do that through the layer it is testing without asserting that a function agrees with itself.
 * That needs the raw handle and the table objects, and since verification round 1 those live
 * behind `@agent-workspace/core/db/unscoped`, which throws when it is loaded by a process that has
 * not identified itself as a test runner. A suite is such a process; a route handler is not.
 * `packages/core/src/db/index.ts` records why.
 */
import type { MembershipRoleName } from '@indx-workspace/contracts/team';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll } from 'vitest';

import { createRepositoryRunStore } from './repository-store';
import type { RunStore } from './store';
import { installTestRunApi, resetTestRunApi } from '../application-context-fixtures';
import type { TokenScope } from '../rbac/core/token-scope';

/**
 * Does `env` name a database to run against? Each suite hands over `process.env` itself, because
 * only a `*.test.ts` file may read the environment (F-23).
 */
export function databaseConfigured(env: Readonly<Record<string, string | undefined>>): boolean {
  const rawUrl = env['TEST_DATABASE_URL'];
  return rawUrl !== undefined && rawUrl.trim() !== '';
}

/** `apps/web/server/runs/<this file>` → the repository root, five levels up. */
const repoRoot = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..', '..', '..');

type CoreDb = typeof import('@agent-workspace/core/db/unscoped');
type IsolatedDatabase = Awaited<ReturnType<CoreDb['createIsolatedTestDatabase']>>;
type StoreDependencies = Parameters<typeof createRepositoryRunStore>[0];

type MembershipRole = MembershipRoleName;

export const READ_ONLY_PERMISSIONS = {
  readFiles: true,
  writeFiles: false,
  runCommands: false,
  unrestrictedNetwork: false,
} as const;

/** The ids of one workspace → user → membership → agent → session chain. */
export interface RunChain {
  readonly workspaceId: string;
  readonly userId: string;
  readonly principalId: string;
  readonly agentId: string;
  readonly sessionId: string;
}

/** The display names a seeded chain is given. */
interface ChainNames {
  readonly workspace: string;
  readonly user: string;
  readonly agent: string;
}

/** The principal a route handler sees the request as. */
interface ApiPrincipal {
  readonly userId: string;
  readonly role: 'owner' | 'builder';
}

export interface RunDatabase {
  readonly core: CoreDb;
  readonly db: IsolatedDatabase['db'];
  /** A membership of `workspaceId`, and the workspace principal its trigger minted. */
  createMembershipPrincipal(
    workspaceId: string,
    userId: string,
    role?: MembershipRole,
  ): Promise<string>;
  requireMembershipPrincipalId(workspaceId: string, userId: string): string;
  /** A repository-backed store over the isolated database. */
  makeStore(overrides?: Pick<Partial<StoreDependencies>, 'events' | 'maxEventsPerRun'>): RunStore;
  /** The whole referential chain a `runs` row needs, with fresh ids so nothing collides. */
  seedChain(names: ChainNames): Promise<RunChain>;
  /** A chain with throwaway names, for suites that only need somewhere to put runs. */
  seedWorkspace(): Promise<RunChain>;
  /** Install `store` behind the HTTP routes as `principal` in `workspaceId`, run `body`, uninstall. */
  withRunApi(
    workspaceId: string,
    principal: ApiPrincipal,
    store: RunStore,
    scope: TokenScope | null,
    body: () => Promise<void>,
  ): Promise<void>;
  /** {@link RunDatabase.withRunApi} as an Owner with no token scope. */
  asOwnerOf(
    workspaceId: string,
    userId: string,
    store: RunStore,
    body: () => Promise<void>,
  ): Promise<void>;
}

/** Register the isolated database's hooks and return the harness over it. */
export function useRunDatabase(): RunDatabase {
  let core: CoreDb | undefined;
  let isolated: IsolatedDatabase | undefined;
  const membershipPrincipals = new Map<string, string>();

  beforeAll(async () => {
    const dist = path.join(
      repoRoot,
      'packages',
      'core',
      'dist',
      'db',
      'repositories',
      'unscoped.js',
    );
    // A positive assertion before the import, so the failure names its own remedy. Deliberately
    // not a skip: TEST_DATABASE_URL is set, so this half of the suite was asked for and must
    // either run or fail (ADR-0015).
    if (!existsSync(dist)) {
      throw new Error(
        `${dist} does not exist. Run \`pnpm --filter @agent-workspace/core run build\` before ` +
          '`pnpm test`; CI does this in a step of its own.',
      );
    }
    core = await import('@agent-workspace/core/db/unscoped');
    isolated = await core.createIsolatedTestDatabase('aw_w2db02_runs');
  }, 180_000);

  afterAll(async () => {
    await isolated?.close();
  });

  const ready = (): { core: CoreDb; isolated: IsolatedDatabase } => {
    if (core === undefined || isolated === undefined) throw new Error('the database is not ready');
    return { core, isolated };
  };

  const database: RunDatabase = {
    get core() {
      return ready().core;
    },
    get db() {
      return ready().isolated.db;
    },
    async createMembershipPrincipal(workspaceId, userId, role = 'owner') {
      const { core: tables, isolated: handle } = ready();
      const membershipId = crypto.randomUUID();
      await handle.db
        .insert(tables.memberships)
        .values({ id: membershipId, workspaceId, userId, role });
      const principal = (await handle.db.select().from(tables.workspacePrincipals)).find(
        (candidate) => candidate.membershipId === membershipId,
      );
      if (principal === undefined) {
        throw new Error('the membership compatibility trigger did not create an exact principal');
      }
      membershipPrincipals.set(`${workspaceId}:${userId}`, principal.id);
      return principal.id;
    },
    requireMembershipPrincipalId(workspaceId, userId) {
      const principalId = membershipPrincipals.get(`${workspaceId}:${userId}`);
      if (principalId === undefined) {
        throw new Error('the run fixture membership has no exact principal');
      }
      return principalId;
    },
    makeStore(overrides = {}) {
      const { core: tables, isolated: handle } = ready();
      return createRepositoryRunStore({
        repositories: tables.createDatabaseRunRepositoryProvider(handle.db),
        events: tables.createDatabaseRunEventRepositoryProvider(handle.db),
        scopes: tables.createDatabaseWorkspaceScopeResolver(handle.db),
        findRunWorkspace: (runId: string): Promise<string | null> =>
          tables.findRunWorkspace(handle.db, runId),
        ...overrides,
      });
    },
    async seedChain(names) {
      const { core: tables, isolated: handle } = ready();
      const workspaceId = crypto.randomUUID();
      const userId = crypto.randomUUID();
      const agentId = crypto.randomUUID();
      const sessionId = crypto.randomUUID();
      await handle.db
        .insert(tables.workspaces)
        .values({ id: workspaceId, slug: workspaceId, name: names.workspace });
      await handle.db
        .insert(tables.users)
        .values({ id: userId, email: `${userId}@example.com`, name: names.user });
      const principalId = await database.createMembershipPrincipal(workspaceId, userId);
      await handle.db.insert(tables.agents).values({
        id: agentId,
        workspaceId,
        name: names.agent,
        instructions: '',
        modelConnectionId: null,
        model: null,
        createdBy: userId,
        ownerPrincipalId: principalId,
        permissions: READ_ONLY_PERMISSIONS,
      });
      await handle.db
        .insert(tables.sessions)
        .values({ id: sessionId, workspaceId, userId, agentId, ownerPrincipalId: principalId });
      return { workspaceId, userId, principalId, agentId, sessionId };
    },
    seedWorkspace() {
      return database.seedChain({ workspace: 'Tie', user: 'o', agent: 'A' });
    },
    async withRunApi(workspaceId, principal, store, scope, body) {
      const principalId = database.requireMembershipPrincipalId(workspaceId, principal.userId);
      installTestRunApi({
        authenticate: () =>
          Promise.resolve({
            ...principal,
            principalId,
            ownerPrincipalId: principalId,
            workspaceId,
            scope,
          }),
        findAgent: () => Promise.resolve(null),
        openSession: () => Promise.resolve(null),
        ownsRun: () => Promise.resolve(true),
        store,
        launch: () => undefined,
      });
      try {
        await body();
      } finally {
        resetTestRunApi();
      }
    },
    asOwnerOf(workspaceId, userId, store, body) {
      return database.withRunApi(workspaceId, { userId, role: 'owner' }, store, null, body);
    },
  };
  return database;
}
