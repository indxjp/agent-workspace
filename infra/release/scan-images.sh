#!/usr/bin/env sh
set -eu

# Builds every image of the release plan for one platform, loads it into the local Docker daemon,
# and runs the release vulnerability gate (`trivy-gate.sh`, the same script `build-and-push.sh`
# runs on each published digest) on it. Nothing is pushed or tagged in a registry. CI's
# `image-scan` job runs it on every pull request, so a finding that would stop an `images-v*`
# release fails the pull request that introduces it instead (#373).
#
#   sh infra/release/scan-images.sh [--platform <os/arch>] [--image <name>]... [--shard <i>/<n>]
#
# --shard i/n keeps every n-th image of the plan, starting at the i-th (1-based), so CI spreads the
# plan over n runners without naming images: an image added to the plan always lands in a shard.
#
# Every image is built and scanned even after one fails, so one run reports every finding; the
# script then exits 1 and names each image that did not pass.
platform='linux/amd64'
only=''
shard='1/1'
while [ "$#" -gt 0 ]; do
  case "$1" in
    --platform) platform="$2"; shift 2 ;;
    --image) only="$only $2"; shift 2 ;;
    --shard) shard="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
case "$platform" in *[!a-z0-9/]*|'') echo 'platform contains unsafe characters' >&2; exit 2 ;; esac
case "$shard" in [1-9]/[1-9]) ;; *) echo 'shard must be <i>/<n>, each a single digit' >&2; exit 2 ;; esac
shard_index="${shard%/*}"
shard_count="${shard#*/}"
[ "$shard_index" -le "$shard_count" ] || { echo "shard $shard: the index is past the count" >&2; exit 2; }
for command in docker node trivy; do
  command -v "$command" >/dev/null 2>&1 || { echo "$command is required" >&2; exit 1; }
done

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
# CI runs several jobs at once on one Docker daemon (MS-A2), and two scans of one image shared a tag:
# one job's `docker image rm` removed the image the other was about to scan or remove. The tag is
# unique to this invocation (its temporary directory's name), so each job scans and removes only
# the image it built.
tag="local-$(basename "$work" | tr -cd 'A-Za-z0-9')"
plan="$work/plan"
node infra/release/images.mjs > "$plan"
for name in $only; do
  grep -q "^$name " "$plan" || { echo "--image $name is not in the release plan" >&2; exit 2; }
done

failed=''
position=0
while read -r name dockerfile target engine engine_version <&3; do
  position=$((position + 1))
  [ $(((position - 1) % shard_count + 1)) -eq "$shard_index" ] || continue
  if [ -n "$only" ]; then
    case " $only " in *" $name "*) ;; *) continue ;; esac
  fi
  reference="agent-workspace-scan/$name:$tag"
  set -- --platform "$platform" --file "$dockerfile" --target "$target" --load --tag "$reference"
  if [ "$engine" != - ]; then
    # runtime.Dockerfile re-checks ENGINE_VERSION against the manifests it copied.
    set -- "$@" --build-arg "ENGINE=$engine" --build-arg "ENGINE_VERSION=$engine_version"
  fi
  printf '::group::%s: build (%s)\n' "$name" "$platform"
  if ! docker buildx build "$@" .; then
    # Recorded, not fatal: the remaining images are still built and scanned, so one run reports
    # every failure (see the header).
    printf '::endgroup::\n'
    printf '::error::%s did not build, so it could not be scanned\n' "$name"
    failed="$failed $name"
    continue
  fi
  printf '::endgroup::\n'
  printf '%s: trivy gate (%s)\n' "$name" "$platform"
  if sh infra/release/trivy-gate.sh --platform "$platform" "$reference"; then
    printf 'passed: %s\n' "$name"
  else
    printf '::error::%s has a fixable HIGH or CRITICAL finding; images-v* would refuse to publish it\n' "$name"
    failed="$failed $name"
  fi
  # The images are large; keep the runner's disk for the next build.
  docker image rm "$reference" >/dev/null
done 3< "$plan"

if [ -n "$failed" ]; then
  printf 'images that did not build or failed the trivy gate:%s\n' "$failed" >&2
  exit 1
fi
printf 'every planned image of shard %s passed the trivy gate for %s\n' "$shard" "$platform"
