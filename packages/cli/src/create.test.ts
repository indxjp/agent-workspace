import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SETUP_QUESTIONS,
  SETUP_THEMES,
  setupQuestionApplies,
  withRecommendedAnswers,
} from '@indx-workspace/contracts/setup';
import {
  askSetupQuestions,
  MenuCancelledError,
  projectNameFor,
  renderProjectFiles,
  renderProjectShell,
} from '@indx-workspace/sdk/project';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createAnswerFor } from '../../../tests/journey/harness.mjs';
import {
  createProject,
  createWorkspace,
  DEFAULT_ANSWERS,
  detectPackageManager,
  isMainModule,
  nextStepLines,
  packageManagerSpawn,
  parseCreateArguments,
  runAsProcess,
  runCreateCommand,
  shellArgument,
  spawnInProject,
  type CreateTerminal,
  type RunCreateCommandOptions,
  type RunInProject,
  type GeneratorAnswers,
} from './create.js';
import type { DeploymentImages } from './deployment.js';
import { runCli } from './index.js';
import { parseProfileDocument, PROFILE_SCHEMA_URL, PROJECT_KIND_REFUSAL } from './profile.js';
import type { ObjectStorePresence, ProfileProbes } from './validate.js';
import { CLI_VERSION } from './version.js';

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
/** What a cloud deployment pulls: the cloud supplies its own PostgreSQL and its own bucket. */
const cloudImages: DeploymentImages = {
  web: images.web,
  gateway: images.gateway,
  runner: images.runner,
  runtime: images.runtime,
};
const options = { images };

/** `runCreateCommand` with the package manager faked: no test installs or starts anything. */
const fakeRun: RunInProject = () => Promise.resolve(0);
function create(argv: readonly string[], overrides: RunCreateCommandOptions = {}): Promise<void> {
  return runCreateCommand([...argv], { run: fakeRun, platform: 'linux', ...overrides });
}

/** Everything the command wrote to stdout, so the operator-facing text can be asserted on. */
function captureStdout() {
  const written: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    written.push(String(chunk));
    return true;
  });
  return () => written.join('');
}

beforeEach(() => {
  // The package manager that ran `npm create`; the suite itself may run under pnpm.
  vi.stubEnv('npm_config_user_agent', 'npm/11.0.0 node/v24.0.0 linux x64');
});

afterEach(async () => {
  await Promise.all(created.splice(0).map((entry) => rm(entry, { recursive: true })));
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('createWorkspace', () => {
  it('writes an operational deployment contract for every selected dimension', async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), 'agent-workspace-generator-'));
    created.push(parent);
    const target = path.join(parent, 'example');
    await createWorkspace(
      target,
      {
        database: 'embedded PostgreSQL 17',
        storage: 'local filesystem',
        runtime: 'docker',
        authentication: 'local administrator',
      },
      options,
    );
    const compose = await readFile(path.join(target, 'compose.yaml'), 'utf8');
    const env = await readFile(path.join(target, '.env'), 'utf8');
    expect(compose).toContain('DATABASE_URL: ${DATABASE_URL:?set DATABASE_URL in .env}');
    expect(compose).toContain(
      'GATEWAY_TOKEN_SECRET: ${GATEWAY_TOKEN_SECRET:?set GATEWAY_TOKEN_SECRET in .env}',
    );
    expect(compose).toContain(
      'AW_SESSION_MIRROR_URL: ${AW_SESSION_MIRROR_URL:?set AW_SESSION_MIRROR_URL in .env}',
    );
    expect(compose).toContain('condition: service_healthy');
    await expect(readFile(path.join(target, 'package.json'), 'utf8')).resolves.toContain(
      'agent-workspace start',
    );
    // `.env` holds every generated secret, and the profile beside it holds none, so the project
    // has to arrive with the one of them that must never be committed already ignored.
    await expect(readFile(path.join(target, '.gitignore'), 'utf8')).resolves.toMatch(/^\.env$/mu);
    expect(env).toContain('DATABASE_URL=postgres://agent_workspace:');
    expect(env).toContain('AW_STORAGE_URL=file:///var/lib/agent-workspace');
    expect(env).toContain('RUNTIME_DRIVER=docker');
    expect(env).toContain(`WEB_IMAGE=${images.web}`);
    expect(env).toContain('BOOTSTRAP_ADMIN=admin@localhost.test');
    expect(env).not.toMatch(/^AW_(?:DATABASE|STORAGE|AUTHENTICATION)=/mu);
  });

  it('depends on the published CLI at its own version, and on nothing unpublished', async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), 'agent-workspace-generator-'));
    created.push(parent);
    const target = path.join(parent, 'example');
    await createWorkspace(
      target,
      {
        database: 'embedded PostgreSQL 17',
        storage: 'local filesystem',
        runtime: 'docker',
        authentication: 'local administrator',
      },
      options,
    );
    const cli = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
      name: string;
      version: string;
    };
    const text = await readFile(path.join(target, 'package.json'), 'utf8');
    const generated = JSON.parse(text) as {
      dependencies?: Record<string, string>;
      scripts?: Record<string, string>;
    };

    expect(generated.dependencies).toEqual({ '@indx-workspace/cli': cli.version });
    // #394: the project is stopped the way it is started, sandboxes included.
    expect(generated.scripts).toEqual({
      start: 'agent-workspace start',
      stop: 'agent-workspace stop',
    });
    expect(text).not.toMatch(/workspace:|@agent-workspace\//u);
  });

  it('ships templates that name no unpublished package or workspace specifier', async () => {
    const templates = new URL('../templates/', import.meta.url);
    for (const file of ['package.json', 'compose.yaml', 'pnpm-workspace.yaml']) {
      const text = await readFile(new URL(file, templates), 'utf8');
      expect(text, file).not.toMatch(/workspace:\*|@agent-workspace\//u);
    }
  });

  /**
   * `.env` holds the generated administrator password, the session, gateway and runner-manager
   * secrets and the master encryption key, and is the only entry in the rendered `.gitignore`.
   * A world-readable copy on a shared VM defeats both. Nothing else the generator writes holds a
   * credential, so nothing else is narrowed — a profile or a values file an operator cannot read
   * is its own failure.
   */
  it('writes .env to the owner alone, and leaves every other artefact at the default mode', async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), 'agent-workspace-generator-'));
    created.push(parent);
    const target = path.join(parent, 'modes');
    const { artefacts } = await createWorkspace(target, null, {
      images: cloudImages,
      cloud: 'gcp',
    });

    // The permission bits alone; the file-type bits above them are not this test's subject.
    const modeOf = async (file: string) => (await stat(file)).mode % 0o1000;
    // The mode an unremarkable write produces here, so the control is this host's umask rather
    // than an octal literal that a stricter one would make wrong.
    const control = path.join(parent, 'default-mode');
    await writeFile(control, '', 'utf8');

    expect(await modeOf(path.join(target, '.env'))).toBe(0o600);
    for (const artefact of artefacts.filter((file) => file !== '.env')) {
      expect(await modeOf(path.join(target, artefact)), artefact).toBe(await modeOf(control));
    }
  });

  it('creates a deploy state from the given profile and project name, owner-only (#621)', async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), 'agent-workspace-generator-'));
    created.push(parent);
    const target = path.join(parent, 'production');
    const profile = parseProfileDocument(
      await readFile(
        new URL('./deploy/fixtures/production-single-vm.profile.yaml', import.meta.url),
        'utf8',
      ),
    );

    const generated = await createWorkspace(target, null, {
      images,
      deployState: { profile, projectName: 'acme-ai' },
    });

    const env = await readFile(path.join(target, '.env'), 'utf8');
    expect(generated.profile).toEqual(profile);
    expect(env).toContain('BOOTSTRAP_ADMIN=owner@acme.example\n');
    expect(env).toContain('COMPOSE_PROJECT_NAME=acme-ai\n');
    expect((await stat(target)).mode % 0o1000).toBe(0o700);
    expect((await stat(path.join(target, '.env'))).mode % 0o1000).toBe(0o600);
  });

  it('turns the SeaweedFS selection into resolved object-storage configuration', async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), 'agent-workspace-generator-'));
    created.push(parent);
    const target = path.join(parent, 'seaweedfs');
    await createWorkspace(
      target,
      {
        database: 'PostgreSQL 17',
        storage: 'SeaweedFS',
        runtime: 'docker',
        authentication: 'local administrator',
      },
      options,
    );

    const env = await readFile(path.join(target, '.env'), 'utf8');
    // The bucket, endpoint and path style the old names gave it, so its objects stay where they are.
    expect(env).toContain(
      'AW_STORAGE_URL=s3://agent-workspace?endpoint=http://seaweedfs:8333&publicEndpoint=http://localhost:8333&pathStyle=true\n',
    );
    expect(env).toContain('AW_STORAGE_CREATE_BUCKET=true\n');
    expect(env).not.toContain('OBJECT_STORAGE_ENDPOINT=');
    expect(env).not.toContain('OBJECT_STORAGE_BUCKET=');
    expect(env).toContain('RUNTIME_DRIVER=docker');
  });

  it('rejects unsupported choices before creating a partial workspace', async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), 'agent-workspace-generator-'));
    created.push(parent);
    const supported: GeneratorAnswers = {
      database: 'PostgreSQL 17',
      storage: 'local filesystem',
      runtime: 'docker',
      authentication: 'local administrator',
    };
    const cases: readonly [string, GeneratorAnswers, RegExp][] = [
      ['database', { ...supported, database: 'SQLite' }, /Unsupported database/u],
      ['storage', { ...supported, storage: 'Azure Blob' }, /Unsupported storage/u],
      // ADR-0067: "MinIO" is refused with the answer that now means bundled S3, not substituted.
      [
        'storage-minio',
        { ...supported, storage: 'MinIO' },
        /no longer bundles MinIO[\s\S]*choose "SeaweedFS"/u,
      ],
      ['runtime', { ...supported, runtime: 'local' }, /Unsupported runtime/u],
      ['authentication', { ...supported, authentication: 'OIDC' }, /Unsupported authentication/u],
    ];

    for (const [dimension, answers, expected] of cases) {
      const target = path.join(parent, dimension);
      await expect(createWorkspace(target, answers, options)).rejects.toThrow(expected);
      expect(existsSync(target)).toBe(false);
    }
  });

  it('resolves to a complete Docker Compose model when Docker Compose is installed', async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), 'agent-workspace-generator-'));
    created.push(parent);
    const target = path.join(parent, 'compose-model');
    await createWorkspace(
      target,
      {
        database: 'embedded PostgreSQL 17',
        storage: 'SeaweedFS',
        runtime: 'docker',
        authentication: 'local administrator',
      },
      options,
    );

    const docker = spawnSync('docker', ['compose', 'version'], { encoding: 'utf8' });
    if (docker.status !== 0) return;

    const result = spawnSync('docker', ['compose', 'config', '--format', 'json'], {
      cwd: target,
      encoding: 'utf8',
    });
    expect(result.status, result.stderr).toBe(0);
    const parsed: unknown = JSON.parse(result.stdout);
    const model = parsed as {
      services: Record<
        string,
        {
          depends_on?: Record<string, { condition: string }>;
          environment?: Record<string, string>;
        }
      >;
    };
    expect(Object.keys(model.services).sort()).toEqual([
      'gateway',
      'postgres',
      'runner',
      'seaweedfs',
      'web',
    ]);
    expect(model.services['web']?.environment?.['DATABASE_URL']).toContain(
      '@postgres:5432/agent_workspace',
    );
    expect(model.services['web']?.environment).toMatchObject({
      MODEL_GATEWAY_URL: 'http://gateway:4000',
      AW_STORAGE_URL:
        's3://agent-workspace?endpoint=http://seaweedfs:8333&publicEndpoint=http://localhost:8333&pathStyle=true',
      AW_STORAGE_CREATE_BUCKET: 'true',
      // Forwarded empty: only a leftover value in `.env` reaches the server, which warns.
      OBJECT_STORAGE_ENDPOINT: '',
      AW_FILE_STORAGE_ROOT: '',
      RUNNER_URL: 'http://runner:8080',
      RUNTIME_DRIVER: 'docker',
    });
    expect(model.services['gateway']?.environment).toMatchObject({
      DATABASE_URL: model.services['web']?.environment?.['DATABASE_URL'],
      GATEWAY_TOKEN_SECRET: model.services['web']?.environment?.['GATEWAY_TOKEN_SECRET'],
      MASTER_ENCRYPTION_KEY: model.services['web']?.environment?.['MASTER_ENCRYPTION_KEY'],
    });
    expect(model.services['runner']?.environment).toMatchObject({
      AW_SESSION_MIRROR_URL: 'http://web:3000',
    });
    // SeaweedFS's only S3 identity is the key pair web signs with: generated, never a literal.
    const webKeys = model.services['web']?.environment;
    expect(webKeys?.['AWS_SECRET_ACCESS_KEY']).toMatch(/^[\w-]{32}$/u);
    expect(model.services['seaweedfs']?.environment).toEqual({
      AWS_ACCESS_KEY_ID: webKeys?.['AWS_ACCESS_KEY_ID'],
      AWS_SECRET_ACCESS_KEY: webKeys?.['AWS_SECRET_ACCESS_KEY'],
    });
    expect(model.services['web']?.depends_on).toMatchObject({
      gateway: { condition: 'service_healthy' },
      postgres: { condition: 'service_healthy' },
      runner: { condition: 'service_healthy' },
    });

    // No manifest invents a storage location: without AW_STORAGE_URL nothing starts.
    const envPath = path.join(target, '.env');
    const env = await readFile(envPath, 'utf8');
    await writeFile(envPath, env.replace(/^AW_STORAGE_URL=.*\n/mu, ''));
    const refused = spawnSync('docker', ['compose', 'config', '--format', 'json'], {
      cwd: target,
      encoding: 'utf8',
    });
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toContain('set AW_STORAGE_URL in .env');
  }, 20_000);
});

