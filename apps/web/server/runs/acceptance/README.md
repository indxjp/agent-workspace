# W1-CP-04 acceptance — a ten-minute SSE stream through a real nginx, with a real reconnect

> **ACCEPT:** a ten-minute SSE stream survives an nginx proxy without buffering, and a client
> reconnect replays from `Last-Event-ID` — both demonstrated with real output.

Everything in this directory exists to execute that sentence. It is a probe fixture, not product
code, and nothing under `apps/web` imports it.

## Run it

```sh
cd apps/web
SESSION_SECRET=$(head -c48 /dev/urandom | base64) node server/runs/acceptance/run-acceptance.mjs                            # /stock/, ~11 minutes
SESSION_SECRET=$(head -c48 /dev/urandom | base64) node server/runs/acceptance/run-acceptance.mjs --location tuned --no-build
```

Requires Docker (it pulls `nginx:1.29-alpine`), free ports 3111, 3112 and 8099, and a `SESSION_SECRET`
in the environment — the same variable `apps/web/server/auth/session.ts` reads, at least 32
characters. `middleware.ts` (W1-CP-06) refuses every `/api/**` request with none, so the script
mints a session token under this exact secret and attaches it to every request it makes; see
`docs/adr/W1-CP-04b-the-acceptance-harness-authenticates-with-a-real-signed-cookie.md`. Exit code 0
means every assertion passed; the script prints one `PASS`/`FAIL` line per assertion and a
machine-readable `RESULT {…}` line at the end.

## What it actually starts

```text
  probe client ──HTTP──▶ nginx:1.29-alpine ──HTTP──▶ next start (production build)
  (fetch + its own                :8099                      :3111
   SSE parser)                                                 │
                                                               │ relay: fetch POST /run
                                                               ▼
                                                      fake-runner.mjs :3112
                                                      (a §14.3-shaped runtime)
```

* **`next start`, never `next dev`.** A stream verified against a dev server proves nothing about a
  production build.
* **The probe's SSE client is written in `run-acceptance.mjs`, not imported from `relay.ts`.** A
  probe that reuses the server's own parser cannot detect a bug the two share.
* **`fake-runner.mjs` imports no Anthropic package.** Spec §42 makes `apps/runner/src/claude.ts` the
  only file that may import the Agent SDK, and a probe fixture is not an exception to it. The real
  runtime is W1-RN-02's.

## The two nginx locations, and why there are two

`nginx.conf` serves the same upstream twice.

| Location | Configuration | What a pass means |
| --- | --- | --- |
| `/stock/` | nginx's own defaults: `proxy_buffering on`, `proxy_read_timeout 60s`, `gzip on` with the default `gzip_types` | the stream survives an nginx **nobody configured for SSE**, purely because the 15 s keep-alive of `sse.ts` clears the 60 s idle timeout |
| `/tuned/` | the block R-13's contract summary prescribes for spec §33's self-hosted Compose deployment | the configuration we intend to ship also works |

`/stock/` is the load-bearing one. R-13 marked the 15 s keep-alive interval **`inferred`** — it
probed 1 s (survived 620 s) and 70 s of silence (killed at ~60 s), and never ran 15 s itself. This
run is the first execution of the value the code actually ships.

The runtime's event schedule is chosen to make that falsifiable: one event per second for the first
30 s (a dense phase, so the reconnect has a tight id sequence to be checked against), then one event
every 30 s for the rest. A 30-second silence is half of nginx's stock 60 s `proxy_read_timeout`, so
the stream only survives if the keep-alive comments are genuinely reaching the client.

`aw-host` is **chosen by trying it**, not by picking a spelling. The script probes each candidate —
`host-gateway`, then the bridge network's IPv4 gateway — from inside a throwaway container of the
same image, and uses the first one that actually fetches a page from the upstream; if none does it
stops and reports every candidate it tried. Both candidates failed here at least once:
`host-gateway` resolves to IPv6 on this Docker Desktop host, which is the false positive R-13
records, and the bridge IPv4 gateway answered 502 because it is the Docker VM's gateway rather than
the Windows host.

## What the run proves, and what it does not

Proven, by executed output:

* a 200 `text/event-stream` reaches a client through nginx, ungzipped, with `Transfer-Encoding:
  chunked`;
* chunks arrive at the producer's cadence — no proxy buffering;
* keep-alive comments cross the proxy and no inter-chunk gap approaches the stock 60 s timeout;
* the stream runs past ten minutes and ends with a `done` frame rather than being cut;
* a client that disconnects mid-run and reconnects with `Last-Event-ID: N` receives `N+1` first,
  contiguously, with no duplicate of what it already had;
* `GET /api/runs/:id` afterwards reports the run `completed`.

