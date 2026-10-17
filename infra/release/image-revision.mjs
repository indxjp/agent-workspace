import { spawnSync } from 'node:child_process';
import process from 'node:process';

/**
 * The `org.opencontainers.image.revision` label an image carries, read from its config (#370,
 * ADR-0086 D6). build-and-push.sh uses it to tell a re-run of the same commit, whose tag it leaves
 * alone, from an attempt to move a published tag to other content, which it refuses.
 *
 *     node infra/release/image-revision.mjs <repository@sha256:…>
 *
 * Prints the revision, or fails when the platforms of one index disagree or carry none.
 */
export const REVISION_LABEL = 'org.opencontainers.image.revision';

/**
 * The one revision the image configs `imagetools inspect --format '{{json .Image}}'` prints for an
 * index (`platform → config`) or a single manifest (`config`), or `null` when there is none or the
 * platforms disagree.
 *
 * @param {unknown} inspected
 * @returns {string | null}
 */
export function imageRevision(inspected) {
  if (typeof inspected !== 'object' || inspected === null) return null;
  const record = /** @type {Record<string, unknown>} */ (inspected);
  const configs = 'config' in record ? [record] : Object.values(record);
  const revisions = new Set(
    configs.map((image) => {
      const config = /** @type {{ config?: { Labels?: Record<string, unknown> } } | null} */ (
        image
      );
      const revision = config?.config?.Labels?.[REVISION_LABEL];
      return typeof revision === 'string' && revision.length > 0 ? revision : null;
    }),
  );
  if (revisions.size !== 1) return null;
  const [revision] = revisions;
  return revision ?? null;
}

const reference = process.argv[2];
if (reference !== undefined) {
  if (!/@sha256:[0-9a-f]{64}$/u.test(reference)) {
    process.stderr.write('usage: image-revision.mjs <repository@sha256:digest>\n');
    process.exit(2);
  }
  const result = spawnSync(
    'docker',
    ['buildx', 'imagetools', 'inspect', reference, '--format', '{{json .Image}}'],
    { encoding: 'utf8', shell: false },
  );
  if (result.status !== 0) {
    process.stderr.write(`${result.stderr.trim() || `could not inspect ${reference}`}\n`);
    process.exit(result.status ?? 1);
  }
  let revision = null;
  try {
    revision = imageRevision(JSON.parse(result.stdout));
  } catch {
    revision = null;
  }
  if (revision === null) {
    process.stderr.write(`${reference} carries no single ${REVISION_LABEL} label\n`);
    process.exit(1);
  }
  process.stdout.write(`${revision}\n`);
}