describe('createWorkspace --cloud', () => {
  const parentDirectory = async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), 'agent-workspace-generator-cloud-'));
    created.push(parent);
    return parent;
  };

  it('writes a profile that round-trips, plus the artefacts that cloud has a target for', async () => {
    const parent = await parentDirectory();
    const target = path.join(parent, 'acme-ai');
    const generated = await createWorkspace(target, null, { ...options, cloud: 'gcp' });

    const document = await readFile(path.join(target, 'agent-workspace.yaml'), 'utf8');
    expect(parseProfileDocument(document)).toEqual(generated.profile);
    expect(generated.profile).toMatchObject({
      cloud: 'gcp',
      storage: {
        relational: 'cloud-sql',
        objects: 'gcs://acme-ai-files',
        secrets: 'secret-manager',
      },
      runtime: { default: 'cloud-run-service' },
    });

    const tfvars = await readFile(
      path.join(target, 'deploy/terraform/gcp-cloudrun.auto.tfvars.json'),
      'utf8',
    );
    expect(JSON.parse(tfvars)).toMatchObject({ images: { web: images.web } });
    expect(existsSync(path.join(target, 'deploy/helm/values.yaml'))).toBe(true);
    // The .env still carries the profile-derived placement for a cloud target.
    await expect(readFile(path.join(target, '.env'), 'utf8')).resolves.toContain(
      'AW_STORAGE_URL=gcs://acme-ai-files',
    );
    // The Compose project belongs to `local` alone: a cloud `.env` supplies none of the
    // variables the Compose file demands, so shipping it here would be an unrunnable file.
    expect(existsSync(path.join(target, 'compose.yaml'))).toBe(false);
    expect(existsSync(path.join(target, 'pnpm-workspace.yaml'))).toBe(false);
    // The CLI that renders, validates and deploys it is pinned, with no Compose script (BH061-058).
    const manifest = JSON.parse(await readFile(path.join(target, 'package.json'), 'utf8')) as {
      readonly name: string;
      readonly scripts: Record<string, string>;
      readonly dependencies: Record<string, string>;
    };
    expect(manifest).toEqual({
      private: true,
      name: 'acme-ai',
      scripts: { deploy: 'agent-workspace deploy .' },
      dependencies: { '@indx-workspace/cli': CLI_VERSION },
    });
    expect(generated.artefacts[0]).toBe('package.json');
  });

  it('starts the profile with the $schema line editors read, and the profile still validates (#424)', async () => {
    for (const cloud of ['local', 'aws'] as const) {
      const parent = await parentDirectory();
      const target = path.join(parent, 'acme-ai');
      const generated = await createWorkspace(target, null, { ...options, cloud });

      const document = await readFile(path.join(target, 'agent-workspace.yaml'), 'utf8');
      expect(document.split('\n')[0]).toBe(`# yaml-language-server: $schema=${PROFILE_SCHEMA_URL}`);
      expect(parseProfileDocument(document)).toEqual(generated.profile);
    }
  });

  it('pins the $schema URL to the schema the published CLI of this version ships (#424)', () => {
    expect(PROFILE_SCHEMA_URL).toBe(
      `https://unpkg.com/@indx-workspace/cli@${CLI_VERSION}/schema/agent-workspace.schema.json`,
    );
  });

  it('packs the schema at the path the $schema URL names, identical to the committed schema (#424)', async () => {
    const packageRoot = fileURLToPath(new URL('..', import.meta.url));
    const result = spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
      cwd: packageRoot,
      encoding: 'utf8',
      shell: process.platform === 'win32',
    });
    expect(result.status, result.stderr).toBe(0);
    const [packed] = JSON.parse(result.stdout) as [{ name: string; files: { path: string }[] }];
    const prefix = `https://unpkg.com/${packed.name}@${CLI_VERSION}/`;
    expect(PROFILE_SCHEMA_URL.startsWith(prefix)).toBe(true);
    const shipped = PROFILE_SCHEMA_URL.slice(prefix.length);
    expect(packed.files.map((file) => file.path)).toContain(shipped);
    expect(await readFile(path.join(packageRoot, shipped), 'utf8')).toBe(
      await readFile(path.join(packageRoot, '../schemas/agent-workspace.schema.json'), 'utf8'),
    );
  }, 20_000);

  /**
   * The chart serves the S3 environment contract and the Azure default is the native Blob
   * provider wired by Container Apps. Rendering an AKS overlay would omit that provider wiring,
   * so the artefact is withheld.
   */
  it('renders no chart overlay for a cloud profile whose store the chart cannot serve', async () => {
    const parent = await parentDirectory();
    const target = path.join(parent, 'acme-ai');
    const generated = await createWorkspace(target, null, { ...options, cloud: 'azure' });

    expect(generated.profile.storage.objects).toBe('azblob://acme-ai-files');
    expect(generated.artefacts).toEqual([
      'package.json',
      'agent-workspace.yaml',
      '.env',
      '.gitignore',
      'deploy/terraform/azure-container-apps.auto.tfvars.json',
    ]);
    expect(existsSync(path.join(target, 'deploy/helm'))).toBe(false);
  });

  it('leaves no directory behind when the derived profile is refused', async () => {
    const parent = await parentDirectory();
    // A legal directory name that cannot become an S3 bucket name: the profile is refused
    // before `mkdir`, so nothing of the project exists afterwards.
    const target = path.join(parent, 'a'.repeat(60));
    await expect(createWorkspace(target, null, { ...options, cloud: 'aws' })).rejects.toThrow(
      /storage\.objects/u,
    );
    expect(existsSync(target)).toBe(false);
  });

  it('refuses interactive answers together with a cloud target', async () => {
    const parent = await parentDirectory();
    const target = path.join(parent, 'mixed');
    await expect(
      createWorkspace(
        target,
        {
          database: 'PostgreSQL 17',
          storage: 'local filesystem',
          runtime: 'docker',
          authentication: 'local administrator',
        },
        { ...options, cloud: 'azure' },
      ),
    ).rejects.toThrow(/Interactive answers/u);
    expect(existsSync(target)).toBe(false);
  });

  // Acceptance criterion 3: the release gate (P-6) is not relaxed by this unit, and it still
  // fires before the project directory exists.
  it('refuses a placeholder digest before creating anything', async () => {
    const parent = await parentDirectory();
    const target = path.join(parent, 'placeholder');
    await expect(
      createWorkspace(target, null, {
        cloud: 'gcp',
        images: { ...images, web: `registry.example/web@sha256:${'0'.repeat(64)}` },
      }),
    ).rejects.toThrow(/placeholder/u);
    expect(existsSync(target)).toBe(false);
  });
});

describe('parseCreateArguments', () => {
  // S1-16: with no --cloud, create writes the v2 project `aw dev` runs.
  it('defaults to the v2 project, with or without --yes', () => {
    expect(parseCreateArguments([])).toEqual({
      kind: 'project',
      target: 'my-agent',
      yes: false,
      answers: {},
      named: false,
      install: undefined,
      start: undefined,
    });
    expect(parseCreateArguments(['acme-ai'])).toEqual({
      kind: 'project',
      target: 'acme-ai',
      yes: false,
      answers: {},
      named: true,
      install: undefined,
      start: undefined,
    });
    expect(parseCreateArguments(['--yes', 'acme-ai'])).toEqual({
      kind: 'project',
      target: 'acme-ai',
      yes: true,
      answers: {},
      named: true,
      install: undefined,
      start: undefined,
    });
  });

  it('reads a flag for every setup question, and --help', () => {
    expect(
      parseCreateArguments([
        'acme',
        '--provider',
        'openai',
        '--color=#0f6b77',
        '--tools',
        'postgres',
      ]),
    ).toEqual({
      kind: 'project',
      target: 'acme',
      yes: false,
      answers: {
        'admin.modelProvider': 'openai',
        'embedder.brandColour': '#0f6b77',
        'content.internalTools': ['postgres'],
      },
      named: true,
      install: undefined,
      start: undefined,
    });
    expect(parseCreateArguments(['--help'])).toEqual({ kind: 'help' });
    expect(() => parseCreateArguments(['acme', '--color', 'teal'])).toThrow(
      /^--color: "teal" is not accepted: a hex colour/u,
    );
    expect(() => parseCreateArguments(['acme', '--cloud', 'aws', '--theme', 'blank'])).toThrow(
      /setup flags/u,
    );
  });

  it('accepts every cloud, in either argument order, with --validate', () => {
    for (const cloud of ['aws', 'gcp', 'azure', 'local'] as const) {
      expect(parseCreateArguments(['acme', '--cloud', cloud])).toEqual({
        kind: 'deployment',
        target: 'acme',
        cloud,
        validate: false,
        yes: false,
        generator: {},
      });
      expect(parseCreateArguments(['--cloud', cloud, '--validate', 'acme'])).toEqual({
        kind: 'deployment',
        target: 'acme',
        cloud,
        validate: true,
        yes: false,
        generator: {},
      });
    }
  });

  // Roadmap §5: no option is accepted and then ignored.
  it('refuses the options a cloud would ignore, and --validate without one', () => {
    expect(() => parseCreateArguments(['acme', '--cloud', 'aws', '--yes'])).toThrow(
      /--yes answers questions; --cloud aws asks no setup questions/u,
    );
    expect(() => parseCreateArguments(['--yes', 'acme', '--cloud', 'gcp'])).toThrow(/--yes/u);
    expect(() => parseCreateArguments(['acme', '--cloud', 'local', '--theme', 'blank'])).toThrow(
      /--database, --storage, --runtime and --auth, or take the defaults with --yes/u,
    );
    expect(() =>
      parseCreateArguments(['acme', '--cloud', 'local', '--answers', 'answers.yaml']),
    ).toThrow(/setup flags and --answers/u);
    expect(() => parseCreateArguments(['acme', '--cloud', 'gcp', '--storage', 'x'])).toThrow(
      /--database, --storage, --runtime and --auth answer the questions of --cloud local; --cloud gcp asks none/u,
    );
    expect(() => parseCreateArguments(['acme', '--auth', 'local'])).toThrow(
      /pass them with --cloud local/u,
    );
    expect(() => parseCreateArguments(['acme', '--validate'])).toThrow(
      /--validate .*pass it with --cloud/u,
    );
  });

  it('reads --yes and the four generator flags with --cloud local, and --answers without a cloud', () => {
    expect(
      parseCreateArguments([
        'acme',
        '--cloud',
        'local',
        '--yes',
        '--database',
        'postgres',
        '--storage=SeaweedFS',
        '--runtime',
        'docker',
        '--auth',
        'local',
      ]),
    ).toEqual({
      kind: 'deployment',
      target: 'acme',
      cloud: 'local',
      validate: false,
      yes: true,
      generator: {
        database: 'postgres',
        storage: 'SeaweedFS',
        runtime: 'docker',
        authentication: 'local',
      },
    });
    expect(parseCreateArguments(['acme', '--answers=a.yaml'])).toMatchObject({
      kind: 'project',
      answersFile: 'a.yaml',
    });
  });

  it('reads --port with --cloud local alone, as a port number (BH061-069)', () => {
    expect(parseCreateArguments(['acme', '--cloud', 'local', '--port', '3417'])).toMatchObject({
      kind: 'deployment',
      port: 3417,
    });
    expect(parseCreateArguments(['acme', '--cloud', 'local'])).not.toHaveProperty('port');
    for (const value of ['0', '65536', '3000x', '-1', '03000']) {
      expect(() => parseCreateArguments(['acme', '--cloud', 'local', `--port=${value}`])).toThrow(
        /is not a port/u,
      );
    }
    for (const argv of [
      ['acme', '--port', '3417'],
      ['acme', '--cloud', 'gcp', '--port', '3417'],
    ]) {
      expect(() => parseCreateArguments(argv)).toThrow(/pass it with --cloud local/u);
    }
  });

  // Silently dropping `--clod gcp` would build a Compose project for an operator who asked for a
  // cloud one, so an unrecognised option is a refusal rather than a default.
  it.each([
    [['acme', '--clod', 'gcp'], /Unknown option/u],
    [['acme', '-c', 'gcp'], /Unknown option/u],
    [['acme', '--cloud'], /--cloud needs a value/u],
    [['acme', '--cloud', '--validate'], /--cloud needs a value/u],
    [['acme', '--yes=false'], /--yes takes no value/u],
    [['acme', '--cloud', 'digitalocean'], /Unsupported --cloud/u],
    [['acme', 'extra'], /Unexpected extra argument/u],
    [['acme', '-y'], /Unknown option/u],
  ])('refuses %j', (argv, expected) => {
    expect(() => parseCreateArguments(argv)).toThrow(expected);
  });
});

