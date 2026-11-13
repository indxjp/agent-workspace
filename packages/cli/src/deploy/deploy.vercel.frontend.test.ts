import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { PLATFORM_IMAGE_VERSION } from '../release-images.js';
import { runDeployCommand } from './command.js';
import {
  captured,
  capturedFailure,
  frontend,
  stubRunner,
  temporaryDirectory,
  type Respond,
} from './deploy.test-support.js';
import {
  platform,
  vercelEnvironment,
  vercelProject,
  vercelResponder,
} from './deploy.vercel.test-support.js';

const controlPlaneUrl = 'https://agents.acme.example/';
const deploymentUrl = 'https://acme-ai-web-k3j2h1g-acme.vercel.app';
const origin = 'https://acme-ai-web.vercel.app';

/** The frontend's `vercel deploy` prints its deployment URL; `vercel inspect` answers `inspected`. */
const frontendResponder =
  (listed: readonly string[], inspected: string, deployed = deploymentUrl): Respond =>
  (invocation) => {
    if (invocation.args[0] === 'inspect') return { stdout: inspected };
    if (invocation.args[0] === 'deploy' && invocation.env['VERCEL_PROJECT_ID'] === 'acme-ai-web') {
      return { stdout: `${deployed}\n` };
    }
    return vercelResponder(true, listed)(invocation);
  };
const inspectedAs = (url: string) =>
  `General\n  ID  dpl_1\n  Name  acme-ai-web\n  URL  ${deploymentUrl}\n\n  Aliases\n    ╶ ${url}\n`;
const withFrontend = async (respond: Respond) => {
  const target = await vercelProject();
  const web = await frontend();
  const { runner, calls } = stubRunner(respond);
  const { output } = await captured(() =>
    runDeployCommand([target, '--yes'], {
      runner,
      environment: {
        ...vercelEnvironment,
        AGENT_WORKSPACE_FRONTEND: web,
        CONTROL_PLANE_URL: controlPlaneUrl,
      },
    }),
  );
  const originAdds = calls.filter(
    ({ args }) => args[1] === 'add' && args[2] === 'AW_FRONTEND_ORIGIN',
  );
  return { calls, output, originAdds };
};

function originListedCase(): void {
  it('lists its own origin in the control plane once Vercel names it for the deployment', async () => {
    const { calls, output, originAdds } = await withFrontend(
      frontendResponder([], inspectedAs(origin)),
    );

    const steps = calls.flatMap(({ args, env }) =>
      args[0] === 'deploy' ||
      args[0] === 'inspect' ||
      (args[1] === 'add' && args[2] === 'AW_FRONTEND_ORIGIN')
        ? [
            `${args[0] === 'env' ? 'add-origin' : String(args[0])}:${env['VERCEL_PROJECT_ID'] ?? ''}`,
          ]
        : [],
    );
    expect(steps).toEqual([
      'deploy:acme-ai-gateway',
      'deploy:acme-ai-manager',
      'deploy:acme-ai-web',
      'inspect:acme-ai-web',
      'add-origin:acme-ai',
      'deploy:acme-ai',
    ]);
    expect(calls.find(({ args }) => args[0] === 'inspect')?.args).toEqual([
      'inspect',
      deploymentUrl,
      '--scope',
      'team_acme',
    ]);
    expect(originAdds).toHaveLength(1);
    expect(originAdds[0]?.args).toEqual([
      'env',
      'add',
      'AW_FRONTEND_ORIGIN',
      'production',
      '--no-sensitive',
      '--yes',
      '--scope',
      'team_acme',
    ]);
    expect(originAdds[0]?.input).toBe(origin);
    expect(calls.some(({ args }) => args.join(' ').includes(origin))).toBe(false);
    expect(output).not.toContain('did not list');
  });
}

function originNotListedCases(): void {
  it('leaves an origin already set as it is on a re-deploy', async () => {
    const { originAdds } = await withFrontend(
      frontendResponder(['AW_FRONTEND_ORIGIN'], inspectedAs(origin)),
    );

    expect(originAdds).toEqual([]);
  });

  it.each([
    ['a domain that is not the project’s', inspectedAs('https://acme-ai-web.example.com')],
    ['a look-alike of the project’s domain', inspectedAs(`${origin}.evil.example`)],
    ['nothing', ''],
  ])('writes no origin when Vercel names %s, and says to list it by hand', async (_name, text) => {
    const { calls, output, originAdds } = await withFrontend(frontendResponder([], text));

    expect(originAdds).toEqual([]);
    expect(output).toContain(`Vercel did not list ${origin}`);
    expect(output).toContain(`AW_FRONTEND_ORIGIN=${origin}`);
    expect(calls.filter(({ args }) => args[0] === 'deploy')).toHaveLength(4);
  });

  it('writes no origin when inspect fails', async () => {
    const respond = frontendResponder([], inspectedAs(origin));
    const { originAdds, output } = await withFrontend((invocation) =>
      invocation.args[0] === 'inspect'
        ? { status: 1, stdout: inspectedAs(origin), stderr: 'Error: not found' }
        : respond(invocation),
    );

    expect(originAdds).toEqual([]);
    expect(output).toContain('did not list');
  });
}

function inspectUrlCases(): void {
  it.each([
    ['not a URL', 'Deploying acme-ai-web'],
    ['not on vercel.app', 'https://acme-ai-web.example.com'],
    ['carrying credentials', 'https://user:pw@acme-ai-web-k3j2h1g.vercel.app'],
    ['with a path', 'https://acme-ai-web-k3j2h1g.vercel.app/x'],
  ])('does not inspect a deployment URL that is %s', async (_name, deployed) => {
    const { calls, originAdds } = await withFrontend(
      frontendResponder([], inspectedAs(origin), deployed),
    );

    expect(calls.some(({ args }) => args[0] === 'inspect')).toBe(false);
    expect(originAdds).toEqual([]);
  });
}

