#!/usr/bin/env sh
set -eu

# The release vulnerability gate, in one place (#373, ADR-0086 D3). `build-and-push.sh` runs it on
# every platform of every image digest before it signs anything, and CI's `image-scan` job runs it
# on each image built for linux/amd64 in a pull request, so the two cannot drift: a PR that would
# block the release fails first.
#
#   sh infra/release/trivy-gate.sh --platform <os/arch> <image reference>
#
# It fails on any HIGH or CRITICAL finding that has a fix (`--ignore-unfixed`): vulnerabilities in
# OS and language packages, and secrets. `.trivyignore.yaml` at the repository root holds the only
# exceptions, each with a statement of why it does not apply and an expiry after which it no longer
# suppresses anything. Adding one is a reviewed change to that file, never a flag here.
root="$(cd "$(dirname "$0")/../.." && pwd)"
platform=''
while [ "$#" -gt 1 ]; do
  case "$1" in
    --platform) platform="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
[ "$#" -eq 1 ] || { echo 'usage: trivy-gate.sh --platform <os/arch> <image reference>' >&2; exit 2; }
[ -n "$platform" ] || { echo '--platform is required' >&2; exit 2; }
case "$platform" in *[!a-z0-9/]*) echo 'platform contains unsafe characters' >&2; exit 2 ;; esac
command -v trivy >/dev/null 2>&1 || { echo 'trivy is required' >&2; exit 1; }

exec trivy image \
  --platform "$platform" \
  --quiet \
  --exit-code 1 \
  --severity HIGH,CRITICAL \
  --ignore-unfixed \
  --ignorefile "$root/.trivyignore.yaml" \
  "$1"
