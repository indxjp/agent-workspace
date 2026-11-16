import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { REPO_ROOT as repoRoot } from './inventory-support.js';

export const coreDir = path.join(repoRoot, 'packages', 'core');

export const PROBE_DATABASE = 'w2_int_01_no_503';

export function runNode(
  script: string,
  options: { cwd?: string; env?: Record<string, string> },
): string {
  return execFileSync(process.execPath, ['-e', script], {
    cwd: options.cwd ?? repoRoot,
    env: { ...process.env, ...options.env },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

export function runScript(file: string, env: Record<string, string>): string {
  if (!existsSync(file)) {
    throw new Error(
      `${file} does not exist. packages/core must be built before this probe runs — the wave ` +
        'protocol requires `pnpm build` before `pnpm test`, and .github/workflows/ci.yml has a ' +
        '"Build packages/core" step for the same reason. Refusing to probe a deployment whose ' +
        'database was never migrated.',
    );
  }
  return execFileSync(process.execPath, [file], {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

export const MANAGE_DATABASE = `
  const { Client } = require('pg');
  const name = process.env.PROBE_DB;
  const client = new Client({ connectionString: process.env.ADMIN_URL });
  client.connect()
    .then(() => client.query('drop database if exists "' + name + '" with (force)'))
    .then(() => (process.env.CREATE === '1' ? client.query('create database "' + name + '"') : null))
    .then(() => client.end())
    .catch((error) => { console.error(error.message); process.exit(1); });
`;

export function probeDatabaseUrl(adminUrl: string): string {
  const parsed = new URL(adminUrl);
  parsed.pathname = `/${PROBE_DATABASE}`;
  return parsed.toString();
}
