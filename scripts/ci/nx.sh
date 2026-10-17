#!/usr/bin/env bash
# CI entry point for every task-running `nx` call: `scripts/ci/nx.sh <nx args>`.
#
# Why it exists: Nx 23's self-hosted HTTP cache client treats ANY transport
# error or unexpected status from the cache server as fatal — "Failed to send
# request: … /v1/cache/<hash>" (server unreachable) or "Misconfigured remote
# cache endpoint: Unexpected response status: 503" — and exits non-zero even
# when every task itself succeeded (measured 2026-10 against nx 23.2.0; see
# docs/operations/ci.md "Nx remote cache" → "Outage behaviour"). The remote cache
# is an optimisation and must never decide whether CI is green, so:
#
#   1. run `nx` with whatever remote cache .github/actions/nx-remote-cache
#      configured;
#   2. if it failed AND its output carries one of those two remote-cache
#      signatures, warn, disable the remote cache for the rest of the job
#      (also via $GITHUB_ENV, so later steps skip it too), and run the SAME
#      command once more on the local cache only. Tasks that already
#      succeeded replay from the local cache, so the retry costs little.
#
# A genuine task failure never matches those signatures and is returned as-is
# (exit code preserved). Output is streamed unchanged, so callers can keep
# piping to `tee`.
set -uo pipefail

# CI installs pnpm with pnpm/action-setup, so plain `pnpm` is the pinned one.
nx_cmd=(${NX_CMD:-pnpm nx})
log="$(mktemp)"
trap 'rm -f "$log"' EXIT

"${nx_cmd[@]}" "$@" 2>&1 | tee "$log"
status=${PIPESTATUS[0]}

if [ "$status" -ne 0 ] && [ -n "${NX_SELF_HOSTED_REMOTE_CACHE_SERVER:-}" ] &&
  grep -qE 'Misconfigured remote cache endpoint|Failed to send request: .*/v1/cache/' "$log"; then
  echo "::warning title=Nx remote cache::the remote cache failed mid-run ($(grep -oE 'Misconfigured remote cache endpoint[^]]*|Failed to send request[^(]*' "$log" | head -1)). Re-running on the local cache only; the rest of this job will not use the remote cache."
  unset NX_SELF_HOSTED_REMOTE_CACHE_SERVER NX_SELF_HOSTED_REMOTE_CACHE_ACCESS_TOKEN
  if [ -n "${GITHUB_ENV:-}" ]; then
    {
      echo "NX_SELF_HOSTED_REMOTE_CACHE_SERVER="
      echo "NX_SELF_HOSTED_REMOTE_CACHE_ACCESS_TOKEN="
    } >> "$GITHUB_ENV"
  fi
  "${nx_cmd[@]}" "$@"
  status=$?
fi
exit "$status"
