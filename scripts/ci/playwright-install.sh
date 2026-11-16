#!/usr/bin/env bash
# CI entry point for installing Chromium for Playwright:
#   scripts/ci/playwright-install.sh install       # browser + OS libraries (--with-deps)
#   scripts/ci/playwright-install.sh install-deps  # OS libraries only (browser restored from cache)
#
# Why it exists: several self-hosted runners share one machine (MS-A2: actions-runner-3, -8, ...).
# `playwright install --with-deps` runs apt-get as root, and two jobs doing it at the same moment
# collide on the apt lock: "E: Could not get lock /var/lib/apt/lists/lock. It is held by process
# ... (apt-get)", exit 100. That failed the nightly twice on 2026-11-11 (run 43070608029).
# Playwright's sudo call drops the environment, so apt's own lock-timeout option cannot be passed in.
#
# So: run the Playwright command; if it failed AND its output carries an apt/dpkg lock signature,
# wait and run it again, up to AW_APT_LOCK_ATTEMPTS times (default 8) with a growing delay
# (AW_APT_LOCK_DELAY_SECONDS x attempt, default 15 s: at most 7 minutes of waiting). Any other
# failure, or a lock still held after the last attempt, returns Playwright's exit code unchanged.
# On GitHub-hosted runners nothing else holds the lock, so the command runs once, as before.
#
# AW_PLAYWRIGHT_COMMAND overrides the command (tests only; default "pnpm exec playwright").
set -uo pipefail

case "${1:-}" in
  install) args=(install --with-deps chromium) ;;
  install-deps) args=(install-deps chromium) ;;
  *)
    echo "usage: scripts/ci/playwright-install.sh install|install-deps" >&2
    exit 2
    ;;
esac

attempts="${AW_APT_LOCK_ATTEMPTS:-8}"
delay="${AW_APT_LOCK_DELAY_SECONDS:-15}"
read -r -a command <<<"${AW_PLAYWRIGHT_COMMAND:-pnpm exec playwright}"
lock_signature='Could not get lock|Unable to lock|Unable to acquire the dpkg frontend lock'

log="$(mktemp)"
trap 'rm -f "$log"' EXIT

attempt=1
while true; do
  "${command[@]}" "${args[@]}" 2>&1 | tee "$log"
  status="${PIPESTATUS[0]}"
  if [[ "$status" -eq 0 ]]; then
    exit 0
  fi
  if ! grep -qE "$lock_signature" "$log"; then
    exit "$status"
  fi
  if [[ "$attempt" -ge "$attempts" ]]; then
    echo "::error::The apt/dpkg lock was still held by another process after $attempts attempts." >&2
    exit "$status"
  fi
  wait_seconds=$((delay * attempt))
  echo "::warning::Another job on this machine holds the apt/dpkg lock; trying again in ${wait_seconds}s (attempt $attempt of $attempts)." >&2
  sleep "$wait_seconds"
  attempt=$((attempt + 1))
done
