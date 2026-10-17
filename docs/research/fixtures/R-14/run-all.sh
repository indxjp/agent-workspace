#!/usr/bin/env bash
# R-14 fixture, part 1 of 2 — the LIVE-PROXY suite. Reproduces every `L`- and `A`-numbered probe
# quoted in ../../R-14-node-runtime-proxy.md. Run from this directory: `bash run-all.sh`.
# Requires Node (tested against v24.19.0, the exact version pinned in the repo's Dockerfile /
# compose.yaml), a POSIX shell (git-bash on Windows is what this was authored and run on) and
# `openssl` for the throwaway HTTPS cert.
#
# Part 2 is `route-suite.mjs` — the DEAD-PROXY suite, pure Node with no shell and no openssl, which
# is what runs inside `node:24.19.0-bookworm-slim`. Anything that only needs to establish WHICH
# ROUTE a request took belongs there, because a dead proxy makes the two routes produce different
# outcomes in the client's own output. This file exists for the questions a dead proxy cannot
# answer: what a real proxy actually SEES on the wire (absolute-form vs CONNECT), and whether proxy
# authentication is negotiated.
#
# Per-section proxy-log deltas. The first draft of this fixture printed the whole proxy log once at
# the end and attributed lines to sections by counting them; the fact-check called that inference
# rather than observation, and it was right. Every section below now snapshots the proxy log's line
# count before it runs and prints exactly the lines the section added, immediately underneath the
# client's own output. What the note quotes is that delta.
#
# All fixture servers bind port 0 (OS-assigned) and report their actual port through a tiny file —
# see "Why port 0" in README.md: a wide, seemingly arbitrary range of high ports on the authoring
# machine returns EADDRINUSE for a fixed `listen()` even though no listener shows in
# `netstat`/`Get-NetTCPConnection` (Hyper-V / WSL2 / Docker Desktop dynamic port reservation), so
# hard-coding a port number is not reliable here.
#
# Fixture processes never share a Node process with each other or with the client under test: DEST
# (a plain-HTTP or self-signed-HTTPS "internet" target), PROXY (a real forward proxy handling both
# absolute-form relay and CONNECT tunnelling), PROXY-AUTH (the same proxy demanding Basic
# credentials), and the client. This separation matters — see "Why three separate processes" in
# README.md: if the client and the proxy share one process's env, the proxy's own outbound relay
# call recurses back into itself and hangs.
#
# HTTP_PROXY / HTTPS_PROXY / NODE_USE_ENV_PROXY are exported at the shell level, before `node`
# starts, in every case below except the explicit controls.
set -u
cd "$(dirname "$0")"

WORKDIR=$(mktemp -d)
DEST_HTTP_PORTFILE="$WORKDIR/dest-http.port"
DEST_HTTPS_PORTFILE="$WORKDIR/dest-https.port"
PROXY_PORTFILE="$WORKDIR/proxy.port"
PROXY_AUTH_PORTFILE="$WORKDIR/proxy-auth.port"
PROXY_CREDS="r14user:r14pass"

# A throwaway self-signed cert for dest-server-https.mjs, generated fresh into $WORKDIR rather
# than committed: a committed `.pem` file has no recognised classification in this repository's
# module-graph self-test (`tests/no-sdk-import.test.ts`'s sibling gate in
# `apps/web/server/runs/store.test.ts` — neither MODULE_EXTENSIONS nor NON_MODULE_EXTENSIONS lists
# `.pem`, and that gate is owned by QA/Conformance, not this note), so generating it here avoids
# introducing an unclassified tracked file. Requires `openssl` (present via git-bash on the
# authoring machine).
#
# `node:24.19.0-bookworm-slim` ships no `openssl` binary, so when this script is run inside the
# pinned runtime image the HTTPS half cannot start. That is detected and reported rather than
# silently skipped, and the HTTP and proxy-authentication halves still run there — see
# transcript-linux-live.txt.
if command -v openssl >/dev/null 2>&1; then
  HAVE_OPENSSL=yes
  openssl req -x509 -newkey rsa:2048 -keyout "$WORKDIR/key.pem" -out "$WORKDIR/cert.pem" \
    -days 3 -nodes -subj "//CN=127.0.0.1" >/dev/null 2>&1
else
  HAVE_OPENSSL=no
fi

wait_for_port() { # $1 = portfile
  for _ in $(seq 1 50); do
    [ -s "$1" ] && return 0
    sleep 0.1
  done
  echo "TIMED OUT waiting for $1" >&2
  return 1
}

