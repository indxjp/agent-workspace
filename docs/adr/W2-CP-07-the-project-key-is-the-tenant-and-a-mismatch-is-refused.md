# W2-CP-07 — The `projectKey` is the tenant, and a request that disagrees with its caller is refused

Status: accepted
Date: 2026-09-05
Task: W2-CP-07 (sub-wave 2b-1)
Scope: `apps/web/server/sessions/api.ts`

## Context

`SessionKey.projectKey` is the namespace every transcript is stored under. R-01 §7 established three
things about it, and the third is why this record exists:

1. It is an **input the SDK hands the adapter**. There is no `projectKey` option; the only lever is
   `CLAUDE_CODE_PROJECT_DIR_NAME` set beside `CLAUDE_CONFIG_DIR` in the run's `env`.
2. Left at its default it is the **sanitised `cwd`**, so *"two tenants whose sandboxes share a
   workspace path share a key namespace."*
3. **Both failure modes are silent.** A value failing the SDK's `/^[A-Za-z0-9_-]{1,64}$/`, or one set
   without `CLAUDE_CONFIG_DIR`, is *ignored* — not rejected, not logged — and the cwd-derived key is
   used instead.

`packages/core`'s `validateTenantSessionScope` already refuses to *start* a run whose scope could
trigger (3). That check is upstream of the SDK. It cannot see what the SDK actually did.

## Decision

The transcript API derives the stored `projectKey` **from the authenticated principal**, and
requires the caller to state the `projectKey` it believes it is writing under. The two are compared.

* They agree → the request proceeds under the principal's key.
* They disagree → **403 `project_key_mismatch`**, naming both, and nothing is stored.
* The caller states none → **400 `invalid_project_key`**. It is not defaulted to the principal's
  key, because a field that is filled in for the caller can never disagree with anything, and being
  able to disagree is the whole value of it.

`apps/web/server/compose/run-request.ts` builds every run's scope as `{ projectKey: workspaceId, … }`,
so in a correctly configured deployment the two strings are equal by construction and the check costs
nothing. What it buys is that failure mode (3) stops being silent.

## Evidence — it fired on a live run before anybody wrote a test for it

The first version of this task's acceptance harness used a fixed workspace id and a *separately*
generated project key, which is exactly the shape of a runner whose `CLAUDE_CODE_PROJECT_DIR_NAME`
was ignored. The run reached a real model, mirrored two batches, and produced this:

```text
the SDK emitted 2 system/mirror_error event(s): a batch of transcript entries was dropped after
3 attempts and has no surviving copy in the store. First:
w2cp07-655a44b93658/bb226592-7586-45ed-985d-8aea430c970f: session mirror POST
http://127.0.0.1:62590/api/sessions/bb226592-7586-45ed-985d-8aea430c970f/transcript answered 403:
{"error":{"code":"project_key_mismatch","message":"this request declares projectKey
\"w2cp07-655a44b93658\" but the caller is scoped to \"c8b1f0de-6a2e-4a1f-9d3b-0000000007cp\". …"}}
```

Three separate mechanisms did their job in that one line, and each is worth naming because none of
them is a mock: the route refused the write, the SDK's own retry-then-`mirror_error` behaviour
surfaced the drop (R-01 §7), and `claude.ts`'s `sessionDurability()` refused to call the run durable
and said why. `api.test.ts` now covers the same refusal, including with a cwd-shaped key
(`C--app-workspaces-tenant`).

## Consequences

* A misconfigured runtime cannot quietly write one tenant's conversation into a shared namespace. It
  fails loudly, at the first batch, with a sentence naming both keys.
* `GET /api/sessions` reads **no** `projectKey` from the request at all — the tenant is the
  principal's and a query parameter naming another changes nothing. Asserted in `api.test.ts`.
* The cost is one required field on every transcript request. The runner's mirror sends it from the
  `SessionKey` the SDK handed it, which is precisely the value that needs checking.
* This is not a substitute for a per-run credential. The mirror presents a container-level cookie
  today; spec A.11's short-lived per-run token is Wave 4's
  ([ADR-0021](0021-phase-0-credential-step-belongs-to-wave-4.md)). Until then this check is what
  stands between a misconfigured — not a malicious — runtime and a cross-tenant transcript.
