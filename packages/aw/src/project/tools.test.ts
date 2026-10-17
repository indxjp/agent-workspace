import { createHash } from 'node:crypto';
import { rm, symlink } from 'node:fs/promises';
import path from 'node:path';

import { OPENAPI_DOCUMENT_MAX_BYTES } from '@indx-workspace/contracts/tool-connectors';
import { createClient } from '@indx-workspace/sdk';
import type { OpenApiToolDefinition } from '@indx-workspace/sdk/define';
import { fixtures } from '@indx-workspace/sdk/testing';
import { afterAll, describe, expect, it } from 'vitest';

import type { CliIo } from '../io.js';
import { json, tempDirectory, tempFile } from '../testing.js';
import type { LoadedTool } from './load.js';
import { checkTools, readToolDocument } from './tools.js';

/**
 * Issue #549: a tool's OpenAPI document is read from the project or fetched over https, and
 * `aw check` dry-runs each tool connector without ever sending a secret's value.
 */

const DOCUMENT = '{"openapi":"3.1.0","info":{"title":"Orders","version":"1"},"paths":{}}';
const SENTINEL = 'sentinel-orders-token';
const SPEC_URL = 'https://specs.example.com/orders.json';

const directories: string[] = [];

afterAll(async () => {
  await Promise.all(
    directories.map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function scratch(): Promise<string> {
  const directory = await tempDirectory();
  directories.push(directory);
  return directory;
}

function ioWith(
  fetchImpl: typeof fetch,
  env: CliIo['env'] = {},
): CliIo & { stderrText: () => string } {
  let stderr = '';
  return {
    stdin: () => Promise.resolve(''),
    stdout: () => undefined,
    stderr: (text) => {
      stderr += text;
    },
    env,
    homeDir: '/nonexistent-home',
    fetch: fetchImpl,
    isTty: false,
    stderrText: () => stderr,
  };
}

const noFetch: typeof fetch = () => Promise.reject(new Error('no network'));

function read(spec: string, root: string, fetchImpl: typeof fetch = noFetch, timeoutMs?: number) {
  return readToolDocument(spec, {
    root,
    io: ioWith(fetchImpl),
    signal: new AbortController().signal,
    timeoutMs,
  });
}

/** A fetch double answering `response` for the spec URL. */
function answering(response: () => Response): typeof fetch {
  return () => Promise.resolve(response());
}

describe('readToolDocument (issue #549)', () => {
  it('reads a project path and digests the UTF-8 text', async () => {
    const root = await scratch();
    await tempFile(root, 'apis/orders.openapi.json', DOCUMENT);
    expect(await read('apis/orders.openapi.json', root)).toEqual({
      ok: true,
      document: DOCUMENT,
      digest: `sha256:${createHash('sha256').update(DOCUMENT, 'utf8').digest('hex')}`,
    });
  });

  it('refuses a link out of the project', async () => {
    const outside = await scratch();
    const root = await scratch();
    await tempFile(outside, 'secret.json', DOCUMENT);
    await tempFile(root, 'apis/.keep', '');
    await symlink(path.join(outside, 'secret.json'), path.join(root, 'apis', 'orders.json'));
    expect(await read('apis/orders.json', root)).toEqual({
      ok: false,
      code: 'tool_spec_unreadable',
      detail: 'apis/orders.json: the file is outside the project',
    });
  });

  it('refuses a file over 1 MiB as connector_spec_invalid', async () => {
    const root = await scratch();
    await tempFile(root, 'big.json', new Uint8Array(OPENAPI_DOCUMENT_MAX_BYTES + 1));
    expect(await read('big.json', root)).toEqual({
      ok: false,
      code: 'connector_spec_invalid',
      detail: 'spec: larger than 1 MiB',
    });
  });

  it('refuses a file that is not UTF-8', async () => {
    const root = await scratch();
    await tempFile(root, 'bad.json', new Uint8Array([0x7b, 0xff, 0x7d]));
    expect(await read('bad.json', root)).toMatchObject({
      ok: false,
      code: 'tool_spec_unreadable',
      detail: 'bad.json: not UTF-8 text',
    });
  });

  it('fetches an https spec', async () => {
    const root = await scratch();
    const result = await read(
      SPEC_URL,
      root,
      answering(() => new Response(DOCUMENT)),
    );
    expect(result).toMatchObject({ ok: true, document: DOCUMENT });
  });

  it('refuses a 404, a downgrading redirect and a body over 1 MiB', async () => {
    const root = await scratch();
    expect(
      await read(
        SPEC_URL,
        root,
        answering(() => new Response('gone', { status: 404 })),
      ),
    ).toEqual({ ok: false, code: 'tool_spec_unreadable', detail: `${SPEC_URL}: answered 404` });

    const downgraded = (): Response => {
      const response = new Response(DOCUMENT);
      Object.defineProperty(response, 'url', { value: 'http://specs.example.com/orders.json' });
      return response;
    };
    expect(await read(SPEC_URL, root, answering(downgraded))).toEqual({
      ok: false,
      code: 'tool_spec_unreadable',
      detail: `${SPEC_URL}: redirected to a URL that is not https`,
    });

    let pulled = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(new Uint8Array(64 * 1024));
      },
    });
    expect(
      await read(
        SPEC_URL,
        root,
        answering(() => new Response(endless)),
      ),
    ).toEqual({
      ok: false,
      code: 'connector_spec_invalid',
      detail: 'spec: larger than 1 MiB',
    });
    // Abandoned at the cap: never more than the cap and one chunk was read.
    expect(pulled).toBeLessThanOrEqual(OPENAPI_DOCUMENT_MAX_BYTES / (64 * 1024) + 2);
  });

  it('gives up on a fetch that never answers at the timeout', async () => {
    const root = await scratch();
    const hanging: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted.', 'AbortError'));
        });
      });
    expect(await read(SPEC_URL, root, hanging, 50)).toEqual({
      ok: false,
      code: 'tool_spec_unreadable',
      detail: `${SPEC_URL}: timed out after 50 ms`,
    });
  });
});

