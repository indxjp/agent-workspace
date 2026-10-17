import { rm } from 'node:fs/promises';

import {
  ConnectorResourceSchema,
  TestConnectionOutcomeSchema,
} from '@indx-workspace/contracts/connectors';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { EXIT_CODE } from '../output.js';
import { FIXTURES, json, runCli, stdoutJson, tempDirectory, tempFile } from '../testing.js';

let directory: string;

beforeAll(async () => {
  directory = await tempDirectory();
});

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

const OK = {
  ok: true,
  kind: 'ok',
  message: 'Connected.',
  serverName: 'github',
  serverVersion: '1.0',
  toolCount: 4,
};

describe('aw connectors', () => {
  it('list and get round-trip through the contract', async () => {
    const list = await runCli(['connectors', 'list', '--json'], {
      route: () => json(200, { connectors: [FIXTURES.connector] }),
    });
    expect(ConnectorResourceSchema.array().parse(stdoutJson(list))).toEqual([FIXTURES.connector]);
    const get = await runCli(['connectors', 'get', 'c-1'], {
      route: () => json(200, FIXTURES.connector),
    });
    expect(get.stdout).toMatch(/^transport\s+http$/mu);
  });

  it('create and test-draft send the same body, with the credential from stdin and dryRun on the draft', async () => {
    const body = await tempFile(
      directory,
      'connector.json',
      '{"transport":"http","url":"https://mcp.example.com","authType":"bearer"}',
    );
    const create = await runCli(
      ['connectors', 'create', '--file', body, '--name', 'github', '--value-stdin', '--json'],
      {
        stdin: 'tok\n',
        route: () => json(201, FIXTURES.connector),
      },
    );
    expect(create.code).toBe(EXIT_CODE.ok);
    expect(create.calls[0]?.json).toEqual({
      name: 'github',
      transport: 'http',
      url: 'https://mcp.example.com',
      authType: 'bearer',
      credential: 'tok',
    });
    expect(ConnectorResourceSchema.parse(stdoutJson(create))).toEqual(FIXTURES.connector);

    const draft = await runCli(
      ['connectors', 'test-draft', '--file', body, '--name', 'github', '--value-stdin', '--json'],
      {
        stdin: 'tok',
        route: () => json(200, OK),
      },
    );
    expect(draft.calls[0]?.json).toMatchObject({ dryRun: true, credential: 'tok' });
    expect(TestConnectionOutcomeSchema.parse(stdoutJson(draft))).toEqual(OK);
    expect(draft.code).toBe(EXIT_CODE.ok);

    const stdioWithUrl = await runCli(['connectors', 'create', '--file', '-'], {
      stdin: '{"name":"x","transport":"stdio","url":"https://nope"}',
    });
    expect(stdioWithUrl.code).toBe(EXIT_CODE.usage);
    expect(stdioWithUrl.calls).toHaveLength(0);
  });

  it('remove, rotate-credential and test', async () => {
    const remove = await runCli(['connectors', 'remove', 'c-1'], { route: () => json(204, null) });
    expect(remove.code).toBe(EXIT_CODE.ok);
    expect(remove.calls[0]?.method).toBe('DELETE');
    const rotate = await runCli(
      ['connectors', 'rotate-credential', 'c-1', '--value-stdin', '--json'],
      {
        stdin: 'new-tok',
        route: () => json(200, FIXTURES.connector),
      },
    );
    expect(rotate.calls[0]?.method).toBe('PATCH');
    expect(rotate.calls[0]?.json).toEqual({ credential: 'new-tok' });
    expect(ConnectorResourceSchema.parse(stdoutJson(rotate))).toEqual(FIXTURES.connector);
    const failed = { ok: false, kind: 'stdio-probe-unavailable', message: 'Needs a sandbox.' };
    const test = await runCli(['connectors', 'test', 'c-1', '--json'], {
      route: () => json(200, failed),
    });
    expect(test.calls[0]?.url.pathname).toBe('/api/connectors/c-1/test-connection');
    expect(TestConnectionOutcomeSchema.parse(stdoutJson(test))).toEqual(failed);
    // BH061-067: the outcome is printed, and a failed probe is not a success.
    expect(test.code).toBe(EXIT_CODE.problem);
    const draft = await runCli(['connectors', 'test-draft', '--file', '-', '--json'], {
      stdin: '{"name":"x","transport":"stdio","command":"npx","args":["pkg@1.0.0"]}',
      route: () => json(200, failed),
    });
    expect(TestConnectionOutcomeSchema.parse(stdoutJson(draft))).toEqual(failed);
    expect(draft.code).toBe(EXIT_CODE.problem);
  });

  it('updates fields from --name and refuses a body that names the owner', async () => {
    const fromFlags = await runCli(['connectors', 'update', 'c-1', '--name', 'Renamed'], {
      route: () => json(200, FIXTURES.connector),
    });
    expect(fromFlags.code).toBe(EXIT_CODE.ok);
    expect(fromFlags.calls[0]?.method).toBe('PATCH');
    expect(fromFlags.calls[0]?.json).toEqual({ name: 'Renamed' });

    const owner = await runCli(['connectors', 'update', 'c-1', '--file', '-'], {
      stdin: JSON.stringify({ ownerPrincipalId: 'someone-else' }),
    });
    expect(owner.code).toBe(EXIT_CODE.usage);
    expect(owner.calls).toHaveLength(0);
  });
});
