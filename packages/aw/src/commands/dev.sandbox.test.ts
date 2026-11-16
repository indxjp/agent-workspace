import { existsSync } from 'node:fs';
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { LocalRuntimeStartMessageSchema } from '@indx-workspace/contracts/local-runtime';
import { describe, expect, it } from 'vitest';

import { EXIT_CODE } from '../output.js';
import {
  ANTHROPIC_KEY,
  DEFINE,
  READY,
  CREDENTIAL,
  sends,
  fakeRuntime,
  freshDirectory,
  renderedYaml,
  project,
  dev,
  synced,
  signedIn,
} from './dev.test-support.js';
import { modelConnections, projectWithAgent, agentsRoute } from './dev.routes.test-support.js';

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

describe.skipIf(process.platform === 'win32')(
  'aw dev --sandbox (issue #786): with a docker command on PATH (start)',
  () => {
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
  },
);

describe.skipIf(process.platform === 'win32')(
  'aw dev --sandbox (issue #786): with a docker command on PATH (refusals)',
  () => {
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
  },
);

describe('aw dev --sandbox (issue #786): refuses unknown sandboxes', () => {
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
});

describe('aw dev --sandbox (issue #786): warns about unsandboxed agents', () => {
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
