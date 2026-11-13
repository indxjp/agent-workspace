# Example apps

Each directory here is an app a customer could have written: a project made with
`npm create @indx-workspace`, grown with `aw generate` and a small amount of code of its own. They
import only the published `@indx-workspace/*` packages, exactly as an app outside this repository
does, so they show what the published packages can build without a fork.

The examples are not pnpm workspace members, and no root gate (type check, lint, the import
boundary check, formatting) looks inside them: a workspace member would resolve
`@indx-workspace/*` to this repository's sources instead of the published tarballs, which is the
thing an example must not do. They are kept honest by the apps benchmark instead.

## The benchmark

Every app is scored on six cells, and an app meets the bar when every cell is ✅:

| Cell               | Measured by                                                                                                                  |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| Generated          | running the app's `commands.sh` again gives every file `aw-generated.json` records and the app has not edited, byte for byte |
| Handwritten budget | the lines in files the generators did not write, or that were edited since, are within the app's budget                      |
| Journeys           | the app's Playwright journeys pass against the installed app                                                                 |
| Agent on data      | an agent reads and writes the app's data as the person who asked, and is refused beyond what that person may do              |
| Self-host          | `aw deploy` renders the app into Compose and Helm, and the Compose stack boots it                                            |
| No fork            | the app imports only published packages: no platform package, no path outside the app, no workspace or path dependency       |

`pnpm test` computes Handwritten budget, No fork and the manifest half of Generated for every app
(`tests/apps/benchmark.test.ts`), and checks that every declared verdict names evidence that
exists. Journeys, Self-host and the full Generated check need an installed app, so the apps lane
runs them: the CI job `apps-e2e`, or locally, from a built checkout,

```sh
pnpm build
node tests/apps/lane.mjs --app minimal
```

Per app it regenerates the app from `commands.sh`, installs a copy against the packed packages,
runs `next build`, the app's own tests under `tests/` and its `dependency-cruiser.config.mjs`,
starts it under `aw dev` with a scripted fake model (the app's `e2e/model-script.json`) and runs
its `e2e/*.e2e.mjs` journeys signed in as a person (the wiki, CRM and service desk through the
portal's own `/sign-in` at `aw dev`'s development issuer, as the bootstrap Owner), once with
`app/theme.ts` in English and once in
Japanese, then plans `aw deploy production` into Compose and Helm with the app's image, builds that
image with `npm run image` (its `npm ci` installs the packed packages from a loopback registry the
lane serves) and boots the platform with it (Self-host needs Docker). A step that fails or cannot run is a gap for its cell, never ✅. A
cell an app claims but the lane measures as a gap fails the lane; so does any journey other than
the ones a declared Journeys gap names (its `ref` and, when more than one journey is not met, each
title of its `alsoExcused`).

The handwritten count leaves out `commands.sh`, `benchmark.ts`, `README.md`, `e2e/`, `tests/`,
`.aw/`, lockfiles, `node_modules/`, `.next/` and the migration journal's `meta/` directory, and
counts lines that are neither blank nor only a comment. A generated file that has been edited
counts in full, after the edits the generators recorded (an import added to `app.config.ts`, a
migration added to the journal) are taken out.

An app edits a generated file only by taking it over: its `benchmark.ts` lists the file in
`takenOver` (a recipe's body, a resource's `agents.write`). Generated then leaves that file out of
its comparison, `--write` leaves it alone, and the budget counts it in full. Any other edit of a
generated file is a Generated gap.

<!-- apps-benchmark:start -->

| App | Reference | Generated | Handwritten budget | Journeys | Agent on data | Self-host | No fork | Handwritten / budget |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| [Minimal fixture](./minimal/) | no (fixture) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | 0 / 0 |
| [Team chat](./team-chat/) | yes | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | 85 / 150 |
| [Wiki](./wiki/) | yes | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | 59 / 100 |
| [CRM](./crm/) | yes | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | 141 / 200 |
| [Service desk](./service-desk/) | yes | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | 246 / 250 |

<!-- apps-benchmark:end -->

## An app's files

- `commands.sh`: the commands that write it, run from an empty directory.
- `aw-generated.json` and every file it records: the unedited output of those commands, except the
  generated files the app has taken over (listed as `takenOver` in its `benchmark.ts`), which count
  in full as handwritten; the manifest itself is always compared, so a generator that now writes
  one of them differently still shows.
- `benchmark.ts`: its declaration (budget, the generated files it has taken over, the evidence for
  Journeys, Agent on data and Self-host). It imports nothing, so the app reaches nothing outside its own directory;
  `tests/apps/registry.ts` lists it.
- Everything else is the app's handwritten code, which the budget counts.

## Regenerating an app

After a generator or template change, write an app's generated files again, from a built
checkout:

```sh
pnpm build
node tests/apps/regenerate.mjs --write minimal
```

`--check` runs the same commands and fails naming each file that differs. Both pack the published
packages, run `commands.sh` against the packed tarballs (they are installed through overrides added
to the new project's `pnpm-workspace.yaml`, which the comparison takes out again) and compare every
file the manifest records but the ones the app has taken over; `--write` leaves the app's
handwritten and taken-over files alone. The comparison ignores one other thing: the lock-step
`@indx-workspace/*` version, which a release moves in every `package.json` and so in the
manifest's hashes. An app keeps the version it was written at until it
is written again. Lockfiles are not committed here, so no example adds to the dependency audit.
