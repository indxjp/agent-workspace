/**
 * `POST /api/skills` as `multipart/form-data` (the storage design, §07 US-STO-08): each file part
 * streams into the catalog service, a refused import leaves no row and no object, and the JSON +
 * base64 body still works with a `Deprecation` header. Driven with real `Request` objects on the
 * in-memory catalog and on PostgreSQL.
 */
// @story US-STO-08
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { POST as importRoute } from '../../app/api/skills/route';
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
import {
  createInMemoryObjectStore,
  createInMemoryObjectStoreProvider,
  type ObjectStoreV2,
} from '@agent-workspace/core/storage';
import { MAX_SKILL_REQUEST_BODY_BYTES } from '@indx-workspace/contracts/skills';
import { createClient } from '@indx-workspace/sdk';

import {
  generatedBody,
  MiB,
  peakRssGrowth,
  warmHttpTransport,
} from '../../../../tests/load/flat-memory';
import { clearApplicationContext } from '../application-context';
import { installTestDomains } from '../application-context-fixtures';
import { createMemoryDirectory } from '../rbac/memory-directory';
import { Principal } from '../rbac/principal';
import {
  createResourceCatalogStoreProvider,
  type ResourceCatalogStoreProvider,
} from '../resources/catalog-store';
import { createInMemoryCatalogStore } from '../resources/catalog-store.memory';
import { createStorageService } from '../storage/service';
import { MultipartReader, multipartBoundary, SkillMultipartRefused } from './multipart';
import { createRepositorySkillsStoreProvider } from '../storage/store';

interface World {
  readonly catalogs: ResourceCatalogStoreProvider;
  readonly scopes: WorkspaceScopeResolver;
  readonly workspaceId: string;
  readonly principalId: string;
}

const noLog = { info() {}, warn() {}, error() {}, child: () => noLog };
const bytesOf = (text: string): Uint8Array => new TextEncoder().encode(text);
const SKILL_MD = '---\nname: pricing\ndescription: Prices.\n---\n\nQuote.\n';

/** A body made of fixed bytes and lazily read streams, so a 15 MiB part is never held whole. */
type Content = Uint8Array | { readonly stream: ReadableStream<Uint8Array>; readonly size: number };
interface PartSpec {
  readonly name: string;
  readonly filename?: string;
  readonly content: Content;
}

