// @story US-STO-12
import {
  DeleteBucketCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3';
import { formatStorageUrl } from '@indx-workspace/contracts/storage-url';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { ConnectionStoreError, ReadOnlyStoreError } from './connection-store.js';
import {
  bytes,
  codeOf,
  local,
  open,
  s3Credential,
} from './connection-store.fixture.test-support.js';
import { defineObjectStoreContract } from './contract.js';
import { scopedObjectStoreProvider } from './object-store.js';
import { ensureS3Bucket } from './s3-store.js';

describe('connection store S3 connections', () => {
  let server: Server | undefined;
  afterEach(() => {
    vi.restoreAllMocks();
    server?.closeAllConnections();
    server?.close();
    server = undefined;
  });

  const securityTokens: (string | string[] | undefined)[] = [];
  async function listen(status: number): Promise<number> {
    securityTokens.length = 0;
    server = createServer((request, response) => {
      securityTokens.push(request.headers['x-amz-security-token']);
      response.statusCode = status;
      response.end();
    });
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
    return (server.address() as AddressInfo).port;
  }

  const urlFor = (port: number): string =>
    formatStorageUrl({
      kind: 's3',
      bucket: 'acme-data',
      prefix: '',
      endpoint: `http://bucket-host.invalid:${port}`,
      forcePathStyle: true,
    });
  const toLoopback = () => Promise.resolve([{ address: '127.0.0.1', family: 4 as const }]);

  it('[US-STO-12][unit][sdk] the client connects to the checked address, not a fresh lookup', async () => {
    const port = await listen(200);
    // `.invalid` never resolves in DNS, so this only opens if the socket used the checked address.
    const store = await open(urlFor(port), s3Credential(), { egress: local, resolve: toLoopback });
    await expect(store.write('a.txt', bytes, {})).rejects.toBeInstanceOf(ReadOnlyStoreError);
  });

  it('[US-STO-12][unit][sdk] a temporary credential sends its session token with every request', async () => {
    const port = await listen(200);
    const sessionToken = randomBytes(24).toString('base64');
    const store = await open(
      urlFor(port),
      { ...s3Credential(), sessionToken },
      { egress: local, resolve: toLoopback },
    );
    await store.read('a.txt');
    expect(securityTokens.length).toBeGreaterThan(0);
    expect(new Set(securityTokens)).toEqual(new Set([sessionToken]));
  });

  it('[US-STO-12][unit][sdk] a key limited to one folder, as the guide grants it, opens and lists that folder', async () => {
    // The guide's policy: `s3:ListBucket` only under the `s3:prefix` condition `reports/*`, so a
    // `HeadBucket` (no prefix) is denied and so is a listing outside the folder. The connection
    // URL has no prefix, as in the guide, so an open-time probe of the store's own prefix (an
    // unprefixed listing) would be denied too.
    const requests: string[] = [];
    server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://bucket-host.invalid');
      requests.push(`${request.method ?? ''} ${url.pathname}`);
      const prefix = url.searchParams.get('prefix') ?? '';
      if (
        request.method === 'GET' &&
        url.pathname.replace(/\/$/u, '') === '/acme-data' &&
        prefix.startsWith('reports/')
      ) {
        response.setHeader('content-type', 'application/xml');
        response.end(
          '<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><Name>acme-data</Name>' +
            `<Prefix>${prefix}</Prefix><KeyCount>1</KeyCount><MaxKeys>1</MaxKeys>` +
            '<IsTruncated>false</IsTruncated><Contents><Key>reports/q3.csv</Key>' +
            '<Size>3</Size><ETag>"e"</ETag><LastModified>2026-10-27T00:00:00.000Z</LastModified>' +
            '</Contents></ListBucketResult>',
        );
        return;
      }
      // `s3:GetObject` on the folder: a listing heads each file it returns.
      if (request.method === 'HEAD' && url.pathname.startsWith('/acme-data/reports/')) {
        response.setHeader('content-length', '3');
        response.setHeader('content-type', 'text/csv');
        response.end();
        return;
      }
      response.statusCode = 403;
      response.setHeader('content-type', 'application/xml');
      response.end('<Error><Code>AccessDenied</Code><Message>Access Denied</Message></Error>');
    });
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;

    const store = await open(urlFor(port), s3Credential(), { egress: local, resolve: toLoopback });
    const page = await store.listPage('reports', { limit: 1 });
    expect(page.entries.map((entry) => entry.key)).toEqual(['reports/q3.csv']);
    expect(requests).not.toContainEqual(expect.stringMatching(/^HEAD \/acme-data\/?$/u));
    // Outside the folder the provider's refusal surfaces with its status, for the caller to map.
    const outside: unknown = await store
      .listPage('', { limit: 1 })
      .catch((error: unknown) => error);
    expect(outside).toMatchObject({ $metadata: { httpStatusCode: 403 } });
  });

  it('[US-STO-12][unit][sdk] credentials never appear in a refusal, its cause, or the logs', async () => {
    const credential = { ...s3Credential(), sessionToken: randomBytes(24).toString('base64') };
    const secrets = [credential.accessKeyId, credential.secretAccessKey, credential.sessionToken];
    const logged = (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => undefined),
    );
    const port = await listen(403);
    // The open sends nothing; the refused key shows on the first call, as the provider's status.
    const opened = await open(urlFor(port), credential, { egress: local, resolve: toLoopback });
    const denied: unknown = await opened
      .listPage('', { limit: 1 })
      .catch((error: unknown) => error);
    expect(denied).toMatchObject({ $metadata: { httpStatusCode: 403 } });
    for (const secret of secrets) {
      expect(String(denied)).not.toContain(secret);
      expect((denied as Error).stack ?? '').not.toContain(secret);
    }
    const refusals = [
      open('s3://acme-data?endpoint=https://127.0.0.1', credential),
      open('s3://acme-data', { provider: 'file' }),
      open(`s3://${credential.accessKeyId}:${credential.secretAccessKey}@acme-data`, credential),
    ];
    const errors = await Promise.all(
      refusals.map((refusal) =>
        refusal.then(
          () => undefined,
          (error: unknown) => error,
        ),
      ),
    );
    expect(await codeOf(refusals[0] as Promise<unknown>)).toBe(
      'storage_connection_endpoint_forbidden',
    );
    for (const error of errors) {
      expect(error).toBeInstanceOf(ConnectionStoreError);
      expect((error as Error).cause).toBeUndefined();
      for (const secret of secrets) {
        expect(String(error)).not.toContain(secret);
        expect((error as Error).stack ?? '').not.toContain(secret);
      }
    }
    const output = JSON.stringify(logged.flatMap((spy) => spy.mock.calls));
    for (const secret of secrets) expect(output).not.toContain(secret);
  });
});

