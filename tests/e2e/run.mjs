/* global console */

import { mkdir, writeFile } from 'node:fs/promises';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { URL } from 'node:url';

import { EXPECTED_STEP_COUNT, readPrimaryFlow, runPrimaryFlow } from './flow.mjs';

// Match the shipped Compose/CLI workflow for local evidence while preserving explicit CI
// variables (Node does not overwrite variables that are already present).
try {
  process.loadEnvFile();
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}

const adapter = await import('./adapter.mjs');

const resultUrl = new URL('./results/flow.json', import.meta.url);
const timeoutMs = Number(process.env.E2E_READY_TIMEOUT_MS ?? '60000');
const deadline = Date.now() + timeoutMs;
let ready = (await adapter.ready()) === true;
while (!ready && Date.now() < deadline) {
  await delay(500);
  ready = (await adapter.ready()) === true;
}
if (!ready) {
  console.error(`E2E_READINESS_TIMEOUT: stack was not proven ready within ${timeoutMs}ms`);
  process.exit(1);
}

const steps = await readPrimaryFlow();
const results = await runPrimaryFlow({
  steps,
  runners: adapter.runners ?? {},
  loginPath: adapter.loginPath,
});
await mkdir(new URL('./results/', import.meta.url), { recursive: true });
await writeFile(
  resultUrl,
  `${JSON.stringify({ generatedAt: new Date().toISOString(), steps: results }, null, 2)}\n`,
  'utf8',
);
if (results.length !== EXPECTED_STEP_COUNT) {
  console.error(`E2E_RESULT_INCOMPLETE: wrote ${results.length} entries`);
  process.exit(1);
}
const failed = results.filter((result) => result.status === 'failed');
console.log(
  `wrote ${results.length} flow entries: ${results.filter((r) => r.status === 'passed').length} passed, ${results.filter((r) => r.status === 'credential-bound').length} credential-bound, ${failed.length} failed`,
);
if (failed.length > 0) process.exit(1);
