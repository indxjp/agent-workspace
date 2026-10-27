# Agent Workspace SDK

The programme that turns the control plane's shared functionality into something a customer's
frontend or backend can consume as a real SDK — not a set of internal helpers.

Two words are overloaded in this repository and this directory keeps them apart:

- **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`) is Anthropic's package. Spec §5 and §42
  confine it to `apps/runner/src/claude.ts`; `tests/no-sdk-import.test.ts` enforces that.
- **Agent Workspace SDK** (`@indx-workspace/contracts` and `@indx-workspace/sdk`) is what this
  directory designs: the published contracts of _our_ control-plane API and a typed client for it.

## The staged approach

| Stage                                    | Deliverable                                                                                                                                               | Status                                                                                                                                                                                                                                                                                                                                                                                       |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 — Clean up and formalise the specs     | Wire contracts as executable Zod schemas with derived types, one package, no framework or database dependency. Stable problem codes. Event vocabulary.    | Landed: `packages/contracts` covers every resource family the control plane exposes today (workspaces, sharing policy, team, invitations, API keys, models, runtimes, secrets, files, skills, connectors, agents, projects, sessions and transcripts, runs, run events, shares, metrics, audit) and the three error envelopes.                                                               |
| 2 — Build a clean SDK on the specs       | An isomorphic client: authentication, transport, typed failures, resource clients, an SSE follower with resume.                                           | Landed: `packages/sdk` has a client per family (`aw.<family>`), the neutral `AgentEvent` view, and reads every error envelope; browser and Node. The `aw` CLI (`packages/aw`) wraps every ✅ method.                                                                                                                                                                                         |
| 3 — Have the application consume the SDK | The web application imports contracts from the package and the SDK's parsers instead of keeping its own; one domain at a time, behind a conformance gate. | In progress: `apps/web/contracts/{agents,projects,team,invitations,files,runtimes}.ts` re-export the package; `components/run/live.ts` uses the SDK's SSE parser and `components/run/model.ts` its assistant-message parser; `apps/web/server/sdk-conformance.test.ts` pins every family's real serializer to the contracts. The browser screens still call `fetch` themselves (next phase). |

## Developer documentation

The developer-facing site — quickstart, guides, a page per resource, the `aw` CLI, and a
reference generated from the contracts and the SDK — lives in [`site/`](site/README.md)
(Mintlify; `npx mint dev` to preview, `pnpm docs:generate` / `pnpm docs:check` to regenerate and
verify the reference pages). The decision is
[ADR-0054](../adr/0054-developer-documentation-is-a-mintlify-site-generated-from-the-contracts.md).
The public API of the four published consumer packages (contracts, sdk, react, aw) is also
committed as [API Extractor](https://api-extractor.com/) reports, one `.api.md` per `exports`
subpath, under [`api/`](api/): every exported declaration with its full signature.
`pnpm docs:check` fails when source and reports differ; when the change is deliberate, run
`pnpm api:update` and commit the regenerated files (never edit them by hand). The diff is what
consumers of the package will see, so a breaking change is readable before the package is
published. The reports are rendered from the declarations of each package's `tsconfig.build.json`,
so no build is needed first.
The site also states where a consumer stands — `concepts/public-surface.mdx` (Consume,
Configure, Extend, Internal), `concepts/target-architecture.mdx` (what the SDK is meant to be
once finished, restating 03 §3.2/§3.6, 04 §8 and the refactoring programme's target) and
`concepts/roadmap.mdx` (every gap between today and that target, one entry per `S-n`/`RF-nnn`
item) — and every page marks a gap with a Today / Target callout that links to the roadmap.

## Documents

1. [Use cases and documentation](02-use-cases-and-documentation.md) — what the SDK must support
   for our application, a customer's frontend, and a customer's backend; what documentation exists
   and what is still needed.
2. [SDK design](03-sdk-design.md) — package structure, layering and dependency direction; how it
   is built, tested and published; the public API and its usage patterns; how every existing
   feature maps onto the SDK; the migration sequence and its gates.
3. [API specification](04-api-specification.md) — the normative contract for the **complete**
   surface: resource model with workspaces and principals, authentication, conventions, every
   resource's operations with their SDK method and status, runtime neutrality (what is portable,
   what stays Claude Agent SDK-native), the `aw` CLI, the server changes still required, and how
   a row is proven.
4. [Structure map](07-structure-map.md) — the one page to read before touching a unit: the
   package map with the enforced import direction, the four layers one resource (`agents`)
   crosses with real file paths, the ER diagram of the tables the SDK surfaces, and the
   resource ↔ contract ↔ route ↔ SDK method ↔ `aw` command table, all drawn from the tree
   rather than the specification.

The decision itself is recorded in
[ADR-0052](../adr/0052-the-sdk-is-contracts-first-and-the-application-is-its-first-consumer.md).

## Decisions taken with the Owner (2026-09-21)

- The operational CLI is a new package `packages/aw` (binary `aw`), depending only on the SDK;
  `packages/cli` remains the deployment generator.
- Runtime neutrality names the seams (a portable `AgentDefinition`, a neutral `AgentEvent` view
  computed in the SDK) and keeps tool policy and transcripts Claude Agent SDK-native, tagged
  `provider: 'claude-agent-sdk'`.
- Next implementation phase: SDK coverage of every **existing** route first (files, skills,
  connectors, models, runtimes, secrets, team, shares, metrics, audit), then the server changes
  in [04 §8](04-api-specification.md#8-server-changes-this-specification-requires) as separate
  pull requests, starting with `GET /api/me`, the agent policy route and run interrupt.

The second of those clauses used to defer inventing an engine-neutral policy format until a second
engine existed to require one. On 2026-09-26 the Owner decided that the platform accepts engines
other than the Claude Agent SDK, so that condition is being met and the clause is withdrawn. An
agent's **engine** is now an extension point behind one port, and
[ADR-0065](../adr/0065-an-agents-engine-is-an-extension-point-behind-one-port.md) is the normative
record: it fixes the vocabulary (engine, model provider, runtime driver, wire protocol), names the
portable core every engine honours or refuses by name — which is the format the withdrawn clause
deferred — and states what the platform still refuses to own (an agent loop, a tool executor, a
memory system, prompt templates). Skills move with it, from Claude-native to
portable-with-refusal. The eleven units that implement it are tracked on
[#299](https://github.com/indxjp/agent-workspace/issues/299); two of them (#301 and #302)
must land before the first npm publish (#246), because they rename `AgentPolicy.provider` to
`engine` and replace the relayed event names.

## Coverage after the second phase (2026-09-21)

Every route of `apps/web/app/api/**` that needs no server change has a contract, a conformance
case, a client method and a consumer (the `aw` CLI, or an application re-export). What remains
⬜ in [04 §5](04-api-specification.md#5-resources) is exactly the set of server changes in
[04 §8](04-api-specification.md#8-server-changes-this-specification-requires) plus the
refactoring items RF-103 (share publish), RF-201 (agent archive) and the agent policy/export
surface (S-13). Implementing the phase surfaced seven more server changes, S-16 to S-22, recorded
there; the most consequential was S-16 — the RBAC layer's `{ code, detail }` envelope — which SDK
unit 6 (#238, ADR-0075) replaced with the standard `{ code, message }`, keeping `detail` as a
deprecated duplicate until the next major release (ADR-0078 D7). S-22 is the CLI's: the workspace
and invitation routes refuse an API-key principal (ADR W9-WS-119), and a key is the only
credential `aw` can hold, so those eight commands exist in the SDK but not in the binary until a
person can sign the CLI in.
