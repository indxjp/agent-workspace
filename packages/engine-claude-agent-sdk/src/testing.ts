/**
 * `@agent-workspace/engine-claude-agent-sdk/testing` — every module of the adapter, for this repository's tests.
 *
 * The package root exports one factory (W3-8); the formal vector replays, the engine matrix and
 * the parity suites need the pieces behind it, and import them from here instead.
 *
 * The adapter itself: the Claude Agent SDK behind the engine port.
 *
 * Eight modules, and the split is §42's plus ENG-04b's:
 *
 *   * `boundary.ts` — **the** import site of `@anthropic-ai/claude-agent-sdk`, and the only one
 *     in this repository (`tests/no-sdk-import.test.ts` asserts it as a set equality);
 *   * `options.ts`  — the SDK's `Options` as a plain structural type, so nothing outside the
 *     boundary needs the SDK's declarations to type-check;
 *   * `policy.ts`   — the engine-native arm of the private `/run` contract, as a schema;
 *   * `scope.ts`    — `.claude`, written down once, and the tenant session scope derived from it;
 *   * `tools.ts`    — the Claude tool mapping: permissions, connectors and file grants into
 *     `allowedTools` / `disallowedTools` / `tools`;
 *   * `skill-script.ts` — `run_skill_script`'s Node host and tool names (ADR-0137);
 *   * `compile.ts`  — spec §5's compile step: stored configuration in, options object out;
 *   * `engine.ts`   — the {@link AgentEngine} the runner's registry looks up.
 *
 * ENG-04 (#303) assembled this package out of `apps/runner/src/claude.ts`,
 * `packages/core/src/config.ts` and the compiled-options types in `packages/core/src/types.ts`,
 * **without behaviour change**. ENG-04b (#325) closed that unit's Deviations 7 and 8 by moving the
 * tool mapping and the skills placement in from `apps/web` and `apps/runner`, also without
 * behaviour change. Adding an engine is now adding a package beside this one.
 */
export * from './boundary.js';
export * from './compile.js';
export * from './engine.js';
export * from './options.js';
export * from './policy.js';
export * from './scope.js';
export * from './skill-script.js';
export * from './tools.js';
