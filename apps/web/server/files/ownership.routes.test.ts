/**
 * Builder own/other on the files routes over the in-memory catalog. Harness:
 * `routes.test-support.ts`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { bytesToStream } from '@agent-workspace/core/storage';
import { installTestDomains } from '../application-context-fixtures';
import { clearApplicationContext } from '../application-context';
import { createMemoryDirectory } from '../rbac/memory-directory';
import { Principal } from '../rbac/principal';
import { createInMemoryCatalogStore } from '../resources/catalog-store.memory';
import type { CatalogFilesWorld } from './catalog-runtime-fixtures';
import {
  ACTOR_HEADER,
  WORKSPACE_A,
  download,
  installSingleWorkspaceWorld,
  upload,
} from './routes.test-support';

afterEach(() => {
  clearApplicationContext();
});

/**
 * FX-1: the same own/other gate as the PostgreSQL suite (`ownership.postgres.routes.test.ts`), on
 * the shared in-memory catalog, for the two writes that suite does not cover — the relay upload
 * (`POST /api/files`) over another member's file, and a recursive delete of an owned folder holding
 * an object with no catalog row (what a signed upload leaves until the next list). Both must answer
 * a plain 403.
 */
describe('Builder own/other on the relay upload and on row-less objects (FX-1)', () => {
  const builderA = 'builder-a@example.test';
  const principalIds = new Map([
    [builderA, crypto.randomUUID()],
    ['builder-b@example.test', crypto.randomUUID()],
  ]);
  let catalogs: ReturnType<typeof createInMemoryCatalogStore>;
  let world: CatalogFilesWorld;

  beforeEach(() => {
    catalogs = createInMemoryCatalogStore();
    world = installSingleWorkspaceWorld({ catalogs });
    installTestDomains({
      rbac: {
        directory: createMemoryDirectory({
          users: [
            {
              email: 'owner-a@example.test',
              name: 'Owner A',
              workspaceId: WORKSPACE_A,
              role: 'owner',
            },
          ],
        }),
        identify(request: Request) {
          const actor = request.headers.get(ACTOR_HEADER) ?? '';
          const principalId = principalIds.get(actor);
          return Promise.resolve(
            principalId === undefined
              ? null
              : Principal.fromApiKey({
                  principalId,
                  apiKeyId: principalId,
                  workspaceId: WORKSPACE_A,
                  role: 'builder',
                  label: actor,
                }),
          );
        },
      },
    });
  });

  const uploadAs = (actor: string, filePath: string, text: string): Promise<Response> =>
    upload(filePath, text, { actor, contentType: 'text/plain' });

  async function contentOf(filePath: string): Promise<string> {
    const response = await download(filePath, { actor: builderA });
    expect(response.status).toBe(200);
    return response.text();
  }

  it("a Builder cannot overwrite another Builder's file through POST /api/files", async () => {
    expect((await uploadAs(builderA, 'shared.txt', 'A bytes')).status).toBe(201);

    const overwrite = await uploadAs('builder-b@example.test', 'shared.txt', 'B bytes');

    expect(overwrite.status).toBe(403);
    expect(await contentOf('shared.txt')).toBe('A bytes');
    // The owner may still overwrite its own file.
    expect((await uploadAs(builderA, 'shared.txt', 'A again')).status).toBe(201);
  });

  /** Save `text` at `path` as `actor` through the service, as a concurrent request would. */
  async function saveAs(actor: string, path: string, text: string): Promise<void> {
    const principalId = principalIds.get(actor) ?? '';
    const saved = await world.storage.save(
      { workspaceId: WORKSPACE_A, principalId, userId: null },
      {
        area: 'files',
        path,
        body: bytesToStream(new TextEncoder().encode(text)),
        maxBytes: 1024,
        replace: true,
      },
    );
    if (!saved.ok) throw new Error(`save refused: ${saved.code}`);
  }

  /** Run `around` around the next reserve of `path`, the step after the route's ownership check. */
  function aroundReserve(path: string, around: (reserve: () => Promise<unknown>) => Promise<void>) {
    const repository = catalogs.forWorkspaceSync(WORKSPACE_A);
    const reserve = repository.reserve.bind(repository);
    repository.reserve = async (reserved, input) => {
      if (reserved !== path) return reserve(reserved, input);
      repository.reserve = reserve;
      let outcome: Awaited<ReturnType<typeof reserve>> | undefined;
      await around(async () => (outcome = await reserve(reserved, input)));
      if (outcome === undefined) throw new Error('the reserve did not run');
      return outcome;
    };
    return repository;
  }

  it('a Builder cannot replace a file another Builder creates after the ownership check', async () => {
    aroundReserve('race.txt', async (reserve) => {
      await saveAs('builder-b@example.test', 'race.txt', 'B bytes');
      await reserve();
    });

    const overwrite = await uploadAs(builderA, 'race.txt', 'A bytes');

    expect(overwrite.status).toBe(403);
    expect(await contentOf('race.txt')).toBe('B bytes');
  });
});
