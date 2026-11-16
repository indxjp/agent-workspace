// A GCS store opened from its config: the endpoint it dials and the access token it sends.
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { StorageOptions } from '@google-cloud/storage';
import { GoogleAuth } from 'google-auth-library';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createGcsObjectStoreFromConfig, GcsEndpointForbiddenError } from './gcs-store.js';

// Points every client the store builds at a local stub while set, over any endpoint its config
// names; a custom endpoint drops auth unless asked to keep it.
const redirect = vi.hoisted(() => ({ apiEndpoint: '' }));
vi.mock('@google-cloud/storage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@google-cloud/storage')>();
  class RedirectedStorage extends actual.Storage {
    public constructor(options: StorageOptions = {}) {
      super(
        redirect.apiEndpoint === ''
          ? options
          : {
              ...options,
              apiEndpoint: redirect.apiEndpoint,
              useAuthWithCustomEndpoint: true,
              retryOptions: { autoRetry: false },
            },
      );
    }
  }
  return { ...actual, Storage: RedirectedStorage };
});

/** A local HTTP server that records each request and answers it with `reply`. */
async function recordingServer(
  reply: (method: string, url: string) => { status: number; body: unknown },
): Promise<{
  url: string;
  host: string;
  requests: { method: string; url: string; authorization: string | undefined }[];
  close: () => void;
}> {
  const requests: { method: string; url: string; authorization: string | undefined }[] = [];
  const server = createServer((request, response) => {
    const method = request.method ?? '';
    const url = request.url ?? '';
    requests.push({ method, url, authorization: request.headers.authorization });
    request.resume();
    request.on('end', () => {
      const { status, body } = reply(method, url);
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const host = `127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  return {
    url: `http://${host}`,
    host,
    requests,
    close: () => {
      server.closeAllConnections();
      server.close();
    },
  };
}

// Live GCS (#1835 follow-up): a configured store sanitises provider errors, and it wrapped the
// caller's own failing body as "Google Cloud Storage write failed." too. fake-gcs-server runs the
// unsanitised native client, so only a configured store over a stub shows it.
describe('a configured GCS store whose caller body fails', () => {
  it('rejects with the body error, not a sanitised provider error', async () => {
    const server = await recordingServer(() => ({ status: 200, body: {} }));
    try {
      const store = await createGcsObjectStoreFromConfig({
        bucket: 'acme-data',
        projectId: 'acme-prod',
        accessToken: `ya29.${randomUUID()}`,
        apiEndpoint: server.url,
        checkBucketOnOpen: false,
      });
      let pulls = 0;
      const failing = new ReadableStream<Uint8Array>({
        pull(controller) {
          pulls += 1;
          if (pulls > 2) controller.error(new Error('source broke'));
          else controller.enqueue(new Uint8Array(1024).fill(7));
        },
      });
      await expect(store.write('half.bin', failing, {})).rejects.toThrow('source broke');
      // A provider failure is still sanitised.
      const refused = await recordingServer(() => ({ status: 503, body: { error: 'down' } }));
      try {
        const down = await createGcsObjectStoreFromConfig({
          bucket: 'acme-data',
          projectId: 'acme-prod',
          accessToken: `ya29.${randomUUID()}`,
          apiEndpoint: refused.url,
          checkBucketOnOpen: false,
          timeoutMs: 1_000,
        });
        await expect(down.write('a.txt', new Uint8Array([1]), {})).rejects.toThrow(
          'Google Cloud Storage write failed.',
        );
      } finally {
        refused.close();
      }
    } finally {
      server.close();
    }
  });
});

describe('a GCS store that must dial its endpoint', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('[US-STO-12][unit][sdk] is refused before any request when STORAGE_EMULATOR_HOST redirects the SDK', async () => {
    const emulator = await recordingServer(() => ({ status: 200, body: {} }));
    vi.stubEnv('STORAGE_EMULATOR_HOST', emulator.url);
    const config = {
      bucket: 'acme-data',
      projectId: 'acme-prod',
      accessToken: `ya29.${randomUUID()}`,
      checkBucketOnOpen: false,
    } as const;
    try {
      // The SDK honours the variable by itself, so only the flag stops the redirect.
      await expect(createGcsObjectStoreFromConfig(config)).resolves.toBeDefined();
      await expect(
        createGcsObjectStoreFromConfig({ ...config, requireApiEndpoint: true }),
      ).rejects.toBeInstanceOf(GcsEndpointForbiddenError);
      expect(emulator.requests).toEqual([]);
    } finally {
      emulator.close();
    }
  });

  it('[US-STO-12][unit][sdk] opens when the SDK keeps the Google endpoint', async () => {
    await expect(
      createGcsObjectStoreFromConfig({
        bucket: 'acme-data',
        projectId: 'acme-prod',
        accessToken: `ya29.${randomUUID()}`,
        checkBucketOnOpen: false,
        requireApiEndpoint: true,
      }),
    ).resolves.toBeDefined();
  });

  it('[US-STO-12][unit][sdk] dials a configured endpoint, and is still refused when STORAGE_EMULATOR_HOST redirects it', async () => {
    const configured = await recordingServer(() => ({
      status: 200,
      body: { kind: 'storage#objects' },
    }));
    const emulator = await recordingServer(() => ({ status: 200, body: {} }));
    const token = `ya29.${randomUUID()}`;
    const config = {
      bucket: 'acme-data',
      projectId: 'acme-prod',
      accessToken: token,
      apiEndpoint: configured.url,
      requireApiEndpoint: true,
    } as const;
    try {
      vi.stubEnv('STORAGE_EMULATOR_HOST', emulator.url);
      await expect(createGcsObjectStoreFromConfig(config)).rejects.toBeInstanceOf(
        GcsEndpointForbiddenError,
      );
      vi.unstubAllEnvs();
      expect(configured.requests).toEqual([]);
      expect(emulator.requests).toEqual([]);

      const store = await createGcsObjectStoreFromConfig(config);
      await expect(store.listPage('', { limit: 1 })).resolves.toEqual({
        entries: [],
        cursor: null,
      });
      // The open's one-object bucket check, then the listing; both carry the connection's token.
      expect(configured.requests.map(({ method, url }) => `${method} ${url}`)).toEqual([
        expect.stringMatching(/^GET \/storage\/v1\/b\/acme-data\/o\?/u),
        expect.stringMatching(/^GET \/storage\/v1\/b\/acme-data\/o\?/u),
      ]);
      expect(configured.requests.map(({ authorization }) => authorization)).toEqual([
        `Bearer ${token}`,
        `Bearer ${token}`,
      ]);
      expect(emulator.requests).toEqual([]);
    } finally {
      configured.close();
      emulator.close();
    }
  });
});

describe('a GCS store opened with an access token', () => {
  afterEach(() => {
    redirect.apiEndpoint = '';
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('[US-STO-12][unit][sdk] cannot sign, and never asks the metadata server or ADC across create, test, list, read, write and a sign attempt', async () => {
    const token = `ya29.${randomUUID()}`;
    const metadata = await recordingServer(() => ({ status: 404, body: {} }));
    const gcs = await recordingServer((method, url) => {
      if (method === 'GET' && url.startsWith('/storage/v1/b/acme-data?')) {
        return { status: 200, body: { name: 'acme-data' } };
      }
      if (method === 'GET' && url.startsWith('/storage/v1/b/acme-data/o?')) {
        return { status: 200, body: { kind: 'storage#objects' } };
      }
      return { status: 404, body: { error: { code: 404, message: 'Not Found' } } };
    });
    // Both overrides `gcp-metadata` reads, so no metadata request can leave for the real server.
    vi.stubEnv('GCE_METADATA_HOST', metadata.host);
    vi.stubEnv('GCE_METADATA_IP', metadata.host);
    redirect.apiEndpoint = gcs.url;
    const adc = vi.spyOn(
      GoogleAuth.prototype as unknown as { getApplicationDefaultAsync: () => Promise<unknown> },
      'getApplicationDefaultAsync',
    );
    try {
      const store = await createGcsObjectStoreFromConfig({
        bucket: 'acme-data',
        projectId: 'acme-prod',
        accessToken: token,
      });

      expect(store.capabilities.sign).toBe(false);
      expect(store.capabilities.boundLengthSign).toBe(false);
      expect(store).not.toHaveProperty('createSignedUrl');
      await expect(store.listPage('', { limit: 1 })).resolves.toEqual({
        entries: [],
        cursor: null,
      });
      await expect(store.listPage('', { recursive: true })).resolves.toEqual({
        entries: [],
        cursor: null,
      });
      await expect(store.read('a.txt')).resolves.toBeNull();
      await expect(store.write('a.txt', new TextEncoder().encode('a'), {})).rejects.toThrow();
      await store.createSignedUrl?.('a.txt', { method: 'GET' }).catch(() => undefined);

      expect(adc).not.toHaveBeenCalled();
      expect(metadata.requests).toEqual([]);
      expect(gcs.requests.length).toBeGreaterThanOrEqual(5);
      for (const request of gcs.requests) expect(request.authorization).toBe(`Bearer ${token}`);
    } finally {
      gcs.close();
      metadata.close();
    }
  });
});
