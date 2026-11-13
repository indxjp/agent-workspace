import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ENV_IMAGE_KEYS, ENV_VERSION_KEY } from '../render/env.ts';

/** The checkout of the platform `vercel deploy` uploads; the control plane project's Root Directory is `apps/web`, which `deploy` sets. */
export const VERCEL_SOURCE_VARIABLE = 'AGENT_WORKSPACE_SOURCE';

const RELEASE_MANIFEST = path.join('packages', 'cli', 'src', 'release-images.json');

/**
 * The release a platform checkout is at, from the manifest the images are published from, or why
 * it is unknown. Only the `version` field is read, and only as a string.
 */
function checkoutVersion(source: string): string | null {
  try {
    const manifest: unknown = JSON.parse(readFileSync(path.join(source, RELEASE_MANIFEST), 'utf8'));
    const version =
      typeof manifest === 'object' && manifest !== null
        ? (manifest as Record<string, unknown>)['version']
        : undefined;
    return typeof version === 'string' && version !== '' ? version : null;
  } catch {
    return null;
  }
}

/**
 * The migrations run from `WEB_IMAGE` and the code from the checkout, so both must be one release.
 * `AGENT_WORKSPACE_VERSION` in `.env` is the release the image was resolved for; the checkout's
 * `release-images.json` is the release it is at. Anything but equal is refused by name.
 */
export function assertOneRelease(source: string, dotEnv: Readonly<Record<string, string>>): void {
  const rendered = dotEnv[ENV_VERSION_KEY]?.trim() ?? '';
  if (rendered === '') {
    throw new Error(
      `${ENV_VERSION_KEY} is empty in .env: it names the release ${ENV_IMAGE_KEYS.web} was ` +
        'resolved for, and the checkout cannot be matched to the image without it. Run ' +
        '`create-agent-workspace` again or add the line. Nothing was run.',
    );
  }
  const checkout = checkoutVersion(source);
  if (checkout === null) {
    throw new Error(
      `${VERCEL_SOURCE_VARIABLE} is ${source}, which has no readable ${RELEASE_MANIFEST}: ` +
        'point it at a platform checkout. Nothing was run.',
    );
  }
  if (checkout !== rendered) {
    throw new Error(
      `${VERCEL_SOURCE_VARIABLE} is at ${checkout} but ${ENV_IMAGE_KEYS.web} was rendered for ` +
        `${rendered} (${ENV_VERSION_KEY}); check out release ${rendered}, or pin the images of ` +
        `${checkout} and set ${ENV_VERSION_KEY} to it. Nothing was run.`,
    );
  }
}
