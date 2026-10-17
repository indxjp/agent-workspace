/**
 * The one guard a post-sign-in `next` destination passes through (ADR-0134 clause 19).
 *
 * `next` is attacker-controllable (a link, a query string, a form field). Only a path on this
 * origin may come out, so a sign-in link can never bounce a member to another site: the answer is
 * a relative `/path?query`, never a URL, and the caller redirects relative to itself.
 */

/** Longer than any authorize URL the OAuth endpoints produce; refuses a request-line stuffer. */
export const NEXT_PATH_MAX_LENGTH = 2048;

const PROBE_ORIGIN = 'http://next-path.invalid';

/** Space, every C0 control and DEL: CR/LF smuggling, and browsers strip tab and newline inside a URL. */
function hasForbiddenCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x20 || code === 0x7f || code === 0x5c) return true;
  }
  return false;
}

/** `pathname + search` of `raw` when it names a path on this origin, otherwise `null`. */
export function safeNextPath(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > NEXT_PATH_MAX_LENGTH) return null;
  if (!raw.startsWith('/') || raw.startsWith('//') || hasForbiddenCharacter(raw)) return null;
  const url = new URL(raw, PROBE_ORIGIN);
  if (url.origin !== PROBE_ORIGIN) return null;
  const normalised = `${url.pathname}${url.search}`;
  // `/.//evil` normalises to `//evil`, which a browser reads as another host.
  return normalised.startsWith('//') ? null : normalised;
}
