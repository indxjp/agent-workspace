/**
 * The real-model harness's command line (R1):
 *
 *   STORE_LIVE_VERIFY=spend-approved STORE_LIVE_VERIFY_ENVIRONMENT=staging \
 *   STORE_LIVE_VERIFY_URL=<staging origin> STORE_LIVE_VERIFY_API_KEY=<key> \
 *   [STORE_LIVE_VERIFY_ENTRIES=<slug>,<slug>] node tests/store/live-verify/run.ts [evidence-file]
 *
 * It does nothing and exits non-zero without the opt-in, and prints only entry slugs, results and
 * reasons, never a credential or the deployment's address. In staging the evidence file defaults to
 * the committed `examples/store/catalog/real-model-runs.json`; a person commits what it appends.
 * A staging run verifies the entries with a source (live, or coming soon with its code merged, which
 * the staging deploy seeds) that `STORE_LIVE_VERIFY_ENTRIES` names, or by default every one with no
 * passing record for its current source hash, and each record carries that hash
 * (`source-hash.ts`), taken from the checkout before anything is spent. It refuses, before spending,
 * any entry whose source or catalog file is not the same at `STORE_LIVE_VERIFY_DEPLOYED_COMMIT` (the
 * commit staging was deployed and seeded from) as in the checkout, and any entry whose copy in the
 * verification workspace has other instructions than the seed built from the checkout (a workspace
 * not refilled since the deploy), so the record verifies the code the run exercised.
 * With `STORE_LIVE_VERIFY_ENVIRONMENT=production` (the daily production test, `../daily/`) the
 * evidence file must be named, and it is written whole as production evidence, never appended to the
 * committed file.
 */
import { fileURLToPath } from 'node:url';

import { hasSource, type LiveEntry } from '../../../examples/store/catalog/define.ts';
import { CATALOG } from '../../../examples/store/catalog/index.ts';
import { buildSeed } from '../seed/build.ts';
import { readEvidence, writeEvidence, writeProductionEvidence } from './evidence-file.ts';
import { deployedSourceDiffers, entrySourceHash, passedForSource } from './source-hash.ts';
import {
  clientFor,
  deployedCommitOf,
  entriesToVerify,
  LiveVerifyRefusal,
  type LiveEnvironment,
  type VerifyOutcome,
  readSettings,
  redact,
  refuseUndeployed,
  secretsOf,
  sourceHashesOf,
  verifyLive,
  withSourceHashes,
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
    const live = CATALOG.filter((entry): entry is LiveEntry => entry.status === 'live');
    const input = { client: clientFor(settings), secrets, now: () => new Date() };
    let outcome: VerifyOutcome<LiveEnvironment>;
    if (settings.environment === 'production') {
      const file = process.argv[2];
      if (file === undefined) {
        throw new LiveVerifyRefusal('refused: a production run needs an evidence file to write');
      }
      const production = await verifyLive({ ...input, entries: live, environment: 'production' });
      writeProductionEvidence(file, production.records);
      outcome = production;
    } else {
      const file = process.argv[2] ?? DEFAULT_EVIDENCE;
      const { runs } = readEvidence(file);
      // R1 comes before the flip: a coming-soon entry is verified once its code is merged and seeded.
      const sourced = CATALOG.filter(hasSource);
      const hashes = sourceHashesOf(sourced, (entry) => entrySourceHash(entry));
      const entries = entriesToVerify(sourced, env['STORE_LIVE_VERIFY_ENTRIES'], (entry) =>
        passedForSource(entry.slug, hashes.get(entry.slug) ?? null, runs),
      );
      const deployed = deployedCommitOf(env);
      refuseUndeployed(entries, (entry) => deployedSourceDiffers(entry, deployed));
      // A workspace not refilled since the deploy holds an older copy, which is refused, unspent.
      const staging = await verifyLive({
        ...input,
        entries,
        environment: 'staging',
        expectedInstructions: (entry) => buildSeed(entry).definition.agent.instructions,
      });
      writeEvidence(file, withSourceHashes(staging.records, hashes));
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
