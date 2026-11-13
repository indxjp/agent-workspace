// @story US-STO-12
import { formatStorageUrl } from '@indx-workspace/contracts/storage-url';
import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { connect, type AddressInfo, type Socket } from 'node:net';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { OutboundProxyConfig } from '../net/outbound-proxy.js';
import {
  ConnectionStoreError,
  openConnectionStore,
  type ConnectionCredential,
  type ConnectionStoreOptions,
} from './connection-store.js';

const local = { production: false, allowHosts: [] } as const;
const production = { production: true, allowHosts: [] } as const;
const toLoopback = () => Promise.resolve([{ address: '127.0.0.1', family: 4 as const }]);

/** The `CONNECT` authorities the proxy saw, in order. */
interface TestProxy {
  readonly url: string;
  readonly connects: string[];
}

const servers: Server[] = [];
const sockets: Socket[] = [];

afterEach(async () => {
  vi.useRealTimers();
  for (const socket of sockets.splice(0)) socket.destroy();
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});

async function listen(server: Server): Promise<number> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

/**
 * A CONNECT proxy that resolves every name to loopback, as a proxy with its own DNS would, and
 * answers 403 for port 443, where nothing listens here.
 */
async function startProxy(): Promise<TestProxy> {
  const connects: string[] = [];
  const server = createServer((_request, response) => {
    response.statusCode = 405;
    response.end();
  });
  server.on('connect', (request, client: Socket) => {
    const authority = request.url ?? '';
    connects.push(authority);
    sockets.push(client);
    const port = Number(authority.slice(authority.lastIndexOf(':') + 1));
    if (port === 443) {
      client.end('HTTP/1.1 403 Forbidden\r\ncontent-length: 0\r\n\r\n');
      return;
    }
    const upstream = connect(port, '127.0.0.1', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      upstream.pipe(client);
      client.pipe(upstream);
    });
    sockets.push(upstream);
    upstream.on('error', () => client.destroy());
    client.on('error', () => upstream.destroy());
  });
  const port = await listen(server);
  return { url: `http://127.0.0.1:${String(port)}`, connects };
}

/** A port nothing listens on: bound, then closed. */
async function deadPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/**
 * Answers an S3 `ListObjectsV2` and an Azure container listing with an empty page, and anything
 * else with 200, counting what reached it.
 */
async function startTarget(): Promise<{ port: number; requests: string[] }> {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    const url = request.url ?? '';
    requests.push(url);
    response.setHeader('content-type', 'application/xml');
    if (url.includes('restype=container') && url.includes('comp=list')) {
      response.end(
        '<?xml version="1.0" encoding="utf-8"?><EnumerationResults ContainerName="files"><Blobs /><NextMarker /></EnumerationResults>',
      );
      return;
    }
    if (url.includes('list-type=2')) {
      response.end(
        '<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><Name>acme-data</Name><KeyCount>0</KeyCount><MaxKeys>1000</MaxKeys><IsTruncated>false</IsTruncated></ListBucketResult>',
      );
      return;
    }
    response.end();
  });
  return { port: await listen(server), requests };
}

const proxyConfig = (proxyUrl: string, noProxy: readonly string[] = []): OutboundProxyConfig => ({
  httpsProxy: proxyUrl,
  httpProxy: proxyUrl,
  noProxy,
});

interface Provider {
  readonly name: string;
  readonly url: (endpoint: string) => string;
  readonly credential: () => ConnectionCredential;
}

const s3: Provider = {
  name: 'S3',
  url: (endpoint) =>
    formatStorageUrl({
      kind: 's3',
      bucket: 'acme-data',
      prefix: '',
      endpoint,
      forcePathStyle: true,
    }),
  credential: () => ({
    provider: 's3',
    accessKeyId: ['AK', 'IA', randomBytes(8).toString('hex').toUpperCase()].join(''),
    secretAccessKey: randomBytes(20).toString('base64'),
  }),
};

const azure: Provider = {
  name: 'Azure',
  url: (serviceUrl) =>
    formatStorageUrl({
      kind: 'azblob',
      account: 'acme',
      serviceUrl,
      container: 'files',
      prefix: '',
    }),
  credential: () => ({
    provider: 'azblob',
    sasToken: `sv=2024-11-04&sp=rl&sr=c&sig=${encodeURIComponent(randomBytes(24).toString('base64'))}`,
  }),
};

