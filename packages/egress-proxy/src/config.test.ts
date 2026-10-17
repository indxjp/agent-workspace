import { describe, expect, it } from 'vitest';

import { loadConfig } from './config.js';

const valid = { EGRESS_SESSION_ID: 'session-1', EGRESS_ALLOWLIST: 'api.example.com, *.cdn.test' };

describe('loadConfig', () => {
  it('reads the session, the allowlist and the defaults', () => {
    const config = loadConfig(valid);
    expect(config.sessionId).toBe('session-1');
    expect(config.allowlist.exact.has('api.example.com')).toBe(true);
    expect(config.allowlist.suffixes).toEqual(['.cdn.test']);
    expect(config.allowedPorts).toBeUndefined();
    expect(config.port).toBe(3128);
  });

  it('reads an explicit port list', () => {
    expect(loadConfig({ ...valid, EGRESS_ALLOWED_PORTS: '443, 8443', PORT: '8080' })).toMatchObject(
      {
        allowedPorts: [443, 8443],
        port: 8080,
      },
    );
  });

  it.each([
    [{ EGRESS_ALLOWLIST: 'example.com' }, 'EGRESS_SESSION_ID is required'],
    [{ EGRESS_SESSION_ID: ' ', EGRESS_ALLOWLIST: 'example.com' }, 'EGRESS_SESSION_ID is required'],
    [{ EGRESS_SESSION_ID: 's' }, 'EGRESS_ALLOWLIST is required'],
    [{ EGRESS_SESSION_ID: 's', EGRESS_ALLOWLIST: 'exa*mple.com' }, 'must be a host name'],
    [{ ...valid, EGRESS_ALLOWED_PORTS: '443,http' }, 'EGRESS_ALLOWED_PORTS must list ports'],
    [{ ...valid, EGRESS_ALLOWED_PORTS: '70000' }, 'EGRESS_ALLOWED_PORTS must list ports'],
    [{ ...valid, PORT: '0' }, 'PORT must list ports'],
  ])('refuses %j', (env, message) => {
    expect(() => loadConfig(env)).toThrow(message);
  });
});
