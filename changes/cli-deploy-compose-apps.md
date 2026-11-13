---
changelog: cli
section: Added
---

- A single-vm `aw deploy production` runs each app listed in `environments.production.apps`
  beside the platform. It writes `compose.apps.yaml` (`0600`) next to the state's `compose.yaml`
  and sets `COMPOSE_FILE=compose.yaml:compose.apps.yaml` in `.env`. For each app a one-shot
  `app-<name>-role` service creates the database role and schema `app_<name>`, which the role
  owns; the role holds no privilege on the database, so it can create no other schema. The
  `app-<name>` service then runs the digest-pinned image with a `DATABASE_URL` for that role, never
  the platform's, and publishes it on `127.0.0.1:<3100 + i>`. The app's database
  password and identity secret are generated into `.env` once. When the last app is removed, the
  overlay is emptied and `COMPOSE_FILE` dropped, and the container is left running. The printed
  next steps name each app's Caddy site, `.env` lines and connector.
- The Compose deploy step runs with `.env`'s `COMPOSE_FILE`, or none, whatever the shell sets, as
  it already did for `COMPOSE_PROJECT_NAME`.
- A single-vm project refuses an app name longer than 59 characters at
  `environments.production.apps.<name>`, because its role `app_<name>` must fit PostgreSQL's
  63-byte identifier.
