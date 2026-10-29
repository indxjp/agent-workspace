# Changelog

All notable changes to the Agent Workspace platform (images and deployment) are documented here.
npm packages have their own changelogs: `packages/<name>/CHANGELOG.md`. Release notes: [`docs/release/notes/`](docs/release/notes/).
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [SemVer](https://semver.org/).

## Unreleased

### Added

- `pnpm migrations:renumber` moves a branch's new migrations after the ones main landed (next
  number, strictly later `when`, unchanged SQL, merged snapshots) during `git merge origin/main`, and
  `pnpm migrations:check` in fast-checks rejects a journal that reuses a number or would skip a
  migration (engineering audit F-17).
- The console session composer has an **Attach file** control. It uploads through the session's attachments route, the next follow-up hands the attached files to its run as read-only attachments, and the control is disabled with a stated reason (English and Japanese) when the session's project is archived.
- The built-in `office-reader` skill's Word (`ooxml.mjs docx`) and DXF (`dxf.mjs`) readers take an
  optional output `.json` path inside the working directory: they write the parsed JSON there and
  print only `{ "written": "<path>" }`, so a large document or drawing reaches the next step without
  passing through the model.
- `GET /api/runs/:id` and `GET /api/runs` report `agentVersion`, the number of the agent version the run's session pins (`null` for a legacy session), so an auditor can go from a run id to the skill revision that applied.
- `POST /api/agents/:id/runs` honours an `Idempotency-Key` header (1 to 255 characters, scoped to
  the workspace and the calling principal): a repeat with the same key and body answers `202` with
  the original run whatever its status, a paused run included, and a different body answers
  `409 run_idempotency_conflict`. A continuation run's approved tool calls are recorded as consumed
  in the commit that starts it, and the database refuses to queue such a run again (ADR-0151,
  engineering audit F-09).
- A run granted a storage connection folder (`storage://<connection>/<folder>/`) now sees its files under `storage/<connection>/<folder>/`, named by the connection's current name. The files are read-only whatever the grant's access: write-back arrives with #1696. The grant stays bound to the connection it was deployed with and is checked again when the run starts: a connection that is gone, or no longer allows the folder, refuses the run with `run_storage_grant_unavailable` before it is queued. Files count toward the 128 MiB run limit, and a key that could leave the folder is skipped.
- The runner and the model gateway export OpenTelemetry spans when `OTEL_EXPORTER_OTLP_ENDPOINT` is
  set, as the web app does: one span per runner `/run` and per gateway request, and one per model
  call carrying the provider, model and status only. The spans join the W3C trace the request's log
  lines carry. Unset, neither process starts an SDK.
- `POST /api/skills` accepts `multipart/form-data` (a `name` field, then `SKILL.md`, then one `file` part per other file) and streams each part into storage, so a skill import holds no whole file in memory and uses no base64. The JSON body with `contentBase64` is deprecated: it still imports, with an RFC 9745 `Deprecation: @1792800000` header (deprecated 2026-10-24). `client.skills.import` and `aw skills import` now send multipart, one part per file, with no base64; `import` takes `files: [{ path, body: Blob | Uint8Array | string }]` and still accepts `contentBase64`.
- At start-up the server gives every file the old object naming left without a catalog row a row,
  in the background, so it is listed. It is on by default (`AW_STORAGE_MIGRATE` unset or `adopt`);
  `AW_STORAGE_MIGRATE=off` disables it. Until the run finishes after an upgrade, such a file may be
  missing from lists. It writes nothing to the bucket, leaves a removed file removed, and is safe to
  repeat or to run on two instances.
- The storage cleanup pass finds objects no file row points at (in the new and the old object naming), settles stale uploads and finishes interrupted deletes. This release runs it in report mode only: it counts and writes nothing.
- The storage cleanup runs hourly on a long-lived server, one server at a time. `AW_STORAGE_CLEANUP=report` (the default) only counts; `delete` removes objects no file row points at, never files in the old naming. Where `CRON_SECRET` is set (Vercel), the platform cron runs it through `GET /api/cron/storage-cleanup` instead: daily in the generated Vercel config, which Hobby requires, and hourly if a Vercel Pro project changes the schedule.
- `GET`/`POST /api/storage-connections` and `GET /api/storage-connections/:id` connect an S3 bucket or an operator-allowed folder to a workspace, read-only by default. Credentials are sealed in the secret store and never returned; Owners and Admins connect, Members list, Viewers see nothing.
- `PATCH /api/storage-connections/:id` renames a connection or changes its URL, allowed prefixes and write access. A URL that moves a connection holding a credential to another endpoint, account, bucket or container is refused (`409 storage_connection_credential_required`) unless the patch also sends the new `credential`, which replaces the stored one. `PUT /api/storage-connections/:id/credential` rotates its credential without ever returning the old one. `DELETE /api/storage-connections/:id` removes the connection and then its credential. Each change is audited once, and `/api/secrets` now refuses to delete or replace a storage connection's credential (`409 secret_in_use`, naming `storage-connection:<id>`).
- `POST /api/storage-connections/:id/test` opens the connection with its stored credential and lists one entry of an allowed folder, answering `{ok}` or a stable failure code, never the provider's reply; each test is audited once. `GET /api/storage-connections/:id/browse?prefix=&cursor=` lists a folder inside the connection's `allowedPrefixes`, compared segment by segment and never percent-decoded (`403 storage_connection_prefix_not_allowed` otherwise), and never shows an entry outside the prefix. Both go through the egress guard, are reads for Owners, Admins and Members, and answer `404` for another workspace's connection.
- Owners and Admins can edit a storage connection's allowed folders and write switch, rotate its credential and delete it at `/admin/storage/<id>`; Storage now has an entry in the Administration navigation (hidden from other roles), and a connected-storage grant can be removed from the agent's files editor.
- Owners and Admins can list, test and connect storage at `/admin/storage` (credentials are write-only and never shown again), and an agent's files group has a "Connected storage" picker that grants one folder of a connection to the agent, read-only by default.
- Deploying an agent with `files('storage://<connection>/<folder>')` now checks the grant against the workspace's own storage connection: a missing connection is `422 agent_definition_references_missing`, a folder outside the connection's allowed folders is `403 storage_connection_prefix_not_allowed`, and a `read-write` grant on a read-only connection is `403 storage_connection_write_not_allowed`. An accepted grant is not stored yet.
- A workspace may hold at most 100 unfinished signed-link uploads: minting another upload link answers `429 too_many_pending_uploads` and reserves nothing, until an upload is completed. Upload and download link requests are also limited to 60 per minute per workspace on each server; the next one answers `429 link_rate_limited` with `Retry-After`.
- Self-hosting docs state at-rest encryption, credential sources and bucket scope for stored files, and map each old storage variable to `AW_STORAGE_URL`.
- `POST /api/files/:id/upload-complete` finishes a signed-link upload: it checks the object the `PUT` wrote and marks the file ready, so it is listed, searched and can be given to an agent. An object larger than declared or over the upload limit is deleted with its pending row, and a missing or smaller one answers `409 upload_not_verified` and leaves the row pending.
- Signed upload links accept files up to the deployment's `AW_STORAGE_SIGNED_UPLOAD_MAX_BYTES` (default and maximum 5 GiB) instead of 64 MiB; a larger request answers `413 request_body_too_large`, and a malformed value stops the server from starting.
- A completed run granted a connection folder with `read-write` access now saves its new and changed files back to that folder on the connection. The write is checked again when the run finishes: the connection must still allow writes, the grant must still be `read-write` and the agent must still be allowed to write files. Nothing is ever deleted, nothing is written outside the granted folder, a file that changed on the connection while the run was going keeps the connection's version, and one file that cannot be saved does not stop the others or fail the run. Only a run that ends `completed` is saved. The save happens before that status is written, so the session stays busy and the next message cannot start a run that overwrites the folder before it is saved. The save stops at its deadline, before the host's time limit runs out, or when the run is interrupted (the run then ends `cancelled`), and the files it did not reach count as failed. A failed save never changes the run's status. The files go to the connection that was delivered, even if it is renamed during the run. A run that wrote, refused, conflicted or failed on a connection leaves one `storage-connection-written` audit row for that connection, with the counts and, when a check refused the write, its reason code.
- A trigger can carry an `outputSchema` (ADR-0154). A webhook firing or a schedule pass starts its
  run with that schema, so the run returns typed output; an engine without structured output
  answers `422 engine_capability_unsupported`. Migration `0062` adds the nullable column.
- A trigger can carry a `subject` (ADR-0156). A webhook firing or a schedule pass starts its run as
  that caller, so a subject-scoped connector answers it; the firing body cannot set it. Only a member who may create API keys may set or
  change a subject, or edit a trigger that has one (`403 trigger_subject_not_allowed`); any editor
  may clear it. Migration
  `0064` adds the nullable column.
- The Files screen uploads files above 64 MiB through a signed link straight to the object store, shows an "Uploading <name>…" status while it runs, and says "This file is too large for this deployment." when the deployment cannot take the file. `compose.yaml` passes `AW_STORAGE_SIGNED_UPLOAD_MAX_BYTES` (5 GiB default) and restricts the bundled SeaweedFS S3 gateway's CORS origins to the app origin.
- `GET /api/audit-events` rows of `agent-created` name the Builder run that created the agent in a new optional `builderRunId` field. `aw audit list` prints it as a `builderRunId` column, and `--json` and `client.observability.audit.list` carry it. An SDK or `aw` older than this release parses audit rows strictly and rejects a page that contains such a row; upgrade the client to list them.
- An agent allowed to build can now call the Builder's tools from its own run. It cannot create
  more agents than the workspace's daily creation quota (counted in UTC and re-checked inside the
  create transaction), and it can try or evaluate only an agent it made or one no wider than itself.
