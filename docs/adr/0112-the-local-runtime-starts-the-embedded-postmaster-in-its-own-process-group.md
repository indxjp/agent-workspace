# ADR-0112 — The local runtime starts the embedded PostgreSQL postmaster itself, in its own process group

Status: accepted
Date: 2026-10-03
Decided by: the implementing agent of the developer-journey delivery, on the Owner's delegation of 2026-10-02 ("decide yourself, ask nothing")
Scope: `packages/embedded/src/postmaster.ts`, `packages/embedded/src/embedded-db.ts`, `packages/embedded/src/runtime-messages.ts`, `packages/core/src/db/client.ts` (`createPool`, `reportDatabaseConnectionErrors`), `packages/core/src/db/bootstrap.ts`, `packages/core/src/db/migrate.ts`; issue #510 (S1-25)

## Context

Ctrl+C on `aw dev` must stop the local runtime in the order S1-06 fixed: revoke the local
credential while the database is up, close the server, then stop PostgreSQL. It did not. The S1-19
exit test saw `warning: the local credential could not be revoked` and uncaught
`terminating connection due to administrator command` (`57P01`) errors on a terminal Ctrl+C.

The cause is the process tree, not the launcher's order:

- `embedded-postgres@17.10.0-beta.17` starts the postmaster with a plain
  `spawn(postgres, ['-D', dir, '-p', port])`: no `detached`, and no option to ask for it. The
  postmaster stays in the launcher's foreground process group.
- A terminal sends SIGINT to every process in its foreground group. The postmaster received it
  directly and began a fast shutdown while the launcher was still revoking the key.
- S1-06's `claimSignals` removes the library's in-process `async-exit-hook` listeners. It cannot
  keep a signal the kernel delivers to another process away from that process.
- The pools `createPool` builds had no `error` listener. pg-pool re-emits an idle client's `57P01`
  as a pool `error`, and an `error` event with no listener is an uncaught exception. The raw lock
  clients of `bootstrap.ts` and `migrate.ts` had the same gap.

## Decision

### The runtime spawns the postmaster, detached

`packages/embedded/src/postmaster.ts` owns the postmaster process. `startPostmaster` spawns the
server binary with `detached: true`, `stdio: ['ignore', 'pipe', 'pipe']`, `windowsHide: true` and
`LC_MESSAGES=C`. On POSIX `detached` is `setsid()`: the postmaster gets its own session and
process group, so no terminal signal reaches it. On Windows it is `DETACHED_PROCESS` with
`CREATE_NEW_PROCESS_GROUP`: no console, so no console Ctrl+C. When the runtime runs as root it
passes the uid and gid of the `postgres` user, as `embedded-postgres` did. It is ready on the log
line `database system is ready to accept connections`, and it rejects with
`EmbeddedDatabaseError` `postmaster_exited` when the process exits or cannot be spawned first.
That keeps `embedded-db.ts`'s flow unchanged: try a start, `initdb` on failure, start again, and
map the postmaster's socket-failure log to `port <n> is already in use`.

`embedded-postgres` keeps two jobs: it owns the platform binaries, and its `initialise()` still runs
`initdb` on a first start. Its `start()` and `stop()` are never called, so its exit hook has no
running instance to stop, and it is imported only when a data directory needs initialising.

### The binary is found through `embedded-postgres`'s own dependency

`locatePostgresBinary` resolves `embedded-postgres` with `module.findPackageJSON` from the
runtime's own file, then resolves the platform package (the table of
`embedded-postgres/dist/binary.js`: darwin arm64 and x64; linux arm, arm64, ia32, ppc64 and x64;
win32 x64) from that manifest's real path, and takes `native/bin/postgres[.exe]` there, adding the
`r-x` bits when they are missing as the library does. Under pnpm's strict layout the platform
package is reachable only from `embedded-postgres`, which is why the second lookup starts from its
manifest. This adds no dependency, leaves the lockfile and the bundle's externals unchanged, and
any missing step is `EmbeddedDatabaseError` `binary_not_found`. Every `EmbeddedDatabaseError` has
a fixed message with no path, and `failureMessage` shows it.

### Stop, and the exit backstop

`Postmaster.stop()` is idempotent. It resolves at once when the postmaster has already exited,
which also removes the cause of the old hang where a failed start waited for an `exit` that never
came again. On POSIX it sends SIGINT (fast shutdown) and waits for `exit`; after 30 seconds it
sends SIGKILL to the postmaster's whole process group (`process.kill(-pid)`) and waits five more
seconds, then rejects with `stop_timeout`. On Windows it runs `taskkill /pid <pid> /f /t`, as the
library did. A `process.once('exit')` backstop, registered at spawn and removed by `stop()`, sends
SIGINT synchronously to a postmaster still running when the process ends through `process.exit`,
an uncaught exception or an empty event loop. It does not run when a signal's default action ends
the process: Node emits no `exit` then.

