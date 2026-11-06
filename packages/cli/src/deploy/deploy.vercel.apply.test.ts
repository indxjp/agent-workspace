import { access, readFile, writeFile } from 'node:fs/promises';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { parseEnvironment } from '../deployment.js';
import { runDeployCommand } from './command.js';
import type { ToolInvocation } from './runner.js';
import {
  captured,
  capturedFailure,
  databaseUrl,
  secretsOf,
  stubRunner,
} from './deploy.test-support.js';
import {
  changesOf,
  platform,
  token,
  vercelEnvironment,
  vercelProject,
  vercelResponder,
} from './deploy.vercel.test-support.js';

const stepsOf = (calls: readonly ToolInvocation[]) =>
  calls.map(({ tool, args }) => `${tool} ${args[0] ?? ''} ${args[1] ?? ''}`.trim());

interface IndexedCall {
  readonly call: ToolInvocation;
  readonly index: number;
}

const vercelDeploysIn = (calls: readonly ToolInvocation[]): IndexedCall[] =>
  calls
    .map((call, index) => ({ call, index }))
    .filter(({ call }) => call.tool === 'vercel' && call.args[0] === 'deploy');

/** Every project is configured, the migration runs once, and only then do the three deploy. */
function expectMigrationBetweenConfigurationAndDeploys(calls: readonly ToolInvocation[]) {
  const steps = stepsOf(calls);
  const dockerAt = steps.findIndex((step) => step.startsWith('docker'));
  const deploys = vercelDeploysIn(calls);
  expect(steps.slice(0, 3)).toEqual([
    'vercel project inspect',
    'vercel project inspect',
    'vercel project inspect',
  ]);
  expect(steps.filter((step) => step.startsWith('docker'))).toHaveLength(1);
  expect(dockerAt).toBeGreaterThan(steps.lastIndexOf('vercel env add MASTER_ENCRYPTION_KEY'));
  expect(dockerAt).toBeGreaterThan(steps.lastIndexOf('vercel project add'));
  expect(deploys.map(({ call }) => call.env['VERCEL_PROJECT_ID'])).toEqual([
    'acme-ai-gateway',
    'acme-ai-manager',
    'acme-ai',
  ]);
  expect(deploys.every(({ index }) => index > dockerAt)).toBe(true);
  expect(deploys.at(-1)?.index).toBe(calls.length - 1);
  return { dockerAt, deploys };
}

function expectMigrationCall(
  migrate: ToolInvocation | undefined,
  env: Readonly<Record<string, string | undefined>>,
) {
  expect(migrate?.args).toEqual([
    'run',
    '--rm',
    '-e',
    'DATABASE_URL',
    '-e',
    'BOOTSTRAP_ADMIN',
    '-e',
    'WORKSPACE_SLUG',
    '-e',
    'WORKSPACE_NAME',
    env['WEB_IMAGE'] ?? 'unset',
    'sh',
    '-c',
    'node /srv/packages/core/dist/db/migrate.js && node /srv/packages/core/dist/db/seed.js',
  ]);
  expect(migrate?.env['DATABASE_URL']).toBe(databaseUrl);
  expect(migrate?.env['BOOTSTRAP_ADMIN']).toBe(env['BOOTSTRAP_ADMIN']);
}

/** Each deploy runs from a staged copy, with the project's own config, and the copy is removed. */
async function expectStagedDeploys(deploys: readonly IndexedCall[], target: string) {
  for (const [index, name] of [
    [0, 'gateway'],
    [1, 'manager'],
    [2, 'vercel'],
  ] as const) {
    const staged = String(deploys[index]?.call.args[2]);
    expect(staged).not.toBe(platform);
    expect(deploys[index]?.call.args).toEqual([
      'deploy',
      '--cwd',
      staged,
      '--archive=tgz',
      '--prod',
      '--yes',
      '--scope',
      'team_acme',
      '--local-config',
      path.join(target, 'deploy', 'vercel', `${name}.json`),
    ]);
    expect(deploys[index]?.call.env['VERCEL_TOKEN']).toBe(token);
    await expect(access(staged)).rejects.toThrow();
  }
}

