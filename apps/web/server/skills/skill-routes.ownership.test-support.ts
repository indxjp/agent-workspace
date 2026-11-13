import { openDatabaseRoot, type DatabaseRoot } from '@agent-workspace/core/db';
import {
  apiKeys,
  createIsolatedTestDatabase,
  memberships,
  users,
  workspacePrincipals,
  workspaces,
  type IsolatedTestDatabase,
} from '@agent-workspace/core/db/unscoped';
import { createLocalFilesystemObjectStoreProvider } from '@agent-workspace/core/storage';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { GET as detailRoute, PATCH as patchRoute } from '../../app/api/skills/[name]/route';
import { POST as importRoute } from '../../app/api/skills/route';
import { clearApplicationContext } from '../application-context';
import { installTestDomains } from '../application-context-fixtures';
import { createPostgresDirectory } from '../rbac/postgres-directory';
import { Principal } from '../rbac/principal';
import { createResourceCatalogStoreProvider } from '../storage/store';
import { createRepositorySkillsStoreProvider } from '../storage/store';
import type { WorkspaceResolution } from './runtime';
import {
  ACTOR_HEADER,
  nameContext,
  req,
  skillsStorage,
  WORKSPACE_HEADER,
} from './skill-routes.test-support';

interface BuilderActor {
  readonly user: { id: string; email: string; name: string };
  readonly apiKeyId: string;
  readonly principalId: string;
  readonly keyPrefix: string;
  readonly keyHash: string;
  readonly label: string;
}

class OwnershipFixture {
  readonly workspace = {
    id: crypto.randomUUID(),
    slug: 'w9-117-skills-ownership',
    name: 'Skills ownership',
  };
  readonly builderA: BuilderActor = {
    user: { id: crypto.randomUUID(), email: 'builder-a@example.test', name: 'Builder A' },
    apiKeyId: crypto.randomUUID(),
    principalId: 'cba4eb82-685c-43c2-bbba-65a7f8131e74',
    keyPrefix: 'ak_skill_a',
    keyHash: 'c'.repeat(64),
    label: 'Builder A skill key',
  };
  readonly builderB: BuilderActor = {
    user: { id: crypto.randomUUID(), email: 'builder-b@example.test', name: 'Builder B' },
    apiKeyId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    principalId: 'bf63147f-5888-4779-8c7f-8bcedc57e426',
    keyPrefix: 'ak_skill_b',
    keyHash: 'd'.repeat(64),
    label: 'Builder B skill key',
  };
  private isolatedValue: IsolatedTestDatabase | undefined;
  private rootValue: DatabaseRoot | undefined;
  private dbRootDir = '';

  constructor() {
    beforeAll(() => this.setup(), 180_000);
    afterAll(async () => {
      await this.root.close();
      await this.isolated.close();
    });
    beforeEach(() => this.install());
    afterEach(async () => {
      clearApplicationContext();
      await rm(this.dbRootDir, { recursive: true, force: true });
    });
  }

  private get root(): DatabaseRoot {
    if (this.rootValue === undefined) throw new Error('ownership root not initialized');
    return this.rootValue;
  }
  private get isolated(): IsolatedTestDatabase {
    if (this.isolatedValue === undefined) throw new Error('ownership database not initialized');
    return this.isolatedValue;
  }

  private async setup() {
    this.isolatedValue = await createIsolatedTestDatabase('aw_skills_ownership');
    const actors = [this.builderA, this.builderB];
    const workspaceId = this.workspace.id;
    await this.isolated.db.insert(workspaces).values(this.workspace);
    await this.isolated.db.insert(users).values(actors.map(({ user }) => user));
    await this.isolated.db
      .insert(memberships)
      .values(
        actors.map(({ user }) => ({ workspaceId, userId: user.id, role: 'builder' as const })),
      );
    await this.isolated.db.transaction(async (tx) => {
      await tx.insert(apiKeys).values(
        actors.map((actor) => ({
          id: actor.apiKeyId,
          workspaceId,
          name: actor.label,
          role: 'builder' as const,
          keyPrefix: actor.keyPrefix,
          keyHash: actor.keyHash,
        })),
      );
      await tx.insert(workspacePrincipals).values(
        actors.map((actor) => ({
          id: actor.principalId,
          workspaceId,
          kind: 'api_key' as const,
          apiKeyId: actor.apiKeyId,
        })),
      );
    });
    this.rootValue = await openDatabaseRoot({ DATABASE_URL: this.isolated.url });
  }

