# Contributing

Thank you for helping. By taking part you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).

## Before you start

Open an issue for anything non-trivial and wait for a maintainer to agree on the approach before
you write code. Small fixes (typos, obvious bugs) can go straight to a pull request.

## Development setup

- Node.js 24 and pnpm 12 (`corepack enable` provides the pinned pnpm).
- Docker, which `pnpm test` uses to provision its databases.

```sh
corepack enable
pnpm install
```

## Checks

Run these before you ask for review:

```sh
pnpm check:fast
pnpm test
pnpm build
```

Tests that exercise the complete repository require `TEST_DATABASE_URL` pointing to PostgreSQL 18.

The repository's `compose.yaml` runs PostgreSQL 18 (ADR-0159). A `postgres-data` volume that
PostgreSQL 17 initialised does not start under 18. Remove it to start empty
(`docker compose down --volumes`), or keep its rows by dumping them with the 17 image before you
pull, and restoring the dump into the new volume:

```sh
docker compose exec -T postgres pg_dump -Fc -U agent_workspace agent_workspace > dev.dump   # still on 17
docker compose down --volumes && docker compose up -d postgres
docker compose exec -T postgres pg_restore --clean --if-exists --no-owner -U agent_workspace -d agent_workspace < dev.dump
```

## Coding standard

- [`ENGINEERING_GUIDELINES.md`](ENGINEERING_GUIDELINES.md)
- [`AGENTS.md`](AGENTS.md)
- [`docs/architecture.md`](docs/architecture.md)
- [`docs/adr/README.md`](docs/adr/README.md) for recorded decisions

Do not weaken a quality gate, broaden an ignore or add a suppression to make a change pass.

## Pull requests

Fill in the pull request template.

## Commit and merge

Pull requests are squash-merged. Use a Conventional-Commit-style title, for example
`fix(sdk): retry the event stream after a reset`.

Pull requests are merged by importing them into the maintainers' source repository; you keep
authorship and the change appears here with the next snapshot.

## Repository conventions

The repository relies on these decisions; each links to the record that explains it.

| Convention                                                                                   | Record                                                                                   |
| -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| A gate decides on a positive assertion, never the absence of a negative                      | [ADR-0015](docs/adr/0015-gates-decide-on-positive-assertions.md)                         |
| A measured number is generated or absent — never written into prose                          | [ADR-0016](docs/adr/0016-measured-numbers-do-not-live-in-prose.md)                       |
| A manifest belongs to its package; the lockfile is generated, and conflicts are re-generated | [ADR-0017](docs/adr/0017-manifests-belong-to-their-package-the-lockfile-is-generated.md) |
| Repository-wide gates are owned at the integration level                                     | [ADR-0019](docs/adr/0019-repo-wide-gates-belong-to-the-integration-level.md)             |
| ADR filenames are task-scoped so parallel tasks cannot collide                               | [ADR-0003](docs/adr/0003-adr-naming-preserves-file-ownership.md)                         |

## Licence

Contributions are licensed under Apache-2.0, as set out in section 5 of [`LICENSE`](LICENSE).
