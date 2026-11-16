import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createWorkspace } from './create.js';
import { parseProfileDocument, PROFILE_SCHEMA_URL } from './profile.js';
import { CLI_VERSION } from './version.js';
import { created, images, options } from './create-test-fixtures.test-support.js';

export function describeCreateCloud(): void {
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
        expect(document.split('\n')[0]).toBe(
          `# yaml-language-server: $schema=${PROFILE_SCHEMA_URL}`,
        );
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
            database: 'PostgreSQL 18',
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
}
