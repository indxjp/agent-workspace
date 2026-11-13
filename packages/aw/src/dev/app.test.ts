import { EventEmitter } from 'node:events';
import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PassThrough } from 'node:stream';

import type { ConnectorResource } from '@indx-workspace/contracts/connectors';
import {
  PROJECT_API_VERSION,
  PROJECT_KIND,
  type ProjectRead,
} from '@indx-workspace/contracts/project-file';
import { createClient, type AgentWorkspaceClient } from '@indx-workspace/sdk';
import { fixtures } from '@indx-workspace/sdk/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CommandRefusedError } from '../io.js';
import { json, tempDirectory } from '../testing.js';
import {
  APP_IDENTITY_FILE,
  appIdentitySecret,
  appIdentitySecretName,
  detectApp,
  ownerOnlyIdentityNotice,
  settleAppConnector,
  startApp,
  startDevApp,
  storeAppIdentitySecret,
  withAppConnector,
  type AppChild,
  type AppDeps,
  type StartAppOptions,
} from './app.js';

/**
 * Issue #1506: `aw dev` with a generated app. Every effect (the migration, `next dev`, ports, the
 * MCP probe, the control plane) is a fake, so these cases never start a server.
 */

const WORKSPACE_ID = '0b9d6c1e-4f3a-4b2c-9d8e-7f6a5b4c3d2e';
const SECRET_ID = '2c9d6c1e-4f3a-4b2c-9d8e-7f6a5b4c3d2e';
const DATABASE_URL = 'postgresql://agent_workspace:agent_workspace_local@127.0.0.1:25432/postgres';
const AT = '2026-10-31T10:00:00.000Z';

const READ: ProjectRead = {
  lifted: false,
  project: {
    apiVersion: PROJECT_API_VERSION,
    kind: PROJECT_KIND,
    name: 'desk-project',
    environments: {
      local: { cloud: 'local', identity: { bootstrapAdmin: 'admin@localhost.test' } },
    },
  },
};

const MANIFEST = {
  version: 1,
  entries: {
    'app:desk': { files: {}, edits: [] },
    'resource:ticket': { files: {}, edits: [] },
  },
};

afterEach(() => {
  vi.restoreAllMocks();
});

async function projectWith(manifest?: unknown): Promise<string> {
  const cwd = await tempDirectory();
  if (manifest !== undefined) {
    await writeFile(path.join(cwd, 'aw-generated.json'), `${JSON.stringify(manifest)}\n`);
  }
  return cwd;
}

/** The connector `aw dev` registered for `desk` on an earlier start. */
function appConnectorResource(overrides: Partial<ConnectorResource> = {}): ConnectorResource {
  return fixtures.connector({
    id: '3c9d6c1e-4f3a-4b2c-9d8e-7f6a5b4c3d2e',
    name: 'desk',
    url: 'http://127.0.0.1:3100/api/mcp',
    authType: 'none',
    hasCredential: false,
    identity: { secret: 'APP_DESK_IDENTITY' },
    ...overrides,
  });
}

/** A fake child process: it exits when killed. */
function fakeChild(): AppChild & { readonly killed: NodeJS.Signals[] } {
  const events = new EventEmitter();
  const killed: NodeJS.Signals[] = [];
  const child = {
    killed,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill(signal: NodeJS.Signals = 'SIGTERM') {
      killed.push(signal);
      child.signalCode = signal;
      queueMicrotask(() => events.emit('exit', null));
      return true;
    },
    once(event: 'exit', listener: (code: number | null) => void) {
      events.once(event, listener);
      return child;
    },
  };
  return child;
}

interface Harness {
  readonly deps: AppDeps;
  readonly events: string[];
  readonly spawned: { readonly args: readonly string[]; readonly env: Record<string, string> }[];
  readonly children: ReturnType<typeof fakeChild>[];
}

function harness(
  options: { readonly migrateCode?: number; readonly busy?: number[] } = {},
): Harness {
  const events: string[] = [];
  const spawned: Harness['spawned'] = [];
  const children: ReturnType<typeof fakeChild>[] = [];
  const deps: AppDeps = {
    migrate: ({ appName, databaseUrl }) => {
      events.push(`migrate:${appName}:${databaseUrl === DATABASE_URL ? 'url' : 'other'}`);
      return Promise.resolve(
        options.migrateCode === undefined || options.migrateCode === 0
          ? { code: 0, stderr: '' }
          : { code: options.migrateCode, stderr: 'error: App migration drift in app_desk\n' },
      );
    },
    nextBin: () => Promise.resolve('/project/node_modules/next/dist/bin/next'),
    spawn: (_command, args, spawnOptions) => {
      events.push(`spawn:${args.slice(1).join(' ')}`);
      spawned.push({ args, env: spawnOptions.env });
      const child = fakeChild();
      children.push(child);
      return child;
    },
    isFree: (port) => Promise.resolve(!(options.busy ?? []).includes(port)),
    fetch: (input) => {
      events.push(
        `probe:${typeof input === 'string' ? input : input instanceof URL ? input.href : input.url}`,
      );
      return Promise.resolve(new Response(null, { status: 405 }));
    },
    log: () => Promise.resolve(new PassThrough()),
  };
  return { deps, events, spawned, children };
}

