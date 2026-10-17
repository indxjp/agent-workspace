/**
 * `@agent-workspace/engine-pi` — the pi coding agent behind the engine port (ENG-08, #307).
 *
 * Nine modules, and the split keeps pi in exactly one of them:
 *
 *   * `boundary.ts`  — **the** import site of `@earendil-works/pi-coding-agent`
 *     (`tests/no-sdk-import.test.ts` asserts it as a set equality);
 *   * `policy.ts`    — the engine-native arm of the private `/run` contract, as a schema;
 *   * `tools.ts`     — the four permission switches into pi's built-in tool set;
 *   * `workspace.ts` — which tool calls the guard lets through, on the path the model named;
 *   * `guard.ts`     — the same question on the path with its symbolic links resolved;
 *   * `compile.ts`   — the neutral request into a plain, SDK-free configuration;
 *   * `frames.ts`    — pi's session events into the neutral `agent.*` frames;
 *   * `session.ts`   — pi's JSONL session tree over the platform's engine-scoped store;
 *   * `engine.ts`    — the {@link AgentEngine} the runner's registry looks up.
 *
 * `docs/adr/0081-pi-runs-in-process-with-a-pinned-loader-behind-the-port.md` records the unit's
 * decisions.
 */
export * from './boundary.js';
export * from './compile.js';
export * from './engine.js';
export * from './frames.js';
export * from './guard.js';
export * from './policy.js';
export * from './session.js';
export * from './tools.js';
export * from './workspace.js';