# --- per-section proxy-log delta ------------------------------------------------------------
# LOGFILE is whichever proxy the current section points at; section() records its line count and
# endsection() prints only the lines that appeared while the section ran.
LOGFILE="$WORKDIR/proxy.log"
MARK=0
section() {
  echo
  echo "### $1 ###"
  MARK=$(wc -l < "$LOGFILE" | tr -d ' ')
}
endsection() {
  echo "--- proxy log lines added by this section (from $(basename "$LOGFILE")) ---"
  tail -n "+$((MARK + 1))" "$LOGFILE" | sed 's/^/    /'
  local added
  added=$(( $(wc -l < "$LOGFILE" | tr -d ' ') - MARK ))
  [ "$added" -eq 0 ] && echo "    (none — the proxy was never contacted for this section)"
  return 0
}

node dest-server.mjs 0 "$DEST_HTTP_PORTFILE" > "$WORKDIR/dest-http.log" 2>&1 &
DEST_HTTP_PID=$!
if [ "$HAVE_OPENSSL" = yes ]; then
  node dest-server-https.mjs 0 "$DEST_HTTPS_PORTFILE" "$WORKDIR" > "$WORKDIR/dest-https.log" 2>&1 &
  DEST_HTTPS_PID=$!
else
  DEST_HTTPS_PID=""
fi
node proxy-server.mjs 0 "$PROXY_PORTFILE" > "$WORKDIR/proxy.log" 2>&1 &
PROXY_PID=$!
node proxy-server.mjs 0 "$PROXY_AUTH_PORTFILE" "$PROXY_CREDS" > "$WORKDIR/proxy-auth.log" 2>&1 &
PROXY_AUTH_PID=$!

wait_for_port "$DEST_HTTP_PORTFILE"
[ "$HAVE_OPENSSL" = yes ] && wait_for_port "$DEST_HTTPS_PORTFILE"
wait_for_port "$PROXY_PORTFILE"
wait_for_port "$PROXY_AUTH_PORTFILE"

DEST_HTTP_PORT=$(cat "$DEST_HTTP_PORTFILE")
DEST_HTTPS_PORT=$([ "$HAVE_OPENSSL" = yes ] && cat "$DEST_HTTPS_PORTFILE" || echo "-")
PROXY_PORT=$(cat "$PROXY_PORTFILE")
PROXY_AUTH_PORT=$(cat "$PROXY_AUTH_PORTFILE")
PROXY_URL="http://127.0.0.1:$PROXY_PORT"
PROXY_AUTH_URL_NOCREDS="http://127.0.0.1:$PROXY_AUTH_PORT"
PROXY_AUTH_URL="http://$PROXY_CREDS@127.0.0.1:$PROXY_AUTH_PORT"

echo "node=$(node -v)  platform=$(node -p process.platform)"
echo "DEST(http)=127.0.0.1:$DEST_HTTP_PORT  DEST(https)=127.0.0.1:$DEST_HTTPS_PORT"
if [ "$HAVE_OPENSSL" != yes ]; then
  echo "NOTE: \`openssl\` is NOT on PATH here (\`command -v openssl\` found nothing), so no"
  echo "      self-signed cert could be generated and every HTTPS section below is SKIPPED."
  echo "      This is what happens inside node:24.19.0-bookworm-slim, which ships no openssl."
fi
echo "PROXY(open)=$PROXY_URL  PROXY(auth, $PROXY_CREDS)=$PROXY_AUTH_URL_NOCREDS"

# ============================ WIRE PROTOCOL AND ENABLING MECHANISMS ==========================

section "L1. fetch + NODE_USE_ENV_PROXY=1 env var, plain-http target"
HTTP_PROXY=$PROXY_URL NODE_USE_ENV_PROXY=1 node client-fetch-probe.mjs fetch "http://127.0.0.1:$DEST_HTTP_PORT/L1"
endsection

section "L2. http.get + NODE_USE_ENV_PROXY=1 env var, plain-http target"
HTTP_PROXY=$PROXY_URL NODE_USE_ENV_PROXY=1 node client-fetch-probe.mjs http "http://127.0.0.1:$DEST_HTTP_PORT/L2"
endsection

section "L3. fetch + --use-env-proxy CLI flag (no env var)"
HTTP_PROXY=$PROXY_URL node --use-env-proxy client-fetch-probe.mjs fetch "http://127.0.0.1:$DEST_HTTP_PORT/L3"
endsection

