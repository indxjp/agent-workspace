import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { ENGINE_IDS } from '@indx-workspace/contracts/engines';
import { MODEL_PROVIDERS } from '@indx-workspace/contracts/runs';
import {
  SETUP_QUESTIONS,
  SETUP_SANDBOX_CHOICES,
  SETUP_THEMES,
  setupQuestionApplies,
} from '@indx-workspace/contracts/setup';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { errorCode } from '../cli-failure.ts';
import { DEFAULT_ANSWERS, TEMPLATES_DIRECTORY, runAsProcess, runCreateCommand } from '../create.ts';
import type { GeneratorAnswers } from '../create.ts';
import type { DeploymentImages } from '../deployment.ts';
import { CLI_VERSION } from '../version.ts';

// The v1 secrets are random; fixed bytes make them, and every file that carries one, repeatable.
vi.mock('node:crypto', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:crypto')>()),
  randomBytes: (size: number) => Buffer.alloc(size, 7),
}));

// The group of /var/run/docker.sock is a property of the host, not of `create`.
vi.mock('../deployment.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../deployment.ts')>()),
  dockerSocketGroupId: () => Promise.resolve(0),
}));

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

interface CreateRecord {
  readonly argv: readonly string[];
  readonly exit: number;
  readonly exitCode: number | undefined;
  readonly stdout: string;
  readonly stderr: string;
  readonly files: Readonly<Record<string, string>>;
}

interface Row {
  readonly name: string;
  /** The arguments after the target; a row without `target` passes only these. */
  readonly argv: readonly string[];
  readonly target?: false;
  readonly images?: DeploymentImages;
  readonly answers?: GeneratorAnswers;
}

const YES = ['--yes', '--no-install'];
const modelBaseUrl = SETUP_QUESTIONS.find((question) => question.id === 'admin.modelBaseUrl');
if (modelBaseUrl === undefined) throw new Error('the admin.modelBaseUrl question is gone');

const rows: readonly Row[] = [
  ...SETUP_THEMES.flatMap((theme) =>
    ENGINE_IDS.map((engine) => ({
      name: `theme ${theme} with engine ${engine}`,
      argv: [...YES, '--theme', theme, '--engine', engine],
    })),
  ),
  ...MODEL_PROVIDERS.map((provider) => ({
    name: `provider ${provider}`,
    argv: [
      ...YES,
      '--provider',
      provider,
      ...(setupQuestionApplies(modelBaseUrl, { 'admin.modelProvider': provider })
        ? ['--model-base-url', 'https://models.example.test/']
        : []),
    ],
  })),
  ...SETUP_SANDBOX_CHOICES.map((sandbox) => ({
    name: `sandbox ${sandbox}`,
    argv: [...YES, '--sandbox', sandbox],
  })),
  {
    name: 'tools openapi and postgres',
    argv: [...YES, '--tools', 'openapi,postgres', '--openapi', 'openapi.json'],
  },
  {
    name: 'every permission',
    argv: [...YES, '--permissions', 'readFiles,writeFiles,runCommands,unrestrictedNetwork'],
  },
  {
    name: 'automation theme with an openapi tool',
    argv: [...YES, '--theme', 'automation', '--tools', 'openapi', '--openapi', 'delivery.json'],
  },
  { name: 'cloud local, default answers', argv: ['--cloud', 'local'], answers: DEFAULT_ANSWERS },
  {
    name: 'cloud local, SeaweedFS',
    argv: ['--cloud', 'local'],
    answers: { ...DEFAULT_ANSWERS, storage: 'SeaweedFS' },
  },
  ...(['aws', 'gcp', 'azure', 'vercel', 'cloudflare'] as const).map((cloud) => ({
    name: `cloud ${cloud}`,
    argv: ['--cloud', cloud],
    images: cloudImages,
  })),
  { name: 'help', argv: ['--help'], target: false },
  {
    name: 'refusal: --cloud azure --yes',
    argv: ['--cloud', 'azure', '--yes'],
    images: cloudImages,
  },
  { name: 'refusal: unknown theme', argv: ['--theme', 'nope'] },
];

