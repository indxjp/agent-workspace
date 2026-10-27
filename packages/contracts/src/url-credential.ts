/**
 * The one check every contracts URL shares for a credential written into it: a user name or
 * password, or a query parameter whose name is a common place for one. A credential belongs in a
 * secret (a `{ secret: NAME }` reference in a project file, a write-only `credential` in a create
 * body), so a stored, echoed URL never holds its value.
 *
 * A leaf: no imports, so `project-file` and `tool-connectors` can share it without a cycle.
 */

/**
 * Query parameter names a URL may not carry, compared case-insensitively: each is a common way to
 * put a credential in a URL. The list is a guard, not a proof: a credential under some other
 * parameter name is not caught here.
 */
const CREDENTIAL_QUERY_PARAMETER_PATTERN =
  /^(?:api[_-]?key|apikey|key|access[_-]?token|auth[_-]?token|token|secret|client[_-]?secret|password|passwd|pwd|auth|authorization|sig|signature|credential|credentials)$/iu;

/**
 * Whether a parsed URL carries a credential: a user name or password, or a query parameter in
 * {@link CREDENTIAL_QUERY_PARAMETER_PATTERN}. Pure.
 */
export function urlCarriesCredential(url: URL): boolean {
  if (url.username !== '' || url.password !== '') return true;
  return [...url.searchParams.keys()].some((name) => CREDENTIAL_QUERY_PARAMETER_PATTERN.test(name));
}

/** Whether `value` is an http(s) URL with no credential, query or fragment: a bare endpoint. */
export function isHttpEndpoint(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      !urlCarriesCredential(url) &&
      url.search === '' &&
      url.hash === ''
    );
  } catch {
    return false;
  }
}
