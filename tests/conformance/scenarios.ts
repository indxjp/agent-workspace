/**
 * `tests/conformance/scenarios.ts` — the ten A.12 scenarios, each a `{ id, name, requirement, run
 * }` record. `tests/conformance/harness.ts` is the only thing that iterates this table; it decides
 * `unsupported-by-capability` from `requirement` without ever calling `run`, so a scenario a
 * driver's capabilities do not claim is never attempted at all — that is what keeps the suite from
 * being able to "pass by weakening the test" (A.12).
 *
 * `name` is transcribed by hand from `docs/spec.md`'s A.12 fenced block, once per scenario.
 * `tests/conformance/scenario-names.test.ts` is what proves each of these ten strings still equals
 * the corresponding line the spec actually contains, read with
 * `tests/conformance/spec-scenarios.ts`'s parser rather than remembered — this file does not
 * re-read `docs/spec.md` itself, so a scenario's behaviour never depends on the document parsing
 * at run time.
 *
 * ## Why most `requirement`s are unconditional
 *
 * `RuntimeCapabilities` (spec §14.5) has ten fields, and three of them each name exactly one
 * scenario: `networkPolicies` is what scenarios 5 and 6 are *about*, and `maxSessionSeconds` — the
 * one field that *is* a timeout ceiling — is what scenario 7 is about (round 2 of this task: round
 * 1 gated scenario 7 on `isolation` instead, a field scenario 7 never reads; see
 * `docs/adr/W3-QA-02-a12-conformance-harness-design.md`'s round-2 addendum). `isolation` remains
 * the field general enough to gate scenario 9, which is structurally impossible without some real
 * isolation boundary. Nothing in `RuntimeCapabilities` lets a driver opt out of the rest — file
 * transfer (§15.3), a working `startAgent`/`sessionId` contract, honouring `interrupt()`, and not
 * leaking host `.claude` state (§14.7) are baseline obligations of *any* `RuntimeDriver`, not
 * features a driver can decline. A driver that cannot do one of those has a defect this suite
 * reports as `fail`, never as `unsupported-by-capability` — ADR-0015: `unsupported-by-capability`
 * is available only where a real field says so, never invented to cover an absent one. Scenario
 * 10 is exactly this case for `local`: `local` declares `isolation: 'none'` with no field that
 * lets it decline §14.7, so it fails this scenario for real on every host — round 3's fix
 * (ADR-0047) seeds the scenario's own marker at a host location it designates, rather than asking
 * about this machine's real `~/.claude` (which round 2's version did, and which a host with no
 * `~/.claude` at all — every CI runner — could never fail against; see `a12-local.test.ts`) —
 * never the `pass` round 1 fabricated unconditionally, and never a verdict round 2 left dependent
 * on the machine running it.
 */
import { ALWAYS_REQUIRED, type A12Scenario } from './scenario-types.js';
import {
  runCreateAndDestroy,
  runInterruptRunningAgent,
  runResumeAfterSandboxGone,
  runTrivialAgentTurn,
} from './scenarios-lifecycle.js';
import {
  runConcurrentSessionsFileIsolation,
  runHydrateAndCollectFiles,
} from './scenarios-files.js';
import { runEnforceResourceLimits } from './scenarios-limits.js';
import {
  runEnforceNetworkPolicy,
  runNoHostClaudeConfigVisible,
} from './scenarios-sandbox-boundaries.js';

export type { A12Requirement, A12Scenario, A12ScenarioContext } from './scenario-types.js';

// --- the table -----------------------------------------------------------------------------

/**
 * The ten scenarios, in A.12's own order. `tests/conformance/scenario-names.test.ts` asserts the
 * `name` column against `docs/spec.md`; nothing here re-derives it.
 */
export function a12Scenarios<TRequest, TEvent>(): readonly A12Scenario<TRequest, TEvent>[] {
  return [
    {
      id: 'create-and-destroy',
      name: 'create and destroy a runtime',
      requirement: () => ALWAYS_REQUIRED,
      run: runCreateAndDestroy,
    },
    {
      id: 'trivial-agent-turn',
      name: 'run a trivial agent turn and stream events',
      requirement: () => ALWAYS_REQUIRED,
      run: runTrivialAgentTurn,
    },
    {
      id: 'hydrate-and-collect-files',
      name: 'hydrate files in, collect files out',
      requirement: () => ALWAYS_REQUIRED,
      run: runHydrateAndCollectFiles,
    },
    {
      id: 'resume-after-sandbox-gone',
      name: 'resume a session after the sandbox is gone',
      requirement: () => ALWAYS_REQUIRED,
      run: runResumeAfterSandboxGone,
    },
    {
      id: 'enforce-network-none',
      name: 'enforce networkPolicy "none" (egress to a blocked host fails)',
      requirement: (capabilities) =>
        capabilities.networkPolicies.includes('none')
          ? ALWAYS_REQUIRED
          : {
              met: false,
              reason: `capabilities.networkPolicies is ${JSON.stringify(capabilities.networkPolicies)}, which does not include "none"`,
            },
      run: (ctx) => runEnforceNetworkPolicy(ctx, 'none'),
    },
    {
      id: 'enforce-network-restricted',
      name: 'enforce networkPolicy "restricted" (allowed host succeeds, other host fails)',
      requirement: (capabilities) =>
        capabilities.networkPolicies.includes('allowlist')
          ? ALWAYS_REQUIRED
          : {
              met: false,
              reason: `capabilities.networkPolicies is ${JSON.stringify(capabilities.networkPolicies)}, which does not include "allowlist"`,
            },
      run: (ctx) => runEnforceNetworkPolicy(ctx, 'restricted'),
    },
    {
      id: 'enforce-resource-limits',
      name: 'enforce cpu / memory / timeout limits',
      // Gated on `maxSessionSeconds` — the one `RuntimeCapabilities` field that IS a timeout
      // ceiling — never on `isolation`, which this scenario's `run()` does not read at all. Round
      // 1 gated this on `isolation !== 'none'`, which let a driver claiming `maxSessionSeconds:
      // null` (no ceiling of any kind) still have this scenario attempted and pass (ADR-0046).
      requirement: (capabilities) =>
        capabilities.maxSessionSeconds !== null
          ? ALWAYS_REQUIRED
          : {
              met: false,
              reason:
                'capabilities.maxSessionSeconds is null — no ceiling is declared to enforce against',
            },
      run: runEnforceResourceLimits,
    },
    {
      id: 'interrupt-running-agent',
      name: 'interrupt a running agent',
      requirement: () => ALWAYS_REQUIRED,
      run: runInterruptRunningAgent,
    },
    {
      id: 'concurrent-sessions-file-isolation',
      name: "concurrent sessions do not see each other's files",
      requirement: (capabilities) =>
        capabilities.isolation !== 'none'
          ? ALWAYS_REQUIRED
          : {
              met: false,
              reason:
                'capabilities.isolation is "none" — sessions share one filesystem with no isolation boundary between them',
            },
      run: runConcurrentSessionsFileIsolation,
    },
    {
      id: 'no-host-claude-config-visible',
      name: 'no host .claude configuration is visible inside the sandbox',
      requirement: () => ALWAYS_REQUIRED,
      run: runNoHostClaudeConfigVisible,
    },
  ];
}
