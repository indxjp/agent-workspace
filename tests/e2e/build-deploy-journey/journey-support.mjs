/* global console */
/** Assertions and process helpers shared by the build-to-deploy journey's modules. */
import { spawnSync } from 'node:child_process';
import path from 'node:path';

import { JourneyFailure } from '../../journey/harness.mjs';

export const ROOT = path.resolve(import.meta.dirname, '../../..');

/** @param {boolean} ok @param {string} message */
export function check(ok, message) {
  if (!ok) throw new JourneyFailure(`journey assertion failed: ${message}`);
  console.log(`ok: ${message}`);
}

/** @param {readonly string[]} args @param {import('node:child_process').SpawnSyncOptions} options */
export function spawnChecked(command, args, options, expected = 0) {
  const result = spawnSync(command, [...args], { encoding: 'utf8', shell: false, ...options });
  const output = `${String(result.stdout)}${String(result.stderr)}`;
  if (result.status !== expected) {
    throw new JourneyFailure(
      `${command} ${args.join(' ')} exited ${String(result.status ?? result.signal)}, not ${String(expected)}\n${output}`,
    );
  }
  return output;
}
