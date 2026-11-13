import { readFileSync } from 'node:fs';

import { parseAllowlist, type Allowlist } from './allowlist.js';
import { DEFAULT_PORTS } from './proxy.js';

const MIN_KEY_LENGTH = 32;
const DEFAULT_HOST = '0.0.0.0';
const DEFAULT_PORT = '3128';

/** One row of the generated settings table (`docs/operations/settings.md`, refactoring part 03). */
export interface SettingDescription {
  readonly name: string;
  readonly default: string;
  readonly meaning: string;
}

/** The variables {@link loadProxyConfig} reads, in either mode. */
export const EGRESS_PROXY_SETTINGS: readonly SettingDescription[] = [
  {
    name: 'EGRESS_MODE',
    default: '`session`',
    meaning:
      '`session`: one sandbox, with its allowlist below. `shared`: every request carries a signed credential naming its session and hosts.',
  },
  {
    name: 'EGRESS_SESSION_ID',
    default: 'none: required in `session` mode',
    meaning: 'The session this proxy serves. Must not be set in `shared` mode.',
  },
  {
    name: 'EGRESS_ALLOWLIST',
    default: 'none: required in `session` mode',
    meaning:
      'Comma-separated host names, `*.suffix` entries, or `*`, that the sandbox may reach. Must not be set in `shared` mode.',
  },
  {
    name: 'EGRESS_CREDENTIAL_KEY_FILE',
    default: 'none: required in `shared` mode',
    meaning: `A file holding the key credentials are signed with, at least ${String(MIN_KEY_LENGTH)} characters.`,
  },
  {
    name: 'EGRESS_ALLOWED_PORTS',
    default: `unset: ${DEFAULT_PORTS.join(' and ')}`,
    meaning: 'Comma-separated ports, 1 to 65535, that requests may go to.',
  },
  { name: 'HOST', default: `\`${DEFAULT_HOST}\``, meaning: 'The address the proxy listens on.' },
  { name: 'PORT', default: `\`${DEFAULT_PORT}\``, meaning: 'The port the proxy listens on.' },
];

interface CommonConfig {
  readonly allowedPorts: readonly number[] | undefined;
  readonly host: string;
  readonly port: number;
}

/** One session: the allowlist comes from the environment. */
export interface EgressProxyConfig extends CommonConfig {
  readonly sessionId: string;
  readonly allowlist: Allowlist;
}

/** Shared: every request carries a signed credential that names its session and hosts. */
export interface SharedEgressProxyConfig extends CommonConfig {
  readonly credentialKey: Buffer;
}

export type ProxyConfig =
  | { readonly mode: 'session'; readonly config: EgressProxyConfig }
  | { readonly mode: 'shared'; readonly config: SharedEgressProxyConfig };

export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

function parsePort(name: string, value: string): number {
  const port = /^\d{1,5}$/u.test(value) ? Number(value) : 0;
  if (port < 1 || port > 65535) throw new ConfigError(`${name} must list ports from 1 to 65535`);
  return port;
}

function commonConfig(env: Readonly<Record<string, string | undefined>>): CommonConfig {
  const ports = env['EGRESS_ALLOWED_PORTS'];
  return {
    allowedPorts:
      ports === undefined
        ? undefined
        : ports.split(',').map((port) => parsePort('EGRESS_ALLOWED_PORTS', port.trim())),
    host: env['HOST'] ?? DEFAULT_HOST,
    port: parsePort('PORT', env['PORT'] ?? DEFAULT_PORT),
  };
}

function readCredentialKey(path: string | undefined): Buffer {
  if (path === undefined || path.trim() === '') {
    throw new ConfigError('EGRESS_CREDENTIAL_KEY_FILE is required when EGRESS_MODE is shared');
  }
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    throw new ConfigError('EGRESS_CREDENTIAL_KEY_FILE must name a readable file');
  }
  const key = text.replace(/\r?\n$/u, '');
  if (key.length < MIN_KEY_LENGTH) {
    throw new ConfigError(
      `EGRESS_CREDENTIAL_KEY_FILE must hold a key of at least ${MIN_KEY_LENGTH} characters`,
    );
  }
  return Buffer.from(key, 'utf8');
}

/** Reads the single-session environment, failing at startup with a message that names the variable. */
export function loadConfig(env: Readonly<Record<string, string | undefined>>): EgressProxyConfig {
  const sessionId = env['EGRESS_SESSION_ID']?.trim() ?? '';
  if (sessionId === '') throw new ConfigError('EGRESS_SESSION_ID is required');
  const entries = (env['EGRESS_ALLOWLIST'] ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
  if (entries.length === 0) {
    throw new ConfigError('EGRESS_ALLOWLIST is required: host names, *.suffix entries, or *');
  }
  return { sessionId, allowlist: parseAllowlist(entries), ...commonConfig(env) };
}

/** Reads the shared-mode environment: the key file is read once, and no session is configured. */
export function loadSharedConfig(
  env: Readonly<Record<string, string | undefined>>,
): SharedEgressProxyConfig {
  for (const name of ['EGRESS_SESSION_ID', 'EGRESS_ALLOWLIST']) {
    if (env[name] !== undefined) {
      throw new ConfigError(`${name} must not be set when EGRESS_MODE is shared`);
    }
  }
  return {
    credentialKey: readCredentialKey(env['EGRESS_CREDENTIAL_KEY_FILE']),
    ...commonConfig(env),
  };
}

/** Picks the mode from EGRESS_MODE: unset or `session` is the single-session proxy. */
export function loadProxyConfig(env: Readonly<Record<string, string | undefined>>): ProxyConfig {
  const mode = env['EGRESS_MODE']?.trim() ?? '';
  if (mode === 'shared') return { mode, config: loadSharedConfig(env) };
  if (mode === '' || mode === 'session') return { mode: 'session', config: loadConfig(env) };
  throw new ConfigError('EGRESS_MODE must be session or shared');
}