describe('create-agent-workspace --validate', () => {
  const composeAnswers: GeneratorAnswers = {
    database: 'PostgreSQL 17',
    storage: 'SeaweedFS',
    runtime: 'docker',
    authentication: 'local administrator',
  };

  /** Every probe is injected, so nothing in this block opens a socket. */
  function recordingProbes(overrides: Partial<ProfileProbes> = {}) {
    const calls: string[] = [];
    const record = (entry: string) => {
      calls.push(entry);
      return Promise.resolve();
    };
    const probes: ProfileProbes = {
      relational: (url) => record(`relational:${url}`),
      // The default double answers for a bucket that is there; `validate.test.ts` covers `missing`.
      objects: (input): Promise<ObjectStorePresence> =>
        record(
          `objects:${input.bucket}:${input.backend === 's3' ? input.accessKeyId : 'adc'}`,
        ).then(() => 'present'),
      identity: (issuer) => record(`identity:${issuer}`),
      ...overrides,
    };
    return { calls, probes };
  }

  const targetIn = async (name: string) => {
    const parent = await mkdtemp(path.join(os.tmpdir(), 'agent-workspace-generator-validate-'));
    created.push(parent);
    return path.join(parent, name);
  };

  // The Compose project puts both stores on an `internal: true` network with no published port,
  // so the host can never reach them; probing them would make the command fail on its own output.
  it('reports the Compose stores as unreachable from the host, and succeeds, on --cloud local', async () => {
    const target = await targetIn('acme-ai');
    const { calls, probes } = recordingProbes();
    const output = captureStdout();

    await create([target, '--cloud', 'local', '--validate'], {
      images,
      answers: composeAnswers,
      probes,
    });

    expect(calls).toEqual([]);
    expect(output()).toContain("skipped  relational: postgres is on the Compose project's");
    expect(output()).toContain("skipped  objects: seaweedfs is on the Compose project's");
    expect(output()).toContain('docker compose exec postgres pg_isready -U agent_workspace');
    expect(existsSync(path.join(target, 'compose.yaml'))).toBe(true);
  });

  // A cloud store is real from the moment the project exists, and the credentials come from the
  // project's own environment layered over the operator's exports.
  it('probes the real stores on --cloud gcp, with the project environment', async () => {
    const target = await targetIn('acme-ai');
    vi.stubEnv('DATABASE_URL', 'postgres://ops:pw@10.0.0.2:5432/agent_workspace');
    vi.stubEnv('GCP_PROJECT', 'acme-project');
    const { calls, probes } = recordingProbes();
    captureStdout();

    await create([target, '--cloud', 'gcp', '--validate'], {
      images: cloudImages,
      probes,
    });

    expect(calls).toEqual([
      'relational:postgres://ops:pw@10.0.0.2:5432/agent_workspace',
      // The bucket is the profile's; ADC supplies the workload identity.
      'objects:acme-ai-files:adc',
    ]);
  });

  it('fails with the project already written when a store genuinely refuses', async () => {
    const target = await targetIn('acme-ai');
    vi.stubEnv('DATABASE_URL', 'postgres://ops:pw@10.0.0.2:5432/agent_workspace');
    const { probes } = recordingProbes({
      relational: () => Promise.reject(new Error('connect ECONNREFUSED 10.0.0.2:5432')),
    });
    captureStdout();

    const refusal = await create([target, '--cloud', 'gcp', '--validate'], {
      images: cloudImages,
      probes,
    }).catch((thrown: unknown) => thrown);

    expect(refusal).toBeInstanceOf(Error);
    const error = refusal as Error;
    expect(error.message).toContain('the relational store did not answer');
    expect(error.message).toContain(`The project was written to ${target}`);
    // The driver's own text names the host; it stays in `cause`, as everywhere else.
    expect(error.message).not.toContain('ECONNREFUSED');
    expect(existsSync(path.join(target, 'agent-workspace.yaml'))).toBe(true);
  });
});

describe('what the command tells the operator to do next', () => {
  const targetIn = async (name: string) => {
    const parent = await mkdtemp(path.join(os.tmpdir(), 'agent-workspace-generator-next-'));
    created.push(parent);
    return path.join(parent, name);
  };

  /**
   * `apply deploy/` was not a step an operator could take: the generated `deploy/terraform/` holds
   * no `.tf` file, so Terraform would initialise an empty configuration there and apply nothing,
   * and `*.auto.tfvars.json` is auto-loaded only from the directory Terraform runs in. The copy
   * into `infra/terraform/<module>/` is the step that exists.
   */
  it('names the copy into the module directory, and the apply that follows it', async () => {
    const target = await targetIn('acme-ai');
    const output = captureStdout();

    await create([target, '--cloud', 'gcp'], { images: cloudImages });

    expect(output()).toContain(
      `  cp ${target}/deploy/terraform/gcp-cloudrun.auto.tfvars.json infra/terraform/gcp-cloudrun/`,
    );
    expect(output()).toContain('  terraform -chdir=infra/terraform/gcp-cloudrun apply');
    expect(output()).toContain(`-f ${target}/deploy/helm/values.yaml`);
    // The step that pointed at a directory holding no Terraform configuration is gone.
    expect(output()).not.toContain('apply deploy/');
  });

  // A withheld artefact that is never mentioned looks like a bug in the generator; saying which
  // store the chart needs is what turns it into a decision the operator can act on.
  it('says why a profile the chart cannot serve got no overlay', async () => {
    const target = await targetIn('acme-ai');
    const output = captureStdout();

    await create([target, '--cloud', 'azure'], { images: cloudImages });

    expect(output()).toContain('No chart overlay was rendered');
    expect(output()).toContain('storage.objects is azblob://acme-ai-files');
    // `render` re-renders the profile, but never into an overlay the chart cannot serve.
    expect(output()).toContain('`agent-workspace render` renders no overlay for this profile');
    // Its own target is Container Apps, so the Terraform copy is still the next step.
    expect(output()).toContain('infra/terraform/azure-container-apps/');
    expect(output()).not.toContain('helm upgrade');
  });

  it('keeps the Compose project on its own install-and-start path', async () => {
    const target = await targetIn('acme-ai');
    const output = captureStdout();

    await create([target, '--cloud', 'local'], {
      images,
      answers: {
        database: 'PostgreSQL 17',
        storage: 'SeaweedFS',
        runtime: 'docker',
        authentication: 'local administrator',
      },
    });

    expect(output()).toContain(`Next: cd ${target} && pnpm install`);
    expect(output()).not.toContain('No chart overlay was rendered');
    // Every file written is listed, the three copied from the template included.
    for (const file of ['compose.yaml', 'package.json', 'pnpm-workspace.yaml', '.env']) {
      expect(output()).toContain(`  ${file}\n`);
    }
  });

  it('names the Compose project and the package after the directory, sanitised', async () => {
    const target = await targetIn('Acme AI.Platform');
    const output = captureStdout();

    await create([target, '--cloud', 'local'], {
      images,
      answers: {
        database: 'PostgreSQL 17',
        storage: 'local filesystem',
        runtime: 'docker',
        authentication: 'local administrator',
      },
    });

    const env = await readFile(path.join(target, '.env'), 'utf8');
    expect(env).toMatch(/^COMPOSE_PROJECT_NAME=acme-ai-platform$/mu);
    // BH061-054: loopback only, the address `start` prints.
    expect(env).toMatch(/^PORT=127\.0\.0\.1:3000$/mu);
    const manifest = JSON.parse(await readFile(path.join(target, 'package.json'), 'utf8')) as {
      name: string;
    };
    expect(manifest.name).toBe('acme-ai-platform');
    expect(output()).toContain(`Next: cd '${target}' && pnpm install`);
  });

  it('publishes the web service on the --port given (BH061-069)', async () => {
    const target = await targetIn('acme-port');
    captureStdout();
    await create([target, '--cloud', 'local', '--port', '3417'], {
      images,
      answers: DEFAULT_ANSWERS,
    });
    const env = await readFile(path.join(target, '.env'), 'utf8');
    expect(env).toMatch(/^PORT=127\.0\.0\.1:3417$/mu);
  });
});