/**
 * Each upload holds the package its part builds and none of the checkout's dependencies, VCS
 * data or caches; a part does not carry the packages it does not build.
 */
function expectUploadContents(uploads: readonly (readonly string[])[]) {
  const [gateway = [], manager = [], controlPlane = []] = uploads;
  for (const upload of uploads) {
    expect(
      upload.filter((entry) => /(^|[\\/])(node_modules|\.git|\.nx)([\\/]|$)/u.test(entry)),
    ).toEqual([]);
  }
  expect(gateway).toContain(path.join('packages', 'gateway', 'src', 'index.ts'));
  expect(manager).not.toContain(path.join('packages', 'gateway', 'src', 'index.ts'));
  expect(controlPlane).toContain(path.join('packages', 'gateway', 'src', 'index.ts'));
  expect(controlPlane).toContain(path.join('apps', 'web', 'package.json'));

  // The gateway and the manager find their function at the upload root, where `functions` points.
  expect(gateway).toContain(path.join('api', 'index.js'));
  expect(manager).toContain(path.join('api', 'index.js'));
  expect(controlPlane).not.toContain(path.join('api', 'index.js'));
}

function deployOrderCase(): void {
  it('configures every project, migrates once, then deploys the gateway, the manager and the control plane', async () => {
    const target = await vercelProject();
    const env = parseEnvironment(await readFile(path.join(target, '.env'), 'utf8'));
    const uploads: string[][] = [];
    const { runner, calls } = stubRunner((invocation) => {
      if (invocation.args[0] === 'deploy') {
        uploads.push(readdirSync(String(invocation.args[2]), { recursive: true }).map(String));
      }
      return vercelResponder(false)(invocation);
    });

    await captured(() =>
      runDeployCommand([target, '--yes'], { runner, environment: vercelEnvironment }),
    );

    const { dockerAt, deploys } = expectMigrationBetweenConfigurationAndDeploys(calls);
    expectMigrationCall(calls[dockerAt], env);
    await expectStagedDeploys(deploys, target);
    expectUploadContents(uploads);
  });
}

function projectCreationCases(): void {
  it('creates the project and adds each variable with its value on stdin only', async () => {
    const target = await vercelProject();
    const env = parseEnvironment(await readFile(path.join(target, '.env'), 'utf8'));
    const { runner, calls } = stubRunner(vercelResponder(false));

    const { result } = await captured(() =>
      runDeployCommand([target, '--yes'], { runner, environment: vercelEnvironment }),
    );

    expect(result).toEqual({ changes: true, applied: true });
    const created = calls.filter(({ args }) => args[0] === 'project' && args[1] === 'add');
    expect(created.map(({ args }) => args)).toEqual([
      ['project', 'add', 'acme-ai-gateway', '--scope', 'team_acme'],
      ['project', 'add', 'acme-ai-manager', '--scope', 'team_acme'],
      ['project', 'add', 'acme-ai', '--scope', 'team_acme'],
    ]);

    const added = changesOf(calls);
    const master = added.find(({ args }) => args[2] === 'MASTER_ENCRYPTION_KEY');
    expect(master?.args).toEqual([
      'env',
      'add',
      'MASTER_ENCRYPTION_KEY',
      'production',
      '--sensitive',
      '--yes',
      '--scope',
      'team_acme',
    ]);
    expect(master?.input).toBe(env['MASTER_ENCRYPTION_KEY']);
    expect(added.find(({ args }) => args[2] === 'CRON_SECRET')?.args).toContain('--sensitive');
    expect(added.find(({ args }) => args[2] === 'CRON_SECRET')?.input).toBe(env['CRON_SECRET']);
    for (const call of calls) {
      for (const secret of await secretsOf(target))
        expect(call.args.join(' ')).not.toContain(secret);
      expect(call.args.join(' ')).not.toContain(token);
    }
    expect(added.map(({ args }) => args[2])).not.toContain('COMPOSE_PROJECT_NAME');
  });
}

