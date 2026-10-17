# ADR-0088 — A Builder reads runtime profiles, and a runtime profile carries no credential

Status: accepted
Date: 2026-10-01
Decided by: the implementer of issue #388 (PR #390), recorded after the PR's review asked for it
(issue #380, items 6 and 7)
Scope: `apps/web/server/rbac/permissions.ts` (the Builder row's `runtime-profiles` cell);
`apps/web/app/api/runtime-profiles/route.ts`; `apps/web/app/api/runtime-profiles/[id]/route.ts`;
`apps/web/server/runtimes/contract.ts` (`driverConfig` validation);
`packages/contracts/src/runtimes.ts` (the `driverConfig` documentation)

## Context

Before #388, `/api/runtime-profiles` checked only which workspace the caller belonged to, never
the caller's role. PR #390 put every method behind the shared decision table (`decide()` through
`requireResourceAccess`). Spec §21 gives runtimes to Owner and Admin ("Admin: … runtimes"), so the
plain reading would refuse Builder and Viewer everything (`NOTHING`).

Two places a Builder already works need to read profiles:

- **The agent editor.** It lists the workspace's runtime profiles, and it cannot submit an agent
  without one: an agent's policy names the profile its runs use. §21 gives a Builder
  "Create/edit/run agents", and choosing the profile is part of creating the agent.
- **SDK agent definitions.** `aw agents export` and `aw agents import` (and the SDK's
  agent-definition resource) refer to a profile by name and resolve it to an id on import. A
  Builder's API key that cannot list profiles cannot import its own agent definitions.

With `NOTHING`, the editor shows no profiles to a Builder, and an import from a Builder fails, so
the §21 Builder clause would not work for agents at all.

A read is safe only if what it shows is not secret. A profile has sizing (`cpu`, `memoryMb`,
`diskMb`), timeouts, a network policy with its allowed domains, a filesystem mode, persisted paths,
the id of a runtime connection, and `driverConfig`, a free-form per-driver record. §14.9 keeps
credentials (cluster tokens, registry passwords, cloud keys) on **runtime connections**, which are
encrypted at rest and never read back. A profile only points at a connection by id. But until now
nothing stopped someone with write access from putting a credential in `driverConfig`. A Builder
could then read it.

## Decision

### D1 — Builder gets `READ_ONLY` on `runtime-profiles`; writes stay with Owner and Admin

The Builder row's `runtime-profiles` cell is `READ_ONLY`: list and get, any profile in the
workspace. Create, update and delete stay Owner/Admin (`MANAGE`). Viewer stays `NOTHING`. Runtime
connections stay Owner/Admin for every method, including reads, so a Builder never reaches the
record that does hold a credential.

### D2 — `driverConfig` must not carry a credential, and the server refuses one

A profile is safe to show a Builder only if it holds no secret, so that is now enforced, not just
assumed. `POST /api/runtime-profiles` and `PATCH /api/runtime-profiles/:id` refuse, with `400`, a
`driverConfig` that has a key at any depth whose name looks like a credential. The key is split
into words at camelCase, `_`, `-` and digits (`APIKey2` reads `api key`, `oauth2token` reads
`oauth token`). It is refused when:

- a word is `secret`, `secrets`, `token`, `sas`, `authorization`, `bearer` or
  `connectionstring`;
- a word ends in `token` or `secret` (`githubtoken`, `webhooksecret`);
- a word contains `password`, `passwd`, `passphrase`, `apikey`, `apitoken`, `accesskey`,
  `secretkey`, `privatekey`, `clientsecret`, `authtoken`, `credential` or `cookie`, which catches
  run-together lowercase keys (`dbpassword`, `accesskeyid`, `sessioncookie`); the word
  `passwordless` is a setting and is exempt;
- or two adjacent words are `api key`, `api token`, `access key`, `access token`,
  `refresh token`, `secret key`, `private key`, `auth token`, `client secret` or
  `connection string`, the second word singular or plural (`apiKeys`, `accessTokens`).

`maxTokens` and `tokenizer` pass: `tokens` and `tokenizer` neither are nor end in `token`.

A key whose last word is `ref`, `refs`, `name` or `names` (`secretRef`, `secretName`) names a
reference to a secret and passes, and so does Kubernetes' `imagePullSecrets`, a list of names.
`driverConfig` nested deeper than 32 levels is refused with `400` too, so the walk is bounded. The
error names the key and says where credentials belong: a runtime connection, referenced by
`runtimeConnectionId`.

The check is on key names, not values. A value check cannot recognise an arbitrary secret, and
would reject harmless strings. The check is on the write path in `apps/web`, the handler that
owns the domain rule, not in the read schema. A profile stored before this change still reads and
still runs, and the next edit has to remove the key. `packages/contracts` only documents the rule
on `driverConfig`. It has no write schema for profiles (the inputs are interfaces), and the
contracts package describes the wire, not domain policy (docs/sdk/07-structure-map.md §5).

## Alternatives considered

- **Keep `NOTHING` for Builder** (the literal §21 reading). This breaks the agent editor and agent
  definition import for the role §21 gives agents to. Rejected.
- **A narrower read model for Builders** (id and name only, through a separate route or a
  projection). This adds a second resource shape and a second route for data that is not secret
  once D2 holds. The agent editor also shows sizing and network policy to help the choice.
  Rejected as a speculative layer. It can be revisited if a profile ever needs a field a Builder
  must not see.
- **Owner-only `driverConfig` redaction on read.** This hides the field from Builders but leaves
  the credential stored in plain JSON, outside the encrypted runtime-connection store. Refusing it
  on write keeps secrets in the one place built for them. Rejected.
- **Validate `driverConfig` values** (entropy, known token prefixes). This is unreliable in both
  directions, as above. Key names are where a credential announces itself in a config record.
  Rejected.
- **A per-driver `driverConfig` schema.** §15.1 asks for one eventually. No driver reads
  `driverConfig` today (`aca-sessions` and the Compose path refuse any non-empty one), so there is
  no shape to write yet. D2 does not replace it, and a per-driver schema will cover D2 when it lands.

## Consequences

- A Builder can create and edit agents and import agent definitions that name a runtime profile.
- A Builder sees every profile's sizing, network policy and allowed domains in its workspace. These
  are operational settings, not secrets.
- An Owner or Admin who tries to put a credential in `driverConfig` gets a `400` naming the key and
  pointing to runtime connections. A setting whose name contains a credential word as a whole word
  (for example `accessKeyId`) is refused too and has to be renamed. This is the price of a rule
  based on names.
- `formal/AgentWorkspace/Concepts/RuntimeProfile.lean` does not model the refusal yet (finding
  F-106).
- The header comments of the runtime-profile routes and `routes.test.ts` now describe the real
  matrix (Owner/Admin write, Builder reads), and cite this ADR.
