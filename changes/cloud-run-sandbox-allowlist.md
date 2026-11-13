---
changelog: platform
section: Added
---

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
