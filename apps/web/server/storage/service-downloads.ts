import { SignedUrlUnsupportedError } from '@agent-workspace/core/storage';
import type { StorageOperations } from './service-operations';
import type { StorageService } from './service-contract';
import { linkLifetime } from './service-policy';

export function serviceDownloads(
  operations: StorageOperations,
): Pick<StorageService, 'open' | 'signDownload'> {
  const { audit, locate } = operations;
  return {
    // @story US-STO-05
    // A download is audited when the caller names an actor (the relay route); the agent's own
    // reads and the search index pass the workspace only and are not.
    async open(ctx, row, range) {
      const object = locate(ctx.workspaceId, row);
      if (object === null) return null;
      const stream = await object.store.read(
        object.name,
        range === undefined ? undefined : { range },
      );
      const { id, path } = row;
      const owned = row.area === undefined || row.area === 'files' || row.area === 'artifacts';
      if (stream === null || ctx.actor === undefined || !owned) return stream;
      if (id === undefined || path === undefined) return stream;
      try {
        await audit(ctx, 'file-downloaded', { id, path }, { occurrence: null });
      } catch (error) {
        await stream.body.cancel().catch(() => undefined);
        throw error;
      }
      return stream;
    },

    // @story US-STO-05
    async signDownload(ctx, row, request) {
      const object = locate(ctx.workspaceId, row);
      if (object === null) return null;
      if (object.store.createSignedUrl === undefined) {
        throw new SignedUrlUnsupportedError('This object store cannot sign URLs.');
      }
      // The root store is not wrapped by the scoped store's 60..900 s bound, so it is checked here
      // before any I/O (the storage design, §05 "A signed link leaks").
      const expiresInSeconds = linkLifetime(request.ttlSeconds);
      if (expiresInSeconds === null) {
        throw new SignedUrlUnsupportedError('A signed URL lifetime is outside the allowed range.');
      }
      const url = await object.store.createSignedUrl(object.name, {
        method: 'GET',
        expiresInSeconds,
        responseContentType: request.responseContentType,
        responseDisposition: request.responseDisposition,
        ...(request.now === undefined ? {} : { now: request.now }),
      });
      await audit(ctx, 'file-link-created', row, { occurrence: null });
      return url;
    },
  };
}
