#!/usr/bin/env bash
# Deploy / update this repository's Nx remote cache on Cloud Run + GCS.
# Idempotent: re-running converges every resource and rolls out a new revision.
#
#   PROJECT=<project> OIDC_REPOSITORY=<owner>/<repo> OIDC_REPOSITORY_ID=<id> REGION=us-central1 infra/nx-cache/deploy-gcp.sh
#
# ONE INSTANCE PER REPOSITORY. The service, bucket, service account, both
# secrets and the OIDC audience are all derived from SERVICE, so this
# repository's instance shares nothing with a sibling project's
# cache in the same project. That matters most for the signing key:
# a minted token (auth.mjs, `nxc1.<payload>.<hmac>`) names no service, so two
# services holding the same key would accept each other's tokens — and
# the sibling's `main` could then write this repository's trusted cache. Never
# point SECRET_PREFIX at another instance's secrets.
#
# Creates (if missing): the bucket (private, uniform access, 30-day
# lifecycle, no soft delete), a dedicated service account with ONLY
# objectCreator + objectViewer on that bucket (it can create objects but can
# neither overwrite nor delete one), two Secret Manager secrets (read tokens,
# signing key — generated randomly, never printed), an Artifact Registry repo,
# the image (Cloud Build), and the Cloud Run service (h2c end to end, scale to
# zero). See README.md "Deploying" and ci-cd-per-repo.md "Nx remote cache".
#
# Prints the service URL at the end. It does NOT print any secret: fetch the
# read token for the GitHub secret with
#   gcloud secrets versions access latest --secret=aw-nx-cache-read-tokens --project=$PROJECT
set -euo pipefail

PROJECT="${PROJECT:?set PROJECT}"
REGION="${REGION:-us-central1}"
SERVICE="${SERVICE:-aw-nx-cache}"
BUCKET="${BUCKET:-${PROJECT}-${SERVICE}}"
SA_NAME="${SA_NAME:-${SERVICE}}"
SECRET_PREFIX="${SECRET_PREFIX:-${SERVICE}}"
AUDIENCE="${AUDIENCE:-${SERVICE}}"
SA="${SA_NAME}@${PROJECT}.iam.gserviceaccount.com"
REPO="${REPO:-nx-cache}"
# The only repository whose GitHub OIDC tokens this instance accepts, pinned by
# name AND numeric id (`gh api repos/<owner>/<repo> --jq .id`) so a deleted and
# re-created repository of the same name cannot inherit its trust.
OIDC_REPOSITORY="${OIDC_REPOSITORY:?set OIDC_REPOSITORY (owner/repo)}"
OIDC_REPOSITORY_ID="${OIDC_REPOSITORY_ID:?set OIDC_REPOSITORY_ID (gh api repos/<owner>/<repo> --jq .id)}"
RETENTION_DAYS="${RETENTION_DAYS:-30}"
MAX_INSTANCES="${MAX_INSTANCES:-4}"
HERE="$(cd "$(dirname "$0")" && pwd)"
TAG="$(git -C "$HERE" rev-parse --short HEAD 2>/dev/null || echo nogit)-$(date +%Y%m%d%H%M%S)"
IMAGE="${REGION}-docker.pkg.dev/${PROJECT}/${REPO}/${SERVICE}:${TAG}"
g() { gcloud --project "$PROJECT" --quiet "$@"; }

echo "==> APIs"
g services enable run.googleapis.com storage.googleapis.com secretmanager.googleapis.com \
  artifactregistry.googleapis.com cloudbuild.googleapis.com iam.googleapis.com

echo "==> bucket gs://${BUCKET}"
if ! g storage buckets describe "gs://${BUCKET}" >/dev/null 2>&1; then
  g storage buckets create "gs://${BUCKET}" --location="$REGION" --uniform-bucket-level-access \
    --public-access-prevention --soft-delete-duration=0 --default-storage-class=STANDARD
