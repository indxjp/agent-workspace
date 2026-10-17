#!/usr/bin/env sh
set -eu

# Publishes one immutable process contract per image.  In particular, never build Dockerfile
# without --target: its final stage is an implementation detail and must not select a production
# process implicitly.
#
# The image list is not written here. infra/release/images.mjs derives it from
# packages/cli/src/release-images.json (the images the generator pins) and from the engine adapter
# packages (one runtime image per engine, ADR-0073), so what a release publishes is what `create`
# resolves (#370, ADR-0086). .github/workflows/images.yml runs this script from an
# images-v<version> tag.
#
#   --platform <list>   the platforms to build (a publish needs linux/amd64 and linux/arm64)
#   --tag <tag>         the tag each image is published under (the workflow passes the version)
#   --output <file>     where the release manifest (name -> digest reference) is written
#   --security <mode>   required (scan, sign and attest) or skip (local tests only)
#   --image <name>      build only this image of the plan (repeatable; --dry-run only)
#   --dry-run           build without pushing: no registry, no tag, no manifest
#
# Digest first, tag last (ADR-0086 D6):
#
# 1. Before building anything, every planned <name>:<tag> is looked up. A tag that exists must
#    carry this commit's org.opencontainers.image.revision; it is then kept as it is (a re-run),
#    and anything else stops the release. A published tag never moves to other content.
# 2. Each image is pushed by digest only, with no tag. On that digest, for every platform, syft
#    writes the SPDX SBOM, trivy scans, and the SLSA provenance BuildKit recorded is checked. The
#    digest is then signed keyless with cosign, and each platform's SBOM (--type spdxjson) and
#    provenance (--type slsaprovenance) are attached as cosign attestations: what
#    .github/workflows/release.yml verifies.
# 3. Only when every image has passed are the tags added, with `imagetools create`, which copies
#    the signed index unchanged; each tag is then read back and must name the digest that passed.
#
# COSIGN_CERTIFICATE_IDENTITY_REGEXP names the signing identity the verification requires.
# IMAGE_SOURCE, when set, labels every image with org.opencontainers.image.source, which is how
# GHCR links a package to the repository that published it.
platforms='linux/amd64,linux/arm64'
tag="${IMAGE_TAG:-$(git rev-parse --short=12 HEAD)}"
output="${RELEASE_MANIFEST:-dist/release/images.json}"
security="${PUBLISH_SECURITY:-required}"
dry_run=false
only=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    --platform) platforms="$2"; shift 2 ;;
    --tag) tag="$2"; shift 2 ;;
    --output) output="$2"; shift 2 ;;
    --security) security="$2"; shift 2 ;;
    --image) only="$only $2"; shift 2 ;;
    --dry-run) dry_run=true; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
case "$security" in required|skip) ;; *) echo '--security must be required or skip' >&2; exit 2 ;; esac
# The platform list reaches a Go template below, so it may hold platform names and commas only.
case "$platforms" in *[!a-z0-9/,]*|'') echo 'platforms contain unsafe characters' >&2; exit 2 ;; esac
if [ "$dry_run" = true ]; then
  # A dry run proves the plan and the Dockerfile targets build. It publishes nothing, so it may
  # build one platform and one image, and it never claims to have scanned or signed anything.
  [ "$security" = skip ] || { echo '--dry-run publishes nothing; pass --security skip' >&2; exit 2; }
else
  case ",$platforms," in *,linux/amd64,*) ;; *) echo 'missing required architecture linux/amd64' >&2; exit 2 ;; esac
  case ",$platforms," in *,linux/arm64,*) ;; *) echo 'missing required architecture linux/arm64' >&2; exit 2 ;; esac
  [ -z "$only" ] || { echo '--image selects a subset, which only a --dry-run may build' >&2; exit 2; }
fi
case "$tag" in *[!A-Za-z0-9._-]*|'') echo 'tag contains unsafe characters' >&2; exit 2 ;; esac
if [ "$dry_run" = true ]; then
  registry="${REGISTRY:-dry-run.invalid}"
else
  registry="${REGISTRY:?REGISTRY must name the target registry}"
