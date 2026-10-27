/**
 * Spec §22's two sentences, as executable assertions.
 *
 * > Show the raw secret only once.
 * > Store only a secure hash.
 *
 * The acceptance criterion for this task states the same thing and names the half that is easy to
 * skip: *"a key is returned EXACTLY ONCE and thereafter only its hash exists. Prove the second
 * half — a test that reads the row back and asserts the plaintext is unreachable, and a test that
 * a second read of the creation endpoint does not re-reveal it."*
 *
 * So there are three separate proofs here, and each is over a different surface:
 *
 *   1. **The row.** The stored record is read back through the directory port and every one of its
 *      fields is compared against the plaintext and against its secret half. Not "the response
 *      looks right" — the thing that persists, inspected.
 *   2. **The creation endpoint, read again.** `GET /api/api-keys` is a `GET` on the same path the
 *      `201` came from; it is called after the creation and its body is scanned.
 *   3. **Every response the suite produced.** R-12 §1.5's method: the harness records the body text
 *      of every response, and the plaintext must appear in exactly one of them — the `201`. This is
 *      the assertion that would catch a *future* route re-revealing the key, which neither of the
 *      first two would.
 *
 * All three drive the real route files with real `Request` objects.
 */
import crypto from 'node:crypto';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { DELETE as DELETE_API_KEY } from '../../app/api/api-keys/[id]/route';
import { GET as LIST_API_KEYS, POST as CREATE_API_KEY } from '../../app/api/api-keys/route';

import {
  API_KEY_PREFIX,
  hashApiKeySecret,
  hashesEqual,
  KEY_ID_LENGTH,
  mintApiKey,
  parsePresentedKey,
  presentedKeyText,
  readBearerApiKey,
  readBearerApiKeyAttempt,
  SECRET_LENGTH,
} from './api-key';
import { conferredBy, type ConferredRole } from './conferral';
import type { ApiKeySummary, RevokeApiKeyOutcome, WorkspaceDirectory } from './directory';
import { revokeApiKey } from './handlers';
import { createMemoryDirectory } from './memory-directory';
import type { Role } from './roles';
import { clearApplicationContext } from '../application-context';
import { installTestDomains } from '../application-context-fixtures';
import type { ToolEndpointEnvironment } from '../tool-endpoint/env';

/**
 * A role an Owner may confer, for the fixture rows below.
 *
 * The directory port takes a `ConferredRole` rather than a `Role` — the type-level half of
 * `conferral.ts`'s rule, and what makes a route that never asked *"may this caller confer this
 * role?"* a compile error rather than a review comment. A test that writes a role into a row
 * therefore has to say who is conferring it. An Owner may confer all four; `conferredBy` runs the
 * same comparison every route runs and throws if that ever stops being true.
 */
function asOwner(role: Role): ConferredRole {
  return conferredBy('owner', role, 'the fixture in this test file');
}

import { installRbacHarness, TEST_WORKSPACE_ID, type RbacHarness } from './testing';

const OWNER = { email: 'owner@example.test' };

function harnessWithOwner(): RbacHarness {
  // `newId` is supplied — as `routes.test.ts` and `invitations/routes.test.ts` already do — because
  // this suite revokes a key by the id the fixture minted, and issue #203 made `revokeApiKey`
  // refuse an id that is not shaped like the `uuid` column `api_keys.id` is. The fixture's default
  // counter (`id-2`) is not one, so a seeded id standing in for a real one has to be.
  return installRbacHarness(
    [{ email: OWNER.email, name: 'The Owner', workspaceId: TEST_WORKSPACE_ID, role: 'owner' }],
    { newId: crypto.randomUUID },
  );
}

