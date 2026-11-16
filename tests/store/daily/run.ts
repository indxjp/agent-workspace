/**
 * The daily jobs' command line (internal runbook, "The daily jobs"):
 *
 *   node tests/store/daily/run.ts sample-check
 *     STORE_PLATFORM_URL, STORE_OPERATOR_TOKEN. Free: reads the platform's template report.
 *   node tests/store/daily/run.ts test [evidence-file]
 *     The above, plus STORE_LIVE_VERIFY=spend-approved, STORE_LIVE_VERIFY_ENVIRONMENT=production and
 *     STORE_LIVE_VERIFY_API_KEY (the verification workspace's key; its address is
 *     STORE_PLATFORM_URL). SPENDS on a real model, once per live entry; the workflow runs it only
 *     when a person has set `STORE_DAILY_TEST=enabled`.
 *
 * It prints only entry slugs, results and reasons, never a credential or the deployment's address.
 * The test's evidence is written whole to the evidence file (default `store-daily-evidence.json`),
 * which the workflow keeps as an artifact; it never touches the committed staging evidence.
 */

import { CATALOG } from '../../../examples/store/catalog/index.ts';
import { writeProductionEvidence } from '../live-verify/evidence-file.ts';
import {
  LiveVerifyRefusal,
  clientFor,
  readSettings,
  redact,
  secretsOf,
} from '../live-verify/verify.ts';
import { exitCodeOf, runDaily } from './daily.ts';
import type { Platform } from './platform.ts';
import { expectedTemplate, sampleCheck } from './sample-check.ts';

/** The repository root, for the catalog's source folders. */
const DEFAULT_EVIDENCE = 'store-daily-evidence.json';

async function main(): Promise<number> {
  const env = process.env;
  const url = env['STORE_PLATFORM_URL']?.trim() ?? '';
  const token = env['STORE_OPERATOR_TOKEN']?.trim() ?? '';
  const secrets = [token, ...secretsOf({ ...env, STORE_LIVE_VERIFY_URL: url })];
  try {
    if (url === '' || token === '') {
      throw new LiveVerifyRefusal(
        'refused: STORE_PLATFORM_URL and STORE_OPERATOR_TOKEN are required',
      );
    }
    const platform: Platform = { baseUrl: url, token, request: fetch };
    const live = CATALOG.filter((entry) => entry.status === 'live');
    if (process.argv[2] === 'sample-check') {
      const expected = live.map((entry) => expectedTemplate(entry));
      const differences = await sampleCheck(platform, expected);
      for (const difference of differences) console.log(difference);
      console.log(
        `sample check: ${differences.length === 0 ? 'every template matches' : 'differences found'}`,
      );
      return differences.length === 0 ? 0 : 1;
    }
    if (process.argv[2] !== 'test') {
      throw new LiveVerifyRefusal('refused: the command is sample-check or test');
    }
    const settings = readSettings({ ...env, STORE_LIVE_VERIFY_URL: url });
    if (settings.environment !== 'production') {
      throw new LiveVerifyRefusal('refused: the daily test runs against production only');
    }
    const outcome = await runDaily({
      client: clientFor(settings),
      platform,
      secrets,
      entries: live,
      now: () => new Date(),
    });
    writeProductionEvidence(process.argv[3] ?? DEFAULT_EVIDENCE, outcome.records);
    for (const record of outcome.records) {
      console.log(`${record.entry}: ${record.result} (${record.reason})`);
    }
    for (const missed of outcome.unrun) console.log(`${missed.entry}: not run (${missed.reason})`);
    for (const missed of outcome.unsent)
      console.log(`${missed.entry}: verdict not kept (${missed.reason})`);
    return exitCodeOf(outcome);
  } catch (error) {
    console.error(redact(error instanceof Error ? error.message : 'unknown error', secrets));
    return error instanceof LiveVerifyRefusal ? 2 : 1;
  }
}

process.exitCode = await main();
