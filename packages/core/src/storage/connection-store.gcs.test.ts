// @story US-STO-12
import { OAuth2Client } from 'google-auth-library';
import { randomBytes, randomUUID } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import { ConnectionStoreError, parseServiceAccount } from './connection-store.js';
import { codeOf, local, open, production } from './connection-store.fixture.test-support.js';
import { GcsBucketUnavailableError } from './gcs-safe-client.js';
import { createGcsObjectStoreFromConfig, gcsStorageOptions } from './gcs-store.js';

// The opener imports `gcs-store.js` itself; a test can make its store construction fail.
vi.mock('./gcs-store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./gcs-store.js')>();
  return {
    ...actual,
    createGcsObjectStoreFromConfig: vi.fn(actual.createGcsObjectStoreFromConfig),
  };
});

describe('connection store GCS connections', () => {
  // Built at runtime so no key-shaped literal sits in the source for a secret scanner to flag.
  const serviceAccount = () => ({
    client_email: `svc-${randomBytes(4).toString('hex')}@acme.iam.gserviceaccount.com`,
    private_key: randomBytes(24).toString('base64'),
  });

  it('[US-STO-12][unit][sdk] a GCS connection opens with its service-account credentials, and the server store without them is unchanged', async () => {
    const credentials = serviceAccount();
    expect(await gcsStorageOptions({ bucket: 'acme-data', credentials })).toStrictEqual({
      credentials,
    });
    expect(
      await gcsStorageOptions({ bucket: 'acme-data', projectId: 'acme-prod', credentials }),
    ).toStrictEqual({ projectId: 'acme-prod', credentials });
    expect(await gcsStorageOptions({ bucket: 'acme-data', projectId: 'acme-prod' })).toStrictEqual({
      projectId: 'acme-prod',
    });
    expect(await gcsStorageOptions({ bucket: 'acme-data', timeoutMs: 5_000 })).toStrictEqual({
      retryOptions: { totalTimeout: 5 },
    });
    expect(await gcsStorageOptions({ bucket: 'acme-data' })).toStrictEqual({});
  });

  it('[US-STO-12][unit][sdk] a GCS access token becomes an OAuth2 authClient, never credentials', async () => {
    const accessToken = `ya29.${randomUUID()}`;
    const options = await gcsStorageOptions({
      bucket: 'acme-data',
      projectId: 'acme-prod',
      accessToken,
    });
    expect(options).not.toHaveProperty('credentials');
    expect(options.projectId).toBe('acme-prod');
    const { authClient } = options as unknown as { authClient: unknown };
    expect(authClient).toBeInstanceOf(OAuth2Client);
    expect((authClient as OAuth2Client).credentials.access_token).toBe(accessToken);
  });

  it('[US-STO-12][unit][sdk] a GCS access token without a project, or external_account JSON, is refused without echoing it', async () => {
    const accessToken = `ya29.${randomUUID()}`;
    const externalAccount = JSON.stringify({
      type: 'external_account',
      credential_source: { file: `/tmp/${accessToken}` },
    });
    const refusals = [
      open('gcs://acme-data', { provider: 'gcs', accessToken }),
      open('gcs://acme-data?project=acme-prod', {
        provider: 'gcs',
        serviceAccountJson: externalAccount,
      }),
    ];
    for (const refusal of refusals) {
      const failure = await refusal.then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(ConnectionStoreError);
      expect((failure as ConnectionStoreError).code).toBe('storage_connection_url_invalid');
      expect((failure as Error).cause).toBeUndefined();
      expect(String(failure)).not.toContain(accessToken);
      expect((failure as Error).stack ?? '').not.toContain(accessToken);
    }
  });

  it('[US-STO-12][unit][sdk] a rejected GCS token is unreachable, with no cause and no token in the error', async () => {
    const accessToken = `ya29.${randomUUID()}`;
    // Shaped like the 401 the bucket check ends in: the SDK error keeps its bearer request.
    const sdkError = Object.assign(new Error(`401 for Bearer ${accessToken}`), {
      code: 401,
      config: { headers: { Authorization: `Bearer ${accessToken}` } },
    });
    vi.mocked(createGcsObjectStoreFromConfig).mockRejectedValueOnce(
      new GcsBucketUnavailableError('acme-data', 'unreachable', sdkError),
    );

    const failure: unknown = await open('gcs://acme-data?project=acme-prod', {
      provider: 'gcs',
      accessToken,
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ConnectionStoreError);
    expect((failure as ConnectionStoreError).code).toBe('storage_connection_unreachable');
    expect((failure as Error).cause).toBeUndefined();
    expect(String(failure)).not.toContain(accessToken);
    expect((failure as Error).stack ?? '').not.toContain(accessToken);
    expect(JSON.stringify(failure)).not.toContain(accessToken);
  });

  it('[US-STO-12][unit][sdk] a GCS connection opens without reading the bucket, which the object roles cannot', async () => {
    // Storage Object Viewer and User hold no `storage.buckets.get`: the bucket's metadata is a 403.
    const requests: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      requests.push(input instanceof Request ? input.url : String(input));
      return Promise.resolve(new Response('{"error":{"code":403}}', { status: 403 }));
    });
    const store = await open('gcs://acme-data?project=acme-prod', {
      provider: 'gcs',
      accessToken: `ya29.${randomUUID()}`,
    });
    expect(store.capabilities).toBeDefined();
    expect(requests).toEqual([]);
    expect(vi.mocked(createGcsObjectStoreFromConfig)).toHaveBeenLastCalledWith(
      expect.objectContaining({ bucket: 'acme-data', checkBucketOnOpen: false }),
    );
    vi.restoreAllMocks();
  });

  it('[US-STO-12][unit][sdk] a GCS connection is refused while the SDK emulator host is set', async () => {
    // The SDK would send every request to that host, which no endpoint check has seen.
    const credential = { provider: 'gcs', accessToken: `ya29.${randomUUID()}` } as const;
    vi.mocked(createGcsObjectStoreFromConfig).mockClear();
    for (const egress of [production, local]) {
      const attempt = open('gcs://acme-data?project=acme-prod', credential, {
        egress,
        gcsEmulatorHost: 'http://127.0.0.1:4443',
      });
      expect(await codeOf(attempt)).toBe('storage_connection_endpoint_forbidden');
    }
    expect(vi.mocked(createGcsObjectStoreFromConfig)).not.toHaveBeenCalled();
  });

  it('[US-STO-12][unit][sdk] a GCS connection is refused when the SDK picks the emulator host up from the environment itself', async () => {
    // No caller passes `gcsEmulatorHost` here: the client the SDK builds is checked instead.
    vi.stubEnv('STORAGE_EMULATOR_HOST', 'http://127.0.0.1:4443');
    const requests: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      requests.push(input instanceof Request ? input.url : String(input));
      return Promise.resolve(new Response('{}', { status: 200 }));
    });
    try {
      const attempt = open('gcs://acme-data?project=acme-prod', {
        provider: 'gcs',
        accessToken: `ya29.${randomUUID()}`,
      });
      expect(await codeOf(attempt)).toBe('storage_connection_endpoint_forbidden');
      expect(requests).toEqual([]);
    } finally {
      vi.unstubAllEnvs();
      vi.restoreAllMocks();
    }
  });

  it('[US-STO-12][unit][sdk] a GCS connection dials the test seam endpoint and still requires it', async () => {
    vi.mocked(createGcsObjectStoreFromConfig).mockClear();
    await open(
      'gcs://acme-data?project=acme-prod',
      { provider: 'gcs', accessToken: `ya29.${randomUUID()}` },
      { gcsApiEndpoint: 'http://127.0.0.1:4443' },
    );
    expect(vi.mocked(createGcsObjectStoreFromConfig)).toHaveBeenLastCalledWith(
      expect.objectContaining({ apiEndpoint: 'http://127.0.0.1:4443', requireApiEndpoint: true }),
    );
    // Without the seam, nothing names an endpoint and Google's is required.
    await open('gcs://acme-data?project=acme-prod', {
      provider: 'gcs',
      accessToken: `ya29.${randomUUID()}`,
    });
    expect(vi.mocked(createGcsObjectStoreFromConfig).mock.lastCall?.[0]).not.toHaveProperty(
      'apiEndpoint',
    );
  });

  it('[US-STO-12][unit][sdk] a stored key whose type is not service_account is refused even with an email and a key', () => {
    const key = { ...serviceAccount(), project_id: 'acme-prod' };
    expect(parseServiceAccount(JSON.stringify({ type: 'service_account', ...key }))).toStrictEqual(
      key,
    );
    for (const type of ['external_account', 'authorized_user']) {
      expect(parseServiceAccount(JSON.stringify({ type, ...key }))).toBeNull();
    }
    // A key with no `type` is refused too (owner decision, #1835).
    expect(parseServiceAccount(JSON.stringify(key))).toBeNull();
  });

  it('[US-STO-12][unit][sdk] an unusable GCS credential is refused without echoing it', async () => {
    const secret = randomBytes(24).toString('base64');
    const logged = (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => undefined),
    );
    const bad = [
      `{"private_key":"${secret}"`,
      JSON.stringify({ private_key: secret }),
      JSON.stringify([secret]),
      secret,
    ];
    for (const serviceAccountJson of bad) {
      const failure = await open('gcs://acme-data', { provider: 'gcs', serviceAccountJson }).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(ConnectionStoreError);
      expect((failure as ConnectionStoreError).code).toBe('storage_connection_url_invalid');
      expect((failure as Error).cause).toBeUndefined();
      expect(String(failure)).not.toContain(secret);
      expect((failure as Error).stack ?? '').not.toContain(secret);
    }
    expect(JSON.stringify(logged.flatMap((spy) => spy.mock.calls))).not.toContain(secret);
    vi.restoreAllMocks();
  });
});
