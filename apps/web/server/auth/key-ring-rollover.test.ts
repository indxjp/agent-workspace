/**
 * Part 06 step 5: every signed cookie is signed with its own purpose key, a cookie signed for one
 * purpose is refused for every other, and a cookie signed the old way (with the raw secret) still
 * verifies during the roll-over, so a deploy signs nobody out.
 */
import { hkdfSync } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { mintInvitationIdentityToken, verifyInvitationIdentityToken } from './invitation-identity';
import { mintSelectionToken, verifySelectionToken } from './selection';
import { mintSessionToken, newSessionClaims, verifySessionToken } from './session';

const SECRET = 'roll-over-test-secret-0123456789abcdef';
const NOW_MS = Date.UTC(2026, 10, 10, 3, 0, 0);
const encoder = new TextEncoder();

function purposeKey(purpose: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(
    hkdfSync('sha256', SECRET, 'agent-workspace/key-ring', `agent-workspace/${purpose}/v1`, 32),
  );
}

async function hmac(key: Uint8Array<ArrayBuffer>, data: string): Promise<string> {
  const imported = await crypto.subtle.importKey(
    'raw',
    key,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', imported, encoder.encode(data));
  return Buffer.from(mac).toString('base64url');
}

/** The same token, its MAC recomputed under `key`. */
async function resigned(token: string, key: Uint8Array<ArrayBuffer>): Promise<string> {
  const [version, payload] = token.split('.');
  const head = `${version ?? ''}.${payload ?? ''}`;
  return `${head}.${await hmac(key, head)}`;
}

const LEGACY = encoder.encode(SECRET);

interface Case {
  readonly name: string;
  readonly purpose: string;
  readonly other: string;
  readonly mint: () => Promise<string>;
  readonly verifies: (token: string) => Promise<boolean>;
}

const cases: readonly Case[] = [
  {
    name: 'session',
    purpose: 'session',
    other: 'workspace-selection',
    mint: () => mintSessionToken(newSessionClaims('a@b.test', 'default', NOW_MS), SECRET),
    verifies: async (token) => (await verifySessionToken(token, SECRET, NOW_MS)).ok,
  },
  {
    name: 'workspace selection',
    purpose: 'workspace-selection',
    other: 'session',
    mint: () => mintSelectionToken('user-1', 'a@b.test', SECRET, NOW_MS),
    verifies: async (token) => (await verifySelectionToken(token, SECRET, NOW_MS)).ok,
  },
  {
    name: 'invitation identity',
    purpose: 'invitation-identity',
    other: 'session',
    mint: () =>
      mintInvitationIdentityToken(
        { email: 'a@b.test', issuer: 'https://issuer.example.test', subject: 'sub' },
        SECRET,
        NOW_MS,
      ),
    verifies: async (token) => (await verifyInvitationIdentityToken(token, SECRET, NOW_MS)).ok,
  },
];

describe.each(cases)('the $name cookie', ({ purpose, other, mint, verifies }) => {
  it('is signed with its purpose key, not the raw secret', async () => {
    const token = await mint();
    expect(await resigned(token, purposeKey(purpose))).toBe(token);
    expect(await resigned(token, LEGACY)).not.toBe(token);
    expect(await verifies(token)).toBe(true);
  });

  it('is refused when signed with another purpose key', async () => {
    expect(await verifies(await resigned(await mint(), purposeKey(other)))).toBe(false);
  });

  it('still verifies when signed the old way, during the roll-over', async () => {
    expect(await verifies(await resigned(await mint(), LEGACY))).toBe(true);
  });

  it('is refused when signed with neither key', async () => {
    expect(await verifies(await resigned(await mint(), encoder.encode(`${SECRET}x`)))).toBe(false);
  });
});
