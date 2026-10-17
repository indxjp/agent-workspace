# `@indx-workspace/embedded` — the Agent Workspace local runtime

The control plane (web), the model gateway and the runner in **one Node process**, over an
embedded PostgreSQL 17 and local files. A generated project runs it as `aw dev`, which resolves
this package's `./launch` export from the project's dependencies and forks it; it never imports
it (ADR-0109).
`aw dev` itself is a later unit of the developer journey (S1-13).

The package exports no importable API. Its `exports` are exactly:

| Export           | Target           | Who reads it                                            |
| ---------------- | ---------------- | ------------------------------------------------------- |
| `./launch`       | `./dist/bin.js`  | `aw dev`, which resolves the path and forks it          |
| `./package.json` | `./package.json` | `aw dev`, which checks the runtime's version equals its |

The server images stay the production path. The local runtime has no tenant isolation: the
`local` runtime driver runs commands as you.

## Installing

A generated project depends on this package, at the same version as `@indx-workspace/aw`. Its
`embedded-postgres` dependency installs the PostgreSQL binaries for your platform from one of the
eight `@embedded-postgres/*` packages, whose install script restores the binaries' symlinks.

- **npm** runs dependencies' install scripts by default, so `npm install` needs nothing more.
- **pnpm** runs none it has not been told to allow: a pnpm project must allow the eight
  `@embedded-postgres/*` builds (`allowBuilds` in `pnpm-workspace.yaml`).
- **After `npm install --ignore-scripts`**, run `npm rebuild @embedded-postgres/<platform>` (for
  example `@embedded-postgres/linux-x64`). It restores the PostgreSQL symlinks and runs no other
  package's script.

The release smoke (`pnpm release:pack --smoke`) installs the packed tarballs this way and boots the
runtime from them: `ready`, `credential`, `GET /api/me` answering 200, and exit 0 on SIGINT. The
first npm publish is the Owner's step (see "Declared gap"), so until then the package is proven
from tarballs only.

## Two ways to run it

**Contributor path, from a repository clone.** `pnpm start:embedded` compiles `src/` with `tsc`
into `dist/contributor` (the `build-contributor` target) and runs `dist/contributor/index.js`. The
web server is Next development mode from `apps/web`, as before; the command prints
`Agent Workspace is ready at …` once every server answers.

**Published path.** `pnpm --filter @indx-workspace/embedded build` (also part of `pnpm build`)
runs `node src/packaging/main.ts` (Node strips the types) and writes:

- `dist/launch.js` and `dist/chunks/*.js`: an esbuild bundle of `src/launch.ts` (ESM, no source
  map), split at every `import()`. Every workspace member it reaches (the server packages, the four
  engine adapters, the CLI, the contracts and the SDK) is inlined; every third-party package stays
  an external `import`. Splitting keeps each engine adapter's and each cloud driver's imports in
  its own chunk, so a start loads none of them until a run or a profile needs one.
- `dist/bin.js`: a few lines from `src/bin.ts`. When it is `argv[1]` it imports `./launch.js` and
  runs the runtime; importing it does nothing. It takes no arguments and refuses any it is given
  (exit 1) rather than ignore them; configuration comes from the environment and from `.env` in the
  working directory, which is optional. A failed start exits with a non-zero code: the bin calls
  `process.exit` itself, because `embedded-postgres` installs an exit hook that would otherwise
  end the process with 0. `argv[1]` is resolved as Node resolves the main module, so
  `node dist/bin` and `node dist/launch` are recognised as well.
- `dist/web/`: `next build --webpack` of `apps/web` into the distDir `.next-embedded`, without the
  build cache, the route types, the traces, the `*.nft.json` files and source maps, plus a
  generated `next.config.mjs` naming that distDir. The launcher serves it with
  `startWeb(env, { dir: dist/web, dev: false })`.
