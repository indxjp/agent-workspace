/**
 * What `agent-workspace doctor` must never print: a password, token or connection-string
 * credential from the profile, the project `.env` or the ambient environment.
 *
 * The checks doctor composes already keep provider text out of their messages, but two paths
 * still carry operator input verbatim — `describeSkew` embeds the server URL, and a profile
 * refusal may quote the value it refused — so every string of every result passes through
 * {@link redact} before it is rendered, as text or as JSON. Over-masking a harmless substring
 * that happens to equal a secret is the accepted cost: it can only hide text, never reveal it.
 */

const MASK = '***';

/** Shorter values are too likely to occur in ordinary text, and too short to be a credential. */
const MINIMUM_SECRET_LENGTH = 4;

/**
 * Variable names whose value is a credential. An `…_KEY_ID` is an identifier, not a secret, and
 * masking it would blank out ordinary words such as a Compose database user.
 */
const SECRET_NAME = /PASSWORD|PASSPHRASE|SECRET|TOKEN|CREDENTIAL|KEY$/iu;

/** `scheme://userinfo@` — greedy up to the authority's last `@`, so `p@ss` cannot split it. */
const URL_USERINFO = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/?#]*@/giu;

function userinfoPasswords(text: string): string[] {
  const passwords: string[] = [];
  for (const match of text.matchAll(URL_USERINFO)) {
    const userinfo = match[0].slice(match[1]?.length ?? 0, -1);
    const separator = userinfo.indexOf(':');
    if (separator === -1) continue;
    const password = userinfo.slice(separator + 1);
    passwords.push(password);
    try {
      passwords.push(decodeURIComponent(password));
    } catch {
      // A malformed escape is still masked in its raw form above.
    }
  }
  return passwords;
}

/**
 * Every literal the output must not contain: the value of each credential-named variable, and the
 * password of every URL in the environment or in the profile's text.
 */
export function collectSecrets(
  environment: Readonly<Record<string, string | undefined>>,
  profileText: string | null,
): readonly string[] {
  const secrets = new Set<string>();
  for (const [name, value] of Object.entries(environment)) {
    if (value === undefined) continue;
    if (SECRET_NAME.test(name)) secrets.add(value.trim());
    for (const password of userinfoPasswords(value)) secrets.add(password);
  }
  if (profileText !== null) {
    for (const password of userinfoPasswords(profileText)) secrets.add(password);
  }
  return [...secrets]
    .filter((secret) => secret.length >= MINIMUM_SECRET_LENGTH)
    .sort((left, right) => right.length - left.length);
}

/** Mask URL userinfo, then every literal secret, longest first so none is half-masked. */
export function redact(text: string, secrets: readonly string[]): string {
  let masked = text.replace(URL_USERINFO, `$1${MASK}@`);
  for (const secret of secrets) masked = masked.split(secret).join(MASK);
  return masked;
}
