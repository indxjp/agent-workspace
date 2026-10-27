# R-14 probe fixtures — Node runtime and proxy semantics

Companion to the R-14 research note (maintained privately). Every claim in
that note graded `verified` was produced by one of the scripts here, run against **Node v24.19.0** —
the exact version pinned in the repo's `Dockerfile` (line 28, `ARG NODE_IMAGE=node:24.19.0-bookworm-slim`)
and `compose.yaml` (line 127) — on **two platforms**: the Windows 11 authoring host, and the pinned
Linux image itself under Docker 29.7.2. Retrieved 2026-09-05.

Nothing in this fixture tree imports anything beyond Node's own `node:*` built-ins — see "Why no
`undici` fixture is committed" below for the one source read that deliberately stayed uncommitted
because of that.

## Reproducing

```
cd docs/research/fixtures/R-14

# part 1 — dead-proxy route suite (pure Node, no shell, no openssl)
node route-suite.mjs

# part 2 — live-proxy suite (wire protocol + proxy authentication)
bash run-all.sh

# part 3 — non-Node client suite (curl and python urllib.request)
bash nonnode-suite.sh

# the same three, inside the exact pinned runtime image
docker run --rm -v "$PWD":/fx:ro -w /fx node:24.19.0-bookworm-slim node route-suite.mjs
docker run --rm -v "$PWD":/fx:ro -w /fx node:24.19.0-bookworm-slim bash run-all.sh
docker run --rm -v "$PWD":/fx:ro -w /fx node:24.19.0-bookworm-slim bash -c   'apt-get update -qq >/dev/null 2>&1; apt-get install -y -qq curl python3 >/dev/null 2>&1;    echo "apt-get install -y curl python3 -> exit=$?"; bash nonnode-suite.sh'
```

`nonnode-suite.sh` needs `curl` and/or `python3`. It detects each one and skips its sections with a
printed reason rather than failing if it is absent — which is what happens when the suite is run in
the pinned image unmodified, since `node:24.19.0-bookworm-slim` ships neither. The container command
above therefore installs both first and records that it did so in the transcript's first two lines.

`run-all.sh` needs `openssl` for its throwaway HTTPS certificate. The pinned image ships none, which
the script detects and reports before skipping the HTTPS sections; the HTTP and
proxy-authentication sections still run there. `route-suite.mjs` needs nothing but Node.

On Windows, use the container run for anything about environment-variable **case**: Windows folds
env-var case at the OS level, so a probe that sets `http_proxy` and `HTTP_PROXY` to different values
cannot exist there. The transcripts show this rather than assert it — the Windows `boot env:` line
reports both names carrying the same value.

## Committed transcripts

| File | Platform | Command |
| --- | --- | --- |
| `transcript-win-route.txt` | Windows 11 | `node route-suite.mjs` |
| `transcript-linux-route.txt` | `node:24.19.0-bookworm-slim` | `docker run … node route-suite.mjs` |
| `transcript-win-live.txt` | Windows 11 | `bash run-all.sh` |
| `transcript-linux-live.txt` | `node:24.19.0-bookworm-slim` | `docker run … bash run-all.sh` |
| `transcript-win-nonnode.txt` | Windows 11 | `bash nonnode-suite.sh` |
| `transcript-linux-nonnode.txt` | `node:24.19.0-bookworm-slim` + `curl`, `python3` | `docker run … bash nonnode-suite.sh` |

