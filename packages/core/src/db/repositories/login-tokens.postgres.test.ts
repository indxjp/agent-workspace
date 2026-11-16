import crypto from 'node:crypto';

import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loginTokens } from '../schema/login-tokens.js';
import { memberships } from '../schema/memberships.js';
import { users } from '../schema/users.js';
import { workspaces } from '../schema/workspaces.js';
import { createDatabaseLoginTokenRepository } from './login-tokens.js';
import { createIsolatedTestDatabase, type IsolatedTestDatabase } from './testing.js';

const hasDatabase = Boolean(process.env['TEST_DATABASE_URL']?.trim());

const hex = () => crypto.randomBytes(32).toString('hex');
const T0 = new Date('2026-11-16T10:00:00.000Z');
const later = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);

/** The SQLSTATE of a failed statement, wherever the driver wrapper put it. */
function sqlState(error: unknown): string | undefined {
  for (let current = error; current instanceof Error; current = current.cause) {
    const code: unknown = Reflect.get(current, 'code');
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/u.test(code)) return code;
  }
  return undefined;
}

const CHECK_VIOLATION = '23514';

describe.skipIf(!hasDatabase)('migration 0106: the guest role and login_tokens', () => {
  let isolated: IsolatedTestDatabase;
  const workspaceId = crypto.randomUUID();
  const userId = crypto.randomUUID();

  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase('aw_login_tokens');
    await isolated.db
      .insert(workspaces)
      .values({ id: workspaceId, slug: workspaceId, name: 'Demo' });
    await isolated.db
      .insert(users)
      .values({ id: userId, email: `${userId}@example.com`, name: 'Guest' });
  });
  afterAll(async () => {
    await isolated.close();
  });

  const row = (overrides: Partial<typeof loginTokens.$inferInsert> = {}) => ({
    id: crypto.randomUUID(),
    tokenHash: hex(),
    emailHash: hex(),
    createdAt: T0,
    expiresAt: later(15),
    ...overrides,
  });
  const refused = async (statement: Promise<unknown>) => {
    const error = await statement.then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error, 'the statement should have been refused').toBeDefined();
    expect(sqlState(error)).toBe(CHECK_VIOLATION);
  };

  describe('login_tokens', () => {
    it('accepts a valid row', async () => {
      await isolated.db.insert(loginTokens).values(row());
    });

    it('accepts a used row stamped at or after its creation', async () => {
      await isolated.db.insert(loginTokens).values(row({ usedAt: T0 }));
    });

    it('refuses a token hash that is not 64 lower-case hex characters', async () => {
      await refused(isolated.db.insert(loginTokens).values(row({ tokenHash: 'not-hex' })));
      await refused(
        isolated.db.insert(loginTokens).values(row({ tokenHash: hex().toUpperCase() })),
      );
    });

    it('refuses an email hash that is not 64 lower-case hex characters', async () => {
      await refused(isolated.db.insert(loginTokens).values(row({ emailHash: 'a@example.com' })));
    });

    it('refuses a link that expires at or before its creation', async () => {
      await refused(isolated.db.insert(loginTokens).values(row({ expiresAt: T0 })));
      await refused(isolated.db.insert(loginTokens).values(row({ expiresAt: later(-1) })));
    });

    it('refuses a link used before it was created', async () => {
      await refused(isolated.db.insert(loginTokens).values(row({ usedAt: later(-1) })));
    });

    it('refuses a second row with the same token hash', async () => {
      const shared = hex();
      await isolated.db.insert(loginTokens).values(row({ tokenHash: shared }));
      const error = await isolated.db
        .insert(loginTokens)
        .values(row({ tokenHash: shared }))
        .then(
          () => undefined,
          (caught: unknown) => caught,
        );
      expect(sqlState(error)).toBe('23505');
    });

    it('is consumed once by the repository, against the real table', async () => {
      const repository = createDatabaseLoginTokenRepository(isolated.db);
      const record = {
        id: crypto.randomUUID(),
        tokenHash: hex(),
        emailHash: hex(),
        createdAt: T0,
        expiresAt: later(15),
      };
      await repository.reserve(record, { since: later(-15), limit: 3 });
      const input = { tokenHash: record.tokenHash, emailHash: record.emailHash, now: later(1) };
      await expect(repository.consume(input)).resolves.toBe(true);
      await expect(repository.consume(input)).resolves.toBe(false);
    });

    it('stores at most the limit for one address under concurrent reserves', async () => {
      const repository = createDatabaseLoginTokenRepository(isolated.db);
      const emailHash = hex();
      const limit = 3;
      // Each call is its own connection and its own transaction, as requests from different
      // addresses of one client population would be.
      const outcomes = await Promise.all(
        Array.from({ length: 12 }, () =>
          repository.reserve(
            {
              id: crypto.randomUUID(),
              tokenHash: hex(),
              emailHash,
              createdAt: T0,
              expiresAt: later(15),
            },
            { since: later(-15), limit },
          ),
        ),
      );
      expect(outcomes.filter(Boolean)).toHaveLength(limit);
      const rows = await isolated.db
        .select()
        .from(loginTokens)
        .where(eq(loginTokens.emailHash, emailHash));
      expect(rows).toHaveLength(limit);
    });

    it('does not let one address use up another one', async () => {
      const repository = createDatabaseLoginTokenRepository(isolated.db);
      const window = { since: later(-15), limit: 1 };
      const make = (emailHash: string) => ({
        id: crypto.randomUUID(),
        tokenHash: hex(),
        emailHash,
        createdAt: T0,
        expiresAt: later(15),
      });
      await expect(repository.reserve(make(hex()), window)).resolves.toBe(true);
      await expect(repository.reserve(make(hex()), window)).resolves.toBe(true);
    });

    it('frees a slot when a reservation is released', async () => {
      const repository = createDatabaseLoginTokenRepository(isolated.db);
      const emailHash = hex();
      const window = { since: later(-15), limit: 1 };
      const first = {
        id: crypto.randomUUID(),
        tokenHash: hex(),
        emailHash,
        createdAt: T0,
        expiresAt: later(15),
      };
      await repository.reserve(first, window);
      await expect(
        repository.reserve({ ...first, id: crypto.randomUUID(), tokenHash: hex() }, window),
      ).resolves.toBe(false);
      await repository.release(first.id);
      await expect(
        repository.reserve({ ...first, id: crypto.randomUUID(), tokenHash: hex() }, window),
      ).resolves.toBe(true);
    });
  });

  describe('the role checks', () => {
    it('lets memberships hold guest', async () => {
      await isolated.db.insert(memberships).values({ workspaceId, userId, role: 'guest' });
      const rows = await isolated.db.execute<{ role: string }>(
        sql`select role from memberships where workspace_id = ${workspaceId} and user_id = ${userId}`,
      );
      expect(rows.rows.map((r) => r.role)).toEqual(['guest']);
    });

    it('still refuses a role outside the five on memberships', async () => {
      await refused(
        isolated.db.execute(
          sql`insert into memberships (workspace_id, user_id, role) values (${workspaceId}, ${crypto.randomUUID()}, 'root')`,
        ),
      );
    });

    const apiKey = (role: string) =>
      sql`insert into api_keys (workspace_id, name, role, key_prefix, key_hash)
          values (${workspaceId}, ${crypto.randomUUID()}, ${role}, 'ak_live_', ${hex()})`;

    it('lets an API key carry a conferrable role but refuses guest', async () => {
      await isolated.db.execute(apiKey('viewer'));
      await refused(isolated.db.execute(apiKey('guest')));
    });

    // The invitations table checks expires_at against its created_at, which defaults to now(), so
    // this expiry is relative to the real clock, not T0.
    const invitation = (role: string) =>
      sql`insert into invitations (workspace_id, email, role, token_hash, expires_at)
          values (${workspaceId}, ${`${crypto.randomUUID()}@example.com`}, ${role}, ${hex()}, ${new Date(Date.now() + 60 * 60_000)})`;

    it('lets an invitation carry a conferrable role but refuses guest', async () => {
      await isolated.db.execute(invitation('viewer'));
      await refused(isolated.db.execute(invitation('guest')));
    });
  });
});
