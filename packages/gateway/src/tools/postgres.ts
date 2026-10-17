/**
 * The `postgres` executor (ADR-0113 SD4, C17): `list_tables`, `describe` and `select` over the
 * connector's allowlisted tables only. `select` is a structured request compiled to parameterised
 * SQL with quoted identifiers, so no argument can carry SQL; every statement still runs inside
 * `BEGIN READ ONLY` under a `statement_timeout`, and a result holds at most `maxRows` rows.
 *
 * Each call re-checks the database host through the platform egress policy and connects to the
 * address it just checked, never to the name, so pg does no DNS lookup of its own; TLS keeps the
 * name as its servername. No text this module returns names the database URL, its host or the
 * credential, and nothing here logs.
 */
import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import type { ConnectionOptions } from 'node:tls';

import {
  checkHostEgress,
  loadEgressPolicyFromEnv,
  type EgressPolicyConfig,
  type EgressResolver,
} from '@agent-workspace/core';
import type { PostgresToolConfig } from '@indx-workspace/contracts/tool-connectors';
import { ToolSchema, type CallToolResult, type Tool } from '@modelcontextprotocol/sdk/types.js';
import pg from 'pg';
import { z } from 'zod';

import {
  cappedText,
  textResult,
  TOOL_RESPONSE_MAX_BYTES,
  TOOL_UPSTREAM_TIMEOUT_MS,
  upstreamFailure,
} from './openapi.js';

export type PostgresExecutorOptions = {
  readonly policy?: EgressPolicyConfig;
  readonly resolve?: EgressResolver;
  readonly timeoutMs?: number;
};

export type PostgresToolExecutor = {
  call(
    connectorId: string,
    config: PostgresToolConfig,
    credential: () => Promise<string | null>,
    name: string,
    args: Readonly<Record<string, unknown>> | undefined,
  ): Promise<CallToolResult>;
  /** End every pool; a shutting-down gateway calls this once. */
  close(): Promise<void>;
};

const POSTGRES_PORT = 5432;
const POOL_MAX_CONNECTIONS = 2;
const POOL_IDLE_MS = 30_000;

const IdentifierSchema = z
  .string()
  .min(1)
  .max(63)
  .regex(/^\P{Cc}+$/u, 'must not contain a control character');

const ListTablesArgsSchema = z.object({}).strict();
const DescribeArgsSchema = z.object({ table: z.string() }).strict();

const OPERATORS = { eq: '=', lt: '<', lte: '<=', gt: '>', gte: '>=' } as const;

function selectArgsSchema(maxRows: number) {
  return z
    .object({
      table: z.string(),
      columns: z
        .array(IdentifierSchema)
        .min(1)
        .max(64)
        .refine((columns) => new Set(columns).size === columns.length, 'must not repeat a column')
        .optional(),
      filters: z
        .array(
          z
            .object({
              column: IdentifierSchema,
              op: z.enum(['eq', 'lt', 'lte', 'gt', 'gte']),
              value: z.union([z.string().max(1024), z.number(), z.boolean()]),
            })
            .strict(),
        )
        .max(16)
        .optional(),
      order: z
        .array(z.object({ column: IdentifierSchema, direction: z.enum(['asc', 'desc']) }).strict())
        .max(4)
        .optional(),
      limit: z.number().int().min(1).max(maxRows).optional(),
    })
    .strict();
}

type SelectArgs = z.infer<ReturnType<typeof selectArgsSchema>>;

function inputSchema(schema: z.ZodType): Tool['inputSchema'] {
  return ToolSchema.shape.inputSchema.parse(z.toJSONSchema(schema));
}

export function listPostgresTools(config: PostgresToolConfig): Tool[] {
  return [
    {
      name: 'list_tables',
      description: 'List the tables this connector may read.',
      inputSchema: inputSchema(ListTablesArgsSchema),
    },
    {
      name: 'describe',
      description: 'List the columns of one allowed table: name, data type and nullability.',
      inputSchema: inputSchema(DescribeArgsSchema),
    },
    {
      name: 'select',
      description: `Read at most ${String(config.maxRows)} rows of one allowed table, with optional columns, filters and order.`,
      inputSchema: inputSchema(selectArgsSchema(config.maxRows)),
    },
  ];
}