/** The `201` body, narrowed. Throws rather than casting, so a shape change is a failure here. */
function createdKey(body: unknown): { key: string; id: string; keyPrefix: string } {
  if (typeof body !== 'object' || body === null) throw new Error('the 201 body is not an object');
  const record = body as Record<string, unknown>;
  const key = record['key'];
  const apiKey = record['apiKey'];
  if (typeof key !== 'string') throw new Error('the 201 body carries no "key" string');
  if (typeof apiKey !== 'object' || apiKey === null) throw new Error('no "apiKey" object');
  const summary = apiKey as Record<string, unknown>;
  const id = summary['id'];
  const keyPrefix = summary['keyPrefix'];
  if (typeof id !== 'string' || typeof keyPrefix !== 'string') {
    throw new Error('the 201 body’s apiKey has no id and prefix');
  }
  return { key, id, keyPrefix };
}

let live: RbacHarness | null = null;

afterEach(() => {
  live?.teardown();
  live = null;
});

describe('the key format is the one R-12 §1.4 measured', () => {
  it('mints a key that its own parser reads back, both halves at their fixed lengths', async () => {
    const minted = await mintApiKey();
    const parsed = parsePresentedKey(minted.presented);
    expect(parsed).not.toBeNull();
    expect(parsed?.keyId.length).toBe(KEY_ID_LENGTH);
    expect(parsed?.secret.length).toBe(SECRET_LENGTH);
    expect(minted.presented.startsWith(API_KEY_PREFIX)).toBe(true);
    expect(minted.keyPrefix).toBe(`${API_KEY_PREFIX}${minted.keyId}`);
    // The inverse really is the inverse, which is what lets the authenticator reconstruct the key
    // it was handed rather than keeping the raw string around.
    expect(parsed === null ? null : presentedKeyText(parsed)).toBe(minted.presented);
  });

  it('reads keys whose random halves contain the separator — R-12’s 63 % failure', async () => {
    // The measured claim in R-12 §1.4 is that roughly two keys in three contain at least one `_`
    // in a random half, so a `split('_')` parser rejects them. Rather than restating the number,
    // this mints until it has one and proves *this* parser reads it. If the alphabet ever changed
    // so that no key could contain a separator, this loop would run out and fail rather than pass
    // by never testing anything.
    let withSeparator: string | null = null;
    for (let attempt = 0; attempt < 200 && withSeparator === null; attempt += 1) {
      const minted = await mintApiKey();
      const halves = minted.presented.slice(API_KEY_PREFIX.length);
      if (halves.split('_').length > 2) withSeparator = minted.presented;
    }
    expect(withSeparator, 'no minted key contained a separator in 200 attempts').not.toBeNull();
    const parsed = parsePresentedKey(withSeparator);
    expect(parsed).not.toBeNull();
    expect(parsed === null ? null : presentedKeyText(parsed)).toBe(withSeparator);
  });

  it('rejects every malformed presentation R-12 probe J lists, and every non-string', async () => {
    const minted = await mintApiKey();
    const parsed = parsePresentedKey(minted.presented);
    if (parsed === null) throw new Error('a freshly minted key did not parse');
    const negatives: [string, unknown][] = [
      ['empty', ''],
      ['prefix only', API_KEY_PREFIX],
      ['wrong prefix', `zz_live_${parsed.keyId}_${parsed.secret}`],
      ['wrong env', `ak_test_${parsed.keyId}_${parsed.secret}`],
      ['key_id one short', `${API_KEY_PREFIX}${parsed.keyId.slice(1)}_${parsed.secret}`],
      ['key_id one long', `${API_KEY_PREFIX}${parsed.keyId}A_${parsed.secret}`],
      ['secret one short', `${API_KEY_PREFIX}${parsed.keyId}_${parsed.secret.slice(1)}`],
      ['secret one long', `${API_KEY_PREFIX}${parsed.keyId}_${parsed.secret}A`],
      ['non-base64url char', `${API_KEY_PREFIX}${parsed.keyId}_${parsed.secret.slice(1)}$`],
      ['trailing newline', `${minted.presented}\n`],
      ['embedded NUL', `${minted.presented}\u0000`],
      ['not a string', 42],
      ['null', null],
      ['undefined', undefined],
      ['an object shaped like one', { keyId: parsed.keyId, secret: parsed.secret }],
    ];
    const accepted = negatives
      .filter(([, value]) => parsePresentedKey(value) !== null)
      .map(([label]) => label);
    expect(accepted, 'these malformed presentations were accepted').toEqual([]);
  });

  it('reads a bearer header case-insensitively and refuses anything else', async () => {
    const minted = await mintApiKey();
    expect(readBearerApiKey(`Bearer ${minted.presented}`)).not.toBeNull();
    expect(readBearerApiKey(`bearer ${minted.presented}`)).not.toBeNull();
    for (const header of [
      minted.presented,
      `Basic ${minted.presented}`,
      `Bearer  ${minted.presented}`,
      `Bearer ${minted.presented} extra`,
      null,
      42,
    ]) {
      expect(readBearerApiKey(header), `accepted ${JSON.stringify(header)}`).toBeNull();
    }
  });

  it('distinguishes an absent credential from every invalid bearer attempt', async () => {
    const minted = await mintApiKey();
    expect(readBearerApiKeyAttempt(null)).toEqual({ kind: 'absent' });
    expect(readBearerApiKeyAttempt(undefined)).toEqual({ kind: 'absent' });
    expect(readBearerApiKeyAttempt(`Bearer ${minted.presented}`)).toMatchObject({
      kind: 'presented',
    });
    for (const header of [
      minted.presented,
      `Basic ${minted.presented}`,
      `Bearer  ${minted.presented}`,
      'Bearer malformed',
      42,
    ]) {
      expect(
        readBearerApiKeyAttempt(header),
        `did not fail closed for ${JSON.stringify(header)}`,
      ).toEqual({ kind: 'invalid' });
    }
  });

  it('compares digests without leaking where they differ', async () => {
    const digest = await hashApiKeySecret('a-secret');
    expect(hashesEqual(digest, digest)).toBe(true);
    expect(hashesEqual(digest, await hashApiKeySecret('another-secret'))).toBe(false);
    expect(hashesEqual(digest, digest.slice(0, -1))).toBe(false);
    expect(hashesEqual(digest, `${digest}0`)).toBe(false);
  });
});

