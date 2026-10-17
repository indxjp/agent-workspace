import {
  chmod,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { runAsProcess } from './cli-failure.js';
import { createWorkspace, DEFAULT_ANSWERS } from './create.js';
import { parseEnvironment, type DeploymentImages } from './deployment.js';
import type { DeploymentCloud } from './profile.js';
import { parseRenderArguments, runRenderCommand } from './render.js';

const created: string[] = [];
const digest = (character: string) => `sha256:${character.repeat(64)}`;
const images: DeploymentImages = {
  web: `registry.example/web@${digest('1')}`,
  gateway: `registry.example/gateway@${digest('2')}`,
  runner: `registry.example/runner@${digest('3')}`,
  runtime: `registry.example/runtime@${digest('4')}`,
  postgres: `registry.example/postgres@${digest('5')}`,
  seaweedfs: `registry.example/seaweedfs@${digest('6')}`,
};
const cloudImages: DeploymentImages = {
  web: images.web,
  gateway: images.gateway,
  runner: images.runner,
  runtime: images.runtime,
};
/** No `AW_*_IMAGE` override: every image comes from the project's own `.env` pins. */
const offline = { environment: {} };

afterEach(async () => {
  await Promise.all(created.splice(0).map((entry) => rm(entry, { recursive: true })));
  vi.restoreAllMocks();
});

async function project(cloud: DeploymentCloud): Promise<string> {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'agent-workspace-render-'));
  created.push(parent);
  const target = path.join(parent, 'acme-ai');
  await createWorkspace(target, cloud === 'local' ? DEFAULT_ANSWERS : null, {
    cloud,
    images: cloud === 'local' ? images : cloudImages,
  });
  return target;
}

