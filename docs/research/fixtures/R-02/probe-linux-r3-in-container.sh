#!/usr/bin/env bash
# R-02 Linux probe, ROUND 3 — the body that runs INSIDE the container.
#
# Do not run this directly on a workstation: it apt-get installs packages and
# npm-installs a global CLI. `probe-linux-r3.sh` pipes it into a throwaway
# `node:20` container via `docker run --rm -i --privileged ... bash -s`.
#
# This script exists because round 2 of this note graded several rows
# `verified` that no committed probe exercised, and graded one number
# (`the proxy-startup flake rate`) `verified` that does not reproduce from its
# own fixture. Every section below is one of those rows, probed:
#
#   KERNEL IDENTITY PROBE   the `uname` comparison the `isolation: "os-sandbox"`
#                           label rests on, actually run inside the sandbox
#   DENYWRITE PRECEDENCE    a NON-EMPTY denyWrite inside an allowWrite region
#   PROXY PORT PROBE        where the sandboxed client is actually told to go
#   FLAKE RATE, 3 ROUNDS    the same 20-request count, three independent times
#   SESSION TIMEOUT PROBE   is a long-running command killed? (maxSessionSeconds)
#   DENY-FIRST PROBE        deniedDomains vs allowedDomains for the same host
#   WILDCARD PROBE          `*.iana.org`
#   PORT-SUFFIX PROBE       `example.com:443` vs `example.com:22`
#   IPV6 SYNTAX PROBE       `[::1]` bracketed vs `2001:db8::1` unbracketed
#   UNIX SOCKET PROBE       default / allowUnixSockets / allowAllUnixSockets
#
# Network sections retry, because this configuration has a proxy-startup race
# (Finding 4): a run that fails with `Failed to connect to localhost port` never
# reached the proxy and carries no policy information. Every retrying section
# prints how many attempts it consumed, so the retry itself is visible.

set -uo pipefail

hr() { echo; echo "== $* =="; }

# Run one sandboxed command, retrying only the proxy-startup race, and report
# how many attempts it took. Any other outcome (200, 403, an error) is final.
RETRY_MAX=40
retry_srt() {
  local settings="$1" cmd="$2" i out
  for i in $(seq 1 $RETRY_MAX); do
    out="$(srt --settings "$settings" -c "$cmd" 2>&1)"
    case "$out" in
      *"Failed to connect to localhost port"*) continue ;;
      *) echo "(attempts consumed: $i)"; echo "$out"; return 0 ;;
    esac
  done
  echo "(attempts consumed: $RETRY_MAX — every one lost the proxy-startup race)"
  echo "$out"
}

hr "platform"
uname -a
grep -E '^(PRETTY_NAME|VERSION_ID)=' /etc/os-release
node --version

hr "install prerequisites and the CLI"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq >/dev/null 2>&1
apt-get install -y -qq bubblewrap socat ripgrep curl >/dev/null 2>&1
echo "apt-get rc=$?"
npm install -g @anthropic-ai/sandbox-runtime >/dev/null 2>&1
echo "npm install -g rc=$?"
echo "installed package version (package.json): $(node -e "console.log(require('/usr/local/lib/node_modules/@anthropic-ai/sandbox-runtime/package.json').version)" 2>&1)"

mkdir -p /tmp/work