const open = (
  url: string,
  credential: ConnectionCredential,
  options: Partial<ConnectionStoreOptions>,
) =>
  openConnectionStore(url, credential, {
    writable: false,
    fileRoots: [],
    egress: local,
    ...options,
  });

/** Open and list one page: an S3 open sends nothing, so the listing is its first request. */
async function openAndList(
  url: string,
  credential: ConnectionCredential,
  options: Partial<ConnectionStoreOptions>,
): Promise<number> {
  const store = await open(url, credential, options);
  return (await store.listPage('')).entries.length;
}

/**
 * Settles `work` while its SDK's retry back-off (seconds, on `setTimeout`) runs on a fake clock,
 * so a refused connection costs milliseconds; sockets stay real.
 */
async function settleWithFastRetries(work: () => Promise<unknown>): Promise<unknown> {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  let done = false;
  const outcome = work().then(
    () => undefined,
    (error: unknown) => error,
  );
  void outcome.finally(() => {
    done = true;
  });
  while (!done) {
    await new Promise((resolve) => setImmediate(resolve));
    await vi.advanceTimersByTimeAsync(1_000);
  }
  return outcome;
}

const codeOf = (error: unknown) => (error instanceof ConnectionStoreError ? error.code : error);

describe.each([s3, azure])('a $name connection behind an outbound proxy', (provider) => {
  it('[US-STO-12][unit][sdk] tunnels through the proxy with CONNECT, and the proxy resolves the name', async () => {
    const proxy = await startProxy();
    const target = await startTarget();
    // `.invalid` never resolves: only the proxy, which maps it to loopback, can reach it.
    const authority = `blob-host.invalid:${String(target.port)}`;
    const entries = await openAndList(provider.url(`http://${authority}`), provider.credential(), {
      resolve: toLoopback,
      proxy: proxyConfig(proxy.url),
    });
    expect(entries).toBe(0);
    expect(proxy.connects.length).toBeGreaterThan(0);
    expect(new Set(proxy.connects)).toEqual(new Set([authority]));
    expect(target.requests.length).toBeGreaterThan(0);
  });

  it('[US-STO-12][unit][sdk] an https target is tunnelled too, to its own name and port', async () => {
    const proxy = await startProxy();
    const host = provider === s3 ? 's3.example.com' : 'acme.blob.core.windows.net';
    // Allowed by name and resolved to loopback, so a direct connection would be refused at once
    // instead of reaching the internet; the proxy answers this CONNECT with 403.
    const error = await settleWithFastRetries(() =>
      openAndList(provider.url(`https://${host}`), provider.credential(), {
        egress: { production: true, allowHosts: [host] },
        resolve: toLoopback,
        proxy: proxyConfig(proxy.url),
      }),
    );
    expect(codeOf(error)).not.toBeUndefined();
    expect(proxy.connects.length).toBeGreaterThan(0);
    expect(new Set(proxy.connects)).toEqual(new Set([`${host}:443`]));
  });

  it('[US-STO-12][unit][sdk] fails, and never connects directly, while the proxy is down', async () => {
    const target = await startTarget();
    const down = `http://127.0.0.1:${String(await deadPort())}`;
    const error = await settleWithFastRetries(() =>
      openAndList(
        provider.url(`http://blob-host.invalid:${String(target.port)}`),
        provider.credential(),
        { resolve: toLoopback, proxy: proxyConfig(down) },
      ),
    );
    expect(error).not.toBeUndefined();
    expect(target.requests).toEqual([]);
  });

  it('[US-STO-12][unit][sdk] a NO_PROXY target is reached directly, on the checked address', async () => {
    const proxy = await startProxy();
    const target = await startTarget();
    const entries = await openAndList(
      provider.url(`http://blob-host.invalid:${String(target.port)}`),
      provider.credential(),
      { resolve: toLoopback, proxy: proxyConfig(proxy.url, ['.invalid']) },
    );
    expect(entries).toBe(0);
    expect(proxy.connects).toEqual([]);
    expect(target.requests.length).toBeGreaterThan(0);
  });

  it.each([
    ['https://10.0.0.1', ['10.0.0.1']],
    ['https://169.254.169.254', ['169.254.169.254']],
    ['https://storage.example.com', ['93.184.216.34', '10.0.0.7']],
    ['http://storage.example.com', ['93.184.216.34']],
  ])(
    '[US-STO-12][unit][sdk] a forbidden target is refused before the proxy is asked: %s %j',
    async (endpoint, resolved) => {
      const proxy = await startProxy();
      const asked: string[] = [];
      const resolve = (host: string) => {
        asked.push(host);
        return Promise.resolve(resolved.map((address) => ({ address, family: 4 as const })));
      };
      const error = await openAndList(provider.url(endpoint), provider.credential(), {
        egress: production,
        resolve,
        proxy: proxyConfig(proxy.url),
      }).then(
        () => undefined,
        (failure: unknown) => failure,
      );
      expect(codeOf(error)).toBe('storage_connection_endpoint_forbidden');
      expect(proxy.connects).toEqual([]);
      // A literal address needs no lookup; a name is still resolved and checked here.
      expect(asked).toEqual(endpoint.includes('example.com') ? ['storage.example.com'] : []);
    },
  );
});

