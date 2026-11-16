import { describe, expect, it, vi } from 'vitest';
import {
  frontendFiles,
  redactingCheck,
  responseSecrets,
  setDotEnv,
  setupAnswered,
} from './journey.e2e.mjs';
import './journey-test-fixtures.js';

describe('the lightweight journey helpers (issue #832)', () => {
  it('replaces a set line, appends a missing one and keeps the rest of the file', () => {
    const text = 'A=1\nDATABASE_URL=\nB=2\n';
    expect(setDotEnv(text, { DATABASE_URL: 'postgres://x?a=b&c=d', C: '3' })).toBe(
      'A=1\nDATABASE_URL=postgres://x?a=b&c=d\nB=2\nC=3\n',
    );
    expect(setDotEnv('A=1', { B: '2' })).toBe('A=1\nB=2\n');
  });

  it('writes a frontend whose build embeds the control plane url', () => {
    const files = frontendFiles();
    const manifest = JSON.parse(files['package.json']) as { scripts: { build: string } };
    expect(manifest.scripts.build).toBe('node build.mjs');
    expect(files['build.mjs']).toContain('VITE_AW_BASE_URL');
  });

  it('finds the credentials an answer carries, at any depth, and ignores the rest', () => {
    expect(
      responseSecrets({
        token: 'awt_live_abc_0123456789',
        sessionId: 'session-0123456789',
        nested: { apiKey: 'ak_live_abc_0123456789', password: 'short', count: 12345678 },
        list: [{ secret: 'declared-secret-value' }],
        tokens: ['awt_live_def_0123456789', 'short'],
        names: ['not-a-secret-value'],
      }),
    ).toEqual([
      'awt_live_abc_0123456789',
      'ak_live_abc_0123456789',
      'declared-secret-value',
      'awt_live_def_0123456789',
    ]);
    expect(responseSecrets(null)).toEqual([]);
  });

  it('prints no visitor token on an ok: line, whatever the order the token was learned in', () => {
    const token = 'awt_live_0a1b2c3d_4e5f6a7b8c9d0e1f';
    const session = { status: 201, text: JSON.stringify({ token, sessionId: 'sid-1' }) };
    const secrets: string[] = [];
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const check = redactingCheck(() => secrets);
    secrets.push(...responseSecrets(JSON.parse(session.text)));
    check(true, `a visitor session opened (${String(session.status)} ${session.text})`);
    const printed = log.mock.calls.map((call) => String(call[0])).join('\n');
    expect(printed).toContain('ok: a visitor session opened (201 {"token":"[redacted]"');
    expect(printed).not.toContain('awt_');
    expect(() => check(false, `refused ${token}`)).toThrow(/refused \[redacted\]/u);
  });

  it('prints the setup answer through the redacting report it is given', () => {
    const lines: string[] = [];
    const report = redactingCheck(
      () => ['awt_live_abcdef0123456789'],
      (_ok, message) => {
        lines.push(message);
      },
    );
    const text = '{"token":"awt_live_abcdef0123456789"}';
    setupAnswered(undefined, { status: 201, text, json: JSON.parse(text) }, report);
    expect(lines.join('\n')).toContain('setup answered 201 {"token":"[redacted]"}');
    expect(lines.join('\n')).not.toContain('awt_');
  });
});