function startOptions(cwd: string, overrides: Partial<StartAppOptions> = {}): StartAppOptions {
  return {
    cwd,
    appName: 'desk',
    webPort: 3000,
    environment: {
      awUrl: 'http://127.0.0.1:3000',
      databaseUrl: DATABASE_URL,
      workspaceId: WORKSPACE_ID,
      apiKey: 'ak_live_local',
      identitySecret: 'identity-key',
    },
    connectorId: undefined,
    env: { PATH: '/usr/bin', AGENT_WORKSPACE_API_KEY: 'ak_live_other', NODE_OPTIONS: '--x' },
    signal: new AbortController().signal,
    ...overrides,
  };
}

/** A stateful double of the control plane's connectors and secrets, through the SDK client. */
function controlPlane(
  connectors: ConnectorResource[] = [],
  options: { readonly admin?: true } = {},
) {
  const bodies: string[] = [];
  const secrets: { id: string; name: string }[] = [];
  const secret = (id: string, name: string) => ({
    id,
    name,
    algorithm: 'aes-256-gcm',
    masterKeyId: 'local',
    createdAt: AT,
    updatedAt: AT,
  });
  const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? init.body : '';
    if (body !== '') bodies.push(body);
    // Spec §21: secrets are an Owner's, and the runtime's key is an Admin's.
    if (options.admin === true && url.pathname.startsWith('/api/secrets')) {
      return json(403, {
        error: { code: 'forbidden', message: 'read on "secrets" is granted "none"' },
      });
    }
    if (method === 'GET' && url.pathname === '/api/connectors') return json(200, { connectors });
    if (method === 'GET' && url.pathname === '/api/secrets') {
      const name = url.searchParams.get('name');
      const found = secrets.filter((entry) => entry.name === name);
      return found.length === 0
        ? json(404, { error: { code: 'secret_not_found', message: 'no secret' } })
        : json(200, { secrets: found.map((entry) => secret(entry.id, entry.name)) });
    }
    if (method === 'POST' && url.pathname === '/api/secrets') {
      const { name } = JSON.parse(body) as { name: string };
      secrets.push({ id: SECRET_ID, name });
      return json(201, secret(SECRET_ID, name));
    }
    if (method === 'PUT' && url.pathname.startsWith('/api/secrets/')) {
      const id = url.pathname.slice('/api/secrets/'.length);
      return json(200, secret(id, secrets.find((entry) => entry.id === id)?.name ?? 'X'));
    }
    await Promise.resolve();
    return json(404, { error: { code: 'not_found', message: `${method} ${url.pathname}` } });
  };
  const client: AgentWorkspaceClient = createClient({
    baseUrl: 'http://127.0.0.1:3000',
    auth: { kind: 'api-key', apiKey: 'ak_live_local' },
    fetch,
  });
  return { client, bodies, connectors, secrets };
}

describe('detectApp', () => {
  it('finds no app without a manifest, so aw dev starts nothing', async () => {
    expect(await detectApp(await projectWith())).toBeNull();
  });

  it('finds no app in a manifest that records none', async () => {
    const cwd = await projectWith({
      version: 1,
      entries: { 'agent:triage': { files: {}, edits: [] } },
    });
    expect(await detectApp(cwd)).toBeNull();
  });

  it('finds the app the manifest records', async () => {
    expect(await detectApp(await projectWith(MANIFEST))).toStrictEqual({ name: 'desk' });
  });

  it('refuses a manifest that is not one', async () => {
    const cwd = await projectWith({ version: 2 });
    await expect(detectApp(cwd)).rejects.toBeInstanceOf(CommandRefusedError);
  });
});

