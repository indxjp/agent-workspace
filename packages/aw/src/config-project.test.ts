import { describe, expect, it } from 'vitest';

import { emptyHome, homeWithProfiles, resolve } from './config.fixture.test-support.js';
import { fixtures, resolveProjectConfig } from './config-project.test-support.js';
import { UsageError } from './io.js';

describe('resolveConfig: the project step (issue #451)', () => {
  it('ranks a flag over the environment over the project over the default profile', async () => {
    const { projectDefault, noProject } = fixtures;
    const key = { AGENT_WORKSPACE_API_KEY: 'env-key' };
    const withUrl = { ...key, AGENT_WORKSPACE_URL: 'https://env.example.com' };
    expect(
      await resolveProjectConfig({
        argv: ['--url', 'https://flag.example.com'],
        env: withUrl,
        cwd: projectDefault,
      }),
    ).toMatchObject({ url: 'https://flag.example.com' });
    expect(await resolveProjectConfig({ env: withUrl, cwd: projectDefault })).toMatchObject({
      url: 'https://env.example.com',
    });
    expect(
      await resolveProjectConfig({
        argv: ['--api-key-stdin'],
        env: key,
        stdin: 'k',
        cwd: projectDefault,
      }),
    ).toMatchObject({ url: 'http://127.0.0.1:3000' });
    expect(await resolveProjectConfig({ env: key, cwd: noProject })).toMatchObject({
      url: 'https://default.example.com',
    });
    // A profile named on the command line still outranks the project.
    expect(
      await resolveProjectConfig({
        argv: ['--profile', 'staging'],
        env: { STAGING_KEY: 's' },
        cwd: projectDefault,
      }),
    ).toMatchObject({ url: 'https://staging.example.com', apiKey: 's' });
  });

  it("honours the project's port and defaults to 3000", async () => {
    const stdin = ['--api-key-stdin'];
    expect(
      (
        await resolveProjectConfig({
          argv: stdin,
          homeDir: emptyHome,
          stdin: 'k',
          cwd: fixtures.projectPort,
        })
      ).url,
    ).toBe('http://127.0.0.1:4123');
    expect(
      (
        await resolveProjectConfig({
          argv: stdin,
          homeDir: emptyHome,
          stdin: 'k',
          cwd: fixtures.projectDefault,
        })
      ).url,
    ).toBe('http://127.0.0.1:3000');
  });

  it('takes nothing from a lifted v1 profile, or without a directory', async () => {
    const key = { AGENT_WORKSPACE_API_KEY: 'env-key' };
    expect((await resolveProjectConfig({ env: key, cwd: fixtures.projectV1 })).url).toBe(
      'https://default.example.com',
    );
    expect((await resolve({ argv: [], env: key, homeDir: homeWithProfiles })).url).toBe(
      'https://default.example.com',
    );
    await expect(
      resolveProjectConfig({ env: key, homeDir: emptyHome, cwd: fixtures.projectV1 }),
    ).rejects.toThrow(/no control plane URL/u);
  });

  it('refuses a malformed project file with its line and column', async () => {
    const failure = resolveProjectConfig({
      env: { AGENT_WORKSPACE_API_KEY: 'k' },
      homeDir: emptyHome,
      cwd: fixtures.projectBroken,
    });
    await expect(failure).rejects.toBeInstanceOf(UsageError);
    await expect(failure).rejects.toThrow(/^agent-workspace\.yaml:\d+:\d+: /u);
  });

  it('reads the project file only when every earlier source is empty', async () => {
    const env = { AGENT_WORKSPACE_URL: 'https://env.example.com', AGENT_WORKSPACE_API_KEY: 'k' };
    expect(
      (await resolveProjectConfig({ env, homeDir: emptyHome, cwd: fixtures.projectBroken })).url,
    ).toBe('https://env.example.com');
  });
});
