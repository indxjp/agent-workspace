/**
 * The run store conformance suite — **one suite, two implementations**.
 *
 * Written against `RunStore` rather than against either implementation, and exported as
 * {@link describeRunStoreConformance} so that both are held to the same assertions. It runs
 * against:
 *
 *   1. `new InMemoryRunStore()` — records in a `Map`, always (`store.test.ts`);
 *   2. `createRepositoryRunStore()` over `packages/core/src/db/repositories/runs.ts` and a **real
 *      PostgreSQL**, whenever `TEST_DATABASE_URL` names one (`store.postgres.test.ts`).
 *
 * ## Why the fixture mints the run input
 *
 * The in-memory store accepts any workspace, agent and session id. PostgreSQL does not: `runs`
 * references `sessions (id, workspace_id)`, `sessions` references `agents` and `memberships`, and
 * each of those references `workspaces`. So the database fixture creates that whole chain and
 * hands back a `CreateRunInput` whose ids really exist, and the same assertions then run against
 * both. Every fixture uses fresh ids, so nothing needs truncating and nothing collides with the
 * other suites sharing the server.
 *
 * The PostgreSQL-specific cases additionally construct a second store over the same database to
 * prove that events written by the first instance replay after a process-level composition reset.
 *
 * The topics live in `store.conformance-records.ts`, `-streams.ts` and `-properties.ts`.
 */
import { describe } from 'vitest';

import { describeProperties } from './store.conformance-properties.test-support';
import { describeRecords } from './store.conformance-records.test-support';
import { describeStreams } from './store.conformance-streams.test-support';
import { startRunWith, type MakeRunStoreFixture } from './store.test-support';

/** Run the conformance suite against a fixture factory. */
export function describeRunStoreConformance(label: string, make: MakeRunStoreFixture): void {
  const harness = { make, started: startRunWith(make) };
  describe(label, () => {
    describeRecords(harness);
    describeStreams(harness);
    describeProperties(harness);
  });
}