hr "settings files"
cat > /tmp/s-base.json <<'JSON'
{
  "filesystem": { "allowRead": [], "denyRead": [], "allowWrite": ["/tmp/work"], "denyWrite": [] },
  "network": { "allowedDomains": ["example.com"], "deniedDomains": [] },
  "enableWeakerNestedSandbox": true
}
JSON
cat > /tmp/s-denywrite.json <<'JSON'
{
  "filesystem": { "allowRead": [], "denyRead": [], "allowWrite": ["/tmp/work"], "denyWrite": ["/tmp/work/secret.txt"] },
  "network": { "allowedDomains": [], "deniedDomains": [] },
  "enableWeakerNestedSandbox": true
}
JSON
cat > /tmp/s-denyfirst.json <<'JSON'
{
  "filesystem": { "allowRead": [], "denyRead": [], "allowWrite": ["/tmp/work"], "denyWrite": [] },
  "network": { "allowedDomains": ["example.com"], "deniedDomains": ["example.com"] },
  "enableWeakerNestedSandbox": true
}
JSON
cat > /tmp/s-wildcard.json <<'JSON'
{
  "filesystem": { "allowRead": [], "denyRead": [], "allowWrite": ["/tmp/work"], "denyWrite": [] },
  "network": { "allowedDomains": ["*.iana.org"], "deniedDomains": [] },
  "enableWeakerNestedSandbox": true
}
JSON
cat > /tmp/s-port443.json <<'JSON'
{
  "filesystem": { "allowRead": [], "denyRead": [], "allowWrite": ["/tmp/work"], "denyWrite": [] },
  "network": { "allowedDomains": ["example.com:443"], "deniedDomains": [] },
  "enableWeakerNestedSandbox": true
}
JSON
cat > /tmp/s-port22.json <<'JSON'
{
  "filesystem": { "allowRead": [], "denyRead": [], "allowWrite": ["/tmp/work"], "denyWrite": [] },
  "network": { "allowedDomains": ["example.com:22"], "deniedDomains": [] },
  "enableWeakerNestedSandbox": true
}
JSON
cat > /tmp/s-ipv6-bracketed.json <<'JSON'
{
  "filesystem": { "allowRead": [], "denyRead": [], "allowWrite": ["/tmp/work"], "denyWrite": [] },
  "network": { "allowedDomains": ["[::1]", "[2001:db8::1]:443"], "deniedDomains": [] },
  "enableWeakerNestedSandbox": true
}
JSON
cat > /tmp/s-ipv6-bare.json <<'JSON'
{
  "filesystem": { "allowRead": [], "denyRead": [], "allowWrite": ["/tmp/work"], "denyWrite": [] },
  "network": { "allowedDomains": ["2001:db8::1"], "deniedDomains": [] },
  "enableWeakerNestedSandbox": true
}
JSON
cat > /tmp/s-unix-default.json <<'JSON'
{
  "filesystem": { "allowRead": [], "denyRead": [], "allowWrite": ["/tmp/work"], "denyWrite": [] },
  "network": { "allowedDomains": [], "deniedDomains": [] },
  "enableWeakerNestedSandbox": true
}
JSON
cat > /tmp/s-unix-path.json <<'JSON'
{
  "filesystem": { "allowRead": [], "denyRead": [], "allowWrite": ["/tmp/work"], "denyWrite": [] },
  "network": { "allowedDomains": [], "deniedDomains": [], "allowUnixSockets": ["/tmp/work/probe.sock"] },
  "enableWeakerNestedSandbox": true
}
JSON
cat > /tmp/s-unix-all.json <<'JSON'
{
  "filesystem": { "allowRead": [], "denyRead": [], "allowWrite": ["/tmp/work"], "denyWrite": [] },
  "network": { "allowedDomains": [], "deniedDomains": [], "allowAllUnixSockets": true },
  "enableWeakerNestedSandbox": true
}
JSON
echo "wrote /tmp/s-*.json"

# ---------------------------------------------------------------------------
hr "KERNEL IDENTITY PROBE — does the sandboxed process share the container's kernel?"
# This is the comparison the `isolation: \"os-sandbox\"` grade rests on. Round 2
# asserted it without running it.
echo '$ uname -a                     # container, outside the sandbox'
CONTAINER_UNAME="$(uname -a)"
echo "$CONTAINER_UNAME"
echo '$ cat /proc/version            # container, outside the sandbox'
CONTAINER_PROCVER="$(cat /proc/version)"
echo "$CONTAINER_PROCVER"
echo '$ srt --settings /tmp/s-base.json -c "uname -a; cat /proc/version"'
SANDBOX_OUT="$(srt --settings /tmp/s-base.json -c 'uname -a; cat /proc/version' 2>&1)"
echo "$SANDBOX_OUT"
echo "exit code: $?"
SANDBOX_UNAME="$(echo "$SANDBOX_OUT" | sed -n '1p')"
SANDBOX_PROCVER="$(echo "$SANDBOX_OUT" | sed -n '2p')"
if [ "$CONTAINER_UNAME" = "$SANDBOX_UNAME" ]; then
  echo "uname-a identical inside and outside the sandbox: YES"
