# Provider sandbox live lane

Live proof that the provider sandboxes behind `external` (E2B), `vercel-sandbox` and
`cloudflare-sandbox` isolate what their drivers claim (issue #832, ADR-0120 LC4). CI is
`.github/workflows/providers-live.yml`: daily and on `workflow_dispatch`, never on pull requests, and
not a required check for release PRs (it depends on third-party accounts).

Each lane builds the real driver from the built `packages/runtime/dist`, creates sandboxes from the
**probe image** and reads what `probe.mjs` reports from inside. The probe stands in for the runner
server at the path every provider starts (`/srv/apps/runner/dist/index.js`) and runs as the
production `node` user, so the non-root check measures the provider, not a value the test sets.
A fixed address counts as reached only on a TCP connect (a refusal is the firewall answering), and
the gateway and public hosts only on a TLS handshake with their SNI, because the providers allow
by hostname.

## Outcomes

Each check is `pass`, `fail`, `inconclusive` (a positive control failed or the provider gave no definite answer, so nothing
is proven; not a pass),
`n/a` (the provider does not declare the capability; the reason is in the results file) or
`skipped`. `infra/tests/isolation/summary.mjs` merges the lane files into a `check | e2b | vercel |
cloudflare` table and exits 1 over anything that is not `pass` or `n/a`.

**A missing credential is `skipped`, never `pass`.** Every check of that provider
reads `skipped` with the variable names, the run is red, and no issue is filed (it is a
configuration gap, not a regression). **A probe artefact that cannot be built or pushed is `fail`**:
every check of that provider reads `fail` with `probe artefact: <reason>`, and the lane exits
non-zero. A `fail`, `inconclusive` or missing row, a missing results
file, or a failed provider job (its cleanup may have leaked a sandbox or Worker) on a scheduled run
opens, or comments on, an issue labelled `provider-lane`.

## Checks

| check | applies when |
| --- | --- |
| `non-root`, `gateway-reachable` | under `none`, or under `open` where `none` is not declared; where neither is declared, `n/a` only on the `all-policies-refused` proof (below) |
| `none-blocks-public` | always; a timeout or refusal counts as blocked only if the gateway answered in the same probe (positive control), otherwise `inconclusive` |
| `none-blocks-private`, and `open-blocks-private` where applicable | always; the private targets are unreachable (refused or timed out, next to the same gateway control), or the provider's egress proxy accepts the TCP connect for every address and nothing answers behind it (below) |
| `none-blocks-cloud-metadata` | always; `169.254.169.254:80` blocked passes. If it connects, it passes only on proof of per-VM Firecracker MMDS and no cloud metadata (below) |
| `open-reaches-public`, `open-blocks-cloud-metadata`, `open-blocks-private` | the provider declares `open` (E2B, Vercel); otherwise `n/a`; the same gateway control applies |
| `metadata-is-per-vm-mmds` | informational, always under `none` (`open` where `none` is not declared): `pass` with the key names when `169.254.169.254:80` is proven MMDS, `n/a` when it does not connect, `fail` when it connects without proof |
| `no-ipv6-egress` | always, every provider: under `none` and `open` where declared (an undeclared `none` reads `n/a` as below; where neither is declared the row is `n/a` only on the `all-policies-refused` proof), `fe80::1`, `fc00::1` and `::1` on port 80 are unreachable; under `none` the IPv6 public host `[2606:4700:4700::1111]:443` (TLS, SNI `one.one.one.one`) too. A sandbox with no IPv6 route passes and says "no IPv6 route". Any reachable target is `fail` |
| `deadline` | `maxSessionSeconds` is not `null`; created with 60 s; 30 s after, `/ping` must not answer and the provider API must report it stopped (E2B: 404, Vercel: `stopped`), a failed or unknown lookup is `inconclusive`; `n/a` on Cloudflare (no declared policy, and activity-based `sleepAfter`) |
| `restricted-refused` | `allowlist` is not declared (today: none of the three) |
| `open-refused` | `open` is not declared (Cloudflare declares no network policy, ADR-0131) |
| `none-refused` | `none` is not declared (Cloudflare, ADR-0131): the real `create` under `none` throws `RuntimeRefusalError` `network_policy_unsupported`, returns no sandbox and makes no bridge call. Only then do `none-blocks-public`, `none-blocks-cloud-metadata`, `none-blocks-private` and the `none` half of `no-ipv6-egress` read `n/a`; a created sandbox, another error or a timeout fails them all. `n/a` where `none` is declared |
| `bridge-auth` | Cloudflare: the bridge refuses an unauthenticated create, destroy and forward (no sandbox needed); on the same sandbox as `non-root`, neither the bearer nor the access header alone reaches the runner. Where no policy is declared the sandbox half is skipped, only on the `all-policies-refused` proof |
| `all-policies-refused` | no network policy is declared (Cloudflare, ADR-0131): the real `create` under each of `none`, `open` and `restricted` throws `RuntimeRefusalError` `network_policy_unsupported`, returns no sandbox and makes no bridge call. Only then do the create-based rows (`non-root`, `gateway-reachable`, the `none-*` and `open-*` rows, `metadata-is-per-vm-mmds`, `no-ipv6-egress`, `deadline`) read `n/a`; a created sandbox, another error or a timeout fails them all. `n/a` where a policy is declared |
| `loopback` | `n/a`: a sandbox always reaches its own `127.0.0.1`, so a probe from inside shows nothing |

A refusal is asserted as `RuntimeRefusalError` with code `network_policy_unsupported`. If a provider
starts declaring `allowlist`, `restricted-refused` turns `inconclusive` until an allowlist check
exists; a check is never relaxed to pass. The private targets are `10.0.0.1`, `172.16.0.1`,
`192.168.0.1` and `100.64.0.1` on port 80, plus `169.254.169.254` and `169.254.169.253`;
a private target that connects is sent one HTTP request and the probe reports only the byte count, how the exchange ended and the status code. Each of those addresses and `192.0.2.1` is also tried with `Host: <gateway>` (reported as `<name>-fronted`), so a proxy that filters on Host and forwards to the original address is caught. It passes only if `192.0.2.1:80` (TEST-NET-1, never routed) connected too and neither it, any private target nor any `-fronted` variant returned a byte before the connection closed or reset: that is a proxy accepting every connect, not a host answering. Any byte, a connect that stalls until the timeout, a missing `-fronted` report, or a connect with no such evidence is `fail`.
`example.com` is the gateway host and `example.org` the non-gateway public host, both on 443.

**MMDS proof.** E2B runs Firecracker microVMs whose per-VM metadata service (MMDS) answers at
`169.254.169.254:80` before any egress rule can see the frame (ADR-0120 LC4 amendment). When that
address connects, the probe records HTTP statuses and key names only, and the row passes only if:
an unauthenticated `GET /` answers 401; the MMDS token flow returns a non-empty JSON object whose
keys are within `instanceID`, `envID`, `address`, `accessTokenHash` (any other key, or a non-string value, is `fail`); GCP
(`Metadata-Flavor: Google`), AWS IMDSv2 (token `PUT` plus `iam/`) and AWS IMDSv1 (`iam/`) reads all
fail; and `169.254.169.253:80` is blocked. MMDS answers the IMDSv2 token path itself, so the proof
rests on `iam/`, not on the token `PUT` failing. Tokens and values never leave the probe.

A real `fail` (for example a private range reachable on Cloudflare, whose `deniedHosts` CIDRs are
not enforced) is a driver bug to fix in E2/E3/E4, not a reason to change the check.

## Inputs

Secrets come from the `providers-live` environment (or repository secrets); variables from
repository variables. Nothing is passed on a command line; a failure message carries only
redacted output.

| provider | secrets (required) | variables (optional overrides) |
| --- | --- | --- |
| e2b | `E2B_API_KEY` | `E2B_PROBE_TEMPLATE` (`<template>:<build_id>`) |
| vercel | `VERCEL_TOKEN`, `VERCEL_TEAM_ID` | `VERCEL_PROJECT_ID`, `VERCEL_PROBE_IMAGE` (digest-pinned) |
| cloudflare | `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` | `CLOUDFLARE_PROBE_IMAGE` (digest-pinned) |

A variable that is set (non-empty) is used as is and nothing is built for it; an unset one is
derived by `prepare.mjs` as below. `VERCEL_PROJECT_ID` alone is looked up, never created.

## Probe artefacts

The lane builds them inside the run from `probe.Dockerfile` and `probe.mjs`, with each provider's
own mechanism, and keeps them under fixed names. The cache key is `p-<first 16 hex of
sha256(probe.Dockerfile, NUL, probe.mjs)>`, so a daily run rebuilds only when a probe file changed.

| provider | derived artefact | mechanism | cache |
| --- | --- | --- | --- |
| e2b | template `aw-providers-probe`, pinned as `aw-providers-probe:<build id>` | REST over `fetch`, no CLI or SDK (`e2b` is on `denyByName`): `POST /v3/templates`, then a v2 build of `probe.Dockerfile`'s steps with `probe.mjs` written from base64, polled until `ready`; the tag `p-<key>` is then assigned. The template has no start command: the provider starts the probe after create through envd's process API, with the bearer in its environment | the tag is looked up first (`GET /templates/aw-providers-probe/tags`); a hit builds nothing, and a create that conflicts reuses the build another run tagged |
| vercel | project `aw-providers-live` (resolved, created when missing); image `<team slug>/<project>/aw-providers-probe@sha256:...` | REST `GET /v9/projects`, `POST /v11/projects`; `docker buildx build --push` of a linux/amd64 image to Vercel Container Registry (`vcr.vercel.com`) | the tag is looked up first (`docker buildx imagetools inspect`); a throwaway sandbox is created and deleted until VCR stops answering `image_not_ready` (5 minutes at most) |
| cloudflare | image `registry.cloudflare.com/<account>/aw-providers-probe:p-<key>@sha256:...` | `wrangler containers build -p`; the digest is read back from `docker image inspect` | none: Wrangler builds and pushes each run, and Docker layer reuse is the only saving |

A failure of any of these steps is a `fail` row with the redacted reason (operation and status only),
not a `skipped` one.

To build the image by hand, for example to set an override:

```sh
docker build -t <registry>/aw-providers-probe:ci -f infra/tests/providers/probe.Dockerfile infra/tests/providers
```

## Running a lane by hand

```sh
pnpm --filter @agent-workspace/runtime build
PROVIDERS_LANE=e2b PROVIDERS_RESULTS=/tmp/results-e2b.json node --test infra/tests/providers/lane.test.mjs
node --test infra/tests/providers/unit.test.mjs   # no credentials needed
```

Without credentials the lane writes every check as `skipped` and exits 0; the summary is what turns
that red.

The Cloudflare lane waits up to 180 s, after deploying the bridge Worker and setting its secret, for
the bridge's own `401 {"error":"unauthorized"}` before any check runs. A timeout fails every row and
names the last answer (status and the bridge's error code, or `not the bridge` for the edge's page).

## Leftovers

Every sandbox, the throwaway bridge Worker and its Containers applications (`<worker>-sandboxnone`,
`<worker>-sandboxopen`) are removed in a `finally`, also after a failed or half-way deploy; a refused
deletion fails the lane. The Worker is named `agent-workspace-sandbox-bridge-ci-<run_id>-<attempt>`,
and the same name goes into the deployed `wrangler.jsonc` because Containers applications are named
after the config, not `--name`. Before deploying, this lane (not the lightweight journey, which
shares the bridge code) deletes any Worker or Containers application whose name starts with
`agent-workspace-sandbox-bridge-` (nothing else on the account) and whose newest creation or
modification time is older than 4 hours, longer than either workflow's timeout, so a run in flight
in the other workflow keeps its bridge; an entry without a readable time is kept. Every list page is
read, and only the names are logged. A run killed mid-way is therefore cleaned up by a later run; until then it can
leave those names in the Cloudflare account, or a sandbox that expires at its provider-side
timeout. The cached probe artefacts are kept on purpose: E2B template `aw-providers-probe`, Vercel
project `aw-providers-live` with its `aw-providers-probe` repository in VCR, and the Cloudflare
registry repository `aw-providers-probe`. Old `p-<key>` tags accumulate, one per change of a probe
file; prune them by hand until a retention step exists.

## Vendor sources

Facts about each provider's network controls and limits are cited, with the date they were checked,
next to the driver that relies on them: `packages/runtime/src/external/e2b.ts`, `vercel-sandbox.ts`,
`cloudflare-sandbox.ts`. Wrangler deploy/delete:
https://developers.cloudflare.com/workers/wrangler/commands/ (checked 2026-10-08).

Probe artefacts (all checked 2026-10-08; the exact calls are in the header of `prepare.mjs`):

- E2B: https://docs.e2b.dev/api-reference/templates/create-template-v3,
  https://docs.e2b.dev/api-reference/templates/start-build-v2,
  https://docs.e2b.dev/api-reference/templates/get-build-status,
  https://github.com/e2b-dev/infra/blob/main/packages/envd/spec/process/process.proto (`Process.Start`),
  https://docs.e2b.dev/template/tags,
  https://docs.e2b.dev/api-reference/tags/list-template-tags,
  https://docs.e2b.dev/api-reference/tags/assign-tags
- Vercel: https://vercel.com/docs/container-registry,
  https://vercel.com/docs/sandbox/concepts/images,
  https://vercel.com/docs/rest-api/projects/find-a-project-by-id-or-name,
  https://vercel.com/docs/rest-api/projects/create-a-new-project,
  https://vercel.com/docs/rest-api/teams/get-a-team
- Cloudflare: https://developers.cloudflare.com/containers/platform-details/image-management/,
  https://developers.cloudflare.com/workers/wrangler/commands/containers/
