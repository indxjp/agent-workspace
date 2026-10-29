import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import {
  assertComposeProjectName,
  assertDigestReference,
  assertDigestReferences,
  daemonSocketGroupId,
  DOCKER_CONTEXT_INSPECT_TIMEOUT_MS,
  DOCKER_SOCKET_GROUP_PROBE_TIMEOUT_MS,
  dockerEndpoint,
  hostPortFree,
  parseEnvironment,
  parseEnvLine,
  resolveDeploymentImages,
  RUNNER_SOCKET_PING,
  startComposeDeployment,
  validateDeploymentEnvironment,
  webUrl,
  type ComposeUp,
  type DockerCommand,
  type DockerContextInspector,
  type HostPortProbe,
} from './deployment.js';

const childProcess = vi.hoisted(() => ({ spawn: vi.fn(), spawnSync: vi.fn() }));

vi.mock('node:child_process', () => childProcess);

const ref = (name: string, digit: string) => `registry.example/${name}@sha256:${digit.repeat(64)}`;

describe('deployment image contract', () => {
  it('accepts immutable references and rejects tags and placeholder digests', () => {
    expect(assertDigestReference(ref('web', 'a'))).toContain('@sha256:');
    expect(() => assertDigestReference('registry.example/web:latest')).toThrow(/sha256/u);
    expect(() => assertDigestReference(`registry.example/web@sha256:${'0'.repeat(64)}`)).toThrow(
      /placeholder/u,
    );
  });

  it('resolves already-pinned environment overrides without registry access', () => {
    const environment = {
      AW_WEB_IMAGE: ref('web', '1'),
      AW_GATEWAY_IMAGE: ref('gateway', '2'),
      AW_RUNNER_IMAGE: ref('runner', '3'),
      AW_RUNTIME_IMAGE: ref('runtime', '4'),
      AW_POSTGRES_IMAGE: ref('postgres', '5'),
      AW_SEAWEEDFS_IMAGE: ref('seaweedfs', '6'),
    };
    expect(resolveDeploymentImages('local', environment)).toEqual({
      web: environment.AW_WEB_IMAGE,
      gateway: environment.AW_GATEWAY_IMAGE,
      runner: environment.AW_RUNNER_IMAGE,
      runtime: environment.AW_RUNTIME_IMAGE,
      postgres: environment.AW_POSTGRES_IMAGE,
      seaweedfs: environment.AW_SEAWEEDFS_IMAGE,
    });
  });

  // ADR-0067: the bundled object store is SeaweedFS. The MinIO-era override is refused by name
  // rather than ignored, so a release script still setting it learns why its pin went nowhere.
  it('refuses the retired MinIO image override for the Compose project', () => {
    const environment = {
      AW_WEB_IMAGE: ref('web', '1'),
      AW_GATEWAY_IMAGE: ref('gateway', '2'),
      AW_RUNNER_IMAGE: ref('runner', '3'),
      AW_RUNTIME_IMAGE: ref('runtime', '4'),
      AW_POSTGRES_IMAGE: ref('postgres', '5'),
      AW_MINIO_IMAGE: ref('minio', '6'),
    };
    expect(() => resolveDeploymentImages('local', environment)).toThrow(
      /AW_MINIO_IMAGE is no longer read.*AW_SEAWEEDFS_IMAGE/u,
    );
  });

  it('pins the bundled object store to the digest the S3 contract suite runs against', () => {
    const environment = {
      AW_WEB_IMAGE: ref('web', '1'),
      AW_GATEWAY_IMAGE: ref('gateway', '2'),
      AW_RUNNER_IMAGE: ref('runner', '3'),
      AW_RUNTIME_IMAGE: ref('runtime', '4'),
      AW_POSTGRES_IMAGE: ref('postgres', '5'),
    };
    expect(resolveDeploymentImages('local', environment).seaweedfs).toBe(
      'docker.io/chrislusf/seaweedfs@sha256:ce9e796f1fe6f06968f4c04bdaf8f678dad9c8acdfef3d244133d71bfa6bf882',
    );
  });

  // PostgreSQL and SeaweedFS are Compose services. A cloud deployment takes its database and its
  // bucket from the cloud, so requiring those two pins would gate an image it never pulls — and
  // would send the generator to a registry for it.
  it('resolves and gates only the images the named deployment shape pulls', () => {
    const environment = {
      AW_WEB_IMAGE: ref('web', '1'),
      AW_GATEWAY_IMAGE: ref('gateway', '2'),
      AW_RUNNER_IMAGE: ref('runner', '3'),
      AW_RUNTIME_IMAGE: ref('runtime', '4'),
    };
    const cloudImages = resolveDeploymentImages('gcp', environment);
    expect(cloudImages).toEqual({
      web: environment.AW_WEB_IMAGE,
      gateway: environment.AW_GATEWAY_IMAGE,
      runner: environment.AW_RUNNER_IMAGE,
      runtime: environment.AW_RUNTIME_IMAGE,
    });
    expect(assertDigestReferences(cloudImages)).toBe(cloudImages);
    // Whatever is in the set still clears the gate.
    expect(() =>
      assertDigestReferences({ ...cloudImages, postgres: 'docker.io/library/postgres:18-alpine' }),
    ).toThrow(/sha256/u);
  });

  // `agent-workspace render` passes the project's own `.env` pins: an override still wins, a pin
  // is used without a registry, and a pin that is not a digest is refused by name, not by value.
  describe('with pinned references', () => {
    const pinned = {
      web: ref('web', '1'),
      gateway: ref('gateway', '2'),
      runner: ref('runner', '3'),
      runtime: ref('runtime', '4'),
    };

    beforeEach(() => {
      childProcess.spawnSync.mockReset();
    });

    it('uses every pin without spawning docker', () => {
      expect(resolveDeploymentImages('gcp', {}, pinned)).toEqual(pinned);
      expect(childProcess.spawnSync).not.toHaveBeenCalled();
    });

    it('lets an override beat a pin', () => {
      const override = ref('web', '9');
      expect(resolveDeploymentImages('gcp', { AW_WEB_IMAGE: override }, pinned).web).toBe(override);
    });

    it('refuses a placeholder pin without quoting it', () => {
      const placeholder = `registry.example/web@sha256:${'0'.repeat(64)}`;
      expect(() => resolveDeploymentImages('gcp', {}, { ...pinned, web: placeholder })).toThrow(
        'the pinned web image must be a non-placeholder sha256 digest reference',
      );
    });
  });

  it('fails when configured and effective runtime topology disagree', () => {
    const environment = parseEnvironment(
      [
        `WEB_IMAGE=${ref('web', '1')}`,
        `GATEWAY_IMAGE=${ref('gateway', '2')}`,
        `RUNNER_IMAGE=${ref('runner', '3')}`,
        `RUNTIME_IMAGE=${ref('runtime', '4')}`,
        `POSTGRES_IMAGE=${ref('postgres', '5')}`,
        `SEAWEEDFS_IMAGE=${ref('seaweedfs', '6')}`,
        'RUNTIME_DRIVER=local',
      ].join('\n'),
    );
    expect(() => validateDeploymentEnvironment(environment)).toThrow(/disagrees/u);
  });

  const platformPins = [
    `WEB_IMAGE=${ref('web', '1')}`,
    `GATEWAY_IMAGE=${ref('gateway', '2')}`,
    `RUNNER_IMAGE=${ref('runner', '3')}`,
    `RUNTIME_IMAGE=${ref('runtime', '4')}`,
    `POSTGRES_IMAGE=${ref('postgres', '5')}`,
    'RUNTIME_DRIVER=docker',
  ];
  const environmentOf = (...lines: string[]) =>
    parseEnvironment([...platformPins, ...lines].join('\n'));

  /** #394: the project name labels sandboxes and scopes the session cookie; refuse a bad one up front. */
  it('refuses an invalid, too-long or reserved COMPOSE_PROJECT_NAME before starting', () => {
    const seaweed = `SEAWEEDFS_IMAGE=${ref('seaweedfs', '6')}`;
    expect(() =>
      validateDeploymentEnvironment(environmentOf(seaweed, 'COMPOSE_PROJECT_NAME=acme-ai')),
    ).not.toThrow();
    expect(() =>
      validateDeploymentEnvironment(environmentOf(seaweed, 'COMPOSE_PROJECT_NAME=Acme AI')),
    ).toThrow(/is not a Compose project name/u);
    expect(() =>
      validateDeploymentEnvironment(
        environmentOf(seaweed, `COMPOSE_PROJECT_NAME=${'a'.repeat(64)}`),
      ),
    ).toThrow(/64 characters long.*session cookie/su);
    expect(() =>
      validateDeploymentEnvironment(environmentOf(seaweed, 'COMPOSE_PROJECT_NAME=agent-workspace')),
    ).toThrow(/reserved/u);
    expect(assertComposeProjectName('a'.repeat(63))).toBe('a'.repeat(63));
  });

  /** #496: an empty name is how a kind: Project directory with a hand-written .env reaches this. */
  it('tells a refused COMPOSE_PROJECT_NAME where a Compose project comes from and about aw dev', () => {
    expect(() => assertComposeProjectName('')).toThrow(
      'the name `npm create @indx-workspace <directory> -- --cloud local` generated',
    );
    expect(() => assertComposeProjectName('')).toThrow(
      'A kind: Project directory runs with `aw dev`',
    );
    expect(() => assertComposeProjectName(undefined)).not.toThrow(/create-agent-workspace/u);
  });

  it('holds the object-store pin to the digest gate', () => {
    expect(() =>
      validateDeploymentEnvironment(environmentOf(`SEAWEEDFS_IMAGE=${ref('seaweedfs', '6')}`)),
    ).not.toThrow();
    expect(() =>
      validateDeploymentEnvironment(
        environmentOf('SEAWEEDFS_IMAGE=docker.io/chrislusf/seaweedfs:4.47'),
      ),
    ).toThrow(/SEAWEEDFS_IMAGE must be a non-placeholder sha256 digest/u);
    expect(() => validateDeploymentEnvironment(environmentOf())).toThrow(
      /SEAWEEDFS_IMAGE must be/u,
    );
  });

  // A project generated before ADR-0067 carries its own MinIO-era compose.yaml and pins
  // MINIO_IMAGE; `start` still holds that pin to the same gate instead of refusing the project.
  it('still gates the MinIO pin of a project generated before the SeaweedFS switch', () => {
    expect(() =>
      validateDeploymentEnvironment(environmentOf(`MINIO_IMAGE=${ref('minio', '6')}`)),
    ).not.toThrow();
    expect(() =>
      validateDeploymentEnvironment(environmentOf('MINIO_IMAGE=minio/minio:RELEASE.2025-09-07')),
    ).toThrow(/MINIO_IMAGE must be a non-placeholder sha256 digest/u);
  });

  // ENG-07 (ADR-0073): a project generated since pins the Claude engine's runtime image under its
  // per-engine variable; one generated before pins RUNTIME_IMAGE (the `platformPins` above). Both
  // clear the same digest gate.
  it('gates the per-engine runtime image pin and still accepts the pre-ENG-07 one', () => {
    const current = (runtime: string) =>
      parseEnvironment(
        [
          ...platformPins.filter((line) => !line.startsWith('RUNTIME_IMAGE=')),
          `AGENT_WORKSPACE_RUNTIME_IMAGE_CLAUDE_AGENT_SDK=${runtime}`,
          `SEAWEEDFS_IMAGE=${ref('seaweedfs', '6')}`,
        ].join('\n'),
      );
    expect(() => validateDeploymentEnvironment(current(ref('runtime', '4')))).not.toThrow();
    expect(() => validateDeploymentEnvironment(current('registry.example/runtime:latest'))).toThrow(
      /AGENT_WORKSPACE_RUNTIME_IMAGE_CLAUDE_AGENT_SDK must be a non-placeholder sha256 digest/u,
    );
    expect(() =>
      validateDeploymentEnvironment(environmentOf(`SEAWEEDFS_IMAGE=${ref('seaweedfs', '6')}`)),
    ).not.toThrow();
  });
});