else
  echo "uname-a identical inside and outside the sandbox: NO"
  echo "  outside: $CONTAINER_UNAME"
  echo "  inside : $SANDBOX_UNAME"
fi
if [ "$CONTAINER_PROCVER" = "$SANDBOX_PROCVER" ]; then
  echo "/proc/version identical inside and outside the sandbox: YES"
else
  echo "/proc/version identical inside and outside the sandbox: NO"
fi

# ---------------------------------------------------------------------------
hr "DENYWRITE PRECEDENCE PROBE — denyWrite:[/tmp/work/secret.txt] inside allowWrite:[/tmp/work]"
rm -f /tmp/work/secret.txt /tmp/work/ok.txt
: > /tmp/work/secret.txt
echo '$ srt --settings /tmp/s-denywrite.json -c "echo A > /tmp/work/ok.txt; echo ok-rc=$?; echo B > /tmp/work/secret.txt; echo denywrite-rc=$?"'
srt --settings /tmp/s-denywrite.json -c 'echo A > /tmp/work/ok.txt; echo ok-rc=$?; echo B > /tmp/work/secret.txt; echo denywrite-rc=$?' 2>&1
echo "exit code: $?"
echo "host view: /tmp/work/ok.txt     -> [$(cat /tmp/work/ok.txt 2>&1)]"
echo "host view: /tmp/work/secret.txt -> [$(cat /tmp/work/secret.txt 2>&1)]"

# ---------------------------------------------------------------------------
hr "PROXY PORT PROBE — what port is the sandboxed client actually pointed at?"
echo '$ srt --settings /tmp/s-base.json -c "env | grep -i proxy | sort"'
srt --settings /tmp/s-base.json -c 'env | grep -i proxy | sort' 2>&1
echo "exit code: $?"
echo
echo '$ srt --settings /tmp/s-base.json -c "curl -sSv -m 15 -o /dev/null https://example.com 2>&1 | grep -Ei \"Connected to|CONNECT |proxy\""   (retrying past the startup race)'
retry_srt /tmp/s-base.json 'curl -sSv -m 15 -o /dev/null https://example.com 2>&1 | grep -Ei "Connected to|CONNECT |proxy"'
echo
echo '$ ss -ltnp 2>/dev/null | head -20   # container-side listeners while no sandbox is running'
(command -v ss >/dev/null 2>&1 && ss -ltnp 2>&1 | head -20) || echo "ss: not installed in this image"

# ---------------------------------------------------------------------------
hr "PROXY-STARTUP FLAKE RATE — three INDEPENDENT rounds of 20 identical allowlisted requests"
# Round 2 committed one such count (200=10) and graded the RATE `verified`.
# Three rounds are run here, in one container, back to back, precisely so the
# spread between rounds is on the record next to any number taken from them.
for round in 1 2 3; do
  OK=0; RACE=0; OTHER=0
  for i in $(seq 1 20); do
    OUT="$(srt --settings /tmp/s-base.json -c 'curl -sS -m 15 -o /dev/null -w "%{http_code}\n" https://example.com' 2>&1)"
    case "$OUT" in
      *200*)                                   OK=$((OK+1)) ;;
      *"Failed to connect to localhost port"*) RACE=$((RACE+1)) ;;
      *)                                       OTHER=$((OTHER+1)); echo "other: $(echo "$OUT" | tr '\n' ' ')" ;;
    esac
  done
  echo "round $round of 20 identical allowlisted requests: 200=$OK  proxy-port-connect-failure=$RACE  other=$OTHER"
done

# ---------------------------------------------------------------------------
hr "SESSION TIMEOUT PROBE — is a long-running command killed? (maxSessionSeconds)"
echo '$ time srt --settings /tmp/s-unix-default.json -c "sleep 100; echo survived-100"'
S=$(date +%s)
srt --settings /tmp/s-unix-default.json -c 'sleep 100; echo survived-100' 2>&1
RC=$?
E=$(date +%s)
echo "exit code: $RC"
echo "wall clock: $((E - S)) s"

