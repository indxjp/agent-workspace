import { describe, expect, it } from 'vitest';

import { createEndpointGrantCodec } from './endpoint-grant.js';
import { createRunTokenCodec } from './run-token.js';

const SECRET = 'gateway-endpoint-grant-test-secret-at-least-32-bytes';
const SUBJECT = {
  workspaceId: 'workspace-1',
  clientId: 'client-1',
  origin: 'http://runner:7001/tool-sandboxes/sealed',
} as const;
const RUN_SUBJECT = {
  runId: 'run-1',
  sessionId: 'session-1',
  workspaceId: 'workspace-1',
  agentId: 'agent-1',
  modelConnectionId: 'connection-1',
} as const;

describe('endpoint grant codec', () => {
  it('round-trips the claims with a 60 second lifetime', async () => {
    const codec = createEndpointGrantCodec({ secret: SECRET, now: () => 1_000 });
    const token = await codec.issue(SUBJECT);

    expect(token.startsWith('awg.')).toBe(true);
    await expect(codec.verify(token)).resolves.toEqual({
      ok: true,
      claims: {
        version: 1,
        kind: 'tool-endpoint',
        ...SUBJECT,
        issuedAt: 1_000,
        expiresAt: 1_060,
      },
    });
  });

  it('expires', async () => {
    let now = 1_000;
    const codec = createEndpointGrantCodec({ secret: SECRET, now: () => now });
    const token = await codec.issue(SUBJECT);
    now = 1_060;
    await expect(codec.verify(token)).resolves.toEqual({ ok: false, reason: 'expired' });
  });

  it('refuses a tampered payload, a tampered signature and a different secret', async () => {
    const codec = createEndpointGrantCodec({ secret: SECRET });
    const token = await codec.issue(SUBJECT);
    const [payload, signature] = token.slice('awg.'.length).split('.');
    const forged = btoa(
      JSON.stringify({
        version: 1,
        kind: 'tool-endpoint',
        ...SUBJECT,
        origin: 'http://attacker.test',
        issuedAt: 1,
        expiresAt: 2 ** 40,
      }),
    );
    expect(payload).toBeDefined();
    await expect(codec.verify(`awg.${forged}.${signature}`)).resolves.toEqual({
      ok: false,
      reason: 'invalid',
    });
    // Flip a character mid-signature, where all 6 bits are significant, so the bytes always change.
    const flipped = `${signature?.slice(0, 5)}${signature?.[5] === 'A' ? 'B' : 'A'}${signature?.slice(6)}`;
    await expect(codec.verify(`awg.${payload}.${flipped}`)).resolves.toEqual({
      ok: false,
      reason: 'invalid',
    });
    await expect(
      createEndpointGrantCodec({ secret: `${SECRET}-other` }).verify(token),
    ).resolves.toEqual({ ok: false, reason: 'invalid' });
    await expect(codec.verify('awg.')).resolves.toEqual({ ok: false, reason: 'invalid' });
    await expect(codec.verify('garbage')).resolves.toEqual({ ok: false, reason: 'invalid' });
  });

  it('is not a run token, and a run token is not a grant', async () => {
    const grants = createEndpointGrantCodec({ secret: SECRET });
    const runs = createRunTokenCodec({ secret: SECRET });
    const grant = await grants.issue(SUBJECT);
    const runToken = await runs.issue(RUN_SUBJECT);

    await expect(runs.verify(grant)).resolves.toEqual({ ok: false, reason: 'invalid' });
    await expect(runs.verify(grant.slice('awg.'.length))).resolves.toEqual({
      ok: false,
      reason: 'invalid',
    });
    await expect(grants.verify(runToken)).resolves.toEqual({ ok: false, reason: 'invalid' });
    await expect(grants.verify(`awg.${runToken}`)).resolves.toEqual({
      ok: false,
      reason: 'invalid',
    });
  });

  it('refuses a lifetime over 60 seconds at construction', () => {
    expect(() => createEndpointGrantCodec({ secret: SECRET, ttlSeconds: 61 })).toThrow(/TTL/u);
    expect(() => createEndpointGrantCodec({ secret: SECRET, ttlSeconds: 0 })).toThrow(/TTL/u);
    expect(() => createEndpointGrantCodec({ secret: 'short' })).toThrow(/32 bytes/u);
  });

  it('refuses to issue a grant with a blank subject', async () => {
    const codec = createEndpointGrantCodec({ secret: SECRET });
    await expect(codec.issue({ ...SUBJECT, clientId: ' ' })).rejects.toThrow();
  });
});
