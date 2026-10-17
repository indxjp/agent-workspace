/**
 * What `agent-workspace render` leaves in place and says so about (ADR-0090: `render` never
 * deletes).
 *
 * A file an earlier profile rendered — `compose.yaml` before a move off `local`, the variables of
 * the previous cloud's Terraform module, a chart overlay the profile no longer gets — and a `.env`
 * image key the current profile or generator no longer writes stay where they are, because an
 * operator may have committed or copied them. Listing them keeps that from being silent. Only
 * paths and key names are returned, never a value: `.env` holds the deployment's secrets.
 */
import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';

import { ENV_IMAGE_KEYS } from './env.ts';

export interface Leftovers {
  /** Project-relative paths, `/`-separated. */
  readonly files: readonly string[];
  readonly envKeys: readonly string[];
}

interface LeftoverInputs {
  /** The paths this run renders. */
  readonly renderedFiles: readonly string[];
  /** Every key `.env` holds, in its order, repeats included. */
  readonly envKeys: readonly string[];
  /** The `.env` image keys this run renders. */
  readonly renderedEnvKeys: readonly string[];
}

/**
 * Image keys of an older generator: `RUNTIME_IMAGE` before one runtime image per engine
 * (ADR-0073), `MINIO_IMAGE` before the Compose object store became SeaweedFS (ADR-0067).
 */
const RETIRED_ENV_IMAGE_KEYS = ['RUNTIME_IMAGE', 'MINIO_IMAGE'] as const;

const TERRAFORM_DIRECTORY = 'deploy/terraform';
const TERRAFORM_VARIABLES_SUFFIX = '.auto.tfvars.json';

function isAbsent(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error.code === 'ENOENT' || error.code === 'ENOTDIR')
  );
}

async function exists(file: string): Promise<boolean> {
  try {
    await lstat(file);
    return true;
  } catch (error) {
    if (isAbsent(error)) return false;
    throw error;
  }
}

/** Every `deploy/terraform/<module>.auto.tfvars.json`, whichever module it was rendered for. */
async function terraformVariableFiles(directory: string): Promise<readonly string[]> {
  let names: readonly string[];
  try {
    names = await readdir(path.join(directory, ...TERRAFORM_DIRECTORY.split('/')));
  } catch (error) {
    if (isAbsent(error)) return [];
    throw error;
  }
  return names
    .filter((name) => name.endsWith(TERRAFORM_VARIABLES_SUFFIX))
    .sort()
    .map((name) => `${TERRAFORM_DIRECTORY}/${name}`);
}

/** What an earlier render or generator wrote that this run neither renders nor removes. */
export async function findLeftovers(
  directory: string,
  { renderedFiles, envKeys, renderedEnvKeys }: LeftoverInputs,
): Promise<Leftovers> {
  const candidates = [
    'compose.yaml',
    'deploy/helm/values.yaml',
    ...(await terraformVariableFiles(directory)),
  ].filter((file) => !renderedFiles.includes(file));
  const present = await Promise.all(
    candidates.map((file) => exists(path.join(directory, ...file.split('/')))),
  );

  const imageKeys = new Set<string>([...Object.values(ENV_IMAGE_KEYS), ...RETIRED_ENV_IMAGE_KEYS]);
  const leftoverKeys = envKeys.filter(
    (key) => imageKeys.has(key) && !renderedEnvKeys.includes(key),
  );

  return {
    files: candidates.filter((_, index) => present[index] === true),
    envKeys: [...new Set(leftoverKeys)],
  };
}
