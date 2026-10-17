#!/usr/bin/env bash
# R-14 fixture, part 3 of 3 — the NON-NODE CLIENT suite. It exists to answer one question that the
# first two suites deliberately did not: when the four proxy variables are set for a process, do
# *non-Node* HTTP clients started in the same environment bypass them the way a raw `node:net`
# socket does (finding 9), or do they honour them?
#
# Round 2 of this note asserted "expected yes [they bypass], by the same mechanism" without
# measuring it. This suite measures it. It uses the same two fixture servers as run-all.sh
# (`dest-server.mjs` and `proxy-server.mjs`, both unmodified) and the same per-section proxy-log
# delta, so a section that shows proxy lines demonstrably went THROUGH the proxy and a section that
# shows none demonstrably went direct.
#
# Clients probed: `curl` and Python's standard-library `urllib.request`. Both are detected rather
# than assumed; if one is absent the suite says so and skips its sections instead of pretending.
# `ws`/database/gRPC clients are NOT probed here — see the note's Declared gaps.
#
# Run from this directory: `bash nonnode-suite.sh`.
#
# A Windows caveat this suite prints for itself: Windows folds environment-variable case, so on the
# Windows host `http_proxy` and `HTTP_PROXY` are one variable. Sections that set only one of the two
# names therefore cannot distinguish them there; each section echoes back what the client process
# actually saw so the transcript records this rather than the note asserting it.
set -u
cd "$(dirname "$0")"

WORKDIR=$(mktemp -d)
DEST_PORTFILE="$WORKDIR/dest-http.port"
PROXY_PORTFILE="$WORKDIR/proxy.port"

wait_for_port() { # $1 = portfile
  for _ in $(seq 1 50); do
    [ -s "$1" ] && return 0
    sleep 0.1
  done
  echo "TIMED OUT waiting for $1" >&2
  return 1
}

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

if command -v curl >/dev/null 2>&1; then HAVE_CURL=yes; else HAVE_CURL=no; fi
# `%{proxy_used}` is a --write-out variable curl's manual marks "(Added in 8.7.0)". curl 7.88.1
# (what bookworm-slim installs) rejects it, so the format string is chosen by probing rather than
# assumed; the proxy-log delta
# printed under each section is the actual evidence either way.
CURL_W='RESULT: curl http_code=%{http_code}\n'
if [ "$HAVE_CURL" = yes ] && curl --write-out '%{proxy_used}' --version >/dev/null 2>&1; then
  CURL_W='RESULT: curl http_code=%{http_code} proxy_used=%{proxy_used}\n'
fi
PY=""
for c in python3 python; do
  if command -v "$c" >/dev/null 2>&1; then PY=$c; break; fi
done

node dest-server.mjs 0 "$DEST_PORTFILE" > "$WORKDIR/dest-http.log" 2>&1 &
DEST_PID=$!
node proxy-server.mjs 0 "$PROXY_PORTFILE" > "$WORKDIR/proxy.log" 2>&1 &
PROXY_PID=$!
wait_for_port "$DEST_PORTFILE"
wait_for_port "$PROXY_PORTFILE"
DEST_PORT=$(cat "$DEST_PORTFILE")
PROXY_PORT=$(cat "$PROXY_PORTFILE")
PROXY_URL="http://127.0.0.1:$PROXY_PORT"

echo "node=$(node -v)  platform=$(node -p process.platform)"
echo "DEST(http)=127.0.0.1:$DEST_PORT  PROXY(open)=$PROXY_URL"
if [ "$HAVE_CURL" = yes ]; then echo "curl=$(curl --version | head -n 1)"; else echo "curl: NOT ON PATH — sections N1-N4 SKIPPED"; fi
if [ -n "$PY" ]; then echo "python=$($PY --version 2>&1) ($PY)"; else echo "python: NOT ON PATH — sections N5-N7 SKIPPED"; fi

