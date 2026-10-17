import http from 'node:http';
import net, { type AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { parseAllowlist } from './allowlist.js';
import { createEgressProxy, type EgressProxyOptions } from './proxy.js';

const PUBLIC_ADDRESS = '93.184.216.34';
const closers: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

function listen(server: net.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      closers.push(
        () =>
          new Promise<void>((done) => {
            if (server instanceof http.Server) server.closeAllConnections();
            server.close(() => done());
          }),
      );
      resolve((server.address() as AddressInfo).port);
    });
  });
}

interface Harness {
  readonly proxyPort: number;
  readonly logs: Record<string, unknown>[];
  readonly lookups: string[];
  readonly dials: { address: string; port: number }[];
  readonly upstreamRequests: http.IncomingMessage[];
}

/** A proxy whose "public" address 93.184.216.34 is really a local upstream that echoes. */
async function startProxy(
  allowlist: readonly string[],
  overrides: Partial<EgressProxyOptions> = {},
): Promise<Harness> {
  const upstreamRequests: http.IncomingMessage[] = [];
  const web = http.createServer((req, res) => {
    upstreamRequests.push(req);
    res.writeHead(201, {
      'x-upstream': 'yes',
      connection: 'keep-alive',
      'keep-alive': 'timeout=5',
    });
    res.end(`hello ${req.method ?? ''} ${req.url ?? ''}`);
  });
  const echo = net.createServer((socket) => socket.pipe(socket));
  const webPort = await listen(web);
  const echoPort = await listen(echo);
  const logs: Record<string, unknown>[] = [];
  const lookups: string[] = [];
  const dials: { address: string; port: number }[] = [];
  const proxy = createEgressProxy({
    sessionId: 'session-1',
    allowlist: parseAllowlist(allowlist),
    resolve: (host) => {
      lookups.push(host);
      return Promise.resolve([PUBLIC_ADDRESS]);
    },
    dial: (address, port) => {
      dials.push({ address, port });
      return net.connect({ host: '127.0.0.1', port: port === 443 ? echoPort : webPort });
    },
    writeLog: (line) => logs.push(JSON.parse(line) as Record<string, unknown>),
    ...overrides,
  });
  const proxyPort = await listen(proxy);
  return { proxyPort, logs, lookups, dials, upstreamRequests };
}

interface ProxiedResponse {
  readonly status: number;
  readonly headers: http.IncomingHttpHeaders;
  readonly body: string;
}

function get(
  harness: Harness,
  target: string,
  headers: http.OutgoingHttpHeaders = {},
): Promise<ProxiedResponse> {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port: harness.proxyPort, path: target, headers }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      })
      .on('error', reject);
  });
}

interface ConnectResult {
  readonly status: number;
  readonly echoed: string;
  readonly body: string;
}

function connectThrough(
  harness: Harness,
  authority: string,
  send = 'ping',
): Promise<ConnectResult> {
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: '127.0.0.1',
      port: harness.proxyPort,
      method: 'CONNECT',
      path: authority,
    });
    request.on('connect', (response, socket, head) => {
      const status = response.statusCode ?? 0;
      if (status === 200) {
        socket.once('data', (chunk: Buffer) => {
          socket.destroy();
          resolve({ status, echoed: chunk.toString('utf8'), body: '' });
        });
        socket.write(send);
        return;
      }
      // A refusal is the status line, headers and a JSON body, then the proxy closes.
      const chunks: Buffer[] = [head];
      socket.on('data', (chunk: Buffer) => chunks.push(chunk));
      socket.on('close', () =>
        resolve({
          status,
          echoed: '',
          body: Buffer.concat(chunks).toString('utf8'),
        }),
      );
    });
    request.on('error', reject);
    request.end();
  });
}

const LITERALS: readonly [host: string, reason: string][] = [
  ['169.254.169.254', 'address_link_local'],
  ['10.0.0.1', 'address_private'],
  ['127.0.0.1', 'address_loopback'],
  ['[::1]', 'address_loopback'],
  ['[fd00::1]', 'address_unique_local'],
  ['[::ffff:169.254.169.254]', 'address_link_local'],
];

