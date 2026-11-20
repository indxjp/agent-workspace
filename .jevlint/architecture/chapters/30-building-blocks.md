---
title: Building blocks
evidence: [docs/architecture.md:39-66, docs/architecture.md:450-501, apps/web/server/contexts.json, docs/10-product/sdk/07-structure-map.md:14-60, apps/web/server/application-context.ts:15-51, packages/tool-host/src/intake.ts:25]
---

<!-- jevlint:diagram overview -->

### Published clients

`sdk` is the typed client every outside caller uses; `aw-cli`, `react-chat`, `app-kit` and the
browser screens build on it, and none of them may reach a server package
(`docs/10-product/sdk/07-structure-map.md`). `project-cli` generates and deploys projects, and `aw` loads its
`deploy` and `publish` only through `packages/aw/src/cli-bridge.ts`. They hand work on by calling
`/api/**` over HTTPS; the dashed arrow from the SDK to the routes is that boundary.

### Control plane (apps/web)

`web-routes` is the Next.js tree; it renders `web-ui` screens and calls one domain function per
route. The server is split into the bounded contexts that `apps/web/server/contexts.json` lists,
upstream first: identity (with secrets), storage and sharing, execution, integrations, agents
(with evaluations) and the store demo. In this SSOT they are the components `identity`,
`storage-sharing`, `execution`, `integrations`, `agent-authoring` and `store-demo`, each allowed to
depend only on the contexts before it. Each context has a public `index.ts` entry that the others
should import. `server-kernel` is what all of them share, and `composition` builds them and installs
the `ApplicationContext` they read at request time. The execution domain hands a run to the runner
by HTTP, not by import.

### Execution plane

`runner` is two processes: the runtime manager, which allocates a sandbox per session through one
`runtime-drivers` driver, and the runtime server inside the sandbox, which runs one
`engine-adapters` engine. Engines call `gateway` over HTTP with the run token. `sandbox-tools` are
the tool host and egress proxy that run next to an agent; the tool host implements the tool-host
contract from `aw` (`intake.ts:25`). `embedded` bundles the control plane, gateway and runner into
one process for `aw dev`.

### Contracts and persistence

`contracts` is the public wire language, `run-contract` the private one between control plane,
runner and engines (`AgentEngine`, `RunRequest`), and `platforms` the pure translators that export
a portable agent to other agent platforms. `persistence` (`packages/core`) is the only component
that reaches PostgreSQL and object storage.

<!-- jevlint:diagram layers -->

The layers run top to bottom. A component may import its own layer and those below. The server's
contexts share the `application` layer because the composition root and the contexts import each
other by design (the root builds them; they read the context it installed); their direction is held
by each component's `depends_on`, not by layers.
