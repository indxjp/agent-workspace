const MAX_LOGGED_MESSAGE = 200;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/**
 * A failure message made fit for a server log: each of `secrets` becomes `[redacted]`, every URL
 * becomes `[url]`, a long unbroken token (an API key, a bearer) other than a UUID becomes `[redacted]`, and the
 * result is capped.
 */
export function redacted(
  message: string,
  secrets: readonly string[],
  limit = MAX_LOGGED_MESSAGE,
): string {
  const withoutSecrets = secrets.reduce(
    (text, secret) => text.split(secret).join('[redacted]'),
    message,
  );
  return withoutSecrets
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/giu, '[url]')
    .replace(/[A-Za-z0-9_-]{32,}/gu, (token) => (UUID.test(token) ? token : '[redacted]'))
    .slice(0, limit);
}
