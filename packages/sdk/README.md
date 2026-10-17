# @indx-workspace/sdk

A typed client for the Agent Workspace control-plane API. Every response is validated against
[`@indx-workspace/contracts`](https://www.npmjs.com/package/@indx-workspace/contracts) before it is returned, and every failure is
one of three typed errors, so calling code branches on a status and a stable code — never on prose.

The client uses only Web platform APIs (`fetch`, `Headers`, `URL`, `AbortSignal`,
`ReadableStream`), so the same import works in a browser bundle, in Node 24, and at the edge.

## Create a client

```ts claim="compile"
import { createClient } from '@indx-workspace/sdk';

// A backend, holding a workspace API key.
const aw = createClient({
  baseUrl: 'https://agents.example.com',
  auth: { kind: 'api-key', apiKey: process.env.AGENT_WORKSPACE_API_KEY ?? '' },
  timeoutMs: 15_000, // until response headers arrive; streams stay open as long as they need
});

// A page on the control plane's own origin, signed in with a session cookie.
const same = createClient({ baseUrl: window.location.origin, auth: { kind: 'session' } });
```

Options: `fetch` (inject your own), `headers` (sent on every request, e.g. a trace id). Every
method takes a trailing `{ signal }`; aborting it ends the call — a stream included — with a
`TransportError` whose `aborted` is `true`.

The two credentials do not reach the same routes. Every `/api/workspaces` route and every
`/api/invitations` route refuses an API-key principal with `403 api_key_not_permitted`
(ADR W9-WS-119: a key acts for one workspace with a fixed role, so it has no human membership to
list, create or administer against); `aw.workspaces.list|get|create|update` and
`aw.team.invitations.*` need `auth: { kind: 'session' }`.

## Start a run and wait for it

```ts title="illustrative" claim="illustrative"
const { run } = await aw.runs.start(agentId, { prompt: 'Triage the overnight alerts.' });
const settled = await aw.runs.waitForOutcome(run.id);
console.log(settled.status, settled.usage.totalTokens, settled.cost.amount);
```

## Stream a run

```ts title="illustrative" claim="illustrative"
for await (const frame of aw.runs.follow(run.id)) {
  switch (frame.kind) {
    case 'run-status': // the platform's own lifecycle event: { status, error }
    case 'runtime': // a relayed Claude Agent SDK message, verbatim, under frame.name
    case 'run-failed': // this connection could not deliver a successful run
    case 'stream-reset': // the resume cursor could not be served; discard what you rendered
  }
}
```

`follow` reconnects with `Last-Event-ID` when a connection drops before the server's `done`
frame; `events` is the single-connection primitive underneath it. `done` means the stream is over
and says nothing about success — `run-failed` says that, and `runs.get` has the settled record.

## Resources

| Client          | Methods                                                                                                                                                       |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `aw.workspaces` | `list`, `get`, `create`, `update` — **session auth only** (an API-key principal gets `403 api_key_not_permitted`; ADR W9-WS-119); `sharingPolicy.get`, `.set` |
| `aw.agents`     | `list`, `get`, `create`, `update`, `remove`, `getResourceAssignments`, `replaceResourceAssignments`                                                           |
| `aw.runs`       | `start`, `get`, `list` (cursor-paged, filtered), `events`, `follow`, `waitForOutcome`                                                                         |
| `aw.sessions`   | `list`, `get`, `update` (rename, archive, restore)                                                                                                            |
| `aw.projects`   | `list`, `get`, `create`, `update`, `archive`, `restore`, `startSession`                                                                                       |

## Errors

```ts title="illustrative" claim="illustrative"
import { ApiProblemError, ContractViolationError, TransportError } from '@indx-workspace/sdk';

try {
  await aw.agents.get(id);
} catch (error) {
  if (error instanceof ApiProblemError) error.status; // 404, error.code === 'agent_not_found'
  if (error instanceof ContractViolationError) error.issues; // the server and this SDK disagree
  if (error instanceof TransportError) error.aborted; // no response: network, abort, timeout
}
```

`@indx-workspace/sdk/events` exposes the SSE parser (`parseSseFrame`, `splitSseFrames`,
`readSseFrames`) and `classifyRunEventFrame` for a consumer that already has a stream in hand.

## Agents and surfaces as code

`@indx-workspace/sdk/define` describes an agent and the surfaces that talk to it in TypeScript,
the files an `agent-workspace` project keeps under `agents/` and `surfaces/`. The module is
isomorphic — no `node:*` import — so the same definitions load in a browser, in Node 24 and at
the edge.

```ts claim="compile"
// agents/assistant.ts
import { defineAgent, files, mcp, skill } from '@indx-workspace/sdk/define';

export default defineAgent({
  name: 'assistant',
  instructions: { file: './assistant.md' }, // a bare string is the instructions text itself
  model: 'default',
  tools: [mcp('github')],
  skills: [skill('triage')],
  files: [files('handbook/'), files('notes/', 'read-write')],
  permissions: { readFiles: true },
});
```

```ts claim="compile"
// surfaces/main.ts
import { defineSurface } from '@indx-workspace/sdk/define';

export default defineSurface({
  name: 'main',
  agent: 'assistant',
  theme: { colour: '#3b5bdb' },
});
```

Every `define*` call and reference helper validates eagerly against a strict schema, so an
unknown key — a `description`, an `audience` — or a repeated tool, skill or file path is refused
where it is written, with a `DefinitionError` (`code: 'invalid_definition'`, one
`{ path, message }` per issue). `toAgentVersionBody(agent, { surfaces, instructions })` turns the
definitions into the body the agent-versions contract parses, and throws `DefinitionError` too:
for an unresolved `instructions.file` (pass the file's text as `instructions`), or a surface that
names another agent.

Three rules decide what is sent:

- **Policy.** It is `compiled` — exactly what the server compiles from the permissions and skills
  — unless a limit has a value or an engine other than `claude-agent-sdk` is given; then it is
  `stored`. An empty `limits: {}` gives no limit.
- **`model: 'default'`** (or no model) is sent as `modelConnectionName: 'default'`, which the
  server resolves to the workspace's connection of that name, else the deployment default
  (contract C7). Any other string names a model connection; `{ connection, id }` also pins the
  model id.
- **Engine.** `toAgentVersionBody(agent, { defaultEngine })` applies the project's `engine` to an
  agent that names none; an agent's own `engine` wins (contract C12). With neither, the engine is
  `claude-agent-sdk`.

### Tools and secrets

An agent's `tools` list takes three kinds: an MCP connector (`mcp('github')`), an OpenAPI tool and
a PostgreSQL tool. The project keeps the last two under `tools/`:

```ts claim="compile"
// tools/orders.ts
import { openapiTool, secret } from '@indx-workspace/sdk/define';

export default openapiTool({
  name: 'orders',
  spec: 'apis/orders.openapi.json',
  auth: secret('ORDERS_TOKEN'),
  allow: ['GET /orders/*'],
});
```

```ts claim="compile"
// tools/orders-db.ts
import { postgresTool, secret } from '@indx-workspace/sdk/define';

export default postgresTool({
  name: 'orders-db',
  url: secret('ORDERS_DB_URL'),
  readOnly: true,
  tables: ['public.orders'],
});
```

```ts title="illustrative" claim="illustrative"
// agents/assistant.ts
import { defineAgent, mcp } from '@indx-workspace/sdk/define';
import orders from '../tools/orders';
import ordersDb from '../tools/orders-db';

export default defineAgent({
  name: 'assistant',
  instructions: { file: './assistant.md' },
  tools: [mcp('github'), orders, ordersDb],
});
```

- **`secret('NAME')`** is a reference, `{ secret: 'NAME' }`, never the value (contract C10); a
  plain `{ secret: 'NAME' }` object is the same reference. A name starts with `A`–`Z` and goes on
  with `A`–`Z`, `0`–`9` and `_`. Names the runtime reserves, such as `PORT`, `PATH` or any
  `AW_*`, are refused, and so is a string where a reference belongs.
- **`spec`** is a project-relative path without `..` segments, or an `https://host/...` URL. An
  absolute path, a drive letter, an `http` URL, a URL with a fragment or a credential (a user
  name, password or a parameter such as `token` or `api_key`), and a path segment that starts or
  ends with a space, ends with a dot or is a Windows device name (`CON`, `NUL`) are refused at
  `spec`.
- **`auth`** is optional: left out, the tool sends no credential; a reference is sent as a bearer
  token; `{ header, credential: secret('NAME') }` sends it in a named header.
- **Reads only.** `allow` takes only `GET` and `HEAD` rules, and a PostgreSQL tool's `readOnly`
  must be `true` (ADR-0113, SD4). `maxRows` is optional.
- **Connectors.** Each tool becomes a catalog connector named in the body's
  `resources.connectors`, in the order written (contract C15). MCP, OpenAPI and PostgreSQL tools
  share one name space, so a repeated tool name is refused even across kinds.
- **`toolDefinitionsOf(agent)`** returns the agent's OpenAPI and PostgreSQL tools as unresolved
  specs — `{ kind: 'openapi', name, spec, allow, auth, baseUrl?, credential? }` and
  `{ kind: 'postgres', name, credential, tables, readOnly, maxRows? }`, each `credential` a plain
  `{ secret }` reference. It reads no file and no secret value; `aw dev` resolves both.
  `isOpenApiTool` and `isPostgresTool` recognise the tools across module copies.

## Project files

`@indx-workspace/sdk/project` is the one reader and the one renderer of `agent-workspace.yaml`
and the project files. `aw init` and `npm create @indx-workspace` write a project through it
(ADR-0107). The reader moved here from the CLI (ADR-0103), so every tool reads the file the same
way. Like `./define`, the module is isomorphic.

```ts title="illustrative" claim="illustrative"
import {
  parseProjectFile,
  projectNameFor,
  renderProjectFiles,
  renderProjectShell,
} from '@indx-workspace/sdk/project';
import { withRecommendedAnswers } from '@indx-workspace/contracts/setup';

const project = parseProjectFile(text); // the validated project document

const name = projectNameFor('demo');
const files = [
  ...renderProjectFiles(withRecommendedAnswers({}), { name }), // agent-workspace.yaml, agents/, surfaces/
  ...renderProjectShell({ name, version: '0.6.1' }), // package.json, pnpm-workspace.yaml, .gitignore
];
```

Each file is a `{ path, contents }` pair; nothing is written to disk. The reader refuses anchors,
aliases, custom tags, duplicate keys and second documents with a `ProjectFileError` that names the
line and column (ADR-0089). A schema refusal names the line, column and dotted path of the
offending key. Invalid answers, names or versions throw `ProjectRenderError`.
