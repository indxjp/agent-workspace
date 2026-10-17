/**
 * `AW_PUBLIC_URL`: the origin external platforms reach this deployment at (ADR-0135). The A2A agent
 * card's `url` is built from it, and the OAuth issuer of T1c reuses it.
 */

export type PublicUrl =
  { readonly ok: true; readonly origin: string } | { readonly ok: false; readonly reason: string };

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]']);

/** An https origin with no path, query or credentials; plain http only on a loopback host. */
export function readPublicUrl(env: Readonly<Record<string, string | undefined>>): PublicUrl {
  const raw = env['AW_PUBLIC_URL']?.trim();
  if (raw === undefined || raw === '') return { ok: false, reason: 'AW_PUBLIC_URL is not set' };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: 'AW_PUBLIC_URL is not a URL' };
  }
  if (
    url.protocol !== 'https:' &&
    !(url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname))
  ) {
    return { ok: false, reason: 'AW_PUBLIC_URL must be https (http only on localhost)' };
  }
  if (url.username !== '' || url.password !== '') {
    return { ok: false, reason: 'AW_PUBLIC_URL must not carry credentials' };
  }
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    return { ok: false, reason: 'AW_PUBLIC_URL must be an origin without a path or query' };
  }
  return { ok: true, origin: url.origin };
}
