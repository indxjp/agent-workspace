import { createServer, type AddressInfo, type Server, type Socket } from 'node:net';

import type { EgressPolicyConfig, EgressResolver } from '@agent-workspace/core';
import {
  POSTGRES_TOOL_OPERATION_NAMES,
  PostgresToolConfigSchema,
} from '@indx-workspace/contracts/tool-connectors';
import pg from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createRunTokenCodec } from '../tokens/run-token.js';
import { handleToolRequest } from './endpoint.js';
import { compileSelect, createPostgresExecutor, listPostgresTools } from './postgres.js';

const CONNECTOR = '66666666-6666-4666-8666-666666666666';
const PASSWORD = 'fixture-db-password';
const LOCAL: EgressPolicyConfig = { production: false, allowHosts: [] };
const PRODUCTION: EgressPolicyConfig = { production: true, allowHosts: [] };
const CONFIG = PostgresToolConfigSchema.parse({
  tables: ['public.orders', 'public.slow'],
  readOnly: true,
  maxRows: 10,
});

const resolveTo =
  (address: string): EgressResolver =>
  () =>
    Promise.resolve([{ address, family: 4 }]);

function url(port: number, query = ''): string {
  return `postgresql://reader:${PASSWORD}@db.example.test:${String(port)}/app${query}`;
}

const UPSTREAM_FAILED = { error: { code: 'tool_upstream_failed', status: 502 } };

type FakeDatabase = {
  readonly port: number;
  readonly sockets: number;
  readonly received: Buffer[];
};

const servers: Server[] = [];

/**
 * A TCP server standing in for PostgreSQL. `tls` answers pg's 8-byte SSLRequest with `S` and keeps
 * the next bytes (the TLS ClientHello); `close` hangs up on the first bytes; `silent` never answers.
 */
async function fakeDatabase(mode: 'tls' | 'close' | 'silent'): Promise<FakeDatabase> {
  const received: Buffer[] = [];
  let sockets = 0;
  const live: Socket[] = [];
  const server = createServer((socket) => {
    sockets += 1;
    live.push(socket);
    socket.on('error', () => undefined);
    socket.on('data', (chunk: Buffer) => {
      received.push(chunk);
      if (mode === 'close') socket.destroy();
      if (mode === 'tls') {
        if (received.length === 1) socket.write('S');
        else socket.destroy();
      }
    });
  });
  server.on('close', () => {
    for (const socket of live) socket.destroy();
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    port,
    get sockets() {
      return sockets;
    },
    received,
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.emit('close');
        }),
    ),
  );
});

describe('compileSelect', () => {
  it('compiles columns, filters, order and a limit to parameterised SQL', () => {
    expect(
      compileSelect(CONFIG, {
        table: 'public.orders',
        columns: ['id', 'name'],
        filters: [
          { column: 'status', op: 'eq', value: 'open' },
          { column: 'total', op: 'gte', value: 10 },
        ],
        order: [{ column: 'id', direction: 'desc' }],
      }),
    ).toEqual({
      text: 'SELECT "id","name" FROM "public"."orders" WHERE "status" = $1 AND "total" >= $2 ORDER BY "id" DESC LIMIT $3',
      values: ['open', 10, CONFIG.maxRows + 1],
    });
  });

  it('quotes a crafted column as one identifier and keeps every value out of the text', () => {
    const { text, values } = compileSelect(CONFIG, {
      table: 'public.orders',
      columns: ['id" FROM x; DROP TABLE t; --'],
      filters: [{ column: 'status', op: 'eq', value: "'; DROP TABLE t; --" }],
      limit: 3,
    });
    expect(text).toBe(
      'SELECT "id"" FROM x; DROP TABLE t; --" FROM "public"."orders" WHERE "status" = $1 LIMIT $2',
    );
    expect(values).toEqual(["'; DROP TABLE t; --", 4]);
  });

  it('has no WHERE without filters', () => {
    expect(compileSelect(CONFIG, { table: 'public.orders' }).text).toBe(
      'SELECT * FROM "public"."orders" LIMIT $1',
    );
  });
});

