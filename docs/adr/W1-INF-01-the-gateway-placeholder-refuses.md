# W1-INF-01 — The gateway placeholder answers 501 to everything, and builds from none of our source

Status: accepted
Date: 2026-09-03
Decided by: W1-INF-01 (Infra)
Scope: `compose.yaml`, the `gateway` service; binding on W4-GW-*

## Context

Spec §32 lists `Gateway` among Simple Mode's components and §33 counts it among the five services a
normal single-node deployment has. The model gateway itself — §9's provider routing, §10's provider
architecture, §11's Anthropic-to-non-Anthropic translation, §26's per-run authentication — is
Wave 4. `packages/gateway/src/index.ts` is a placeholder module that exports a constant.

So `compose.yaml` has to list a fifth service that does not exist yet. There are several ways to do
that and most of them are lies of different sizes.

## Decision

**A stock `node` image running a script written inline in `compose.yaml`, which answers
`501 not_implemented` to every path and every method, with a body naming the spec sections and the
wave that implements it, and logs a banner on start-up saying it is not a model gateway.**

Three properties, each chosen against a specific way of being wrong:

**It refuses, positively.** Not a sleeping container, not a 200, not a 404. ADR-0015 — a capability
is supported because a scenario passed, never because nothing failed. A placeholder that answers
`200` to `/healthz` and nothing else would let a later task point a client at it, get a plausible
response, and discover months later that nothing was ever routed. A `501` with a named code is the
one answer a caller cannot misread.

**It builds from none of this repository's source.** `packages/gateway` is not compiled into it and
not mounted into it. There is therefore no file anywhere in the tree that looks like a gateway
implementation, and no build target that would quietly start succeeding if someone put a stub in
`packages/gateway`. Wave 4 replaces this block with a real build; until then the absence is
structural.

**It has no healthcheck, and nothing depends on it.** A green `healthy` beside `gateway` in
`docker compose ps` would be this file telling the operator the gateway works. `depends_on` is
empty for it, so no service can start believing it is there.

## Alternatives rejected

* **Omit the service and ship four.** Cleanest file, and it makes §32's component list wrong and
  §33's five into four with no explanation. It also hides the gap: an operator reading
  `compose.yaml` would have no reason to know a gateway is meant to exist.
* **A container that sleeps.** `docker compose ps` shows it `Up`. That is the misleading state this
  decision exists to avoid.
* **Build `packages/gateway` and serve whatever it exports.** Turns a placeholder package into a
  running service and makes the emptiness a runtime discovery instead of a compile-time one.
* **`nginx` returning 501 from a config.** Fewer moving parts than a Node script and one more image
  to pull and pin, for a service whose entire job is to say "not yet".
* **Answer `503 Service Unavailable`.** Defensible, rejected: `503` means *"this exists and is
  temporarily down"*, which is exactly the wrong impression. `501 Not Implemented` means the server
  does not support the functionality required, which is the literal truth.

## Honest downside

**A script embedded in a YAML string is not a nice place to keep code.** It cannot be linted,
tested or type-checked, and the YAML folding rules mean a `//` comment inside it would swallow the
rest of the line. That is tolerable for about twenty lines whose only job is to be deleted in Wave
4, and it would not be tolerable for anything that grew.

**`compose.yaml` now pins a third image tag** (`node:24.19.0-bookworm-slim`) that has nothing to do
with the product, and it must be kept in step with the Node version in the two Dockerfiles by hand.

**Nothing enforces that Wave 4 removes it.** If W4-GW-* lands a real gateway beside this block
rather than in place of it, the deployment would have two. Stated here rather than gated, because
the gate would have to live in a file this task does not own.