describe('.env lines', () => {
  it('reads an `export NAME=` line under its name', () => {
    expect(parseEnvironment('export WEB_IMAGE=a\n  export\tKEY=b\nexport=c\n')).toEqual({
      WEB_IMAGE: 'a',
      KEY: 'b',
      export: 'c',
    });
    expect(parseEnvLine('export WEB_IMAGE=a  # pinned')).toEqual({
      kind: 'entry',
      prefix: 'export ',
      key: 'WEB_IMAGE',
      value: 'a',
      suffix: '  # pinned',
    });
  });

  it('strips an inline comment after whitespace from an unquoted value only', () => {
    expect(
      parseEnvironment(
        [
          `WEB_IMAGE=${ref('web', 'a')} # pinned by ops`,
          'EMPTY= # nothing yet',
          'HASH=a#b',
          'QUOTED="a # b"',
          'PLAIN=value',
        ].join('\n'),
      ),
    ).toEqual({
      WEB_IMAGE: ref('web', 'a'),
      EMPTY: '',
      HASH: 'a#b',
      QUOTED: 'a # b',
      PLAIN: 'value',
    });
  });

  it('unquotes values as Compose does, and leaves unmatched quotes as written', () => {
    expect(
      parseEnvironment(
        [
          `POLICY='{"promotion":{"minEvalScore":1}}'`,
          String.raw`ESCAPED="x\"y\\z\nw"`,
          `LITERAL='a\\nb $HOME'`,
          `EMPTY_QUOTED=''`,
          `UNTERMINATED='abc`,
          `INNER_QUOTE='it's'`,
          `MIXED='a"`,
          `COMMENTED='x' # note`,
        ].join('\n'),
      ),
    ).toEqual({
      POLICY: '{"promotion":{"minEvalScore":1}}',
      ESCAPED: 'x"y\\z\nw',
      LITERAL: 'a\\nb $HOME',
      EMPTY_QUOTED: '',
      UNTERMINATED: "'abc",
      INNER_QUOTE: "'it's'",
      MIXED: `'a"`,
      // Not wholly quoted, so returned as written; Compose would give `x`. No writer emits this.
      COMMENTED: `'x' # note`,
    });
  });

  it('keeps a quoted value byte-for-byte in parseEnvLine, which writers rewrite from', () => {
    expect(parseEnvLine(`POLICY='{"a":1}'`)).toMatchObject({ key: 'POLICY', value: `'{"a":1}'` });
  });

  it('keeps blank lines, comments and malformed lines apart', () => {
    expect(parseEnvLine('   ')).toEqual({ kind: 'blank' });
    expect(parseEnvLine('# WEB_IMAGE=x')).toEqual({ kind: 'blank' });
    expect(parseEnvLine('export ')).toEqual({ kind: 'invalid' });
    expect(parseEnvLine('=value')).toEqual({ kind: 'invalid' });
    expect(() => parseEnvironment('export NOVALUE\n')).toThrow('Invalid .env line');
  });
});