# `env -u` is used for the controls so that a variable inherited from the surrounding shell cannot
# silently make a control look like a test.
UNSET="env -u HTTP_PROXY -u http_proxy -u HTTPS_PROXY -u https_proxy -u NO_PROXY -u no_proxy -u ALL_PROXY -u all_proxy"

if [ "$HAVE_CURL" = yes ]; then
  section "N1. CONTROL — curl, NO proxy variable set at all"
  $UNSET sh -c "echo \"client env: http_proxy=\${http_proxy-null} HTTP_PROXY=\${HTTP_PROXY-null} no_proxy=\${no_proxy-null}\"; curl -sS -o /dev/null -w \"$CURL_W\" http://127.0.0.1:$DEST_PORT/N1-control" 2>&1
  endsection

  section "N2. curl with lowercase http_proxy set (the name curl documents)"
  $UNSET env http_proxy="$PROXY_URL" sh -c "echo \"client env: http_proxy=\${http_proxy-null} HTTP_PROXY=\${HTTP_PROXY-null} no_proxy=\${no_proxy-null}\"; curl -sS -o /dev/null -w \"$CURL_W\" http://127.0.0.1:$DEST_PORT/N2-lower" 2>&1
  endsection

  section "N3. curl with UPPERCASE HTTP_PROXY only (case-folding platforms make this the same as N2)"
  $UNSET env HTTP_PROXY="$PROXY_URL" sh -c "echo \"client env: http_proxy=\${http_proxy-null} HTTP_PROXY=\${HTTP_PROXY-null} no_proxy=\${no_proxy-null}\"; curl -sS -o /dev/null -w \"$CURL_W\" http://127.0.0.1:$DEST_PORT/N3-upper" 2>&1
  endsection

  section "N4. curl with http_proxy set AND no_proxy=127.0.0.1"
  $UNSET env http_proxy="$PROXY_URL" no_proxy=127.0.0.1 sh -c "echo \"client env: http_proxy=\${http_proxy-null} HTTP_PROXY=\${HTTP_PROXY-null} no_proxy=\${no_proxy-null}\"; curl -sS -o /dev/null -w \"$CURL_W\" http://127.0.0.1:$DEST_PORT/N4-noproxy" 2>&1
  endsection
fi

PYSRC='
import os, sys, urllib.request
url = sys.argv[1]
print("client env: http_proxy=%s HTTP_PROXY=%s no_proxy=%s" % (
    os.environ.get("http_proxy", "null"),
    os.environ.get("HTTP_PROXY", "null"),
    os.environ.get("no_proxy", "null")))
print("urllib.request.getproxies() -> %r" % (urllib.request.getproxies(),))
body = urllib.request.urlopen(url, timeout=10).read().decode()
print("RESULT: urllib got %r" % body)
'

if [ -n "$PY" ]; then
  section "N5. CONTROL — python urllib.request, NO proxy variable set at all"
  $UNSET "$PY" -c "$PYSRC" "http://127.0.0.1:$DEST_PORT/N5-control" 2>&1
  endsection

  section "N6. python urllib.request with lowercase http_proxy set"
  $UNSET env http_proxy="$PROXY_URL" "$PY" -c "$PYSRC" "http://127.0.0.1:$DEST_PORT/N6-lower" 2>&1
  endsection

  section "N7. python urllib.request with http_proxy set AND no_proxy=127.0.0.1"
  $UNSET env http_proxy="$PROXY_URL" no_proxy=127.0.0.1 "$PY" -c "$PYSRC" "http://127.0.0.1:$DEST_PORT/N7-noproxy" 2>&1
  endsection
fi

echo
echo "### DEST server log (every request that reached the destination directly or via the proxy) ###"
cat "$WORKDIR/dest-http.log"

kill "$DEST_PID" "$PROXY_PID" 2>/dev/null
wait "$DEST_PID" "$PROXY_PID" 2>/dev/null
rm -rf "$WORKDIR"
