---
title: Cross-cutting concerns
evidence: [docs/architecture.md:518-646, apps/web/server/http/route.ts, apps/web/server/http/result.ts:1-10, apps/web/proxy.ts, apps/web/server/rbac/decide.ts, apps/web/server/composition/session-rbac.ts, packages/gateway/src/tokens/run-token.ts, packages/egress-proxy/src/address.ts, packages/core/src/net/egress-policy.ts, eslint-suppressions.json, docs/adr/0155-server-processes-log-json-lines-and-join-a-w3c-trace-for-correlation.md]
---

### Errors

Every owned JSON route builds its `{ error: { code, message } }` envelope in
`apps/web/server/http/result.ts`, rendered by `route()` in `http/route.ts`; the comment at the top
of `result.ts` lists the deliberate variants (public surface pages, versioning). Expected failures
carry a stable code from `packages/contracts`; infrastructure failures stay 5xx, keep their cause
for the log and never echo SQL, provider or credential text (checklist `expected-failures-are-typed`).
The SDK decodes the envelope into typed errors such as `ApiProblemError`.

### Trust boundaries and access

A request is checked three times, each for one thing: `apps/web/proxy.ts` checks that a credential
of the right shape is present and a cookie is validly signed; the route resolves the credential into
a `Principal` (`resolveActor`, `composition/session-rbac.ts`); `decide()` in `rbac/decide.ts` asks
the pure rules in `rbac/core/` whether that role may use the method on the path. Signing keys derive
from `SESSION_SECRET` with HKDF and a purpose label, so a token for one purpose fails every other.
Only `identity` imports `jose` and `openid-client` (`only-identity-verifies-oidc`).

Provider credentials never reach a sandbox. The runner receives a short-lived run token signed with
`GATEWAY_TOKEN_SECRET` (`packages/gateway/src/tokens/run-token.ts`), and the gateway swaps it for the
stored key. Sandbox egress goes through `packages/egress-proxy`, which refuses loopback, private,
link-local (including the cloud metadata address) and reserved ranges (`address.ts`).

### Input validation

HTTP bodies, provider JSON, environment values, persisted JSON and runner frames are `unknown`
until a Zod schema or a small predicate checks them. Owned APIs reject unknown keys; extensible
third-party protocols may keep them after the consumed fields are validated.

### Configuration

The environment is read once, in a composition root or a process entry point, and passed on as typed
values (checklist `environment-read-at-entry`). The files that still read `process.env` elsewhere are
the `no-restricted-properties` entries of `eslint-suppressions.json`, which may only shrink.
`AW_STORAGE_URL` is the one storage setting, parsed by `parseStorageUrl` for server and CLI alike.

### Observability

Web, runner and gateway log one JSON object per line through the `Logger` port in
`@agent-workspace/core/telemetry`, with fixed `msg` strings and redacted values. A W3C `traceparent`
travels from the web's span to the runner and on to the gateway with every model call; OpenTelemetry
export is on only when `OTEL_EXPORTER_OTLP_ENDPOINT` is set (ADR-0155). Only `persistence` and the
web's `server-kernel` telemetry import OpenTelemetry.

### Concurrency

Run start is idempotent per key; approvals are consumed by guarded updates; catalog locks are proven
on PostgreSQL only. The stale-run sweep runs on one replica at a time under a database lease, and
interrupts reach only the launching replica.
