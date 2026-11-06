---
changelog: platform
section: Changed
---

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
