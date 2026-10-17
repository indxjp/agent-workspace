import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  OpenApiToolConfigSchema,
  type OpenApiToolConfig,
} from '@indx-workspace/contracts/tool-connectors';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ToolParameter } from './authorize.js';
import { callTool, listTools, TOOL_RESPONSE_MAX_BYTES } from './openapi.js';

const LOCAL = { production: false, allowHosts: [] } as const;
const CREDENTIAL = 'fixture-tool-credential';

type Seen = { readonly url: string; readonly headers: IncomingHttpHeaders };
const seen: Seen[] = [];
let server: Server;
let baseUrl = '';

beforeAll(async () => {
  server = createServer((request, response) => {
    seen.push({ url: request.url ?? '', headers: request.headers });
    const url = new URL(request.url ?? '/', 'http://fixture');
    if (url.pathname === '/api/redirect') {
      response.writeHead(302, { location: 'http://127.0.0.1:1/elsewhere' }).end();
    } else if (url.pathname === '/api/slow') {
      setTimeout(() => response.end('late'), 2_000).unref();
    } else if (url.pathname === '/api/large') {
      response.end('x'.repeat(300 * 1024));
    } else if (url.pathname === '/api/multibyte') {
      // 3-byte characters: the 256 KiB cap (not a multiple of 3) cuts one in half.
      response.end('あ'.repeat(100_000));
    } else if (url.pathname === '/api/missing') {
      response.writeHead(404).end('{"error":"no such pet"}');
    } else {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ path: url.pathname, query: url.search }));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/api`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function config(auth: OpenApiToolConfig['auth'] = 'bearer'): OpenApiToolConfig {
  return OpenApiToolConfigSchema.parse({
    spec: { digest: `sha256:${'a'.repeat(64)}`, bytes: 1 },
    baseUrl,
    auth,
    allow: ['GET /**'],
    operations: [
      { name: 'showPetById', method: 'GET', path: '/pets/{petId}' },
      { name: 'redirect', method: 'GET', path: '/redirect' },
      { name: 'slow', method: 'GET', path: '/slow' },
      { name: 'large', method: 'GET', path: '/large' },
      { name: 'multibyte', method: 'GET', path: '/multibyte' },
      { name: 'missing', method: 'GET', path: '/missing' },
    ],
  });
}

const PARAMETERS: Readonly<Record<string, readonly ToolParameter[]>> = {
  showPetById: [
    { name: 'petId', in: 'path', required: true, schema: { type: 'string' } },
    { name: 'tag', in: 'query', required: false },
    { name: 'x-trace', in: 'header', required: false },
    { name: 'session', in: 'cookie', required: false },
    { name: 'ids', in: 'query', required: false, style: 'pipeDelimited' },
    { name: 'filter', in: 'query', required: false, style: 'deepObject' },
  ],
};

const credential = () => Promise.resolve(CREDENTIAL);

function text(result: CallToolResult): string {
  const [first] = result.content;
  if (first?.type !== 'text') throw new Error('expected one text block');
  return first.text;
}

async function call(
  name: string,
  args: Record<string, unknown> = {},
  overrides: { auth?: OpenApiToolConfig['auth']; secret?: string | null; timeoutMs?: number } = {},
): Promise<CallToolResult> {
  return callTool(
    config(overrides.auth),
    PARAMETERS,
    () => (overrides.secret === undefined ? credential() : Promise.resolve(overrides.secret)),
    name,
    args,
    {
      policy: LOCAL,
      ...(overrides.timeoutMs === undefined ? {} : { timeoutMs: overrides.timeoutMs }),
    },
  );
}

describe('listTools', () => {
  it('advertises one tool per operation with its C17 name and the sendable parameters', () => {
    const [pet] = listTools(config(), PARAMETERS);
    expect(pet).toEqual({
      name: 'showPetById',
      description: 'GET /pets/{petId}',
      inputSchema: {
        type: 'object',
        properties: { petId: { type: 'string' }, tag: {}, 'x-trace': {} },
        required: ['petId'],
        additionalProperties: false,
      },
    });
  });
});

describe('callTool', () => {
  it('substitutes path, query (repeated for a list) and header parameters', async () => {
    seen.length = 0;
    const result = await call('showPetById', {
      petId: 'a b/c',
      tag: ['one', 'two'],
      'x-trace': 7,
    });
    expect(result.isError).toBe(false);
    expect(JSON.parse(text(result))).toEqual({
      path: '/api/pets/a%20b%2Fc',
      query: '?tag=one&tag=two',
    });
    expect(seen[0]?.headers['x-trace']).toBe('7');
    expect(seen[0]?.headers['accept']).toBe('application/json');
  });

  it('sends the credential upstream and never the caller run token', async () => {
    seen.length = 0;
    await call('showPetById', { petId: '1' });
    expect(seen[0]?.headers['authorization']).toBe(`Bearer ${CREDENTIAL}`);
    seen.length = 0;
    await call('showPetById', { petId: '1' }, { auth: { header: 'X-Api-Key' } });
    expect(seen[0]?.headers['x-api-key']).toBe(CREDENTIAL);
    expect(seen[0]?.headers['authorization']).toBeUndefined();
  });

  it('sends no credential header for auth none', async () => {
    seen.length = 0;
    let asked = false;
    const result = await callTool(
      config('none'),
      PARAMETERS,
      () => {
        asked = true;
        return credential();
      },
      'showPetById',
      { petId: '1' },
      { policy: LOCAL },
    );
    expect(result.isError).toBe(false);
    expect(asked).toBe(false);
    expect(seen[0]?.headers['authorization']).toBeUndefined();
  });

  it.each([
    ['an unknown argument', { petId: '1', other: 1 }, 'unknown argument "other"'],
    ['a missing required argument', {}, 'missing argument "petId"'],
    ['a non-scalar path value', { petId: { id: 1 } }, '"petId" must be'],
    ['a non-scalar query item', { petId: '1', tag: [{}] }, '"tag" must be'],
    ['a cookie parameter', { petId: '1', session: 's' }, 'unknown argument "session"'],
    ['a pipeDelimited query', { petId: '1', ids: 'a' }, 'unknown argument "ids"'],
    ['a deepObject query', { petId: '1', filter: 'a' }, 'unknown argument "filter"'],
  ])('refuses %s without an upstream call', async (_name, args, message) => {
    seen.length = 0;
    const result = await call('showPetById', args);
    expect(result.isError).toBe(true);
    expect(text(result)).toContain(message);
    expect(seen).toHaveLength(0);
  });

  it.each(['..', '.', '%2e%2e', '%2E%2e', '.%2E', '%2e', '%252e%252e'])(
    'refuses the dot-segment path value %j without an upstream call',
    async (petId) => {
      seen.length = 0;
      const result = await call('showPetById', { petId });
      expect(result.isError).toBe(true);
      expect(text(result)).toContain('invalid arguments');
      expect(seen).toHaveLength(0);
    },
  );

  it('refuses path values that only form a dot segment together', async () => {
    seen.length = 0;
    const result = await callTool(
      OpenApiToolConfigSchema.parse({
        ...config(),
        operations: [{ name: 'pair', method: 'GET', path: '/pets/{a}{b}' }],
      }),
      {
        pair: [
          { name: 'a', in: 'path', required: true },
          { name: 'b', in: 'path', required: true },
        ],
      },
      credential,
      'pair',
      { a: '.', b: '.' },
      { policy: LOCAL },
    );
    expect(result.isError).toBe(true);
    expect(seen).toHaveLength(0);
  });

  it('keeps a value with slashes and dots inside one encoded segment of the operation path', async () => {
    seen.length = 0;
    const result = await call('showPetById', { petId: '../../admin' });
    expect(result.isError).toBe(false);
    expect(JSON.parse(text(result))).toMatchObject({ path: '/api/pets/..%2F..%2Fadmin' });
    expect(seen[0]?.url.startsWith('/api/pets/')).toBe(true);
  });

  it('refuses a header parameter that frames the request or carries the credential', async () => {
    const framing = await callTool(
      config(),
      { showPetById: [{ name: 'Host', in: 'header', required: false }] },
      credential,
      'showPetById',
      { Host: 'evil' },
      { policy: LOCAL },
    );
    expect(text(framing)).toContain('header "Host" cannot be set');
    const auth = await callTool(
      config(),
      { showPetById: [{ name: 'Authorization', in: 'header', required: false }] },
      credential,
      'showPetById',
      { Authorization: 'Bearer other' },
      { policy: LOCAL },
    );
    expect(text(auth)).toContain('header "Authorization" cannot be set');
  });

  it('answers tool_upstream_failed without a request when the credential is missing', async () => {
    seen.length = 0;
    const result = await call('showPetById', { petId: '1' }, { secret: null });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({
      error: { code: 'tool_upstream_failed', status: 502 },
    });
    expect(seen).toHaveLength(0);
  });

  it('refuses a redirect upstream as tool_upstream_failed (502)', async () => {
    const result = await call('redirect');
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({
      error: { code: 'tool_upstream_failed', status: 502 },
    });
    expect(text(result)).not.toContain('127.0.0.1');
  });

  it('times out as tool_upstream_timeout (504)', async () => {
    const result = await call('slow', {}, { timeoutMs: 50 });
    expect(result.structuredContent).toEqual({
      error: { code: 'tool_upstream_timeout', status: 504 },
    });
  });

  it('caps the body at 256 KiB with a truncation marker', async () => {
    const result = await call('large');
    const body = text(result);
    const marker = `\n[truncated: the response exceeded ${String(TOOL_RESPONSE_MAX_BYTES)} bytes]`;
    expect(body.endsWith(marker)).toBe(true);
    expect(body.length - marker.length).toBe(262_144);
  });

  it('drops a multi-byte character cut by the cap instead of emitting U+FFFD', async () => {
    const body = text(await call('multibyte'));
    expect(body).not.toContain('�');
    const marker = `
[truncated: the response exceeded ${String(TOOL_RESPONSE_MAX_BYTES)} bytes]`;
    expect(body.length - marker.length).toBe(Math.floor(TOOL_RESPONSE_MAX_BYTES / 3));
  });

  it('returns a non-2xx upstream body as a tool error', async () => {
    const result = await call('missing');
    expect(result.isError).toBe(true);
    expect(text(result)).toBe('{"error":"no such pet"}');
  });

  it('answers an egress refusal with 502 and no host in the text', async () => {
    const result = await callTool(
      config(),
      PARAMETERS,
      credential,
      'showPetById',
      { petId: '1' },
      {
        policy: { production: true, allowHosts: [] },
      },
    );
    expect(result.structuredContent).toEqual({
      error: { code: 'tool_upstream_failed', status: 502 },
    });
    expect(JSON.stringify(result)).not.toContain('127.0.0.1');
    expect(JSON.stringify(result)).not.toContain(CREDENTIAL);
  });

  it('answers an unknown tool name as a tool error', async () => {
    const result = await call('nope');
    expect(result.isError).toBe(true);
  });
});
