import type { DemoRunStartProblemCode } from '@indx-workspace/contracts/demo';

/**
 * The Agent Store demo's run-start gate, as the run API reads it (internal spec, "Abuse
 * controls"). The runs domain declares the type and the demo domain fills it, so execution never
 * imports the demo context.
 */
export interface DemoRunGate {
  /**
   * `null` when the start may go ahead: the workspace is not a demo workspace, or it is and the
   * caps admit one more run, which this call records. The record is kept even if the start then
   * fails before a run exists (creating it can still throw): an admission is a start the caps let
   * through, not a run that finished. Otherwise the cap that refused it. Rejects
   * when the caps cannot be read; the start is then refused as unavailable.
   */
  readonly refusal: (start: {
    readonly workspaceId: string;
    readonly userId: string | null;
    /** The starting request's headers, when there is one. */
    readonly clientHeaders: Headers | null;
    /**
     * Whether this start is a new demo run of the visitor's own. An approval's continuation and a
     * team member's child run are not: they carry on a run that was admitted, so they are not
     * counted against the person's or the client's runs (a visitor at the limit can still approve
     * a pending write), and still meet the site's cost cap.
     */
    readonly newRun: boolean;
  }) => Promise<{ readonly code: DemoRunStartProblemCode } | null>;
}