describe('an allowed host', () => {
  it('passes HTTP to the resolved address, relays the response and strips hop-by-hop headers', async () => {
    const harness = await startProxy(['allowed.test']);
    const response = await get(harness, 'http://allowed.test/hello?x=1', {
      host: 'attacker.test',
      'proxy-authorization': 'Basic c2VjcmV0',
      'x-custom': 'kept',
      connection: 'close, x-secret-hop',
      'x-secret-hop': 'hidden',
    });
    expect(response.status).toBe(201);
    expect(response.body).toBe('hello GET /hello?x=1');
    expect(response.headers['x-upstream']).toBe('yes');
    const forwarded = harness.upstreamRequests[0]?.headers;
    expect(forwarded?.['host']).toBe('allowed.test');
    expect(forwarded?.['proxy-authorization']).toBeUndefined();
    expect(forwarded?.['x-custom']).toBe('kept');
    expect(forwarded?.['x-secret-hop']).toBeUndefined();
    expect(harness.logs).toEqual([]);
  });

  it('dials the address that was checked, never the name, and resolves once per request', async () => {
    const harness = await startProxy(['allowed.test']);
    await get(harness, 'http://allowed.test/');
    expect(harness.lookups).toEqual(['allowed.test']);
    expect(harness.dials).toEqual([{ address: PUBLIC_ADDRESS, port: 80 }]);
  });

  it('tunnels CONNECT bytes', async () => {
    const harness = await startProxy(['*.allowed.test']);
    const result = await connectThrough(harness, 'api.allowed.test:443', 'hello tunnel');
    expect(result).toMatchObject({ status: 200, echoed: 'hello tunnel' });
    expect(harness.dials).toEqual([{ address: PUBLIC_ADDRESS, port: 443 }]);
  });

  it('does not dial when the CONNECT client leaves while the name is resolving', async () => {
    let release: (addresses: readonly string[]) => void = () => undefined;
    let resolving: () => void = () => undefined;
    const resolveCalled = new Promise<void>((done) => (resolving = done));
    const dials: string[] = [];
    const proxy = createEgressProxy({
      sessionId: 'session-1',
      allowlist: parseAllowlist(['allowed.test']),
      resolve: () => {
        resolving();
        return new Promise((done) => (release = done));
      },
      dial: (address) => {
        dials.push(address);
        return new net.Socket();
      },
      writeLog: () => undefined,
    });
    const clientClosed = new Promise<void>((done) =>
      proxy.on('connect', (_req, socket: net.Socket) => socket.once('close', () => done())),
    );
    const proxyPort = await listen(proxy);
    const client = net.connect({ host: '127.0.0.1', port: proxyPort });
    client.write('CONNECT allowed.test:443 HTTP/1.1\r\nhost: allowed.test:443\r\n\r\n');
    await resolveCalled;
    client.destroy();
    await clientClosed;
    release([PUBLIC_ADDRESS]);
    await new Promise((done) => setImmediate(done));
    expect(dials).toEqual([]);
  });

  it('answers the health probe without a denial log line', async () => {
    const harness = await startProxy(['allowed.test']);
    const response = await get(harness, '/healthz');
    expect(response).toMatchObject({ status: 200, body: 'ok' });
    expect(harness.logs).toEqual([]);
  });
});

