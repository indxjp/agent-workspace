# Lightweight deploy-the-agent-app journey

Issue #832 (E7, AC2). The Z1 journey (`../build-deploy-journey`, imported, not copied) taken to a
Vercel or Cloudflare deployment. Four lanes, one per host and sandbox:
`vercel-vercel-sandbox`, `vercel-e2b`, `cloudflare-cloudflare-sandbox`, `cloudflare-e2b`.

Rows (chapters): `create` `eval` `deploy` `configure` `gate` `chat-api` `hosted-chat` `widget`
`frontend` `rollback`. Every row needs the lane's tokens and nothing else; no model key. As in the Z1
journey, the eval runs a keyless scripted model and the deployment is set up with a fake `sk-ant-`
key (a deployment refuses scripted models outside the local posture).
Compose answers `api.anthropic.com` with the scripted fake; a hosted deployment cannot alias that
host (the real API answers a fake key with 401), so every lane, Vercel included, deploys the fake as
a Cloudflare Worker (`fake-provider-worker.mjs`, named `<project>-provider`, answering only the run's
key) and setup is given its URL as `providerBaseUrl`. The Vercel lanes therefore also read the
Cloudflare token pair (a missing one fails their `deploy` row), and their teardown and sweep delete
that Worker.
The sandbox provider's key (`E2B_API_KEY`, `VERCEL_TOKEN`, or the Cloudflare bridge secret) goes in the
same setup call as `runtimeCredential` + `runtimeEndpoint`: setup tests the runtime with it and stores
it as the encrypted `<driver> default` runtime connection, which the `journey-sandbox` profile uses.

- `lanes.mjs`: lanes, chapters, skip rules, resource names, the results file. Pure.
- `journey.e2e.mjs`: runs one lane (`LJ_LANE`, `LJ_RUN_ID`, `LJ_RESULTS`). Start nothing without credentials.
- `teardown.mjs`: deletes by the derived names; a leftover exits 1.
- `e2b-sandboxes.mjs`: at the end of an E2B lane, success or failure, kills the sandboxes tagged with the lane's workspace (`awWorkspace`, on both the agent runtime and the tool sandbox; a workspace id is a random UUID its deployment's database generates, so no other deployment shares it), prints the count before and after, and fails the lane unless it is 0 or the lane never learned its workspace. Other lanes' and production's sandboxes are never listed. The two E2B lanes run one after the other (a job-level concurrency group in the workflow), so together they never approach the account's 20-sandbox cap.
- `.github/workflows/lightweight-journey.yml`: schedule and dispatch, one job per lane.