/** One identifier, always quoted, so a crafted name stays one name. */
function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/** Compile a parsed `select` to parameterised SQL. `LIMIT` binds one more row to detect a cut. */
export function compileSelect(
  config: PostgresToolConfig,
  args: SelectArgs,
): { readonly text: string; readonly values: readonly (string | number | boolean)[] } {
  const values: (string | number | boolean)[] = [];
  const bind = (value: string | number | boolean): string => {
    values.push(value);
    return `$${String(values.length)}`;
  };
  const columns = args.columns === undefined ? '*' : args.columns.map(quoteIdent).join(',');
  let text = `SELECT ${columns} FROM ${args.table.split('.').map(quoteIdent).join('.')}`;
  const filters = args.filters ?? [];
  if (filters.length > 0) {
    const conditions = filters.map(
      (filter) => `${quoteIdent(filter.column)} ${OPERATORS[filter.op]} ${bind(filter.value)}`,
    );
    text += ` WHERE ${conditions.join(' AND ')}`;
  }
  const order = args.order ?? [];
  if (order.length > 0) {
    const keys = order.map((key) => `${quoteIdent(key.column)} ${key.direction.toUpperCase()}`);
    text += ` ORDER BY ${keys.join(', ')}`;
  }
  text += ` LIMIT ${bind((args.limit ?? config.maxRows) + 1)}`;
  return { text, values };
}

type Rows = { readonly rows: readonly Record<string, unknown>[]; readonly overBudget: boolean };

/**
 * Run one statement in a read-only transaction under `statement_timeout`. A failed client is
 * destroyed, not reused: closing the connection ends its transaction on the server. Rows are kept
 * while their serialised size stays within `maxBytes`; later rows are dropped as they arrive, so an
 * oversized result never sits in memory whole.
 */
export async function readOnly(
  pool: pg.Pool,
  timeoutMs: number,
  text: string,
  values: readonly unknown[],
  maxBytes = TOOL_RESPONSE_MAX_BYTES,
): Promise<Rows> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN READ ONLY');
    await client.query("SELECT set_config('statement_timeout', $1, true)", [
      String(Math.trunc(timeoutMs)),
    ]);
    const rows: Record<string, unknown>[] = [];
    let size = 0;
    let overBudget = false;
    await new Promise<void>((resolve, reject) => {
      // A callback, not the 'error' event: pg's `query_timeout` wraps the callback, and a query
      // that has one reports its error only there.
      const query = new pg.Query<Record<string, unknown>>(text, [...values], (error) => {
        // pg passes `null`, not `undefined`, on success.
        if (error instanceof Error) reject(error);
        else resolve();
      });
      query.on('row', (row: Record<string, unknown>, result) => {
        // A query with a callback also collects every row; emptying that list keeps pg holding
        // at most the row just read.
        result?.rows.splice(0);
        if (overBudget) return;
        size += Buffer.byteLength(JSON.stringify(row));
        if (size > maxBytes) overBudget = true;
        else rows.push(row);
      });
      client.query(query);
    });
    await client.query('ROLLBACK');
    client.release();
    return { rows, overBudget };
  } catch (error) {
    client.release(error instanceof Error ? error : true);
    throw error;
  }
}

type Prepared =
  | { readonly kind: 'answer'; readonly result: CallToolResult }
  | {
      readonly kind: 'query';
      readonly text: string;
      readonly values: readonly unknown[];
      readonly answer: (result: Rows) => Promise<CallToolResult>;
    };

async function jsonResult(body: unknown): Promise<CallToolResult> {
  return textResult(await cappedText(new Response(JSON.stringify(body))), false);
}

function invalid(error: z.ZodError): Prepared {
  return {
    kind: 'answer',
    result: textResult(`invalid arguments: ${z.prettifyError(error)}`, true),
  };
}

function notAllowed(table: string): Prepared {
  return {
    kind: 'answer',
    result: textResult(`table ${JSON.stringify(table)} is not allowed`, true),
  };
}

