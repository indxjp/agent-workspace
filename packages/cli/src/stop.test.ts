/**
 * Issue #394: `agent-workspace stop` takes the project down with the sandboxes its runner started.
 *
 * `docker compose down` and every `docker` call are fakes over a small model of the daemon:
 * nothing here reaches a real one, which on a developer machine runs the Owner's own stack.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DockerCommand } from './deployment.ts';
import { COMPOSE_PROJECT_LABEL, SANDBOX_LABEL, runStopCommand, type ComposeDown } from './stop.ts';

type Container = { id: string; labels: Record<string, string>; networks: string[] };
type Network = { id: string; name: string; labels: Record<string, string> };

/** A daemon with this project's, another project's and an unrelated container on it. */
function daemon(options: { downRemovesNetworks?: boolean; rmRefusal?: string } = {}) {
  const containers: Container[] = [];
  const networks: Network[] = [];
  const calls: string[][] = [];
  const downs: boolean[] = [];

  const matches = (labels: Record<string, string>, filter: string): boolean => {
    const [key, value] = filter.slice('label='.length).split(/=(.*)/su);
    return value === undefined ? key! in labels : labels[key!] === value;
  };
  const filtersOf = (argv: readonly string[]) =>
    argv.flatMap((arg, index) => (argv[index - 1] === '--filter' ? [arg] : []));

  const docker: DockerCommand = (argv) => {
    calls.push([...argv]);
    if (argv[0] === 'ps') {
      const ids = containers
        .filter((container) =>
          filtersOf(argv).every((filter) =>
            filter.startsWith('network=')
              ? container.networks.includes(filter.slice('network='.length))
              : matches(container.labels, filter),
          ),
        )
        .map((container) => container.id);
      return { status: 0, stdout: ids.join('\n') };
    }
    if (argv[0] === 'network' && argv[1] === 'ls') {
      const ids = networks
        .filter((network) => filtersOf(argv).every((filter) => matches(network.labels, filter)))
        .map((network) => network.id);
      return { status: 0, stdout: ids.join('\n') };
    }
    if (argv[0] === 'rm') {
      if (options.rmRefusal !== undefined)
        return { status: 1, stdout: '', stderr: options.rmRefusal };
      for (const id of argv.slice(3)) {
        const index = containers.findIndex((c) => c.id === id);
        // A real daemon refuses an unknown id; the fake must not silently remove another one.
        if (index < 0) throw new Error(`fake daemon: rm of unknown container ${id}`);
        containers.splice(index, 1);
      }
      return { status: 0, stdout: '' };
    }
    if (argv[0] === 'network' && argv[1] === 'rm') {
      for (const id of argv.slice(2)) {
        const network = networks.find((candidate) => candidate.id === id);
        if (network === undefined) continue;
        if (containers.some((container) => container.networks.includes(network.name))) {
          return {
            status: 1,
            stdout: '',
            stderr: `Error response from daemon: error while removing network: network ${network.name} has active endpoints`,
          };
        }
        networks.splice(networks.indexOf(network), 1);
      }
      return { status: 0, stdout: '' };
    }
    return { status: 1, stdout: '' };
  };

  /** Compose removes its own services, then its networks, failing on one a sandbox holds. */
  const down: ComposeDown = (_directory, _env, removeVolumes) => {
    downs.push(removeVolumes);
    for (const service of containers.filter(
      (c) => c.labels['com.docker.compose.project'] === 'acme',
    )) {
      containers.splice(containers.indexOf(service), 1);
    }
    let status = 0;
    if (options.downRemovesNetworks !== false) {
      for (const network of networks.filter(
        (n) => n.labels['com.docker.compose.project'] === 'acme',
      )) {
        if (containers.some((container) => container.networks.includes(network.name))) status = 1;
        else networks.splice(networks.indexOf(network), 1);
      }
    }
    return Promise.resolve(status);
  };

  return { containers, networks, calls, downs, docker, down };
}

