import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { LocalRuntimeStartMessageSchema } from '@indx-workspace/contracts/local-runtime';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { EXIT_CODE } from '../output.js';
import { FIXTURES, tempFile, type CliRun } from '../testing.js';
import {
  ANTHROPIC_KEY,
  READY,
  DEV_ISSUER,
  CREDENTIAL,
  sends,
  fakeRuntime,
  project,
  filesUnder,
  type DevRun,
  dev,
  ENV_AGENT,
  forkedEnv,
  synced,
  syncSaid,
} from './dev.test-support.js';
import {
  modelConnections,
  projectWithAgentAnd,
  workspaceRoute,
  yamlWith,
  DEFAULT_MODEL_YAML,
  GITHUB_YAML,
} from './dev.routes.test-support.js';

describe('aw dev applies the project file (issue #547): creates models.default', () => {
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
});

describe('aw dev applies the project file (issue #547): withholds connector secrets', () => {
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
});

describe('aw dev applies the project file (issue #547): rotates credentials and says unset variables', () => {
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
});

describe('aw dev applies the project file (issue #547): refuses provider changes and sends policy', () => {
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
      devIssuer: DEV_ISSUER,
    });
  });
});

describe('aw dev applies the project file (issue #547): sends secret names in start', () => {
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
});