describe('a refused request', () => {
  it('refuses a host that is not listed, over HTTP and CONNECT, with one log line each', async () => {
    const harness = await startProxy(['allowed.test']);
    const viaHttp = await get(harness, 'http://other.test/');
    const viaConnect = await connectThrough(harness, 'other.test:443');
    expect(viaHttp.status).toBe(403);
    expect(JSON.parse(viaHttp.body)).toEqual({
      error: 'egress_denied',
      reason: 'host_not_allowed',
    });
    expect(viaConnect.status).toBe(403);
    expect(harness.logs).toEqual([
      {
        event: 'egress_denied',
        sessionId: 'session-1',
        host: 'other.test',
        port: 80,
        reason: 'host_not_allowed',
      },
      {
        event: 'egress_denied',
        sessionId: 'session-1',
        host: 'other.test',
        port: 443,
        reason: 'host_not_allowed',
      },
    ]);
    expect(harness.dials).toEqual([]);
    expect(harness.lookups).toEqual([]);
  });

  it.each(LITERALS)(
    'refuses the literal %s even when every host is allowed (HTTP)',
    async (host, reason) => {
      const harness = await startProxy(['*']);
      const response = await get(harness, `http://${host}/`);
      expect(response.status).toBe(403);
      expect(JSON.parse(response.body)).toEqual({ error: 'egress_denied', reason });
      expect(harness.logs).toHaveLength(1);
      expect(harness.dials).toEqual([]);
    },
  );

  it.each(LITERALS)(
    'refuses the literal %s even when every host is allowed (CONNECT)',
    async (host, reason) => {
      const harness = await startProxy(['*']);
      const result = await connectThrough(harness, `${host}:443`);
      expect(result.status).toBe(403);
      expect(JSON.parse(result.body)).toEqual({ error: 'egress_denied', reason });
      expect(harness.logs).toMatchObject([
        { event: 'egress_denied', sessionId: 'session-1', reason },
      ]);
      expect(harness.dials).toEqual([]);
    },
  );

  it('allows a public IP literal only when every host is allowed', async () => {
    const open = await startProxy(['*']);
    expect((await get(open, `http://${PUBLIC_ADDRESS}/`)).status).toBe(201);
    const restricted = await startProxy(['allowed.test']);
    const response = await get(restricted, `http://${PUBLIC_ADDRESS}/`);
    expect(JSON.parse(response.body)).toMatchObject({ reason: 'host_not_allowed' });
  });

  it.each([
    [['10.0.0.5'], 'a private address'],
    [['169.254.169.254'], 'the metadata address'],
    [[PUBLIC_ADDRESS, '10.0.0.5'], 'a public and a private address'],
    [['::ffff:10.0.0.5'], 'an IPv4-mapped private address'],
  ])('refuses a listed name that resolves to %s (%#)', async (addresses) => {
    const harness = await startProxy(['allowed.test'], {
      resolve: () => Promise.resolve(addresses),
    });
    const viaHttp = await get(harness, 'http://allowed.test/');
    const viaConnect = await connectThrough(harness, 'allowed.test:443');
    for (const status of [viaHttp.status, viaConnect.status]) expect(status).toBe(403);
    expect(JSON.parse(viaHttp.body)).toEqual({
      error: 'egress_denied',
      reason: 'resolves_to_denied_address',
    });
    expect(harness.logs.map((line) => line['reason'])).toEqual([
      'resolves_to_denied_address',
      'resolves_to_denied_address',
    ]);
    expect(harness.dials).toEqual([]);
  });

  it('answers 502 with a typed reason when the name does not resolve', async () => {
    const harness = await startProxy(['allowed.test'], {
      resolve: () => Promise.reject(new Error('ENOTFOUND secret-resolver-detail')),
    });
    const response = await get(harness, 'http://allowed.test/');
    expect(response.status).toBe(502);
    expect(response.body).not.toContain('secret-resolver-detail');
    expect(JSON.parse(response.body)).toEqual({
      error: 'egress_denied',
      reason: 'resolution_failed',
    });
    expect(harness.logs).toMatchObject([{ reason: 'resolution_failed' }]);
  });

  it('refuses a port that is not listed unless the port list names it', async () => {
    const harness = await startProxy(['allowed.test']);
    const response = await get(harness, 'http://allowed.test:8080/');
    expect(JSON.parse(response.body)).toMatchObject({ reason: 'port_not_allowed' });
    const widened = await startProxy(['allowed.test'], { allowedPorts: [8080] });
    expect((await get(widened, 'http://allowed.test:8080/')).status).toBe(201);
  });

  it.each(['/other', 'https://allowed.test/', 'http://'])(
    'refuses the request target %j as a bad request without a host in the log',
    async (target) => {
      const harness = await startProxy(['*']);
      const response = await get(harness, target);
      expect(response.status).toBe(400);
      expect(harness.logs).toEqual([
        {
          event: 'egress_denied',
          sessionId: 'session-1',
          host: null,
          port: null,
          reason: 'bad_request',
        },
      ]);
    },
  );

  it.each(['allowed.test', 'allowed.test:99999', 'user@allowed.test:443', 'allowed.test:443/x'])(
    'refuses the malformed CONNECT authority %j',
    async (authority) => {
      const harness = await startProxy(['*']);
      const result = await connectThrough(harness, authority);
      expect(result.status).toBe(400);
      expect(harness.dials).toEqual([]);
    },
  );

  it('never writes a URL path, query or header value to the denial log', async () => {
    const harness = await startProxy(['allowed.test']);
    await get(harness, 'http://other.test/secret/path?token=abc', { authorization: 'Bearer abc' });
    const line = JSON.stringify(harness.logs);
    expect(line).not.toMatch(/secret|token|abc/u);
  });
});
