import type {
  CliSessionRepository,
  CliTokenExchangeOutcome,
  RecordCliApprovalInput,
} from '@agent-workspace/core/db';
import {
  CliTokenResponseSchema,
  DeviceAuthorizationResponseSchema,
} from '@indx-workspace/contracts/cli-auth';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { mintSessionToken, newSessionClaims, verifySessionToken } from '../auth/session';
import { hashCliTokenSecret, parsePresentedCliToken } from '../rbac/cli-token';
import type { DirectoryRoot, UserMembershipSummary } from '../rbac/directory';
import { Principal } from '../rbac/principal';
import { createMemoryDirectory } from '../rbac/memory-directory';
import type { WorkspaceRepositoryPort } from '../workspaces/runtime';
import { mintDeviceCode, normaliseUserCode, verifyDeviceCode } from './device-code';
import {
  cliPollMemorySize,
  exchangeDeviceCode,
  resetCliPollMemory,
  revokeCliToken,
  startDeviceAuthorization,
  switchCliWorkspace,
} from './handlers';
import { BoundedRecencyMap, FixedWindowLimiter } from '../http/rate-limit';
import { CLI_AUTH_LIMITS } from './rate-limit';
import { renderVerifyPage, submitVerifyPage } from './verify-page';
import { clearApplicationContext } from '../application-context';
import { installTestDomains } from '../application-context-fixtures';

const SECRET = 'a-session-secret-that-is-long-enough-for-tests';
const WORKSPACE_ID = '44444444-4444-4444-8444-444444444444';
const USER_ID = 'u-1';
const OTHER_WORKSPACE_ID = '55555555-5555-4555-8555-555555555555';
const FOREIGN_WORKSPACE_ID = '66666666-6666-4666-8666-666666666666';
const PRINCIPAL_ID = '77777777-7777-4777-8777-777777777777';

/** A browser-session principal for Ada in Acme: mint and verify, the only way to get claims. */
async function browserSessionPrincipal(): Promise<Principal> {
  const token = await mintSessionToken(newSessionClaims('ada@example.com', 'acme'), SECRET);
  const verified = await verifySessionToken(token, SECRET);
  if (!verified.ok) throw new Error(`the fixture could not verify its token: ${verified.reason}`);
  const built = Principal.fromSession(
    verified.claims,
    { id: WORKSPACE_ID, slug: 'acme' },
    'admin',
    { principalId: PRINCIPAL_ID, userId: USER_ID, label: 'Ada' },
  );
  if (!built.ok) throw new Error(`the fixture built no principal: ${built.because}`);
  return built.principal;
}
const NOW = Date.parse('2026-09-30T00:00:00.000Z');

interface Row {
  status: 'approved' | 'denied' | 'active' | 'revoked';
  workspaceId: string;
  userId: string;
  approvalExpiresAt: Date;
  tokenHash: string | null;
  expiresAt: Date | null;
}

/** The repository's contract, in memory: what `cli-sessions.ts` does in one SQL statement each. */
function memorySessions(): CliSessionRepository & { readonly rows: Map<string, Row> } {
  const rows = new Map<string, Row>();
  const active = (hash: string, now: Date) =>
    [...rows.values()].find(
      (row) =>
        row.tokenHash === hash &&
        row.status === 'active' &&
        row.expiresAt !== null &&
        row.expiresAt > now,
    );
  return {
    rows,
    recordApproval(input: RecordCliApprovalInput) {
      if (rows.has(input.userCode)) return Promise.resolve('code-taken');
      rows.set(input.userCode, {
        status: input.decision,
        workspaceId: input.workspaceId,
        userId: input.userId,
        approvalExpiresAt: input.approvalExpiresAt,
        tokenHash: null,
        expiresAt: null,
      });
      return Promise.resolve('recorded');
    },
    exchange(userCode, tokenHash, expiresAt, now = new Date()): Promise<CliTokenExchangeOutcome> {
      const row = rows.get(userCode);
      if (row === undefined) return Promise.resolve({ kind: 'pending' });
      if (row.status === 'denied') return Promise.resolve({ kind: 'denied' });
      if (row.status !== 'approved') return Promise.resolve({ kind: 'spent' });
      if (row.approvalExpiresAt <= now) return Promise.resolve({ kind: 'expired' });
      Object.assign(row, { status: 'active', tokenHash, expiresAt });
      return Promise.resolve({ kind: 'issued', workspaceId: row.workspaceId, userId: row.userId });
    },
    findActiveByHash() {
      return Promise.resolve(null);
    },
    revokeByHash(hash, now = new Date()) {
      const row = active(hash, now);
      if (row === undefined) return Promise.resolve(false);
      row.status = 'revoked';
      return Promise.resolve(true);
    },
    moveToWorkspace(hash, workspaceId, now = new Date()) {
      const row = active(hash, now);
      if (row === undefined) return Promise.resolve(false);
      row.workspaceId = workspaceId;
      return Promise.resolve(true);
    },
  };
}

