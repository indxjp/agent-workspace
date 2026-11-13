import {
  appSchemaName,
  type ProductionApp,
  type ProductionGcp,
} from '@indx-workspace/contracts/project-file';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { writeFileAtomically } from '../render/write-file.ts';
import { appRoleSql } from './compose-apps.ts';
import { readIfPresent, tfvarsFiles } from './gcp-terraform-files.ts';

const LEGACY_VARIABLES_NOTICE =
  'Using project_id from terraform.tfvars or TF_VAR_project_id; set environments.production.gcp ' +
  'in agent-workspace.yaml to let aw deploy manage the project, region and state bucket.';

/** The `variable "name"` default of the module: the repository `image_registry` names. */
const FALLBACK_RESOURCE_NAME = 'agent-ws';

/**
 * The module's own rules for its `name` variable (`variables.tf`): the shape, and never `rt-`, the
 * prefix of the runner manager's sandbox services, which its IAM conditions match.
 */
const MODULE_NAME = /^(?!rt-)[a-z][a-z0-9-]{1,20}[a-z0-9]$/u;

/**
 * The module's `name` variable for a project: the name itself when it is at most 19 characters
 * (the module adds up to `-runner-mgr`, and Google caps a service account id at 30), else its
 * first 14 characters, `-` and 4 hex characters of the name's sha256 (19 in all), so two projects
 * in one Google Cloud project get distinct resources; `agent-ws-` and that hash when no such name
 * is valid. Written to `terraform.tfvars.json`, which wins over `TF_VAR_name` and a
 * hand-written `terraform.tfvars`.
 */
export function moduleResourceName(projectName: string): string {
  if (projectName.length <= 19 && MODULE_NAME.test(projectName)) return projectName;
  const hash = createHash('sha256').update(projectName).digest('hex').slice(0, 4);
  const prefix = projectName.slice(0, 14).replace(/-+$/u, '');
  const name = `${prefix}-${hash}`;
  return MODULE_NAME.test(name) ? name : `${FALLBACK_RESOURCE_NAME}-${hash}`;
}

/**
 * The module's `image_registry` output, `<region>-docker.pkg.dev/<project>/<repository>`, computed
 * before the repository exists. The repository is the module's `name` variable
 * ({@link moduleResourceName}). `gcp-infrastructure.test.ts` holds this formula equal to `outputs.tf`.
 */
export function expectedImageRegistry(gcp: ProductionGcp, name: string): string {
  return `${gcp.region}-docker.pkg.dev/${gcp.project}/${name}`;
}

/**
 * Refuse a `project_id` or `region` that `terraform.tfvars` or a `*.auto.tfvars` file in
 * `directory` (and, with `env`, `TF_VAR_project_id`) sets to something other than the `gcp` block
 * (and, with `name`, a `name` other than it; `terraform.tfvars.json` would override it),
 * naming both, rather than leave a file to override one silently.
 *
 * @throws {Error} when such a value differs from `gcp`.
 */
export async function assertNoConflictingVariables(
  directory: string,
  gcp: ProductionGcp,
  env: NodeJS.ProcessEnv = {},
  name?: string,
): Promise<void> {
  const settings = [
    { key: 'project_id', setting: 'environments.production.gcp.project', wanted: gcp.project },
    { key: 'region', setting: 'environments.production.gcp.region', wanted: gcp.region },
    ...(name === undefined ? [] : [{ key: 'name', setting: 'the project name', wanted: name }]),
  ];
  for (const { key, setting, wanted } of settings) {
    const sources: [string, string | undefined][] = [];
    for (const name of await tfvarsFiles(directory)) {
      const text = (await readIfPresent(path.join(directory, name))) ?? '';
      sources.push([name, new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"`, 'mu').exec(text)?.[1]]);
    }
    if (key !== 'region') sources.push([`TF_VAR_${key}`, env[`TF_VAR_${key}`] || undefined]);
    const conflict = sources.find(([, value]) => value !== undefined && value !== wanted);
    if (conflict?.[1] !== undefined) {
      throw new Error(
        `${setting} is "${wanted}" but the ${key} (${conflict[0]}) is "${conflict[1]}". ` +
          `Remove the ${key} there, or make them equal. ` +
          'Nothing was created.',
      );
    }
  }
}

/**
 * The module's `apps` variable: per app its image (the Artifact Registry copy), its origin and the
 * role SQL its role job runs with psql, which the Compose overlay renders from the same text.
 */
export function appVariables(
  apps: Readonly<Record<string, ProductionApp>>,
): Record<string, { image: string; url: string; role_sql: string }> {
  return Object.fromEntries(
    Object.entries(apps).map(([name, { image, url }]) => [
      name,
      { image, url, role_sql: appRoleSql(appSchemaName(name), '$$') },
    ]),
  );
}

/**
 * Write `terraform.tfvars.json` (`project_id`, `region`, `name`, `vertex_location`, plus each optional `gcp` key that is set: `domain`, `armor`, `iap`, `oidc_*`, `data_protection`, `size`, `alerts_email`, `sandbox_internet`, and `apps` when the project lists some) into the CLI-owned module directory, where
 * Terraform loads it without a flag. A hand-written `terraform.tfvars` or `TF_VAR_project_id` that
 * names another project is refused, naming both, rather than left to override one silently.
 *
 * @throws {Error} when the legacy project id or region differs from `gcp`.
 */
export async function writeProjectVariables(
  moduleDirectory: string,
  gcp: ProductionGcp,
  name: string,
  env: NodeJS.ProcessEnv,
  apps: Readonly<Record<string, ProductionApp>> = {},
): Promise<void> {
  await assertNoConflictingVariables(moduleDirectory, gcp, env, name);
  await writeFileAtomically(
    path.join(moduleDirectory, 'terraform.tfvars.json'),
    `${JSON.stringify(
      {
        project_id: gcp.project,
        region: gcp.region,
        name,
        vertex_location: gcp.modelLocation ?? 'global',
        // Written only when set, so a stack deployed before these keys existed plans no change.
        ...(gcp.domain === undefined ? {} : { domain: gcp.domain }),
        ...(gcp.armor === undefined ? {} : { armor: gcp.armor }),
        ...(gcp.iap === undefined ? {} : { iap: gcp.iap }),
        ...(gcp.oidc === undefined
          ? {}
          : { oidc_issuer: gcp.oidc.issuer, oidc_client_id: gcp.oidc.clientId }),
        ...(gcp.dataProtection === undefined ? {} : { data_protection: gcp.dataProtection }),
        ...(gcp.size === undefined ? {} : { size: gcp.size }),
        ...(gcp.alertsEmail === undefined ? {} : { alerts_email: gcp.alertsEmail }),
        ...(gcp.sandboxInternet === undefined ? {} : { sandbox_internet: gcp.sandboxInternet }),
        ...(Object.keys(apps).length === 0 ? {} : { apps: appVariables(apps) }),
      },
      null,
      2,
    )}\n`,
    null,
  );
}

/** The notice for a project that still sets its Google Cloud project by hand. */
export function legacyVariablesNotice(): string {
  return `${LEGACY_VARIABLES_NOTICE}\n`;
}
