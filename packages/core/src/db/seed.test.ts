/**
 * The acceptance test for this task: against a real PostgreSQL 17, `db:migrate` then `db:seed`
 * must leave **exactly one** agent named `General`, and that agent must be an ordinary row
 * (spec §19.5 rule 3).
 *
 * **It needs a database, and it says so when it does not have one.** `TEST_DATABASE_URL` names
 * a throwaway PostgreSQL that this file will migrate, truncate and write to — never a
 * development database. When the variable is absent the suite is SKIPPED and a warning is
 * printed naming what was not verified. Skipped is not passed: a green run without that
 * variable has not exercised any of this, which is why the warning exists — it is there for a
 * developer running `pnpm test` on a machine with no container.
 *
 * **CI is not that machine.** W1-INF-02 wired a `postgres:17-alpine` service and a job-level
 * `TEST_DATABASE_URL` into `.github/workflows/ci.yml`, and that workflow's "No test in the run
 * was skipped" step reads vitest's own JSON report and fails the build if any test did not
 * execute — so these suites cannot be skipped in CI without turning the build red.
 *
 * An earlier revision of this header said the shipping pull request declares a CI gap for these
 * suites instead. That sentence was written by W1-DB-01 (commit 1456fde) and was true then:
 * `git log -S "postgres:17-alpine" -- .github/workflows/ci.yml` shows the service arrived later,
 * in W1-INF-02 (commit bfd2d1e), which is not an ancestor of 1456fde. It was left in place
 * unedited while this file grew, by which time it had become a false statement about the pull
 * request shipping it. It is withdrawn.
 *
 * The environment-only assertions below (`readSeedOptions`) run everywhere, database or not.
 *
 * Every database suite here shares and truncates the one database, so they stay in this single
 * file and run in order; their cases live in the `seed.*.test-support.ts` modules.
 */
import { getTableConfig } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { readSeedOptions } from './seed.js';
import { registerBootstrapCases, truncateSeedTables } from './seed.bootstrap.test-support.js';
import {
  createTenant,
  registerCrossTenantCases,
  type Tenant,
} from './seed.cross-tenant.test-support.js';
import { useSeedDatabase } from './seed.fixture.test-support.js';
import {
  createResourceTenant,
  registerResourceIsolationCases,
  type ResourceTenant,
} from './seed.resource-isolation.test-support.js';
import {
  createShapesOwner,
  registerResourceShapeCases,
  type ShapesOwner,
} from './seed.resource-shapes.test-support.js';
import { agents } from './schema/agents.js';
import { memberships } from './schema/memberships.js';
import { modelConnections } from './schema/model-connections.js';
import { runs } from './schema/runs.js';
import { sessions } from './schema/sessions.js';
import { users } from './schema/users.js';
import { workspaces } from './schema/workspaces.js';

const rawUrl = process.env['TEST_DATABASE_URL'];
const hasDatabase = rawUrl !== undefined && rawUrl.trim() !== '';

if (!hasDatabase) {
  console.warn(
    '[seed.test.ts] SKIPPED — TEST_DATABASE_URL is not set, so the migration and the ' +
      '"exactly one General agent" assertion did NOT run. This suite is the acceptance test ' +
      'for W1-DB-01; a green result without it verifies nothing about the database.',
  );
}

describe('readSeedOptions (no database required)', () => {
  it('refuses to invent an administrator identity', () => {
    expect(() => readSeedOptions({})).toThrow(/BOOTSTRAP_ADMIN is not set/u);
    expect(() => readSeedOptions({ BOOTSTRAP_ADMIN: '   ' })).toThrow(
      /BOOTSTRAP_ADMIN is not set/u,
    );
  });

  it.each(['admin', 'admin@', '@example.com', 'a b@example.com', 'admin@example'])(
    'rejects %s as an administrator address',
    (value) => {
      expect(() => readSeedOptions({ BOOTSTRAP_ADMIN: value })).toThrow(/not a usable email/u);
    },
  );

  it('lower-cases the address, because the users table requires it', () => {
    expect(readSeedOptions({ BOOTSTRAP_ADMIN: ' Admin@Example.COM ' }).adminEmail).toBe(
      'admin@example.com',
    );
  });

  it('rejects a workspace slug that is not URL-safe', () => {
    expect(() =>
      readSeedOptions({ BOOTSTRAP_ADMIN: 'a@b.c', WORKSPACE_SLUG: 'Not A Slug' }),
    ).toThrow(/not a usable slug/u);
  });

  it('defaults only the values that identify nobody', () => {
    const options = readSeedOptions({ BOOTSTRAP_ADMIN: 'a@b.co' });
    expect(options.workspaceSlug).toBe('default');
    expect(options.adminEmail).toBe('a@b.co');
  });
});

