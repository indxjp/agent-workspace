# Isolation conformance lanes

Live proof that the `docker` and `kubernetes` runtime drivers isolate a sandbox. The suite builds
nothing itself: it imports the built `packages/runtime/dist`, creates sandboxes through the real
drivers and runs commands inside them. CI is `.github/workflows/isolation.yml`.

Each check is recorded as `pass`, `fail`, `inconclusive` (a positive control failed), `n/a`
(the driver does not claim it) or `pending` (a case the suite lists but cannot run yet). `summary.mjs` merges the lane
files into a `check | docker | kind` table.

## Docker lane

Needs Docker with cgroup v2.

```sh
pnpm --filter @agent-workspace/runtime build
docker build -t aw-isolation-probe:ci -f infra/tests/isolation/probe.Dockerfile infra/tests/isolation
docker build -t aw-egress-proxy:ci -f egress-proxy.Dockerfile --target egress-proxy .
ISOLATION_LANE=docker node --test infra/tests/isolation/isolation.test.mjs
```

## kind lane

Needs `kind` and `kubectl`. kind's default CNI does not enforce NetworkPolicy, so install Calico:

```sh
kind create cluster --name aw-isolation --config infra/tests/isolation/kind-config.yaml --wait 0s
kubectl apply -f https://raw.githubusercontent.com/projectcalico/calico/v3.33.0/manifests/calico.yaml
kubectl wait --for=condition=Ready nodes --all --timeout=300s
kind load docker-image aw-isolation-probe:ci aw-egress-proxy:ci --name aw-isolation
ISOLATION_LANE=kind node --test infra/tests/isolation/isolation.test.mjs
```

## Environment

- `ISOLATION_LANE`: `docker`, `kind` or `kind-chart`. Required; there is no default and no skip.
- `ISOLATION_IMAGE`: the sandbox image (default `aw-isolation-probe:ci`).
- `ISOLATION_PROXY_IMAGE`: the egress proxy image of ADR-0117 (default `aw-egress-proxy:ci`), built
  from `egress-proxy.Dockerfile`. Both lanes hand it to the driver as `egressProxyImage`.
- `ISOLATION_MANAGER_URL`, `ISOLATION_MANAGER_TOKEN`, `ISOLATION_NAMESPACE`: the `kind-chart` lane
  only. The runner manager of an installed chart (`http://…`, its bearer token, the release
  namespace); required there, ignored elsewhere.
- `ISOLATION_RESULTS`: where the lane writes its JSON (default: the OS temp directory).
- `ISOLATION_INTERNET_URL`: the URL the internet control fetches. Its host is resolved once on the
  runner and probed by IP with the original `Host` header, so a sandbox without DNS cannot pass the
  internet check on the failed lookup alone.

## Egress checks

`restricted` and `open` sandboxes reach the internet only through their per-session egress proxy,
so the network checks read the proxy's own answer: a 403 whose JSON body carries the reason
(`host_not_allowed`, `address_private`, `address_link_local`). The same targets are then probed
directly with `wget -Y off`, which ignores the proxy variables and shows the sandbox has no other
route. The positive controls come from `lane.control`, a plain container or pod with no policy,
because an `open` sandbox no longer reaches the decoy workload by design. `network-restricted-dns`
checks that a `restricted` sandbox cannot resolve an external name, so DNS is no way out either.

## Tool sandbox secrets

`tool-sandbox-writefile-secrets` (docker only; `n/a` on kind until the Kubernetes tool sandbox
lands) writes a file through the driver's `writeFile`, the call the runner uses to hand a tool
sandbox its secrets (ADR-0118 TS4), reads it back from inside, and checks the value is absent from
`docker inspect`.

`tool-sandbox-agent-unreachable` (docker only) places a tool sandbox through a second driver on a
network of its own, as the runner does, and checks that an agent sandbox cannot connect to it. A
second tool sandbox on the same network is the positive control. Both checks use the probe image:
building `tool-host.Dockerfile` in the lane is follow-up #843.

Known limit of this slice: every tool sandbox, the gateway and the runner manager share one internal
tool network, so a tool sandbox can reach another session's tool sandbox and the runner control API.
The runner therefore leaves tool sandboxes off unless `AGENT_WORKSPACE_TOOL_HOST_IMAGE` is set.
Follow-up #841 adds per-session tool networks, takes the runner manager off the tool network and
turns the feature on by default.

## Checking that a lane can fail

Remove one isolation flag from the built driver and run the lane again, for example delete
`'--cap-drop', 'ALL'` in `packages/runtime/dist/docker.js`: the `capabilities` check must fail.
Rebuild afterwards.