function multipart(parts: readonly PartSpec[]): {
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

const skillMdPart = (text = SKILL_MD): PartSpec => ({
  name: 'file',
  filename: 'SKILL.md',
  content: bytesOf(text),
});
const namePart = (name = 'pricing'): PartSpec => ({ name: 'name', content: bytesOf(name) });
const filePart = (filename: string, text = 'x'): PartSpec => ({
  name: 'file',
  filename,
  content: bytesOf(text),
});

const bigPart = (source: ReturnType<typeof generatedBody>, size: number): PartSpec => ({
  name: 'file',
  filename: 'data/table.bin',
  content: { stream: source.body, size },
});

const codeOf = async (response: Response): Promise<string> =>
  ((await response.json()) as { error: { code: string } }).error.code;

function memoryWorld(): Promise<World> {
  const workspaceId = crypto.randomUUID();
  return Promise.resolve({
    catalogs: createInMemoryCatalogStore(),
    scopes: createInMemoryWorkspaceScopeResolver([{ id: workspaceId, slug: 'acme' }]),
    workspaceId,
    principalId: crypto.randomUUID(),
  });
}

let isolated: IsolatedTestDatabase | undefined;

async function postgresWorld(): Promise<World> {
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

beforeAll(async () => {
  const url = process.env['TEST_DATABASE_URL']?.trim();
  if (!url) throw new Error('TEST_DATABASE_URL is not set; run this suite through `pnpm test`.');
  isolated = await createIsolatedTestDatabase('aw_skills_multipart_import');
}, 180_000);

afterAll(async () => isolated?.close());

afterEach(() => {
  clearApplicationContext();
});

// The memory phase runs first, before other tests hold large bodies in this process; its negative
// control is `multipart-buffering-control.test.ts`.
function defineSuite(name: string, setup: () => Promise<World>, phase: 'memory' | 'behaviour') {
  describe(`multipart skill import on the ${name} (${phase})`, () => {
    let world: World;
    let objects: ObjectStoreV2;
    let storage: ReturnType<typeof createStorageService>;

    function install(root: ObjectStoreV2): void {
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
      expect(await objects.listPrefix(`workspaces/${world.workspaceId}`)).toEqual([]);
    };

    // @story US-STO-08
    it('[US-STO-08][api][sdk] a 15 MiB multipart body streams in bounded memory', async () => {
      const size = 15 * MiB;
      const inner = createInMemoryObjectStore();
      let sample: () => void = () => undefined;
      // Keeps a small object (SKILL.md) and drains a large one, so the window reads the route and
      // the service, not the test's own store.
      install({
        ...inner,
        write: async (key, body, options) => {
          if (body instanceof Uint8Array) return inner.write(key, body, options);
          const kept: Uint8Array[] = [];
          let seen = 0;
          for await (const chunk of body) {
            const before = seen;
            seen += chunk.byteLength;
            if (seen <= 64 * 1024) kept.push(new Uint8Array(chunk));
            if (Math.floor(seen / (4 * MiB)) > Math.floor(before / (4 * MiB))) sample();
          }
          if (seen <= 64 * 1024) return inner.write(key, Buffer.concat(kept), options);
          return { sizeBytes: seen, contentType: null, etag: 'drained', lastModified: new Date() };
        },
      });

      // Built before the baseline: the generator's ring is the source, not the route.
      const source = generatedBody(size);
      const sent = multipart([namePart(), skillMdPart(), bigPart(source, size)]);
      await warmHttpTransport();
      const streamed = await peakRssGrowth(async (sampled) => {
        sample = sampled;
        const response = await post(sent);
        expect(response.status, await response.clone().text()).toBe(201);
      });
      expect(streamed).toBeLessThan(2 * size);
      expect(await (await catalog()).get('.skills/pricing/data/table.bin')).toMatchObject({
        sizeBytes: size,
        sha256: await source.sha256,
      });
    }, 120_000);
    if (phase === 'memory') return;

    // @story US-STO-08
    it('[US-STO-08][api][sdk] 15 MiB skill imports as multipart', async () => {
      const size = 15 * MiB;
      const bytes = new Uint8Array(size);
      for (let at = 0; at < size; at += 1) bytes[at] = (at * 31) % 251;
      let contentType: string | null = null;
      const client = createClient({
        baseUrl: 'https://example.invalid',
        auth: { kind: 'api-key', apiKey: 'ak_live_k' },
        // The SDK's own request, handed to the real route handler.
        fetch: (input, init) => {
          const request = new Request(input, init);
          contentType = request.headers.get('content-type');
          return importRoute(request);
        },
      });
      const skill = await client.skills.import({
        name: 'pricing',
        files: [
          { path: 'data/table.bin', body: new Blob([bytes]) },
          { path: 'SKILL.md', body: SKILL_MD },
        ],
      });
      expect(contentType).toMatch(/^multipart\/form-data; boundary=/u);
      expect(skill.name).toBe('pricing');
      expect(skill.files.map((file) => file.path)).toEqual(['SKILL.md', 'data/table.bin']);
      expect(await (await catalog()).get('.skills/pricing/data/table.bin')).toMatchObject({
        sizeBytes: size,
      });
    }, 120_000);

    // @story US-STO-08
    it('[US-STO-08][api][sdk] each file part is one row and the response lists them', async () => {
      const response = await postParts([
        namePart(),
        skillMdPart(),
        filePart('scripts/run.sh', '#!/bin/sh\n'),
        filePart('data/a.txt', 'alpha'),
      ]);
      expect(response.status, await response.clone().text()).toBe(201);
      expect(response.headers.get('deprecation')).toBeNull();
      const { skill } = (await response.json()) as {
        skill: { id: string; name: string; files: { path: string }[] };
      };
      expect(skill.name).toBe('pricing');
      expect(skill.files.map((file) => file.path)).toEqual([
        'SKILL.md',
        'data/a.txt',
        'scripts/run.sh',
      ]);
      const listed = await (await catalog()).listSkills();
      expect(listed.map((row) => [row.name, row.id])).toEqual([['pricing', skill.id]]);
      expect(await rowTexts('.skills/pricing')).toEqual({
        '.skills/pricing/SKILL.md': SKILL_MD,
        '.skills/pricing/data/a.txt': 'alpha',
        '.skills/pricing/scripts/run.sh': '#!/bin/sh\n',
      });
    });

    // @story US-STO-08
    it('[US-STO-08][api][sdk] a body over the limit answers 413 and saves nothing', async () => {
      const declared = await postParts([namePart(), skillMdPart()], {
        'content-length': String(MAX_SKILL_REQUEST_BODY_BYTES + 1),
      });
      expect(declared.status).toBe(413);
      await expectNothingSaved();

      // No Content-Length: the running total across parts stops it, the byte after the limit.
      const overhead = multipart([namePart(), skillMdPart(), bigPart(generatedBody(0), 0)]).length;
      const over = MAX_SKILL_REQUEST_BODY_BYTES - overhead + 1;
      const counted = await postParts([
        namePart(),
        skillMdPart(),
        bigPart(generatedBody(over), over),
      ]);
      expect(counted.status, await counted.clone().text()).toBe(413);
      expect(await codeOf(counted)).toBe('request_body_too_large');
      await expectNothingSaved();

      // One byte fewer fits, and the refused import released the name.
      const fits = over - 1;
      const accepted = await postParts([
        namePart(),
        skillMdPart(),
        bigPart(generatedBody(fits), fits),
      ]);
      expect(accepted.status, await accepted.clone().text()).toBe(201);
    }, 120_000);

    // @story US-STO-08
    it('[US-STO-08][api][sdk] a bad, repeated or colliding path leaves nothing saved', async () => {
      const cases: [PartSpec[], number, string][] = [
        [[filePart('ok.txt'), filePart('../evil.txt')], 400, 'inadmissible_path'],
        [[filePart('ok.txt'), filePart('/abs.txt')], 400, 'inadmissible_path'],
        [[filePart('ok.txt'), filePart('ok.txt')], 400, 'duplicate_path'],
        [[filePart('SKILL.md')], 400, 'duplicate_path'],
        [[filePart('Doc.txt'), filePart('doc.txt')], 409, 'colliding_paths'],
        [[{ name: 'file', content: bytesOf('x') }], 400, 'malformed_file_entry'],
        [
          [{ name: 'extra', filename: 'a.txt', content: bytesOf('x') }],
          400,
          'malformed_file_entry',
        ],
      ];
      for (const [parts, status, code] of cases) {
        const response = await postParts([namePart(), skillMdPart(), ...parts]);
        expect([response.status, await codeOf(response)]).toEqual([status, code]);
        await expectNothingSaved();
      }
    });

    // @story US-STO-08
    it('[US-STO-08][api][sdk] a refused head or a cut-off body leaves nothing saved', async () => {
      const invalidUtf8: PartSpec = {
        ...skillMdPart(),
        content: new Uint8Array([0xff, 0xfe, 0x41]),
      };
      const cases: [PartSpec[], number, string][] = [
        [[skillMdPart()], 400, 'missing_name'],
        [[namePart(''), skillMdPart()], 400, 'missing_name'],
        [[namePart('Not Valid'), skillMdPart()], 400, 'invalid_name'],
        [[namePart('a'.repeat(2000)), skillMdPart()], 400, 'invalid_name'],
        [[namePart(), filePart('a.txt')], 400, 'missing_skill_md'],
        [[namePart()], 400, 'missing_skill_md'],
        [[namePart(), invalidUtf8], 400, 'malformed_content'],
        [[namePart(), { ...skillMdPart(), content: bytesOf('  \n') }], 400, 'malformed_content'],
      ];
      for (const [parts, status, code] of cases) {
        const response = await postParts(parts);
        expect([response.status, await codeOf(response)]).toEqual([status, code]);
        await expectNothingSaved();
      }

      // Cut off after a file started: the stream fails mid-save, and the row and object go.
      const whole = multipart([namePart(), skillMdPart(), filePart('a.txt', 'abcdef')]);
      const bytes = new Uint8Array(await new Response(whole.body).arrayBuffer());
      const cut = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes.subarray(0, bytes.length - 20));
          controller.close();
        },
      });
      const response = await post({ body: cut, contentType: whole.contentType });
      expect([response.status, await codeOf(response)]).toEqual([400, 'malformed_body']);
      await expectNothingSaved();
    });

    // @story US-STO-08
    it('[US-STO-08][api][sdk] a name already taken answers 409 and keeps the first skill', async () => {
      expect((await postParts([namePart(), skillMdPart(), filePart('a.txt', 'one')])).status).toBe(
        201,
      );
      const before = await rowTexts('.skills/pricing');
      const again = await postParts([namePart(), skillMdPart(), filePart('a.txt', 'two')]);
      expect([again.status, await codeOf(again)]).toEqual([409, 'skill_already_exists']);
      expect(await rowTexts('.skills/pricing')).toEqual(before);
    });

    // @story US-STO-08
    it('[US-STO-08][api][sdk] a failed save releases the name and removes what was saved', async () => {
      const inner = createInMemoryObjectStore();
      let streams = 0;
      install({
        ...inner,
        write: (key, body, options) => {
          if ((streams += 1) < 3) return inner.write(key, body, options);
          return Promise.reject(new Error('object store down'));
        },
      });
      const parts = [namePart(), skillMdPart(), filePart('a.txt', 'a'), filePart('b.txt', 'b')];
      const outcome = await postParts(parts).then(
        (response) => response.status,
        () => 'threw',
      );
      expect(outcome).not.toBe(201);
      await expectNothingSaved();
    });

    // @story US-STO-08
    it('[US-STO-08][api][sdk] the JSON body still imports, with a Deprecation header', async () => {
      const json = JSON.stringify({
        name: 'pricing',
        files: [{ path: 'SKILL.md', contentBase64: Buffer.from(SKILL_MD).toString('base64') }],
      });
      const response = await post({ body: json, contentType: 'application/json' });
      expect(response.status, await response.clone().text()).toBe(201);
      expect(response.headers.get('deprecation')).toBe('@1792800000');

      const refused = await post({ body: 'x', contentType: 'text/plain' });
      expect(refused.status).toBe(415);
      expect(await refused.clone().json()).toEqual({
        error: {
          code: 'unsupported_media_type',
          message: 'This route accepts multipart/form-data or application/json.',
        },
      });
      expect(refused.headers.get('deprecation')).toBeNull();
    });
  });
}

