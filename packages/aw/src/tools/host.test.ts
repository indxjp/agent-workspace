import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { startToolHost, type ToolHost } from './host.js';

// These tests start a real child process (the project loader or the tool host): a second or more
// each on a shared CI runner, past vitest's 5 s default when several run.
vi.setConfig({ testTimeout: 30_000 });

// What `defineTool` makes: a declaration branded as a code tool (the tmp project cannot import the SDK).
const declaration = (name: string, run: string, timeoutMs = 5000, inputSchema?: unknown): string =>
  `const tool = ${JSON.stringify({
    name,
    description: `the ${name} tool`,
    inputSchema: inputSchema ?? {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
    run,
    limits: { timeoutMs },
  })};
Object.defineProperty(tool, Symbol.for('agentworkspace.dev/define'), { value: 'code' });
export default tool;
`;

const RUN = `export default async ({ id }, { signal, runId, agent }) => {
  if (id === 'boom') throw new Error('order boom exploded');
  if (id === 'hang') await new Promise((resolve) => signal.addEventListener('abort', resolve));
  console.log('looking up ' + id);
  return { id, runId, agent };
};\n`;

let root = '';
let stop: AbortController;
let errors: string[];
let hosts: ToolHost[];

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'aw-tool-host-'));
  await mkdir(path.join(root, 'tools'));
  stop = new AbortController();
  errors = [];
  hosts = [];
});

afterEach(async () => {
  stop.abort();
  await Promise.all(hosts.map((host) => host.closed));
  await rm(root, { recursive: true, force: true });
});

async function open(url: string, headers: Record<string, string> = {}): Promise<Client> {
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } }),
  );
  return client;
}

const start = async () => {
  const host = await startToolHost({
    root,
    io: { env: process.env, stderr: (text) => errors.push(text) },
    signal: stop.signal,
  });
  hosts.push(host);
  return host;
};

