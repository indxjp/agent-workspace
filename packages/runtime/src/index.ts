/**
 * `@agent-workspace/runtime` — the runtime (sandbox) driver interface and its implementations.
 *
 * Runtime contracts, concrete local drivers, and transfer support.
 *
 *   * `driver.ts` — the whole of spec §14.2's `RuntimeDriver` (including the optional
 *     `putFiles`/`getFiles` pair), `RuntimeHandle` and `AgentConnection`, plus §14.5's
 *     `RuntimeCapabilities`. One abstraction, as §14.1 rule 3 requires.
 *   * `types.ts`  — spec §15.1's `RuntimeProfile`, the reusable resource/network settings a
 *     `RuntimeConfig` now references by id (see `driver.ts`).
 *   * `local.ts`  — the `local` driver of §14.4: no sandbox, and a capability record that says so.
 *   * `engine-images.ts` — ENG-07's `engine → image` map: its parser, its labels, and the
 *     `engine_not_installed` refusal an engine with no configured image answers.
 *
 * `sandbox-runtime` is a reserved contract id (`RuntimeDriverId`) with no driver here. This
 * package has **no dependencies**, deliberately: see the header of `driver.ts` for why the
 * request and event types are parameters rather than imports from `@agent-workspace/core`, and
 * the header of `types.ts` for why `RuntimeProfile` carries no Zod schema here.
 */
export const PACKAGE_NAME = '@agent-workspace/runtime';

export * from './driver.js';
export * from './engine-images.js';
export * from './types.js';
export * from './local.js';
export * from './docker.js';
export * from './kubernetes.js';
export * from './cloud-run.js';
export * from './gcp-auth.js';
export * from './external/index.js';
export * from './vercel-sandbox.js';
export * from './cloudflare-sandbox.js';
export * from './aca-sessions.js';
export * from './azure-auth.js';
export * from './transfer.js';
