#!/usr/bin/env bash
# R-02 Linux probe — the body that runs INSIDE the container.
#
# Do not run this directly on a workstation: it apt-get installs packages and
# npm-installs a global CLI. `probe-linux.sh` pipes it into a throwaway
# `node:20` container (the same image upstream issue #180 uses in its own
# reproduction) via `docker run --rm -i ... bash -s`.
#
# The wrapper runs it twice, with different container privilege:
#   MODE=unprivileged  — plain `docker run` (Docker's default seccomp profile
#                        and capability set; no user-namespace creation)
#   MODE=privileged    — `docker run --privileged`
# so the same commands can be compared across the two configurations that
# note Finding 6 is about.
#
# Ordering matters: the CLI is installed BEFORE the host prerequisites so that
# its own dependency check can be observed against a host that has none of
# them (section "DEPENDENCY CHECK, prerequisites absent").

set -uo pipefail
MODE="${MODE:-unprivileged}"

hr() { echo; echo "== $* =="; }

hr "mode"
echo "MODE=$MODE"

hr "platform"
uname -a
grep -E '^(PRETTY_NAME|VERSION_ID)=' /etc/os-release
echo "container capabilities (CapEff): $(grep -E '^CapEff' /proc/self/status | awk '{print $2}')"
echo "user_namespaces max: $(cat /proc/sys/user/max_user_namespaces 2>&1 || true)"

hr "node/npm"
node --version
npm --version

hr "spec A.3 prerequisites BEFORE install"
for bin in bwrap socat rg; do
  if command -v "$bin" >/dev/null 2>&1; then echo "$bin: found at $(command -v "$bin")"; else echo "$bin: NOT found on PATH"; fi
done
echo '$ command -v bwrap >/dev/null && command -v socat >/dev/null && command -v rg >/dev/null'
command -v bwrap >/dev/null && command -v socat >/dev/null && command -v rg >/dev/null
echo "exit code: $?"

hr "install the CLI"
npm install -g @anthropic-ai/sandbox-runtime >/dev/null 2>&1
echo "npm install -g rc=$?"
echo "installed package version (package.json): $(node -e "console.log(require('/usr/local/lib/node_modules/@anthropic-ai/sandbox-runtime/package.json').version)" 2>&1)"
echo '$ srt --version'
srt --version 2>&1
echo '$ srt --help'
srt --help 2>&1

hr "DEPENDENCY CHECK, prerequisites absent — what srt itself says it needs on Linux"
cat > /tmp/srt-weaker.json <<'JSON'
{
  "filesystem": { "allowRead": [], "denyRead": ["/root/.ssh"], "allowWrite": ["/tmp/work"], "denyWrite": [] },
  "network": { "allowedDomains": [], "deniedDomains": [] },
  "enableWeakerNestedSandbox": true
}
JSON
echo '$ srt --settings /tmp/srt-weaker.json -c "echo hi"    # with NO bwrap/socat/rg installed'
srt --settings /tmp/srt-weaker.json -c 'echo hi' 2>&1
echo "exit code: $?"

hr "installing spec A.3 prerequisites (apt-get install bubblewrap socat ripgrep)"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq >/dev/null 2>&1
apt-get install -y -qq bubblewrap socat ripgrep >/dev/null 2>&1
echo "apt-get rc=$?"
echo "installed versions:"
bwrap --version 2>&1 | head -1
socat -V 2>&1 | head -1
rg --version 2>&1 | head -1

hr "spec A.3 prerequisites AFTER install (the note's Linux detection command, run verbatim)"
for bin in bwrap socat rg; do
  if command -v "$bin" >/dev/null 2>&1; then echo "$bin: found at $(command -v "$bin")"; else echo "$bin: NOT found on PATH"; fi
done
echo '$ command -v bwrap >/dev/null && command -v socat >/dev/null && command -v rg >/dev/null'
command -v bwrap >/dev/null && command -v socat >/dev/null && command -v rg >/dev/null
echo "exit code: $?"

hr "bwrap on its own (issue #417 uses this as its control)"
echo '$ bwrap --ro-bind / / --unshare-all --die-with-parent /bin/true'
bwrap --ro-bind / / --unshare-all --die-with-parent /bin/true 2>&1
echo "exit code: $?"

