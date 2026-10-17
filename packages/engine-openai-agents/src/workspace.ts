/**
 * Where a path the model names lands, and whether this run may write it (ENG-09, #308).
 *
 * Pure. The Editor and the read tools (`./executors.ts`) call {@link resolveWorkspacePath} before
 * they touch the filesystem, and the conformance kit's `writeAllowed` calls
 * {@link workspaceWriteAllowed} over a compiled configuration — the same function, so the answer
 * the kit checks is the answer a run gets.
 *
 * The grant arithmetic is `@agent-workspace/engine`'s `writeGrantVerdict`, not a copy of it: a
 * second implementation of `..` handling is a second chance to get it wrong, and
 * `formal/AgentWorkspace/Authz/PathGrant.lean` proves the one the port ships.
 */
import { workspaceWriteVerdict, type EngineWorkspace } from '@agent-workspace/engine';

export {
  workspacePathVerdict as resolveWorkspacePath,
  workspaceWriteVerdict,
  type WorkspacePathVerdict,
} from '@agent-workspace/engine';

/** What the executors need to know about the run's workspace. Plain data, so it compiles. */
export type OpenAiAgentsWorkspace = EngineWorkspace;

/** {@link workspaceWriteVerdict} as a boolean, for the conformance kit. */
export function workspaceWriteAllowed(workspace: OpenAiAgentsWorkspace, input: string): boolean {
  return workspaceWriteVerdict(workspace, input).ok;
}