describe('the postgres executor: arguments', () => {
  const credential = vi.fn(() => Promise.resolve(url(5432)));
  const executor = createPostgresExecutor({ policy: LOCAL, resolve: resolveTo('127.0.0.1') });

  it('lists exactly the three C17 operations', () => {
    expect(listPostgresTools(CONFIG).map((tool) => tool.name)).toEqual([
      ...POSTGRES_TOOL_OPERATION_NAMES,
    ]);
  });

  it('answers list_tables from the allowlist without reading the credential', async () => {
    const result = await executor.call(CONNECTOR, CONFIG, credential, 'list_tables', {});
    expect(result).toEqual({
      content: [{ type: 'text', text: JSON.stringify({ tables: CONFIG.tables }) }],
      isError: false,
    });
    expect(credential).not.toHaveBeenCalled();
  });

  it.each([
    ['select', { table: 'public.secrets' }],
    ['describe', { table: 'public.secrets' }],
  ])('refuses %s of a table outside the allowlist by name', async (name, args) => {
    const result = await executor.call(CONNECTOR, CONFIG, credential, name, args);
    expect(result).toEqual({
      content: [{ type: 'text', text: 'table "public.secrets" is not allowed' }],
      isError: true,
    });
    expect(credential).not.toHaveBeenCalled();
  });

  it.each([
    ['sql', { table: 'public.orders', sql: 'DELETE FROM orders' }],
    ['where', { table: 'public.orders', where: '1=1' }],
    ['raw', { table: 'public.orders', raw: true }],
    ['a limit above maxRows', { table: 'public.orders', limit: CONFIG.maxRows + 1 }],
    [
      'an unknown operator',
      { table: 'public.orders', filters: [{ column: 'id', op: 'like', value: 1 }] },
    ],
    ['a repeated column', { table: 'public.orders', columns: ['id', 'id'] }],
    ['a control character', { table: 'public.orders', columns: ['id\u0000'] }],
  ])('refuses %s through the strict schema', async (_name, args) => {
    const result = await executor.call(CONNECTOR, CONFIG, credential, 'select', args);
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([
      { type: 'text', text: expect.stringMatching(/^invalid arguments: /u) as unknown },
    ]);
    expect(credential).not.toHaveBeenCalled();
  });

  it('answers an unknown tool name as a tool error', async () => {
    const result = await executor.call(CONNECTOR, CONFIG, credential, 'insert', {});
    expect(result).toMatchObject({ isError: true });
  });
});

describe('the postgres executor: connection and egress', () => {
  it('connects to the checked address and keeps the name as the TLS servername', async () => {
    const server = await fakeDatabase('tls');
    const executor = createPostgresExecutor({
      policy: LOCAL,
      resolve: resolveTo('127.0.0.1'),
      timeoutMs: 5000,
    });
    const credential = url(server.port, '?sslmode=require');
    const result = await executor.call(
      CONNECTOR,
      CONFIG,
      () => Promise.resolve(credential),
      'select',
      { table: 'public.orders' },
    );
    expect(server.sockets).toBe(1);
    expect(Buffer.concat(server.received.slice(1)).includes('db.example.test')).toBe(true);
    expect(result).toMatchObject({ isError: true, structuredContent: UPSTREAM_FAILED });
    expect(JSON.stringify(result)).not.toContain(PASSWORD);
    expect(JSON.stringify(result)).not.toContain('db.example.test');
    await executor.close();
  });

  it('refuses a host that resolves to a private address after an earlier check', async () => {
    const server = await fakeDatabase('close');
    const addresses = ['127.0.0.1', '10.0.0.5'];
    const executor = createPostgresExecutor({
      policy: LOCAL,
      resolve: () => Promise.resolve([{ address: addresses.shift() ?? '10.0.0.5', family: 4 }]),
      timeoutMs: 5000,
    });
    const credential = () => Promise.resolve(url(server.port));
    const select = { table: 'public.orders' };
    await executor.call(CONNECTOR, CONFIG, credential, 'select', select);
    expect(server.sockets).toBe(1);
    const second = await executor.call(CONNECTOR, CONFIG, credential, 'select', select);
    expect(second).toMatchObject({ isError: true, structuredContent: UPSTREAM_FAILED });
    expect(server.sockets).toBe(1);
    await executor.close();
  });

  it('refuses a loopback database under the production posture', async () => {
    const server = await fakeDatabase('close');
    const executor = createPostgresExecutor({
      policy: PRODUCTION,
      resolve: resolveTo('127.0.0.1'),
    });
    const result = await executor.call(
      CONNECTOR,
      CONFIG,
      () => Promise.resolve(url(server.port)),
      'select',
      { table: 'public.orders' },
    );
    expect(result).toMatchObject({ isError: true, structuredContent: UPSTREAM_FAILED });
    expect(server.sockets).toBe(0);
  });

  it.each([
    ['sslmode=disable towards a public address', '?sslmode=disable', '93.184.216.34'],
    ['an unknown sslmode', '?sslmode=bogus', '127.0.0.1'],
    ['a connect_timeout that is not an integer', '?connect_timeout=abc', '127.0.0.1'],
  ])('refuses %s before any connection', async (_name, query, address) => {
    const connect = vi.spyOn(pg.Pool.prototype, 'connect');
    const executor = createPostgresExecutor({ policy: LOCAL, resolve: resolveTo(address) });
    const result = await executor.call(
      CONNECTOR,
      CONFIG,
      () => Promise.resolve(url(5432, query)),
      'select',
      { table: 'public.orders' },
    );
    expect(result).toMatchObject({ isError: true, structuredContent: UPSTREAM_FAILED });
    expect(connect).not.toHaveBeenCalled();
  });

  it('gives up on a silent server after connect_timeout', async () => {
    const server = await fakeDatabase('silent');
    const executor = createPostgresExecutor({
      policy: LOCAL,
      resolve: resolveTo('127.0.0.1'),
      timeoutMs: 10_000,
    });
    const started = Date.now();
    const result = await executor.call(
      CONNECTOR,
      CONFIG,
      () => Promise.resolve(url(server.port, '?connect_timeout=1')),
      'select',
      { table: 'public.orders' },
    );
    expect(result).toMatchObject({ isError: true, structuredContent: UPSTREAM_FAILED });
    expect(Date.now() - started).toBeLessThan(3000);
    await executor.close();
  });

  it('answers a missing credential as an upstream failure', async () => {
    const executor = createPostgresExecutor({ policy: LOCAL, resolve: resolveTo('127.0.0.1') });
    const result = await executor.call(CONNECTOR, CONFIG, () => Promise.resolve(null), 'select', {
      table: 'public.orders',
    });
    expect(result).toMatchObject({ isError: true, structuredContent: UPSTREAM_FAILED });
  });
});

