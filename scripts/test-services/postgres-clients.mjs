import { waitUntil } from './process.mjs';

// Client backends other than the one asking. packages/core/src/db/repositories/testing.ts
// describes the same query.
export const CLIENT_BACKENDS_SQL =
  "select count(*) from pg_stat_activity where pid <> pg_backend_pid() and datname is not null and backend_type = 'client backend'";

/**
 * After a green Vitest run, every test must have closed its PostgreSQL clients: wait up to ten
 * seconds for `countClients` to answer 0. `countClients` answers `null` when it could not ask.
 *
 * @param {() => number | null | Promise<number | null>} countClients
 */
export async function waitForPostgresClientsToClose(countClients) {
  await waitUntil(
    'PostgreSQL test clients to close after Vitest',
    async () => (await countClients()) === 0,
    10_000,
  );
}
