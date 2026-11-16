import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createWorkspace, type GeneratorAnswers } from './create.js';
import { parseProfileDocument } from './profile.js';
import { created, images, cloudImages, options } from './create-test-fixtures.test-support.js';

export function describeCreateWorkspace(): void {
  describe('createWorkspace', () => {
    it('writes an operational deployment contract for every selected dimension', async () => {
      const parent = await mkdtemp(path.join(os.tmpdir(), 'agent-workspace-generator-'));
      created.push(parent);
      const target = path.join(parent, 'example');
      await createWorkspace(
        target,
        {
          database: 'PostgreSQL 18',
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
          database: 'PostgreSQL 18',
          storage: 'local filesystem',
          runtime: 'docker',
          authentication: 'local administrator',
        },
        options,
      );
      const cli = JSON.parse(
        await readFile(new URL('../package.json', import.meta.url), 'utf8'),
      ) as {
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
          database: 'PostgreSQL 18',
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
        database: 'PostgreSQL 18',
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
          database: 'PostgreSQL 18',
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
}
