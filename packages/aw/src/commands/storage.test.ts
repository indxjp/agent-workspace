// @story US-STO-12
import { randomBytes } from 'node:crypto';
import { rm } from 'node:fs/promises';

import { afterAll, describe, expect, it } from 'vitest';

import { EXIT_CODE } from '../output.js';
import { IDS, json, runCli, stdoutJson, tempDirectory, tempFile, type Route } from '../testing.js';

const AT = '2026-09-21T10:00:00.000Z';
const CONNECTION = {
  id: IDS.connection,
  name: 'acme',
  provider: 's3',
  url: 's3://acme-bucket',
  allowedPrefixes: ['reports'],
  writeAllowed: false,
  hasCredential: true,
  createdAt: AT,
  updatedAt: AT,
};
const problem = (status: number, code: string) =>
  json(status, { error: { code, message: `Refused: ${code}.` } });

const directory = await tempDirectory();
afterAll(() => rm(directory, { recursive: true, force: true }));

// Built at runtime: a key-shaped literal in the source would trip the secret scanner.
const secret = {
  provider: 's3',
  accessKeyId: ['AK', 'IA'].join('') + randomBytes(8).toString('hex').toUpperCase(),
  secretAccessKey: randomBytes(20).toString('base64url'),
};

function slices(text: string): string[] {
  return Array.from({ length: text.length - 5 }, (_, at) => text.slice(at, at + 6));
}

function request(run: { calls: readonly { method: string; url: URL }[] }) {
  return run.calls.map((call) => `${call.method} ${call.url.pathname}${call.url.search}`);
}

