import { createHash } from 'node:crypto';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { request } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runIntakeSandbox } from './intake.js';
import { MANIFEST_FILE, READY_FILE } from './sandbox.js';

const KEY = 'intake-key-0123456789abcdef0123456789';
const TOKEN = 'run-token-0123456789abcdef';
const SECRET = 'sk-live-do-not-print-0123456789';
const RUN = `export default async ({ id }) => ({ id, secret: process.env.ORDERS_API_KEY });\n`;

const manifest = JSON.stringify({
  tools: [
    {
      name: 'get_order',
      description: 'Looks up an order.',
      inputSchema: { type: 'object', properties: { id: { type: 'string' } } },
      timeoutMs: 5_000,
      digest: createHash('sha256').update(Buffer.from(RUN)).digest('hex'),
      bundleBase64: Buffer.from(RUN).toString('base64'),
    },
  ],
  env: { ORDERS_API_KEY: SECRET },
});

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

function send(
  port: number,
  method: string,
  url: string,
  headers: Record<string, string>,
  body?: string,
): Promise<{ status: number | undefined; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      `http://127.0.0.1:${String(port)}${url}`,
      { method, agent: false, headers },
      (response) => {
        let text = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => (text += chunk));
        response.on('end', () => {
          resolve({ status: response.statusCode, body: text });
        });
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

const put = (port: number, name: string, body: string, key: string | null = KEY) =>
  send(port, 'PUT', `/files/${name}`, key === null ? {} : { 'x-aw-tool-intake': key }, body);

const mcp = (port: number, bearer: string | undefined) =>
  send(
    port,
    'POST',
    '/mcp',
    {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(bearer === undefined ? {} : { authorization: `Bearer ${bearer}` }),
    },
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'get_order', arguments: { id: 'A-1' } },
    }),
  );

let directory = '';
let stop: AbortController;
let closed: Promise<void>[];

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'aw-tool-intake-'));
  stop = new AbortController();
  closed = [];
});

afterEach(async () => {
  stop.abort();
  await Promise.all(closed);
  await rm(directory, { recursive: true, force: true });
});

describe('runIntakeSandbox', () => {
  async function start(maxBodyBytes?: number, root = directory) {
    const port = await freePort();
    const errors: string[] = [];
    const sandbox = runIntakeSandbox({
      directory: root,
      host: '127.0.0.1',
      port,
      stderr: (text) => errors.push(text),
      signal: stop.signal,
      intakeKey: KEY,
      ...(maxBodyBytes === undefined ? {} : { maxBodyBytes }),
    });
    // The listener is up before any file arrives.
    for (;;) {
      try {
        await send(port, 'GET', '/', {});
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    sandbox.catch(() => undefined);
    return { port, errors, sandbox };
  }

  it('answers 503 before the host is ready, and 401 or 413 to a bad upload', async () => {
    const { port, sandbox } = await start(1_000);
    expect(await send(port, 'GET', '/healthz', {})).toEqual({
      status: 503,
      body: '{"error":"tool_host_not_ready"}',
    });
    expect((await send(port, 'GET', '/ping', {})).status).toBe(200);
    expect((await mcp(port, TOKEN)).status).toBe(503);
    const wrong = await put(port, 'tokens.json', '[]', 'x'.repeat(KEY.length));
    expect(wrong).toEqual({ status: 401, body: '{"error":"tool_intake_unauthorized"}' });
    expect((await put(port, 'tokens.json', '[]', 'short')).status).toBe(401);
    expect((await put(port, 'tokens.json', '[]', null)).status).toBe(401);
    expect((await put(port, 'tokens.json', JSON.stringify(['a'.repeat(2_000)]))).status).toBe(413);
    expect((await put(port, 'tokens.json', '{"not":"an array"}')).status).toBe(400);
    expect((await put(port, 'tokens.json', '[1]')).status).toBe(400);
    expect((await put(port, MANIFEST_FILE, '{}')).status).toBe(400);
    stop.abort();
    await expect(sandbox).rejects.toThrow();
  });

  it('creates a directory no provider mounted before it takes a file', async () => {
    // Cloud Run mounts nothing: the driver names a directory under /tmp that does not exist yet.
    const root = path.join(directory, 'tool-host');
    const { port, sandbox } = await start(undefined, root);
    expect((await stat(root)).isDirectory()).toBe(true);
    expect((await put(port, MANIFEST_FILE, manifest)).status).toBe(204);
    const host = await sandbox;
    closed.push(host.closed);
    await expect(stat(path.join(root, READY_FILE))).resolves.toBeTruthy();
  });

  it('takes the manifest once, serves a tool to a token, and revokes a replaced token', async () => {
    const { port, sandbox } = await start();
    expect((await put(port, MANIFEST_FILE, manifest)).status).toBe(204);
    expect(await put(port, MANIFEST_FILE, manifest)).toEqual({
      status: 409,
      body: '{"error":"tool_intake_manifest_taken"}',
    });
    const host = await sandbox;
    closed.push(host.closed);
    await expect(stat(path.join(directory, READY_FILE))).resolves.toBeTruthy();
    await expect(stat(path.join(directory, MANIFEST_FILE))).rejects.toThrow();
    // Still taken once the host runs.
    expect((await put(port, MANIFEST_FILE, manifest)).status).toBe(409);

    // The host's own refusal is reached through the proxy.
    expect((await mcp(port, undefined)).status).toBe(401);
    expect((await mcp(port, TOKEN)).status).toBe(401);
    expect((await put(port, 'tokens.json', JSON.stringify([TOKEN]))).status).toBe(204);
    const answer = await mcp(port, TOKEN);
    expect(answer.status).toBe(200);
    expect(answer.body).toContain(SECRET);
    expect((await put(port, 'tokens.json', JSON.stringify(['other-token']))).status).toBe(204);
    expect((await mcp(port, TOKEN)).status).toBe(401);
    expect((await mcp(port, 'other-token')).status).toBe(200);
    // The key is never forwarded and an unauthorised upload is never proxied.
    expect((await put(port, 'tokens.json', '[]', 'wrong')).status).toBe(401);
  });
});