describe('webUrl', () => {
  it('answers on this machine at PORT, or 3000 when .env leaves it empty', () => {
    expect(webUrl({ PORT: '3310' })).toBe('http://127.0.0.1:3310');
    expect(webUrl({})).toBe('http://127.0.0.1:3000');
    expect(webUrl({ PORT: '' })).toBe('http://127.0.0.1:3000');
    expect(webUrl({ PORT: '127.0.0.1:3000' })).toBe('http://127.0.0.1:3000');
  });

  it('answers on the remote Docker host a tcp:// or ssh:// DOCKER_HOST names', () => {
    expect(webUrl({ PORT: '3310' }, 'tcp://10.0.0.5:2375')).toBe('http://10.0.0.5:3310');
    expect(webUrl({}, 'ssh://ops@docker.internal')).toBe('http://docker.internal:3000');
  });

  it('keeps this machine for a local socket or pipe', () => {
    expect(webUrl({}, 'unix:///var/run/docker.sock')).toBe('http://127.0.0.1:3000');
    expect(webUrl({}, 'npipe:////./pipe/docker_engine')).toBe('http://127.0.0.1:3000');
  });
});

describe('dockerEndpoint', () => {
  const inspectCalls: NodeJS.ProcessEnv[] = [];
  const context =
    (stdout: string, status = 0) =>
    (environment: NodeJS.ProcessEnv) => {
      inspectCalls.push(environment);
      return { status, stdout };
    };

  it('takes DOCKER_HOST from the environment compose runs with, .env included', () => {
    const shell: NodeJS.ProcessEnv = { DOCKER_HOST: 'tcp://shell:2375' };
    const dotEnv = parseEnvironment('DOCKER_HOST=tcp://dotenv:2375\n');
    const merged = { ...shell, ...dotEnv };
    expect(dockerEndpoint(merged, context('unix:///ignored'))).toBe('tcp://dotenv:2375');
    expect(webUrl({ PORT: '3417' }, dockerEndpoint(merged, context('')))).toBe(
      'http://dotenv:3417',
    );
  });

  it("falls back to the current docker context's endpoint when DOCKER_HOST is unset", () => {
    inspectCalls.length = 0;
    const environment = { DOCKER_CONTEXT: 'remote' };
    expect(dockerEndpoint(environment, context('ssh://ops@build-host\n'))).toBe(
      'ssh://ops@build-host',
    );
    expect(inspectCalls).toEqual([environment]);
    expect(dockerEndpoint({ DOCKER_HOST: '' }, context('tcp://ctx:2376'))).toBe('tcp://ctx:2376');
  });

  it('is undefined when the context cannot be read, so the URL stays on this machine', () => {
    expect(dockerEndpoint({}, context('', 1))).toBeUndefined();
    expect(webUrl({}, dockerEndpoint({}, context('', 1)))).toBe('http://127.0.0.1:3000');
  });
});

