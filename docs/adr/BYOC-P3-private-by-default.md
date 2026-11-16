# ADR-BYOC-P3 — The Google Cloud install is private by default; the gateway keeps its run-token gate

Status: accepted
Date: 2026-11-05
Decided by: BYOC Google Cloud phase P3
Scope: `infra/terraform/gcp-cloudrun/**`, `packages/cli/modules/gcp-cloudrun/**`,
`packages/cli/src/deploy/**`, `packages/contracts/src/project-file.ts`,
`docs/deploy/gcp-cloudrun.md`, `docs/sdk/site/features/self-host-securely.mdx`

## Context

Phase P1 deployed the stack with a public `run.app` address on every service and a public Cloud SQL
address. Phase P3 makes the install private by default, adds an
optional custom domain, and lets the project file configure single sign-on. Three facts about Google
Cloud shaped the decision:

- A Cloud Run service with `INGRESS_TRAFFIC_INTERNAL_ONLY` answers `404` to an internet request, and
  accepts a caller only through the VPC or Google's own network paths. A caller needs
  `roles/run.invoker` and a Google ID token.
- `Authorization` already carries `RUNNER_MANAGER_TOKEN` on the web to runner-manager call. Cloud Run
  reads a Google ID token from `X-Serverless-Authorization` when `Authorization` is taken.
- Sandbox engines cannot attach a Google ID token to their model calls, and the sandbox service
  account holds no roles by design. Only the per-run token reaches the model gateway from a sandbox.

## Decision

1. **The runner manager is internal-only, with no `allUsers`.** The web service account holds
   `roles/run.invoker` on it. The web app sends a Google ID token in `X-Serverless-Authorization`
   beside its bearer token in `Authorization`; the manager still checks the bearer token.
2. **Web and the gateway use Direct VPC egress, `PRIVATE_RANGES_ONLY`.** The network has Private
   Google Access and a private `run.app` DNS zone resolving `*.run.app` to `199.36.153.8/30`, so
   the web app reaches the internal manager through the VPC while public calls leave as before.
   `network` and `subnetwork` adopt an existing VPC; an adopted network must already have Private
   Services Access and the private zone.
3. **Cloud SQL has a private IP only (`ipv4_enabled = false`), `ssl_mode = ENCRYPTED_ONLY`, and the
   Cloud SQL proxy runs with `--private-ip`.**
4. **A custom domain is optional.** `gcp.domain` adds a global external load balancer with a
   serverless network endpoint group and a managed certificate; web ingress becomes
   `internal-and-cloud-load-balancing`. `armor` adds a Cloud Armor policy and `iap` enables
   Identity-Aware Proxy on the load balancer backend service only (an `iap { enabled = true }` block,
   GA provider). The web service is not IAP-enabled and keeps its `allUsers` invoker behind the
   internal-load-balancer ingress, so the gateway's internal call to its run.app URL (aw-control)
   needs no Google ID token. IAP users outside the organisation need a custom OAuth client. The certificate is
   issued only after DNS points at the load balancer's IP; the preflight says when it does not.
5. **Single sign-on comes from `gcp.oidc: { issuer, clientId }`.** The CLI asks for the client secret
   once at the terminal (hidden input) or reads `AW_OIDC_CLIENT_SECRET`, writes it to Secret
   Manager as `<name>-oidc-client-secret`, and the module passes the four `OIDC_*` variables to the
   web service. The secret never appears in the project file, the Terraform plan output or the
   summary. Rotation is `gcloud secrets versions add`.
6. **Destroy waits for the network.** Google Cloud keeps a subnetwork in use for one to two hours
   after the services using Direct VPC egress are deleted. The first destroy removes everything else
   and says so; the Owner runs it again later.

## Amendment: the model gateway keeps `allUsers` permanently

The plan first made the gateway internal like the runner manager. That does not hold: a sandbox calls
the gateway from inside an engine that cannot attach a Google ID token, and the sandbox service
account has no roles. If the gateway required `roles/run.invoker`, no sandbox could call it. So the
gateway keeps `allUsers` as invoker, permanently, and the per-run token is its gate. In P3 it keeps
ingress `ALL` and gains Direct VPC egress, which it needs to reach the private Cloud SQL address. Its
`INGRESS_TRAFFIC_INTERNAL_ONLY` moves to the next phase, together with the sandbox Direct VPC driver
that lets sandboxes call an internal service from inside the VPC.

## Amendment: the gateway reaching web behind IAP

Behind `iap`, web drops `allUsers`, and direct IAP covers the run.app URL as well. The gateway calls
web there for the aw-control MCP tool. The module therefore grants the gateway service account
`roles/run.invoker` on web when IAP is on. The gateway must also send a Google ID token for that call;
until it does, `iap` does not work for aw-control. The public-access preflight stays at `fail` under an
organisation policy that restricts members, because the gateway keeps `allUsers` until the next phase.

## Consequences

- Only the web app is public; the database and the runner manager are not reachable from the
  internet. A web-to-manager call needs the web service account's invoker role and a working private
  DNS zone, so an adopted network without the zone fails at the first run.
- The gateway remains internet-reachable behind its run token. The documentation says so in its
  "Limits today" and the sandbox no-internet proof stays pending until the next phase.
- A new `google-beta` provider joins the module's lock file; it is used only for the Secret Manager service agent.
- A deploy with a `domain` is two-step: the Owner points DNS at the printed IP before the managed
  certificate can be issued.
- A destroy can need two runs, an hour or two apart.
- Offline tests cover the default and `domain` shapes. The live run asserts that the manager's
  `run.app` address refuses internet requests, that Cloud SQL has only a private address, and that
  sign-in redirects to the issuer.