const RECORD = {
  id: WORKSPACE_ID,
  slug: 'acme',
  name: 'Acme',
  publicSharingEnabled: false,
  archivedAt: null,
  createdAt: new Date(NOW - 1000),
  updatedAt: new Date(NOW - 1000),
};

function workspaceRepository(): WorkspaceRepositoryPort {
  const notUsed = (): never => {
    throw new Error('not used by these fixtures');
  };
  return {
    listForUser: notUsed,
    ownerPrincipalId: notUsed,
    get: notUsed,
    getForMember: (id, userId) =>
      Promise.resolve(
        id === WORKSPACE_ID && userId === USER_ID
          ? { ...RECORD, role: 'admin' }
          : id === OTHER_WORKSPACE_ID && userId === USER_ID
            ? { ...RECORD, id: OTHER_WORKSPACE_ID, slug: 'other', name: 'Other', role: 'viewer' }
            : null,
      ),
    create: notUsed,
    update: notUsed,
    archive: notUsed,
    restore: notUsed,
  };
}

function post(path: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`http://127.0.0.1:3000${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

function errorCode(body: unknown): unknown {
  return (body as { readonly error?: { readonly code?: unknown } }).error?.code;
}

let sessions: ReturnType<typeof memorySessions>;

beforeEach(() => {
  resetCliPollMemory();
  sessions = memorySessions();
  installTestDomains({
    cliAuth: { sessions, secret: SECRET },
    workspaces: { repository: workspaceRepository() },
  });
});

afterEach(() => {
  clearApplicationContext();
});

describe('with no application context installed', () => {
  it('answers 503 cli_auth_not_configured from the device route and the verify page', async () => {
    clearApplicationContext();
    const started = startDeviceAuthorization(post('/api/auth/cli-device', {}), NOW);
    expect(started.status).toBe(503);
    expect(errorCode(started.body)).toBe('cli_auth_not_configured');
    const page = await renderVerifyPage(new Request('http://localhost/api/auth/cli-verify'));
    expect(page.status).toBe(503);
  });
});

describe('the device code', () => {
  it('verifies only what this server signed, and only until it expires', () => {
    const code = mintDeviceCode('BCDFGHJK', 100, SECRET);
    expect(verifyDeviceCode(code, SECRET, 99)).toEqual({ ok: true, userCode: 'BCDFGHJK' });
    expect(verifyDeviceCode(code, SECRET, 100)).toEqual({ ok: false, reason: 'expired' });
    expect(verifyDeviceCode(code, 'another-secret-of-sufficient-length', 99).ok).toBe(false);
    expect(verifyDeviceCode(code.replace('BCDFGHJK', 'BCDFGHJL'), SECRET, 99).ok).toBe(false);
    expect(verifyDeviceCode('v1.BCDFGHJK.100', SECRET, 99).ok).toBe(false);
  });

  it('normalises a typed user code and refuses anything outside the alphabet', () => {
    expect(normaliseUserCode('bcdf-ghjk')).toBe('BCDFGHJK');
    expect(normaliseUserCode('BCDF GHJK')).toBe('BCDFGHJK');
    expect(normaliseUserCode('ABCD-EFGH')).toBeNull();
    expect(normaliseUserCode('<script>')).toBeNull();
  });
});

describe('POST /api/auth/cli-device → approval → POST /api/auth/cli-token', () => {
  async function startAndApprove(decision: 'approved' | 'denied', approvalMs = 60_000) {
    const start = DeviceAuthorizationResponseSchema.parse(
      startDeviceAuthorization(post('/api/auth/cli-device', {}), NOW).body,
    );
    const userCode = normaliseUserCode(start.userCode);
    if (userCode === null) throw new Error('the server issued an invalid user code');
    await sessions.recordApproval({
      workspaceId: WORKSPACE_ID,
      userId: USER_ID,
      userCode,
      decision,
      approvalExpiresAt: new Date(NOW + approvalMs),
    });
    return start;
  }

  it('is pending until approved, then issues a token once, stored only as a hash', async () => {
    const start = DeviceAuthorizationResponseSchema.parse(
      startDeviceAuthorization(post('/api/auth/cli-device', {}), NOW).body,
    );
    const pending = await exchangeDeviceCode(
      post('/api/auth/cli-token', { deviceCode: start.deviceCode }),
      NOW,
    );
    expect(pending.status).toBe(400);
    expect(errorCode(pending.body)).toBe('authorization_pending');

    const userCode = normaliseUserCode(start.userCode) ?? '';
    await sessions.recordApproval({
      workspaceId: WORKSPACE_ID,
      userId: USER_ID,
      userCode,
      decision: 'approved',
      approvalExpiresAt: new Date(NOW + 60_000),
    });
    const issued = await exchangeDeviceCode(
      post('/api/auth/cli-token', { deviceCode: start.deviceCode }),
      NOW + 10_000,
    );
    expect(issued.status).toBe(200);
    const body = CliTokenResponseSchema.parse(issued.body);
    expect(body.workspace.id).toBe(WORKSPACE_ID);
    expect(Date.parse(body.expiresAt)).toBe(NOW + 10_000 + 12 * 60 * 60 * 1000);
    const secret = parsePresentedCliToken(body.token)?.secret ?? '';
    const row = sessions.rows.get(userCode);
    expect(row?.tokenHash).toBe(await hashCliTokenSecret(secret));
    expect(JSON.stringify(row)).not.toContain(body.token);

    const again = await exchangeDeviceCode(
      post('/api/auth/cli-token', { deviceCode: start.deviceCode }),
      NOW + 20_000,
    );
    expect(errorCode(again.body)).toBe('invalid_grant');
  });

  it('answers access_denied when the person denied the code', async () => {
    const start = await startAndApprove('denied');
    const result = await exchangeDeviceCode(
      post('/api/auth/cli-token', { deviceCode: start.deviceCode }),
      NOW,
    );
    expect(errorCode(result.body)).toBe('access_denied');
  });

  it('answers expired_token for an expired approval and for an expired device code', async () => {
    const start = await startAndApprove('approved', 1_000);
    const lateApproval = await exchangeDeviceCode(
      post('/api/auth/cli-token', { deviceCode: start.deviceCode }),
      NOW + 5_000,
    );
    expect(errorCode(lateApproval.body)).toBe('expired_token');
    const lateCode = await exchangeDeviceCode(
      post('/api/auth/cli-token', { deviceCode: start.deviceCode }),
      NOW + 11 * 60 * 1000,
    );
    expect(errorCode(lateCode.body)).toBe('expired_token');
  });

  it('refuses a forged device code and a poll faster than the interval', async () => {
    const forged = await exchangeDeviceCode(
      post('/api/auth/cli-token', { deviceCode: mintDeviceCode('BCDFGHJK', 9e9, 'x'.repeat(40)) }),
      NOW,
    );
    expect(errorCode(forged.body)).toBe('invalid_grant');
    const start = DeviceAuthorizationResponseSchema.parse(
      startDeviceAuthorization(post('/api/auth/cli-device', {}), NOW).body,
    );
    await exchangeDeviceCode(post('/api/auth/cli-token', { deviceCode: start.deviceCode }), NOW);
    const tooSoon = await exchangeDeviceCode(
      post('/api/auth/cli-token', { deviceCode: start.deviceCode }),
      NOW + 1_000,
    );
    expect(errorCode(tooSoon.body)).toBe('slow_down');
  });

  it('revokes the presented token server-side on sign-out, once', async () => {
    const start = await startAndApprove('approved');
    const issued = CliTokenResponseSchema.parse(
      (
        await exchangeDeviceCode(
          post('/api/auth/cli-token', { deviceCode: start.deviceCode }),
          NOW + 10_000,
        )
      ).body,
    );
    const signOut = () =>
      revokeCliToken(
        new Request('http://127.0.0.1:3000/api/auth/cli-token', {
          method: 'DELETE',
          headers: { authorization: `Bearer ${issued.token}` },
        }),
        NOW + 20_000,
      );
    expect((await signOut()).status).toBe(204);
    const second = await signOut();
    expect(second.status).toBe(401);
    expect(errorCode(second.body)).toBe('unauthenticated');
  });
});

describe('POST /api/auth/cli-workspace', () => {
  const PRESENTED = `awu_live_${'A'.repeat(22)}_${'S'.repeat(43)}`;
  const tokenPrincipal = Principal.fromUserToken(WORKSPACE_ID, 'ada@example.com', 'admin', {
    principalId: PRINCIPAL_ID,
    userId: USER_ID,
    label: 'Ada',
  });
  const MEMBERSHIPS: readonly UserMembershipSummary[] = [
    {
      principalId: PRINCIPAL_ID,
      workspaceId: WORKSPACE_ID,
      workspaceSlug: 'acme',
      workspaceName: 'Acme',
      role: 'admin',
    },
    {
      principalId: '88888888-8888-4888-8888-888888888888',
      workspaceId: OTHER_WORKSPACE_ID,
      workspaceSlug: 'other',
      workspaceName: 'Other',
      role: 'viewer',
    },
  ];

  /** A directory whose only answer that matters here is the person's memberships. */
  function directoryWith(memberships: readonly UserMembershipSummary[]): DirectoryRoot {
    const base = createMemoryDirectory({ workspaces: [], users: [] });
    return {
      ...base,
      membershipsForUser: (userId: string) =>
        Promise.resolve(userId === USER_ID ? memberships : []),
    };
  }

  function withPrincipal(principal: Principal | null): void {
    installTestDomains({
      rbac: {
        directory: directoryWith(MEMBERSHIPS),
        identify: () => Promise.resolve(principal),
      },
    });
  }

  /** Record every `moveToWorkspace`, answering `answer`. */
  function spyMoves(answer: boolean): string[] {
    const moved: string[] = [];
    installTestDomains({
      cliAuth: {
        secret: SECRET,
        sessions: {
          ...sessions,
          moveToWorkspace: (_hash: string, workspaceId: string) => {
            moved.push(workspaceId);
            return Promise.resolve(answer);
          },
        },
      },
    });
    return moved;
  }

  const switchTo = (workspace: string) =>
    switchCliWorkspace(
      post('/api/auth/cli-workspace', { workspace }, { authorization: `Bearer ${PRESENTED}` }),
    );

  it('refuses any caller that is not a signed-in CLI token', async () => {
    installTestDomains({
      rbac: {
        directory: createMemoryDirectory({ workspaces: [], users: [] }),
        identify: () => Promise.resolve(null),
      },
    });
    const result = await switchCliWorkspace(post('/api/auth/cli-workspace', { workspace: 'acme' }));
    expect(result.status).toBe(401);
  });

  it('moves the token to another of the person’s workspaces, by id and by slug', async () => {
    withPrincipal(tokenPrincipal);
    for (const requested of [OTHER_WORKSPACE_ID, 'other']) {
      const moved = spyMoves(true);
      const result = await switchTo(requested);
      expect(result.status, requested).toBe(200);
      expect(
        (result.body as { readonly workspace: { readonly id: string } }).workspace.id,
        requested,
      ).toBe(OTHER_WORKSPACE_ID);
      expect(moved, requested).toEqual([OTHER_WORKSPACE_ID]);
    }
  });

  it('refuses a workspace the person is not a member of without touching the token', async () => {
    withPrincipal(tokenPrincipal);
    const moved = spyMoves(true);
    const result = await switchTo(FOREIGN_WORKSPACE_ID);
    expect(result.status).toBe(404);
    expect(errorCode(result.body)).toBe('workspace_not_available');
    expect(moved).toEqual([]);
  });

  it('answers 404 when the database refused the move (membership removed meanwhile)', async () => {
    withPrincipal(tokenPrincipal);
    const moved = spyMoves(false);
    const result = await switchTo('other');
    expect(result.status).toBe(404);
    expect(errorCode(result.body)).toBe('workspace_not_available');
    expect(moved).toEqual([OTHER_WORKSPACE_ID]);
  });

  it('refuses a browser session: only the token itself can be moved', async () => {
    withPrincipal(await browserSessionPrincipal());
    const moved = spyMoves(true);
    const result = await switchTo('other');
    expect(result.status).toBe(401);
    expect(moved).toEqual([]);
  });
});

describe('rate limits and the bounded slow_down memory (review round 1)', () => {
  const ENV_KEYS = ['AW_TRUSTED_PROXY_HOPS', 'SESSION_SECRET'] as const;
  let savedEnv: Record<(typeof ENV_KEYS)[number], string | undefined>;
  beforeEach(() => {
    savedEnv = { AW_TRUSTED_PROXY_HOPS: undefined, SESSION_SECRET: undefined };
    for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  });
  afterEach(() => {
    for (const key of ENV_KEYS) {
      const value = savedEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('refuses the start route with 429 and Retry-After once one client exceeds its limit', () => {
    process.env['AW_TRUSTED_PROXY_HOPS'] = '1';
    process.env['SESSION_SECRET'] = SECRET;
    const from = (address: string) =>
      post('/api/auth/cli-device', {}, { 'x-forwarded-for': address });
    for (let index = 0; index < CLI_AUTH_LIMITS.start; index += 1) {
      expect(startDeviceAuthorization(from('203.0.113.7'), NOW).status).toBe(200);
    }
    const refused = startDeviceAuthorization(from('203.0.113.7'), NOW);
    expect(refused.status).toBe(429);
    expect(errorCode(refused.body)).toBe('rate_limited');
    expect(Number(refused.headers?.['retry-after'])).toBeGreaterThan(0);
    // Another client is counted on its own, and the window passes.
    expect(startDeviceAuthorization(from('203.0.113.8'), NOW).status).toBe(200);
    expect(startDeviceAuthorization(from('203.0.113.7'), NOW + 60_000).status).toBe(200);
  });

  it('shares one wider bucket when no trusted proxy chain names the client', async () => {
    delete process.env['AW_TRUSTED_PROXY_HOPS'];
    for (let index = 0; index < CLI_AUTH_LIMITS.poll * 10; index += 1) {
      await exchangeDeviceCode(post('/api/auth/cli-token', { deviceCode: 'x' }), NOW);
    }
    const refused = await exchangeDeviceCode(post('/api/auth/cli-token', { deviceCode: 'x' }), NOW);
    expect(refused.status).toBe(429);
    expect(errorCode(refused.body)).toBe('rate_limited');
  });

  it('refuses the approval POST with 429 once the limit is spent', async () => {
    delete process.env['AW_TRUSTED_PROXY_HOPS'];
    installTestDomains({
      rbac: {
        directory: createMemoryDirectory({ workspaces: [], users: [] }),
        identify: () => Promise.resolve(null),
      },
    });
    const submit = () =>
      submitVerifyPage(
        new Request('http://127.0.0.1:3000/api/auth/cli-verify', {
          method: 'POST',
          headers: {
            origin: 'http://127.0.0.1:3000',
            'content-type': 'application/x-www-form-urlencoded',
          },
          body: 'userCode=BCDF-GHJK&decision=deny',
        }),
        NOW,
      );
    for (let index = 0; index < CLI_AUTH_LIMITS.approve * 10; index += 1) await submit();
    const refused = await submit();
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get('retry-after'))).toBeGreaterThan(0);
  });

  it('keeps the slow_down memory at its cap however many device codes poll', async () => {
    // A trusted chain, one client per poll, so the per-client limit does not stop the flood first.
    process.env['AW_TRUSTED_PROXY_HOPS'] = '1';
    process.env['SESSION_SECRET'] = SECRET;
    const codes = 10_050;
    for (let index = 0; index < codes; index += 1) {
      const userCode = mintUserCode(index);
      await exchangeDeviceCode(
        post(
          '/api/auth/cli-token',
          { deviceCode: mintDeviceCode(userCode, NOW / 1000 + 600, SECRET) },
          {
            'x-forwarded-for': `10.${String(index >> 16)}.${String((index >> 8) & 255)}.${String(index & 255)}`,
          },
        ),
        NOW,
      );
    }
    expect(cliPollMemorySize()).toBe(10_000);
  }, 60_000);

  it('evicts the least recently written key in O(1) at capacity', () => {
    const memory = new BoundedRecencyMap<number>(3);
    for (const key of ['a', 'b', 'c', 'd']) memory.set(key, 1);
    expect(memory.size).toBe(3);
    expect(memory.get('a')).toBeUndefined();
    memory.set('b', 2);
    memory.set('e', 1);
    // `b` was rewritten, so `c` was the stalest and went first.
    expect(memory.get('b')).toBe(2);
    expect(memory.get('c')).toBeUndefined();
  });

  it('counts per key per window and forgets the stalest key at capacity', () => {
    const limiter = new FixedWindowLimiter({ limit: 2, windowMs: 1_000, capacity: 2 });
    expect(limiter.admit('a', 0).admitted).toBe(true);
    expect(limiter.admit('a', 1).admitted).toBe(true);
    expect(limiter.admit('a', 2)).toEqual({ admitted: false, retryAfterSeconds: 1 });
    expect(limiter.admit('a', 1_000).admitted).toBe(true);
    limiter.admit('b', 1_000);
    limiter.admit('c', 1_000);
    // `a` was evicted, so it starts a fresh window.
    expect(limiter.admit('a', 1_001).admitted).toBe(true);
    expect(limiter.admit('a', 1_002).admitted).toBe(true);
  });
});

/** The `index`-th user code of the device-code alphabet, so every flood entry is distinct. */
function mintUserCode(index: number): string {
  const alphabet = 'BCDFGHJKLMNPQRSTVWXZ';
  let remaining = index;
  let code = '';
  for (let position = 0; position < 8; position += 1) {
    code += alphabet[remaining % alphabet.length] ?? 'B';
    remaining = Math.floor(remaining / alphabet.length);
  }
  return code;
}

describe('/api/auth/cli-verify', () => {
  const cliPrincipal = Principal.fromUserToken(WORKSPACE_ID, 'ada@example.com', 'admin', {
    principalId: '77777777-7777-4777-8777-777777777777',
    userId: USER_ID,
    label: 'Ada',
  });

  it('will not let a bearer credential approve a sign-in — only a browser session', async () => {
    installTestDomains({
      rbac: {
        directory: createMemoryDirectory({ workspaces: [], users: [] }),
        identify: () => Promise.resolve(cliPrincipal),
      },
    });
    const page = await renderVerifyPage(
      new Request('http://127.0.0.1:3000/api/auth/cli-verify?code=BCDF-GHJK'),
    );
    expect(page.status).toBe(401);
    const submitted = await submitVerifyPage(
      new Request('http://127.0.0.1:3000/api/auth/cli-verify', {
        method: 'POST',
        headers: {
          origin: 'http://127.0.0.1:3000',
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: 'userCode=BCDF-GHJK&decision=approve',
      }),
    );
    expect(submitted.status).toBe(401);
    expect(sessions.rows.size).toBe(0);
  });

  it('refuses a cross-origin approval before reading anything', async () => {
    const submitted = await submitVerifyPage(
      new Request('http://127.0.0.1:3000/api/auth/cli-verify', {
        method: 'POST',
        headers: {
          origin: 'https://evil.example',
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: 'userCode=BCDF-GHJK&decision=approve',
      }),
    );
    expect(submitted.status).toBe(403);
    expect(submitted.headers.get('x-frame-options')).toBe('DENY');
  });

  describe('with a signed-in browser session', () => {
    beforeEach(async () => {
      const session = await browserSessionPrincipal();
      installTestDomains({
        rbac: {
          directory: createMemoryDirectory({ workspaces: [], users: [] }),
          identify: () => Promise.resolve(session),
        },
      });
    });
    const submit = (body: string) =>
      submitVerifyPage(
        new Request('http://127.0.0.1:3000/api/auth/cli-verify', {
          method: 'POST',
          headers: {
            origin: 'http://127.0.0.1:3000',
            'content-type': 'application/x-www-form-urlencoded',
          },
          body,
        }),
        NOW,
      );

    it('renders a pre-filled code with a required confirmation and no inline style', async () => {
      const page = await renderVerifyPage(
        new Request('http://127.0.0.1:3000/api/auth/cli-verify?code=bcdf-ghjk'),
      );
      expect(page.status).toBe(200);
      const html = await page.text();
      expect(html).toContain('value="BCDF-GHJK"');
      expect(html).toContain('<input type="checkbox" name="confirm" value="yes" required>');
      expect(html).not.toContain('style=');
    });

    it('will not approve a code the person has not confirmed (RFC 8628 §5.4)', async () => {
      const unconfirmed = await submit('userCode=BCDF-GHJK&decision=approve');
      expect(unconfirmed.status).toBe(400);
      expect(sessions.rows.size).toBe(0);

      const confirmed = await submit('userCode=BCDF-GHJK&decision=approve&confirm=yes');
      expect(confirmed.status).toBe(200);
      expect(sessions.rows.get('BCDFGHJK')?.status).toBe('approved');
    });

    it('lets a person deny without confirming', async () => {
      const denied = await submit('userCode=BCDF-GHJK&decision=deny');
      expect(denied.status).toBe(200);
      expect(sessions.rows.get('BCDFGHJK')?.status).toBe('denied');
    });
  });
});