section "L4. http.get + --use-env-proxy CLI flag"
HTTP_PROXY=$PROXY_URL node --use-env-proxy client-fetch-probe.mjs http "http://127.0.0.1:$DEST_HTTP_PORT/L4"
endsection

section "L5. fetch + NODE_OPTIONS=--use-env-proxy (no env var, no CLI flag on the command line)"
HTTP_PROXY=$PROXY_URL NODE_OPTIONS=--use-env-proxy node client-fetch-probe.mjs fetch "http://127.0.0.1:$DEST_HTTP_PORT/L5"
endsection

section "L6. http.get + NODE_OPTIONS=--use-env-proxy"
HTTP_PROXY=$PROXY_URL NODE_OPTIONS=--use-env-proxy node client-fetch-probe.mjs http "http://127.0.0.1:$DEST_HTTP_PORT/L6"
endsection

section "L7. CONTROL — fetch, HTTP_PROXY set, no flag / no env var at all"
HTTP_PROXY=$PROXY_URL node client-fetch-probe.mjs fetch "http://127.0.0.1:$DEST_HTTP_PORT/L7"
endsection

section "L8. CONTROL — http.get, HTTP_PROXY set, no flag / no env var at all"
HTTP_PROXY=$PROXY_URL node client-fetch-probe.mjs http "http://127.0.0.1:$DEST_HTTP_PORT/L8"
endsection

if [ "$HAVE_OPENSSL" = yes ]; then
  section "L9. fetch, HTTPS target via HTTPS_PROXY + NODE_USE_ENV_PROXY=1"
  HTTPS_PROXY=$PROXY_URL NODE_USE_ENV_PROXY=1 NODE_TLS_REJECT_UNAUTHORIZED=0 node client-fetch-probe.mjs fetch "https://127.0.0.1:$DEST_HTTPS_PORT/L9"
  endsection
else
  echo
  echo "### L9 — SKIPPED: no openssl on PATH, so there is no HTTPS destination here ###"
fi

if [ "$HAVE_OPENSSL" = yes ]; then
  section "L10. https.get, HTTPS target via HTTPS_PROXY + NODE_USE_ENV_PROXY=1"
  HTTPS_PROXY=$PROXY_URL NODE_USE_ENV_PROXY=1 NODE_TLS_REJECT_UNAUTHORIZED=0 node client-fetch-probe.mjs http "https://127.0.0.1:$DEST_HTTPS_PORT/L10"
  endsection
else
  echo
  echo "### L10 — SKIPPED: no openssl on PATH, so there is no HTTPS destination here ###"
fi

if [ "$HAVE_OPENSSL" = yes ]; then
  section "L11. CONTROL — fetch, HTTPS target, HTTPS_PROXY set but no NODE_USE_ENV_PROXY"
  HTTPS_PROXY=$PROXY_URL NODE_TLS_REJECT_UNAUTHORIZED=0 node client-fetch-probe.mjs fetch "https://127.0.0.1:$DEST_HTTPS_PORT/L11"
  endsection
else
  echo
  echo "### L11 — SKIPPED: no openssl on PATH, so there is no HTTPS destination here ###"
fi

section "L12. NO_PROXY exact match on 127.0.0.1 -> bypasses the proxy"
HTTP_PROXY=$PROXY_URL NO_PROXY=127.0.0.1 NODE_USE_ENV_PROXY=1 node client-fetch-probe.mjs fetch "http://127.0.0.1:$DEST_HTTP_PORT/L12"
endsection

section "L13. NO_PROXY set to a non-matching host -> still proxies"
HTTP_PROXY=$PROXY_URL NO_PROXY=example.com NODE_USE_ENV_PROXY=1 node client-fetch-probe.mjs fetch "http://127.0.0.1:$DEST_HTTP_PORT/L13"
endsection

section "L14. child_process.spawn with NO env override inherits HTTP_PROXY/NODE_USE_ENV_PROXY"
HTTP_PROXY=$PROXY_URL NODE_USE_ENV_PROXY=1 node probe-child-process-inherit.mjs "$DEST_HTTP_PORT" "$PROXY_PORT"
endsection

section "L15. SECURITY-BOUNDARY CHECK — raw node:net socket, HTTP_PROXY + NODE_USE_ENV_PROXY=1 both set"
HTTP_PROXY=$PROXY_URL NODE_USE_ENV_PROXY=1 node probe-raw-net-bypasses-proxy.mjs "$DEST_HTTP_PORT"
endsection

