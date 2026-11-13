---
changelog: platform
section: Added
---

- `aw deploy production` on the `gcp-cloudrun` target deploys `environments.production.apps`
  (the Vercel target still refuses them). Each app is its own Cloud Run service with its own service
  account, its own PostgreSQL role and schema, internal ingress, and one always-on instance that
  migrates on start. Today an app answers only `/api/health` and its routing on Cloud Run. An app
  name is at most 25 characters on this target. The next steps print each app's run.app address
  and, with `gcp.domain`, the host to point at the load balancer.
- Cloud Run now runs code tools and `stdio` MCP servers in a per-session tool sandbox: an internal
  service with the same no-egress firewall as an agent sandbox. A tool call no longer answers 503
  `tool_endpoint_unavailable` on this target.
- Two limits remain on Cloud Run. Agents cannot call an app's MCP endpoint yet, because sandboxes
  reach only the gateway. The app's workspace id, API key and connector id are not set yet.
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
