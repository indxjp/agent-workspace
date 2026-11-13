/**
 * The execution context's public entry (refactoring plan part 04, step 7).
 *
 * Code in another context imports runs, sessions, engines, runtimes and usage from here, not from
 * the folders underneath. `pnpm architecture:check` enforces it: the
 * `context-execution-entered-through-its-entry` rule in dependency-cruiser.config.mjs refuses a new
 * deep import, and the deep imports that were left when the rule landed are in
 * .dependency-cruiser-known-violations.json, where they can only shrink. Tests, `composition/` and
 * the execution context's own modules keep importing the modules directly.
 *
 * Every type other contexts use is re-exported with `export type`, which loads nothing at run time.
 * Values are re-exported only from modules without start-up work: importing this file loads no
 * application context, no database driver, no object-store or cloud SDK, nothing Next.js-only and no
 * downstream context. These deep value imports stay, on purpose, and are in the baseline:
 *
 *   * `runs/environment.ts` (`getRunApi`): it reads the application context.
 *   * `runs/api.ts` and `runs/service.ts` (starting, finding and interrupting runs, the prompt
 *     limits): each loads 340 to 440 modules, including the object-store SDKs and downstream
 *     contexts.
 *   * `runs/failures.ts` (`atStep`, `publicRunFailure`) and `runs/transcription.ts`: they import
 *     downstream contexts (agents, integrations), so re-exporting them would close an import cycle.
 *   * `runtimes/connections.ts`: it loads the database driver.
 *
 * No execution module imports this file: that would be a cycle, and `no-circular-dependencies`
 * refuses it.
 */
export {
  engineCapabilityRefusalMessage,
  unsupportedEngineCapability,
  type EngineCapabilityDemand,
} from '../engines/capabilities';
export { listEngines } from '../engines/handlers';
export { resolveWireProtocol } from '../engines/protocol';
export { registeredEngine, registeredEngineIds } from '../engines/registry';
export { DEFAULT_ENGINE_ID, engineForStoredPolicy } from '../engines/session-engine';
export { upgradeEventStream } from '../runs/agent-frames';
export { runCallerOf, type RunCaller } from '../runs/caller';
export type {
  AgentRef,
  JudgeReply,
  LaunchContext,
  ModelSelection,
  RunApiEnvironment,
  RunEvaluationEnvironment,
  RunReadEnvironment,
  RunStartEnvironment,
  RunLimitsOverride,
  RunPrincipal,
  RunTargetDescription,
  RunTargetDescriptions,
  SessionRef,
} from '../runs/environment';
export { apiError, isUuid, json } from '../runs/http';
export type { RuntimeWorkspaceLifecycle } from '../runs/launcher';
export type { FileTransfer, RuntimeLaunchTarget, RuntimeRunResolver } from '../runs/launch-target';
export {
  IdempotencyKeyTakenError,
  isStoppedRunStatus,
  isTerminalRunStatus,
  type RunRecord,
  type RunStatus,
  type RunStore,
} from '../runs/store';
export { STREAMED_SHA256 } from '../runs/streamed-digests';
export { listRuntimeProfiles } from '../runtimes/handlers';
export { restrictedUnenforceableReason } from '../runtimes/network-policy';
export {
  currentWebRuntimeRegistry,
  type RuntimeRegistryEntry,
  type WebRuntimeRegistry,
} from '../runtimes/registry';
export type { RuntimeProfileRecord, RuntimeProfileStoreProvider } from '../runtimes/store';
export { storableText } from '../runs/storable-text';
export { unstorableTextPath } from '../sessions/transcript';