- `dist/node_modules/`: the files of `next`, `react` and `react-dom` (and what they need) that
  the production server reads, as Next's build traces and an nft trace of
  `next/dist/server/next.js` list them, without source maps and development runtimes (ADR-0140).
  The chunks resolve `next` here, so the package does not depend on it, and `@next/swc-*` and
  `sharp` are never installed. The launcher sets `__NEXT_PRIVATE_STANDALONE_CONFIG` to the config
  in `dist/web/.next-embedded/required-server-files.json`, as Next's standalone server does, so Next
  never loads the build-time modules the trace leaves out.
- `dist/migrations/`: a copy of the repository's `migrations/`, journal included. The launcher sets
  `MIGRATIONS_DIR` to it unless it is already set.
- `publish/`: the staging directory the package is packed from (git-ignored). See below.

**Never run `dist/launch.js` directly.** Inlined modules compare their own `import.meta.url` with
`argv[1]` to decide whether they are the main module, and inside the bundle that URL is the
bundle's. Run directly, it refuses with `run dist/bin.js, not the bundle` and exits 1. `launch.ts`
reaches the servers only through a dynamic `import()`, so that refusal runs before any inlined
module's top level. It does not run before the third-party externals, which ESM links first (see
"Why the externals are pinned here too"): the refusal assumes they are installed, as they are in
the repository and in an installed package, and a missing one fails with Node's resolution error
instead.

The web build leaves `apps/web` as it found it: Next rewrites `apps/web/tsconfig.json` and
`next-env.d.ts` for a custom distDir, so both are saved byte for byte and restored, and
`apps/web/.next-embedded` is removed, in a `finally`. The build then fails if
`git status --porcelain apps/web` differs from what it was before the build. A contributor's own
uncommitted edits under `apps/web` are therefore allowed; a trace the build left is not. The Nx
`build` target runs after `web:typecheck` and `web:lint`, so CI's parallel fast checks never read
the half-written build.

## The published launcher (`aw dev`)

