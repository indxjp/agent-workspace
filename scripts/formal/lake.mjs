#!/usr/bin/env node
/**
 * Runs `lake` inside `formal/`, the Lean 4 specification (docs/adr/0062). `lake` is taken from
 * `PATH`, falling back to elan's default install directory, so a shell that installed elan but
 * was not restarted still works. Invoked directly, it forwards its arguments:
 * `node scripts/formal/lake.mjs build`.
 */
import console from 'node:console';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const FORMAL_ROOT = path.join(REPOSITORY_ROOT, 'formal');

function lakeExecutable() {
  const elanLake = path.join(
    os.homedir(),
    '.elan',
    'bin',
    process.platform === 'win32' ? 'lake.exe' : 'lake',
  );
  const onPath = spawnSync('lake', ['--version'], { stdio: 'ignore', shell: false });
  if (onPath.status === 0) return 'lake';
  if (existsSync(elanLake)) return elanLake;
  throw new Error(
    'lake was not found on PATH or in ~/.elan/bin. Install elan (see docs/formal/README.md) and retry.',
  );
}

/**
 * Run `lake <args>` in `formal/`, streaming its output, and throw when it exits non-zero.
 * @param {readonly string[]} args
 */
export function runLake(args) {
  const result = spawnSync(lakeExecutable(), [...args], { cwd: FORMAL_ROOT, stdio: 'inherit' });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new Error(`lake ${args.join(' ')} exited with status ${String(result.status)}`);
  }
}

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  pathToFileURL(path.resolve(invokedPath)).href === import.meta.url
) {
  try {
    runLake(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
