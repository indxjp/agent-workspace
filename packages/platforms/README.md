# @indx-workspace/platforms

Translators from a `PortableProject` (`@indx-workspace/contracts/portable-agent`) to the files an
external agent host takes, and back where the host allows it. The design is
ADR-0133
D6-D8. The package is published in lock-step with `@indx-workspace/contracts`; six targets ship: `claude-managed-agents`,
`copilot-studio`, `m365-declarative-agent`, `microsoft-foundry`, `gemini-enterprise` (compile only)
and `aws-agentcore`, each at
`@indx-workspace/platforms/<target>`.

- `PlatformTarget` is the port: an id, a capability matrix, an options schema, a pure `compile`
  and an optional `import`.
- Every field of the project gets one verdict in the report: `native`, `mapped`, or `dropped` with a
  drop code. Nothing is dropped silently. Paths are `toolEndpoint`, then `<agent>.<field>`
  (`portableFieldPaths`).
- Call `compileForPlatform(target, project, options)`, not `target.compile`: it checks the root
  agent, validates the options and orders the output.
- Production code is pure: no Node built-in, clock, randomness or environment. `platforms-are-pure`
  in `dependency-cruiser.config.mjs` and an ESLint block enforce it. The only npm dependencies are
  `@indx-workspace/contracts`, `zod` and `yaml` (`src/dependencies.test.ts`), and the package
  `tsconfig.json` has no Node types; `tsconfig.test.json` adds them for the kit and the tests.

## Adding a target

1. Add `src/targets/<id>/index.ts` exporting a `PlatformTarget` whose `id` is in `PLATFORM_IDS`,
   add it to `PLATFORM_TARGETS` in `src/registry.ts` (in `PLATFORM_IDS` order) and give it a
   `./<id>` subpath in `package.json` `exports` and `publishConfig.exports`.
2. Build its report from `portableFieldPaths`, `capabilityOfPath` and the `native`, `mapped` and
   `dropped` builders.
3. Test it with `@indx-workspace/platforms/testing`: `runPlatformConformance(target)` and a golden
   from `expectGoldenFiles` (data files) or `expectGoldenBundle` (generated source, one `.txt`).
   `UPDATE_GOLDEN=1` rewrites goldens. `loadGoldenProject` reads `<goldenDir>/input.json`.
4. Regenerate the platform matrix with
   `node tests/platform-matrix/run.mjs`; `pnpm docs:check` fails while it is stale.