hr "settings files"
# NOTE: all four filesystem keys and both network keys are REQUIRED by the
# CLI's own schema. A settings file missing any of them is rejected before any
# command runs — see the SCHEMA PROBE section below.
cat > /tmp/srt-default.json <<'JSON'
{
  "filesystem": { "allowRead": [], "denyRead": ["/root/.ssh"], "allowWrite": ["/tmp/work"], "denyWrite": [] },
  "network": { "allowedDomains": [], "deniedDomains": [] }
}
JSON
cat > /tmp/srt-net-allow.json <<'JSON'
{
  "filesystem": { "allowRead": [], "denyRead": [], "allowWrite": ["/tmp/work"], "denyWrite": [] },
  "network": { "allowedDomains": ["example.com"], "deniedDomains": [] },
  "enableWeakerNestedSandbox": true
}
JSON
cat > /tmp/srt-bashrc.json <<'JSON'
{
  "filesystem": { "allowRead": [], "denyRead": [], "allowWrite": ["/root"], "denyWrite": [] },
  "network": { "allowedDomains": [], "deniedDomains": [] },
  "enableWeakerNestedSandbox": true
}
JSON
cat > /tmp/srt-note-profile.json <<'JSON'
{
  "filesystem": {
    "denyRead": ["~/.ssh"],
    "allowWrite": ["."],
    "denyWrite": [".env"]
  },
  "network": {
    "allowedDomains": [],
    "deniedDomains": []
  },
  "enableWeakerNestedSandbox": false
}
JSON
cat > /tmp/srt-partial.json <<'JSON'
{
  "filesystem": { "allowWrite": ["/tmp/work"], "denyRead": ["/root/.ssh"] },
  "network": { "allowedDomains": [] }
}
JSON
mkdir -p /tmp/work /root/.ssh
echo "SECRET-KEY-MATERIAL" > /root/.ssh/id_probe
touch /root/.bashrc
echo "wrote /tmp/srt-{default,weaker,net-allow,bashrc,partial}.json"

hr "SCHEMA PROBE — are filesystem.allowRead/denyWrite and network.deniedDomains optional?"
echo '$ srt --settings /tmp/srt-partial.json -c "echo hi"   # allowRead, denyWrite, deniedDomains omitted'
srt --settings /tmp/srt-partial.json -c 'echo hi' 2>&1
echo "exit code: $?"
echo
echo '$ srt --settings /tmp/srt-note-profile.json -c "echo hi"   # the note contract-summary profile, verbatim'
srt --settings /tmp/srt-note-profile.json -c 'echo hi' 2>&1
echo "exit code: $?"

hr "EXEC PROBE 1 — enableWeakerNestedSandbox absent (default false)"
echo '$ srt --settings /tmp/srt-default.json -c "echo hi"'
srt --settings /tmp/srt-default.json -c 'echo hi' 2>&1
echo "exit code: $?"

hr "EXEC PROBE 2 — enableWeakerNestedSandbox: true (issue #180 repro)"
echo '$ srt --settings /tmp/srt-weaker.json -c "echo hi"'
srt --settings /tmp/srt-weaker.json -c 'echo hi' 2>&1
echo "exit code: $?"

hr "FILESYSTEM PROBE — allowWrite /tmp/work, everything else write-denied"
echo '$ srt --settings /tmp/srt-weaker.json -c "echo inside > /tmp/work/allowed.txt; echo write-allowed-rc=$?"'
srt --settings /tmp/srt-weaker.json -c 'echo inside > /tmp/work/allowed.txt; echo write-allowed-rc=$?' 2>&1
echo "exit code: $?"
echo '$ srt --settings /tmp/srt-weaker.json -c "echo outside > /tmp/denied.txt; echo write-denied-rc=$?"'
srt --settings /tmp/srt-weaker.json -c 'echo outside > /tmp/denied.txt; echo write-denied-rc=$?' 2>&1
echo "exit code: $?"
echo "host view: /tmp/work/allowed.txt -> $(cat /tmp/work/allowed.txt 2>&1)"
echo "host view: /tmp/denied.txt      -> $(cat /tmp/denied.txt 2>&1)"

hr "FILESYSTEM PROBE — denyRead /root/.ssh"
echo '$ srt --settings /tmp/srt-weaker.json -c "cat /root/.ssh/id_probe; echo read-rc=$?"'
srt --settings /tmp/srt-weaker.json -c 'cat /root/.ssh/id_probe; echo read-rc=$?' 2>&1
echo "exit code: $?"

hr "MANDATORY DENY PROBE — is /root/.bashrc write-denied even with allowWrite /root?"
echo '$ srt --settings /tmp/srt-bashrc.json -c "echo pwned >> /root/.bashrc; echo bashrc-rc=$?"'
srt --settings /tmp/srt-bashrc.json -c 'echo pwned >> /root/.bashrc; echo bashrc-rc=$?' 2>&1
echo "exit code: $?"
echo "host view: occurrences of 'pwned' in /root/.bashrc -> $(grep -c pwned /root/.bashrc 2>&1)"

