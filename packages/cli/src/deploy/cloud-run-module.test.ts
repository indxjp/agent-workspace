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

/** Terraform files only: `*.tf` and `.terraform.lock.hcl`, what the module ships. */
async function terraformFiles(directory: string): Promise<readonly string[]> {
  return (await readdir(directory, { withFileTypes: true }))
    .filter(
      (entry) =>
        entry.isFile() && (entry.name.endsWith('.tf') || entry.name === '.terraform.lock.hcl'),
    )
    .map((entry) => entry.name)
    .sort();
}

describe('the gcp-cloudrun module shipped with the CLI (#794)', () => {
  it('is byte-identical to infra/terraform/gcp-cloudrun, file for file', async () => {
    const platform = await terraformFiles(PLATFORM_MODULE);
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

  it('ships monitoring.tf with the log metrics, the dashboard and the uptime check', async () => {
    const source = await readFile(path.join(CLOUD_RUN_MODULE_SOURCE, 'monitoring.tf'), 'utf8');
    expect(source).toContain('resource "google_logging_metric" "main"');
    expect(source).toContain('resource "google_monitoring_dashboard" "main"');
    expect(source).toContain('resource "google_monitoring_uptime_check_config" "web_readyz"');
    expect(source).toContain('/api/readyz');
  });

  it('forgets the retired Cloud Build grants without revoking them', async () => {
    const source = await readFile(path.join(PLATFORM_MODULE, 'main.tf'), 'utf8');
    for (const name of [
      'cloudbuild_storage_viewer',
      'cloudbuild_artifact_writer',
      'cloudbuild_log_writer',
    ]) {
      expect(source).toMatch(
        new RegExp(
          `removed \\{\\s*from = google_project_iam_member\\.${name}\\s*lifecycle \\{\\s*destroy = false`,
          'u',
        ),
      );
    }
  });

  it('binds no role to the sandbox runtime identity and declares no NAT', async () => {
    const names = (await readdir(PLATFORM_MODULE)).filter((name) => name.endsWith('.tf'));
    expect(names).toContain('main.tf');
    for (const name of names) {
      const source = await readFile(path.join(PLATFORM_MODULE, name), 'utf8');
      expect(source, `${name} binds a role to the runtime service account`).not.toMatch(
        /member\s*=\s*(?:google_service_account\.runtime\.member|"serviceAccount:\$\{google_service_account\.runtime\.email\}")/u,
      );
      expect(source, `${name} declares a NAT`).not.toContain('google_compute_router_nat');
    }
  });

  it('does not ship the module tests or the example tfvars', async () => {
    const platform = await files(PLATFORM_MODULE);
    expect(platform).toContain('tests');
    expect(platform).toContain('terraform.tfvars.example');
    const shipped = await files(CLOUD_RUN_MODULE_SOURCE);
    expect(shipped).not.toContain('tests');
    expect(shipped).not.toContain('terraform.tfvars.example');
  });

  it('protects the Cloud SQL instance and keeps point-in-time recovery on', async () => {
    const main = await readFile(path.join(CLOUD_RUN_MODULE_SOURCE, 'main.tf'), 'utf8');
    const instance = /resource "google_sql_database_instance" "main" \{[\s\S]*?\n\}\n/u.exec(
      main,
    )?.[0];
    expect(instance).toMatch(/deletion_protection\s*=\s*var\.data_protection\b/u);
    expect(instance).toMatch(/backup_configuration \{[^}]*enabled\s*=\s*true/u);
    expect(instance).toMatch(/point_in_time_recovery_enabled\s*=\s*true/u);
  });

  it('abandons the database user on destroy, so it goes with the instance', async () => {
    // The user owns the migrated schema; Cloud SQL refused to drop it ("69 objects in database
    // agent_workspace") and the destroy stopped before the instance (BYOC GCP P1 live run).
    const main = await readFile(path.join(CLOUD_RUN_MODULE_SOURCE, 'main.tf'), 'utf8');
    const user = /resource "google_sql_user" "main" \{[\s\S]*?\n\}\n/u.exec(main)?.[0];
    expect(user).toMatch(/\n {2}deletion_policy\s*=\s*"ABANDON"\n/u);
  });

  it('binds the KMS key to the Secret Manager service agent only after it can propagate', async () => {
    // A project's first Secret Manager request creates the agent, and IAM refuses a binding made
    // at once ("Service account ... does not exist"); the plan-time test cannot see the wait.
    const main = await readFile(path.join(CLOUD_RUN_MODULE_SOURCE, 'main.tf'), 'utf8');
    const binding =
      /resource "google_kms_crypto_key_iam_member" "secret_manager" \{[\s\S]*?\n\}\n/u.exec(
        main,
      )?.[0];
    const wait = /resource "time_sleep" "secret_manager_identity" \{[\s\S]*?\n\}\n/u.exec(
      main,
    )?.[0];
    expect(binding).toMatch(
      /member\s*=\s*time_sleep\.secret_manager_identity\.triggers\["member"\]/u,
    );
    expect(wait).toMatch(/member\s*=\s*google_project_service_identity\.secret_manager\.member\b/u);
    expect(wait).toMatch(/create_duration\s*=\s*"\d+s"/u);
  });

  it('declares the service-level scaling the API reads back, so a second apply plans no change', async () => {
    // Without it, every plan after the first apply removes { min_instance_count = 0,
    // manual_instance_count = 0 } from all three services (BYOC GCP P1 live run).
    const main = await readFile(path.join(CLOUD_RUN_MODULE_SOURCE, 'main.tf'), 'utf8');
    for (const name of ['gateway', 'runner_manager', 'web']) {
      const service = new RegExp(
        `resource "google_cloud_run_v2_service" "${name}" \\{[\\s\\S]*?\\n\\}\\n`,
        'u',
      ).exec(main)?.[0];
      const beforeTemplate = service?.split(/\n {2}template \{/u)[0];
      expect(beforeTemplate, name).toMatch(
        /\n {2}scaling \{\s*min_instance_count\s*=\s*0\s*manual_instance_count\s*=\s*0\s*\}/u,
      );
      expect(beforeTemplate, name).not.toMatch(/^\s*scaling_mode\s*=/mu);
    }
  });

  it('starts the services that connect to Cloud SQL only after their database user exists', async () => {
    // A live first deploy created the gateway alongside google_sql_user.main; the gateway
    // started first and exited on "password authentication failed" (BYOC GCP P1 live run).
    const main = await readFile(path.join(CLOUD_RUN_MODULE_SOURCE, 'main.tf'), 'utf8');
    for (const name of ['gateway', 'web']) {
      const service = new RegExp(
        `resource "google_cloud_run_v2_service" "${name}" \\{[\\s\\S]*?\\n\\}\\n`,
        'u',
      ).exec(main)?.[0];
      const dependsOn = /\n {2}depends_on = \[([\s\S]*?)\n {2}\]/u.exec(service ?? '')?.[1];
      expect(dependsOn, name).toContain('google_sql_user.main');
      expect(dependsOn, name).toContain('google_sql_database.main');
    }
  });

  it('protects data by default', async () => {
    const variables = await readFile(path.join(CLOUD_RUN_MODULE_SOURCE, 'variables.tf'), 'utf8');
    const declaration = /variable "data_protection" \{[\s\S]*?\n\}\n/u.exec(variables)?.[0];
    expect(declaration).toMatch(/type\s*=\s*bool/u);
    expect(declaration).toMatch(/default\s*=\s*true/u);
  });

  it('keeps no demo setting in the default deploy: no forced bucket destroy, no Cloud Build grants', async () => {
    const main = await readFile(path.join(CLOUD_RUN_MODULE_SOURCE, 'main.tf'), 'utf8');
    expect(main).not.toMatch(/force_destroy\s*=\s*true/u);
    expect(main).not.toMatch(/resource "[a-z_]+" "cloudbuild_/u);
    expect(main).not.toContain('cloudbuild.googleapis.com');
    expect(main).not.toMatch(/deletion_protection\s*=\s*false/u);
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
    expect(await files(moduleDirectory)).toEqual(await terraformFiles(CLOUD_RUN_MODULE_SOURCE));
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