defineObjectStoreContract('connection store — S3 (SeaweedFS)', async () => {
  const endpoint = process.env['TEST_S3_ENDPOINT'];
  if (endpoint === undefined || endpoint.trim() === '') {
    throw new Error('TEST_S3_ENDPOINT is required (the repository test launcher supplies it)');
  }
  const accessKeyId = process.env['TEST_S3_ACCESS_KEY_ID'] ?? 'agent_workspace';
  const secretAccessKey = process.env['TEST_S3_SECRET_ACCESS_KEY'] ?? 'agent_workspace';
  const region = process.env['TEST_S3_REGION'] ?? 'us-east-1';
  const client = new S3Client({
    endpoint,
    region,
    forcePathStyle: true,
    credentials: { accessKeyId, secretAccessKey },
  });
  const bucket = `aw-connection-${randomUUID()}`;
  await ensureS3Bucket(client, bucket);
  const store = await open(
    formatStorageUrl({ kind: 's3', bucket, prefix: '', endpoint, region, forcePathStyle: true }),
    { provider: 's3', accessKeyId, secretAccessKey },
    { writable: true, egress: local },
  );
  return {
    provider: scopedObjectStoreProvider(store),
    signedUrlsFetchable: true,
    teardown: async () => {
      const listed = await client.send(new ListObjectsV2Command({ Bucket: bucket }));
      const objects = (listed.Contents ?? []).flatMap((entry) =>
        entry.Key === undefined ? [] : [{ Key: entry.Key }],
      );
      if (objects.length > 0) {
        await client.send(
          new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: objects } }),
        );
      }
      await client.send(new DeleteBucketCommand({ Bucket: bucket }));
    },
  };
});
