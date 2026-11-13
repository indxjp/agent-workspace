/**
 * Test Connection's transport-level guarantees, driven through an in-process transport (no
 * sockets): every request goes through the egress guard (#2283 finding 3), SSE framing accepts
 * CRLF / CR / LF line endings (RU2), and JSON-RPC error codes outside the protocol range are
 * application errors, not "not MCP" (SI4).
 */
import { describe, expect, it, vi } from 'vitest';

import { restrictedBaseEnv } from './base-env';
import { testConnection } from './test-connection';
import { splitSseFrames } from './wire/sse';

const BASE_ENV = restrictedBaseEnv();
const PRODUCTION_POLICY = { production: true, allowHosts: [] } as const;
const LOCAL_POLICY = { production: false, allowHosts: [] } as const;

function requestBody(init: RequestInit | undefined): { id?: number; method?: string } {
  if (typeof init?.body !== 'string') throw new Error('expected a JSON string body');
  return JSON.parse(init.body) as { id?: number; method?: string };
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('Test Connection — egress guard', () => {
  it.each(['http', 'sse'] as const)(
    'refuses an internal address on %s before any request is sent',
    async (transport) => {
      const sent = vi.fn<typeof fetch>();
      const result = await testConnection(
        {
          transport,
          url: 'http://169.254.169.254/latest/meta-data',
          headers: {},
          credentialConfigured: false,
        },
        { baseEnv: BASE_ENV, egressPolicy: () => PRODUCTION_POLICY, transport: sent },
      );
      expect(sent).not.toHaveBeenCalled();
      expect(result.ok).toBe(false);
      expect(result.kind).toBe('unknown-failure');
    },
  );

  it('sends through the injected transport when the policy admits the host', async () => {
    const sent = vi.fn<typeof fetch>((_url, init) => {
      const body = requestBody(init);
      if (body.method === 'initialize') {
        return Promise.resolve(
          json({
            jsonrpc: '2.0',
            id: body.id,
            result: { protocolVersion: '2025-11-25', serverInfo: { name: 's', version: '1' } },
          }),
        );
      }
      if (body.method === 'tools/list') {
        return Promise.resolve(json({ jsonrpc: '2.0', id: body.id, result: { tools: [{}, {}] } }));
      }
      return Promise.resolve(new Response(null, { status: 202 }));
    });
    const result = await testConnection(
      {
        transport: 'http',
        url: 'http://127.0.0.1:9/mcp',
        headers: {},
        credentialConfigured: false,
      },
      { baseEnv: BASE_ENV, egressPolicy: () => LOCAL_POLICY, transport: sent },
    );
    expect(result.ok).toBe(true);
    expect(sent).toHaveBeenCalled();
  });
});

describe('Test Connection — JSON-RPC error classification', () => {
  const probeWithError = async (code: number, credentialConfigured: boolean) =>
    testConnection(
      { transport: 'http', url: 'http://127.0.0.1:9/mcp', headers: {}, credentialConfigured },
      {
        baseEnv: BASE_ENV,
        egressPolicy: () => LOCAL_POLICY,
        transport: (_url, init) =>
          Promise.resolve(
            json({ jsonrpc: '2.0', id: requestBody(init).id, error: { code, message: 'nope' } }),
          ),
      },
    );

  it.each([-32002, 401, 1, -31999])(
    'code %i from an MCP server is an application error, not "not MCP"',
    async (code) => {
      expect((await probeWithError(code, true)).kind).toBe('credential-rejected');
      expect((await probeWithError(code, false)).kind).toBe('server-refused');
    },
  );

  it('a code in the JSON-RPC protocol range (method not found) is still "not MCP"', async () => {
    expect((await probeWithError(-32601, true)).kind).toBe('endpoint-not-mcp');
  });
});

describe('SSE framing (RU2)', () => {
  const body = 'event: endpoint\ndata: /m\n\nevent: message\ndata: {"a":1}\n\n';
  it.each([
    ['LF', '\n'],
    ['CRLF', '\r\n'],
    ['CR', '\r'],
  ])('splits frames with %s line endings', (_name, eol) => {
    // The trailing bytes belong to the next frame; they keep a CR-only terminator unambiguous.
    const { frames, rest } = splitSseFrames(`${body}data: next`.replaceAll('\n', eol));
    expect(frames).toEqual(['event: endpoint\ndata: /m', 'event: message\ndata: {"a":1}']);
    expect(rest).toBe('data: next');
  });

  it('keeps a CR at a chunk boundary until its LF arrives', () => {
    const first = splitSseFrames('data: x\r\n\r');
    expect(first.frames).toEqual([]);
    const second = splitSseFrames(`${first.rest}\n`);
    expect(second.frames).toEqual(['data: x']);
  });
});