- The new-agent page gains a Form | Chat switch. In Chat, you describe the agent and the Builder drafts it next to a live preview of the definition. Every save, trial and evaluation (running the eval cases) shows an approval card with the exact diff and any policy warning before it runs; validating a draft (`draft_check`) runs without asking, because it changes nothing. The guide "Build an agent in chat" explains it. It is available once an admin enables the `builder` feature for the workspace.
- `POST /mcp/builder` lets an outside MCP client such as Claude Code read the Builder's catalogue, examples and draft checks as the member who approved it through OAuth. It lists only `catalog_list`, `examples_get` and `draft_check`, answers every write or spend tool with `read_only_client`, and is available once the `builder` feature is enabled.
- After the Builder saves an approved draft, the definition preview says "Saved as version N on local" with three links: Try it opens a new chat pinned to that version (`/?agent=<id>&version=<n>`), View history opens the agent's versions tab, and Promote opens its Release section. The Builder itself never promotes.
- The Builder can save a draft agent with `draft_save`, try it with `trial_run` (capped at 0.30 USD) and score it with `evals_run`, each only after the person approves the call. A save lands on `local` as a version whose source is `builder`, never on `production`, and a new agent writes one `agent-created` audit row naming the person who approved it. Available once the `builder` feature is enabled.
- `policy.maxCostPerDayUsd` sets a daily model-spend cap for a workspace. A run start is refused with
  `429 daily_cost_cap_reached` (details `capUsd`, `spentUsd`, `resetsAt`) once the workspace's
  spend for the current UTC day reaches the cap. The cap applies to every run in the workspace and
  to every way a run is started: the API, approvals, A2A, the Builder, and visitor runs on a public
  share (which see the share's usual "unavailable"). It fails closed: if the day's spend cannot be
  read, the start is refused with `503 daily_cost_unavailable`. If any run with usage today has
  unpriced spend (stored as 0), the cap cannot be measured, so the start is refused with
  `daily_cost_cap_reached` and `unpricedUsage: true`. The cap is checked at run start only; a run
  already running is not stopped mid-run, and enforcing it at the gateway's next model call is a
  follow-up slice. Each web instance reuses a workspace's sum for up to 60 seconds.
- A storage connection to GCS can hold a short-lived access token instead of a service-account key. The server sends it as the bearer and never looks up application default credentials or a project; a token-backed connection has no signed URLs. Create, patch and credential rotation refuse a token on a URL without `?project=`. A token expires in about an hour; rotate it with `aw storage connections credential`.
- A storage connection to S3 can hold temporary (STS) credentials: the credential's optional `sessionToken` is sent with every request. Temporary credentials expire; rotate them with `aw storage connections credential`.
- A platform setting, `AW_STORAGE_CREATE_BUCKET`: `true` creates the bucket of an `s3://` `AW_STORAGE_URL` on first boot, idempotently, as the old settings did for the bundled SeaweedFS. Unset or `false` never creates one, and any other value stops start-up. It is not a URL parameter, so a storage connection cannot ask for a bucket.
- The "Use your own bucket" guide: connect an S3, Google Cloud Storage or Azure Blob bucket, or a local folder, give an agent a folder of it, run, and read the write-back.
- Agents an agent made (a Builder, or an agent's own `agents.create`) are archived automatically
  once they are 30 days old with no run in the last 30 days. The sweep is offered on every
  `/api/cron/triggers` delivery, or on a 15 minute timer when the deployment runs interval
  triggers, and runs at most once an hour per instance. It writes an `agent-changed` audit row
  (`{ archived: true }`) per agent. An archived agent refuses every run start with `409
  agent_archived`. Agents a person created are never auto-archived.
- The console shows an Archived badge (English and Japanese) on an archived agent's page and in the
  agent list, with the archive time on hover. Anyone who may restore the agent (the Owner, an Admin
  or the agent's owner) also gets a Restore button on the agent page. The agent list hides archived
  agents and has a Show archived toggle (`?archived=include`).
- `POST /api/agents/:id/restore` brings back an archived agent. The workspace Owner, an Admin or the
  agent's owner may call it, with no request body. It clears `archivedAt` and writes one
  `agent-changed` audit row (`{ archived: false }`); restoring an agent that is not archived is a
  `200` that changes nothing and writes no row. The auto-archive sweep leaves a restored agent
  alone for 30 days, so an agent someone restored is not archived again the next hour. The
  `agent-changed` audit details are now `{ archived: boolean }` (were `{ archived: true }`).
- The Azure Container Apps Terraform module takes `storage_blob_endpoint`, the storage account's blob endpoint in a sovereign cloud (`*.blob.core.usgovcloudapi.net`, `*.blob.core.chinacloudapi.cn`). It reaches web as the `endpoint=` of `AW_STORAGE_URL`; left unset, the public cloud's endpoint applies as before.
- An admin can let a named agent build agents through the Builder's tools: a policy key
  (`builder.allow`), a creator that can never give a new agent more than it has, a daily creation
  quota, a per-day cost cap and automatic archiving. The guide "Build an agent in chat" explains the
  setup.
- A run of the Builder, or of a person-made agent whose name the deployment's `builder.allow`
  lists, now has the `aw-control` tools. A run the rule does not give them to is refused
  `not_allowed_to_build` at the door, before anything is journalled. The composed door does not
  widen the agent. The server logs one warning per agent when it first sees a run of an allow-listed
  agent whose owner is not an Owner or Admin of its workspace.
- Creating an agent with a name in the deployment's `builder.allow`, or renaming one to it, needs a
  workspace Owner or Admin; a Member is answered `403 builder_name_reserved`. An edit that keeps an
  agent's stored name is not a rename.
- A console create of an agent now takes the per-workspace creation lock, so it cannot race a
  Builder or agent create past the workspace's agent limit.
- A workspace with the `builder` feature on now has its Builder agent: the web server ensures it for every such workspace at start-up, when a features write switches `builder` on, and when `POST /api/workspaces` creates a workspace.
- The Builder never counts as a workspace's only agent: `aw chat` with no agent name still picks the one agent you made, its "name the agent" list leaves the Builder out, and the console's new chat does not open on the Builder unless you last chatted with it or it is the only agent. `aw chat builder` still runs it.
- A running run in a workspace over its `maxCostPerDayUsd` is now stopped at its next model call, and ends `failed` with the visible reason `daily_cost_cap_reached` (the cap and the reset time, not the spend). A spend that cannot be read refuses the call with `daily_cost_unavailable` and leaves the run running. Deploy the gateway before, or with, the web service: it must know the new run token claim.
- The Helm chart takes `storage.url`, an `AW_STORAGE_URL` (`s3://`, `gcs://`, `azblob://` or `file://`) that web, the gateway and the runner manager read in place of the object-store Secret's copy. Left empty, the default, the Secret still supplies it.
- A route whose feature is not installed in the deployment (`AW_DEPLOYMENT_FEATURES`) or is switched off for the caller's workspace answers `404 feature_disabled` with `details: [<feature id>]`. The deployment check runs at the edge before authentication; the workspace check runs once the route's own credential verifies and before any row is read. With the variable unset and no switched-off features, every answer is unchanged.
- `GET /api/workspaces/:id/features` lists every feature with whether the deployment installs it
  and whether the workspace has it on (any member); `PUT` replaces the workspace's whole off set
  (Owner of that workspace only). A change that moves the set writes one
  `workspace-features-changed` audit row; a `PUT` that leaves it as it was writes none. Switching
  off a feature another enabled feature needs is `409 feature_in_use`; naming one the deployment
  does not install as on is `409 feature_not_installed` (ADR-0160 D6–D8).
- `GET /api/me` carries the caller's workspace's enabled `features`, in `FEATURE_IDS` order
  (ADR-0160 D8).

### Changed

- The runner logs one JSON object per line (`time`, `level`, `service`, `msg`, then fields such as
  `runId`) instead of `[runner] …` text, with tokens and URLs in field values redacted. The control
  plane forwards the active W3C `traceparent` on runtime requests when OpenTelemetry is configured,
  and the runner adds its `traceId` to that request's log lines; a malformed header is ignored
  (engineering audit F-04).
- `RunRequest`, the agent configuration schemas and the Claude `agent.*` mapping moved from
  `packages/core` into the private `packages/run-protocol`, which depends only on the contracts and
  the engine port. Callers import `@agent-workspace/run-protocol` directly, `@agent-workspace/core`
  no longer re-exports it, and `packages/core` may depend only on the contracts (engineering audit
  F-08).
- Pull requests no longer edit `CHANGELOG.md` files: each adds a `changes/<slug>.md` fragment, and
  the release pull request merges them with `pnpm changes:collect` (`changes/README.md`). CI's
  `Changelog fragment gate` fails a pull request that edits a `CHANGELOG.md` outside a `release/*`
  branch.
- The contract-review gallery use case scopes each review to the signed-in legal member's deal teams: contracts sit at `contracts/<deal-team>/`, `data/access.json` lists each member's teams, and `reviewContract` starts the run with `subject` and a `fileScope` of those folders, the playbook and `drafts/<team>`. A member with no team, or an attachment outside their teams, is refused before any run starts. The tutorial gains the scoping step and the Per-user scope cell is now met.
- The quality-defect gallery use case reads past cases, full reports and 4M counts from the QMS API with `openapiTool()` instead of a hosted MCP server, and its one write, `createCase`, is gated by the tool. The Search cell is now ✅.
- The model gateway logs one JSON object per line (`time`, `level`, `service: "gateway"`, `msg`,
  then fields), like the runner, instead of plain text, and a failed request is now logged. Each
  request line carries a `traceId`: the runner forwards its run's W3C `traceparent` and
  `tracestate` on the Claude engine's model calls, the gateway joins that trace, and a missing or
  malformed header starts a fresh trace instead (engineering audit F-04).
- A `MASTER_ENCRYPTION_KEY` that is set but malformed no longer looks like an unset key. The server still boots with the secrets, models and connectors routes answering `503`, but the new unauthenticated readiness probe `GET /api/readyz` answers `503` and the boot log names the variable and the expected format (64 hex characters), never its value. The Helm chart's web readiness probe now reads `/api/readyz`, so a bad key stops a rollout. An unset key keeps today's behaviour and passes readiness.
- Runs accept up to 128 MiB of granted files; a start whose files total more answers `422 run_files_too_large` before the run is queued. The run request names each granted file, skill file and attachment by path, size and SHA-256 instead of carrying its bytes, and the server streams one archive into the sandbox with flat memory. A stored file whose bytes no longer match its checksum fails the run with `run_file_corrupt`.
- An attachment is granted to the run it was sent with (ADR-0146): a follow-up turn in the same session that does not attach it again no longer sees the file.
- Session state saves through the storage service: each save writes a new object under the workspace's `session-state/` area and swaps the catalog row only after the bytes are stored, so a failed or oversize save leaves the previous state intact and no stray object. Existing state keeps resuming from its old location until it is next saved.
- Skills read and delete their files through the files catalog: a skill stored as catalog rows under `.skills/` is listed, exported and delivered to runs, and deleting it removes its rows, its revision rows and their objects. A skill stored the old way keeps working. The files API never lists, searches, downloads or attaches a skill's rows, and refuses to rename or recursively delete them. A new file, folder or rename into `.skills/` answers `400 reserved_path`. A file a user already kept under `.skills/` still lists, downloads, deletes and renames out.
- A skill's pending delete and the digest of its installed built-in release are recorded on the skill row (`skills.pending_delete`, `skills.builtin_digest`; migration 0074 also adds `skills.meta`) instead of as marker objects. Markers an earlier release wrote are still read and copied to the row.
- Importing, patching and publishing a skill save each file as a row in the files catalog under `.skills/<name>/` (a published revision under `.skills/<name>@<n>/`), and the row-by-row replace removes a dropped file only after every new file is saved, so a failed save leaves the previous version readable. A skill stored the old way is moved into rows before its first patch or publish, so a patch is never written to a prefix the rows hide; a move that fails part-way is resumed by the next patch or publish. A publish no longer holds a database connection while it writes files: the revision number is committed first and the revision is listed only once its files are written, so many concurrent publishes cannot exhaust the connection pool. A save refused because another push of the skill is still writing (`upload_in_progress`) or because an older file holds one of its paths (`path_taken`) answers `409` instead of a server error. A delete that was interrupted remembers the skill's revision numbers and removes their rows on retry, so a re-created skill never inherits them.
- `GET /api/files` lists the catalog's ready files, and `GET /api/files/:id` streams the file from
  the object store instead of holding it in memory, so a large download no longer grows server
  memory. A file listed from the catalog has no modification time (`lastModified` is `null`). A
  deployment on the old per-area local roots keeps reading its store as before.
- `POST /api/sessions/:id/attachments` streams the attachment to the object store through the
  catalog service instead of holding it in memory, and a refused attachment (over 10 MiB, past 20
  files or 50 MiB for the session) leaves no row and no object. The stored content type is inferred
  from the file name rather than taken from the request `Content-Type` header. The retention purge
  of a session's attachments goes through the same service. A deployment on the old per-area local
  roots keeps the buffered upload as before.
- Renaming or moving a file or folder through `PATCH /api/files/:id` is now a catalog row update that copies no object bytes, and `DELETE /api/files/:id` removes the stored object together with its row, when the storage service is configured.
- A deployment on local disk no longer loads the AWS, Azure or Google Cloud storage libraries; each cloud library loads only when that cloud is configured.
- `POST /api/files` streams the upload to the object store instead of holding it in memory, records
  its SHA-256, and answers `409 upload_in_progress` when another upload to the same path is still
  running. Creating a folder no longer writes a marker object: the folder is a catalog row. A
  deployment on the old per-area local roots keeps the buffered upload as before. On the streamed
  path the `201` body's `lastModified` is `null` and its `contentType` is inferred from the file
  name rather than taken from the request `Content-Type` header.
- `AW_STORAGE_URL` replaces the storage settings; old names work for one release with a warning.
- Each agent version now stores its own `storage://` folder grants, so a version that is not the
  one `local` last materialised (a lagging `production` pointer, an older pinned session) runs with
  the folders it was deployed with. A version with `storage://` folders that was deployed before
  this change, other than the one `local` last materialised, fails closed until it is saved again.
- The web app's server code now writes structured JSON log lines (`time`, `level`, `service: "web"`, `msg`, then fields) through the telemetry logger instead of free-text `console` output. Errors and other field values are redacted before they are written, so a log line no longer carries raw provider, database or token text from an error. Message strings are not redacted and carry no error text. Log pipelines that matched the old free-text lines should parse the JSON instead.
- The Builder tools now judge a caller as the agent behind the verified door, not as the Builder: an agent needs to be named in `AW_DEPLOYMENT_POLICY` `builder.allow`, and an agent it creates records the creating agent, its version and the run. Until a later release, only the built-in Builder's own runs reach these tools; other agents' runs are still refused. The external `/mcp/builder` client stays read-only. Available once the `builder` feature is enabled.
- The platform images publish to `ghcr.io/indxjp/agent-workspace/*` from the public repository
  `indxjp/agent-workspace`, for every release after 0.6.10; earlier versions stay at
  `ghcr.io/indxdev/agent-workspace/*`. The npm packages now carry npm provenance.
- **Breaking:** `db:migrate` refuses to run while a `files` or `session_state_blobs` row still has no `object_id`, and says `legacy_storage_rows_remain: run the storage migration first (AW_STORAGE_MIGRATE=copy)`. Nothing is deleted or rewritten. An install that kept the default `adopt` setting on 0.6.10 and had files from before the new naming has such rows (adopt gives them a row without an object id; only the opt-in copy fills it in), and so may an install that ran with `AW_STORAGE_MIGRATE=off`. Before upgrading, start 0.6.10 once with `AW_STORAGE_MIGRATE=copy` (it adopts, then copies) and wait until its last progress line has `"done":true`, then upgrade.
- At start-up the storage migration now also gives every skill kept in the old forms (a record object, a bare object prefix, a published revision's prefix) a catalog row and file rows, once across servers, never replacing an existing row. A skill whose delete is pending is left alone, and a published revision's prefix is moved only when the revision has a record. Each pass is recorded as a `skills` run in `storage_migration_runs`, and each file adopt pass as an `adopt` run with the objects it adopted, what it skipped by reason (no workspace owner, path taken, failed workspace) and whether it was clean; a pass that changed nothing is not recorded again.
- `GET /api/agents` no longer lists archived agents; `?archived=include` lists them with their `archivedAt`, and `GET /api/agents/{id}` still returns one. Setting, promoting or rolling back a pointer, saving a version, and the Builder's `draft_save` on an archived agent answer 409 `agent_archived`.
- The workspace's `builder` feature switch now turns the Builder on and off. It is on by default; an
  Owner switches it off with `aw workspaces features disable builder`. While it is off, both
  Builder doors answer `404 feature_disabled` (including to a run already in progress) and the
  console hides the Chat tab of the new-agent screen.
- On a default deployment the Builder is on with the per-run caps (a chat turn's budget and $0.30
  per trial); the daily cost cap (`maxCostPerDayUsd`) applies only when the deployment policy
  ceiling sets it.
- The GCP Cloud Run Terraform module no longer sets `GCP_PROJECT` on the web service, which never read it: web takes the project from the `?project=` of `AW_STORAGE_URL`. Applying the module rolls a new web revision with that one variable fewer. The runner manager keeps `GCP_PROJECT`.
- The build moves to Nx 24.0.1. `nx affected` keeps selecting whole projects (`affected.legacy`),
  and CI asks `nx show projects` for its line output explicitly: Nx 24 prints a JSON array under an
  AI agent, which would have matched no test project.
- The repository and its images move to pnpm 12.15.0. The `runner` and runtime images carry pnpm's
  native executable for their architecture, from a checksum-verified registry tarball, and `npx`
  for `stdio` connectors still runs through `pnpm dlx` (ADR-0087, amendment 2026-10-25).
- CI, `pnpm test`, the repository's `compose.yaml` and the isolation harness run PostgreSQL 18
  (ADR-0159). A `postgres-data` volume a 17 server initialised does not start under 18: dump it
  with the 17 image, or remove it to start empty.
- A GCS storage connection whose stored service-account key does not give `service_account` as its `type` no longer opens; it fails with `storage_connection_url_invalid`. Rotate its credential with the key file Google Cloud issued, which carries the `type`.
- The storage adopt and skills passes now record every pass in `storage_migration_runs`, a failed one and an unchanged one included, and the skills record counts the files of skill revisions with no committed revision record in a new `orphans` column. Session-state blobs are no longer saved without the storage service: `PUT` answers `session_state_blobs_not_configured` while the files API is not serving (`AW_STORAGE_URL` is unset, or the storage service or its catalog failed to open). Run this release once before the next one, which will refuse to upgrade without a clean record of both passes.
- Before upgrading past the `legacy_storage_rows_remain` guard, check more than `"done":true` in
  the last `storage-migrate` progress line: every area's `failed`, `missing` and `mismatched`
  should be `0`. A row counted there kept no object id, so `db:migrate` still refuses. Run 0.6.10
  with `AW_STORAGE_MIGRATE=copy` again after fixing the cause (a `failed` row is retried; a
  `missing` row's old object is gone and needs the file re-uploaded or the row removed).

### Removed

- **Breaking (run protocol):** the runner refuses a `/run` body that carries inline `contentBase64` file or skill-file contents (400 `invalid_run_request`). Files and skills are named by reference only (`size`, `sha256`). Web servers older than 0.6.10 cannot drive runners from this release.
- **Breaking:** files, skills, chat attachments and run delivery read and write only through the catalog service. The code paths that read and wrote one object store per area (the files tree, the skills prefix, the attachments root and the run output copy) are gone, so a deployment whose catalog service cannot start answers `503` (`files_runtime_not_configured`, `skills_runtime_not_configured`) instead of serving files from the area root. Skills written as a bare object prefix are still read, and are moved into rows on their first change. With `AW_STORAGE_URL` set to a supported `s3://`, `gcs://`, `azblob://` or `file://` URL nothing changes.
- **Breaking:** the old storage settings no longer say where files, skills and session state are kept: `AW_FILE_STORAGE_ROOT`, `AW_SKILL_STORAGE_ROOT`, `AW_SESSION_TRANSCRIPT_ROOT`, `OBJECT_STORAGE_BUCKET`, `OBJECT_STORAGE_BACKEND`, `OBJECT_STORAGE_ENDPOINT`, `OBJECT_STORAGE_PUBLIC_ENDPOINT` and `OBJECT_STORAGE_FORCE_PATH_STYLE`. `AW_STORAGE_URL` alone does. A leftover old variable never stops start-up: the server, `agent-workspace doctor`, `aw dev` and the `vercel` and `cloudflare` deploy commands log one `storage_setting_ignored` warning that names it, never its value. With `AW_STORAGE_URL` unset nothing is read from the old location: the files, skills and session-state APIs stay uninstalled and answer 503, `aw dev` keeps storage off rather than choose a folder, `agent-workspace doctor` fails and prints the `AW_STORAGE_URL=` line that points at the old location, and `deploy` refuses a Vercel or Cloudflare apply. Neither deploy command pushes an old storage variable to the platform project. Set `AW_STORAGE_URL` (for example `file:///var/lib/agent-workspace`) before you upgrade.
- **Breaking:** the repository `compose.yaml` and a generated Compose project refuse to start without `AW_STORAGE_URL` in `.env`. `.env.example` and `create` write the bundled SeaweedFS as `AW_STORAGE_URL=s3://agent-workspace?endpoint=http://seaweedfs:8333&publicEndpoint=http://localhost:8333&pathStyle=true`, the bucket, endpoint and path style the old settings gave it, so its objects stay where they are. A generated project's `.env` also needs `AW_STORAGE_CREATE_BUCKET=true` for that store.
- New in `@indx-workspace/contracts/storage-settings`: `IGNORED_STORAGE_VARIABLES`, `ignoredStorageVariables(env)` and `ignoredStorageSettingsWarning(env)`. Every export the old settings had stays as a deprecated shim until the next major release.

### Fixed

- `POST /api/agents` with `{agent, assignments}` now creates the agent and its assignments in one
  transaction, so a refused assignment leaves no agent behind (engineering audit F-05). An assigned
  file, skill, skill revision or connector the workspace does not have answers `400` with
  `unknown_file`, `unknown_skill`, `unknown_skill_revision` or `unknown_connector` and the id in
  `details`, instead of a kebab-case code or a `500`.
- Every `/api/agents/**` route now answers an unexpected failure (a store or dependency that throws)
  with the standard `500 internal_error` envelope and logs it server-side under the route's name,
  instead of letting it escape as a bodiless 500 (engineering audit F-11). Typed errors keep their
  status and code.
- `GET /api/files` no longer writes the file catalog (engineering audit F-05). It answers each
  catalogued file or folder by its catalog id, as before, and an object with no catalog row by its
  path-derived id instead of creating a row attributed to whoever listed it. Run outputs now get
  their catalog rows, owned by the run's principal, when they are promoted.
- `pnpm test` starts when `npm_execpath` is a native `pnpm.exe` (the `@pnpm/exe` distribution): the
  launcher runs it directly instead of through `node` (engineering audit F-25).
- An invalid `WORKSPACE_SLUG` now logs a `[surfaces]` warning at startup that names the variable (not
  its value) and says every hosted surface and A2A agent card will answer "not found" until it is
  fixed, instead of failing silently.
- A web request-handler failure now answers `500` (or destroys the response when headers were
  already sent) instead of an unhandled rejection.
- The runner exits with code 2 and names the failure when its shutdown rejects, instead of crashing
  through the unhandled-rejection path.
- A failed pi `session.abort()` now fails the run instead of an unhandled rejection.
- A run whose insert fails no longer leaves an orphan empty session behind.
- A model connection that lacks a config field its provider requires now answers `409
model_connection_incomplete` naming the field (for example `config.apiVersion`), instead of an
  opaque 500, on every gateway route. To repair a legacy row (for example an Azure connection saved
  without `apiVersion`), open Admin → Models → the connection, fill the missing field and save, or
  `PATCH /api/model-connections/{id}` with the missing `config` key.
- The add-provider form no longer sends fields the selected provider does not accept (for example a
  deployment typed for Azure before switching to Anthropic), which the server rejected with no way
  to clear them from the form.
- Concurrent same-name skill imports and same-path file uploads or folder creates no longer let one
  request's rollback delete the other's bytes: the check, write, catalog write and rollback now run
  under a per-key lock. The guarantee holds within one web instance; across replicas it needs a
  conditional create on `ObjectStore.put`. A failed file catalog write on `POST /api/files` now
  answers `500 catalog_unavailable` instead of an unhandled error.
- The web refuses an unknown `RUNTIME_DRIVER` instead of treating it as `docker`: composition fails
  with an error that lists the valid ids and does not echo the value. An unset or blank value still
  means `docker`. The Kubernetes runtime row is now disabled unless Kubernetes is the runner
  manager's driver, because Test Runtime could never pass for it and every run on it was refused.
  Its wire shape (`id`, `label`, fields) is unchanged; only `state` and `reason` change.
  `KUBERNETES_RUNTIME_IMAGE` and the web's `KUBECONFIG` check are gone.
- Hosted surfaces and the A2A Agent Card no longer require `BOOTSTRAP_ADMIN` and
  `BOOTSTRAP_ADMIN_PASSWORD` (issue #1168); the deployment workspace is read from `WORKSPACE_SLUG`
  alone, so an OIDC-only deployment serves them.
- The runner no longer exits when an engine's `interrupt()` rejects after a client disconnect or an
  interrupt that arrived during start. The rejection is logged to stderr with the run id and every
  other run on the runtime keeps streaming.
- An `anthropic-compatible` run keeps its provider on settlement: `runs.provider` and the usage ledger
  now say `anthropic-compatible` instead of being overwritten with `anthropic`, and the run is priced
  under `anthropic-compatible:<model>` (or `anthropic-compatible:*`) in `GATEWAY_PRICING_JSON`. A
  deployment that relied on `anthropic:*` prices for a compatible endpoint settles those runs unpriced
  (`unavailable`) until it adds that key.
- The runner's `/files` endpoints now go through the single ustar codec in `packages/runtime`
  instead of a hand-written copy. A member that percent-decodes to a NUL byte (`%00`) is refused
  there too, collecting through a symlinked parent directory is refused, and long paths are split
  at any `/`. Symlink refusals no longer put an absolute host path in the message. Status codes and
  `error` codes (`invalid_archive`, `invalid_file_request`) are unchanged; the message text changed
  from `unsafe workspace path …` to `unsafe archive path …`.
- The runner's `/files` takes real file names literally: `50%.txt` no longer fails the whole
  `GET /files?path=dir` with a 400, `a%2Eb` is no longer collected as `a.b`, and a Linux name with
  `\` is no longer folded to `/`. Percent-decoding stays on request `path` parameters, and members
  that decode to `%00`, `..` or an absolute path are still refused. Failures are typed: a refused
  archive or path is 400, a missing path is now 404 `file_not_found` (it was 400), a collection
  over the 128 MiB limit that `POST` already had is 413 `archive_too_large`, and any other fault
  (ENOSPC, EACCES, EIO) is 500 `internal_error` with a fixed message and the detail on stderr, so
  no response carries a host path. A client that matched on 400 for a missing path now sees 404.
- A fresh `npm install` of the published packages pulled `@earendil-works` 1.2.0 siblings of pi
  (pi declares them as `^1.0.2`), and `aw dev` crashed with "does not provide an export named
  `MCP_TYPESCRIPT_PREAMBLE`". The whole pi family is now pinned exactly at 1.0.2 in
  `@indx-workspace/embedded`, and a test fails if pi gains a
  sibling that is not pinned.
- `GET /api/metrics` returned an empty run list because the telemetry projection was a
  per-module-graph `Map`; it is now anchored on `globalThis` like the other process-wide state
  (issue #1161).
- A run that is approved or rejected (`POST /api/runs/:id/approval`) keeps acting for the `subject`
  the paused run was started with (ADR-0157). The continuation lost it, so a connector that asks
  for a caller identity refused the approved call. The approval request still cannot carry a
  subject. Migration `0067` adds the nullable `runs.subject` column.
- A run that is approved or rejected (`POST /api/runs/:id/approval`) keeps the `outputSchema` the
  paused run was started with. The continuation lost it, so its answer was no longer checked against
  the schema and `runs.result` could not return it typed.
- The API Keys screen shows each key's prefix again. It read a `prefix` field the API never sent
  (the contract's field is `keyPrefix`), so every row showed a blank prefix.
- Creating an API key that the server refuses (for example a duplicate name) now shows the server's
  message instead of only the status code.
- `PUT /api/agents/:id/resources` answers an assigned file, skill or connector the workspace does
  not have with `400 unknown_file`, `unknown_skill` or `unknown_connector` and the id in `details`,
  like `POST /api/agents`, instead of the kebab-case `unknown-file`, `unknown-skill` or
  `unknown-connector`. Clients matching the old strings must match the new ones. The codes are now
  in the contracts' `AGENT_VERSION_PROBLEM_CODES`.
- A transcript entry nested more than 128 levels deep is refused with a 400 instead of overflowing the stack and answering 500.
- The home chat no longer shows a run that paused for approval, or was cancelled without an error, as "Completed" once its event stream ends; the badge keeps "Awaiting approval" or "Cancelled".
- The use-cases landing page shows the current tutorial benchmark scores (quotation 85, customer
  inquiry 100, Excel consolidation 95, meeting minutes 90, maintenance troubleshooting 95), and
  three use-case cards no longer run their score badge into the tutorial link. A gallery test now
  fails when a landing-page score disagrees with its benchmark.
- The enterprise agent gallery showcase says it is a pre-programme snapshot and links to the
  tutorials overview for live scores.
- Runs on the `local` driver (`aw dev`) now save the files the agent writes to `outputs/` under
  `runs/<runId>/outputs/`, so `runs.outputs()` and `aw runs outputs` list them, and a run's
  attachments are written into its working directory before it starts instead of being granted
  with no bytes.
- The Claude Managed Agents and Copilot Studio compiles write a multi-line agent description with a whitespace-only line as one escaped line, so importing it back returns the description unchanged.
- `pnpm migrations:renumber` keeps Drizzle's column order when it merges snapshots, so a renumbered branch no longer fails the formal ER test until `pnpm db:generate` is re-run.
- A retried `POST /api/agents/:id/runs` with the same `Idempotency-Key` and the same body whose
  JSON objects list their members in another order (an `outputSchema` rebuilt by the client)
  replays the original run instead of answering `409 run_idempotency_conflict`. Array order still
  counts.
- Two concurrent starts with one `Idempotency-Key` on one existing session now both answer `202`
  with the same run; the second used to answer `409 session_busy`.
- A run start whose launch handoff throws answers `202` with its queued run instead of `500`; the
  stale-run sweep ends the run (ADR-0151, RF-303).
- The first-run setup wizard says when it could not detect which runtimes the host can run, and keeps the local driver, instead of showing "Detecting this host…" forever; an unreachable server during setup is reported as such.
- Two servers importing one skill name no longer delete each other's files: the catalog reserves the name first, and the second import answers `409 skill_already_exists` without writing. Publishing a skill revision takes turns under the catalog's lock on the skill row, and an import whose `SKILL.md` is blank answers `400 malformed_content`.
- File search and the files a run is given now read each ready catalog row through the storage
  service, so a file saved under the new object naming is found by search and delivered to a run, as
  a file in the old naming still is. Search also stops reading an object at the extraction size
  limit.
- A `file://` storage connection now lists and reads the folder as it is on disk, so `a/b/c.txt` is the file at `<folder>/a/b/c.txt`; it no longer looks for the platform's own `objects/` and `metadata/` folders, which made an existing folder of files appear empty.
- Compose: browser uploads above 64 MiB work. SeaweedFS is published on `127.0.0.1:8333` (the generated project's too, through a new `storage-ingress` network), and signed links name `http://localhost:8333` instead of `http://seaweedfs:8333`, a host the browser cannot resolve. Set `publicEndpoint=` in `AW_STORAGE_URL`, or `OBJECT_STORAGE_PUBLIC_ENDPOINT` with the old variables, to sign links for another host; unset, links are signed for the endpoint as before. A project generated before this change keeps working, with links for the endpoint, until its `.env` is rendered again.
- A folder grant no longer gives a run the unverified bytes of a pending upload inside it.
- On Azure Blob, members get a signed upload link for a new file again; completion deletes an object over the declared size. Overwriting an existing file still falls back to the relay upload.
- Moving a folder answers `409 name_conflict` when the destination already holds any object, instead of overwriting it when its size and type happened to match. A move that stops part-way removes the copies it made, so the same request can be retried.
- `POST /api/files/:id/upload-complete` answers the file's catalog id, the one listing, the relay upload and grants use, instead of a path-derived id.
- `DELETE /api/files/:id` on a non-empty folder without `?recursive=true` answers `409 folder_not_empty` again instead of `500`.
- S3 storage configured with temporary AWS credentials sends `AWS_SESSION_TOKEN` with the key pair.
- Azure Blob ranged reads report the range the store served, and a blob that shrank under a read answers range-not-satisfiable instead of a generic failure.
- The runner manager accepts a full 128 MiB run file archive (the tar framing no longer counts against the payload limit), and aborts a proxied request when the client disconnects while waiting for the runtime's answer.
- Run file archives open and size-check empty files too, and cancelling an archive while a file is being opened cancels that file once it opens.
- Narrowing a resumed run's folder grant to one of its files keeps that file instead of deleting it.
- `POST /api/files/:id/download-urls` signs the catalog row's own object (new or legacy naming) on the storage domain, so a file saved under a permanent id gets a working link instead of a 404.
- A signed-link upload (`POST /api/files/:id/upload-urls`, then `upload-complete`) over an existing file no longer overwrites its bytes in place: the link targets a new object, the old version stays readable until complete swaps the rows, and a failed or oversize upload deletes only the new object. On Azure Blob, which cannot bind the upload length, replacing a file is now signed unbound instead of answering `501`.
- A file uploaded through a signed link now gets a pending catalog row when the link is minted, so it has an owner from the start. It is not listed, searched or given to an agent or project until the upload is completed, and it cannot be renamed before then.
- Audio attachment transcription reads at most 1 MiB of transcript from the provider and fails the
  run's transcription step past that, instead of buffering an unbounded body. An interrupt that
  lands while a run's recordings are being transcribed now stops the remaining transcriptions.
- A webhook delivery without an `Idempotency-Key` is deduplicated by a digest of its body for the
  24-hour window, so a Microsoft Graph or Zoom retry no longer starts a second run. An explicit
  header still wins, and an empty body still fires every time.
- A schedule trigger that is enabled again, or whose cron or time zone changes, no longer fires a
  catch-up run at once for the windows it missed: it next fires at its next scheduled time.
- Trigger delivery records older than the dedupe window are pruned by the schedule pass instead of
  being kept forever.
- A Builder provisioned before first-run setup now runs once setup has made its model connection and the default runtime profile: setup, and creating or changing a model connection, bring the Builder's connection and runtime profile up to date without writing a new version.
- `POST /api/agents/:id/evaluation-advance` now advances an evaluation run of the built-in Builder, so `aw eval builder` scores it end to end. Promoting, rolling back or otherwise changing the Builder is still refused with `builtin_agent_read_only`.
- The built-in Builder now runs on a fresh install. Its definition names the `default` model connection, but first-run setup names its connection `anthropic default`, so the Builder was bound to no connection and every run was refused with `builder_model_unavailable`. The Builder now binds to the connection named `default` when there is one, and otherwise to the connection setup made for its model's provider. Other agents still resolve `default` only to a connection named `default`.
- Model-graded evaluation cases now give the judge a system instruction and up to 1024 output tokens, and read its verdict even after other JSON in the reply. A reply that holds verdicts that disagree fails the case with `judge_unparseable`.
- Copying a file on local-disk storage no longer leaves a partial file behind when the copy fails part way, and a download during the copy gets the old file or the new one, never a mix.
- A model, tool or skill option the Claude engine refuses to translate at run start is now answered with its own code (`engine_policy_invalid`) and message on the run's `run-error` frame, like any other engine refusal, instead of the generic `422 run_rejected`. Engine adapters signal such a refusal with the new `EngineRefusalError` from `@agent-workspace/engine`.
- A refused `POST /files` hydrate now leaves the run workspace as it was. Members stream into a staging directory and move into place only once the whole archive is accepted; a refusal, in the archive or against the workspace (a symlink, a directory where a file goes), keeps every file the hydrate would have replaced and removes a workspace it created.
- A runtime profile `persistPaths` entry under a sibling of the workspace, such as `/workspaces/out`, is refused as not workspace-relative. Before, only the `/workspace` prefix was stripped from it, so the run persisted `s/out` instead.
- Run file archives keep trailing whitespace in file names, so `report.txt` and `report.txt ` stay two files instead of one overwriting the other.
- Collecting run outputs no longer hangs when an output file is swapped for a named pipe after it was listed; the file is refused.
- A remote run output of exactly the 128 MiB payload limit is saved: the default cap on the output archive now counts tar headers on top of the payload, while the payload and member limits are enforced when the archive is decoded.
- A `file://` storage connection on a host without `/proc/self/fd` (such as macOS) refuses a file symlink or folder alias inside its root when it is addressed directly, as it already did on Linux.
- A Google Cloud Storage download that fails after it started no longer exposes the provider's response, which can carry the bearer token; it fails with the same safe error and HTTP status as other GCS failures.
- Refusing a write to a read-only storage connection now cancels the streamed body it was given.
- An Azure Blob signed link whose signing time is in the past no longer fails with "Azure blob user delegation key failed": the delegation key is requested for a window that is valid now, while the link keeps the expiry it was asked for.
- A storage connection to a server folder closes a file whose read was dropped unread, instead of leaving it to the garbage collector with Node's DEP0137 warning.
- A write to a storage connection's server folder flushes the file and its folder entry to disk before it is reported done, so a crash right after cannot lose it.
- A Google Cloud Storage write whose source stream fails reports the source's own error instead of "Google Cloud Storage write failed."
- A cleanup pass in delete mode, a failed save and a stale completion no longer delete or confirm an upload that was completed or re-minted meanwhile; each acts only on the unchanged reservation it saw.
- A save whose confirm reply is lost no longer deletes the saved bytes when the file was renamed meanwhile.
- Uploads abandoned for longer than the longest signed link plus an hour no longer count toward the 100 unfinished uploads per workspace.
- An upload whose replacement permission check fails releases its reservation instead of leaving the path busy, and the error is reported.
- A storage connection's credential secret that a failed delete left behind is now removed by the next storage-connection delete in the workspace, once it is more than ten minutes old.
- The storage connection page's delete dialog makes the page behind it, the navigation included,
  inert while it is open, so neither a pointer nor a screen reader can reach it; focus returns to
  "Delete this connection" when the dialog closes, also after a refused delete.
- Removing a storage grant on an agent's page moves focus to the grant that takes its row, or the
  one above it, and to "Add files or folders" only when no grant is left. The pressed Remove
  button keeps focus while the removal runs and after a refused removal.
- `DELETE /api/files/:id` on a path that only holds a pending upload removes that upload, its
  reservation and its bytes. Its uploader may delete it with an own-files grant (a Builder); before,
  the Builder was refused with `403` and an Owner's delete answered `204` while leaving the upload
  in place. Another member's pending upload is still refused to a Builder.
- A stored file now answers `lastModified` (the time its catalog row was last written) on
  `POST /api/files`, `GET /api/files`, `PATCH /api/files/:id` and
  `POST /api/files/:id/upload-complete`, instead of `null`. A folder still answers `null`.
- Moving a folder with `PATCH /api/files/:id` answers `moved` as the number of files it moved, as
  it did before moves became catalog-only. It no longer counts the folder rows, so a folder of
  10,000 files answers `moved: 10000`, not `10001`.
- Deploying an agent whose `storage://` grant names a connection deleted after the deploy was validated no longer fails with a `500`. The agent's grant on the deleted connection is dropped, as its version's grant already was, and a run of that version is refused with `run_storage_grant_unavailable` until it is redeployed.
- A storage bucket deleted while the server runs is reported as a failure on S3 and Google Cloud Storage, instead of every file in it reading as missing. Run write-back then marks a changed file as failed rather than conflicted.
- When a Google Cloud Storage upload fails its integrity check, only that upload's own version is deleted, never a newer one a concurrent writer stored.
- S3 writes report the server's time, taken from the `Date` of the write's own response, instead of the client clock. A write sends no second request to learn it.
- Listing a folder page by page on Google Cloud Storage, or listing it recursively on S3-compatible servers such as the bundled SeaweedFS, returns the same order as one large page, so a page boundary never repeats or reorders entries.
- A one-level S3 listing orders each page the way the server pages it: on AWS S3 (no endpoint, or an `amazonaws.com` one) by native name, where folder `a/` follows file `a.txt`, and on any other endpoint, such as the bundled SeaweedFS, by bare key. Deployment storage and storage connections both pick the order from the endpoint, so a folder named like the start of a file name no longer reorders across a page boundary on AWS.
- An S3 or Azure storage connection whose endpoint resolves to both IPv4 and IPv6 answers each address-family lookup with a checked address of that family.
- A Google Cloud Storage connection is refused while `STORAGE_EMULATOR_HOST` points the Google client at another host, so a customer connection never bypasses the outbound endpoint check.
- The least-privilege grants in the storage connections guide are now enough to connect a Google Cloud Storage or S3 bucket: neither `storage.buckets.get` nor an unprefixed `s3:ListBucket` is needed. The platform's own object store checks its bucket at startup by listing one object under its prefix. A storage connection sends no request when it is opened, so its first listing of an allowed folder is the check, and a connection URL without a prefix works with a grant limited to that folder.
- A storage connection whose bucket refuses its key, or is gone, now tests as `forbidden` or `not_found` on Google Cloud Storage as it already did on S3, instead of `unreachable`. A run whose granted bucket refuses the listing is refused with `run_storage_grant_unavailable` before it is queued, instead of failing later as `run_preparation_failed`.
- The runner manager passes the client's `content-length` on a proxied `/files` or tool request instead of re-sending the body chunked, so a runtime or tool server that refuses a chunked body now accepts it. A declared length over the limit is refused before the runtime is called.
- A run the runtime cannot start answers `422 run_rejected` with a fixed message instead of the cause, which could name an absolute host path. The cause is in the runner's `run start failed` log line, keyed by the run ID.
- A granted skill file whose bytes change after the runner verified them answers `422 run_file_checksum_mismatch`, and the engine never starts with the changed file.
- A client that disconnects in the middle of a proxied request is no longer logged as `runner manager request failed`. A runtime or tool sandbox that fails in the middle of its response still is, including after the response has started.
- A run file archive whose first header does not parse no longer creates an empty workspace directory.
- A run's storage write-back no longer saves a folder to the wrong connection when a connection is
  renamed while the run is being prepared. The run's input files and its `/run` body are loaded
  separately; a folder the two loads delivered for different connections or prefixes is now refused
  and audited as `refused: folder_mismatch`, rather than written to the connection that holds the
  name at the second load.
- A storage write-back stops before its next file once the stored run is no longer running, so a
  cancel on another replica takes effect within a second rather than at the write-back deadline.
  The stored status is read at most once a second, not once per file. Its audit
  row names an interrupt `refused: interrupted`, apart from `refused: deadline`, and the audit
  write itself is bounded, so a hung audit store no longer keeps the session busy. Its warnings
  name an error's type, never a provider message that could carry an object key.

### Added

- `aw platforms publish --platform microsoft-foundry` (issue #976): plans and, with `--yes`, sends the
  agent versions and A2A endpoints the Foundry export holds, using the token of the user's own
  `az login`. Every hosted platform now has a publish executor, and the table is total by type.

### Fixed

- An E2B agent-runtime sandbox no longer holds a slot for the plan maximum (issue #827, part of): the
  runner creates it with a timeout of the session's idle limit (900 seconds, or the profile's
  `idleTimeoutSeconds` if longer) plus 120 seconds, and each reconnect for a later run of the
  session renews it. These session sandboxes, not tool sandboxes, were what the vercel-e2b lane
  found alive at its end. The lightweight journey's sweep log now splits them as `runtime=<n>
tool=<n>`.
- E2B tool sandboxes no longer outlive their run (issue #832, part of #827): when an `external` run
  ends, the control plane releases the tool sandbox that run started (`DELETE
/tool-sandboxes/runs/<runId>`, keyed by the run's `awRun` tag) and never the session's agent
  runtime, a tool sandbox's E2B timeout is its run deadline plus two minutes, a failed run-token
  write or tool recording removes the sandbox it just started, and a 429 from E2B surfaces as
  `tool_sandbox_unavailable` naming the concurrency limit. The lightweight journey kills its lane's
  sandboxes (tag `awWorkspace`) at the end of each E2B lane and runs the two E2B lanes one at a time.

### Added

- Live Managed Agents lane (issue #979, part of it): `tests/e2e/platforms-journey/managed-agents-live.e2e.mjs`
  publishes the journey's agent as `awpt-<run id>` to Claude Managed Agents with the real `ant` CLI
  (a plan without `--yes` exits 3 and creates nothing, then `--yes`), reads it back through the
  Managed Agents list API, and always archives the agents and deletes the skills it created; a
  leftover fails the run. It runs as the `platforms-live-managed-agents` job of `journey-live.yml`,
  `workflow_dispatch` only, with the existing `ANTHROPIC_API_KEY` secret, a checksum-pinned `ant`
  installed in a `run` step (no new action), and outside `ci-success`. `findAgentByName` is tested
  against the committed `fixtures/agents-list.json`.
- A runtime profile with `driver: external` takes `provider: e2b` (issue #827, part of; `runtime.provider`
  in `agent-workspace.yaml`, `driverConfig.provider` on the server). An unknown provider is refused by
  name, as `422 runtime_provider_unsupported` on `POST`/`PATCH /api/runtime-profiles` and at profile
  validation in the CLI schema. Without `provider` a runtime is `e2b`, as before.
- The lightweight journey shows two more things (issue #832, part of #830, #831, #827): the `gate`
  row tries `aw promote` below the eval bar and asserts the refusal names the version (the
  profile-path lanes now deploy with the same `AW_DEPLOYMENT_POLICY` bar `aw deploy` writes), and the
  `widget` row sends one turn from the frontend origin the way the frontend's client does. The docs
  cite run 38215231687 for the Vercel and Cloudflare hosts, with the native-sandbox lanes named as
  `n/a` (#940, ADR-0131), and gain the guides [Deploy on Vercel](docs/sdk/site/guides/deploy-vercel.mdx)
  and [Deploy on Cloudflare](docs/sdk/site/guides/deploy-cloudflare.mdx).
- Developer docs chapter 7, "Run it on other platforms" (issue #978, part of): an optional chapter
  with an overview of `aw platforms`, a guide for each of Claude Managed Agents, Copilot Studio,
  Microsoft 365 declarative agents, Microsoft Foundry, Gemini Enterprise and AWS AgentCore, the three
  eject targets, switching the engine, and a platform compatibility matrix generated from
  `docs/platform-matrix.md` (`pnpm docs:generate` keeps it in step). Publish is described only for
  the platforms that have an executor, Gemini Enterprise included (plan-first, `--yes` to apply,
  with a `gcloud` token); Foundry says it is not yet available. Each publish step still marked
  VERIFY in its executor is labelled "unverified against a live tenant".
- Developer docs chapter 7 (issue #978): the Foundry guide describes plan-first publish with your
  `az` login (the token is never printed; steps still marked VERIFY are labelled "unverified against
  a live tenant"); the Claude Managed Agents and Foundry verdict tables list the drops they were
  missing; the Claude Managed Agents page notes the on-demand live lane: until a run of it passes,
  publishing to Claude Managed Agents is unverified against a live tenant.
- Platforms journey (issue #979, part of it): `tests/e2e/platforms-journey` creates a project from the
  packed packages, exports it to every id in `PLATFORM_TARGETS` with `aw platforms export` and
  compares each verdict list with a committed golden (`golden/<id>.json`, nine files), so a dropped
  or re-mapped field can never change silently. It also asserts `--strict` exits 5, a non-Claude
  model for Managed Agents exits 1 with `platform_model_unsupported`, an unknown platform exits 2,
  `aw platforms doctor` lists every id, and the export → `aw platforms import` → export round trip
  keeps the instructions. It uses no secret and runs as the `platforms-journey` job of
  `journey-live.yml`, outside `ci-success`. `createSupportProject` takes `extraArgs`.
- `aw platforms publish --platform gemini-enterprise` registers or updates the exported A2A agent
  in Gemini Enterprise, plan-first (issue #976, part of): it checks the Agent Card is reachable and
  declares A2A `0.3.0` before it asks `gcloud` for a token, lists the app's agents (following
  `nextPageToken`), and sends a `POST` or `PATCH` only with `--yes`. Microsoft Foundry and the
  total executor table follow.
- A twelfth setup question, `admin.platforms` (`--platform <a>[,<b>…]`, asked last, default
  `none`), in `npm create`, `aw init` and the browser setup (issue #977, part of): each chosen
  hosted platform is written as `platforms: {<id>: {enabled: true}}` in `agent-workspace.yaml`,
  with a "Publish to other agent platforms" README section and an "Other agent platforms"
  AGENTS.md section. With `none` every file is unchanged.
- OpenAPI documents are stored (issue #968, part of; migration 0052 adds the nullable
  `mcp_servers.openapi_document`), so a platform export of a saved agent version carries an OpenAPI
  connector in `project.openapiSpecs` instead of dropping it. The resource still never returns the
  document. A connector registered before this change has no document: replace it (`PATCH` with the full
  body) with its document to export it; until then the export reports it as `dropped`.
- OAuth consent follow-ups (issue #971, part of; ADR-0134 clause 19): the workspace picker returns a
  member to the authorize page (`next`, same-origin only, re-checked on every read), and the consent
  check that a member can run every agent of the client reads the database through the shared
  `ownershipOf` rule instead of the agents runtime.
- `aw platforms publish` for Copilot Studio (import only with `--experimental --yes`) and AWS
  AgentCore, plan-first through the vendor's own CLI (`pac`, `agentcore`) (issue #976, part of).
- Subagents run on the Claude Agent SDK (issue #974, part of; ADR-0133 D14): a version's
  `subagents` are resolved at run time from the version its environment points at (`production`
  when the parent runs its `production` version, else `local`), sent on the private `/run` contract
  as `portable.subagents` (omitted when empty), and compiled into the SDK's `agents` option. Each
  subagent's permissions are AND-ed with its parent's, and a parent policy that denies `Agent` is
  refused with `engine_capability_unsupported`. Mastra, OpenAI Agents and pi refuse a request that
  carries subagents, by name; a version whose subagent has no description is refused on save.
- Subagents run on Mastra and OpenAI Agents (issue #974, part of; ADR-0133 D14): Mastra compiles
  each into a sub-`Agent` under `agents` (own workspace and read-only tool set), OpenAI Agents into
  an `Agent.asTool` (a nested run, not a handoff). Both meter a subagent's usage against the
  `maxBudget` cap without counting it as one of the run's turns, and refuse by name a subagent on
  another model when a cap is set (the cap is priced with the parent's model). Only pi still
  refuses subagents.
- OAuth endpoint-client follow-ups (issue #971, part of; ADR-0134 clause 19): `aw endpoint-clients
secret rotate` and `update --redirect-uri`; `/signin?next=` is honoured for same-origin paths only
  (open redirects refused); the consent page no longer needs the agents runtime; concurrent
  revocations of one token audit once.
- `aw platforms publish --platform <id>` (issue #975, part of; ADR-0133 D11): exports the agent,
  then shows the vendor tool's own plan and publishes it only with `--yes`. A plan with changes exits
  `3`; `--plan` with `--yes` is a usage error; `--strict` still exits `5` before any vendor call.
  Claude Managed Agents runs `ant apply --dry-run .` then `ant apply --yes .`, Microsoft 365 runs
  `atk validate`, `package`, then `provision`. Credentials come from the vendor tool's own login and
  are never stored or printed. `aw platforms doctor` also warns when a vendor tool is missing or too
  old. Needs `@indx-workspace/cli`, loaded only through `packages/aw/src/cli-bridge.ts`.
- `aw platforms export` prints `/` in every path it shows on Windows too (issue #972).
- `@indx-workspace/cli/publish` (issue #975, part of; ADR-0133 D11): plan-first publish executors
  for `aw platforms publish`. They spawn the vendor's CLI (`ant`, `atk`) through the same runner as
  `agent-workspace deploy`, redact every printed line, and apply nothing without `--yes`.
- `aw platforms list|export|import|doctor` (issue #972, part of; ADR-0133): `export --platform <id>`
  compiles the project's agent (`agents/*.ts` or `agents/*.agent.md`) into a platform's files under
  `platforms/<id>/`, prints a per-field verdict table and always writes `PLATFORM_REPORT.md`;
  `--strict` exits `5` when any field is dropped. `import --from <id> <path>` turns a platform's
  agent files into `agents/<name>.agent.md`, `doctor` checks that each enabled platform compiles,
  and `list` shows every agent platform. A new exit code `5` means `--strict` found dropped fields.
- platforms: microsoft-foundry output uses the shared `prettyJson` and per-file JSON goldens (#963,
  part of): string-only arrays such as `allowed_tools` now print on one line, and the `full` and
  `no-tool-endpoint` goldens are byte-exact JSON files instead of `.txt` bundles. V1-V6 stay VERIFY.
- Subagent checks (issue #969, part of; ADR-0133 D14): saving or dry-running a version that names a
  subagent the workspace lacks or one with subagents of its own, or giving subagents to an agent
  that is already someone's subagent, is refused `422 agent_subagent_unusable`, checked in the same
  transaction as the save under a workspace lock so two concurrent saves cannot together build
  A→B→C. A portable knowledge file takes `access: read-write`, so a read-write grant round-trips
  through the converters. `aw push` saves subagents first and refuses a cycle locally as
  `subagent_cycle`. The Lean engine model still lacks `subagents` (a local follow-up).
- **Project tool sandboxes close on revoke** (issue #967, part of): revoking an `mcp-project` endpoint
  client, one of its endpoint API keys, or an OAuth grant (a token revoke or a replayed refresh token)
  now closes the client's tool sandbox through the runner manager's new
  `DELETE /tool-sandboxes/sessions/:clientId`, best effort with the idle timeout as the backstop
  (ADR-0134 part 2). The deploy guides say which drivers place tool sandboxes.
- platforms: aws-agentcore importer, vendor fixtures, region-derived partition (#964, part of): an
  AgentCore CLI project imports back into a portable project and round-trips through the compiler.
  Header values and `apiKeyArn` are never copied; only a token-vault reference becomes `auth`. ARNs
  take their partition (`aws`, `aws-cn`, `aws-us-gov`) from the region. The fixtures under
  `aws-agentcore/vendor-fixtures/` are hand-rendered, not vendor copies; V1-V5 stay VERIFY.
- platforms: aws-agentcore vendor fixtures are verbatim (#964, part of): the hand-rendered project
  is replaced by `examples/AgentCoreCliReviewer` from `aws/agentcore-cli@dd6304e` (Apache-2.0, blob
  SHAs in `SOURCE.md`), parsed by the harness subset schema and imported. The opus-4-7 row of V4 is
  confirmed by the fixture; V1-V3, `allowedTools: []`, the other V4 rows and V5 stay VERIFY (V2, V3
  and `allowedTools: []` have CLI-source evidence only, not AWS docs). Upstream requires `model`, so
  an agent without a model is a follow-up.
- `description`, `subagents` and `knowledge` on `defineAgent()` and the agent version body (issue
  #969, part of; ADR-0133 D2, D14): all optional, so an existing body is unchanged. Subagents are
  declared and validated but not run: every engine declares `subagents: false`, so a body naming
  one is refused `422 engine_capability_unsupported` until the runtime supports them.
- A **Platforms** tab on the agent page (issue #973, part of): for a saved version it shows what
  each platform can carry, the per-field verdicts of an export, a bundle download and the
  `aw platforms publish` command to copy, in English and Japanese. It reads the platform routes
  through the SDK; publishing still runs from the CLI.
- The `eject-claude-agent-sdk` platform target (issue #965, part of): `aw`'s platform compiler can
  now emit a standalone TypeScript project that runs an agent on the Claude Agent SDK. A real
  `tsc` run over the emitted project and a pins test keep it honest.
- The `eject-mastra` and `eject-openai-agents` platform targets (issue #965): the same
  standalone TypeScript project for Mastra and for the OpenAI Agents SDK, on the engines' pinned
  versions, each with a golden, a verdict table and a real `tsc` run. The Claude project now puts a
  subagent's MCP servers in its own `mcpServers`.

### Changed

- CI refuses a lockfile that `pnpm dedupe` would change.
- CI: a new `Terraform` workflow runs `fmt -check`, `validate` and `terraform test` for every `infra/terraform` root, `fast-checks` runs `infra/tests/contracts.test.mjs`, and that test now expects the pinned `azure/login` v3 (issue #1050, part of).
- `agent-workspace render` writes `AW_PUBLIC_URL` as its origin, so a trailing slash or path in `.env` no longer fails `terraform plan` (issue #1050, part of).
- The A2A card's `protocolVersion` is now `0.3.0` (the A2A v0.3.0 schema default) instead of `0.3`, in the served card and the `gemini-enterprise` registration (issue #966, part of).
- `platforms`: one shared JSON renderer for the targets (`gemini-enterprise`, `copilot-studio`, `aws-agentcore`), and the `gemini-enterprise` card is pinned to the A2A v0.3.0 spec fixture (issue #966, part of).
- `platforms`: a multi-agent `PLATFORM_REPORT.md` is grouped under one heading per agent, and the `gemini-enterprise` report shows a `mapped` row for a generated card description and a clearer `toolEndpoint` note (issue #966).
- `AW_PUBLIC_URL` now reaches every remaining generated deployment (issue #955): the
  azure-container-apps module takes a validated `public_url` variable (set on `web` only when
  non-empty), `agent-workspace render` writes `publicUrl` into the v1 Helm overlay, and a Cloudflare
  deploy hands the `.env` value to the control-plane Worker, now pinned by a test. Unset, the
  rendered output is unchanged.
- `AW_PUBLIC_URL` now reaches Cloud Run (new `public_url` Terraform variable, set on `web` only when
  non-empty) and Kubernetes (new Helm value `publicUrl`, set by `aw deploy`); unset, the rendered
  output is unchanged. A2A: a key not bound to the agent now answers `404 a2a_agent_not_found` like an
  unknown name, not `403 token_out_of_scope` (ADR-0135; issue #955, part of).
- The `m365-declarative-agent` platform target gains an importer and bundles OpenAPI documents at
  `appPackage/openapi/` (issue #962, part of; ADR-0133): the Agents Toolkit project round-trips
  through compile and import, colliding tool names are renamed instead of overwriting a plugin file
  or auth variable, and `m365agents.yml` follows the toolkit template (v1.12, `copilotAgent/publish`).
- The `claude-managed-agents` report records the original auth scheme when an `api-key` or `oauth2`
  secret is flattened to a `static_bearer` credential (issue #960, part of).
- `aw deploy` (single-vm, vercel, gcp-cloudrun) writes `AW_PUBLIC_URL` into the deployment `.env`
  from `environments.production.url`, and the Compose template forwards it to `web`, so a deployed
  control plane serves its A2A cards (issue #955, part of). `aw create` output is unchanged except
  for `compose.yaml`. Spec §34 now prints the two A2A routes. The A2A card's skill id and generated
  description always use the agent `name`; a display name only relabels the card and its skill.
- The `m365-declarative-agent`, `microsoft-foundry` and `aws-agentcore` platform targets no longer
  export an OpenAPI tool with more operations than its `allow` rules permit (issue #1012, part of;
  ADR-0133 amendment): M365 and Foundry emit a spec narrowed to the allowed operations, and a tool
  whose spec cannot be narrowed, or any `allow` tool on AgentCore, is dropped with
  `permissions_unsupported`, so `--strict` exits 5.
- A passing Test Runtime is now also stored per workspace in PostgreSQL (`runtime_verifications`), so
  runs no longer fail at the `runtime_profile` step on a serverless instance that did not run the test
  (#827). The log line of a failed run preparation is redacted of the secrets it could resolve instead
  of being withheld when one secret cannot be resolved.
- The engine catalogue (ADR-0136, #946) is the one place an engine is described: the stored policy,
  the SDK engine settings and the registry versions are built from it, with a compile-time guard that
  fails when an engine has no arm.
- The gateway now refuses an Azure OpenAI connection without `apiVersion`, as the API always required; set `"v1"` for the v1 surface.

### Added

- Platform targets and stored-version exports over the API and the SDK (issue #968, part of;
  ADR-0133): `GET /api/platforms`, `POST /api/agents/:id/platform-exports` (JSON files plus the
  per-field verdict report) and `.../platform-archives` (the same files as a tar), surfaced as
  `aw.platforms.list`, `.export` and `.exportArchive`. Connectors and skills are resolved; a
  connector credential is only ever a `CONNECTOR_<NAME>` secret reference.
- Platform exports refuse what cannot be carried safely (issue #968, part of): a connector whose
  URL carries a credential, a `bearer` or `api-key` connector with no credential on file, and
  connectors whose `CONNECTOR_<NAME>` secret names collide are each a `dropped` verdict naming the
  connector (never its URL). A skill that is dropped no longer counts toward the export size cap.
- Stored-version exports are assembled by the SDK's `loadPortableProject` (issue #968, part of;
  ADR-0133): they now carry the version's subagents (each agent's `production` version, else its
  `local` one; a subagent the workspace cannot serve is `422 platform_agent_not_found`), the
  granted knowledge files, and the public MCP tool endpoint of the one live `mcp-project` client
  that publishes the agent (its key is the `TOOL_ENDPOINT_<CLIENT>` secret reference). An OpenAPI
  connector is reported as `dropped`, because only its document's digest is stored. In the SDK,
  `LoadPortableProjectInput.project` needs only `connectors` and `models`, and `codeTools` and
  `codeToolNames` may be left out to use each body's recorded `toolBundles`.
- `aw.endpointClients` in the SDK and `aw endpoint-clients …` in the CLI (issue #949, closes; ADR-0134):
  create endpoint clients and mint their endpoint-scoped keys, shown once. The scope matrix test now
  also covers every `API_ROUTES` entry, and `isPrincipal` is tested to refuse an API key with a
  `session` scope.
- `docs/platform-matrix.md` (issue #956, part of; ADR-0133): the capability table of every registered
  platform target, generated from the targets and the conformance kit, with a `--check` gate in
  `pnpm docs:check`. `@indx-workspace/platforms` joins the lock-step npm release set; the Owner
  hand-publishes its `0.0.0-bootstrap` placeholder before the next `packages-v*` tag
  (`docs/release/README.md`).
- The `claude-managed-agents` platform target (issue #960, part of; ADR-0133): a portable project
  compiles to the `ant apply` layout, with a per-field verdict report. Compile side only.
- The `claude-managed-agents` importer (issue #960, part of; ADR-0133): reads an `ant apply` layout
  back into a portable project with a per-field verdict report, refusing malformed files with a
  typed error that never quotes their content. `docs/platform-matrix.md` gains an Import row.
- The `copilot-studio` platform target (issue #961, part of; ADR-0133): a pure translator from the
  portable agent to a Copilot Studio `pac copilot` workspace plus one Power Platform custom
  connector per remote MCP server, with a verdict for every field it cannot carry. It also imports a
  cloned workspace back into a portable project.
- The `microsoft-foundry` platform translator in `@indx-workspace/platforms` (issue #963, part of;
  ADR-0133): portable agents compile to Foundry prompt-agent version bodies and a publish plan.
- The `microsoft-foundry` importer (issue #963, part of; ADR-0133): reads emitted agent versions, or
  a saved `GET .../versions/{v}` response, back into a portable project with a per-field verdict
  report, refusing malformed files with a typed error that never quotes their content. API-key and
  OAuth 2 MCP credentials are planned as project connections, over-long connection names are
  shortened deterministically, and the publish plan notes the vendor facts still unconfirmed.
- platforms: aws-agentcore translator (AgentCore harness project) (issue #964, part of; ADR-0133):
  `@indx-workspace/platforms/aws-agentcore` compiles a `PortableProject` into an AgentCore CLI
  project with one managed harness, and reports a verdict for every field. The importer follows
  separately.
- The `gemini-enterprise` platform target (issue #966, part of; ADR-0133, ADR-0135): a pure
  translator that emits the A2A v0.3 Agent Card and the Gemini Enterprise agent-registration request
  for the root agent, which keeps running on the deployment. Compile only; no importer.
- The `platforms:` block of `agent-workspace.yaml` (issue #959; ADR-0133): which agent platforms a
  project exports or publishes to, with their options; credentials only as `{ secret: NAME }`.
- The portable agent (issue #950, part of; ADR-0133 D2/D3): `PortableAgent` and `PortableProject`
  schemas and the platform id list in `@indx-workspace/contracts`, and a strict, round-tripping
  `.agent.md` parser and serialiser in `@indx-workspace/sdk/portable`.
- Agent definitions convert to and from the portable agent (issue #954, part of; ADR-0133 D5):
  `toPortableAgent`, `portableFromAgentVersionBody` and `defineAgentFromPortable` in
  `@indx-workspace/sdk/portable` return the converted value and a list of everything the target
  cannot carry, each with a path and a reason.
- `loadPortableProject` in `@indx-workspace/sdk/portable` assembles the `PortableProject` a platform
  translator takes (issue #954; ADR-0133 D5): the project's TS and `.agent.md` agents plus the skill,
  knowledge and OpenAPI bytes, read through an injected file source, with each agent holding only
  the code tools it lists. An OpenAPI spec path written `./openapi.json` is now carried instead of
  dropped, and a reordered Claude tool policy no longer counts as a drop.
- Added endpoint clients and endpoint-scoped API keys
  ([ADR-0134](docs/adr/0134-external-platforms-reach-tools-and-agents-through-endpoint-clients.md),
  issue #949, part 1): `/api/endpoint-clients` creates a client that names one MCP project or one
  agent, and mints a static key bound to it. The key is refused on every route outside its scope
  with `403 token_out_of_scope`. The SDK and CLI follow separately.
- Published agents speak A2A v0.3 over JSON-RPC
  ([ADR-0135](docs/adr/0135-published-agents-speak-a2a-v0-3-over-json-rpc.md), issue #955, part
  of): `POST /api/a2a/agents/:agentName` serves `message/send`, `message/stream`, `tasks/get` and
  `tasks/cancel` for the version the agent's `production` pointer names, and
  `GET /api/a2a/agents/:agentName/.well-known/agent-card.json` serves the agent card. Only an
  API key is accepted (a session or browser token gets `403 a2a_credential_not_accepted`), and the
  route is rate limited. The card needs the new `AW_PUBLIC_URL` setting.
- `POST /mcp/projects/:name` serves the code tools of an `mcp-project` endpoint client's agents
  (`initialize`, `ping`, `tools/list`, `tools/call`;
  [ADR-0134](docs/adr/0134-external-platforms-reach-tools-and-agents-through-endpoint-clients.md)
  part 2, issue #967). Only that client's endpoint-scoped API key is accepted, each call is audited
  as `endpoint-tool-called`, and the route is rate limited. The tools run in a sandbox only the
  gateway can reach, under a 60-second grant the control plane signs.
- Added an OAuth 2.1 authorization server for endpoint clients
  ([ADR-0134](docs/adr/0134-external-platforms-reach-tools-and-agents-through-endpoint-clients.md)
  part 3, issue #971): `/oauth/authorize`, `/oauth/token` and `/oauth/revoke` plus the RFC 8414 and
  RFC 9728 metadata documents, served from `AW_PUBLIC_URL`. Authorization code with PKCE S256,
  client credentials and rotating refresh tokens issue short-lived `awo_live_` tokens bound to one
  endpoint URL; `POST /api/endpoint-clients/:id/secret` shows a client secret once. Migration
  `0050_add_oauth_to_endpoint_clients.sql` adds the columns and the `oauth_tokens` table. The SDK and
  CLI follow separately.

- `packages/platforms` (issue #956, part of; ADR-0133 D6-D8): the `PlatformTarget` port, the
  per-field verdict model and a framework-free conformance kit that every platform target runs.
  No target ships yet, and the package is not yet published.
- The `m365-declarative-agent` target (issue #962, part of; ADR-0133): compiles a portable project
  to an Agents Toolkit project for a Microsoft 365 Copilot declarative agent (manifest v1.8, API
  plugin manifests v2.4), reporting a verdict for every field. The import direction follows
  separately.

### Fixed

- The `copilot-studio` platform target no longer maps an `api-key` or `oauth2` MCP tool, or tool
  endpoint, to a Bearer custom connector that cannot authenticate it: it is dropped with
  `field_unsupported` and a note naming the scheme (issue #961, part of).
- The `claude-managed-agents` target refuses a project whose MCP servers reach one URL with different
  `secretRef`s (a vault holds one credential per URL) instead of emitting a credential plan that
  cannot be applied (issue #960, part of).
- A run that fails preparation because its tool sandbox could not be opened now names the runner
  manager's `tool_sandbox_unavailable` reason in its stored error, redacted of the run's secrets and
  withheld when they are unknown; the runner's manifest, run-token and readiness failures name their
  cause and the last probe status (#827).
- The lightweight journey builds the E2B tool-host template from the checkout for each e2b lane, in
  parallel with the runtime template, instead of reading `E2B_TOOL_HOST_TEMPLATE` (#827).

### Documentation

- ADR-0133: portable agent definition and platform targets.

### Security

- `GET /api/files/search` no longer returns files under `.attachments/` (surface visitors' uploads) to workspace members; a run still searches the attachments it was granted.
- The web app moves to Next.js 16.4.2, which fixes an unauthenticated remote code execution
  ([GHSA-2464-fhr4-w9xw](https://github.com/advisories/GHSA-2464-fhr4-w9xw)) and an App Router
  denial of service ([GHSA-p3m5-59mp-jv5r](https://github.com/advisories/GHSA-p3m5-59mp-jv5r)) in
  Next.js 16.0.0 to 16.4.0.
- Every image moves to the Node.js 24.22.1 security release (October 2026: the Brotli decoder
  out-of-bounds write CVE-2026-111497, the TLS hostname validation fixes CVE-2026-105483 and
  CVE-2026-106069, the `dns.resolve` truncation CVE-2026-105482 and the rest of that release).
  The release's bundled CA store also distrusts the eight compromised eMudhra intermediates.
  The Nx remote cache image moves from Node 22.20.0 to the same 24.22.1 line.
- A session-scoped browser token now gets `403 token_out_of_scope` from `POST /api/files/:id/upload-urls` on every object store, so a visitor's upload goes through `POST /api/sessions/:id/attachments` and its flag, name, rate and quota rules instead of minting unlimited presigned `PUT` URLs.
- A session share publishes the turns its publisher chose, copied by the server from the session's stored runs with secrets masked, instead of text the browser sent. A run of another session, or a transcript over 1 MiB, is refused with `400 invalid_share`, and a raw transcript array is no longer accepted. The public page shows the copied conversation, and labels a share published before this change as provided by the person who shared it.
- A storage endpoint on `AW_PUBLIC_URL`'s origin is refused (`storage_endpoint_same_origin`), so signed downloads never come from the app's domain. Without `AW_PUBLIC_URL` an endpoint is not checked and a warning says so. Platform archive downloads now also send `X-Content-Type-Options: nosniff`.
- `POST /api/files/:id/upload-urls` decides again, after reserving the path, whether the caller may overwrite a file that another member created in the meantime, so a Builder no longer receives a link that overwrites someone else's file.
- Server logs now mask the value of a bare `sig=`, `X-Amz-Signature=` or `X-Goog-Signature=` pair that appears outside a full signed URL, such as a query string or header quoted in an error.
- A storage connection's credential is now bound to the endpoint, account and bucket it was supplied
  for. Browse, test and run start open the connection only when the row they read names the same
  target; a mismatch from a concurrent edit is refused before storage is opened, with the existing
  errors, and never falls back to another identity. Revisions up to 0.6.11 cannot read a credential
  stored this way and refuse the connection: drain older revisions before you create, edit or rotate
  a storage connection (see the self-hosting guide).
- A credential sent with `PATCH /api/storage-connections/:id` or `PUT …/credential` is bound to the
  URL the request was checked against. When another edit has moved the connection to a different
  target in the meantime, the request is refused with `409 storage_connection_credential_required`
  and the stored credential is left as it is.
- A credential stored before this release is bound to the connection's URL the first time it is
  read, and is never used for a URL the connection did not have then.
- `POST` and `PUT /api/secrets` now refuse every name starting with `STORAGE_CONNECTION_`
  (`409 secret_name_conflict` on create, `409 secret_in_use` on replace): only the storage-connection
  routes write a connection's credential. `DELETE /api/secrets/:id` refuses such a secret with
  `409 secret_in_use` while its connection exists, and deletes it once the connection is gone.
- A code tool's `secrets` and a connector's `identity` secret can no longer name a storage
  connection's credential. A `STORAGE_CONNECTION_` name is refused when a version is saved (`400`
  with the schema's validation details) and on every connector write: create, `PATCH`, tool
  connectors and the project file. A version or connector stored earlier never reads it; the tool
  is refused as for a missing secret.
- After you deploy this release, restart running tool sandboxes: one opened before it that declared
  a `STORAGE_CONNECTION_` secret may still hold that credential in its environment. Rotate the
  credential of any storage connection whose secret a code tool could have named.
- An S3 storage connection's `publicEndpoint` goes through the same outbound check as its `endpoint`: a link signed for a private or link-local address is refused with `storage_connection_endpoint_forbidden`, so a signed link never sends its fetcher to one.
- An Azure Blob storage connection on the default account host (`<account>.blob.core.windows.net`) is checked against the outbound policy and pinned to the checked addresses, as one with `?endpoint=` already was.
- A file upload that replaces an existing file (`POST /api/files`, `POST /api/files/{id}/upload-urls`) is now authorized against the file the catalog reserved under its path lock, not against an earlier read of the path. A Builder can no longer overwrite another member's file that was created at the path, or renamed away from it and the path reused, while the upload was starting; the upload answers 403 and the other member's file and bytes are kept.
- A signed upload link can no longer change a file after its upload was completed. Completing an
  upload (explicitly, or by the cleanup job) now streams the uploaded object once into a new object
  that no link was ever signed for, records the size and SHA-256 of the bytes written to that copy,
  and switches the catalog row to it in the same transaction that makes it ready; the file keeps
  its id. Reusing the link afterwards only rewrites the now-unreferenced uploaded object, which the
  cleanup job's orphan sweep removes once it is older than the longest link lifetime plus an hour.
  The cost is one extra bounded streaming copy per upload, with flat memory. Files that were already
  ready before this release are not migrated: they keep the object their upload link named, and any
  such link has expired after at most its signed lifetime.
- A run's storage write-back now keeps every path its launch delivered read-only. Removing an
  overlapping read-only grant (an exact file or a folder inside a `read-write` grant) while the run
  is in flight no longer lets that run write the path back; the file is counted as refused. A
  read-only grant added during the run is still honoured, and a removed `read-write` grant still
  writes nothing.

## 0.1.0 — release candidate

_Prepared 2026-09-09. The release is not tagged: D-10 blocks it until the residual risks in
[`docs/release/security-review-0.1.0.md`](docs/release/security-review-0.1.0.md) are signed._

- Added the spec-derived eleven-step E2E harness and an on-demand Docker Compose workflow. The live
  model path remains credential-bound and the full flow is not green.
- Published evidence-backed provider and runtime matrices. Their generated marks—not this changelog—
  are the capability claims for the candidate.
- Added the reproducible security review and the section 55 walkthrough instrument. The walkthrough
  has not been performed by a non-engineer.
- Added release/version consistency and exact Claude Agent SDK specifier gates.
- Carried the missing Wave 2c screens and the D-06 runnable-link conflict as explicit release
  blockers. No published container image is claimed under D-05.
