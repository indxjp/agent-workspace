# ADR-0160 — Features are switched off per deployment and workspace

Status: accepted
Date: 2026-10-28
Decided by: Owner (agent-portal plan F-1), ratified 2026-10-28
Scope: spec §3, §44; `packages/contracts/src/{features,routes,project-file,setup}.ts`; apps/web route guards and console navigation

## Context

Agent portal plan item F-1 (#1476), unit U2.1, lets an operator leave features out of a deployment and lets a workspace Owner switch an installed
feature off. Two recorded invariants stand in the way:

- Spec §3 "What the Platform Must Manage" lists a _minimum_ product surface.
- Spec §44 "Main Navigation" prints the sidebar as a literal block, and
  `apps/web/components/shell/navigation.ts` says "Adding an entry here is a §38/§43 change and needs
  the spec changed first".

Both must allow **subtraction** before any code lands. Every later F-1 issue (R-F1, R-F2, U2.3,
U2.4a–d) implements what this record decides, so it settles the id list, the route mapping and the
problem codes exactly.

Three facts from the code shape the decision:

- **The console chat starts runs.** `apps/web/components/composer/home-chat.tsx` imports
  `startAgentRunForSession` and `followRunEvents` from `../run/live`, so chat calls
  `POST /api/agents/:id/runs` and `GET /api/runs/:id/events`. Surfaces, triggers, evaluations and
  project sessions start runs the same way. Run execution therefore cannot belong to a switchable
  feature.
- **Some features have no sidebar entry.** Evaluations, triggers and surfaces have routes only
  (`navigation.ts`).
- **The Agent Builder needs a switch.** The Agent Builder design (#1842) says every Builder phase ships behind a per-workspace switch, and that the Builder
  registers the feature id `builder` in this switch and builds no second one (#1846 slice 3). Today
  production composition keeps the Builder dark with a fixed stub
  (`apps/web/server/builder/transport/composition.ts`, `feature: { enabled: () => Promise.resolve(false) }`).

## Decision

**D1 Ids.** A closed enum in `@indx-workspace/contracts/features`:

```ts
FEATURE_IDS = [
  'chat',
  'projects',
  'files',
  'skills',
  'connectors',
  'runs',
  'sharing',
  'surfaces',
  'triggers',
  'evaluations',
  'builder',
];
```

`builder` is last because it was added for the Agent Builder (#1846 slice 3), which registers its
id here instead of building a second switch. A route or nav entry outside every feature is tagged
`core`. `core` is always on and is not a `FeatureId`. It covers identity, workspaces, team, API
keys, endpoint clients, models, runtimes, storage connections, secrets, agents, agent versions,
tool bundles, **run execution**, audit, engines, platforms, A2A and OAuth. The word is _feature_,
not _module_; "module" already names the feature-owned frontend folders of RF-503.

**D2 `runs` is the run-history surface, not run execution.** Starting, reading, following,
interrupting, approving and revoking a run are `core`, because chat, surfaces, triggers,
evaluations, project sessions and the Builder all start runs. The `runs` feature is
`GET /api/runs`, `POST /api/runs/:id/feedback`, `GET /api/agents/:id/feedback`, `GET /api/metrics`
and the Runs nav entry.

**D3 Dependencies.** `FEATURE_DEPENDENCIES = { surfaces: ['chat'], triggers: ['runs'], evaluations: ['runs'] }`.
There are no other edges; `builder` has none. The graph is acyclic.

**D4 Route mapping.** Every `METHOD path` in `API_ROUTES` and every `API_ROUTE_EXCLUSIONS` entry
(`packages/contracts/src/routes.ts`) carries exactly one feature id, or `core`. On origin/main at
the time of writing that is 150 catalogued routes and 35 exclusions: 66 in a feature, 119 `core`.

| Feature       | Routes                                                                                                                                                 | Nav entry                                               |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------- |
| `chat`        | `GET /api/sessions`; `GET`, `PATCH /api/sessions/:engineSessionId`; `GET …/transcript`; `GET …/subkeys`                                                | `home`                                                  |
| `projects`    | `/api/projects/**`; `POST /mcp/projects/:name` and its exclusion `GET /.well-known/oauth-protected-resource/mcp/projects/:name`                        | `projects`                                              |
| `files`       | `/api/files/**`; exclusion `GET /api/sessions/:engineSessionId/file-search` (runner-private)                                                           | `files`                                                 |
| `skills`      | `/api/skills/**`                                                                                                                                       | `skills`                                                |
| `connectors`  | `/api/connectors/**`                                                                                                                                   | `connectors`                                            |
| `runs`        | as in D2                                                                                                                                               | `runs`                                                  |
| `sharing`     | `/api/shares/**`; `GET`, `PATCH /api/sharing-policies`; exclusions `GET /p/:token` and `POST /p/:token/messages`                                       | `shares`                                                |
| `surfaces`    | the four `/p/s/:name/**` exclusions                                                                                                                    | none                                                    |
| `triggers`    | `/api/triggers/**`; exclusion `GET /api/cron/triggers`                                                                                                 | none                                                    |
| `evaluations` | `POST /api/agents/:id/evaluations`; `GET`, `POST /api/agents/:id/evaluation-runs`; `POST /api/agents/:id/evaluation-advance`                           | none                                                    |
| `builder`     | `POST /mcp/builder` and its exclusion `GET /.well-known/oauth-protected-resource/mcp/builder`; exclusion `POST /api/builder/mcp` (the run-caller door) | none                                                    |
| `core`        | everything else                                                                                                                                        | `agents` and every Administration entry except `shares` |

`builder` has no nav entry: its chat mode lives on `/agents/new`, which stays `core` (see D8).

Assignments that are not obvious from the path:

- `/api/storage-connections/**` and `GET /api/cron/storage-cleanup` are `core`: deployment storage
  infrastructure, like runtimes.
- `POST /api/agents/:id/restore` is `core`: agent lifecycle.
- `POST /api/sessions/:engineSessionId/attachments` is `core`, not `surfaces`: a surface visitor
  uses it, but so does the console composer's Attach button
  (`apps/web/components/run/attach-control.tsx`; `apps/web/server/surfaces/public/attachments.ts`).
- `POST /api/runs/:id/approval` is `core`: run execution (D2); a paused run must be resumable
  whichever feature started it.
- The other runner-private session routes (`…/transcript` writes, `…/state-entries`,
  `…/state-streams`, `…/state-blobs`) are `core`: the runner calls them for every run.
- `POST /api/projects/:id/sessions` is `projects`: it starts a session only a project offers, and
  the run it starts goes through the `core` run routes.
- `POST /api/triggers/:id/fire/:secret` is `triggers`: it fires a trigger, so it has no meaning
  while triggers are off.
- `GET /api/sharing-policies` and `PATCH /api/sharing-policies` are `sharing`: they configure only
  what share links may publish.
- `GET /api/sessions/:engineSessionId/file-search` is `files`: it searches workspace files for a
  running agent.
- `GET /api/agents/:id/feedback` is `runs`: it reads feedback left on run history.
- `/api/auth/**`, `/oauth/**`, `GET /.well-known/oauth-authorization-server`, `POST /api/setup`,
  `GET /api/readyz` and `GET /api/cron/retention` are `core`: sign-in, setup and platform jobs.
- `POST /api/agents/:id/platform-exports` and `…/platform-archives` are `core` (platforms).

**D5 Deployment level.** An optional `features: FeatureId[]` in the project file (ADR-0103):

- absent means all on;
- present means exactly those features are installed;
- it is refused when it is empty, has duplicates, or lists a feature without its D3 dependency.

It reaches the control plane as `AW_DEPLOYMENT_FEATURES` (comma-separated ids), the same way
`policy` travels as `AW_DEPLOYMENT_POLICY` (`apps/web/server/composition/config.ts`). An unset or
blank variable means all on, and an invalid one stops start-up. `builder` follows the same rule as
every feature: it is installed when `features:` is absent or lists it.

**D6 Workspace level.** An Owner may switch off any installed feature for one workspace, and switch
it back on. A feature the deployment does not install can never be switched on. In storage, a row
in `workspace_features` means "off"; no row means on. So `builder` is on for a workspace when the
deployment installs it and no `workspace_features` row says off. Until #1846 slice 3 lands,
production composition keeps the Builder dark with the existing `enabled=false` stub, so turning on
the switch mechanism exposes nothing new.

**D7 Refusals.**

- A route whose feature is off answers `404 feature_disabled`, `details: [<featureId>]`, in the
  ADR-0075 envelope. It is 404, not 403, because for this caller the route does not exist. That
  matches the edge's `404 not_found` for an unserved path (`apps/web/proxy.ts`).
- **Deployment-level** refusals are answered at the edge, before authentication, because they
  reveal nothing beyond what the deployment serves.
- **Workspace-level** refusals are answered only after the route's own credential is verified,
  because only then is the workspace known. For a console or API route that credential makes the
  caller a member of the workspace, and the check runs before any other row is read. Some switchable
  routes are reached with other credentials: the trigger secret
  (`POST /api/triggers/:id/fire/:secret`), a per-run token (the runner's
  `GET /api/sessions/:engineSessionId/file-search`, and the Builder's run-caller door
  `POST /api/builder/mcp`), and an endpoint client or OAuth token (`POST /mcp/projects/:name`,
  `POST /mcp/builder`). For these the check runs right after that credential is verified, and a
  switched-off feature answers `404 feature_disabled`. The workspace checked is the one the
  verified credential is bound to (the token's claims, the identified principal's workspace, or
  the trigger row whose secret matched), never one resolved from a path segment such as `:name`
  or `:engineSessionId`. So the answer tells the holder only about its own workspace. On the
  run-caller door the check runs once the run token verifies and before the caller check, so a
  verified run with no person behind it also gets `feature_disabled`. On `fire` it runs only
  after the full secret check; a credential that fails verification keeps the route's own
  refusal, so an unknown trigger, a wrong secret, a disabled trigger and a schedule trigger still
  answer as before.
- Share and surface pages (`/p/**`) are reached anonymously. When `sharing` or `surfaces` is off
  they answer the page's existing not-found (concealment), never `feature_disabled`, so a visitor
  learns neither the workspace's switch state nor whether the share or surface exists.
- The anonymous discovery documents (`/.well-known/oauth-protected-resource/mcp/**`) know no
  workspace and get only the deployment-level refusal at the edge.
- The cron sweep (`GET /api/cron/triggers`) spans all workspaces and is never refused at workspace
  level; it filters per workspace (D8).
- `PUT /api/workspaces/:id/features` refuses two cases:
  - switching off a feature an enabled one needs: `409 feature_in_use`,
    `details: ['feature:<dependent>', …]` sorted (the ADR-0077 `<resource>_in_use` naming rule);
  - switching on a feature the deployment lacks: `409 feature_not_installed`, `details: [<id>]`.

**D8 Effects.**

- `GET /api/me` gains `features: FeatureId[]`, the enabled set.
- `GET /api/workspaces/:id/features` and `PUT /api/workspaces/:id/features`: GET for any member,
  PUT for the Owner only, both refusing API keys like every `/api/workspaces/**` route
  (`docs/adr/W9-WS-119-api-key-callers-are-refused.md`). A PUT writes one
  `workspace-features-changed` audit row.
- The console hides the nav entries of disabled features. A deep link to a disabled feature's page
  explains who can switch it on.
- While `builder` is off, the agent console hides the Chat tab on `/agents/new`; the page itself
  stays `core`. U2.4d and #1849 implement this.
- Switching off never deletes data.
- While `triggers` is off, the cron sweep skips that workspace's triggers.

**D9 Not an authorisation control.** RBAC (`decide()`) still applies to every route. A switch only
subtracts. An unwired switch runtime (tests, no database) means all on.

## Alternatives considered

- **A `runs` feature that includes execution.** Rejected: chat, surfaces, triggers, evaluations,
  project sessions and the Builder all start runs, so switching `runs` off would break almost
  everything (D2).
- **403 instead of 404.** Rejected: 403 asserts a rule about the caller; for this caller the route
  does not exist.
- **Storing an `enabled` boolean per feature.** Rejected: a row only ever means "off"
  in the agent portal data model. A boolean adds a third state (row says on) that
  means the same as no row.
- **Putting the guard in `route()` (`apps/web/server/http/route.ts`) only.** Rejected: 32 of the
  124 route files use it (`grep -rl "server/http/route'" apps/web/app | wc -l`), so most routes
  would go unguarded.
- **A separate Builder switch.** Rejected: the Builder design says it registers `builder` here and
  builds no second switch; two switches would disagree.

## Consequences

- `@indx-workspace/contracts` takes an additive minor: the new `features` field on
  `MeResponseSchema` (ADR-0052, ADR-0078 D7) and the new `features` export.
- The console `/setup` wizard does not ask the new setup question; it does not read
  `SETUP_QUESTIONS`. The question reaches `npm create`, `aw init` and the Claude Code entry point
  only.
- `aw help` filtering is deferred, because it would need a network call at help time.
- Switching `chat` off also hides the session read routes a project session's transcript uses
  (`GET /api/sessions/:engineSessionId/…`). A deployment that wants projects without chat accepts
  that, or a later record moves those reads to `core`.
- `core` screens that read switchable routes must render `feature_disabled` as an empty or absent
  list, not as an error. For example, a team member's removal impact reads `GET /api/sessions`, the
  agent editor reads files, skills, connectors and projects, and run history reads `/api/projects`.
  U2.4d implements this.
- Every route added to the catalogue from now on needs a feature id or falls into `core`. R-F1
  records the mapping beside the catalogue in `packages/contracts`, so the choice is made when the
  route is added.
- Reversing this record means removing the switch: data stays, since switching off never deleted
  any, and spec §3 and §44 return to their minimum-surface wording.