/** Every file under `directory`, with its bytes and its mode. */
async function snapshot(directory: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  for (const entry of await readdir(directory, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const file = path.join(entry.parentPath, entry.name);
    const mode = (await stat(file)).mode & 0o777;
    files.set(
      path.relative(directory, file),
      `${mode.toString(8)}:${await readFile(file, 'utf8')}`,
    );
  }
  return files;
}

/** Everything written to stdout and stderr while `run` ran. */
async function captured<T>(run: () => Promise<T>): Promise<{ result: T; output: string }> {
  const written: string[] = [];
  const capture = (chunk: unknown) => {
    written.push(String(chunk));
    return true;
  };
  vi.spyOn(process.stdout, 'write').mockImplementation(capture);
  vi.spyOn(process.stderr, 'write').mockImplementation(capture);
  try {
    return { result: await run(), output: written.join('') };
  } finally {
    vi.restoreAllMocks();
  }
}

async function editFile(file: string, edit: (contents: string) => string): Promise<void> {
  await writeFile(file, edit(await readFile(file, 'utf8')), 'utf8');
}

describe('parseRenderArguments', () => {
  it('defaults to the current directory and takes --check', () => {
    expect(parseRenderArguments([])).toEqual({
      directory: process.cwd(),
      check: false,
      upgrade: false,
    });
    expect(parseRenderArguments(['acme-ai', '--check'])).toEqual({
      directory: path.resolve('acme-ai'),
      check: true,
      upgrade: false,
    });
  });

  it('refuses an unknown flag and an extra argument', () => {
    expect(() => parseRenderArguments(['--chek'])).toThrow('Unknown option "--chek"');
    expect(() => parseRenderArguments(['a', 'b'])).toThrow('Unexpected extra argument "b"');
  });
});

describe('agent-workspace render', () => {
  it.each(['local', 'gcp', 'aws', 'azure'] as const)(
    'changes nothing on a freshly created %s project, and says so',
    async (cloud) => {
      const target = await project(cloud);
      const before = await snapshot(target);

      const { result, output } = await captured(() => runRenderCommand([target], offline));

      expect(result.length).toBeGreaterThan(1);
      expect(result.every(({ status }) => status === 'unchanged')).toBe(true);
      expect(result.map(({ path: file }) => file)).toContain('.env');
      expect(result.some(({ path: file }) => file === 'compose.yaml')).toBe(cloud === 'local');
      expect(output).toContain('unchanged  .env');
      expect(output).toContain('Nothing to change');
      expect(await snapshot(target)).toEqual(before);
    },
  );

  it('updates the files an edited profile affects, and a second run changes nothing', async () => {
    const target = await project('gcp');
    await editFile(path.join(target, 'agent-workspace.yaml'), (profile) =>
      profile.replace('bootstrapAdmin: admin@localhost.test', 'bootstrapAdmin: ops@acme.example'),
    );

    const first = await captured(() => runRenderCommand([target], offline));
    const statuses = Object.fromEntries(
      first.result.map(({ path: file, status }) => [file, status]),
    );
    expect(statuses).toEqual({
      'deploy/helm/values.yaml': 'unchanged',
      'deploy/terraform/gcp-cloudrun.auto.tfvars.json': 'updated',
      '.env': 'unchanged',
    });
    expect(first.output).toContain('updated    deploy/terraform/gcp-cloudrun.auto.tfvars.json');
    expect(first.output).toContain('Rendered 1 file from agent-workspace.yaml');
    expect(
      await readFile(path.join(target, 'deploy/terraform/gcp-cloudrun.auto.tfvars.json'), 'utf8'),
    ).toContain('"bootstrap_admin_email": "ops@acme.example"');

    const afterFirst = await snapshot(target);
    const second = await captured(() => runRenderCommand([target], offline));
    expect(second.result.every(({ status }) => status === 'unchanged')).toBe(true);
    expect(await snapshot(target)).toEqual(afterFirst);
  });

  it.each([
    ['gcp', 'gcp-cloudrun', 'https://agents.acme.example/', 'https://agents.acme.example'],
    [
      'azure',
      'azure-container-apps',
      'https://agents.acme.example/a2a?x=1',
      'https://agents.acme.example',
    ],
    [
      'gcp',
      'gcp-cloudrun',
      'https://agents.acme.example:8443/',
      'https://agents.acme.example:8443',
    ],
  ] as const)(
    'renders the origin of a %s AW_PUBLIC_URL of %s, so a slash or path cannot fail terraform plan',
    async (cloud, module, written, origin) => {
      const target = await project(cloud);
      await editFile(path.join(target, '.env'), (env) => `${env}AW_PUBLIC_URL=${written}\n`);

      await captured(() => runRenderCommand([target], offline));

      expect(
        await readFile(path.join(target, `deploy/terraform/${module}.auto.tfvars.json`), 'utf8'),
      ).toContain(`"public_url": "${origin}"`);
      if (cloud === 'gcp') {
        expect(await readFile(path.join(target, 'deploy/helm/values.yaml'), 'utf8')).toContain(
          `publicUrl: ${origin}`,
        );
      }
    },
  );

  it('leaves an AW_PUBLIC_URL that is not a URL as written, for the module to refuse', async () => {
    const target = await project('gcp');
    await editFile(path.join(target, '.env'), (env) => `${env}AW_PUBLIC_URL=not a url\n`);

    await captured(() => runRenderCommand([target], offline));

    expect(
      await readFile(path.join(target, 'deploy/terraform/gcp-cloudrun.auto.tfvars.json'), 'utf8'),
    ).toContain('"public_url": "not a url"');
  });

  it('restores compose.yaml from the template create copies, and never deletes a file', async () => {
    const target = await project('local');
    const compose = path.join(target, 'compose.yaml');
    const original = await readFile(compose, 'utf8');
    const untouched = path.join(target, 'notes.md');
    await writeFile(untouched, 'mine\n', 'utf8');

    await editFile(compose, (contents) => `${contents}# a hand edit\n`);
    const edited = await captured(() => runRenderCommand([target], offline));
    expect(edited.result.find(({ path: file }) => file === 'compose.yaml')?.status).toBe('updated');
    expect(await readFile(compose, 'utf8')).toBe(original);

    await rm(compose);
    const deleted = await captured(() => runRenderCommand([target], offline));
    expect(deleted.result.find(({ path: file }) => file === 'compose.yaml')?.status).toBe(
      'created',
    );
    expect(deleted.output).toContain('created    compose.yaml');
    expect(await readFile(compose, 'utf8')).toBe(original);
    expect(await readFile(untouched, 'utf8')).toBe('mine\n');
  });

  it('rewrites only the image lines of .env, keeps every other line, and prints no value', async () => {
    const target = await project('local');
    const envFile = path.join(target, '.env');
    await editFile(envFile, (env) => `${env}# my own settings\nMY_KEY=keep-me\n`);
    const before = await readFile(envFile, 'utf8');
    const patched = `registry.example/web@${digest('9')}`;

    const { output } = await captured(() =>
      runRenderCommand([target], { environment: { AW_WEB_IMAGE: patched } }),
    );

    const after = await readFile(envFile, 'utf8');
    const beforeLines = before.split('\n');
    const afterLines = after.split('\n');
    expect(afterLines).toHaveLength(beforeLines.length);
    const differing = afterLines.filter((line, index) => line !== beforeLines[index]);
    expect(differing).toEqual([`WEB_IMAGE=${patched}`]);
    expect(after).toContain('MY_KEY=keep-me\n');
    expect((await stat(envFile)).mode & 0o777).toBe(0o600);

    // Not one value from .env — before or after, secrets and digests alike — reaches the output.
    const values = [
      ...Object.values(parseEnvironment(before)),
      ...Object.values(parseEnvironment(after)),
    ].filter((value) => value.length >= 6);
    expect(values.length).toBeGreaterThan(5);
    for (const value of values) expect(output).not.toContain(value);
    expect(output).toContain('updated    .env');
  });

  it('keeps CRLF line endings and inserts a missing image key after the others', async () => {
    const target = await project('gcp');
    const envFile = path.join(target, '.env');
    await editFile(envFile, (env) =>
      env
        .split('\n')
        .filter((line) => !line.startsWith('RUNNER_IMAGE='))
        .join('\r\n'),
    );

    const runner = { environment: { AW_RUNNER_IMAGE: images.runner } };
    await captured(() => runRenderCommand([target], runner));

    const contents = await readFile(envFile, 'utf8');
    expect(contents.replaceAll('\r\n', '')).not.toContain('\n');
    const lines = contents.split('\r\n');
    const runtime = lines.findIndex((line) => line.startsWith('AGENT_WORKSPACE_RUNTIME_IMAGE_'));
    expect(lines[runtime + 1]).toBe(`RUNNER_IMAGE=${images.runner}`);

    const again = await captured(() => runRenderCommand([target], offline));
    expect(again.result.every(({ status }) => status === 'unchanged')).toBe(true);
  });

  it('refuses a malformed .env line by number without quoting it, and writes nothing', async () => {
    const target = await project('gcp');
    await editFile(path.join(target, '.env'), (env) => `${env}hunter2-secret-line\n`);
    await editFile(path.join(target, 'agent-workspace.yaml'), (profile) =>
      profile.replace('gcs://acme-ai-files', 'gcs://acme-ai-archive'),
    );
    const before = await snapshot(target);
    const stderr: string[] = [];

    const code = await runAsProcess(
      () => runRenderCommand([target], offline).then(() => undefined),
      (chunk) => stderr.push(chunk),
    );

    expect(code).toBe(1);
    expect(stderr.join('')).toMatch(/\.env line \d+ is not a comment or NAME=value/u);
    expect(stderr.join('')).not.toContain('hunter2');
    expect(await snapshot(target)).toEqual(before);
  });

  it('--check exits non-zero on drift and writes nothing', async () => {
    const target = await project('local');
    await editFile(path.join(target, 'compose.yaml'), (contents) => `${contents}# drift\n`);
    await editFile(path.join(target, '.env'), (env) =>
      env.replace(`WEB_IMAGE=${images.web}`, `WEB_IMAGE=registry.example/web@${digest('8')}`),
    );
    const before = await snapshot(target);
    const stderr: string[] = [];

    const { result: code, output } = await captured(() =>
      runAsProcess(
        () =>
          runRenderCommand([target, '--check'], { environment: { AW_WEB_IMAGE: images.web } }).then(
            () => undefined,
          ),
        (chunk) => stderr.push(chunk),
      ),
    );

    expect(code).toBe(1);
    expect(output).toContain('would update  compose.yaml');
    expect(output).toContain('would update  .env');
    expect(stderr.join('')).toContain('2 files would change');
    expect(stderr.join('')).toContain('Nothing was written');
    expect(await snapshot(target)).toEqual(before);
  });

  it('--check passes on a project that matches its profile', async () => {
    const target = await project('aws');
    const { result: code } = await captured(() =>
      runAsProcess(() => runRenderCommand([target, '--check'], offline).then(() => undefined)),
    );
    expect(code).toBe(0);
  });

  it('refuses a profile with an unsupported key, naming its line, and writes nothing', async () => {
    const target = await project('local');
    await editFile(path.join(target, 'agent-workspace.yaml'), (profile) =>
      profile.replace('storage:\n', 'storage:\n  unknown: x\n'),
    );
    await rm(path.join(target, 'compose.yaml'));
    const before = await snapshot(target);
    const line = (await readFile(path.join(target, 'agent-workspace.yaml'), 'utf8'))
      .split('\n')
      .indexOf('  unknown: x');

    await expect(captured(() => runRenderCommand([target], offline))).rejects.toThrow(
      `agent-workspace.yaml line ${String(line + 1)}, column 3: storage.unknown is not a field`,
    );
    expect(await snapshot(target)).toEqual(before);
  });

  it('refuses a YAML construct the reader does not accept, and writes nothing', async () => {
    const target = await project('gcp');
    await editFile(path.join(target, 'agent-workspace.yaml'), (profile) =>
      profile.replace('cloud: gcp', 'cloud: &c gcp'),
    );
    await rm(path.join(target, 'deploy/helm/values.yaml'));
    const before = await snapshot(target);

    await expect(captured(() => runRenderCommand([target], offline))).rejects.toThrow(/line \d+/u);
    expect(await snapshot(target)).toEqual(before);
  });

  it('rewrites an `export NAME=` image line in place, keeping its inline comment', async () => {
    const target = await project('local');
    const envFile = path.join(target, '.env');
    await editFile(envFile, (env) =>
      env
        .replace(`WEB_IMAGE=${images.web}`, `export WEB_IMAGE=${images.web}`)
        .replace(`GATEWAY_IMAGE=${images.gateway}`, `GATEWAY_IMAGE=${images.gateway}  # pinned`),
    );

    // The commented pin passes the digest gate as it stands: nothing changes.
    const pinned = await captured(() => runRenderCommand([target], offline));
    expect(pinned.result.every(({ status }) => status === 'unchanged')).toBe(true);

    const patchedWeb = `registry.example/web@${digest('9')}`;
    const patchedGateway = `registry.example/gateway@${digest('8')}`;
    await captured(() =>
      runRenderCommand([target], {
        environment: { AW_WEB_IMAGE: patchedWeb, AW_GATEWAY_IMAGE: patchedGateway },
      }),
    );

    const lines = (await readFile(envFile, 'utf8')).split('\n');
    expect(lines.filter((line) => line.includes('WEB_IMAGE='))).toEqual([
      `export WEB_IMAGE=${patchedWeb}`,
    ]);
    expect(lines.filter((line) => line.includes('GATEWAY_IMAGE='))).toEqual([
      `GATEWAY_IMAGE=${patchedGateway}  # pinned`,
    ]);
    const again = await captured(() => runRenderCommand([target], offline));
    expect(again.result.every(({ status }) => status === 'unchanged')).toBe(true);
  });

  it('replaces a file without leaving a temporary file, and keeps its mode', async () => {
    const target = await project('gcp');
    const variables = path.join(target, 'deploy/terraform/gcp-cloudrun.auto.tfvars.json');
    await chmod(variables, 0o640);
    await editFile(path.join(target, 'agent-workspace.yaml'), (profile) =>
      profile.replace('bootstrapAdmin: admin@localhost.test', 'bootstrapAdmin: ops@acme.example'),
    );

    await captured(() => runRenderCommand([target], { environment: { AW_WEB_IMAGE: images.web } }));

    expect(await readFile(variables, 'utf8')).toContain('ops@acme.example');
    expect((await stat(variables)).mode & 0o777).toBe(0o640);
    expect((await stat(path.join(target, '.env'))).mode & 0o777).toBe(0o600);
    const entries = await readdir(target, { recursive: true });
    expect(entries.filter((entry) => entry.endsWith('.tmp'))).toEqual([]);
  });

  it.each([
    ['.env', 'local'],
    ['compose.yaml', 'local'],
    ['deploy', 'gcp'],
  ] as const)(
    'refuses a symbolic link at %s, writes nothing, and leaves the link target alone',
    async (owned, cloud) => {
      const target = await project(cloud);
      const outside = path.join(path.dirname(target), 'outside');
      await rename(path.join(target, owned), outside);
      await symlink(outside, path.join(target, owned));
      if (owned === 'compose.yaml') await writeFile(outside, '# not the template\n');
      await editFile(path.join(target, 'agent-workspace.yaml'), (profile) =>
        profile.replace('bootstrapAdmin: admin@localhost.test', 'bootstrapAdmin: ops@acme.example'),
      );
      const outsideBefore =
        owned === 'deploy' ? await snapshot(outside) : await readFile(outside, 'utf8');
      const before = await snapshot(target);

      await expect(
        captured(() =>
          runRenderCommand([target], {
            environment: { AW_WEB_IMAGE: `registry.example/web@${digest('9')}` },
          }),
        ),
      ).rejects.toThrow(`${owned} is a symbolic link; render writes only regular files`);

      expect(await snapshot(target)).toEqual(before);
      expect(
        owned === 'deploy' ? await snapshot(outside) : await readFile(outside, 'utf8'),
      ).toEqual(outsideBefore);
    },
  );

  it('lists what an earlier profile left in place, without values, and deletes nothing', async () => {
    const target = await project('gcp');
    const legacyRuntime = `registry.example/legacy-runtime@${digest('7')}`;
    const postgres = `registry.example/postgres@${digest('5')}`;
    await writeFile(path.join(target, 'compose.yaml'), '# from when this project was local\n');
    await writeFile(
      path.join(target, 'deploy/terraform/azure-container-apps.auto.tfvars.json'),
      '{}\n',
    );
    await editFile(
      path.join(target, '.env'),
      (env) =>
        `${env}POSTGRES_IMAGE=${postgres}\nRUNTIME_IMAGE=${legacyRuntime}\n` +
        `RUNTIME_IMAGE=${legacyRuntime}\n`,
    );
    const before = await snapshot(target);

    const { result: code, output } = await captured(() =>
      runAsProcess(() => runRenderCommand([target, '--check'], offline).then(() => undefined)),
    );

    expect(code).toBe(0);
    expect(output).toContain(
      'Left in place (render no longer writes these and never deletes them; remove them once ' +
        'nothing uses them):\n' +
        '  compose.yaml\n' +
        '  deploy/terraform/azure-container-apps.auto.tfvars.json\n' +
        '  .env key POSTGRES_IMAGE\n' +
        '  .env key RUNTIME_IMAGE\n',
    );
    expect(output).not.toContain(legacyRuntime);
    expect(output).not.toContain(postgres);
    await captured(() => runRenderCommand([target], offline));
    expect(await snapshot(target)).toEqual(before);
  });

  it.each(['local', 'gcp', 'aws', 'azure'] as const)(
    'lists nothing left in place on a freshly created %s project',
    async (cloud) => {
      const target = await project(cloud);
      const { output } = await captured(() => runRenderCommand([target], offline));
      expect(output).not.toContain('Left in place');
    },
  );

  it('refuses a directory with no profile or no .env, by file name', async () => {
    const target = await project('gcp');
    await rm(path.join(target, '.env'));
    await expect(runRenderCommand([target], offline)).rejects.toThrow('.env was not found in');
    await rm(path.join(target, 'agent-workspace.yaml'));
    await expect(runRenderCommand([target], offline)).rejects.toThrow(
      'agent-workspace.yaml was not found in',
    );
  });

  /** #496: the refusals name the command that generates a Compose project, not the v1 name. */
  it('points a directory with no profile or no .env at create --cloud local', async () => {
    const target = await project('local');
    await rm(path.join(target, '.env'));
    const noEnv = runRenderCommand([target], offline);
    await expect(noEnv).rejects.toThrow(
      '`npm create @indx-workspace <directory> -- --cloud local`',
    );
    await expect(noEnv).rejects.not.toThrow(/create-agent-workspace/u);
    await rm(path.join(target, 'agent-workspace.yaml'));
    const noProfile = runRenderCommand([target], offline);
    await expect(noProfile).rejects.toThrow(
      'the Compose project `npm create @indx-workspace <directory> -- --cloud local` generates',
    );
    await expect(noProfile).rejects.not.toThrow(/create-agent-workspace/u);
  });
});
