import type { ChallengeVerifier } from '../../ports';

/**
 * The production challenge verifiers, chosen by `AW_EMAIL_LINK_CHALLENGE`. Which CAPTCHA provider
 * the store uses is an open decision (spec §08, "CAPTCHA provider"), so none is known yet and every
 * non-empty name is refused at start-up rather than silently accepting every answer. A provider is
 * added here, with its own adapter, when that decision is made.
 */
const KNOWN_CHALLENGES: Readonly<Record<string, () => ChallengeVerifier>> = Object.freeze({});

/**
 * The verifier `name` selects, or `null` when `name` is unset or blank (the deployment has no
 * challenge, so it cannot take a sign-up; the issue route answers `503 email_link_unavailable`).
 * A name that is set but unknown throws, so a typo is a start-up error and not a deployment that
 * quietly lets nobody sign up.
 */
export function createChallengeVerifier(name: string | null): ChallengeVerifier | null {
  const chosen = name?.trim() ?? '';
  if (chosen === '') return null;
  const make = Object.hasOwn(KNOWN_CHALLENGES, chosen) ? KNOWN_CHALLENGES[chosen] : undefined;
  if (make === undefined) {
    const known = Object.keys(KNOWN_CHALLENGES);
    throw new Error(
      `AW_EMAIL_LINK_CHALLENGE ${JSON.stringify(chosen)} is not a known sign-up challenge (known: ${
        known.length === 0 ? 'none' : known.join(', ')
      }).`,
    );
  }
  return make();
}
