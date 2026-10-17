# Single VM — Docker Compose

This deployment uses the five services declared by the repository: `postgres`, `runner`,
`seaweedfs`, `web`, and `gateway`. The specification calls object storage `storage` and says runtime
containers are created on demand; this Compose file names the concrete SeaweedFS service and also
runs the control plane's runner service.

## From a project: `aw deploy production`

A v2 project (`kind: Project`, what `npm create @indx-workspace` writes) names its production
environment in its own `agent-workspace.yaml`, and `aw deploy` takes it to this Compose deployment
through `agent-workspace deploy` (ADR-0103, #621):

```yaml
environments:
  # local: as npm create wrote it
  production:
    target: single-vm
    url: https://agents.example.com
```

```sh
aw deploy production --plan     # what the deploy will do; nothing is started
aw deploy production --yes      # Compose up from the published release images
caddy reverse-proxy --from agents.example.com --to 127.0.0.1:3000
aw login --url https://agents.example.com && aw push --yes
```

Without `--yes` it only plans: it exits 0 when the deployment matches and 3 when changes are
pending; `--plan --yes` is refused. Run it on the VM, from the project directory.

**What the Owner provides.** Each is refused by name, before anything is created, when missing:

| Prerequisite                                                        | Refused with                                                           |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| A Linux VM with Node.js 24 or later                                 | `Node.js 24 or later is required`                                      |
| Docker Engine and the Compose plugin                                | `Docker Engine is not installed` / `Install docker-compose-plugin`     |
| `@indx-workspace/cli` beside `aw` (a created project has it)        | `@indx-workspace/cli is not installed`                                 |
| The release images for the CLI's version, published and public      | the version and the `images-v<version>` tag to publish (#370)          |
| A DNS A record for the `url` host pointing at the VM (`--yes` only) | `The url host … does not resolve`                                      |
| Ports 80 and 443 open, and Caddy on the VM                          | not checked; `aw deploy --yes` names Caddy in the next steps it prints |

**Where its state lives.** The deployment `aw deploy` drives is internal, at
`~/.config/agent-workspace/deployments/<project>/production/` (directory `0700`, `.env` `0600`).
The first run generates its secrets; later runs rewrite its `agent-workspace.yaml` from your
project and never regenerate them. **Back that directory up**: `.env` holds
`MASTER_ENCRYPTION_KEY`, without which stored secrets cannot be decrypted. The first Owner is
`environments.local.identity.bootstrapAdmin`; its password is `BOOTSTRAP_ADMIN_PASSWORD` in that
`.env`, which `aw deploy` names by path and never prints. When you change that email after the
first deploy, the next run rewrites the `BOOTSTRAP_ADMIN` line of `.env` and no other line: the
master key and the password stay as they were. `docker compose down` in that directory stops the
deployment.

**On Windows** the `0700` and `0600` modes are not enforced: Node.js maps a file mode to the
read-only attribute only, so the directory and `.env` take the access control list they inherit.
Under `%USERPROFILE%\.config\` that list grants only your account, `SYSTEM` and the
Administrators group by default; keep it that way (`icacls "%USERPROFILE%\.config\agent-workspace"`
shows it). The single-vm target itself runs on a Linux VM, where the modes hold.

**TLS with Caddy.** Web is published on `127.0.0.1:3000` only, and `AW_TRUSTED_PROXY_HOPS=1`
trusts exactly one proxy, so the deployment is reachable only through the proxy on the VM.
`caddy reverse-proxy --from agents.example.com --to 127.0.0.1:3000` obtains and renews the
certificate; the equivalent Caddyfile is two lines:

```text
agents.example.com
reverse_proxy 127.0.0.1:3000
```

## The deployment profile

The supported way to produce this deployment's settings is the generator, which writes one
`agent-workspace.yaml` and renders `.env` and the Compose project from it:

```sh
npx -p @indx-workspace/cli create-agent-workspace acme-ai --cloud local
```

`agent-workspace.yaml` is the single statement of where this deployment keeps its relational store,
objects, secrets, sandboxes and identity; `agent-workspace validate acme-ai` re-checks it and
probes the stores it names. A `local` project ships a `package.json` that depends on
`@indx-workspace/cli`, so `pnpm install` inside it puts that command on the path; outside one,
`npx -p @indx-workspace/cli agent-workspace validate acme-ai` is the same command. It reports
`postgres` and `seaweedfs` as skipped whether or not the project is up, and the generator's own
`--validate` does the same: Compose puts both on the `control` network, which is `internal: true`
and publishes no host port, so those hostnames resolve inside the project and nowhere else. Check
them from inside it — `docker compose exec postgres pg_isready -U agent_workspace` and
`docker compose exec seaweedfs wget -q -O /dev/null http://127.0.0.1:8333/healthz`. After editing
`agent-workspace.yaml`, `agent-workspace render` re-renders `compose.yaml`, `deploy/` and the image
lines of `.env` in place and keeps every other `.env` line; the other `.env` values are still
edited by hand, and re-running the generator writes a new directory with fresh secrets. `.env` is
also this deployment's secrets, which is why the generated
project ignores it in version control and writes it `0600`. The field reference is
`packages/cli/README.md`.

## Install

Install Docker Engine with the Compose plugin, clone the repository, then create local settings:

```sh
cp .env.example .env
```

Replace every placeholder secret in `.env`. Never copy a model-provider key into the runner
environment; provider credentials belong in the encrypted Models screen and are resolved only by
the private gateway.

Validate and start the deployment:

```sh
docker compose --env-file .env config --services
docker compose --env-file .env up -d
docker compose --env-file .env ps
```

Wait for the services to become healthy, then verify the web endpoint:

```sh
curl -fsS http://localhost:3000/ >/dev/null
```

Open `http://localhost:3000/setup` and complete Provider, Credentials, Runtime, Administrator, and
First agent.

## Security boundary

Mount the Docker socket only into the runner—never into the web container and never into a sandbox.
Keep PostgreSQL, SeaweedFS, the runner, and the gateway off public host ports. For gVisor, configure the
host runtime and select `runsc` for agent containers; do not claim that isolation until Test Runtime
passes. The `local` driver has no tenant isolation and must retain its warning banner.

## Client addresses behind a proxy (`AW_TRUSTED_PROXY_HOPS`)

`AW_TRUSTED_PROXY_HOPS` is the exact number of reverse proxies or load balancers in front of `web`
that append the caller's address to `X-Forwarded-For`. The web process cannot see the socket
peer, so it reads the client's address from that header, counting this many entries from the
right; entries further left are whatever the caller sent and are never trusted. The address is
used only as an HMAC (keyed by `SESSION_SECRET`), never stored raw.

- **Default:** unset (the Compose template passes `0`, which reads the same). No address is
  trusted. The per-client limits of an embedded public surface (sessions, turns and ratings;
  issue #622) then fall back to one bucket shared by every visitor, at ten times the per-client
  limit, and runnable public shares refuse to run. `aw login`'s pre-sign-in routes share one
  bucket the same way.
- **Set it** when `web` is reachable only through proxies that each overwrite or append
  `X-Forwarded-For`: `1` for one TLS terminator or cloud load balancer (the generated `gcp`, `aws`
  and `azure` profiles render `1`), `2` for a CDN in front of that load balancer, and so on, up to 16. A deployment that serves a surface with `allowedOrigins` to the public should set it, or one
  busy site can exhaust the shared bucket for every other visitor.
- **Never set it** when callers can reach `web` directly, or to more hops than really append the
  header: either lets a caller pick its own address, and so a fresh rate-limit identity per request.

## Upgrade and stop

Pin production images by digest, apply migrations once, and retain the PostgreSQL and object-store
volumes. To stop while preserving data:

```sh
docker compose --env-file .env down
```

For a disposable test deployment only, remove its named volumes as well:

```sh
docker compose --env-file .env down -v
```

### Upgrading to the engine-identity release (single-revision cutover)

The release that carries migrations `0024` and `0025` renames `sessions.claude_session_id` and
rewrites the `agents.policy` discriminant; the previous release cannot run against the migrated
database ([ADR-0069](../adr/0069-the-engine-identity-migrations-require-a-single-revision-cutover.md)).
`web` migrates as it starts, so stop the old stack first, back up PostgreSQL, then start the new
images:

```sh
docker compose --env-file .env down
docker compose --env-file .env up -d
```

### Upgrading to the engine-scoped session-state release (single-revision cutover)

The release that carries migrations `0026` and `0027` is upgraded the same way
([ADR-0071](../adr/0071-one-engine-scoped-session-state-store.md)): `0027` copies every Claude
transcript into the new store once, when `web` migrates at start-up, so nothing of the old stack may
still be writing when it does. Stop the old stack (`down`, without `-v`), back up PostgreSQL, then
start the new images. Rollback means restoring that backup together with the previous images.

Never pass `-v` here. Rollback means restoring the backup together with the previous images.

### Moving an existing deployment from MinIO to SeaweedFS

The bundled object store was MinIO until
[ADR-0067](../adr/0067-the-bundled-object-store-is-seaweedfs.md) replaced it with SeaweedFS. A
deployment that already holds files in the `minio-data` volume keeps them there after the upgrade;
the new `seaweedfs` service starts on an empty `seaweedfs-data` volume, and nothing deletes the old
one. Copy the bucket across before `web` serves from the new store — the ADR's upgrade note has
the exact commands, which reuse the MinIO image already on the host (its `mc` client) so nothing
has to be pulled from MinIO's registries.

## Public URL for external agent platforms (`AW_PUBLIC_URL`)

Set `AW_PUBLIC_URL` in the `.env` of `web` to the https origin external platforms reach it at, with
no path (`https://aw.example.com`). The A2A agent card (ADR-0135) builds its `url` from it; unset,
the card route answers `503 a2a_public_url_not_configured` and JSON-RPC calls still work. It is also the
OAuth 2.1 issuer for endpoint clients (ADR-0134): unset, `/oauth/*` and the `/.well-known/oauth-*`
documents answer `404 oauth_not_configured`. `aw
deploy` writes it from the project's `environments.production.url` on every run, replacing a
hand-set value, so change the project file instead; only a deployment `aw deploy` does not manage
keeps a hand-set value. The Compose project forwards it to `web`; other targets do not receive it
yet.

## Project tool endpoint (`/mcp/projects/:name`)

The endpoint (ADR-0134 part 2) runs a project's code tools in a tool sandbox opened by the runner
manager, using the workspace's default runtime profile. The Docker driver places it once
`AGENT_WORKSPACE_TOOL_HOST_IMAGE` names the tool-host image on the runner manager; without that
image, or without a default runtime profile, a tool call answers `503 tool_endpoint_unavailable`.
Revoking the endpoint client, one of its keys or an OAuth grant closes its sandbox at once, best
effort; the idle timeout ends it if the close cannot reach the runner manager.