interface Recorded {
  readonly method: string;
  readonly path: string;
  readonly body: string;
}

const ORDERS_DEFINITION: OpenApiToolDefinition = {
  kind: 'openapi',
  name: 'orders',
  spec: 'apis/orders.openapi.json',
  allow: ['GET /orders/*'],
  auth: 'bearer',
  credential: { secret: 'ORDERS_TOKEN' },
};

const ORDERS: LoadedTool = { file: 'tools/orders.ts', definition: ORDERS_DEFINITION };

const ORDERS_DB: LoadedTool = {
  file: 'tools/db.ts',
  definition: {
    kind: 'postgres',
    name: 'orders-db',
    credential: { secret: 'ORDERS_DB_URL' },
    tables: ['public.orders'],
    readOnly: true,
  },
};

const VALID = {
  ok: true,
  kind: 'ok',
  message: 'The openapi connector is valid; nothing was saved.',
  serverName: 'Orders',
  serverVersion: null,
  toolCount: 1,
};

async function check(
  tools: readonly LoadedTool[],
  env: CliIo['env'],
  existing: readonly unknown[] = [],
): Promise<{ readonly calls: Recorded[]; readonly stderr: string; readonly problems: unknown }> {
  const root = await scratch();
  await tempFile(root, 'apis/orders.openapi.json', DOCUMENT);
  const calls: Recorded[] = [];
  const fetchImpl: typeof fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = init?.method ?? 'GET';
    calls.push({
      method,
      path: url.pathname,
      body: typeof init?.body === 'string' ? init.body : '',
    });
    return Promise.resolve(
      method === 'GET' ? json(200, { connectors: existing }) : json(200, VALID),
    );
  };
  const io = ioWith(fetchImpl, env);
  const client = createClient({
    baseUrl: 'http://127.0.0.1:3000',
    auth: { kind: 'api-key', apiKey: `ak_live_${'A'.repeat(22)}_${'S'.repeat(43)}` },
    fetch: fetchImpl,
  });
  const problems = await checkTools(
    { client, root, io, signal: new AbortController().signal },
    tools,
  );
  return { calls, stderr: io.stderrText(), problems };
}

describe('checkTools (issue #549)', () => {
  it('dry-runs an openapi tool with the placeholder, never the secret value (C10)', async () => {
    const { calls, problems } = await check([ORDERS], { ORDERS_TOKEN: SENTINEL });
    expect(problems).toEqual([]);
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      'GET /api/connectors',
      'POST /api/connectors',
    ]);
    expect(JSON.parse(calls[1]?.body ?? '')).toEqual({
      kind: 'openapi',
      name: 'orders',
      document: DOCUMENT,
      allow: ['GET /orders/*'],
      auth: 'bearer',
      credential: 'aw-check-placeholder',
      dryRun: true,
    });
    expect(calls.some((call) => call.body.includes(SENTINEL))).toBe(false);
  });

  it('dry-runs a PATCH of the connector the workspace already has', async () => {
    const existing = fixtures.openApiConnector({ name: 'orders' });
    const { calls } = await check([ORDERS], {}, [existing]);
    expect(calls[1]?.method).toBe('PATCH');
    expect(calls[1]?.path).toBe(`/api/connectors/${existing.id}`);
  });

  it('prints the C10 notice for an unset postgres URL and sends nothing for it', async () => {
    const { calls, stderr, problems } = await check([ORDERS_DB], {});
    expect(problems).toEqual([]);
    expect(stderr).toBe(
      'notice: ORDERS_DB_URL is not set: run export ORDERS_DB_URL=… in the shell aw dev started from, then restart aw dev\n',
    );
    expect(calls.map((call) => call.method)).toEqual(['GET']);
  });

  it("says an unreadable document against the tool's file", async () => {
    const { calls, problems } = await check(
      [{ ...ORDERS, definition: { ...ORDERS_DEFINITION, spec: 'apis/missing.json' } }],
      {},
    );
    expect(problems).toEqual([
      {
        file: 'tools/orders.ts',
        status: null,
        code: 'tool_spec_unreadable',
        details: ['apis/missing.json: no such file'],
      },
    ]);
    expect(calls.map((call) => call.method)).toEqual(['GET']);
  });
});
