# W1-INF-01 — `.env.example` carries six values, not §37's four, and the bundled services' passwords are literals

Status: accepted
Date: 2026-09-03
Decided by: W1-INF-01 (Infra)
Scope: `.env.example`, `compose.yaml`

## Context

Spec §37 lists four deployment-level environment variables — `DATABASE_URL`,
`MASTER_ENCRYPTION_KEY`, `OBJECT_STORAGE_ENDPOINT`, `BOOTSTRAP_ADMIN` — and this task's brief is
emphatic that `.env.example` is limited to them: *"Not five. Not 'a few extras that might be
useful'."*

Two facts make the literal four impossible.

First, W1-CP-06 built the authentication gate around two variables §37 does not name:
`SESSION_SECRET` (the session cookie's HMAC key) and `BOOTSTRAP_ADMIN_PASSWORD`. Both fail closed.
Absent either, the deployment starts and answers `401` to **every** `/api/**` request, logging
which variable is missing. That task recorded the coordination cost against this one, by name, in
`W1-CP-06-bootstrap-credential-is-a-deployment-value.md`: *"W1-INF-01 must add
`BOOTSTRAP_ADMIN_PASSWORD` and `SESSION_SECRET` … either way the §37 list is now six values rather
than four."*

Second, two of §37's own four are read by no code in this repository yet.
`MASTER_ENCRYPTION_KEY` is §23's secrets store (Wave 2) and `OBJECT_STORAGE_ENDPOINT` is §16's file
management (Wave 2). So the literal reading produces a file where half the entries do nothing and
the two that decide whether the product works at all are absent.

There is a third question the file forces: the bundled `postgres` and `minio` need credentials, and
`DATABASE_URL` is a single opaque string that compose cannot decompose into `POSTGRES_USER` and
`POSTGRES_PASSWORD`.

## Decision

**`.env.example` holds six values: §37's four, plus `SESSION_SECRET` and
`BOOTSTRAP_ADMIN_PASSWORD`.** The two credentials ship **blank**, with the command that generates
one, so that a deployment either has a real secret or refuses to start. §37's two unread values
ship with the label *"NOT READ BY ANY CODE IN THIS REPOSITORY YET"* and the wave that will read
them, because an entry that does nothing and does not say so is the file misleading its reader.

`compose.yaml` marks four of the six `${VAR:?message}` — required, with the fix in the error — and
that is the same fail-closed decision W1-CP-06 took, moved earlier and made louder: a missing
`SESSION_SECRET` stops `docker compose up` rather than producing a running server that refuses
every request.

**The bundled `postgres` and `minio` credentials are literals in `compose.yaml`, not variables.**
Neither service publishes a port; both are reachable only on the internal bridge network. They
authenticate a service to a service inside one Docker network, they are not the deployment's
secrets, and promoting them would put two more entries in the file §37 wants small while protecting
nothing. The reasoning depends entirely on those ports staying unpublished, so it is written beside
them in `compose.yaml` rather than only here.

**§37's rule is honoured where it actually bites**, which is not the count: no model, tool, skill,
connector, permission, runtime-profile or agent setting is in this file or ever may be. That is the
sentence §37 is made of — *"Agent-specific configuration belongs in the database"* — and it holds
exactly.

## Alternatives rejected

* **Exactly four, and let the deployment 401 everything.** The literal brief. It produces a
  `docker compose up -d` that satisfies §46's command and fails §46's criterion on the next line,
  and it silently ignores a peer task's explicit, recorded, correct request.
* **Exactly four, with the two credentials required from the environment but absent from the
  example.** Compose reads `.env` and nothing else; a variable that is mandatory but undocumented
  is a first run that fails with an error naming a variable the operator has never seen.
* **Generate `SESSION_SECRET` at start-up when unset.** Removes a variable and silently invalidates
  every session on every restart, breaks §32 Cluster Mode's multiple `web` replicas outright, and —
  worst — turns a misconfiguration into behaviour that looks like it works. W1-CP-06 rejected this
  for the same reasons; agreeing with it here rather than re-litigating it.
* **Ship a default `SESSION_SECRET` in the example.** A shipped secret is a published secret. Every
  deployment that never edited the file would share one signing key.
* **Drop `MASTER_ENCRYPTION_KEY` and `OBJECT_STORAGE_ENDPOINT` because nothing reads them.** Would
  get the count back to four by removing two of §37's own names. It also makes provisioning a
  machine a two-visit job: generate one key now, another when Wave 2 lands.
* **Promote the Postgres and MinIO passwords to `.env`.** Eight values, two of which are ceremony
  for a network no one outside the host can reach.

## Honest downside

**Six is not four, and the next reader will notice.** The count in this file no longer matches the
count in the specification, and the only thing keeping that from becoming drift is this record and
the paragraph in `.env.example` that points at it. If §37 is ever amended, it should be amended to
say six.

**The `${VAR:?}` markers make a missing variable a start-up failure rather than a runtime one.**
That is intended, and it means an operator who removes `SESSION_SECRET` from a working `.env`
discovers it at `docker compose up` rather than at the next sign-in. It also means `docker compose
config` cannot be run in a directory without a `.env` — for instance in CI — without those four
being set in the environment first.

**The literal database password is defensible only while the port stays unpublished.** Someone will
eventually add `ports: ['5432:5432']` to debug something. Nothing in this file stops them; only the
comment beside the credential says why they must change the password when they do. A gate would be
better than a comment, and there is nowhere in Wave 1 to put one.
