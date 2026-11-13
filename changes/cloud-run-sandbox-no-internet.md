---
changelog: platform
section: Changed
---

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
