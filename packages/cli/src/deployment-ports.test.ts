import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startFixture } from './deployment-start.test-support.ts';

import { describe, expect, it, vi } from 'vitest';

import { startComposeDeployment, type DockerCommand, type HostPortProbe } from './deployment.js';

const fixture = startFixture();

const { writeEnvironment, noContext, freePort, upWith } = fixture;

/** A daemon whose `docker ps` lists `rows` (project, name, ports), and that agrees otherwise. */
type Row = readonly [string, string, string] | readonly [string, string, string, string];

/** Rows are (project, name, ports), or (project, working_dir, name, ports). */
const listing = (...rows: Row[]) =>
  vi.fn<DockerCommand>((argv) =>
    argv[0] === 'ps'
      ? {
          status: 0,
          stdout: rows
            .map((row) => (row.length === 3 ? [row[0], '', row[1], row[2]] : row).join('\t'))
            .join('\n'),
        }
      : { status: 0, stdout: '' },
  );
describe('local web port conflicts', () => {
  it('refuses a port a process on this machine holds, before pulling anything', async () => {
    await writeEnvironment('PORT=3417', 'COMPOSE_PROJECT_NAME=demo');
    const docker = listing();
    const up = upWith(0);
    const probe = vi.fn<HostPortProbe>(() => Promise.resolve(false));
    const rejection = startComposeDeployment(fixture.directory, {
      up,
      docker,
      inspect: noContext,
      hostPortFree: probe,
    });
    await expect(rejection).rejects.toThrow(
      /^The web service cannot be published on http:\/\/127\.0\.0\.1:3417: port 3417 is already in use on the Docker host\. Stop the process holding port 3417, or set PORT in \.env to a free port, and run `agent-workspace start` again\. Nothing was started\.$/u,
    );
    expect(probe).toHaveBeenCalledWith(3417);
    expect(up).not.toHaveBeenCalled();
    expect(docker).not.toHaveBeenCalledWith(expect.arrayContaining(['run']), expect.anything());
  });

  it('refuses a port inside a range another container publishes', async () => {
    await writeEnvironment('PORT=3002', 'COMPOSE_PROJECT_NAME=demo');
    const up = upWith(0);
    const rejection = startComposeDeployment(fixture.directory, {
      up,
      docker: listing(
        ['', 'range-1', '0.0.0.0:2990-2999->2990-2999/tcp'],
        ['', 'range-2', '0.0.0.0:3000-3005->3000-3005/tcp'],
      ),
      inspect: noContext,
      hostPortFree: freePort,
    });
    await expect(rejection).rejects.toThrow(/port 3002 .*\(by container range-2\)/su);
    expect(up).not.toHaveBeenCalled();
  });
});

describe('other Compose projects', () => {
  it('refuses a port another container publishes on the daemon, naming it', async () => {
    await writeEnvironment('PORT=3000', 'COMPOSE_PROJECT_NAME=demo');
    const docker = listing(
      ['other', 'other-db-1', '0.0.0.0:13000->5432/tcp'],
      ['agent-workspace', 'agent-workspace-web-1', '0.0.0.0:3000->3000/tcp, [::]:3000->3000/tcp'],
    );
    const up = upWith(0);
    const probe = vi.fn<HostPortProbe>(() => Promise.resolve(true));
    const rejection = startComposeDeployment(fixture.directory, {
      up,
      docker,
      inspect: noContext,
      hostPortFree: probe,
    });
    await expect(rejection).rejects.toThrow(
      /port 3000 is already in use on the Docker host \(by container agent-workspace-web-1 of Compose project agent-workspace\)\. .*set PORT in \.env.*Nothing was started\./su,
    );
    expect(up).not.toHaveBeenCalled();
    expect(probe).not.toHaveBeenCalled();
  });

  it('refuses a same-named project in another directory without COMPOSE_PROJECT_NAME', async () => {
    await writeEnvironment('PORT=3000');
    const sameName = path.basename(fixture.directory).toLowerCase();
    const elsewhere = path.join(
      path.dirname(fixture.directory),
      'elsewhere',
      path.basename(fixture.directory),
    );
    const up = upWith(0);
    const rejection = startComposeDeployment(fixture.directory, {
      up,
      docker: listing([sameName, elsewhere, `${sameName}-web-1`, '0.0.0.0:3000->3000/tcp']),
      inspect: noContext,
      hostPortFree: freePort,
    });
    await expect(rejection).rejects.toThrow(/port 3000 is already in use.*Nothing was started/su);
    expect(up).not.toHaveBeenCalled();
  });
});

