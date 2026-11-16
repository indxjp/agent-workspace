/**
 * The real-model harness's command line (R1):
 *
 *   STORE_LIVE_VERIFY=spend-approved STORE_LIVE_VERIFY_ENVIRONMENT=staging \
 *   STORE_LIVE_VERIFY_URL=<staging origin> STORE_LIVE_VERIFY_API_KEY=<key> \
 *   node tests/store/live-verify/run.ts [evidence-file]
 *
 * It does nothing and exits non-zero without the opt-in, and prints only entry slugs, results and
 * reasons, never a credential or the deployment's address. In staging the evidence file defaults to
 * the committed `examples/store/catalog/real-model-runs.json`; a person commits what it appends.
 * With `STORE_LIVE_VERIFY_ENVIRONMENT=production` (the daily production test, `../daily/`) the
 * evidence file must be named, and it is written whole as production evidence, never appended to the
 * committed file.
 */
import { fileURLToPath } from 'node:url';

import { CATALOG } from '../../../examples/store/catalog/index.ts';
import { writeEvidence, writeProductionEvidence } from './evidence-file.ts';
import {
  clientFor,
  LiveVerifyRefusal,
  type LiveEnvironment,
  type VerifyOutcome,
  readSettings,
  redact,
  secretsOf,
  verifyLive,
} from './verify.ts';

const DEFAULT_EVIDENCE = fileURLToPath(
  new URL('../../../examples/store/catalog/real-model-runs.json', import.meta.url),
);

async function main(): Promise<number> {
  // The environment is read once, here, and handed on.
  const env = process.env;
  const secrets = secretsOf(env);
  try {
    const settings = readSettings(env);
    const entries = CATALOG.filter((entry) => entry.status === 'live');
    const input = { client: clientFor(settings), secrets, entries, now: () => new Date() };
    let outcome: VerifyOutcome<LiveEnvironment>;
    if (settings.environment === 'production') {
      const file = process.argv[2];
      if (file === undefined) {
        throw new LiveVerifyRefusal('refused: a production run needs an evidence file to write');
      }
      const production = await verifyLive({ ...input, environment: 'production' });
      writeProductionEvidence(file, production.records);
      outcome = production;
    } else {
      const staging = await verifyLive({ ...input, environment: 'staging' });
      writeEvidence(process.argv[2] ?? DEFAULT_EVIDENCE, staging.records);
      outcome = staging;
    }
    for (const record of outcome.records) {
      console.log(`${record.entry}: ${record.result} (${record.reason})`);
    }
    for (const missed of outcome.unrun) console.log(`${missed.entry}: not run (${missed.reason})`);
    const failed = outcome.records.some((record) => record.result === 'fail');
    return failed || outcome.unrun.length > 0 ? 1 : 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown error';
    console.error(redact(message, secrets));
    return error instanceof LiveVerifyRefusal ? 2 : 1;
  }
}

process.exitCode = await main();