describe('startToolHost', () => {
  it('serves a tool over MCP with its context, and prefixes its output', async () => {
    await writeFile(
      path.join(root, 'tools', 'get-order.ts'),
      declaration('get_order', './tools/get-order.run.js'),
    );
    await writeFile(path.join(root, 'tools', 'get-order.run.js'), RUN);
    const host = await start();
    expect(host.tools()).toEqual(['get_order']);
    expect(host.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{48}\/mcp$/u);

    const client = await open(host.url, { 'x-aw-run-id': 'run_1', 'x-aw-agent': 'assistant' });
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(['get_order']);
    const ok = await client.callTool({ name: 'get_order', arguments: { id: 'A-1' } });
    expect(ok.content).toEqual([
      { type: 'text', text: JSON.stringify({ id: 'A-1', runId: 'run_1', agent: 'assistant' }) },
    ]);
    expect(errors.join('')).toContain('[tool get_order] looking up A-1');
    await client.close();
  });

  it('decodes a percent-encoded agent name into the tool context', async () => {
    await writeFile(
      path.join(root, 'tools', 'get-order.ts'),
      declaration('get_order', './tools/get-order.run.js'),
    );
    await writeFile(path.join(root, 'tools', 'get-order.run.js'), RUN);
    const client = await open((await start()).url, {
      'x-aw-run-id': 'run_1',
      'x-aw-agent': encodeURIComponent('サポート'),
    });
    const ok = await client.callTool({ name: 'get_order', arguments: { id: 'A-1' } });
    expect(ok.content).toEqual([
      { type: 'text', text: JSON.stringify({ id: 'A-1', runId: 'run_1', agent: 'サポート' }) },
    ]);
    await client.close();
  });

  it('turns a thrown error and a timeout into MCP tool errors', async () => {
    await writeFile(
      path.join(root, 'tools', 'get-order.ts'),
      declaration('get_order', './tools/get-order.run.js', 200),
    );
    await writeFile(path.join(root, 'tools', 'get-order.run.js'), RUN);
    const client = await open((await start()).url);
    const thrown = await client.callTool({ name: 'get_order', arguments: { id: 'boom' } });
    expect(thrown).toMatchObject({ isError: true, content: [{ text: 'order boom exploded' }] });
    const slow = await client.callTool({ name: 'get_order', arguments: { id: 'hang' } });
    expect(slow).toMatchObject({
      isError: true,
      content: [{ text: 'get_order timed out after 200 ms' }],
    });
    const invalid = await client.callTool({ name: 'get_order', arguments: {} });
    expect(invalid.isError).toBe(true);
    await client.close();
  });

  it('names the project-relative rule when run is written relative to the declaration', async () => {
    await writeFile(
      path.join(root, 'tools', 'get-order.ts'),
      declaration('get_order', './get-order.run.js'),
    );
    await writeFile(path.join(root, 'tools', 'get-order.run.js'), RUN);
    const host = await start();
    expect(host.tools()).toEqual([]);
    expect(errors.join('')).toContain(
      "run './get-order.run.js' not found: run is project-relative; did you mean './tools/get-order.run.js'?",
    );
  });

  it('refuses a non-declaration, a run without a function, an unreadable schema and a run outside the project', async () => {
    const tools = path.join(root, 'tools');
    const outside = `${path.basename(root)}-outside.run.js`;
    await writeFile(
      path.join(tools, 'helper.ts'),
      'export default { name: "x", run: "./y.ts" };\n',
    );
    await writeFile(path.join(tools, 'no-fn.ts'), declaration('no_fn', './tools/no-fn.run.js'));
    await writeFile(path.join(tools, 'no-fn.run.js'), 'export default 1;\n');
    await writeFile(
      path.join(tools, 'bad-schema.ts'),
      declaration('bad_schema', './tools/ok.run.js', 5000, { type: 'object', $ref: '#/nope' }),
    );
    await writeFile(path.join(tools, 'ok.run.js'), 'export default () => 1;\n');
    await writeFile(path.join(tools, 'out.ts'), declaration('out', `../${outside}`));
    await writeFile(path.join(root, '..', outside), 'export default () => 1;\n');
    const host = await start();
    expect(host.tools()).toEqual([]);
    const log = errors.join('');
    expect(log).toContain(
      `${path.join('tools', 'no-fn.ts')}: ./tools/no-fn.run.js must export a function as its default`,
    );
    expect(log).toContain(
      `${path.join('tools', 'bad-schema.ts')}: its input schema cannot be read for validation`,
    );
    expect(log).toContain(`${path.join('tools', 'out.ts')}: ../${outside} is outside the project`);
    await rm(path.join(root, '..', outside), { force: true });
    expect(log).not.toContain('helper.ts');
  });

  it('answers an unknown tool with an MCP tool error and aborts the signal of a cancelled call', async () => {
    await writeFile(
      path.join(root, 'tools', 'get-order.ts'),
      declaration('get_order', './tools/get-order.run.js'),
    );
    await writeFile(path.join(root, 'tools', 'get-order.run.js'), RUN);
    const host = await start();
    const client = await open(host.url);
    expect(await client.callTool({ name: 'nope', arguments: {} })).toMatchObject({
      isError: true,
      content: [{ text: 'unknown tool nope' }],
    });
    // A caller that hangs up cancels the call: the run's signal aborts.
    const abort = new AbortController();
    const pending = fetch(host.url, {
      method: 'POST',
      signal: abort.signal,
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'get_order', arguments: { id: 'hang' } },
      }),
    });
    setTimeout(() => abort.abort(), 200);
    await expect(pending).rejects.toThrow();
    // The run saw its signal abort (it resumes from `hang` and logs).
    for (let i = 0; i < 50 && !errors.join('').includes('looking up hang'); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(errors.join('')).toContain('[tool get_order] looking up hang');
    await client.close();
  });

  it('says on stderr that the child exited, and that a save restarts it', async () => {
    await writeFile(
      path.join(root, 'tools', 'get-order.ts'),
      declaration('get_order', './tools/get-order.run.js'),
    );
    await writeFile(
      path.join(root, 'tools', 'get-order.run.js'),
      'export default () => process.exit(3);\n',
    );
    const client = await open((await start()).url);
    await client.callTool({ name: 'get_order', arguments: { id: 'x' } }).catch(() => undefined);
    for (let i = 0; i < 50 && !errors.join('').includes('[tool host] exited'); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(errors.join('')).toContain('[tool host] exited (code 3); save a file to restart it');
    await client.close().catch(() => undefined);
  });

  it('refuses a request on any other path', async () => {
    const host = await start();
    const response = await fetch(host.url.replace(/\/[0-9a-f]{48}\//u, '/wrong/'), {
      method: 'POST',
    });
    expect(response.status).toBe(404);
  });

  it('restarts on the same URL when a run file changes', async () => {
    await writeFile(
      path.join(root, 'tools', 'get-order.ts'),
      declaration('get_order', './tools/get-order.run.js'),
    );
    await writeFile(path.join(root, 'tools', 'get-order.run.js'), 'export default () => 1;\n');
    const host = await start();
    const first = await open(host.url);
    expect((await first.callTool({ name: 'get_order', arguments: { id: 'x' } })).content).toEqual([
      { type: 'text', text: '1' },
    ]);
    await first.close();

    await writeFile(path.join(root, 'tools', 'get-order.run.js'), 'export default () => 2;\n');
    let text = '';
    for (let attempt = 0; attempt < 50 && text !== '2'; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const client = await open(host.url).catch(() => undefined);
      const result = await client
        ?.callTool({ name: 'get_order', arguments: { id: 'x' } })
        .catch(() => undefined);
      text = (result?.content as { text: string }[] | undefined)?.[0]?.text ?? '';
      await client?.close().catch(() => undefined);
    }
    expect(text).toBe('2');
  });
});

