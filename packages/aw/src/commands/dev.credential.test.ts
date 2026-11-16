import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { stripVTControlCharacters } from 'node:util';

import { LocalRuntimeStartMessageSchema } from '@indx-workspace/contracts/local-runtime';
import { describe, expect, it } from 'vitest';

import { keyShell, missingKeyLines } from '../local-runtime/environment.js';
import { localCredentialsFilePath } from '../local-runtime/local-credentials.js';
import { EXIT_CODE } from '../output.js';
import { FIXTURES, json, tempFile, type Route } from '../testing.js';
import {
  TOKEN,
  WORKSPACE_ID,
  ANTHROPIC_KEY,
  PROJECT_URL,
  DEFINE,
  READY,
  DEV_ISSUER,
  CREDENTIAL,
  sends,
  fakeRuntime,
  project,
  filesUnder,
  dev,
  signedIn,
} from './dev.test-support.js';
import { modelConnections } from './dev.routes.test-support.js';

describe('aw dev (issue #451): signs in', () => {
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
        // Issue #2075: no OIDC_* is set, so aw dev runs its development issuer.
        devIssuer: DEV_ISSUER,
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
});

describe('aw dev (issue #451): creates the default model connection', () => {
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
});

describe('aw dev (issue #451): reports a rejected key', () => {
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
});

describe('aw dev (issue #451): serves scripted models', () => {
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
});

describe('aw dev (issue #451): offers the key menu', () => {
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
});

describe('aw dev (issue #451): takes the menu choices', () => {
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
});

describe('aw dev (issue #451): stays quiet and keeps stored keys', () => {
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
});
