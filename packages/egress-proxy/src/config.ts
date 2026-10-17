import { parseAllowlist, type Allowlist } from './allowlist.js';

export interface EgressProxyConfig {
  readonly sessionId: string;
  readonly allowlist: Allowlist;
  readonly allowedPorts: readonly number[] | undefined;
  readonly host: string;
  readonly port: number;
}

export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

function parsePort(name: string, value: string): number {
  const port = /^\d{1,5}$/u.test(value) ? Number(value) : 0;
  if (port < 1 || port > 65535) throw new ConfigError(`${name} must list ports from 1 to 65535`);
  return port;
}

/** Reads the process environment, failing at startup with a message that names the variable. */
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
  const ports = env['EGRESS_ALLOWED_PORTS'];
  return {
    sessionId,
    allowlist: parseAllowlist(entries),
    allowedPorts:
      ports === undefined
        ? undefined
        : ports.split(',').map((port) => parsePort('EGRESS_ALLOWED_PORTS', port.trim())),
    host: env['HOST'] ?? '0.0.0.0',
    port: parsePort('PORT', env['PORT'] ?? '3128'),
  };
}