function awsKeyCases(): void {
  it.each([
    ['maps the object storage key pair to AWS_*', '', 'object-key', 'object-secret'],
    [
      'lets an explicit AWS_* win',
      'AWS_ACCESS_KEY_ID=aws-key\nAWS_SECRET_ACCESS_KEY=aws-secret\n',
      'aws-key',
      'aws-secret',
    ],
  ])('%s, the secret as encrypted env that is never printed', async (_, explicit, id, secret) => {
    const target = await vercelProject();
    const file = path.join(target, '.env');
    const text = (await readFile(file, 'utf8'))
      .replace(/^OBJECT_STORAGE_ACCESS_KEY_ID=.*$/mu, 'OBJECT_STORAGE_ACCESS_KEY_ID=object-key')
      .replace(
        /^OBJECT_STORAGE_SECRET_ACCESS_KEY=.*$/mu,
        'OBJECT_STORAGE_SECRET_ACCESS_KEY=object-secret',
      );
    await writeFile(file, `${text}${explicit}`);
    const { runner, calls } = stubRunner(vercelResponder(false));

    const { output } = await captured(() =>
      runDeployCommand([target, '--yes'], { runner, environment: vercelEnvironment }),
    );

    const added = (project: string, name: string) =>
      changesOf(calls).find(
        ({ args, env }) => args[2] === name && env['VERCEL_PROJECT_ID'] === project,
      );
    expect(added('acme-ai', 'AWS_ACCESS_KEY_ID')?.input).toBe(id);
    expect(added('acme-ai', 'AWS_SECRET_ACCESS_KEY')?.input).toBe(secret);
    expect(added('acme-ai', 'AWS_SECRET_ACCESS_KEY')?.args).toContain('--sensitive');
    expect(added('acme-ai-gateway', 'AWS_ACCESS_KEY_ID')).toBeUndefined();
    expect(added('acme-ai-manager', 'AWS_SECRET_ACCESS_KEY')).toBeUndefined();
    for (const call of calls) expect(call.args.join(' ')).not.toMatch(/object-|aws-/u);
    expect(output).not.toMatch(/object-secret|aws-secret/u);
  });
}

function leftAsIsCases(): void {
  it('adds only the missing variables, and names the ones it leaves as they are', async () => {
    const target = await vercelProject();
    const env = parseEnvironment(await readFile(path.join(target, '.env'), 'utf8'));
    const { runner, calls } = stubRunner(vercelResponder(true, ['SESSION_SECRET', 'CRON_SECRET']));

    const { result, output } = await captured(() =>
      runDeployCommand([target, '--yes'], { runner, environment: vercelEnvironment }),
    );

    expect(result).toEqual({ changes: true, applied: true });
    const added = changesOf(calls).map(({ args }) => args[2]);
    expect(added).not.toContain('SESSION_SECRET');
    expect(added).not.toContain('CRON_SECRET');
    expect(added).toContain('MASTER_ENCRYPTION_KEY');
    expect(output).toContain(
      'Left as they are in acme-ai (their values are not compared): SESSION_SECRET, CRON_SECRET.',
    );
    expect(output).toContain('vercel env rm <NAME> production');
    expect(output).not.toContain(env['SESSION_SECRET'] ?? 'unset');
    expect(output).not.toContain(env['CRON_SECRET'] ?? 'unset');
  });

  it('says nothing about left-as-is variables when the project has none of them', async () => {
    const target = await vercelProject();
    const { runner } = stubRunner(vercelResponder(false));

    const { output } = await captured(() =>
      runDeployCommand([target, '--yes'], { runner, environment: vercelEnvironment }),
    );

    expect(output).not.toContain('Left as they are');
  });
}

