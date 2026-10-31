import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { appendFile, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { stripVTControlCharacters } from 'node:util';

import { CONTRACTS_VERSION } from '@indx-workspace/contracts';
import { CreateAgentFromVersionRequestSchema } from '@indx-workspace/contracts/agent-versions';
import { LocalRuntimeStartMessageSchema } from '@indx-workspace/contracts/local-runtime';
import { withRecommendedAnswers } from '@indx-workspace/contracts/setup';
import { ENGINE_PACKAGES, renderProjectFiles } from '@indx-workspace/sdk/project';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { InterruptedError } from '../io.js';
import { keyShell, missingKeyLines } from '../local-runtime/environment.js';
import { localCredentialsFilePath } from '../local-runtime/local-credentials.js';
import { EXIT_CODE } from '../output.js';
import {
  FIXTURES,
  json,
  runCli,
  tempDirectory,
  tempFile,
  type CliRun,
  type Route,
} from '../testing.js';
import { AW_VERSION } from '../version.js';

// These tests run the real project loader, a forked Node process that evaluates the definition
// files: a second or more each on a shared CI runner, past vitest's 5 s default when several run.
vi.setConfig({ testTimeout: 30_000 });

/**
 * Issue #451 (S1-13): `aw dev` against a fake local runtime over a real `fork`. Each case writes a
 * project into a temp directory — `package.json`, `agent-workspace.yaml` and
 * `node_modules/@indx-workspace/embedded` whose `./launch` export is a fake `bin.mjs` — and the
 * fake's behaviour after it receives `start` is the case's own script.
 */

/** The local workspace's API key the runtime issues (ADR-0109, S1-21): `API_KEY_PATTERN`. */
const TOKEN = `ak_live_${'A'.repeat(22)}_${'S'.repeat(43)}`;
/** A user token: what the runtime issued before S1-21, which the contract now refuses. */
const USER_TOKEN = `awu_live_${'A'.repeat(22)}_${'S'.repeat(43)}`;
const WORKSPACE_ID = '44444444-4444-4444-8444-444444444444';
const ANTHROPIC_KEY = 'sk-ant-api03-never-in-a-file-0123456789';
const PROJECT_URL = 'http://127.0.0.1:3000';
const INSTALL_LINE = `npm install -D @indx-workspace/embedded@${AW_VERSION}`;
/** How long a case whose last step prints nothing waits before interrupting. */
const SETTLE_MS = 300;
/** What the sync says in a project that has no agents yet. */
const NO_AGENTS = 'sync: no agents/*.ts in this directory\n';
const DEFINE = `import { defineAgent, defineSurface } from '@indx-workspace/sdk/define';\n`;

const READY = { type: 'ready', url: PROJECT_URL, contractsVersion: CONTRACTS_VERSION };
const CREDENTIAL = {
  type: 'credential',
  token: TOKEN,
  expiresAt: '2999-01-01T00:00:00.000Z',
  workspaceId: WORKSPACE_ID,
  workspaceSlug: 'local',
};

/** Send each message in order, then stay up until interrupted (the IPC channel keeps it alive). */
function sends(...messages: readonly unknown[]): string {
  return messages.map((message) => `await send(${JSON.stringify(message)});`).join('\n');
}

/**
 * The fake runtime: records `start`, marks a stop request — SIGINT or the IPC channel closing,
 * both of which the real launcher honours — in `stopped`, then runs `body`. Its `message`
 * listener stays registered, which keeps the IPC channel (and so the fake) alive until it is
 * interrupted or `aw` goes away, as a real runtime stays up.
 */
function fakeRuntime(body: string): string {
  return `import { writeFileSync } from 'node:fs';
const send = (message) => new Promise((resolve) => process.send(message, () => resolve()));
const stop = () => {
  writeFileSync('stopped', '');
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('disconnect', stop);
let started = false;
process.on('message', async (start) => {
  if (started) return;
  started = true;
  writeFileSync('start.json', JSON.stringify(start));
  writeFileSync('env.json', JSON.stringify(Object.keys(process.env)));
  ${body}
});
`;
}

/** Only what a child process needs to start; never the developer's own ANTHROPIC_* variables. */
function baseEnv(
  extra: Readonly<Record<string, string | undefined>> = {},
): Record<string, string | undefined> {
  return {
    PATH: process.env['PATH'],
    SystemRoot: process.env['SystemRoot'],
    // A set service port turns the free-port fallback off, so these cases run on 3000 whatever else
    // is listening on the machine; the fallback has its own case.
    AW_DATABASE_PORT: '25432',
    ...extra,
  };
}

const temporary: string[] = [];

afterEach(async () => {
  for (const directory of temporary.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

async function freshDirectory(): Promise<string> {
  const directory = await tempDirectory();
  temporary.push(directory);
  return directory;
}

interface ProjectOptions {
  readonly script?: string;
  /** `null`: no runtime installed. */
  readonly embeddedVersion?: string | null;
  /** Install every engine's packages (an empty `package.json` each); default true. */
  readonly engines?: boolean;
  readonly yaml?: string;
}

function renderedYaml(): string {
  const [projectFile] = renderProjectFiles(withRecommendedAnswers({}), { name: 'demo' });
  if (projectFile === undefined) throw new Error('renderProjectFiles rendered nothing');
  return projectFile.contents;
}

async function project(options: ProjectOptions = {}): Promise<string> {
  const directory = await freshDirectory();
  await writeFile(path.join(directory, 'package.json'), '{ "name": "demo", "private": true }\n');
  await writeFile(path.join(directory, 'agent-workspace.yaml'), options.yaml ?? renderedYaml());
  const version = options.embeddedVersion === undefined ? AW_VERSION : options.embeddedVersion;
  if (version !== null) {
    const embedded = path.join(directory, 'node_modules', '@indx-workspace', 'embedded');
    await mkdir(embedded, { recursive: true });
    await writeFile(
      path.join(embedded, 'package.json'),
      JSON.stringify({
        name: '@indx-workspace/embedded',
        version,
        type: 'module',
        exports: { './launch': './bin.mjs', './package.json': './package.json' },
      }),
    );
    await writeFile(path.join(embedded, 'bin.mjs'), options.script ?? fakeRuntime(''));
  }
  if (options.engines !== false) {
    const names = Object.values(ENGINE_PACKAGES).flatMap((packages) => Object.keys(packages));
    for (const name of new Set(names)) {
      const installed = path.join(directory, 'node_modules', ...name.split('/'));
      await mkdir(installed, { recursive: true });
      await writeFile(path.join(installed, 'package.json'), '{}');
    }
  }
  return directory;
}

/** Every file under `directory`, recursively. */
async function filesUnder(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true, recursive: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath, entry.name));
}

interface DevRun {
  readonly run: CliRun;
  readonly cwd: string;
  readonly home: string;
}

/**
 * Run `aw dev` in `cwd`, interrupting it once `until` holds for the output so far (a runtime that
 * is up never exits by itself).
 */
async function dev(
  cwd: string,
  options: {
    readonly env?: Readonly<Record<string, string | undefined>>;
    readonly route?: Route;
    readonly until?: (output: { readonly stdout: string; readonly stderr: string }) => boolean;
    readonly argv?: readonly string[];
    /** For a case whose last step prints nothing: its route aborts this one itself. */
    readonly controller?: AbortController;
    /** A terminal, and what a person types at the masked key prompt (issue #690). */
    readonly tty?: {
      readonly pasted: string;
      /** What is typed at the numbered menu; Enter by default. */
      readonly choice?: string;
      /** What is typed at `Open the chat in your browser? (Y/n)`; Enter by default. */
      readonly open?: string;
      /** The open question is never answered; it ends only when `aw dev` aborts it. */
      readonly pending?: boolean;
      /** Every question put to the person, in order. */
      readonly asked?: string[];
      /** Called when the open question is put, to see what was on screen by then. */
      readonly onAsk?: () => void;
      readonly opened?: string[];
      /** What `io.openUrl` answers; true by default. */
      readonly browser?: boolean;
      /** Rejects the menu prompt, as Ctrl-C does. */
      readonly interrupt?: boolean;
      /** No `io.prompt`, as where only the hidden prompt exists. */
      readonly noPrompt?: boolean;
    };
  } = {},
): Promise<DevRun> {
  const home = await freshDirectory();
  const controller = options.controller ?? new AbortController();
  const until = options.until;
  const run = await runCli(['dev', ...(options.argv ?? [])], {
    cwd,
    homeDir: home,
    env: baseEnv(options.env),
    signal: controller.signal,
    ...(options.tty === undefined
      ? {}
      : {
          isTty: true,
          ...(options.tty.noPrompt === true
            ? {}
            : {
                prompt: (question: string, own?: AbortSignal) => {
                  if (question.includes('Open the chat')) options.tty?.onAsk?.();
                  return question.includes('Open the chat') && options.tty?.pending === true
                    ? new Promise<string>((_resolve, reject) => {
                        options.tty?.asked?.push(question);
                        own?.addEventListener('abort', () => {
                          reject(new InterruptedError());
                        });
                      })
                    : options.tty?.interrupt === true
                      ? Promise.reject(new InterruptedError())
                      : Promise.resolve(
                          (question.includes('Open the chat')
                            ? options.tty?.open
                            : options.tty?.choice) ?? '',
                        );
                },
              }),
          promptSecret: () => Promise.resolve(options.tty?.pasted ?? ''),
          openUrl: (url: string) => {
            options.tty?.opened?.push(url);
            return Promise.resolve(options.tty?.browser ?? true);
          },
        }),
    ...(options.route === undefined ? {} : { route: options.route }),
    onOutput: (output) => {
      if (until?.(output) !== true || controller.signal.aborted) return;
      // On a terminal the chat question follows the first sync; let it settle before stopping.
      if (options.tty === undefined) controller.abort();
      else setTimeout(() => controller.abort(), 300);
    },
  });
  return { run, cwd, home };
}

/** A control plane with the given model connections that accepts a create. */
function modelConnections(existing: readonly string[]): Route {
  return (request) => {
    // Issue #661: every connection's key checks out.
    if (request.url.pathname === '/api/models') return json(200, { models: [] });
    if (request.url.pathname !== '/api/model-connections') {
      return json(404, { error: { code: 'not_found', message: 'no route' } });
    }
    if (request.method === 'POST') {
      return json(201, { ...FIXTURES.modelConnection, name: 'default' });
    }
    return json(200, {
      models: existing.map((name) => ({ ...FIXTURES.modelConnection, name })),
    });
  };
}

/** A project the fake runtime runs, holding `agents/assistant.ts`. */
async function projectWithAgent(ready: unknown = READY): Promise<string> {
  const cwd = await project({ script: fakeRuntime(sends(ready, CREDENTIAL)) });
  await tempFile(
    cwd,
    'agents/assistant.ts',
    `${DEFINE}export default defineAgent({ name: 'assistant', instructions: 'Help people.' });\n`,
  );
  return cwd;
}

/** {@link projectWithAgent} with its own project file. */
async function projectWithAgentAnd(yaml: string): Promise<string> {
  const cwd = await project({ yaml, script: fakeRuntime(sends(READY, CREDENTIAL)) });
  await tempFile(
    cwd,
    'agents/assistant.ts',
    `${DEFINE}export default defineAgent({ name: 'assistant', instructions: 'Help people.' });\n`,
  );
  return cwd;
}

/** A workspace with no agents and a `default` model connection, that accepts a new agent. */
const agentsRoute: Route = (request) => {
  if (request.url.pathname === '/api/model-connections') {
    return json(200, { models: [{ ...FIXTURES.modelConnection, name: 'default' }] });
  }
  if (request.url.pathname !== '/api/agents') {
    return json(404, { error: { code: 'not_found', message: 'no route' } });
  }
  if (request.method === 'GET') return json(200, { agents: [] });
  const body = CreateAgentFromVersionRequestSchema.parse(request.json);
  if (body.dryRun === true) return json(200, { ok: true, number: 1 });
  return json(201, {
    agent: { ...FIXTURES.agent, modelConnectionId: null, name: 'assistant' },
    version: {
      id: 'v-1',
      agentId: FIXTURES.agent.id,
      workspaceId: WORKSPACE_ID,
      number: 1,
      summary: body.version.summary,
      via: body.version.via,
      body: body.version.body,
      createdByPrincipalId: FIXTURES.agent.id,
      createdAt: '2026-10-02T10:00:00.000Z',
    },
  });
};

/**
 * A local workspace holding `models` and `connectors`, that accepts every create and rotation the
 * project's resources need and answers `/api/agents` as {@link agentsRoute} does.
 */
function workspaceRoute(
  existing: { readonly models?: readonly unknown[]; readonly connectors?: readonly unknown[] } = {},
): Route {
  return (request) => {
    const { pathname } = request.url;
    const route = `${request.method} ${pathname}`;
    if (route === 'GET /api/model-connections') return json(200, { models: existing.models ?? [] });
    if (route === 'POST /api/model-connections') {
      return json(201, { ...FIXTURES.modelConnection, name: 'default' });
    }
    if (request.method === 'POST' && pathname.endsWith('/credential')) {
      return new Response(null, { status: 204 });
    }
    if (route === 'GET /api/connectors') {
      return json(200, { connectors: existing.connectors ?? [] });
    }
    if (route === 'POST /api/connectors') return json(201, FIXTURES.connector);
    return agentsRoute(request);
  };
}

/** `renderedYaml()` with `extra` added at the root. */
function yamlWith(extra: string): string {
  return `${renderedYaml()}${extra}`;
}

const DEFAULT_MODEL_YAML = [
  'models:',
  '  default:',
  '    provider: anthropic',
  '    credential:',
  '      secret: ANTHROPIC_API_KEY',
  '',
].join('\n');

const GITHUB_YAML = [
  'connectors:',
  '  github:',
  '    url: https://mcp.example.com',
  '    auth:',
  '      scheme: bearer',
  '      credential:',
  '        secret: ORDERS_TOKEN',
  '',
].join('\n');

/** An agent file that prints the names of its environment's variables on one `ENV` line. */
const ENV_AGENT = `${DEFINE}console.log('ENV ' + Object.keys(process.env).join(','));
export default defineAgent({ name: 'assistant', instructions: 'Help people.' });
`;

/** The variable names the fake runtime was forked with. */
async function forkedEnv(cwd: string): Promise<string[]> {
  return z.array(z.string()).parse(JSON.parse(await readFile(path.join(cwd, 'env.json'), 'utf8')));
}

const synced = ({ stdout }: { readonly stdout: string }): boolean => stdout.includes('synced: ');
const syncSaid = ({ stderr }: { readonly stderr: string }): boolean => stderr.includes('sync: ');

const signedIn = ({
  stdout,
  stderr,
}: {
  readonly stdout: string;
  readonly stderr: string;
}): boolean =>
  stdout.includes('watching ') || stderr.includes('notice:') || stderr.includes('warning:');

describe('aw dev (issue #451)', () => {
  it('prints ready, then signed in, stores the credential for the project URL and never prints the token', async () => {
    const cwd = await project({ script: fakeRuntime(sends(READY, CREDENTIAL)) });
    const { run, home } = await dev(cwd, { route: modelConnections([]), until: signedIn });

    expect(run.code, run.stderr).toBe(EXIT_CODE.interrupted);
    expect(run.stdout).toMatch(
      /^\n {2}Agent Workspace · demo · local\n\n {2}console {3}http:\/\/127\.0\.0\.1:3000\n {12}sign in as admin@localhost\.test\n {12}password in \.agent-workspace\/secrets\/local-secrets\.json\n {2}chat {6}npx aw chat\n\n {4}runtime {3}ready in [0-9.]+ s {3}logs: \.aw\/logs\/runtime\.log\n/u,
    );
    expect(run.stdout).toContain('    signed in as admin@localhost.test (workspace local)\n');
    expect(run.stdout).toContain('  x model     no ANTHROPIC_API_KEY in this shell\n');
    expect(run.stdout).toContain(missingKeyLines('ANTHROPIC_API_KEY', keyShell())[1]);
    expect(run.stdout + run.stderr).not.toContain('ak_live_');
    const stored: unknown = JSON.parse(await readFile(localCredentialsFilePath(home), 'utf8'));
    expect(stored).toEqual({
      [PROJECT_URL]: {
        apiKey: TOKEN,
        expiresAt: CREDENTIAL.expiresAt,
        workspaceId: WORKSPACE_ID,
        workspaceSlug: 'local',
      },
    });
    // The start message is the contract's, built from the project file.
    const start = LocalRuntimeStartMessageSchema.parse(
      JSON.parse(await readFile(path.join(cwd, 'start.json'), 'utf8')),
    );
    expect(start).toEqual({
      type: 'start',
      projectDir: cwd,
      environment: {
        port: 3000,
        bootstrapAdmin: 'admin@localhost.test',
        // Issue #661: names only — the try page says which variable to set.
        modelSecrets: ['ANTHROPIC_API_KEY'],
      },
    });
    // Without ANTHROPIC_API_KEY: the screen's cross row says it once (no planner notice), and no create.
    expect(run.stdout).toContain('no ANTHROPIC_API_KEY in this shell');
    expect(run.stderr).not.toContain('ANTHROPIC_API_KEY');
    expect(run.calls.filter((call) => call.method === 'POST')).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')('stores the credential owner-only (0600)', async () => {
    const cwd = await project({ script: fakeRuntime(sends(READY, CREDENTIAL)) });
    const { run, home } = await dev(cwd, { route: modelConnections([]), until: signedIn });
    expect(run.code, run.stderr).toBe(EXIT_CODE.interrupted);
    expect((await stat(localCredentialsFilePath(home))).mode & 0o777).toBe(0o600);
  });

  it('creates the default model connection once from ANTHROPIC_API_KEY, and writes the key nowhere', async () => {
    const cwd = await project({ script: fakeRuntime(sends(READY, CREDENTIAL)) });
    const { run, home } = await dev(cwd, {
      env: { ANTHROPIC_API_KEY: ANTHROPIC_KEY, ANTHROPIC_BASE_URL: 'https://llm.example.com' },
      route: modelConnections(['other']),
      until: ({ stdout }) => stdout.includes('model connection:'),
    });

    expect(run.code, run.stderr).toBe(EXIT_CODE.interrupted);
    expect(run.stdout).toContain('model connection: default (anthropic)\n');
    const creates = run.calls.filter((call) => call.method === 'POST');
    expect(creates).toHaveLength(1);
    expect(creates[0]?.url.href).toBe(`${PROJECT_URL}/api/model-connections`);
    // The listing, the create and the key check (#661) all carry the runtime's API key (ADR-0109,
    // S1-21).
    expect(run.calls.map((call) => call.headers.get('authorization'))).toEqual([
      `Bearer ${TOKEN}`,
      `Bearer ${TOKEN}`,
      `Bearer ${TOKEN}`,
    ]);
    expect(run.calls[2]?.url.pathname).toBe('/api/models');
    expect(creates[0]?.headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
    expect(run.stdout + run.stderr).not.toContain('ak_live_');
    expect(creates[0]?.json).toEqual({
      name: 'default',
      provider: 'anthropic',
      apiKey: ANTHROPIC_KEY,
      config: { baseUrl: 'https://llm.example.com' },
    });
    expect(run.stdout + run.stderr).not.toContain(ANTHROPIC_KEY);
    for (const file of [...(await filesUnder(home)), ...(await filesUnder(cwd))]) {
      expect(await readFile(file, 'utf8'), file).not.toContain(ANTHROPIC_KEY);
    }
  });

  it('says at start, naming ANTHROPIC_API_KEY, that the provider rejected the key (#661)', async () => {
    const cwd = await project({ script: fakeRuntime(sends(READY, CREDENTIAL)) });
    const reason =
      'The provider rejected the API key (HTTP 401). Replace the key on this connection.';
    const route: Route = (request) =>
      request.url.pathname === '/api/models'
        ? json(200, {
            models: [],
            unavailable: [
              {
                connectionId: FIXTURES.modelConnection.id,
                connectionName: 'default',
                reason,
                kind: 'credential-rejected',
                status: 401,
              },
            ],
          })
        : modelConnections([])(request);
    const { run } = await dev(cwd, {
      env: { ANTHROPIC_API_KEY: ANTHROPIC_KEY },
      route,
      until: ({ stdout }) => stdout.includes('watching '),
    });
    expect(run.code, run.stderr).toBe(EXIT_CODE.interrupted);
    expect(run.stdout).toContain('model connection: default (anthropic)\n');
    // The ready screen says it, before any message: one cross row and the exact fix.
    expect(run.stdout).toContain('  x model     the key was rejected (401)\n');
    expect(run.stdout).toContain('Set ANTHROPIC_API_KEY to a valid key and restart aw dev.');
    expect(run.stderr).not.toContain('warning: model connection');
    expect(run.stdout + run.stderr).not.toContain(ANTHROPIC_KEY);
  });

  it('on a terminal with no key, asks once, keeps the pasted key out of every file and the output (#690)', async () => {
    const cwd = await project({ script: fakeRuntime(sends(READY, CREDENTIAL)) });
    const { run, home } = await dev(cwd, {
      tty: { pasted: ANTHROPIC_KEY },
      route: modelConnections([]),
      until: ({ stdout }) => stdout.includes('watching '),
    });
    expect(run.code, run.stderr).toBe(EXIT_CODE.interrupted);
    expect(run.stdout).toContain('the local runtime keeps a pasted key for later starts:');
    expect(run.stdout).toContain(missingKeyLines('ANTHROPIC_API_KEY', keyShell())[1]);
    const create = run.calls.find((call) => call.method === 'POST');
    expect(create?.json).toMatchObject({ name: 'default', apiKey: ANTHROPIC_KEY });
    expect(run.stdout).toContain('model     anthropic · workspace default model · key checked');
    expect(run.stdout).not.toContain('x model');
    expect(run.stdout + run.stderr).not.toContain(ANTHROPIC_KEY);
    for (const file of [...(await filesUnder(home)), ...(await filesUnder(cwd))]) {
      expect(await readFile(file, 'utf8'), file).not.toContain(ANTHROPIC_KEY);
    }
  });

  const scriptedProject = async (): Promise<string> => {
    const cwd = await project({ script: fakeRuntime(sends(READY, CREDENTIAL)) });
    await tempFile(
      cwd,
      'agents/assistant.ts',
      `${DEFINE}export default defineAgent({ name: 'assistant', instructions: 'Help people.', model: { connection: 'default', id: 'scripted:order-status' } });\n`,
    );
    return cwd;
  };

  it('with AW_SCRIPTED_MODELS_DIR and only scripted: agents, starts with no key and asks for none (#798)', async () => {
    const { run } = await dev(await scriptedProject(), {
      env: { AW_SCRIPTED_MODELS_DIR: path.join(path.sep, 'scripts') },
      tty: { pasted: ANTHROPIC_KEY },
      route: modelConnections([]),
      until: ({ stdout }) => stdout.includes('watching '),
    });
    expect(run.code, run.stderr).toBe(EXIT_CODE.interrupted);
    expect(run.stdout).not.toContain('the local runtime keeps a pasted key');
    // The connection holds a placeholder the gateway never sends for a scripted: id.
    expect(run.calls.find((call) => call.method === 'POST')?.json).toMatchObject({
      name: 'default',
      apiKey: 'scripted',
    });
    expect(run.stdout).toContain(
      'model     default · scripted:order-status · scripted, no key needed',
    );
    expect(run.stdout).not.toContain('key checked');
    expect(run.stdout).not.toContain('x model');
  });

  it('without AW_SCRIPTED_MODELS_DIR, asks for the key a scripted: agent cannot be served without (#798)', async () => {
    // Without the directory the scripted id is not served, so the key is asked for as before.
    const unscripted = await dev(await scriptedProject(), {
      tty: { pasted: ANTHROPIC_KEY },
      route: modelConnections([]),
      until: ({ stdout }) => stdout.includes('watching '),
    });
    expect(unscripted.run.stdout).toContain('the local runtime keeps a pasted key');
  });

  it('on a terminal, Enter opens the provider console, then takes the pasted key (UX-B)', async () => {
    const cwd = await project({ script: fakeRuntime(sends(READY, CREDENTIAL)) });
    const opened: string[] = [];
    const { run } = await dev(cwd, {
      tty: { pasted: ANTHROPIC_KEY, opened },
      route: modelConnections([]),
      until: ({ stdout }) => stdout.includes('watching '),
    });
    expect(opened).toEqual(['https://console.anthropic.com/settings/keys']);
    const menu = stripVTControlCharacters(run.stdout);
    expect(menu).toContain('[1] Open the Anthropic console, create a key, then paste it');
    // Every line of the menu fits an 80-column terminal (BH061-070).
    for (const line of menu.split('\n')) expect(line.length, line).toBeLessThan(80);
    expect(menu).toContain('[2] Paste a key now (hidden)');
    expect(menu).toContain('[3] Skip for now');
    expect(run.calls.find((call) => call.method === 'POST')?.json).toMatchObject({
      apiKey: ANTHROPIC_KEY,
    });
  });

  it('says the link when no browser opens, and still takes the pasted key (UX-B)', async () => {
    const cwd = await project({ script: fakeRuntime(sends(READY, CREDENTIAL)) });
    const { run } = await dev(cwd, {
      tty: { pasted: ANTHROPIC_KEY, browser: false },
      route: modelConnections([]),
      until: ({ stdout }) => stdout.includes('watching '),
    });
    expect(run.stdout).toContain(
      'no browser could be opened here: open that link yourself, then paste the key',
    );
    expect(run.calls.find((call) => call.method === 'POST')?.json).toMatchObject({
      apiKey: ANTHROPIC_KEY,
    });
  });

  it('with no io.prompt nothing is offered, opened or sent (UX-B)', async () => {
    const cwd = await project({ script: fakeRuntime(sends(READY, CREDENTIAL)) });
    const opened: string[] = [];
    const { run } = await dev(cwd, {
      tty: { pasted: ANTHROPIC_KEY, noPrompt: true, opened },
      route: modelConnections([]),
      until: ({ stdout }) => stdout.includes('watching '),
    });
    expect(opened).toEqual([]);
    expect(run.stdout).not.toContain('Skip for now');
    expect(run.calls.some((call) => call.method === 'POST')).toBe(false);
  });

  it('Ctrl-C at the menu is an interrupt and sends nothing (UX-B)', async () => {
    const cwd = await project({ script: fakeRuntime(sends(READY, CREDENTIAL)) });
    const { run } = await dev(cwd, {
      tty: { pasted: ANTHROPIC_KEY, interrupt: true },
      route: modelConnections([]),
    });
    expect(run.code).toBe(EXIT_CODE.interrupted);
    expect(run.calls.some((call) => call.method === 'POST')).toBe(false);
  });

  it('on a terminal, 2 pastes without opening a browser and 3 skips (UX-B)', async () => {
    const paste = await dev(await project({ script: fakeRuntime(sends(READY, CREDENTIAL)) }), {
      tty: { pasted: ANTHROPIC_KEY, choice: '2', opened: [] },
      route: modelConnections([]),
      until: ({ stdout }) => stdout.includes('watching '),
    });
    expect(paste.run.calls.some((call) => call.method === 'POST')).toBe(true);
    const opened: string[] = [];
    const skip = await dev(await project({ script: fakeRuntime(sends(READY, CREDENTIAL)) }), {
      tty: { pasted: ANTHROPIC_KEY, choice: '3', opened },
      route: modelConnections([]),
      until: ({ stdout }) => stdout.includes('watching '),
    });
    expect(opened).toEqual([]);
    expect(skip.run.calls.some((call) => call.method === 'POST')).toBe(false);
    expect(stripVTControlCharacters(skip.run.stdout)).toContain(
      'model     no ANTHROPIC_API_KEY in this shell',
    );
  });

  it('on a terminal, --quiet never asks for a key and sends none (#690)', async () => {
    const cwd = await project({ script: fakeRuntime(sends(READY, CREDENTIAL)) });
    const { run } = await dev(cwd, {
      argv: ['--quiet'],
      tty: { pasted: ANTHROPIC_KEY },
      route: modelConnections([]),
      until: signedIn,
    });
    expect(run.stdout).toBe('');
    expect(run.calls.some((call) => call.method === 'POST')).toBe(false);
    expect(run.stdout + run.stderr).not.toContain(ANTHROPIC_KEY);
  });

  it('a second start with no key in the shell, on a connection the runtime already holds, is not a cross (#690)', async () => {
    const cwd = await project({ script: fakeRuntime(sends(READY, CREDENTIAL)) });
    const { run } = await dev(cwd, {
      route: modelConnections(['default']),
      until: ({ stdout }) => stdout.includes('watching '),
    });
    // Issue #732: the screen says the runs use the key stored by an earlier start.
    expect(run.stdout).toContain(
      'model     anthropic · workspace default model · stored key checked\n' +
        '              (ANTHROPIC_API_KEY not set: using the key of an earlier start)\n',
    );
    expect(run.stdout).not.toContain('no ANTHROPIC_API_KEY in this shell');
    expect(run.calls.filter((call) => call.method !== 'GET')).toEqual([]);
  });

  it('a restart with a new key or base URL updates the existing default connection (#732)', async () => {
    const cwd = await project({ script: fakeRuntime(sends(READY, CREDENTIAL)) });
    const id = FIXTURES.modelConnection.id;
    /** The base URL the connection holds on the server; the Owner may change it in the UI. */
    let stored = 'https://old.example.com';
    const route: Route = (request) => {
      const { pathname } = request.url;
      if (pathname === `/api/model-connections/${id}/credential`) {
        return new Response(null, { status: 204 });
      }
      if (pathname === `/api/model-connections/${id}`) return json(200, FIXTURES.modelConnection);
      if (pathname === '/api/model-connections') {
        const config = { baseUrl: stored };
        return json(200, { models: [{ ...FIXTURES.modelConnection, name: 'default', config }] });
      }
      return modelConnections([])(request);
    };
    const start = async (
      env: Record<string, string>,
    ): Promise<{ readonly writes: unknown[]; readonly stderr: string }> => {
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
    };

    const first = await start({
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
    // The base URL is recorded beside the fingerprints, never the key.
    const recorded = await readFile(
      path.join(cwd, '.agent-workspace', 'secret-fingerprints.json'),
      'utf8',
    );
    expect(JSON.parse(recorded)).toMatchObject({ anthropicBaseUrl: 'https://new.example.com/v1' });
    expect(recorded).not.toContain('sk-ant-fake-');

    // Changed key, removed base URL: both reach the connection.
    const second = await start({ ANTHROPIC_API_KEY: 'sk-ant-fake-valid' });
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
    const third = await start({ ANTHROPIC_API_KEY: 'sk-ant-fake-valid' });
    expect(third.writes).toEqual([]);
    expect(third.stderr).not.toContain('ANTHROPIC_BASE_URL changed');
  }, 30_000);

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

  it('syncs agents/ and surfaces/ after sign-in and prints the widget line last (issue #453)', async () => {
    const cwd = await projectWithAgent();
    await tempFile(
      cwd,
      'surfaces/main.ts',
      `${DEFINE}export default defineSurface({ name: 'main', agent: 'assistant' });\n`,
    );
    const { run } = await dev(cwd, {
      route: agentsRoute,
      until: synced,
    });

    expect(run.code, run.stderr).toBe(EXIT_CODE.interrupted);
    // The ready screen carries the try page and the widget, so the first sync does not repeat them.
    expect(run.stdout).toContain('    agent     assistant  (agents/assistant.ts)\n');
    expect(run.stdout).toContain('    surface   main\n');
    expect(run.stdout).toContain(`  try       ${PROJECT_URL}/p/s/main/try\n`);
    expect(run.stdout).toContain(
      `  embed     <script src="${PROJECT_URL}/p/s/main/widget.js" async></script>\n`,
    );
    expect(run.stdout).not.toContain('page: ');
    expect(run.stdout).not.toContain('widget: ');
    expect(run.stdout.endsWith('synced: "assistant" created at version 1\n')).toBe(true);
    // A dry run and the create, both to the runtime aw dev started, with its own credential.
    const posts = run.calls.filter(
      (call) => call.url.pathname === '/api/agents' && call.method === 'POST',
    );
    expect(
      posts.map((call) => `${call.url.origin} ${call.headers.get('authorization') ?? ''}`),
    ).toEqual([`${PROJECT_URL} Bearer ${TOKEN}`, `${PROJECT_URL} Bearer ${TOKEN}`]);
    expect(run.stdout + run.stderr).not.toContain('ak_live_');
  });

  it('prints the try URL and embed tag of every surface, the first on the ready screen', async () => {
    const cwd = await projectWithAgent();
    for (const name of ['main', 'second']) {
      await tempFile(
        cwd,
        `surfaces/${name}.ts`,
        `${DEFINE}export default defineSurface({ name: '${name}', agent: 'assistant' });
`,
      );
    }
    const { run } = await dev(cwd, { route: agentsRoute, until: synced });

    expect(run.code, run.stderr).toBe(EXIT_CODE.interrupted);
    expect(run.stdout).toContain(`  try       ${PROJECT_URL}/p/s/main/try
`);
    expect(run.stdout).not.toContain(`try: ${PROJECT_URL}/p/s/main/try
`);
    expect(run.stdout).toContain(`try: ${PROJECT_URL}/p/s/second/try
`);
    expect(run.stdout).toContain(`widget: <script src="${PROJECT_URL}/p/s/second/widget.js"`);
  });

  describe('opening the chat (UX-C)', () => {
    const tryUrl = `${PROJECT_URL}/p/s/main/try`;
    async function withSurface(
      argv: readonly string[],
      tty?: NonNullable<Parameters<typeof dev>[1]>['tty'],
    ) {
      const cwd = await projectWithAgent();
      await tempFile(
        cwd,
        'surfaces/main.ts',
        `${DEFINE}export default defineSurface({ name: 'main', agent: 'assistant' });
`,
      );
      return dev(cwd, {
        argv,
        env: { ANTHROPIC_API_KEY: ANTHROPIC_KEY },
        route: agentsRoute,
        until: synced,
        ...(tty === undefined ? {} : { tty }),
      });
    }

    it('on a terminal asks once and Enter opens the try page; the screen names the console first', async () => {
      const opened: string[] = [];
      const { run } = await withSurface([], { pasted: '', opened });
      expect(opened).toEqual([tryUrl]);
      expect(run.stdout).toContain('Agent Workspace');
      const screen = stripVTControlCharacters(run.stdout);
      expect(screen.indexOf(`try       ${tryUrl}`)).toBeLessThan(screen.indexOf('runtime   ready'));
      expect(screen).toContain(
        `console   ${PROJECT_URL}\n            sign in as admin@localhost.test\n            password in .agent-workspace/secrets/local-secrets.json\n`,
      );
      expect(screen).not.toContain('aw login');
    });

    it('n declines and opens nothing', async () => {
      const opened: string[] = [];
      await withSurface([], { pasted: '', open: 'n', opened });
      expect(opened).toEqual([]);
    });

    it('--open opens without asking, also with no terminal prompt; the link is said when no browser opens', async () => {
      const opened: string[] = [];
      await withSurface(['--open'], { pasted: '', noPrompt: true, opened });
      expect(opened).toEqual([tryUrl]);
      const { run } = await withSurface(['--open'], { pasted: '', browser: false });
      expect(run.stdout).toContain(`no browser could be opened here: open ${tryUrl} yourself`);
    }, 20_000);

    it('--no-open and --quiet never ask and never open', async () => {
      const opened: string[] = [];
      await withSurface(['--no-open'], { pasted: '', opened });
      await withSurface(['--quiet'], { pasted: '', opened });
      expect(opened).toEqual([]);
    }, 20_000);

    it('--open still opens under --quiet, an explicit request; with --no-open it is a usage error', async () => {
      const opened: string[] = [];
      await withSurface(['--quiet', '--open'], { pasted: '', opened });
      expect(opened).toEqual([tryUrl]);
      const cwd = await projectWithAgent();
      const both = await dev(cwd, { argv: ['--open', '--no-open'] });
      expect(both.run.code).toBe(EXIT_CODE.usage);
      expect(both.run.stderr).toContain('--open and --no-open cannot be used together');
    });

    it('asks only after the first sync has printed its lines', async () => {
      const cwd = await projectWithAgent();
      await tempFile(
        cwd,
        'surfaces/main.ts',
        `${DEFINE}export default defineSurface({ name: 'main', agent: 'assistant' });
`,
      );
      let stdout = '';
      const syncedAtAsk: boolean[] = [];
      await dev(cwd, {
        env: { ANTHROPIC_API_KEY: ANTHROPIC_KEY },
        route: agentsRoute,
        until: (output) => {
          stdout = output.stdout;
          return synced(output);
        },
        tty: { pasted: '', onAsk: () => syncedAtAsk.push(stdout.includes('synced: ')) },
      });
      expect(syncedAtAsk).toEqual([true]);
    });

    it('a fatal first sync neither asks nor opens, even with --open', async () => {
      const cwd = await projectWithAgent();
      await tempFile(
        cwd,
        'surfaces/main.ts',
        `${DEFINE}export default defineSurface({ name: 'main', agent: 'assistant' });
`,
      );
      const opened: string[] = [];
      let thrown = false;
      await dev(cwd, {
        argv: ['--open'],
        env: { ANTHROPIC_API_KEY: ANTHROPIC_KEY },
        route: agentsRoute,
        until: ({ stdout }) => {
          if (!thrown && stdout.includes('synced: ')) {
            thrown = true;
            throw new RangeError('the terminal went away');
          }
          return false;
        },
        tty: { pasted: '', opened },
      });
      expect(opened).toEqual([]);
    });

    it('without a terminal it neither asks nor opens', async () => {
      const { run } = await withSurface([]);
      expect(run.stdout).toContain(`try       ${tryUrl}`);
      expect(run.stdout).not.toContain('Open the chat');
    });

    it('does not offer the chat when the provider rejected the key (BH061-051)', async () => {
      const cwd = await projectWithAgent();
      await tempFile(
        cwd,
        'surfaces/main.ts',
        `${DEFINE}export default defineSurface({ name: 'main', agent: 'assistant' });\n`,
      );
      const asked: string[] = [];
      const opened: string[] = [];
      const { run } = await dev(cwd, {
        env: { ANTHROPIC_API_KEY: ANTHROPIC_KEY },
        route: (request) =>
          request.url.pathname === '/api/models'
            ? json(200, {
                models: [],
                unavailable: [
                  {
                    connectionId: FIXTURES.modelConnection.id,
                    connectionName: 'default',
                    reason: 'The provider rejected the API key (HTTP 401).',
                    kind: 'credential-rejected',
                    status: 401,
                  },
                ],
              })
            : agentsRoute(request),
        until: synced,
        tty: { pasted: '', asked, opened },
      });
      expect(run.stdout).toContain('the key was rejected (401)');
      expect(asked).toEqual([]);
      expect(opened).toEqual([]);
    });

    it('a runtime that crashes while the question is pending ends aw dev with its log tail', async () => {
      const cwd = await project({
        script: fakeRuntime(
          // Crash once the question is pending (the prompt below writes `asked`), not after a fixed
          // sleep: on a loaded runner the sleep ran out before the first sync had asked.
          `${sends(READY, CREDENTIAL)}
const { existsSync } = await import('node:fs');
await new Promise((resolve) => {
  const poll = setInterval(() => {
    if (existsSync('asked')) resolve(clearInterval(poll));
  }, 20);
});
process.exit(3);`,
        ),
      });
      await tempFile(
        cwd,
        'surfaces/main.ts',
        `${DEFINE}export default defineSurface({ name: 'main', agent: 'assistant' });
`,
      );
      await tempFile(
        cwd,
        'agents/assistant.ts',
        `${DEFINE}export default defineAgent({ name: 'assistant', instructions: 'Help people.' });
`,
      );
      const asked: string[] = [];
      const { run } = await dev(cwd, {
        env: { ANTHROPIC_API_KEY: ANTHROPIC_KEY },
        route: agentsRoute,
        tty: {
          pasted: '',
          pending: true,
          asked,
          onAsk: () => {
            writeFileSync(path.join(cwd, 'asked'), '');
          },
        },
      });
      expect(asked).toEqual(['  Open the chat in your browser? (Y/n) ']);
      expect(run.code).not.toBe(0);
      expect(run.stderr).toContain('full log: ');
    });

    it('says where the console password is: the environment, then .env, then the secrets file', async () => {
      const row = async (env: Record<string, string>, dotEnv?: string): Promise<string> => {
        const cwd = await projectWithAgent();
        if (dotEnv !== undefined) await tempFile(cwd, '.env', dotEnv);
        const { run } = await dev(cwd, { env, route: agentsRoute, until: synced });
        expect(run.stdout + run.stderr).not.toContain('Hunter2-Hunter2');
        return /password in (.*)$/mu.exec(run.stdout)?.[1] ?? '';
      };
      expect(await row({})).toBe('.agent-workspace/secrets/local-secrets.json');
      expect(await row({}, 'BOOTSTRAP_ADMIN_PASSWORD=Hunter2-Hunter2\n')).toBe(
        '.env (BOOTSTRAP_ADMIN_PASSWORD)',
      );
      expect(await row({ BOOTSTRAP_ADMIN_PASSWORD: 'Hunter2-Hunter2' })).toBe(
        'your environment (BOOTSTRAP_ADMIN_PASSWORD)',
      );
    }, 60_000);

    it('Ctrl-C at the question is an interrupt', async () => {
      const opened: string[] = [];
      const { run } = await withSurface([], { pasted: '', interrupt: true, opened });
      expect(run.code).toBe(EXIT_CODE.interrupted);
      expect(opened).toEqual([]);
    });
  });

  it('shows no evals row without eval files, and the case total with them', async () => {
    const without = await projectWithAgent();
    const none = await dev(without, { route: agentsRoute, until: synced });
    expect(none.run.stdout).not.toContain('npx aw eval');

    const cwd = await projectWithAgent();
    const cases = (count: number): string =>
      `cases:
${Array.from(
  { length: count },
  (_, i) => `  - name: c${String(i)}
    input: hi
    expect: { contains: [hi] }
`,
).join('')}`;
    await tempFile(cwd, 'evals/A.yaml', cases(2));
    await tempFile(cwd, 'evals/B.yaml', cases(1));
    const { run } = await dev(cwd, { route: agentsRoute, until: synced });
    expect(run.stdout).toContain('  evals     3 cases · npx aw eval\n');
  }, 30_000);

  it('refuses instead of crashing when .aw/logs cannot be created', async () => {
    const cwd = await project({ script: fakeRuntime(sends(READY, CREDENTIAL)) });
    await writeFile(path.join(cwd, '.aw'), 'not a directory');
    const { run } = await dev(cwd);
    expect(run.code).toBe(EXIT_CODE.problem);
    expect(run.stderr).toContain('could not write the runtime log');
  });

  it('points the page, try and widget lines at the URL the runtime said it is ready on', async () => {
    const readyUrl = 'http://localhost:3000';
    const cwd = await projectWithAgent({ ...READY, url: `${readyUrl}/` });
    await tempFile(
      cwd,
      'surfaces/main.ts',
      `${DEFINE}export default defineSurface({ name: 'main', agent: 'assistant' });\n`,
    );
    const { run } = await dev(cwd, {
      route: agentsRoute,
      until: synced,
    });

    expect(run.code, run.stderr).toBe(EXIT_CODE.interrupted);
    expect(run.stdout).toContain(`  try       ${readyUrl}/p/s/main/try\n`);
    expect(run.stdout).toContain(
      `  embed     <script src="${readyUrl}/p/s/main/widget.js" async></script>\n`,
    );
  });

  it('stops the runtime when the sync fails beyond a refusal, and exits with that error', async () => {
    const cwd = await projectWithAgent();
    let thrown = false;
    const { run } = await dev(cwd, {
      route: agentsRoute,
      // The terminal going away while the sync prints: a failure no refusal describes.
      until: ({ stdout }) => {
        if (!thrown && stdout.includes('synced: ')) {
          thrown = true;
          throw new RangeError('the terminal went away');
        }
        return false;
      },
    });
    expect(run.code).toBe(EXIT_CODE.problem);
    expect(run.stderr).toContain('error: unexpected: the terminal went away\n');
    expect(existsSync(path.join(cwd, 'stopped'))).toBe(true);
  });

  it('reports a failed runtime and exits 1', async () => {
    const cwd = await project({
      script: fakeRuntime(sends({ type: 'failed', message: 'Port 3000 is already in use.' })),
    });
    const { run } = await dev(cwd);
    expect(run.code).toBe(EXIT_CODE.problem);
    expect(run.stderr).toContain('error: Port 3000 is already in use.\n');
    expect(run.stderr).toContain('full log: ');
    expect(run.stdout).toBe('');
    // Asked to stop, so its own shutdown ran — on Windows too, where SIGINT would kill it outright.
    expect(existsSync(path.join(cwd, 'stopped'))).toBe(true);
  });

  it('reports a runtime that stops on its own with its exit code', async () => {
    const cwd = await project({ script: fakeRuntime('process.exit(3);') });
    const { run } = await dev(cwd);
    expect(run.code).toBe(EXIT_CODE.problem);
    expect(run.stderr).toContain('the local runtime stopped (exit code 3)');
  });

  it.each([
    ['a skewed runtime version', { embeddedVersion: '0.0.1' }, 'is installed, but aw'],
    ['no runtime installed', { embeddedVersion: null }, 'is not installed in this project'],
  ] as const)('refuses %s with the install line, before forking', async (_name, options, text) => {
    const cwd = await project(options);
    const { run } = await dev(cwd);
    expect(run.code).toBe(EXIT_CODE.problem);
    expect(run.stderr).toContain(text);
    expect(run.stderr).toContain(`fix: ${INSTALL_LINE}\n`);
    expect(existsSync(path.join(cwd, 'start.json'))).toBe(false);
  });

  it("refuses an agent whose engine is not installed with that engine's install line (#691)", async () => {
    const cwd = await project({ engines: false, script: fakeRuntime(sends(READY, CREDENTIAL)) });
    await tempFile(
      cwd,
      'agents/assistant.ts',
      `${DEFINE}export default defineAgent({ name: 'assistant', instructions: 'Help people.' });\n`,
    );
    const { run } = await dev(cwd);
    expect(run.code).toBe(EXIT_CODE.problem);
    expect(run.stderr).toContain('engine claude-agent-sdk is not installed');
    const specs = Object.entries(ENGINE_PACKAGES['claude-agent-sdk']).map(
      ([name, version]) => `${name}@${version}`,
    );
    expect(run.stderr).toContain(`fix: npm install ${specs.join(' ')}\n`);
    expect(existsSync(path.join(cwd, 'start.json'))).toBe(false);
  });

  it('refuses a runtime that speaks another contracts version with the install line', async () => {
    const cwd = await project({
      script: fakeRuntime(sends({ ...READY, contractsVersion: '9.9.9' })),
    });
    const { run } = await dev(cwd);
    expect(run.code).toBe(EXIT_CODE.problem);
    expect(run.stderr).toContain('speaks contracts 9.9.9');
    expect(run.stderr).toContain(`fix: ${INSTALL_LINE}\n`);
    expect(run.stdout).toBe('');
  });

  it.each([
    ['a credential before ready', [CREDENTIAL], 'credential was sent before ready'],
    ['an unknown message type', [{ type: 'hello', token: TOKEN }], 'type'],
    ['a malformed ready', [{ ...READY, url: `http://127.0.0.1:3000/?${TOKEN}` }], 'url'],
    [
      'a ready on another port',
      [{ ...READY, url: 'http://127.0.0.1:4000' }],
      'ready.url is not on port 3000',
    ],
    ['a second ready', [READY, READY], 'ready was sent twice'],
    ['a credential holding a user token', [READY, { ...CREDENTIAL, token: USER_TOKEN }], 'token'],
  ] as const)('stops the runtime on %s and never echoes a value', async (_name, messages, text) => {
    const cwd = await project({ script: fakeRuntime(sends(...messages)) });
    const { run, home } = await dev(cwd);
    expect(run.code).toBe(EXIT_CODE.problem);
    expect(run.stderr).toContain('the local runtime broke the protocol: ');
    expect(run.stderr).toContain(text);
    expect(run.stdout + run.stderr).not.toContain(TOKEN);
    expect(run.stdout + run.stderr).not.toContain(USER_TOKEN);
    expect(existsSync(localCredentialsFilePath(home))).toBe(false);
  });

  it('keeps the output of the runtime in .aw/logs/runtime.log and prints the last 20 lines of it when it fails', async () => {
    const lines = Array.from({ length: 30 }, (_unused, index) => `line ${String(index + 1)}`);
    const cwd = await project({
      script: fakeRuntime(
        `console.log(${JSON.stringify(lines.join('\n'))});
console.error('initdb said this');
process.exit(3);`,
      ),
    });
    const { run } = await dev(cwd);
    expect(run.code).toBe(EXIT_CODE.problem);
    expect(run.stdout).toBe('');
    expect(run.stderr).toContain('line 30\n');
    expect(run.stderr).toContain('line 12\n');
    expect(run.stderr).not.toContain('line 11\n');
    expect(run.stderr).toContain(path.join(cwd, '.aw', 'logs', 'runtime.log'));
    const log = await readFile(path.join(cwd, '.aw', 'logs', 'runtime.log'), 'utf8');
    expect(log).toContain('line 1\n');
    expect(log).toContain('initdb said this');
  });

  it('streams the output of the runtime with --verbose and prints no screen with --quiet', async () => {
    const script = fakeRuntime(`console.log('postgres is up'); ${sends(READY, CREDENTIAL)}`);
    const cwd = await project({ script });
    const verbose = await dev(cwd, { argv: ['--verbose'], until: signedIn });
    expect(verbose.run.stdout).toContain('postgres is up');
    const quiet = await dev(cwd, { argv: ['--quiet'], until: signedIn });
    expect(quiet.run.stdout).toBe('');
    expect(quiet.run.stderr).not.toContain('postgres is up');
    const refused = await dev(cwd, { argv: ['--quiet', '--verbose'] });
    expect(refused.run.code).toBe(EXIT_CODE.usage);
  });

  it('prints no runtime output, not even a sign-in line with a password (BH061-011)', async () => {
    const line =
      'Sign in at http://127.0.0.1:3000 as admin@localhost.test with password PPBRLllEuBBDmkK1 (shown once; it is kept in /x/local-secrets.json)';
    const cwd = await project({
      script: fakeRuntime(
        `console.log('postgres is up'); console.log(${JSON.stringify(line)}); ${sends(READY, CREDENTIAL)}`,
      ),
    });
    const { run } = await dev(cwd, { until: signedIn });
    expect(run.stdout).not.toContain('PPBRLllEuBBDmkK1');
    expect(run.stdout).not.toContain('postgres is up');
  });

  it('forwards an interrupt to the runtime and exits 130', async () => {
    const cwd = await project({ script: fakeRuntime(sends(READY, CREDENTIAL)) });
    const { run } = await dev(cwd, { until: signedIn });
    expect(run.code).toBe(EXIT_CODE.interrupted);
    expect(run.stderr.endsWith('interrupted\n')).toBe(true);
    // BH061-072: said at once, on its own line after the terminal's ^C.
    expect(run.stderr).toContain('\nstopping the local runtime…\n');
    // The runtime's own shutdown ran on every platform: the IPC channel closing asks it to stop.
    expect(existsSync(path.join(cwd, 'stopped'))).toBe(true);
  });

  it('stops the tool host child when it stops', async () => {
    const cwd = await project({ script: fakeRuntime(sends(READY, CREDENTIAL)) });
    await mkdir(path.join(cwd, 'tools'));
    // What `defineTool` makes, branded by hand: the temp project cannot import the SDK.
    await writeFile(
      path.join(cwd, 'tools', 'probe.ts'),
      `const tool = { name: 'probe', description: 'probe', inputSchema: { type: 'object' }, run: './tools/probe.run.js', limits: { timeoutMs: 1000 } };
Object.defineProperty(tool, Symbol.for('agentworkspace.dev/define'), { value: 'code' });
export default tool;
`,
    );
    await writeFile(
      path.join(cwd, 'tools', 'probe.run.js'),
      `import { writeFileSync } from 'node:fs';
writeFileSync('tool-host.pid', String(process.pid));
export default () => 1;
`,
    );
    const { run } = await dev(cwd, { until: signedIn });
    expect(run.code, run.stderr).toBe(EXIT_CODE.interrupted);
    const pid = Number(await readFile(path.join(cwd, 'tool-host.pid'), 'utf8'));
    expect(pid).toBeGreaterThan(0);
    // `aw dev` awaits the host, so the child is already gone when it returns.
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it.each(['http://localhost:3000', 'http://[::1]:3000'])(
    'accepts a ready on %s, a loopback host the contract allows, on the asked port',
    async (url) => {
      const cwd = await project({ script: fakeRuntime(sends({ ...READY, url }, CREDENTIAL)) });
      const { run } = await dev(cwd, { until: signedIn });
      expect(run.code, run.stderr).toBe(EXIT_CODE.interrupted);
      expect(run.stdout).toContain('Agent Workspace');
    },
  );

  it('moves an unpinned web port that is busy to the next free one and says so', async () => {
    // Hold 3000 if nothing does yet; either way it is busy for the whole case.
    const holder = createServer();
    await new Promise<void>((resolve) => {
      holder.once('error', () => {
        resolve();
      });
      holder.listen(3000, '127.0.0.1', resolve);
    });
    try {
      const ready = { ...READY, url: 'http://127.0.0.1:PORT' };
      const script = fakeRuntime(
        `await send({ ...${JSON.stringify(ready)}, url: 'http://127.0.0.1:' + start.environment.port });
${sends(CREDENTIAL)}`,
      );
      const cwd = await project({ script });
      // Issue #730: while it runs, the record other `aw` commands read names the port it bound.
      const recordFile = path.join(cwd, '.aw', 'runtime.json');
      let record: unknown;
      const { run, home } = await dev(cwd, {
        env: { AW_DATABASE_PORT: undefined },
        until: (output) => {
          if (!signedIn(output)) return false;
          // Read once: later output (the interruption) arrives after the clean exit removed it.
          record ??= JSON.parse(readFileSync(recordFile, 'utf8'));
          return true;
        },
      });
      const start = LocalRuntimeStartMessageSchema.parse(
        JSON.parse(await readFile(path.join(cwd, 'start.json'), 'utf8')),
      );
      expect(start.environment.port).toBeGreaterThan(3000);
      expect(run.stdout).toContain(
        `web       on :${String(start.environment.port)} (3000 was busy)`,
      );
      expect(record).toEqual({ port: start.environment.port, pid: process.pid });
      // The record is written on sign-in, after the key for that port was stored.
      const stored: unknown = JSON.parse(await readFile(localCredentialsFilePath(home), 'utf8'));
      expect(stored).toHaveProperty([`http://127.0.0.1:${String(start.environment.port)}`]);
      // A clean exit removes it, so the project file's port is used again.
      expect(existsSync(recordFile)).toBe(false);
    } finally {
      holder.close();
    }
  });

  it('prints the address the runtime signs in as: lowercased, or BOOTSTRAP_ADMIN', async () => {
    const yaml = renderedYaml().replace('admin@localhost.test', 'Admin@Localhost.TEST');
    expect(yaml).toContain('Admin@Localhost.TEST');
    const cwd = await project({ yaml, script: fakeRuntime(sends(READY, CREDENTIAL)) });
    const mixed = await dev(cwd, { route: modelConnections([]), until: signedIn });
    expect(mixed.run.stdout).toContain('signed in as admin@localhost.test (workspace local)\n');
    const overridden = await dev(cwd, {
      env: { BOOTSTRAP_ADMIN: 'Owner@Example.COM' },
      route: modelConnections([]),
      until: signedIn,
    });
    expect(overridden.run.stdout).toContain('signed in as owner@example.com (workspace local)\n');
  });

  it('refuses a project file whose bootstrap admin holds a terminal control character, echoing nothing', async () => {
    const yaml = renderedYaml().replace(
      'admin@localhost.test',
      '"evil\\u001b]0;pwned\\u0007\\u001b[2J@x.test"',
    );
    const cwd = await project({ yaml, script: fakeRuntime(sends(READY, CREDENTIAL)) });
    const { run } = await dev(cwd, { route: modelConnections([]), until: signedIn });
    // The contract's schema refuses it while the project file is read, by line and column.
    expect(run.code, run.stderr).toBe(EXIT_CODE.usage);
    expect(run.stderr).toContain(
      'environments.local.identity.bootstrapAdmin must not contain a control character',
    );
    expect(run.stdout + run.stderr).not.toContain('\u001b');
    expect(run.stdout + run.stderr).not.toContain('pwned');
    expect(existsSync(path.join(cwd, 'start.json'))).toBe(false);
  });

  it.each([
    ['a terminal control sequence', 'evil\u001b]0;pwned\u0007\u001b[2J@x.test'],
    ['a C1 control', 'evil\u009bpwned@x.test'],
    ['a value that is not an email address', 'pwned'],
  ])('refuses a BOOTSTRAP_ADMIN override holding %s, echoing nothing', async (_case, override) => {
    const cwd = await project({ script: fakeRuntime(sends(READY, CREDENTIAL)) });
    const { run } = await dev(cwd, {
      env: { BOOTSTRAP_ADMIN: override },
      route: modelConnections([]),
      until: signedIn,
    });
    expect(run.code, run.stderr).toBe(EXIT_CODE.problem);
    expect(run.stderr).toBe(
      'error: the bootstrap admin address is not a plain email address (it may hold a control character), so aw dev will not print or use it\n' +
        'fix: set identity.bootstrapAdmin in agent-workspace.yaml (or BOOTSTRAP_ADMIN) to a plain email address\n',
    );
    expect(run.stdout + run.stderr).not.toContain('\u001b');
    expect(run.stdout + run.stderr).not.toContain('\u009b');
    expect(run.stdout + run.stderr).not.toContain('pwned');
    expect(existsSync(path.join(cwd, 'start.json'))).toBe(false);
  });

  it('refuses outside a project, naming aw init', async () => {
    const cwd = await freshDirectory();
    const { run } = await dev(cwd);
    expect(run.code).toBe(EXIT_CODE.problem);
    expect(run.stderr).toBe(
      'error: no agent-workspace.yaml in this directory\nfix: aw init --yes\n',
    );
  });

  it.each([
    [
      'a lifted v1 profile with storage',
      [
        'apiVersion: agentworkspace.dev/v1',
        'kind: Deployment',
        'cloud: local',
        'storage:',
        '  relational: compose',
        '  objects: compose',
        '  secrets: compose',
        'runtime:',
        '  default: docker',
        'identity:',
        '  bootstrapAdmin: admin@localhost.test',
        '',
      ].join('\n'),
      {},
      'storage',
    ],
    [
      'a kubernetes runtime',
      renderedYaml().replace(
        '    cloud: local\n',
        '    cloud: local\n    runtime:\n      default: kubernetes\n',
      ),
      {},
      'environments.local.runtime.default',
    ],
    [
      'an ANTHROPIC_BASE_URL that is not an http(s) URL',
      renderedYaml(),
      { ANTHROPIC_BASE_URL: 'ftp://llm.example.com' },
      'ANTHROPIC_BASE_URL',
    ],
  ] as const)('refuses %s by name, with nothing forked', async (_name, yaml, env, field) => {
    const cwd = await project({ yaml });
    const { run } = await dev(cwd, { env });
    expect(run.code, run.stderr).toBe(EXIT_CODE.problem);
    expect(run.stderr).toContain(field);
    expect(run.stderr).not.toContain('ftp://');
    expect(existsSync(path.join(cwd, 'start.json'))).toBe(false);
  });

  it('refuses a malformed project file with its line and column', async () => {
    const cwd = await project({ yaml: `${renderedYaml()}surprise: true\n` });
    const { run } = await dev(cwd);
    expect(run.code).toBe(EXIT_CODE.usage);
    expect(run.stderr).toMatch(/^error: agent-workspace\.yaml:\d+:\d+: /u);
  });

  it.each([
    [4000, 'gateway'],
    [8080, 'runner'],
  ] as const)(
    'refuses the reserved port %i (the runtime %s) at its line, before resolving or forking a runtime (issue #560)',
    async (port, service) => {
      const yaml = renderedYaml().replace(
        '    cloud: local\n',
        `    cloud: local\n    port: ${String(port)}\n`,
      );
      // With a runtime installed, and with none: the file is refused before either matters.
      for (const options of [{ yaml }, { yaml, embeddedVersion: null }]) {
        const cwd = await project(options);
        const { run } = await dev(cwd);
        expect(run.code, run.stderr).toBe(EXIT_CODE.usage);
        expect(run.stderr).toMatch(
          new RegExp(
            `^error: agent-workspace\\.yaml:\\d+:5: environments\\.local\\.port is reserved by the local runtime's ${service} \\(${String(port)}\\); choose another port\\n`,
            'u',
          ),
        );
        expect(existsSync(path.join(cwd, 'start.json'))).toBe(false);
      }
    },
  );

  it.each([
    ['--url', ['--url', 'http://x.example.com']],
    ['--json', ['--json']],
    ['--profile', ['--profile', 'p']],
    ['--api-key-stdin', ['--api-key-stdin']],
    ['--timeout', ['--timeout', '5']],
    ['--yes', ['--yes']],
  ] as const)('refuses %s by name rather than accepting and ignoring it', async (flag, argv) => {
    const cwd = await project();
    const { run } = await dev(cwd, { argv });
    expect(run.code).toBe(EXIT_CODE.usage);
    expect(run.stderr).toContain(`aw dev does not take ${flag}`);
    expect(existsSync(path.join(cwd, 'start.json'))).toBe(false);
  });
});

describe('aw dev applies the project file (issue #547)', () => {
  it('creates models.default from ANTHROPIC_API_KEY and keeps the key out of every file and both forks', async () => {
    const cwd = await project({
      yaml: yamlWith(DEFAULT_MODEL_YAML),
      script: fakeRuntime(sends(READY, CREDENTIAL)),
    });
    await tempFile(cwd, 'agents/assistant.ts', ENV_AGENT);
    const { run, home } = await dev(cwd, {
      env: { ANTHROPIC_API_KEY: ANTHROPIC_KEY },
      route: workspaceRoute(),
      until: synced,
    });

    expect(run.code, run.stderr).toBe(EXIT_CODE.interrupted);
    const create = run.calls.find(
      (call) => call.method === 'POST' && call.url.pathname === '/api/model-connections',
    );
    expect(create?.json).toEqual({ name: 'default', provider: 'anthropic', apiKey: ANTHROPIC_KEY });
    expect(run.stdout).toContain('model connection: default (anthropic)\n');
    expect(run.stdout + run.stderr).not.toContain(ANTHROPIC_KEY);
    // Sealed under .agent-workspace/ as an HMAC only; in no other file.
    const fingerprints: unknown = JSON.parse(
      await readFile(path.join(cwd, '.agent-workspace', 'secret-fingerprints.json'), 'utf8'),
    );
    const hmac = z.string().regex(/^[0-9a-f]{64}$/u);
    const sealed = z
      .object({
        key: z.string().regex(/^[A-Za-z0-9+/]{43}=$/u),
        fingerprints: z.record(z.string(), hmac),
      })
      .strict();
    expect(Object.keys(sealed.parse(fingerprints).fingerprints)).toEqual(['ANTHROPIC_API_KEY']);
    for (const file of [...(await filesUnder(home)), ...(await filesUnder(cwd))]) {
      expect(await readFile(file, 'utf8'), file).not.toContain(ANTHROPIC_KEY);
    }
    // Neither fork holds it: the runtime (asserted on its env) and the loader child (its ENV line).
    expect(await forkedEnv(cwd)).not.toContain('ANTHROPIC_API_KEY');
    expect(run.stderr).toMatch(/^ENV /mu);
    expect(run.stderr).not.toContain('ANTHROPIC_API_KEY');
    const start = LocalRuntimeStartMessageSchema.parse(
      JSON.parse(await readFile(path.join(cwd, 'start.json'), 'utf8')),
    );
    expect(start.environment.withheld).toEqual(['ANTHROPIC_API_KEY']);
    expect(start.environment.policy).toBeUndefined();
  });

  it('withholds a connector secret in any case, creates the MCP connector and prints the ADR-0108 notice', async () => {
    const cwd = await project({
      yaml: yamlWith(GITHUB_YAML),
      script: fakeRuntime(sends(READY, CREDENTIAL)),
    });
    await tempFile(cwd, 'agents/assistant.ts', ENV_AGENT);
    const token = 'orders-token-never-in-a-fork';
    const { run } = await dev(cwd, {
      env: { ORDERS_TOKEN: token, orders_token: 'lower-case-twin' },
      route: workspaceRoute(),
      until: synced,
    });

    expect(run.code, run.stderr).toBe(EXIT_CODE.interrupted);
    const create = run.calls.find(
      (call) => call.method === 'POST' && call.url.pathname === '/api/connectors',
    );
    expect(create?.json).toEqual({
      name: 'github',
      transport: 'http',
      url: 'https://mcp.example.com',
      authType: 'bearer',
      credential: token,
    });
    expect(run.stdout).toContain('applied: connector github (new)\n');
    expect(run.stdout).toContain(
      'connectors.github: MCP tools that write run without confirmation (ADR-0108)\n',
    );
    const forked = (await forkedEnv(cwd)).map((name) => name.toUpperCase());
    expect(forked).not.toContain('ORDERS_TOKEN');
    expect(run.stderr).toMatch(/^ENV /mu);
    expect(run.stderr.toUpperCase()).not.toContain('ORDERS_TOKEN');
    expect(run.stdout + run.stderr).not.toContain(token);
    expect(run.stdout + run.stderr).not.toContain('lower-case-twin');
  });

  it('rotates a credential whose variable changed since the last start, with a notice, and only then', async () => {
    const cwd = await project({
      yaml: yamlWith(DEFAULT_MODEL_YAML),
      script: fakeRuntime(sends(READY, CREDENTIAL)),
    });
    const route = workspaceRoute({ models: [{ ...FIXTURES.modelConnection, name: 'default' }] });
    const rotations = (run: CliRun): number =>
      run.calls.filter((call) => call.url.pathname.endsWith('/credential')).length;
    const start = (key: string): Promise<DevRun> =>
      dev(cwd, { env: { ANTHROPIC_API_KEY: key }, route, until: syncSaid });

    // Nothing recorded yet: sent once, and recorded.
    expect(rotations((await start(ANTHROPIC_KEY)).run)).toBe(1);
    const unchanged = (await start(ANTHROPIC_KEY)).run;
    expect(rotations(unchanged)).toBe(0);
    expect(unchanged.stderr).not.toContain('rotating');
    const changed = (await start(`${ANTHROPIC_KEY}-new`)).run;
    expect(rotations(changed)).toBe(1);
    expect(changed.stderr).toContain(
      'notice: ANTHROPIC_API_KEY changed: rotating the credential\n',
    );
    expect(changed.stdout + changed.stderr).not.toContain(ANTHROPIC_KEY);
    // Three full starts in a row: about 4s alone, so it outlives the default per-test budget.
  }, 15_000);

  it('says an unset variable by name and still syncs the agents (C10)', async () => {
    const cwd = await projectWithAgentAnd(yamlWith(GITHUB_YAML));
    const { run } = await dev(cwd, { route: workspaceRoute(), until: synced });
    expect(run.code, run.stderr).toBe(EXIT_CODE.interrupted);
    expect(run.stderr).toContain(
      'notice: ORDERS_TOKEN is not set: run export ORDERS_TOKEN=… in the shell aw dev started from, then restart aw dev\n',
    );
    const connectorPosts = run.calls.filter(
      (call) => call.method === 'POST' && call.url.pathname === '/api/connectors',
    );
    expect(connectorPosts).toEqual([]);
    expect(run.stdout).toContain('synced: "assistant" created at version 1');
  });

  it('refuses to change the provider of an existing connection, and keeps the runtime up', async () => {
    const cwd = await project({
      yaml: yamlWith(DEFAULT_MODEL_YAML),
      script: fakeRuntime(sends(READY, CREDENTIAL)),
    });
    const route = workspaceRoute({
      models: [{ ...FIXTURES.modelConnection, name: 'default', provider: 'openai' }],
    });
    const { run } = await dev(cwd, {
      env: { ANTHROPIC_API_KEY: ANTHROPIC_KEY },
      route,
      until: syncSaid,
    });
    expect(run.code, run.stderr).toBe(EXIT_CODE.interrupted);
    expect(run.stderr).toContain(
      'warning: models.default.provider: the connection is openai on the server and anthropic here',
    );
    expect(run.calls.filter((call) => call.method !== 'GET')).toEqual([]);
  });

  it('sends the project file policy in start', async () => {
    const cwd = await project({
      yaml: yamlWith('policy:\n  permissions:\n    runCommands: false\n'),
      script: fakeRuntime(sends(READY, CREDENTIAL)),
    });
    const { run } = await dev(cwd, { route: modelConnections(['default']), until: syncSaid });
    expect(run.code, run.stderr).toBe(EXIT_CODE.interrupted);
    const start = LocalRuntimeStartMessageSchema.parse(
      JSON.parse(await readFile(path.join(cwd, 'start.json'), 'utf8')),
    );
    expect(start.environment).toEqual({
      port: 3000,
      bootstrapAdmin: 'admin@localhost.test',
      policy: { permissions: { runCommands: false } },
      modelSecrets: ['ANTHROPIC_API_KEY'],
    });
  });

  it("sends the declared model connections' secret names, never their values, in start (#661)", async () => {
    const cwd = await project({
      yaml: yamlWith(
        [
          'models:',
          '  main:',
          '    provider: anthropic',
          '    credential:',
          '      secret: MAIN_MODEL_KEY',
          '',
        ].join('\n'),
      ),
      script: fakeRuntime(sends(READY, CREDENTIAL)),
    });
    const { run } = await dev(cwd, {
      route: modelConnections(['main']),
      until: syncSaid,
      env: { MAIN_MODEL_KEY: 'sk-ant-test-SENTINEL' },
    });
    expect(run.code, run.stderr).toBe(EXIT_CODE.interrupted);
    const text = await readFile(path.join(cwd, 'start.json'), 'utf8');
    expect(LocalRuntimeStartMessageSchema.parse(JSON.parse(text)).environment.modelSecrets).toEqual(
      ['MAIN_MODEL_KEY'],
    );
    expect(text).not.toContain('SENTINEL');
  });

  it("prints the server's 403 policy_cannot_widen and keeps syncing on the next save (C14)", async () => {
    const cwd = await projectWithAgent();
    let dryRuns = 0;
    const route: Route = (request) => {
      if (request.method === 'POST' && request.url.pathname === '/api/agents') {
        const body = CreateAgentFromVersionRequestSchema.parse(request.json);
        if (body.dryRun === true) dryRuns += 1;
        if (body.dryRun === true && dryRuns === 1) {
          return json(403, {
            error: {
              code: 'policy_cannot_widen',
              message: 'the policy ceiling refuses it',
              details: ['permissions.runCommands'],
            },
          });
        }
      }
      return agentsRoute(request);
    };
    let saved = false;
    const { run } = await dev(cwd, {
      route,
      until: ({ stdout }) => {
        if (!saved && stdout.includes('403 policy_cannot_widen')) {
          saved = true;
          void appendFile(path.join(cwd, 'agents/assistant.ts'), '// saved again\n');
        }
        return stdout.includes('synced: ');
      },
    });
    expect(run.code, run.stderr).toBe(EXIT_CODE.interrupted);
    expect(run.stdout).toContain(
      'agents/assistant.ts: 403 policy_cannot_widen [permissions.runCommands]\n',
    );
    expect(run.stdout).toContain('synced: "assistant" created at version 1');
  });

  /** Edit the project file once `aw dev` has synced, and stop when `done` holds (issue #695). */
  async function saveYaml(
    cwd: string,
    edit: (yaml: string) => string,
    done: (output: { readonly stdout: string; readonly stderr: string }) => boolean,
    env: Record<string, string> = {},
    route: Route = workspaceRoute(),
  ) {
    let edited = false;
    return dev(cwd, {
      env,
      route,
      until: (output) => {
        if (!edited && output.stdout.includes('synced: ')) {
          edited = true;
          void readFile(path.join(cwd, 'agent-workspace.yaml'), 'utf8').then((yaml) =>
            writeFile(path.join(cwd, 'agent-workspace.yaml'), edit(yaml)),
          );
        }
        return edited && done(output);
      },
    });
  }

  it('applies a connector added to agent-workspace.yaml without a restart (#695)', async () => {
    const cwd = await projectWithAgent();
    const { run } = await saveYaml(
      cwd,
      (yaml) => `${yaml}${GITHUB_YAML}`,
      ({ stdout }) => stdout.includes('connectors.github: MCP tools'),
      { ORDERS_TOKEN: 'orders-token-value' },
    );
    expect(run.code, run.stderr).toBe(EXIT_CODE.interrupted);
    const posts = run.calls.filter(
      (call) => call.method === 'POST' && call.url.pathname === '/api/connectors',
    );
    expect(posts).toHaveLength(1);
    // The runtime was forked with ORDERS_TOKEN in its environment: say so, once, as the only restart.
    expect(run.stderr).toContain(
      "ORDERS_TOKEN was in aw dev's environment when the runtime started; restart aw dev to withhold it from the runtime\n",
    );
    expect(run.stderr.match(/restart aw dev to withhold/gu)).toHaveLength(1);
    expect(JSON.stringify(run.stdout + run.stderr)).not.toContain('orders-token-value');
  });

  it('applies a model connection added to agent-workspace.yaml without a restart (#695)', async () => {
    const cwd = await projectWithAgent();
    const { run } = await saveYaml(
      cwd,
      (yaml) => `${yaml}${DEFAULT_MODEL_YAML}`,
      ({ stdout }) => stdout.split('model connection: default (anthropic)').length > 2,
      { ANTHROPIC_API_KEY: 'sk-ant-test-live' },
    );
    expect(run.code, run.stderr).toBe(EXIT_CODE.interrupted);
    const posts = run.calls.filter(
      (call) => call.method === 'POST' && call.url.pathname === '/api/model-connections',
    );
    expect(posts).toHaveLength(2);
    expect(run.stderr).not.toContain('restart aw dev');
    expect(run.stdout + run.stderr).not.toContain('sk-ant-test-live');
  });

  it.each([
    [
      'environments.local.port',
      (yaml: string) => yaml.replace('cloud: local', 'cloud: local\n    port: 3999'),
    ],
    [
      'environments.local.runtime',
      (yaml: string) =>
        yaml.replace('cloud: local', 'cloud: local\n    runtime:\n      default: docker'),
    ],
    ['engine', (yaml: string) => `${yaml}engine: pi\n`],
    ['policy', (yaml: string) => `${yaml}policy:\n  permissions:\n    runCommands: false\n`],
    ['features', (yaml: string) => `${yaml}features: [chat, files]\n`],
  ])(
    'names a changed %s in one restart line and applies nothing for it (#695)',
    async (key, edit) => {
      const cwd = await projectWithAgent();
      const inner = workspaceRoute();
      let created = false;
      const { run } = await saveYaml(
        cwd,
        edit,
        ({ stderr }) => stderr.includes(`${key} changed`),
        { ANTHROPIC_API_KEY: 'sk-ant-test-restart' },
        // The workspace keeps the default connection the start-up created.
        (request) => {
          const connections = request.url.pathname === '/api/model-connections';
          if (connections && request.method === 'POST') created = true;
          if (connections && request.method === 'GET' && created) {
            return json(200, { models: [{ ...FIXTURES.modelConnection, name: 'default' }] });
          }
          return inner(request);
        },
      );
      expect(run.code, run.stderr).toBe(EXIT_CODE.interrupted);
      expect(run.stderr).toContain(
        `agent-workspace.yaml: ${key} changed; restart aw dev to apply\n`,
      );
      expect(run.stderr.match(/restart aw dev to apply/gu)).toHaveLength(1);
      const writes = run.calls.filter(
        (call) =>
          call.method === 'POST' &&
          (call.url.pathname === '/api/connectors' ||
            call.url.pathname === '/api/model-connections'),
      );
      // Only the start-up default connection was created; the save sent nothing.
      expect(writes.filter((call) => call.url.pathname === '/api/connectors')).toEqual([]);
      expect(writes.filter((call) => call.url.pathname === '/api/model-connections')).toHaveLength(
        1,
      );
    },
  );

  it('says an unset connector secret once across two saves of the file (#695)', async () => {
    const cwd = await projectWithAgent();
    const controller = new AbortController();
    const inner = workspaceRoute();
    let lists = 0;
    let saves = 0;
    const { run } = await dev(cwd, {
      controller,
      route: (request) => {
        if (request.method === 'GET' && request.url.pathname === '/api/connectors') lists += 1;
        // The agents sync that follows the second apply: its notices are already printed.
        if (lists >= 2 && request.url.pathname.startsWith('/api/agents')) controller.abort();
        return inner(request);
      },
      until: ({ stdout, stderr }) => {
        if (saves === 0 && stdout.includes('synced: ')) {
          saves = 1;
          void readFile(path.join(cwd, 'agent-workspace.yaml'), 'utf8').then((yaml) =>
            writeFile(path.join(cwd, 'agent-workspace.yaml'), `${yaml}${GITHUB_YAML}`),
          );
        } else if (saves === 1 && stderr.includes('ORDERS_TOKEN is not set:')) {
          saves = 2;
          void appendFile(path.join(cwd, 'agent-workspace.yaml'), '# again\n');
        }
        return false;
      },
    });
    expect(run.code, run.stderr).toBe(EXIT_CODE.interrupted);
    expect(lists).toBeGreaterThanOrEqual(2);
    expect(run.stderr.split('\n').filter((line) => line.includes('ORDERS_TOKEN'))).toHaveLength(1);
    expect(run.stderr).toContain('run export ORDERS_TOKEN=');
    expect(run.stderr).not.toContain('aw secrets');
  });

  it('applies a second save of the file made while the first is still applying (#695)', async () => {
    const cwd = await projectWithAgent();
    const inner = workspaceRoute();
    let posts = 0;
    let started = false;
    const { run } = await dev(cwd, {
      env: { ORDERS_TOKEN: 'orders-token-value' },
      route: async (request) => {
        const created = request.method === 'POST' && request.url.pathname === '/api/connectors';
        if (created) posts += 1;
        if (created && posts === 1) {
          // A second save lands while this one is being applied.
          await appendFile(
            path.join(cwd, 'agent-workspace.yaml'),
            '  other:\n    url: https://mcp2.example.com\n',
          );
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
        return inner(request);
      },
      until: ({ stdout }) => {
        if (stdout.includes('synced: ') && !started) {
          started = true;
          void readFile(path.join(cwd, 'agent-workspace.yaml'), 'utf8').then((yaml) =>
            writeFile(path.join(cwd, 'agent-workspace.yaml'), `${yaml}${GITHUB_YAML}`),
          );
        }
        return stdout.split('connectors.').length > 2;
      },
    });
    expect(run.code, run.stderr).toBe(EXIT_CODE.interrupted);
    const created = run.calls
      .filter((call) => call.method === 'POST' && call.url.pathname === '/api/connectors')
      .map((call) => JSON.stringify(call.json));
    expect(created.some((body) => body.includes('"other"'))).toBe(true);
  });

  it('says a secret() named after it started once, and withholds it from later loaders', async () => {
    const cwd = await projectWithAgent();
    const late = `import { defineAgent, postgresTool, secret } from '@indx-workspace/sdk/define';
console.log('ENV ' + Object.keys(process.env).join(','));
const warehouse = postgresTool({ name: 'warehouse', url: secret('LATE_TOKEN'), readOnly: true, tables: ['public.orders'] });
export default defineAgent({ name: 'assistant', instructions: 'Help people.', tools: [warehouse] });
`;
    let step = 0;
    const { run } = await dev(cwd, {
      route: workspaceRoute(),
      until: ({ stdout, stderr }) => {
        if (step === 0 && stdout.includes('synced: ')) {
          step = 1;
          void writeFile(path.join(cwd, 'agents/assistant.ts'), late);
        } else if (step === 1 && stderr.includes('LATE_TOKEN is not set:')) {
          step = 2;
          void appendFile(path.join(cwd, 'agents/assistant.ts'), '// saved again\n');
        }
        return step === 2 && (stderr.match(/^ENV /gmu) ?? []).length >= 2;
      },
    });
    expect(run.code, run.stderr).toBe(EXIT_CODE.interrupted);
    // One line names it: the tool notice, not a second contradicting one.
    expect(
      run.stderr
        .split('\n')
        .filter((line) => line.includes('LATE_TOKEN') && !line.startsWith('ENV ')),
    ).toHaveLength(1);
    expect(run.stderr).not.toContain('aw secrets');
    // The runtime was forked withholding it: a later loader does not see it either.
    const envLines = run.stderr.split('\n').filter((line) => line.startsWith('ENV '));
    expect(envLines.at(-1)).not.toContain('LATE_TOKEN');
  });
});

describe('aw dev --sandbox (issue #786)', () => {
  const WARNING = 'can run commands, and aw dev runs it on the local driver with no sandbox';
  const DOCKER_YAML = renderedYaml().replace(
    '    cloud: local\n',
    '    cloud: local\n    runtime:\n      default: docker\n',
  );

  /** A `PATH` whose `docker` exits with `code`; `undefined` has no `docker` at all. */
  async function pathWithDocker(code: number | undefined): Promise<string> {
    const bin = await freshDirectory();
    if (code === undefined) return bin;
    await writeFile(path.join(bin, 'docker'), `#!/bin/sh\nexit ${String(code)}\n`, { mode: 0o755 });
    return `${bin}${path.delimiter}${process.env['PATH'] ?? ''}`;
  }

  async function startedDriver(cwd: string): Promise<string | undefined> {
    const start = LocalRuntimeStartMessageSchema.parse(
      JSON.parse(await readFile(path.join(cwd, 'start.json'), 'utf8')),
    );
    return start.environment.runtimeDriver;
  }

  const runtimeProject = (yaml?: string): Promise<string> =>
    project({
      script: fakeRuntime(sends(READY, CREDENTIAL)),
      ...(yaml === undefined ? {} : { yaml }),
    });

  describe.skipIf(process.platform === 'win32')('with a docker command on PATH', () => {
    it('--sandbox docker starts the runtime on the docker driver when Docker answers', async () => {
      const cwd = await runtimeProject();
      const { run } = await dev(cwd, {
        argv: ['--sandbox', 'docker'],
        env: { PATH: await pathWithDocker(0) },
        route: modelConnections([]),
        until: signedIn,
      });
      expect(run.code, run.stderr).toBe(EXIT_CODE.interrupted);
      expect(await startedDriver(cwd)).toBe('docker');
    });

    it('runtime.default: docker in the project file does the same without the flag', async () => {
      const cwd = await runtimeProject(DOCKER_YAML);
      const { run } = await dev(cwd, {
        env: { PATH: await pathWithDocker(0) },
        route: modelConnections([]),
        until: signedIn,
      });
      expect(run.code, run.stderr).toBe(EXIT_CODE.interrupted);
      expect(await startedDriver(cwd)).toBe('docker');
    });

    it('--sandbox local beats the project file and never probes Docker', async () => {
      const cwd = await runtimeProject(DOCKER_YAML);
      const { run } = await dev(cwd, {
        argv: ['--sandbox', 'local'],
        env: { PATH: await pathWithDocker(1) },
        route: modelConnections([]),
        until: signedIn,
      });
      expect(run.code, run.stderr).toBe(EXIT_CODE.interrupted);
      expect(await startedDriver(cwd)).toBe('local');
    });

    it('refuses once, with nothing forked, when the Docker daemon does not answer', async () => {
      for (const [argv, yaml, from] of [
        [['--sandbox', 'docker'], undefined, '--sandbox docker'],
        [[], DOCKER_YAML, 'environments.local.runtime.default: docker'],
      ] as const) {
        const cwd = await runtimeProject(yaml);
        const { run } = await dev(cwd, { argv, env: { PATH: await pathWithDocker(1) } });
        expect(run.code, run.stderr).toBe(EXIT_CODE.problem);
        expect(run.stderr).toBe(
          `error: ${from}: Docker is not reachable, so aw dev cannot run the docker sandbox\n` +
            'fix: start Docker so that `docker version` answers, or run without the docker sandbox\n',
        );
        expect(existsSync(path.join(cwd, 'start.json'))).toBe(false);
      }
    });

    it('draws no unsandboxed warning under the docker sandbox, which runs agents in containers', async () => {
      const cwd = await projectWithAgent();
      await writeFile(
        path.join(cwd, 'agents/assistant.ts'),
        `${DEFINE}export default defineAgent({ name: 'assistant', instructions: 'Help people.', permissions: { runCommands: true } });\n`,
      );
      const { run } = await dev(cwd, {
        argv: ['--sandbox', 'docker'],
        env: { PATH: await pathWithDocker(0) },
        route: agentsRoute,
        until: synced,
      });
      expect(run.code, run.stderr).toBe(EXIT_CODE.interrupted);
      expect(await startedDriver(cwd)).toBe('docker');
      expect(run.stderr).not.toContain('no sandbox');
    });

    it('refuses the same way when there is no docker command at all', async () => {
      const cwd = await runtimeProject();
      const { run } = await dev(cwd, {
        argv: ['--sandbox', 'docker'],
        env: { PATH: await pathWithDocker(undefined) },
      });
      expect(run.code, run.stderr).toBe(EXIT_CODE.problem);
      expect(run.stderr).toContain('--sandbox docker: Docker is not reachable');
      expect(existsSync(path.join(cwd, 'start.json'))).toBe(false);
    });
  });

  it('refuses a sandbox it does not know as a usage error, with nothing forked', async () => {
    const cwd = await runtimeProject();
    const { run } = await dev(cwd, { argv: ['--sandbox', 'podman'] });
    expect(run.code).toBe(EXIT_CODE.usage);
    expect(run.stderr).toContain('--sandbox must be one of local, docker');
    expect(existsSync(path.join(cwd, 'start.json'))).toBe(false);
  });

  it('on a terminal with no key, refuses an unknown sandbox before asking for a key', async () => {
    const cwd = await runtimeProject();
    const { run } = await dev(cwd, {
      argv: ['--sandbox', 'podman'],
      tty: { pasted: ANTHROPIC_KEY },
    });
    expect(run.code).toBe(EXIT_CODE.usage);
    expect(run.stderr).toContain('--sandbox must be one of local, docker');
    expect(run.stdout).not.toContain('paste a key');
  });

  it('leaves the default alone: no flag sends no driver and a plain agent draws no warning', async () => {
    const cwd = await projectWithAgent();
    const { run } = await dev(cwd, { route: agentsRoute, until: synced });
    expect(run.code, run.stderr).toBe(EXIT_CODE.interrupted);
    expect(await startedDriver(cwd)).toBeUndefined();
    expect(run.stderr).not.toContain('no sandbox');
  });

  it('warns once per start about an agent that can run commands, not again on a save', async () => {
    const cwd = await projectWithAgent();
    await writeFile(
      path.join(cwd, 'agents/assistant.ts'),
      `${DEFINE}export default defineAgent({ name: 'assistant', instructions: 'Help people.', permissions: { runCommands: true } });\n`,
    );
    let saved = false;
    const { run } = await dev(cwd, {
      route: agentsRoute,
      until: ({ stdout }) => {
        if (!saved && stdout.includes('synced: ')) {
          saved = true;
          void appendFile(path.join(cwd, 'agents/assistant.ts'), '// saved again\n');
        }
        return saved && (stdout.match(/synced: /gu) ?? []).length >= 2;
      },
    });
    expect(run.code, run.stderr).toBe(EXIT_CODE.interrupted);
    expect(run.stderr.split('\n').filter((line) => line.includes(WARNING))).toEqual([
      `warning: assistant ${WARNING}: commands run as you, with your files, network and environment`,
    ]);
  });
});

describe('aw dev status and aw dev stop (BH061-005, BH061-045)', () => {
  async function withRecord(pid: number): Promise<string> {
    const cwd = await project();
    await mkdir(path.join(cwd, '.aw'), { recursive: true });
    await writeFile(path.join(cwd, '.aw', 'runtime.json'), JSON.stringify({ port: 3100, pid }));
    return cwd;
  }

  it('reports a ready aw dev with its URL, as text and as JSON', async () => {
    const cwd = await withRecord(process.pid);
    const text = await runCli(['dev', 'status'], { cwd });
    expect(text.code).toBe(EXIT_CODE.ok);
    expect(text.stdout).toBe(
      `aw dev is running at http://127.0.0.1:3100 (pid ${String(process.pid)})\n`,
    );
    const machine = await runCli(['dev', 'status', '--json'], { cwd });
    expect(JSON.parse(machine.stdout)).toEqual({
      running: true,
      url: 'http://127.0.0.1:3100',
      port: 3100,
      pid: process.pid,
    });
  });

  it('refuses status and stop when no aw dev is running, so a script can wait on it', async () => {
    const cwd = await project();
    for (const verb of ['status', 'stop']) {
      const run = await runCli(['dev', verb], { cwd });
      expect(run.code).toBe(EXIT_CODE.problem);
      expect(run.stderr).toContain('aw dev is not running in this project');
    }
  });

  it('stops the recorded aw dev and waits until it is gone', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
    });
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    try {
      const cwd = await withRecord(child.pid ?? 0);
      const run = await runCli(['dev', 'stop'], { cwd });
      expect(run.stdout).toBe('aw dev stopped\n');
      expect(run.code).toBe(EXIT_CODE.ok);
      await exited;
    } finally {
      child.kill();
    }
  });
});

describe('aw dev --port and PORT (BH061-012)', () => {
  async function startedPort(cwd: string): Promise<number> {
    const start = LocalRuntimeStartMessageSchema.parse(
      JSON.parse(await readFile(path.join(cwd, 'start.json'), 'utf8')),
    );
    return start.environment.port;
  }

  /** A runtime that answers ready on the port it was started on. */
  const onItsPort = fakeRuntime(
    `await send({ ...${JSON.stringify(READY)}, url: 'http://127.0.0.1:' + start.environment.port });
${sends(CREDENTIAL)}`,
  );

  it('starts the runtime on --port, which wins over PORT', async () => {
    const cwd = await project({ script: onItsPort });
    const { run } = await dev(cwd, {
      argv: ['--port', '3300'],
      env: { PORT: '3301' },
      until: signedIn,
    });
    expect(run.code, run.stderr).toBe(EXIT_CODE.interrupted);
    expect(await startedPort(cwd)).toBe(3300);
  });

  it('starts the runtime on PORT from its environment', async () => {
    const cwd = await project({ script: onItsPort });
    const { run } = await dev(cwd, { env: { PORT: '3301' }, until: signedIn });
    expect(run.code, run.stderr).toBe(EXIT_CODE.interrupted);
    expect(await startedPort(cwd)).toBe(3301);
  });

  it.each([
    ['--port', 'abc'],
    ['--port', '4000'],
    ['--port', '70000'],
  ])('refuses %s %s before anything starts', async (flag, value) => {
    const cwd = await project({ script: fakeRuntime(sends(READY, CREDENTIAL)) });
    const { run } = await dev(cwd, { argv: [flag, value] });
    expect(run.code).toBe(EXIT_CODE.usage);
    expect(run.stderr).toContain('--port must be a port from 1 to 65535');
    expect(existsSync(path.join(cwd, 'start.json'))).toBe(false);
  });
});
