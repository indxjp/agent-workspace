/**
 * What the native GCS client tests share: a local JSON-API stub the real SDK dials with a bearer
 * token, the fake bucket a streamed write goes to, and the check that a token never leaks.
 */
import { createHash } from 'node:crypto';
import { createServer, type RequestListener } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Writable } from 'node:stream';

import { Storage, type Bucket } from '@google-cloud/storage';

import { gcsStorageOptions } from './gcs-store.js';

/** GCS's `md5Hash`: the base64 MD5 of the stored bytes. */
export function md5Of(text: string): string {
  return createHash('md5').update(text).digest('base64');
}

/** `value` and every cause behind it as text: what a log line or a serialised error would show. */
export function errorChain(value: unknown): string {
  return value instanceof Error
    ? `${String(value)}\n${value.stack ?? ''}\n${JSON.stringify(value)}\n${errorChain(value.cause)}`
    : '';
}

/** What the SDK is pointed at: a bucket and the access token it sends. */
interface StubTarget {
  readonly bucket: string;
  readonly token: string;
}

/**
 * Serves `listener` on a local port and runs `run` with a real `Storage` that dials it with
 * `target`'s access token and no retry, closing the server after.
 */
export async function withStubbedStorage(
  listener: RequestListener,
  target: StubTarget,
  run: (storage: Storage) => Promise<void>,
): Promise<void> {
  const stub = createServer(listener);
  await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = stub.address() as AddressInfo;
    const storage = new Storage({
      ...(await gcsStorageOptions({
        bucket: target.bucket,
        projectId: 'acme-prod',
        accessToken: target.token,
      })),
      apiEndpoint: `http://127.0.0.1:${String(port)}`,
      useAuthWithCustomEndpoint: true,
      retryOptions: { autoRetry: false },
    });
    await run(storage);
  } finally {
    stub.closeAllConnections();
    stub.close();
  }
}

/** The metadata a finished upload leaves on the file, as the SDK's simple upload does. */
interface UploadedMetadata {
  readonly size?: string;
  readonly updated?: string;
  readonly generation: string;
  readonly md5Hash: string;
}

/** A bucket whose one file accepts a write and then reports `written` as its metadata. */
export function uploadingBucket(written: UploadedMetadata, extras: object = {}): Bucket {
  const file: { name: string; metadata: object; [key: string]: unknown } = {
    name: 'ws/a.txt',
    metadata: {},
    // Like the SDK's simple upload: the response body becomes `file.metadata` on completion.
    createWriteStream: () =>
      new Writable({
        write: (_chunk, _encoding, callback) => {
          callback();
        },
        final: (callback) => {
          file.metadata = written;
          callback();
        },
      }),
    ...extras,
  };
  return { file: () => file } as unknown as Bucket;
}
