# W2-INT-01 — Two new deployment variables, no default for either, and the two files that must carry them are not this task's

Status: accepted
Date: 2026-09-05
Task: W2-INT-01 (sub-wave 2b-1 integrator)
Scope: `apps/web/instrumentation.ts`; a declared gap in `.env.example` and `compose.yaml`

## Context

Two of the three subsystems this task installs need a directory, and neither had a variable to read
it from.

- **`/api/files*` (W2-CP-03)** — the local-filesystem `ObjectStore` is constructed as
  `createLocalFilesystemObjectStoreProvider(rootDir)`. Spec §16 names *"Development: Local
  filesystem"* and §37 names `OBJECT_STORAGE_ENDPOINT`, which is an S3 endpoint and not a path; the
  S3 backend does not exist yet (`docs/adr/W2-CP-03-s3-minio-backend-blocked.md`).
- **`/api/sessions**` (W2-CP-07)** — `new FileTranscriptStore(root)`.
  `docs/adr/W2-CP-07-the-two-wiring-lines-this-task-does-not-own.md` already names the variable it
  expects, `AW_SESSION_TRANSCRIPT_ROOT`, in the code it wrote out.

## Decision

**`AW_FILE_STORAGE_ROOT` and `AW_SESSION_TRANSCRIPT_ROOT`, both read by
`apps/web/instrumentation.ts`, both with no default, and an unset or blank value leaves the
corresponding seam uninstalled and its routes on the 503 that names it.**

`AW_SESSION_TRANSCRIPT_ROOT` is W2-CP-07's own name, taken rather than reinvented.
`AW_FILE_STORAGE_ROOT` follows it and the repository's existing `AW_`-prefixed convention
(`AW_ACCEPTANCE_HARNESS`, `AW_SESSION_MIRROR_URL`).

**Neither gets a default, and that is the decision rather than an omission.** A default path would
install a store nobody configured. Inside the `web` container `compose.yaml` mounts no volume, so a
guessed directory is one whose contents are gone at the next restart while `GET /api/files` answers
`200` with an empty list — a workspace that reads as *empty* rather than as *unavailable*. That is
ADR-0015's shape exactly: a fallback indistinguishable from success. §14.9 makes the same point
about sessions in stronger terms, and `SESSION_API_NOT_CONFIGURED_MESSAGE` already says the server
*"will not fall back to an in-memory store."* A blank string is treated as unset for the same
reason — `FOO=` in a `.env` is an operator who has not filled it in, not an operator who chose the
empty path.

## Consequences

- A deployment that sets both serves files and sessions. A deployment that sets neither serves
  neither and says which variable is missing, once, at start-up, before a user sees a 503.
- **`docker compose up -d` sets neither, so those routes still answer 503 there.** `.env.example`
  and `compose.yaml` are not in this task's `Owns` globs — `.env.example` is W1-INF-01's and
  `compose.yaml` is the deployment task's — and ADR-0038's whole subject is that reaching into
  another task's file is what produced this sub-wave's defect. So the change is declared here, with
  its exact content, and not made:

  ```yaml
  # compose.yaml, services.web.environment
  AW_FILE_STORAGE_ROOT: ${AW_FILE_STORAGE_ROOT:-/var/lib/agent-workspace/files}
  AW_SESSION_TRANSCRIPT_ROOT: ${AW_SESSION_TRANSCRIPT_ROOT:-/var/lib/agent-workspace/sessions}
  # …and a named volume mounted at /var/lib/agent-workspace, or both are lost on restart.
  ```

  A default is defensible *there* and not here: a compose file that mounts a volume at the path it
  names has configured the store, which is a different act from a program inventing one.
- The same gap applies to the runner's two mirror variables
  (`docs/adr/W2-INT-01-the-runner-has-a-composition-root-too-and-it-is-the-integrators.md`) —
  `AW_SESSION_MIRROR_URL` and `AW_SESSION_MIRROR_COOKIE` are read now and set by nothing in
  `compose.yaml`.
- `.env.example`'s comment that `MASTER_ENCRYPTION_KEY` is *"NOT READ BY ANY CODE IN THIS
  REPOSITORY YET"* became false when W2-CP-02 landed and is doubly false now that this composition
  root calls `createSecretsService`. W2-CP-02 declared that gap; this task inherits and re-declares
  it rather than editing the file.
- This task's non-503 proof therefore drives a server started with both variables set. That is not
  a substitute for the criterion (ADR-0035): the criterion is *"a deployment built from this
  branch"*, and a deployment is its build **plus its configuration**. What would be a substitute,
  and is not done, is reporting the routes as reachable in a deployment that does not set them.

## Related

- [ADR-0015](0015-gates-decide-on-positive-assertions.md) — the reason neither variable has a
  default.
- [ADR-0038](0038-the-composition-root-and-the-shared-manifest-belong-to-the-integration-level.md)
  — why the two files that must carry the variables are declared rather than edited.
- `docs/adr/W1-INF-01-env-example-is-six-values.md` — the record that decided what `.env.example`
  holds, and the one a future edit answers to.