Every block quoted in the note that reports a probe's output is copied out of one of these six files
and names which one. (Quotations of *source code* — undici's, Node's, the MCP SDK's — are not from
these transcripts; each such block names the package, version and file it was read from instead.)
All six are regenerated together whenever any fixture changes; ports differ between runs (see "Why
every server binds port 0"), so a quote and its transcript must be re-synced in the same commit.

## Files

| File | What it establishes |
| --- | --- |
| `route-suite.mjs` | **Part 1.** Allocates one live DEST server and two *dead* proxy ports, then runs 45 numbered probes (`D1`–`D45`), each in its own `node` process with its own environment, execArgv and post-boot mutations. Prints one transcript. |
| `route-probe.mjs` | The client half of part 1. Prints the environment it booted with, each post-boot mutation it applied, the raw result, and a `VERDICT:` line computed mechanically from the outcome. |
| `run-all.sh` | **Part 2.** Starts DEST (http), DEST (https), an open proxy and an authenticating proxy, then runs the `L`- and `A`-numbered sections. Snapshots the proxy log around each section and prints that section's added lines directly underneath it. |
| `dest-server.mjs` | A plain-HTTP "internet target" process. Logs every request it receives. |
| `dest-server-https.mjs` | The same over TLS with a throwaway self-signed cert, for `HTTPS_PROXY` / CONNECT-tunnel probing. Takes the cert/key directory as an optional 4th argument — `run-all.sh` generates one fresh per run rather than committing it (see below). |
| `proxy-server.mjs` | A **real** forward proxy — handles both the classic absolute-form relay (`GET http://host/path HTTP/1.1` to the proxy) and `CONNECT host:port` tunnelling, logging which one it received. Given a 4th argument `user:pass` it demands `Proxy-Authorization: Basic …` and answers `407` otherwise, which is what makes proxy authentication a probe rather than a declared gap. |
| `client-fetch-probe.mjs` | The client half of part 2. `node client-fetch-probe.mjs <fetch\|http> <url>` drives either the global `fetch()` or the matching core `http`/`https` module, printing the env it sees and the result. |
| `probe-child-process-inherit.mjs` | Spawns `client-fetch-probe.mjs` via `child_process.spawn` with **no** `env` override, to establish the raw Node baseline that MCP's stdio transport allowlist (R-06) deliberately narrows away from. |
| `probe-raw-net-bypasses-proxy.mjs` | A bare `node:net` socket, to establish that `HTTP_PROXY`/`NODE_USE_ENV_PROXY` is a cooperative HTTP-client convention, not a network-layer control. |

## Why a *dead* proxy decides the route

The first draft of this fixture tree pointed `HTTP_PROXY` at the working proxy for every probe. Both
a proxied and a direct request then returned `200`, and the two were told apart by counting `CONNECT`
lines in a shared log at the end of the run. The fact-check called that inference rather than
observation, and it was right: the fixture proxy logs `CONNECT host:port` with no request path, so
per-request attribution was not actually observable.

`route-suite.mjs` fixes this structurally. It binds a socket, reads the port, closes it, and points
every proxy variable at that now-dead port. A request that is proxied dies with `ECONNREFUSED`; a
request that is not reaches the live DEST and returns `200 hello from DEST`. Both outcomes appear in
the probe process's own stdout, and `route-probe.mjs` prints the mapping as a `VERDICT:` line.

Probes about `NO_PROXY`'s *hostname* grammar need a name rather than an IP, so they aim at
`sub.r14-probe.invalid`. The `.invalid` TLD is reserved by RFC 2606 §2 and is guaranteed never to
resolve, which gives a second unambiguous pair: `ECONNREFUSED` means the request went to the proxy
(the name was never resolved), `ENOTFOUND` means it did not (this process resolved it and DNS said
no).

`run-all.sh` still uses a *live* proxy, because two questions genuinely need one — what the proxy
sees on the wire, and whether authentication is negotiated — but it no longer relies on
after-the-fact log correlation: `section`/`endsection` record the proxy log's line count before each
section and print exactly the lines that section added.

## Why no `.pem` file and no `undici` fixture is committed

Two things this fixture tree would naturally want to commit are deliberately absent, both for the
same kind of reason: this repository's own gates classify every tracked file, and a file (or an
import) that falls outside their known categories is a hard failure — correctly, per ADR-0032 and
the sibling classification gate in `apps/web/server/runs/store.test.ts` — not something this note's
`Owns:` globs (the R-14 note and `docs/research/fixtures/R-14/**`) can fix by editing the gate
itself, since the gate lives in `tests/`, owned by QA/Conformance.

* **No committed `cert.pem`/`key.pem`.** `store.test.ts`'s file-classification gate has a
  `MODULE_EXTENSIONS` set and a `NON_MODULE_EXTENSIONS` set and throws on anything in neither —
  `.pem` is in neither. `run-all.sh` generates a fresh throwaway cert into a `mktemp -d` directory
  on every run instead (three-day validity is plenty for a probe run).