describe('agents table shape', () => {
  it('has one column that marks an agent as built in, and it is nullable (§19.5 rule 3, ADR-0108 B-D1)', () => {
    const columns = getTableConfig(agents).columns.map((column) => column.name);
    expect(columns).toEqual([
      'id',
      'workspace_id',
      'name',
      'instructions',
      'model_connection_id',
      'model',
      // Added by W3-CP-06, outside this task's `Owns` cell — declared on its PR. §17 Step 5 /
      // §14.9: a reference to `runtime_profiles`, not a flag, so it does not touch this test's
      // actual point (there is still no column that could mark an agent as built in).
      'runtime_profile_id',
      'permissions',
      // Added by SDK-02-234 (S-13): a nullable, replaceable policy, not a flag — NULL means
      // "compile from permissions and the assigned resources" (today's behaviour for every row
      // this test seeds), so this test's point survives unchanged.
      'policy',
      // Added by W9-AUTH-117 (issue #117): not a flag either — a tenant-paired reference to
      // whoever created the row, so this test's point survives unchanged.
      'created_by',
      'owner_principal_id',
      // Added by #1848: the one built-in marker. NULL for every ordinary row, including General,
      // which this file's seed still creates as an ordinary, editable and deletable agent.
      'builtin_key',
      // Added by PR #403's review (issue #393): when first-run setup last configured the agent, a
      // composer preference. Not a built-in flag: the agent stays an ordinary, editable and
      // deletable row, and General is not marked by it.
      'setup_configured_at',
      // Added by issue #613: the version the row was last written from. Not a flag either.
      'materialised_version_id',
      // Added by #1851: lineage of an agent made by an agent, and when it was archived. Both
      // null for every ordinary row, and neither marks an agent as built in.
      'created_by_agent_id',
      'created_by_agent_version',
      'created_by_run_id',
      'archived_at',
      'created_at',
      'updated_at',
    ]);
  });
});

describe.skipIf(!hasDatabase)('seed against a real PostgreSQL', () => {
  const database = useSeedDatabase(rawUrl);

  beforeAll(async () => {
    // A clean slate that does not depend on the migration having just run: this file owns the
    // database named by TEST_DATABASE_URL.
    await truncateSeedTables(database());
  });

  registerBootstrapCases(database);
});

/**
 * The §25 cross-tenant integrity suite.
 *
 * Every case below is an INSERT or DELETE that a real PostgreSQL either accepts or rejects.
 * Three of them are the exact statements a review of this schema demonstrated the database used
 * to accept: a session in one workspace naming an agent in another, a run carrying a
 * workspace_id different from its session's, and a session owned by a user holding no membership
 * in that workspace. They are here so that a change reopening any of those holes fails a test
 * rather than shipping.
 *
 * Rejections are matched by constraint NAME, not by message text, so a test cannot pass because
 * the statement failed for some unrelated reason such as a typo in its own SQL. Every rejection
 * is paired with the corresponding statement that must still be ACCEPTED — a constraint that
 * rejects everything is not isolation, it is an outage.
 *
 * This suite owns its own connection and truncates before each case, because it deliberately
 * creates a second workspace and the suite above counts rows globally.
 */
describe.skipIf(!hasDatabase)('§25 cross-tenant referential integrity', () => {
  const database = useSeedDatabase(rawUrl);
  let a: Tenant;
  let b: Tenant;

  beforeEach(async () => {
    const db = database();
    await db.execute(
      sql`truncate table ${runs}, ${sessions}, ${agents}, ${modelConnections}, ${memberships}, ${users}, ${workspaces} restart identity cascade`,
    );
    a = await createTenant(db, 'tenant-a', 'a@example.com');
    b = await createTenant(db, 'tenant-b', 'b@example.com');
  });

  registerCrossTenantCases(() => ({ db: database(), a, b }));
});

/**
 * The same §25 proof as the suite above, for the tables W2-DB-01 adds, plus the shape
 * constraints those tables carry.
 *
 * Every case is one statement PostgreSQL either accepts or rejects, and every rejection is
 * matched by constraint NAME rather than by message text — a test that passes because the
 * statement failed for some other reason is a test that proves nothing. Every rejection is
 * paired with the statement that must still be ACCEPTED, because a constraint that rejects
 * everything is not isolation, it is an outage.
 */
describe.skipIf(!hasDatabase)('§25 tenant isolation over the Wave 2 resource tables', () => {
  const database = useSeedDatabase(rawUrl);
  let a: ResourceTenant;
  let b: ResourceTenant;

  beforeEach(async () => {
    const db = database();
    // Truncating `workspaces` cascades into every table that references it, which is every
    // table this task added.
    await db.execute(sql`truncate table ${workspaces}, ${users} restart identity cascade`);
    a = await createResourceTenant(db, 'res-a', 'res-a@example.com');
    b = await createResourceTenant(db, 'res-b', 'res-b@example.com');
  });

  registerResourceIsolationCases(() => ({ db: database(), a, b }));
});

/**
 * The shape constraints the Wave 2 resource tables carry, each proved by one rejected statement
 * and one accepted statement.
 *
 * The `secrets` cases are the ones this task's brief asks for by name: the table has to make
 * storing a plaintext secret awkward. What follows is the measurement of "awkward", and it is
 * narrower than an earlier revision of this comment claimed. What is measured is that a row
 * missing an envelope part, or carrying one at the wrong size, is refused by constraint name.
 * It is NOT measured — because it is not true — that a caller who never ran AES-256-GCM is
 * refused: `goodEnvelope` in `seed.resource-shapes.test-support.ts` is exactly such a caller. It
 * fabricates every companion with `Buffer.alloc` and sets `ciphertext` to the literal
 * `'not-really-encrypted'`, and the assertions here require PostgreSQL to ACCEPT it. That row is
 * this suite's own counterexample to the stronger claim, and it is left in place deliberately:
 * it is what the constraints actually permit. Proving a stored value is genuinely encrypted is
 * W2-CP-02's acceptance.
 */
describe.skipIf(!hasDatabase)('Wave 2 resource tables — shape constraints', () => {
  const database = useSeedDatabase(rawUrl);
  let owner: ShapesOwner;

  beforeEach(async () => {
    const db = database();
    await db.execute(sql`truncate table ${workspaces}, ${users} restart identity cascade`);
    owner = await createShapesOwner(db);
  });

  registerResourceShapeCases(() => ({ db: database(), ...owner }));
});
