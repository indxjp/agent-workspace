#!/usr/bin/env bash
# R-02 probe fixture — availability detection for the sandbox-runtime driver.
#
# Companion to ../../R-02-sandbox-runtime.md, section "8. The exact detection
# command". This script is the literal sequence of commands run on the
# research machine (Windows 11 Pro 10.0.26200, Node v24.19.0, git-bash/MSYS2)
# to produce the outputs quoted in that section. It imports no package; every
# check shells out to a CLI (node, npm, reg, net, docker) or tests for a
# binary on PATH with `command -v`.
#
# It is a research probe, not the Wave 7 generator implementation: the
# generator must reimplement this logic in TypeScript, choose its own
# fallback order, and decide what to do when `srt --version` cannot be
# trusted (see finding 8 in the note — the installed CLI misreports its own
# version; do not gate on that string).
#
# Usage:
#   bash probe-detect.sh
#
# Exits 0 always; it is a report, not a pass/fail gate.

set -uo pipefail

echo "== platform =="
uname -a || true
echo

echo "== node/npm/npx =="
node --version 2>&1
npm --version 2>&1
npx --version 2>&1
echo

echo "== linux/macOS host prerequisites (spec A.3: bubblewrap, socat, ripgrep) =="
for bin in bwrap socat rg; do
  if command -v "$bin" >/dev/null 2>&1; then
    echo "$bin: found at $(command -v "$bin")"
  else
    echo "$bin: NOT found on PATH"
  fi
done
echo "(macOS needs ripgrep only — sandbox-exec ships with the OS.)"
echo

echo "== windows: has \`windows-install\` already been run on this machine? =="
echo "-- registry key HKLM\\SOFTWARE\\sandbox-runtime (holds the DPAPI-encrypted"
echo "   sandbox-account credential + CA record; absence means never installed) --"
# Output suppressed: `reg query` prints its "key not found" message in the
# OS display language (observed as mojibake under a non-English console code
# page on the research machine) — the exit code is the portable signal.
reg query "HKLM\\SOFTWARE\\sandbox-runtime" >/dev/null 2>&1
RC=$?
if [ "$RC" -eq 0 ]; then
  echo "registry key present (rc=0) — windows-install has been run on this machine"
else
  echo "registry key absent (rc=$RC) — windows-install has NOT been run on this machine"
fi
echo
echo "-- local account \`srt-sandbox\` (created by windows-install) --"
if net user 2>&1 | grep -qi '\bsrt-sandbox\b'; then
  echo "srt-sandbox account: present"
else
  echo "srt-sandbox account: NOT present"
fi
echo

echo "== fallback driver candidate on this OS =="
docker --version 2>&1 || echo "docker: NOT found"
echo

echo "== npm registry: current published version, license, engines, publish date =="
npm view @anthropic-ai/sandbox-runtime version 2>&1
echo "license: $(npm view @anthropic-ai/sandbox-runtime license 2>&1)"
echo "engines: $(npm view @anthropic-ai/sandbox-runtime engines 2>&1 | tr '\n' ' ')"
echo "published (npm 'time' for 0.0.75): $(npm view @anthropic-ai/sandbox-runtime time --json 2>/dev/null | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{console.log(JSON.parse(s)['0.0.75'])}catch(e){console.log('(unavailable: '+e.message+')')}})" 2>&1)"
echo

echo "== GitHub: repository identity and the v0.0.75 release =="
echo "-- the plan's and spec's URL still points at the old org; where does it go? --"
curl -s -o /dev/null -w 'anthropic-experimental/sandbox-runtime: %{http_code} -> %{redirect_url}\n' \
  https://github.com/anthropic-experimental/sandbox-runtime 2>&1 || echo "curl: unavailable"
echo "-- API full_name (follows the rename) --"
gh api repos/anthropic-experimental/sandbox-runtime --jq '.full_name' 2>&1 || echo "gh: unavailable"
echo "-- v0.0.75 release publish date --"
gh api repos/anthropics/sandbox-runtime/releases --jq '.[] | select(.tag_name=="v0.0.75") | "\(.tag_name) published_at=\(.published_at)"' 2>&1 || echo "gh: unavailable"
echo

echo "== install into a scratch dir and probe the CLI directly (no PATH shim) =="
SCRATCH="$(mktemp -d)"
( cd "$SCRATCH" && npm init -y >/dev/null 2>&1 && npm install @anthropic-ai/sandbox-runtime --no-audit --no-fund >/dev/null 2>&1 )
# Run with cwd set to SCRATCH and use a relative specifier — an absolute
# POSIX path embedded in a -e string is not reliably converted to a Windows
# path by MSYS/git-bash, and a bare `require('@anthropic-ai/sandbox-runtime')`
# would otherwise resolve from this fixture's own location, not the scratch
# install.
INSTALLED_VERSION="$(cd "$SCRATCH" && node -e "console.log(require('./node_modules/@anthropic-ai/sandbox-runtime/package.json').version)" 2>&1)"
CLI_VERSION="$(cd "$SCRATCH" && node "./node_modules/@anthropic-ai/sandbox-runtime/dist/cli.js" --version 2>&1)"
echo "package.json version : $INSTALLED_VERSION"
echo "\`srt --version\` output: $CLI_VERSION"
if [ "$INSTALLED_VERSION" != "$CLI_VERSION" ]; then
  echo "MISMATCH — matches upstream issue #207 (\`-V\` prints a stale/wrong version)."
  echo "Do not use this string as an availability or version-pinning signal."
fi
echo

echo "== the CLI's own \`--help\` (argument parsing only — see the exec attempt below) =="
( cd "$SCRATCH" && node "./node_modules/@anthropic-ai/sandbox-runtime/dist/cli.js" --help 2>&1 )
echo

echo "== does the Windows helper binary ship inside the npm package? =="
( cd "$SCRATCH" && ls -l node_modules/@anthropic-ai/sandbox-runtime/vendor/srt-win/*/srt-win.exe 2>&1 )
echo

echo "== package license/engines as installed (package.json in the tarball) =="
( cd "$SCRATCH" && node -e "const p=require('./node_modules/@anthropic-ai/sandbox-runtime/package.json');console.log('license:',p.license);console.log('engines:',JSON.stringify(p.engines))" 2>&1 )
echo

echo "== EXEC ATTEMPT: can srt actually RUN a command on this Windows host? =="
echo "-- (this is the check that distinguishes \`execCommands\` from argument parsing) --"
cat > "$SCRATCH/srt-settings.json" <<'JSON'
{
  "filesystem": { "allowRead": [], "denyRead": [], "allowWrite": ["."], "denyWrite": [] },
  "network": { "allowedDomains": [], "deniedDomains": [] }
}
JSON
( cd "$SCRATCH" && node "./node_modules/@anthropic-ai/sandbox-runtime/dist/cli.js" --settings ./srt-settings.json -c "echo hi" 2>&1 )
echo "exit code: $?"
echo

rm -rf "$SCRATCH"