describe('appIdentitySecret', () => {
  it('makes a 32-byte key once, in an owner-only file, and reads it back after', async () => {
    const cwd = await projectWith();
    const first = await appIdentitySecret(cwd);
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(await appIdentitySecret(cwd)).toBe(first);
    if (process.platform !== 'win32') {
      expect((await stat(path.join(cwd, APP_IDENTITY_FILE))).mode & 0o777).toBe(0o600);
    }
  });

  it('refuses a file it did not write', async () => {
    const cwd = await projectWith();
    await appIdentitySecret(cwd);
    await writeFile(path.join(cwd, APP_IDENTITY_FILE), '{"secret":"x"}');
    await expect(appIdentitySecret(cwd)).rejects.toThrow(/app_identity_unreadable/u);
  });

  it('names the workspace secret after the app', () => {
    expect(appIdentitySecretName('desk')).toBe('APP_DESK_IDENTITY');
    expect(appIdentitySecretName('help-desk')).toBe('APP_HELP_DESK_IDENTITY');
  });
});

describe('storeAppIdentitySecret', () => {
  it('stores the key as the workspace secret once; a second aw dev sends nothing', async () => {
    const cwd = await projectWith();
    const plane = controlPlane();
    const options = {
      cwd,
      appName: 'desk',
      workspaceId: WORKSPACE_ID,
      signal: AbortSignal.timeout(5000),
    };
    expect(await storeAppIdentitySecret(plane.client, options)).toBe('stored');
    expect(plane.secrets).toStrictEqual([{ id: SECRET_ID, name: 'APP_DESK_IDENTITY' }]);
    const sent = plane.bodies.length;
    expect(await storeAppIdentitySecret(plane.client, options)).toBe('unchanged');
    expect(plane.bodies.length).toBe(sent);
  });

  it('stores nothing and says owner-only where the runtime key may not write secrets', async () => {
    const cwd = await projectWith();
    const plane = controlPlane([], { admin: true });
    const options = {
      cwd,
      appName: 'desk',
      workspaceId: WORKSPACE_ID,
      signal: AbortSignal.timeout(5000),
    };
    expect(await storeAppIdentitySecret(plane.client, options)).toBe('owner-only');
    expect(plane.secrets).toStrictEqual([]);
    const notice = ownerOnlyIdentityNotice('desk');
    expect(notice).toContain('APP_DESK_IDENTITY');
    expect(notice).toContain(APP_IDENTITY_FILE);
    expect(notice).not.toContain(await appIdentitySecret(cwd));
  });
});

describe('withAppConnector', () => {
  const URL_ = 'http://127.0.0.1:3100/api/mcp';

  it('adds the app connector with its identity reference to the plan input only', () => {
    const result = withAppConnector(READ, 'desk', URL_, []);
    expect(result.connectorId).toBeUndefined();
    expect(result.read.lifted).toBe(false);
    expect(!result.read.lifted && result.read.project.connectors).toStrictEqual({
      desk: { url: URL_, transport: 'http', identity: { secret: 'APP_DESK_IDENTITY' } },
    });
    // The project file read from disk is not changed.
    expect(READ.project.connectors).toBeUndefined();
  });

  it('keeps the id of the connector aw dev registered before', () => {
    const registered = appConnectorResource();
    expect(withAppConnector(READ, 'desk', URL_, [registered]).connectorId).toBe(registered.id);
  });

  it.each([
    ['a credential', appConnectorResource({ authType: 'bearer', hasCredential: true })],
    ['another host', appConnectorResource({ url: 'https://desk.example.com/api/mcp' })],
    ['another identity secret', appConnectorResource({ identity: { secret: 'OTHER_KEY' } })],
    ['no identity', appConnectorResource({ identity: undefined })],
    ['another route', appConnectorResource({ url: 'http://127.0.0.1:3100/mcp' })],
  ])('refuses a foreign connector named like the app (%s)', (_case, foreign) => {
    expect(() => withAppConnector(READ, 'desk', URL_, [foreign])).toThrow(
      /^app_connector_conflict: a connector named desk that aw dev did not create/u,
    );
  });

  it('refuses a project file that declares a connector named like the app', () => {
    const read: ProjectRead = {
      lifted: false,
      project: { ...READ.project, connectors: { desk: { url: 'https://mcp.example.com/mcp' } } },
    };
    expect(() => withAppConnector(read, 'desk', URL_, [])).toThrow(
      /^app_connector_conflict: agent-workspace.yaml declares a connector named desk/u,
    );
  });
});

