/**
 * The helper process that owns one throwaway PostgreSQL cluster for `pnpm test`'s native mode.
 *
 *   node postgres-native-child.mjs <data directory> <port>
 *
 * It runs apart from the launcher because importing `embedded-postgres` installs
 * `async-exit-hook`, which turns `beforeExit` into `process.exit(0)` and would replace the Vitest
 * exit status the launcher must return (packages/embedded/src/embedded-db.ts explains the same
 * trap). Here that hook is wanted: on SIGINT/SIGTERM it stops the cluster.
 *
 * It prints one JSON line `{"ready":true}` on stdout once `agent_workspace_test` exists. It stops
 * the cluster and exits when its stdin closes, which is how the launcher asks it to stop, and also
 * what happens when the launcher dies without asking.
 */
import process from 'node:process';

import EmbeddedPostgres from 'embedded-postgres';

const [databaseDir, portText] = process.argv.slice(2);
const port = Number(portText);
if (databaseDir === undefined || !Number.isInteger(port) || port <= 0) {
  process.stderr.write('usage: postgres-native-child.mjs <data directory> <port>\n');
  process.exit(2);
}

const database = new EmbeddedPostgres({
  databaseDir,
  port,
  // initdb makes this role the cluster's superuser, which root.test.ts needs for CREATE DATABASE.
  user: 'postgres',
  password: 'postgres',
  authMethod: 'password',
  persistent: false,
  // TCP on loopback only, and no Unix socket in a shared directory. UTC like the Docker image:
  // initdb would otherwise copy the host's TZ (JST on the dgx pool) into the cluster's `timezone`.
  postgresFlags: [
    '-c',
    'listen_addresses=127.0.0.1',
    '-c',
    'unix_socket_directories=',
    '-c',
    'timezone=UTC',
    // The cluster is thrown away, so durability buys nothing. `DROP DATABASE` waits for a forced
    // checkpoint, and with dozens of suites dropping at once that checkpoint's fsyncs took seconds.
    '-c',
    'fsync=off',
    '-c',
    'full_page_writes=off',
  ],
  onLog: (/** @type {string} */ message) => process.stderr.write(message),
  onError: (/** @type {unknown} */ error) => process.stderr.write(`${String(error)}\n`),
});

/** @type {Promise<void> | undefined} */
let stopping;
/** @param {number} code */
function stopAndExit(code) {
  // `stop()` waits for an `exit` event, so it would never resolve for a server that already exited.
  // embedded-postgres exposes no public "is it running" check, so this reads its declared-private
  // child handle; the element access is how TypeScript lets one read it on purpose.
  const server = database['process'];
  const running = server !== undefined && server.exitCode === null && server.signalCode === null;
  stopping ??= (running ? database.stop() : Promise.resolve())
    .catch((/** @type {unknown} */ error) => {
      process.stderr.write(`stopping PostgreSQL failed: ${String(error)}\n`);
      code = 1;
    })
    .then(() => process.exit(code));
  return stopping;
}

process.stdin.on('end', () => void stopAndExit(0));
process.stdin.on('error', () => void stopAndExit(0));
process.stdin.resume();

try {
  await database.initialise();
  await database.start();
  const client = database.getPgClient('postgres', '127.0.0.1');
  await client.connect();
  try {
    await client.query('CREATE DATABASE agent_workspace_test');
  } finally {
    await client.end();
  }
  process.stdout.write(`${JSON.stringify({ ready: true })}\n`);
} catch (error) {
  process.stderr.write(`PostgreSQL did not start: ${String(error ?? 'the server exited')}\n`);
  await stopAndExit(1);
}
