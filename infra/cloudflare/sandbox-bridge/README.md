# Cloudflare sandbox bridge

The Worker behind the `cloudflare-sandbox` runtime driver (ADR-0120 LC1-LC4, LC6). Cloudflare
Containers are driven from a Worker through Durable Objects, so the runner manager reaches them
through this bridge. It uses the Containers `Container` class, not `@cloudflare/sandbox`
(ADR-0120 LC2). **Not yet verified live**: no deployment has been exercised against a real account
(see the live lane below).

| File                  | Role                                                                                 |
| --------------------- | ------------------------------------------------------------------------------------ |
| `src/bridge.ts`       | Routes, validation and constant-time authentication. No Cloudflare imports; unit-tested. |
| `src/worker.ts`       | The entry: two Container classes (`none`; `open`, unused: refused) and the bindings. |
| `wrangler.jsonc`      | Deployment config with two `REPLACE_*` values.                                       |

## Protocol

| Route                                       | Credential                         |
| ------------------------------------------- | ---------------------------------- |
| `POST /v1/sandboxes`                        | `Authorization: Bearer <BRIDGE_SECRET>` |
| `DELETE /v1/sandboxes/{id}`                 | `Authorization: Bearer <BRIDGE_SECRET>` |
| `ANY /v1/sandboxes/{id}/runtime/{path}`     | `x-bridge-access` for `{id}`, plus the per-sandbox bearer the runner server requires |

Every credential is compared in constant time (both sides hashed to a fixed width first). The access
token is `HMAC-SHA256(BRIDGE_SECRET, id)`, returned by create, so the manager keeps no bridge secret
after the call. Credentials are checked before the route, method or sandbox id is looked at (a
forward needs the access header and a bearer), so an unauthenticated caller gets 401 for every path
and never learns whether an id exists. A refused call gets `401 {"error":"unauthorized"}` and never echoes input.

The image and the gateway host are fixed per deployment (`RUNTIME_IMAGE`, `GATEWAY_HOST`); a create
naming another gets `409`. Pin the image by digest. The bridge also refuses `open` and `restricted` with `422`
(ADR-0120 LC4).

The bridge still serves `none` (the `SandboxNone` class starts with `enableInternet = false` and the
gateway as the only allowed host), but the `cloudflare-sandbox` driver does not offer it: Cloudflare
filters outbound traffic in an L7 proxy that accepts TCP on ports 80 and 443 and gates on the Host
header, so the live lane could not show that `none` holds (ADR-0131,
[outbound traffic](https://developers.cloudflare.com/containers/platform-details/outbound-traffic/),
checked 2026-10-09). The driver declares no network policy, so the lane proves `none`, `open` and
`restricted` refused (`all-policies-refused`) and its create-based rows read `n/a` until a silent
deny path is proven.

## Deploy and remove

`@cloudflare/containers` is a pinned root devDependency (so `tests/no-sdk-import.test.ts` can resolve
the Worker's import); `pnpm install` at the repository root provides it:

```sh
pnpm install
cd infra/cloudflare/sandbox-bridge
# fill REPLACE_RUNTIME_IMAGE and REPLACE_GATEWAY_HOST in wrangler.jsonc
npx --yes wrangler@4.147.0 deploy
openssl rand -base64 36 | npx --yes wrangler@4.147.0 secret put BRIDGE_SECRET   # stdin, never argv
npx --yes wrangler@4.147.0 delete                                                # remove the Worker
```

Rotate the secret by putting a new `BRIDGE_SECRET` (existing sandboxes' access tokens stop working;
they are session-lived). The runner manager is configured with `RUNTIME_DRIVER=cloudflare-sandbox`,
`CLOUDFLARE_SANDBOX_BRIDGE_URL` (https) and `GATEWAY_PUBLIC_URL`, but until ADR-0131's condition is
met (a live run proves egress denial and the driver declares `none` again) that driver refuses every
session: a Cloudflare host runs sessions with the E2B sandbox (`RUNTIME_DRIVER=external`).

## Live lane

The `cloudflare` job of `.github/workflows/providers-live.yml` (`infra/tests/providers/`) deploys this
Worker to a throwaway name, proves every policy refused before any sandbox or bridge call (while
the driver declares none, it creates no sandbox), shows an unauthenticated call is refused, then
deletes the Worker. It reads
`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` only in that job, and reports every check as
`skipped` when they or `CLOUDFLARE_PROBE_IMAGE` are absent.
