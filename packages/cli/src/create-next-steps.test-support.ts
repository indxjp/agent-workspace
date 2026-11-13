import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_ANSWERS } from './create.js';
import {
  created,
  images,
  cloudImages,
  create,
  captureStdout,
} from './create-test-fixtures.test-support.js';

export function describeCreateNextSteps(): void {
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
          database: 'PostgreSQL 18',
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
          database: 'PostgreSQL 18',
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
}
