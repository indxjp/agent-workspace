import { replayOf, tallyRun, type JournalRow } from '../../core/facts';
import type { AuditPort, CallContext } from '../../ports';
import { bounded, inputDigest } from './bounded';

type Row = JournalRow & {
  readonly workspaceId: string;
  readonly runId: string;
  readonly callId: string;
  readonly result: unknown;
  readonly input: unknown;
};

export class MemoryAudit implements AuditPort {
  private readonly rows: Row[] = [];

  runCounts: AuditPort['runCounts'] = (ctx) => Promise.resolve(tallyRun(this.rowsOf(ctx)));

  record: AuditPort['record'] = (ctx, entry) => {
    const { workspaceId, runId } = ctx;
    const row = {
      workspaceId,
      runId,
      callId: entry.callId,
      tool: entry.tool,
      outcome: entry.outcome,
      result: entry.result,
      input: bounded(entry.input, {}, inputDigest(entry.tool)),
    };
    const index = this.rows.findIndex(
      (seen) =>
        seen.workspaceId === workspaceId && seen.runId === runId && seen.callId === entry.callId,
    );
    const seen = this.rows[index];
    if (seen === undefined) {
      this.rows.push(row);
      return Promise.resolve(true);
    }
    if (seen.outcome === 'error' && seen.tool === entry.tool && entry.outcome === 'ok') {
      this.rows[index] = row;
      return Promise.resolve(true);
    }
    return Promise.resolve(false);
  };

  replay: AuditPort['replay'] = (ctx, callId, tool) => {
    const row = this.rowsOf(ctx).find((candidate) => candidate.callId === callId);
    return Promise.resolve(row === undefined ? null : replayOf(row, tool));
  };

  spentInputs: AuditPort['spentInputs'] = (ctx, tool) =>
    Promise.resolve(
      this.rowsOf(ctx)
        .filter((row) => row.tool === tool && (row.outcome === 'ok' || row.outcome === 'error'))
        .map((row) => row.input),
    );

  private rowsOf(ctx: CallContext): Row[] {
    return this.rows.filter(
      (row) => row.workspaceId === ctx.workspaceId && row.runId === ctx.runId,
    );
  }
}
