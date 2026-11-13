import { readdir, readFile } from 'node:fs/promises';

export async function readIfPresent(file: string): Promise<string | null> {
  try {
    return await readFile(file, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  }
}

/** The files Terraform loads on its own, besides `terraform.tfvars.json`, that can set a variable. */
export async function tfvarsFiles(directory: string): Promise<readonly string[]> {
  const names = await readdir(directory).catch(() => [] as string[]);
  return names
    .filter((name) => name === 'terraform.tfvars' || name.endsWith('.auto.tfvars'))
    .sort();
}
