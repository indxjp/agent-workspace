import { rm } from 'node:fs/promises';

import {
  RuntimeConnectionResourceSchema,
  RuntimeProfileResourceSchema,
} from '@indx-workspace/contracts/runtimes';
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

describe('aw runtimes profiles', () => {
  it('list, get, create from a file, update and remove', async () => {
    const list = await runCli(['runtimes', 'profiles', 'list', '--json'], {
      route: () => json(200, { runtimeProfiles: [FIXTURES.runtimeProfile] }),
    });
    expect(RuntimeProfileResourceSchema.array().parse(stdoutJson(list))).toEqual([
      FIXTURES.runtimeProfile,
    ]);

    const get = await runCli(['runtimes', 'profiles', 'get', 'rp-1'], {
      route: () => json(200, FIXTURES.runtimeProfile),
    });
    expect(get.stdout).toContain('allowedDomains       ["api.anthropic.com"]');

    const body = await tempFile(
      directory,
      'profile.json',
      JSON.stringify({
        name: 'docker-small',
        driver: 'docker',
        networkPolicy: 'restricted',
        filesystem: 'read-write',
        memoryMb: 1024,
      }),
    );
    const create = await runCli(['runtimes', 'profiles', 'create', '--file', body], {
      route: () => json(201, FIXTURES.runtimeProfile),
    });
    expect(create.code).toBe(EXIT_CODE.ok);
    expect(create.calls[0]?.json).toEqual({
      name: 'docker-small',
      driver: 'docker',
      networkPolicy: 'restricted',
      filesystem: 'read-write',
      memoryMb: 1024,
    });

    const update = await runCli(
      ['runtimes', 'profiles', 'update', 'rp-1', '--name', 'docker-medium'],
      {
        route: () => json(200, { ...FIXTURES.runtimeProfile, name: 'docker-medium' }),
      },
    );
    expect(update.calls[0]?.json).toEqual({ name: 'docker-medium' });

    const remove = await runCli(['runtimes', 'profiles', 'remove', 'rp-1'], {
      route: () => json(204, null),
    });
    expect(remove.code).toBe(EXIT_CODE.ok);
    expect(remove.calls[0]?.method).toBe('DELETE');
  });

  it('refuses a driver outside the contract before sending', async () => {
    const run = await runCli(['runtimes', 'profiles', 'create', '--file', '-'], {
      stdin: '{"name":"x","driver":"mainframe","networkPolicy":"none","filesystem":"read-only"}',
    });
    expect(run.code).toBe(EXIT_CODE.usage);
    expect(run.stderr).toContain('driver');
    expect(run.calls).toHaveLength(0);
  });
});

describe('aw runtimes connections', () => {
  it('lists and creates with the credential from stdin', async () => {
    const list = await runCli(['runtimes', 'connections', 'list', '--json'], {
      route: () => json(200, { runtimeConnections: [FIXTURES.runtimeConnection] }),
    });
    expect(RuntimeConnectionResourceSchema.array().parse(stdoutJson(list))).toHaveLength(1);
    const body = await tempFile(
      directory,
      'connection.json',
      '{"driver":"docker","endpoint":"tcp://docker:2376"}',
    );
    const create = await runCli(
      ['runtimes', 'connections', 'create', '--file', body, '--name', 'primary', '--value-stdin'],
      {
        stdin: 'cert-bundle',
        route: () => json(201, FIXTURES.runtimeConnection),
      },
    );
    expect(create.code).toBe(EXIT_CODE.ok);
    expect(create.calls[0]?.json).toEqual({
      driver: 'docker',
      endpoint: 'tcp://docker:2376',
      name: 'primary',
      credential: 'cert-bundle',
    });
  });
});
