/**
 * The identity context's public entry (refactoring plan part 04, step 7).
 *
 * Code in another context (agents, execution, integrations, …) imports identity from here, not from
 * the folders underneath (`auth/`, `rbac/`, `oauth/`, `setup/`, …). `pnpm architecture:check`
 * enforces it: the `context-identity-entered-through-its-entry` rule in dependency-cruiser.config.mjs
 * refuses a new deep import, and the deep imports that were left when the rule landed are in
 * .dependency-cruiser-known-violations.json, where they can only shrink. Tests, `composition/` and
 * identity's own modules keep importing the modules directly, and code outside the context map
 * (route handlers in `app/`, the files at the root of `server/`) is not covered yet.
 *
 * Only modules without start-up work are re-exported as values: the authorization decision, roles,
 * principals, key and token helpers. Importing this file loads no application context, no feature
 * switch and nothing that only Next.js can load. These deep imports stay, on purpose, and are in the
 * baseline:
 *
 *   * `rbac/http.ts` (`authorise`, `problem`): it loads the application context and the feature
 *     switches, so re-exporting it would start them for every caller of `decide`.
 *   * `auth/index.ts` (`getSession`): it imports `next/headers`.
 *   * `oauth/resource.ts`: it imports `endpoints/`, downstream of identity, so re-exporting it would
 *     close an import cycle through this file.
 *   * `cli-auth/local-runtime-key-guard.ts`: it loads about 220 modules.
 *   * `runs/acceptance/run-acceptance.mjs` (run by Node directly) and
 *     `shares/runnable/visitor-identity.ts` import with an explicit `.ts` path, which this file's
 *     extensionless re-exports do not offer.
 *
 * The types callers need from `rbac/http.ts` are re-exported below with `export type`, which loads
 * nothing at run time.
 *
 * No identity module imports this file: that would be a cycle, and `no-circular-dependencies`
 * refuses it.
 */
export { checkRequestOrigin } from '../auth/origin';
export { readDeploymentWorkspaceSlug } from '../auth/session';
export { clientSecretDigest, mintClientSecret } from '../oauth/tokens';
export { hashApiKeySecret, hashesEqual, mintApiKey, randomToken } from '../rbac/api-key';
export { mayAccessSession, ownerPrincipalIdOf } from '../rbac/core/owner-principal';
export { grantsFor, type Grant } from '../rbac/core/permissions';
export { parseRole, ROLES, type Role } from '../rbac/core/roles';
export type { TokenScope } from '../rbac/core/token-scope';
export { decide, type Decision, type Ownership } from '../rbac/decide';
export type { DirectoryRoot, WorkspaceDirectory } from '../rbac/directory';
export type { OwnershipOutcome, OwnershipResolver } from '../rbac/http';
export { Principal, type OAuthGrant, type PrincipalKind, type Via } from '../rbac/principal';
export type { ResolveRunOwnership, RunOwnershipPrincipal } from '../rbac/run-ownership';
export { setupConnectionName } from '../setup/runtime';
export type { TokensRuntime } from '../tokens/runtime';
export type { WorkspaceFeatureStore } from '../workspaces/features-runtime';
export type { RunGate } from '../workspaces/run-gate';
