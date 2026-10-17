import { describe, expect, it } from 'vitest';

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