describe('docker context inspection', () => {
  beforeEach(() => {
    childProcess.spawnSync.mockReset();
    childProcess.spawnSync.mockReturnValue({ status: 1, stdout: '' });
  });

  it('bounds `docker context inspect` so a stuck docker CLI cannot hang start', () => {
    expect(dockerEndpoint({})).toBeUndefined();
    expect(childProcess.spawnSync).toHaveBeenCalledWith(
      'docker',
      ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'],
      expect.objectContaining({ timeout: DOCKER_CONTEXT_INSPECT_TIMEOUT_MS }),
    );
  });
});

describe('daemonSocketGroupId', () => {
  const answer =
    (stdout: string, status: number | null = 0): DockerCommand =>
    () => ({ status, stdout });

  /** #389: the group comes from the daemon's own socket, not this machine's file. */
  it("stats the daemon's socket in a container of the pinned image, bounded by a timeout", () => {
    const run = vi.fn<DockerCommand>(answer('2375\n'));
    const environment = { DOCKER_HOST: 'tcp://dind:2375' };
    expect(daemonSocketGroupId(environment, ref('postgres', '5'), run)).toBe(2375);
    expect(run).toHaveBeenCalledWith(
      [
        'run',
        '--rm',
        '--quiet',
        '--network',
        'none',
        '--entrypoint',
        'stat',
        '--volume',
        '/var/run/docker.sock:/var/run/docker.sock:ro',
        ref('postgres', '5'),
        '-c',
        '%g',
        '/var/run/docker.sock',
      ],
      { env: environment, timeout: DOCKER_SOCKET_GROUP_PROBE_TIMEOUT_MS },
    );
  });

  it('is undefined when the daemon fails, times out or answers something else', () => {
    expect(daemonSocketGroupId({}, ref('postgres', '5'), answer('', 125))).toBeUndefined();
    expect(daemonSocketGroupId({}, ref('postgres', '5'), answer('', null))).toBeUndefined();
    expect(daemonSocketGroupId({}, ref('postgres', '5'), answer('docker\n'))).toBeUndefined();
  });
});

