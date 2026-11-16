import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, vi, type MockInstance } from 'vitest';

import {
  type ComposeUp,
  type DockerCommand,
  type DockerContextInspector,
  type HostPortProbe,
} from './deployment.js';

const childProcess = vi.hoisted(() => ({ spawn: vi.fn(), spawnSync: vi.fn() }));

vi.mock('node:child_process', () => childProcess);

const ref = (name: string, digit: string) => `registry.example/${name}@sha256:${digit.repeat(64)}`;

const pins = [
  `WEB_IMAGE=${ref('web', '1')}`,
  `GATEWAY_IMAGE=${ref('gateway', '2')}`,
  `RUNNER_IMAGE=${ref('runner', '3')}`,
  `RUNTIME_IMAGE=${ref('runtime', '4')}`,
  `POSTGRES_IMAGE=${ref('postgres', '5')}`,
  `SEAWEEDFS_IMAGE=${ref('seaweedfs', '6')}`,
  'RUNTIME_DRIVER=docker',
];

const noContext: DockerContextInspector = () => ({ status: 1, stdout: '' });
/** Never bind a real port here: the suite's host may run anything on 3000. */
const freePort: HostPortProbe = () => Promise.resolve(true);
const upWith = (status: number, stderr = '') =>
  vi.fn<ComposeUp>(() => Promise.resolve({ status, stderr }));
/** A daemon whose socket group is `groupId`, and whose other answers are `status`. */
const daemon = (groupId: string | undefined, status = 0) =>
  vi.fn<DockerCommand>((argv) =>
    argv[0] === 'run'
      ? { status: groupId === undefined ? 1 : 0, stdout: groupId ?? '' }
      : { status, stdout: '' },
  );

export function startFixture() {
  let directory = '';
  let stdout: MockInstance<typeof process.stdout.write>;
  const shellDockerHost = process.env['DOCKER_HOST'];
  const writeEnvironment = (...lines: string[]) =>
    writeFile(path.join(directory, '.env'), [...pins, ...lines, ''].join('\n'));
  const outputOf = () => stdout.mock.calls.map(([chunk]) => String(chunk)).join('');

  beforeEach(async () => {
    delete process.env['DOCKER_HOST'];
    childProcess.spawnSync.mockReset();
    childProcess.spawnSync.mockReturnValue({ status: 1, stdout: '' });
    childProcess.spawn.mockReset();
    childProcess.spawn.mockImplementation(() => ({
      stderr: { on: vi.fn() },
      once(event: string, listener: (code: number) => void) {
        if (event === 'close') queueMicrotask(() => listener(0));
      },
    }));
    stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    directory = await mkdtemp(path.join(tmpdir(), 'aw-start-'));
  });

  afterEach(async () => {
    stdout.mockRestore();
    if (shellDockerHost !== undefined) process.env['DOCKER_HOST'] = shellDockerHost;
    await rm(directory, { recursive: true, force: true });
  });

  return {
    get directory() {
      return directory;
    },
    pins,
    writeEnvironment,
    noContext,
    freePort,
    upWith,
    daemon,
    outputOf,
  };
}

export { childProcess };