describe('aw storage connections', () => {
  it('[US-STO-12][api][cli] reads the credential from a file or stdin, never a flag', async () => {
    const file = await tempFile(directory, 'credential.json', JSON.stringify(secret));
    const route: Route = () => json(201, CONNECTION);
    const base = ['storage', 'connections', 'create', '--name', 'acme', '--storage-url'];

    const fromFile = await runCli(
      [...base, 's3://acme-bucket', '--allow', 'reports', '--credential-file', file],
      { route },
    );
    expect(fromFile.code).toBe(EXIT_CODE.ok);
    expect(fromFile.calls[0]?.json).toEqual({
      name: 'acme',
      url: 's3://acme-bucket',
      allowedPrefixes: ['reports'],
      writeAllowed: false,
      credential: secret,
    });

    const fromStdin = await runCli(
      [...base, 's3://acme-bucket', '--allow', 'a', '--allow', 'b', '--credential-file', '-'],
      { route, stdin: JSON.stringify(secret) },
    );
    expect(fromStdin.code).toBe(EXIT_CODE.ok);
    expect(fromStdin.calls[0]?.json).toMatchObject({ allowedPrefixes: ['a', 'b'] });

    for (const flag of ['--secret-access-key', '--access-key-id', '--credential']) {
      const refused = await runCli([...base, 's3://acme-bucket', '--allow', 'a', flag, 'x'], {
        route,
      });
      expect(refused.code).toBe(EXIT_CODE.usage);
      expect(refused.calls).toHaveLength(0);
    }
  });

  it('[US-STO-12][api][cli] refuses a bad credential or body before any request', async () => {
    const notJson = await tempFile(directory, 'early.txt', 'not json');
    const credential = ['storage', 'connections', 'credential', 'acme'];
    for (const argv of [
      credential,
      [...credential, '--credential-file', notJson],
      ['storage', 'connections', 'update', 'acme'],
      ['storage', 'connections', 'update', 'acme', '--credential-file', notJson],
    ]) {
      const refused = await runCli(argv, { route: () => json(200, CONNECTION) });
      expect(refused.code, argv.join(' ')).toBe(EXIT_CODE.usage);
      expect(refused.calls).toHaveLength(0);
    }
  });

  it('[US-STO-12][api][cli] never echoes the credential, on success or failure', async () => {
    const good = await tempFile(directory, 'good.json', JSON.stringify(secret));
    const notJson = await tempFile(directory, 'raw.txt', secret.secretAccessKey);
    const wrongShape = await tempFile(
      directory,
      'shape.json',
      JSON.stringify({ provider: 's3', accessKeyId: secret.accessKeyId }),
    );
    const missing = `${directory}/${secret.secretAccessKey}.json`;
    const ok: Route = (call) =>
      call.method === 'GET' && call.url.pathname === '/api/storage-connections'
        ? json(200, { connections: [CONNECTION] })
        : json(call.method === 'POST' ? 201 : 200, CONNECTION);
    const create = ['storage', 'connections', 'create', '--name', 'acme', '--storage-url'];
    const attempts: { argv: string[]; route: Route; stdin?: string; code: number }[] = [
      {
        argv: [...create, 's3://acme-bucket', '--allow', 'a', '--credential-file', good],
        route: ok,
        code: 0,
      },
      {
        argv: [...create, 's3://acme-bucket', '--allow', 'a', '--credential-file', '-', '--json'],
        route: ok,
        stdin: JSON.stringify(secret),
        code: 0,
      },
      {
        argv: ['storage', 'connections', 'credential', 'acme', '--credential-file', good],
        route: ok,
        code: 0,
      },
      { argv: ['storage', 'connections', 'get', 'acme', '--json'], route: ok, code: 0 },
      { argv: ['storage', 'connections', 'list'], route: ok, code: 0 },
      { argv: ['storage', 'connections', 'list', '--json'], route: ok, code: 0 },
      ...[notJson, wrongShape, missing].map((file) => ({
        argv: ['storage', 'connections', 'credential', 'acme', '--credential-file', file],
        route: ok,
        code: EXIT_CODE.usage,
      })),
      {
        argv: ['storage', 'connections', 'credential', 'acme', '--credential-file', '-'],
        route: ok,
        stdin: `${secret.secretAccessKey} not json`,
        code: EXIT_CODE.usage,
      },
      {
        argv: ['storage', 'connections', 'remove', 'acme'],
        route: (call) =>
          call.method === 'DELETE' ? problem(409, 'storage_connection_in_use') : ok(call),
        code: EXIT_CODE.problem,
      },
      {
        argv: [
          'storage',
          'connections',
          'update',
          'acme',
          '--storage-url',
          's3://other-bucket',
          '--credential-file',
          good,
        ],
        route: (call) =>
          call.method === 'PATCH'
            ? problem(409, 'storage_connection_credential_required')
            : ok(call),
        code: EXIT_CODE.problem,
      },
      {
        argv: ['storage', 'connections', 'credential', 'acme', '--credential-file', good],
        route: () => problem(404, 'storage_connection_not_found'),
        code: EXIT_CODE.problem,
      },
    ];

    const needles = [...slices(secret.accessKeyId), ...slices(secret.secretAccessKey)];
    for (const attempt of attempts) {
      const run = await runCli(attempt.argv, {
        route: attempt.route,
        ...(attempt.stdin === undefined ? {} : { stdin: attempt.stdin }),
      });
      expect(run.code, run.stderr).toBe(attempt.code);
      const output = `${run.stdout}\n${run.stderr}`;
      expect(needles.filter((needle) => output.includes(needle))).toEqual([]);
    }
  });

  it('[US-STO-12][api][cli] resolves a name with one list call and an id with one get', async () => {
    const route: Route = (call) =>
      call.url.pathname === '/api/storage-connections'
        ? json(200, { connections: [CONNECTION] })
        : json(200, CONNECTION);

    const byName = await runCli(['storage', 'connections', 'get', 'acme', '--json'], { route });
    expect(request(byName)).toEqual(['GET /api/storage-connections']);
    expect(stdoutJson(byName)).toEqual(CONNECTION);

    const byId = await runCli(['storage', 'connections', 'get', IDS.connection, '--json'], {
      route,
    });
    expect(request(byId)).toEqual([`GET /api/storage-connections/${IDS.connection}`]);

    const removed = await runCli(['storage', 'connections', 'remove', 'acme'], {
      route: (call) => (call.method === 'DELETE' ? json(204, null) : route(call)),
    });
    expect(removed.code).toBe(EXIT_CODE.ok);
    expect(request(removed)).toEqual([
      'GET /api/storage-connections',
      `DELETE /api/storage-connections/${IDS.connection}`,
    ]);

    const unknown = await runCli(['storage', 'connections', 'get', 'nope'], {
      route: () => json(200, { connections: [] }),
    });
    expect(unknown.code).toBe(EXIT_CODE.problem);
    expect(unknown.stderr).toContain('error: storage_connection_not_found:');
  });

  it('[US-STO-12][api][cli] exits 1 when the connection test fails', async () => {
    const route =
      (outcome: unknown): Route =>
      (call) =>
        call.method === 'POST' ? json(200, outcome) : json(200, CONNECTION);
    const failed = await runCli(['storage', 'connections', 'test', IDS.connection, '--json'], {
      route: route({ ok: false, code: 'forbidden' }),
    });
    expect(failed.code).toBe(EXIT_CODE.problem);
    expect(stdoutJson(failed)).toEqual({ ok: false, code: 'forbidden' });

    const passed = await runCli(['storage', 'connections', 'test', IDS.connection], {
      route: route({ ok: true }),
    });
    expect(passed.code).toBe(EXIT_CODE.ok);
  });
});

