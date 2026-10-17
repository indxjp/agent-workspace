import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  MANIFEST_FILE,
  ManifestError,
  READY_FILE,
  TOKENS_FILE,
  parseManifest,
  runSandbox,
  writeBundles,
} from './sandbox.js';

const SECRET = 'sk-live-do-not-print-0123456789';
const TOKEN = 'run-token-0123456789abcdef';

const RUN = `export default async ({ id }) => ({
  id,
  env: Object.keys(process.env).sort(),
  secret: process.env.ORDERS_API_KEY,
});\n`;

const digestOf = (source: string): string =>
  createHash('sha256').update(Buffer.from(source)).digest('hex');

const manifestFor = (source: string, env: Record<string, string> = {}): string =>
  JSON.stringify({
    tools: [
      {
        name: 'get_order',
        description: 'Looks up an order.',
        inputSchema: { type: 'object', properties: { id: { type: 'string' } } },
        timeoutMs: 5_000,
        digest: digestOf(source),
        bundleBase64: Buffer.from(source).toString('base64'),
      },
    ],
    env,
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

/** One MCP request over a connection of its own: a refusal ends keep-alive before the body is read. */
function call(
  port: number,
  token: string,
  params: Record<string, unknown>,
): Promise<{ status: number | undefined; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      `http://127.0.0.1:${String(port)}/mcp`,
      {
        method: 'POST',
        agent: false,
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: `Bearer ${token}`,
        },
      },
      (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => (body += chunk));
        response.on('end', () => {
          resolve({ status: response.statusCode, body });
        });
      },
    );
    req.on('error', reject);
    req.end(JSON.stringify({ jsonrpc: '2.0', id: 1, ...params }));
  });
}

let directory = '';
let stop: AbortController;
let closed: Promise<void>[];

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'aw-tool-sandbox-'));
  stop = new AbortController();
  closed = [];
});

afterEach(async () => {
  stop.abort();
  await Promise.all(closed);
  await rm(directory, { recursive: true, force: true });
});

describe('parseManifest', () => {
  it('refuses a manifest that is not valid without printing a value in it', () => {
    expect(() => parseManifest('not json')).toThrow(ManifestError);
    const invalid = JSON.stringify({ tools: [], env: { ORDERS_API_KEY: SECRET } });
    let message = '';
    try {
      parseManifest(invalid);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('tools');
    expect(message).not.toContain(SECRET);
  });

  it('refuses an environment name that is not a secret name', () => {
    const raw = JSON.parse(manifestFor(RUN)) as Record<string, unknown>;
    raw['env'] = { 'not a name': SECRET };
    expect(() => parseManifest(JSON.stringify(raw))).toThrow(ManifestError);
  });
});

describe('writeBundles', () => {
  it('refuses a bundle that is not the program its digest names, and writes nothing for it', async () => {
    const raw = JSON.parse(manifestFor(RUN)) as { tools: { digest: string }[] };
    raw.tools[0]!.digest = digestOf('export default () => 1;\n');
    const dir = path.join(directory, 'bundles');
    await expect(writeBundles(parseManifest(JSON.stringify(raw)), dir)).rejects.toThrow(
      /is not the program/u,
    );
    expect(await readdir(dir)).toEqual([]);
  });
});

describe('runSandbox', () => {
  async function start() {
    const port = await freePort();
    const errors: string[] = [];
    const sandbox = runSandbox({
      directory,
      host: '127.0.0.1',
      port,
      stderr: (text) => errors.push(text),
      signal: stop.signal,
    });
    return { port, errors, sandbox };
  }

  it('serves a tool to a bearer token with exactly the declared secrets, and keeps no file of them', async () => {
    const { port, sandbox } = await start();
    await writeFile(
      path.join(directory, MANIFEST_FILE),
      manifestFor(RUN, { ORDERS_API_KEY: SECRET }),
    );
    const host = await sandbox;
    closed.push(host.closed);
    await expect(stat(path.join(directory, READY_FILE))).resolves.toBeTruthy();
    await expect(stat(path.join(directory, MANIFEST_FILE))).rejects.toThrow();

    const getOrder = {
      method: 'tools/call',
      params: { name: 'get_order', arguments: { id: 'A-1' } },
    };
    // Nothing is admitted before the runner registers a token.
    expect((await call(port, TOKEN, getOrder)).status).toBe(401);
    await writeFile(path.join(directory, TOKENS_FILE), JSON.stringify([TOKEN]));
    const answer = await call(port, TOKEN, getOrder);
    expect(answer.status).toBe(200);
    const result = JSON.parse(answer.body) as { result: { content: { text: string }[] } };
    expect(JSON.parse(result.result.content[0]?.text ?? '')).toEqual({
      id: 'A-1',
      env: ['ORDERS_API_KEY'],
      secret: SECRET,
    });
    // A revoked token stops being admitted.
    await writeFile(path.join(directory, TOKENS_FILE), '[]');
    expect((await call(port, TOKEN, getOrder)).status).toBe(401);
  });

  it('waits out a manifest that is only half uploaded instead of refusing it', async () => {
    const { sandbox } = await start();
    const full = manifestFor(RUN, { ORDERS_API_KEY: SECRET });
    await writeFile(path.join(directory, MANIFEST_FILE), full.slice(0, full.length / 2));
    await new Promise((resolve) => setTimeout(resolve, 250));
    await writeFile(path.join(directory, MANIFEST_FILE), full);
    const host = await sandbox;
    closed.push(host.closed);
    await expect(stat(path.join(directory, READY_FILE))).resolves.toBeTruthy();
  });

  it('refuses to start when a bundle does not serve, and reports it', async () => {
    const { sandbox } = await start();
    await writeFile(path.join(directory, MANIFEST_FILE), manifestFor('export default 1;\n'));
    await expect(sandbox).rejects.toThrow(/did not serve get_order/u);
    await expect(stat(path.join(directory, READY_FILE))).rejects.toThrow();
  });
});