describe('a key is returned exactly once, and thereafter only its hash exists', () => {
  it('returns the key in the 201, and stores only its hash', async () => {
    const harness = harnessWithOwner();
    live = harness;

    const created = await harness.call(CREATE_API_KEY, {
      method: 'POST',
      path: '/api/api-keys',
      as: OWNER,
      body: { name: 'Production', role: 'builder', expiresAt: null },
    });
    expect(created.status).toBe(201);
    const { key, id, keyPrefix } = createdKey(created.body);
    const parsed = parsePresentedKey(key);
    expect(parsed, 'the key returned is not one this program can read back').not.toBeNull();
    if (parsed === null) throw new Error('unreachable');

    // ── proof 1: the row ────────────────────────────────────────────────────────────────────
    const row = await harness.directory.forWorkspace(TEST_WORKSPACE_ID).readStoredApiKey(id);
    expect(row, 'the created key was not stored at all').not.toBeNull();
    if (row === null) throw new Error('unreachable');

    // The stored digest is the digest of the secret half, and of nothing else. This is the
    // positive assertion — "only its hash exists" said as an equality rather than as an absence.
    expect(row.keyHash).toBe(await hashApiKeySecret(parsed.secret));
    expect(row.keyPrefix).toBe(keyPrefix);
    expect(row.keyId).toBe(parsed.keyId);

    // …and the negative one, over every field of the row rather than over the fields somebody
    // remembered to check. A field that *contains* the plaintext or its secret half fails, so a
    // future column that helpfully cached it cannot pass by being spelled differently.
    const offending = Object.entries(row)
      .filter(
        ([, value]) =>
          typeof value === 'string' && (value.includes(key) || value.includes(parsed.secret)),
      )
      .map(([field]) => field);
    expect(offending, 'these stored fields contain the plaintext key or its secret half').toEqual(
      [],
    );
    expect(JSON.stringify(row).includes(parsed.secret)).toBe(false);

    // Every stored row of every workspace, not only this one — a leak into another tenant's row
    // would be worse, not better.
    expect(JSON.stringify(harness.directory.everyStoredApiKey()).includes(parsed.secret)).toBe(
      false,
    );
  });

  it('does not re-reveal the key when the creation endpoint is read again', async () => {
    const harness = harnessWithOwner();
    live = harness;

    const created = await harness.call(CREATE_API_KEY, {
      method: 'POST',
      path: '/api/api-keys',
      as: OWNER,
      body: { name: 'CI', role: 'viewer', expiresAt: null },
    });
    const { key, keyPrefix } = createdKey(created.body);
    const secret = parsePresentedKey(key)?.secret;
    if (secret === undefined) throw new Error('the created key did not parse');

    // A GET on the same path the 201 came from, twice, because "again" is the whole assertion.
    for (let read = 0; read < 2; read += 1) {
      const list = await harness.call(LIST_API_KEYS, {
        method: 'GET',
        path: '/api/api-keys',
        as: OWNER,
      });
      expect(list.status).toBe(200);
      expect(list.text.includes(key)).toBe(false);
      expect(list.text.includes(secret)).toBe(false);
      // Positive: the key is still *there*, named by its prefix. Without this the assertion above
      // would pass just as well against an endpoint that had lost the row entirely.
      expect(list.text.includes(keyPrefix)).toBe(true);
    }

    // Revoking returns the row too, and it is the same redacted shape.
    const revoked = await harness.call(DELETE_API_KEY, {
      method: 'DELETE',
      path: '/api/api-keys/x',
      as: OWNER,
      id: createdKey(created.body).id,
    });
    expect(revoked.status).toBe(200);
    expect(revoked.text.includes(key)).toBe(false);
    expect(revoked.text.includes(secret)).toBe(false);
  });

  it('puts the plaintext in exactly one response body across the whole exchange', async () => {
    const harness = harnessWithOwner();
    live = harness;

    const created = await harness.call(CREATE_API_KEY, {
      method: 'POST',
      path: '/api/api-keys',
      as: OWNER,
      body: { name: 'Production', role: 'admin', expiresAt: null },
    });
    const { key, id } = createdKey(created.body);

    // Every other route of this task, driven after the creation. If any of them ever learns to
    // return a key, this test is where it is caught — including a route that does not exist yet,
    // because the scan is over the recorded responses rather than over a list of endpoints.
    await harness.call(LIST_API_KEYS, { method: 'GET', path: '/api/api-keys', as: OWNER });
    await harness.call(CREATE_API_KEY, {
      method: 'POST',
      path: '/api/api-keys',
      as: OWNER,
      body: { name: 'Production', role: 'admin', expiresAt: null },
    });
    await harness.call(DELETE_API_KEY, {
      method: 'DELETE',
      path: '/api/api-keys/x',
      as: OWNER,
      id,
    });
    await harness.call(LIST_API_KEYS, { method: 'GET', path: '/api/api-keys', as: OWNER });

    const revealing = harness.responses.filter((response) => response.text.includes(key));
    expect(
      revealing.map(
        (response) => `${response.method} ${response.url} → ${String(response.status)}`,
      ),
      'the plaintext key appears in these responses; §22 allows exactly one',
    ).toEqual(['POST https://control-plane.test/api/api-keys → 201']);
    // …and the second creation with the same name was refused rather than quietly re-minting.
    expect(harness.responses.filter((response) => response.status === 409).length).toBe(1);
  });
});

