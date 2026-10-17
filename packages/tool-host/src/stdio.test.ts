import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { connect, createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createEgressProxy, parseAllowlist } from '@agent-workspace/egress-proxy';

import {
  MANIFEST_FILE,
  ManifestError,
  READY_FILE,
  TOKENS_FILE,
  parseManifest,
  runSandbox,
} from './sandbox.js';

const SECRET = 'sk-live-do-not-print-0123456789';
const TOKEN = 'run-token-0123456789abcdef';
const PROXY = 'http://proxy.invalid:3128';
const ENDPOINT = '/stdio/orders/mcp';
const PINNED = ['-y', '@acme/orders-mcp@1.2.3', '--region', 'eu'];

/** A stdio MCP server in a few lines of JSON-RPC, so the test needs no package from a registry. */
const SERVER = `
import readline from 'node:readline';
const send = (id, result) =>
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n');
const tools = [
  { name: 'inspect', description: 'Reports its launch.', inputSchema: { type: 'object' } },
  { name: 'die', description: 'Exits.', inputSchema: { type: 'object' } },
  { name: 'fetch_url', description: 'Fetches a URL.', inputSchema: { type: 'object' } },
];
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const { id, method, params } = JSON.parse(line);
  if (method === 'initialize') {
    send(id, {
      protocolVersion: params.protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: 'fixture', version: '1.0.0' },
    });
  } else if (method === 'tools/list') {
    send(id, { tools });
  } else if (method === 'tools/call' && params.name === 'die') {
    process.exit(0);
  } else if (method === 'tools/call' && params.name === 'fetch_url') {
    const reply = (text) => send(id, { content: [{ type: 'text', text }] });
    fetch(params.arguments.url).then(
      async (response) => reply(String(response.status) + ' ' + (await response.text())),
      (error) => reply('failed ' + String(error)),
    );
  } else if (method === 'tools/call') {
    process.stderr.write('inspected\\n');
    const launch = { argv: process.argv.slice(2), env: process.env };
    send(id, { content: [{ type: 'text', text: JSON.stringify(launch) }] });
  }
});
`;

const manifestFor = (args: string[], env: Record<string, string> = {}): string =>
  JSON.stringify({
    tools: [],
    stdioServers: [{ name: 'orders', command: 'npx', args, timeoutMs: 5_000 }],
    env,
  });

async function post(
  port: number,
  token: string | undefined,
  endpoint: string,
  params: Record<string, unknown>,
): Promise<{ status: number; body: string }> {
  const response = await fetch(`http://127.0.0.1:${String(port)}${endpoint}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, ...params }),
  });
  return { status: response.status, body: await response.text() };
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => {
        resolve(port);
      });
    });
  });
}

let directory = '';
let binary = '';
let stop: AbortController;
let closed: Promise<void>[];

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'aw-tool-stdio-'));
  stop = new AbortController();
  closed = [];
  // A stand-in `npx` that runs the fixture instead of fetching a package.
  binary = path.join(directory, 'bin');
  await mkdir(binary);
  const server = path.join(binary, 'server.mjs');
  await writeFile(server, SERVER);
  const npx = path.join(binary, 'npx');
  await writeFile(npx, `#!/bin/sh\nexec '${process.execPath}' '${server}' "$@"\n`);
  await chmod(npx, 0o755);
});

afterEach(async () => {
  stop.abort();
  await Promise.all(closed);
  await rm(directory, { recursive: true, force: true });
});

describe('stdio servers in the manifest', () => {
  it.each([
    ['a tag', ['@acme/orders-mcp@latest']],
    ['a range', ['-y', '@acme/orders-mcp@^1.2.3']],
    ['no version', ['orders-mcp']],
    ['a flag in place of the package', ['--yes', 'orders-mcp@1.2.3']],
    ['a path', ['./server.js']],
  ])('refuses %s', (_label, args) => {
    expect(() => parseManifest(manifestFor(args))).toThrow(ManifestError);
    expect(() => parseManifest(manifestFor(args))).toThrow(/stdioServers\.0\.args/u);
  });

  it('refuses a command other than npx', () => {
    const raw = JSON.parse(manifestFor(PINNED)) as { stdioServers: { command: string }[] };
    raw.stdioServers[0]!.command = 'sh';
    expect(() => parseManifest(JSON.stringify(raw))).toThrow(/stdioServers\.0\.command/u);
  });

  it('accepts a pinned package', () => {
    expect(parseManifest(manifestFor(PINNED)).stdioServers).toHaveLength(1);
  });
});

