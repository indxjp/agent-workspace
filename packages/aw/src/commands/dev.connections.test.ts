import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { stripVTControlCharacters } from 'node:util';

import { describe, expect, it } from 'vitest';

import { EXIT_CODE } from '../output.js';
import { FIXTURES, json, type Route } from '../testing.js';
import {
  ANTHROPIC_KEY,
  SETTLE_MS,
  NO_AGENTS,
  READY,
  CREDENTIAL,
  sends,
  fakeRuntime,
  renderedYaml,
  project,
  dev,
  signedIn,
} from './dev.test-support.js';
import { modelConnections } from './dev.routes.test-support.js';

const CONNECTION_ID = FIXTURES.modelConnection.id;

/** A workspace whose default connection holds the base URL `stored()` answers. */
function connectionRoute(stored: () => string): Route {
  return (request) => {
    const { pathname } = request.url;
    if (pathname === `/api/model-connections/${CONNECTION_ID}/credential`) {
      return new Response(null, { status: 204 });
    }
    if (pathname === `/api/model-connections/${CONNECTION_ID}`) {
      return json(200, FIXTURES.modelConnection);
    }
    if (pathname === '/api/model-connections') {
      const config = { baseUrl: stored() };
      return json(200, { models: [{ ...FIXTURES.modelConnection, name: 'default', config }] });
    }
    return modelConnections([])(request);
  };
}

/** One `aw dev` start in `cwd` with `env`: the writes it sent and what it said on stderr. */
async function startWith(
  cwd: string,
  route: Route,
  env: Record<string, string>,
): Promise<{ readonly writes: unknown[]; readonly stderr: string }> {
  const { run } = await dev(cwd, {
    env,
    route,
    until: ({ stdout }) => stdout.includes('watching '),
  });
  expect(run.code, run.stderr).toBe(EXIT_CODE.interrupted);
  expect(run.stdout + run.stderr).not.toContain('sk-ant-fake-');
  const writes = run.calls
    .filter((call) => call.method !== 'GET')
    .map((call) => [call.method, call.url.pathname, call.json]);
  return { writes, stderr: run.stderr };
}

/** The base URL is recorded beside the fingerprints, never the key. */
async function expectRecordedBaseUrl(cwd: string, baseUrl: string): Promise<void> {
  const recorded = await readFile(
    path.join(cwd, '.agent-workspace', 'secret-fingerprints.json'),
    'utf8',
  );
  expect(JSON.parse(recorded)).toMatchObject({ anthropicBaseUrl: baseUrl });
  expect(recorded).not.toContain('sk-ant-fake-');
}

describe('aw dev (issue #451): restarts with a new key or base URL', () => {
  it('a restart with a new key or base URL updates the existing default connection (#732)', async () => {
    const cwd = await project({ script: fakeRuntime(sends(READY, CREDENTIAL)) });
    const id = CONNECTION_ID;
    /** The base URL the connection holds on the server; the Owner may change it in the UI. */
    let stored = 'https://old.example.com';
    const route = connectionRoute(() => stored);

    const first = await startWith(cwd, route, {
      ANTHROPIC_API_KEY: 'sk-ant-fake-rejected',
      ANTHROPIC_BASE_URL: 'https://new.example.com/v1',
    });
    expect(first.writes).toEqual([
      [
        'PATCH',
        `/api/model-connections/${id}`,
        // A new base URL carries the key: the server never sends the saved one to a new host.
        { config: { baseUrl: 'https://new.example.com/v1' }, apiKey: 'sk-ant-fake-rejected' },
      ],
      ['POST', `/api/model-connections/${id}/credential`, { apiKey: 'sk-ant-fake-rejected' }],
    ]);
    // The notice names the host only.
    expect(first.stderr).toContain(
      'notice: ANTHROPIC_BASE_URL changed: base URL updated to new.example.com\n',
    );
    await expectRecordedBaseUrl(cwd, 'https://new.example.com/v1');

    // Changed key, removed base URL: both reach the connection.
    const second = await startWith(cwd, route, { ANTHROPIC_API_KEY: 'sk-ant-fake-valid' });
    expect(second.writes).toEqual([
      ['PATCH', `/api/model-connections/${id}`, { config: {}, apiKey: 'sk-ant-fake-valid' }],
      ['POST', `/api/model-connections/${id}/credential`, { apiKey: 'sk-ant-fake-valid' }],
    ]);
    expect(second.stderr).toContain(
      'notice: ANTHROPIC_BASE_URL changed: base URL cleared to the provider default\n',
    );

    // The same key and an unchanged (unset) ANTHROPIC_BASE_URL: nothing is sent, so a base URL
    // the Owner set in the UI since is kept.
    stored = 'https://ui.example.com';
    const third = await startWith(cwd, route, { ANTHROPIC_API_KEY: 'sk-ant-fake-valid' });
    expect(third.writes).toEqual([]);
    expect(third.stderr).not.toContain('ANTHROPIC_BASE_URL changed');
  }, 30_000);
});

