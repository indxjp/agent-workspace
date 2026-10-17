/**
 * `tests/conformance/index.ts` — the barrel for the A.12 conformance suite.
 *
 * `runA12ConformanceSuite` is the "one exported harness" the wave plan's Accept line names.
 * Everything else here is what a caller needs to use it: the scenario table it runs (for a
 * caller that wants to name a scenario without a string), the report/probe types, and the
 * spec-reading utility `tests/conformance/scenario-names.test.ts` uses to keep the scenario
 * table honest against `docs/spec.md`.
 */
export { runA12ConformanceSuite, assertHonestReport } from './harness.js';
export { a12Scenarios } from './scenarios.js';
export type { A12Scenario, A12ScenarioContext, A12Requirement } from './scenarios.js';
export { readA12ScenarioNames, readA12ScenarioNamesFromSpecFile } from './spec-scenarios.js';
export type {
  A12AgentAction,
  A12AgentOutcome,
  A12AgentProbe,
  A12FileTransferProbe,
  A12Probe,
  A12Report,
  A12ScenarioId,
  A12ScenarioResult,
  A12Verdict,
} from './types.js';
