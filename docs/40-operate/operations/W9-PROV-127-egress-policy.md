# Egress policy for provider endpoints (`#127`)

Every server-side request this platform makes to a model provider — the model-connection
probe (`apps/web/server/models/probe.ts`) and each gateway adapter under
`packages/gateway/src/providers/` — goes through one policy, `checkEgress`/`guardedFetch` in
`@agent-workspace/core` (`packages/core/src/net/egress-policy.ts`).

## What it refuses by default

Resolves the target host and checks **every** address DNS returns before the request is made.
Refused unconditionally, in production:

- loopback (`127.0.0.0/8`, `::1`)
- RFC1918 private space (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`)
- RFC6598 carrier-grade NAT space (`100.64.0.0/10` — this is also where Alibaba Cloud's
  `100.100.100.200` metadata endpoint lives)
- link-local (`169.254.0.0/16`, `fe80::/10` — this is also where AWS, GCP, Azure, and
  DigitalOcean's `169.254.169.254` metadata endpoint lives; no separate "metadata address" list
  is needed once link-local and RFC6598 are covered)
- IPv6 unique-local (`fc00::/7`)
- the IPv4-mapped IPv6 spelling of any of the above (`::ffff:127.0.0.1`, and so on)

`userinfo` in the URL (`https://user:pass@host/`) is refused outright, in every environment.
HTTPS is required, in every environment, with one exception below. Encoded IPv4 forms (octal
`0177.0.0.1`, decimal `2130706433`) are refused the same as the dotted form — the WHATWG URL
parser canonicalizes them before the policy ever sees the string.

## Environment variables

| Variable | Effect |
| --- | --- |
| `NODE_ENV=production` | Turns on the default-deny policy above and removes the loopback exception. Anything other than `production` (including unset) is treated as a development policy. |
| `EGRESS_ALLOW_HOSTS` | A comma-separated list of exact hostnames exempted from the address-range check — for an approved internal or self-hosted provider endpoint. Whitespace around each entry is trimmed; matching is case-insensitive. The allowlist does **not** waive the HTTPS requirement. |

## The local-fixture exception

Outside production (`NODE_ENV` unset, `development`, or `test`), a plain-`http:` request to a
loopback address is allowed. This is what lets the gateway providers' and the probe's own test
suites run a `node:http` fixture server on `127.0.0.1` without configuring anything. It is the
only exception to "HTTPS required" or to the loopback refusal, and it evaporates the moment
`NODE_ENV=production` is set — there is no separate "test mode" flag to leave on by accident.

## Redirects

Every request through `guardedFetch` is issued with `redirect: 'error'`: a 3xx response from the
upstream is refused, never followed and never inspected further. A provider credential attached
to the original request therefore never reaches a second origin named by a `Location` header.

## What this does not additionally guarantee

`docs/adr/W9-PROV-127-egress-policy.md` records the two gaps this task declares rather than
solves: G-1 (closing the practical DNS-rebinding window between check and connect, short of a
socket-level guarantee for every future call site) and G-2 (no dedicated security-audit-event
table; a refusal is only ever logged with the hostname and the rule that fired). Save-time
validation of a stored `baseUrl` is `#126`'s, built on this module.