### The launcher owns every signal that ends a terminal job

The postmaster no longer shares the terminal, so no signal the terminal or console sends reaches
it, and the library's `async-exit-hook` is installed only on a first start. The launcher therefore
stops in order on SIGINT, SIGTERM, SIGHUP (a closed terminal or SSH session, and on Windows a
closed console window) and SIGBREAK (Windows' Ctrl+Break), and `claimSignals` leaves its listeners
the only ones for all four. Without the SIGHUP listener a closed terminal on any start but the first
ended the launcher by the default action, left the postmaster running and the key unrevoked.
`pnpm start:embedded` stops on the same four. The order (revoke, close the database root, close the
workspace, which closes the services and then the database) is unchanged.

### The server closes its database pools before PostgreSQL stops

The web composition root (`register()` in Next's instrumentation) opened its pools for the life of
the process and nothing closed them, so on every stop PostgreSQL terminated their idle clients
with `57P01`. Instrumentation now holds the composition's `close` handle on `globalThis` under a
registered symbol (Next bundles its own copy of every module), and `startWeb`'s `close` releases
it after Next has closed. `next start` never calls it; process exit closes the pools there.

Closing means `closePool`, not `pool.end()` alone. pg-pool's `end()` resolves once its last client
is removed, while each client's own `end()` is still in flight: the Terminate message is sent but
the backend may not have read it, and a postmaster stopped then answers it with `57P01`. On Linux
CI this raced often enough to fail the ordered-stop test. `closePool` also waits for every
connection the pool opened to close (bounded at 5 s), and the database root and the secrets
service close their pools with it.

A typed failure to start the postmaster at all (`root_without_postgres_user`, `binary_not_found`,
`unsupported_platform`) is reported as itself; only `postmaster_exited` is taken to mean an
uninitialised data directory and followed by `initdb`.

### Pools report a failed connection instead of crashing

`createPool(config, { onError })` attaches a pool `error` listener that reports
`{ code }`, where `code` is a SQLSTATE, a Node errno or `unknown`, never the message, URL or host.
The default report is one `[db] a database connection failed (<code>); the pool discards it`
line, and a throwing reporter is swallowed. Each pooled client also gets a silent `error` listener
for the time it is checked out, when pg-pool removes its own; that client's next query rejects to
its caller anyway. `bootstrap.ts` and `migrate.ts` attach the same reporter to their lock clients.
A pool still open while PostgreSQL stops would log that line rather than end the process; the
launcher's ordered stop closes every pool first, and its integration test forbids the line.

## Consequences

- A terminal's Ctrl+C reaches only the launcher, which exits 0 after revoking the key, closing the
  server and stopping PostgreSQL. The IPC protocol and the exit codes are unchanged.
- **A launcher killed with SIGKILL leaves the postmaster running**, as it did before; what is
  new is that no terminal signal reaches that postmaster any more, so it stays up. The next start
  fails with `port 54329 is already in use` until that postmaster is stopped, by its pid (the
  first line of `.agent-workspace/postgres/postmaster.pid`). The same holds for any signal the
  launcher does not handle whose default action ends it (for example SIGQUIT, `Ctrl+\`), and for a
  Windows launcher ended by `TerminateProcess`. The package README states this.
- `initdb` on a first start still runs in the launcher's group: a Ctrl+C during the first
  initialisation aborts it, and the launcher's existing abandon path handles that. Declared, not
  fixed.
- The binary lookup depends on the platform packages' `native/bin` layout. The exact pin of
  `embedded-postgres` and the launcher integration test cover it, and a changed layout fails as
  `binary_not_found`, never as a wrong binary.
- The launcher integration test forks the launcher `detached`, sends SIGINT to its whole group and
  checks the postmaster's group, the exit, stderr (no revoke warning, no uncaught error and no
  `[db]` connection line), the postmaster's pid and port, and the revoked key. It then restarts on
  the same project and ends that start with a SIGHUP to its group, with the same checks. It lives in the existing integration file because the embedded port 54329 is fixed and two
  files would race in parallel.

## Alternatives rejected

- **Patch `embedded-postgres`** (a `pnpm patch` adding `detached`). It would carry a fork of a
  third-party file through every upgrade, and the library's `stop()` would still wait forever on a
  postmaster that had already exited.
- **Ignore SIGINT in the postmaster.** PostgreSQL has no option for it, and a wrapper process that
  ignores it would add a process and still leave the stop to the library.
- **Start the postmaster with `pg_ctl`.** `pg_ctl` daemonises, but it leaves no child the runtime can
  wait on, so the stop would have to poll the pid file, and its Windows path differs again.
- **Amend ADR-0109.** S1-24 amends ADR-0109's S1-21 section concurrently; this decision is about the
  database process, not the package, so it stands on its own.