describe('a virtual-hosted S3 endpoint behind an outbound proxy', () => {
  // Through the proxy the client dials `<bucket>.<endpoint host>`, which the proxy resolves, so
  // that name is checked too: pinning no longer makes it answer with the endpoint's addresses.
  it('[US-STO-12][unit][sdk] the bucket host the client dials is checked too, before the proxy is asked', async () => {
    const proxy = await startProxy();
    const asked: string[] = [];
    const resolve = (host: string) => {
      asked.push(host);
      const address = host === 's3.example.com' ? '93.184.216.34' : '10.0.0.7';
      return Promise.resolve([{ address, family: 4 as const }]);
    };
    const url = formatStorageUrl({
      kind: 's3',
      bucket: 'acme-data',
      prefix: '',
      endpoint: 'https://s3.example.com',
      forcePathStyle: false,
    });
    const error = await openAndList(url, s3.credential(), {
      egress: production,
      resolve,
      proxy: proxyConfig(proxy.url),
    }).then(
      () => undefined,
      (failure: unknown) => failure,
    );
    expect(codeOf(error)).toBe('storage_connection_endpoint_forbidden');
    expect(asked).toEqual(['s3.example.com', 'acme-data.s3.example.com']);
    expect(proxy.connects).toEqual([]);
  });
});

describe('an S3 connection to AWS itself behind an outbound proxy', () => {
  it('[US-STO-12][unit][sdk] the default AWS endpoint is tunnelled too', async () => {
    const proxy = await startProxy();
    const url = formatStorageUrl({
      kind: 's3',
      bucket: 'acme-data',
      prefix: '',
      region: 'eu-west-1',
      forcePathStyle: false,
    });
    await settleWithFastRetries(() =>
      openAndList(url, s3.credential(), { egress: production, proxy: proxyConfig(proxy.url) }),
    );
    expect(proxy.connects.length).toBeGreaterThan(0);
    expect(new Set(proxy.connects)).toEqual(new Set(['acme-data.s3.eu-west-1.amazonaws.com:443']));
  });
});

// A GCS connection names no endpoint: it always dials Google's API host with the SDK's own
// transport, which reads the proxy variables itself, so there is nothing for the opener to route.
describe('a GCS connection behind an outbound proxy', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('[US-STO-12][unit][sdk] the SDK tunnels to Google through HTTPS_PROXY by itself', async () => {
    const proxy = await startProxy();
    vi.stubEnv('HTTPS_PROXY', proxy.url);
    vi.stubEnv('NO_PROXY', '');
    vi.stubEnv('no_proxy', '');
    const error = await settleWithFastRetries(() =>
      openAndList(
        'gcs://acme-data?project=acme-prod',
        { provider: 'gcs', accessToken: `ya29.${randomBytes(16).toString('hex')}` },
        { egress: production },
      ),
    );
    expect(error).not.toBeUndefined();
    expect(new Set(proxy.connects)).toEqual(new Set(['storage.googleapis.com:443']));
  });
});