describe('aw dev (issue #451): says every rejected connection', () => {
  it('says every rejected connection with its own fix: the screen the first, stderr the rest (#690)', async () => {
    const yaml = `${renderedYaml()}models:
  first:
    provider: anthropic
    credential:
      secret: FIRST_KEY
  second:
    provider: anthropic
    credential:
      secret: SECOND_KEY
`;
    const cwd = await project({ yaml, script: fakeRuntime(sends(READY, CREDENTIAL)) });
    const rejected = (name: string): Record<string, unknown> => ({
      connectionId: FIXTURES.modelConnection.id,
      connectionName: name,
      reason: 'rejected',
      kind: 'credential-rejected',
      status: 401,
    });
    const route: Route = (request) => {
      const { pathname } = request.url;
      if (pathname === '/api/models') {
        return json(200, { models: [], unavailable: [rejected('first'), rejected('second')] });
      }
      if (pathname === '/api/model-connections' && request.method === 'GET') {
        return json(200, {
          models: ['first', 'second'].map((name) => ({ ...FIXTURES.modelConnection, name })),
        });
      }
      if (request.method !== 'GET') return json(200, FIXTURES.modelConnection);
      return json(404, { error: { code: 'not_found', message: 'no route' } });
    };
    const { run } = await dev(cwd, {
      env: { FIRST_KEY: ANTHROPIC_KEY, SECOND_KEY: ANTHROPIC_KEY },
      route,
      until: ({ stdout }) => stdout.includes('watching '),
    });
    expect(run.stdout).toContain('Set FIRST_KEY to a valid key and restart aw dev.');
    expect(run.stderr).toContain(
      'warning: model connection "second": the key was rejected (401) Set SECOND_KEY to a valid key and restart aw dev.',
    );
  });
});

describe('aw dev (issue #451): does not cross a passing connection', () => {
  it('does not cross an unset key whose connection passes: the rejected one is the screen row (#690)', async () => {
    const yaml = `${renderedYaml()}models:
  first:
    provider: anthropic
    credential:
      secret: FIRST_KEY
  second:
    provider: anthropic
    credential:
      secret: SECOND_KEY
`;
    const cwd = await project({ yaml, script: fakeRuntime(sends(READY, CREDENTIAL)) });
    const route: Route = (request) => {
      const { pathname } = request.url;
      if (pathname === '/api/models') {
        return json(200, {
          models: [],
          unavailable: [
            {
              connectionId: FIXTURES.modelConnection.id,
              connectionName: 'second',
              reason: 'rejected',
              kind: 'credential-rejected',
              status: 401,
            },
          ],
        });
      }
      if (pathname === '/api/model-connections' && request.method === 'GET') {
        return json(200, {
          models: ['first', 'second'].map((name) => ({ ...FIXTURES.modelConnection, name })),
        });
      }
      if (request.method !== 'GET') return json(200, FIXTURES.modelConnection);
      return json(404, { error: { code: 'not_found', message: 'no route' } });
    };
    const { run } = await dev(cwd, {
      env: { SECOND_KEY: ANTHROPIC_KEY },
      route,
      until: ({ stdout }) => stdout.includes('watching '),
    });
    expect(run.stdout).not.toContain('no FIRST_KEY in this shell');
    expect(run.stdout).toContain('Set SECOND_KEY to a valid key and restart aw dev.');
    expect(run.stderr).not.toContain('warning: model connection "second"');
    expect(run.stdout + run.stderr).not.toContain(ANTHROPIC_KEY);
  });
});

