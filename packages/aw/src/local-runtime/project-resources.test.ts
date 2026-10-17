import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { parseProjectFile } from '@indx-workspace/sdk/project';
import { afterAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { CliIo } from '../io.js';
import { FIXTURES, json, tempDirectory, tempFile } from '../testing.js';
import { localStartMessage } from './environment.js';
import { applyProjectResources, type ModelCheck } from './project-resources.js';

/**
 * Issue #547: `applyProjectResources` against a fetch double. `aw dev`'s own tests cover the path
 * end to end; these pin the fingerprint file and how each server answer is said.
 */

const KEY = 'sk-ant-api03-never-printed-0123456789';
const TOKEN = 'orders-token-never-printed';
const FINGERPRINTS = path.join('.agent-workspace', 'secret-fingerprints.json');

const YAML = `apiVersion: agentworkspace.dev/v2
kind: Project
name: demo
models:
  default:
    provider: anthropic
    credential:
      secret: ANTHROPIC_API_KEY
connectors:
  github:
    url: https://mcp.example.com
    auth:
      scheme: bearer
      credential:
        secret: ORDERS_TOKEN
environments:
  local:
    cloud: local
    identity:
      bootstrapAdmin: admin@localhost.test
`;

const directories: string[] = [];

afterAll(async () => {
  await Promise.all(
    directories.map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

interface Sent {
  readonly route: string;
  readonly body: string;
}

/** Answer each request with `answer`, recording it, and run the apply with `env`. */
async function apply(
  root: string,
  env: Readonly<Record<string, string>>,
  answer: (route: string) => Response,
  yaml = YAML,
  deferModelCheck = false,
): Promise<{
  readonly sent: Sent[];
  readonly stdout: string;
  readonly stderr: string;
  readonly check: ModelCheck;
}> {
  const sent: Sent[] = [];
  let stdout = '';
  let stderr = '';
  const fetchDouble: typeof fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const route = `${init?.method ?? 'GET'} ${url.pathname}`;
    sent.push({ route, body: typeof init?.body === 'string' ? init.body : '' });
    return Promise.resolve(answer(route));
  };
  const io: CliIo = {
    stdin: () => Promise.resolve(''),
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
    env,
    homeDir: root,
    fetch: fetchDouble,
    isTty: false,
  };
  const read = parseProjectFile(yaml);
  const check = await applyProjectResources({
    io,
    session: { baseUrl: 'http://127.0.0.1:3000', apiKey: 'ak_live_test', workspaceSlug: 'local' },
    read,
    start: localStartMessage(read, root),
    root,
    anthropicBaseUrl: undefined,
    signal: new AbortController().signal,
    deferModelCheck,
  });
  return { sent, stdout, stderr, check };
}

/** One apply whose discovery names `entry` as unavailable, with the model check deferred. */
async function applyDeferred(
  entry: Readonly<Record<string, unknown>>,
): Promise<{ readonly check: ModelCheck; readonly stderr: string }> {
  const { check, stderr } = await apply(
    await freshRoot(),
    { ANTHROPIC_API_KEY: KEY, ORDERS_TOKEN: TOKEN },
    (route) =>
      route === 'GET /api/models'
        ? json(200, { models: [], unavailable: [entry] })
        : existing(route),
    YAML,
    true,
  );
  return { check, stderr };
}

/** A workspace that holds both resources, with credentials, and accepts every rotation. */
function existing(route: string): Response {
  if (route === 'GET /api/model-connections') {
    return json(200, { models: [{ ...FIXTURES.modelConnection, name: 'default' }] });
  }
  if (route === 'GET /api/connectors') return json(200, { connectors: [FIXTURES.connector] });
  if (route === 'GET /api/models') return json(200, { models: [] });
  if (route.endsWith('/credential')) return new Response(null, { status: 204 });
  return json(200, FIXTURES.connector);
}

async function freshRoot(): Promise<string> {
  const root = await tempDirectory();
  directories.push(root);
  return root;
}

/** Every request but the two listings. */
const rotations = (sent: readonly Sent[]): readonly string[] =>
  sent.filter((request) => !request.route.startsWith('GET ')).map((request) => request.route);

describe('applyProjectResources', () => {
  it('records each fingerprint after its send, and sends nothing again while it matches', async () => {
    const root = await freshRoot();
    const env = { ANTHROPIC_API_KEY: KEY, ORDERS_TOKEN: TOKEN };
    const first = await apply(root, env, existing);
    expect(rotations(first.sent)).toEqual([
      `POST /api/model-connections/${FIXTURES.modelConnection.id}/credential`,
      `PATCH /api/connectors/${FIXTURES.connector.id}`,
    ]);
    const file = await readFile(path.join(root, FINGERPRINTS), 'utf8');
    expect(file).not.toContain(KEY);
    expect(file).not.toContain(TOKEN);
    expect(rotations((await apply(root, env, existing)).sent)).toEqual([]);
  });

  it('treats a malformed fingerprint file as nothing recorded, and rotates', async () => {
    const root = await freshRoot();
    await tempFile(root, FINGERPRINTS, '{ "key": "not base64", "fingerprints": {} }');
    const { sent } = await apply(root, { ANTHROPIC_API_KEY: KEY, ORDERS_TOKEN: TOKEN }, existing);
    expect(rotations(sent)).toHaveLength(2);
    await writeFile(path.join(root, FINGERPRINTS), 'not json');
    expect(rotations((await apply(root, { ANTHROPIC_API_KEY: KEY }, existing)).sent)).toHaveLength(
      1,
    );
  });

  it('says nothing about a 409 on a create: another aw dev made it first', async () => {
    const root = await freshRoot();
    const { stderr, stdout } = await apply(
      root,
      { ANTHROPIC_API_KEY: KEY, ORDERS_TOKEN: TOKEN },
      (route) => {
        if (route.startsWith('GET '))
          return json(200, route.includes('model') ? { models: [] } : { connectors: [] });
        return json(409, { error: { code: 'name_conflict', message: 'taken' } });
      },
    );
    expect(stderr).toBe('');
    expect(stdout).toBe('');
  });

  it('warns about a refused rotation and goes on with the next resource, printing no value', async () => {
    const root = await freshRoot();
    const { sent, stderr, stdout } = await apply(
      root,
      { ANTHROPIC_API_KEY: KEY, ORDERS_TOKEN: TOKEN },
      (route) =>
        route.endsWith('/credential')
          ? json(400, { error: { code: 'invalid_credential', message: 'refused' } })
          : existing(route),
    );
    expect(stderr).toContain('warning: could not set up the "default" model connection: ');
    expect(rotations(sent)).toContain(`PATCH /api/connectors/${FIXTURES.connector.id}`);
    expect(stdout).toContain('applied: connector github (updated)\n');
    expect(stdout).toContain(
      'connectors.github: MCP tools that write run without confirmation (ADR-0108)\n',
    );
    expect(stdout + stderr).not.toContain(KEY);
    expect(stdout + stderr).not.toContain(TOKEN);
    // Only the connector's fingerprint was recorded: the refused key is sent again next time.
    const recorded = z
      .object({ fingerprints: z.record(z.string(), z.string()) })
      .parse(JSON.parse(await readFile(path.join(root, FINGERPRINTS), 'utf8')));
    expect(Object.keys(recorded.fingerprints)).toEqual(['ORDERS_TOKEN']);
  });
  it('records a shared secret only once every resource naming it took the value (SD16)', async () => {
    const root = await freshRoot();
    const fastId = '0b4c3a52-8d6f-4f0e-9a1b-2c3d4e5f6a7b';
    const shared = `apiVersion: agentworkspace.dev/v2
kind: Project
name: demo
models:
  default:
    provider: anthropic
    credential:
      secret: ANTHROPIC_API_KEY
  fast:
    provider: anthropic
    credential:
      secret: ANTHROPIC_API_KEY
environments:
  local:
    cloud: local
    identity:
      bootstrapAdmin: admin@localhost.test
`;
    const both = (failFast: boolean) => (route: string) => {
      if (route === 'GET /api/model-connections') {
        return json(200, {
          models: [
            { ...FIXTURES.modelConnection, name: 'default' },
            { ...FIXTURES.modelConnection, id: fastId, name: 'fast' },
          ],
        });
      }
      if (failFast && route === `POST /api/model-connections/${fastId}/credential`) {
        return json(500, { error: { code: 'internal', message: 'boom' } });
      }
      return existing(route);
    };
    const env = { ANTHROPIC_API_KEY: KEY };
    const first = await apply(root, env, both(true), shared);
    expect(first.stderr).toContain('warning: could not set up the "fast" model connection: ');
    // The second send failed, so nothing is recorded and the next start sends both again.
    const second = await apply(root, env, both(false), shared);
    expect(rotations(second.sent)).toEqual([
      `POST /api/model-connections/${FIXTURES.modelConnection.id}/credential`,
      `POST /api/model-connections/${fastId}/credential`,
    ]);
    expect(rotations((await apply(root, env, both(false), shared)).sent)).toEqual([]);
  });

  it("names the declared connection's variable when its provider cannot be reached (#661)", async () => {
    const root = await freshRoot();
    const yaml = `apiVersion: agentworkspace.dev/v2
kind: Project
name: demo
models:
  main:
    provider: anthropic
    credential:
      secret: MAIN_MODEL_KEY
environments:
  local:
    cloud: local
    identity:
      bootstrapAdmin: admin@localhost.test
`;
    const reason = 'Model list unavailable (the provider could not be reached).';
    const { stderr, stdout } = await apply(
      root,
      { MAIN_MODEL_KEY: KEY },
      (route) => {
        if (route === 'GET /api/model-connections') {
          return json(200, { models: [{ ...FIXTURES.modelConnection, name: 'main' }] });
        }
        if (route === 'GET /api/models') {
          return json(200, {
            models: [],
            unavailable: [
              {
                connectionId: FIXTURES.modelConnection.id,
                connectionName: 'main',
                reason,
                kind: 'unreachable',
              },
              // A connection the project does not use is not this start's business.
              { connectionId: 'other-id', connectionName: 'stale', reason },
            ],
          });
        }
        return existing(route);
      },
      yaml,
    );
    expect(stderr).toBe(
      `warning: model connection "main": ${reason} The key was not rejected: check the base URL and this machine's network, then restart aw dev.\n`,
    );
    expect(stdout + stderr).not.toContain(KEY);
  });

  it('returns the problem for a rejected key, with its status and the variable to fix, when deferred', async () => {
    const found = await applyDeferred({
      connectionId: FIXTURES.modelConnection.id,
      connectionName: 'default',
      reason: 'The provider rejected the API key (HTTP 401). Replace the key on this connection.',
      kind: 'credential-rejected',
      status: 401,
    });
    expect(found.check).toEqual({
      checked: true,
      problems: [
        {
          connection: 'default',
          rejected: true,
          problem: 'the key was rejected (401)',
          fix: 'Set ANTHROPIC_API_KEY to a valid key and restart aw dev.',
        },
      ],
    });
    expect(found.stderr).not.toContain('warning: model connection');
  });

  it('does not say a key was not rejected when the failure is unclassified or the provider unsupported', async () => {
    for (const kind of [undefined, 'unsupported-provider']) {
      const found = await applyDeferred({
        connectionId: FIXTURES.modelConnection.id,
        connectionName: 'default',
        reason: 'Model list unavailable.',
        ...(kind === undefined ? {} : { kind }),
      });
      expect(found.check.problems).toEqual([
        {
          connection: 'default',
          problem: 'Model list unavailable.',
          fix: 'Restart aw dev to check again.',
        },
      ]);
    }
  });

  it('names no connection when the discovery call itself is refused', async () => {
    const { stderr } = await apply(
      await freshRoot(),
      { ANTHROPIC_API_KEY: KEY, ORDERS_TOKEN: TOKEN },
      (route) =>
        route === 'GET /api/models'
          ? json(500, { error: { code: 'internal', message: 'down' } })
          : existing(route),
      YAML,
    );
    expect(stderr.startsWith("warning: could not check the model connections' keys: ")).toBe(true);
    expect(stderr.endsWith(' Restart aw dev to check again.\n')).toBe(true);
  });

  it('checks no key when the project has no model connection yet', async () => {
    const root = await freshRoot();
    const { sent, stderr } = await apply(root, {}, (route) =>
      json(200, route.includes('model') ? { models: [] } : { connectors: [] }),
    );
    expect(sent.map((request) => request.route)).not.toContain('GET /api/models');
    expect(stderr).not.toContain('warning: model connection');
  });

  it('says a missing model key once: the planner notice only when the screen will not (#690)', async () => {
    const answer = (route: string): Response =>
      json(200, route.includes('model') ? { models: [] } : { connectors: [] });
    const quiet = await apply(await freshRoot(), {}, answer);
    expect(quiet.stderr).toContain('ANTHROPIC_API_KEY');
    const screen = await apply(await freshRoot(), {}, answer, YAML, true);
    expect(screen.stderr).not.toContain('ANTHROPIC_API_KEY');
  });

  it('lists every unset model key once, and still prints a prefix-named connector notice (#690)', async () => {
    const yaml = `apiVersion: agentworkspace.dev/v2
kind: Project
name: demo
models:
  first:
    provider: anthropic
    credential:
      secret: FIRST_KEY
  second:
    provider: anthropic
    credential:
      secret: SECOND_KEY
connectors:
  github:
    url: https://mcp.example.com
    auth:
      scheme: bearer
      credential:
        secret: FIRST_KEY_ORG
environments:
  local:
    cloud: local
    identity:
      bootstrapAdmin: admin@localhost.test
`;
    const answer = (route: string): Response =>
      json(200, route.includes('model') ? { models: [] } : { connectors: [] });
    const { stderr, check } = await apply(await freshRoot(), {}, answer, yaml, true);
    expect(check.problems.map((problem) => problem.secret)).toEqual(['FIRST_KEY', 'SECOND_KEY']);
    expect(stderr).not.toContain('notice: FIRST_KEY is not set');
    expect(stderr).not.toContain('notice: SECOND_KEY is not set');
    expect(stderr).toContain('notice: FIRST_KEY_ORG is not set');
  });

  it('lists an unset key whose connection the runtime lacks, though another connection passes (#690)', async () => {
    const { stderr, check } = await apply(
      await freshRoot(),
      { MAIN_KEY: KEY },
      modelRoute({ held: ['main'], rejected: [] }),
      modelsYaml(['main', 'fast']),
      true,
    );
    expect(check.problems.map((problem) => problem.secret)).toEqual(['FAST_KEY']);
    expect(stderr).not.toContain('FAST_KEY');
  });

  /*
   * The #690 invariant: every model problem — each unset model secret and each failed connection
   * check — is reported exactly once, as the ready screen's one row or a stderr line. `aw dev` shows
   * `check.problems[0]` and prints the rest with warningLine, so what is reported is the problem
   * list plus whatever this apply printed itself.
   */
  describe('reports every model problem exactly once (#690)', () => {
    interface State {
      readonly key: 'set' | 'unset';
      readonly connection: 'passing' | 'rejected' | 'not held';
    }
    const states: readonly State[] = (['set', 'unset'] as const).flatMap((key) =>
      (['passing', 'rejected', 'not held'] as const).map((connection) => ({ key, connection })),
    );
    interface Case {
      /** The declared `models`; none is the C6 `default` connection on ANTHROPIC_API_KEY. */
      readonly names: readonly string[];
      readonly states: readonly State[];
    }
    const cases: readonly Case[] = [
      ...states.map((state) => ({ names: [], states: [state] })),
      ...states.map((state) => ({ names: ['main'], states: [state] })),
      ...states.flatMap((a) => states.map((b) => ({ names: ['main', 'fast'], states: [a, b] }))),
    ];
    const connectionsOf = ({ names }: Case): readonly string[] =>
      names.length === 0 ? ['default'] : names;
    const label = (entry: Case): string =>
      connectionsOf(entry)
        .map((name, index) => {
          const state = entry.states[index];
          return `${name}: key ${state?.key ?? ''}, ${state?.connection ?? ''}`;
        })
        .join('; ');

    it.each(cases.map((entry) => [label(entry), entry] as const))('%s', async (_, entry) => {
      const connections = connectionsOf(entry);
      const secretOf = (name: string): string =>
        entry.names.length === 0 ? 'ANTHROPIC_API_KEY' : `${name.toUpperCase()}_KEY`;
      const stated = connections.map((name, index) => ({
        name,
        secret: secretOf(name),
        ...(entry.states[index] ?? { key: 'set', connection: 'passing' }),
      }));
      const env = Object.fromEntries(
        stated.filter(({ key }) => key === 'set').map(({ secret }) => [secret, KEY]),
      );
      const { stdout, stderr, check } = await apply(
        await freshRoot(),
        env,
        modelRoute({
          held: stated
            .filter(({ connection }) => connection !== 'not held')
            .map(({ name }) => name),
          rejected: stated
            .filter(({ connection }) => connection === 'rejected')
            .map(({ name }) => name),
        }),
        modelsYaml(entry.names),
        true,
      );

      const expected = stated.flatMap(({ name, secret, key, connection }) => [
        ...(key === 'unset' && connection !== 'passing' ? [`unset ${secret}`] : []),
        // A key unset on a passing connection is no problem: the plan's notice alone says it.
        ...(key === 'unset' && connection === 'passing' && entry.names.length > 0
          ? [`notice ${secret}`]
          : []),
        ...(connection === 'rejected' ? [`check ${name}`] : []),
      ]);
      const reported = [
        ...check.problems.map((problem) =>
          problem.secret === undefined
            ? `check ${problem.connection ?? ''}`
            : `unset ${problem.secret}`,
        ),
        ...[...stderr.matchAll(/^notice: (\w+) is not set:/gmu)].map(
          ([, name]) => `notice ${name}`,
        ),
        ...(stderr.includes('no "default" model connection yet')
          ? ['notice ANTHROPIC_API_KEY']
          : []),
        ...[...stderr.matchAll(/^warning: model connection "(\w+)"/gmu)].map(
          ([, name]) => `check ${name}`,
        ),
      ];
      expect(reported.sort()).toEqual(expected.sort());
      expect(stdout + stderr).not.toContain(KEY);
    });
  });
});

/** A project whose `models` are `names`, each on `<NAME>_KEY`; none declares no `models`. */
function modelsYaml(names: readonly string[]): string {
  const models = names
    .map(
      (name) =>
        `  ${name}:\n    provider: anthropic\n    credential:\n      secret: ${name.toUpperCase()}_KEY\n`,
    )
    .join('');
  return `apiVersion: agentworkspace.dev/v2
kind: Project
name: demo
${names.length === 0 ? '' : `models:\n${models}`}environments:
  local:
    cloud: local
    identity:
      bootstrapAdmin: admin@localhost.test
`;
}

/** A workspace holding the `held` model connections, whose discovery rejects the `rejected` ones. */
function modelRoute(options: {
  readonly held: readonly string[];
  readonly rejected: readonly string[];
}): (route: string) => Response {
  return (route) => {
    if (route === 'GET /api/model-connections') {
      return json(200, {
        models: options.held.map((name) => ({ ...FIXTURES.modelConnection, name })),
      });
    }
    if (route === 'GET /api/models') {
      return json(200, {
        models: [],
        unavailable: options.rejected.map((connectionName) => ({
          connectionId: FIXTURES.modelConnection.id,
          connectionName,
          reason: 'rejected',
          kind: 'credential-rejected',
          status: 401,
        })),
      });
    }
    if (route.endsWith('/credential')) return new Response(null, { status: 204 });
    return json(200, FIXTURES.modelConnection);
  };
}
