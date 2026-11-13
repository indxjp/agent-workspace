import { beforeEach, expect } from 'vitest';
import { POST as importRoute } from '../../app/api/skills/route';

import {
  workspaceFolder,
  createInMemoryObjectStore,
  createInMemoryObjectStoreProvider,
  type ObjectStore,
} from '@agent-workspace/core/storage';
import { installTestDomains } from '../application-context-fixtures';
import { createMemoryDirectory } from '../rbac/memory-directory';
import { Principal } from '../rbac/principal';
import { createStorageService } from '../storage/service';
import { createRepositorySkillsStoreProvider } from '../storage/store';
import {
  type World,
  noLog,
  type PartSpec,
  multipart,
} from './multipart-import.fixture.test-support';
export function createSkillImportFixture(setup: () => Promise<World>) {
  let world: World;
  let objects: ObjectStore;
  let storage: ReturnType<typeof createStorageService>;
  function install(root: ObjectStore): void {
    objects = root;
    storage = createStorageService({
      catalog: (workspaceId) => world.catalogs.forWorkspace(workspaceId),
      objects,
      log: noLog,
    });
    installTestDomains({
      skills: {
        kind: 'serving',
        runtime: {
          store: createRepositorySkillsStoreProvider({
            store: createInMemoryObjectStoreProvider(),
            scopes: world.scopes,
          }),
          catalog: world.catalogs,
          storage,
          resolveWorkspace: () =>
            Promise.resolve({ kind: 'workspace', workspaceId: world.workspaceId }),
        },
      },
      rbac: {
        directory: createMemoryDirectory({
          users: [
            {
              email: 'owner@example.test',
              name: 'Owner',
              workspaceId: world.workspaceId,
              role: 'owner',
            },
          ],
        }),
        identify: () =>
          Promise.resolve(
            Principal.fromApiKey({
              principalId: world.principalId,
              apiKeyId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
              workspaceId: world.workspaceId,
              role: 'owner',
              label: 'Skill import test key',
            }),
          ),
      },
    });
  }
  beforeEach(async () => {
    world = await setup();
    install(createInMemoryObjectStore());
  });
  const post = (
    sent: { body: BodyInit | null; contentType: string },
    headers: Record<string, string> = {},
  ) => {
    // A variable, not a literal: the DOM `RequestInit` has no `duplex`.
    const init = {
      method: 'POST',
      headers: { 'content-type': sent.contentType, ...headers },
      body: sent.body,
      duplex: 'half' as const,
    };
    return importRoute(new Request('https://example.invalid/api/skills', init));
  };
  const postParts = (parts: readonly PartSpec[], headers?: Record<string, string>) =>
    post(multipart(parts), headers);
  const catalog = () => world.catalogs.forWorkspace(world.workspaceId);
  const rowTexts = async (folder: string): Promise<Record<string, string>> => {
    const ctx = { workspaceId: world.workspaceId };
    const out: Record<string, string> = {};
    for (const row of (await storage.list(ctx, 'skills', folder)).rows) {
      const opened = await storage.open(ctx, row);
      out[row.path] = await new Response(opened?.body).text();
    }
    return out;
  };
  const expectNothingSaved = async (): Promise<void> => {
    expect(await (await catalog()).listSkills()).toEqual([]);
    expect(
      (await storage.list({ workspaceId: world.workspaceId }, 'skills', '.skills')).rows,
    ).toEqual([]);
    expect(
      (await objects.listPage(workspaceFolder(world.workspaceId).slice(0, -1), { recursive: true }))
        .entries,
    ).toEqual([]);
  };
  return {
    get world() {
      return world;
    },
    get objects() {
      return objects;
    },
    get storage() {
      return storage;
    },
    get install() {
      return install;
    },
    get post() {
      return post;
    },
    get postParts() {
      return postParts;
    },
    get catalog() {
      return catalog;
    },
    get rowTexts() {
      return rowTexts;
    },
    get expectNothingSaved() {
      return expectNothingSaved;
    },
  };
}
export type SkillImportFixture = ReturnType<typeof createSkillImportFixture>;
