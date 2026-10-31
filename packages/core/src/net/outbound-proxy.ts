/**
 * The deployment's outbound proxy (`HTTPS_PROXY`, `HTTP_PROXY`, `NO_PROXY`), read once by a
 * composition root and handed to the code that dials customer endpoints itself, such as a storage
 * connection (`storage/connection-store.ts`). That code still runs {@link checkEgress} on the
 * target before it asks the proxy for anything: the proxy is a route, not a policy.
 *
 * The rules follow the common convention (curl, Node's `NODE_USE_ENV_PROXY`): an `https:` target
 * uses `HTTPS_PROXY`, an `http:` target `HTTP_PROXY`; the upper-case name wins over the lower-case
 * one. A `NO_PROXY` entry is `*`, a host or address (optionally `[v6]`), a domain that also
 * matches its subdomains (with or without a leading `.` or `*.`), each optionally with `:port`.
 * CIDR ranges are not understood.
 */

export interface OutboundProxyConfig {
  /** The proxy an `https:` target is reached through, or null for none. */
  readonly httpsProxy: string | null;
  /** The proxy an `http:` target is reached through, or null for none. */
  readonly httpProxy: string | null;
  /** `NO_PROXY`, split and trimmed: the targets reached directly. */
  readonly noProxy: readonly string[];
}

type Env = Readonly<Record<string, string | undefined>>;

function envValue(env: Env, name: string): string | null {
  for (const key of [name, name.toLowerCase()]) {
    const value = env[key]?.trim();
    if (value !== undefined && value !== '') return value;
  }
  return null;
}

/** The value of `name`, checked to be an `http:` or `https:` URL with a host. */
function proxyUrl(env: Env, name: string): string | null {
  const value = envValue(env, name);
  if (value === null) return null;
  let url: URL | null;
  try {
    url = new URL(value);
  } catch {
    url = null;
  }
  if (url === null || (url.protocol !== 'http:' && url.protocol !== 'https:') || url.host === '') {
    // The value is not repeated: a proxy URL may carry a password.
    throw new Error(`${name} must be an http: or https: URL.`);
  }
  return value;
}

/** Throws, naming only the variable, when a proxy variable is set to something that is not a URL. */
export function loadOutboundProxyFromEnv(env: Env): OutboundProxyConfig {
  return {
    httpsProxy: proxyUrl(env, 'HTTPS_PROXY'),
    httpProxy: proxyUrl(env, 'HTTP_PROXY'),
    noProxy: (envValue(env, 'NO_PROXY') ?? '')
      .split(/[\s,]+/u)
      .map((entry) => entry.trim())
      .filter((entry) => entry !== ''),
  };
}

function defaultPort(url: URL): string {
  if (url.port !== '') return url.port;
  return url.protocol === 'https:' ? '443' : '80';
}

/** Whether one `NO_PROXY` entry covers `host` (lower case, no brackets) on `port`. */
function bypasses(entry: string, host: string, port: string): boolean {
  if (entry === '*') return true;
  let pattern = entry.toLowerCase();
  const bracketed = /^\[([^\]]+)\](?::(\d+))?$/u.exec(pattern);
  if (bracketed !== null) {
    return bracketed[1] === host && (bracketed[2] === undefined || bracketed[2] === port);
  }
  const portMatch = /^(.*):(\d+)$/u.exec(pattern);
  if (portMatch !== null && !(portMatch[1] ?? '').includes(':')) {
    if (portMatch[2] !== port) return false;
    pattern = portMatch[1] ?? '';
  }
  pattern = pattern.replace(/^\*?\./u, '');
  if (pattern === '') return false;
  return host === pattern || host.endsWith(`.${pattern}`);
}

/** The proxy `target` is reached through under `config`, or null to connect directly. */
export function outboundProxyFor(target: URL, config: OutboundProxyConfig): string | null {
  const proxy =
    target.protocol === 'https:'
      ? config.httpsProxy
      : target.protocol === 'http:'
        ? config.httpProxy
        : null;
  if (proxy === null) return null;
  const host = target.hostname.toLowerCase().replace(/^\[(.*)\]$/u, '$1');
  const port = defaultPort(target);
  return config.noProxy.some((entry) => bypasses(entry, host, port)) ? null : proxy;
}