* **No committed fixture that imports `undici` directly.** `tests/no-sdk-import.test.ts` (ADR-0032
  clause 1) hard-codes the exact set of packages any committed fixture may import as
  `PACKAGES_A_FIXTURE_INSTALLS_FOR_ITSELF = ['@modelcontextprotocol/sdk']` — a literal only
  QA/Conformance's own file can extend. Rather than commit a fixture that fails that gate or reach
  outside this note's `Owns:` globs to edit someone else's test, the note cites a **scratch,
  uncommitted** reproduction for the undici source reads:
  ```
  mkdir /tmp/r14-undici && cd /tmp/r14-undici
  npm init -y && npm install undici@7.29.0   # pinned to match process.versions.undici
                                              # on node:24.19.0-bookworm-slim
  # then read lib/dispatcher/env-http-proxy-agent.js and lib/dispatcher/proxy-agent.js
  ```
  Node's own half of the story needs no install at all and is cited by URL at the pinned tag —
  `https://raw.githubusercontent.com/nodejs/node/v24.19.0/lib/internal/http.js` and
  `.../lib/_http_agent.js`. Nothing in the note's Decisions table rests on either source read alone:
  every behavioural row is graded `verified` off a probe, and the source reads are graded
  `documented` and used only to explain *why* the probes came out as they did.

## Why every server binds port `0`

The authoring machine returns `EADDRINUSE` for a wide, seemingly arbitrary set of fixed high
ports (tried: `45001`–`45003`, `47101`–`47103`) even though neither `netstat -ano` nor
`Get-NetTCPConnection` shows any listener on them, and `netsh interface ipv4 show
excludedportrange` doesn't list them as reserved either — almost certainly a Hyper-V / WSL2 /
Docker Desktop dynamic port reservation that those tools don't surface. Binding port `0` (OS
picks a free ephemeral port) and reading the real port back from `server.address().port` sidesteps
this entirely and is what every fixture here does. `run-all.sh` collects the chosen ports through
small port files before starting the client-side probes; `route-suite.mjs` reads DEST's port from
its stdout and allocates its two dead ports by binding and immediately closing.

The consequence for the note: **port numbers differ on every run**, so a quoted block is only
correct against the transcript committed alongside it. Regenerate all four transcripts and re-copy
the quotes in the same commit, never retype them.

## Why three separate processes, never one

The first version of this proxy fixture ran the "proxy" and the "client" in the same Node
process (to keep the demo short) and set `process.env.HTTP_PROXY` before calling `fetch`. It hung
until timeout on every call. The cause: the *proxy's own* relay call (`http.request` to the real
destination, made from inside the proxy's request handler) inherited the same process's
`HTTP_PROXY`/`NODE_USE_ENV_PROXY`, so it was itself routed back through the proxy — infinitely.
Splitting DEST, PROXY, and the client into separate `node` processes (as every script here now does)
removes the recursion because each process's env-proxy configuration is independent. This is not a
Node quirk worth reporting upstream; it is a mistake in the *first draft of this fixture*, kept here
as a comment because the next person extending it will make the same one.

`route-suite.mjs` keeps DEST in its own process for the same reason, and additionally gives every
probe its own process because the enabling mechanisms under test — `NODE_USE_ENV_PROXY`,
`--use-env-proxy`, `NODE_OPTIONS` — are read during Node's bootstrap and cannot be changed afterwards
from inside a running process.

## Provenance

`verified` in the note means: the committed script was run on this host (and, for `route-suite.mjs`,
also inside `node:24.19.0-bookworm-slim`) against this Node version, and the transcript quoted in the
note is that run's actual stdout, not a paraphrase. Where a quote is abridged, the note says so and
the abridgement only ever removes whole lines — never alters one. The one deliberate exception is
quoted *source code*, where a block may be dedented to its own left margin and separate members of
one class joined into one block; every such block says so on its first line, and no character inside
a line is changed. Anything established by reading a
source file, a type definition or a specification is graded `documented`, never `verified`, per
§5.1 rule 4.

Retrieved 2026-09-05 against Node v24.19.0 (`process.versions.undici` = `7.29.0`) on Windows 11 and
in `node:24.19.0-bookworm-slim` under Docker 29.7.2 (`OSType=linux`). See the note's own
"Re-verify after" for the 90-day freshness deadline.

## The key in git history

Commit `0d903b4f1` briefly committed a `key.pem` here (removed one commit later, `0b064f134`). It
was generated for this fixture, protected nothing, and was never used for anything real, so it needs
no rotation. A full-history secret scan reports it; `.gitleaksignore` ignores that one fingerprint.
