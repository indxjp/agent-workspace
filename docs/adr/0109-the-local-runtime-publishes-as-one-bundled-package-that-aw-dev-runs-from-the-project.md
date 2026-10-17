# ADR-0109 — The local runtime publishes as one bundled package, and `aw dev` runs it from the project's dependencies

Status: accepted — supersedes in part [ADR-0082](0082-the-sdk-packages-publish-under-indx-workspace-from-a-tag-with-provenance.md) (four clauses of its amendment, listed under Decision) and accepts the `aw dev` part of [ADR-0103](0103-one-project-file-holds-every-environment.md)
Date: 2026-10-02
Decided by: the planning writer of the developer-journey delivery, on the Owner's delegation of 2026-10-02 ("decide yourself, ask nothing")
Scope: `packages/embedded` (renamed `@indx-workspace/embedded`), `packages/aw` (`dev`), `packages/contracts` (`./local-runtime`), `apps/web/server/start.ts`, the six `NODE_ENV` posture sites, `scripts/release/{pack,publish}-packages.mjs`, `.github/workflows/publish-packages.yml`, `dependency-cruiser.config.mjs`

## Amendment — the embedded PostgreSQL port (issue #556, 2026-10-03)

Reason: the WSL clean-machine run (tracker #438) found that `aw dev` cannot start under WSL2
mirrored networking. The embedded PostgreSQL's fixed port 54329 lies in Windows' dynamic port range
(49152-65535), which Linux cannot bind in mirrored mode. The bind failed with `EADDRINUSE` and was
reported as `port 54329 is already in use`, although nothing listened on it. A Windows excluded
port range answers `EACCES` instead, and that error reached the user only as the generic
`the local runtime failed to start`. 54329 is also inside the default ephemeral ranges of macOS
(49152-65535) and Linux (32768-60999).

- **The default port is 25432.** `EMBEDDED_DATABASE_PORT` (`packages/embedded/src/embedded-db.ts`)
  is below every default ephemeral range (Linux 32768, Windows and macOS 49152) and is not a
  well-known port. It stays fixed and deterministic. A restart on the same data directory keeps
  working, because the port is passed with `-p` on every start and is not stored in the data
  directory.
- **`AW_DATABASE_PORT` overrides it.** The variable is read from the environment or the project's
  `.env`, which the launcher already loads. It must be a whole number from 1024 to 65535. Unset
  or blank means 25432. Any other value fails the start before anything is started, with a typed
  `EmbeddedDatabasePortError` (`invalid_port`) whose message names the variable and the allowed
  range. A port equal to the web (`PORT`, 3000 by default), gateway (`GATEWAY_PORT`, 4000) or
  runner (`RUNNER_PORT`, 8080) port also fails before anything starts, with `port_conflict`:
  `port <n> is both the embedded PostgreSQL's port and <VARIABLE>: set AW_DATABASE_PORT (or
  <VARIABLE>) in .env so the two differ`. Without this check the database took the port and the
  web server failed about a minute later with a bare `port <n> is already in use`.
  `DATABASE_URL` still skips the embedded PostgreSQL entirely. The variable is not part of
  contract C1, which lists only what the launcher sets.
- **Three diagnostics replace the one.** When the probe bind fails with `EADDRINUSE` or `EACCES`,
  the start connects to `127.0.0.1:<port>` (about 500 ms at most, on the failure path only):
  - Nothing answers (`ECONNREFUSED`). The start fails with `EmbeddedDatabasePortError`
    (`port_reserved`): `port <n> cannot be bound on 127.0.0.1, but no process is listening on it:`
    followed by the cause (the operating system reserves the port; under WSL2 mirrored networking
    Windows' dynamic ports 49152-65535 cannot be bound) and the remedy (`AW_DATABASE_PORT` in
    `.env` set to a free port below 49152, or `DATABASE_URL` set to your own PostgreSQL).
  - Something answers. The start fails as before with `port <n> is already in use`, which now
    says what holds it and what to do: `: another process holds it (for example another project's
    aw dev, or a PostgreSQL a killed run left behind); stop it, or set AW_DATABASE_PORT in .env to
    another free port below 49152`. Web, gateway and runner ports keep the bare
    `port <n> is already in use`.
  - The check is inconclusive (it times out, or the connection fails other than with
    `ECONNREFUSED`). The start fails with `EmbeddedDatabasePortError` (`port_unavailable`), which
    claims neither cause: `port <n> cannot be bound on 127.0.0.1, and whether a process holds it
    could not be determined:` followed by both causes and both remedies.
- **No silent fallback port.** The start does not move to another free port by itself. A second
  start on the same data directory must still fail by naming the port; it must not start a second
  postmaster that then fails on `postmaster.pid`. ADR-0112's diagnostics for a postmaster a killed
  run left behind rely on this.
- **Follow-up.** A project-file setting (`environments.local.database.port` in
  `agent-workspace.yaml`) would be a contracts change and is left as a follow-up.

This amendment supersedes the Consequences bullet that lists 54329 among the fixed ports: the
embedded PostgreSQL's port is now 25432 or `AW_DATABASE_PORT`. ADR-0112 names 54329 as it stood
when that record was written and is not rewritten.

Proof: `embedded-db.test.ts` (the default is below 32768; `AW_DATABASE_PORT` parsing and its
clash with a service port; a busy port with a listener, without one and with an inconclusive
check, for `EADDRINUSE` and `EACCES`), `runtime-messages.test.ts`,
`local-launcher.test.ts`, `workspace.test.ts` and `local-launcher.integration.test.ts`. The
embedded port is not a formalised surface, so no Lean model changes.

## Amendment — what S1-10 settled (issue #448, 2026-10-02)

Reason: building the bundle (S1-10, PR #464) needed four decisions this record did not make.

- **One self-export exemption.** `scripts/release/pack-packages.mjs` rejects any `exports` target
  outside `./dist/`, so it exempts exactly the pair `"./package.json": "./package.json"` and only
  for `@indx-workspace/embedded` (`SELF_EXPORTING_PACKAGE`): `aw dev` resolves that export to check
  the runtime's version, and every other package and target keeps the dist-only rule.
- **The staging manifest is a complete public manifest.** Besides the fields listed under "One
  package", `publish/package.json` carries `description`, `homepage`, `bugs`, `engines` and
  `publishConfig: { access: "public" }`, and its `dependencies` add the required peers of the
  externals (`react` and `react-dom` for `next`): an install must resolve every external without
  the workspace.
- **The bundle manifest may declare the engine SDKs, never import them.**
  `tests/no-sdk-import.test.ts` names one exception, `RUNTIME_BUNDLE_MANIFEST =
'packages/embedded/package.json'`: because ESM links an external `import` before any code runs,
  the workspace manifest must list the SDKs the bundle leaves external, but only under
  `dependencies` and pinned exactly as the owning engine manifest pins them, so it can never
  introduce or move an SDK; the import assertions still refuse any reference. The exception also
  requires `"private": true`, which S1-12 must revisit when the package publishes.
- **No `@agent-workspace/` string reaches the bundle, fixed at the source.** The four engine
  adapters' unread `PACKAGE_NAME` exports were deleted, because a dynamically imported member keeps
  its whole namespace; the build rewrites no source or output, and its `foreign_scope_in_bundle`
  error fails on any leak. The build sources live in `packages/embedded/src/packaging`, not
  `src/build`, because the root `.gitignore` ignores every `build/` directory.

## Amendment — how aw dev finds the runtime (issue #451, 2026-10-02)

Reason: implementing `aw dev` (S1-13, PR #482) showed that the module-resolver call this record
named could not hold. The §42 SDK-boundary gate (`tests/no-sdk-import.test.ts`) cannot decide a
`createRequire(...).resolve` call on a package `aw` does not depend on, and refuses it; and the
CommonJS resolver consults `NODE_PATH`, which pnpm's `.bin` shims set, so inside this repository it
found the workspace's own build instead of the project's install.

- **No module resolver.** `aw dev` (`packages/aw/src/local-runtime/resolve.ts`) looks for the
  first `node_modules/@indx-workspace/embedded` directory in the project directory or one of its
  parents, as an ES module `import` from there would, and never reads `NODE_PATH`.
- **`./launch` is read, not resolved.** It reads that package's `package.json` with file-system
  calls only and takes `exports["./launch"]`, accepting only a plain string target that starts with
  `./`. A conditional target, a missing file, or a target whose real path (after following symbolic
  links) leaves the package is refused with the same install line as a missing package.
- **The version check is unchanged in effect.** The same `package.json` must name
  `@indx-workspace/embedded` at exactly `aw`'s version; it is read from the file directly, so the
  `"./package.json"` self-export the S1-10 amendment kept is no longer what `aw dev` uses to find it.

The section "`aw dev` resolves and forks it; it never imports it" below is corrected to match;
everything else in it (refusals, fork, signals, protocol) stands.

## Amendment — what S1-12 settled (issue #450, 2026-10-02)

Reason: adding the package to the lock-step release (S1-12) changed four things this record and
its S1-10 amendment describe.

- **The private requirement is flipped.** The package publishes, from the generated staging
  manifest `publish/package.json`, so `tests/no-sdk-import.test.ts` no longer requires
  `"private": true` of `RUNTIME_BUNDLE_MANIFEST`. It keeps the exception narrow without that flag:
  the manifest must be `@indx-workspace/embedded` and its `exports` exactly `./launch` and
  `./package.json`, so it exports no API that could re-export an SDK, and the dependencies-only and
  exact-owner-pin assertions are unchanged. The workspace manifest itself stays private and is
  never packed.
- **The publish workflow is two jobs.** `verify` (`contents: read`, no `id-token`) builds the six
  packages, packs and verifies them, records each tarball's sha256 as a job output and uploads the
  tarballs and their list as a 7-day artifact; only then does it run `pack-packages.mjs --smoke`,
  whose new boot smoke runs `npm rebuild` of `@embedded-postgres/*` and boots the runtime from the
  tarballs, with an allowlisted environment so no CI credential reaches that third-party code. The
  smoke re-packs and must reproduce the uploaded bytes. `publish` (`npm-publish` environment,
  `id-token: write`) downloads the tarballs, refuses any whose sha256 differs from the recorded one,
  re-runs every tarball check (`verifyTarball`) at the version the tag names, and publishes,
  installing only the pinned npm CLI. The job that holds the OIDC token therefore still runs no
  third-party install script and no runtime, as it did when it installed with `--ignore-scripts`.
  `publish-packages.mjs` resolves each list line against the list file's directory and checks the
  order, names and lock-step from the tarballs again.
- **`pack-packages.mjs --packages <list>`** packs a subset in publish order. Only
  `tests/generated-project/run.mjs` uses it
  (`contracts,platforms,sdk,aw,cli,create`: that CI job does not
  build the runtime, and its v1 Compose project needs only the CLI). It is refused together with
  `--smoke` or `--expect-tag`, so a release and the smoke always pack all six.
- **TypeScript is imported lazily.** `pack-packages.mjs` imports `typescript` only inside the
  consumer type-check, because `publish-packages.mjs` imports `PUBLISHED_PACKAGES` and
  `verifyTarball` from it in the publish job, which has no `pnpm install`.

The first publish of `@indx-workspace/embedded` stays the Owner's manual step (ADR-0082 D5), a
declared gap: the Owner publishes a `0.0.0-bootstrap` placeholder and configures the trusted
publisher. Until then the publish job refuses the whole release before publishing anything, because
every package must already exist on npm, so a tag never leaves a partial lock-step set; a re-run
after the Owner's step publishes all six.

## Amendment — what S1-21 settled (issue #500, 2026-10-02)

Reason: the S1-19 exit test (workflow run 36975818149) found that the CLI user token this record
had the launcher issue cannot do what `aw dev` needs. ADR-0083 §4 admits an `awu_live_` token only
on the person-facing prefixes in `apps/web/server/cli-auth/token-routes.ts` (`/api/me`,
`/api/workspaces`, `/api/invitations`, `/api/sharing-policies`, `/api/auth/cli-*`), and
`apps/web/proxy.ts` and `session-rbac.ts` refuse it with `401` everywhere else, so `aw dev` could
not create the default model connection or push agents, and `aw push` in the project directory
failed the same way. Items 3, 4 and 6 of "The first run needs no hand edit" below are replaced by
the following; items 1, 2, 5 and 7 stand.

- **The credential is a workspace API key.** The local runtime gives `aw dev` one credential, an
  `ak_live_…` key scoped to the local workspace, instead of a user token. The launcher mints it in
  process through `issueLocalApiKey` in `apps/web/server/cli-auth/local-credential.ts`, with
  `rbac/api-key.ts`'s `mintApiKey` (the only source of a key) into the core directory repository
  that `POST /api/api-keys` also writes through (`createApiKey` on
  `DatabaseRoot['directory'].forWorkspace(ws)`), so only the SHA-256 hash of its secret is stored.
  There is no new route and no migration. `issueLocalUserToken` is deleted.
- **Never more than the bootstrap admin.** The key's role is `admin`, minted only for a bootstrap
  admin whose own role is Owner or Admin: exactly the callers `conferRole(role, 'admin')` allows,
  so the key never exceeds the person it stands for. The issuer takes only `{ workspaceId, userId }`
  and reads that user's membership of the workspace from the directory itself; it never trusts a
  role from its caller. No membership, or any other stored role, is
  `LocalCredentialError('not_issued')`, and the launcher also refuses, as `workspace_mismatch`, a
  membership whose user is not the seeded administrator. The issuer does not call `conferRole`
  itself, because it is bundled into the local runtime, whose `nodenext` type-check
  (`packages/embedded`) refuses the extensionless relative imports of the RBAC module graph behind
  `conferral.ts`; `local-credential.test.ts` asserts, for every role in `rbac/roles.ts`, that the
  issuer's rule answers exactly what `conferRole(role, 'admin')` answers, so the two cannot drift.
  Admin holds the `any` grant, so agents an earlier run's key created, which belong to that key's
  principal, still take versions and pointers. Admin, not Builder, because Builder has no grant over
  `model-connections` and `aw dev` creates the default connection.
- **Nothing the key does outlives the run.** Admin may also administer API keys, users and
  memberships, and a key minted with the local key through `POST /api/api-keys` would keep working
  after the runtime revoked its own. So every write on `/api/api-keys`, `/api/users` and
  `/api/memberships` (`POST`, `PATCH`, `DELETE`) answers a principal whose key carries the reserved
  prefix with `403 local_runtime_key_not_permitted`, from an ownership resolver
  (`apps/web/server/cli-auth/local-runtime-key-guard.ts`) that runs inside `authorise` before
  `decide()`. `POST /api/api-keys` refuses that prefix in any new key's name with
  `400 reserved_name`, so the in-process issuer is the only source of such a name and the prefix is
  a reliable mark. Browser tokens (`POST /api/tokens`) stay available: they are short-lived and
  scoped to one run or session. Signing in to the browser with the bootstrap password remains the
  way to manage keys and members locally.
- **One live key per run.** The key is named with the reserved prefix `aw dev local runtime`
  and a space, followed by eight random base64url characters, unique under
  `api_keys_workspace_name_key` (a revoked key keeps its name; a taken name is retried once).
  Before minting, the issuer revokes every unrevoked key in the local workspace whose name carries
  that prefix, which a crashed run left behind; no person's key can carry it (see above).
  Declared, local only: revocation is a timestamp, so every start leaves one revoked `api_keys` row
  and its `workspace_principals` row behind, and the sweep reads the workspace's whole key list.
  Both grow by one row per `aw dev` start in a database that holds one developer's keys; they are
  not deleted, because §22 keeps revoked keys for audit.
- **Same lifetime, revoked before the database stops.** The key expires after
  `CLI_TOKEN_TTL_SECONDS` (12 hours), the lifetime this record already allowed, so a crash leaves at
  most what it left before, and the next start's sweep revokes it sooner. On SIGINT, SIGTERM, the
  channel closing or a failure, the launcher revokes it first (`revokeApiKey`), before the database
  connection and then the workspace close, which keeps the S1-06 `claimSignals` ordering: the
  database is still up when the key is revoked. A revoke that finds no row at all is reported on
  stderr as a warning; one that finds the key already revoked (by a person) is not.
- **IPC and one `0600` file only.** The key travels only over the IPC channel in the `credential`
  message, whose `token` field (unchanged in name, so the release boot smoke still reads it) now
  matches `API_KEY_PATTERN`. `aw` keeps it only in a file of its own,
  `~/.config/agent-workspace/local-credentials.json` (`0600`, written like `credentials.json`),
  keyed by the local URL; nothing prints, logs or writes it anywhere else. It is not an entry in
  `credentials.json`, because every published `aw` (0.2.x) parses that whole file strictly and
  would refuse every command, `aw logout` included, once it held a key entry; a test pins that the
  file this version writes still parses under the 0.2.x schema. The new file is read per entry, so
  an entry a later version writes is skipped, never a reason to refuse the file. With no configured
  key, `aw` uses the local key for the URL first and `aw login`'s token second; the two are stored
  apart, so `aw login` against the local URL never replaces the key `aw push` needs.
- **No token-route or role change.** ADR-0083's token routes, `proxy.ts`, `session-rbac.ts` and
  the role grants are unchanged; the only route change is the refusal above. An API key is already admitted at the edge on every catalogue route with
  default security (`auth/api-key-routes.ts`) and resolved by the directory, which covers
  `GET`/`POST /api/model-connections`, `GET`/`POST /api/agents`, the agent read and export routes,
  `GET`/`POST /api/agents/:id/versions` and `PUT /api/agents/:id/pointers`. The surface and widget
  routes the browser uses are public and do not depend on this credential.
- **Declared: workspace and invitation commands are browser steps locally.** The W9-WS-119 refusal
  (`api_key_not_permitted` on `/api/workspaces/**` and `/api/invitations/**`) still applies, and
  while `aw dev`'s key is stored `aw` sends it to the local URL, so `aw workspaces …` and
  `aw invitations …` against the local runtime answer `403`; use the browser sign-in for them.
  `aw me` works, answering with the key's principal.

The key is minted through the existing conferral, whose never-exceed-your-own-role property is
already modelled in `formal/AgentWorkspace/Concepts/ApiKey.lean`. The refusal above only narrows
what one class of key may do, before `decide()`, and grants nothing, so no formal model changes.

### S1-24 (issue #509): what the local key writes belongs to the bootstrap admin

Reason: the S1-19 exit test, round 5 (PR #498, Journey E2E run 37020839264), found that a widget
stops working on the first restart. Every write made with the local key stored the key's own
principal as the owner (`create-from-version.ts` and every other site that stores the caller's
`principalId`). The next start's sweep, the stop, or the 12-hour expiry revokes that key, after
which `principalById` no longer resolves its principal, so the surface bootstrap
(`surfaces/public/composition.ts`) answered `POST /p/s/main/sessions` with `404 surface_not_found`.
The bullet above that says agents an earlier run's key created "belong to that key's principal" is
replaced by the following.

- **Owner is the issuing member.** `workspace_principals` gains a nullable
  `acts_for_principal_id` (migration `0035_record_who_a_local_runtime_key_acts_for`): a tenant-paired
  self-reference to the membership principal an API-key principal acts for, with two checks (set only
  on an `api_key` principal, never to itself). It is on the principal, not on `api_keys`, because a
  reference from `api_keys` to `workspace_principals` would close a schema and module cycle, while
  a self-reference does not. `issueLocalApiKey` reads the bootstrap admin's membership, as before,
  and creates the key with `actsForPrincipalId` set to that membership's principal; the directory
  checks, in the same transaction, that the target is an unrevoked membership principal of the
  workspace. `Principal` gains `ownerPrincipalId`: the acts-for principal for such a key, and
  `principalId` for everyone else. Every site that stores or compares a resource owner (agents,
  sessions, runs, skills, files, connectors, projects, shares, tokens, item ownership) uses it. The
  field is required on every caller projection the composition roots build (the run, session,
  project and share actors), so a root that forgets to copy it fails to compile instead of silently
  making the key the owner again.
- **The audit trail keeps the acting key.** Sites that record who acted keep `principalId`: the
  audit `actorPrincipalId`, an agent version's `createdByPrincipalId`, a browser token's
  `mintedByPrincipalId` and `GET /api/me`. A browser token minted with the local key stays bound to
  that key, so it dies with it, and owns what it writes for the same member.
- **A key never outlives the person it acts for.** `authenticateApiKeyHash` and `principalById`
  answer `null` for a key whose acts-for principal is revoked or whose membership is gone.
- **Repair at start, before the sweep.** Before `sweepStaleKeys`, the issuer calls
  `reassignLocalRuntimeKeyOwnership`: in one transaction, every owner column (agents, sessions,
  skills, files, MCP servers, projects, and the shares publisher) held by an API-key principal whose
  key name starts with the reserved prefix (`LOCAL_RUNTIME_API_KEY_NAME_PREFIX`, a core constant
  the method takes no parameter for, so no caller can widen it to hosted keys), revoked and expired
  keys included, moves to the principal that key acts for, or to the issuing member when it records
  none; those principals'
  unset `acts_for_principal_id` is backfilled. It is idempotent, leaves `updated_at` alone (a change
  of owner is not an edit, and `aw push` and the default-profile attach compare it), and never
  touches actor attribution. This fixes projects pushed before the fix on their next start. A
  failure is `LocalCredentialError('not_issued')`, with the cause kept.
- **Hosted keys are unchanged.** A key created through `POST /api/api-keys`, or any other key the
  local issuer did not mint, records no acts-for principal and keeps owning what it writes.
- **Consequence: a member a local key acted for cannot be deleted while that key's principal
  exists.** The acts-for foreign key is `NO ACTION`, the same as every owner key, so deleting that
  membership is refused, as it already is for a member who owns projects or agents. The refusal is
  the typed `membership-in-use` outcome with dependency `local-runtime-keys`, which
  `DELETE /api/memberships/:id` answers as `409 membership_in_use`, never a raw constraint
  failure. Revoked key principals are kept for audit (see "One live key per run" above), so locally
  this holds for the bootstrap admin for good; an offboarding policy that reassigns ownership is
  RF-202's.

The ownership facts are modelled in `formal/AgentWorkspace/Concepts/Principal.lean` (the acts-for
field, its admission and resolution conjuncts, and `reassignLocalOwnership`) and the column, key and
checks in `formal/AgentWorkspace/Er/Core.lean`.

## Amendment — what S1-22 settled (issue #504, 2026-10-02)

Reason: the S1-19 exit test found that an agent `aw dev` pushes cannot run. Its version names no
runtime profile (`runtimeProfileName: null`), the local runtime created none, and `runs.start`
answered `422 agent_runtime_profile_missing`. ADR-0101 (amendment for S1-22) now resolves a null
name to the workspace's default runtime profile when the version is applied. This amendment makes
the local runtime choose that default.

- **The bootstrap prepares a `local` runtime profile and makes it the default.** After the
  membership check (`workspace_mismatch`) and before minting the credential, the launcher calls an
  injected `prepareLocalRuntimeProfile` (`packages/embedded/src/local-runtime-profile.ts`). It
  resolves the seeded workspace's scope and calls `ensureWorkspaceDefault` on the core runtime-profile
  repository with the profile
  `{ name: 'local', driver: 'local', networkPolicy: 'open', filesystem: 'read-write' }` and every
  other field `null`, so it asks the in-process runner for nothing `localRuntimeRunSpecRejection`
  refuses. The call locks the workspace row, so it is safe against a concurrent start, and answers:
  - `kept` when the workspace already has a default. **A default someone chose is never
    replaced.**
  - `adopted` when a `local` profile on the `local` driver already exists and the in-process runner
    can enforce it (`localRunnerUnenforceable`, the same rule as `localRuntimeRunSpecRejection`,
    finds nothing); it becomes the default and its settings are left as they are.
  - `unenforceable` when such a profile exists but sets something the runner cannot enforce
    (`cpu`, `networkPolicy=restricted`, `allowedDomains`, `filesystem=read-only`, …). Nothing is
    written; the launcher prints one stderr warning naming those settings, and the start
    continues. Adopting it would accept every run with `202` and then fail it while it is
    prepared.
  - `created` otherwise.
  - `name-conflict` when a profile named `local` uses another driver. Nothing is written; the
    launcher prints one stderr warning that agents that name no runtime profile cannot run until
    one is chosen, and the start continues. Such agents stay strictly refused.

  A restart therefore keeps exactly one `local` profile. After `kept`, `adopted` and `created`,
  core also attaches the default to the agents applied while the workspace had none (ADR-0101,
  amendment for S1-22), so a restart repairs an agent whose default was deleted or was blocked by
  a name conflict. A thrown error is the new safe
  `LocalLauncherError('runtime_profile_not_prepared')`. The launcher reaches the function through
  its existing dynamic import of `local-launcher.js` (which re-exports it) and the database root it
  already opened, so there is no new web export and no new dynamic import, and the §42 gate is
  unaffected.

- **Under posture `local`, the in-process `local` driver counts as verified.** The launcher
  integration test showed a second blocker once the profile existed: `assertAvailable`
  (`apps/web/server/compose/runtime-profile.ts`) also requires the driver's Test Runtime to have
  passed, and for `local` that is a one-hour verification only the Runtimes screen or the setup
  wizard records, which `aw dev` never visits. Every run failed at launch with
  `selects unavailable driver local: Test Runtime has not passed for this driver`. The local
  driver's Test Runtime is an in-process echo that cannot fail, and an explicit
  `AW_DEPLOYMENT_POSTURE=local` (what the launcher sets) has had HOST checked against loopback, so
  `installDriverRegistry` (`apps/web/server/composition/services.ts`) now answers
  `wasVerified('local')` with `true` under an explicit posture `local`, and only there. Under
  `production` and the implicit `local` posture nothing changes, and no other driver changes.
- **`RUNTIME_DRIVER=local` no longer shadows the in-process driver.** `aw dev` starts the runtime
  with `RUNTIME_DRIVER=local`, which made the runner manager's managed driver `local` as well. Its
  entry then replaced the in-process driver's verification key, and its Test Runtime branch ran
  first and failed with "the runner manager is not configured". Under posture `local`, when the
  two ids are equal, the managed entry no longer sets the `local` key and no longer takes the
  `local` Test Runtime. Other postures keep today's behaviour.
- **The implicit `local` posture keeps the Test Runtime.** `readDeploymentPosture` answers `local`
  also when `AW_DEPLOYMENT_POSTURE` is unset and `NODE_ENV` is not `production` (`pnpm dev`), and
  checks no HOST then, so the process may listen on any interface. The verified rule does not
  apply there: the local driver is offered as before and counts as verified only after a Test
  Runtime. The `RUNTIME_DRIVER=local` rule above applies to both, since it grants nothing.
- **Declared: the seeded General agent** is not given the default here. It is out of scope; it can
  be applied again once a default exists.

The stored shape of the default (the `runtime_profiles.workspace_default` mark, its unique key and
its check) is recorded in the formal ER catalogue; `ensureWorkspaceDefault` is proved by the core
repository tests. The launcher's ordering and the verified rule are proved by
`local-launcher.test.ts`, `services.test.ts` and `local-launcher.integration.test.ts`, not by a
Lean model.

## Amendment — what S1-23 settled (issue #506, 2026-10-02)

Reason: the S1-19 exit test found that an agent pushed with `model: 'default'` (connection
`default`, model `null`) is refused its first run with `422 model_connection_unresolved`.
ADR-0103 (amendment for S1-23) adds the deployment default model, `AW_DEPLOYMENT_DEFAULT_MODELS`,
as the last layer of the run model ladder. This amendment makes the local runtime set it.

- **The launcher defaults `AW_DEPLOYMENT_DEFAULT_MODELS` to
  `{"anthropic":"claude-sonnet-4-5","openai":"gpt-5.1"}`.** `applyLocalRuntimeEnvironment`
  (`packages/embedded/src/local-environment.ts`) sets it with `??=`, like `GATEWAY_PRICING_JSON`.
  It is a default, not a C1 fixed value: a value from `.env` or the environment wins, and an empty
  value turns the default off, so runs on a connection with no model are refused again.
- **Why these ids.** `claude-sonnet-4-5` and `gpt-5.1` are the models the setup wizard seeds
  (ADR-0030). The journey's fake Anthropic lists `claude-sonnet-4-5`, and real Anthropic accepts it;
  when its model list holds only dated releases, the newest `claude-sonnet-4-5-YYYYMMDD` is used.
- **Why per provider.** `aw dev` creates the `default` connection with provider `anthropic`, but it
  leaves an existing `default` connection alone, and a user may have created that one by hand with
  another provider. No id is set for `anthropic-compatible`, `azure-openai` or `openai-compatible`:
  their ids depend on the deployment, so a run on such a connection with no model is refused with
  `model_connection_unresolved`, naming the deployment layer.

Proof: `local-environment.test.ts` (the default is set, an existing value wins, an empty value is
kept) and `local-launcher.integration.test.ts`, where an agent pushed with `model: 'default'`
starts a run with `202` on `claude-sonnet-4-5`.

## Amendment (slice 2, 2026-10-03) — the start message's policy, and no secret in a forked environment (issue #522)

Reason: slice 2 of the delivery plan (§8) adds the
project's policy ceiling (SD5, contract C13) and secret references (SD17, contract C10). Both
reach the process boundary this ADR defines. The runtime's environment is built by
`applyLocalRuntimeEnvironment`, which refuses a value set by hand that conflicts with the start
message (`packages/embedded/src/local-environment.ts:72`, the `conflicting_value` message "… set
in the environment or .env to a value the local runtime cannot use; unset it, or change the
project file instead"). And `aw dev`'s supervisor forks the runtime with the whole environment,
`env: { ...io.env }` (`packages/aw/src/local-runtime/supervisor.ts:110-113`). On the `local`
driver an agent runs as the runtime's process, so a token in that environment is one `env` read
away.

This amendment records the decision and the units that implement it; none of it is built yet. On
the commit that records it, the `start` message schema in `@indx-workspace/contracts/local-runtime`
has no `policy` and no `withheld`, the supervisor still forwards the whole environment, and the
runtime loads the project's `.env` into its own environment after the fork
(`packages/embedded/src/local-launcher.ts:353-360`, `deps.loadDotEnv(dotEnv)` before
`applyLocalRuntimeEnvironment`).

- **The `start` message may carry `environment.policy` and `environment.withheld` (SD5, C13;
  SD17, C10).** The message becomes `{ type: 'start', projectDir, environment: { port,
  runtimeDriver?, bootstrapAdmin, policy?, withheld? } }`. `aw dev` sends `policy` only when
  `agent-workspace.yaml` has a top-level `policy`
  ([ADR-0103](0103-one-project-file-holds-every-environment.md), "Top-level `policy`"), validated
  with `ProjectPolicySchema`. The runtime writes it to `AW_DEPLOYMENT_POLICY` as canonical JSON.
  The server reads that variable once at startup: an invalid value stops the server with the
  variable named, and an absent value means no ceiling. The ceiling itself is
  [ADR-0102](0102-content-owners-edit-engineers-build-admins-narrow-stop-and-approve.md),
  "Slice 2 acceptance" (SD5). Changing the policy means restarting `aw dev`. `withheld` is the
  list of secret names described below, each matching the C10 grammar. It carries names only,
  never a value, and an older `start` message without it starts as before.
- **A hand-set `AW_DEPLOYMENT_POLICY` is parsed, and a differing one stops the runtime.** The
  runtime parses a value that the environment or `.env` sets with `ProjectPolicySchema`. A value
  that does not parse is refused with the variable named (`invalid_value`), whether or not the
  `start` message carries `policy`, so the runtime, not the server, is the first layer that
  refuses it. When `policy` is sent, the runtime compares the canonical JSON of the parsed
  hand-set value with the canonical JSON of the message's policy. A difference refuses startup
  with the variable named, on the same `conflicting_value` path it uses for a posture variable
  it cannot use (`local-environment.ts:72`); an equal policy starts, whatever its key order or
  whitespace. A value set by hand never silently beats the project file. With no `policy` in the
  start message, a valid hand-set value is passed through, because a deployment without a
  project policy may still be given a ceiling by whoever starts it. It is not silent: before it
  starts, the runtime writes `warning: AW_DEPLOYMENT_POLICY is set in the environment or .env and
  agent-workspace.yaml has no policy; that ceiling applies` to stderr, so a value left in `.env`
  after `policy` was removed from the project file is named on every start. Because the
  conflict rule applies only when `policy` is sent, `AW_DEPLOYMENT_POLICY` is not a C1 fixed
  value like `PORT` or `BOOTSTRAP_ADMIN`.
- **`aw dev` forwards no `secret()`-named variable to the runtime it forks (SD17, C10).** Every
  variable that a `secret('NAME')` or `{ secret: NAME }` in the project names is withheld from the
  supervised runtime's environment. Names are matched without regard to case, as the loader
  child's filter already is (`packages/aw/src/project/load.ts`, `childEnv`): on Windows
  `github_token` is the same variable as `GITHUB_TOKEN`. This replaces the whole-environment fork
  at `supervisor.ts:110-113`. The value reaches the server only in a connector or
  model-connection create or rotate request.
  - *Where the names come from at fork time.* `aw dev` forks the runtime before its first sync
    (`packages/aw/src/commands/dev.ts`: `superviseLocalRuntime` runs first, and `startDevSync`
    only in `onSignedIn`). So before the fork, `aw dev` loads the project once and takes the
    union of the `{ secret: NAME }` references in `agent-workspace.yaml` and the `secret()`
    calls that the definitions load returns. That union is the runtime's withheld set, and it is
    sent as `environment.withheld`.
  - *A name that a later save adds.* The runtime keeps the environment it was forked with. When
    a save names a secret that is not in the fork-time set, `aw dev` does not send its value. It
    withholds the name from every later loader child and prints one line, once, as built in
    #753 and amended by #755 (2026-10-06). When the variable is set in `aw dev`'s environment,
    the resource is applied from it and `aw dev` prints `<NAME> was in aw dev's environment when
    the runtime started; restart aw dev to withhold it from the runtime`. When it is unset, the
    resource is skipped as for a missing variable (C10) and the line is `<NAME> is not set: run
    export <NAME>=… in the shell aw dev started from, then restart aw dev`. A change to
    `policy`, `engine`, `environments.local.port` or `environments.local.runtime` prints
    `agent-workspace.yaml: <key> changed; restart aw dev to apply`, naming the key; `policy` has
    no live path (ADR-0113, SD3 amendment).
  - *The loader child.* Each loader child is forked without the profile `apiKeyRef`s, the
    `WITHHELD_ENV` names and every secret name known when it is forked: the YAML references,
    then the union of every load so far. A load learns its names only after its child has
    evaluated the code, so a name that appears only in a TS `secret()` call reaches the
    environment of the first loader child that evaluates it (declared gap below).
  - *The project's `.env`.* The runtime loads `.env` into its own environment after the fork,
    so filtering the fork alone does not keep a secret out of it. After `loadDotEnv`, the
    runtime refuses to start when its environment holds any name in `environment.withheld`
    (again without regard to case), with the variable named: `<NAME> is named by secret() and is
    set in .env; the local runtime holds no secret: remove it from .env and start aw dev with
    <NAME> in its environment`. The supervisor already withheld the name, so a value found there
    came from `.env`. `aw` reads only `process.env[NAME]` (C10) and never `.env`, so without
    this refusal a secret kept only in `.env` would be in the runtime and reported unset by `aw`.
  - *A name the runtime needs is not a secret name.* A reference may not name a variable that
    the local runtime itself sets or reads, because withholding it would break the runtime in an
    unrelated way. Contracts export one reserved list, matched without regard to case: the C1
    set (`HOST`, `AW_DEPLOYMENT_POSTURE`, `AW_LOCAL_SURFACE_SESSIONS`, `PORT`,
    `BOOTSTRAP_ADMIN`, `RUNTIME_DRIVER`, `WORKSPACE_SLUG`), `AW_DEPLOYMENT_POLICY`, the other
    names that `applyLocalRuntimeEnvironment` writes (`NODE_ENV`, `MIGRATIONS_DIR`,
    `GATEWAY_PRICING_JSON`, `AW_DEPLOYMENT_DEFAULT_MODELS`), the names that `applyLocalSecrets`
    writes (`SESSION_SECRET`, `MASTER_ENCRYPTION_KEY`, `GATEWAY_TOKEN_SECRET`,
    `BOOTSTRAP_ADMIN_PASSWORD`), `DATABASE_URL`, the process variables `PATH`, `HOME`,
    `USERPROFILE`, `SYSTEMROOT`, `TEMP`, `TMP`, `TMPDIR` and `NODE_OPTIONS`, and every name that
    starts with `AW_`. A reference that names one is refused at its path with the typed schema
    error `<NAME> is a variable the local runtime uses; name the secret something else`, in YAML
    and in TS alike.

Implemented by:

- **S2-01a** (contracts): the `policy` and `withheld` fields of the `start` message,
  `ProjectPolicySchema`, and the reserved list in the secret-reference schema. Tests: a `start`
  message parses with and without each field, and a value in `withheld` is refused; a reference
  to `PATH`, `port` or `AW_ANYTHING` is refused at its path with the message above, and one to
  `GITHUB_TOKEN` is accepted.
- **S2-04a** (runtime: `local-environment.ts`, and the one stderr line in `local-launcher.ts`):
  the mapping, the parse and the canonical comparison, the pass-through warning, and the `.env`
  refusal. Tests in `local-environment.test.ts`: an invalid hand-set value is refused with the
  variable named, with and without `policy`; a differing one is refused; an equal one with a
  different key order starts; with no `policy`, a valid hand-set value is kept and the warning
  is returned; a `withheld` name that `.env` sets, in any case, is refused with the variable
  named; every name that `applyLocalRuntimeEnvironment` and `applyLocalSecrets` write is in the
  reserved list. `local-launcher.ts` is outside the plan's S2-04a Owns globs: either that one
  line is added to them, or S2-09a's supervisor prints the warning it is handed.
- **S2-09a** (`aw dev`): the load before the fork, `policy` and `withheld` in the `start`
  message, the case-insensitive filter on both forked environments, and the restart notice.
  Tests, asserted on the fork call: a name from a TS `secret()` and one from the YAML are absent
  from the runtime's environment, whatever their case; a save that adds a new name prints the
  restart notice and sends no value; a later loader child is forked without that name.

Declared gap: a secret named only in a TS `secret()` call reaches the environment of the first
loader child that evaluates it, because the name is known only after that child answers. The
loader child runs the developer's own definition code, exits after it answers and runs no agent.
The supervised runtime, where agents run, never holds the value.

## Context

The developer journey's first budget is ten minutes from `npx` to a branded widget that answers,
with no file edited by hand (the developer-platform developer journey, Phase A).
ADR-0103 (D9) decides that `aw dev` runs the control plane, the gateway and the runner in **one
process**, and that the embedded mode "becomes a published capability, not a contributor-only
one". Today that mode exists only in a clone of this repository:

- `packages/embedded` is `"private": true`, named `@agent-workspace/embedded`, and runs as
  `pnpm start:embedded`. It imports `@agent-workspace/core`, `gateway`, `runner` and `web`
  (`packages/embedded/src/workspace.ts:12-16`) and starts embedded PostgreSQL 17 on port 54329.
- It regenerates `SESSION_SECRET`, `MASTER_ENCRYPTION_KEY` and `GATEWAY_TOKEN_SECRET` on every run
  unless `.env` sets them (`workspace.ts:103-105`), while the database is persistent
  (`embedded-db.ts:31`). On a second start, anything encrypted under the first key cannot be read.
- The seed refuses to start without `BOOTSTRAP_ADMIN` (`packages/core/src/db/seed.ts:88-95`), and
  browser sign-in needs a hand-set `BOOTSTRAP_ADMIN_PASSWORD`. The mode works only after a
  hand-edited `.env`.
- The web server runs Next in development mode unless `NODE_ENV=production`
  (`apps/web/server/start.ts:25`). Six sites decide the deployment posture from `NODE_ENV`: the
  `local` runtime driver (`apps/web/server/composition/services.ts:303,344,374,375`), the engine
  images (`apps/web/server/engines/images.ts:68`) and loopback egress
  (`packages/core/src/net/egress-policy.ts:76`). A production Next build inlines
  `NODE_ENV="production"`, so a production-built runtime would lose the `local` driver and refuse
  its own loopback gateway.

The ADR-0082 amendment (issue #364) took the opposite direction for the CLI, at
`docs/adr/0082-the-sdk-packages-publish-under-indx-workspace-from-a-tag-with-provenance.md:143-144` (section "Amendment — the project CLI and `npm create`", second bullet; line numbers as of this commit):

> Publishing the server, or bundling it into the CLI, was rejected: the server is not a library
> and ships as images.

That clause was right for the CLI and stays right for it. It blocks D9, because a generated project
cannot run a process it cannot install.

## Decision

### What this supersedes, and what it keeps

This ADR supersedes exactly four clauses of the ADR-0082 amendment ("the project CLI and
`npm create`"), and each only as far as the local runtime described here needs:

1. **"Publishing the server, or bundling it into the CLI, was rejected"** (second bullet). The
   local runtime alone now publishes, as one bundled package; bundling it into the CLI stays
   rejected.
2. **"the development-only embedded workspace … moves to the private `packages/embedded` and runs
   from a clone as `pnpm start:embedded`"** (second bullet). `packages/embedded` becomes the
   public `@indx-workspace/embedded`. `pnpm start:embedded` stays as the contributor path, and the
   published `agent-workspace start` still refuses `--embedded`.
3. **"A generated `local` project depends on `@indx-workspace/cli` at the generator's own version
   and on nothing else"** (third bullet). This now holds only for the v1 Compose project that
   `create --cloud local` writes. The default v2 project depends on `@indx-workspace/aw`,
   `@indx-workspace/embedded` and `@indx-workspace/sdk` (see Consequences).
4. **"`publish-packages.mjs` refuses a tarball list that is not exactly the five in order"**
   (fourth bullet). The list becomes six: contracts, sdk, aw, cli, embedded, create.

Everything else in ADR-0082 stands:

- `aw`, `cli` and `sdk` depend on `contracts` (and, for `aw` and `cli`, `sdk`) only.
  dependency-cruiser keeps `aw-`, `cli-` and `create-depends-only` rules unchanged.
- Bundling the server **into the CLI or `aw`** stays rejected.
- Images stay the production path. The server is still not a library: the new package exports no
  importable API, only a launch entry that is resolved by path and forked.
- Server packages (`core`, `gateway`, `runner`, `web`, the engines) keep the third-party-owned
  `@agent-workspace` scope as private workspace names, and none of them is published.

### One package: `@indx-workspace/embedded`

`packages/embedded` is renamed `@indx-workspace/embedded` (directory name = npm name, ADR-0082 D1),
joins `PUBLISHED_PACKAGES` lock-step at `CONTRACTS_VERSION` (D3), and publishes in the order
contracts, sdk, aw, cli, **embedded**, create. Its `dist/` holds:

1. `dist/launch.js` — an esbuild bundle (a pinned build-time devDependency) of a new
   `src/launch.ts`. Every `@agent-workspace/*` workspace module is inlined, including the four
   engine packages that `apps/runner/src/engines.ts:60-63` imports dynamically. Every third-party
   package stays external and is an exact-pinned `dependency` of the package (`next`, `react`,
   `react-dom`, `pg`, `embedded-postgres`, the engine SDKs, OpenTelemetry and so on).
2. `dist/bin.js` — a three-line wrapper, guarded by `isMainModule`, that imports `./launch.js`.
   **`launch.js` is never `argv[1]`.** Inside the bundle, four main-module guards
   (`packages/gateway/src/index.ts:313`, `apps/runner/src/index.ts:298`,
   `packages/core/src/db/migrate.ts:224`, `packages/core/src/db/seed.ts:233`) compare
   `import.meta.url` with `argv[1]`; running the wrapper keeps every one of them false. A test
   asserts the rule, and the launcher refuses to run when `argv[1]` is the bundle.
3. `dist/web/` — the production Next build of `apps/web`, made with `next build --webpack` into a
   configurable `distDir` (`AW_NEXT_DIST_DIR`), plus a generated `next.config.mjs` and `public/`.
   Webpack externals resolve through ordinary Node resolution from the installed package.
4. `dist/migrations/` — copied; the launcher sets `MIGRATIONS_DIR` (`migrate.ts:71`).

The package's `exports` are `./launch` (→ `dist/bin.js`) and `./package.json` only. There is no
`.` export. `pack-packages.mjs` keeps its `FOREIGN_SCOPE` rule exactly as strict: the tarball,
including `dist/web/` and the packed `package.json`, must contain no `@agent-workspace/` string.

The workspace package cannot satisfy that rule with its own manifest: to inline `core`, `gateway`,
`runner`, `web` and the engines, `packages/embedded/package.json` has to name them as
`workspace:*` dependencies, and `pnpm pack` keeps every dependency field, `devDependencies`
included, in the packed manifest (`checkPackedManifest` reads the whole manifest). The package is
therefore **packed from a generated staging directory**, `packages/embedded/publish/`
(git-ignored, rebuilt by the package's `build`):

- the build writes `publish/package.json` from the workspace manifest's `name`, `version`,
  `license`, `repository`, `type`, `exports` and `bin`, plus a `dependencies` map holding exactly
  the third-party packages the esbuild metafile and the webpack externals leave external, each at
  the exact version the lockfile resolved. It has no `devDependencies`, `scripts`, `nx` or
  `workspace:` field;
- it copies `dist/`, `README.md`, `LICENSE` and `CHANGELOG.md` beside it;
- `pack-packages.mjs` runs `pnpm pack` in `publish/` for this one package, and the packed manifest
  goes through the same `checkPackedManifest`, `checkTarballEntries` and `checkDistContents` as
  every other package;
- a build test fails when an external import has no entry in the generated `dependencies`, or when
  an entry names a package nothing imports.

The workspace manifest itself stays `"private": true` under its new name, so it can never be
published by mistake; only the staging manifest is public. The first acceptance item of the
runtime unit is a measured gate: zero occurrences, and the packed and unpacked sizes recorded, from
which the size budget constant is set (ADR-0016: no invented numbers).

### `aw dev` resolves and forks it; it never imports it

`aw dev` runs inside a project. It finds the nearest `node_modules/@indx-workspace/embedded` above
the project directory and reads the `./launch` target from that package's `exports` with file-system
calls only — neither import nor module resolution, so `aw`'s dependency rule holds and
dependency-cruiser sees nothing. (As first accepted, this sentence named
`createRequire(<project>/package.json).resolve('@indx-workspace/embedded/launch')`; the amendment
"how aw dev finds the runtime" records why that changed.) It then:

- refuses, naming `aw init`, outside a project;
- refuses, printing the exact `npm install -D @indx-workspace/embedded@<v>` line, when the package
  is missing or its version is not `aw`'s own;
- forks the resolved path with stdio `['inherit', 'inherit', 'inherit', 'ipc']`, and forwards
  `SIGINT` and `SIGTERM`. The runtime stays one Node process (D9); `aw` is its supervisor.

The two processes speak a small protocol defined in `@indx-workspace/contracts/local-runtime` and
validated with Zod on both sides:

- `aw` → runtime: `{ type: 'start', projectDir, environment: { port, runtimeDriver?, bootstrapAdmin } }`;
- runtime → `aw`: `{ type: 'ready', url, contractsVersion }`, then
  `{ type: 'credential', token, expiresAt, workspaceId, workspaceSlug }`, or
  `{ type: 'failed', message }`.

(The slice-2 amendment, issue #522, adds an optional `policy` and `withheld` to `environment`,
withholds every `secret()`-named variable from the forked runtime's environment, and has the
runtime refuse a withheld name that the project's `.env` sets.)

### Local posture is decoupled from `NODE_ENV` and limited to loopback

- A new `AW_DEPLOYMENT_POSTURE=local|production` is read at the six posture sites. Its default is
  derived from `NODE_ENV`, so images and tests do not change.
- The launcher sets `NODE_ENV=production`, `AW_DEPLOYMENT_POSTURE=local`, `HOST=127.0.0.1` and
  `AW_LOCAL_SURFACE_SESSIONS=1` (the local surface bootstrap, see ADR-0105's slice-1 acceptance).
- Posture `local` is refused when `HOST` is not a loopback address. The runner and the gateway
  already bind `127.0.0.1` (`workspace.ts:126,132`).
- `startWeb` gains `{ dir, dev }`. The published launcher passes `dev: false` and `dist/web`. The
  contributor path, `pnpm start:embedded`, keeps Next development mode from `apps/web`.

### The first run needs no hand edit

1. `BOOTSTRAP_ADMIN` comes from `environments.local.identity.bootstrapAdmin` in
   `agent-workspace.yaml` (default `admin@localhost.test`).
2. On first start the launcher creates `.agent-workspace/`, writes `.agent-workspace/.gitignore`
   containing `*` **before** any other file, and then writes `.agent-workspace/local-secrets.json`
   (mode `0600`) holding
   `SESSION_SECRET`, `MASTER_ENCRYPTION_KEY`, `GATEWAY_TOKEN_SECRET` and
   `BOOTSTRAP_ADMIN_PASSWORD`. Later starts reuse it, which also fixes the key-regeneration defect
   for the contributor path. A value in `.env` still wins. The directory ignores itself, so the
   secrets stay out of git whichever entry point wrote the project: `create` writes a root
   `.gitignore`, but `aw init` writes only the three answer files and never touches one.
3. _(Replaced by the S1-21 amendment above.)_ Once the web server is up, the launcher calls an
   in-process `issueLocalUserToken` in `apps/web/server/cli-auth/local-credential.ts`: the
   existing device-flow repository calls `recordApproval`, `mintCliToken` and `exchange`, for the
   seeded administrator. There is no new route and no migration. `prepareDatabase` returns the
   seed's result so the ids are known.
4. _(Replaced by the S1-21 amendment above.)_ The token travels **only over IPC**, never to stdout
   or a file the launcher writes. `aw` stores it with its existing `saveStoredCredential` (`0600`),
   keyed by the local URL.
5. `aw`'s configuration gains one precedence step, after `AGENT_WORKSPACE_URL` and before the
   default profile: inside a directory with `agent-workspace.yaml`, the URL is
   `http://127.0.0.1:<environments.local.port | 3000>`. `aw me`, `aw check` and `aw push` then work
   with no flags.
6. _(Replaced by the S1-21 amendment above.)_ The launcher revokes the token on shutdown
   (`revokeByHash`). A crash leaves it valid until its 12-hour expiry.
7. The browser sign-in prints the administrator's e-mail and generated password once, on the first
   start, as `create` does today; later starts print the file's path. The one-time setup link is
   ADR-0107's U-2/U-3 and is not part of this decision.

### Installing the runtime

`embedded-postgres` stays an npm dependency, so its platform binary is installed from npm rather
than bundled. The generated project's `pnpm-workspace.yaml` answers every install script in the
runtime's dependency tree (the eight `@embedded-postgres/*` packages `true`, as at the repository
root), so `pnpm install` does not fail with `ERR_PNPM_IGNORED_BUILDS`. `npm install` runs install
scripts by default and needs nothing. The release smoke installs with `--ignore-scripts`, so its
boot check runs `npm rebuild` on the `@embedded-postgres/*` packages alone, which restores their
symlinks and runs no other package's script.

### The Owner's first publish is a declared gap

ADR-0082 D5 requires the first version of every new package to be published by hand by the Owner
before a trusted publisher can be configured. Until that happens, `npm create @indx-workspace`
from the public registry cannot install the runtime. CI proves the path from tarballs (and from a
local registry in the slice-1 exit test) only.

## Alternatives rejected

- **Bundle the server into `aw` or the CLI.** ADR-0082's reason holds: `npx aw` must stay small
  and must not carry the server.
- **An all-in-one container image for `aw dev`.** It needs Docker, starts slowly and has no host
  OS sandbox, against D9. It stays the future `aw dev --prod-like`.
- **Download the runtime from GitHub Releases or OCI on first run.** The repository is internal;
  it would be a second supply chain outside trusted publishing and lock-step, and offline use is
  worse.
- **Publish `core`, `gateway`, `runner` and `web` separately.** Eight public APIs with semver
  duties, and eight Owner first-publish bootstraps.
- **Next `standalone` output.** `npm pack` drops its nested `node_modules`, which duplicate what
  npm installs anyway.
- **Ship Turbopack output and re-create the `.next/node_modules` links at start.** It writes into
  the installed package. It is kept only as the fallback if the webpack build fails the
  feasibility gate, which would be a new decision.
- **Next development mode in the published runtime.** It needs the sources and TypeScript,
  compiles for minutes on the first request, and writes into `node_modules`.
- **A long-lived API key as the local credential.** It needs `apiKeyRef` plumbing and is not
  short-lived.
- **A loopback HTTP route that auto-approves a device code.** Any local process, or a DNS-rebound
  page, could mint tokens. In-process issuance over IPC has no network surface.

## Consequences

- A generated project depends on `@indx-workspace/aw`, `@indx-workspace/embedded` and
  `@indx-workspace/sdk` at one version, and `pnpm dev` / `npm run dev` is `aw dev`.
- The release builds `apps/web` in the publish job (installed with `--ignore-scripts`, Nx Cloud
  off), which lengthens the job and needs `--infra` approval.
- Two compilers exist until one is chosen: the images use Turbopack, the published runtime uses
  webpack.
- The ports stay fixed (3000, 4000, 8080, 54329) apart from `environments.local.port`; two
  projects cannot run `aw dev` at once, and `EADDRINUSE` is reported with the port. Configurable
  ports are a follow-up. (Superseded for PostgreSQL by the issue #556 amendment above: its port
  is 25432 by default, or `AW_DATABASE_PORT`.)
- The published runtime has no tenant isolation and the `local` driver runs commands as the user.
  The mitigations are the loopback-only bind, the posture refusal, and IPC-only token issuance.
  A security review of the package is part of its publishing unit; an audit record of local
  token issuance is a follow-up.
- Persisting `MASTER_ENCRYPTION_KEY` means data an earlier contributor run wrote under a random key
  stays unreadable; a one-time reset of `.agent-workspace/` may be needed, and the runtime unit's
  notes say so.