# ---------------------------------------------------------------------------
hr "DENY-FIRST PROBE — example.com in allowedDomains AND in deniedDomains"
echo '$ srt --settings /tmp/s-denyfirst.json -c "curl ... https://example.com"   (retrying past the startup race)'
retry_srt /tmp/s-denyfirst.json 'curl -sS -m 15 -o /dev/null -w "%{http_code}\n" https://example.com'

# ---------------------------------------------------------------------------
hr "WILDCARD PROBE — allowedDomains: [\"*.iana.org\"]"
echo '$ srt --settings /tmp/s-wildcard.json -c "curl ... https://www.iana.org"   (should match the wildcard)'
retry_srt /tmp/s-wildcard.json 'curl -sS -m 15 -o /dev/null -w "%{http_code}\n" https://www.iana.org'
echo
echo '$ srt --settings /tmp/s-wildcard.json -c "curl ... https://example.com"    (should NOT match)'
retry_srt /tmp/s-wildcard.json 'curl -sS -m 15 -o /dev/null -w "%{http_code}\n" https://example.com'

# ---------------------------------------------------------------------------
hr "PORT-SUFFIX PROBE — allowedDomains: [\"example.com:443\"] then [\"example.com:22\"]"
echo '$ srt --settings /tmp/s-port443.json -c "curl ... https://example.com"   (port matches)'
retry_srt /tmp/s-port443.json 'curl -sS -m 15 -o /dev/null -w "%{http_code}\n" https://example.com'
echo
echo '$ srt --settings /tmp/s-port22.json  -c "curl ... https://example.com"   (port does NOT match)'
retry_srt /tmp/s-port22.json 'curl -sS -m 15 -o /dev/null -w "%{http_code}\n" https://example.com'

# ---------------------------------------------------------------------------
hr "IPV6 SYNTAX PROBE — bracketed vs unbracketed entries in allowedDomains"
echo '$ srt --settings /tmp/s-ipv6-bracketed.json -c "echo hi"   # ["[::1]", "[2001:db8::1]:443"]'
srt --settings /tmp/s-ipv6-bracketed.json -c 'echo hi' 2>&1
echo "exit code: $?"
echo
echo '$ srt --settings /tmp/s-ipv6-bare.json -c "echo hi"        # ["2001:db8::1"] — unbracketed, multi-colon'
srt --settings /tmp/s-ipv6-bare.json -c 'echo hi' 2>&1
echo "exit code: $?"

# ---------------------------------------------------------------------------
hr "UNIX SOCKET PROBE — default vs allowUnixSockets vs allowAllUnixSockets"
rm -f /tmp/work/probe.sock
cat > /tmp/work/unixserver.js <<'JS'
const net = require('net');
net.createServer(s => s.end('pong\n')).listen('/tmp/work/probe.sock', () => console.log('unix server listening'));
JS
cat > /tmp/work/unixclient.js <<'JS'
const net = require('net');
const c = net.connect('/tmp/work/probe.sock');
let done = false;
c.on('data', d => { done = true; process.stdout.write('unix-connect: OK, read ' + JSON.stringify(String(d)) + '\n'); process.exit(0); });
c.on('error', e => { done = true; console.log('unix-connect: BLOCKED, error ' + e.code + ' (' + e.syscall + ')'); process.exit(1); });
setTimeout(() => { if (!done) { console.log('unix-connect: TIMEOUT'); process.exit(2); } }, 8000);
JS
node /tmp/work/unixserver.js &
SRV=$!
sleep 2
echo "container-side control (outside the sandbox):"
node /tmp/work/unixclient.js 2>&1
echo "control exit code: $?"
for s in default path all; do
  echo
  echo "\$ srt --settings /tmp/s-unix-$s.json -c \"node /tmp/work/unixclient.js\""
  srt --settings "/tmp/s-unix-$s.json" -c 'node /tmp/work/unixclient.js' 2>&1
  echo "exit code: $?"
done
kill $SRV 2>/dev/null
rm -f /tmp/work/probe.sock

hr "done"
echo "round-3 probe complete"