hr "NETWORK PROBE — allowedDomains: [] (default deny), 5 consecutive attempts"
# Repeated because a single attempt is not enough to tell a policy decision
# apart from the proxy-startup race this probe found: some invocations never
# reach the proxy at all and fail with a local connect error to the proxy port
# instead of a policy response. Both outcomes are recorded verbatim.
echo '$ srt --settings /tmp/srt-weaker.json -c "curl -sS -m 15 -o /dev/null -w %{http_code} https://example.com"'
for i in 1 2 3 4 5; do
  printf 'attempt %s: ' "$i"
  srt --settings /tmp/srt-weaker.json -c 'curl -sS -m 15 -o /dev/null -w "%{http_code}\n" https://example.com' 2>&1 | tr '\n' ' '
  echo "| exit code: ${PIPESTATUS[0]}"
done

hr "NETWORK PROBE — allowedDomains: [\"example.com\"], 5 consecutive attempts"
echo '$ srt --settings /tmp/srt-net-allow.json -c "curl -sS -m 15 -o /dev/null -w %{http_code} https://example.com"'
for i in 1 2 3 4 5; do
  printf 'attempt %s: ' "$i"
  srt --settings /tmp/srt-net-allow.json -c 'curl -sS -m 15 -o /dev/null -w "%{http_code}\n" https://example.com' 2>&1 | tr '\n' ' '
  echo "| exit code: ${PIPESTATUS[0]}"
done

hr "NETWORK PROBE — a domain that is NOT on the allowlist, 5 consecutive attempts"
echo '$ srt --settings /tmp/srt-net-allow.json -c "curl -sS -m 15 -o /dev/null -w %{http_code} https://www.iana.org"'
for i in 1 2 3 4 5; do
  printf 'attempt %s: ' "$i"
  srt --settings /tmp/srt-net-allow.json -c 'curl -sS -m 15 -o /dev/null -w "%{http_code}\n" https://www.iana.org' 2>&1 | tr '\n' ' '
  echo "| exit code: ${PIPESTATUS[0]}"
done

hr "TLS PROBE — with no network.tlsTerminate set, who issued the cert curl sees?"
echo '$ srt --settings /tmp/srt-net-allow.json -c "curl -sSv -m 15 -o /dev/null https://example.com 2>&1 | grep -E issuer:|subject:|SSL certificate"'
srt --settings /tmp/srt-net-allow.json -c 'curl -sSv -m 15 -o /dev/null https://example.com 2>&1 | grep -E "issuer:|subject:|SSL certificate"' 2>&1
echo "exit code: $?"
echo "(control, outside the sandbox:)"
curl -sSv -m 15 -o /dev/null https://example.com 2>&1 | grep -E "issuer:|subject:" || true

hr "PROXY-STARTUP FLAKE RATE — 20 identical allowlisted requests, counted"
# Quantifies the intermittent failure the repeated probes above exposed: some
# invocations never reach the proxy and fail locally against the proxy port.
OK=0; RACE=0; OTHER=0
for i in $(seq 1 20); do
  OUT="$(srt --settings /tmp/srt-net-allow.json -c 'curl -sS -m 15 -o /dev/null -w "%{http_code}\n" https://example.com' 2>&1)"
  case "$OUT" in
    *200*)                       OK=$((OK+1)) ;;
    *"Failed to connect to localhost port"*) RACE=$((RACE+1)) ;;
    *)                           OTHER=$((OTHER+1)); echo "other: $(echo "$OUT" | tr '\n' ' ')" ;;
  esac
done
echo "of 20 identical allowlisted requests: 200=$OK  proxy-port-connect-failure=$RACE  other=$OTHER"

hr "IDENTITY PROBE — who is the sandboxed process, and is the fs writable elsewhere?"
echo '$ srt --settings /tmp/srt-weaker.json -c "id; pwd; touch /usr/local/x; echo touch-usr-local-rc=$?"'
srt --settings /tmp/srt-weaker.json -c 'id; pwd; touch /usr/local/x 2>&1; echo touch-usr-local-rc=$?' 2>&1
echo "exit code: $?"

hr "GPU PROBE — what device nodes does the sandboxed process see?"
echo "unsandboxed container view of /dev: $(ls /dev | tr '\n' ' ')"
echo "unsandboxed /dev/dri, /dev/nvidia*: $(ls -d /dev/dri /dev/nvidia* 2>&1 | head -3)"
echo '$ srt --settings /tmp/srt-weaker.json -c "ls /dev"'
srt --settings /tmp/srt-weaker.json -c 'ls /dev | tr "\n" " "; echo' 2>&1
echo "exit code: $?"

hr "STARTUP LATENCY PROBE — 5x srt -c true, wall clock per run"
for i in 1 2 3 4 5; do
  S=$(date +%s%N)
  srt --settings /tmp/srt-weaker.json -c 'true' >/dev/null 2>&1
  RC=$?
  E=$(date +%s%N)
  echo "run $i: $(( (E - S) / 1000000 )) ms (rc=$RC)"
done

hr "done"
echo "MODE=$MODE complete"
