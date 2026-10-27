import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';

import { canonicalCall } from '@indx-workspace/contracts/agents';
import {
  OpenApiToolConfigSchema,
  type OpenApiToolConfig,
} from '@indx-workspace/contracts/tool-connectors';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ToolApproval, ToolParameter } from './authorize.js';
import { callTool, listTools, TOOL_RESPONSE_MAX_BYTES } from './openapi.js';

const LOCAL = { production: false, allowHosts: [] } as const;
const CREDENTIAL = 'fixture-tool-credential';

type Seen = {
  readonly url: string;
  readonly method: string;
  readonly body: string;
  readonly headers: IncomingHttpHeaders;
};
const seen: Seen[] = [];
let server: Server;
let baseUrl = '';

function respond(request: IncomingMessage, response: ServerResponse): void {
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
}

beforeAll(async () => {
  server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      seen.push({
        url: request.url ?? '',
        method: request.method ?? '',
        body: Buffer.concat(chunks).toString('utf8'),
        headers: request.headers,
      });
      respond(request, response);
    });
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
      { name: 'addPet', method: 'POST', path: '/pets' },
      { name: 'renamePet', method: 'PATCH', path: '/pets/{petId}' },
      { name: 'removePet', method: 'DELETE', path: '/pets/{petId}' },
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
  addPet: [{ name: 'body', in: 'body', required: true, schema: { type: 'object' } }],
  renamePet: [
    { name: 'petId', in: 'path', required: true },
    { name: 'body', in: 'body', required: false },
  ],
  removePet: [{ name: 'petId', in: 'path', required: true }],
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

  it('sends the signed identity assertion, and refuses to dial when it cannot be signed', async () => {
    const options = (identity: () => Promise<string | null>) => ({ policy: LOCAL, identity });
    seen.length = 0;
    const sent = await callTool(
      config(),
      PARAMETERS,
      credential,
      'showPetById',
      { petId: '1', 'x-trace': 'a' },
      options(() => Promise.resolve('signed.assertion')),
    );
    expect(sent.isError).toBe(false);
    expect(seen[0]?.headers['x-aw-identity']).toBe('signed.assertion');

    seen.length = 0;
    const refused = await callTool(
      config(),
      PARAMETERS,
      credential,
      'showPetById',
      { petId: '1' },
      options(() => Promise.resolve(null)),
    );
    expect(refused.isError).toBe(true);
    expect(text(refused)).toContain('caller identity');
    expect(seen).toEqual([]);
  });

  it('sends no identity header to a connector that did not opt in', async () => {
    seen.length = 0;
    await call('showPetById', { petId: '1' });
    expect(seen[0]?.headers['x-aw-identity']).toBeUndefined();
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

describe('write operations (#1304)', () => {
  /** Uses an approval up once, as `runs.consumeApprovedCall` does; every call asks, in order. */
  const onceOnly =
    (consumed: string[] = []): ToolApproval['consume'] =>
    (call) => {
      const first = !consumed.includes(call.canonicalCall);
      consumed.push(call.canonicalCall);
      return Promise.resolve(first ? 'consumed' : 'already-used');
    };
  const approved = (
    name: string,
    args: unknown,
    consume: ToolApproval['consume'] = onceOnly(),
  ): ToolApproval => ({
    serverKey: 'pets',
    approvedToolCalls: [canonicalCall(`mcp__pets__${name}`, args)],
    consume,
  });
  const withApproval = (
    name: string,
    args: Record<string, unknown>,
    approval: ToolApproval | undefined,
    readCredential: () => Promise<string | null> = credential,
  ) =>
    callTool(config(), PARAMETERS, readCredential, name, args, {
      policy: LOCAL,
      ...(approval === undefined ? {} : { approval }),
    });

  it('advertises the body as a required argument of a write', () => {
    const tool = listTools(config(), PARAMETERS).find((candidate) => candidate.name === 'addPet');
    expect(tool).toMatchObject({
      description: 'POST /pets',
      inputSchema: { properties: { body: { type: 'object' } }, required: ['body'] },
    });
  });

  it('sends an approved write with its JSON body and the connector credential', async () => {
    seen.length = 0;
    const args = { body: { name: 'Rex', tags: ['a'] } };
    const result = await withApproval('addPet', args, approved('addPet', args));
    expect(result.isError).toBe(false);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ method: 'POST', body: '{"name":"Rex","tags":["a"]}' });
    expect(seen[0]?.headers['content-type']).toBe('application/json');
    expect(seen[0]?.headers['authorization']).toBe(`Bearer ${CREDENTIAL}`);
  });

  it('sends an approved DELETE with no body and no content-type', async () => {
    seen.length = 0;
    const args = { petId: '7' };
    await withApproval('removePet', args, approved('removePet', args));
    expect(seen[0]).toMatchObject({ method: 'DELETE', body: '', url: '/api/pets/7' });
    expect(seen[0]?.headers['content-type']).toBeUndefined();
  });

  it('sends an optional body only when one is given', async () => {
    seen.length = 0;
    const args = { petId: '7' };
    await withApproval('renamePet', args, approved('renamePet', args));
    expect(seen[0]).toMatchObject({ method: 'PATCH', body: '' });
  });

  it.each<[string, ToolApproval | undefined]>([
    ['no approval data', undefined],
    [
      'no approved calls',
      { serverKey: 'pets', approvedToolCalls: [], consume: () => Promise.resolve('consumed') },
    ],
    ['another call', approved('addPet', { body: { name: 'Other' } })],
    [
      'the same call under another server key',
      { ...approved('addPet', { body: { n: 1 } }), serverKey: 'x' },
    ],
  ])(
    'refuses a write with %s before the credential or the upstream is touched',
    async (_name, approval) => {
      seen.length = 0;
      let credentialReads = 0;
      const result = await withApproval('addPet', { body: { n: 1 } }, approval, () => {
        credentialReads += 1;
        return credential();
      });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toEqual({
        error: { code: 'approval_required', status: 403 },
      });
      expect(credentialReads).toBe(0);
      expect(seen).toHaveLength(0);
    },
  );

  it('runs an approved write once: the repeat is refused before the credential or the upstream', async () => {
    seen.length = 0;
    let credentialReads = 0;
    const readCredential = () => {
      credentialReads += 1;
      return credential();
    };
    const args = { body: { name: 'Rex' } };
    const approval = approved('addPet', args);

    const first = await withApproval('addPet', args, approval, readCredential);
    const second = await withApproval('addPet', args, approval, readCredential);

    expect(first.isError).toBe(false);
    expect(second.isError).toBe(true);
    expect(second.structuredContent).toEqual({
      error: { code: 'approval_already_used', status: 403 },
    });
    expect(credentialReads).toBe(1);
    expect(seen).toHaveLength(1);
  });

  it('sends one request when two parallel calls race for the same approval', async () => {
    seen.length = 0;
    const args = { body: { name: 'Rex' } };
    const approval = approved('addPet', args);

    const results = await Promise.all([
      withApproval('addPet', args, approval),
      withApproval('addPet', args, approval),
    ]);

    expect(results.filter((result) => result.isError === false)).toHaveLength(1);
    expect(results.filter((result) => result.isError === true)).toHaveLength(1);
    expect(seen).toHaveLength(1);
  });

  it('consumes the approved call, named as the run stored it, and never for a read', async () => {
    const asked: { toolName: string; canonicalCall: string }[] = [];
    const args = { body: { name: 'Rex' } };
    const approval = approved('addPet', args, (call) => {
      asked.push(call);
      return Promise.resolve('consumed');
    });

    await withApproval('showPetById', { petId: '1' }, approval);
    expect(asked).toEqual([]);

    await withApproval('addPet', args, approval);
    expect(asked).toEqual([
      { toolName: 'mcp__pets__addPet', canonicalCall: canonicalCall('mcp__pets__addPet', args) },
    ]);
  });

  it('consumes before the arguments are built: an invalid approved write is still spent', async () => {
    const approval = approved('addPet', {});

    const first = await withApproval('addPet', {}, approval);
    const second = await withApproval('addPet', {}, approval);

    expect(text(first)).toBe('invalid arguments: missing argument "body"');
    expect(second.structuredContent).toEqual({
      error: { code: 'approval_already_used', status: 403 },
    });
  });

  it('answers approval_required, not already used, when the run stopped approving the call', async () => {
    seen.length = 0;
    const args = { body: { name: 'Rex' } };
    const result = await withApproval(
      'addPet',
      args,
      approved('addPet', args, () => Promise.resolve('not-approved')),
    );
    expect(result.structuredContent).toEqual({
      error: { code: 'approval_required', status: 403 },
    });
    expect(seen).toHaveLength(0);
  });

  it('does not run a write when consuming the approval fails', async () => {
    seen.length = 0;
    let credentialReads = 0;
    const args = { body: { name: 'Rex' } };
    const approval = approved('addPet', args, () => Promise.reject(new Error('database is down')));

    await expect(
      withApproval('addPet', args, approval, () => {
        credentialReads += 1;
        return credential();
      }),
    ).rejects.toThrow('database is down');

    expect(credentialReads).toBe(0);
    expect(seen).toHaveLength(0);
  });

  it('refuses an approved write whose body argument is missing', async () => {
    const result = await withApproval('addPet', {}, approved('addPet', {}));
    expect(text(result)).toBe('invalid arguments: missing argument "body"');
  });

  it('still runs a read without any approval data', async () => {
    const result = await withApproval('showPetById', { petId: '1' }, undefined);
    expect(result.isError).toBe(false);
  });
});