describe('startToolHost, hosted (issue #791)', () => {
  const TOKEN = 'run-token-1';
  const ENV_RUN = `export default async (input, { runId }) => ({
  runId,
  env: Object.keys(process.env).sort(),
  secret: process.env.ORDERS_API_KEY,
});\n`;

  async function port(): Promise<number> {
    return new Promise((resolve) => {
      const probe = createServer();
      probe.listen(0, '127.0.0.1', () => {
        const address = probe.address();
        const free = typeof address === 'object' && address !== null ? address.port : 0;
        probe.close(() => {
          resolve(free);
        });
      });
    });
  }

  async function startHosted(tokens: readonly string[], source = ENV_RUN) {
    const tokensFile = path.join(root, 'tokens.json');
    await writeFile(tokensFile, JSON.stringify(tokens));
    const file = path.join(root, 'get-order.mjs');
    await writeFile(file, source);
    const host = await startToolHost({
      root,
      io: { env: { ORDERS_API_KEY: 'orders-secret' }, stderr: (text) => errors.push(text) },
      signal: stop.signal,
      hosted: {
        host: '127.0.0.1',
        port: await port(),
        tokensFile,
        tools: [
          {
            name: 'get_order',
            description: 'Look up an order',
            inputSchema: { type: 'object', properties: { id: { type: 'string' } } },
            timeoutMs: 5000,
            file,
          },
        ],
      },
    });
    hosts.push(host);
    return { host, tokensFile };
  }

  it('serves only the listed tools to a bearer token, with exactly the environment it was given', async () => {
    const { host } = await startHosted([TOKEN]);
    expect(host.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/u);
    expect(host.tools()).toEqual(['get_order']);

    const client = await open(host.url, {
      authorization: `Bearer ${TOKEN}`,
      'x-aw-run-id': 'run_1',
    });
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(['get_order']);
    const ok = await client.callTool({ name: 'get_order', arguments: { id: 'A-1' } });
    expect(JSON.parse((ok.content as { text: string }[])[0]?.text ?? '')).toEqual({
      runId: 'run_1',
      env: ['ORDERS_API_KEY'],
      secret: 'orders-secret',
    });
    const unknown = await client.callTool({ name: 'other', arguments: {} });
    expect(unknown).toMatchObject({ isError: true });
    await client.close();
  });

  it('refuses a missing, wrong or revoked token, and the local path form', async () => {
    const { host, tokensFile } = await startHosted([TOKEN]);
    // One connection per request: a refusal answers before the body is read, which ends keep-alive.
    const post = (url: string, authorization?: string) =>
      new Promise<number | undefined>((resolve, reject) => {
        const request = httpRequest(
          url,
          {
            method: 'POST',
            agent: false,
            headers: {
              'content-type': 'application/json',
              accept: 'application/json, text/event-stream',
              ...(authorization === undefined ? {} : { authorization }),
            },
          },
          (response) => {
            response.resume();
            resolve(response.statusCode);
          },
        );
        request.on('error', reject);
        request.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }));
      });
    expect(await post(host.url)).toBe(401);
    expect(await post(host.url, 'Bearer nope')).toBe(401);
    expect(await post(host.url, `Basic ${TOKEN}`)).toBe(401);
    expect(await post(host.url.replace('/mcp', `/${TOKEN}/mcp`), `Bearer ${TOKEN}`)).toBe(404);
    await writeFile(tokensFile, '[]');
    expect(await post(host.url, `Bearer ${TOKEN}`)).toBe(401);
    await writeFile(tokensFile, 'not json');
    expect(await post(host.url, `Bearer ${TOKEN}`)).toBe(401);
    await writeFile(tokensFile, JSON.stringify([TOKEN]));
    expect(await post(host.url, `Bearer ${TOKEN}`)).toBe(200);
  });

  it('settles closed when its child dies on its own', async () => {
    const { host } = await startHosted([TOKEN], 'process.exit(3);\nexport default () => 1;\n');
    await host.closed;
    expect(errors.join('')).toContain('exited (code 3)');
  });

  it('never listens when a declared bundle fails to load, and settles closed', async () => {
    const { host } = await startHosted([TOKEN], 'export default 42;\n');
    await host.closed;
    expect(host.tools()).toEqual([]);
    expect(errors.join('')).toContain('get_order: its bundle must export a function');
    expect(errors.join('')).toContain('exited (code 1)');
    const refused = await fetch(host.url, { method: 'POST' }).then(
      () => false,
      () => true,
    );
    expect(refused).toBe(true);
  });
});
