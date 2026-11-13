import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { childProcess, startFixture } from './deployment-start.test-support.ts';

import { describe, expect, it } from 'vitest';

import { RUNNER_SOCKET_PING, startComposeDeployment } from './deployment.js';

const fixture = startFixture();

const { pins, writeEnvironment, noContext, freePort, upWith, daemon, outputOf } = fixture;
describe('Docker endpoint and socket group selection', () => {
  it('answers on the DOCKER_HOST of .env, not the shell, that compose runs with', async () => {
    await writeEnvironment('DOCKER_HOST=tcp://dotenv:2375', 'PORT=3417');
    await expect(startComposeDeployment(fixture.directory)).resolves.toBe('http://dotenv:3417');
    expect(childProcess.spawn).toHaveBeenCalledTimes(1);
    expect(childProcess.spawnSync).not.toHaveBeenCalledWith(
      'docker',
      expect.arrayContaining(['context']),
      expect.anything(),
    );
  });

  /** #389: a dind or remote daemon's socket is `root:docker`, whatever this machine says. */
  it("runs the runner in the daemon's socket group for this start and says so", async () => {
    await writeEnvironment('DOCKER_GID=0');
    const up = upWith(0);
    await startComposeDeployment(fixture.directory, {
      up,
      docker: daemon('2375'),
      inspect: noContext,
      hostPortFree: freePort,
    });
    expect(up.mock.calls[0]?.[1]).toMatchObject({ DOCKER_GID: '2375' });
    expect(outputOf()).toMatch(
      /^Checking the Docker socket group on the daemon…\n.*group 2375, not DOCKER_GID=0 in \.env.*DOCKER_GID=2375/su,
    );
  });

  it('keeps DOCKER_GID from .env, silently, when the daemon agrees or cannot answer', async () => {
    await writeEnvironment('DOCKER_GID=999');
    for (const groupId of ['999', undefined]) {
      const up = upWith(0);
      await startComposeDeployment(fixture.directory, {
        up,
        docker: daemon(groupId),
        inspect: noContext,
        hostPortFree: freePort,
      });
      expect(up.mock.calls[0]?.[1]).toMatchObject({ DOCKER_GID: '999' });
    }
    expect(outputOf()).not.toMatch(/socket on the daemon/u);
  });
});

describe('Docker socket refusals', () => {
  it('refuses a POSTGRES_IMAGE that docker would read as an option, before running it', async () => {
    await writeFile(
      path.join(fixture.directory, '.env'),
      [
        ...pins.filter((line) => !line.startsWith('POSTGRES_IMAGE=')),
        'POSTGRES_IMAGE=--privileged',
        '',
      ].join('\n'),
    );
    const docker = daemon('2375');
    const up = upWith(0);
    await expect(
      startComposeDeployment(fixture.directory, {
        up,
        docker,
        inspect: noContext,
        hostPortFree: freePort,
      }),
    ).rejects.toThrow(/POSTGRES_IMAGE/u);
    expect(docker).not.toHaveBeenCalled();
    expect(up).not.toHaveBeenCalled();
  });

  it('fails naming DOCKER_GID when the runner is denied the Docker socket', async () => {
    await writeEnvironment('DOCKER_GID=0');
    const docker = daemon(undefined, 13);
    const rejection = startComposeDeployment(fixture.directory, {
      up: upWith(0),
      docker,
      inspect: noContext,
      hostPortFree: freePort,
    });
    await expect(rejection).rejects.toThrow(
      /runner cannot use the Docker socket.*DOCKER_GID=0, which does not match the socket group, or SELinux\/AppArmor denies the socket.*Set DOCKER_GID in \.env/su,
    );
    expect(docker).toHaveBeenCalledWith(
      ['compose', 'exec', '-T', 'runner', 'node', '-e', RUNNER_SOCKET_PING],
      expect.objectContaining({ cwd: fixture.directory }),
    );
  });
});

describe('partial Compose startup cleanup', () => {
  /** #389: the bind error of `up` gets the same guidance as a port answered by something else. */
  it.each([
    'Error response from daemon: failed to set up container networking: driver failed programming external connectivity on endpoint demo-web-1: failed to bind host port for 0.0.0.0:3417:172.18.0.5:3000/tcp: address already in use',
    'Error response from daemon: Bind for 0.0.0.0:3417 failed: port is already allocated',
    // Docker Desktop on Windows; the WinSock tail is localised, so only the prefix is matched.
    'Error response from daemon: ports are not available: exposing port TCP 0.0.0.0:3417 -> 127.0.0.1:0: listen tcp 0.0.0.0:3417: bind: 通常、各ソケット アドレスに対してプロトコル、ネットワーク アドレス、またはポートのどれか 1 つのみを使用できます。',
  ])('stops the partial stack and names PORT when the host port is taken: %s', async (stderr) => {
    await writeEnvironment('PORT=3417');
    const docker = daemon(undefined);
    const rejection = startComposeDeployment(fixture.directory, {
      up: upWith(1, stderr),
      docker,
      inspect: noContext,
      hostPortFree: freePort,
    });
    await expect(rejection).rejects.toThrow(
      /port 3417 is already in use on the Docker host.*set PORT in \.env.*stopped with `docker compose down`/su,
    );
    expect(docker).toHaveBeenCalledWith(
      ['compose', 'down'],
      expect.objectContaining({ cwd: fixture.directory }),
    );
  });

  it('says how to stop the partial stack when `docker compose down` fails too', async () => {
    await writeEnvironment();
    const rejection = startComposeDeployment(fixture.directory, {
      up: upWith(1, 'port is already allocated'),
      docker: daemon(undefined, 1),
      inspect: noContext,
      hostPortFree: freePort,
    });
    await expect(rejection).rejects.toThrow(/port 3000 .*failed: run `docker compose down`/su);
  });

  it('passes any other compose failure through, and leaves the stack alone', async () => {
    await writeEnvironment();
    const docker = daemon(undefined);
    const rejection = startComposeDeployment(fixture.directory, {
      up: upWith(17, 'no such image'),
      docker,
      inspect: noContext,
      hostPortFree: freePort,
    });
    await expect(rejection).rejects.toThrow('docker compose exited with status 17');
    expect(docker).not.toHaveBeenCalledWith(['compose', 'down'], expect.anything());
  });
});