describe('runSandbox with a stdio server', () => {
  async function start(env: NodeJS.ProcessEnv) {
    const port = await freePort();
    const errors: string[] = [];
    const sandbox = runSandbox({
      directory,
      host: '127.0.0.1',
      port,
      stderr: (text) => errors.push(text),
      signal: stop.signal,
      env,
    });
    return { port, errors, sandbox };
  }

  it('serves the server behind the bearer check, with only the declared secrets and the proxy, and no secret in argv', async () => {
    const { port, errors, sandbox } = await start({
      PATH: binary,
      HTTPS_PROXY: PROXY,
      UNRELATED_HOST_VARIABLE: 'must-not-reach-the-server',
    });
    await writeFile(
      path.join(directory, MANIFEST_FILE),
      manifestFor(PINNED, { ORDERS_API_KEY: SECRET }),
    );
    const host = await sandbox;
    closed.push(host.closed);
    expect(host.tools()).toEqual(['stdio:orders']);
    await expect(stat(path.join(directory, READY_FILE))).resolves.toBeTruthy();

    expect((await post(port, undefined, ENDPOINT, { method: 'tools/list' })).status).toBe(401);
    expect((await post(port, TOKEN, ENDPOINT, { method: 'tools/list' })).status).toBe(401);
    await writeFile(path.join(directory, TOKENS_FILE), JSON.stringify([TOKEN]));

    const listed = await post(port, TOKEN, ENDPOINT, { method: 'tools/list' });
    expect(listed.status).toBe(200);
    const names = (JSON.parse(listed.body) as { result: { tools: { name: string }[] } }).result
      .tools;
    expect(names.map((tool) => tool.name)).toEqual(['inspect', 'die', 'fetch_url']);

    const answer = await post(port, TOKEN, ENDPOINT, {
      method: 'tools/call',
      params: { name: 'inspect', arguments: {} },
    });
    const text = (JSON.parse(answer.body) as { result: { content: { text: string }[] } }).result
      .content[0]?.text;
    const launch = JSON.parse(text ?? '') as { argv: string[]; env: Record<string, string> };
    expect(launch.argv).toEqual(PINNED);
    expect(launch.argv.join(' ')).not.toContain(SECRET);
    expect(launch.env['ORDERS_API_KEY']).toBe(SECRET);
    expect(launch.env['HTTPS_PROXY']).toBe(PROXY);
    expect(launch.env['HOME']).toBe(path.join(directory, 'home'));
    expect(launch.env['npm_config_cache']).toBe(path.join(directory, 'npm-cache'));
    expect(launch.env).not.toHaveProperty('UNRELATED_HOST_VARIABLE');
    expect(launch.env).not.toHaveProperty('AW_TOOL_HOST');
    expect(errors.join('')).toContain('[tool stdio orders] inspected');

    // A server the sandbox does not run is not served, and a revoked token is not admitted.
    expect((await post(port, TOKEN, '/stdio/other/mcp', { method: 'tools/list' })).status).toBe(
      404,
    );
    await writeFile(path.join(directory, TOKENS_FILE), '[]');
    expect((await post(port, TOKEN, ENDPOINT, { method: 'tools/list' })).status).toBe(401);
  });

  it('refuses to start when the server cannot be launched, and reports it', async () => {
    const { sandbox } = await start({ PATH: path.join(directory, 'nowhere') });
    await writeFile(path.join(directory, MANIFEST_FILE), manifestFor(PINNED));
    await expect(sandbox).rejects.toThrow(/did not serve stdio:orders/u);
    await expect(stat(path.join(directory, READY_FILE))).rejects.toThrow();
  });

  it('ends the host when the server goes away', async () => {
    const { port, sandbox } = await start({ PATH: binary });
    await writeFile(path.join(directory, MANIFEST_FILE), manifestFor(PINNED));
    const host = await sandbox;
    await writeFile(path.join(directory, TOKENS_FILE), JSON.stringify([TOKEN]));
    void post(port, TOKEN, ENDPOINT, {
      method: 'tools/call',
      params: { name: 'die', arguments: {} },
    }).catch(() => undefined);
    await expect(host.closed).resolves.toBeUndefined();
  });

  it('sends the server egress through the proxy, which no declared secret can bypass, and stops cleanly', async () => {
    // A proxy that allows only `allowed.test`, whose "public" address is really a local upstream.
    const reached: string[] = [];
    const denied: unknown[] = [];
    const upstream = createHttpServer((req, res) => {
      reached.push(req.headers.host ?? '');
      res.end('upstream');
    });
    const proxy = createEgressProxy({
      sessionId: 'session-1',
      allowlist: parseAllowlist(['allowed.test']),
      resolve: () => Promise.resolve(['93.184.216.34']),
      dial: () => connect({ host: '127.0.0.1', port: (upstream.address() as AddressInfo).port }),
      writeLog: (line) => denied.push(JSON.parse(line)),
    });
    const listening = (server: typeof upstream) =>
      new Promise<number>((resolve) => {
        server.listen(0, '127.0.0.1', () => {
          resolve((server.address() as AddressInfo).port);
        });
      });
    await listening(upstream);
    const proxyUrl = `http://127.0.0.1:${String(await listening(proxy))}`;
    try {
      const { port, errors, sandbox } = await start({
        PATH: binary,
        HTTP_PROXY: proxyUrl,
        HTTPS_PROXY: proxyUrl,
        NODE_USE_ENV_PROXY: '1',
      });
      await writeFile(
        path.join(directory, MANIFEST_FILE),
        manifestFor(PINNED, {
          NO_PROXY: '*',
          HTTPS_PROXY: 'http://attacker.invalid',
          NPM_CONFIG_REGISTRY: 'http://registry.invalid',
        }),
      );
      const host = await sandbox;
      await writeFile(path.join(directory, TOKENS_FILE), JSON.stringify([TOKEN]));
      const callTool = async (name: string, args: Record<string, unknown>) => {
        const answer = await post(port, TOKEN, ENDPOINT, {
          method: 'tools/call',
          params: { name, arguments: args },
        });
        return (JSON.parse(answer.body) as { result: { content: { text: string }[] } }).result
          .content[0]?.text;
      };

      const launch = JSON.parse((await callTool('inspect', {})) ?? '') as {
        env: Record<string, string>;
      };
      expect(launch.env).not.toHaveProperty('NO_PROXY');
      expect(launch.env).not.toHaveProperty('NPM_CONFIG_REGISTRY');
      expect(launch.env['HTTPS_PROXY']).toBe(proxyUrl);
      expect(launch.env['HTTP_PROXY']).toBe(proxyUrl);

      expect(await callTool('fetch_url', { url: 'http://allowed.test/' })).toBe('200 upstream');
      expect(await callTool('fetch_url', { url: 'http://denied.test/' })).not.toMatch(/^200 /u);
      expect(reached).toEqual(['allowed.test']);
      expect(denied).toEqual([
        expect.objectContaining({ host: 'denied.test', reason: 'host_not_allowed' }),
      ]);

      // A graceful stop is not a server that went away.
      stop.abort();
      await host.closed;
      expect(errors.join('')).not.toContain('exited');
    } finally {
      proxy.closeAllConnections();
      upstream.closeAllConnections();
      await Promise.all([
        new Promise((resolve) => proxy.close(resolve)),
        new Promise((resolve) => upstream.close(resolve)),
      ]);
    }
  });
});