describe('authentication with a presented key decides on a positive assertion', () => {
  it('does not fall back to a valid session after a malformed bearer attempt', async () => {
    const harness = harnessWithOwner();
    live = harness;

    const response = await harness.call(LIST_API_KEYS, {
      method: 'GET',
      path: '/api/api-keys',
      as: OWNER,
      bearer: 'malformed',
    });

    expect(response.status).toBe(401);
  });

  it('accepts the minted key, and refuses a revoked one, an expired one and an unknown one', async () => {
    // The clock is an argument, so expiry is proved rather than waited for.
    let clock = new Date('2026-01-01T00:00:00.000Z');
    const directory = createMemoryDirectory({ now: () => clock });
    const workspace = directory.forWorkspace('ws-1');

    const liveKey = await workspace.createApiKey({
      name: 'live',
      role: asOwner('builder'),
      expiresAt: null,
    });
    const expiring = await workspace.createApiKey({
      name: 'expiring',
      role: asOwner('viewer'),
      expiresAt: '2026-01-02T00:00:00.000Z',
    });
    const doomed = await workspace.createApiKey({
      name: 'doomed',
      role: asOwner('admin'),
      expiresAt: null,
    });
    if (liveKey.kind !== 'created' || expiring.kind !== 'created' || doomed.kind !== 'created') {
      throw new Error('the directory refused to create the keys this test needs');
    }

    const authenticated = await directory.authenticateApiKey(liveKey.presented, clock);
    expect(authenticated).not.toBeNull();
    if (authenticated === null) throw new Error('the live key did not authenticate');
    expect(authenticated.principalId).toMatch(/\S/u);
    expect(authenticated).toMatchObject({
      apiKeyId: liveKey.key.id,
      workspaceId: 'ws-1',
      role: 'builder',
      label: 'live',
    });
    expect(await directory.authenticateApiKey(expiring.presented, clock)).not.toBeNull();

    // Revoked.
    expect((await workspace.revokeApiKey(doomed.key.id)).kind).toBe('revoked');
    expect(await directory.authenticateApiKey(doomed.presented, clock)).toBeNull();

    // Expired.
    clock = new Date('2026-01-03T00:00:00.000Z');
    expect(await directory.authenticateApiKey(expiring.presented, clock)).toBeNull();
    // …and the live key still works at the later clock, so the test above proved expiry rather
    // than a broken clock.
    expect(await directory.authenticateApiKey(liveKey.presented, clock)).not.toBeNull();

    // Unknown, malformed, and a key whose secret half was altered — all the same `null`, which is
    // R-12 §1.5: distinguishing them turns the 401 into an oracle for enumerating retired keys.
    const parsed = parsePresentedKey(liveKey.presented);
    if (parsed === null) throw new Error('the live key did not parse');
    const tamperedSecret = `${parsed.secret.slice(0, -1)}${parsed.secret.endsWith('A') ? 'B' : 'A'}`;
    for (const presentation of [
      'ak_live_not-a-key',
      '',
      presentedKeyText({ keyId: parsed.keyId, secret: tamperedSecret }),
    ]) {
      expect(await directory.authenticateApiKey(presentation, clock)).toBeNull();
    }
  });

  it('records last_used_at on a successful authentication and not on a failed one', async () => {
    const clock = new Date('2026-02-01T00:00:00.000Z');
    const directory = createMemoryDirectory({ now: () => clock });
    const workspace = directory.forWorkspace('ws-1');
    const created = await workspace.createApiKey({
      name: 'k',
      role: asOwner('viewer'),
      expiresAt: null,
    });
    if (created.kind !== 'created') throw new Error('creation failed');

    expect((await workspace.readStoredApiKey(created.key.id))?.lastUsedAt).toBeNull();
    await directory.authenticateApiKey('ak_live_nope', clock);
    expect((await workspace.readStoredApiKey(created.key.id))?.lastUsedAt).toBeNull();
    await directory.authenticateApiKey(created.presented, clock);
    expect((await workspace.readStoredApiKey(created.key.id))?.lastUsedAt).toBe(
      clock.toISOString(),
    );
  });

  it('refuses an expiry that is not later than now, rather than storing a key nobody can use', async () => {
    const clock = new Date('2026-02-01T00:00:00.000Z');
    const directory = createMemoryDirectory({ now: () => clock });
    const workspace = directory.forWorkspace('ws-1');
    for (const expiresAt of ['2020-01-01T00:00:00.000Z', clock.toISOString()]) {
      const outcome = await workspace.createApiKey({
        name: 'k',
        role: asOwner('viewer'),
        expiresAt,
      });
      expect(outcome.kind).toBe('expiry-in-the-past');
    }
    expect(directory.everyStoredApiKey()).toEqual([]);
  });
});