  private async install() {
    this.dbRootDir = await mkdtemp(path.join(os.tmpdir(), 'w9-auth-117-skills-ownership-'));
    const dbCatalogs = createResourceCatalogStoreProvider({
      repositories: this.root.resourceCatalogs,
      scopes: this.root.scopes,
    });
    installTestDomains({
      skills: {
        kind: 'serving',
        runtime: {
          store: createRepositorySkillsStoreProvider({
            store: createLocalFilesystemObjectStoreProvider(this.dbRootDir),
            scopes: this.root.scopes,
          }),
          catalog: dbCatalogs,
          storage: skillsStorage(dbCatalogs),
          resolveWorkspace,
        },
      },
    });
    installTestDomains({
      rbac: {
        directory: createPostgresDirectory(this.root.directory),
        identify: (request: Request) => this.identify(request),
      },
    });
  }

  private identify(request: Request): Promise<Principal | null> {
    const workspaceId = request.headers.get(WORKSPACE_HEADER);
    const actor = request.headers.get(ACTOR_HEADER);
    if (workspaceId === null || actor === null) return Promise.resolve(null);
    const builder = actor === this.builderA.user.email ? this.builderA : this.builderB;
    return Promise.resolve(
      Principal.fromApiKey({
        principalId: builder.principalId,
        apiKeyId: builder.apiKeyId,
        workspaceId,
        role: 'builder',
        label: builder.label,
      }),
    );
  }
}

function resolveWorkspace(request: Request): Promise<WorkspaceResolution> {
  const workspaceId = request.headers.get(WORKSPACE_HEADER);
  return Promise.resolve(
    workspaceId === null
      ? { kind: 'unauthenticated', reason: 'no test workspace header' }
      : { kind: 'workspace', workspaceId },
  );
}

export function registerOwnershipTests(hasDatabase: boolean) {
  describe.skipIf(!hasDatabase)(
    'own/other ownership on GET/PATCH /api/skills/:name (issue #117, PostgreSQL-backed)',
    () => {
      const fixture = new OwnershipFixture();
      it('a Builder may read and edit the skill it imported, and no other Builder may (issue #117)', () =>
        provesBuilderOwnership(fixture));
    },
  );
}

async function provesBuilderOwnership({ workspace, builderA, builderB }: OwnershipFixture) {
  const imported = await importRoute(
    req('POST', '/api/skills', {
      workspace: workspace.id,
      body: JSON.stringify({
        name: 'shared',
        files: [
          {
            path: 'SKILL.md',
            contentBase64: Buffer.from('---\nname: shared\n---\nbody\n').toString('base64'),
          },
        ],
      }),
      contentType: 'application/json',
      headers: { [ACTOR_HEADER]: builderA.user.email },
    }),
  );
  expect(imported.status, await imported.clone().text()).toBe(201);

  // Builder's grant on `skills` is `{ read: 'any', write: 'own', run: 'own' }`
  // (`permissions.ts`) — `GET` is readable workspace-wide by design and is not an own/other
  // gate; `PATCH` is the write this task's `ownershipOfName` stands in front of, and it is
  // what this test proves. Both builders can read the same skill first, so the denial below
  // is provably about `PATCH`, not a workspace mismatch.
  const readByOther = await detailRoute(
    req('GET', '/api/skills/shared', {
      workspace: workspace.id,
      headers: { [ACTOR_HEADER]: builderB.user.email },
    }),
    nameContext('shared'),
  );
  expect(readByOther.status, await readByOther.clone().text()).toBe(200);

  // Builder B did not create this row: `own` is denied, and `decide()` never sees a role wide
  // enough to substitute for it (Builder's write grant on skills is `own`, not `any`).
  const deniedPatch = await patchRoute(
    req('PATCH', '/api/skills/shared', {
      workspace: workspace.id,
      body: JSON.stringify({ enabled: false }),
      contentType: 'application/json',
      headers: { [ACTOR_HEADER]: builderB.user.email },
    }),
    nameContext('shared'),
  );
  expect(deniedPatch.status).toBe(403);

  // Builder A did create it: the same route, the same skill, only the caller differs.
  const allowedPatch = await patchRoute(
    req('PATCH', '/api/skills/shared', {
      workspace: workspace.id,
      body: JSON.stringify({ enabled: false }),
      contentType: 'application/json',
      headers: { [ACTOR_HEADER]: builderA.user.email },
    }),
    nameContext('shared'),
  );
  expect(allowedPatch.status, await allowedPatch.clone().text()).toBe(200);
}
