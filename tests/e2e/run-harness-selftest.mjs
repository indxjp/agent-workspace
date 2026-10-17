import { mkdir, writeFile } from 'node:fs/promises';
import process from 'node:process';
import { URL } from 'node:url';

import * as adapter from './harness-selftest-adapter.mjs';
import { EXPECTED_STEP_COUNT, readPrimaryFlow, runPrimaryFlow } from './flow.mjs';

const steps = await readPrimaryFlow();
const results = await runPrimaryFlow({
  steps,
  runners: adapter.runners,
  loginPath: adapter.loginPath,
});
const resultUrl = new URL('./results/harness-selftest.json', import.meta.url);
await mkdir(new URL('./results/', import.meta.url), { recursive: true });
await writeFile(
  resultUrl,
  `${JSON.stringify(
    {
      kind: 'harness-selftest',
      generatedAt: new Date().toISOString(),
      steps: results,
    },
    null,
    2,
  )}\n`,
  'utf8',
);
const failed = results.filter((result) => result.status === 'failed');
if (results.length !== EXPECTED_STEP_COUNT || failed.length > 0) process.exit(1);
