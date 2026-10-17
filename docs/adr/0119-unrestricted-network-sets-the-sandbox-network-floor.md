# ADR-0119 — `unrestrictedNetwork` sets the sandbox network floor

Status: accepted
Date: 2026-10-07
Decided by: the product owner (tracker #780; issue #785 A5), finalising ADR-0117 decision 9
Scope: `packages/contracts` (`networkPolicyFloor`), `apps/web/server/compose` (the run resolver); the permission table in `docs/sdk/site/building/agents.mdx`

## Context

ADR-0117 decision 9 says a principal's sandbox gets at most `restricted` without
`unrestrictedNetwork`, and leaves "what a sandbox gets when the profile asks for more than the
permission allows" to #785. Until now the permission only withheld the engine's `WebFetch` and
`WebSearch` tools: an agent with `runCommands` on an `open` runtime profile could still `curl`
anywhere, so `unrestrictedNetwork: false` was a false assurance.

## Decision

**1. The floor is applied when the run spec is resolved, before the driver sees it.**
`createRuntimeRunResolver` (`apps/web/server/compose/runtime-profile.ts`) lowers the profile's
policy before `validate` and `allocate`, so the runner manager is never given `open` for an agent
without the permission. The runner has no agent or permissions and does not decide this.

**2. The mapping.** `networkPolicyFloor` (`@indx-workspace/contracts/policy-ceiling`) is pure and
never widens:

| Profile policy | `unrestrictedNetwork` (after the ceiling) | Resolved policy                                          |
| -------------- | ----------------------------------------- | -------------------------------------------------------- |
| `none`         | any                                       | `none`                                                   |
| `restricted`   | any                                       | `restricted`, the profile's own `allowedDomains`         |
| `open`         | on                                        | `open`                                                   |
| `open`         | off, at least one connector host          | `restricted`, `allowedDomains` = the distinct hosts       |
| `open`         | off, no connector host                    | `none` (the gateway only)                                |

**3. The switch is the met one.** The input is the permission after the stored arm's withholding
and the deployment's policy ceiling, the same narrowing `buildRunRequestFor` applies. A switch the
ceiling turns off therefore lowers the network too.

**4. Connector hosts.** The hosts are the DNS names of the run's met remote (`http`, `sse`) MCP
connectors, because the sandbox itself calls them (remote connectors need no permission). `stdio`
connectors and gateway-served tool connectors have no sandbox egress and add nothing. IP literals
are left out: the proxy allowlist holds names only (ADR-0117 decision 3).

**5. `local` is exempt.** ADR-0117 decision 7 leaves it unchanged: a host process has the host's
network and `localRuntimeRunSpecRejection` refuses every policy but `open`.

**6. Fail closed.** A lowered `restricted` on a driver without the egress proxy (every driver but
Docker and Kubernetes, which route egress through it since #784 when the deployment sets
`AGENT_WORKSPACE_EGRESS_PROXY_IMAGE`; Cloud Run and ACA by ADR-0117 decision 7) refuses the run
with `network_policy_unenforceable`, naming the hosts and the way out. The web process reads the
same variable as the runner manager to decide.
Any other policy a driver cannot enforce refuses the run through its existing `validate` or driver
refusal (`none` on an `open` ACA pool). The run never falls back to `open`.

**7. The lowering is logged, not yet an event.** The resolver tells the web process when it lowers
a policy, which writes one line naming the run, the applied policy and the hosts. A durable
`run.network` event would add a reserved name to the platform event vocabulary, which the formal
model pins (`formal/AgentWorkspace/Events/Sse.lean`) and which needs the Lean vectors regenerated;
it is left to a follow-up.

## Consequences

- An agent without `unrestrictedNetwork` (the default) on an `open` profile loses the internet on
  Docker, Kubernetes and Cloud Run. One with remote connectors resolves to `restricted`, which
  Docker and Kubernetes enforce with the egress proxy configured; without it, and on Cloud Run and
  ACA, the run is refused with `network_policy_unenforceable`.
- The run's resources are loaded twice per launch (resolve and build): extra reads only.
- No migration.
