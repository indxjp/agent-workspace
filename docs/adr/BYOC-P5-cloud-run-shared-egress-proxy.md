# ADR-BYOC-P5 — Cloud Run sandboxes reach the internet through one shared egress proxy VM with a signed credential

Status: accepted
Date: 2026-11-06
Decided by: BYOC Google Cloud phase P5
Amends: ADR-0117 (non-goal "Authentication of the sandbox to the proxy"; decision 7)
Scope: `packages/egress-proxy/**`, `packages/runtime/src/cloud-run.ts`,
`infra/terraform/gcp-cloudrun/**`, `packages/cli/modules/gcp-cloudrun/**`,
`apps/web/server/runtimes/network-policy.ts`

## Context

ADR-0117 puts one proxy per session beside the sandbox and says its network topology is the
boundary, so the proxy does not authenticate the sandbox. Cloud Run changes three things:

- A Cloud Run sandbox cannot have a sidecar proxy that is reachable only by it. Every sandbox shares
  the sandbox subnet, so one proxy VM serves all of them and the topology no longer says which
  session a request belongs to.
- Cloud NAT cannot be bound to one VM; it serves subnet ranges
  ("You can't choose specific VMs to be served by a Cloud NAT gateway").
- A subnet with Private Google Access carries traffic to public Google front-end addresses
  (`*.run.app`, `*.googleapis.com`) over the VPC, ahead of Cloud NAT, so Cloud Run would count a
  request through the proxy as coming from inside the VPC.

## Decision

1. **Shared mode.** The egress proxy image runs in `EGRESS_MODE=shared` on one Compute Engine VM in
   a managed instance group of one, autohealed on `/healthz`. Per-session mode is unchanged.
2. **A signed credential replaces the topology as the sandbox's identity.** The runner manager signs
   `{sid, exp, hosts}` with HMAC-SHA256 under a key in Secret Manager and hands the sandbox a proxy
   URL carrying it as `Proxy-Authorization: Basic`. The proxy checks the signature (canonical
   base64url only), then expiry, then the allowlist the credential names, and refuses everything
   else with 407 or 403. The private, link-local, metadata and Google private-access ranges are
   refused for every credential, `*` included (ADR-0117 decision 4 still applies).
3. **The credential lives as long as the runtime.** It is a static environment variable of the
   Cloud Run service, so its `exp` is the run's timeout plus 300 s (default 3600 s) and the runtime
   is reported not live once it passes; the runner manager then starts a new one.
4. **Placement.** The VM has no external IP and sits on its own subnet with Private Google Access
   off. The Cloud NAT gateway lists only that subnet. The reserved internal address is the instance
   template's `network_ip`, so the one VM the group ever creates takes it; the sandbox firewall
   allows tcp 3128 to that /32 and denies every other protocol and port to it. The proxy VM itself
   may not reach private ranges or the Google VIPs.
5. **Opt-in.** `gcp.sandboxInternet: true` creates all of it; without it nothing exists and Cloud
   Run keeps `none`. Web accepts `restricted` on `cloud-run-service` only when the proxy is
   configured, and never lowers to `open`.

## Consequences

- One shared failure domain: the proxy VM is a single point of failure for `restricted` and
  `open` runs. Autohealing replaces it in place under the same address.
- The signing key is shared by the runner manager and the proxy. Rotation is a new secret version
  followed by a redeploy; credentials signed with the old key are refused.
- The idle-cost line gains a VM and a NAT gateway.
- Not covered: TLS interception, per-path rules, and DNS exfiltration through the metadata
  resolver (unchanged from P4).