`dist/bin.js` behaves in one of two ways. Started without an IPC channel (`node dist/bin.js`), it
keeps the environment-only start described above. Forked with an IPC channel, as `aw dev` forks
it, it is the launcher of S1-11 (issue #449) and speaks the protocol of
`@indx-workspace/contracts/local-runtime`:

1. `aw` → runtime: `start {projectDir, environment: {port, runtimeDriver?, bootstrapAdmin}}`.
   The launcher waits up to 60 seconds for it. A message that schema refuses (an unknown key, a
   wrong type, or a runtime-to-`aw` message such as `ready`) is answered with `failed`.
2. runtime → `aw`: `ready {url, contractsVersion}`, once the web server, the gateway and the
   runner answer and the server serves this package's contracts version. `url` is always a
   loopback URL.
3. runtime → `aw`: `credential {token, expiresAt, workspaceId, workspaceSlug}`, where `token` is
   a workspace API key (`ak_live_…`) for the local workspace (`WORKSPACE_SLUG`, or `default`),
   minted in process by the server's own `issueLocalApiKey` at a role no higher than the
   bootstrap admin's, expiring after 12 hours (ADR-0109's S1-21 amendment, issue #500). `aw` can
   then reach every control-plane route it calls without a device grant, and keeps the key in its
   own owner-only `~/.config/agent-workspace/local-credentials.json`. The key cannot write
   `/api/api-keys`, `/api/users` or `/api/memberships`, so nothing it mints outlives the run;
   `aw workspaces` and `aw invitations` refuse API keys, so use the browser sign-in for them. The
   key travels only over the IPC channel and is revoked on stop, before the database stops; a key
   a crashed run left behind is revoked on the next start. Before minting it, the launcher makes
   a runtime profile named `local`, on the `local` driver, the workspace default, creating or
   adopting it, unless the workspace already has a default (ADR-0109's S1-22 amendment, issue
   #504), so an agent pushed with no runtime profile runs on it. A profile named `local` on
   another driver is left alone with one warning on stderr.
4. Any failure, before or after `ready`, sends `failed {message}` instead, releases what was
   started and exits 1. The message is terminal-safe (no control character, at most 4096
   characters) and never carries a secret. Before starting anything, the launcher checks every
   port it will bind (web, gateway, runner, and the embedded PostgreSQL unless `DATABASE_URL` is
   set) and reports every one that cannot be bound in one message, a line each naming the port, its
   role and the setting that moves it: `environments.local.port` in `agent-workspace.yaml`,
   `GATEWAY_PORT`, `RUNNER_PORT` or `AW_DATABASE_PORT` in `.env` (issue #660). A port taken after
   that check is reported as `port <n> is already in use`. For the embedded PostgreSQL's port, 25432 by default, the message
   goes on to say that another process holds it (for example another project's `aw dev`, or a
   PostgreSQL a killed run left behind) and what to do (stop it, or set `AW_DATABASE_PORT` in
   `.env` to another free port below 49152). A PostgreSQL port that cannot be bound although
   nothing listens on it is reported as
   `port <n> cannot be bound on 127.0.0.1, but no process is listening on it: ...`, and one whose
   listener check is inconclusive as
   `port <n> cannot be bound on 127.0.0.1, and whether a process holds it could not be determined: ...`,
   both naming `AW_DATABASE_PORT` and `DATABASE_URL` (see "The embedded PostgreSQL's port" below). A start
   that has not sent `credential` five minutes after `start` arrived is reported as
   `the local runtime did not become ready in time`.
   A port the process may not listen on is reported as `permission denied to listen on port <n>`,
   with a hint to choose a port from 1024 to 65535 when it is below 1024 (issue #560). The
   runtime's own gateway (4000) and runner (8080) ports are refused as `environments.local.port`
   by `aw check` and `aw dev`; the project file is shared, so that check follows the fixed ports
   whatever `.env` says. Each of `GATEWAY_PORT`, `RUNNER_PORT` and `AW_DATABASE_PORT` that is unset
   becomes its default (4000, 8080, 25432) plus the web port's distance from 3000, kept at the
   default when that falls outside 1024-49151, so two projects on different web ports run side by
   side with no setting (issue #664). The launcher refuses again the ports this machine's runtime will bind: the
   `GATEWAY_PORT` and `RUNNER_PORT` that `.env` sets (the message names the variable), and the
   embedded PostgreSQL's port unless `DATABASE_URL` is set. The launcher records its pid in
   `.agent-workspace/runtime.pid` while it runs; a second start in the same project that collides
   on a port while that process is alive is reported as
   `port <n> is already in use, and this project's local runtime may already be running (.agent-workspace/runtime.pid records process <pid>); if aw dev is running in this project, stop that aw dev before running it again`.
   The file only words that diagnosis: it never refuses a start, and a pid cannot prove its process
   is an aw runtime, so a start whose services all bind over a live record re-records itself.

`projectDir` must be an existing absolute directory. The launcher changes into it and keeps all
its state under `<projectDir>/.agent-workspace/`: the embedded PostgreSQL in `postgres/`, the
file, skill and transcript storage, and the secrets.

**The environment it sets (contract C1).** From `start`: `PORT`, `BOOTSTRAP_ADMIN` and, when given,
`RUNTIME_DRIVER`. For the local posture: `AW_DEPLOYMENT_POSTURE=local`, `HOST=127.0.0.1` and
`AW_LOCAL_SURFACE_SESSIONS=1`. `MIGRATIONS_DIR` defaults to `dist/migrations`. A value already set
in the process environment or in `.env` that differs from the one required is refused, never
silently overridden: the launcher sends `failed` naming the variable (never its value), so
`HOST=0.0.0.0` fails with `local posture needs a loopback HOST`, and another loopback host such
as `HOST=localhost` with `the local runtime binds 127.0.0.1`. A `WORKSPACE_SLUG` that is set
must be a workspace slug, and an unreadable `.env` is refused naming its path. The one forced value is
`NODE_ENV=production`: it states how the bundle and `dist/web` were built, not a setting. The
server's deployment-posture check then runs on the result. `GATEWAY_PRICING_JSON`, which the
gateway needs to start, defaults to the sentinel `.env.example` ships (it matches no real provider
model, so metered runs settle unpriced: cost zero, accounting state `unavailable`); set reviewed
rates in `.env` to replace it.
`AW_DEPLOYMENT_DEFAULT_MODELS` defaults to `{"anthropic":"claude-sonnet-4-5","openai":"gpt-5.1"}`,
so an agent whose version names the `default` connection but no model runs on that provider's id
(contract C7, the last layer of the run model ladder, ADR-0103 amendment); a value set in `.env` or
the environment wins, and an empty one turns it off. `start.environment.modelSecrets`, the names
(never the values) of the project's model connection secrets, becomes `AW_LOCAL_MODEL_SECRETS` as a
JSON array, so the try page names the variable to set for a missing or rejected key (issue #661).

**The runtime directory and its secrets.** Before it writes anything else into `.agent-workspace/`,
the launcher writes `.agent-workspace/.gitignore` containing `*`, so a project without a root
`.gitignore` never stages the database, the storage or the secrets. An existing `.gitignore` there
must keep a line that is exactly `*` and contain no negation (`!…`) line, which could un-ignore
the secrets file, or the launcher refuses to start; so it does when `.agent-workspace` is not a
directory. On the first start it
generates `SESSION_SECRET`, `MASTER_ENCRYPTION_KEY`, `GATEWAY_TOKEN_SECRET` and
`BOOTSTRAP_ADMIN_PASSWORD` into `.agent-workspace/secrets/local-secrets.json`, created with mode `0600`
(a sibling of the run workspaces, not one of their ancestors; a file at the old place,
`.agent-workspace/local-secrets.json`, is moved there on the next start).
Later starts reuse the file unchanged (and tighten a looser mode back to `0600` on POSIX), so
sessions, encrypted secrets and gateway tokens survive a restart. A file that cannot be parsed or
fails validation is refused with an error that names its path and never its contents. The
precedence is the process environment, then `.env` in the project directory, then
`local-secrets.json`: a value from either of the first two wins over the file. A blank value,
such as the `SESSION_SECRET=` line `.env.example` ships, counts as unset.

**The key.** It travels only over the IPC channel: the launcher never writes it to stdout,
stderr, a log or a file. On SIGINT, SIGTERM, SIGHUP (a closed terminal or console window), SIGBREAK
(Windows' Ctrl+Break) or the IPC channel disconnecting, the launcher revokes
it first, while the database is still up, then closes its database root and the servers, and
exits 0. The same triggers during the start (and a signal while it still waits for `start`)
abandon the step in progress at once, release what was acquired and exit 0 without sending
`failed`. A crash or a `SIGKILL` cannot revoke it, so such a key stays valid until it expires,
twelve hours after it was issued (the CLI token lifetime), or until the next start, which revokes
every unrevoked key whose name starts with the reserved `aw dev local runtime` prefix before
minting its own.

**Ctrl+C in a terminal.** The terminal sends SIGINT to every process in its foreground process
group. The runtime starts the embedded PostgreSQL postmaster itself, `detached` (ADR-0112): on POSIX
in its own session and process group, on Windows in its own process group with no console. So a
Ctrl+C reaches only the launcher, which revokes the key, closes the server and its database pools,
and only then stops PostgreSQL (SIGINT, a fast shutdown; SIGKILL to the postmaster's group if it has
not exited within 30 seconds; `taskkill /t` on Windows). A database connection that still fails
during that stop is reported as one `[db] a database connection failed (<code>)` line, never an
uncaught error. A closed terminal (SIGHUP) or Ctrl+Break (SIGBREAK) runs the same ordered stop. An
exit through `process.exit`, an uncaught exception or an empty event loop sends the postmaster
SIGINT from an `exit` hook. A launcher killed with `SIGKILL`, or ended by another signal's default
action (such as SIGQUIT, `Ctrl+\`), runs no code at all, so it leaves the postmaster running: the
next start then fails with `port 25432 is already in use` (or the `AW_DATABASE_PORT` port) until
that postmaster is stopped (`kill <pid>`, the pid being the first line of
`.agent-workspace/postgres/postmaster.pid`). On a first start, `initdb` still runs in the
launcher's group, so a Ctrl+C during the first initialisation aborts it, and the start is
abandoned as any other interrupted start is.

**The sign-in line.** On the first start, when the password was generated into
`local-secrets.json`, the launcher prints the admin email and that password once on stdout. Later
starts print only where the password is: the path of `local-secrets.json`, or that it is set in
`.env`.

`src/local-launcher.integration.test.ts` forks the built `dist/bin.js` in a temporary project
directory on free ports and checks the sequence end to end: `ready` then `credential`,
`GET /api/me` and `GET /api/model-connections` with the key answering 200, the `.gitignore` and
the secrets file (its mode outside Windows), exit 0 on SIGINT, a restart that reuses the secrets
byte for byte and answers 401 to the first, revoked key, and no key in either run's stdout or
stderr. A second describe forks the launcher `detached`, so that it leads its own process group as
a terminal job does, and sends SIGINT to that whole group (on Windows it closes the IPC channel):
the postmaster is in a group of its own, the launcher exits 0 with no revoke warning, no
`terminating connection` error and no stack trace, the postmaster and port 25432 are gone, and a
restart answers 401 to the first key, whose row was revoked before the first runtime exited. Its
last test
holds port 25432 and checks that a start then answers `failed` with the full in-use message and
exits 1. The embedded PostgreSQL listens on that fixed port, so the earlier tests fail, naming it,
while another embedded runtime runs on the same host.

**The embedded PostgreSQL's port.** It is 25432 for web port 3000, and moves with the web port
like the gateway's and runner's (issue #664), always deterministic per project, below every default
ephemeral range (Linux 32768-60999, Windows and macOS 49152-65535). The earlier 54329 sat in
Windows' dynamic range, which Linux cannot bind under WSL2 mirrored networking (issue #556).
`AW_DATABASE_PORT`, from the environment or the project's `.env`, overrides it; it must be a whole
number from 1024 to 65535, and any other value fails the start before anything is started, naming
the variable and the range. A port equal to the web (`PORT`), gateway (`GATEWAY_PORT`) or runner
(`RUNNER_PORT`) port also fails before anything starts, with
`port <n> is both the embedded PostgreSQL's port and <VARIABLE>: ...`. When `DATABASE_URL` is set,
no embedded PostgreSQL starts at all and the runtime uses that database. If the port cannot be
bound, the start checks whether anything listens on it: if something does, it fails with
`port <n> is already in use: ...`; if nothing does, the operating system reserves the port (a
Hyper-V or WSL excluded range, for example) and it fails with
`port <n> cannot be bound on 127.0.0.1, but no process is listening on it: ...`; if the check is
inconclusive (it times out), it fails with
`port <n> cannot be bound on 127.0.0.1, and whether a process holds it could not be determined: ...`.
The last two tell you to set `AW_DATABASE_PORT` in `.env` to a free port below 49152, or
`DATABASE_URL` to your own PostgreSQL. The start never moves to another port by itself: a second start on the same data
directory must fail naming the port rather than start a second postmaster (ADR-0109, issue #556
amendment).

**The contributor path is unchanged.** `pnpm start:embedded` still generates fresh secrets on
every run and writes no `local-secrets.json`.

## The staging directory and the zero-leak gate

This workspace manifest names the server members as `workspace:*` dependencies, so Nx builds them
first and esbuild can inline them, and it stays `"private": true`. It is never packed. The build
writes `publish/package.json` instead (the release packs `publish/`), from a whitelist of this manifest's fields (`name`,
`version`, `description`, `license`, `homepage`, `repository`, `bugs`, `engines`, `type`,
`exports`, `bin`), public `publishConfig`, and a `dependencies` map holding exactly:

- every third-party package a start of the bundle loads: imported eagerly by a module the entry
  reaches, or imported in any way by this package's own `src/` (`embedded-postgres`, deferred for
  its exit hook, is still needed by every start);
- every package a webpack external module of the server chunks loads (`pg`);
- the required (non-optional) peers of those, recursively;

less `next`, `react` and `react-dom`, which `dist/node_modules/` carries instead.

Every other external is an optional `peerDependencies` entry: the packages an inlined member loads
only through an `import()` (each engine adapter's SDK, the cloud SDKs of the KMS, object-storage
and runtime drivers), with their required peers and pinned family, less what is already a
dependency. npm and pnpm install an optional peer only when the project names it, so a project
carries the one engine it uses and no cloud SDK (#691, ADR-0139). `npm create` and `aw init` name
the engine's packages from `ENGINE_PACKAGES` in `@indx-workspace/sdk/project`; the build derives
each engine's set from the imports under `packages/engine-<id>/` and fails
(`engine_packages_drift`) when that table differs, printing the table to paste. `aw dev` refuses a
project whose agents use an engine it has not installed, with the `npm install` line that adds it.

The metadata fields beyond ADR-0109's list (`description`, `homepage`, `bugs`, `engines`), the
public `publishConfig` and the required peers are deliberate: npm shows the first four, a scoped
package publishes as restricted without the access setting, and `next` does not load without its
peers installed beside it. The published `description` therefore describes the package alone.

Each is at the exact version the lockfile installed, read with `module.findPackageJSON` from its
importer. `dist/bin.js`, `dist/launch.js`, `dist/web/`, `dist/migrations/`, this README, `LICENSE`
and `CHANGELOG.md` are copied beside it. The build fails, with a typed `EmbeddedBuildError`, when
two importers resolve one external to two versions, when an external has no installed manifest,
when a pin below differs from the installed version, or when a literal `require`/`import` in the
server chunks is neither a webpack external nor one of the reviewed `NON_EXTERNAL_LOADS` (an
optional `encoding` require of the bundled `node-fetch`, and two package names that occur only in
the text of an AWS SDK error message).

The packed tarball must not contain the private workspace scope anywhere, `dist/web/` and the
packed manifest included. Inlined members that are reached through a dynamic `import()` (the
runner's engine adapters) keep their whole namespace in the bundle, so no inlined module may hold
its own package name as a string: the source does not carry one, and the bundle step rewrites
nothing. The build fails (`foreign_scope_in_bundle`) if `dist/launch.js`, a chunk, `dist/bin.js` or a vendored file
under `dist/node_modules/` names the private scope. `src/bundle.test.ts` packs `publish/` with `pnpm pack` and runs the
release checks of `scripts/release/pack-packages.mjs` on it (`checkTarballEntries`,
`checkPackedManifest`, `checkDistContents`), then logs the packed and unpacked sizes. A size budget
is set from those measurements, not invented (ADR-0016).

## Why the externals are pinned here too

The bundle, run from this directory in the repository, resolves its externals from
`packages/embedded`, and the repository runs every engine. This manifest therefore pins each
staged dependency and each optional peer at the same exact version, and the build fails when the
two lists differ in either direction.

## The knip exception

`knip.json` lists, under this workspace's `ignoreDependencies`, the dependencies no file under
`src/` imports by name: the bundle externals that only inlined members import, and the inlined
workspace members that are reached only through other members. They are real run-time
dependencies of the bundle, which knip cannot see. `src/knip-exception.test.ts` holds the list to
that rule, so it cannot over-ignore: every name in it must be a staged dependency or an inlined
workspace member.

## Declared gap

ADR-0082 D5: the first version of a new package is published by hand by the Owner (a
`0.0.0-bootstrap` placeholder, as for the other five) before a trusted publisher can be
configured. Until then `npm create @indx-workspace` cannot install this package from the public
registry, and the publish workflow refuses a `packages-v*` release before publishing any package,
so no partial lock-step set reaches npm; re-running its publish job after the Owner's step finishes
the release (the repository's release procedure). CI proves the path from
tarballs only.

Follow-up for the bundle build (S1-10): the Next build inlines `import.meta.url` values and page
source paths as absolute paths of the build machine into about 200 `dist/web/` files. Nothing reads
them at run time (the launcher sets `MIGRATIONS_DIR`, and `open` falls back to the system opener),
but the published tarball names the CI runner's paths and is not reproducible across build hosts.