describe('startApp', () => {
  it('migrates before next dev, on the first free port from webPort + 100, and waits for 405', async () => {
    const h = harness({ busy: [3100] });
    const app = await startApp(startOptions(await projectWith()), h.deps);
    expect(h.events).toStrictEqual([
      'migrate:desk:url',
      'spawn:dev -p 3101 -H 127.0.0.1',
      'probe:http://127.0.0.1:3101/api/mcp',
    ]);
    expect(app.origin).toBe('http://127.0.0.1:3101');
    expect(app.mcpUrl).toBe('http://127.0.0.1:3101/api/mcp');
    await app.stop();
  });

  it('starts the app with the own values of aw dev and nothing else of its environment', async () => {
    const h = harness();
    const app = await startApp(startOptions(await projectWith()), h.deps);
    expect(h.spawned[0]?.env).toStrictEqual({
      PATH: '/usr/bin',
      NEXT_TELEMETRY_DISABLED: '1',
      PORT: '3100',
      AW_URL: 'http://127.0.0.1:3000',
      AW_APP_NAME: 'desk',
      DATABASE_URL,
      AW_WORKSPACE_ID: WORKSPACE_ID,
      AW_APP_IDENTITY_SECRET: 'identity-key',
      AW_APP_API_KEY: 'ak_live_local',
    });
    await app.stop();
  });

  it('refuses the app when the migration fails, with its stderr, and never starts next dev', async () => {
    const h = harness({ migrateCode: 1 });
    await expect(startApp(startOptions(await projectWith()), h.deps)).rejects.toThrow(
      'app_migration_failed: aw-app migrate could not migrate the desk app: App migration drift in app_desk',
    );
    expect(h.events).toStrictEqual(['migrate:desk:url']);
  });

  it('restarts once with a new connector id, and not for the id it runs with', async () => {
    const h = harness();
    const app = await startApp(startOptions(await projectWith()), h.deps);
    expect(await app.restartWith('3c9d6c1e-4f3a-4b2c-9d8e-7f6a5b4c3d2e')).toBe(true);
    expect(h.children[0]?.killed).toStrictEqual(['SIGTERM']);
    expect(h.spawned[1]?.env['AW_APP_CONNECTOR_ID']).toBe('3c9d6c1e-4f3a-4b2c-9d8e-7f6a5b4c3d2e');
    expect(await app.restartWith('3c9d6c1e-4f3a-4b2c-9d8e-7f6a5b4c3d2e')).toBe(false);
    expect(h.spawned).toHaveLength(2);
    await app.stop();
  });

  it('registers at the dev issuer with its callback and carries the five sign-in names (#2075)', async () => {
    const h = harness();
    const registered: string[] = [];
    const appBackend = { clientId: 'client-1', clientSecret: 'app-backend-secret' };
    const app = await startApp(
      startOptions(await projectWith(), {
        oidcClient: (redirectUri) => {
          registered.push(redirectUri);
          return {
            issuerUrl: 'http://127.0.0.1:3200',
            clientId: 'desk',
            clientSecret: 'issuer-secret',
          };
        },
        appBackend,
      }),
      h.deps,
    );
    expect(registered).toStrictEqual(['http://127.0.0.1:3100/api/sign-in/callback']);
    expect(h.spawned[0]?.env).toMatchObject({
      AW_OIDC_ISSUER_URL: 'http://127.0.0.1:3200',
      AW_OIDC_CLIENT_ID: 'desk',
      AW_OIDC_CLIENT_SECRET: 'issuer-secret',
      AW_APP_CLIENT_ID: 'client-1',
      AW_APP_CLIENT_SECRET: 'app-backend-secret',
    });
    expect(h.spawned[0]?.args.join(' ')).not.toContain('secret');
    await app.stop();
  });

  it('restarts once to take a new app-backend pair, and not for the pair it runs with', async () => {
    const h = harness();
    const connector = '3c9d6c1e-4f3a-4b2c-9d8e-7f6a5b4c3d2e';
    const app = await startApp(
      startOptions(await projectWith(), { connectorId: connector }),
      h.deps,
    );
    expect(h.spawned[0]?.env['AW_APP_CLIENT_ID']).toBeUndefined();
    const pair = { clientId: 'client-1', clientSecret: 'app-backend-secret' };
    expect(await app.restartWith(connector, pair)).toBe(true);
    expect(h.spawned[1]?.env['AW_APP_CLIENT_SECRET']).toBe('app-backend-secret');
    expect(await app.restartWith(connector, pair)).toBe(false);
    expect(await app.restartWith(connector)).toBe(false);
    expect(h.spawned).toHaveLength(2);
    await app.stop();
  });

  it('stops the app when aw dev ends', async () => {
    const h = harness();
    const ended = new AbortController();
    await startApp(startOptions(await projectWith(), { signal: ended.signal }), h.deps);
    ended.abort();
    await Promise.resolve();
    expect(h.children[0]?.killed).toStrictEqual(['SIGTERM']);
  });
});

