import { readFileSync } from 'node:fs';
import process from 'node:process';

/**
 * Refuse to sign a provenance attestation BuildKit did not record: `imagetools inspect` prints
 * `null` for an index without provenance, and `cosign attest` would sign that as a predicate.
 *
 * @param {unknown} predicate
 */
export function isSlsaProvenance(predicate) {
  if (typeof predicate !== 'object' || predicate === null) return false;
  const { builder, buildType } = /** @type {Record<string, unknown>} */ (predicate);
  return (
    typeof builder === 'object' &&
    builder !== null &&
    typeof buildType === 'string' &&
    buildType.length > 0
  );
}

const [file, reference] = process.argv.slice(2);
if (file !== undefined) {
  /** @type {unknown} */
  let predicate;
  try {
    predicate = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    predicate = undefined;
  }
  if (!isSlsaProvenance(predicate)) {
    process.stderr.write(`no SLSA provenance recorded for ${reference ?? file}\n`);
    process.exitCode = 1;
  }
}