fi
lifecycle="$(mktemp)"
printf '{"rule":[{"action":{"type":"Delete"},"condition":{"age":%s}}]}' "$RETENTION_DAYS" > "$lifecycle"
g storage buckets update "gs://${BUCKET}" --lifecycle-file="$lifecycle" --soft-delete-duration=0
rm -f "$lifecycle"

echo "==> service account ${SA}"
g iam service-accounts describe "$SA" >/dev/null 2>&1 ||
  g iam service-accounts create "$SA_NAME" --display-name="Nx remote cache (${OIDC_REPOSITORY})"
# objectCreator: create objects (no overwrite — that needs objects.delete).
# objectViewer: read + the metadata lookup used for the 409 fast path.
for role in roles/storage.objectCreator roles/storage.objectViewer; do
  g storage buckets add-iam-policy-binding "gs://${BUCKET}" --member="serviceAccount:${SA}" --role="$role" >/dev/null
done

echo "==> secrets"
ensure_secret() {
  local name="$1"
  if ! g secrets describe "$name" >/dev/null 2>&1; then
    g secrets create "$name" --replication-policy=automatic >/dev/null
    # 48 random bytes, base64url — never echoed.
    node -e 'process.stdout.write(require("crypto").randomBytes(48).toString("base64url"))' |
      g secrets versions add "$name" --data-file=- >/dev/null
    echo "    created $name"
  fi
  g secrets add-iam-policy-binding "$name" --member="serviceAccount:${SA}" \
    --role=roles/secretmanager.secretAccessor >/dev/null
}
ensure_secret "${SECRET_PREFIX}-read-tokens"
ensure_secret "${SECRET_PREFIX}-signing-key"

echo "==> image ${IMAGE}"
g artifacts repositories describe "$REPO" --location="$REGION" >/dev/null 2>&1 ||
  g artifacts repositories create "$REPO" --repository-format=docker --location="$REGION"
g builds submit "$HERE" --tag "$IMAGE" --region="$REGION"

echo "==> Cloud Run ${SERVICE}"
# --use-http2: Cloud Run forwards to the container as h2c, which lifts the
#   32 MiB HTTP/1 request-size limit (Nx tarballs can exceed it).
# --allow-unauthenticated: Nx's client can only send its own bearer token,
#   not a Google identity token, so authN/Z happens in the service itself.
# --concurrency 32 / 1 vCPU / 512 MiB: the service streams; memory is flat
#   per request (see test 11), and CPU is mostly TLS + copying.
g run deploy "$SERVICE" --image="$IMAGE" --region="$REGION" --service-account="$SA" \
  --use-http2 --allow-unauthenticated --ingress=all \
  --min-instances=0 --max-instances="$MAX_INSTANCES" --concurrency=32 \
  --cpu=1 --memory=512Mi --timeout=900 --cpu-boost \
  --set-env-vars="^@^NX_CACHE_HTTP2=1@NX_CACHE_STORAGE=gcs@NX_CACHE_GCS_BUCKET=${BUCKET}@NX_CACHE_OIDC_AUDIENCE=${AUDIENCE}@NX_CACHE_OIDC_REPOSITORY=${OIDC_REPOSITORY}@NX_CACHE_OIDC_REPOSITORY_ID=${OIDC_REPOSITORY_ID}@NX_CACHE_OIDC_WRITE_REFS=refs/heads/main@NX_CACHE_OIDC_WRITE_EVENTS=push,schedule" \
  --set-secrets="NX_CACHE_READ_TOKENS=${SECRET_PREFIX}-read-tokens:latest,NX_CACHE_SIGNING_KEY=${SECRET_PREFIX}-signing-key:latest"

URL="$(g run services describe "$SERVICE" --region="$REGION" --format='value(status.url)')"
echo "==> ${URL}"
curl -fsS "${URL}/v1/health" && echo " (health ok)"
