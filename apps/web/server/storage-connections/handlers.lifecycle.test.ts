/**
 * The storage-connection lifecycle (change, rotate, delete, browse and test), driven through the
 * routes over the in-memory repository and over PostgreSQL (the storage design, §05 and §06
 * Phase 5).
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { IncomingMessage } from 'node:http';
import { Socket } from 'node:net';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { S3Client } from '@aws-sdk/client-s3';
import { normalizeCdnUrl } from 'next/dist/server/server-utils';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  StorageConnectionBrowseResponseSchema,
  StorageConnectionResourceSchema,
  StorageConnectionTestOutcomeSchema,
} from '@indx-workspace/contracts/storage-connections';
import {
  createDatabaseStorageConnectionRepositoryProvider,
  createDatabaseWorkspaceScopeResolver,
  createIsolatedTestDatabase,
  workspaces,
  type IsolatedTestDatabase,
} from '@agent-workspace/core/db/unscoped';
import { openConnectionStore } from '@agent-workspace/core/storage';

import { GET as getOne } from '../../app/api/storage-connections/[id]/route';
import {
  ACTOR,
  accessKeyId,
  audits,
  body,
  change,
  connect,
  expectAudit,
  expectError,
  fileRoot,
  granted,
  installRuntime,
  reach,
  read,
  secretAccessKey,
  storedCredential,
  useStorageConnectionRoutes,
  WORKSPACE_A,
  WORKSPACE_B,
} from './handlers.test-support';

useStorageConnectionRoutes();

// Built at runtime, like the first credential.
const rotatedAccessKeyId = ['AK', 'IA'].join('') + randomUUID().replaceAll('-', '').slice(0, 16);
const rotatedSecretAccessKey = randomBytes(24).toString('base64');
// A temporary (STS) credential: its session token is as secret as the key.
const rotatedSessionToken = randomBytes(32).toString('base64');
const rotated = {
  provider: 's3',
  accessKeyId: rotatedAccessKeyId,
  secretAccessKey: rotatedSecretAccessKey,
  sessionToken: rotatedSessionToken,
};
const credentialValues = [
  accessKeyId,
  secretAccessKey,
  rotatedAccessKeyId,
  rotatedSecretAccessKey,
  rotatedSessionToken,
];

function expectNoCredential(text: string): void {
  for (const value of credentialValues) expect(text).not.toContain(value);
}

function readOne(id: string): Promise<Response> {
  return getOne(read(`/${id}`), { params: Promise.resolve({ id }) });
}

/** Plain files at `<dir>/<key>`, as a user's own folder holds them. */
function seedFolder(dir: string, keys: readonly string[]): void {
  for (const key of keys) {
    mkdirSync(path.dirname(path.join(dir, key)), { recursive: true });
    writeFileSync(path.join(dir, key), key);
  }
}

/**
 * `query` as `next start` hands it to a route handler. Before the handler runs, Next rebuilds
 * `req.url`'s query from its parsed values (`normalizeCdnUrl`, called by the route module for
 * every request), so the handler never sees the bytes the client sent: `%20` arrives as `+`.
 */
function servedByNext(query: string): string {
  const message = new IncomingMessage(new Socket());
  message.url = `/browse${query}`;
  normalizeCdnUrl(message, []);
  return (message.url ?? '').slice('/browse'.length);
}

/** `browse` reached both as the bare handler is called and as `next start` serves it. */
async function browseBothWays(id: string, query: string): Promise<Response[]> {
  return [await reach('browse', id, query), await reach('browse', id, servedByNext(query))];
}

/** A `file` connection over a folder holding `reports/`, `reports-old/` and `secret/`. */
async function connectFolder(name: string): Promise<string> {
  const dir = path.join(fileRoot, name);
  mkdirSync(dir);
  seedFolder(dir, ['reports/a.txt', 'reports/2026/b.txt', 'reports-old/c.txt', 'secret/d.txt']);
  return connect({ name, url: pathToFileURL(dir).href, allowedPrefixes: ['reports'] });
}

async function browsedPaths(response: Response): Promise<string[]> {
  expect(response.status).toBe(200);
  const page = StorageConnectionBrowseResponseSchema.parse(await response.json());
  return page.entries.map((entry) => entry.path);
}