# ================================== PROXY AUTHENTICATION ====================================
# These sections point at PROXY-AUTH, which answers 407 unless the request carries a matching
# `Proxy-Authorization: Basic ...` header. Credentials travel only as the proxy URL's userinfo —
# nothing else is configured — so a 200 here proves Node derived and sent the header itself.
LOGFILE="$WORKDIR/proxy-auth.log"

section "A1. fetch through an AUTHENTICATING proxy, NO credentials in the proxy URL"
HTTP_PROXY=$PROXY_AUTH_URL_NOCREDS NODE_USE_ENV_PROXY=1 node client-fetch-probe.mjs fetch "http://127.0.0.1:$DEST_HTTP_PORT/A1"
endsection

section "A2. fetch through an AUTHENTICATING proxy, credentials as userinfo in HTTP_PROXY"
HTTP_PROXY=$PROXY_AUTH_URL NODE_USE_ENV_PROXY=1 node client-fetch-probe.mjs fetch "http://127.0.0.1:$DEST_HTTP_PORT/A2"
endsection

section "A3. http.get through an AUTHENTICATING proxy, NO credentials"
HTTP_PROXY=$PROXY_AUTH_URL_NOCREDS NODE_USE_ENV_PROXY=1 node client-fetch-probe.mjs http "http://127.0.0.1:$DEST_HTTP_PORT/A3"
endsection

section "A4. http.get through an AUTHENTICATING proxy, credentials as userinfo in HTTP_PROXY"
HTTP_PROXY=$PROXY_AUTH_URL NODE_USE_ENV_PROXY=1 node client-fetch-probe.mjs http "http://127.0.0.1:$DEST_HTTP_PORT/A4"
endsection

if [ "$HAVE_OPENSSL" = yes ]; then
  section "A5. fetch, HTTPS target (CONNECT) through an AUTHENTICATING proxy, NO credentials"
  HTTPS_PROXY=$PROXY_AUTH_URL_NOCREDS NODE_USE_ENV_PROXY=1 NODE_TLS_REJECT_UNAUTHORIZED=0 node client-fetch-probe.mjs fetch "https://127.0.0.1:$DEST_HTTPS_PORT/A5"
  endsection
else
  echo
  echo "### A5 — SKIPPED: no openssl on PATH, so there is no HTTPS destination here ###"
fi

if [ "$HAVE_OPENSSL" = yes ]; then
  section "A6. fetch, HTTPS target (CONNECT) through an AUTHENTICATING proxy, credentials as userinfo"
  HTTPS_PROXY=$PROXY_AUTH_URL NODE_USE_ENV_PROXY=1 NODE_TLS_REJECT_UNAUTHORIZED=0 node client-fetch-probe.mjs fetch "https://127.0.0.1:$DEST_HTTPS_PORT/A6"
  endsection
else
  echo
  echo "### A6 — SKIPPED: no openssl on PATH, so there is no HTTPS destination here ###"
fi

if [ "$HAVE_OPENSSL" = yes ]; then
  section "A7. https.get, HTTPS target (CONNECT) through an AUTHENTICATING proxy, credentials as userinfo"
  HTTPS_PROXY=$PROXY_AUTH_URL NODE_USE_ENV_PROXY=1 NODE_TLS_REJECT_UNAUTHORIZED=0 node client-fetch-probe.mjs http "https://127.0.0.1:$DEST_HTTPS_PORT/A7"
  endsection
else
  echo
  echo "### A7 — SKIPPED: no openssl on PATH, so there is no HTTPS destination here ###"
fi

echo
echo "=== FULL PROXY log (open proxy) ==="
cat "$WORKDIR/proxy.log"
echo
echo "=== FULL PROXY-AUTH log ==="
cat "$WORKDIR/proxy-auth.log"
echo
echo "=== DEST http log ==="
cat "$WORKDIR/dest-http.log"
if [ "$HAVE_OPENSSL" = yes ]; then
  echo
  echo "=== DEST https log ==="
  cat "$WORKDIR/dest-https.log"
fi

kill "$DEST_HTTP_PID" $DEST_HTTPS_PID "$PROXY_PID" "$PROXY_AUTH_PID" 2>/dev/null
wait 2>/dev/null
rm -rf "$WORKDIR"