describe('recognising this Compose project', () => {
  it("lets `up` run again when the container holding the port is this project's own", async () => {
    await writeEnvironment('PORT=3000', 'COMPOSE_PROJECT_NAME=demo');
    const up = upWith(0);
    const probe = vi.fn<HostPortProbe>(() => Promise.resolve(false));
    await expect(
      startComposeDeployment(fixture.directory, {
        up,
        docker: listing(['demo', 'demo-web-1', '0.0.0.0:3000->3000/tcp']),
        inspect: noContext,
        hostPortFree: probe,
      }),
    ).resolves.toBe('http://127.0.0.1:3000');
    expect(probe).not.toHaveBeenCalled();
    expect(up).toHaveBeenCalledTimes(1);
  });

  it("knows its own container by Compose's working_dir label without COMPOSE_PROJECT_NAME", async () => {
    await writeEnvironment('PORT=3000');
    const up = upWith(0);
    const probe = vi.fn<HostPortProbe>(() => Promise.resolve(false));
    await expect(
      startComposeDeployment(fixture.directory, {
        up,
        docker: listing([
          'anything',
          fixture.directory,
          'anything-web-1',
          '0.0.0.0:3000->3000/tcp',
        ]),
        inspect: noContext,
        hostPortFree: probe,
      }),
    ).resolves.toBe('http://127.0.0.1:3000');
    expect(probe).not.toHaveBeenCalled();
    expect(up).toHaveBeenCalledTimes(1);
  });
});

/** Compose records the logical `$PWD`; a project opened through a symlink is still ours. */
it('knows its own container when Compose recorded the directory through a symlink', async () => {
  await writeEnvironment('PORT=3000');
  const linkParent = await mkdtemp(path.join(tmpdir(), 'aw-start-link-'));
  try {
    const link = path.join(linkParent, 'link');
    await symlink(fixture.directory, link, 'junction');
    const up = upWith(0);
    const probe = vi.fn<HostPortProbe>(() => Promise.resolve(false));
    await expect(
      startComposeDeployment(fixture.directory, {
        up,
        docker: listing(['anything', link, 'anything-web-1', '0.0.0.0:3000->3000/tcp']),
        inspect: noContext,
        hostPortFree: probe,
      }),
    ).resolves.toBe('http://127.0.0.1:3000');
    expect(probe).not.toHaveBeenCalled();
    expect(up).toHaveBeenCalledTimes(1);
  } finally {
    await rm(linkParent, { recursive: true, force: true });
  }
});
describe('daemon port probe fallback', () => {
  it('does not bind on this machine for a remote daemon, and leaves the rest to `up`', async () => {
    await writeEnvironment('DOCKER_HOST=tcp://remote:2375', 'COMPOSE_PROJECT_NAME=demo');
    const up = upWith(0);
    const probe = vi.fn<HostPortProbe>(() => Promise.resolve(false));
    await expect(
      startComposeDeployment(fixture.directory, { up, docker: listing(), hostPortFree: probe }),
    ).resolves.toBe('http://remote:3000');
    expect(probe).not.toHaveBeenCalled();
    expect(up).toHaveBeenCalledTimes(1);
  });

  it('leaves the port to `up` when `docker ps` fails, rather than refuse on the bind alone', async () => {
    await writeEnvironment('PORT=3000', 'COMPOSE_PROJECT_NAME=demo');
    const up = upWith(0);
    const probe = vi.fn<HostPortProbe>(() => Promise.resolve(false));
    const docker = vi.fn<DockerCommand>((argv) =>
      argv[0] === 'ps' ? { status: 1, stdout: '' } : { status: 0, stdout: '' },
    );
    await expect(
      startComposeDeployment(fixture.directory, {
        up,
        docker,
        inspect: noContext,
        hostPortFree: probe,
      }),
    ).resolves.toBe('http://127.0.0.1:3000');
    expect(probe).not.toHaveBeenCalled();
    expect(up).toHaveBeenCalledTimes(1);
  });
});