describe('create command entry point', () => {
  const sourceEntry = fileURLToPath(new URL('./create.ts', import.meta.url));

  it('recognizes direct and package-bin-style symlink invocations', async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), 'agent-workspace-generator-entry-'));
    created.push(parent);
    const symlinkEntry = path.join(parent, 'create-agent-workspace.ts');
    const target = path.join(parent, 'generated');
    await symlink(sourceEntry, symlinkEntry, 'file');

    expect(isMainModule(sourceEntry, new URL('./create.ts', import.meta.url).href)).toBe(true);
    expect(isMainModule(symlinkEntry, new URL('./create.ts', import.meta.url).href)).toBe(true);

    const result = spawnSync(
      process.execPath,
      [symlinkEntry, target, '--cloud', 'local', '--yes'],
      {
        cwd: path.resolve(fileURLToPath(new URL('../../../', import.meta.url))),
        encoding: 'utf8',
        env: {
          ...process.env,
          AW_WEB_IMAGE: images.web,
          AW_GATEWAY_IMAGE: images.gateway,
          AW_RUNNER_IMAGE: images.runner,
          AW_RUNTIME_IMAGE: images.runtime,
          AW_POSTGRES_IMAGE: images.postgres,
          AW_SEAWEEDFS_IMAGE: images.seaweedfs,
        },
      },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(path.join(target, 'compose.yaml'))).toBe(true);
  }, 20_000);

  /**
   * The process-level half of `cli-failure.ts`: the guard this file ends with is what stops Node's
   * default handler from printing a rejected top-level `await`. That handler renders the whole
   * `cause` chain and a stack trace, which for a probe refusal is the driver's own text — so what
   * matters here is not only the exit code but that nothing beneath the message is written.
   */
  it('exits 1 with the refusal alone, and no stack or cause chain, on stderr', async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), 'agent-workspace-generator-refusal-'));
    created.push(parent);

    // The parent exists and the generator will not write into a directory it did not create, so
    // this refuses before any probe — no socket, and the same failure every time.
    const result = spawnSync(process.execPath, [sourceEntry, parent, '--cloud', 'gcp'], {
      cwd: path.resolve(fileURLToPath(new URL('../../../', import.meta.url))),
      encoding: 'utf8',
      env: {
        ...process.env,
        AW_WEB_IMAGE: images.web,
        AW_GATEWAY_IMAGE: images.gateway,
        AW_RUNNER_IMAGE: images.runner,
        AW_RUNTIME_IMAGE: images.runtime,
      },
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('EEXIST');
    expect(result.stderr.trimEnd().split('\n')).toHaveLength(1);
    expect(result.stderr).not.toContain('[cause]');
    expect(result.stderr).not.toMatch(/\n\s+at /u);
  }, 20_000);

  it('runs the generator when the source module is invoked directly', async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), 'agent-workspace-generator-direct-'));
    created.push(parent);
    const target = path.join(parent, 'generated');
    const repository = path.resolve(fileURLToPath(new URL('../../../', import.meta.url)));
    const result = spawnSync(process.execPath, [sourceEntry, target, '--cloud', 'local', '--yes'], {
      cwd: repository,
      encoding: 'utf8',
      env: {
        ...process.env,
        AW_WEB_IMAGE: images.web,
        AW_GATEWAY_IMAGE: images.gateway,
        AW_RUNNER_IMAGE: images.runner,
        AW_RUNTIME_IMAGE: images.runtime,
        AW_POSTGRES_IMAGE: images.postgres,
        AW_SEAWEEDFS_IMAGE: images.seaweedfs,
      },
    });

    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(path.join(target, 'compose.yaml'))).toBe(true);
  }, 20_000);
});

describe('no person, no prompt (#879)', () => {
  const sourceEntry = fileURLToPath(new URL('./create.ts', import.meta.url));
  const repositoryRoot = path.resolve(fileURLToPath(new URL('../../../', import.meta.url)));
  const generatorEnvironment = {
    ...process.env,
    AW_WEB_IMAGE: images.web,
    AW_GATEWAY_IMAGE: images.gateway,
    AW_RUNNER_IMAGE: images.runner,
    AW_RUNTIME_IMAGE: images.runtime,
    AW_POSTGRES_IMAGE: images.postgres,
    AW_SEAWEEDFS_IMAGE: images.seaweedfs,
  };
  /** Far under the 10 s silence the old piped-answers reader waited out. */
  const FAST_MS = 5_000;

  async function freshTarget(): Promise<string> {
    const parent = await mkdtemp(path.join(os.tmpdir(), 'agent-workspace-generator-stdin-'));
    created.push(parent);
    return path.join(parent, 'generated');
  }

  /**
   * Runs `create` as a process whose stdin is a pipe the parent holds open and never writes to or
   * closes, as a CI step or an agent harness does. It must finish by itself.
   */
  async function runWithStdinHeldOpen(
    args: readonly string[],
    env: Readonly<Record<string, string | undefined>> = {},
  ) {
    const child = spawn(process.execPath, [sourceEntry, ...args], {
      cwd: repositoryRoot,
      env: { ...generatorEnvironment, CI: 'true', ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    const started = Date.now();
    const status = await new Promise<number | null>((resolve) => {
      const giveUp = setTimeout(() => child.kill('SIGKILL'), 15_000);
      child.once('close', (code) => {
        clearTimeout(giveUp);
        resolve(code);
      });
    });
    return { status, stdout, stderr, elapsed: Date.now() - started };
  }

  /** The defaults generate the local-filesystem Compose project, with no object-store profile. */
  async function expectDefaultProject(target: string): Promise<void> {
    const env = await readFile(path.join(target, '.env'), 'utf8');
    expect(env).not.toMatch(/^COMPOSE_PROFILES=.*object-storage/mu);
    expect(existsSync(path.join(target, 'compose.yaml'))).toBe(true);
  }

  it('labels the defaults as what the Compose project runs, and still accepts the old wording', async () => {
    expect(DEFAULT_ANSWERS).toMatchObject({
      database: 'PostgreSQL 17 (container)',
      storage: 'local filesystem (Docker volume)',
    });
    const legacy = await freshTarget();
    await createWorkspace(
      legacy,
      { ...DEFAULT_ANSWERS, database: 'embedded PostgreSQL 17', storage: 'local filesystem' },
      options,
    );
    await expectDefaultProject(legacy);
  });

  it('--cloud local --yes finishes with stdin held open and CI set, reading none of it', async () => {
    const target = await freshTarget();
    const run = await runWithStdinHeldOpen([target, '--cloud', 'local', '--yes']);
    expect(run.status, run.stderr).toBe(0);
    expect(run.elapsed).toBeLessThan(FAST_MS);
    await expectDefaultProject(target);
  }, 20_000);

  it('--cloud local without --yes takes the flags and the defaults with stdin held open', async () => {
    const target = await freshTarget();
    const run = await runWithStdinHeldOpen([target, '--cloud', 'local', '--storage', 'SeaweedFS']);
    expect(run.status, run.stderr).toBe(0);
    expect(run.elapsed).toBeLessThan(FAST_MS);
    expect(await readFile(path.join(target, '.env'), 'utf8')).toMatch(
      /^COMPOSE_PROFILES=.*object-storage/mu,
    );
  }, 20_000);

  it('does not read piped answers any more: the lines are not answers', async () => {
    const target = await freshTarget();
    const result = spawnSync(process.execPath, [sourceEntry, target, '--cloud', 'local'], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      env: { ...generatorEnvironment, CI: 'true' },
      input: 'PostgreSQL\nSeaweedFS\ndocker\nlocal administrator\n',
    });
    expect(result.status, result.stderr).toBe(0);
    await expectDefaultProject(target);
  }, 20_000);

  it('takes its answers from the flags: --storage SeaweedFS changes the profile', async () => {
    const target = await freshTarget();
    const run = await runWithStdinHeldOpen([
      target,
      '--cloud',
      'local',
      '--yes',
      '--database',
      'PostgreSQL',
      '--storage',
      'SeaweedFS',
      '--runtime',
      'docker',
      '--auth',
      'local administrator',
    ]);
    expect(run.status, run.stderr).toBe(0);
    expect(await readFile(path.join(target, '.env'), 'utf8')).toMatch(
      /^COMPOSE_PROFILES=.*object-storage/mu,
    );
  }, 20_000);

  it.each([
    ['--storage', 'MinIO', /no longer bundles MinIO/u],
    ['--storage', 'tape', /Unsupported storage "tape"/u],
    ['--database', 'mysql', /Unsupported database "mysql"/u],
    ['--runtime', 'kubernetes', /Unsupported runtime "kubernetes"/u],
    ['--auth', 'sso', /Unsupported authentication "sso"/u],
  ])(
    '%s %s exits 2 and writes nothing',
    async (flag, value, message) => {
      const target = await freshTarget();
      const run = await runWithStdinHeldOpen([target, '--cloud', 'local', '--yes', flag, value]);
      expect(run.status).toBe(2);
      expect(run.stderr).toMatch(message);
      expect(existsSync(target)).toBe(false);
    },
    20_000,
  );

  it('--cloud gcp --storage x is refused before anything is generated', async () => {
    const target = await freshTarget();
    const run = await runWithStdinHeldOpen([target, '--cloud', 'gcp', '--storage', 'x']);
    expect(run.status).toBe(2);
    expect(run.stderr).toMatch(/answer the questions of --cloud local/u);
    expect(existsSync(target)).toBe(false);
  }, 20_000);

  it('<dir> --yes finishes with stdin held open and CI set, and asks nothing', async () => {
    const target = await freshTarget();
    const run = await runWithStdinHeldOpen([target, '--yes', '--no-install']);
    expect(run.status, run.stderr).toBe(0);
    expect(run.elapsed).toBeLessThan(FAST_MS);
    expect(run.stdout).not.toContain('?');
    expect(existsSync(path.join(target, 'agent-workspace.yaml'))).toBe(true);
  }, 20_000);

  it('<dir> with no flag finishes with stdin held open, using the recommended answers', async () => {
    const target = await freshTarget();
    const run = await runWithStdinHeldOpen([target]);
    expect(run.status, run.stderr).toBe(0);
    expect(run.elapsed).toBeLessThan(FAST_MS);
    expect(run.stderr).toContain('no terminal: used the recommended answers');
  }, 20_000);

  it('--yes with an endpoint provider and no URL exits 2 naming the flag, and writes nothing', async () => {
    const target = await freshTarget();
    const run = await runWithStdinHeldOpen([target, '--yes', '--provider', 'openai-compatible']);
    expect(run.status).toBe(2);
    expect(run.stderr).toContain('--model-base-url');
    expect(run.stderr).toContain('fix: add --model-base-url <url>');
    expect(existsSync(target)).toBe(false);
  }, 20_000);

  it('the same without --yes and without a person exits 2 as well', async () => {
    const target = await freshTarget();
    const run = await runWithStdinHeldOpen([target, '--provider', 'azure-openai']);
    expect(run.status).toBe(2);
    expect(run.stderr).toContain('fix: add --model-base-url <url>');
    expect(existsSync(target)).toBe(false);
  }, 20_000);

  it('writes the project once the endpoint is given', async () => {
    const target = await freshTarget();
    const run = await runWithStdinHeldOpen([
      target,
      '--yes',
      '--no-install',
      '--provider',
      'openai-compatible',
      '--model-base-url',
      'https://models.example.com/v1',
    ]);
    expect(run.status, run.stderr).toBe(0);
    expect(await readFile(path.join(target, 'agent-workspace.yaml'), 'utf8')).toContain(
      'https://models.example.com/v1',
    );
  }, 20_000);

  // `script` allocates a pseudo-terminal, which is what a CI runner with `tty: true` hands a job.
  it.skipIf(process.platform !== 'linux')(
    'asks nothing on a pseudo-terminal when CI is set',
    async () => {
      const target = await freshTarget();
      const result = spawnSync(
        'script',
        [
          '-qec',
          `${shellArgument(process.execPath, 'linux')} ${shellArgument(sourceEntry, 'linux')} ${shellArgument(target, 'linux')} --yes --no-install`,
          '/dev/null',
        ],
        {
          cwd: repositoryRoot,
          encoding: 'utf8',
          env: { ...process.env, CI: 'true' },
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: 20_000,
        },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).not.toMatch(/\? /u);
      expect(existsSync(path.join(target, 'agent-workspace.yaml'))).toBe(true);
    },
    30_000,
  );

  // Without --yes the pseudo-terminal reaches terminalFor, so this fails if it ignores CI.
  it.skipIf(process.platform !== 'linux')(
    'uses the recommended answers on a pseudo-terminal when CI is set, even without --yes',
    async () => {
      const target = await freshTarget();
      const result = spawnSync(
        'script',
        [
          '-qec',
          `${shellArgument(process.execPath, 'linux')} ${shellArgument(sourceEntry, 'linux')} ${shellArgument(target, 'linux')} --no-install --no-start`,
          '/dev/null',
        ],
        {
          cwd: repositoryRoot,
          encoding: 'utf8',
          env: { ...process.env, CI: 'true' },
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: 20_000,
        },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).not.toMatch(/\? /u);
      // Under `script`, stderr is merged into the pseudo-terminal output on stdout.
      expect(result.stdout + result.stderr).toContain('no terminal: used the recommended answers');
      expect(existsSync(path.join(target, 'agent-workspace.yaml'))).toBe(true);
    },
    30_000,
  );
});

describe('create --answers (#879)', () => {
  const sourceEntry = fileURLToPath(new URL('./create.ts', import.meta.url));
  const ANSWERS = [
    'setup.theme: copilot',
    'admin.modelProvider: openai-compatible',
    'admin.modelBaseUrl: https://models.example.com/v1',
    'content.internalTools:',
    '  - openapi',
    'content.openapiDocument: apis/orders.json',
    'embedder.brandColour: "#0f6b77"',
    '',
  ].join('\n');
  const EQUIVALENT_FLAGS = [
    '--theme',
    'copilot',
    '--provider',
    'openai-compatible',
    '--model-base-url',
    'https://models.example.com/v1',
    '--tools',
    'openapi',
    '--openapi',
    'apis/orders.json',
    '--color',
    '#0f6b77',
  ];

  async function workDirectory(): Promise<string> {
    const parent = await mkdtemp(path.join(os.tmpdir(), 'agent-workspace-generator-answers-'));
    created.push(parent);
    return parent;
  }

  function run(parent: string, args: readonly string[]) {
    return spawnSync(process.execPath, [sourceEntry, ...args], {
      cwd: parent,
      encoding: 'utf8',
      env: { ...process.env, CI: 'true' },
      input: '',
      timeout: 20_000,
    });
  }

  async function tree(directory: string): Promise<Record<string, string>> {
    const entries = await readdir(directory, { recursive: true, withFileTypes: true });
    const files = await Promise.all(
      entries
        .filter((entry) => entry.isFile())
        .map(async (entry) => {
          const file = path.join(entry.parentPath, entry.name);
          return [
            path.relative(directory, file).replaceAll('\\', '/'),
            await readFile(file, 'utf8'),
          ] as const;
        }),
    );
    return Object.fromEntries(files.toSorted(([left], [right]) => left.localeCompare(right)));
  }

  it('writes the same files as the equivalent flags', async () => {
    const parent = await workDirectory();
    await writeFile(path.join(parent, 'answers.yaml'), ANSWERS);
    const fromFile = run(parent, ['from-file', '--answers', 'answers.yaml', '--no-install']);
    expect(fromFile.status, fromFile.stderr).toBe(0);
    const fromFlags = run(parent, ['from-flags', '--yes', '--no-install', ...EQUIVALENT_FLAGS]);
    expect(fromFlags.status, fromFlags.stderr).toBe(0);
    // The project name is the directory's, so compare with it normalised.
    const normalise = (files: Record<string, string>, name: string) =>
      Object.fromEntries(
        Object.entries(files).map(([file, text]) => [file, text.replaceAll(name, 'NAME')]),
      );
    expect(normalise(await tree(path.join(parent, 'from-file')), 'from-file')).toEqual(
      normalise(await tree(path.join(parent, 'from-flags')), 'from-flags'),
    );
  }, 30_000);

  it('lets a flag win over the file', async () => {
    const parent = await workDirectory();
    await writeFile(path.join(parent, 'answers.json'), '{"content.agentName": "from-file"}');
    const result = run(parent, [
      'acme',
      '--answers',
      'answers.json',
      '--agent',
      'from-flag',
      '--no-install',
    ]);
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(path.join(parent, 'acme/agents/from-flag.ts'))).toBe(true);
    expect(existsSync(path.join(parent, 'acme/agents/from-file.ts'))).toBe(false);
  }, 20_000);

  it.each([
    ['an unknown key', 'content.engin: x\n', /content\.engin/u],
    ['a bad value', 'content.engine: nope\n', /content\.engine/u],
    [
      'an answer that does not apply',
      'admin.modelBaseUrl: https://x.example\n',
      /admin\.modelBaseUrl/u,
    ],
    ['a file that is not an object', '- a\n', /object keyed by setup question id/u],
  ])(
    'exits 2 naming the problem for %s, and writes nothing',
    async (_name, text, message) => {
      const parent = await workDirectory();
      await writeFile(path.join(parent, 'answers.yaml'), text);
      const result = run(parent, ['acme', '--answers', 'answers.yaml']);
      expect(result.status).toBe(2);
      expect(result.stderr).toMatch(message);
      expect(result.stderr).toContain('answers.yaml');
      expect(existsSync(path.join(parent, 'acme'))).toBe(false);
    },
    20_000,
  );

  it('exits 2 naming a file that does not exist', async () => {
    const parent = await workDirectory();
    const result = run(parent, ['acme', '--answers', 'missing.yaml']);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('--answers missing.yaml: the file does not exist');
    expect(existsSync(path.join(parent, 'acme'))).toBe(false);
  }, 20_000);

  it('is refused with --cloud', async () => {
    const parent = await workDirectory();
    await writeFile(path.join(parent, 'answers.yaml'), 'setup.theme: blank\n');
    const result = run(parent, ['acme', '--cloud', 'aws', '--answers', 'answers.yaml']);
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/--answers/u);
    expect(existsSync(path.join(parent, 'acme'))).toBe(false);
  }, 20_000);
});

