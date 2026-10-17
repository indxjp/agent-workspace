/**
 * `@agent-workspace/engine-mastra` — Mastra behind the engine port (ENG-10, #309).
 *
 * Ten modules, and the split keeps Mastra in exactly one of them:
 *
 *   * `boundary.ts`  — **the** import site of `@mastra/core`, `@mastra/mcp`, `@mastra/memory` and
 *     the two AI SDK providers (`tests/no-sdk-import.test.ts` asserts it as a set equality);
 *   * `policy.ts`    — the engine-native arm of the private `/run` contract, as a schema;
 *   * `tools.ts`     — the four permission switches into Mastra's workspace tool set;
 *   * `workspace.ts` — which filesystem writes the wrapper lets through, on the path a tool named;
 *   * `guard.ts`     — the same question on the path with its symbolic links resolved;
 *   * `compile.ts`   — the neutral request into a plain, SDK-free configuration;
 *   * `frames.ts`    — Mastra's `fullStream` chunks into the neutral `agent.*` frames;
 *   * `skill-script.ts` — `run_skill_script`'s Node host (ADR-0137);
 *   * `session.ts`   — Mastra memory over the platform's engine-scoped store;
 *   * `engine.ts`    — the {@link AgentEngine} the runner's registry looks up.
 *
 * `docs/adr/0084-mastra-runs-a-plain-agent-with-memory-over-the-platform-store.md` records the
 * unit's decisions.
 */
export * from './boundary.js';
export * from './compile.js';
export * from './engine.js';
export * from './frames.js';
export * from './guard.js';
export * from './policy.js';
export * from './session.js';
export * from './skill-script.js';
export * from './tools.js';
export * from './workspace.js';
