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
- An agent may keep a memory folder across sessions (ADR-0163, #1526).
  `permissions.memory: 'agent'` (`defineAgent({ permissions: { memory: 'agent' } })`), in force
  while `readFiles` and `writeFiles` are both on, hands the run the workspace folder `memory/<agentId>/` read-write at
  `memory/`, and a completed run writes its `memory/` back there: at most 64 files and 256 KiB
  (`memory_limit_exceeded` otherwise), symlinks refused, only new or changed files, nothing deleted.
  Each run that wrote leaves one `memory-updated` audit row naming the run (migration 0100). The
  Claude adapter adds one system-prompt line naming `memory/MEMORY.md`. A member reads and deletes a
  fact in the file browser, and the next session is not handed it. An agent without `memory` is
  unchanged. The folder belongs to the agent, not a person: every person who runs the agent reads
  what any earlier run wrote there, another person's facts and any saved injected instruction
  included. Per-person memory waits for #1281.
- An agent's page has a **Schedules** tab: it lists the schedules that start the agent, with when
  each runs next in its own time zone, pauses, resumes and deletes them, and adds one from a
  preset (every hour, every day, every weekday, every Monday) or a cron expression. It is hidden
  while the workspace has Triggers switched off, and a Viewer is told who may use it (UX-18 in
  #2086).
- Agent-team runs keep their tree bounded and stoppable (spec 04 §5.18, #1517). A member call
  whose lead is no longer `running` starts no child: the run start answers
  `409 parent_run_stopped` and the lead sees `team_member_refused`. A member call that is waiting
  interrupts its child as soon as the lead stops and answers `team_member_cancelled`. A child's
  approval continuation counts against its root's 16 children, so a decision over the limit
  answers `409 team_member_limit` and the child stays paused. A scoped credential cannot decide an
  approval on a team lead run (`403 token_out_of_scope`), as it cannot start one.
- Agent teams run (ADR-0104 acceptance, spec 04 §5.18, #1517). `POST /api/agent-teams/:id/runs`
  starts the team's newest version on its lead, as a run start of the lead (the same body without
  `version`, the same `Idempotency-Key` and refusals; `409 agent_team_has_no_version` for a team
  with no version; a scoped token is `403 token_out_of_scope`). The root run records its team
  version in the new nullable, tenant-paired `runs.agent_team_version_id` (migration 0098).
- The lead sees each member as `agent__<member>` (`mcp__agent__<member>` on the Claude engine),
  served by `POST /api/runs/:id/members/mcp` on the lead run's own token at `AW_PUBLIC_URL`. A
  member call starts a child run of the member's pinned version for the person behind the lead, with
  its own definition met with the ceiling, at most 16 per root (under a lock), waits for it and
  returns its answer, or a typed tool error (`AGENT_TEAM_TOOL_ERROR_CODES`) that never carries
  provider text. A child run gets no member tools, and interrupting the root interrupts every live
  child through the durable cancellation path.
- SDK `aw.agentTeams.run(id, input)` and CLI `aw agent-teams run <team> <prompt>` (with
  `--session`, `--idempotency-key`, `--wait`, `--follow` and `--fail-on-error`).
- The agent-team routes of ADR-0104's acceptance (spec 04 §5.18, #1516): `GET/POST
  /api/agent-teams`, `GET/DELETE /api/agent-teams/:id` and `GET/POST /api/agent-teams/:id/versions`,
  cursor paged, decided as the `agents` resource (every role reads, a Builder writes its own teams,
  Owner and Admin any) and audited as an agent change naming the team. A bad lead or member list is
  `422 agent_team_member_invalid`; another workspace's team is `404 agent_team_not_found`.
- Run trees on the run read: every run renders `parentRunId`, and `GET /api/runs/:id` adds
  `children` (at most 16, oldest first, one indexed read) and `treeCost`, the exact decimal sum of
  `cost` over the run and its children. Lists carry neither. Nothing starts a child run yet.
- Migration `0097_agent_teams` (expand-only, #1516): the tenant-paired tables `agent_teams`,
  `agent_team_versions` and `agent_team_version_members`, where a team version pins the lead's and
  each member's agent version, and the nullable `runs.parent_run_id`, a run of the same workspace
  and never the run itself. Nothing writes `parent_run_id` yet. The core `AgentTeamRepository`
  numbers versions under the team's lock and refuses another workspace's agent, an unknown version
  and the lead listed as a member. The formal ER model gains the three tables and the column.
- `aw dev` runs a development OIDC issuer on `127.0.0.1` when no `OIDC_*` variable is set (issue
  #2075, ADR-0161's 2026-11-01 amendment), so the local console and a generated app sign a person
  in with a member's email and the local console password. The app gets `AW_OIDC_ISSUER_URL`,
  `AW_OIDC_CLIENT_ID`, `AW_OIDC_CLIENT_SECRET`, `AW_APP_CLIENT_ID` and `AW_APP_CLIENT_SECRET`, and
  `aw dev` makes its `app-backend` endpoint client for the project's agents, so the app's
  `aw.auth.exchange` starts runs as the signed-in person. One to three `OIDC_*` set is refused
  (`oidc_configuration_incomplete`). The local runtime takes `environment.devIssuer`, refuses a
  hand-set `OIDC_*` beside it (`dev_issuer_oidc_set`) and links the bootstrap Owner's identity at
  the issuer. The production posture refuses a non-`https:` `OIDC_ISSUER_URL` at boot
  (`oidc_issuer_not_https`). The local runtime's key may create an `app-backend` endpoint client
  and rotate its secret in the local posture only. The console's sign-in uses
  `client_secret_basic` with an issuer that serves only that. `awu_live_` is still refused on
  every run route.
- A Cloud Run app can now take its workspace id, API key and connector id. Set `workspaceId`,
  `apiKeySecret` (the id of a Secret Manager secret that holds the key, never the key) and
  `connectorId` on the app in `agent-workspace.yaml` and deploy again: the app gets
  `AW_WORKSPACE_ID`, `AW_APP_CONNECTOR_ID` and `AW_APP_API_KEY`, and its own service account may
  read that one secret and no other. Before, an app on Cloud Run answered `app_misconfigured` past
  `/api/health`. `aw deploy` now names the keys an app still lacks.
- A Cloud Run app can now sign people in. Set `signIn` on the app in `agent-workspace.yaml` and
  deploy again. It holds the app's client id at the deployment's `gcp.oidc` issuer, the Secret
  Manager id of that client's secret, the app's `app-backend` endpoint client id, and the Secret
  Manager id of that client's secret. The app gets `AW_OIDC_ISSUER_URL` (always `gcp.oidc.issuer`,
  the one issuer the token exchange trusts), `AW_OIDC_CLIENT_ID`, `AW_OIDC_CLIENT_SECRET`,
  `AW_APP_CLIENT_ID` and `AW_APP_CLIENT_SECRET`. Its own service account may read those two secrets
  and no other. Before, an app's sign-in on Cloud Run answered `sign_in_not_configured`. `aw deploy`
  now prints the redirect URI to register for each app with a sign-in, and a gap line for each app
  without one.
- `aw deploy production` on the `gcp-cloudrun` target deploys `environments.production.apps`
  (the Vercel target still refuses them). Each app is its own Cloud Run service with its own service
  account, its own PostgreSQL role and schema, internal ingress, and one always-on instance that
  migrates on start. An app answers past `/api/health` once its `workspaceId` is set, and its
  agent panel and recipes work once `apiKeySecret` is set (see the app credentials note). An app
  name is at most 25 characters on this target. The next steps print each app's run.app address
  and, with `gcp.domain`, the host to point at the load balancer.
- Cloud Run now runs code tools and `stdio` MCP servers in a per-session tool sandbox: an internal
  service with the same no-egress firewall as an agent sandbox. A tool call no longer answers 503
  `tool_endpoint_unavailable` on this target.
- One limit remains on Cloud Run. Agents cannot call an app's MCP endpoint yet, because sandboxes
  reach only the gateway.
- The tool-host image is copied into Artifact Registry by digest with the other images (`tool-host`),
  pinned for the Cloud Run deployment in `.env` as `CLOUD_RUN_TOOL_HOST_IMAGE` and overridable with
  `AW_TOOL_HOST_IMAGE`; the single-vm `.env` is unchanged. The runner manager places tool sandboxes
  when `AGENT_WORKSPACE_TOOL_HOST_IMAGE` is set. The tool host is a second private Cloud Run service
  per session (`rt-tool-` prefix) that receives its manifest and run token over an authenticated
  file intake. The gateway's service account holds `roles/run.servicesInvoker` conditioned on the
  request's host (`rt-tool-….run.app`): Cloud Run's invoke check sees the host but not the service
  name, so a name condition let the gateway invoke nothing. The runner manager refuses a tool
  sandbox whose URL that condition would not match, and the module refuses a `name` starting `rt-`.
- A Cloud Run tool sandbox is found and removed by labels, so any runner manager instance reuses or
  deletes a session's sandbox, and one past its lifetime is deleted when the next starts. A sandbox
  whose host restarted is replaced, and a tool host serves parallel requests.
- On Google Cloud Run, an agent can now use the `restricted` and `open` network policies. Set
  `environments.production.gcp.sandboxInternet: true` in `agent-workspace.yaml`. `aw deploy
production` passes it to Terraform as `sandbox_internet`, copies the egress-proxy image into your
  Artifact Registry as a fifth image, and creates one proxy VM with no external IP on its own subnet
  (without Private Google Access), a Cloud NAT gateway that serves only that subnet, firewall rules
  that let a sandbox open port 3128 to the proxy and nothing else of it, and a signing key in Secret
  Manager. The plan summary adds the VM and the NAT gateway to the idle-cost line, at list price.
  Without `gcp.sandboxInternet: true` nothing extra is copied, planned or created and sandboxes keep `none`.
- Each run gets a proxy credential signed with that key. It names the run's session and its
  allowlist, and the proxy refuses private ranges, the cloud metadata server and the Google
  private-access ranges for every run, `open` included. The credential lives as long as the
  runtime; once it has expired the runner starts a new runtime for the session's next run.
- Web accepts `restricted` on Cloud Run when the proxy is configured. Without
  `gcp.sandboxInternet: true` the refusal now says so.
- A deep link to the page of a feature the deployment does not install (it is missing from `AW_DEPLOYMENT_FEATURES`) now says, in English and Japanese, that the feature is not installed in this deployment and that the operator adds it to the `features` list in `agent-workspace.yaml` and deploys again. It shows no Settings link and does not tell the reader to ask a workspace Owner, who cannot switch it on.
- The console chat shows Approve and Reject when an agent pauses before a tool call that needs
  approval, and follows the run the decision continues in the same conversation. Before, the
  chat showed only an "Awaiting approval" badge and the decision could be sent through the API
  only.
  While the card asks, and while the continued run is queued or running, the follow-up box waits,
  so a new message can neither hide the request nor cut off the approved call.
- The console's run detail shows the run tree of an agent team run (ADR-0104, #1517): a Team card
  lists each child run as a collapsible row with its status, cost and a link to it, the tree cost
  sits beside the run's own cost, and a child run links back to its lead run. In the run view, an
  `agent__<member>` activity row shows the member name and links to the child run it started. The
  new strings are in English and Japanese.
- The console has a **Sign out** button under the signed-in person in the sidebar. It expires the
  session cookie (and the workspace-selection and invitation cookies) and goes back to the sign-in
  screen. Before, nothing ended a session: a shared computer stayed signed in until the cookie
  expired, up to 12 hours. Sessions stay stateless, so a copied cookie is still valid until it
  expires.
- A chat opened from the sidebar's recent chats now shows its earlier messages above the composer:
  what you typed and what the agent answered, read from the Claude Agent SDK session transcript
  (spec §20). Tool calls, tool results and thinking are left out, as in the live chat. The last 40
  messages are shown, and the screen says how many older ones are not. They stay on screen when you
  send the next message (UX-05 step 2 in #2086).
- The Files screen uploads a whole folder: pick one with "Upload a folder and everything in it", or
  drop one on the list. Each file lands at its path inside the folder under the folder on screen,
  the server adds the folders on the way, and an empty subfolder of a dropped folder is created too.
  Each file is said to be uploaded or not and why, as for several files. One upload takes at most
  1,000 files; a larger one is refused before anything is sent. A dropped folder used to be skipped
  with "Upload the files inside it instead" (#2086).
- The Files screen has a search box. It finds files by the words inside them and shows each
  file's path, page or sheet, and the matching text, with buttons to open its folder or download
  it. It says when results are partial and lets you search again, says plainly why a search could
  not run (no words, no access, Files switched off), and speaks Japanese when the browser asks for it. Clearing the search shows the folder again (UX-17 in #2086).
- The Google Cloud Run recipe carries two new `environments.production.gcp` keys: `settings` sets a
  closed list of non-secret web settings, and `secretSettings` maps `AW_DEMO_OPERATOR_TOKEN` and
  `AW_DEMO_ANTHROPIC_API_KEY` to Secret Manager secrets that web reads at `latest`. The deploy checks
  from metadata that each secret holds an enabled latest version. Behind a `gcp.domain` the web service now sets
  `AW_TRUSTED_PROXY_HOPS=2`.
- `aw deploy status production` reports a Google Cloud deployment without changing it: the CLI
  version and the image of each service, whether each Cloud Run service's latest revision is
  ready, whether data protection is on, off or partial, and whether the stack has drifted from the
  project file (a plan that does not lock the state and is never applied). It exits 0 when every
  service is ready and the plan is empty, 3 when the plan has changes, and 1 when a service is
  not ready or nothing was deployed from this machine.
- `aw deploy production` deploys the whole workspace into your Google Cloud project from one
  `gcp: { project, region }` block in `agent-workspace.yaml` (BYOC Google Cloud, phase P1). It first
  checks your tools, sign-in, project, billing, APIs and organisation policies and prints every
  result with one fix command per failure; with `--yes` it creates the state bucket, enables the
  APIs, copies the release images and applies, printing a plan summary, per-step timings and the
  web address. `aw deploy production --show-owner-password` prints the generated Owner password,
  which is never shown otherwise. `aw deploy destroy production` removes the stack after you type
  the project id; data protection keeps the database unless the stack was created disposable
  (`TF_VAR_data_protection=false`). `docs/deploy/gcp-cloudrun.md` is rewritten task-first, with
  Cloud Shell first and the `--infra` procedure for maintainers.
  A Google Cloud region with a two-digit number (`europe-west10`) is accepted. The check now also
  asks for `gcloud auth login`, which a laptop needs beside `gcloud auth application-default
login`. `aw deploy` refuses a state bucket owned by another project, stops a destroy before
  anything is deleted when Cloud SQL data protection is on, and copies the release images again
  when a plan or a destroy left a pin to images that are not there.
  `aw deploy` re-runs `terraform init` (against the shipped lock file) when the shipped module's
  providers or lock file change, refuses a `name` in `terraform.tfvars` or `TF_VAR_name` that differs
  from the project name, checks the `iam.serviceAccounts.actAs` permission, refuses to start a second stack beside one whose state is elsewhere (it prints the `init -migrate-state`
  command), refuses a `--infra` checkout whose tfvars name another project or region, and
  `aw deploy destroy production` refuses a stack that never used the managed state. The permission
  fix names the narrowest roles instead of Owner, and the Terraform install command checks the
  archive against HashiCorp's SHA256SUMS. A project name longer than 19 characters is cut to 14 characters plus a short hash of the full name. The public-access organisation-policy check prints no fix, and `aw deploy destroy` says the same project name cannot be redeployed right away.
- A project file may name the Google Cloud project and region a `gcp-cloudrun` production deploys
  to: `environments.production.gcp: { project, region }`. `gcp` is accepted only with
  `target: gcp-cloudrun`, and a new project file carries a commented example of it.
- The home chat's "+ Files" picker lists the workspace files and folders the chosen agent is
  granted, with each one's access, and the picks narrow the chat: the first message and every
  follow-up are sent with the picked paths as the run's `fileScope`. The run start re-checks each
  path against the agent's grants and refuses one outside them (`run_file_scope_not_granted`), so a
  pick never widens access; picking nothing keeps every grant, as before. The list is shown only to
  someone who may read the agent's resources. Storage-connection folders are not listed, since
  `fileScope` narrows workspace files only. On a phone the composer's pickers now span the screen
  instead of running off it (#2089, RF-502).
- `examples/` holds four reference apps built only on the published `@indx-workspace/*` packages,
  each generated from its own `commands.sh` by `npm create` and `aw generate` plus a measured
  amount of handwritten code: a team chat (`examples/team-chat`), a wiki (`examples/wiki`), a CRM
  (`examples/crm`) and a service desk (`examples/service-desk`), beside the `examples/minimal`
  fixture (#1476). Each is scored on six cells (Generated, Handwritten budget, Journeys, Agent on
  data, Self-host, No fork); `examples/README.md` holds the scoreboard, and a cell that is not met
  is shown as a gap with its cause.
- The "Webhooks" resource guide (issue #250, N-3): register an endpoint, what a `WebhookEvent`
  carries, the Standard Webhooks v1 signature and `verifyWebhookSignature`, the retry schedule,
  deduplication and who may manage webhooks. "Integrate a backend" shows a receiver that verifies
  the raw body, deduplicates on the event id and answers a fast `2xx`, and "Retries and
  idempotency" points at a webhook instead of a polling loop. The roadmap's N-3 entry is removed.
- A run stops at its spend ceiling on every engine (ADR-0162, #1524). `runs.spend_ceiling_usd`
  (migration 0099) holds the lowest of the agent's `limits.maxBudgetUsd`, the deployment ceiling's
  and the start's new `spendCeilingUsd` (`aw.runs.start(agentId, { spendCeilingUsd })`,
  `aw runs start --spend-ceiling-usd <usd>`), which can only narrow: a higher value is
  `403 policy_cannot_widen` with the detail `spendCeilingUsd`. The run resource returns it as
  `spendCeilingUsd`. Once the run's cost reaches it, the gateway refuses the next model call with
  `403` `run_budget_reached` and ends the run `failed` with that failure code (`503
  run_budget_unavailable` when the end cannot be written). The engine receives the same value as
  its `limits.maxBudgetUsd`. The console run view says "Stopped at its spend ceiling (<n> USD)",
  shows the ceiling next to the cost, and says when an unpriced model leaves it unenforced.
- The run view lists the files a run wrote to its `outputs/` folder once the run ends, each with
  its size and a **Download** button, and links to the folder in Files. Before, those files were
  only in the SDK (`runs.outputs`) or found by browsing Files to `runs/<runId>/outputs/` (UX-14 in
  #2086). A run that wrote nothing shows nothing, and so does a Viewer, who may not read Files.
- A schedule's time can be changed in place: the agent page's Schedules tab has **Change time**,
  and `PATCH /api/triggers/:id` takes `cron` and `timezone` for a `schedule` trigger, checked as on
  create. The change restarts the schedule's counting, so no run is owed for the old time
  (ADR-0144 D5). A `webhook` trigger answers `400 invalid_field`. Before, the tab said to delete the
  schedule and add it again.
- `docs/operations/settings.md` lists the variables web and the egress proxy read at start-up, with
  what applies when each is unset. It is generated from each settings module's own list, and
  `pnpm docs:check` fails when the two differ.
- The sidebar lists your recent chats under New chat, newest first, with "See all" into Runs
  (spec §44). Opening one goes back to the home chat, and your next message continues that chat.
  Its earlier messages are not shown there yet. A new chat is named after its first message. On a
  run's page, "Open conversation" goes to the same chat; the raw session data link stays beside it
  (UX-05 in #2086).
- `docs/operations/storage-grants-report.sql`, a read-only report of the agent versions whose
  storage-connection folders cannot be bound at run time (deployed before per-version grants, or
  granting a deleted connection), with the environments pointing at each. The runbook says when to
  run it.
- The Agent Store app (`examples/store`): shelves with filters, agent detail pages with Try,
  Customize and Under the hood tabs, `/platform`, an enquiry form and a privacy notice, in Japanese
  and English. It is registered with the apps benchmark.
- The platform answers credentialed CORS to the store's origin (`AW_EMAIL_LINK_BASE_URL`) on the
  email-link and guest-session routes, takes enquiries and launch notices at `POST /api/store/leads`
  (consent required), serves the privacy notice's facts at `GET /api/store/privacy`, and a demo
  workspace's remaining runs at `GET /api/demo/allowance`.
- A guest who opens the web shell sees only the screens it can use.
- A run started in an Agent Store demo workspace is refused once the person has started 20 demo
  runs in 24 hours, the client address its configured number, or the site's demo model cost today
  has reached its cap, with a typed `429` (`demo_person_runs_reached`, `demo_client_runs_reached`,
  `demo_site_cost_reached`); while a cap the deployment must set is unset it is refused `503
  demo_caps_unconfigured`. An approval continuation or a team child run is not counted again; it
  still stops at the site cost cap. Other workspaces are never gated.
- A scheduled sweep on the trigger driver deletes demo workspaces after their 24 hours (carrying
  their model spend into the site's daily total), spent and expired email-link tokens, old
  admissions, the user rows of email-link guests nothing references any more (only addresses
  recorded as leads; no other user is deleted), and, once `AW_STORE_LEAD_RETENTION_DAYS` is set, leads past that many days.
- A visitor's copy of an Agent Store demo can now run: it gets a `default` Anthropic model connection
  holding the deployment's demo key and a `demo-sandbox` runtime profile with network policy `none`, made
  only on a runtime driver that enforces it. Its connector reads answer from the entry's sample records.
- A visitor's copy of an Agent Store demo has the template agent's skills: the deployment seeds each
  skill the gallery agent uses into its template, the copy makes them in the visitor's workspace, and
  they are deleted with that workspace.
- The deployment fills the demo templates through an idempotent operator route, keeps an entry "Under
  maintenance" when the daily production test fails it, and answers a read-only readiness check that the
  Anthropic API is reachable with the demo key, without ever returning the key.
- The Agent Store deploys to Google Cloud Run from one project file (`infra/agent-store/agent-workspace.yaml`),
  rendered per environment from repository variables. The deploy workflow builds the images from the commit,
  deploys staging on a merge to main and production only from a `store-v*` tag through a protected
  environment, and stays off until a person has set up the Google Cloud side. It checks that the Anthropic API
  key secret has a version and that the platform reaches the Anthropic API with it, without reading or printing
  the key. The operations runbook lists the one-time setup, rollback, key rotation and the human-only steps.
- A locked-down `guest` membership role, held only inside a demo workspace: it cannot create
  agents, connectors, API keys or workspaces, cannot invite, and no route confers it.
- Email-link (passwordless) sign-in: `POST /api/auth/email-link` sends a single-use link that
  expires after 15 minutes and is stored only as a hash, rate-limited per address and per IP;
  `POST /api/auth/email-link/verify` signs the visitor in as the guest of their own demo
  workspace. The email provider is chosen by `AW_EMAIL_LINK_SENDER`; none is configured by default.
- Each live Agent Store entry has suggested prompts, a moment check and a recording. The recording
  is made by running the entry's real agent against the scripted model, never written by hand. When
  a demo cannot start, the Try tab replays it with the same chat parts as a live run, labelled
  "recorded with the scripted model".
- A store card says "verified with the scripted model" until a recorded real-model run of that entry
  has passed. That run is made by the dispatch-only real-model check (`tests/store/live-verify`),
  which refuses to start without an explicit spend opt-in.
- The CRM, team chat, wiki and service desk examples ship fictional Japanese and English sample
  records for the store's demos.
- The Agent Store demo provisioner: an email-link visitor's demo workspace is marked with its end
  (`workspaces.demo_expires_at`, 24 hours after it is made, never moved), and the entry the visitor
  chose is copied into it from the entry's template workspace through the agents, files and
  connectors domains. The copy's per-run turns and cost are no wider than the deployment's demo
  settings, the visitor is granted the agent and nothing else, a tool that could send or write
  outside is replaced by a stand-in that answers "Sent (demo only, nothing was actually sent)", and
  the contact is recorded as a lead.
  Only a template the deployment made is copied (a workspace whose members are all system accounts
  in a reserved domain), the caps are applied on every copy, and each stand-in echoes the call it
  was given with `delivered: false`.
- Email-link sign-up requires a challenge answer (CAPTCHA or equivalent, provider chosen by
  `AW_EMAIL_LINK_CHALLENGE`; unset answers 503) and refuses addresses on a checked-in
  disposable-email list (422 `email_link_address_refused`). The link carries the chosen demo entry
  in its fragment.
- The tool host container can take its manifest and tokens over HTTP (`PUT /files/manifest.json`,
  `PUT /files/tokens.json`, guarded by the `x-aw-tool-intake` header) when `AW_TOOL_INTAKE_KEY`
  is set, so a tool sandbox runs on Cloud Run, which has no exec or file API. Without the variable
  nothing changes.
- The console hides the sidebar entries of features the workspace has switched off or the deployment does not install (ADR-0160 D8). A deep link to a switched-off feature's page says it is switched off, that nothing was deleted, and that a workspace Owner can switch it on in Settings → Features. A workspace with nothing switched off shows the console exactly as before.
- Settings has a **Features** card with one row per feature: its switch, what it needs and what needs it. An Owner switches a feature off after a confirmation that names the navigation entries that disappear and says the data is kept, and switches it back on at once. A switch the server would refuse is disabled with the reason, and other roles see the card read-only. The card, its confirmation and the switched-off page are in English and Japanese.
- `POST /api/auth/token-exchange` (ADR-0161): an app backend exchanges the signed-in person's ID
  token from the deployment's own `OIDC_ISSUER_URL` for a 300-second `awo_live_` access token of its
  new `app-backend` endpoint client. The token acts as that person on `POST /api/agents/:id/runs`
  (bound agents only), `GET /api/runs/:id`, `GET /api/runs/:id/events`,
  `POST /api/runs/:id/interrupt` and `GET /api/me`, through the person's own role and agent grants,
  and every exchange writes one `user-token-exchanged` audit row. Migration `0096` adds
  `endpoint_clients.oidc_audience` and widens the kind and audit-action checks (expand only).
- Claude on Google Cloud (Vertex AI) is a keyless model provider (`vertex`, #2105). The gateway
  signs each request with its own Google Cloud identity (`roles/aiplatform.user`), so no model key
  is stored. It acts only on the project the deployment names (`GATEWAY_VERTEX_PROJECT_ID`, set by
  the Cloud Run module) and refuses a connection that names another. It offers `claude-opus-5-5`,
  `claude-sonnet-5-5`, `claude-haiku-5-5` and `claude-fable-5-1` in the `global`, `us` or `eu`
  location, prices them in the default catalogue, and refuses the features Vertex AI lacks with
  `vertex_unsupported_feature`. A `vertex` connection takes `projectId` and `location` and no API
  key, and a project file cannot declare it.
- `aw deploy` on `gcp-cloudrun` connects Claude on Vertex AI as the default model on the first
  deploy, and `gcp.modelLocation` picks its location (`us` and `eu` cost 10 % more). The module
  enables the Vertex AI API and lets only the gateway call it. The preflight checks that Claude is
  enabled in Model Garden and links the page that enables it, as a warning that never stops the deploy; a refusal that is not about the model
  is a warning that names its cause. If seeding fails, finish setup in the browser.
- Web: Add provider offers Claude on Google Cloud (Vertex AI), which needs no API key. A connection
  is ready on its config alone, uses the install's project, and refuses any other. An install without a Google Cloud project refuses to create one. Testing it makes
  no network call, and first-run setup shows a sentence instead of the key field.
- Claude engine sandboxes set `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`, `DISABLE_TELEMETRY` and
  `DISABLE_ERROR_REPORTING`, so the engine sends no telemetry or error reports of its own.
- An app backend acting as the signed-in person (ADR-0161) may decide the approval a run waits on:
  `POST /api/runs/:id/approval` is now in the `app-backend` grammar, admitted for an `awo_live_`
  token, and refused `403 token_out_of_scope` for a run of an agent the endpoint client does not
  bind. The decision still clears the person's own run and approval checks.
- Run-outcome webhooks (N-3, #250): `GET`/`POST /api/webhooks` and `DELETE /api/webhooks/:id`
  register, list and remove up to 10 endpoints per workspace (Owner and Admin; `runs` feature). The
  `whsec_` signing secret is returned once by the create answer and kept in the secrets service. A
  delivery worker in the web process (PostgreSQL only, no new service) posts a Standard Webhooks v1
  signed `WebhookEvent` when a run completes, fails or is cancelled, through the egress policy at
  create and on every attempt, and retries a failed attempt with jittered backoff (8 attempts over
  about 21 hours) under the same `webhook-id`.
- `contracts`: the route table lists `webhooks.list`, `webhooks.create` and `webhooks.remove`, and
  the OpenAPI document carries them.

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
- The Models screens are in Japanese for a Japanese reader: the provider list (heading, tabs, each
  row's status, detail line and buttons), Add Provider (every provider's name and description,
  every field, the Vertex AI locations) and a provider's detail panel (connection settings,
  credential rotation, removal with its agent preview). Each screen carries `lang`. A connection's
  name and settings, a test's result line and a refusal's message are shown as the server sends
  them. English is unchanged (UX-15 in #2086).
- The Runtimes screen is in Japanese for a Japanese reader: every driver's name, description, side
  note and disabled reason, the badges, Test Runtime and Save, the note on disabled drivers, the
  runtime switch comparison, and the refusal a member sees. The screen carries `lang`. A
  registered runtime's own reason or refusal and the Test Runtime transcript are shown as the
  server sends them. English is unchanged and still held to the spec and mockup character for
  character (UX-15 in #2086).
- Settings, API keys and Shared links are in Japanese for a Japanese reader: headings, the
  workspace default model card, the API key form (key name, role names as the sidebar says them,
  キーを作成, 無効にする) and every word of the Shared links list. Each screen carries `lang`.
  Endpoint paths, key prefixes and a link's kind and mode are shown as the server sends them. The
  API key form's name box and role list now have accessible names. English is unchanged
  (UX-15 in #2086).
- The Storage screens are in Japanese for a Japanese reader: the connection list (each row, Edit and
  Test and their accessible names, the test line), Connect storage (every field, each provider's
  credential fields, the name and key-pair checks, and the Save and test result) and Edit storage
  connection (settings, credential rotation and the delete dialog), and the refusal a member sees.
  Each screen carries `lang`. A connection's name, provider, URL and folders are shown as they are
  stored. An agent's Connected storage panel is still English. English is unchanged (UX-15 in
  #2086).
- The Users screen is in Japanese for a Japanese reader: the members table (headings, role names as
  the sidebar says them, dates, あなた, the last-Owner note, each control's accessible name), the
  removal confirmation in each of its states, and the invitations section (the form, the one-time
  link panel, and the table with each invitation's state and date). The screen carries `lang`.
  Names, addresses, a refusal's own sentence and the server's one-time-link warning are shown as
  the server sends them. On a phone, short cells keep to one line and the table scrolls inside its
  card, as it does for English. English is unchanged (UX-15 in #2086).
- ADR-0104 is accepted for `handoff` mode (U4.2a, #1515). The resource is an _agent team_
  (`./agent-teams`, `agent_teams*` tables, `/api/agent-teams/**`, `aw.agentTeams`,
  `aw agent-teams`). A lead calls a member as the tool `agent__<member>`, which
  `POST /api/runs/:id/members/mcp` serves on the lead run's token. Each call starts a child run
  that has its own policy, met with the ceiling. The depth is at most 1, a team has at most
  8 members, and a root has at most 16 child runs. The tree cost is summed when it is read, and
  interrupting the root cancels its children. The API specification gains §5.18 and the
  `parentRunId`, `children` and `treeCost` run fields, which land in U4.2b and U4.2c. The run tree
  is modelled in Lean (`Concepts/RunTree.lean`), with its normative theorems.
- ADR-0161 is amended (issue #2075): `aw dev` runs a development OIDC issuer on `127.0.0.1`, so an
  app signs a person in and acts as them by the unchanged token exchange locally. The issuer is a
  CLI tool (Ed25519 keys from `node:crypto`, no new dependency), runs only when no `OIDC_*`
  variable is set, and asks for a member's email and the local console password. The local
  runtime's `start` message gains `environment.devIssuer` (ADR-0109 contract C1). The production
  posture refuses a non-`https:` `OIDC_ISSUER_URL` at boot (`oidc_issuer_not_https`). The app's
  five variables are `AW_OIDC_ISSUER_URL`, `AW_OIDC_CLIENT_ID`, `AW_OIDC_CLIENT_SECRET`,
  `AW_APP_CLIENT_ID` and `AW_APP_CLIENT_SECRET`. ADR-0083 is unchanged: `awu_live_` is still
  refused on run routes. This records the decision; the issuer lands with G1.
- ADR-0161 is amended (issue #1530): an `app-backend` access token (`awo_live_`) is also admitted
  on `GET /api/runs`. The list is the one the person gets in the console, narrowed to the agents
  the endpoint client binds; an `agent` filter outside them is `403 token_out_of_scope`. An app's
  Dashboard (`dashboardRoutes()`) and the portal template's Dashboard and `/runs` page now list
  the signed-in person's runs instead of answering `401`.
- An agent's Configuration tab is in Japanese for a Japanese reader: the definition, model,
  engine and permission sections, the assigned files, skills and connectors, the project-provided
  group, the connected-storage browser and its grants, and the save report. A failure leads with a
  Japanese sentence; the server's or the network's own words follow it, marked as English.
  English is unchanged (UX-15 in #2086).
- The Agents list is in Japanese for a Japanese reader: the heading, the agent count, the search
  box (which now has an accessible name), New Agent, the table, the empty and no-match lines,
  Workspace default and the created date. A list, run or model catalog that could not be loaded
  on the Agents list, the New Agent form or the Runs screens now opens with a Japanese sentence;
  the server's or the network's own words follow it, marked as English. English is unchanged
  (UX-15 in #2086).
- Claude models on an Anthropic API connection now declare prompt caching, so the agent form no
  longer warns that caching is unsupported for them. A weekly live check
  (`model-providers-live.yml`) verified that a cached prompt is written once and then read, in plain
  and streamed requests, through the gateway. Claude on Vertex AI and models on an
  Anthropic-compatible connection still declare no prompt caching, since no live run has shown it
  for them.
- All four reference apps under `examples/` (team chat, wiki, CRM and service desk) now score
  every cell of the benchmark in `examples/README.md` (#1476): Generated, Handwritten budget,
  Journeys, Agent on data, Self-host and No fork. Their journeys sign a person in under `aw dev` at
  its development issuer and act as that person, call the app connector from a claude-agent-sdk
  run, and move a schedule slot with the app kit's test clock. Self-host is measured by the
  `apps-e2e` CI job, which boots each app with Docker Compose.
- On Google Cloud Run, each session's sandbox now has no internet. The sandbox is an internal Cloud
  Run service on your install's sandbox subnet with Direct VPC egress, and a VPC firewall denies all
  its egress except plain HTTP to the model gateway's new regional internal Application Load
  Balancer, a private address on your network. Google's private ranges (`199.36.153.8/30` and
  `199.36.153.4/30`) are denied to sandboxes on every port, so a sandbox reaches no Google API and
  no `run.app` service of any project. All IPv6 egress is denied too. There is no NAT, so under
  network policy `none` a sandbox reaches nothing but the gateway. Public names still resolve
  through the metadata server's resolver. The firewall rules have the highest VPC priority, so an
  egress allow rule on an adopted network cannot override them. The gateway now accepts internal
  traffic only (it keeps `allUsers` at the Cloud Run IAM layer because sandboxes cannot present a
  Google identity; the per-run token is its gate), and `web` hands sandboxes the load balancer's
  address. The load balancer adds an idle cost of one forwarding rule (about US$18 a month at list
  price) plus per-GB data processing. An adopted network must now also have an active proxy-only
  subnet in the region. The runtime image must be in an Artifact Registry repository of the
  install's own project: an image in another project's registry is refused at plan, with a message
  saying to copy it into this project first. The metadata server cannot be firewalled inside Cloud
  Run, so the sandbox service account holds no roles and Google APIs refuse its token. A Cloud Run
  runtime profile that uses `open` or `restricted` is now refused, with a message saying it is not
  available yet; the project-file option `gcp.sandboxInternet` arrives in a later release. The
  runner manager settings `RUNTIME_VPC_CONNECTOR` and `RUNTIME_EGRESS` are replaced by
  `RUNTIME_NETWORK` and `RUNTIME_SUBNETWORK`, which the Terraform module sets.
- Console: the built-in Builder no longer shows in the Agents list or the New chat agent picker.
  Open it from New Agent, as before. A workspace whose only agent is the Builder now says it has no
  agents yet. `GET /api/agents` and `aw chat builder` are unchanged.
- The console's navigation, breadcrumb trail, Menu button, skip link, runtime chip and band, and
  the role under your name are in Japanese when your browser asks for Japanese (UX-15 in #2086).
  The English labels are unchanged.
- The Files screen is in Japanese for a Japanese reader: the heading, the upload and new-folder
  forms, the breadcrumb, the table (columns, file and folder types, Download, Rename and Delete, and
  the rename row), the empty and missing-folder lines, the delete questions, every upload line and
  each file's state, and the drop hint. The file picker that agent detail opens from "Add files or
  folders" follows the reader's language too. A refusal the server or the browser words keeps its
  own English sentence, marked `lang="en"`, after a Japanese lead; a line the screen words itself
  (a part-way move or delete, an upload over the limit) is said in Japanese. A refused create on the
  New Agent form now also leads in Japanese. English is unchanged (UX-15 in #2086).
- Files: the rename row now shows the name of the file or folder being renamed, and offers a
  "Move to folder" choice (Home, the folders on the breadcrumb, and the open folder's subfolders)
  next to the path field. A typed path still works for any other folder.
- The Files screen uploads several files at once: pick more than one, or drop them on the folder
  list. Each file shows whether it is waiting, uploading, uploaded or not uploaded and why, and one
  failure no longer stops the rest. A dropped folder is named and skipped, a file dropped outside
  the list no longer opens in the browser in place of the console, and a file too large for the
  deployment is named with its size and the 64 MiB every deployment accepts (UX-16 in #2086).
- The model gateway parses its settings once, before it opens the database, and names every
  refused variable in one start-up error. A missing or invalid `GATEWAY_PRICING_JSON` now stops
  start-up before any database connection. `docs/operations/settings.md` lists the gateway's
  variables.
- The CLI release pins every platform image by digest, and `aw deploy` on the `gcp-cloudrun` target
  copies only those digests into Artifact Registry. A CLI built from source carries no digests and
  still resolves image tags from the registry, and says so.
- When `cosign` is on `PATH`, `aw deploy` verifies the signature of each release image before it
  copies anything, against the identity of the `images.yml` workflow on `images-v*` tags, and says
  so. A signature that does not verify stops the deploy. `cosign` is not required: without it the
  deploy prints that the signatures were not verified and continues.
- An `AW_WEB_IMAGE`, `AW_GATEWAY_IMAGE`, `AW_RUNNER_IMAGE`, `AW_RUNTIME_IMAGE`,
  `AW_TOOL_HOST_IMAGE` or `AW_EGRESS_PROXY_IMAGE` override now prints a warning that the image is
  not one this CLI release pinned. Overrides are never signature-verified.
- The Google Cloud install (`aw deploy production` with a `gcp` block) is now private by default
  (BYOC Google Cloud, phase P3). The deployment creates its own network, or adopts yours with
  `network` and `subnetwork`. Only the web app and the model gateway are reachable from the internet; the
  runner manager is internal and the web app calls it with its Google identity. Cloud SQL has a private IP address only and accepts
  encrypted connections only. The model gateway stays reachable behind its per-run token until a later
  release, because sandboxes cannot present a Google identity.
- New optional `gcp` keys: `domain` serves the web app at your host name behind a load balancer with
  a managed certificate (point a DNS `A` record at the printed IP address; the certificate is issued
  after DNS points there), `armor` adds Cloud Armor, `iap` adds Identity-Aware Proxy (users outside
  your organisation need a custom OAuth client; IAP sits on the load balancer only, so the `aw-control`
  agent tool keeps working), and `oidc: { issuer, clientId }` sets up single
  sign-on. The client secret is asked for once and kept in Secret Manager (it is asked for again when
  the issuer or client id changes); rotate it with
  `gcloud secrets versions add <name>-oidc-client-secret --data-file=-`. Register
  `<web origin>/api/auth/callback` with your provider.
- `aw deploy destroy production` can wait one to two hours at the end: Google Cloud releases the
  network that long after its services are deleted. `docs/deploy/gcp-cloudrun.md` describes all of
  this.
- The Google Cloud checks say what the organisation policies mean for the deployment. With a
  `gcp.domain`, they check that it points at the load balancer; before the first deploy the address
  does not exist yet, so they warn that the record must be created after the deploy, at the printed
  address.
- With `oidc` set, the first `--yes` run asks once for the client secret (hidden input, or
  `AW_OIDC_CLIENT_SECRET` when there is no terminal) and keeps it in Secret Manager; a re-run asks
  for nothing. The summary says which sign-in is active and, with a `domain`, which address to point
  it at.
- A first `--yes` deploy creates Cloud SQL and its private network with a targeted apply while the
  release images copy, instead of after them, so the two slowest steps overlap. If either fails,
  the error names both outcomes and what was already created.
- The Google Cloud install (`aw deploy production` with a `gcp` block) now has production defaults
  (BYOC Google Cloud, phase P6). Data protection is on by default (`gcp.dataProtection`): Cloud SQL
  has deletion protection, the buckets are versioned (noncurrent versions are deleted after 30 days)
  with a 7-day soft delete and cannot be emptied by a destroy, and the web, gateway and runner
  manager services have deletion protection. This changes behaviour for disposable stacks:
  `aw deploy destroy production` now refuses while any of it is on. Set `dataProtection: false`,
  run `aw deploy production --yes`, then destroy. A deleted bucket stays restorable, and billed,
  for 7 days.
- New `gcp.size`: `small` (the default; shared-core Cloud SQL, one web instance always warm, the
  gateway and runner manager scale to zero) or `standard` (`db-custom-2-7680` with regional high
  availability, at least one instance of every service). Both start with CPU boost and keep 14
  backups with point-in-time recovery (7 days of logs); the maintenance window is Sunday 18:00 UTC.
- Four log-based metrics and a dashboard are created always. New `gcp.alertsEmail` adds an email
  channel, alert policies (web and gateway 5xx, gateway upstream errors, runner manager failures,
  Cloud SQL CPU and disk, live sandboxes over the size's cap) and an uptime check of `/api/readyz`
  (none with `iap`). The live-sandboxes alert counts services with an active instance, not metric
  series. The deploy needs the logging and dashboard roles always, and the alerting roles only
  with `gcp.alertsEmail`; the permission check names them.
- New `aw deploy status production` reports versions, revision health, data protection and drift,
  and exits 3 when the plan has changes.
- The Cloud Build grants and API are no longer part of the install. Secrets are pinned to the
  version the module wrote; the single sign-on client secret stays at `latest`. On an existing
  stack the three Cloud Build grants on the default Compute Engine service account are kept, not
  revoked: Terraform only forgets them (`removed` blocks), so revoke them by hand if unwanted.
- New operator runbook: `docs/operations/gcp-cloudrun-runbook.md` (upgrade, rollback, restore,
  key and secret rotation, budgets, alerts).
- The home chat and the share dialog now speak Japanese to a reader whose browser asks for it: the
  heading, the composer, its pickers and Send, the reasons nothing can be sent, and every word of
  the share dialog. English stays as before, and the values the dialog sends are unchanged
  (UX-15 in #2086).
- The New Agent screen is in Japanese for a Japanese reader: the Form/Chat switch, the five form
  steps (labels, help, permissions, empty and loading states, Create Agent), and the Builder chat
  beside its definition preview, the saved line and the approval card. The card's warnings about a
  change that lowers a guard (skipping permission checks, the whole Claude Code tool set, an added
  tool, a removed deny, a tool used without asking) and the trial and check budget notes say the
  same in Japanese. What the model wrote and what the server sends (a check's sentence, a refused
  decision) are shown as they come, marked as English. English is unchanged (UX-15 in #2086).
- The reference apps' journeys now sign their browser in through the portal's own `/sign-in` at
  `aw dev`'s development issuer (#1530, on #2075, #2076 and #2077), so a run started or decided in
  the app is the signed-in person's. The wiki offers its `writer` on each page: the page's agent
  panel summarizes a page tree into a new page whose first revision carries the panel's run. The
  CRM's agent panel runs as the person. The service desk's journey fires the SLA sweep's slot past
  a ticket's SLA, approves the closure in `RecipeGraph`, and checks the ticket's history links the
  triage, escalation and closure writes to their runs, and its home Dashboard lists the approval
  waiting as the person. The wiki, CRM and service desk now score every cell.
- With **Run commands** on, a shell command that changes something now pauses the run and asks:
  the chat shows Approve and Reject, and Approve runs that one command. Before, the command was
  refused with nobody asked and the run still ended Completed (#2091). A read-only command, and a
  command the stored policy already allows, still runs without asking. The agent form says so.
- The run screen a chat becomes is in Japanese for a Japanese reader: the status badge
  (承認待ち and the others), the follow-up box and its placeholder, Send, the line before Send
  and the agent's detail line (標準サンドボックス · 読み書き), the working and failure notices,
  and Show technical details with its tabs. Each part carries `lang`, so a screen reader reads it as
  Japanese. The transcript, activity lines and event log are shown as they arrive.
- The approval card shows a shell command on its own, so the person deciding reads the command, not
  the call's JSON. The full call, with the agent's own description of the command, is one click away
  under "Full call" (呼び出しの全文). A call with any other argument, and any other tool, is shown in
  full.
- A run start refused with `429 daily_cost_cap_reached` no longer lists `spentUsd` in `details`: it carries `capUsd` and `resetsAt` (and `unpricedUsage: true` when it applies), as the mid-run stop already did. The agent page also reads its tabs again after a restore, and a failed sweep listing is retried at the next delivery instead of after an hour.
- The runner manager names the variable when a driver setting is missing or blank:
  `GCP_PROJECT`, `GCP_REGION` and `RUNTIME_SERVICE_ACCOUNT` on `cloud-run-service`,
  `ACA_SESSION_POOL_ENDPOINT` and its API version on `aca-sessions`, and `RUNTIME_NETWORK` and
  `AGENT_WORKSPACE_TOOL_NETWORK` on `docker`. Before, start-up stopped on the same values with the
  runtime's own option name, such as "project must be a non-empty string". The database, master key
  and tracing settings web and the model gateway share are now in `docs/operations/settings.md`.
- The runner manager reads its settings in one module, `apps/runner/src/manager-settings.ts`, and
  its variables are now in the generated settings table (`docs/operations/settings.md`). A failed
  start logs one JSON line with each refused setting in its own `refused` entry and exits with
  status 1; the same happens for the Vercel Function entry, which answers 500 as before. A bad
  `PORT`, a short `RUNNER_MANAGER_TOKEN`, a bad `RUNTIME_VERIFICATION_TIMEOUT_MS` and a bad driver
  setting are named together, so one restart fixes them all.
- `RUNTIME_VERIFICATION_TIMEOUT_MS` must be a whole number of milliseconds from 1. Before, any text
  was passed through `Number()`, so a typo became `NaN` and every sandbox readiness check timed out
  at once. Unset still means 30 seconds.
- The Runs screen is in Japanese for a Japanese reader: the list, its filters and table, the run
  detail panel (figures, labels, usage and runtime cards, team card) and the words a run's cost,
  duration and model are shown in. The status badges switch to Japanese on the list and the
  detail together with the run screen's, so no screen mixes languages. A run's own error, its
  accounting error and a problem's sentence are shown as the server sends them, marked as
  English. English is unchanged (UX-15 in #2086).
- A session-state blob save now takes the same steps as a file save: a pending row first, the
  `PUT` body streamed to object storage (it is no longer held in memory, up to the 32 MiB cap),
  then a confirm against the row's reservation token. Retention marks a blob row deleting before it
  deletes the bytes, and the cleanup job finishes deleting rows and abandoned reservations.
- On Linux, a `file://` storage connection follows a directory symlink that stays inside the connection's folder: it is listed, read, written and deleted through like the folder it names. A listing counts, and does not enter, a link back to a folder it is inside. File symlinks, links that lead outside the folder, and every link on hosts without `/proc/self/fd` are still refused (#1835).
- An S3 listing page no longer sends a HEAD per file to learn its content type: `contentType` is `null` unless the caller passes the new `ListPageOptions.contentTypes`, and then the HEADs go eight at a time. A run's delivery, a storage-connection browse and every catalog-backed listing send none (#1746).
- Connecting storage now saves and then tests the connection at once with its stored key ("Save
  and test"), the same test as the Test button on Storage. The page says "Saved and connected", or
  what failed (credential, location, reachability, or an allowed folder with no files) with a link
  to edit the connection. The connection stays saved either way (UX-07 in #2086).
- A start-up skips the skills adopt walk when the latest `skills` row of `storage_migration_runs` is clean, has `proof_version` 2, `legacy_rows` 0 and `mismatches` 0, and logs `skills adopt skipped: the latest pass left no old skill forms`; a pass that left anything, or failed a workspace, still runs on the next start-up. A pass that does run reads each skill's pending delete by name instead of listing every skill, and counts a workspace that failed twice as one failed workspace. Migration 0094 adds a partial index of the pending `files` rows, so counting a workspace's pending uploads no longer reads its ready rows; it is a plain `CREATE INDEX`, so it holds writes to `files` while it scans the table once.
- **Breaking:** `db:migrate` refuses with `legacy_storage_rows_remain` unless the latest `adopt` and `skills` rows of `storage_migration_runs` were written by the release after 0.6.11 (`proof_version` 2), are clean and have `legacy_rows` 0, so that release is a required upgrade stop (0.6.10 or 0.6.11 → the release after 0.6.11 → this one). A fresh install upgrades with no step. The self-hosting guide lists the three starts that release needs, and one remedy for each cause that keeps `legacy_rows` above 0: `skipped_ownerless` (give the workspace an owner or remove its old objects), `skipped_path_taken` (another file holds the path: download or remove the old object), `skipped_failed` (start again and read the warn lines) and a skill whose delete is pending (its owner retries `DELETE /api/skills/<name>`). Nothing is deleted or rewritten while it refuses. After the check, a file row and a session-state blob row must name an object id (`files_file_has_object_id`, `session_state_blobs.object_id NOT NULL`).
- The Agent Store's origin may also call `GET /api/runs` with a session an email link minted, so
  the store's `/runs` page lists a visitor's own demo runs from the visitor's browser. The guest
  role's rights are unchanged: a visitor reads only the runs they started in their own demo
  workspace.
- The Agent Store app's `/runs`, `/runs/:id`, `/chat` and `/files` read the platform as the
  signed-in visitor's own session, on their own demo workspace, and say so when the visitor is
  not signed in or the demo has ended.
- `web` exits with status 1 when its start fails, instead of listening and answering 500 to every
  request. An invalid `AW_DEPLOYMENT_POLICY`, `AW_DEPLOYMENT_FEATURES`, `AW_TRUSTED_PROXY_HOPS` or
  `AW_CONTAINER_IDLE_STOP_SECONDS` is the usual cause: the log line names every refused variable at
  once, so one restart fixes them all. A container platform now shows the server as crashed or
  restarting, with the reason in its log. A missing `SESSION_SECRET` or an unreachable database
  still starts and answers 503 with the reason. `startWeb` (the embedded workspace) rejects with
  the error instead of exiting its caller's process.
- The gateway's start-up log lists every refused variable in full. Before, the list was cut at 200
  characters, so with three or more invalid settings the later ones were missing.
- Web stops at start-up, exiting with status 1 and logging each refused variable and the value it
  expects, when `AW_TRUSTED_PROXY_HOPS` is not `0` to `16` or `AW_CONTAINER_IDLE_STOP_SECONDS` is not
  whole seconds above 15. Before, a malformed proxy count was silently read as "no proxy", so
  every visitor shared one rate-limit bucket and runnable public links refused to run, and a
  malformed idle stop meant no run limit, so a Cloudflare Container could stop in the middle of a
  run. Unset values and `0` for the proxy count work as before.

### Removed

- **Breaking (run protocol):** the runner refuses a `/run` body that carries inline `contentBase64` file or skill-file contents (400 `invalid_run_request`). Files and skills are named by reference only (`size`, `sha256`). Web servers older than 0.6.10 cannot drive runners from this release.
- **Breaking:** files, skills, chat attachments and run delivery read and write only through the catalog service. The code paths that read and wrote one object store per area (the files tree, the skills prefix, the attachments root and the run output copy) are gone, so a deployment whose catalog service cannot start answers `503` (`files_runtime_not_configured`, `skills_runtime_not_configured`) instead of serving files from the area root. Skills written as a bare object prefix are still read, and are moved into rows on their first change. With `AW_STORAGE_URL` set to a supported `s3://`, `gcs://`, `azblob://` or `file://` URL nothing changes.
- **Breaking:** the old storage settings no longer say where files, skills and session state are kept: `AW_FILE_STORAGE_ROOT`, `AW_SKILL_STORAGE_ROOT`, `AW_SESSION_TRANSCRIPT_ROOT`, `OBJECT_STORAGE_BUCKET`, `OBJECT_STORAGE_BACKEND`, `OBJECT_STORAGE_ENDPOINT`, `OBJECT_STORAGE_PUBLIC_ENDPOINT` and `OBJECT_STORAGE_FORCE_PATH_STYLE`. `AW_STORAGE_URL` alone does. A leftover old variable never stops start-up: the server, `agent-workspace doctor`, `aw dev` and the `vercel` and `cloudflare` deploy commands log one `storage_setting_ignored` warning that names it, never its value. With `AW_STORAGE_URL` unset nothing is read from the old location: the files, skills and session-state APIs stay uninstalled and answer 503, `aw dev` keeps storage off rather than choose a folder, `agent-workspace doctor` fails and prints the `AW_STORAGE_URL=` line that points at the old location, and `deploy` refuses a Vercel or Cloudflare apply. Neither deploy command pushes an old storage variable to the platform project. Set `AW_STORAGE_URL` (for example `file:///var/lib/agent-workspace`) before you upgrade.
- **Breaking:** the repository `compose.yaml` and a generated Compose project refuse to start without `AW_STORAGE_URL` in `.env`. `.env.example` and `create` write the bundled SeaweedFS as `AW_STORAGE_URL=s3://agent-workspace?endpoint=http://seaweedfs:8333&publicEndpoint=http://localhost:8333&pathStyle=true`, the bucket, endpoint and path style the old settings gave it, so its objects stay where they are. A generated project's `.env` also needs `AW_STORAGE_CREATE_BUCKET=true` for that store.
- New in `@indx-workspace/contracts/storage-settings`: `IGNORED_STORAGE_VARIABLES`, `ignoredStorageVariables(env)` and `ignoredStorageSettingsWarning(env)`. Every export the old settings had stays as a deprecated shim until the next major release.
- The provisional adapter-side budget caps of the OpenAI Agents, Mastra and pi engines (ADR-0074 D7,
  #342) are retired, as ADR-0162 decides: `limits.maxBudgetUsd` is enforced by the gateway for every
  engine. The adapters no longer price usage, stop a run `max_budget` or refuse a cap on a model
  their price table did not list; such a run now starts. `@agent-workspace/engine` no longer exports
  `provisionalBudget`, `subagentBudgetRefusal`, `provisionalPriceFor`, `PROVISIONAL_MODEL_PRICES` or
  `PROVISIONAL_PRICES_CHECKED_ON`.
- The `adopt`, `copy`, `copy-dry-run` and `finalize` stages of the move off the old object naming. They ran on the release after 0.6.11, which this release requires as an upgrade stop. `AW_STORAGE_MIGRATE=off` still turns off the skills adopt pass; any other value runs it.
- The server no longer reads the old object naming: the catalog service opens, signs, renames and deletes a file or a session-state blob only by its object id, the old per-area session-state blob store is gone, and the storage cleanup lists only the new naming. Its report and `GET /api/cron/storage-cleanup` no longer carry `legacyOrphans`. The upgrade guard of this release proves no row needs the old naming; an old object left in the bucket is never read or removed.

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
- The Administration menu now shows Models, Storage, Users, API Keys and Runtimes only to Owners
  and Admins; a Builder or Viewer saw them before, and each answered "not allowed". Settings and
  Shared links stay for everyone, and Settings shows its subsystem status only to Owners and
  Admins. The runtime chip links to Runtimes only for them (UX-12 in #2086).
- The New Agent form numbers its steps 1 to 5 in the order they appear; it showed Step 5, 3, 4.
  Every model picker lists each model once, even when two model connections offer it, and asks
  which connection to use only when more than one offers the chosen model (UX-22 in #2086).
- The Builder's approval card lists each change in words ("Write files: Not allowed → Allowed",
  "Connector: crm — Added", "Skill version: memo — 3 → 4", "Code tool pdf may reach:
  example.com") instead of field paths; the exact fields stay one click away under "Show the exact
  fields". The definition preview's "changed" labels use the same words, and its
  sections are no longer numbered "Step 5, Step 3, Step 4".
- While the Builder waits for approval of a save, the definition preview no longer reports "The last
  check failed: unreadable_result": the call the run paused on has no answer until the decision.
- A refused check, a refused decision, an unreadable tool answer and an unavailable Builder are
  explained in a sentence, with the code kept small for support.
- An evaluation now interrupts, and waits for the interrupt of, a case run that is paused for an approval, abandoned at the deadline, or whose event stream cannot be read, before it answers. Under the Builder's trial limits an evaluation that cannot stop a case run answers a typed `trial_not_stopped` refusal and stores no row; `POST /api/agents/{id}/evaluations` keeps storing the row and logs the failure.
- Evaluation log lines for a failed interrupt, judge call or stream read name the error class only and no longer carry the error's message.
- A Builder `trial_run` whose run fails after it started now interrupts that run by id before the failure propagates, so it cannot keep spending under the full policy budget.
- `evals_run` runs each case under the policy's trial budget, as `trial_run` does, and starts nothing when the run API cannot interrupt a run.
- The Builder's log line for a failed trial interrupt carries the error class and a system code such as `ECONNRESET`, never the message.
- A run on the claude-agent-sdk engine that asks for structured output with a schema naming its
  draft 2020-12 `$schema` (as `z.toJSONSchema` writes it) no longer fails before the model is
  asked: the engine hands Claude Code the schema without that reference, which its validator
  cannot resolve.
- A claude-agent-sdk run now ends at most 5 seconds after its `result`, even when the SDK's stream
  stays open after it: the boundary aborts the SDK and its CLI, and the run ends with the result it
  reached. Before, a CLI that lingered held the run open until its credential expired. Issue #2076
  found the reported failure (an app-connector `tools/call` refused `ECONNREFUSED` under `aw dev`
  after `tools/list` succeeded, then a run that did not end) to be a harness artefact, not a
  platform bug. A journeys harness that ran Playwright with `spawnSync` blocked the process that
  serves the scripted model. The run's model request was answered only after Playwright returned,
  as the harness stopped `aw dev`, so the tool call reached an app that had stopped. The apps lane
  runs Playwright without blocking (`attemptAsync`), and a lane test now keeps every synchronous
  call out of the journeys step. With that fixed, the lane showed why triage still left the ticket
  as it was. A recipe step's run asserts its person as an API-key subject, which holds no role, so
  the service-desk `ticket`'s `member` rules refused it with `resource_not_found`. The reference
  app's `ticket` now also admits its `requester` on read and update, and triage moves the ticket
  to `in_progress` under `aw dev`.
- A code-tool sandbox on Cloud Run now opens: the runner manager points the tool host at
  `/tmp/tool-host` (Cloud Run mounts no `/workspace`, which the tool-host image's user cannot
  create), and the tool host creates its directory before it takes a file. Before, every
  `PUT /files/manifest.json` failed with HTTP 500 and the manager answered
  `503 tool_sandbox_unavailable`. The manager now also logs the reason of such a 503.
- New chat: an empty "+ Files" or "+ Connectors" picker now says that the agent's items are not
  listed yet and that the agent still uses all of them, and "Upload" and "Manage agents" link to the
  Files and Agents screens instead of being disabled (#2089).
- MCP connector Test Connection now sends every request through the egress policy, accepts CRLF and CR line endings on SSE streams, and reports JSON-RPC error codes outside the protocol range as server refusals instead of "not an MCP server".
- Console keyboard use (UX-23 in #2086): every signed-in console screen starts with a "Skip to
  content" link that moves focus to the page (New Agent's Builder chat now has exactly one main
  region while it loads, fails or chats, so the link always lands there); the home chat box shows
  when it has focus; Esc closes the Agent, Files and Connectors pickers; Enter sends in the home
  chat (Shift+Enter adds a new line). Enter no longer sends while Japanese input is still being
  converted, in the home chat or a run's follow-up box.
- The Files screen's Modified column shows the time in the viewer's own time zone and language,
  with the zone named (for example `2026年11月9日 10:01 JST`), instead of UTC, and says its language
  to a screen reader (UX-15 in #2086).
- On a phone, the console menu now folds behind a Menu button, so a page starts at the top of the
  screen instead of below the whole menu. Esc closes the menu, and following a link closes it.
- On a phone, the Agents page no longer scrolls sideways, and the Japanese "show archived" label
  stays on one line (UX-10 in #2086).
- When an agent cannot run because setup is not finished, the words "setup wizard" in the composer
  and in the failed run's message are now a link to the setup wizard (UX-25 in #2086).
- Console screens no longer use internal terms: the Runs page, the workspace default model card,
  the storage "Allow writing" note, the run detail page and two runtime descriptions now say what
  they mean in plain words (UX-13 in #2086).
- The Builder looks a run's caller up by principal instead of scanning the workspace's member list
  on every tool call, and an API key bound to a Builder endpoint client no longer fails the whole
  key listing: it is listed and refused at authentication.
- A disabled button now looks disabled (faded, with a not-allowed cursor) on every screen that uses
  the shared button styles, such as "Add schedule" before the form is filled in.
- The API Keys form wraps at phone width, so the page no longer scrolls sideways at 390 px.
- The release images build again: `*.test-support.ts` files, which import test helpers from the
  repository's `tests/` folder, are left out of the Docker build context like `*.test.ts` files,
  so the web build in the image no longer fails with `TS2307`.
- `aw push`, `aw check` and the first sync of `aw dev` accept an agent that names a built-in skill
  (`office-reader`) the workspace has not installed yet. Their dry run refused it with
  `422 agent_definition_references_missing [skill:office-reader]`, although the save installs the
  built-in before it checks the body. A dry run now answers what the save would; it still installs
  nothing (#890).
- Evaluation scoring reads the whole turn. `contains`, `notContains` and `judge` see the assistant
  text of every message in the run, not only the last one, and `tool` and `toolInput` are satisfied
  only by a tool call that completed without an error (a call the tool refused or that failed no
  longer counts). The judge's verdict is the last JSON object of its reply and the last thing in it;
  a reply that only quotes a verdict, or has text or another object after it, fails the case closed.
- Settings → Features: a switch that cannot be turned off says "Switch off Surfaces first" instead
  of repeating the row's "Needed by: Surfaces" line (UX-21 in #2086).
- Files: a link to a folder that no longer exists, or to a file, now says so instead of "This folder
  is empty.", and an empty (0-byte) file is reported as not uploaded instead of being skipped in
  silence (UX-19 and UX-20 in #2086).
- Files: when a rename, move or delete is refused, or a delete stops part-way, the reason now stays
  on screen after the list reloads instead of disappearing at once (#2088). If the list cannot be
  read again after it, the message says the list may be out of date.
- On a phone, a short file or folder name in the Files table, such as a Japanese one, no longer
  breaks into one character per line.
- With Files switched off, New chat and the Builder chat no longer offer "+ Files" or "Attach
  file". The switched-off page tells an Owner "You can switch it on in Settings → Features" with the
  link; anyone else is told which Owner to ask (UX-21 in #2086).
- An agent with Write files on can no longer write `CLAUDE.md`, `.claude/`, or `.mcp.json` in its workspace without approval, since Claude Code loads them as instructions on later runs. The skills editor now quotes YAML frontmatter values, so editing a skill whose description holds a colon no longer breaks it. `agent-workspace start` and `stop` no longer print a malformed `.env` line, which may hold a secret; they name its line number. Blueprint archives with non-ASCII paths are no longer refused. A bad `PORT` is refused, and a failed listen closes Next and the database pools (#2283).
- OpenAI and Azure OpenAI model connections: tool-using turns no longer fail on strict-schema
  validation, cached input tokens are no longer charged twice, and a failed or truncated stream
  records the tokens it spent (or stays unmeasured) instead of settling as $0 (#2283).
- Azure OpenAI connections with a dated `apiVersion` now count tokens through
  `/responses/input_tokens` instead of making a billed Responses call, and a provider without
  token counting answers a typed 501 rather than a 500 (#2283).
- On Google Cloud Run without a custom domain, `aw deploy` now reports the web app at the URL the
  app itself uses for sign-in, `https://<name>-web-<project number>.<region>.run.app`. Before, the
  `web:` line and the `web_url` output showed the service's other address (`…a.run.app`), so an
  operator who registered `<web>/api/auth/callback` with their OIDC provider got
  `redirect_uri_mismatch` at sign-in. When single sign-on is configured, `aw deploy` now also
  prints the exact redirect URI to register.
- The caller-identity guide, five tutorials and the gallery project files told you to create a
  connector's identity secret with `aw secrets set`, a command `aw` does not have. They now use
  `aw secrets create --name <NAME> --value-stdin` (and `aw secrets replace <NAME> --value-stdin`
  to rotate it).
- Setting, promoting or rolling back a pointer, and the Builder's `draft_save`, now answer 409 `agent_archived` when the agent is archived between the request's read and the pointer move; before, that move applied to an archived agent. The check now runs on the locked agent row.
- A public agent share link no longer shows a visitor a box with only `null` in it. A share with
  nothing but its name says so in words, and a published agent definition shows its instructions
  and what it needs instead of raw JSON (#2087).
- Approving or rejecting a paused run now works when an Owner or Admin decides another member's run, and when the run had file attachments; the continuation no longer fails with `session_not_usable` or `run_file_scope_not_granted` after the decision is consumed.
- A run paused for approval is now cancelled with `approval_expired` once its 24 hour deadline passes, so an approval-gated trigger no longer stays blocked by undecided runs.
- An `Idempotency-Key` used on an agent-team run route is no longer treated as a replay of a run started on another team or on the lead agent directly.
- A run start refused after its new session was opened no longer leaves an empty session behind.
- A run's Technical details, its error and the call it is waiting to have approved no longer show
  the folder the run works in on the runtime's host, such as `/srv/runner-ws/<ids>/…`; it reads
  `<workspace>`, and a path inside it keeps its relative part: `<workspace>/outputs/report.md`.
  Runs recorded before this change are shown the same way (UX-02 in #2086).
- `POST /api/runs/:id/interrupt` now stops the runtime within about one cancellation-watch interval
  (2 s) whichever replica serves it. Before, an interrupt served by a replica that did not hold the
  run's stream made the run `cancelled` and revoked its tokens, but the runtime kept running until
  its credential-bounded lifetime ended. The replica holding the run now reads the committed status
  and interrupts its runtime (ADR-0151-FU-1440 D1, issue #261). No migration.
- A run started under a lower-only limits override (a Builder trial's budget, for one) now keeps it
  across an approval continuation: the override is stored on the run (`runs.limits_override`, a
  nullable column added by migration 0101) and the continuation reads it back, where before it fell
  back to the agent's full policy budget. A lower policy budget still wins.
- The daily cost cap now counts a run whose usage settlement failed as unpriced even when it wrote
  no ledger row that day, so a settlement failure can no longer leave a workspace looking under its
  cap. Two indexes (`run_usage_records (workspace_id, created_at)` and a partial index on the audit
  log's agent restore rows) keep the cap's window sum and the archive sweep's restore lookup off
  full scans.
- A tool call the agent's permissions refused, with nobody asked, is now said in the chat: "Did not
  run: Bash". Before, the run ended Completed and the answer could read as if the command had
  worked; the refusal was only in Show technical details. What Run commands allows is unchanged
  (part of #2091).
- A run no longer fails with "The runtime stream ended unexpectedly" when a tool reads a binary
  file (NUL characters) or its output is cut inside an emoji; the unstorable characters become
  U+FFFD. Shell output no longer turns a multi-byte character split across two reads into U+FFFD,
  and an evaluation judge's reason can no longer lose the evaluation the same way (#2283).
- Files, Skills, a skill, Connectors, New connector, API Keys and Settings now have a `<main>`
  landmark and the same page margin as the other screens, instead of sitting flush against the
  sidebar (UX-24 in #2086).
- A person who opens Storage, a storage connection, Connect storage or Runtimes without the role
  for it now sees the screen's heading and the refusal inside the page's `<main>` landmark, with
  the same margin, instead of a bare line of text.
- Share dialog: "Copy link" now copies the full link (`https://…/p/…`) instead of a path that opens
  nothing once pasted, and the button says "Share" for the choices that make no link (UX-09 in
  #2086).
- Share dialog: a second click while a share is being made no longer publishes a second link; the
  button waits until the first answer.
- A file audit row is written once per event even when its write is retried: each row carries an
  audit key (the stored object for an upload, the file for a delete, the request for a download,
  link or move), and a retried upload completion records an upload whose first audit write failed.
  Every download request, a `Range` request included, stays its own `file-downloaded` row.
- Browsing, testing or running with a storage connection whose credential was stored by 0.6.11 or
  earlier no longer rewrites it into the target-bound form, which locked undrained older revisions
  out of the connection. The read binds it to the connection's current URL in memory only, and
  still refuses it for a URL the connection no longer has; only creating, editing or rotating the
  connection writes the bound form, as the self-hosting guide says.
- Azure and S3 storage connections go through the outbound proxy the server's environment names
  (`HTTPS_PROXY`, `HTTP_PROXY`, `NO_PROXY`), tunnelled with `CONNECT`, instead of connecting
  directly. The egress check still runs on the endpoint's name and resolved addresses first, so a
  private, link-local or plaintext endpoint is refused with `storage_connection_endpoint_forbidden`
  and never reaches the proxy. Without a proxy, or for a `NO_PROXY` host, the connection stays
  pinned to the addresses the check saw. GCS connections already followed these variables.
- Browsing or testing a `file://` storage connection maps the folder's own failures explicitly: a path outside the folder is `storage_connection_endpoint_forbidden` (a test answers `forbidden`), and an I/O failure or the listing's walk cap is `storage_connection_unreachable`. Each is logged as a warning with its reason code only; the whole error, whose message names the customer's key, is no longer logged as unclassified. A run that cannot list a granted folder names the same class (#1835).
- A `file://` storage connection's conditional writes hold across processes: a write's precondition and its rename, and a delete, take a lock file in the folder, so two replicas writing the same file over a shared mount can no longer both pass `ifMatch` and lose one of the writes. A lock left by a process that died is broken after 10 seconds (#1835).
- A `file://` storage connection checks a write's `ifMatch` against the file in the folder the write opened, not whatever the key resolves to from the root when the check runs, so a folder renamed inside the root during a write can no longer pass another file's etag (#1835).
- A `file://` storage connection's listing carries one walk from page to page, so a run's delivery reads each folder once and logs what it skipped once, and a walk that examines more than 200,000 directory entries stops with a typed `FolderWalkLimitError` instead of reading a huge folder to the end (#1835).
- Pointing `local` back at an older agent version binds the storage connections that version was
  deployed with, by connection id. After a connection was deleted and recreated under the same
  name, the move used to bind the new connection to the old version, so the new connection could
  not be deleted although the version could not run.
- Migration 0102 gives a version materialised during the upgrade window (by a server older than
  per-version storage grants) the grants its agent holds, so it no longer fails closed with
  `run_storage_grant_unavailable`. It never binds a connection created after the version.
- A run lists each granted storage-connection folder once per launch instead of twice; the input
  archive and the `/run` body share one listing.
- Connect storage: a name the server would refuse (capitals, spaces, underscores, a leading digit,
  or an ID-shaped name) is now caught before saving, with what a name may contain, instead of "The
  storage connection could not be saved." (UX-08 in #2086).
- `ObjectStore.read` and `write` take an abort `signal`, and every store passes it to its SDK where it takes one (S3 GetObject and the multipart upload, Azure download and upload, the GCS media stream and upload) and errors the body with it everywhere else. A storage write-back passes its save signal to the connection's open, each read and each write, so at the deadline or a cancel a hung provider call is stopped rather than left holding the session until the sweep (#1835, STO-509).
- A Cloud Run service or Azure Container Apps session that fails to start is now reported with
  its failed clean-up, so a billed leftover is no longer silent; a run's tool sandbox that cannot
  be released is logged (#2283).
- Google Cloud Storage reads keep a gzip-encoded object's stored bytes, so delivering one no
  longer fails with "changed size"; Azure Blob Storage no longer reads a missing container as a
  missing file; a SeaweedFS listing continues past a key that contains a colon (#2283).
- The recipe routes log an Agent Workspace failure behind a 502, and recipes check
  `AW_APP_API_KEY` the way agent tools do (#2283).
- Testing a storage connection now looks into every allowed folder, not only the first. The
  console says which folders have no files instead of a plain "Connection OK".
- A trigger whose run fails to start now logs it when freeing the delivery claim fails too, and a schedule slot whose claim has no run is no longer marked fired.
- A whitespace-only `CRON_SECRET` is read as unset by every cron driver, so the in-process schedulers start instead of neither driver running.
- A passphrase-protected public share link verifies the passphrase off the event loop and refuses further guesses (429 `passphrase_attempts_limited`) after 10 wrong ones a minute per link and 5 per visitor.
- Emptying a schedule's Time zone no longer replaces the Schedules tab with an error page; the form
  says "Enter a time zone, for example Asia/Tokyo." and waits (UX-18 in #2086).
- A screen reader reads the console's English screens in English again for a Japanese browser: the
  page stays `lang="en"`, and each translated part (the sidebar, the top bar, the skip link, the
  runtime band, a run's files, Files search and the Modified column) says `lang="ja"` itself
  (UX-15 in #2086).
- When an upload batch ends after the person opened another folder, the folder on screen is the one
  refreshed, not the folder the batch started in (UX-16 in #2086).
- Closing a schedule's Change time form (Cancel, Escape or Save) or the delete question (Keep or
  Escape) puts the keyboard focus back on the button that opened it.
- An agent with **Write files** on can now write files in its workspace. Claude Code asked before
  every `Write` and `Edit`, nobody could answer, so each write was refused ("Did not run: Write"),
  and an agent's memory file was never saved. The switch now allows edits inside the workspace. A
  read-only file grant still keeps its files read-only, a write outside the workspace is still
  refused, and a stored approval rule on `Write` or `Edit` still asks first.

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
- A draft that names `aw-control` in any case or with surrounding space is refused as the reserved
  connector, and a write that was already journaled is no longer replayed once the workspace has
  switched the Builder off.
- The Builder's run-token door logs the error class, never its message, when it fails closed.
- The Builder's run-token door (`POST /api/builder/mcp`) limits each run to 120 requests a minute
  (`429 builder_rate_limited` with `Retry-After`) and refuses a write or spend tool call that
  carries no engine tool-use id (`invalid_arguments`) instead of minting one.
- A credential that cannot read agents (a scoped API key or browser token) now gets the `404
  agent_not_found` of a missing agent, not `403 builtin_agent_read_only`, for a write to the
  built-in Builder agent.
- On the `gcp-cloudrun` target the runner manager may invoke only sandbox services: its invoke grant
  is now conditioned on the request's host (`rt-….run.app`) instead of the service name, which Cloud
  Run does not check when a service is invoked. The runner manager also refuses to call an agent
  sandbox whose URL is not an `https://rt-….run.app` address.
- `SESSION_SECRET` no longer signs six things directly. The session, workspace-selection and
  invitation cookies, the OIDC sign-in transaction, CLI device codes and the public-share visitor
  key each use their own key, derived from the secret with HKDF, so a token signed for one can never
  be accepted as another. Nobody is signed out by the upgrade: tokens signed the old way are still
  accepted until they expire (at most 12 hours). Refactoring part 06 step 5.
- A code tool can no longer declare a model connection, runtime connection or webhook signing secret, and an upper-case membership or secret id no longer skips the Owner and reserved-secret guards.
- A public share link is shown once, when it is published, and only the SHA-256 of its token is
  stored. Migration `0105` clears every stored plain token; existing links keep working because
  they are already looked up by hash. The publish dialog now says the link won't be shown again.
  The plain `token` column stays, nullable, for one release so a web process from the previous
  release can still publish during a rolling update; the next release drops it.
- Public share links are looked up by the SHA-256 of their token, stored in a new `shares.token_hash`
  column, the way API keys and other bearer tokens already are. PostgreSQL fills the column for
  every existing link, so links made before the upgrade keep working. The plain token is still
  stored for now, because the share list shows each public link again; a follow-up removes it once
  a link is shown only when it is created.
- On Windows, a `file://` storage connection refuses a key that NTFS would read as another name or a device: an alternate data stream (`a.txt:s`, `a.txt::$DATA`), a trailing dot or space, a device name such as `nul` or `con.txt`, or a Win32 wildcard character. Such names are left out of listings, and a write no longer tries to flush the folder, which Windows cannot do (#1835).
- A session signed in by email link is now marked, and `POST /api/auth/workspace` refuses to switch
  it to any workspace but its own demo workspace (404 `workspace_not_available`), even if the same
  address later joins a real workspace through the identity provider.
- The per-address limit on sign-in links is now atomic: concurrent requests for one address from
  different clients can no longer exceed it.
- A webhook's signing secret (`WEBHOOK_<id>_SIGNING_SECRET`, issue #250) is platform-owned, like a
  storage connection's secret: a run's tools, connectors and tool endpoints never receive it, and
  `/api/secrets` refuses to create or replace a secret with that exact name (`409`); deleting it is
  still allowed. Other names such as `WEBHOOK_STRIPE_SIGNING_SECRET` stay ordinary secrets. A
  delivery attempt that fails inside the platform (an unreadable secret or run) now counts as a
  failed attempt and ends `failed` after the usual 8 attempts instead of being claimed forever.

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
