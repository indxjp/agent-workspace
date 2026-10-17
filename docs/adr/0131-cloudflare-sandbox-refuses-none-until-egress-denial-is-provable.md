# ADR-0131 — `cloudflare-sandbox` refuses `none` until egress denial is provable

Status: accepted
Date: 2026-10-09
Decided by: the issue #829 plan (slice "enforce `none` on Cloudflare"; also #832), reviewed in the pull request
Scope: `packages/runtime/src/cloudflare-sandbox.ts`, `packages/runtime/src/external/driver.ts`, `infra/cloudflare/sandbox-bridge/`, the `cloudflare` rows of `infra/tests/providers/`

## Context

After the Cloudflare lane started deploying and running (providers-live run 37878740518, main at
07ffc7af), `restricted-refused`, `open-refused`, `non-root`, `gateway-reachable` and `bridge-auth`
passed, and every egress row under `none` failed:

- `none-blocks-public` and `no-ipv6-egress`: the public IPv4 and IPv6 hosts completed a connect.
- `none-blocks-private`: the RFC 1918 and CGNAT targets connected and answered HTTP 520; the
  `-fronted` variants (gateway Host header, private address) answered HTTP 200.
- `none-blocks-cloud-metadata` and `metadata-is-per-vm-mmds`: `169.254.169.253` connected and answered 520.
- `no-ipv6-egress`: the ULA address connected.

The cause is not a missing switch. `SandboxNone` already starts with `enableInternet = false` and
`allowedHosts = [gateway host]` (`@cloudflare/containers@0.3.7` passes `enableInternet` to
`container.start`). Setting `allowedHosts` turns on outbound interception, and with
`interceptHttps = true` every outbound HTTP or HTTPS connection is terminated by Cloudflare's proxy
and handed to the library's `ContainerProxy`:

- a connect to ports 80 and 443 succeeds for any address; the 520 is the library's own
  `Origin is disallowed` answer, not a reached origin;
- the allow gate matches the Host header (or SNI), not the destination address, so a request to a
  private address carrying the gateway's Host passes it;
- the TLS handshake is completed by Cloudflare's interception CA, which the container trusts, so a
  handshake with the right SNI says nothing about the destination.

Cloudflare documents that with `enableInternet = false` only ports 80 and 443 are available
([outbound traffic](https://developers.cloudflare.com/containers/platform-details/outbound-traffic/),
checked 2026-10-09). It documents nothing about refusing the TCP connect, about matching on the
destination address, or about IPv6. `deniedHosts` is matched as hostname globs, so the always-denied
CIDRs of ADR-0120 LC4 match nothing.

ADR-0120's rule applies: a policy mode whose conformance lane fails is declared unsupported on that
provider, not passed with a weaker test.

## Decision

- **`cloudflare-sandbox` declares `networkPolicies: []`** and refuses `none`, `restricted` and
  `open` by name with `RuntimeRefusalError('network_policy_unsupported')` before the bridge is called.
- **The external driver refuses `none` for any provider that does not declare it**, also when a run
  has no run spec (which means `none`). E2B and Vercel declare `none`, so nothing changes for them.
- **The bridge keeps serving `none`**, with the per-policy container settings pinned by
  `containerSettings` in `bridge.ts` (`none`: `enableInternet = false`, `allowedHosts = [gateway]`;
  `open`: `enableInternet = true`). The manager does not depend on the bridge for policy; the bridge
  stays usable for the experiment below.
- **The lane reads an undeclared `none` like an undeclared `open` (F-lane-none, decided on #829).**
  A new `none-refused` row calls the real `create` under `none` and passes only when it throws
  `RuntimeRefusalError('network_policy_unsupported')`, returns no sandbox and makes no bridge call.
  Only on that proof do `none-blocks-public`, `none-blocks-cloud-metadata`, `none-blocks-private` and
  the `none` half of `no-ipv6-egress` read `n/a`; a created sandbox, another error or a timeout fails
  them. The rows not about `none` (`non-root`, `gateway-reachable`, `metadata-is-per-vm-mmds`,
  `bridge-auth`, `deadline`) run under `open` where `none` is not declared.
- **A provider that declares no network policy reads "no policy declared", not a failure (decided
  on #829).** `open` is not declared for Cloudflare: run 37878740518 showed the container reaching
  RFC 1918, CGNAT and `169.254.169.253` through the edge, so `open-blocks-private` and
  `open-blocks-cloud-metadata` do not hold either. A new `all-policies-refused` row calls the real
  `create` under `none`, `open` and `restricted` and passes only when each is refused as above.
  Only on that proof do the create-based rows (`non-root`, `gateway-reachable`, the `none-*` and
  `open-*` rows, `metadata-is-per-vm-mmds`, `no-ipv6-egress`, `deadline`) read `n/a`; any other
  outcome fails them. `bridge-auth` keeps its bridge half, which needs no sandbox (the bridge refuses
  an unauthenticated create, destroy and forward). `all-policies-refused` is `n/a` where a policy is
  declared, and no verdict for E2B or Vercel changes.

## Consequences

- The `cloudflare-sandbox` driver cannot create sandboxes. The Cloudflare host with Cloudflare
  Sandbox in ADR-0120's table is unusable until a follow-up re-declares `none`; the Cloudflare host
  with E2B is unaffected.
- The `cloudflare` job of providers-live reads `n/a` on the rows that need a sandbox, on the proof
  that every policy is refused, until F-LC4-open or F-LC4-none declares a policy and those rows run
  for real. A change that makes them pass by reading a 520 or a completed handshake as "blocked" is
  the loosening this ADR rules out.
- Follow-ups: **F-LC4-none** (a silent deny path, an address-level check against fronting, a
  decision on `interceptHttps` for non-gateway hosts; tried live first, `none` re-declared only after
  the lane passes strictly). F-lane-none is decided above.
- Rollback is a revert.

## Alternatives rejected

- **Flip `enableInternet`.** It is already `false`.
- **A catch-all outbound handler that resets instead of answering 520.** The library hands the
  handler a `Response`-shaped request, not the destination address, and TLS completes under
  `interceptHttps` regardless; unverified, so it cannot ship in a slice the lane must pass strictly.
- **Read a 520 as blocked in the lane.** It loosens the lane.
- **Refuse `none` in the bridge too (422).** It would stop the lane and the follow-up experiment from
  creating a sandbox at all.

## Amendment (BH061-029, 2026-10-12)

`create-agent-workspace --cloud cloudflare` and `defaultProfile` now write `runtime.default:
external` (E2B), not `cloudflare-sandbox`: while this ADR holds, the native driver runs no session,
so the default must be one that does. `cloudflare-sandbox` stays accepted for an operator who sets
it, and `agent-workspace doctor` still warns about it. When F-LC4-none passes and `none` is declared
again, the default can return to the native driver.