function prepare(
  config: PostgresToolConfig,
  name: string,
  args: Readonly<Record<string, unknown>>,
): Prepared {
  if (name === 'list_tables') {
    const parsed = ListTablesArgsSchema.safeParse(args);
    if (!parsed.success) return invalid(parsed.error);
    return { kind: 'answer', result: textResult(JSON.stringify({ tables: config.tables }), false) };
  }
  if (name === 'describe') {
    const parsed = DescribeArgsSchema.safeParse(args);
    if (!parsed.success) return invalid(parsed.error);
    const { table } = parsed.data;
    if (!config.tables.includes(table)) return notAllowed(table);
    const [schema, relation] = table.split('.');
    return {
      kind: 'query',
      text:
        'SELECT column_name, data_type, is_nullable FROM information_schema.columns ' +
        'WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position',
      values: [schema, relation],
      answer: ({ rows }) =>
        rows.length === 0
          ? Promise.resolve(textResult('table not found', true))
          : jsonResult({
              table,
              columns: rows.map((row) => ({
                name: row['column_name'],
                type: row['data_type'],
                nullable: row['is_nullable'] === 'YES',
              })),
            }),
    };
  }
  if (name === 'select') {
    const parsed = selectArgsSchema(config.maxRows).safeParse(args);
    if (!parsed.success) return invalid(parsed.error);
    if (!config.tables.includes(parsed.data.table)) return notAllowed(parsed.data.table);
    const limit = parsed.data.limit ?? config.maxRows;
    const { text, values } = compileSelect(config, parsed.data);
    return {
      kind: 'query',
      text,
      values,
      answer: ({ rows, overBudget }) =>
        jsonResult({ rows: rows.slice(0, limit), truncated: overBudget || rows.length > limit }),
    };
  }
  return { kind: 'answer', result: textResult(`unknown tool ${JSON.stringify(name)}`, true) };
}

/** Every `sslmode` value libpq knows; any other is refused, never ignored. */
const SSL_MODES: ReadonlySet<string> = new Set([
  'disable',
  'allow',
  'prefer',
  'require',
  'verify-ca',
  'verify-full',
]);
/** The modes that accept plaintext, which is used only where the egress policy tolerates it. */
const PLAINTEXT_MODES: ReadonlySet<string | null> = new Set([null, 'disable', 'allow', 'prefer']);

type Target = {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly password: string;
  readonly database: string;
  readonly sslmode: string | null;
  readonly connectTimeoutSeconds: number | null;
  readonly applicationName: string | null;
};

class TargetRefusal extends Error {}

