import { describe, expect, it } from 'vitest';

import { parseArguments } from './args.js';
import { resolveConfig } from './config.js';
import { resolve } from './config.fixture.test-support.js';
import { fixtures, LOCAL_URL, resolveProjectConfig, TOKEN } from './config-project.test-support.js';

describe('resolveConfig: which credential reaches the project URL', () => {
  const NO_LOCAL_CREDENTIAL = /no credential for this project's local runtime/u;

  it('falls back to the stored sign-in, not another key, when --api-key-stdin reads a blank stdin', async () => {
    // docs/10-product/sdk/04-api-specification.md §7.1 documents this order (issue #485).
    const env = {
      AGENT_WORKSPACE_URL: LOCAL_URL,
      AGENT_WORKSPACE_API_KEY: 'env-key',
      DEFAULT_KEY: 'profile-key',
    };
    expect(
      await resolve({
        argv: ['--api-key-stdin'],
        env,
        homeDir: fixtures.homeWithToken,
        stdin: ' \n',
      }),
    ).toMatchObject({ url: LOCAL_URL, apiKey: undefined, token: TOKEN });
  });

  it("never sends the default profile's key to the project URL", async () => {
    await expect(
      resolveProjectConfig({
        env: { DEFAULT_KEY: 'production-key' },
        cwd: fixtures.projectDefault,
      }),
    ).rejects.toThrow(NO_LOCAL_CREDENTIAL);
    // A key piped on stdin still reaches it.
    expect(
      await resolveProjectConfig({
        argv: ['--api-key-stdin'],
        env: { DEFAULT_KEY: 'production-key' },
        stdin: 'stdin-key\n',
        cwd: fixtures.projectDefault,
      }),
    ).toMatchObject({ apiKey: 'stdin-key' });
  });

  it('never sends AGENT_WORKSPACE_API_KEY to the project URL', async () => {
    const { projectDefault, homeWithToken } = fixtures;
    const env = { DEFAULT_KEY: 'production-key', AGENT_WORKSPACE_API_KEY: 'env-production-key' };
    await expect(resolveProjectConfig({ env, cwd: projectDefault })).rejects.toThrow(
      NO_LOCAL_CREDENTIAL,
    );
    expect(
      await resolveProjectConfig({ env, homeDir: homeWithToken, cwd: projectDefault }),
    ).toMatchObject({ url: LOCAL_URL, apiKey: undefined, token: TOKEN });
    // Paired with an explicit URL, the environment key is used as before.
    expect(
      await resolveProjectConfig({
        env: { ...env, AGENT_WORKSPACE_URL: 'https://env.example.com' },
        cwd: projectDefault,
      }),
    ).toMatchObject({ url: 'https://env.example.com', apiKey: 'env-production-key' });
  });

  it('says why AGENT_WORKSPACE_API_KEY is not in force inside a project (BH061-022)', async () => {
    const config = await resolveConfig({
      args: parseArguments([]),
      env: { AGENT_WORKSPACE_API_KEY: 'env-production-key' },
      homeDir: fixtures.homeWithToken,
      cwd: fixtures.projectDefault,
      readStdin: () => Promise.resolve(''),
      credentialRequired: true,
    });
    expect(config.credential.kind).toBe('user-token');
    expect(config.notices).toHaveLength(1);
    expect(config.notices[0]).toMatch(
      /AGENT_WORKSPACE_API_KEY is not sent .* set AGENT_WORKSPACE_URL/u,
    );
  });

  it('uses the credential stored for the project URL, not the default profile key', async () => {
    expect(
      await resolveProjectConfig({
        env: { DEFAULT_KEY: 'production-key' },
        homeDir: fixtures.homeWithToken,
        cwd: fixtures.projectDefault,
      }),
    ).toMatchObject({ url: LOCAL_URL, apiKey: undefined, token: TOKEN });
  });
});
