import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import {
  CLOUD_RUN_MODULE_SOURCE,
  cloudRunModuleDirectory,
  materializeCloudRunModule,
} from './cloud-run-module.js';

const PLATFORM_MODULE = fileURLToPath(
  new URL('../../../../infra/terraform/gcp-cloudrun/', import.meta.url),
);

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((entry) => rm(entry, { recursive: true })));
});

async function stateDirectory(): Promise<string> {
  const home = await mkdtemp(path.join(os.tmpdir(), 'aw-cloud-run-module-'));
  temporary.push(home);
  return path.join(home, 'deployments', 'acme-ai', 'production');
}

async function files(directory: string): Promise<readonly string[]> {
  return (await readdir(directory)).sort();
}

describe('the gcp-cloudrun module shipped with the CLI (#794)', () => {
  it('is byte-identical to infra/terraform/gcp-cloudrun, file for file', async () => {
    const platform = await files(PLATFORM_MODULE);
    expect(await files(CLOUD_RUN_MODULE_SOURCE)).toEqual(platform);
    expect(platform).toContain('main.tf');
    for (const name of platform) {
      const shipped = await readFile(path.join(CLOUD_RUN_MODULE_SOURCE, name));
      const original = await readFile(path.join(PLATFORM_MODULE, name));
      expect(shipped.equals(original), `${name} drifted from infra/terraform/gcp-cloudrun`).toBe(
        true,
      );
    }
  });

  it('protects the Cloud SQL instance and keeps point-in-time recovery on', async () => {
    const main = await readFile(path.join(CLOUD_RUN_MODULE_SOURCE, 'main.tf'), 'utf8');
    const instance = /resource "google_sql_database_instance" "main" \{[\s\S]*?\n\}\n/u.exec(
      main,
    )?.[0];
    expect(instance).toMatch(/deletion_protection\s*=\s*true/u);
    expect(instance).toMatch(/backup_configuration \{[^}]*enabled\s*=\s*true/u);
    expect(instance).toMatch(/point_in_time_recovery_enabled\s*=\s*true/u);
  });

  it('outputs the registry the images are copied into', async () => {
    const outputs = await readFile(path.join(CLOUD_RUN_MODULE_SOURCE, 'outputs.tf'), 'utf8');
    expect(outputs).toContain('output "image_registry"');
  });
});

describe('materializeCloudRunModule (#794)', () => {
  it('writes the shipped module beside the state directory and returns its infra root', async () => {
    const state = await stateDirectory();

    const infra = await materializeCloudRunModule(state);

    const moduleDirectory = cloudRunModuleDirectory(state);
    expect(moduleDirectory).toBe(path.join(infra, 'terraform', 'gcp-cloudrun'));
    expect(await files(moduleDirectory)).toEqual(await files(CLOUD_RUN_MODULE_SOURCE));
    expect(await readFile(path.join(moduleDirectory, 'main.tf'), 'utf8')).toBe(
      await readFile(path.join(CLOUD_RUN_MODULE_SOURCE, 'main.tf'), 'utf8'),
    );
  });

  it('restores an edited file and removes a stale .tf, keeping what Terraform and the Owner keep', async () => {
    const state = await stateDirectory();
    await materializeCloudRunModule(state);
    const moduleDirectory = cloudRunModuleDirectory(state);
    await mkdir(path.join(moduleDirectory, '.terraform'));
    await writeFile(path.join(moduleDirectory, '.terraform', 'marker'), 'init');
    await writeFile(path.join(moduleDirectory, 'terraform.tfvars'), 'project_id = "acme-prod"\n');
    await writeFile(path.join(moduleDirectory, 'old.tf'), 'resource "x" "y" {}\n');
    const override = 'terraform {\n  backend "gcs" {}\n}\n';
    await writeFile(path.join(moduleDirectory, 'backend_override.tf'), override);
    await writeFile(path.join(moduleDirectory, 'main.tf'), '# edited\n');

    await materializeCloudRunModule(state);

    expect(await readFile(path.join(moduleDirectory, 'main.tf'), 'utf8')).toBe(
      await readFile(path.join(CLOUD_RUN_MODULE_SOURCE, 'main.tf'), 'utf8'),
    );
    expect(await files(moduleDirectory)).toEqual(
      [
        ...(await files(CLOUD_RUN_MODULE_SOURCE)),
        '.terraform',
        'backend_override.tf',
        'terraform.tfvars',
      ].sort(),
    );
    expect(await readFile(path.join(moduleDirectory, 'backend_override.tf'), 'utf8')).toBe(
      override,
    );
    expect(await readFile(path.join(moduleDirectory, '.terraform', 'marker'), 'utf8')).toBe('init');
  });
});
