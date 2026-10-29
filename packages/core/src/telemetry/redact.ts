const MAX_LOGGED_MESSAGE = 200;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
/** A cloud signature pair (S3, GCS, Azure SAS) seen outside its URL, up to the next separator. */
const SIGNATURE_PAIR = /\b(sig|X-Amz-Signature|X-Goog-Signature)=[^\s&;,'"]+/giu;

/**
 * A failure message made fit for a server log: each of `secrets` becomes `[redacted]`, every URL
 * becomes `[url]`, the value of a bare signature pair (`sig=`, `X-Amz-Signature=`,
 * `X-Goog-Signature=`) becomes `[redacted]`, a long unbroken token (an API key, a bearer) other
 * than a UUID becomes `[redacted]`, and the result is capped.
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
    .replace(SIGNATURE_PAIR, '$1=[redacted]')
    .replace(/[A-Za-z0-9_-]{32,}/gu, (token) => (UUID.test(token) ? token : '[redacted]'))
    .slice(0, limit);
}
