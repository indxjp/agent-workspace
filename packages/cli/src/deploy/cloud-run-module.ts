/**
 * The gcp-cloudrun Terraform module this CLI version ships, so `aw deploy` needs no checkout of
 * the platform repository (issue #794).
 *
 * The shipped copy is held byte-identical to `infra/terraform/gcp-cloudrun` by
 * `cloud-run-module.test.ts`, so the module an Owner applies is the one the CLI's version was
 * released with. It is copied out of the package for each run because Terraform writes
 * `.terraform/` and reads `terraform.tfvars` beside the module, and neither belongs in
 * `node_modules`, which is replaced on upgrade.
 */
import { mkdir, readdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { writeFileAtomically } from '../render/write-file.ts';

/** Resolves from `src/deploy` and from `dist/deploy` alike: both sit two levels below the package. */
export const CLOUD_RUN_MODULE_SOURCE = fileURLToPath(
  new URL('../../modules/gcp-cloudrun/', import.meta.url),
);

/** Where an Owner's `terraform.tfvars` and `.terraform/` live for the environment at `stateDirectory`. */
export function cloudRunModuleDirectory(stateDirectory: string): string {
  return path.join(
    path.dirname(stateDirectory),
    `${path.basename(stateDirectory)}.infra`,
    'terraform',
    'gcp-cloudrun',
  );
}

/** Terraform's documented way to adjust a module without editing it; an Owner's, never shipped. */
function isTerraformOverride(name: string): boolean {
  return name === 'override.tf' || name.endsWith('_override.tf');
}

/**
 * Make `cloudRunModuleDirectory(stateDirectory)` hold exactly the shipped module's files: each is
 * overwritten, a `.tf` file the CLI no longer ships is removed, and what Terraform and the Owner
 * keep there (`.terraform/`, `terraform.tfvars`, `*.auto.tfvars.json`, Terraform's override files
 * `override.tf` and `*_override.tf`) is left alone. Returns the
 * `infra/` directory the deploy command's `--infra` takes.
 */
export async function materializeCloudRunModule(stateDirectory: string): Promise<string> {
  const moduleDirectory = cloudRunModuleDirectory(stateDirectory);
  await mkdir(moduleDirectory, { recursive: true, mode: 0o700 });
  const shipped = await readdir(CLOUD_RUN_MODULE_SOURCE);
  for (const name of await readdir(moduleDirectory)) {
    if (name.endsWith('.tf') && !isTerraformOverride(name) && !shipped.includes(name)) {
      await rm(path.join(moduleDirectory, name));
    }
  }
  for (const name of shipped) {
    const contents = await readFile(path.join(CLOUD_RUN_MODULE_SOURCE, name), 'utf8');
    await writeFileAtomically(path.join(moduleDirectory, name), contents, null);
  }
  return path.dirname(path.dirname(moduleDirectory));
}
