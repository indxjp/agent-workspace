/**
 * The `postgres` executor against a real PostgreSQL (#433's native or Docker service, or CI's):
 * the allowlist, the read-only transaction, the timeout and the row cap, end to end.
 */
import type { EgressPolicyConfig } from '@agent-workspace/core';
import {
  createIsolatedTestDatabase,
  type IsolatedTestDatabase,
} from '@agent-workspace/core/db/unscoped';
import { PostgresToolConfigSchema } from '@indx-workspace/contracts/tool-connectors';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createRunTokenCodec } from '../tokens/run-token.js';
import { handleToolRequest } from './endpoint.js';
import { createPostgresExecutor, readOnly, type PostgresToolExecutor } from './postgres.js';

const rawUrl = process.env['TEST_DATABASE_URL'];
const hasDatabase = rawUrl !== undefined && rawUrl.trim() !== '';

if (!hasDatabase) {
  console.warn(
    '[gateway/tools/postgres-database.test.ts] SKIPPED — TEST_DATABASE_URL is not set, so the ' +
      'postgres executor against a real PostgreSQL was NOT exercised.',
  );
}

const CONNECTOR = '66666666-6666-4666-8666-666666666666';
// The test database is on loopback, which only the local posture reaches.
const LOCAL: EgressPolicyConfig = { production: false, allowHosts: [] };
const CONFIG = PostgresToolConfigSchema.parse({
  tables: ['public.orders', 'public.slow'],
  readOnly: true,
  maxRows: 10,
});

type Rows = { rows: Record<string, unknown>[]; truncated: boolean };

function text(result: { content: unknown }): string {
  const [first] = result.content as { type: string; text: string }[];
  return first?.text ?? '';
}