describe('aw dev (issue #451): reports unusable keys and refused creates', () => {
  it('on a terminal, a blank answer leaves the key missing and says the export line (#690)', async () => {
    const cwd = await project({ script: fakeRuntime(sends(READY, CREDENTIAL)) });
    const { run } = await dev(cwd, {
      tty: { pasted: '  ' },
      route: modelConnections([]),
      until: ({ stdout }) => stdout.includes('watching '),
    });
    expect(stripVTControlCharacters(run.stdout)).toContain(
      'model     no ANTHROPIC_API_KEY in this shell',
    );
    expect(run.calls.some((call) => call.method === 'POST')).toBe(false);
  });

  it('says an unreachable provider is not a rejected key (#690)', async () => {
    const cwd = await project({ script: fakeRuntime(sends(READY, CREDENTIAL)) });
    const route: Route = (request) =>
      request.url.pathname === '/api/models'
        ? json(200, {
            models: [],
            unavailable: [
              {
                connectionId: FIXTURES.modelConnection.id,
                connectionName: 'default',
                reason: 'The provider could not be connected to (connection refused).',
                kind: 'connection-failed',
              },
            ],
          })
        : modelConnections([])(request);
    const { run } = await dev(cwd, {
      env: { ANTHROPIC_API_KEY: ANTHROPIC_KEY },
      route,
      until: ({ stdout }) => stdout.includes('watching '),
    });
    expect(run.stdout).toContain('x model     The provider could not be connected to');
    expect(run.stdout).toContain('The key was not rejected');
    expect(run.stdout).not.toContain('was rejected (');
  });

  it('warns and keeps running when the server refuses the create', async () => {
    const cwd = await project({ script: fakeRuntime(sends(READY, CREDENTIAL)) });
    const route: Route = (request) =>
      request.method === 'POST'
        ? json(400, { error: { code: 'invalid_request', message: 'bad base url' } })
        : json(200, { models: [] });
    const { run } = await dev(cwd, {
      env: { ANTHROPIC_API_KEY: ANTHROPIC_KEY },
      route,
      until: signedIn,
    });
    expect(run.code).toBe(EXIT_CODE.interrupted);
    expect(run.stderr).toContain('warning: could not set up the "default" model connection');
    expect(run.stderr).not.toContain(ANTHROPIC_KEY);
  });
});

describe('aw dev (issue #451): keeps an existing default connection', () => {
  it('never re-creates an existing default connection', async () => {
    const cwd = await project({ script: fakeRuntime(sends(READY, CREDENTIAL)) });
    const controller = new AbortController();
    const route: Route = (request) => {
      // Nothing is printed after the listing, so stop once it has had time to be read.
      setTimeout(() => {
        controller.abort();
      }, SETTLE_MS);
      // No fingerprint is recorded in this fresh project, so its key is sent once (#732).
      if (request.url.pathname.endsWith('/credential')) return new Response(null, { status: 204 });
      return modelConnections(['default'])(request);
    };
    const { run } = await dev(cwd, {
      env: { ANTHROPIC_API_KEY: ANTHROPIC_KEY },
      route,
      controller,
    });
    expect(run.code).toBe(EXIT_CODE.interrupted);
    // The listing, the key's rotation, then the key check (#661): no create.
    expect(run.calls.map((call) => `${call.method} ${call.url.pathname}`)).toEqual([
      'GET /api/model-connections',
      `POST /api/model-connections/${FIXTURES.modelConnection.id}/credential`,
      'GET /api/models',
    ]);
    // The project has no agents/: the sync says so, sends nothing and keeps watching.
    expect(run.stderr).toBe(`${NO_AGENTS}\nstopping the local runtime…\ninterrupted\n`);
  });

  it('treats a 409 on create as the connection already existing', async () => {
    const cwd = await project({ script: fakeRuntime(sends(READY, CREDENTIAL)) });
    const controller = new AbortController();
    const route: Route = (request) => {
      if (request.method === 'GET') return json(200, { models: [] });
      setTimeout(() => {
        controller.abort();
      }, SETTLE_MS);
      return json(409, { error: { code: 'model_connection_name_conflict', message: 'taken' } });
    };
    const { run } = await dev(cwd, {
      env: { ANTHROPIC_API_KEY: ANTHROPIC_KEY },
      route,
      controller,
    });
    expect(run.code).toBe(EXIT_CODE.interrupted);
    expect(run.calls.map((call) => call.method)).toEqual(['GET', 'POST']);
    expect(run.stderr).toBe(`${NO_AGENTS}\nstopping the local runtime…\ninterrupted\n`);
  });
});
