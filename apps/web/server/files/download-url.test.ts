/**
 * `POST /api/files/:id/download-urls` signs the catalog row's object (the storage design, §05): a
 * new-naming row by its object id, a legacy row by its storage key, as a link on the storage domain
 * that forces an attachment and is never logged. Driven with real `Request` objects over the
 * catalog service, on the in-memory catalog and on PostgreSQL.
 */
// @story US-STO-05
import { describe, expect, it, vi } from 'vitest';

import {
  PRESIGNED_URL_DEFAULT_TTL_SECONDS,
  PRESIGNED_URL_MAX_TTL_SECONDS,
  PRESIGNED_URL_MIN_TTL_SECONDS,
} from '@indx-workspace/contracts/files';
import { SignedUrlUnsupportedError, storageObjectName } from '@agent-workspace/core/storage';

import { captureLog } from '../telemetry/capture-log';
import {
  APP_ORIGIN,
  ctxOf,
  memoryWorld,
  postgresWorld,
  STORAGE_ORIGIN,
  useDownloadHarness,
  useDownloadUrlDatabase,
  type World,
} from './download-url.test-support';

useDownloadUrlDatabase(() => process.env['TEST_DATABASE_URL']);

function defineSuite(name: string, setup: () => Promise<World>) {
  describe(`download links on the ${name}`, () => {
    const h = useDownloadHarness(setup);

    // @story US-STO-05
    it('[US-STO-05][api][sdk] signed download comes from the storage domain', async () => {
      const row = await h.save('reports/q3.txt', 'quarter three');
      expect(row.objectId).not.toBeNull();

      const link = await h.minted('reports/q3.txt');

      expect(new URL(link.url).origin).toBe(STORAGE_ORIGIN);
      expect(new URL(link.url).origin).not.toBe(APP_ORIGIN);
      expect(link.method).toBe('GET');
      expect(h.signed).toHaveLength(1);
      const [call] = h.signed;
      expect(call?.key).toBe(storageObjectName(h.world.a.workspaceId, 'files', row.objectId ?? ''));
      expect(call?.request.method).toBe('GET');
      expect(call?.request.responseDisposition).toMatch(/^attachment;/u);
      expect(call?.request.responseDisposition).toContain('q3.txt');
      expect(call?.request.responseContentType).toBe('text/plain');
    });

    // @story US-STO-05
    it('[US-STO-05][api][sdk] an omitted ttl is the default and an explicit one is passed through', async () => {
      await h.save('ttl.txt', 'x');

      const before = Date.now();
      const defaulted = await h.minted('ttl.txt');
      expect(h.signed[0]?.request.expiresInSeconds).toBe(PRESIGNED_URL_DEFAULT_TTL_SECONDS);
      const lifetime = Date.parse(defaulted.expiresAt) - before;
      expect(lifetime).toBeGreaterThanOrEqual(PRESIGNED_URL_DEFAULT_TTL_SECONDS * 1000);
      expect(lifetime).toBeLessThan(PRESIGNED_URL_DEFAULT_TTL_SECONDS * 1000 + 5000);

      await h.minted('ttl.txt', { ttlSeconds: PRESIGNED_URL_MIN_TTL_SECONDS });
      await h.minted('ttl.txt', { ttlSeconds: PRESIGNED_URL_MAX_TTL_SECONDS });
      expect(h.signed.map((call) => call.request.expiresInSeconds)).toEqual([
        PRESIGNED_URL_DEFAULT_TTL_SECONDS,
        PRESIGNED_URL_MIN_TTL_SECONDS,
        PRESIGNED_URL_MAX_TTL_SECONDS,
      ]);
    });

    // @story US-STO-05
    it('[US-STO-05][api][sdk] a ttl above the maximum is a 400 and nothing is signed', async () => {
      await h.save('ttl.txt', 'x');
      for (const ttlSeconds of [
        PRESIGNED_URL_MAX_TTL_SECONDS + 1,
        PRESIGNED_URL_MIN_TTL_SECONDS - 1,
      ]) {
        const response = await h.mint('a', 'ttl.txt', { ttlSeconds });
        expect(response.status).toBe(400);
      }
      expect(h.signed).toEqual([]);
    });

    // @story US-STO-05
    it('[US-STO-05][api][sdk] the service refuses a ttl outside the contract before it signs', async () => {
      const row = await h.save('ttl.txt', 'x');
      const headers = { responseContentType: 'text/plain', responseDisposition: 'attachment' };
      for (const ttlSeconds of [
        PRESIGNED_URL_MAX_TTL_SECONDS + 1,
        PRESIGNED_URL_MIN_TTL_SECONDS - 1,
      ]) {
        await expect(
          h.storage.signDownload(ctxOf(h.world.a), row, { ttlSeconds, ...headers }),
        ).rejects.toBeInstanceOf(SignedUrlUnsupportedError);
      }
      expect(h.signed).toEqual([]);
    });

    // @story US-STO-05
    it('[US-STO-05][api][sdk] a pending, deleting or absent row answers 404 and signs nothing', async () => {
      const catalog = await h.world.catalogs.forWorkspace(h.world.a.workspaceId);
      await catalog.reserve('pending.txt', {
        area: 'files',
        objectId: crypto.randomUUID(),
        ownerPrincipalId: h.world.a.principalId,
        sizeBytes: 0,
        contentType: 'text/plain',
      });
      await h.save('removed.txt', 'x');
      await catalog.remove('removed.txt');

      for (const path of ['pending.txt', 'removed.txt', 'absent.txt']) {
        expect((await h.mint('a', path)).status, path).toBe(404);
      }
      expect(h.signed).toEqual([]);
    });

    // @story US-STO-05
    it('[US-STO-05][api][sdk] another workspace and the attachments folder answer 404, never 403', async () => {
      await h.save('private/plan.txt', 'x');
      await h.save('.attachments/s1/photo.png', 'x');

      expect((await h.mint('b', 'private/plan.txt')).status).toBe(404);
      expect((await h.mint('a', '.attachments/s1/photo.png')).status).toBe(404);
      expect(h.signed).toEqual([]);
    });

    // @story US-STO-05
    it('[US-STO-05][api][sdk] a member of the same workspace without read access is refused 403', async () => {
      await h.save('private/plan.txt', 'x');

      // RBAC answers 403 here, as it does for `GET /api/files/:id`: the viewer is a member of the
      // workspace, so there is no tenant to conceal (`presign.routes.test.ts` asserts the same).
      const response = await h.mint('viewer', 'private/plan.txt');
      expect(response.status).toBe(403);
      expect(h.signed).toEqual([]);
    });

    // @story US-STO-05
    it('[US-STO-05][api][sdk] a download link is never logged, whether signing succeeds or fails', async () => {
      await h.save('secret.txt', 'x');
      const log = captureLog();
      const output = vi.spyOn(console, 'log');
      const errors = vi.spyOn(console, 'error');
      try {
        const link = await h.minted('secret.txt');
        expect(link.url).toContain(h.signature);

        h.failSigning = true;
        const failed = await h.mint('a', 'secret.txt');
        expect(failed.status).toBe(502);
        const failedBody = await failed.text();

        for (const written of [
          log.text(),
          failedBody,
          JSON.stringify(output.mock.calls),
          JSON.stringify(errors.mock.calls),
        ]) {
          expect(written).not.toContain(h.signature);
          expect(written).not.toContain(STORAGE_ORIGIN);
        }
      } finally {
        log.restore();
      }
    });
  });
}

defineSuite('in-memory catalog', memoryWorld);
defineSuite('PostgreSQL catalog', postgresWorld);
