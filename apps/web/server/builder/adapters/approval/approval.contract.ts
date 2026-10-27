import { describe, expect, it } from 'vitest';

import type { ApprovalPort, ApprovalRequest, CallContext } from '../../ports';

export interface ApprovalFixture {
  readonly port: ApprovalPort;
  /** A run in the workspace; nothing is approved yet. */
  readonly ctx: CallContext;
  /** Another run in the same workspace. */
  readonly otherRun: CallContext;
  /** The first run's id asked from another workspace. */
  readonly otherWorkspace: CallContext;
  /** Records the person's approval of `call` for the run `ctx` names, as `POST /api/runs/:id/approval` does. */
  readonly approve: (ctx: CallContext, call: ApprovalRequest) => Promise<void>;
}

const SAVE_ARGUMENTS = {
  agentId: '33333333-3333-4333-8333-333333333333',
  baseVersion: 1,
  body: { instructions: 'Answer politely.' },
};
const SAVE: ApprovalRequest = { tool: 'draft_save', arguments: SAVE_ARGUMENTS };

/** Memory and production grant an approval to one call of one run in one workspace, and nothing else. */
export function describeApprovalConformance(
  label: string,
  make: () => Promise<ApprovalFixture>,
): void {
  describe(`ApprovalPort: ${label}`, () => {
    async function start() {
      const fixture = await make();
      await fixture.approve(fixture.ctx, SAVE);
      return fixture;
    }

    it('grants the call that was approved', async () => {
      const { port, ctx } = await start();
      await expect(port.status(ctx, SAVE)).resolves.toBe('granted');
    });

    it('grants it again, because reading a record uses nothing up', async () => {
      const { port, ctx } = await start();
      await port.status(ctx, SAVE);
      await expect(port.status(ctx, SAVE)).resolves.toBe('granted');
    });

    it('does not grant a call with one argument changed', async () => {
      const { port, ctx } = await start();
      await expect(
        port.status(ctx, { ...SAVE, arguments: { ...SAVE_ARGUMENTS, baseVersion: 2 } }),
      ).resolves.toBe('missing');
      await expect(
        port.status(ctx, {
          ...SAVE,
          arguments: { ...SAVE_ARGUMENTS, body: { instructions: 'Answer rudely.' } },
        }),
      ).resolves.toBe('missing');
    });

    it('does not grant the same arguments to another tool', async () => {
      const { port, ctx } = await start();
      await expect(port.status(ctx, { ...SAVE, tool: 'trial_run' })).resolves.toBe('missing');
    });

    it('does not grant the call in another run of the workspace', async () => {
      const { port, otherRun } = await start();
      await expect(port.status(otherRun, SAVE)).resolves.toBe('missing');
    });

    it('does not grant the call to the same run id in another workspace', async () => {
      const { port, otherWorkspace } = await start();
      await expect(port.status(otherWorkspace, SAVE)).resolves.toBe('missing');
    });

    it('grants nothing that was not approved', async () => {
      const { port, ctx } = await make();
      await expect(port.status(ctx, SAVE)).resolves.toBe('missing');
    });

    it('reads the arguments as canonical JSON, so key order does not matter', async () => {
      const { port, ctx, approve } = await make();
      await approve(ctx, { tool: 'evals_run', arguments: { version: 2, agentId: 'a' } });
      await expect(
        port.status(ctx, { tool: 'evals_run', arguments: { agentId: 'a', version: 2 } }),
      ).resolves.toBe('granted');
    });

    it('reads absent arguments as `{}`, as the gateway does', async () => {
      const { port, ctx, approve } = await make();
      await approve(ctx, { tool: 'evals_run', arguments: {} });
      await expect(port.status(ctx, { tool: 'evals_run', arguments: undefined })).resolves.toBe(
        'granted',
      );
    });

    it('answers missing, never throws, for arguments that are not JSON', async () => {
      const { port, ctx } = await start();
      await expect(port.status(ctx, { tool: 'draft_save', arguments: { n: 1n } })).resolves.toBe(
        'missing',
      );
    });
  });
}
