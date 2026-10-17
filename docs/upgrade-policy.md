# Claude Agent SDK upgrade policy

The SDK is an upstream dependency. Its current contract version is generated in
[`docs/research/R-01-options.json`](research/R-01-options.json), and every manifest that declares the
SDK must use that exact version.

| Section 42 rule                                                 | Enforcement                                                                                                                                            |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Do not copy SDK internals into this repository.                 | `tests/sdk-surface.test.ts` checks the allowed SDK surface; broader semantic copying is **not enforced**.                                              |
| Pin a compatible version.                                       | `scripts/release/check.mjs` rejects ranges, tags, URLs, and versions different from `docs/research/R-01-options.json`.                                 |
| Automate tests against upgrades.                                | `tests/sdk-surface.test.ts` compares the installed SDK surface with the research contract, and `tests/release/check.test.ts` checks declaration drift. |
| Keep SDK-specific translation concentrated in one small module. | `tests/no-sdk-import.test.ts` restricts direct SDK imports to `apps/runner/src/claude.ts`.                                                             |

## Upgrade procedure

1. Research the target SDK version and regenerate the R-01 contract from the shipped declaration
   surface.
2. Change the exact manifest specifier and regenerate `pnpm-lock.yaml` once.
3. Run `pnpm typecheck`, `pnpm lint`, `pnpm test`, and `pnpm release:check`.
4. Review changes in `apps/runner/src/claude.ts`; an option change should not require provider or
   product code to import SDK internals.

A green dependency update does not establish live-provider compatibility. Run the provider suite
with approved credentials when available, and leave unrun cells weakened in the published matrix.
