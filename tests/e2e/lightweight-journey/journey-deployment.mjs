import process from 'node:process';
import { WRANGLER } from '../../../infra/tests/providers/cloudflare-bridge.mjs';
import { check, spawnChecked } from '../build-deploy-journey/journey.e2e.mjs';

/** The promotion bar `aw deploy` writes as `AW_DEPLOYMENT_POLICY`; the profile-path deploy does not, so the journey sets it. */
export const JOURNEY_DEPLOYMENT_POLICY = '{"promotion":{"minEvalScore":1}}';

/** One R2 bucket per lane, reused across runs. */
export const laneBucket = (/** @type {string} */ laneKey) => `awlj-${laneKey}-files`;

/**
 * A lane's object-store entries for `.env`: its R2 key pair and the `AW_STORAGE_URL` of its bucket,
 * `awlj-<lane key>-files`, reused across runs (the rendered per-run name would leak one each run).
 * The URL names R2's endpoint, so neither target derives another or creates a per-run bucket.
 *
 * @param {string} laneKey @param {Readonly<Record<string, string | undefined>>} env
 */
export function storageEntries(laneKey, env) {
  const account = env['CLOUDFLARE_ACCOUNT_ID'] ?? '';
  return {
    OBJECT_STORAGE_ACCESS_KEY_ID: env['R2_ACCESS_KEY_ID'] ?? '',
    OBJECT_STORAGE_SECRET_ACCESS_KEY: env['R2_SECRET_ACCESS_KEY'] ?? '',
    AW_STORAGE_URL: `s3://${laneBucket(laneKey)}?endpoint=https://${account}.r2.cloudflarestorage.com&region=auto`,
  };
}

/**
 * `text` with each `KEY=value` set: an existing line is replaced, a missing one appended.
 *
 * @param {string} text @param {Readonly<Record<string, string>>} entries
 */
export function setDotEnv(text, entries) {
  let out = text.endsWith('\n') || text === '' ? text : `${text}\n`;
  for (const [key, value] of Object.entries(entries)) {
    const line = new RegExp(`^${key}=.*$`, 'mu');
    out = line.test(out) ? out.replace(line, () => `${key}=${value}`) : `${out}${key}=${value}\n`;
  }
  return out;
}

/** The project frontend: no dependency, `npm run build` writes `dist/` (what Vercel and Wrangler run). */
export function frontendFiles() {
  return {
    'package.json': `${JSON.stringify({ name: 'lightweight-journey-web', private: true, scripts: { build: 'node build.mjs' } }, null, 2)}\n`,
    'build.mjs': [
      "import { mkdirSync, writeFileSync } from 'node:fs';",
      "const base = process.env.VITE_AW_BASE_URL ?? '';",
      "mkdirSync('dist', { recursive: true });",
      'writeFileSync(\'dist/index.html\', `<!doctype html><title>journey</title><p id="aw-base">${base}</p><script src="${base}/p/s/main/widget.js" async></script>\\n`);',
      '',
    ].join('\n'),
  };
}

/**
 * The runtime image a generated project pins (`AW_RUNTIME_IMAGE`), pushed to Cloudflare's registry
 * the way `agent-workspace deploy --target cloudflare` pushes the platform images: pulled for
 * linux/amd64, tagged by its digest, `wrangler containers push`ed with the token in the environment
 * only. Returns the registry's digest reference, which the bridge pins.
 *
 * @param {string} reference `name@sha256:<digest>` @param {string} account
 */
export function pushRuntimeImage(reference, account) {
  const digest = /@sha256:([0-9a-f]{64})$/u.exec(reference)?.[1];
  check(digest !== undefined, 'the runtime image is pinned by digest');
  const localTag = `agent-workspace-runtime:sha256-${String(digest)}`;
  spawnChecked('docker', ['pull', '--platform', 'linux/amd64', reference], {});
  spawnChecked('docker', ['tag', reference, localTag], {});
  spawnChecked('npx', ['--yes', WRANGLER, 'containers', 'push', localTag], {
    env: process.env,
    timeout: 900_000,
  });
  const pushed = `registry.cloudflare.com/${account}/${localTag}`;
  const pinned = spawnChecked(
    'docker',
    ['image', 'inspect', '--format', '{{join .RepoDigests "\\n"}}', pushed],
    {},
  )
    .split('\n')
    .map((line) => line.trim())
    .find((line) => /^registry\.cloudflare\.com\/.+@sha256:[0-9a-f]{64}$/u.test(line));
  check(pinned !== undefined, 'the pushed runtime image has a registry digest');
  return String(pinned);
}