describe('--cloud local, the v1 Compose project (S1-16 regression)', () => {
  // The default moved to the v2 project; `--cloud local` keeps writing exactly what the bare
  // command wrote before: the template files, then the rendered artefacts, and a package.json that
  // depends on the published CLI alone.
  it('writes the same file list and package.json dependencies as the bare command did', async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), 'agent-workspace-generator-v1-'));
    created.push(parent);
    const target = path.join(parent, 'acme-ai');
    const output = captureStdout();

    await create([target, '--cloud', 'local'], { images, answers: DEFAULT_ANSWERS });

    const templates = (await readdir(new URL('../templates/', import.meta.url))).sort();
    const listed = output()
      .split('\n')
      .filter((line) => line.startsWith('  '))
      .map((line) => line.trim());
    expect(listed).toEqual([...templates, 'agent-workspace.yaml', '.env', '.gitignore']);
    const manifest = JSON.parse(await readFile(path.join(target, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    expect(manifest.dependencies).toEqual({ '@indx-workspace/cli': CLI_VERSION });
    expect(output()).toContain(
      `Next: cd ${target} && pnpm install --frozen-lockfile=false && pnpm start\n`,
    );
  });
});

describe('create writes a v2 project by default (S1-16)', () => {
  const V2_FILES = [
    'package.json',
    'pnpm-workspace.yaml',
    '.gitignore',
    'agent-workspace.yaml',
    'agents/assistant.ts',
    'surfaces/main.ts',
    'README.md',
    'evals/assistant.yaml',
    'AGENTS.md',
    'skills/refund-policy/SKILL.md',
  ];

  const targetIn = async (name: string) => {
    const parent = await mkdtemp(path.join(os.tmpdir(), 'agent-workspace-generator-v2-'));
    created.push(parent);
    return path.join(parent, name);
  };

  /** Every file under `directory`, as forward-slash relative paths. */
  async function listTree(directory: string): Promise<string[]> {
    const entries = await readdir(directory, { recursive: true, withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) =>
        path.relative(directory, path.join(entry.parentPath, entry.name)).replaceAll('\\', '/'),
      )
      .sort();
  }

  /** A terminal whose answers are scripted; records every question it was asked. */
  function scriptedTerminal(answers: readonly string[]): {
    readonly terminal: CreateTerminal;
    readonly asked: string[];
  } {
    const asked: string[] = [];
    const queue = [...answers];
    return {
      asked,
      terminal: {
        isTty: true,
        prompt: (question) => {
          if (question.endsWith('[Y/n] ')) return Promise.resolve('n');
          asked.push(question);
          const next = queue.shift();
          if (next === undefined) throw new Error(`unexpected question: ${question}`);
          return Promise.resolve(next);
        },
      },
    };
  }

  /**
   * A terminal that answers the theme question with `theme`, `[y/N]` with `y`, and every other
   * question with the empty line (the recommended answer); records every question it was asked.
   */
  const THEME_PROMPT =
    SETUP_QUESTIONS.find((question) => question.id === 'setup.theme')?.prompt ?? 'setup.theme';

  function themeTerminal(theme: string) {
    const questions: string[] = [];
    const prompt = (question: string): Promise<string> => {
      if (question.endsWith('[Y/n] ')) return Promise.resolve('n');
      questions.push(question);
      if (question.startsWith(THEME_PROMPT)) {
        return Promise.resolve(theme);
      }
      return Promise.resolve(
        question.endsWith('[y/N] ') ? 'y' : question.endsWith('[Y/n] ') ? 'n' : '',
      );
    };
    return { questions, prompt };
  }

  it.each(SETUP_THEMES)(
    'on a terminal, theme %s writes exactly the files aw init writes (C20)',
    async (theme) => {
      const target = await targetIn(`theme-${theme}`);
      captureStdout();
      const reference = themeTerminal(theme);
      const answers = await askSetupQuestions(reference.prompt, () => undefined);
      const name = projectNameFor(path.basename(target));
      const expected = renderProjectFiles(answers, { name, version: CLI_VERSION });
      const { questions, prompt } = themeTerminal(theme);

      await create([target], { terminal: { isTty: true, prompt } });

      const shell = renderProjectShell({
        name,
        version: CLI_VERSION,
        engine: answers['content.engine'],
      }).map((file) => file.path);
      expect(questions).toEqual([
        ...reference.questions,
        `write these ${String(shell.length + expected.length)} files into ${path.resolve(target)}? [y/N] `,
      ]);
      expect(await listTree(target)).toEqual(
        [...shell, ...expected.map((file) => file.path)].sort(),
      );
      for (const file of expected) {
        expect(await readFile(path.join(target, file.path), 'utf8'), file.path).toBe(file.contents);
      }
    },
  );

  it('on a terminal with menus, asks choices as menus and declines on a No menu', async () => {
    const target = await targetIn('menus');
    captureStdout();
    const titles: string[] = [];
    await create([target], {
      terminal: {
        isTty: true,
        prompt: () => Promise.resolve(''),
        choose: (spec) => {
          titles.push(spec.title);
          return Promise.resolve(spec.title.startsWith('Write') ? ['no'] : spec.initial);
        },
      },
    });
    expect(titles[0]).toMatch(/theme/iu);
    expect(titles.at(-1)).toMatch(/^Write these \d+ files into /u);
    expect(existsSync(target)).toBe(false);
  });

  it('on a terminal, Ctrl-C at a menu exits 130 and writes nothing', async () => {
    const target = await targetIn('menu-ctrl-c');
    const out = captureStdout();
    const before = process.exitCode;
    try {
      await create([target], {
        terminal: {
          isTty: true,
          prompt: () => Promise.resolve(''),
          choose: () => Promise.reject(new MenuCancelledError()),
        },
      });
      expect(process.exitCode).toBe(130);
    } finally {
      process.exitCode = before;
    }
    expect(out()).toContain('nothing written');
    expect(existsSync(target)).toBe(false);
  });

  it('on a terminal, theme knowledge writes the three starter files', async () => {
    const target = await targetIn('knowledge');
    captureStdout();

    await create([target], {
      terminal: { isTty: true, prompt: themeTerminal('knowledge').prompt },
    });

    for (const file of ['agent-workspace.yaml', 'agents/knowledge.ts', 'surfaces/main.ts']) {
      expect(existsSync(path.join(target, file)), file).toBe(true);
    }
  });

  it('--yes asks nothing, even on a terminal, and ends with the hand-off (#544)', async () => {
    const target = await targetIn('handoff');
    const output = captureStdout();
    const prompt = vi.fn<(question: string) => Promise<string>>();
    vi.stubEnv('ANTHROPIC_API_KEY', 'set');

    await create([target, '--yes', '--no-install'], { terminal: { isTty: true, prompt } });

    expect(prompt).not.toHaveBeenCalled();
    expect(output().trimEnd().split('\n').slice(-5)).toEqual([
      'aw dev reads ANTHROPIC_API_KEY from its environment; no key is written to a file.',
      'Next steps:',
      `  cd ${target}`,
      '  npm install',
      '  npm run dev',
    ]);
    expect(output()).not.toContain('aw login');
  });

  it('adds an export line to the next steps when the provider key is not in the environment', async () => {
    const target = await targetIn('nokey');
    const output = captureStdout();
    vi.stubEnv('OPENAI_API_KEY', '');

    await create([target, '--yes', '--no-install', '--provider', 'openai']);

    expect(output()).toContain(
      '  npm install\n  export OPENAI_API_KEY=<your key>\n  npm run dev\n',
    );
  });

  it('with stdin closed and one flag, writes the project, says so on stderr and asks nothing', async () => {
    const target = await targetIn('closed');
    const output = captureStdout();
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const prompt = vi.fn<(question: string) => Promise<string>>();

    await create([target, '--theme', 'copilot', '--provider', 'openai'], {
      terminal: { isTty: false, prompt },
    });

    expect(prompt).not.toHaveBeenCalled();
    expect(stderr).toHaveBeenCalledWith(
      'no terminal: used your flags and the recommended answers for the rest (to choose others, pass more flags or --answers <file>; see --help)\n',
    );
    expect(output()).toContain('Next steps:');
    expect(await readFile(path.join(target, 'agent-workspace.yaml'), 'utf8')).toContain('openai');
    expect(await readFile(path.join(target, 'surfaces/main.ts'), 'utf8')).toContain('Copilot');
  });

  it('does not ask a question a flag answered, on a terminal', async () => {
    const target = await targetIn('flagged');
    captureStdout();
    const asked: string[] = [];
    await create([target, '--sandbox', 'local'], {
      terminal: {
        isTty: true,
        prompt: (question) => {
          if (question.endsWith('[Y/n] ')) return Promise.resolve('n');
          asked.push(question);
          return Promise.resolve(question.startsWith('write these') ? 'y' : '');
        },
      },
    });
    expect(asked.some((question) => question.startsWith('Where should agents run'))).toBe(false);
    // Conditional questions (the model endpoint) are not asked for the default provider.
    const applicable = SETUP_QUESTIONS.filter(
      (question) =>
        question.flag !== 'sandbox' &&
        setupQuestionApplies(question, { 'admin.modelProvider': 'anthropic' }),
    );
    expect(asked).toHaveLength(applicable.length + 1);
  });

  it('asks for the model endpoint on a terminal only for the providers that need one', async () => {
    for (const provider of ['azure-openai', 'openai-compatible', 'openai', 'anthropic'] as const) {
      const asked: string[] = [];
      await askSetupQuestions(
        (question) => {
          asked.push(question);
          return Promise.resolve(
            question.startsWith('Where is') ? 'https://models.example/v1' : '',
          );
        },
        () => undefined,
        { 'admin.modelProvider': provider },
      );
      const needsEndpoint = provider === 'azure-openai' || provider === 'openai-compatible';
      expect(
        asked.some((question) => question.startsWith("Where is the model provider's endpoint?")),
        provider,
      ).toBe(needsEndpoint);
    }
  });

  it('prints every setup flag for --help', async () => {
    const output = captureStdout();
    await create(['--help']);
    for (const question of SETUP_QUESTIONS) expect(output()).toContain(`--${question.flag} <`);
  });

  it('writes the platforms block and the README section for --platform (#977)', async () => {
    const target = await targetIn('acme-ai');
    captureStdout();
    vi.stubEnv('ANTHROPIC_API_KEY', 'set');

    await create([target, '--yes', '--no-install', '--platform', 'claude-managed-agents']);

    expect(await listTree(target)).toEqual([...V2_FILES].sort());
    expect(await readFile(path.join(target, 'agent-workspace.yaml'), 'utf8')).toContain(
      'platforms:\n  claude-managed-agents:\n    enabled: true\n',
    );
    expect(await readFile(path.join(target, 'README.md'), 'utf8')).toContain(
      '## Publish to other agent platforms',
    );
    expect(await readFile(path.join(target, 'AGENTS.md'), 'utf8')).toContain(
      '## Other agent platforms',
    );
  });

  it('refuses a platform setup does not offer as a usage error, writing no directory (#977)', async () => {
    const target = await targetIn('acme-ai');
    const written: string[] = [];

    const status = await runAsProcess(
      () => create([target, '--yes', '--no-install', '--platform', 'eject-mastra']),
      (chunk) => written.push(chunk),
    );

    expect(status).toBe(2);
    expect(written.join('')).toContain(
      '--platform: ["eject-mastra"] is not accepted: up to 6 of claude-managed-agents, copilot-studio, m365-declarative-agent, microsoft-foundry, gemini-enterprise, aws-agentcore, none, separated by commas',
    );
    expect(existsSync(target)).toBe(false);
  });

  it('refuses --platform with --cloud (#977)', async () => {
    const target = await targetIn('acme-ai');
    await expect(
      create([target, '--cloud', 'gcp', '--platform', 'copilot-studio']),
    ).rejects.toThrow(/setup flags/u);
    expect(existsSync(target)).toBe(false);
  });

  it('writes the six files of the golden project with --yes', async () => {
    const target = await targetIn('acme-ai');
    const output = captureStdout();
    vi.stubEnv('ANTHROPIC_API_KEY', 'set');

    await create([target, '--yes', '--no-install']);

    const name = 'acme-ai';
    const answers = withRecommendedAnswers({});
    const expected = [
      ...renderProjectShell({ name, version: CLI_VERSION, engine: answers['content.engine'] }),
      ...renderProjectFiles(answers, { name, version: CLI_VERSION }),
    ];
    expect(expected.map((file) => file.path)).toEqual(V2_FILES);
    expect(await listTree(target)).toEqual([...V2_FILES].sort());
    for (const file of expected) {
      expect(await readFile(path.join(target, file.path), 'utf8'), file.path).toBe(file.contents);
    }
    const manifest = JSON.parse(await readFile(path.join(target, 'package.json'), 'utf8')) as {
      name?: string;
      scripts?: Record<string, string>;
      dependencies?: Record<string, string>;
      allowScripts?: Record<string, boolean>;
    };
    expect(manifest).toMatchObject({
      name: 'acme-ai',
      scripts: { dev: 'aw dev' },
      dependencies: {
        '@indx-workspace/aw': CLI_VERSION,
        '@indx-workspace/embedded': CLI_VERSION,
        '@indx-workspace/sdk': CLI_VERSION,
      },
      // npm 11's install-script policy (issue #689); the list itself is pinned in the sdk.
      allowScripts: { '@embedded-postgres/linux-x64': true, protobufjs: false },
    });

    const text = output();
    expect(text).toContain(`Created ${target}\n`);
    for (const file of V2_FILES) expect(text).toContain(`  ${file}\n`);
    expect(text).toContain(`Next steps:\n  cd ${target}\n  npm install\n  npm run dev\n`);
    expect(text).toContain('aw dev reads ANTHROPIC_API_KEY from its environment');
    // The recommended theme, support, writes its greeting (#543).
    expect(await readFile(path.join(target, 'surfaces/main.ts'), 'utf8')).toContain(
      "greeting: 'Hi! How can I help you today?',",
    );
    expect(text).not.toContain('Host runtime detected');
    expect(text).not.toContain('One-time setup password');
  });

  it('writes the same three starter files `aw init --yes` writes', async () => {
    const target = await targetIn('Acme AI');
    const result = await createProject(target, withRecommendedAnswers({}));

    expect(result.destination).toBe(path.resolve(target));
    expect(result.files).toEqual(V2_FILES);
    for (const file of renderProjectFiles(withRecommendedAnswers({}), { name: 'acme-ai' })) {
      expect(await readFile(path.join(target, file.path), 'utf8'), file.path).toBe(file.contents);
    }
  });

  it('asks the setup questions on a terminal, re-asks a refused answer, and writes on yes', async () => {
    const target = await targetIn('support');
    const output = captureStdout();
    const { terminal, asked } = scriptedTerminal([
      '',
      'local',
      '',
      'helpdesk',
      '',
      'none,openapi',
      'openapi',
      'apis/orders.openapi.json',
      'readFiles',
      'Support Desk',
      'blue',
      '#112233',
      '',
      'y',
    ]);

    await create([target], { terminal });

    // Twelve questions, the refused tools and colour asked twice, then the confirmation.
    expect(asked).toHaveLength(14);
    expect(asked[0]).toBe(
      'Which theme should setup start from? (support | copilot | knowledge | automation | review | blank) [support] ',
    );
    expect(asked[1]).toBe('Where should agents run their tools? (auto | local) [auto] ');
    expect(asked[5]).toBe(
      'Which internal tools should the agent call? (openapi | postgres | none; comma-separated) [none] ',
    );
    expect(asked[6]).toBe(asked[5]);
    expect(asked[7]).toContain('Where is the OpenAPI document?');
    expect(asked[8]).toMatch(/^Which permissions should the agent have\? \(.*\) \[\] $/u);
    expect(asked[9]).toContain('(1-60 characters, no control or invisible characters');
    expect(asked[10]).toContain('[#2f5fd0]');
    expect(asked[11]).toBe(asked[10]);
    // The seven files, AGENTS.md, the OpenAPI tool (#543) and the example skill (#694).
    expect(asked[12]).toBe(
      'Which agent platforms should this agent also be published to? (claude-managed-agents | copilot-studio | m365-declarative-agent | microsoft-foundry | gemini-enterprise | aws-agentcore | none; comma-separated) [none] ',
    );
    expect(asked[13]).toBe(`write these 11 files into ${target}? [y/N] `);
    expect(output()).toContain(
      '["none","openapi"] is not accepted: up to 2 of openapi, postgres, none, separated by commas; none must be chosen alone',
    );
    expect(output()).toContain('"blue" is not accepted: a hex colour');

    const answers = withRecommendedAnswers({
      'admin.sandbox': 'local',
      'content.agentName': 'helpdesk',
      'content.internalTools': ['openapi'],
      'content.openapiDocument': 'apis/orders.openapi.json',
      'content.permissions': ['readFiles'],
      'embedder.surfaceTitle': 'Support Desk',
      'embedder.brandColour': '#112233',
    });
    for (const file of renderProjectFiles(answers, { name: 'support' })) {
      expect(await readFile(path.join(target, file.path), 'utf8'), file.path).toBe(file.contents);
    }
    const surface = await readFile(path.join(target, 'surfaces/main.ts'), 'utf8');
    expect(surface).toContain("title: 'Support Desk'");
    expect(surface).toContain('#112233');
    expect(existsSync(path.join(target, 'agents/helpdesk.ts'))).toBe(true);
    expect(await readFile(path.join(target, 'tools/orders.ts'), 'utf8')).toContain(
      "auth: secret('ORDERS_TOKEN')",
    );
    expect(output()).toContain(
      'aw dev reads ANTHROPIC_API_KEY, ORDERS_TOKEN from its environment; no key is written',
    );
  });

  it('writes nothing when the file list is declined', async () => {
    const target = await targetIn('declined');
    const output = captureStdout();
    const { terminal } = scriptedTerminal([...Array<string>(10).fill(''), 'n']);

    await create([target], { terminal });

    expect(output()).toContain('create will write:\n  package.json\n');
    expect(output()).toContain('nothing written\n');
    expect(existsSync(target)).toBe(false);
  });

  it('skips the OpenAPI question when no tool is chosen', async () => {
    const target = await targetIn('no-tools');
    captureStdout();
    const { terminal, asked } = scriptedTerminal([...Array<string>(10).fill(''), 'n']);

    await create([target], { terminal });

    expect(asked).toHaveLength(11);
    expect(asked.some((question) => question.startsWith('Where is the OpenAPI document?'))).toBe(
      false,
    );
  });

  it("recommends the chosen theme's answers", async () => {
    const target = await targetIn('copilot');
    captureStdout();
    const { terminal, asked } = scriptedTerminal(['copilot', ...Array<string>(9).fill(''), 'y']);

    await create([target], { terminal });

    expect(asked[3]).toMatch(/^What is your first agent called\? .*\[copilot\] $/u);
    expect(asked[7]).toContain('[Copilot] ');
    expect(existsSync(path.join(target, 'agents/copilot.ts'))).toBe(true);
  });

  it('answers every prompt the way the journey does (C20)', async () => {
    const target = await targetIn('journey');
    captureStdout();
    const asked: string[] = [];
    const terminal: CreateTerminal = {
      isTty: true,
      prompt: (question) => {
        // The journey's menus answer the install question; this typed terminal declines it.
        if (question.endsWith('[Y/n] ')) return Promise.resolve('n');
        asked.push(question);
        const answer = createAnswerFor(question, { 'What is your brand colour?': '#c0392b' });
        if (answer === null) throw new Error(`the journey would not answer: ${question}`);
        return Promise.resolve(answer);
      },
    };

    await create([target], { terminal });

    expect(asked.length).toBeLessThanOrEqual(SETUP_QUESTIONS.length + 1);
    expect(await readFile(path.join(target, 'surfaces/main.ts'), 'utf8')).toContain('#c0392b');
  });

  it('takes the recommended answers as a process with stdin closed', async () => {
    const target = await targetIn('spawned');
    const result = spawnSync(
      process.execPath,
      [fileURLToPath(new URL('./create.ts', import.meta.url)), target, '--color', '#0f6b77'],
      {
        cwd: path.resolve(fileURLToPath(new URL('../../../', import.meta.url))),
        encoding: 'utf8',
        input: '',
      },
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toContain('no terminal: used your flags and the recommended answers');
    expect(existsSync(path.join(target, 'surfaces/main.ts'))).toBe(true);
  }, 20_000);

  it('refuses a directory that already exists, and writes nothing into it', async () => {
    const target = await targetIn('existing');
    await mkdir(target);

    await expect(create([target, '--yes', '--no-install'])).rejects.toThrow(
      `${target} already exists; create writes a new directory`,
    );
    const { terminal, asked } = scriptedTerminal([]);
    await expect(create([target], { terminal })).rejects.toThrow(/already exists/u);
    expect(asked).toEqual([]);
    expect(await readdir(target)).toEqual([]);
  });

  // S1-16 review: a raw `ENOENT: no such file or directory, mkdir '…'` reached the operator.
  it('refuses a target whose parent does not exist with a plain refusal, not an errno string', async () => {
    const parent = await targetIn('missing-parent');
    const target = path.join(parent, 'deep');

    const refusal = create([target, '--yes', '--no-install']);
    await expect(refusal).rejects.toThrow(
      `${parent} does not exist; create writes one new directory and never its parents.`,
    );
    await expect(refusal).rejects.not.toThrow(/ENOENT/u);
    expect(existsSync(parent)).toBe(false);
  });

  // S1-16 review: an over-long name surfaced as a raw ENAMETOOLONG/EINVAL errno string.
  it('refuses a name the file system rejects with a plain refusal', async () => {
    const target = await targetIn('x'.repeat(300));

    const refusal = create([target, '--yes', '--no-install']);
    await expect(refusal).rejects.toThrow(/is not a valid directory name here|does not exist/u);
    await expect(refusal).rejects.not.toThrow(/ENAMETOOLONG|EINVAL|ENOENT/u);
  });

  // S1-16 review: a newline in the name could forge lines of create's output.
  it('refuses a target holding a control character before anything is written', () => {
    expect(() => parseCreateArguments(['c\nCreated fake', '--yes'])).toThrow(
      /holds a control character/u,
    );
    expect(() => parseCreateArguments(['c\u0007', '--cloud', 'local'])).toThrow(
      /holds a control character/u,
    );
  });

  // S1-16 review: double quotes let a copied hint run `$( )` or a backtick command.
  it('single-quotes a target in the printed hints, so a copied hint runs no embedded command', async () => {
    const target = await targetIn("a$(touch PWNED) b`id` c'd");
    const quoted = `'${target.replaceAll("'", String.raw`'\''`)}'`;
    const output = captureStdout();

    await create([target, '--yes', '--no-install'], { platform: 'linux' });
    expect(output()).toContain(`Next steps:\n  cd ${quoted}\n  npm install\n`);
    expect(output()).not.toContain(`"${target}"`);
  });

  /**
   * The repository has no secret scanner, so the patterns a scanner flags are listed here. The
   * v2 project holds no credential: `aw dev` reads the model key from its own environment.
   */
  it('writes no file a secret scanner would flag, and no .env', async () => {
    const target = await targetIn('scanned');
    await create([target, '--yes', '--no-install']);
    const patterns: readonly RegExp[] = [
      /sk-ant-/u,
      /AKIA[0-9A-Z]{16}/u,
      /-----BEGIN .*PRIVATE KEY-----/u,
      /ANTHROPIC_API_KEY=\S/u,
      /(?:password|secret|token)\s*[:=]\s*['"]?[^\s'"]{16,}/iu,
      /\b[0-9a-f]{32,}\b/iu,
      /[A-Za-z0-9_-]{32,}/u,
    ];
    const files = await listTree(target);
    expect(files).toEqual([...V2_FILES].sort());
    for (const file of files) {
      const text = await readFile(path.join(target, file), 'utf8');
      for (const pattern of patterns)
        expect(text, `${file} ${String(pattern)}`).not.toMatch(pattern);
    }
    expect(existsSync(path.join(target, '.env'))).toBe(false);
  });

  /**
   * The deployment commands read `agent-workspace.yaml` as a v1 profile. Until P-2 they refuse a
   * v2 project by name, as one line, through the same `runAsProcess` the binary exits through.
   */
  it.each(['validate', 'render', 'doctor', 'deploy'])(
    'agent-workspace %s refuses the v2 project with the P-2 sentence',
    async (verb) => {
      const target = await targetIn('acme-ai');
      const stdout = captureStdout();
      await create([target, '--yes', '--no-install']);
      stdout();
      const written: string[] = [];
      const errors = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

      const status = await runAsProcess(
        async () => {
          const code = await runCli([verb, target]);
          if (code !== 0) throw new Error(`exit ${String(code)}`);
        },
        (chunk) => written.push(chunk),
      );

      errors.mockRestore();
      const everything = `${stdout()}${written.join('')}`;
      expect(status).toBe(1);
      expect(everything).toContain(PROJECT_KIND_REFUSAL);
      expect(everything).not.toContain('\n    at ');
      expect(written.join('').trimEnd().split('\n')).toHaveLength(1);
    },
    20_000,
  );
});

describe('create finishes the job (UX-D, #760)', () => {
  const targetIn = async (name: string) => {
    const parent = await mkdtemp(path.join(os.tmpdir(), 'agent-workspace-finish-'));
    created.push(parent);
    return path.join(parent, name);
  };

  /** Records every package-manager call; `codes` are the exit codes it answers with, in order. */
  function recorder(codes: readonly number[] = []) {
    const calls: { manager: string; args: readonly string[]; cwd: string }[] = [];
    const queue = [...codes];
    const run: RunInProject = (manager, args, cwd) => {
      calls.push({ manager, args, cwd });
      return Promise.resolve(queue.shift() ?? 0);
    };
    return { calls, run };
  }

  /** A menu terminal: every menu takes its default except those `answers` names by title. */
  function menus(answers: Readonly<Record<string, string>> = {}) {
    const titles: string[] = [];
    const terminal: CreateTerminal = {
      isTty: true,
      prompt: () => Promise.resolve(''),
      choose: (spec) => {
        titles.push(spec.title);
        const answer = answers[spec.title];
        return Promise.resolve(answer === undefined ? spec.initial : [answer]);
      },
    };
    return { terminal, titles };
  }

  const withoutKey = () => vi.stubEnv('ANTHROPIC_API_KEY', '');

  describe('arguments', () => {
    it('reads --install, --no-install, --start and --no-start', () => {
      const read = (...flags: string[]) => {
        const parsed = parseCreateArguments(['acme', ...flags]);
        if (parsed.kind !== 'project') throw new Error('not a project');
        return { install: parsed.install, start: parsed.start };
      };
      expect(read()).toEqual({ install: undefined, start: undefined });
      expect(read('--install')).toEqual({ install: true, start: undefined });
      expect(read('--no-install')).toEqual({ install: false, start: undefined });
      expect(read('--no-start')).toEqual({ install: undefined, start: false });
      // --start needs the dependencies, so it implies --install.
      expect(read('--start')).toEqual({ install: true, start: true });
      expect(read('--install', '--no-start')).toEqual({ install: true, start: false });
    });

    it('refuses --start with --no-install, and the flags with --cloud', () => {
      expect(() => parseCreateArguments(['acme', '--start', '--no-install'])).toThrow(
        /--start runs the project after its dependencies are installed/u,
      );
      expect(() => parseCreateArguments(['acme', '--cloud', 'gcp', '--install'])).toThrow(
        /--install and --start belong to the project/u,
      );
    });

    it('documents the flags in --help', async () => {
      const output = captureStdout();
      await runCreateCommand(['--help']);
      expect(output()).toContain('--install / --no-install');
      expect(output()).toContain('--start / --no-start');
    });
  });

  describe('package manager', () => {
    it.each([
      ['npm/11.0.0 node/v24.0.0 win32 x64 workspaces/false', 'npm'],
      ['pnpm/10.4.0 npm/? node/v24.0.0 linux x64', 'pnpm'],
      ['yarn/4.5.0 npm/? node/v24.0.0 darwin arm64', 'yarn'],
      ['bun/1.2.0 npm/? node/v24.0.0 linux x64', 'bun'],
      ['something/1.0.0', 'npm'],
      [undefined, 'npm'],
    ] as const)('detects %s as %s', (userAgent, expected) => {
      expect(detectPackageManager(userAgent)).toBe(expected);
    });

    it('spawns the manager directly off Windows, and through the shell as one string on Windows', () => {
      expect(packageManagerSpawn('pnpm', ['run', 'dev'], 'linux')).toEqual({
        command: 'pnpm',
        args: ['run', 'dev'],
        shell: false,
      });
      expect(packageManagerSpawn('npm', ['install'], 'darwin').shell).toBe(false);
      expect(packageManagerSpawn('npm', ['install'], 'win32')).toEqual({
        command: 'npm install',
        args: [],
        shell: true,
      });
    });

    it('actually runs the chosen form on this host: npm --version exits 0 in the project dir', async () => {
      const dir = path.dirname(await targetIn('x'));
      expect(await spawnInProject('npm', ['--version'], dir, 'ignore')).toBe(0);
      expect(await spawnInProject('npm', ['run', 'no-such-script'], dir, 'ignore')).not.toBe(0);
    }, 60_000);
  });

  describe('next steps', () => {
    const base = { target: 'acme', manager: 'npm', installed: false, missingKey: null } as const;

    it('lists cd, install, the key and run, in that order, for POSIX shells', () => {
      expect(
        nextStepLines({ ...base, missingKey: 'ANTHROPIC_API_KEY', platform: 'linux' }),
      ).toEqual(['cd acme', 'npm install', 'export ANTHROPIC_API_KEY=<your key>', 'npm run dev']);
    });

    it('gives PowerShell and cmd lines on Windows, and double-quotes a name with a space', () => {
      expect(
        nextStepLines({
          ...base,
          target: 'my agent',
          manager: 'pnpm',
          missingKey: 'OPENAI_API_KEY',
          platform: 'win32',
        }),
      ).toEqual([
        'cd "my agent"',
        'pnpm install',
        'PowerShell: $env:OPENAI_API_KEY="<your key>"',
        'cmd:        set OPENAI_API_KEY=<your key>',
        'pnpm run dev',
      ]);
    });

    it('leaves out what is done: no install once installed, no key line when it is set', () => {
      expect(nextStepLines({ ...base, installed: true, platform: 'linux' })).toEqual([
        'cd acme',
        'npm run dev',
      ]);
    });

    it('single-quotes off Windows, closing and reopening a quote inside the name', () => {
      expect(shellArgument("a b'c", 'linux')).toBe(String.raw`'a b'\''c'`);
      expect(shellArgument('a b', 'win32')).toBe('"a b"');
      expect(shellArgument('plain-name', 'win32')).toBe('plain-name');
    });

    it('single-quotes a `$` or backtick on Windows so PowerShell keeps it literal', () => {
      expect(shellArgument('a$b c', 'win32')).toBe("'a$b c'");
      expect(shellArgument("a`b'c", 'win32')).toBe("'a`b''c'");
    });
  });

  describe('install and start on a terminal', () => {
    it('asks both with a Yes default, runs install then dev in the project, and prints no steps', async () => {
      const target = await targetIn('both');
      const output = captureStdout();
      const { calls, run } = recorder();
      const { terminal, titles } = menus();
      vi.stubEnv('npm_config_user_agent', 'pnpm/10.0.0 node/v24.0.0');

      await runCreateCommand([target], { terminal, run, platform: 'linux' });

      expect(titles.slice(-2)).toEqual(['Install dependencies now?', 'Start it now?']);
      expect(calls).toEqual([
        { manager: 'pnpm', args: ['install'], cwd: path.resolve(target) },
        { manager: 'pnpm', args: ['run', 'dev'], cwd: path.resolve(target) },
      ]);
      expect(output()).not.toContain('Next steps:');
      expect(output()).not.toContain('aw login');
    });

    it('prints cd, the key and run when install is accepted and start is declined', async () => {
      const target = await targetIn('no-start');
      const output = captureStdout();
      const { calls, run } = recorder();
      withoutKey();

      await runCreateCommand([target], {
        terminal: menus({ 'Start it now?': 'no' }).terminal,
        run,
        platform: 'linux',
      });

      expect(calls.map((call) => call.args)).toEqual([['install']]);
      expect(output()).toContain(
        `Next steps:\n  cd ${target}\n  export ANTHROPIC_API_KEY=<your key>\n  npm run dev\n`,
      );
      expect(output()).not.toContain('npm install\n');
    });

    it('declining install runs nothing, never asks about start, and prints every step', async () => {
      const target = await targetIn('no-install');
      const output = captureStdout();
      const { calls, run } = recorder();
      const { terminal, titles } = menus({ 'Install dependencies now?': 'no' });
      vi.stubEnv('ANTHROPIC_API_KEY', 'set');

      await runCreateCommand([target], { terminal, run, platform: 'linux' });

      expect(calls).toEqual([]);
      expect(titles).not.toContain('Start it now?');
      expect(output()).toContain(`Next steps:\n  cd ${target}\n  npm install\n  npm run dev\n`);
    });

    it('asks a typed [Y/n] question where there is no menu, and Enter means yes', async () => {
      const target = await targetIn('typed');
      captureStdout();
      const { calls, run } = recorder();
      const asked: string[] = [];

      await runCreateCommand([target], {
        terminal: {
          isTty: true,
          prompt: (question) => {
            asked.push(question);
            if (question.endsWith('[y/N] ')) return Promise.resolve('y');
            return Promise.resolve(question === 'Start it now? [Y/n] ' ? 'n' : '');
          },
        },
        run,
        platform: 'linux',
      });

      expect(asked.slice(-3)).toEqual([
        expect.stringMatching(/\[y\/N\] $/u),
        'Install dependencies now? [Y/n] ',
        'Start it now? [Y/n] ',
      ]);
      expect(calls.map((call) => call.args)).toEqual([['install']]);
    });

    it('--no-install skips both offers; --no-start skips only the second', async () => {
      const first = menus();
      captureStdout();
      const one = recorder();
      await runCreateCommand([await targetIn('a'), '--no-install'], {
        terminal: first.terminal,
        run: one.run,
        platform: 'linux',
      });
      expect(one.calls).toEqual([]);
      expect(first.titles).not.toContain('Install dependencies now?');
      expect(first.titles).not.toContain('Start it now?');

      const second = menus();
      const two = recorder();
      await runCreateCommand([await targetIn('b'), '--no-start'], {
        terminal: second.terminal,
        run: two.run,
        platform: 'linux',
      });
      expect(two.calls.map((call) => call.args)).toEqual([['install']]);
      expect(second.titles).toContain('Install dependencies now?');
      expect(second.titles).not.toContain('Start it now?');
    });

    it('--start answers both questions without asking', async () => {
      const { terminal, titles } = menus();
      captureStdout();
      const { calls, run } = recorder();
      await runCreateCommand([await targetIn('c'), '--start'], {
        terminal,
        run,
        platform: 'linux',
      });
      expect(calls.map((call) => call.args)).toEqual([['install'], ['run', 'dev']]);
      expect(titles).not.toContain('Install dependencies now?');
      expect(titles).not.toContain('Start it now?');
    });

    it('a failed install exits 1, never starts, and still prints the install step', async () => {
      const target = await targetIn('failed');
      const output = captureStdout();
      const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      const { calls, run } = recorder([1]);
      const before = process.exitCode;
      vi.stubEnv('ANTHROPIC_API_KEY', 'set');
      try {
        await runCreateCommand([target], { terminal: menus().terminal, run, platform: 'linux' });
        expect(process.exitCode).toBe(1);
      } finally {
        process.exitCode = before;
      }
      expect(calls.map((call) => call.args)).toEqual([['install']]);
      expect(stderr).toHaveBeenCalledWith(expect.stringContaining('npm install failed (exit 1)'));
      expect(output()).toContain('  npm install\n  npm run dev\n');
    });

    it('Ctrl-C at the install question exits 130, runs nothing and prints the steps', async () => {
      const target = await targetIn('cancel-install');
      const output = captureStdout();
      const { calls, run } = recorder();
      const before = process.exitCode;
      try {
        await runCreateCommand([target], {
          terminal: {
            isTty: true,
            prompt: () => Promise.resolve(''),
            choose: (spec) =>
              spec.title === 'Install dependencies now?'
                ? Promise.reject(new MenuCancelledError())
                : Promise.resolve(spec.initial),
          },
          run,
          platform: 'linux',
        });
        expect(process.exitCode).toBe(130);
      } finally {
        process.exitCode = before;
      }
      expect(calls).toEqual([]);
      expect(output()).toContain('Next steps:');
    });
  });

  describe('without a terminal, and --yes', () => {
    it('never installs or starts without a flag', async () => {
      const target = await targetIn('closed');
      const output = captureStdout();
      vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      const { calls, run } = recorder();
      vi.stubEnv('ANTHROPIC_API_KEY', 'set');

      await runCreateCommand([target], {
        terminal: { isTty: false, prompt: vi.fn() },
        run,
        platform: 'linux',
      });

      expect(calls).toEqual([]);
      expect(output()).toContain(`Next steps:\n  cd ${target}\n  npm install\n  npm run dev\n`);
    });

    it('--install alone installs and does not start; --start does both', async () => {
      captureStdout();
      vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      const terminal = { isTty: false, prompt: vi.fn() };
      const one = recorder();
      await runCreateCommand([await targetIn('i'), '--install'], { terminal, run: one.run });
      expect(one.calls.map((call) => call.args)).toEqual([['install']]);
      const two = recorder();
      await runCreateCommand([await targetIn('s'), '--start'], { terminal, run: two.run });
      expect(two.calls.map((call) => call.args)).toEqual([['install'], ['run', 'dev']]);
    });

    it('a non-zero exit from the started dev run becomes the exit code', async () => {
      captureStdout();
      const { run } = recorder([0, 1]);
      const before = process.exitCode;
      try {
        await runCreateCommand([await targetIn('devfail'), '--yes', '--start'], { run });
        expect(process.exitCode).toBe(1);
      } finally {
        process.exitCode = before;
      }
    });

    it('--yes installs and does not start, on a terminal or not, asking nothing', async () => {
      const target = await targetIn('yes');
      const output = captureStdout();
      const { calls, run } = recorder();
      const prompt = vi.fn<(question: string) => Promise<string>>();
      vi.stubEnv('ANTHROPIC_API_KEY', 'set');

      await runCreateCommand([target, '--yes'], {
        terminal: { isTty: true, prompt },
        run,
        platform: 'linux',
      });

      expect(prompt).not.toHaveBeenCalled();
      expect(calls.map((call) => call.args)).toEqual([['install']]);
      expect(output()).toContain(`Next steps:\n  cd ${target}\n  npm run dev\n`);
    });

    it('--yes --start installs and starts; --yes --no-install installs nothing', async () => {
      captureStdout();
      const started = recorder();
      await runCreateCommand([await targetIn('ys'), '--yes', '--start'], { run: started.run });
      expect(started.calls.map((call) => call.args)).toEqual([['install'], ['run', 'dev']]);
      const skipped = recorder();
      await runCreateCommand([await targetIn('yn'), '--yes', '--no-install'], {
        run: skipped.run,
      });
      expect(skipped.calls).toEqual([]);
    });
  });

  describe('the project name', () => {
    it('asks it first, typed, when no directory is given, and creates what was typed', async () => {
      const target = await targetIn('named');
      captureStdout();
      const asked: string[] = [];

      await runCreateCommand([], {
        terminal: {
          isTty: true,
          prompt: (question) => {
            asked.push(question);
            if (asked.length === 1) return Promise.resolve(target);
            if (question.endsWith('[y/N] ')) return Promise.resolve('y');
            return Promise.resolve(question.endsWith('[Y/n] ') ? 'n' : '');
          },
        },
        platform: 'linux',
      });

      expect(asked[0]).toBe('? Project name (my-agent) ');
      expect(existsSync(path.join(target, 'agent-workspace.yaml'))).toBe(true);
    });

    it('prints `cd` to the typed name and lists the files once (BH061-015, BH061-073)', async () => {
      const target = await targetIn('typed-cd');
      const output = captureStdout();

      await runCreateCommand([], {
        terminal: {
          isTty: true,
          prompt: (question) => {
            if (question.startsWith('? Project name')) return Promise.resolve(target);
            if (question.endsWith('[y/N] ')) return Promise.resolve('y');
            return Promise.resolve(question.endsWith('[Y/n] ') ? 'n' : '');
          },
        },
        platform: 'linux',
      });

      expect(output()).toContain(`Next steps:\n  cd ${target}\n`);
      expect(output()).not.toContain('cd my-agent');
      expect(output().match(/^ {2}agent-workspace\.yaml$/gmu)).toHaveLength(1);
    });

    it('says the project name when the directory name cannot be one (BH061-053)', async () => {
      const target = path.join(path.dirname(await targetIn('wide')), 'エージェント');
      const output = captureStdout();
      await runCreateCommand([target, '--yes', '--no-install']);
      expect(output()).toContain(
        'project name: agent-workspace (the directory stays "エージェント")\n',
      );
    });

    it('Ctrl-C at the name exits 130 and writes nothing (BH061-014)', async () => {
      const output = captureStdout();
      const before = process.exitCode;
      try {
        await runCreateCommand([], {
          terminal: { isTty: true, prompt: () => Promise.reject(new MenuCancelledError()) },
        });
        expect(process.exitCode).toBe(130);
      } finally {
        process.exitCode = before;
      }
      expect(output()).toContain('nothing written\n');
    });

    it('asks again after a name that already exists or is not a name', async () => {
      const taken = await targetIn('taken');
      await mkdir(taken);
      const free = await targetIn('free');
      const output = captureStdout();
      const typed = [taken, 'bad\u0007name', free];
      const asked: string[] = [];

      await runCreateCommand([], {
        terminal: {
          isTty: true,
          prompt: (question) => {
            asked.push(question);
            if (question.startsWith('? Project name')) return Promise.resolve(typed.shift() ?? '');
            if (question.endsWith('[y/N] ')) return Promise.resolve('y');
            return Promise.resolve(question.endsWith('[Y/n] ') ? 'n' : '');
          },
        },
        platform: 'linux',
      });

      expect(asked.filter((question) => question.startsWith('? Project name'))).toHaveLength(3);
      expect(output()).toContain(`${taken} already exists; choose another name.\n`);
      expect(output()).toContain('A name cannot hold a control character.\n');
      expect(existsSync(path.join(free, 'agent-workspace.yaml'))).toBe(true);
      expect(await readdir(taken)).toEqual([]);
    });

    it('takes my-agent in the working directory, saying so on stderr, with no terminal', async () => {
      const parent = path.dirname(await targetIn('cwd'));
      const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      captureStdout();
      const before = process.cwd();
      process.chdir(parent);
      try {
        await runCreateCommand(['--yes', '--no-install']);
      } finally {
        process.chdir(before);
      }
      expect(stderr).toHaveBeenCalledWith('no directory given: using my-agent\n');
      expect(existsSync(path.join(parent, 'my-agent', 'agent-workspace.yaml'))).toBe(true);
    });

    it('does not ask when a directory is given', async () => {
      const prompt = vi.fn<(question: string) => Promise<string>>();
      captureStdout();
      await runCreateCommand([await targetIn('given'), '--yes', '--no-install'], {
        terminal: { isTty: true, prompt },
      });
      expect(prompt).not.toHaveBeenCalled();
    });
  });
});
