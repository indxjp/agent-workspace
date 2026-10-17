import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { count, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { agents } from '../schema/agents.js';
import { runEvents } from '../schema/run-events.js';
import { runUsageRecords } from '../schema/run-usage-records.js';
import { runs } from '../schema/runs.js';
import { sessionMessages } from '../schema/session-messages.js';
import { sessionTranscripts } from '../schema/session-transcripts.js';
import { sessions } from '../schema/sessions.js';
import { shareRunCharges } from '../schema/share-run-charges.js';
import { createDatabaseDirectoryRoot } from './directory.js';
import {
  installRf001LegacyFixture,
  RF001_DEFERRED_FIXTURES,
  type Rf001LegacyFixture,
} from './refactoring-fixtures.js';
import { createIsolatedTestDatabase, type IsolatedTestDatabase } from './testing.js';
import { postgresViolations } from './violations.js';

const hasDatabase = Boolean(process.env['TEST_DATABASE_URL']?.trim());
const repositoryRoot = fileURLToPath(new URL('../../../../../', import.meta.url));

const RETAINED_HISTORY_COUNTS = {
  sessions: 1,
  runs: 1,
  events: 1,
  transcripts: 1,
  messages: 1,
  usage: 1,
  shareRunCharges: 1,
} as const;

const CASCADED_HISTORY_COUNTS = {
  sessions: 0,
  runs: 0,
  events: 0,
  transcripts: 0,
  messages: 0,
  usage: 0,
  shareRunCharges: 0,
} as const;

async function historyCounts(isolated: IsolatedTestDatabase, fixture: Rf001LegacyFixture) {
  const [
    sessionCount,
    runCount,
    eventCount,
    transcriptCount,
    messageCount,
    usageCount,
    shareRunChargeCount,
  ] = await Promise.all([
    isolated.db.select({ total: count() }).from(sessions).where(eq(sessions.id, fixture.sessionId)),
    isolated.db.select({ total: count() }).from(runs).where(eq(runs.id, fixture.runId)),
    isolated.db
      .select({ total: count() })
      .from(runEvents)
      .where(eq(runEvents.runId, fixture.runId)),
    isolated.db
      .select({ total: count() })
      .from(sessionTranscripts)
      .where(eq(sessionTranscripts.sessionId, fixture.sessionId)),
    isolated.db
      .select({ total: count() })
      .from(sessionMessages)
      .where(eq(sessionMessages.sessionId, fixture.sessionId)),
    isolated.db
      .select({ total: count() })
      .from(runUsageRecords)
      .where(eq(runUsageRecords.runId, fixture.runId)),
    isolated.db
      .select({ total: count() })
      .from(shareRunCharges)
      .where(eq(shareRunCharges.runId, fixture.runId)),
  ]);
  return {
    sessions: sessionCount[0]?.total ?? 0,
    runs: runCount[0]?.total ?? 0,
    events: eventCount[0]?.total ?? 0,
    transcripts: transcriptCount[0]?.total ?? 0,
    messages: messageCount[0]?.total ?? 0,
    usage: usageCount[0]?.total ?? 0,
    shareRunCharges: shareRunChargeCount[0]?.total ?? 0,
  };
}

describe('RF-001 fixture inventory', () => {
  it('reserves only representations whose tables belong to later units', () => {
    expect(RF001_DEFERRED_FIXTURES).toEqual({
      activeRuntimeAllocation: {
        prerequisite: 'RF-302',
        reason: 'runtime_allocations does not exist before its owning additive migration',
      },
      partialStorageOperation: {
        prerequisite: 'RF-304',
        reason: 'storage_operations does not exist before its owning additive migration',
      },
    });

    const trackedSchemaFiles = execFileSync(
      'git',
      ['ls-files', '-z', '--', 'packages/core/src/db/schema/*.ts'],
      { cwd: repositoryRoot, encoding: 'utf8' },
    )
      .split('\0')
      .filter((file) => file !== '')
      .sort();
    expect(trackedSchemaFiles.length).toBeGreaterThan(0);
    const trackedSchemaSource = trackedSchemaFiles
      .map((file) => readFileSync(path.join(repositoryRoot, file), 'utf8'))
      .join('\n');
    expect(trackedSchemaSource).not.toContain('runtime_allocations');
    expect(trackedSchemaSource).not.toContain('storage_operations');
  });
});

describe.skipIf(!hasDatabase)('RF-001 PostgreSQL characterization', () => {
  let isolated: IsolatedTestDatabase;
  let fixture: Rf001LegacyFixture;

  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase('aw_rf001_characterization');
  }, 180_000);

  beforeEach(async () => {
    fixture = await installRf001LegacyFixture(isolated.db);
  });

  afterAll(async () => isolated.close());

  it('RF-201/RF-202 installs the complete retained-history fixture for each characterization', async () => {
    expect(await historyCounts(isolated, fixture)).toEqual(RETAINED_HISTORY_COUNTS);
  });

  it('RF-201 deleting an Agent cascades all retained execution history today', async () => {
    const before = await historyCounts(isolated, fixture);
    let deletionError: unknown;

    try {
      await isolated.db.delete(agents).where(eq(agents.id, fixture.usedAgentId));
    } catch (error) {
      deletionError = error;
    }

    expect(deletionError).toBeUndefined();
    expect([...postgresViolations(deletionError)]).toEqual([]);
    expect({ before, after: await historyCounts(isolated, fixture) }).toEqual({
      before: RETAINED_HISTORY_COUNTS,
      after: CASCADED_HISTORY_COUNTS,
    });
  });

  it.fails(
    'RF-201 refuses Agent deletion and preserves all execution history (expected failure until RF-201)',
    async () => {
      const before = await historyCounts(isolated, fixture);
      let deletionError: unknown;

      try {
        await isolated.db.delete(agents).where(eq(agents.id, fixture.usedAgentId));
      } catch (error) {
        deletionError = error;
      }

      const violations = [...postgresViolations(deletionError)];
      expect({
        before,
        after: await historyCounts(isolated, fixture),
        hasExpectedViolation: violations.some(
          (violation) =>
            violation.code === '23503' && violation.constraint === 'sessions_agent_workspace_fk',
        ),
      }).toEqual({
        before: RETAINED_HISTORY_COUNTS,
        after: RETAINED_HISTORY_COUNTS,
        hasExpectedViolation: true,
      });
    },
  );

  it('RF-202 membership removal surfaces a raw dependency violation today', async () => {
    const directory = createDatabaseDirectoryRoot(isolated.db).forWorkspace(fixture.workspaceId);
    let outcome: Awaited<ReturnType<typeof directory.deleteMembership>> | undefined;
    let deletionError: unknown;

    try {
      outcome = await directory.deleteMembership(fixture.departingMembershipId);
    } catch (error) {
      deletionError = error;
    }

    const violations = [...postgresViolations(deletionError)];
    expect(outcome).toBeUndefined();
    expect(
      violations.some(
        (violation) =>
          violation.code === '23503' && violation.constraint === 'sessions_member_workspace_fk',
      ),
    ).toBe(true);
    expect(await historyCounts(isolated, fixture)).toEqual(RETAINED_HISTORY_COUNTS);
  });

  it.fails(
    'RF-202 reports membership_in_use with dependencies instead of a raw constraint failure (expected failure until RF-202)',
    async () => {
      const directory = createDatabaseDirectoryRoot(isolated.db).forWorkspace(fixture.workspaceId);
      let outcome: Awaited<ReturnType<typeof directory.deleteMembership>> | undefined;
      let deletionError: unknown;

      try {
        outcome = await directory.deleteMembership(fixture.departingMembershipId);
      } catch (error) {
        deletionError = error;
      }

      const violations = [...postgresViolations(deletionError)];
      expect({
        outcome,
        history: await historyCounts(isolated, fixture),
        violations,
      }).toEqual({
        outcome: {
          kind: 'membership-in-use',
          id: fixture.departingMembershipId,
          dependencies: {
            sessions: 1,
          },
        },
        history: RETAINED_HISTORY_COUNTS,
        violations: [],
      });
    },
  );
});