describe('startComposeDeployment', () => {
  let directory: string;
  let stdout: MockInstance<typeof process.stdout.write>;
  const shellDockerHost = process.env['DOCKER_HOST'];
  const pins = [
    `WEB_IMAGE=${ref('web', '1')}`,
    `GATEWAY_IMAGE=${ref('gateway', '2')}`,
    `RUNNER_IMAGE=${ref('runner', '3')}`,
    `RUNTIME_IMAGE=${ref('runtime', '4')}`,
    `POSTGRES_IMAGE=${ref('postgres', '5')}`,
    `SEAWEEDFS_IMAGE=${ref('seaweedfs', '6')}`,
    'RUNTIME_DRIVER=docker',
  ];
  const writeEnvironment = (...lines: string[]) =>
    writeFile(path.join(directory, '.env'), [...pins, ...lines, ''].join('\n'));
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

  it('answers on the DOCKER_HOST of .env, not the shell, that compose runs with', async () => {
    await writeEnvironment('DOCKER_HOST=tcp://dotenv:2375', 'PORT=3417');
    await expect(startComposeDeployment(directory)).resolves.toBe('http://dotenv:3417');
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
    await startComposeDeployment(directory, {
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

  it('refuses a POSTGRES_IMAGE that docker would read as an option, before running it', async () => {
    await writeFile(
      path.join(directory, '.env'),
      [
        ...pins.filter((line) => !line.startsWith('POSTGRES_IMAGE=')),
        'POSTGRES_IMAGE=--privileged',
        '',
      ].join('\n'),
    );
    const docker = daemon('2375');
    const up = upWith(0);
    await expect(
      startComposeDeployment(directory, { up, docker, inspect: noContext, hostPortFree: freePort }),
    ).rejects.toThrow(/POSTGRES_IMAGE/u);
    expect(docker).not.toHaveBeenCalled();
    expect(up).not.toHaveBeenCalled();
  });

  it('keeps DOCKER_GID from .env, silently, when the daemon agrees or cannot answer', async () => {
    await writeEnvironment('DOCKER_GID=999');
    for (const groupId of ['999', undefined]) {
      const up = upWith(0);
      await startComposeDeployment(directory, {
        up,
        docker: daemon(groupId),
        inspect: noContext,
        hostPortFree: freePort,
      });
      expect(up.mock.calls[0]?.[1]).toMatchObject({ DOCKER_GID: '999' });
    }
    expect(outputOf()).not.toMatch(/socket on the daemon/u);
  });

  it('fails naming DOCKER_GID when the runner is denied the Docker socket', async () => {
    await writeEnvironment('DOCKER_GID=0');
    const docker = daemon(undefined, 13);
    const rejection = startComposeDeployment(directory, {
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
      expect.objectContaining({ cwd: directory }),
    );
  });

  /** #389: the bind error of `up` gets the same guidance as a port answered by something else. */
  it.each([
    'Error response from daemon: failed to set up container networking: driver failed programming external connectivity on endpoint demo-web-1: failed to bind host port for 0.0.0.0:3417:172.18.0.5:3000/tcp: address already in use',
    'Error response from daemon: Bind for 0.0.0.0:3417 failed: port is already allocated',
    // Docker Desktop on Windows; the WinSock tail is localised, so only the prefix is matched.
    'Error response from daemon: ports are not available: exposing port TCP 0.0.0.0:3417 -> 127.0.0.1:0: listen tcp 0.0.0.0:3417: bind: 通常、各ソケット アドレスに対してプロトコル、ネットワーク アドレス、またはポートのどれか 1 つのみを使用できます。',
  ])('stops the partial stack and names PORT when the host port is taken: %s', async (stderr) => {
    await writeEnvironment('PORT=3417');
    const docker = daemon(undefined);
    const rejection = startComposeDeployment(directory, {
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
      expect.objectContaining({ cwd: directory }),
    );
  });

  it('says how to stop the partial stack when `docker compose down` fails too', async () => {
    await writeEnvironment();
    const rejection = startComposeDeployment(directory, {
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
    const rejection = startComposeDeployment(directory, {
      up: upWith(17, 'no such image'),
      docker,
      inspect: noContext,
      hostPortFree: freePort,
    });
    await expect(rejection).rejects.toThrow('docker compose exited with status 17');
    expect(docker).not.toHaveBeenCalledWith(['compose', 'down'], expect.anything());
  });
  /** #396: a taken port is found before `compose up` pulls and starts anything. */
  describe('pre-flight web port check', () => {
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

    it('refuses a port a process on this machine holds, before pulling anything', async () => {
      await writeEnvironment('PORT=3417', 'COMPOSE_PROJECT_NAME=demo');
      const docker = listing();
      const up = upWith(0);
      const probe = vi.fn<HostPortProbe>(() => Promise.resolve(false));
      const rejection = startComposeDeployment(directory, {
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

    it('refuses a port another container publishes on the daemon, naming it', async () => {
      await writeEnvironment('PORT=3000', 'COMPOSE_PROJECT_NAME=demo');
      const docker = listing(
        ['other', 'other-db-1', '0.0.0.0:13000->5432/tcp'],
        ['agent-workspace', 'agent-workspace-web-1', '0.0.0.0:3000->3000/tcp, [::]:3000->3000/tcp'],
      );
      const up = upWith(0);
      const probe = vi.fn<HostPortProbe>(() => Promise.resolve(true));
      const rejection = startComposeDeployment(directory, {
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

    it("lets `up` run again when the container holding the port is this project's own", async () => {
      await writeEnvironment('PORT=3000', 'COMPOSE_PROJECT_NAME=demo');
      const up = upWith(0);
      const probe = vi.fn<HostPortProbe>(() => Promise.resolve(false));
      await expect(
        startComposeDeployment(directory, {
          up,
          docker: listing(['demo', 'demo-web-1', '0.0.0.0:3000->3000/tcp']),
          inspect: noContext,
          hostPortFree: probe,
        }),
      ).resolves.toBe('http://127.0.0.1:3000');
      expect(probe).not.toHaveBeenCalled();
      expect(up).toHaveBeenCalledTimes(1);
    });

    it('does not bind on this machine for a remote daemon, and leaves the rest to `up`', async () => {
      await writeEnvironment('DOCKER_HOST=tcp://remote:2375', 'COMPOSE_PROJECT_NAME=demo');
      const up = upWith(0);
      const probe = vi.fn<HostPortProbe>(() => Promise.resolve(false));
      await expect(
        startComposeDeployment(directory, { up, docker: listing(), hostPortFree: probe }),
      ).resolves.toBe('http://remote:3000');
      expect(probe).not.toHaveBeenCalled();
      expect(up).toHaveBeenCalledTimes(1);
    });

    it('refuses a port inside a range another container publishes', async () => {
      await writeEnvironment('PORT=3002', 'COMPOSE_PROJECT_NAME=demo');
      const up = upWith(0);
      const rejection = startComposeDeployment(directory, {
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

    it("knows its own container by Compose's working_dir label without COMPOSE_PROJECT_NAME", async () => {
      await writeEnvironment('PORT=3000');
      const up = upWith(0);
      const probe = vi.fn<HostPortProbe>(() => Promise.resolve(false));
      await expect(
        startComposeDeployment(directory, {
          up,
          docker: listing(['anything', directory, 'anything-web-1', '0.0.0.0:3000->3000/tcp']),
          inspect: noContext,
          hostPortFree: probe,
        }),
      ).resolves.toBe('http://127.0.0.1:3000');
      expect(probe).not.toHaveBeenCalled();
      expect(up).toHaveBeenCalledTimes(1);
    });

    /** Compose records the logical `$PWD`; a project opened through a symlink is still ours. */
    it('knows its own container when Compose recorded the directory through a symlink', async () => {
      await writeEnvironment('PORT=3000');
      const linkParent = await mkdtemp(path.join(tmpdir(), 'aw-start-link-'));
      try {
        const link = path.join(linkParent, 'link');
        await symlink(directory, link, 'junction');
        const up = upWith(0);
        const probe = vi.fn<HostPortProbe>(() => Promise.resolve(false));
        await expect(
          startComposeDeployment(directory, {
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

    it('refuses a same-named project in another directory without COMPOSE_PROJECT_NAME', async () => {
      await writeEnvironment('PORT=3000');
      const sameName = path.basename(directory).toLowerCase();
      const elsewhere = path.join(path.dirname(directory), 'elsewhere', path.basename(directory));
      const up = upWith(0);
      const rejection = startComposeDeployment(directory, {
        up,
        docker: listing([sameName, elsewhere, `${sameName}-web-1`, '0.0.0.0:3000->3000/tcp']),
        inspect: noContext,
        hostPortFree: freePort,
      });
      await expect(rejection).rejects.toThrow(/port 3000 is already in use.*Nothing was started/su);
      expect(up).not.toHaveBeenCalled();
    });

    it('leaves the port to `up` when `docker ps` fails, rather than refuse on the bind alone', async () => {
      await writeEnvironment('PORT=3000', 'COMPOSE_PROJECT_NAME=demo');
      const up = upWith(0);
      const probe = vi.fn<HostPortProbe>(() => Promise.resolve(false));
      const docker = vi.fn<DockerCommand>((argv) =>
        argv[0] === 'ps' ? { status: 1, stdout: '' } : { status: 0, stdout: '' },
      );
      await expect(
        startComposeDeployment(directory, { up, docker, inspect: noContext, hostPortFree: probe }),
      ).resolves.toBe('http://127.0.0.1:3000');
      expect(probe).not.toHaveBeenCalled();
      expect(up).toHaveBeenCalledTimes(1);
    });
  });
});

describe('hostPortFree', () => {
  it('reads a port another listener holds as taken, and a released one as free', async () => {
    const holder = createServer();
    await new Promise<void>((resolve) => holder.listen({ port: 0 }, resolve));
    const address = holder.address();
    if (address === null || typeof address === 'string') throw new Error('no TCP address');
    await expect(hostPortFree(address.port)).resolves.toBe(false);
    await new Promise<void>((resolve) => holder.close(() => resolve()));
    await expect(hostPortFree(address.port)).resolves.toBe(true);
  });
});
