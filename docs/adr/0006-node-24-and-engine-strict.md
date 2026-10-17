# ADR-0006 — Node 24 is the floor, enforced by `engine-strict`

Status: accepted
Date: 2026-09-03
Decided by: W0-INF-01 (Infra agent); promoted to programme level by the orchestrator
Scope: CI runner images, contributor toolchains, both container images
Task record: [W0-INF-01 · One Node version, stated in three places that
agree](W0-INF-01-supported-node-runtime.md) — it records what the three declarations say and how
they are kept in agreement; this record says why the floor is a security decision. Per
[ADR-0012](0012-reconciling-two-adr-series.md) neither subsumes the other, and this is the link
ADR-0012 asserted before it existed.

## Context

`package.json` declares `engines: { node: ">=24" }` and `.npmrc` sets `engine-strict=true`, so
`pnpm install` **hard-fails** on Node 22 LTS rather than warning. A verifier found this had been
chosen silently: it appeared in no PR body and no commit message, while constraining every
contributor and every CI runner image.

Node 24 is not arbitrary. Research note R-14 is scheduled to confirm spec A.11's claim that `fetch`
ignores proxy environment variables unless `NODE_USE_ENV_PROXY=1` on **Node 24+**, and the
`restricted` network policy of spec §15.2 rests on that mechanism. A wrong answer there silently
defeats egress control, and the failure is invisible from outside — which is why the version floor
is a decision and not a detail.

## Decision

Keep Node 24 as a hard floor with `engine-strict=true`. Pin CI to `node-version: 24`, and pin the
same major in `Dockerfile` and `runtime.Dockerfile` when Wave 1 creates them.

## Alternatives considered

- **Node 22 LTS floor, warn only.** Rejected: it makes the proxy mechanism conditional on whichever
  runtime a user happens to have, and spec §15.2 offers no way to tell that user their network
  policy is not being enforced. Silent downgrade is the one thing plan §9.3 gate 5 forbids.
- **`engines` without `engine-strict`.** Rejected: a warning that scrolls past is not a gate, and
  what it permits surfaces later as an unexplained proxy bypass rather than as an install error.

## Consequences

- Contributors on Node 22 LTS cannot install at all. Deliberate — the error is immediate and legible.
- If R-14 lands showing the proxy mechanism works on an earlier major, revisit this: the security
  argument disappears and only convenience remains.
