# R-06 probe fixtures — MCP transports and authentication

Companion to the R-06 research note (maintained privately). Every row
in that note graded `verified` was produced by one of the scripts here. They are committed so the
claims can be re-run and audited by someone other than their author, and so W2-CP-05 inherits a
running reference implementation rather than a description of one.

## The deliverable

| File | What it is |
| --- | --- |
| `test-connection.mjs` | **The reference Test Connection.** `testConnection(config, {timeoutMs, baseEnv})` for stdio / http / sse, the `classify()` that turns a thrown error into exactly one tag, and `credentialConfiguredFor()` that decides whether a connector carries a credential. W2-CP-05 translates this to TypeScript. Written to ADR-0015: `classify()` ends in an explicit rejecting `else` rather than in a default tag, so an error shape it does not recognise comes back named as unrecognised instead of wearing the nearest tag. Two things must survive the translation — the **wall-clock deadline** over the whole probe (the SDK's per-request timeout does not bound the `sse` handshake) and the credential predicate being about a *credential* rather than about the presence of a header. Both were defects found by fact-checking the note, and both now have matrix cases. |

## Servers under test

Hand-rolled, not built on `@modelcontextprotocol/sdk`, so the probes control the exact bytes and
can produce each failure deliberately.

| File | What it does |
| --- | --- |
| `server-http.mjs` | Streamable HTTP MCP endpoint at `/mcp` behind `Authorization: Bearer <token>`. Also serves `/forbidden` (403), `/500` (an HTML error page), and `/hang` (accepts and never answers). `--log` records every request with its headers and body. `--protocol` makes it answer `initialize` with a chosen protocol version. |
| `server-sse.mjs` | Legacy HTTP+SSE MCP server (`GET /sse` → `event: endpoint`, `POST /messages`), same bearer gate. Also serves `/sse-blackhole` (accepts the GET and never writes a byte) and `/sse-no-endpoint` (opens a well-formed `200 text/event-stream` and never sends the `endpoint` event). Those two exist because neither can be bounded by the SDK's per-request timeout — see the note's §4.3. |
| `server-stdio.mjs` | stdio MCP server. `--mode ok|hang|exit|noise|slow|not-mcp`; `--require-env NAME=VALUE` models a credentialled stdio server; `--protocol` fixes the version it answers `initialize` with; `--report-env` smuggles the environment it was given back through `serverInfo.version`. |
| `server-deaf.mjs` | A stdio child that never answers, never exits on stdin EOF, and ignores `SIGTERM`. Forces the transport's whole shutdown ladder. |
| `server-spawner-linux.mjs`, `server-spawner.mjs` | A stdio "server" that is really a launcher: it forks a grandchild that holds the resources, then hangs. The `npx -y <server>` shape of spec §8's own example. |
| `server-env-report.mjs` | Not an MCP server. Prints the environment it was actually given, on stderr, and exits 3. |

## Probes

| File | What it establishes | Where it must run |
| --- | --- | --- |
| `probe-transports.mjs` | The raw failure matrix: what each transport throws for every failure mode, with the constructor, `code`, and cause chain. Transcripts: `transports-linux.json`, `transports-win32.json`. | either |
| `probe-wire.mjs` | The exact `initialize` request and headers the MCP SDK client sends, plus `LATEST_PROTOCOL_VERSION` / `SUPPORTED_PROTOCOL_VERSIONS`. | either |
| `scan-protocol-constants.mjs` | Which MCP protocol versions the shipped Agent SDK artefacts declare, derived rather than searched for. It admits an array literal holding an ISO-date string as one of its own members, then requires every member of that array to resolve to an ISO date — as a literal, or through a `var`/`let`/`const` binding in the same file — and rejects on stdout with exit 3 an admitted array it cannot resolve. Its arguments are directories: each is walked and every regular file under it is read, so the artefact set comes from the installed package. Its coverage limit — a list written entirely out of identifiers is never admitted, so it is never rejected either — is stated in the script's header comment and declared in the note's §6. Imports nothing. No committed transcript: its output is quoted in the note's §6 and it is meant to be re-run against whatever version of the SDK is installed. | either |
| `inspect-err.mjs` | The three ambiguous error shapes, dumped field by field: a client timeout vs a server-sent `-32001`, and an `SseError` with no structured errno. Also prints `DEFAULT_INHERITED_ENV_VARS`. Transcripts: `inspect-err-linux.txt`, `inspect-err-win32.txt`. | both — the allowlist differs by platform |
| `probe-stdio-env.mjs` | What environment a stdio MCP server actually receives, on **both** clients: the allowlist `StdioClientTransport` gives it versus the runner's whole environment the Agent SDK gives it. Transcripts: `stdio-env-linux.txt`, `stdio-env-win32.txt`. **The Agent SDK half makes one live model call.** | both — the allowlist differs by platform |
| `probe-classify.mjs` | Runs `test-connection.mjs` over the whole matrix, checks each case against the tag it declares it should produce, asserts the timing, and exits non-zero on any miss. **This is the evidence that wrong-URL and wrong-token come out different, and that the probe returns at all.** Prints nothing measured, so its output is byte-stable. Transcripts: `classify-linux.txt`, `classify-win32.txt`. | both — one row's answer differs |
| `probe-hang.mjs` | The hung-stdio-child lifecycle on the host platform. Transcript: `hang-win32.txt`. | either |
| `probe-linux-tree.mjs` | The same on Linux, plus the launcher/grandchild case and the process-group kill that fixes it. Transcript: `linux-tree.txt`. | Linux only (reads `/proc`), **and only from `/probe`** — see Reproducing |
| `probe-reap.mjs` | `testConnection()` against a launcher-shaped server: the grandchild it leaks, and the wrapper that reaps it. Transcript: `reap-linux.txt`. | Linux only, **and only from `/probe`** |
| `probe-agent-sdk-status.mjs` | What `Query.mcpServerStatus()` reports for connected / rejected / unreachable / hung servers. Transcript: `agent-sdk-status.json`. **Makes one live model call and costs money.** | either |
| `probe-authz.mjs` | 401 with a credential vs 401 with none vs 403, on both clients — and the unattended OAuth discovery the Agent SDK performs when no `Authorization` header is configured. Transcript: `agent-sdk-authz.txt`. **One live model call.** | either |
| `probe-mismatch.mjs` | Every pairing of the two remote transports with the two remote endpoint shapes. Transcript: `agent-sdk-mismatch.txt`. **One live model call.** | either |

## Which transcripts are baselines and which are readings

A **baseline** prints nothing measured, so a clean container reproduces it byte for byte and any
drift is a `diff`. A **captured reading** holds pids, elapsed milliseconds, absolute paths, ports or
a live SDK's prose; re-running it reproduces the substance, never the bytes. Which file is which is
not written out here as a list of names — the snippet below assigns the class, by shape, to every
tracked file in this directory, and **stops on a file it cannot classify** rather than letting it
fall out of the listing (ADR-0027), so a transcript added later in an extension nobody thought of
shows up as a failure and not as an absence.

The same loop answers the other question the bytes cannot: "is this file a run of the code beside
it?" That cannot be settled by re-running a reading, and it is not uniform across the set, so it is
answered per file out of the history — `d5909e7` is this note's first commit, and the label says
only whether the file has changed since it, because which later round touched it is not something
`git diff` between two points can say:

```sh
set -e
for f in $(git ls-files -- 'docs/research/fixtures/R-06-mcp/*'); do
  case "${f##*/}" in
    README.md)      class=doc ;;
    *.mjs)          class=code ;;
    classify-*.txt) class=baseline ;;
    *.txt|*.json)   class=reading ;;
    *) echo "UNCLASSIFIED $f — classify it before trusting this listing"; exit 3 ;;
  esac
  case "$class" in baseline|reading) ;; *) continue ;; esac
  if git diff --quiet d5909e7 HEAD -- "$f"
    then echo "unchanged-since-d5909e7  $class  $f"
    else echo "changed-since-d5909e7    $class  $f"
  fi
done
```

It prints `unchanged-since-d5909e7` for `stdio-env-linux.txt` and `stdio-env-win32.txt`, and for
nothing else. Those, and `probe-stdio-env.mjs` which produced them, each have a single commit
(`git log --oneline -- <those paths>` prints only `d5909e7`) and are byte-identical to it: the probe
was not changed by the repair and the readings were not re-taken, because the Agent SDK half costs
one live model call. Read them as readings of the probe as committed, which is the probe as it
stands. Everything the loop marks `changed-since-d5909e7` was last written by one later commit,
`6dfb29d` — verification round 1's repair, which re-ran the probes and captured them fresh. Read
that off `git log --oneline -- <path>` rather than off this listing: a two-point `git diff` cannot
say which round touched a file, which is why the labels name the commit they compare against.

### Reading `agent-sdk-authz.txt`'s third section

Its header says `== requests the Agent SDK made ==`, and that is narrower than what follows.
`probe-authz.mjs` spawns `server-http.mjs` with `--log` at its top level, before the
`await mcpSdk(...)` calls; at the end it replays the whole log file, so the section is **every**
request the server received during the run, both clients' included. The requests before the first
`server-discover-probe-1` are the `@modelcontextprotocol/sdk` half's — they repeat the cases of
the transcript's own first section, in the same order and against the same route and header. The
Agent SDK's requests are the ones from that first `server/discover` onwards. The header string is
left as it was captured so the file stays a faithful reading of `probe-authz.mjs` as committed;
re-taking it costs one live model call.

The replay gives every record in the log a verdict: `request` is printed, `response` is skipped as
the server's own half of the exchange, and a record of any other `kind` stops the replay with exit
3 instead of falling out of the section. `server-http.mjs`, the server this probe points `--log` at,
writes only those two kinds (`grep -n "log({ kind" server-http.mjs`), so the committed transcript is
unaffected by that branch; `server-sse.mjs` writes a third, which is what the branch is for.

## Reproducing

```sh
mkdir probe-r06 && cd probe-r06
cp <this-dir>/*.mjs .
npm init -y
npm install @anthropic-ai/claude-agent-sdk@0.3.258 @modelcontextprotocol/sdk@1.30.0
node probe-classify.mjs        # self-checking; exits 0 iff every case produced its expected tag
node probe-transports.mjs      # the raw failure matrix behind it
```

Copy the scripts into a directory that has its own `node_modules` — `NODE_PATH` does not resolve
bare specifiers for ES modules, so pointing at an installation elsewhere silently fails with
`ERR_MODULE_NOT_FOUND`.

`probe-classify.mjs` needs no credentials and calls no model. It prints no measured quantity, so
its output is stable: this exact command in a clean `node:24-bookworm-slim` container reproduces
the committed `classify-linux.txt` **byte for byte**, and that is the check to run first.

```sh
docker run --rm -v "$PWD:/fixtures:ro" node:24-bookworm-slim sh -c '
  mkdir -p /work && cp /fixtures/*.mjs /work/ && cd /work
  npm init -y >/dev/null && npm install @modelcontextprotocol/sdk@1.30.0 >/dev/null
  node probe-classify.mjs > out.txt; echo "EXIT=$?"
  diff out.txt /fixtures/classify-linux.txt'
```

Expected: `EXIT=0` and no `diff` output.

`probe-linux-tree.mjs` and `probe-reap.mjs` read `/proc` and must run on Linux — **but not with the
container shape above.** Both hardcode absolute `/probe/…` paths for the servers they launch and,
in `probe-reap.mjs`, for the module its detached runner imports. Copied to `/work` they start no
server at all: every case comes back `McpError -32000: Connection closed` almost immediately
instead of the documented `-32001 Request timed out`, and the run then dies on
`ENOENT: /tmp/grandchild.pid`. A reader who followed the `/work` shape would conclude the note's §5
does not reproduce. Copy them to `/probe`:

```sh
docker run --rm -v "$PWD:/fixtures:ro" node:24-bookworm-slim sh -c '
  mkdir -p /probe && cp /fixtures/*.mjs /probe/ && cd /probe
  npm init -y >/dev/null && npm install @modelcontextprotocol/sdk@1.30.0 >/dev/null
  node probe-linux-tree.mjs
  node probe-reap.mjs'
```

Expected: three `Request timed out` rows with `"grandchildAlive":true` on the launcher row and a
process-group kill that clears it, then `reap-linux.txt`'s two halves. The pids and the `ms`
readings differ every run — those two files are captured readings, not baselines.

`probe-agent-sdk-status.mjs`, `probe-authz.mjs`, `probe-mismatch.mjs` and the Agent SDK half of
`probe-stdio-env.mjs` need working Claude Code credentials and each makes **one live API call that
costs money**. Read them before running them.

`scan-protocol-constants.mjs` is the exception to all of the above: it starts no server, imports
nothing, and needs no install of its own. Point it at the installed **package directories**, not at
files inside them — it walks each argument and reads every regular file under it, so the artefact
set is whatever the package ships. From the repository root:

```sh
node docs/research/fixtures/R-06-mcp/scan-protocol-constants.mjs \
  node_modules/.pnpm/@anthropic-ai+claude-agent-*/node_modules/@anthropic-ai/claude-agent-sdk \
  node_modules/.pnpm/@anthropic-ai+claude-agent-sdk-win32-x64@*/node_modules/@anthropic-ai/claude-agent-sdk-win32-x64
```

The win32 package is an optional dependency and is absent on Linux; the second argument may be
omitted there. Exit 0 means every array it admitted was resolved; exit 3 means at least one was not,
and the rejected arrays are named on stdout above the `FAIL` line.

## Four of these probes import the Agent SDK, and the §42 gate permits them by shape

`probe-agent-sdk-status.mjs`, `probe-authz.mjs`, `probe-mismatch.mjs` and `probe-stdio-env.mjs`
import `@anthropic-ai/claude-agent-sdk`. `tests/no-sdk-import.test.ts` enforces spec §42 over the
whole tracked tree and permits `apps/runner/src/claude.ts` plus a research-probe set that it
**derives from the tracked tree by shape** (ADR-0027, landed by W2-INT-01): a tracked `.mjs` under
`docs/research/fixtures/` is a probe and is permitted; an inert capture needs no permit; anything
else at that path is a named failure rather than a silent drop.

An earlier revision of this file described the gate as carrying a hard-coded `RESEARCH_PROBES`
literal that named only R-01's three scripts, and recorded that this branch went red on it and that
a research PR was forbidden to edit it. That is no longer the shape of the gate. The four scripts
above are permitted because they are `.mjs` files at that path, with nothing to add to any list;
the transcripts beside them (`.txt`, `.json`, this `README.md`) classify as inert captures and are
not permitted, which costs them nothing because they reference no module.

The practical constraint that leaves on this directory: **a new probe must be `.mjs`.** A `.js`
here would be CommonJS the moment a reader copies it to the scratch directory the Reproducing
section asks for, and a `.ts` belongs to no `tsconfig` in this repository — the gate rejects both by
name rather than quietly leaving them out of the permit. The gate's own header explains why.

Deleting the four SDK-importing scripts to avoid the question was rejected when the gate was a
literal and stays rejected now. They are the only executable evidence for the note's §2 (the
environment the Agent SDK gives a stdio server), §4.6 (`mcpServerStatus()`'s error strings), §6
(the `initialize` request captured on the wire) and §7 (both hazards). Removing evidence to turn a
gate green is the failure the development plan §0 rule 2 exists to forbid.

Nothing else in this directory imports the Agent SDK: `test-connection.mjs` — the file W2-CP-05
actually copies — and `probe-classify.mjs`, which produces the note's central evidence, use only
`@modelcontextprotocol/sdk`.

## What is committed, and what is deliberately not

**Committed.** Every transcript the note grades a claim `verified` on. `classify-linux.txt` and
`classify-win32.txt` (the failure matrix), `transports-linux.json` and `transports-win32.json` (the
raw error shapes behind the note's §4.2 discriminator column), `inspect-err-linux.txt` and
`inspect-err-win32.txt` (the `data.timeout` discriminator and the transport's environment
allowlist), `linux-tree.txt`, `reap-linux.txt` and `hang-win32.txt` (process lifecycle),
`stdio-env-linux.txt` and `stdio-env-win32.txt` (the environment a stdio server gets), and the three
live-Agent-SDK transcripts `agent-sdk-status.json`, `agent-sdk-authz.txt` and
`agent-sdk-mismatch.txt`. Most of those were added in verification round 1: without them, four of
the error strings the note quotes verbatim in §4.6 and §7.2, and every structural discriminator in
§4.2, existed in no artefact any reader could open — and a `verified` grade nobody can re-check is
not a grade. They contain loopback addresses, pids, absolute paths, the fixtures' own throwaway
token `s3cret`, and the SDK's own prose — no real credential, hostname or account identifier.

`agent-sdk-status.json` includes the `config.headers` echo that §7.1 of the note is *about*. It is
committed deliberately: the hazard is that the SDK returns the credential in cleartext, and the
evidence for a hazard has to be the thing itself.

**Not committed.** The raw `.jsonl` wire logs the probes write (`wire-http.jsonl`,
`authz-wire.jsonl`, `agent-sdk-wire.jsonl`). They hold every request header verbatim, and although
today's are the fixtures' own `s3cret`, a committed file of that *shape* invites someone to commit a
real one later. Re-running the probes regenerates them. Where the note quotes a wire body it says so
and marks the quotation `documented` rather than `verified`, because the reader has the
transcription and not the file — §6's `initialize` block is the case. The summarised request log
inside `agent-sdk-authz.txt` is committed, truncated at 70 characters per line.