describe('revoking an endpoint key tells the caller which project client it served', () => {
  const key = { id: crypto.randomUUID(), name: 'k' } as ApiKeySummary;
  const directoryAnswering = (outcome: RevokeApiKeyOutcome): WorkspaceDirectory =>
    ({ revokeApiKey: () => Promise.resolve(outcome) }) as unknown as WorkspaceDirectory;

  it('calls back once, with the client id, for the revoke of an mcp-project key', async () => {
    const closed = vi.fn(() => Promise.resolve());
    const response = await revokeApiKey(
      directoryAnswering({ kind: 'revoked', key, mcpProjectClientId: 'client-one' }),
      key.id,
      closed,
    );
    expect(response).toEqual({ status: 200, body: { apiKey: key } });
    expect(closed).toHaveBeenCalledTimes(1);
    expect(closed).toHaveBeenCalledWith('client-one');
  });

  it('does not call back for an ordinary key, a repeat revoke or an unknown key', async () => {
    const closed = vi.fn(() => Promise.resolve());
    for (const outcome of [
      { kind: 'revoked', key, mcpProjectClientId: null },
      { kind: 'already-revoked', key },
      { kind: 'no-such-key', id: key.id },
    ] as const) {
      await revokeApiKey(directoryAnswering(outcome), key.id, closed);
    }
    expect(closed).not.toHaveBeenCalled();
  });

  it('closes the client’s tool sandbox in the caller’s workspace through the route', async () => {
    const harness = harnessWithOwner();
    live = harness;
    const closeSandbox = vi.fn(() => Promise.resolve());
    installTestDomains({
      toolEndpoint: {
        kind: 'serving',
        environment: { closeSandbox } as unknown as ToolEndpointEnvironment,
      },
    });
    try {
      // The memory directory never records an endpoint scope, so this reports one for the revoke.
      const { directory } = harness;
      const forWorkspace = directory.forWorkspace.bind(directory);
      vi.spyOn(directory, 'forWorkspace').mockImplementation((workspaceId) => {
        const scoped = forWorkspace(workspaceId);
        return {
          ...scoped,
          revokeApiKey: async (id) => {
            const outcome = await scoped.revokeApiKey(id);
            return outcome.kind === 'revoked'
              ? { ...outcome, mcpProjectClientId: 'client-one' }
              : outcome;
          },
        };
      });
      const created = await harness.call(CREATE_API_KEY, {
        method: 'POST',
        path: '/api/api-keys',
        as: OWNER,
        body: { name: 'endpoint', role: 'viewer', expiresAt: null },
      });
      const revoked = await harness.call(DELETE_API_KEY, {
        method: 'DELETE',
        path: '/api/api-keys/x',
        as: OWNER,
        id: createdKey(created.body).id,
      });
      expect(revoked.status).toBe(200);
      expect(closeSandbox).toHaveBeenCalledTimes(1);
      expect(closeSandbox).toHaveBeenCalledWith(TEST_WORKSPACE_ID, 'client-one');
    } finally {
      clearApplicationContext();
    }
  });

  it('does not call back for an id that is not a UUID', async () => {
    const closed = vi.fn(() => Promise.resolve());
    const response = await revokeApiKey(
      directoryAnswering({ kind: 'revoked', key, mcpProjectClientId: 'client-one' }),
      'not-a-uuid',
      closed,
    );
    expect(response.status).toBe(404);
    expect(closed).not.toHaveBeenCalled();
  });
});
