import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { loadConfig, loadProxyConfig } from './config.js';

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

describe('loadProxyConfig', () => {
  const dir = mkdtempSync(join(tmpdir(), 'egress-key-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const keyFile = (content: string): string => {
    const path = join(dir, `key-${String(Math.random())}`);
    writeFileSync(path, content);
    return path;
  };
  const KEY = 'aw-egress-test-key-0123456789abcdef';

  it('keeps the single-session behaviour when EGRESS_MODE is unset or session', () => {
    expect(loadProxyConfig(valid)).toMatchObject({ mode: 'session' });
    expect(loadProxyConfig({ ...valid, EGRESS_MODE: 'session' })).toMatchObject({
      mode: 'session',
    });
  });

  it('reads the key file once and trims the trailing newline', () => {
    const loaded = loadProxyConfig({
      EGRESS_MODE: 'shared',
      EGRESS_CREDENTIAL_KEY_FILE: keyFile(`${KEY}\n`),
      EGRESS_ALLOWED_PORTS: '443',
    });
    expect(loaded.mode).toBe('shared');
    expect(loaded.config.allowedPorts).toEqual([443]);
    if (loaded.mode === 'shared') expect(loaded.config.credentialKey.toString('utf8')).toBe(KEY);
  });

  it.each([
    [{ EGRESS_MODE: 'shared' }, 'EGRESS_CREDENTIAL_KEY_FILE is required'],
    [
      { EGRESS_MODE: 'shared', EGRESS_CREDENTIAL_KEY_FILE: '/nonexistent/key' },
      'EGRESS_CREDENTIAL_KEY_FILE must name',
    ],
    [{ EGRESS_MODE: 'bogus' }, 'EGRESS_MODE must be'],
  ])('refuses %j', (env, message) => {
    expect(() => loadProxyConfig(env)).toThrow(message);
  });

  it('refuses a short key', () => {
    expect(() =>
      loadProxyConfig({ EGRESS_MODE: 'shared', EGRESS_CREDENTIAL_KEY_FILE: keyFile('short\n') }),
    ).toThrow('EGRESS_CREDENTIAL_KEY_FILE must hold a key of at least 32');
  });

  it.each(['EGRESS_ALLOWLIST', 'EGRESS_SESSION_ID'])('refuses %s in shared mode', (name) => {
    expect(() =>
      loadProxyConfig({
        EGRESS_MODE: 'shared',
        EGRESS_CREDENTIAL_KEY_FILE: keyFile(KEY),
        [name]: 'x',
      }),
    ).toThrow(`${name} must not be set`);
  });
});
