/**
 * The seam between the version routes (S1-05, issue #443) and the version store the composition
 * root wires. One `globalThis` property, one setter, one reader — the same shape, and for the same
 * reason, as `../agents/runtime.ts`: Next.js compiles `instrumentation.ts` and the route handlers
 * into separate module graphs, and only a `globalThis` property is shared by both.
 *
 * Unconfigured, both version routes answer `503 agent_policy_not_configured` — the 503 code the
 * version contract publishes (`AGENT_VERSION_PROBLEM_CODES`) — never an empty list (ADR-0015).
 */
import type { CeilingFor } from '../policy-ceiling/ceiling';
import { defineSlot } from '../runtime-slot';
import type { AgentVersionStoreProvider } from './store';

/** Everything the version routes need beyond the agents runtime. */
export interface AgentVersionsRuntime {
  readonly versions: AgentVersionStoreProvider;
  /** The deployment's policy ceiling (issue #535); absent when `AW_DEPLOYMENT_POLICY` is unset. */
  readonly ceilingFor?: CeilingFor;
  /**
   * Whether the deployment runs code tools: its tool sandbox is enabled (ADR-0118 TS8). Absent
   * means it is not, so a code-tool version cannot leave `local`.
   */
  readonly toolHost?: boolean;
  /**
   * Why the tool sandbox cannot enforce a code tool's `allowedDomains` (E2B, or docker without the
   * egress proxy; #1018), or `null` when it can. Absent means no check.
   */
  readonly toolDomainsRefusal?: string | null;
}

const slot = defineSlot<AgentVersionsRuntime>('__agentWorkspaceAgentVersionsRuntime__');

/** Install the version store. Called once, from the composition root. */
export function configureAgentVersionsRuntime(runtime: AgentVersionsRuntime): void {
  slot.set(runtime);
}

/** Remove the installed runtime, so a test can prove the unconfigured path fails. */
export function clearAgentVersionsRuntime(): void {
  slot.clear();
}

/** The installed runtime, or `null` when nothing has been wired. Never throws. */
export function currentAgentVersionsRuntime(): AgentVersionsRuntime | null {
  return slot.current();
}