describe('startDevApp', () => {
  const session = {
    baseUrl: 'http://127.0.0.1:3000',
    apiKey: 'ak_live_local',
    workspaceId: WORKSPACE_ID,
  };
  const printedNotices: string[] = [];

  afterEach(() => {
    printedNotices.length = 0;
  });

  it.each([
    ['stored by aw dev', false],
    ['left to an Owner', true],
  ])('never writes the identity key to stdout or stderr (%s)', async (_case, admin) => {
    const cwd = await projectWith(MANIFEST);
    const plane = controlPlane([], admin ? { admin: true } : {});
    const h = harness();
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const consoleCalls = [
      vi.spyOn(console, 'log').mockImplementation(() => undefined),
      vi.spyOn(console, 'error').mockImplementation(() => undefined),
      vi.spyOn(console, 'warn').mockImplementation(() => undefined),
    ];
    const { read, app } = await startDevApp(
      {
        client: plane.client,
        cwd,
        appName: 'desk',
        read: READ,
        session,
        webPort: 3000,
        databaseUrl: DATABASE_URL,
        env: { PATH: '/usr/bin' },
        stderr: (text) => void printedNotices.push(text),
        signal: AbortSignal.timeout(5000),
      },
      h.deps,
    );
    await app.stop();
    const key = (
      JSON.parse(await readFile(path.join(cwd, APP_IDENTITY_FILE), 'utf8')) as { secret: string }
    ).secret;
    const printed = [
      ...stdout.mock.calls,
      ...stderr.mock.calls,
      ...consoleCalls.flatMap((spy) => spy.mock.calls),
      printedNotices,
    ]
      .flat()
      .map(String)
      .join('\n');
    expect(printed).not.toContain(key);
    // It travels only in the secret's create body (when the key may write one) and in the app's
    // environment; an Owner is told where it is instead.
    expect(plane.bodies.filter((body) => body.includes(key))).toHaveLength(admin ? 0 : 1);
    expect(printedNotices).toStrictEqual(admin ? [ownerOnlyIdentityNotice('desk')] : []);
    expect(h.spawned[0]?.env['AW_APP_IDENTITY_SECRET']).toBe(key);
    expect(h.spawned[0]?.args.join(' ')).not.toContain(key);
    expect(JSON.stringify(read)).not.toContain(key);
  });

  it('refuses a foreign connector named like the app before anything is started or stored', async () => {
    const plane = controlPlane([appConnectorResource({ authType: 'bearer', hasCredential: true })]);
    const h = harness();
    await expect(
      startDevApp(
        {
          client: plane.client,
          cwd: await projectWith(MANIFEST),
          appName: 'desk',
          read: READ,
          session,
          webPort: 3000,
          databaseUrl: DATABASE_URL,
          env: {},
          stderr: (text) => void printedNotices.push(text),
          signal: AbortSignal.timeout(5000),
        },
        h.deps,
      ),
    ).rejects.toThrow(/^app_connector_conflict/u);
    expect(h.events).toStrictEqual([]);
    expect(plane.secrets).toStrictEqual([]);
  });

  it('refuses when no database is known for the app', async () => {
    const plane = controlPlane();
    await expect(
      startDevApp(
        {
          client: plane.client,
          cwd: await projectWith(MANIFEST),
          appName: 'desk',
          read: READ,
          session,
          webPort: 3000,
          databaseUrl: undefined,
          env: {},
          stderr: (text) => void printedNotices.push(text),
          signal: AbortSignal.timeout(5000),
        },
        harness().deps,
      ),
    ).rejects.toThrow(/^app_database_unavailable/u);
  });

  it('restarts the app once the plan created its connector', async () => {
    const plane = controlPlane();
    const h = harness();
    const { app } = await startDevApp(
      {
        client: plane.client,
        cwd: await projectWith(MANIFEST),
        appName: 'desk',
        read: READ,
        session,
        webPort: 3000,
        databaseUrl: DATABASE_URL,
        env: {},
        stderr: (text) => void printedNotices.push(text),
        signal: AbortSignal.timeout(5000),
      },
      h.deps,
    );
    plane.connectors.push(appConnectorResource());
    expect(await settleAppConnector(plane.client, app, 'desk', AbortSignal.timeout(5000))).toBe(
      true,
    );
    expect(await settleAppConnector(plane.client, app, 'desk', AbortSignal.timeout(5000))).toBe(
      false,
    );
    expect(h.spawned).toHaveLength(2);
    await app.stop();
  });
});