**Not** proven, and not claimed anywhere:

* **This harness's durability.** The probe deliberately uses `InMemoryRunStore`, so it verifies
  replay *within one server process* and does not exercise restart or cross-replica recovery. The
  production repository adapter persists and polls `run_events`; the historical in-process
  decision in `docs/adr/W1-CP-04-run-events-are-in-process-in-wave-1.md` is superseded.
* **A browser.** The probe client is `fetch`-based. R-13 verified that Chrome 152 and undici's
  `EventSource` send `Last-Event-ID` on their own automatic reconnects; this run verifies that the
  *server* replays correctly from it. Nothing here re-verifies the browsers.
* **Authentication, beyond the gate.** The request must carry a session cookie that verifies under
  the real `SESSION_SECRET` — that is W1-CP-06's real middleware, enforced for real, and this run
  is the proof it does not block a legitimate signed-in request. What is still a stub is *behind*
  that gate: `instrumentation.ts` in this directory authorizes every request that clears it as the
  same fixed principal, regardless of which workspace or account the cookie's claims name. The 401
  path (no cookie, or one that fails verification) has unit tests; the fine-grained authorization
  path (a verified session naming a workspace this account is not a member of) is W1-CP-06's, not
  this harness's.
* **Any proxy other than this one.** One nginx version, one host, one operating system — the same
  bound R-13 states for its own figures.
* **The `run-failed` path.** The acceptance run's run succeeds, so the stream it measures ends
  with `done` and no `run-failed` frame. The failing outcomes — a run whose runtime is unreachable,
  and a stream that breaks while producing frames — are covered by unit tests in `api.test.ts` and
  `sse.test.ts`, not by anything that crossed nginx.
* **The `stream-reset` path.** No eviction happens in ten minutes at this cadence; that path is
  covered by unit tests over an `InMemoryRunStore` whose retention cap is smaller than the number
  of events those tests append, which is what makes the eviction the assertion is about happen.
  `store.test.ts` covers the store's own notice, `api.test.ts` covers the frame that reaches a
  client. Neither cap is quoted here: read it from the `maxEventsPerRun` those tests construct.

## The one file this script temporarily overwrites

`register()` has to be reached through a root `apps/web/instrumentation.ts`. That path is
**outside this task's ownership globs** — W1-COMP-01 owns and commits the real one, the
application's actual composition root. This harness's `register()` (in `instrumentation.ts`,
beside this README) is a different, acceptance-only implementation that authenticates every
request that clears the middleware, and it has to be the one `apps/web/instrumentation.ts`
re-exports while the probe runs, or the real composition root's database-backed wiring runs
instead and the probe needs a seeded PostgreSQL database it does not set up.

So `run-acceptance.mjs` **saves whatever is at `apps/web/instrumentation.ts` before it starts** —
the real composition root, nothing at all, or a concurrent session's uncommitted work — writes its
own one-line re-export in its place, and **restores the saved bytes exactly, in a `finally`**, once
the run ends. Nothing is deleted unless nothing was there to begin with.

The temporary file's exact bytes are **not** reproduced here. They are the string literal passed to
`writeFileSync` in `run-acceptance.mjs`, which is the copy that is actually written, and therefore
the only one that cannot drift away from what the probe does. An earlier revision of this README
quoted the re-export line under the words "the whole of its content is", and the quotation was
already two lines short of the file by the time anyone checked.

If a run is killed hard (`SIGKILL`, or anything that skips the script's own `finally`),
`apps/web/instrumentation.ts` is left holding the harness's temporary stub. Restore the real file
with `git checkout -- apps/web/instrumentation.ts` before committing anything — not `rm`, which
would delete a file this task does not own and cannot recreate.

The location flag is `--location stock|tuned`, not `--path /stock/`, because Git Bash on Windows
rewrites an argument that looks like an absolute POSIX path: `/stock/` arrived as
`C:/Program Files/Git/stock/`, and two ten-minute runs failed at the nginx readiness check before
the error message was widened enough to say so.

## Two bugs this run found that no unit test did

Recorded because they are the argument for running the real thing rather than trusting the suite.

1. **The connect timeout was a run timeout.** `launcher.ts` passed `AbortSignal.timeout(ms)` into
   `fetch`; that signal stays attached to the response body, so a perfectly healthy ten-minute
   stream failed at exactly thirty seconds. Fixed, and now covered by a unit test that only exists
   because the long run pointed at it.
2. **Next.js gives `instrumentation.ts` and the route handlers separate module graphs.** The harness
   logged that it had installed the run API while, in the same process, the routes answered
   `503 run_api_not_configured`. The registry moved to `globalThis`; see
   `docs/adr/W1-CP-04-run-api-is-installed-not-imported.md`.
