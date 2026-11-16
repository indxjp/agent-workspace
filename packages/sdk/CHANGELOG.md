# Changelog — `@indx-workspace/sdk`

One heading per release, newest first. Each lists what was **added**, **deprecated** and
**removed**; a removal names the release that deprecated it. Removals and renames happen only in a
major release, no earlier than one minor after the deprecation. The full rule, the served range and
what the policy covers are on the developer site's
[Public surface and stability](../../docs/sdk/site/concepts/public-surface.mdx#versions-and-deprecation)
page. Released in lock-step with `@indx-workspace/contracts`, with the same version.

## 0.6.13 — unreleased

### Added

- The app template (`aw generate app`, `create --template portal`) builds an image for
  `aw deploy`: a two-stage `Dockerfile` on a digest-pinned Node.js 24 image that copies Next.js's
  standalone output, its static files and `db/migrations`, and runs as `node` on port 3000; a
  `.dockerignore`; `instrumentation.ts`, which applies the app's migrations as the server starts
  when `AW_APP_MIGRATE_ON_START=1` and exits on a failed one; and `app/api/health/route.ts`, which
  answers `ok` with `no-store` without reading the app's settings. `package.json` gains the script
  `image` (`docker build -t <app> .`), recorded in `aw-generated.json` so `aw destroy app` removes
  it; a project's own `image` script is kept. `appScripts` and `scriptEdit` are exported from
  `@indx-workspace/sdk/project`.
- `renderAppTemplate` renders four presets over the portal: `chat`, `wiki`, `crm` and `desk`
  (`APP_PRESETS`). Each adds the recipe pages and their four routes, and its own overlay: chat a
  home page that links to its channels once they exist; wiki the `space` and `page` resources,
  their migration `0003_wiki`, routes, the wiki pages and the space pages; crm its theme tokens;
  desk the dashboard page. A later layer writing a path an earlier one wrote is refused unless the
  preset lists it in `replaces`. The app is named after the project, never the template, and
  `aw-generated.json` records the wiki's resources as `resource:space` and `resource:page` and the
  desk's dashboard as `page:dashboard`, so `aw destroy` removes them as generated ones. Each
  preset's README section lists its follow-up `npx aw` commands, shell-quoted.
- `triggers.update(id, { cron, timezone })` re-times a `schedule` trigger; a `webhook` trigger
  answers `400 invalid_field`.
- `aw.agentTeams` (ADR-0104, #1516): `list`, `listAll`, `get`, `create`, `remove`,
  `versions.create` and `versions.list` over `/api/agent-teams/**`. `runs.get` returns a
  `RunDetail` with `parentRunId`, `children` and `treeCost`, and `fixtures.runDetail(run)` in
  `@indx-workspace/sdk/testing` builds the read's answer for a test double.
- `@indx-workspace/sdk/project` renders app templates for `create --template`:
  `renderAppTemplate('portal', { appName, version, existing })` returns the `app` template, the
  portal's pages over it and the `aw-generated.json` entry recording them, with the packages to
  pin; `withAppPackages` adds those pins to `package.json`; `appKitPackages` and `APP_TEMPLATES`
  are the pins and the template list `aw generate app` and `create` share.
- The generated app's CI (`app-ci.yml`) now cruises the whole project, so an app with no
  `resources/` yet passes, and also refuses a private-scope or `workspace:` dependency in
  `package.json`; its dependency-cruiser rule is `app-imports-only-published-packages`, which
  refuses the private packages' imports as well as `apps/*`.
- `@indx-workspace/sdk/project` exports the app blueprint API (ADR-0166): `BlueprintManifestSchema`
  and `parseBlueprintManifest` for a package's strict `blueprint.json`; the pure planners
  `planBlueprintInstall(release, app)` and `planBlueprintUpdate(installed, release, local)`, which
  classify each file as `add`, `update`, `remove`, `unchanged` or `conflict` and never plan a write
  over a file the developer edited (a conflict writes only `blueprintSidecarPath`); and
  `destructiveMigrations`, which refuses a non-expand-only migration by name. It reads comments
  with a quote-aware reader and also refuses `TRUNCATE`, `DELETE`, `DO` and `EXECUTE` in blueprint
  SQL. `readBlueprintArchive` reads a gunzipped npm tarball and refuses links, unsafe paths and
  unlisted files. `aw-generated.json` gains a `blueprint` entry kind: a `blueprint:<name>` entry
  must carry its `source` (package, exact version and sha512 integrity) and its `migrations` map.
- The `channel` generator template (issue #1519) and its spec: `renderChannelSpec(resource,
  { key?, refs })` keys the channel on a `ref()` field (`--key`, else the first `ref()` to another
  resource, found by `refFieldsOf` in the resource's file) and refuses with `channel_key_required`
  when there is none; `channelRouteEdits(resource)` are the one-line edits of the resource's two
  route files that pass `{ publish }`. `aw-generated.json` records the `channel` kind, and an edit
  may name the line it `replaced`, which `aw destroy` puts back.
- `pinnedOf(tool)` in `@indx-workspace/sdk/define` returns the declaration `aw push` pins in a version's `toolBundles` entry for a code tool (with the `PinnableCodeTool` and `PinnedToolDeclaration` types); `aw` and `agentFromVersionBody()` now share it.
- `@indx-workspace/sdk/project`: `renderPageSpec(name, { kind, resource })` gives the values of the
  `page/dashboard`, `page/list` and `page/custom` templates (`GENERATOR_PAGE_KINDS`), refusing an
  unknown kind, a list page without its resource and a reserved name; `renderResourceSpec`'s values
  also render the new `resource-pages` template. `aw-generated.json` entries may now be `page:<name>`.
- The generators' pure half in `@indx-workspace/sdk/project`, for `aw generate app|resource|agent`:
  `parseFieldSpec` and `parseFieldSpecs` read the `name:type` field grammar (`title:text(200)`,
  `amount:money(JPY)`, `status:enum(new,closed)`, `parent:ref(ticket)`, a trailing `?` for an
  optional field) and refuse a bad argument with every reason; `renderFieldCode` writes the
  app-kit builder call a field becomes; `GENERATOR_FIELD_TYPES` lists the field types.
  `renderAppSpec`, `renderResourceSpec` and `renderAgentSpec` give the values of the `app`,
  `resource` and `agent` templates, which `renderGeneratorTemplate` renders.
- `aw-generated.json`, the record of what a generator wrote: `parseGeneratedManifest` refuses a
  file that is not exactly the manifest, `serializeGeneratedManifest` writes it in one canonical
  form, and `addGeneratedEntry` and `removeGeneratedEntry` change it.
- `issuesFromZod(error, prefix?, known?)` from `@indx-workspace/sdk/define`: maps a Zod error to
  the `DefinitionIssue`s a `DefinitionError` lists, naming the closest known key for an unknown
  root key ("did you mean"). `@indx-workspace/app` uses it so its definitions report mistakes in
  the same words as `defineAgent`.
- `@indx-workspace/sdk/portable` exports `revealInvisible` and `stripControlSequences`, which make
  model-written text safe to show. `revealInvisible` is for a screen where a person approves
  something: every control, zero-width, bidirectional, tag, variation-selector and look-alike space
  character is written as `<U+XXXX>` and nothing is deleted. `stripControlSequences` drops the escape
  sequences a terminal would act on, for streamed output.
- `@indx-workspace/sdk/project`: `renderTemplateDirectory(root, values, subject, options?)` renders
  a directory of real files into `ProjectFile[]`: `{{key}}` in text and `__key__` in paths are
  replaced from `values`, a trailing `.template.txt` is dropped and a README's file maps are
  re-aligned; a placeholder with no value is a `ProjectRenderError` naming the key. The setup
  starters render through it, so `aw init` and `create` write the same files as before.
- `aw.webhooks.list | create | remove` (N-3, issue #250, ADR-SDK-18-N3-250): register the endpoints
  a run's outcome is posted to. `create` answers `{ webhook, secret }`, the only time the `whsec_`
  signing secret is returned; `remove` resolves on the `204`.
- `verifyWebhookSignature({ secret, headers, body, toleranceSeconds?, now? })` checks a delivery's
  Standard Webhooks v1 signature with Web Crypto (any `v1` entry may match, compared in constant
  time; the timestamp must be within 5 minutes) and returns the contract-checked `WebhookEvent`.
  A refusal is a `WebhookVerificationError` whose `code` is `missing_header`, `invalid_secret`,
  `timestamp_out_of_tolerance`, `signature_mismatch` or `invalid_payload`.
- `aw.auth.exchange({ clientId, clientSecret, idToken })` (ADR-0161) trades the signed-in person's
  OIDC ID token for a 300-second `awo_live_` access token of an `app-backend` endpoint client,
  posting `/api/auth/token-exchange` with the client pair as `Authorization: Basic`. A client built
  with the new `auth: { kind: 'access-token', token }` presents that token as a bearer and acts as
  the person: it starts runs on the client's bound agents the person may run, reads and interrupts
  their runs, and reads `me`.

### Changed

- `renderAppTemplate(template, { appName, version, projectFiles })` takes the project's own files
  in place of the `existing` path list, returns them first in `files` (its `package.json` with the
  app's packages and scripts added), and records them in `aw-generated.json` as the entry
  `project:<name>`, so every file `create --template` writes is recorded. `project` is a new
  `GENERATED_ENTRY_KINDS` kind.
- `@indx-workspace/sdk/project` exports `revertGeneratedEdit`, which undoes one recorded
  generator edit (a line, a replaced line, a `package.json` pin or script, a migration journal
  entry) as `aw destroy` does, with `readPackageManifest`, `serializePackageManifest`,
  `readMigrationJournal` and `serializeMigrationJournal`.
- The `page/dashboard` template draws the app kit's `Dashboard` instead of a placeholder grid, and
  writes its route too, `app/api/dashboard/route.ts` (`export const { GET } = dashboardRoutes();`),
  so `aw generate page <name> --kind dashboard` gives a working dashboard.
- `runs.follow` backs off between reconnects (issue #250, K-3): the base is the last `retry:` the
  stream sent, or `reconnectDelayMs` before one arrives; the n-th failed reconnect in a row waits a
  random time between half and all of `min(maxReconnectDelayMs, base × 2^(n−1))`, and a connection
  that delivers a new event starts the count again. A `429` or `5xx` with `Retry-After` is still
  waited exactly that long. The new `maxReconnectDelayMs` option is the ceiling, default 30000.
  `reconnectDelayMs` and `maxReconnectDelayMs` must be non-negative finite numbers with
  `reconnectDelayMs ≤ maxReconnectDelayMs`; anything else throws a `TypeError` before the first
  request.
- `AgentVersionSource.project` no longer lists `models` in its `Pick<ProjectDocument, …>`: `agentFromVersionBody()` never read it, because the body names its model connection itself. A full `ProjectDocument` is still accepted.
- The `app` generator template's `app/layout.tsx` imports `@indx-workspace/app/react/styles.css`
  and wraps every page in `AppTheme`, so the generated resource pages are styled and themed.
- `shares.list()` items no longer carry `url`. Keep the `url` that `shares.publish()` returns: it
  is the only time a public link is shown. An older SDK refuses a list that holds a public share,
  because its schema still required `url` on one; upgrade the SDK with the server.

### Fixed

- `agentFromVersionBody()` reports a module tool whose name repeats an earlier export that the body uses (`toolModules.N` in `dropped`) instead of silently keeping the first, and the drops of a runtime profile, a skill allowlist and a stored tool policy now say what to change instead of "not reproduced by defineAgent()".
- `toPortableAgent()` and `portableFromAgentVersionBody()` no longer drop the signed identity assertion (`identity`) of an OpenAPI tool or an `mcp()` connector silently: the converter lists it in `dropped` at `<tool path>.identity`, naming the signing secret, because the portable tool has no field to carry it (ADR-0133 D5).

### Security

- A new project from `npm create` overrides `minimatch` 10.x to 11.0.3 (GHSA-g3hv-75wg-m249), as
  the repository root does, so the `pi` engine's dependency tree no longer installs a vulnerable
  `minimatch`.

## 0.6.12 — unreleased

### Added

- `agents.list({ archived: 'include' })` also lists archived agents, each with its `archivedAt`; without it they are left out.
- `agents.restore(id)` brings back an archived agent and returns it; `aw agents restore <id>` does
  the same from the CLI and prints the agent's name.
- `BuiltinAgentProblemCode` is exported, and `agents.create` and `agents.update` can throw
  `ApiProblemError` with code `builder_name_reserved` (`403`) when a Member gives an agent a name
  the deployment's `builder.allow` lists.
- `ClientOptions.onWarning` receives the SDK's deprecation warnings (today, a `contentBase64`
  skill import file) instead of `console.warn`; a handler that does nothing silences them. Without
  it the first such warning in a process is still one console line.
- `files.upload(path, stream, { sizeBytes })` streams a `ReadableStream` whose length is declared
  straight to the object store's signed link when it is above `MAX_UPLOAD_BYTES` (or with
  `direct`), instead of buffering it in memory first. A store that cannot sign links answers
  `501 direct_transfer_unsupported` and the stream is not read. A declared size that is not a
  byte count, or that a `Blob` or `Uint8Array` body contradicts, is refused with a `TypeError`
  before any request. A `Uint8Array` body is no longer copied on its way to the store.
- `renderProjectFiles` writes a `features:` list to `agent-workspace.yaml` (in `FEATURE_IDS` order) when the `admin.features` answer is not every feature. An absent answer, or every feature, writes no `features` key, so generated projects are unchanged by default.
- `workspaces.features.list(workspaceId)` returns `{ features }`, one `{ id, installed, enabled }`
  row per feature, and `workspaces.features.set(workspaceId, { disabled })` replaces the
  workspace's whole off set and returns the same shape. `me()` now includes the caller's enabled
  `features`.

### Changed

- New Claude Agent SDK projects pin `@anthropic-ai/sdk` 1.3.0 (was 0.137.0). The agent SDK uses it
  for types only.

### Fixed

- `files.upload(path, stream, { signal })` stops reading a `ReadableStream` body once `signal` aborts: the stream is cancelled and the call rejects with an aborted `TransportError` without sending a request. A body stream that fails rejects with `TransportError`, keeping the stream's error as its `cause`.

## 0.6.11 — unreleased

### Changed

- `diffBodies` (`@indx-workspace/sdk/portable`) also diffs the `policy` tool rules, `subagents`, `knowledge` and `description`, and `uncoveredKeys(before, after)` names the top-level fields it does not cover.

### Deprecated

- A `skills.import` file given as `contentBase64` is deprecated; pass its bytes as `body`. The
  first such file a process sends logs one warning, and the form is removed in the next major
  release. `skills.import` already sends `multipart/form-data` either way.

## 0.6.10 — unreleased

### Added

- `triggers` (ADR-0144): `list`, `get`, `create`, `update`, `remove` and `rotateSecret` over
  `/api/triggers`; `create` and `rotateSecret` return the URL secret once.
- `runs.start` takes `attachments` (ADR-0146): workspace files the run receives read-only.
- `RunEventFrame` gains the `run-warning` kind, a platform notice such as
  `attachments_removed_shell`. It carries a resume `id` and is not an agent event (`toAgentEvent`
  returns `null`). Before this, a `run.warning` frame was read as an agent frame and refused.
- `runs.outputs(runId)` lists the files a completed run wrote to its `outputs/` directory (an agent
  with `writeFiles`), each with its `name` and the `path` `files.download` takes. It is the files
  list over the run's prefix; no new route.
- `engine.requireApproval` on the `claude-agent-sdk` engine settings: tool names (`Write`,
  `mcp__gh__*`) whose every call waits for approval. `defineAgent()` refuses a rule for a tool the
  permissions turn off, a tool also in `autoApprove`, and a rule with a `(specifier)`;
  `toAgentVersionBody()` refuses a non-empty list until the Claude adapter honours it.
- `runs.start` takes `outputSchema`: a Zod schema, sent as JSON Schema 2020-12, or a JSON Schema
  object as is (ADR-0143). `runs.result(runId, { schema })` waits for the run, then returns its
  `text` and its structured `output`, parsed and typed by `schema`; an answer that does not match
  is a `ContractViolationError`. A run that failed or was cancelled resolves with a `null` text and
  `null` output. `RunResource.output` carries the answer; `fixtures.run()` defaults it to `null`.
- `defineAgent({ engine: { id: 'claude-agent-sdk', handoff: true } })` offers the agent a `handoff_to_person` tool; the run then ends `completed` after one `agent.handoff` event carrying the reason. The agent's policy is stored, as with `requireApproval`.
- `toAgentEvent` parses the `agent.handoff` frame.
- `runs.start({ subject })` names the person a run acts for, and the platform signs it into the identity headers of every tool call that opts in.
- `verifyIdentity` is exported to check that signed assertion in your own tool server.
- `openapiTool` accepts `identity` so an OpenAPI tool can opt in to the caller assertion.
- `skill(name, { revision })` pins a skill revision in `defineAgent`; the pin lands in the saved version's `resources.skillRevisions`, and an unpinned skill adds no key.
- Runs carry `agentVersion`, so a run id leads to the agent version, and through `agents.versions.list` to the skill revisions it pinned.
- `runs.start({ fileScope })` narrows a run to part of the agent's file grants, so built-in `search_files` and the sandbox cover only those paths. A path outside the grants fails the run with `run_file_scope_not_granted`.
- `agentFromVersionBody()` and `toolModulesOf()` in `@indx-workspace/sdk/define`: the inverse of `toAgentVersionBody()` for an Agent Workspace project. File grants, tools from the project's modules, `mcp()` connectors and code tools come back, and anything that cannot is reported as a drop, never silently. Code tools are named by `codeToolNames` or by the body's `toolBundles`; a pinned bundle that differs from the module's `defineTool()` value is dropped.
- `files.completeUpload(path)` finishes a signed-link upload and returns the ready file.
- `files.upload` now uses a signed link (mint, `PUT` to the object store, complete) for a body larger than `MAX_UPLOAD_BYTES`, or with `{ direct: true }`. A store that cannot sign (`501 direct_transfer_unsupported`) falls back to the relay unless `direct` is set. A `Blob` is streamed to the store, not buffered. Until the server accepts a signed-link size above `MAX_UPLOAD_BYTES` (#1640), such an upload fails at the mint with `400` instead of `413`.
- `runs.start(agentId, { idempotencyKey })` sends the key as the `Idempotency-Key` header: a start
  retried with the same key and input answers with the run the first one queued instead of starting
  another (ADR-0151). The same key with a different input is `409 run_idempotency_conflict`; a blank
  key or one over 255 characters is `400 invalid_idempotency_key`.
- `client.storage.connections` connects a bucket or folder and browses it: `list`, `get` (by id or name), `create`, `update`, `remove`, `rotateCredential`, `test`, and `browse`, an async iterator over the entries of a folder. No method returns a credential. The server percent-decodes the browse `prefix` once before checking it, so a folder whose name holds a space or a non-ASCII character can be opened.
- `shares.publish` sends a session share's `transcript: { runIds }`, and only the run ids, so text a caller holds never reaches the body.
- `triggers.create` and `triggers.update` take an `outputSchema`, a Zod type or a JSON Schema object,
  so the runs a trigger starts return typed output that `runs.result` reads.
- `triggers.create` and `triggers.update` take a `subject`, so a scheduled or webhook run reaches a
  subject-scoped connector as that caller.
- `runs.start` takes an `idempotencyKey`, sent as the `Idempotency-Key` header, so a retried start
  answers the run already started.

### Changed

- New projects pin the engines this release was built with: `@anthropic-ai/claude-agent-sdk`
  0.3.310, `@earendil-works/pi-*` 1.4.0 and `@mastra/core` 1.79.0 (`@mastra/mcp` 2.5.0,
  `@mastra/memory` 1.39.0).
- `openapiTool()` in `@indx-workspace/sdk/define` accepts write rules (`POST`, `PUT`, `PATCH`,
  `DELETE`, or an `operationId:<id>` naming a write). Compose adds every write operation to the
  agent's `requireApproval` as `mcp__<server>__<operation>` for a `claude-agent-sdk` agent, and the
  gateway runs it only for an approved call. A stored policy whose `permissionMode` is not
  `default` and that uses such a connector fails to compile, since `requireApproval` needs the
  `default` mode.
- `runs.outputs` no longer filters the server's temporary archive: the server saves run outputs as artifacts and never lists its staging files.

### Fixed

- `runs.follow` (and so `runs.waitForOutcome`) counts only consecutive failed reconnects against
  `maxReconnects`: a reconnect that delivers a new event resets the count, so a long run behind a
  proxy that drops idle connections is no longer cut off. A `5xx` or `429` answer to a reconnect is
  retried like a dropped connection, waiting the `Retry-After` it names.
- Selecting a workspace (`workspace` client option) releases the response body instead of holding
  the connection until garbage collection.

## 0.6.9 — 2026-10-14

### Changed

- An error envelope that carries a field this contracts version does not know (a newer server
  inside the served range adding, say, `requestId`) is still read as an `ApiProblemError` with its
  `code`, rather than as `unrecognised_error_body`. Success bodies stay strict.

## 0.6.8 — 2026-10-14

### Added

- `ENGINE_PACKAGES` and `projectDependencies(version, engine)` in `@indx-workspace/sdk/project`;
  `renderProjectShell` takes the project's `engine` and pins its packages (#691).

## 0.6.7 — 2026-10-13

### Added

- `parseSseFrame`/`RunEventFrame` carry an optional validated `at` (control-plane record time) on
  durable frames (#1113).

## 0.6.6 — 2026-10-13

No changes; released in lock-step with the other packages.

## 0.6.5 — 2026-10-13

No changes; released in lock-step with the other packages.

## 0.6.4 — 2026-10-13

No changes; released in lock-step with the other packages.

## 0.6.3 — 2026-10-12

No changes; released in lock-step with the other packages.

## 0.6.2 — 2026-10-12

### Added

- `renderProjectFiles` writes the `platforms:` block for the platforms the `admin.platforms` answer
  chose, in `PLATFORM_IDS` order, plus a "Publish to other agent platforms" README section (a new
  README.md for the blank theme) and an "Other agent platforms" AGENTS.md section; `parseSetupFlags`
  reads `--platform` (issue #977, part of). With `none` the files are byte-identical.
- `defineAgent({ engine: { id: 'claude-agent-sdk', autoApprove: ['Bash'] } })` declares the tools a
  Claude run may use without a person to approve them. `permissions.runCommands` alone only keeps
  Bash out of `deny`, so an unattended run answered with the approval prompt instead of the work.
  The list is stored in the version's `tools.autoApprove` (`policySource: 'stored'`), each entry
  must be a granting rule, and a rule for a tool the permissions turn off is refused (issue #1021,
  part of; #881).
- `toPortableAgent()` writes a read-write grant that is also a knowledge file as a `files` knowledge
  source with `access: 'read-write'` (read paths first), and `defineAgentFromPortable()` grants it
  again, reporting `knowledge.<i>.access` as dropped while `permissions.writeFiles` is off (issue
  #969, part of; ADR-0133 D2).
- `aw.endpointClients.rotateSecret(id)` over `POST /api/endpoint-clients/:id/secret` (issue #971, part
  of; ADR-0134): mints or rotates the OAuth client secret and returns it once.
- `toPortableAgent()` reports `definition.resources.files.<i>.access` as dropped when a read-write
  grant is also a knowledge file: the portable form keeps the path read-only (issue #969, part of;
  ADR-0133 D2).
- `defineAgent()` takes `description`, `subagents` (a defined agent or its name) and `knowledge`
  (`files` or `connector` sources; the new `KnowledgeSource` type), and `toAgentVersionBody()` maps
  them (issue #969, part of; ADR-0133). The portable converters carry all three, and a `url`
  knowledge source is reported as dropped on the way in.
- `aw.endpointClients.list|get|create|update|revoke|mintKey` over `/api/endpoint-clients` (issue #949,
  closes; ADR-0134): the client an external platform is bound to and its endpoint-scoped API keys.
  `mintKey` returns the key once.
- `agent-workspace.yaml` accepts an optional `platforms:` block (ADR-0133): one entry per platform
  id with `enabled`, `options` and per-environment overrides; credentials only as
  `{ secret: NAME }`. `parseProjectFile` locates a refusal at the offending line (issue #959).
- `@indx-workspace/sdk/portable`: `parseAgentMarkdown` and `formatAgentMarkdown` read and write
  `agents/<name>.agent.md`, the portable agent file, strictly and round-tripping, with
  `AGENT_MARKDOWN_SUFFIX` (issue #950, part of; ADR-0133 D3). The `PortableAgent` and
  `PortableProject` types are re-exported.
- `@indx-workspace/sdk/portable`: `toPortableAgent`, `portableFromAgentVersionBody` and
  `defineAgentFromPortable` convert an agent to and from `PortableAgent`, returning the value and a
  `dropped` list of what the target cannot carry (issue #954, part of; ADR-0133 D5), with the
  `PortableConversion`, `PortableDrop`, `PortableAgentContext` and `PortableCodeToolDeclaration`
  types.
- `@indx-workspace/sdk/portable`: `loadPortableProject` assembles the `PortableProject` a platform
  translator takes from a project's TS and `.agent.md` agents and the skill, knowledge and OpenAPI
  bytes a caller-injected `PortableProjectSource` reads. Each agent gets only the code tools it
  lists (`codeToolNames`). Failures are a `PortableProjectError` with a stable code (issue #954;
  ADR-0133 D5).

### Changed

- `renderProjectShell()` writes the runtime tree's security overrides into the starter's
  `package.json` (`overrides`, for npm) and `pnpm-workspace.yaml`, copied from the repository root:
  `@mastra/mcp` pins the vulnerable `@modelcontextprotocol/client@2.0.0` exactly, and only the
  installing project can lift it (BH061-007).
- A `TransportError`'s message names the network failure behind it, for example
  `(fetch failed: connect ECONNREFUSED 127.0.0.1:3000)` after "the request could not be completed",
  instead of leaving it two `cause` levels down (BH061-039). `cause` is unchanged.
- `createClient()` refuses a `baseUrl` that is not an absolute `http(s)` URL (`localhost:3000`,
  `aw.example.com`) with a `TypeError` naming the value, instead of a bare TypeError on the first
  request (BH061-039).
- `toPortableAgent` and `portableFromAgentVersionBody` carry an OpenAPI tool whose spec path starts
  with `./` (written without the prefix) instead of dropping it, and no longer report a Claude tool
  policy as dropped because its rules are in another order (issue #954).
- `writeProjectFileText` writes an empty mapping as a key's value as `key: {}` instead of refusing it;
  an empty mapping as a list item is still refused.

### Fixed

- `defineAgent()` names the nearest known key for an unknown one (`did you mean "instructions"?`),
  lists the engine ids for a bad `engine`, and the accepted forms for a bad `model` or a missing
  `instructions`, instead of `Invalid input` (BH061-046).
- A starter's `README.md` file map stays aligned once the agent's name replaces `{{agentName}}`
  (BH061-075).

## 0.6.1 — 2026-10-11

0.6.0 was cut as platform images only and its packages were never published to npm, so its entries ship in 0.6.1.

### Added

- The copilot starter's `web/` app has a `build` script and reads `VITE_AW_BASE_URL`, so
  `aw deploy` can build it for Vercel (#830, part of).

### Fixed

- The select menu counts East Asian wide and fullwidth characters as two terminal columns when it
  works out how many rows to erase, so a Japanese path in a menu title no longer leaves stale rows
  (UX-D, #760).

### Added

- `defineTool()` takes optional `secrets` (`secret('NAME')` references) and `allowedDomains`
  (host names or `*.suffix`), the secrets and hosts a code tool needs in a hosted tool sandbox
  (issue #791, ADR-0118 TS4, TS5). Left out, the tool has neither.

- `client.agents.evaluations` takes the asynchronous evaluation run (issue #799):
  `createRun(agentId, request)` stores a run of up to 200 cases, `advanceRun(agentId, evaluationId)`
  runs its next cases and answers its progress, and `getRun(agentId, evaluationId)` reads a run. `evals/<agent>.yaml` files take up to 200 cases and an optional `toolInput` beside
  `tool`.
- `client.toolBundles` (issue #790): `upload({ contentBase64 })` stores a bundled code tool by its
  SHA-256 digest (`created: false` when the workspace already held it) and `get(digest)` reads it
  back as `{ digest, sizeBytes }`; the bytes are never served back.
- `renderProjectFiles` also renders `AGENTS.md`: how a coding agent installs, starts in the
  background and checks the project without a terminal, with the model key variable for the
  provider and the key command for each shell (#760).
- `chooseFromMenu`, `confirmMenu`, `MenuCancelledError` and the `Choose`/`MenuSpec`/`MenuOption`
  types in `@indx-workspace/sdk/project`: a raw-mode arrow-key select menu on `node:readline`.
  `askSetupQuestions` takes it as a fourth argument and asks every choice and multi question
  through it; without it the typed prompt is used as before (UX-A, #760).

## 0.5.0 — 2026-10-06

### Added

- `renderProjectFiles` also renders the `support` and `copilot` starters as real files (first-hour
  programme FH-09, tracker #687): the `copilot` starter ships its page as `main.jsx.template.txt`
  with the page's packages pinned, and every starter keeps a `README.md`. A setup tool that would
  overwrite a starter file is refused.
- Secret names resolve on the server (ADR-0114 S4, FH-08): `planProjectResources` selects a secret
  by its exact name, refuses a name that matches none, and sends the name instead of an id.
- `planProjectSkills({ skills, existing })` in `@indx-workspace/sdk/project` plans the
  `skills/<name>/` folders on their own (create, update when the content hash differs, unchanged
  otherwise); `planProjectResources` delegates to it, and `aw dev` / `aw push` use it to sync
  skills (#694, #748).
- `renderProjectFiles` with theme `automation` also renders a complete starter project: a code tool
  (`tools/delivery-estimate.ts` and its run file), an OpenAPI tool over a fake orders API the starter
  includes (`fake-api/`, started with `node fake-api/server.ts`), a `README.md` and an `evals/<agent>.yaml`
  of three cases (#696). It refuses an OpenAPI document whose tool name would overwrite one of those
  files, and `aw init` refuses a directory that already has one (for example a `README.md`).

### Fixed

- `planProjectResources` with no `models` now brings an existing `default` connection in step when
  `ANTHROPIC_API_KEY` is set: a `model` update, with a notice naming the host, when
  `anthropicBaseUrl` differs from the new optional `sentAnthropicBaseUrl` (the value recorded at the
  last start; an absent `anthropicBaseUrl` clears it; with nothing recorded only a set value that
  differs from the connection's is applied), and a `model-credential` rotation when the key's fingerprint changed
  (#732). With the key unset, or a `default` that is not `anthropic`, it plans nothing, as before.

## 0.4.0 — 2026-10-05

### Added

- `client.runs.rate(runId, { rating, comment? })` (`POST /api/runs/:id/feedback`, issue #665)
  rates a run's answer thumbs-up or -down.

- `defineTool({ name, description, input, output?, run, limits? })` in
  `@indx-workspace/sdk/define` (FH-06, #709), which also re-exports `z`. `input` and `output` are
  stored as JSON Schema; `run` is a project-relative `.ts` or `.js` path the declaration never
  imports; `limits.timeoutMs` defaults to 30000 (at most 600000). It declares the new `code` tool
  kind (`CodeToolSchema`), and `ToolRun<T>` types a run function from its declaration.
- `client.runs.start` takes an optional `version` (#725): run a new session on that numbered
  version instead of the one `local` points at. An unknown number is `404 agent_version_not_found`,
  and `version` with `sessionId` is refused. A 0.3.0 server rejects the field, so leave it out
  against 0.3 servers.
- `@indx-workspace/sdk/project`: every setup question can be answered by its flag, so
  `parseSetupFlags` and `setupFlagsHelp` answer the interview from the command line, and a
  non-terminal run takes the recommended answers (#708). The rendered `package.json` carries
  npm's `allowScripts` (#722), and new projects render `evals/<agent>.yaml` (#711).
  `appendEvalCase` adds a case to an evals file and keeps its comments and order (#719).
  `planProjectResources` takes the project's `skills/<name>/` folders and returns a `skills` list:
  create, update when the content hash differs, unchanged otherwise (#713).

## 0.3.0 — 2026-10-04

### Added

- `client.agents.feedback.list(agentId, { rating?, since?, runId? })` (`GET
/api/agents/:id/feedback`, issue #620). `writeProjectFileText` writes a list of non-empty
  mappings, such as an eval file's `cases:`.
- `client.agents.evaluations.create(agentId, { version, cases })` (`POST
/api/agents/:id/evaluations`, issue #618) and `readEvalCaseFile(text, label)` in
  `@indx-workspace/sdk/project`, which reads an `evals/<agent>.yaml` case file with the project
  file's reader rules and `EvalCaseFileSchema`. `readProjectFileText` and `ProjectFileError` take
  an optional file label (default `agent-workspace.yaml`, so existing messages are unchanged), and
  a refusal inside a list is now located at the list item rather than at the list's key.
- `@indx-workspace/sdk/define`, agents and surfaces as code (issue #445, contract C3):
  `defineAgent`, `defineSurface`, the references `mcp`, `skill` and `files`, and
  `toAgentVersionBody`, which turns a defined agent and its surfaces into the body
  `AgentVersionBodySchema` parses. Every `define*` call and helper validates eagerly with a strict
  schema and throws `DefinitionError` (`code: 'invalid_definition'`, dotted `issues[].path`);
  `isDefinedAgent` and `isDefinedSurface` recognise the brand across module copies. The module is
  isomorphic: no `node:*` import. The policy is `compiled` (what the server's own compilation
  yields) unless a limit with a value (not an empty `limits: {}`) or an engine other than `claude-agent-sdk` is given; then it is
  `stored`, including for a non-default engine with no settings. `model: 'default'`, or no
  model, is sent as `modelConnectionName: 'default'` for the server to resolve to the
  deployment's default connection (C7). An `instructions: { file: './x.md' }` reference must be
  resolved by the caller and passed as `toAgentVersionBody(agent, { instructions })`.
- Tools and secrets in `@indx-workspace/sdk/define` (issue #532, S2-03a, contracts C10, C12 and
  C15): `secret(name)`, a `{ secret: NAME }` reference that never holds the value and refuses a
  bad or runtime-reserved name; `openapiTool` (a project-relative or `https` `spec`, `GET`/`HEAD`
  `allow` rules, bearer or header `auth` from a secret reference) and `postgresTool` (`url` is a
  secret reference, `readOnly: true` only); the guards `isOpenApiTool` and `isPostgresTool`; and
  `toolDefinitionsOf(agent)`, the unresolved OpenAPI and PostgreSQL tool specs, read without any
  file or secret value. An agent's `tools` now accepts `mcp`, `openapiTool` and `postgresTool`
  values, each named in `resources.connectors`, and refuses a repeated tool name across kinds.
  `toAgentVersionBody` gains the `defaultEngine` option, the project's engine for an agent that
  names none; the agent's own `engine` wins.
- `@indx-workspace/sdk/project`, the one reader and the one renderer of `agent-workspace.yaml`
  and the project files (issue #446, contract C4, ADR-0103, ADR-0107). The module is isomorphic:
  no `node:*` import.
  - `readProjectFileText` is the ADR-0089 reader, moved from `@indx-workspace/cli` with its
    refusals unchanged (anchors, aliases, custom tags, directives, duplicate keys, second
    documents, non-text keys), and `writeProjectFileText` now writes nested mappings at any
    depth; two-level output is byte-identical to the CLI's former serializer.
    `parseProjectFile(text)` reads and validates a v2 project (lifting a v1 file) and reports a
    schema refusal at the offending key's line and column, with its dotted path.
  - A refusal's detail now says `agent-workspace.yaml` instead of "the deployment profile". The
    CLI's `ProfileDocumentError` is now this `ProjectFileError` (its `name` is
    `ProjectFileError`); the message prefix `agent-workspace.yaml line L, column C: ` is the same.
  - `renderProjectFiles(answers, { name })` writes `agent-workspace.yaml`, `agents/<name>.ts` and
    `surfaces/main.ts` from complete setup answers; `surfaces/main.ts` carries `title` from
    `embedder.surfaceTitle` (C4, ADR-0108 as amended). Every file is checked through
    `defineAgent` / `defineSurface` before it is written, and a refusal throws
    `ProjectRenderError`.
  - `renderProjectShell({ name, version })` writes `package.json`, `pnpm-workspace.yaml` and
    `.gitignore`; `package.json` pins exactly three dependencies, `@indx-workspace/aw`,
    `@indx-workspace/embedded` and `@indx-workspace/sdk`, at the exact `version`.
    `projectNameFor(directoryName)` is the one rule `aw init` and `create` name a project by.
- Tool connectors, the apply plan and a wider writer (issue #533, S2-03b, contracts C10, C11, C15
  and SD16):
  - `client.connectors.create` and `update` take an `openapi` or `postgres` body,
    `ToolConnectorBody` (the contract's create body without `dryRun`), and parse the tool-kind
    resource. A tool connector is updated with its whole create body, which registers it again in
    place. Only the keys the body type names are sent; MCP bodies are unchanged.
  - `planProjectResources({ project, tools, existing, secrets, anthropicBaseUrl })` in
    `@indx-workspace/sdk/project` returns `{ creates, updates, refusals, notices }`: what
    `aw dev` creates, updates, refuses and reports for the project's `models` (C11; without
    `models`, C6's `default` only), `connectors` and its agents' tools. It is pure, never deletes,
    and holds no secret value: an action names its secret and the caller sends the value. A
    credential is rotated when the server has none or when the secret's fingerprint differs from
    the one recorded at its last send; with no recorded fingerprint it differs, so the first
    `aw dev` after this change rotates each declared credential once and records it. An unset
    secret is a notice and its resource is skipped.
  - `writeProjectFileText` writes booleans, finite decimals and lists of text, numbers and
    booleans (an empty list as `[]`), so it renders `models`, `connectors` and `policy`. NaN and
    the infinities are refused with `must be a finite number`; the catch-all refusal now reads
    `must be text, a number, a boolean, a list of those or a non-empty mapping`.
  - `fixtures.modelConnection`, `fixtures.connector`, `fixtures.openApiConnector` and
    `fixtures.postgresConnector` in `@indx-workspace/sdk/testing`.
- Agent versions and environment pointers (issue #447, S1-09):
  - `agents.versions.list(agentId)` returns `{ items, pointers }` (`GET /api/agents/:id/versions`);
    `agents.versions.create(agentId, draft)` saves version N (`201`); and
    `agents.versions.check(agentId, draft)` is the same route with `dryRun: true`
    (`200 { ok, number }`, nothing written).
  - `agents.pointers.set(agentId, { environment: 'local', version })` moves a pointer
    (`PUT /api/agents/:id/pointers`).
  - `agents.create({ version, dryRun? })` is the create-from-version form: `201` with the created
    agent and its version, or `200 { ok, number }` for a dry run.
    The form is chosen by a `version` value, not by the key, so a legacy input carrying
    `version: undefined` still creates the agent alone.
  - Responses are parsed with `@indx-workspace/contracts/agent-versions`; refusals
    (`400 invalid_agent_version`, `404 agent_version_not_found`, `409 surface_name_taken`,
    `409 agent_name_conflict`, `422 agent_definition_references_missing`, …) surface as
    `ApiProblemError` with `status`, `code` and `details`.
  - `@indx-workspace/sdk/testing` gains `fixtures.agentVersion` and `fixtures.agentVersionPointer`.
- `InvalidArgumentError` (`kind: 'argument'`), the SDK's refusal of an argument before any request
  is made (issue #488): `code` is `'invalid_path_segment'` and `value` is the refused id. Never
  retry it; fix the argument. `AgentWorkspaceError.kind` widens to
  `'problem' | 'contract' | 'transport' | 'argument'`, so an exhaustive `switch` on `kind` (one
  that ends in a `never` check) must now handle `'argument'`.
- `askSetupQuestions(prompt, say)` in `@indx-workspace/sdk/project`, the one setup question loop,
  moved from `create` (issue #543, C20): it asks each question that applies, takes the theme's
  recommendation on an empty line, and after `say`ing why an answer is refused asks it again. It
  is isomorphic; the caller owns the terminal. `setupSecretNames(answers)` names the environment
  variables a rendered project reads its model key and tool credentials from.

- `ConnectorsClient.checkTool(body, { connectorId? })` dry-runs an `openapi` or `postgres`
  connector body (`dryRun: true`): `POST /api/connectors`, or `PATCH /api/connectors/:id` for the
  connector it would replace. It answers the server's `TestConnectionOutcome` and saves nothing; a
  refused document is the server's `422 connector_spec_invalid` (#549, C15).
- `toolConnectorBody(tool)` from `@indx-workspace/sdk/project`: the connector body, without its
  credential, that `planProjectResources` creates or registers a planned tool with (#549).

### Changed

- `renderProjectFiles` writes the chosen theme's instructions, greeting and suggested prompts, the
  permissions the answers switch on, `models.default` for a provider other than `anthropic`, and
  a `tools/<name>.ts` per internal tool, which the agent imports and lists. Theme `blank` renders
  the slice-1 files byte for byte (issue #543, SD9, SD12).
- `defineSurface` accepts ADR-0108 rung 2 completed (SD10, issue #537): `parts.history`,
  `parts.feedback`, `parts.agentSwitcher`, `parts.toolTrace: 'full'` and `toolResults`.
  `audience`, `allowedOrigins`, `limits` and attachments are still refused.

### Fixed

- Every resource method that puts an id in its path refuses an id that is `''`, `'.'` or `'..'`
  with an `InvalidArgumentError` rejection before any request (issue #488). Before, such an id
  was sent unchanged and the URL parser resolved it to a different route: `agents.get('..')`
  reached `/api/`, and `files.download('')` reached the list route `/api/files/`. A file path of
  `.` or `..` is still addressed, because its route id is base64url. The methods that refuse are
  now `async`, so the refusal is always a rejection and never a synchronous throw; their return
  types are unchanged.
- An id holding a lone UTF-16 surrogate is refused the same way, with `code`
  `'invalid_path_segment'`, instead of letting `encodeURIComponent`'s raw `URIError` escape untyped.

## 0.2.1 — unreleased

### Changed

- Lock-step patch release with `@indx-workspace/cli` 0.2.1. No change to this package.

## 0.2.0 — unreleased

### Added

- `runFailure(run)`, the run's stored `error` read through the contracts' `parseRunFailure`: the
  run-start problem code it failed with, if any, and its message, so a caller branches on the code
  rather than on prose (issue #393).

## 0.1.3 — unreleased

### Changed

- Lock-step patch release with `@indx-workspace/cli` 0.1.3, which pins platform images 0.1.2. No
  change to the SDK.

## 0.1.2 — unreleased

### Changed

- Lock-step patch release with `@indx-workspace/cli` 0.1.2 (issue #389). No change to the SDK.

## 0.1.1 — unreleased

### Changed

- Lock-step patch release with `@indx-workspace/cli` 0.1.1 (issue #377). No change to the SDK.

## 0.1.0 — unreleased

### Added

- Published to npm as `@indx-workspace/sdk`, in lock-step with
  `@indx-workspace/contracts` at `CONTRACTS_VERSION` (issue #246, ADR-0082). The tarball carries
  `dist/` and the manifests only.
- `@indx-workspace/sdk/testing`: `fetchDouble` (a recording `fetch`), `jsonResponse`,
  `eventStreamResponse`, `droppedEventStreamResponse`, `openEventStreamResponse`, `drain`, and
  `fixtures.agent`, `fixtures.run` and `fixtures.session`, which build resources the contracts
  schemas accept (P-2).
- Every request sends `X-Agent-Workspace-Contracts` with the contracts version the client was built
  against; a caller's `headers` option cannot override it (issue #244, ADR-0078).
- `ContractsVersionUnsupportedError`, a subclass of `ApiProblemError` raised for
  `426 contracts_version_unsupported`, with `skew` naming both versions and the side to upgrade.
- `readContractsVersionSkew(headers)`, the same verdict for a tool with its own HTTP client.
- `ContractViolationError.contractsVersion`, also named in its message.
- `createClient` and a client per resource family, the `./events` stream parser, and the three
  error classes.
