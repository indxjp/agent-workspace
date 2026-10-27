import type { ApprovalPort, ApprovalRequest, CallContext } from '../../ports';
import { approvedCallText } from './production';

/** `ApprovalPort` over a map of approved calls per `(workspace, run)`. */
export class MemoryApproval implements ApprovalPort {
  private readonly approved = new Map<string, Set<string>>();

  /** Records the person's approval of `call` in the run `ctx` names; test setup only. */
  approve(ctx: CallContext, call: ApprovalRequest): void {
    const text = approvedCallText(call);
    if (text === null) throw new Error('Only a JSON call can be approved.');
    const key = `${ctx.workspaceId}/${ctx.runId}`;
    this.approved.set(key, (this.approved.get(key) ?? new Set()).add(text));
  }

  status(ctx: CallContext, call: ApprovalRequest): Promise<'granted' | 'missing'> {
    const text = approvedCallText(call);
    const granted =
      text !== null && this.approved.get(`${ctx.workspaceId}/${ctx.runId}`)?.has(text) === true;
    return Promise.resolve(granted ? 'granted' : 'missing');
  }
}