function rootDirectoryCase(): void {
  it('sets the Root Directory of each platform project before it deploys, and not the frontend', async () => {
    const target = await vercelProject();
    const { runner, calls } = stubRunner(vercelResponder(false));

    await captured(() =>
      runDeployCommand([target, '--yes'], { runner, environment: vercelEnvironment }),
    );

    const patches = calls.filter(({ args }) => args[0] === 'api');
    expect(patches.map(({ env }) => env['VERCEL_PROJECT_ID'])).toEqual([
      'acme-ai-gateway',
      'acme-ai-manager',
      'acme-ai',
    ]);
    expect(patches.map(({ input }) => JSON.parse(input ?? 'null') as unknown)).toEqual([
      { rootDirectory: null },
      { rootDirectory: null },
      { rootDirectory: 'apps/web', sourceFilesOutsideRootDirectory: true },
    ]);
    for (const patch of patches) {
      expect(patch.tool).toBe('vercel');
      expect(patch.args[1]).toBe(
        `/v9/projects/${patch.env['VERCEL_PROJECT_ID'] ?? ''}?teamId=team_acme`,
      );
      expect(patch.args.slice(2)).toEqual(['-X', 'PATCH', '--input', '-', '--scope', 'team_acme']);
      expect(patch.args.join(' ')).not.toContain(token);
    }
    // Each project's Root Directory is set before any of its variables is written.
    for (const patch of patches) {
      const firstEnvAdd = calls.findIndex(
        ({ args, env }) =>
          args[0] === 'env' &&
          args[1] === 'add' &&
          env['VERCEL_PROJECT_ID'] === patch.env['VERCEL_PROJECT_ID'],
      );
      expect(firstEnvAdd).toBeGreaterThan(calls.indexOf(patch));
    }
    const lastPatch = calls.map(({ args }) => args[0]).lastIndexOf('api');
    expect(lastPatch).toBeLessThan(calls.findIndex(({ args }) => args[0] === 'deploy'));
  });
}

function migrationAndTokenCases(): void {
  it('keeps the database URL and the token out of every argument and every line of output', async () => {
    const target = await vercelProject();
    const { runner, calls } = stubRunner(vercelResponder(false, [], `${databaseUrl} ${token}`));

    const { output } = await captured(() =>
      runDeployCommand([target, '--yes'], { runner, environment: vercelEnvironment }),
    );

    for (const call of calls) {
      expect(call.args.join(' ')).not.toContain('np_secret_pw');
      expect(call.args.join(' ')).not.toContain(token);
    }
    expect(output).not.toContain('np_secret_pw');
    expect(output).not.toContain(token);
  });

  it('stops before vercel deploy when the migration fails', async () => {
    const target = await vercelProject();
    const respond = vercelResponder(false);
    const { runner, calls } = stubRunner((invocation) =>
      invocation.tool === 'docker'
        ? { status: 1, stderr: `error: connect ECONNREFUSED ${databaseUrl}` }
        : respond(invocation),
    );

    const { message, output } = await capturedFailure(() =>
      runDeployCommand([target, '--yes'], { runner, environment: vercelEnvironment }),
    );

    expect(message).toContain('`docker run` failed (exit status 1)');
    expect(`${message}${output}`).not.toContain('np_secret_pw');
    expect(calls.some(({ tool, args }) => tool === 'vercel' && args[0] === 'deploy')).toBe(false);
  });

  it('hands the token to the tool through its environment and never prints it', async () => {
    const target = await vercelProject();
    const { runner, calls } = stubRunner(vercelResponder(false, [], token));

    const { output } = await captured(() =>
      runDeployCommand([target, '--yes'], { runner, environment: vercelEnvironment }),
    );

    expect(calls.every((call) => call.env['VERCEL_TOKEN'] === token)).toBe(true);
    expect(output).not.toContain(token);
  });
}

describe('agent-workspace deploy to Vercel', () => {
  projectCreationCases();
  awsKeyCases();
  leftAsIsCases();
  deployOrderCase();
  rootDirectoryCase();
  migrationAndTokenCases();
});
