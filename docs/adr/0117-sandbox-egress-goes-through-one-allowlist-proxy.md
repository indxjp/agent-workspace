# ADR-0117 — Sandbox egress goes through one allowlist proxy

Status: accepted
Date: 2026-10-07
Decided by: the product owner (one egress proxy for every driver, tracker #780; issue #781 A1)
Scope: `packages/egress-proxy`, `egress-proxy.Dockerfile`, the release image plan (`infra/release/images.mjs`); the network policies of `packages/runtime` drivers (wired in #784, A4) and the `unrestrictedNetwork` permission (#785, A5)

## Context

A runtime profile's network policy is `none`, `restricted` (with `allowedDomains`) or `open`
(`RUNTIME_NETWORK_POLICIES`, `packages/contracts/src/runtimes.ts`). Two work today and the third is
refused:

- `none` is the internal `agent-egress` Docker network (or default-deny `NetworkPolicy` on
  Kubernetes) with the model gateway reachable.
- `open` is the whole internet. A shell-capable agent on `open` can reach the cloud metadata
  endpoint (`169.254.169.254`) and the host's LAN.
- `restricted` is refused by the Docker, Cloud Run, ACA and Kubernetes drivers
  (`packages/runtime/src/docker.ts`, `cloud-run.ts`, `aca-sessions.ts`, `kubernetes.ts`) because
  nothing can enforce a list of domains. "This agent may call only api.example.com" is not
  expressible.

Enforcing names in the network layer needs a different mechanism per platform (CNI FQDN policies,
VPC firewall tags, Container Apps egress rules), none of them common to all drivers. The Owner chose
one mechanism that behaves the same everywhere: a proxy.

## Decision

**1. One proxy, one session.** `packages/egress-proxy` is an HTTP forward and `CONNECT` proxy that
serves exactly one sandbox session. It is configured at start (`EGRESS_SESSION_ID`,
`EGRESS_ALLOWLIST`, optional `EGRESS_ALLOWED_PORTS`) and refuses to start on a missing or
malformed value. It uses the Node standard library only (`node:http`, `node:net`, `node:dns`);
there is no third-party runtime dependency, and no third-party proxy image is used.

**2. The sandbox has no other route.** A sandbox whose policy is not `none` may reach the gateway
and the proxy, and nothing else. The proxy is the only component with a route out. Whether that is
true is a property of the driver's topology (decision 7), not of the proxy; a driver that cannot
make it true keeps refusing the policy.

**3. Deny by default.** A request is allowed only when all of these hold, in this order:

1. the host is a well-formed ASCII DNS name or an IP literal (internationalised names arrive as
   punycode);
2. the port is in the port list (default `80` and `443`);
3. an IP literal is public unicast (decision 4);
4. the host matches the allowlist;
5. a name is resolved **once**, and every address it resolves to is public unicast.

Allowlist entries are an exact host (`api.example.com`), `*.suffix` (strict subdomains: it does not
match the apex, so `*.example.com` and `example.com` are separate entries) or `*` (every host, still
subject to the address rule). IP addresses are not allowlist entries.

**4. Refused addresses.** Regardless of the allowlist: IPv4 `0.0.0.0/8`, `10.0.0.0/8`,
`100.64.0.0/10`, `127.0.0.0/8`, `169.254.0.0/16` (which contains the metadata endpoint),
`172.16.0.0/12`, `192.0.0.0/24`, `192.168.0.0/16`, `198.18.0.0/15`, `224.0.0.0/4`, `240.0.0.0/4`;
IPv6 `::/96` (unspecified, loopback and IPv4-compatible), `fc00::/7` (unique local), `fe80::/10`
(link local) and `ff00::/8`; IPv6 is allow-only-global-unicast, so any address outside `2000::/3`
(plus `64:ff9b:1::/48` and `2001:db8::/32`) is refused as reserved. An IPv6 address carrying an IPv4 one (`::ffff:a.b.c.d`,
`64:ff9b::a.b.c.d`) is judged by the IPv4 address. A name that resolves to one refused address
among several public ones is refused whole: a name that points into the LAN is the attack, and
choosing the public record would hide it.

**5. Resolve once, dial the checked address.** The upstream connection goes to the address that
passed the check, never to the name, so a second DNS answer cannot rebind it to a private address
between the check and the connect. The allowlist matches the `CONNECT` authority or request host;
TLS is not intercepted, so the proxy cannot verify the SNI or the certificate name of a tunnel.

**6. Denials are typed and logged.** A refusal is `403` (`400` for a malformed request, `502` when
the name does not resolve) with the body `{"error":"egress_denied","reason":"<reason>"}`, where the
reason is one of `host_not_allowed`, `port_not_allowed`, `address_loopback`, `address_private`,
`address_link_local`, `address_unique_local`, `address_reserved`, `resolves_to_denied_address`,
`resolution_failed`, `bad_request`. Each denial writes one JSON line to standard output:
`{"event":"egress_denied","sessionId","host","port","reason"}`. The line carries no path, query or
header, which may hold credentials.

**7. Topology per driver.** The proxy runs as a sidecar or a per-session process where the
platform can make it the only route, and as a separate workload where it cannot.

| Driver                 | Proxy                                                                                                                                                        | Why                                                                                                                                                                                                           |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Docker                 | One proxy container per session, attached to the internal `agent-egress` network and to an external network. The sandbox is attached to `agent-egress` only. | An internal network has no route out, so the proxy container is the only way across.                                                                                                                          |
| Kubernetes             | One proxy pod and Service per session. The sandbox `NetworkPolicy` allows the gateway and the proxy Service only.                                            | A `NetworkPolicy` applies to a pod, so a sidecar in the sandbox pod shares the sandbox's network permissions and cannot be the only route.                                                                    |
| Cloud Run, ACA         | `restricted` stays refused. `open` is not made safe by a sidecar either.                                                                                     | Containers of one instance share a network namespace, so a sidecar cannot be the only route. A separate proxy service with the sandbox's VPC egress locked to it is the way forward; it is not designed here. |
| Local (`local` driver) | Unchanged. The driver documents that it can enforce nothing.                                                                                                 | A host process has the host's network.                                                                                                                                                                        |

**8. Policy meanings.** `none` is unchanged (the gateway only). `restricted` is the allowlist from
`allowedDomains`. `open` becomes "the public internet through the proxy" (`*`): the metadata
endpoint, loopback, the LAN and every other refused address are unreachable on `open` too.

**9. `unrestrictedNetwork`.** The `unrestrictedNetwork` permission (policy ceiling) decides how
wide a network policy a principal's sandbox may be given: without it, at most `restricted`; with it,
`open`. Both go through the proxy, and the permission never removes the refused addresses or the
proxy. The floor semantics (what a sandbox gets when the profile asks for more than the permission
allows) are implemented and finalised in #785 (A5).

## Non-goals

- Wiring the proxy into the drivers: #784 (A4).
- TLS interception, SNI or certificate checks, per-path or per-method rules, response filtering.
- Authentication of the sandbox to the proxy. The network topology of decision 7 is the boundary.
- Rate limiting and byte accounting.

## Consequences

- The release publishes one more image, `egress-proxy`, built from `egress-proxy.Dockerfile`. It is
  in the release plan (`infra/release/images.mjs`), so it is scanned, signed, attested and recorded
  by digest with the others. It runs as UID 1000 with a read-only root file system; it writes
  nothing to disk. The first `images-v*` release that contains it needs its GHCR package made public
  once (`docs/release/README.md`, Platform images).
- The image is not pinned by the generator (`packages/cli/src/release-images.json`) until a driver
  consumes it (#784); `create` does not resolve it yet.
- Only ports 80 and 443 are reachable by default; a profile that needs another port needs the
  port list, which A4 exposes.
- `packages/egress-proxy` has no consumer inside the repository until A4; its tests run the real
  server over local sockets with the resolver and the dialer injected.