const testedAudits = () =>
  audits.filter((event) => event['action'] === 'storage-connection-tested');

describe.each(['memory', 'postgres'] as const)(
  'storage connection lifecycle over the %s repository',
  (kind) => {
    let isolated: IsolatedTestDatabase | undefined;

    // A missing TEST_DATABASE_URL makes this throw: the suite fails instead of skipping.
    beforeAll(async () => {
      if (kind !== 'postgres') return;
      isolated = await createIsolatedTestDatabase('aw_storage_lifecycle');
      await isolated.db.insert(workspaces).values([
        { id: WORKSPACE_A, slug: 'lifecycle-a', name: 'A' },
        { id: WORKSPACE_B, slug: 'lifecycle-b', name: 'B' },
      ]);
    }, 180_000);

    afterAll(async () => {
      await isolated?.close();
    });

    beforeEach(() => {
      if (isolated === undefined) return;
      installRuntime(
        createDatabaseStorageConnectionRepositoryProvider(isolated.db),
        createDatabaseWorkspaceScopeResolver(isolated.db),
      );
    });

    describe('PATCH/PUT/DELETE', () => {
      // @story US-STO-12
      it('[US-STO-12][api][sdk] an admin renames a connection and narrows its folders', async () => {
        const id = await connect({ ...body, name: `rename-${kind}` });
        const response = await change('PATCH', id, {
          name: `renamed-${kind}`,
          url: 's3://acme-other/exports',
          allowedPrefixes: ['reports/2026'],
          writeAllowed: true,
          credential: rotated,
        });
        expect(response.status).toBe(200);
        expect(StorageConnectionResourceSchema.parse(await response.json())).toMatchObject({
          id,
          name: `renamed-${kind}`,
          url: 's3://acme-other/exports',
          allowedPrefixes: ['reports/2026'],
          writeAllowed: true,
          hasCredential: true,
        });
        expect(await storedCredential(id)).toEqual(rotated);
        expectAudit('storage-connection-updated', id, `renamed-${kind}`);
      });

      // @story US-STO-12
      it('[US-STO-12][api][sdk] the stored credential never follows a connection to another endpoint, account or bucket', async () => {
        const id = await connect({ ...body, name: `pinned-${kind}` });
        const before: unknown = await (await readOne(id)).json();
        const moves = [
          's3://acme-data/exports?endpoint=https://attacker.example',
          's3://acme-data/exports?endpoint=https://s3.eu-west-1.amazonaws.com&publicEndpoint=https://attacker.example',
          's3://acme-data/exports',
          's3://acme-other/exports?endpoint=https://s3.eu-west-1.amazonaws.com',
        ];
        for (const url of moves) {
          const response = await change('PATCH', id, { url, allowedPrefixes: ['other'] });
          await expectError(response, 409, 'storage_connection_credential_required');
        }
        const mismatch = await change('PATCH', id, {
          url: moves[0],
          credential: { provider: 'gcs', serviceAccountJson: '{}' },
        });
        expect(mismatch.status).toBe(422);
        expect(await (await readOne(id)).json()).toEqual(before);
        expect(await storedCredential(id)).toEqual(body.credential);
        expect(audits).toHaveLength(1);

        const moved = await change('PATCH', id, { url: moves[0], credential: rotated });
        expect(moved.status).toBe(200);
        const text = await moved.text();
        expect(StorageConnectionResourceSchema.parse(JSON.parse(text))).toMatchObject({
          url: moves[0],
          hasCredential: true,
        });
        expect(await storedCredential(id)).toEqual(rotated);
        expectNoCredential(text);
      });

      // @story US-STO-12
      it('[US-STO-12][api][sdk] a prefix, name or write change keeps the stored credential', async () => {
        const id = await connect({ ...body, name: `kept-${kind}` });
        const response = await change('PATCH', id, {
          name: `kept-renamed-${kind}`,
          url: 's3://acme-data/archive?endpoint=https://s3.eu-west-1.amazonaws.com',
          allowedPrefixes: ['archive/2026'],
          writeAllowed: true,
        });
        expect(response.status).toBe(200);
        expect(StorageConnectionResourceSchema.parse(await response.json())).toMatchObject({
          url: 's3://acme-data/archive?endpoint=https://s3.eu-west-1.amazonaws.com',
          hasCredential: true,
        });
        expect(await storedCredential(id)).toEqual(body.credential);
      });

      // @story US-STO-12
      it('[US-STO-12][api][sdk] a patch is refused for a taken name, another provider or a URL with a secret', async () => {
        const id = await connect({ ...body, name: `patched-${kind}` });
        await connect({ ...body, name: `taken-${kind}` });
        const refused = [
          [{ name: `taken-${kind}` }, 409, 'storage_connection_name_taken'],
          [{ url: 'gcs://acme-bucket/exports' }, 422, 'storage_connection_url_invalid'],
          [
            { url: pathToFileURL(path.join(fileRoot, 'shared')).href },
            422,
            'storage_connection_url_invalid',
          ],
          [{ url: 's3://acme-data@host/x' }, 422, 'storage_connection_url_has_secret'],
          [{}, 400, 'invalid_storage_connection'],
        ] as const;
        for (const [patchBody, status, code] of refused) {
          await expectError(await change('PATCH', id, patchBody), status, code);
        }
        expect(audits).toHaveLength(2);
      });

      // @story US-STO-12
      it('[US-STO-12][api][sdk] a member cannot change, rotate or delete a connection', async () => {
        const id = await connect({ ...body, name: `guarded-${kind}` });
        const builder = { role: 'builder' } as const;
        expect((await change('PATCH', id, { writeAllowed: true }, builder)).status).toBe(403);
        expect((await change('PUT', id, rotated, builder)).status).toBe(403);
        expect((await change('DELETE', id, undefined, builder)).status).toBe(403);
        expect((await change('DELETE', id, undefined, { role: 'viewer' })).status).toBe(403);
        expect(await storedCredential(id)).toEqual(body.credential);
        expect(audits).toHaveLength(1);
      });

      // @story US-STO-12
      it('[US-STO-12][api][sdk] rotating the credential replaces the secret and never returns it', async () => {
        const id = await connect({ ...body, name: `rotated-${kind}` });
        const response = await change('PUT', id, rotated);
        expect(response.status).toBe(200);
        const text = await response.text();
        expect(StorageConnectionResourceSchema.parse(JSON.parse(text))).toMatchObject({
          id,
          hasCredential: true,
        });
        expect(await storedCredential(id)).toEqual(rotated);
        const mismatch = await change('PUT', id, { provider: 'gcs', serviceAccountJson: '{}' });
        expect(mismatch.status).toBe(422);
        expect(await storedCredential(id)).toEqual(rotated);
        expectNoCredential([text, JSON.stringify(audits)].join('\n'));
        expectAudit('storage-connection-credential-changed', id);
      });

      // @story US-STO-12
      it('[US-STO-12][api][sdk] rotating a connection created without a credential creates its secret', async () => {
        const id = await connect({ ...body, name: `bare-${kind}`, credential: undefined });
        expect(await storedCredential(id)).toBeNull();
        const response = await change('PUT', id, rotated);
        expect(response.status).toBe(200);
        expect(StorageConnectionResourceSchema.parse(await response.json())).toMatchObject({
          id,
          hasCredential: true,
        });
        expect(await storedCredential(id)).toEqual(rotated);
        expectAudit('storage-connection-credential-changed', id);
      });

      // @story US-STO-12
      it('[US-STO-12][api][sdk] deleting a connection removes its row and then its secret', async () => {
        const id = await connect({ ...body, name: `doomed-${kind}` });
        expect((await change('DELETE', id)).status).toBe(204);
        expect((await readOne(id)).status).toBe(404);
        expect(await storedCredential(id)).toBeNull();
        expect((await change('DELETE', id)).status).toBe(404);
        expectAudit('storage-connection-deleted', id, `doomed-${kind}`);
      });

      // @story US-STO-12
      it('[US-STO-12][api][sdk] a connection an agent version grants is not deleted', async () => {
        const id = await connect({ ...body, name: `granted-${kind}` });
        granted.add(`${WORKSPACE_A}/${id}`);
        await expectError(await change('DELETE', id), 409, 'storage_connection_in_use');
        expect((await readOne(id)).status).toBe(200);
        expect(await storedCredential(id)).toEqual(body.credential);
        expect(audits).toHaveLength(1);
        // Another workspace's grant of the same id does not hold this one.
        granted.clear();
        granted.add(`${WORKSPACE_B}/${id}`);
        expect((await change('DELETE', id)).status).toBe(204);
      });

      // @story US-STO-12
      it.each([
        ['PATCH', { writeAllowed: true }],
        ['PUT', rotated],
        ['DELETE', undefined],
      ] as const)(
        '[US-STO-12][api][sdk] another workspace gets 404 on %s and changes nothing',
        async (method, payload) => {
          const id = await connect({ ...body, name: `private-${method.toLowerCase()}-${kind}` });
          const response = await change(method, id, payload, {
            role: 'owner',
            workspace: WORKSPACE_B,
          });
          await expectError(response, 404, 'storage_connection_not_found');
          expect(
            StorageConnectionResourceSchema.parse(await (await readOne(id)).json()),
          ).toMatchObject({
            writeAllowed: false,
            hasCredential: true,
          });
          expect(await storedCredential(id)).toEqual(body.credential);
          expect(audits).toHaveLength(1);
        },
      );

      // @story US-STO-12
      it('[US-STO-12][api][sdk] no response or audit row of the lifecycle holds a credential', async () => {
        const id = await connect({ ...body, name: `clean-${kind}` });
        const texts = [
          await (await change('PATCH', id, { writeAllowed: true })).text(),
          await (await change('PUT', id, rotated)).text(),
          await (await change('PUT', id, { provider: 's3' })).text(),
          await (await change('PATCH', id, { url: 's3://acme-data@host/x' })).text(),
          await (await readOne(id)).text(),
          await (await change('DELETE', id)).text(),
          JSON.stringify(audits),
        ].join('\n');
        expectNoCredential(texts);
      });
    });

    describe('browse', () => {
      // @story US-STO-12
      it('[US-STO-12][api][sdk] a file:// connection lists and reads the files already in the folder', async () => {
        const id = await connectFolder(`ondisk-${kind}`);
        const response = await reach('browse', id, '?prefix=reports');
        expect(response.status).toBe(200);
        const page = StorageConnectionBrowseResponseSchema.parse(await response.json());
        expect(page.entries.map((entry) => entry.path)).toEqual(['reports/2026', 'reports/a.txt']);
        expect(page.entries.find((entry) => entry.path === 'reports/a.txt')).toMatchObject({
          size: 'reports/a.txt'.length,
        });
      });

      // @story US-STO-12
      it('[US-STO-12][api][sdk] folder names with a space list their files', async () => {
        const id = await connectFolder(`spaces-${kind}`);
        seedFolder(path.join(fileRoot, `spaces-${kind}`), ['reports/Q3 reports/n.txt']);
        expect(
          await browsedPaths(await reach('browse', id, '?prefix=reports%2FQ3%20reports')),
        ).toEqual(['reports/Q3 reports/n.txt']);
      });

      // @story US-STO-12
      it('[US-STO-12][api][sdk] browse is limited to allowed folders', async () => {
        const id = await connectFolder(`folders-${kind}`);
        expect(await browsedPaths(await reach('browse', id, '?prefix=reports'))).toEqual([
          'reports/2026',
          'reports/a.txt',
        ]);
        expect(await browsedPaths(await reach('browse', id, '?prefix=reports/'))).toEqual([
          'reports/2026',
          'reports/a.txt',
        ]);
        expect(await browsedPaths(await reach('browse', id, '?prefix=reports/2026'))).toEqual([
          'reports/2026/b.txt',
        ]);
        expect(await browsedPaths(await reach('browse', id))).toEqual(['reports']);

        const refused = [
          'reports-old',
          'secret',
          'reports/..',
          '..',
          '%2e%2e',
          'reports/%2e%2e',
          'reports%2F..%2Fsecret',
          '/reports',
          'reports//2026',
          // The prefix is decoded exactly once, then checked.
          'reports/%2e%2e/secret',
          '%2e',
          'reports%2f..%2fsecret',
          'reports%5c..',
          'reports%00',
          '%2freports',
          '%252e%252e',
          'reports/%252e%252e',
          '%E0%A4%A',
          'reports/%E0%A4%A',
        ];
        for (const prefix of refused) {
          for (const response of await browseBothWays(id, `?prefix=${prefix}`)) {
            expect(response.status, prefix).toBe(403);
            const text = await response.text();
            expect(JSON.parse(text), prefix).toMatchObject({
              error: { code: 'storage_connection_prefix_not_allowed' },
            });
            expect(text).not.toContain('d.txt');
          }
        }
        expect(audits).toHaveLength(1);
      });

      // @story US-STO-12
      it('[US-STO-12][api][sdk] a folder named with a space, an accent, a plus or an ampersand lists as the server serves it', async () => {
        const name = `names-${kind}`;
        const dir = path.join(fileRoot, name);
        mkdirSync(dir);
        // Through the store the product opens, so the seed lands wherever that store reads.
        const objects = await openConnectionStore(
          pathToFileURL(dir).href,
          { provider: 'file' },
          { writable: true, fileRoots: [fileRoot], egress: { production: false, allowHosts: [] } },
        );
        const keys = [
          'reports/Q3 drafts/z.txt',
          'reports/Q3+drafts/plus.txt',
          'reports/café/e.txt',
          'reports/a&b/amp.txt',
        ];
        for (const key of keys) await objects.write(key, new TextEncoder().encode(key), {});
        const id = await connect({
          name,
          url: pathToFileURL(dir).href,
          allowedPrefixes: ['reports'],
        });

        // What the SDK sends (`encodeURIComponent`), and the spellings a person types by hand.
        const listed: Record<string, string> = {
          'reports%2FQ3%20drafts': 'reports/Q3 drafts/z.txt',
          'reports/Q3%20drafts': 'reports/Q3 drafts/z.txt',
          'reports%2FQ3+drafts': 'reports/Q3 drafts/z.txt',
          'reports%2FQ3%2Bdrafts': 'reports/Q3+drafts/plus.txt',
          'reports%2Fcaf%C3%A9': 'reports/café/e.txt',
          'reports%2Fa%26b': 'reports/a&b/amp.txt',
        };
        for (const [prefix, file] of Object.entries(listed)) {
          for (const response of await browseBothWays(id, `?prefix=${prefix}`)) {
            expect(await browsedPaths(response), prefix).toEqual([file]);
          }
        }
      });

      // @story US-STO-12
      it('[US-STO-12][api][sdk] a tampered cursor never lists outside the prefix', async () => {
        const id = await connectFolder(`cursors-${kind}`);
        const cursors = [
          'file:../secret/d.txt',
          'file:secret/d.txt',
          'file:reports-old/c.txt',
          'folder:',
          'file:',
          'no-kind',
          'file:\u0000',
        ];
        for (const cursor of cursors) {
          const response = await reach(
            'browse',
            id,
            `?prefix=reports&cursor=${encodeURIComponent(cursor)}`,
          );
          for (const found of await browsedPaths(response)) {
            expect(found, cursor).toMatch(/^reports\//u);
          }
        }
      });
    });

    describe('test', () => {
      // @story US-STO-12
      it('[US-STO-12][api][sdk] a member can test and browse a connection, a viewer cannot', async () => {
        const id = await connectFolder(`readers-${kind}`);
        for (const role of ['owner', 'admin', 'builder'] as const) {
          expect((await reach('browse', id, '?prefix=reports', { role })).status, role).toBe(200);
          expect((await reach('test', id, '', { role })).status, role).toBe(200);
        }
        const viewer = { role: 'viewer' } as const;
        expect((await reach('browse', id, '?prefix=reports', viewer)).status).toBe(403);
        expect((await reach('test', id, '', viewer)).status).toBe(403);
        expect(testedAudits()).toHaveLength(3);
      });

      // @story US-STO-12
      it('[US-STO-12][api][sdk] another workspace gets 404 on test and browse', async () => {
        const id = await connectFolder(`hidden-${kind}`);
        const owner = { role: 'owner', workspace: WORKSPACE_B } as const;
        for (const target of [id, 'not-a-uuid', randomUUID()]) {
          for (const route of ['browse', 'test'] as const) {
            const response = await reach(route, target, '?prefix=reports', owner);
            expect(response.status, `${route} ${target}`).toBe(404);
            expect(await response.json()).toMatchObject({
              error: { code: 'storage_connection_not_found' },
            });
          }
        }
        expect(audits).toHaveLength(1);
      });

      // @story US-STO-12
      it('[US-STO-12][api][sdk] a test answers the outcome schema and is audited once', async () => {
        const id = await connectFolder(`tested-${kind}`);
        const ok = await reach('test', id);
        expect(StorageConnectionTestOutcomeSchema.parse(await ok.json())).toEqual({ ok: true });
        expect(testedAudits()).toEqual([
          expect.objectContaining({
            workspaceId: WORKSPACE_A,
            actorPrincipalId: ACTOR,
            subjectId: id,
            subjectLabel: `tested-${kind}`,
          }),
        ]);
        await reach('browse', id, '?prefix=reports');
        expect(testedAudits()).toHaveLength(1);

        // The folder is gone, so the operator's root no longer holds it.
        rmSync(path.join(fileRoot, `tested-${kind}`), { recursive: true });
        const gone = await reach('test', id);
        expect(StorageConnectionTestOutcomeSchema.parse(await gone.json())).toEqual({
          ok: false,
          code: 'forbidden',
        });
        const browsed = await reach('browse', id, '?prefix=reports');
        await expectError(browsed, 422, 'storage_connection_endpoint_forbidden');
        expect(testedAudits()).toHaveLength(2);
      });

      // @story US-STO-12
      it('[US-STO-12][api][sdk] a test names the allowed folders it found nothing in', async () => {
        const name = `empty-${kind}`;
        const dir = path.join(fileRoot, name);
        mkdirSync(dir);
        seedFolder(dir, ['reports/a.txt', 'deep/2026/b.txt']);
        mkdirSync(path.join(dir, 'blank'));
        const id = await connect({
          name,
          url: pathToFileURL(dir).href,
          allowedPrefixes: ['reports', 'missing', 'deep', 'blank', 'reports/a.txt/x'],
        });
        const tested = await reach('test', id);
        expect(StorageConnectionTestOutcomeSchema.parse(await tested.json())).toEqual({
          ok: true,
          emptyFolders: ['missing', 'blank', 'reports/a.txt/x'],
        });
        expect(testedAudits()).toHaveLength(1);
      });

      // @story US-STO-12
      it('[US-STO-12][api][sdk] test and browse refuse a private, loopback or link-local endpoint', async () => {
        // The S3 client sends over Node's http module, not `fetch`, so both transports are watched.
        const fetched = vi.spyOn(globalThis, 'fetch');
        const sent = vi.spyOn(S3Client.prototype, 'send');
        const endpoints = ['https://10.0.0.5', 'https://127.0.0.1:9000', 'https://169.254.169.254'];
        const seen: string[] = [];
        try {
          for (const [index, endpoint] of endpoints.entries()) {
            const id = await connect({
              ...body,
              name: `ssrf-${String(index)}-${kind}`,
              url: `s3://acme-data/exports?endpoint=${endpoint}`,
            });
            const tested = await reach('test', id);
            seen.push(await tested.clone().text());
            expect(StorageConnectionTestOutcomeSchema.parse(await tested.json())).toEqual({
              ok: false,
              code: 'forbidden',
            });
            const browsed = await reach('browse', id, '?prefix=reports');
            seen.push(await browsed.clone().text());
            expect(browsed.status, endpoint).toBe(422);
            expect(await browsed.json()).toMatchObject({
              error: { code: 'storage_connection_endpoint_forbidden' },
            });
          }
          expect(fetched).not.toHaveBeenCalled();
          expect(sent).not.toHaveBeenCalled();
        } finally {
          fetched.mockRestore();
          sent.mockRestore();
        }
        expectNoCredential([...seen, JSON.stringify(audits)].join('\n'));
      });

      // @story US-STO-12
      it('[US-STO-12][api][sdk] a connection with no stored credential is unreachable, not an error', async () => {
        const id = await connect({ ...body, name: `bare-test-${kind}`, credential: undefined });
        const tested = await reach('test', id);
        expect(StorageConnectionTestOutcomeSchema.parse(await tested.json())).toEqual({
          ok: false,
          code: 'unreachable',
        });
        const browsed = await reach('browse', id, '?prefix=reports');
        await expectError(browsed, 409, 'storage_connection_credential_required');
      });
    });
  },
);
