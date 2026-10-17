/* global console */

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import process from 'node:process';
import { URL } from 'node:url';

import { renderDriverMatrix } from './renderer.mjs';

const root = new URL('../../', import.meta.url);
const spec = readFileSync(new URL('docs/spec.md', root), 'utf8');
const results = JSON.parse(readFileSync(new URL('tests/driver-matrix/results.json', root), 'utf8'));
if (!process.argv.includes('--no-conformance')) {
  const testArguments = [
    'vitest',
    'run',
    'tests/conformance/a12-local.test.ts',
    'packages/runtime/src/docker.test.ts',
  ];
  const command = process.platform === 'win32' ? (process.env.ComSpec ?? 'cmd.exe') : 'pnpm';
  const argumentsForCommand =
    process.platform === 'win32'
      ? ['/d', '/s', '/c', `pnpm ${testArguments.join(' ')}`]
      : testArguments;
  const run = spawnSync(command, argumentsForCommand, {
    cwd: new URL('.', root),
    encoding: 'utf8',
    stdio: 'inherit',
    shell: false,
  });
  if (run.error) throw run.error;
  if (run.status !== 0) process.exit(run.status ?? 1);
}

writeFileSync(
  new URL('docs/runtime-driver-matrix.md', root),
  await renderDriverMatrix(spec, results),
);
console.log('wrote the A.10 matrix from the checked-in evidence record');