function seedProject(model: ReturnType<typeof daemon>) {
  model.networks.push(
    {
      id: 'net-control',
      name: 'acme-runtime-control',
      labels: { 'com.docker.compose.project': 'acme', 'agent-workspace.runtime': 'docker-network' },
    },
    {
      id: 'net-other',
      name: 'other-runtime-control',
      labels: {
        'com.docker.compose.project': 'other',
        'agent-workspace.runtime': 'docker-network',
      },
    },
  );
  model.containers.push(
    {
      id: 'acme-runner',
      labels: { 'com.docker.compose.project': 'acme' },
      networks: ['acme-runtime-control'],
    },
    {
      id: 'acme-sandbox',
      labels: { 'agent-workspace.runtime': 'docker', [COMPOSE_PROJECT_LABEL]: 'acme' },
      networks: ['acme-runtime-control'],
    },
    {
      // Started by 0.1.2, before sandboxes carried the project label.
      id: 'acme-legacy-sandbox',
      labels: { 'agent-workspace.runtime': 'docker' },
      networks: ['acme-runtime-control'],
    },
    {
      id: 'other-sandbox',
      labels: { 'agent-workspace.runtime': 'docker', [COMPOSE_PROJECT_LABEL]: 'other' },
      networks: ['other-runtime-control'],
    },
    {
      // Attached to this project's network, but not a sandbox: never ours to remove.
      id: 'unrelated',
      labels: {},
      networks: ['acme-runtime-control'],
    },
  );
}