fi
registry="${registry%/}"
revision="${VCS_REF:-$(git rev-parse HEAD 2>/dev/null || printf '%s' "$tag")}"
source_label="org.opencontainers.image.source=${IMAGE_SOURCE:-}"
revision_label="org.opencontainers.image.revision=$revision"
# The release each image belongs to, so `docker inspect` names it without a registry (BH061-059).
version_label="org.opencontainers.image.version=$tag"

command -v node >/dev/null 2>&1 || { echo 'node is required' >&2; exit 1; }
if [ "$security" = required ]; then
  for command in cosign syft trivy; do
    command -v "$command" >/dev/null 2>&1 || {
      echo "$command is required; use --security skip only for non-publishing local tests" >&2
      exit 1
    }
  done
  : "${COSIGN_CERTIFICATE_IDENTITY_REGEXP:?COSIGN_CERTIFICATE_IDENTITY_REGEXP must name the signing identity to verify}"
fi
issuer="${COSIGN_CERTIFICATE_OIDC_ISSUER:-https://token.actions.githubusercontent.com}"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
plan="$work/plan"
node infra/release/images.mjs > "$plan"
for name in $only; do
  grep -q "^$name " "$plan" || { echo "--image $name is not in the release plan" >&2; exit 2; }
done
# docker is checked only once every argument, --image included, has been validated, so a refused
# invocation is refused the same way on a host without the docker CLI.
command -v docker >/dev/null 2>&1 || { echo 'docker is required' >&2; exit 1; }

evidence="$(dirname "$output")"
if [ "$dry_run" = false ]; then
  mkdir -p "$evidence/sbom" "$evidence/provenance"
fi

# cosign's keyless verification, held to this repository's workflow identity.
verify_signed() {
  cosign "$@" \
    --certificate-identity-regexp "$COSIGN_CERTIFICATE_IDENTITY_REGEXP" \
    --certificate-oidc-issuer "$issuer" >/dev/null
}

verify_published() {
  verify_signed verify "$1"
  verify_signed verify-attestation --type spdxjson "$1"
  verify_signed verify-attestation --type slsaprovenance "$1"
}

# name=digest-reference, for the manifest: every image, kept or newly published.
records=''
record() {
  records="$records${records:+
}$1=$2"
}
# "<tagged> <digest-reference>" per image built in this run, tagged only after all have passed.
pending="$work/pending"
: > "$pending"
# The images this run leaves alone, because their tag already names this commit's build.
kept=''

# 1. Tag immutability. Nothing is built until every planned tag is known to be absent, or to be
#    this commit's own earlier, complete publication.
if [ "$dry_run" = false ]; then
  while read -r name _ <&3; do
    tagged="$registry/agent-workspace/$name:$tag"
    if published="$(node infra/release/resolve-digest.mjs "$tagged")"; then
      published_revision="$(node infra/release/image-revision.mjs "$published")"
      if [ "$published_revision" != "$revision" ]; then
        echo "::error::$tagged is already published from revision $published_revision, not $revision. A published tag is never moved; release a new version instead." >&2
        exit 1
      fi
      if [ "$security" = required ]; then verify_published "$published"; fi
      printf 'kept: %s is already %s, built from %s\n' "$tagged" "$published" "$revision"
      kept="$kept $name"
      record "$name" "$published"
    else
      status=$?
      if [ "$status" -ne 3 ]; then
        echo "::error::could not tell whether $tagged is published (resolve-digest exited $status); nothing was built" >&2
        exit 1
      fi
      printf 'absent: %s\n' "$tagged"
    fi
  done 3< "$plan"
fi

