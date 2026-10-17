import { spawnSync } from 'node:child_process';
import console from 'node:console';
import process from 'node:process';

const reference = process.argv[2];
if (!reference) {
  console.error('usage: resolve-digest.mjs <image:tag>');
  process.exit(2);
}
if (reference.includes('@')) {
  console.error('resolve-digest expects a tagged reference, not a digest reference');
  process.exit(2);
}
/** How `imagetools inspect` reports a tag the registry does not serve to this caller. */
const ABSENT = /not found|manifest unknown|name unknown|denied|unauthorized|forbidden/iu;
const result = spawnSync(
  'docker',
  ['buildx', 'imagetools', 'inspect', reference, '--format', '{{json .Manifest}}'],
  { encoding: 'utf8', shell: false },
);
if (result.status !== 0) {
  // No stderr at all when docker itself could not be spawned (not installed): say that instead.
  const reason = result.stderr?.trim() || result.error?.message || `could not resolve ${reference}`;
  console.error(reason);
  // Exit 3: the registry answered, and serves this caller no such tag (unknown, or not readable
  // with these credentials). build-and-push.sh reads that as "not published yet"; a tag it cannot
  // read is a tag it cannot push either, so that push fails instead of moving the tag. Anything
  // else (no network, a 5xx) keeps the command's own status: an answer nobody may build on.
  process.exit(ABSENT.test(reason) ? 3 : (result.status ?? 1));
}
let manifest;
try {
  manifest = JSON.parse(result.stdout);
} catch {
  console.error(`registry returned no manifest for ${reference}`);
  process.exit(1);
}
const digest = manifest.digest ?? manifest.Digest;
if (typeof digest !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(digest)) {
  console.error(`registry returned no sha256 digest for ${reference}`);
  process.exit(1);
}
const lastSlash = reference.lastIndexOf('/');
const lastColon = reference.lastIndexOf(':');
const repository = lastColon > lastSlash ? reference.slice(0, lastColon) : reference;
console.log(`${repository}@${digest}`);
