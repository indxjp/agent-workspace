/** Which workspace each recently seen run belongs to, so most calls skip the lookup. */
import { type RunId, type WorkspaceId } from '../newtypes';

/** How many run-to-workspace lookups one repository store remembers. */
const REMEMBERED_RUN_WORKSPACES = 10_000;

/** The workspace each recently seen run belongs to, oldest evicted first once the bound is passed. */
export class RecentRunWorkspaces {
  private readonly workspaceOfRun = new Map<string, WorkspaceId>();

  get(runId: string): WorkspaceId | undefined {
    return this.workspaceOfRun.get(runId);
  }

  remember(runId: RunId, workspaceId: WorkspaceId): void {
    this.workspaceOfRun.delete(runId);
    this.workspaceOfRun.set(runId, workspaceId);
    if (this.workspaceOfRun.size > REMEMBERED_RUN_WORKSPACES) {
      const oldest = this.workspaceOfRun.keys().next();
      if (oldest.done !== true) this.workspaceOfRun.delete(oldest.value);
    }
  }
}
