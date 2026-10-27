/**
 * `@agent-workspace/runtime/driver` — the runtime (sandbox) driver contract, and nothing else.
 *
 *   * `driver.ts` — the whole of spec §14.2's `RuntimeDriver`,
 *     `RuntimeHandle` and `AgentConnection`, plus §14.5's
 *     `RuntimeCapabilities`. One abstraction, as §14.1 rule 3 requires.
 *   * `types.ts`  — spec §15.1's `RuntimeProfile`, the reusable resource/network settings a
 *     `RuntimeConfig` now references by id (see `driver.ts`).
 *   * `RuntimeRefusalError` — the named refusal every driver may answer.
 *
 * Each driver is its own subpath (`@agent-workspace/runtime/driver/<id>`, F-22), so importing one
 * never loads another; `engine-images` and `transfer` are subpaths of their own. The cloud SDKs in
 * this package's manifest (`@azure/identity`, `@kubernetes/client-node`, `google-auth-library`) are
 * loaded by dynamic import on a driver's first call, never by importing a module.
 * `sandbox-runtime` is a reserved contract id (`RuntimeDriverId`) with no driver here. See the
 * header of `driver.ts` for why the request and event types are parameters rather than imports
 * from `@agent-workspace/core`, and the header of `types.ts` for why `RuntimeProfile` carries no
 * Zod schema here.
 */
export const PACKAGE_NAME = '@agent-workspace/runtime';

export * from './driver.js';
export * from './types.js';
export { RuntimeRefusalError, type RuntimeRefusalCode } from './external/errors.js';
