/**
 * The committed evidence file's read and write (R1): the only file I/O of the harness, kept out of
 * the pure core in `verify.ts`.
 */
import { readFileSync, writeFileSync } from 'node:fs';

import { z } from 'zod';

import {
  realModelEvidenceSchema,
  realModelRunSchema,
  type RealModelEvidence,
  type RealModelRun,
} from '../../../examples/store/catalog/verification.ts';
import { appendEvidence, type LiveRun } from './verify.ts';

/** The evidence in `path`, checked against the committed format. */
export function readEvidence(path: string): RealModelEvidence {
  return realModelEvidenceSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
}

/** Reads `path`, appends `records`, and writes the file back in the committed format. */
export function writeEvidence(path: string, records: readonly RealModelRun[]): RealModelEvidence {
  const existing = readEvidence(path);
  const next = appendEvidence(existing, records);
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

/**
 * One daily production test's evidence: the staging record's fields but the source hash (the
 * daily test checks the deployment, not a promotion), with `environment: 'production'`. It is kept as the workflow's artifact, never committed: the committed evidence
 * (`real-model-runs.json`) stays staging-only, and its schema is not loosened.
 */
export const productionEvidenceSchema = z.strictObject({
  runs: z
    .array(
      realModelRunSchema
        .omit({ sourceHash: true })
        .extend({ environment: z.literal('production') }),
    )
    .readonly(),
});
export type ProductionEvidence = z.infer<typeof productionEvidenceSchema>;

/** Writes `records` to `path` as one production evidence file, replacing what was there. */
export function writeProductionEvidence(
  path: string,
  records: readonly LiveRun<'production'>[],
): ProductionEvidence {
  const evidence = productionEvidenceSchema.parse({ runs: records });
  writeFileSync(path, `${JSON.stringify(evidence, null, 2)}\n`);
  return evidence;
}