/** The connection URL's parts. Messages are fixed text: none repeats the URL. */
function parseTarget(credential: string): Target {
  let url: URL;
  let user: string;
  let password: string;
  let database: string;
  try {
    url = new URL(credential);
    user = decodeURIComponent(url.username);
    password = decodeURIComponent(url.password);
    database = decodeURIComponent(url.pathname.replace(/^\//u, ''));
  } catch {
    throw new TargetRefusal('the connector credential is not a usable URL');
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new TargetRefusal('the connector credential is not a postgres URL');
  }
  const sslmode = url.searchParams.get('sslmode');
  if (sslmode !== null && !SSL_MODES.has(sslmode)) {
    throw new TargetRefusal('unsupported sslmode');
  }
  const connectTimeout = url.searchParams.get('connect_timeout');
  if (connectTimeout !== null && !/^\d{1,9}$/u.test(connectTimeout)) {
    throw new TargetRefusal('connect_timeout must be a non-negative integer');
  }
  return {
    host: url.hostname,
    port: url.port === '' ? POSTGRES_PORT : Number(url.port),
    user,
    password,
    database,
    sslmode,
    connectTimeoutSeconds: connectTimeout === null ? null : Number(connectTimeout),
    applicationName: url.searchParams.get('application_name'),
  };
}

function isTimeout(error: unknown): boolean {
  if (error instanceof pg.DatabaseError) return error.code === '57014';
  // pg's client-side `query_timeout`, the backstop when the server does not answer.
  return error instanceof Error && error.message === 'Query read timeout';
}

/**
 * A bad value or an unknown column (SQLSTATE classes 22 and 42) is the caller's mistake, answered
 * with the SQLSTATE only. Every other failure is the upstream's, and no pg message is forwarded.
 */
function failure(error: unknown): CallToolResult {
  if (isTimeout(error)) return upstreamFailure('tool_upstream_timeout', 'the query timed out');
  if (error instanceof pg.DatabaseError && /^(?:22|42)[0-9A-Z]{3}$/u.test(error.code ?? '')) {
    return textResult(`the database refused the query (SQLSTATE ${String(error.code)})`, true);
  }
  return upstreamFailure('tool_upstream_failed', 'the database call failed');
}

type PoolEntry = { readonly version: string; readonly address: string; readonly pool: pg.Pool };

export function createPostgresExecutor(
  options: PostgresExecutorOptions = {},
): PostgresToolExecutor {
  const timeoutMs = options.timeoutMs ?? TOOL_UPSTREAM_TIMEOUT_MS;
  // ponytail: one Pool object per connector ever called, idle connections closed after 30s;
  // upgrade path: LRU eviction when connector counts grow
  const pools = new Map<string, PoolEntry>();

  async function poolFor(connectorId: string, credential: string): Promise<pg.Pool> {
    const target = parseTarget(credential);
    const decision = await checkHostEgress(
      target.host,
      options.policy ?? loadEgressPolicyFromEnv(),
      options.resolve,
    );
    if (!decision.ok) throw new TargetRefusal('the database host is refused by the egress policy');
    let ssl: false | ConnectionOptions;
    if (PLAINTEXT_MODES.has(target.sslmode) && decision.plaintextAllowed) {
      ssl = false;
    } else if (target.sslmode === 'disable') {
      throw new TargetRefusal('sslmode=disable is allowed only for a local loopback database');
    } else {
      // ponytail: Node's default CA store only (sslrootcert is refused by the contract), so a
      // private-CA database fails closed; upgrade path: a per-connector CA field in tool_config
      ssl = {
        rejectUnauthorized: true,
        ...(isIP(decision.host) === 0 ? { servername: decision.host } : {}),
      };
    }
    const [checked] = decision.addresses;
    if (checked === undefined) throw new TargetRefusal('the database host has no address');

    const version = createHash('sha256').update(credential).digest('hex');
    const cached = pools.get(connectorId);
    // A round-robin name may list its addresses in any order: the cached pool stays while its
    // pinned address is still among the ones just checked.
    if (
      cached?.version === version &&
      decision.addresses.some((candidate) => candidate.address === cached.address)
    ) {
      return cached.pool;
    }
    // A replaced pool is not ended: `end` would strand callers queued on it. Its clients finish
    // their queries and close after POOL_IDLE_MS idle.

    const seconds = target.connectTimeoutSeconds ?? 0;
    const pool = new pg.Pool({
      host: checked.address,
      port: target.port,
      user: target.user,
      // A function, so an empty password never falls back to PGPASSWORD or a pgpass file.
      password: () => target.password,
      database: target.database,
      ssl,
      max: POOL_MAX_CONNECTIONS,
      idleTimeoutMillis: POOL_IDLE_MS,
      connectionTimeoutMillis: seconds > 0 ? Math.min(seconds * 1000, timeoutMs) : timeoutMs,
      query_timeout: timeoutMs + 1000,
      allowExitOnIdle: true,
      ...(target.applicationName === null ? {} : { application_name: target.applicationName }),
    });
    // Without a listener, an idle client's error would crash the gateway process.
    pool.on('error', () => undefined);
    pools.set(connectorId, { version, address: checked.address, pool });
    return pool;
  }

  return {
    async call(connectorId, config, credential, name, args) {
      const prepared = prepare(config, name, args ?? {});
      if (prepared.kind === 'answer') return prepared.result;
      const secret = await credential();
      if (secret === null) {
        return upstreamFailure('tool_upstream_failed', 'the connector credential is unavailable');
      }
      try {
        const pool = await poolFor(connectorId, secret);
        const result = await readOnly(pool, timeoutMs, prepared.text, prepared.values);
        return await prepared.answer(result);
      } catch (error) {
        if (error instanceof TargetRefusal) {
          return upstreamFailure('tool_upstream_failed', error.message);
        }
        return failure(error);
      }
    },
    async close() {
      const entries = [...pools.values()];
      pools.clear();
      await Promise.all(entries.map((entry) => entry.pool.end()));
    },
  };
}
