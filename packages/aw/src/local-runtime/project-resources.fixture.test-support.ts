import { rm } from 'node:fs/promises';
import path from 'node:path';
import { parseProjectFile } from '@indx-workspace/sdk/project';
import { afterAll } from 'vitest';
import type { CliIo } from '../io.js';
import { FIXTURES, json, tempDirectory } from '../testing.js';
import { localStartMessage } from './environment.js';
import { applyProjectResources, type ModelCheck } from './project-resources.js';

/**
 * Issue #547: `applyProjectResources` against a fetch double. `aw dev`'s own tests cover the path
 * end to end; these pin the fingerprint file and how each server answer is said.
 */

export const KEY = 'sk-ant-api03-never-printed-0123456789';

export const TOKEN = 'orders-token-never-printed';

export const FINGERPRINTS = path.join('.agent-workspace', 'secret-fingerprints.json');

export const YAML = `apiVersion: agentworkspace.dev/v2
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
export async function apply(options: {
  readonly root: string;
  readonly env: Readonly<Record<string, string>>;
  readonly answer: (route: string) => Response;
  readonly yaml?: string;
  readonly deferModelCheck?: boolean;
}): Promise<{
  readonly sent: Sent[];
  readonly stdout: string;
  readonly stderr: string;
  readonly check: ModelCheck;
}> {
  const { root, env, answer, yaml = YAML, deferModelCheck = false } = options;
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
    session: {
      baseUrl: 'http://127.0.0.1:3000',
      apiKey: 'ak_live_test',
      workspaceId: '0b9d6c1e-4f3a-4b2c-9d8e-7f6a5b4c3d2e',
      workspaceSlug: 'local',
    },
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
export async function applyDeferred(
  entry: Readonly<Record<string, unknown>>,
): Promise<{ readonly check: ModelCheck; readonly stderr: string }> {
  const { check, stderr } = await apply({
    root: await freshRoot(),
    env: { ANTHROPIC_API_KEY: KEY, ORDERS_TOKEN: TOKEN },
    answer: (route) =>
      route === 'GET /api/models'
        ? json(200, { models: [], unavailable: [entry] })
        : existing(route),
    yaml: YAML,
    deferModelCheck: true,
  });
  return { check, stderr };
}

/** A workspace that holds both resources, with credentials, and accepts every rotation. */
export function existing(route: string): Response {
  if (route === 'GET /api/model-connections') {
    return json(200, { models: [{ ...FIXTURES.modelConnection, name: 'default' }] });
  }
  if (route === 'GET /api/connectors') return json(200, { connectors: [FIXTURES.connector] });
  if (route === 'GET /api/models') return json(200, { models: [] });
  if (route.endsWith('/credential')) return new Response(null, { status: 204 });
  return json(200, FIXTURES.connector);
}

export async function freshRoot(): Promise<string> {
  const root = await tempDirectory();
  directories.push(root);
  return root;
}

/** Every request but the two listings. */
export const rotations = (sent: readonly Sent[]): readonly string[] =>
  sent.filter((request) => !request.route.startsWith('GET ')).map((request) => request.route);

/** A project whose `models` are `names`, each on `<NAME>_KEY`; none declares no `models`. */
export function modelsYaml(names: readonly string[]): string {
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
export function modelRoute(options: {
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