/** One backend message: a type byte, then an int32 length that counts itself. */
function backendMessage(type: string, body: Buffer = Buffer.alloc(0)): Buffer {
  const length = Buffer.alloc(4);
  length.writeInt32BE(body.length + 4);
  return Buffer.concat([Buffer.from(type), length, body]);
}

/**
 * Just enough of the PostgreSQL wire protocol to accept a session, run `BEGIN` and the
 * `statement_timeout` statement, and then refuse the next extended query with SQLSTATE 42703.
 */
async function refusingDatabase(): Promise<number> {
  const ready = backendMessage('Z', Buffer.from('T'));
  const server = createServer((socket) => {
    socket.on('error', () => undefined);
    let pending = Buffer.alloc(0);
    let started = false;
    let syncs = 0;
    socket.on('data', (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      for (;;) {
        const header = started ? 1 : 0;
        if (pending.length < header + 4) return;
        const end = header + pending.readInt32BE(header);
        if (pending.length < end) return;
        const type = started ? String.fromCharCode(pending[0] ?? 0) : 'startup';
        pending = pending.subarray(end);
        if (type === 'startup') {
          started = true;
          socket.write(Buffer.concat([backendMessage('R', Buffer.alloc(4)), ready]));
        } else if (type === 'Q') {
          socket.write(Buffer.concat([backendMessage('C', Buffer.from('BEGIN ')), ready]));
        } else if (type === 'S') {
          syncs += 1;
          socket.write(
            syncs === 1
              ? Buffer.concat([
                  backendMessage('1'),
                  backendMessage('2'),
                  backendMessage('n'),
                  backendMessage('C', Buffer.from('SELECT 1 ')),
                  ready,
                ])
              : Buffer.concat([
                  backendMessage('E', Buffer.from('SERROR C42703 Mno such column  ')),
                  ready,
                ]),
          );
        }
      }
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

describe('the postgres executor: query errors', () => {
  it('answers a refused query instead of waiting on it', async () => {
    const port = await refusingDatabase();
    const executor = createPostgresExecutor({ policy: LOCAL, resolve: resolveTo('127.0.0.1') });
    const result = await executor.call(
      CONNECTOR,
      CONFIG,
      () => Promise.resolve(url(port)),
      'select',
      { table: 'public.orders', columns: ['missing'] },
    );
    await executor.close();
    expect(result).toMatchObject({
      isError: true,
      content: [{ type: 'text', text: 'the database refused the query (SQLSTATE 42703)' }],
    });
  });
});

describe('the postgres executor: pools', () => {
  /** The pool each call connected through, in call order; no connection is made. */
  function capturePools(): readonly unknown[] {
    return vi
      .spyOn(pg.Pool.prototype, 'connect')
      .mockRejectedValue(new Error('fixture: no database')).mock.contexts;
  }

  it('survives an idle client error on a cached pool', async () => {
    const pools = capturePools();
    const executor = createPostgresExecutor({ policy: LOCAL, resolve: resolveTo('127.0.0.1') });
    await executor.call(CONNECTOR, CONFIG, () => Promise.resolve(url(5432)), 'select', {
      table: 'public.orders',
    });
    const [pool] = pools;
    if (!(pool instanceof pg.Pool)) throw new Error('expected a cached pool');
    expect(() => pool.emit('error', new Error('idle client lost'))).not.toThrow();
  });

  it('reuses a pool for the same credential and replaces it when the credential rotates', async () => {
    const pools = capturePools();
    const end = vi.spyOn(pg.Pool.prototype, 'end').mockResolvedValue(undefined);
    const executor = createPostgresExecutor({ policy: LOCAL, resolve: resolveTo('127.0.0.1') });
    const select = { table: 'public.orders' };
    const call = (credential: string) =>
      executor.call(CONNECTOR, CONFIG, () => Promise.resolve(credential), 'select', select);
    await call(url(5432));
    await call(url(5432));
    expect(pools[1]).toBe(pools[0]);
    expect(end).not.toHaveBeenCalled();
    await call(url(5432).replace(PASSWORD, 'rotated-password'));
    expect(pools[2]).not.toBe(pools[0]);
    // The replaced pool is left to close idle, so callers queued on it are not stranded.
    expect(end).not.toHaveBeenCalled();
    await executor.close();
    expect(end.mock.contexts).toEqual([pools[2]]);
  });

  it('keeps the pool while a round-robin name alternates between checked addresses', async () => {
    const pools = capturePools();
    const end = vi.spyOn(pg.Pool.prototype, 'end').mockResolvedValue(undefined);
    let turn = 0;
    const executor = createPostgresExecutor({
      policy: LOCAL,
      resolve: () => {
        turn += 1;
        const both = [
          { address: '127.0.0.1', family: 4 as const },
          { address: '127.0.0.2', family: 4 as const },
        ];
        return Promise.resolve(turn % 2 === 0 ? both.reverse() : both);
      },
    });
    for (let index = 0; index < 4; index += 1) {
      await executor.call(CONNECTOR, CONFIG, () => Promise.resolve(url(5432)), 'select', {
        table: 'public.orders',
      });
    }
    expect(new Set(pools).size).toBe(1);
    expect(end).not.toHaveBeenCalled();
  });
});

describe('the tool endpoint with a postgres connector', () => {
  it('lists exactly list_tables, describe and select', async () => {
    const secret = 'fixture-signing-secret-that-is-longer-than-32-bytes';
    const tokens = createRunTokenCodec({ secret });
    const token = await tokens.issue({
      runId: '11111111-1111-4111-8111-111111111111',
      sessionId: '55555555-5555-4555-8555-555555555555',
      workspaceId: '22222222-2222-4222-8222-222222222222',
      agentId: '33333333-3333-4333-8333-333333333333',
      modelConnectionId: '44444444-4444-4444-8444-444444444444',
    });
    const response = await handleToolRequest(
      new Request(`http://gateway/v1/tools/${CONNECTOR}/mcp`, {
        method: 'POST',
        headers: {
          accept: 'application/json, text/event-stream',
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
      }),
      CONNECTOR,
      {
        tokens,
        tools: {
          resolve: () =>
            Promise.resolve({
              ok: true,
              connector: {
                kind: 'postgres',
                config: CONFIG,
                credential: () => Promise.resolve(url(5432)),
              },
            }),
        },
        postgres: createPostgresExecutor({ policy: LOCAL }),
      },
    );
    const body = (await response.json()) as { result: { tools: { name: string }[] } };
    expect(body.result.tools.map((tool) => tool.name)).toEqual([
      'list_tables',
      'describe',
      'select',
    ]);
  });
});
