import { describe, expect, it } from 'vitest';

import { base64Url } from './base64url.js';
import { createRunTokenCodec, toolSandboxRunToken } from './run-token.js';

const SECRET = 'gateway-run-token-test-secret-at-least-32-bytes';
const SUBJECT = {
  runId: 'run-1',
  sessionId: 'session-1',
  workspaceId: 'workspace-1',
  agentId: 'agent-1',
  modelConnectionId: 'connection-1',
} as const;

describe('run token codec', () => {
  it('round-trips the complete, schema-validated claim set', async () => {
    const codec = createRunTokenCodec({
      secret: SECRET,
      now: () => 1_000,
      randomId: () => 'token-1',
    });
    const token = await codec.issue(SUBJECT);

    await expect(codec.verify(token)).resolves.toEqual({
      ok: true,
      claims: {
        version: 1,
        tokenId: 'token-1',
        ...SUBJECT,
        issuedAt: 1_000,
        expiresAt: 1_300,
      },
    });
  });

  it('carries the caller claim, and refuses one with an unknown principal kind', async () => {
    const codec = createRunTokenCodec({ secret: SECRET, now: () => 1_000 });
    const caller = { sub: 'customer-42', principalKind: 'api-key' } as const;
    const verified = await codec.verify(await codec.issue({ ...SUBJECT, caller }));
    expect(verified).toMatchObject({ ok: true, claims: { caller } });
    const forged = await codec.issue({
      ...SUBJECT,
      caller: { sub: 'x', principalKind: 'root' as 'visitor' },
    });
    await expect(codec.verify(forged)).resolves.toEqual({ ok: false, reason: 'invalid' });
  });

  it('carries the daily cost cap claim, and refuses a cap the policy could not set', async () => {
    const codec = createRunTokenCodec({ secret: SECRET, now: () => 1_000 });
    const verified = await codec.verify(await codec.issue({ ...SUBJECT, dailyCostCapUsd: 12.5 }));
    expect(verified).toMatchObject({ ok: true, claims: { dailyCostCapUsd: 12.5 } });
    const uncapped = await codec.verify(await codec.issue(SUBJECT));
    expect(uncapped).toMatchObject({ ok: true });
    expect(uncapped.ok && 'dailyCostCapUsd' in uncapped.claims).toBe(false);
    for (const dailyCostCapUsd of [0, -1, 100_001]) {
      const forged = await codec.issue({ ...SUBJECT, dailyCostCapUsd });
      await expect(codec.verify(forged)).resolves.toEqual({ ok: false, reason: 'invalid' });
    }
  });

  it('rejects modified and expired claims without exposing their contents', async () => {
    let now = 1_000;
    const codec = createRunTokenCodec({ secret: SECRET, now: () => now });
    const token = await codec.issue(SUBJECT);
    const [payload, signature] = token.split('.');

    await expect(codec.verify(`${payload}x.${signature}`)).resolves.toEqual({
      ok: false,
      reason: 'invalid',
    });

    now = 1_300;
    await expect(codec.verify(token)).resolves.toEqual({ ok: false, reason: 'expired' });
  });

  it('refuses a correctly signed token whose lifetime is longer than one hour', async () => {
    const codec = createRunTokenCodec({ secret: SECRET, now: () => 1_000 });
    const signed = async (expiresAt: number) => {
      const claims = { version: 1, tokenId: 'token-1', ...SUBJECT, issuedAt: 1_000, expiresAt };
      const payload = base64Url(new TextEncoder().encode(JSON.stringify(claims)));
      const key = await crypto.subtle.importKey(
        'raw',
        new TextEncoder().encode(SECRET),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign'],
      );
      const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
      return `${payload}.${base64Url(new Uint8Array(mac))}`;
    };

    await expect(codec.verify(await signed(1_000 + 3_600))).resolves.toMatchObject({ ok: true });
    await expect(codec.verify(await signed(1_000 + 3_601))).resolves.toEqual({
      ok: false,
      reason: 'invalid',
    });
  });
});

describe('tool sandbox run token', () => {
  it('is a stable hex HMAC per run that differs between runs and secrets', async () => {
    const token = await toolSandboxRunToken(SECRET, 'run-1');
    expect(token).toMatch(/^[0-9a-f]{64}$/u);
    await expect(toolSandboxRunToken(SECRET, 'run-1')).resolves.toBe(token);
    await expect(toolSandboxRunToken(SECRET, 'run-2')).resolves.not.toBe(token);
    await expect(toolSandboxRunToken(`${SECRET}-other`, 'run-1')).resolves.not.toBe(token);
  });

  it('is not a run token the gateway would accept', async () => {
    const codec = createRunTokenCodec({ secret: SECRET });
    await expect(codec.verify(await toolSandboxRunToken(SECRET, 'run-1'))).resolves.toEqual({
      ok: false,
      reason: 'invalid',
    });
  });

  it('refuses a short secret and a blank run id', async () => {
    await expect(toolSandboxRunToken('short', 'run-1')).rejects.toThrow(/at least 32 bytes/u);
    await expect(toolSandboxRunToken(SECRET, ' ')).rejects.toThrow(/run id/u);
  });
});