function frontendDeployCase(): void {
  it('deploys it before the control plane, as its own project wired to the control plane', async () => {
    const target = await vercelProject();
    const web = await frontend();
    const { runner, calls } = stubRunner(vercelResponder(false));

    await captured(() =>
      runDeployCommand([target, '--yes'], {
        runner,
        environment: {
          ...vercelEnvironment,
          AGENT_WORKSPACE_FRONTEND: web,
          CONTROL_PLANE_URL: controlPlaneUrl,
        },
      }),
    );

    const added = calls.find(({ args }) => args[1] === 'add' && args[2] === 'VITE_AW_BASE_URL');
    expect(added?.args).toEqual([
      'env',
      'add',
      'VITE_AW_BASE_URL',
      'production',
      '--no-sensitive',
      '--yes',
      '--scope',
      'team_acme',
    ]);
    expect(added?.input).toBe('https://agents.acme.example');
    expect(added?.env['VERCEL_PROJECT_ID']).toBe('acme-ai-web');
    const last = calls.find(
      ({ args, env }) => args[0] === 'deploy' && env['VERCEL_PROJECT_ID'] === 'acme-ai-web',
    );
    expect(calls.at(-1)?.env['VERCEL_PROJECT_ID']).toBe('acme-ai');
    expect(last?.args).toEqual([
      'deploy',
      '--cwd',
      String(last?.args[2]),
      '--archive=tgz',
      '--prod',
      '--yes',
      '--scope',
      'team_acme',
      '--local-config',
      path.join(target, 'deploy', 'vercel', 'frontend.json'),
    ]);
    expect(last?.args[2]).not.toBe(web);
    expect(last?.env['VERCEL_PROJECT_ID']).toBe('acme-ai-web');
    expect(calls.filter(({ args }) => args[0] === 'deploy')).toHaveLength(4);
  });
}

function refusalAndAbsenceCases(): void {
  it.each([
    ['CONTROL_PLANE_URL', true],
    ['AGENT_WORKSPACE_FRONTEND', false],
  ])('refuses by name when %s is missing or wrong, before any tool runs', async (name, found) => {
    const target = await vercelProject();
    const web = found ? await frontend() : path.join(platform, 'no-such-web');
    const { runner, calls } = stubRunner(vercelResponder(false));

    const { message } = await capturedFailure(() =>
      runDeployCommand([target, '--yes'], {
        runner,
        environment: { ...vercelEnvironment, AGENT_WORKSPACE_FRONTEND: web },
      }),
    );

    expect(message).toContain(name);
    expect(message).toContain('Nothing was run');
    expect(calls).toEqual([]);
  });

  it('deploys no frontend when the project has none', async () => {
    const target = await vercelProject();
    const { runner, calls } = stubRunner(vercelResponder(false));

    await captured(() =>
      runDeployCommand([target, '--yes'], { runner, environment: vercelEnvironment }),
    );

    expect(calls.some(({ env }) => env['VERCEL_PROJECT_ID'] === 'acme-ai-web')).toBe(false);
    expect(calls.some(({ args }) => args[0] === 'inspect')).toBe(false);
    expect(calls.some(({ args }) => args[2] === 'AW_FRONTEND_ORIGIN')).toBe(false);
  });
}

describe('agent-workspace deploy to Vercel', () => {
  describe('with a frontend', () => {
    originListedCase();
    originNotListedCases();
    inspectUrlCases();
    frontendDeployCase();
    refusalAndAbsenceCases();
  });

  describe('the checkout and the images are one release', () => {
    const writeManifest = async (source: string, version: string) => {
      await mkdir(path.join(source, 'packages', 'cli', 'src'), { recursive: true });
      await writeFile(
        path.join(source, 'packages', 'cli', 'src', 'release-images.json'),
        JSON.stringify({ version }),
      );
    };
    const refused = async (change: (target: string, source: string) => Promise<void>) => {
      const target = await vercelProject();
      const source = await temporaryDirectory();
      await mkdir(path.join(source, 'apps', 'web'), { recursive: true });
      await change(target, source);
      const { runner, calls } = stubRunner(vercelResponder(false));
      const failure = await capturedFailure(() =>
        runDeployCommand([target, '--yes'], {
          runner,
          environment: { ...vercelEnvironment, AGENT_WORKSPACE_SOURCE: source },
        }),
      );
      expect(calls).toEqual([]);
      return failure.message;
    };

    it('refuses a checkout at another release, naming both versions, before any tool runs', async () => {
      const message = await refused((_target, source) => writeManifest(source, '9.9.9'));
      expect(message).toContain('9.9.9');
      expect(message).toContain(PLATFORM_IMAGE_VERSION);
      expect(message).toContain('AGENT_WORKSPACE_VERSION');
      expect(message).toContain('Nothing was run');
    });

    it('refuses a checkout that has no release manifest', async () => {
      const message = await refused(() => Promise.resolve());
      expect(message).toContain('release-images.json');
    });

    it('refuses a .env that does not say which release its images are', async () => {
      const message = await refused(async (target, source) => {
        await writeManifest(source, PLATFORM_IMAGE_VERSION);
        const file = path.join(target, '.env');
        const text = await readFile(file, 'utf8');
        await writeFile(
          file,
          text.replace(/\nAGENT_WORKSPACE_VERSION=[^\n]*\n/u, '\nAGENT_WORKSPACE_VERSION=\n'),
        );
      });
      expect(message).toContain('AGENT_WORKSPACE_VERSION is empty');
    });
  });
});
