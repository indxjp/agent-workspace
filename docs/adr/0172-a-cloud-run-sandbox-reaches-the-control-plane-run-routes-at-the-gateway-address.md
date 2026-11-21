# ADR-0172 — A Cloud Run sandbox reaches the control plane's run routes at the gateway's internal address

Status: accepted
Date: 2026-11-21
Decided by: the implementing agent of issue #2415 (tracker #2383)
Amends: ADR-cloud-run-service-driver (what a sandbox is given), BYOC-P3-private-by-default (D-6, what
the one allowed address serves)
Scope: `packages/runtime/src/cloud-run-config.ts`, `packages/runtime/src/cloud-run-contract.ts`,
`packages/runtime/src/cloud-run-create.ts`, `apps/runner/src/manager-driver-cloud-run.ts`,
`apps/runner/src/manager-settings.ts`, `infra/terraform/gcp-cloudrun/network.tf`,
`infra/terraform/gcp-cloudrun/main.tf`

## Context

The runner in a sandbox reaches the control plane for two things, both through
`AW_SESSION_MIRROR_URL` and the run's own signed token:

- it mirrors the run's transcript to web's `/api/sessions/:id/state-entries`, `state-streams` and
  `state-blobs` (spec §14.9), which is what makes a session durable and resumable;
- the claude-agent-sdk engine offers `search_files` only when that link exists, and answers it from
  web's `/api/sessions/:id/file-search` (ADR-0147).

Compose, gcp-small, Azure Container Apps, the CLI template and the embedded launcher set the
variable. The `cloud-run-service` driver did not: a Cloud Run sandbox got only the egress proxy
variables and, for a tool host, its intake key. So on every gcp-cloudrun deployment (the Agent Store
staging stack, production later, and BYOC Google Cloud installs) sessions were not durable, and an
agent that answers from granted files could not search them (issue #2415).

A Cloud Run sandbox's network policy `none` is enforced by the VPC firewall of BYOC-P3 D-6: a sandbox
reaches exactly one address, tcp 80 on the gateway's regional internal Application Load Balancer, and
nothing else, Google's private ranges and every `run.app` host included. Web is not at that address,
so a variable alone would have pointed the runner at a host it cannot reach.

## Decision

1. **Web's four run routes are served at the gateway's internal address.** The internal load
   balancer's URL map sends the path templates `/api/sessions/*/state-entries`, `state-streams`,
   `state-blobs` and `file-search` to a serverless NEG for web, and every other path, the model API
   included, to the gateway as before. A sandbox reaches no other web route: not the browser API, not
   the transcript or attachment routes, not the sign-in pages.
2. **The firewall does not change.** The sandbox still reaches one address on one port. No new
   destination, no NAT, no Google range.
3. **Each sandbox is given the address.** The runner manager reads `RUNTIME_SESSION_MIRROR_URL` and
   the driver sets it on every agent sandbox as `AW_SESSION_MIRROR_URL`. The module sets it to the
   internal load balancer's URL. The driver refuses a URL that is not http(s), carries credentials,
   a query or a fragment and, when the egress proxy is configured, one whose host is not in the
   proxy bypass list, because a proxied sandbox would otherwise send its mirror calls to the proxy.
   The module's bypass is the same internal address, so `restricted` and `open` sandboxes reach the
   mirror directly too.
4. **The run token stays the gate.** A sandbox holds only the run's signed token, bound to its
   workspace, run and session, so through these routes it reaches only its own session. The
   `state-*` routes also accept a signed-in person's session (for the person's own sessions), which
   a sandbox does not have; `file-search` accepts the run token only. IAP sits on the external load
   balancer only and is not in this path. Web's ingress accepts the internal load balancer with or
   without a domain, because Cloud Run counts that traffic as internal.
5. **The mirror URL is an origin.** The driver refuses a URL with any path other than `/`: a base
   path would move the runner's requests off the four path templates, and they would fail at run
   time instead of at start-up.

## What `none` means on Cloud Run now

`none` is the model gateway and the control plane's run routes for that run, and nothing else.
Neither reaches the internet: both are this install's own services behind one private address. The
claim "a demo sandbox has no internet" stays true.

## Consequences

- On the next apply of the gcp-cloudrun module: a serverless NEG and a regional backend service for
  web are created, the internal URL map gains a host rule and a path matcher (an in-place update),
  and the runner manager gets a new revision with `RUNTIME_SESSION_MIRROR_URL`. No IAM binding, API
  or firewall rule is added, and no step needs a person.
- Sandboxes started after that revision mirror their transcripts and offer `search_files`. The
  configuration fingerprint is unchanged, so existing Test Runtime passes stay valid.
- The traffic between a sandbox and the internal address stays plain HTTP inside the VPC, as for the
  gateway (BYOC-P3); the per-run token it carries is short-lived and scoped to one run.

## Tests

- `packages/runtime/src/cloud-run.mirror.test.ts`: a `none` sandbox gets the mirror URL and no
  proxy; a proxied sandbox keeps the mirror host in `NO_PROXY`; malformed URLs, a base path and a
  host the proxy would carry are refused; no mirror configured sets nothing.
- `apps/runner/src/manager-start-cloud-run.test.ts`: the manager accepts the variable and refuses a
  malformed one or one the proxy would carry.
- `infra/terraform/gcp-cloudrun/tests/contracts.tftest.hcl`: the URL map routes exactly the four
  templates to web and everything else to the gateway, the firewall still allows only tcp 80 on the
  internal address, and the mirror host is the proxy bypass when sandbox internet is on.
