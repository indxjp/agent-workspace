import { afterAll } from 'vitest';
import {
  createInMemoryWorkspaceScopeResolver,
  type WorkspaceScopeResolver,
} from '@agent-workspace/core/db';
import {
  createDatabaseResourceCatalogRepositoryProvider,
  createDatabaseWorkspaceScopeResolver,
  createIsolatedTestDatabase,
  memberships,
  users,
  workspacePrincipals,
  workspaces,
  type IsolatedTestDatabase,
} from '@agent-workspace/core/db/unscoped';
import { generatedBody } from '../../../../tests/load/flat-memory';
import {
  createResourceCatalogStoreProvider,
  type ResourceCatalogStoreProvider,
} from '../storage/store';
import { createInMemoryCatalogStore } from '../resources/catalog-store.memory';

export interface World {
  readonly catalogs: ResourceCatalogStoreProvider;
  readonly scopes: WorkspaceScopeResolver;
  readonly workspaceId: string;
  readonly principalId: string;
}

export const noLog = { info() {}, warn() {}, error() {}, child: () => noLog };

export const bytesOf = (text: string): Uint8Array => new TextEncoder().encode(text);

export const SKILL_MD = '---\nname: pricing\ndescription: Prices.\n---\n\nQuote.\n';

export type Content =
  Uint8Array | { readonly stream: ReadableStream<Uint8Array>; readonly size: number };

export interface PartSpec {
  readonly name: string;
  readonly filename?: string;
  readonly content: Content;
}

export function multipart(parts: readonly PartSpec[]): {
  body: ReadableStream<Uint8Array>;
  contentType: string;
  length: number;
} {
  const boundary = 'skill-test-boundary';
  const segments: Content[] = [];
  for (const part of parts) {
    const file = part.filename === undefined ? '' : `; filename="${part.filename}"`;
    segments.push(
      bytesOf(
        `--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"${file}\r\n\r\n`,
      ),
      part.content,
      bytesOf('\r\n'),
    );
  }
  segments.push(bytesOf(`--${boundary}--\r\n`));
  const length = segments.reduce(
    (sum, s) => sum + (s instanceof Uint8Array ? s.byteLength : s.size),
    0,
  );
  let index = 0;
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      for (;;) {
        const segment = segments[index];
        if (segment === undefined) return controller.close();
        if (segment instanceof Uint8Array) {
          index += 1;
          return controller.enqueue(segment);
        }
        reader ??= segment.stream.getReader();
        const { done, value } = await reader.read();
        if (!done) return controller.enqueue(value);
        reader = null;
        index += 1;
      }
    },
  });
  return { body, contentType: `multipart/form-data; boundary=${boundary}`, length };
}

export const skillMdPart = (text = SKILL_MD): PartSpec => ({
  name: 'file',
  filename: 'SKILL.md',
  content: bytesOf(text),
});

export const namePart = (name = 'pricing'): PartSpec => ({ name: 'name', content: bytesOf(name) });

export const filePart = (filename: string, text = 'x'): PartSpec => ({
  name: 'file',
  filename,
  content: bytesOf(text),
});

export const bigPart = (source: ReturnType<typeof generatedBody>, size: number): PartSpec => ({
  name: 'file',
  filename: 'data/table.bin',
  content: { stream: source.body, size },
});

export const codeOf = async (response: Response): Promise<string> =>
  ((await response.json()) as { error: { code: string } }).error.code;

export function memoryWorld(): Promise<World> {
  const workspaceId = crypto.randomUUID();
  return Promise.resolve({
    catalogs: createInMemoryCatalogStore(),
    scopes: createInMemoryWorkspaceScopeResolver([{ id: workspaceId, slug: 'acme' }]),
    workspaceId,
    principalId: crypto.randomUUID(),
  });
}

export let isolated: IsolatedTestDatabase | undefined;

export async function postgresWorld(): Promise<World> {
  if (isolated === undefined) throw new Error('the test database did not start');
  const db = isolated.db;
  const [workspaceId, userId, membershipId, principalId] = [1, 2, 3, 4].map(() =>
    crypto.randomUUID(),
  ) as [string, string, string, string];
  await db.insert(workspaces).values({ id: workspaceId, slug: `s-${workspaceId}`, name: 'skills' });
  await db.insert(users).values({ id: userId, email: `${userId}@example.test`, name: 'Member' });
  await db.transaction(async (tx) => {
    await tx.insert(memberships).values({ id: membershipId, workspaceId, userId, role: 'owner' });
    await tx
      .insert(workspacePrincipals)
      .values({ id: principalId, workspaceId, kind: 'membership', membershipId });
  });
  const scopes = createDatabaseWorkspaceScopeResolver(db);
  return {
    catalogs: createResourceCatalogStoreProvider({
      repositories: createDatabaseResourceCatalogRepositoryProvider(db),
      scopes,
    }),
    scopes,
    workspaceId,
    principalId,
  };
}

export async function startFixtureDatabase(databaseUrl: string | undefined) {
  const url = databaseUrl?.trim();
  if (!url) throw new Error('TEST_DATABASE_URL is not set; run this suite through `pnpm test`.');
  isolated = await createIsolatedTestDatabase('aw_skills_multipart_import');
}

afterAll(async () => isolated?.close());