async function filesUnder(root: string, directory = root): Promise<readonly string[]> {
  const found: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...(await filesUnder(root, entryPath)));
    else found.push(path.relative(root, entryPath).split(path.sep).join('/'));
  }
  return found;
}

let parent: string;

beforeEach(async () => {
  parent = await mkdtemp(path.join(os.tmpdir(), 'create-snapshot-'));
  vi.stubEnv('npm_config_user_agent', 'npm/11.0.0 node/v24.0.0 linux x64');
  vi.stubEnv('NO_COLOR', '1');
  for (const key of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'AZURE_OPENAI_API_KEY']) {
    vi.stubEnv(key, 'set');
  }
});

afterEach(async () => {
  process.exitCode = undefined;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(parent, { recursive: true });
});

describe('create output', () => {
  it.each(rows)('$name', async (row) => {
    const target = path.join(parent, 'acme-ai');
    const argv = row.target === false ? [...row.argv] : [target, ...row.argv];

    const normalise = (text: string): string =>
      text
        .replaceAll(parent, '<parent>')
        .replaceAll(parent.split(path.sep).join('/'), '<parent>')
        .replaceAll(CLI_VERSION, '<version>');
    const captured = { stdout: '', stderr: '' };
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      captured.stdout += String(chunk);
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      captured.stderr += String(chunk);
      return true;
    });

    const exit = await runAsProcess(() =>
      runCreateCommand(argv, {
        run: () => Promise.resolve(0),
        platform: 'linux',
        images: row.images ?? images,
        ...(row.answers === undefined ? {} : { answers: row.answers }),
      }),
    );
    const exitCode = typeof process.exitCode === 'number' ? process.exitCode : undefined;
    process.exitCode = undefined;
    vi.restoreAllMocks();

    const files: Record<string, string> = {};
    const written = await filesUnder(target).catch((error: unknown) => {
      if (errorCode(error) === 'ENOENT') return [];
      throw error;
    });
    for (const file of [...written].sort()) {
      const contents = normalise(await readFile(path.join(target, file), 'utf8'));
      files[file] = createHash('sha256').update(contents).digest('hex');
    }

    const record: CreateRecord = {
      argv: argv.map((argument) => (argument === target ? '<parent>/acme-ai' : argument)),
      exit,
      exitCode,
      stdout: normalise(captured.stdout.replaceAll('\r\n', '\n')),
      stderr: normalise(captured.stderr.replaceAll('\r\n', '\n')),
      files,
    };
    expect(record).toMatchSnapshot();
  });

  it('TEMPLATES_DIRECTORY is the CLI package templates directory', async () => {
    const cliPackage = fileURLToPath(new URL('../../', import.meta.url));
    expect(TEMPLATES_DIRECTORY.href).toBe(
      pathToFileURL(path.join(cliPackage, 'templates') + path.sep).href,
    );
    expect((await readdir(fileURLToPath(TEMPLATES_DIRECTORY))).length).toBeGreaterThan(0);
  });

  it('every exported name of ./create is still exported', async () => {
    expect(Object.keys(await import('../create.ts')).sort()).toEqual([
      'DEFAULT_ANSWERS',
      'DEFAULT_TARGET',
      'PACKAGE_MANAGERS',
      'TEMPLATES_DIRECTORY',
      'collectGeneratorAnswers',
      'createHelp',
      'createProject',
      'createWorkspace',
      'detectPackageManager',
      'isMainModule',
      'nextStepLines',
      'packageManagerSpawn',
      'parseCreateArguments',
      'pinCliDependency',
      'runAsProcess',
      'runCreateCommand',
      'shellArgument',
      'spawnInProject',
    ]);
  });
});
