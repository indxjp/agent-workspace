# ADR-0126 — On Vercel the gateway and the runner manager are Vercel Functions, and a stateless manager seals its handles

Status: accepted
Date: 2026-10-08
Decided by: the issue #830 plan (E5, slice 3), reviewed in the pull request
Scope: `packages/runtime/src/external/stateless.ts`, `packages/runtime/src/external/driver.ts`, `packages/runtime/src/external/e2b.ts`, `packages/runtime/src/vercel-sandbox.ts`, `apps/runner/src/manager.ts`, `apps/runner/src/manager-start.ts`, `apps/runner/src/manager-function.ts`, `apps/runner/src/api/`, `packages/gateway/src/vercel-function.ts`, `packages/gateway/src/api/`, `packages/cli/src/deploy/vercel.ts`, `packages/cli/src/deploy/project.ts`, `packages/cli/src/render/vercel.ts`, `packages/cli/src/render/env.ts`, `packages/contracts/src/project-file.ts`

## Context

[ADR-0120](0120-vercel-and-cloudflare-are-deployment-clouds-with-native-sandboxes-and-e2b-is-a-sandbox-only-provider.md)
clause LC7 decides that on Vercel the gateway and the runner manager are Vercel Functions, that the
manager keeps no allocation table and finds a session's sandbox by a provider lookup keyed by the
session key, that the bearer is re-derivable (LC3) and that the provider key is sent per call and
never stored (LC6). LC9 makes the project's own frontend a second Vercel project whose `baseUrl` is
the control plane. It leaves open what a function is packaged as, what the lookup returns, how the
manager hands a handle to the control plane without a table, and how the pieces find each other.
Slices 1 and 2 (#859, #863) shipped the profile, the control-plane project, the Cron route and the
migrate-once step.

## Decision

1. **One Vercel project per part.** `<name>` is the control plane (`apps/web`), `<name>-gateway` is
   `packages/gateway`, `<name>-manager` is `apps/runner`, and `<name>-web` is the project's own
   `web/` Vite app, present only when the project has one. A function project has a one-file entry,
   `api/index.js`, that re-exports the package's compiled `tsc` build; the gateway's is a Web `{ fetch }` export,
   the manager's a Node `(req, res)` export. Every path is rewritten to that entry and
   `functions['api/index.js'].maxDuration` is 300 s. `render` writes the settings of each as
   `deploy/vercel/{gateway,manager,frontend}.json` and `deploy` passes them with `--local-config`.
   The Root Directory of each project is set by `deploy` (see Amendment).
2. **The manager is stateless when its driver can recover a sandbox.** `RUNNER_MANAGER_STATELESS=true`
   (set by `deploy`) requires the `external` or `vercel-sandbox` driver and is refused by name for
   any other. The driver gains an optional `find(sessionKey)`; the manager asks it before it
   allocates, so a repeated allocate for a live session returns the same sandbox.
3. **Handles are sealed, not stored.** HKDF-SHA256 over `RUNNER_MANAGER_TOKEN` (at least 32
   characters; salt `agent-workspace/external`) gives a seal key (`seal v1`) and a MAC key
   (`lookup v1`). `lookupKey = HMAC(macKey, "lookup\n<driverId>\n<sessionKey>")`, base64url; the
   bearer is `HMAC(macKey, "bearer\n<lookupKey>")` and is never stored, sealed or returned. The
   handle id the control plane keeps is `s` + base64url(IV | AES-256-GCM ciphertext | tag) with the
   driver id as additional authenticated data, so a handle cannot be moved to another driver. The
   sandbox carries `lookupKey` as its Vercel name (`aw-<lookupKey>`, deleted before it is created) or
   its E2B metadata (`awKey`), and `find` reconnects by it. A sealed id is opaque to the control
   plane, which treats it like any other handle id.
4. **Wiring.** The control plane reads `MODEL_GATEWAY_URL` and `RUNNER_MANAGER_URL`. `deploy` sets
   them to `https://<name>-gateway.vercel.app` and `https://<name>-manager.vercel.app` unless `.env`
   gives an https origin (a custom domain), which is refused by name if it is not one. The gateway
   receives the database, master-key and token-secret variables it reads and no other; the manager
   receives its token, driver and provider settings, `GATEWAY_PUBLIC_URL`, and `AW_VERCEL_TEAM_ID`
   for `vercel-sandbox`. Neither receives the other's variables. The manager reads
   `AW_VERCEL_TEAM_ID` and `AW_VERCEL_PROJECT_ID` before `VERCEL_TEAM_ID` and `VERCEL_PROJECT_ID`.
   Tokens are passed to the Vercel CLI through the child environment, values on stdin, credentials
   as `--sensitive`.
5. **Order.** `deploy` validates everything, inspects each project, configures all of them, runs
   the migrate-once step, then deploys the gateway, the manager, the control plane and the frontend,
   so that a failed migration deploys nothing and a function is live before the control plane that
   calls it.
6. **The frontend.** `aw deploy` passes the project's `CONTROL_PLANE_URL` and its `web/` directory to
   the Vercel target, which sets `VITE_AW_BASE_URL` on `<name>-web` and deploys it. The browser's
   origin must be listed in the surface's `allowedOrigins`; the CLI cannot edit surface code, so
   `aw deploy` names the origin to add rather than writing it.
7. **Release pin.** `.env` records `AGENT_WORKSPACE_VERSION`, the release `WEB_IMAGE` was resolved
   for. `deploy` refuses by name a source checkout at another version, because migrations run from
   the image and the code from the checkout.
8. **The project file** records `target: vercel` beside `single-vm`, `gcp-cloudrun` and `kubernetes`.
9. **Tool sandboxes are not offered.** The stateless manager answers a tool-sandbox allocation with
   `503` (a code-tool run needs the long-lived sandbox origin that a Function cannot be);
   unchanged from ADR-0120.

Vendor facts, checked 2026-10-08: Vercel Functions duration
(https://vercel.com/docs/functions/configuring-functions/duration), project configuration and
`--local-config` (https://vercel.com/docs/project-configuration,
https://vercel.com/docs/cli/deploy), system environment variables
(https://vercel.com/docs/environment-variables/system-environment-variables: `VERCEL_PROJECT_ID` is
available only with "Enable access to System Environment Variables", and there is no team id), the
Sandbox API (https://vercel.com/docs/vercel-sandbox), E2B's sandbox listing and connect
(https://e2b.dev/docs/sandbox/persistence, https://e2b.dev/docs/sandbox/list).

## Alternatives

- **One Vercel project with Services.** Vercel runs none; one project per part is what the CLI can
  create and deploy today.
- **A table in the database.** It would work, but the manager would need a database credential and
  a migration (0048+) for a lookup that the provider can answer. LC7 chose the provider lookup.
- **Return the sandbox id as the handle.** It would need the control plane to hold a provider id the
  manager cannot verify; a sealed id is authenticated, and the sandbox name or metadata is derived
  from a secret an observer cannot compute.
- **A dedicated seal key.** A second secret to generate, store and rotate. Deriving both keys from
  `RUNNER_MANAGER_TOKEN` with distinct HKDF labels is one secret; rotating it invalidates sealed
  ids, which re-allocate (open question below).
- **Write `allowedOrigins` from `deploy`.** Surfaces are project code (ADR-0108); the CLI must not
  rewrite them. Naming the origin keeps the file the project's.
- **Set the Root Directory from the CLI.** The CLI had no flag for it, and a project setting through
  the REST API would add an HTTP client to the deploy target. Superseded: see Amendment.

## Consequences

- No route is added or changed, so the formal authorization model is unchanged; no migration; no
  dependency.
- A Vercel deployment can now run an agent end to end in principle. It is not claimed to: the
  secrets-gated live smoke (E7 #832) has not run, and `guides/deploy-vercel.mdx` waits for it.
- Rotating `RUNNER_MANAGER_TOKEN` changes the bearer and every lookup key: running sessions' sandboxes
  are no longer found and the next allocation creates new ones.
- A sealed id cannot be revoked before the sandbox's own expiry.
- Two allocations of one session at the same instant can collide on the deterministic name.
- Unverified live, recorded here and in the pull request: the function-only project settings as
  they stand after #915 and #917 (`framework: null`, a scoped install, a `buildCommand` ending with
  `public/robots.txt`, and the rewrite to the function) deploying and serving requests on Vercel,
  the Node helpers' handling of the request body in
  the manager function, the 4.5 MB request-body limit, `<name>.vercel.app` as the production domain
  (`.env` overrides it), Deployment Protection on default domains, whether user variables with a
  `VERCEL_` prefix are reserved (hence the `AW_` names), and the E2B `connect` timeout semantics.
- Follow-ups under #830: the live smoke, the guide, and one duration setting for the Pro tier.

## Amendment — `deploy` sets the Root Directory and stages the function entry (issue #830, 2026-10-09)

The first live build of the gateway failed with ``The pattern "api/index.ts" defined in `functions`
doesn't match any Serverless Functions inside the `api` directory``: `deploy` uploads a staged
monorepo root, Vercel matches `functions` against the project's Root Directory, and the entry sits
at `packages/gateway/api/index.ts`. Clause 1's "the operator sets the Root Directory to
`packages/gateway` and `apps/runner`" is replaced:

- **Gateway and manager:** the Root Directory is the upload root, so the root-relative
  `installCommand` and `buildCommand` keep working. The install is scoped to the package and what
  it needs (`pnpm install --frozen-lockfile --filter "{./packages/gateway}..."`), so a part does not
  install the whole workspace. The braces matter: pnpm reads `./packages/gateway...` as the package
  alone, so the workspace packages whose `dist` the function imports would not be built. The build
  runs `pnpm --filter "{./packages/gateway}..." run build` and
  ends by creating the declared `outputDirectory` (`public`) with a `robots.txt` that disallows
  all crawling in it, because Vercel fails a deployment whose Output Directory is missing or empty.
  A static file wins over a rewrite, so only `/robots.txt` is shadowed; every other path still
  rewrites to the function. `deploy` writes `api/index.js` at the upload root, an ESM re-export of
  the entry the package's own build compiles (`dist/api/index.js`, from `src/api/index.ts`), so the
  rendered `functions['api/index.js']` matches a file. The generated entry is JavaScript on
  purpose: Vercel's own TypeScript compile of the first generated `api/index.ts` failed with only
  `api/index.ts: Emit skipped` and no diagnostics (journey run 38009566248), although plain `tsc`
  emitted the same file, so Vercel now only bundles JavaScript and traces `dist` and
  `node_modules`. A checkout without the package's `src/api/index.ts` is refused by file name
  before any tool runs.
- **Control plane:** the Root Directory is `apps/web`, with source files outside it included,
  because it imports workspace packages. Their `exports` point at `dist`, so the rendered
  `installCommand` is `pnpm install --frozen-lockfile --filter "{.}..."` and the `buildCommand`
  builds the dependencies first, `pnpm --filter "{.}^..." run build && pnpm run build` (journey run
  38020201429: `Module not found` for `engine`, `gateway` and `runtime`). Both commands run in the
  Root Directory, so the filter is `{.}`, the package there; a `{./apps/web}` filter would match
  nothing, and the package name is not used because the published CLI bundle must not name a
  private package.
- **How:** on every apply `deploy` runs `vercel api /v9/projects/<name>?teamId=<team> -X PATCH
  --input -` with the body on stdin, so the token stays in the child's environment and no HTTP
  client is added. It runs after `project add` and before the project's variables are written, so
  a refused request leaves none of them behind. The call is idempotent and replaces a Root
  Directory set by hand. The frontend is not touched.
- `vercel deploy` is given `--cwd <staged>` and an absolute `--local-config`, so the CLI no longer
  runs in the project directory and no longer warns that `deploy/` is a subdirectory.

Vendor facts, checked 2026-10-09: `vercel api` sends an authenticated REST request with the CLI's
credentials and reads a body from stdin (https://vercel.com/docs/cli/api); `project update` has no
Root Directory flag (https://vercel.com/docs/cli/project). Unverified live: the `PATCH` body
(`rootDirectory`, `sourceFilesOutsideRootDirectory`, and `null`), how the Node builder resolves the
`.js` re-export to the `.ts` entry, and the Next.js build under `apps/web`.
