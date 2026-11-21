import type { ApprovalCall } from './store';

/**
 * The Agent Store demo's records stand-ins, as the run API reaches them (ADR-0169 D3). The runs
 * domain declares the type and the demo domain fills it, so execution never imports the demo
 * context. `startRunOnSession` calls it once for a continuation whose row was just inserted with
 * the calls its decision approved, before the run is handed to the launcher, so the continuation's
 * stand-in starts from what was kept. It is never called with a call nobody approved.
 */
export interface DemoApprovedWrites {
  /**
   * Keep each approved call that is a recorded write of a records stand-in in `workspaceId`, in that
   * stand-in's row. A call to any other tool, and any workspace with no records stand-in, changes
   * nothing. Rejects only when a row could not be read or written; the caller logs that and goes on.
   */
  readonly keep: (approved: {
    readonly workspaceId: string;
    readonly calls: readonly ApprovalCall[];
  }) => Promise<void>;
}
