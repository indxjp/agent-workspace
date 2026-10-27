/**
 * `@agent-workspace/engine-pi` — one factory, the adapter's only entry point (W3-8).
 *
 * The runner's registry (`apps/runner/src/engines.ts`) calls it once per process; a test injects
 * a fake run starter through its parameters. Everything behind it is internal and reachable for
 * this repository's tests through `@agent-workspace/engine-pi/testing`.
 * `tests/engine-adapter-surface.test.ts` fails if this file grows a second value export.
 */
export { createPiEngine } from './engine.js';
export type { PiRunStarter } from './boundary.js';
export type { PiCompiled } from './compile.js';
