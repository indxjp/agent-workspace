/**
 * The evaluations context's public entry (refactoring plan part 04, step 7).
 *
 * Code in another context imports evaluations from here, not from the modules underneath.
 * `pnpm architecture:check` enforces it: the `context-evaluations-entered-through-its-entry` rule in
 * dependency-cruiser.config.mjs refuses a new deep import, and the deep import that was left when
 * the rule landed is in .dependency-cruiser-known-violations.json, where it can only shrink. Tests,
 * `composition/` and the evaluations modules themselves keep importing the modules directly.
 *
 * Only modules without start-up work are re-exported: importing this file loads `score.ts` and
 * nothing else from the repository. This deep import stays, on purpose, and is in the baseline:
 *
 *   * `handlers.ts` (`evaluateAgentVersion`, `EVALUATION_DEADLINE_MS`), imported by the Builder's
 *     runner adapter: it loads the application context and about 380 modules, so re-exporting it
 *     would start them for every caller of `finalAnswer`.
 *
 * No evaluations module imports this file: that would be a cycle, and `no-circular-dependencies`
 * refuses it.
 */
export { finalAnswer } from './score';