defineSuite('in-memory catalog', memoryWorld, 'memory');
defineSuite('PostgreSQL catalog', postgresWorld, 'memory');

defineSuite('in-memory catalog', memoryWorld, 'behaviour');
defineSuite('PostgreSQL catalog', postgresWorld, 'behaviour');

function readerOver(bytes: Uint8Array, chunkSize: number): MultipartReader {
  let at = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (at >= bytes.length) return controller.close();
      controller.enqueue(bytes.slice(at, at + chunkSize));
      at += chunkSize;
    },
  });
  return new MultipartReader(body, 'skill-test-boundary', MAX_SKILL_REQUEST_BODY_BYTES);
}

const must = <T>(value: T | null): T => {
  if (value === null) throw new Error('expected a value');
  return value;
};

const bytesOfBody = async (body: ReadableStream<Uint8Array>): Promise<Uint8Array> =>
  new Uint8Array(await new Response(body).arrayBuffer());

describe('multipart reader', () => {
  // @story US-STO-08
  it('[US-STO-08][unit][sdk] reads parts split at any byte and skips a part left unread', async () => {
    // Content that starts like a delimiter and is not one must come through whole.
    const tricky = 'a\r\n--skill-test-boun\r\n--\r\nb';
    const sent = multipart([namePart(), filePart('a.txt', tricky), filePart('b.txt', 'last')]);
    const whole = Buffer.concat([
      bytesOf('preamble\r\n'),
      await bytesOfBody(sent.body),
      bytesOf('epilogue'),
    ]);
    for (const chunkSize of [1, 7, 4096]) {
      const reader = readerOver(whole, chunkSize);
      expect((await reader.next())?.name).toBe('name');
      const second = must(await reader.next());
      expect([second.name, second.filename]).toEqual(['file', 'a.txt']);
      expect(new TextDecoder().decode(await bytesOfBody(second.body))).toBe(tricky);
      expect((await reader.next())?.filename).toBe('b.txt');
      expect(await reader.next()).toBeNull();
    }
  });

  // @story US-STO-08
  it('[US-STO-08][unit][sdk] a body that ends inside a part fails the part stream and is remembered', async () => {
    const head = '--skill-test-boundary\r\nContent-Disposition: form-data; name="name"\r\n\r\nabc';
    const reader = readerOver(bytesOf(head), 5);
    const part = must(await reader.next());
    await expect(bytesOfBody(part.body)).rejects.toBeInstanceOf(SkillMultipartRefused);
    expect(reader.refusal?.status).toBe(400);
  });

  // @story US-STO-08
  it('[US-STO-08][unit][sdk] refuses a part header over the cap even when it arrives in one chunk', async () => {
    const head = `--skill-test-boundary\r\nContent-Disposition: form-data; name="name"\r\nX-Pad: ${'a'.repeat(9000)}\r\n\r\nabc`;
    const reader = readerOver(bytesOf(head), 64 * 1024);
    await expect(reader.next()).rejects.toBeInstanceOf(SkillMultipartRefused);
    expect(reader.refusal?.status).toBe(400);
  });

  // @story US-STO-08
  it('[US-STO-08][unit][sdk] finds the boundary parameter, quoted or not, up to 70 characters', () => {
    expect(multipartBoundary('multipart/form-data; boundary=abc')).toBe('abc');
    expect(multipartBoundary('multipart/form-data; charset=utf-8; boundary="a b"')).toBe('a b');
    expect(multipartBoundary('multipart/form-data')).toBeNull();
    expect(multipartBoundary(`multipart/form-data; boundary=${'a'.repeat(71)}`)).toBeNull();
  });
});
