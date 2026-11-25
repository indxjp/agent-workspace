/**
 * What a live card may say about how it was verified (spec, "Real-model verification gate (R1)").
 * The evidence is `real-model-runs.json`, which only the real-model harness writes
 * (`tests/store/live-verify/`), one record per run against real Claude in staging; it starts empty.
 * A card is verified with real Claude only when its entry's latest record for the source it runs
 * now (its source hash, `source-hashes.generated.ts`) passed. Everything else, no such record or a
 * latest one that failed, is "verified with the scripted model", and the store never calls such a
 * card live. A record for another hash (an earlier source, or a rebuild staged as `next`,
 * ADR-0174) never changes the card.
 *
 * Imports nothing but `zod` and this folder's files, like the rest of the catalog.
 */
import { z } from 'zod';

import evidence from './real-model-runs.json' with { type: 'json' };
import { SOURCE_HASHES } from './source-hashes.generated.ts';

export const realModelRunSchema = z.strictObject({
  /** The catalog entry's slug. */
  entry: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u),
  /** The platform's run id of the suggested prompt's first run. */
  runId: z.string().trim().min(1).max(200),
  /** When the run started, as an ISO 8601 UTC timestamp. */
  date: z.iso.datetime(),
  result: z.enum(['pass', 'fail']),
  /** Why it passed or failed, in words; never a secret or a model's raw output. */
  reason: z.string().trim().min(1).max(500),
  /** R1 runs in staging only. */
  environment: z.literal('staging'),
  /** The sha256 of the entry's source folder it ran on (`tests/store/live-verify/source-hash.ts`). */
  sourceHash: z.string().regex(/^[0-9a-f]{64}$/u),
});
export type RealModelRun = z.infer<typeof realModelRunSchema>;

export const realModelEvidenceSchema = z.strictObject({
  runs: z.array(realModelRunSchema).readonly(),
});
export type RealModelEvidence = z.infer<typeof realModelEvidenceSchema>;

/** The committed evidence, checked when this module loads. */
export const REAL_MODEL_EVIDENCE: RealModelEvidence = realModelEvidenceSchema.parse(evidence);

export type CardVerification =
  | { readonly kind: 'real-model'; readonly runId: string; readonly date: string }
  | { readonly kind: 'scripted-model' };

/**
 * How `slug`'s card is verified: by its latest record in `runs` for its current source hash (in
 * `hashes`) when that passed, else scripted.
 */
export function cardVerification(
  slug: string,
  runs: readonly RealModelRun[] = REAL_MODEL_EVIDENCE.runs,
  hashes: Readonly<Record<string, string>> = SOURCE_HASHES,
): CardVerification {
  const hash = hashes[slug];
  const latest = runs
    .filter((run) => run.entry === slug && run.sourceHash === hash)
    .reduce<RealModelRun | null>(
      (last, run) => (last === null || Date.parse(run.date) > Date.parse(last.date) ? run : last),
      null,
    );
  return latest?.result === 'pass'
    ? { kind: 'real-model', runId: latest.runId, date: latest.date }
    : { kind: 'scripted-model' };
}

/**
 * What a live card says: "under maintenance" for an entry the platform lists as failing its daily
 * production test, whatever its verification; otherwise how it was verified.
 */
export function cardState(
  slug: string,
  maintenance: readonly string[],
  runs: readonly RealModelRun[] = REAL_MODEL_EVIDENCE.runs,
  hashes: Readonly<Record<string, string>> = SOURCE_HASHES,
): CardVerification | { readonly kind: 'maintenance' } {
  return maintenance.includes(slug)
    ? { kind: 'maintenance' }
    : cardVerification(slug, runs, hashes);
}