Credentials per lane are in `lanes.mjs`: `VERCEL_TOKEN` + `VERCEL_TEAM_ID`, `CLOUDFLARE_API_TOKEN` +
`CLOUDFLARE_ACCOUNT_ID` (Vercel lanes also read this pair to deploy the fake provider; a missing one
fails `deploy`), `E2B_API_KEY` for the E2B lanes, `R2_ACCESS_KEY_ID` +
`R2_SECRET_ACCESS_KEY` for every lane (the control plane's R2 key pair; the Vercel lanes reach R2 through its S3 endpoint and the journey creates their bucket), and `NEON_API_KEY` + `NEON_PROJECT_ID`
(each run takes a database branch and deletes it). The Cloudflare sandbox lane's bridge runs the
runtime image the run builds (`AW_RUNTIME_IMAGE`), pushed to Cloudflare's registry by digest the way
`agent-workspace deploy --target cloudflare` pushes the platform images; teardown deletes the bridge
Worker and its container applications. On the Cloudflare sandbox and Vercel Sandbox lanes `aw push` is refused with
`422 code_tool_needs_host` (no tool sandbox, ADR-0131; the Vercel Sandbox tool host is a follow-up): `configure` and the chapters that need the
agent or its surface (`widget` included) record `n/a` with that refusal as the proof, and only
`frontend` still runs; any other push problem, or a problem count that disagrees with the refusal
lines, fails. Each lane reuses one R2 bucket, `awlj-<lane key>-files`, across runs.

The journey proves the commit under test, so every sandbox lane runs that commit's runtime. The E2B
lanes build their runtime template from the checkout on every run (`infra/e2b/runtime-template.mjs`
replays `runtime.Dockerfile`; templates `aw-runtime-journey-ve` and `-ce`, build logs on stderr) and
deploy with the pin it returns. The repository variable `E2B_RUNTIME_TEMPLATE` is the production pin
only: the `E2B runtime template` workflow (`.github/workflows/e2b-template.yml`, `workflow_dispatch`,
`main` only, environment `providers-live`) builds it from the _released_ `runtime-claude-agent-sdk`
image, and the journey no longer reads it. A template from a released image lags `main` (protocol
and environment changes land between releases), which is why it cannot prove a commit.

The tool-host template is built from the checkout the same way, on every run
(`infra/e2b/tool-host-template.mjs` replays `tool-host.Dockerfile`; templates `aw-tool-host-journey-ve`
and `-ce`), so the tool host and the manager under test always agree on `/mcp` and the run-token
file. The repository variable `E2B_TOOL_HOST_TEMPLATE` is the production pin only, and the journey no
longer reads it. `aw deploy` renders the pin as the tool-host flag of the E2B manager and control
plane, so the E2B lanes accept a push with a code tool and run it in an E2B sandbox. That tool declares no
`allowedDomains` (`OFFLINE_DECLARATION`): a declared domain makes the runner ask E2B for the `restricted`
network policy, which E2B refuses (ADR-0120 LC4, ADR-0132), and every run of the agent would fail at
allocation. The Cloudflare sandbox lane keeps its
refusal (ADR-0131), and a Vercel sandbox renders no flag.

The Vercel sandbox lane (`vercel-vercel-sandbox`) pushes the run's runtime image to the
`<project>-manager` project's Vercel Container Registry (`pushVercelSandboxImage`, logging in with
`VERCEL_TOKEN` on stdin) and waits until Vercel Sandbox accepts it; the reference goes to the deploy
as `VERCEL_SANDBOX_RUNTIME_IMAGE`. A failed setup on a Vercel lane reports the control plane's and the
manager's log excerpts.

The `gate` row first tries `aw promote` with a version whose newest evaluation is below the bar
(`minEvalScore` 1) and asserts it is refused naming that version (`production refused: v<N> scored`), then
promotes it past the bar. `aw deploy` carries the bar to the deployment as `AW_DEPLOYMENT_POLICY`; the
profile-path lanes (`agent-workspace deploy <dir> --target`) do not, so the journey writes the same
single-quoted JSON (`JOURNEY_DEPLOYMENT_POLICY`) into their `.env`. The `widget` row, after the session
from the frontend origin, sends one turn the way the frontend's client does (`POST /api/agents/<id>/runs`
with the visitor token and the frontend `Origin`) and asserts the run is accepted with CORS for that
origin, completes, and replies with the code tool's data. Both rows are `n/a` with the push refusal on the
two native-sandbox lanes (no agent exists there).

Outcomes are `pass`, `fail`, `skipped` and `n/a`. `skipped` is not a pass: the summary job is red over it.
`n/a` is only the run rows of the two native-sandbox lanes,
Vercel Sandbox (#940) and Cloudflare Sandbox (ADR-0131). For example the native Cloudflare sandbox
refuses every network policy until egress denial is provable (ADR-0131), so the lane deploys and its
first run must be refused with the typed `network_policy_unsupported`; the row carries that proof, and
a run that completes, or fails for another reason, is a `fail`.
The job installs the host CLI (`vercel@63.1.0` or `wrangler@4.147.0`) globally, as the deploy guide says.
The Cloudflare token needs Containers: Edit and Workers Scripts: Edit, or the lane fails at `deploy`.
`pnpm vitest run tests/e2e/lightweight-journey` checks the rules above with no credential.
