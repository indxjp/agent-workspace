---
changelog: cli
section: Added
---

- `aw deploy production` with `target: kubernetes` writes `environments.production.apps` into the
  Helm overlay as `apps: [{ name, image, host, schema }]`, `schema` being `app_<name>`, and prints
  `create Secret agent-workspace-app-<name>` for each app. It refuses an app name longer than 43
  characters, which would not fit the app's Service name.
- The Helm chart takes `apps`: per app a Deployment and a Service `agent-workspace-app-<name>`
  (probes on `/api/health`, no ServiceAccount token, its own operator-created Secret and none of
  the platform's), an Ingress rule and TLS host, and the NetworkPolicies `apps-dns`,
  `apps-database`, `apps-egress-https` and `apps-from-ingress`. The default render is unchanged.
