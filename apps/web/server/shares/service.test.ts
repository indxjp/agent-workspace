import { createHash, randomBytes, scryptSync } from 'node:crypto';

import type { ShareRecord } from '@agent-workspace/core/db';
import { describe, expect, it } from 'vitest';

import { PassphraseAttemptLimiter } from './passphrase';
import { ShareService } from './service';
import { baseShare, ownerActor, publicSessionInput, sharing, TOKEN } from './service.test-support';

describe('anonymous share resolution', () => {
  it.each(['private', 'workspace'] as const)('fails closed for %s tokens', async (visibility) => {
    const { repositories, recordView } = sharing({ ...baseShare, visibility });

    await expect(new ShareService(repositories).resolve(TOKEN)).rejects.toThrow(
      'Public link is unavailable.',
    );
    expect(recordView).not.toHaveBeenCalled();
  });

  it('resolves and records a view only for a public share', async () => {
    const { repositories, recordView } = sharing(baseShare);
    await expect(new ShareService(repositories).resolve(TOKEN)).resolves.toEqual(baseShare);
    expect(recordView).toHaveBeenCalledWith(baseShare.id, undefined);
  });

  it('looks the link up by the hash of its token, never by the token (part 06 step 3)', async () => {
    const { repositories } = sharing(baseShare);
    await new ShareService(repositories).resolve(TOKEN);
    expect(repositories.shares.findByTokenHash).toHaveBeenCalledWith(
      createHash('sha256').update(TOKEN, 'utf8').digest('hex'),
    );
    expect(repositories.shares.findByTokenHash).not.toHaveBeenCalledWith(TOKEN);
  });
});

describe('share publishing policy', () => {
  it('rejects public publishing when the durable workspace policy is disabled', async () => {
    const { repositories, getPublicSharingEnabled, createShare } = sharing(baseShare);
    getPublicSharingEnabled.mockResolvedValue(false);

    await expect(
      new ShareService(repositories).publish(publicSessionInput, ownerActor),
    ).rejects.toThrow('Public sharing is disabled');
    expect(createShare).not.toHaveBeenCalled();
  });

  it('returns a fresh token once and stores only its hash (part 06 step 3 phase 2)', async () => {
    const { repositories, createShare } = sharing(baseShare);
    createShare.mockImplementation((values: object) =>
      Promise.resolve({ ...baseShare, ...values }),
    );
    const { share, token } = await new ShareService(repositories).publish(
      publicSessionInput,
      ownerActor,
    );
    expect(token).toMatch(/^pub_[A-Za-z0-9_-]{24}$/u);
    const written = createShare.mock.calls[0]![0] as Record<string, unknown>;
    expect(written).not.toHaveProperty('token');
    expect(written['tokenHash']).toBe(createHash('sha256').update(token, 'utf8').digest('hex'));
    expect(JSON.stringify(written)).not.toContain(token);
    expect(share.tokenHash).toBe(written['tokenHash']);
  });
});

describe('share passphrase', () => {
  const salt = randomBytes(16);
  const passphraseHash = `${salt.toString('base64url')}.${scryptSync('right', salt, 32).toString('base64url')}`;
  const protectedShare = { ...baseShare, passphraseHash };
  const service = (found: ShareRecord) =>
    new ShareService(
      sharing(found).repositories,
      false,
      { now: () => new Date('2026-01-02T00:00:00Z') },
      new PassphraseAttemptLimiter(),
    );

  it('accepts the right passphrase and refuses a wrong or missing one', async () => {
    const shares = service(protectedShare);
    await expect(shares.resolve(TOKEN, 'right')).resolves.toEqual(protectedShare);
    await expect(shares.resolve(TOKEN, 'wrong')).rejects.toMatchObject({
      code: 'invalid_passphrase',
    });
    await expect(shares.resolve(TOKEN)).rejects.toMatchObject({ code: 'invalid_passphrase' });
  });

  it('stops verifying a share after 10 wrong guesses a minute, even for the right one', async () => {
    const shares = service(protectedShare);
    for (let guess = 0; guess < 10; guess += 1) {
      await expect(shares.resolve(TOKEN, `guess-${String(guess)}`)).rejects.toMatchObject({
        code: 'invalid_passphrase',
      });
    }
    await expect(shares.resolve(TOKEN, 'right')).rejects.toMatchObject({
      category: 'rate-limit',
      code: 'passphrase_attempts_limited',
      retryAfterSeconds: expect.any(Number) as unknown,
    });
  });

  it('does not count an open without a passphrase as a guess, so page loads never lock a link', async () => {
    const shares = service(protectedShare);
    for (let open = 0; open < 15; open += 1) {
      await expect(shares.resolve(TOKEN)).rejects.toMatchObject({ code: 'invalid_passphrase' });
      await expect(shares.resolve(TOKEN, '')).rejects.toMatchObject({
        code: 'invalid_passphrase',
      });
    }
    await expect(shares.resolve(TOKEN, 'right')).resolves.toEqual(protectedShare);
  });

  it('does not count correct passphrases toward the limit', async () => {
    const shares = service(protectedShare);
    for (let attempt = 0; attempt < 15; attempt += 1) {
      await expect(shares.resolve(TOKEN, 'right')).resolves.toEqual(protectedShare);
    }
  });

  it('limits a visitor to 5 wrong guesses a minute without locking out the share', async () => {
    const shares = service(protectedShare);
    for (let guess = 0; guess < 5; guess += 1) {
      await expect(shares.resolve(TOKEN, 'nope', 'visitor-a')).rejects.toMatchObject({
        code: 'invalid_passphrase',
      });
    }
    await expect(shares.resolve(TOKEN, 'right', 'visitor-a')).rejects.toMatchObject({
      code: 'passphrase_attempts_limited',
    });
    await expect(shares.resolve(TOKEN, 'right', 'visitor-b')).resolves.toEqual(protectedShare);
  });
});
