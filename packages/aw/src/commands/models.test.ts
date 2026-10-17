import {
  DeleteModelConnectionResponseSchema,
  DiscoveredModelsResponseSchema,
  ModelConnectionResourceSchema,
  ModelConnectionTestOutcomeSchema,
} from '@indx-workspace/contracts/models';
import { rm } from 'node:fs/promises';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { EXIT_CODE } from '../output.js';
import { FIXTURES, IDS, json, runCli, stdoutJson, tempDirectory, tempFile } from '../testing.js';

let directory: string;

beforeAll(async () => {
  directory = await tempDirectory();
});

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe('aw models connections', () => {
  it('list and get round-trip through the contract', async () => {
    const list = await runCli(['models', 'connections', 'list', '--json'], {
      route: () => json(200, { models: [FIXTURES.modelConnection] }),
    });
    expect(ModelConnectionResourceSchema.array().parse(stdoutJson(list))).toEqual([
      FIXTURES.modelConnection,
    ]);
    const get = await runCli(['models', 'connections', 'get', IDS.connection], {
      route: () => json(200, FIXTURES.modelConnection),
    });
    expect(get.stdout).toContain('provider       anthropic');
  });

  it('create takes the credential from --value-stdin and the rest from a file', async () => {
    const body = await tempFile(directory, 'connection.json', '{"provider":"anthropic"}');
    const created = await runCli(
      [
        'models',
        'connections',
        'create',
        '--file',
        body,
        '--name',
        'anthropic',
        '--value-stdin',
        '--json',
      ],
      { stdin: 'sk-secret\n', route: () => json(201, FIXTURES.modelConnection) },
    );
    expect(created.code).toBe(EXIT_CODE.ok);
    expect(created.calls[0]?.json).toEqual({
      provider: 'anthropic',
      name: 'anthropic',
      apiKey: 'sk-secret',
    });
    expect(ModelConnectionResourceSchema.parse(stdoutJson(created))).toEqual(
      FIXTURES.modelConnection,
    );

    // `--file -` and `--value-stdin` cannot share stdin.
    const clash = await runCli(
      ['models', 'connections', 'create', '--file', '-', '--value-stdin'],
      { stdin: 'x' },
    );
    expect(clash.code).toBe(EXIT_CODE.usage);
    expect(clash.stderr).toContain('read only once');

    // `provider` missing: refused before any request, naming the field.
    const incomplete = await runCli(
      ['models', 'connections', 'create', '--name', 'anthropic', '--value-stdin'],
      {
        stdin: 'sk-secret\n',
      },
    );
    expect(incomplete.code).toBe(EXIT_CODE.usage);
    expect(incomplete.stderr).toContain('provider');
    expect(incomplete.calls).toHaveLength(0);
  });

  it('update, remove, rotate-credential and test', async () => {
    const update = await runCli(
      ['models', 'connections', 'update', IDS.connection, '--name', 'main'],
      {
        route: () => json(200, { ...FIXTURES.modelConnection, name: 'main' }),
      },
    );
    expect(update.calls[0]?.json).toEqual({ name: 'main' });

    const removed = {
      deleted: true,
      referencedBy: [{ agentId: IDS.agent, agentName: 'Summariser' }],
    };
    const remove = await runCli(['models', 'connections', 'remove', IDS.connection, '--json'], {
      route: () => json(200, removed),
    });
    expect(DeleteModelConnectionResponseSchema.parse(stdoutJson(remove))).toEqual(removed);

    const rotate = await runCli(
      ['models', 'connections', 'rotate-credential', IDS.connection, '--value-stdin'],
      {
        stdin: 'sk-new\n',
        route: () => json(204, null),
      },
    );
    expect(rotate.code).toBe(EXIT_CODE.ok);
    expect(rotate.calls[0]?.url.pathname).toBe(
      `/api/model-connections/${IDS.connection}/credential`,
    );
    expect(rotate.calls[0]?.json).toEqual({ apiKey: 'sk-new' });
    const rotateWithout = await runCli([
      'models',
      'connections',
      'rotate-credential',
      IDS.connection,
    ]);
    expect(rotateWithout.code).toBe(EXIT_CODE.usage);

    const outcome = { ok: false, status: null, latencyMs: 12, message: 'Unreachable.' };
    const test = await runCli(['models', 'connections', 'test', IDS.connection, '--json'], {
      route: () => json(502, outcome),
    });
    expect(test.code).toBe(EXIT_CODE.ok);
    expect(ModelConnectionTestOutcomeSchema.parse(stdoutJson(test))).toEqual(outcome);
  });

  it('discover prints models as a table and names unavailable connections on stderr', async () => {
    const body = {
      models: [FIXTURES.discoveredModel],
      unavailable: [{ connectionId: 'x', connectionName: 'broken', reason: 'timeout' }],
    };
    const human = await runCli(['models', 'discover'], { route: () => json(200, body) });
    expect(human.stdout).toContain('claude-x');
    expect(human.stderr).toContain('unavailable: broken (timeout)');
    const structured = await runCli(['models', 'discover', '--json'], {
      route: () => json(200, body),
    });
    expect(DiscoveredModelsResponseSchema.parse(stdoutJson(structured))).toEqual(body);
  });
});
