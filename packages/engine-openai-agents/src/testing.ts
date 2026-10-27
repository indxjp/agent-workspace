/**
 * `@agent-workspace/engine-openai-agents/testing` — every module of the adapter, for this repository's tests.
 *
 * The package root exports one factory (W3-8); the formal vector replays, the engine matrix and
 * the parity suites need the pieces behind it, and import them from here instead.
 *
 * The adapter itself: the OpenAI Agents SDK behind the engine port (ENG-09).
 *
 * Ten modules, and the split keeps the SDK in exactly one of them:
 *
 *   * `boundary.ts`  — **the** import site of `@openai/agents`, `@openai/agents-extensions` and
 *     `@ai-sdk/anthropic` (`tests/no-sdk-import.test.ts` asserts it as a set equality);
 *   * `policy.ts`    — the engine-native arm of the private `/run` contract, as a schema;
 *   * `tools.ts`     — the four permission switches into this engine's tool set;
 *   * `workspace.ts` — where a model-supplied path lands, and whether it may be written;
 *   * `executors.ts` — our Shell, our Editor and the read tools, run in the container;
 *   * `compile.ts`   — the neutral request into a plain, SDK-free configuration;
 *   * `frames.ts`    — the SDK's stream events into the neutral `agent.*` frames;
 *   * `skill-script.ts` — `run_skill_script`'s Node host (ADR-0137);
 *   * `session.ts`   — the SDK's `Session` over the platform's engine-scoped store;
 *   * `engine.ts`    — the {@link AgentEngine} the runner's registry looks up.
 *
 * `docs/adr/0074-the-openai-agents-sdk-runs-a-plain-agent-behind-the-port.md` records the unit's
 * decisions.
 */
export * from './boundary.js';
export * from './compile.js';
export * from './engine.js';
export * from './executors.js';
export * from './frames.js';
export * from './policy.js';
export * from './session.js';
export * from './skill-script.js';
export * from './tools.js';
export * from './workspace.js';
