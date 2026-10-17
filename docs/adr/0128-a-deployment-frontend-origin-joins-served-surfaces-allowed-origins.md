# ADR-0128 — A deployment's frontend origin joins the served surfaces' `allowedOrigins`

Status: accepted
Date: 2026-10-08
Decided by: the issue #830 plan (E5, slice 4), reviewed in the pull request
Scope: `packages/cli/src/deploy/vercel.ts`, `apps/web/server/surfaces/public/composition.ts`, `packages/runtime/src/vercel-sandbox.ts`, `packages/runtime/src/external/driver.ts`, `apps/runner/src/manager.ts`

## Context

[ADR-0126](0126-vercel-gateway-and-manager-are-functions-and-the-manager-seals-its-handles.md)
deploys the project's `web/` Vite app as its own Vercel project. The browser calls the control plane
from that project's domain, and CORS answers only the origins a surface lists in `allowedOrigins`. Until
now the operator had to list the frontend's origin by hand, after `aw deploy` and before the first
visitor, and `aw deploy` only printed a hint saying so.

The same slice closes two gaps in the stateless manager of ADR-0126: two concurrent allocations for one
session could delete each other's live sandbox, and an expired handle answered `404` where the runtime
contract answers `{ "live": false }`.

## Decision

- **One variable, written by the CLI.** After `vercel deploy --prod` of the frontend succeeds, `deploy`
  sets `AW_FRONTEND_ORIGIN` in the control plane's Vercel project, through the same `inspectPart` and
  `configurePart` that write every other variable. An existing value is left as it is, so a re-deploy
  writes nothing. The frontend is deployed before the control plane, so the control plane's deployment
  already reads it.
- **Only an origin Vercel names.** The origin is `https://<project>-web.vercel.app`, known from the
  project's name. It is written only when `vercel inspect <deployment url>` of the deployment just made
  lists that exact origin as a whole token. The deployment URL is the last line of `vercel deploy`'s
  stdout and must be a bare `https://*.vercel.app` origin without credentials. Anything else writes
  nothing and prints how to list the origin by hand. Never a wildcard and never taken from `.env` or
  other input.
- **The control plane merges it.** `withDeploymentOrigin` adds the origin to the `allowedOrigins` of
  every surface it serves from `production`, including a pinned version's. A draft served from
  `local` (the try page, or an agent not promoted yet) is never widened, so it keeps only the
  origins it lists itself. It is added only if
  `SurfaceAllowedOriginsSchema` accepts it and it is `https://`; otherwise it is ignored with a
  warning, which does not echo the value, each time a surface is resolved. A surface that already lists it is unchanged.
- **Stateless create is idempotent per session.** With a `lookupKey`, the Vercel sandbox provider
  creates the sandbox named `aw-<lookupKey>`. It reads the name first: a usable sandbox is reused; a
  `stopped` one is deleted and created again; any other state (`pending`, `stopping`, a failed read of
  its routes) is waited out, one second at a time, up to 30 times, then `create failed`. A `409` on the
  create means another allocation won the name, and the loop reads it again. A sandbox is deleted only
  when it was read as `stopped` or when our own start-runner step failed. The manager's `/healthz` wait
  covers reuse of a half-started sandbox. The handle's `expiresAt` is the provider's when it reports one.
- **An expired or unknown handle is `{ "live": false }`.** `GET /runtimes/:id` of a stateless manager
  answers `200 { "live": false }` when the handle does not open to a sandbox. Run, interrupt, files and
  `DELETE` of such a handle, and every request of a stateful manager, keep `404`.

## Consequences

- Every served surface of the project admits the project's own frontend. A surface with no
  `allowedOrigins` before now has one, so it also gets the default turn cap
  (`DEFAULT_TURNS_PER_CONVERSATION`, `limits.ts`) and is no longer same-origin only. To stop it, remove
  the variable (`vercel env rm AW_FRONTEND_ORIGIN production` in the control-plane project) and deploy
  the control plane again.
- A custom domain for the frontend is not covered; it is listed in `allowedOrigins` as before, and the
  `aw deploy` hint says so.
- If the `vercel inspect` output changes shape the origin is not written and the operator is told. This
  fails closed.
- Deleting a `stopped` sandbox after a separate read has a window of one round trip in which another
  allocation could reuse the name. The provider offers no conditional delete, so this is a ceiling, noted
  in the code.
- A create whose response is lost on the wire leaves a sandbox that the next create for the session
  reuses or waits out; it is not deleted.
- The E2B driver's stateless create is not yet made idempotent.

## Vendor facts

Checked 2026-10-08. [`vercel deploy`](https://vercel.com/docs/cli/deploy) prints the deployment URL on
stdout, the per-deployment URL and not the production domain. [`vercel inspect`](https://vercel.com/docs/cli/inspect)
takes a deployment URL; its output format is not documented. The Vercel Sandbox REST API:
`POST /v4/sandboxes` lists a `409` response without a description (read here as "name taken"),
`GET /v2/sandboxes/{name}` returns the status (`running`, `stopping`, `stopped`), `currentSessionId` and
`expiresAt`, and `DELETE /v2/sandboxes/{name}` removes it. None of this has run against a real account;
the live lane of #832 proves it.
