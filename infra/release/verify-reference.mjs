import process from 'node:process';

export const DIGEST_REFERENCE =
  /^(?:[a-z0-9]+(?:[._-][a-z0-9]+)*(?::[0-9]+)?\/)?(?:[a-z0-9]+(?:[._-][a-z0-9]+)*\/)*[a-z0-9]+(?:[._-][a-z0-9]+)*@sha256:[0-9a-f]{64}$/u;

/** @param {string} reference */
export function verifyDigestReference(reference) {
  if (!DIGEST_REFERENCE.test(reference)) {
    throw new Error(`image must be an OCI sha256 digest reference: ${reference}`);
  }
  if (reference.endsWith(`sha256:${'0'.repeat(64)}`)) {
    throw new Error('the all-zero digest is a placeholder, not a deployable image');
  }
  return reference;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replaceAll('\\', '/')}`).href) {
  try {
    process.stdout.write(`${verifyDigestReference(process.argv[2] ?? '')}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}
