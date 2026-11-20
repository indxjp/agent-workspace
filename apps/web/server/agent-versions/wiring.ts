/**
 * What the version routes (S1-05, issue #443) need beyond the agents runtime. The composition root
 * builds it once and installs it as `ApplicationContext.agentVersions`; with no context installed
 * the version routes answer `503 agent_policy_not_configured` — the 503 code the version contract
 * publishes (`AGENT_VERSION_PROBLEM_CODES`) — never an empty list (ADR-0015).
 */
import type { DeploymentCeiling } from '../policy-ceiling/ceiling';
import type { AgentVersionStoreProvider } from './store';

/** Everything the version routes need beyond the agents runtime. */
export interface AgentVersionsRuntime {
  readonly versions: AgentVersionStoreProvider;
  readonly ceiling: DeploymentCeiling;
  /**
   * Whether the deployment runs code tools: its tool sandbox is enabled (ADR-0118 TS8). `false`
   * means a code-tool version cannot leave `local`.
   */
  readonly toolHost: boolean;
  /**
   * Why the tool sandbox cannot enforce a code tool's `allowedDomains` (E2B, or docker without the
   * egress proxy; #1018), or `null` when it can.
   */
  readonly toolDomainsRefusal: string | null;
}
