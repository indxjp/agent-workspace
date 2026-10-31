/**
 * The one filter every line `agent-workspace deploy` prints passes through (ADR-0094).
 *
 * `.env` holds the deployment's credentials, and the tools `deploy` wraps can print them:
 * `docker compose` interpolates `.env` into what it reports, and a Terraform or Helm error may
 * quote a value it was given. The redactor masks, as literal substrings, every `.env` value except
 * those of the keys below, which the generator writes and which name public configuration — so a
 * key an operator adds is masked until it is listed here, never the other way round. It also masks
 * the user information of any `scheme://user:password@host` URL, which is how a profile's store
 * URL or a connection string carries a password, and the password of every such URL the profile
 * or `.env` holds wherever it appears on its own.
 */
import { ENV_IMAGE_KEYS, ENV_VERSION_KEY } from '../render/env.ts';

const MASK = '***';

/** `.env` keys whose generated values are public configuration, not credentials. */
const PUBLIC_ENV_KEYS: ReadonlySet<string> = new Set([
  ...Object.values(ENV_IMAGE_KEYS),
  // The release the images were resolved for (`0.6.1`): masking it would mask every path and
  // reference that carries the version, such as a project directory named after the release.
  ENV_VERSION_KEY,
  'COMPOSE_PROJECT_NAME',
  'COMPOSE_PROFILES',
  'DOCKER_GID',
  'POSTGRES_USER',
  'POSTGRES_DB',
  'AWS_REGION',
  'RUNTIME_DRIVER',
  'RUNNER_URL',
  'RUNNER_MANAGER_URL',
  'GATEWAY_PRICING_JSON',
  'MODEL_GATEWAY_URL',
  'AW_SESSION_MIRROR_URL',
  'WORKSPACE_SLUG',
  'WORKSPACE_NAME',
  'MASTER_KEY_PROVIDER',
  'AZURE_KEY_VAULT_URL',
  'BOOTSTRAP_ADMIN',
  'AW_TRUSTED_PROXY_HOPS',
  'AW_PUBLIC_URL',
  'PORT',
]);

/**
 * Values shorter than this are not masked: replacing every `0` or `on` in a plan would make it
 * unreadable, and a credential that short protects nothing.
 */
const MINIMUM_MASKED_LENGTH = 4;

/** `scheme://user:password@` — the user information is masked, the scheme and host are kept. */
const URL_USERINFO = /([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:([^\s/@]+)@/giu;

/** The password of every `scheme://user:password@` URL in `text`. */
function urlPasswords(text: string): readonly string[] {
  return [...text.matchAll(URL_USERINFO)].flatMap((match) =>
    match[2] === undefined ? [] : [match[2]],
  );
}

function unquoted(value: string): string {
  const quote = value[0];
  if (value.length >= 2 && (quote === '"' || quote === "'") && value.endsWith(quote)) {
    return value.slice(1, -1);
  }
  return value;
}

/** A function that masks the credentials of this `.env`, and of the profile's text, in any text. */
export function createRedactor(
  environment: Readonly<Record<string, string>>,
  profileText = '',
): (text: string) => string {
  const secrets = [
    ...new Set(
      [
        ...Object.entries(environment)
          .filter(([key]) => !PUBLIC_ENV_KEYS.has(key))
          .flatMap(([, value]) => [value, unquoted(value)]),
        ...[profileText, ...Object.values(environment)].flatMap(urlPasswords),
      ].filter((value) => value.length >= MINIMUM_MASKED_LENGTH),
    ),
  ].sort((left, right) => right.length - left.length);
  return (text) =>
    secrets
      .reduce((masked, secret) => masked.replaceAll(secret, MASK), text)
      .replace(URL_USERINFO, `$1${MASK}@`);
}