describe.skipIf(!hasDatabase)('the postgres executor over a real PostgreSQL', () => {
  let isolated: IsolatedTestDatabase;
  let pool: pg.Pool;
  let executor: PostgresToolExecutor;
  let credential: () => Promise<string>;

  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase('aw_s202e_pg');
    pool = new pg.Pool({ connectionString: isolated.url, max: 2 });
    await pool.query(`
      CREATE TABLE public.orders (id integer PRIMARY KEY, status text NOT NULL, total numeric);
      INSERT INTO public.orders
        SELECT g, CASE WHEN g % 2 = 0 THEN 'open' ELSE 'closed' END, g FROM generate_series(1, 50) g;
      CREATE TABLE public.hidden (secret text);
      CREATE VIEW public.slow AS SELECT pg_sleep(2)::text AS x;
    `);
    executor = createPostgresExecutor({ policy: LOCAL, timeoutMs: 5000 });
    credential = () => Promise.resolve(isolated.url);
  }, 180_000);

  afterAll(async () => {
    await executor.close();
    await pool.end();
    await isolated.close();
  });

  const call = (name: string, args: Record<string, unknown>) =>
    executor.call(CONNECTOR, CONFIG, credential, name, args);

  async function orderCount(): Promise<number> {
    const result = await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM public.orders');
    return result.rows[0]?.n ?? -1;
  }

  it('lists the allowlist', async () => {
    expect(JSON.parse(text(await call('list_tables', {})))).toEqual({ tables: CONFIG.tables });
  });

  it('describes a table in ordinal order', async () => {
    const result = await call('describe', { table: 'public.orders' });
    expect(result.isError).toBe(false);
    expect(JSON.parse(text(result))).toEqual({
      table: 'public.orders',
      columns: [
        { name: 'id', type: 'integer', nullable: false },
        { name: 'status', type: 'text', nullable: false },
        { name: 'total', type: 'numeric', nullable: true },
      ],
    });
  });

  it('selects with an equality filter, a range filter and an order', async () => {
    const result = await call('select', {
      table: 'public.orders',
      columns: ['id'],
      filters: [
        { column: 'status', op: 'eq', value: 'open' },
        { column: 'total', op: 'gte', value: 40 },
      ],
      order: [{ column: 'id', direction: 'desc' }],
    });
    expect(JSON.parse(text(result))).toEqual({
      rows: [50, 48, 46, 44, 42, 40].map((id) => ({ id })),
      truncated: false,
    });
  });

  it('caps the result at maxRows and says so', async () => {
    const result = JSON.parse(text(await call('select', { table: 'public.orders' }))) as Rows;
    expect(result.rows).toHaveLength(CONFIG.maxRows);
    expect(result.truncated).toBe(true);
  });

  it('stops keeping rows once their serialised size passes the byte budget', async () => {
    const result = await readOnly(
      pool,
      1000,
      "SELECT repeat('x', 1000) AS x FROM generate_series(1, 100)",
      [],
      10_000,
    );
    expect(result.overBudget).toBe(true);
    expect(result.rows).toHaveLength(9);
  });

  it('refuses a table outside the allowlist by name', async () => {
    const result = await call('select', { table: 'public.hidden' });
    expect(result).toMatchObject({ isError: true });
    expect(text(result)).toBe('table "public.hidden" is not allowed');
  });

  it('quotes a crafted identifier into an unknown column and changes nothing', async () => {
    const result = await call('select', {
      table: 'public.orders',
      columns: ['id" FROM public.orders; DELETE FROM public.orders; --'],
    });
    expect(result).toMatchObject({ isError: true });
    expect(text(result)).toBe('the database refused the query (SQLSTATE 42703)');
    expect(await orderCount()).toBe(50);
  });

  it('refuses a write inside the read-only transaction', async () => {
    await expect(
      readOnly(pool, 1000, "INSERT INTO public.orders VALUES (51, 'open', 51)", []),
    ).rejects.toMatchObject({ code: '25006' });
    expect(await orderCount()).toBe(50);
  });

  it('cancels a statement past statement_timeout', async () => {
    await expect(readOnly(pool, 100, 'SELECT pg_sleep(2)', [])).rejects.toMatchObject({
      code: '57014',
    });
  });

  it('answers a slow query with tool_upstream_timeout (504) through the tool endpoint', async () => {
    const slow = createPostgresExecutor({ policy: LOCAL, timeoutMs: 200 });
    const tokens = createRunTokenCodec({
      secret: 'fixture-signing-secret-that-is-longer-than-32-bytes',
    });
    const token = await tokens.issue({
      runId: '11111111-1111-4111-8111-111111111111',
      sessionId: '55555555-5555-4555-8555-555555555555',
      workspaceId: '22222222-2222-4222-8222-222222222222',
      agentId: '33333333-3333-4333-8333-333333333333',
      modelConnectionId: '44444444-4444-4444-8444-444444444444',
    });
    const written: string[] = [];
    const capture = (chunk: unknown) => {
      written.push(String(chunk));
      return true;
    };
    vi.spyOn(process.stderr, 'write').mockImplementation(capture);
    vi.spyOn(process.stdout, 'write').mockImplementation(capture);
    for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        written.push(args.map(String).join(' '));
      });
    }
    const bodies: string[] = [];
    try {
      for (const args of [
        { table: 'public.slow' },
        { table: 'public.hidden' },
        { table: 'public.orders', columns: ['missing'] },
      ]) {
        const response = await handleToolRequest(
          new Request(`http://gateway/v1/tools/${CONNECTOR}/mcp`, {
            method: 'POST',
            headers: {
              accept: 'application/json, text/event-stream',
              'content-type': 'application/json',
              authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: 1,
              method: 'tools/call',
              params: { name: 'select', arguments: args },
            }),
          }),
          CONNECTOR,
          {
            tokens,
            tools: {
              resolve: () =>
                Promise.resolve({
                  ok: true,
                  connector: { kind: 'postgres', config: CONFIG, credential },
                }),
            },
            postgres: slow,
          },
        );
        bodies.push(await response.text());
      }
    } finally {
      vi.restoreAllMocks();
      await slow.close();
    }
    expect(JSON.parse(bodies[0] ?? '')).toMatchObject({
      result: {
        isError: true,
        structuredContent: { error: { code: 'tool_upstream_timeout', status: 504 } },
      },
    });
    const { password } = new URL(isolated.url);
    for (const output of [...bodies, ...written]) {
      expect(output).not.toContain(isolated.url);
      if (password !== '') expect(output).not.toContain(password);
    }
  });
});
