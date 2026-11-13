/**
 * The agents context's public entry (refactoring plan part 04, step 7).
 *
 * Code in another context imports agents, agent versions, compose, skills and the other agents
 * folders from here, not from the modules underneath. `pnpm architecture:check` enforces it: the
 * `context-agents-entered-through-its-entry` rule in dependency-cruiser.config.mjs refuses a new
 * deep import, and the deep imports that were left when the rule landed are in
 * .dependency-cruiser-known-violations.json, where they can only shrink. Tests, `composition/` and
 * the agents context's own modules keep importing the modules directly.
 *
 * Every type other contexts use is re-exported with `export type`, which loads nothing at run time.
 * Values are re-exported only from modules without start-up work: importing this file loads no
 * application context, no object-store or cloud SDK, nothing Next.js-only and no downstream context.
 * Most callers are upstream contexts (execution, storage and sharing, integrations), so these deep
 * value imports are also imports against the context direction; they stay, on purpose, and are in
 * the baseline. Moving that code is the fix, not this file:
 *
 *   * `agents/run-ownership.ts`, `resources/authorise.ts`, `agent-versions/contract.ts` and
 *     `agent-versions/session-version.ts`: they load the application context.
 *   * `agent-versions/storage-grants.ts`, `skills/tree.ts` and `compose/runtime-manager-client.ts`:
 *     they load the object-store or Google auth SDKs.
 *   * `compose/run-preflight.ts`, `compose/run-request.ts`, `compose/resource-loader.ts`,
 *     `compose/workspace-lifecycle.ts`, `projects/archive-gate.ts`, `agent-versions/memory-store.ts`,
 *     `skills/service.ts` and `skills/pending-delete.ts`: each loads 200 to 360 modules.
 *
 * No agents module imports this file: that would be a cycle, and `no-circular-dependencies`
 * refuses it.
 */
export { FIXTURE_PERMISSIONS } from '../agent-versions/fixtures';
export { agentVersionNotFound } from '../agent-versions/problems';
export type { WorkspaceAgentVersionStore } from '../agent-versions/store';
export { isUuid, type AgentRecord } from './contract';
export { createInMemoryAgentStoreProvider } from './memory-store';
export type { WorkspaceAgentStore } from './store';
export { memoryLimitExceeded } from '../compose/agent-memory';
export type { RunModelQuery, RunPreflight } from '../compose/run-preflight';
export type { ModelResolution } from '../compose/run-request';
export type { RuntimeLaunchTarget, RuntimeRunResolver } from '../compose/runtime-profile';
export type { StorageWriteBackRun } from '../compose/storage-writeback';
export { enforceCeiling, type CeilingFor } from '../policy-ceiling/ceiling';
export {
  SKILL_FILES_PREFIX,
  SKILL_META_PREFIX,
  SKILL_REVISIONS_PREFIX,
  SKILL_ROWS_ROOT,
  skillNameFromMetaKey,
  skillRevisionRowFolder,
  skillRowFolder,
} from '../skills/keys';