describe('agent-workspace stop', () => {
  let directory: string;
  const output: string[] = [];
  const out = { write: (chunk: string) => output.push(chunk) > 0 };

  beforeEach(async () => {
    output.length = 0;
    directory = await mkdtemp(path.join(tmpdir(), 'aw-stop-'));
    await writeFile(path.join(directory, '.env'), 'COMPOSE_PROJECT_NAME=acme\nPORT=3000\n');
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('labels the sandbox filter as the runtime driver writes it', () => {
    expect(SANDBOX_LABEL).toBe('agent-workspace.runtime=docker');
  });

  it('leaves nothing of the project, keeps volumes, and touches no other project', async () => {
    const model = daemon();
    seedProject(model);
    // The unrelated container would hold the network; detach it so the project can be emptied.
    model.containers.splice(
      model.containers.findIndex((c) => c.id === 'unrelated'),
      1,
    );

    await runStopCommand([], { directory, down: model.down, docker: model.docker, out });

    expect(model.containers.map((c) => c.id)).toEqual(['other-sandbox']);
    expect(model.networks.map((n) => n.id)).toEqual(['net-other']);
    // The first `down` failed on the held network, and the second one finished it.
    expect(model.downs).toEqual([false, false]);
    const removal = model.calls.find((call) => call[0] === 'rm') ?? [];
    expect(removal.slice(0, 3)).toEqual(['rm', '--force', '--volumes']);
    expect([...removal.slice(3)].sort()).toEqual(['acme-legacy-sandbox', 'acme-sandbox']);
    expect(output.join('')).toMatch(
      /Removed 2 runtime sandbox\(es\) of acme.*acme is stopped.*kept/su,
    );
  });

  it('accepts the lone `--` that `pnpm stop --volumes` forwards', async () => {
    const model = daemon();
    await runStopCommand(['--', '--volumes'], {
      directory,
      down: model.down,
      docker: model.docker,
      out,
    });
    expect(model.downs).toEqual([true]);
  });

  it('claims no sandbox removal when docker rm fails, and passes on what Docker said', async () => {
    const model = daemon({ rmRefusal: 'Error response from daemon: permission denied' });
    seedProject(model);
    const stop = runStopCommand([], { directory, down: model.down, docker: model.docker, out });
    await expect(stop).rejects.toThrow(/acme is not fully stopped/u);
    expect(output.join('')).toContain('Error response from daemon: permission denied');
    expect(output.join('')).not.toMatch(/Removed \d+ runtime sandbox/u);
  });

  it('passes --volumes to compose down', async () => {
    const model = daemon();
    await runStopCommand(['--volumes'], { directory, down: model.down, docker: model.docker, out });
    expect(model.downs).toEqual([true]);
    expect(output.join('')).toContain('Its volumes were removed.');
  });

  it('removes a runtime-driver network labelled for the project that Compose did not create', async () => {
    const model = daemon({ downRemovesNetworks: false });
    model.networks.push({
      id: 'net-driver',
      name: 'agent-egress',
      labels: { 'agent-workspace.runtime': 'docker-network', [COMPOSE_PROJECT_LABEL]: 'acme' },
    });
    await runStopCommand([], { directory, down: model.down, docker: model.docker, out });
    expect(model.networks).toEqual([]);
  });

  it('never removes a container that is not a sandbox, and fails naming what remains', async () => {
    const model = daemon();
    seedProject(model);

    const stop = runStopCommand([], { directory, down: model.down, docker: model.docker, out });

    await expect(stop).rejects.toThrow(/acme is not fully stopped/u);
    await expect(stop).rejects.toThrow(/network\(s\) net-control remain/u);
    // `network rm` failed, so stop passes on Docker's reason instead of claiming a removal.
    expect(output.join('')).toContain('network acme-runtime-control has active endpoints');
    expect(output.join('')).not.toContain('network(s) of acme');
    expect(model.containers.map((c) => c.id).sort()).toEqual(['other-sandbox', 'unrelated']);
  });

  it('fails instead of reporting a stop when the daemon cannot be listed', async () => {
    const model = daemon();
    const docker: DockerCommand = () => ({ status: 1, stdout: '' });
    await expect(runStopCommand([], { directory, down: model.down, docker, out })).rejects.toThrow(
      /cannot be listed/u,
    );
  });

  it('refuses an unknown argument before running anything', async () => {
    const model = daemon();
    await expect(
      runStopCommand(['--force'], { directory, down: model.down, docker: model.docker, out }),
    ).rejects.toThrow(/Unknown argument "--force".*agent-workspace stop \[--volumes\]/su);
    expect(model.downs).toEqual([]);
  });

  it('refuses a directory without a generated .env', async () => {
    await rm(path.join(directory, '.env'));
    await expect(runStopCommand([], { directory, out })).rejects.toThrow(/There is no \.env/u);
  });

  // #496: `npm create @indx-workspace` without --cloud writes a kind: Project directory, no .env.
  it('refuses a kind: Project directory, naming aw dev and the --cloud local project', async () => {
    const model = daemon();
    await rm(path.join(directory, '.env'));
    await writeFile(
      path.join(directory, 'agent-workspace.yaml'),
      'apiVersion: agentworkspace.dev/v2\nkind: Project\nname: acme\n',
    );
    const rejection = runStopCommand([], {
      directory,
      down: model.down,
      docker: model.docker,
      out,
    });
    await expect(rejection).rejects.toThrow(/There is no \.env/u);
    await expect(rejection).rejects.toThrow(/aw dev/u);
    await expect(rejection).rejects.toThrow(
      /npm create @indx-workspace <directory> -- --cloud local/u,
    );
    expect(model.downs).toEqual([]);
    expect(model.calls).toEqual([]);
  });

  it('refuses a COMPOSE_PROJECT_NAME that could widen a filter', async () => {
    await writeFile(path.join(directory, '.env'), 'COMPOSE_PROJECT_NAME=acme,label=x\n');
    const model = daemon();
    await expect(
      runStopCommand([], { directory, down: model.down, docker: model.docker, out }),
    ).rejects.toThrow(/is not a Compose project name/u);
    expect(model.downs).toEqual([]);
  });

  it("refuses the repository's own development stack, agent-workspace, before running anything", async () => {
    await writeFile(path.join(directory, '.env'), 'COMPOSE_PROJECT_NAME=agent-workspace\n');
    const model = daemon();
    await expect(
      runStopCommand([], { directory, down: model.down, docker: model.docker, out }),
    ).rejects.toThrow(/reserved for the repository's own development stack/u);
    expect(model.downs).toEqual([]);
    expect(model.calls).toEqual([]);
  });

  it('refuses a COMPOSE_PROJECT_NAME too long to scope the session cookie', async () => {
    await writeFile(path.join(directory, '.env'), `COMPOSE_PROJECT_NAME=${'a'.repeat(64)}\n`);
    const model = daemon();
    await expect(
      runStopCommand([], { directory, down: model.down, docker: model.docker, out }),
    ).rejects.toThrow(/64 characters long/u);
    expect(model.downs).toEqual([]);
  });

  it('names Docker when the docker binary is missing', async () => {
    const down: ComposeDown = () =>
      Promise.reject(Object.assign(new Error('spawn docker ENOENT'), { code: 'ENOENT' }));
    await expect(runStopCommand([], { directory, down, out })).rejects.toThrow(
      /Docker is not installed or not on PATH/u,
    );
  });
});