describe('aw storage ls', () => {
  const browse =
    (pages: Record<string, unknown>): Route =>
    (call) => {
      if (call.url.pathname === '/api/storage-connections') {
        return json(200, { connections: [CONNECTION] });
      }
      return json(200, pages[call.url.searchParams.get('cursor') ?? ''] ?? { entries: [] });
    };

  it('[US-STO-12][api][cli] splits on the first slash and sends the rest as the prefix', async () => {
    const cases: [string, string][] = [
      ['acme', ''],
      ['acme/a/b/', '?prefix=a%2Fb%2F'],
      ['acme/Q3 reports/', '?prefix=Q3%20reports%2F'],
    ];
    for (const [target, query] of cases) {
      const run = await runCli(['storage', 'ls', target], { route: browse({}) });
      expect(run.code).toBe(EXIT_CODE.ok);
      expect(request(run)).toEqual([
        'GET /api/storage-connections',
        `GET /api/storage-connections/${IDS.connection}/browse${query}`,
      ]);
    }
  });

  it('[US-STO-12][api][cli] pages through every entry into one --json array', async () => {
    const run = await runCli(['storage', 'ls', 'acme/reports/', '--json'], {
      route: browse({
        '': { entries: [{ path: 'reports/a.txt', kind: 'file', size: 3 }], next: 'p2' },
        p2: { entries: [{ path: 'reports/2026', kind: 'folder' }] },
      }),
    });
    expect(stdoutJson(run)).toEqual([
      { path: 'reports/a.txt', kind: 'file', size: 3 },
      { path: 'reports/2026', kind: 'folder' },
    ]);
    expect(run.calls.map((call) => call.url.searchParams.get('cursor'))).toEqual([
      null,
      null,
      'p2',
    ]);

    const table = await runCli(['storage', 'ls', 'acme/reports/'], {
      route: browse({ '': { entries: [{ path: 'reports/a.txt', kind: 'file', size: 3 }] } }),
    });
    expect(table.stdout).toContain('reports/a.txt');
  });

  it('[US-STO-12][api][cli] prints one error line for a refused folder', async () => {
    const run = await runCli(['storage', 'ls', 'acme/private/'], {
      route: (call) =>
        call.url.pathname === '/api/storage-connections'
          ? json(200, { connections: [CONNECTION] })
          : problem(403, 'storage_connection_prefix_not_allowed'),
    });
    expect(run.code).toBe(EXIT_CODE.problem);
    expect(run.stderr).toContain('error: storage_connection_prefix_not_allowed:');
    expect(run.stdout).toBe('');

    const empty = await runCli(['storage', 'ls', '/reports']);
    expect(empty.code).toBe(EXIT_CODE.usage);
    expect(empty.calls).toHaveLength(0);
  });
});
