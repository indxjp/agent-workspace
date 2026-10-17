import { describe, expect, it } from 'vitest';

import { CommandRefusedError } from '../io.js';

import { devSandbox, requireDocker, unsandboxedLine, type Exec } from './sandbox.js';

describe('devSandbox', () => {
  it('takes the flag over the project file, the project file alone, or nothing', () => {
    expect(devSandbox('local', 'docker')).toEqual({ driver: 'local', source: 'flag' });
    expect(devSandbox(undefined, 'docker')).toEqual({ driver: 'docker', source: 'yaml' });
    expect(devSandbox(undefined, undefined)).toBeUndefined();
  });
});

describe('requireDocker', () => {
  const answers: Exec = () => Promise.resolve('27.0.1\n');
  const fails =
    (error: Error): Exec =>
    () =>
      Promise.reject(error);

  it('probes only for the docker driver, with the given environment', async () => {
    const calls: unknown[][] = [];
    const record: Exec = (file, args, options) => {
      calls.push([file, args, options.env]);
      return Promise.resolve('');
    };
    await requireDocker(undefined, {}, record);
    await requireDocker({ driver: 'local', source: 'flag' }, {}, record);
    expect(calls).toEqual([]);
    await requireDocker({ driver: 'docker', source: 'flag' }, { A: '1', B: undefined }, record);
    expect(calls).toEqual([['docker', ['version', '--format', '{{.Server.Version}}'], { A: '1' }]]);
  });

  it('passes when the daemon answers', async () => {
    await expect(
      requireDocker({ driver: 'docker', source: 'flag' }, {}, answers),
    ).resolves.toBeUndefined();
  });

  it.each([
    ['a non-zero exit', new Error('Command failed')],
    ['no docker command', Object.assign(new Error('spawn docker ENOENT'), { code: 'ENOENT' })],
    ['a timeout', Object.assign(new Error('timed out'), { killed: true })],
  ])('refuses once, naming where docker came from, for %s', async (_name, error) => {
    const refusal = await requireDocker(
      { driver: 'docker', source: 'yaml' },
      {},
      fails(error),
    ).catch((caught: unknown) => caught);
    expect(refusal).toBeInstanceOf(CommandRefusedError);
    expect(refusal).toMatchObject({
      message:
        'environments.local.runtime.default: docker: Docker is not reachable, so aw dev cannot run the docker sandbox',
      fix: 'start Docker so that `docker version` answers, or run without the docker sandbox',
    });
  });
});

describe('unsandboxedLine', () => {
  it('is one line, and none without agents', () => {
    expect(unsandboxedLine([])).toBeUndefined();
    expect(unsandboxedLine(['b', 'a'])).toBe(
      'warning: a, b can run commands, and aw dev runs them on the local driver with no sandbox: commands run as you, with your files, network and environment\n',
    );
    expect(unsandboxedLine(['a'])?.split('\n')).toHaveLength(2);
  });
});
