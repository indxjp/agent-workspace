/**
 * `@agent-workspace/engine` — the engine port, and the pieces every adapter behind it shares.
 *
 * The split is the dependency direction ENG-04 (#303) is about:
 *
 *   * `port.ts`        — the interface an adapter implements. Declarations, no behaviour.
 *   * `frames.ts`      — the neutral `agent.*` builders, so an adapter names its engine once.
 *   * `path-grant.ts`  — path normalisation and file grants, and the workspace verdicts built on
 *                        them. Shared because a grant means the same thing on every engine, and a
 *                        second implementation of it is a second chance to get `..` wrong.
 *   * `resolved-path.ts` — the symlink-resolving guard, over an injected filesystem.
 *   * `adapter.ts`     — `createEngineAdapter`, the `start()` skeleton (#951).
 *   * `compile-checks.ts` — the refusals every adapter's `compile` opens with (#951).
 *   * `tool-plan.ts`   — the permission → tool plan (#951).
 *   * `sandbox-env.ts` — spec A.11's *"provider master credentials never enter a sandbox"*, as a
 *                        property of the environment rather than a list of one provider's names.
 *   * `session-state.ts` — the blob cap, the stream-key rendering, the durability fold and the
 *                        store write log every engine's session store shares (ENG-06).
 *   * `skills.ts`      — where an adapter may place a skill, and the check the runner applies to
 *                        the answer before it writes a byte (ENG-04b).
 *   * `skill-script.ts` — `run_skill_script`: a skill's Node script, run with no shell under Node's
 *                        permission model, over an injected host (ADR-0137).
 *   * `refusal.ts`    — `EngineRefusalError`, the typed refusal an adapter can only reach in
 *                        `start()`, which the runner answers like a `compile` refusal.
 *   * `prices.ts`     — the provisional price table an adapter-level budget cap is measured with
 *                        (ADR-0074 D7), shared by every adapter that enforces one (ADR-0081).
 *
 * The conformance kit is **not** re-exported here. It lives at `@agent-workspace/engine/testing`
 * so that importing the port does not pull a fake gateway and a scripted engine into a runtime
 * image — the same reason `@agent-workspace/core` keeps its database layer behind `/db`.
 */
export const PACKAGE_NAME = '@agent-workspace/engine';

export * from './port.js';
export * from './frames.js';
export * from './path-grant.js';
export * from './sandbox-env.js';
export * from './session-state.js';
export * from './skills.js';
export * from './skill-script.js';
export * from './prices.js';
export * from './credential-rejection.js';
export * from './refusal.js';
export * from './compile-checks.js';
export * from './tool-plan.js';
export * from './resolved-path.js';
export * from './adapter.js';
