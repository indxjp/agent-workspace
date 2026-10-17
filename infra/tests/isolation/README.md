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