# 2. Build and push by digest, then gate that digest.
publish() {
  name="$1"
  dockerfile="$2"
  target="$3"
  shift 3
  repository="$registry/agent-workspace/$name"
  metadata="$work/$name.metadata.json"
  if [ "$dry_run" = true ]; then
    docker buildx build \
      --platform "$platforms" \
      --file "$dockerfile" \
      --target "$target" \
      --output "type=image,name=$repository,push-by-digest=true,push=false" \
      --metadata-file "$metadata" \
      --build-arg "VCS_REF=$revision" \
      --label "$revision_label" \
      --label "$version_label" \
      "$@" .
    digest="$(node -p "JSON.parse(require('node:fs').readFileSync(process.argv[1], 'utf8'))['containerimage.digest']" "$metadata")"
    printf 'dry run: built %s@%s for %s, pushed and tagged nothing\n' "$repository" "$digest" "$platforms"
    return
  fi
  docker buildx build \
    --platform "$platforms" \
    --file "$dockerfile" \
    --target "$target" \
    --output "type=image,name=$repository,push-by-digest=true,name-canonical=true,push=true" \
    --metadata-file "$metadata" \
    --build-arg "VCS_REF=$revision" \
    --label "$revision_label" \
    --label "$version_label" \
    ${IMAGE_SOURCE:+--label "$source_label"} \
    "$@" \
    --provenance=mode=max,version=v0.2 \
    --sbom=true .
  digest="$(node -p "JSON.parse(require('node:fs').readFileSync(process.argv[1], 'utf8'))['containerimage.digest']" "$metadata")"
  digest_ref="$(node infra/release/verify-reference.mjs "$repository@$digest")"
  if [ "$security" = required ]; then
    # Every platform of the index, not only the runner's: each is scanned, described by its own
    # SBOM and checked for the provenance BuildKit recorded for it.
    old_ifs="$IFS"
    IFS=,
    for platform in $platforms; do
      IFS="$old_ifs"
      slug="$(printf '%s' "$platform" | tr '/' '-')"
      sbom="$evidence/sbom/$name.$slug.spdx.json"
      provenance="$evidence/provenance/$name.$slug.slsa.json"
      syft --platform "$platform" "$digest_ref" -o "spdx-json=$sbom"
      # The same gate CI runs on every pull request (#373): its flags live only in trivy-gate.sh.
      sh infra/release/trivy-gate.sh --platform "$platform" "$digest_ref"
      # The SLSA provenance BuildKit attached to the index, signed again as a cosign attestation
      # so that `cosign verify-attestation --type slsaprovenance` (release.yml) finds it.
      docker buildx imagetools inspect "$digest_ref" \
        --format "{{ json (index .Provenance \"$platform\").SLSA }}" > "$provenance"
      node infra/release/check-provenance.mjs "$provenance" "$digest_ref ($platform)"
    done
    IFS="$old_ifs"
    cosign sign --yes "$digest_ref"
    for platform in $(printf '%s' "$platforms" | tr ',' ' '); do
      slug="$(printf '%s' "$platform" | tr '/' '-')"
      cosign attest --yes --type spdxjson --predicate "$evidence/sbom/$name.$slug.spdx.json" "$digest_ref"
      cosign attest --yes --type slsaprovenance --predicate "$evidence/provenance/$name.$slug.slsa.json" "$digest_ref"
    done
    verify_published "$digest_ref"
  fi
  printf '%s %s\n' "$repository:$tag" "$digest_ref" >> "$pending"
  record "$name" "$digest_ref"
}

while read -r name dockerfile target engine engine_version <&3; do
  if [ -n "$only" ]; then
    case " $only " in *" $name "*) ;; *) continue ;; esac
  fi
  case " $kept " in *" $name "*) continue ;; esac
  if [ "$engine" = - ]; then
    publish "$name" "$dockerfile" "$target"
  else
    # runtime.Dockerfile re-checks ENGINE_VERSION against the manifests it copied.
    publish "$name" "$dockerfile" "$target" \
      --build-arg "ENGINE=$engine" \
      --build-arg "ENGINE_VERSION=$engine_version"
  fi
done 3< "$plan"

if [ "$dry_run" = true ]; then
  printf 'dry run complete: nothing was pushed or tagged and no manifest was written\n'
  exit 0
fi

# 3. Every image passed: only now does any of them get its release tag.
while read -r tagged digest_ref <&3; do
  docker buildx imagetools create --tag "$tagged" "$digest_ref"
  tagged_ref="$(node infra/release/resolve-digest.mjs "$tagged")"
  if [ "$tagged_ref" != "$digest_ref" ]; then
    echo "::error::$tagged resolves to $tagged_ref, not the digest that passed ($digest_ref)" >&2
    exit 1
  fi
  printf 'tagged: %s -> %s\n' "$tagged" "$digest_ref"
done 3< "$pending"

printf '%s\n' "$records" | node infra/release/write-manifest.mjs "$output" "$tag" "$platforms" "$revision"
printf 'release manifest: %s\n' "$output"