## Chart smoke (kind lane)

After the isolation checks, the kind job builds the root `Dockerfile`'s `web` target, loads it into
the cluster and runs `node infra/tests/isolation/chart-smoke.mjs` (issue #849). The script starts a
throwaway PostgreSQL in its own namespace, creates the three Secrets the chart reads in
`agent-workspace` with a random password, and runs `helm install` of `infra/helm/agent-workspace`.
Helm runs the migrate Job's pre-install hook before it creates the chart's NetworkPolicies, so the
script then runs `helm upgrade`: the pre-upgrade hook runs with the default deny in place, and the
upgrade only returns once the Job has reached the database through it and resolved its name through
the cluster DNS; the script then reads the migration ledger. Pods labelled as the web, migrate and
gateway components must dial the database, and one labelled as none of them must not: that refusal
is the negative control that the policies are enforced. Nothing here waits for the gateway, runner manager
or web rollouts, and the web image is not digest-pinned, so the chart's image schema is skipped for
this install (`--skip-schema-validation`).

```sh
docker build -t aw-web:ci --target web .
kind load docker-image aw-web:ci --name aw-isolation
node infra/tests/isolation/chart-smoke.mjs   # run it on a fresh cluster: it installs into `agent-workspace`
```

## kind-deploy lane (`kind-chart`)

The `kind-deploy` job proves the chart runs agents (issue #854). `node infra/tests/isolation/kind-deploy.mjs`:

1. builds the four platform images from the checkout (`tests/generated-project/images.mjs`) into a
   registry on `localhost:5001` that the workflow connects to the kind network, and takes their
   digests; the web and gateway images are rebuilt on `trust-ca.Dockerfile` to trust the CA of the
   fake provider, the runtime image on `runtime-probe.Dockerfile` for the isolation tools;
2. runs the generated-project E2E's fake Anthropic API as a Pod, with CoreDNS answering
   `api.anthropic.com` with its Service and `providers` narrowed to it (`AW_HELM_VALUES`);
3. creates a PostgreSQL, the namespace and the three Secrets, then `aw deploy production --yes
--infra infra` installs the chart from a `kind: Project` file with `target: kubernetes`;
4. through `kubectl port-forward`, runs setup with `runtime: kubernetes` (a start, echo and destroy
   through the runner manager), starts one run and asserts it completed with the fake's reply and
   that a Pod labelled with that run's session, created by the `agent-workspace-runner-manager`
   field manager under the `agent-runtime` ServiceAccount, ran the engine image.

The workflow then runs this suite with `ISOLATION_LANE=kind-chart`: `lane.mjs` allocates every
sandbox through `POST /runtimes` on that runner manager, so the cases run against the Pods the
manager creates, not against a driver the lane builds itself. Run it on a disposable Docker host:
it needs Docker with Buildx, kind, Calico, `helm`, `kubectl` and `openssl`.

## Cloud Run lane

`infra/tests/isolation/cloud-run-lane.mjs` is run by `.github/workflows/gcp-cloudrun-preview.yml`
(step "Prove a none sandbox has no internet") against a stack that `aw deploy production` created.
It asserts; it no longer records. It runs as three Cloud Run Jobs inside the install's VPC, because the
runner manager is internal (the GitHub runner cannot reach it) and has no command-exec route, so
nothing can run inside a sandbox the manager created. The image is `cloud-run-lane.Dockerfile`: the
runtime image (it carries node) plus the script. Every mode prints one line,
`AW_ISOLATION_RESULT <json>`, which the workflow reads from Cloud Logging, merges into
`{ lane: 'cloud-run', results }` and renders with `summary.mjs`. Each execution gets a fresh nonce
(`AW_ISOLATION_NONCE=<run id>-<run attempt>-<mode>-<random>`, set with
`gcloud run jobs execute --update-env-vars`) that the line echoes. `log-result.mjs` accepts only a
line with the expected mode and nonce, and the query is narrowed by the
`run.googleapis.com/execution_name` label when the execution name was captured. A line of an earlier
execution of a job with the same name is therefore never read: with no matching line the workflow
retries, then fails the lane.

- Control job `$PREFIX-iso-ctl`, in the services subnet as the web service account. `create` sends a
  Google ID token (`X-Serverless-Authorization`) and the runner manager token to `POST /runtimes`
  (`driver: cloud-run-service`, `networkPolicy: none`), prints the handle and the `rt-<id>` service,
  and runs the positive control `control-private-range`: the Cloud SQL private address must accept a
  TCP connection from the services subnet. `destroy <id>` deletes the sandbox at the end.
- The workflow then checks the sandbox service: ingress `internal`, Direct VPC egress `all-traffic`
  on the `$PREFIX-sandbox` subnet with the `aw-sandbox` tag, and the runtime service account.
- Probe job `$PREFIX-iso-probe`, deployed with exactly that network shape and service account.
  `gateway-reachable` (`GET /health` on the gateway's internal load balancer, `gateway_internal_url`)
  must answer 200. `egress-internet` (an HTTP request to an IP literal with a Host header, and a raw
  TCP connect to that address on 443, 10 s each) and `egress-private-range` (a raw TCP connect to the
  Cloud SQL private address on 5432, 10 s) must time out before the connect, by the same rule as the
  VIPs below. `egress-google-vip` sends requests to
  `private.googleapis.com` (199.36.153.8) and `restricted.googleapis.com` (199.36.153.4) by IP literal:
  `run.googleapis.com` on both, the gateway's own `run.app` host, and, when set, an external `run.app`
  host (`ISOLATION_EXTERNAL_RUNAPP_HOST`) and a GCS upload to an external bucket
  (`ISOLATION_EXTERNAL_BUCKET`). `egress-gateway-run-app` requests the gateway's `run.app` URL by name,
  through the private `run.app` zone. Raw TCP connects to both VIPs on 443 and 80 run too. A GCP
firewall deny drops packets silently, so each attempt must time out before its TCP connect: a
connect, an HTTP status, `ECONNREFUSED`, `ECONNRESET`, a hang-up, a TLS error or a timeout after the
connect proves a packet reached the VIP and is a `SECURITY:` fail; any other error is
`inconclusive`. A DNS failure on the `run.app` name passes only when the IP-literal request for the
same host to the VIP timed out.
- Token job `$PREFIX-iso-token`, the sandbox's service account on the services subnet (no tag,
  `private-ranges-only`). `metadata-token-useless` must see 403 from the Cloud Run API, and
  `testIamPermissions` on the project must answer 200 and grant none of `SENSITIVE_PERMISSIONS`.
- `gateway-refusal`: the gateway `run.app` URL answers 404 to `/health` from the internet.

Inputs, set by the workflow: `CLOUD_RUN_MANAGER_URL`, `RUNNER_MANAGER_TOKEN` (a Secret Manager
reference, never printed), `ISOLATION_PRIVATE_ADDRESS`, `ISOLATION_INTERNET_URL`,
`ISOLATION_INTERNET_ADDRESS`, `ISOLATION_GATEWAY_URL`, `ISOLATION_GATEWAY_RUN_APP_URL`,
`ISOLATION_CONTROL_PRIVATE`, `ISOLATION_EXTERNAL_RUNAPP_HOST`, `ISOLATION_EXTERNAL_BUCKET`, and for
the token job `GCP_PROJECT`, `GCP_REGION`. Nothing depends on a model reply.

The metadata server cannot be firewalled: it answers every Cloud Run workload. The lane therefore
does not expect it to be unreachable. It proves the token is useless: a sandbox reaches no Google API,
so the token job takes the same service account to the services subnet and uses its token through
`private.googleapis.com`: the Cloud Run API must answer 403, and
`cloudresourcemanager.googleapis.com/v1/projects/{project}:testIamPermissions` must grant none of the
sensitive permissions in `SENSITIVE_PERMISSIONS` (Cloud Run, Storage, Secret Manager, Vertex AI,
service account impersonation, Cloud SQL, Compute, IAM policy, and `logging.logEntries.create`,
which the runtime service account does not need because Cloud Run collects stdout itself). A 2xx
from Cloud Run or any granted permission fails; any other answer from either call is
`inconclusive`. A binding on a single resource is not visible to the project-level check.

`evaluateProbes` and `evaluateToken` (unit-tested in `cloud-run-lane.test.mjs`) map the measurements
to outcomes: a failed gateway control makes the other probes `inconclusive`, a failed positive control
makes `egress-private-range` `inconclusive`, and any attempt at the public host, the private range,
a Google VIP or the gateway's `run.app` URL that proves a packet came back (a connect, an HTTP status
such as 403 or 404, `ECONNREFUSED`, `ECONNRESET`, a hang-up, a TLS error) is a `fail` whose detail
starts with `SECURITY:`. Only a timeout before the TCP connect is a `pass`; any other error is
`inconclusive`. The workflow writes
`isolation-security` for any `SECURITY:` detail, and the step "Fail on the sandbox isolation proof"
fails the job after the browser journey has run. A sandbox that reaches a public
host stops the programme and is escalated.
