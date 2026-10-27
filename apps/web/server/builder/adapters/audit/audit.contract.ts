import { createHash } from 'node:crypto';

import { canonicalCall } from '@indx-workspace/contracts/agents';
import { AgentVersionBodySchema } from '@indx-workspace/contracts/agent-versions';
import { BUILDER_DEFAULT_LIMITS, type BuilderToolName } from '@indx-workspace/contracts/builder';
import { describe, expect, it } from 'vitest';

import { versionRequest } from '../../../agent-versions/fixtures';
import { decide } from '../../core/decide';
import type { JournalRow } from '../../core/facts';
import type { AuditPort, CallContext } from '../../ports';
import { handleToolCall } from '../../shell';
import { TEST_DOOR } from '../../testing/context';
import { makeMemoryPorts } from '../../testing/ports';

export interface AuditFixture {
  readonly port: AuditPort;
  /** Two workspaces the journal can write to. */
  readonly workspaceA: string;
  readonly workspaceB: string;
}

/** The digest a cut-short journaled input carries: sha256 of the canonical call. */
const sha256Of = (tool: BuilderToolName, input: unknown) =>
  createHash('sha256').update(canonicalCall(tool, input)).digest('hex');

const { maxFailedChecksInARow } = BUILDER_DEFAULT_LIMITS;

function contextOf(workspaceId: string, runId: string): CallContext {
  return {
    workspaceId,
    door: TEST_DOOR,
    runId,
    traceId: 'trace-1',
    modelId: 'model-1',
    promptVersion: 'prompt-1',
    caller: { kind: 'none' },
  };
}

const BODY = AgentVersionBodySchema.parse(versionRequest().body);

type Step = readonly [BuilderToolName, JournalRow['outcome']];

const failedChecks = (count: number): Step[] =>
  Array.from({ length: count }, () => ['draft_check', 'check_failed']);

/** What the core says about the next `draft_check`, from the counts the journal gives it. */
async function nextCheck(port: AuditPort, ctx: CallContext) {
  return decide(
    { tool: 'draft_check', callId: 'next', input: { body: BODY } },
    {
      enabled: true,
      caller: { kind: 'person', role: 'builder' },
      access: 'allowed',
      run: await port.runCounts(ctx),
      limits: BUILDER_DEFAULT_LIMITS,
      approval: 'not_needed',
      local: { version: null },
      creator: { kind: 'builder' },
      creationsToday: 0,
      target: null,
    },
  );
}

/** `[US-BLD-02]`: the journal and the core agree on the failed-check limit. */
export function describeAuditConformance(label: string, make: () => Promise<AuditFixture>): void {
  describe(`AuditPort: ${label}`, () => {
    async function start() {
      const fixture = await make();
      const ctx = contextOf(fixture.workspaceA, crypto.randomUUID());
      const journal = async (steps: readonly Step[], from = 0): Promise<void> => {
        for (const [index, [tool, outcome]] of steps.entries()) {
          await fixture.port.record(ctx, {
            callId: `call-${String(from + index)}`,
            tool,
            decision: outcome === 'refused' ? 'refuse' : 'run',
            outcome,
            code: null,
            input: { n: from + index },
            result: null,
          });
        }
      };
      return { ...fixture, ctx, journal };
    }

    it('counts nothing for a run that has no rows', async () => {
      const { port, ctx } = await start();
      await expect(port.runCounts(ctx)).resolves.toEqual({ toolCalls: 0, failedChecksInARow: 0 });
    });

    it('refuses the next draft_check once the limit of failed checks in a row is reached', async () => {
      const { port, ctx, journal } = await start();
      await journal(failedChecks(maxFailedChecksInARow - 1));
      expect(await nextCheck(port, ctx)).toMatchObject({ kind: 'run' });
      await journal([['draft_check', 'check_failed']], maxFailedChecksInARow - 1);
      expect(await nextCheck(port, ctx)).toMatchObject({
        kind: 'refuse',
        code: 'check_limit_reached',
      });
    });

    it('lets a passing check reset the count', async () => {
      const { port, ctx, journal } = await start();
      const steps: Step[] = [
        ...failedChecks(maxFailedChecksInARow - 1),
        ['draft_check', 'ok'],
        ...failedChecks(maxFailedChecksInARow - 1),
      ];
      await journal(steps);
      expect(await nextCheck(port, ctx)).toMatchObject({ kind: 'run' });
    });

    it('does not reset the count on a refused or errored row', async () => {
      const { port, ctx, journal } = await start();
      await journal([
        ...failedChecks(maxFailedChecksInARow),
        ['draft_check', 'refused'],
        ['draft_save', 'error'],
        ['catalog_list', 'ok'],
      ]);
      await expect(port.runCounts(ctx)).resolves.toMatchObject({
        failedChecksInARow: maxFailedChecksInARow,
      });
      expect(await nextCheck(port, ctx)).toMatchObject({ code: 'check_limit_reached' });
    });

    it('counts every row as a tool call', async () => {
      const { port, ctx, journal } = await start();
      await journal([
        ['catalog_list', 'ok'],
        ['examples_get', 'refused'],
        ['draft_check', 'error'],
      ]);
      await expect(port.runCounts(ctx)).resolves.toMatchObject({ toolCalls: 3 });
    });

    it('keeps the first row when the same call is recorded twice', async () => {
      const { port, ctx, journal } = await start();
      await journal([['draft_check', 'check_failed']]);
      await journal([['draft_check', 'ok']]);
      await expect(port.runCounts(ctx)).resolves.toEqual({ toolCalls: 1, failedChecksInARow: 1 });
    });

    it('answers whether it stored the call: true for a new id, false for a repeated one', async () => {
      const { port, ctx } = await start();
      const entry = {
        callId: 'call-r',
        tool: 'draft_check',
        decision: 'run',
        outcome: 'ok',
        code: null,
        input: {},
        result: {},
      } as const;
      await expect(port.record(ctx, entry)).resolves.toBe(true);
      await expect(port.record(ctx, entry)).resolves.toBe(false);
      await expect(port.runCounts(ctx)).resolves.toMatchObject({ toolCalls: 1 });
    });

    describe('the error-to-ok upgrade', () => {
      const attempt = (
        port: AuditPort,
        ctx: CallContext,
        tool: BuilderToolName,
        outcome: JournalRow['outcome'],
      ) =>
        port.record(ctx, {
          callId: 'call-0',
          tool,
          decision: 'run',
          outcome,
          code: null,
          input: {},
          result: { ok: true },
        });

      it('lets a success of the same tool replace an earlier error row, and nothing else', async () => {
        const { port, ctx } = await start();
        await expect(attempt(port, ctx, 'draft_save', 'error')).resolves.toBe(true);
        await expect(attempt(port, ctx, 'draft_save', 'ok')).resolves.toBe(true);
        await expect(port.runCounts(ctx)).resolves.toMatchObject({ toolCalls: 1 });
        await expect(port.replay(ctx, 'call-0', 'draft_save')).resolves.toEqual({
          result: { ok: true },
        });
      });

      it('does not let a success of another tool replace the error row', async () => {
        const { port, ctx } = await start();
        await attempt(port, ctx, 'draft_save', 'error');
        await expect(attempt(port, ctx, 'trial_run', 'ok')).resolves.toBe(false);
        await expect(port.replay(ctx, 'call-0', 'trial_run')).resolves.toBeNull();
        await expect(port.replay(ctx, 'call-0', 'draft_save')).resolves.toBeNull();
      });
    });

    it('keeps one run and one workspace apart from another', async () => {
      const { port, ctx, journal, workspaceB } = await start();
      await journal(failedChecks(maxFailedChecksInARow));
      await expect(port.runCounts({ ...ctx, runId: crypto.randomUUID() })).resolves.toEqual({
        toolCalls: 0,
        failedChecksInARow: 0,
      });
      await expect(port.runCounts({ ...ctx, workspaceId: workspaceB })).resolves.toEqual({
        toolCalls: 0,
        failedChecksInARow: 0,
      });
    });

    it('handleToolCall with an unknown tool returns unknown_tool and writes exactly one journal row', async () => {
      const { port, ctx } = await start();
      const result = await handleToolCall(
        { name: 'agents_delete', arguments: { id: 'x' }, callId: 'call-unknown' },
        ctx,
        makeMemoryPorts({ audit: port }),
      );
      expect(result).toMatchObject({ ok: false, code: 'unknown_tool' });
      await expect(port.runCounts(ctx)).resolves.toEqual({ toolCalls: 1, failedChecksInARow: 0 });
    });

    describe('replay', () => {
      const result = { saved: true, version: 2 };
      const write = (
        port: AuditPort,
        ctx: CallContext,
        tool: BuilderToolName,
        outcome: JournalRow['outcome'],
        callId = 'call-w',
      ) =>
        port.record(ctx, {
          callId,
          tool,
          decision: 'run',
          outcome,
          code: null,
          input: {},
          result,
        });

      it('answers the stored result of the first successful write, and keeps it on a second record', async () => {
        const { port, ctx } = await start();
        await write(port, ctx, 'draft_save', 'ok');
        await port.record(ctx, {
          callId: 'call-w',
          tool: 'draft_save',
          decision: 'run',
          outcome: 'ok',
          code: null,
          input: {},
          result: { saved: false },
        });
        await expect(port.replay(ctx, 'call-w', 'draft_save')).resolves.toEqual({ result });
      });

      it('answers null when another tool asks for the stored call id', async () => {
        const { port, ctx } = await start();
        await write(port, ctx, 'draft_save', 'ok');
        await expect(port.replay(ctx, 'call-w', 'trial_run')).resolves.toBeNull();
      });

      it('answers null for a call that was not a successful write', async () => {
        const { port, ctx } = await start();
        await write(port, ctx, 'draft_save', 'check_failed', 'failed');
        await write(port, ctx, 'draft_save', 'refused', 'refused');
        await write(port, ctx, 'draft_save', 'error', 'errored');
        await write(port, ctx, 'catalog_list', 'ok', 'read');
        for (const callId of ['failed', 'refused', 'errored', 'unknown']) {
          await expect(port.replay(ctx, callId, 'draft_save')).resolves.toBeNull();
        }
        await expect(port.replay(ctx, 'read', 'catalog_list')).resolves.toBeNull();
      });

      it('keeps one run and one workspace apart from another', async () => {
        const { port, ctx, workspaceB } = await start();
        await write(port, ctx, 'draft_save', 'ok');
        await expect(
          port.replay({ ...ctx, runId: crypto.randomUUID() }, 'call-w', 'draft_save'),
        ).resolves.toBeNull();
        await expect(
          port.replay({ ...ctx, workspaceId: workspaceB }, 'call-w', 'draft_save'),
        ).resolves.toBeNull();
      });
    });

    describe('spentInputs', () => {
      it("answers the inputs of this run's calls of the tool that ended ok or error, and no other", async () => {
        const { port, ctx, workspaceB } = await start();
        const write = (
          at: CallContext,
          tool: BuilderToolName,
          outcome: JournalRow['outcome'],
          callId: string,
        ) =>
          port.record(at, {
            callId,
            tool,
            decision: 'run',
            outcome,
            code: null,
            input: { n: callId },
            result: {},
          });
        await write(ctx, 'draft_save', 'ok', 'a');
        await write(ctx, 'draft_save', 'error', 'b');
        await write(ctx, 'draft_save', 'refused', 'c');
        await write(ctx, 'draft_save', 'check_failed', 'c2');
        await write(ctx, 'trial_run', 'ok', 'd');
        await write({ ...ctx, runId: crypto.randomUUID() }, 'draft_save', 'ok', 'e');
        await write({ ...ctx, workspaceId: workspaceB }, 'draft_save', 'ok', 'f');
        const spent = await port.spentInputs(ctx, 'draft_save');
        expect(spent).toHaveLength(2);
        expect(spent).toEqual(expect.arrayContaining([{ n: 'a' }, { n: 'b' }]));
      });

      it('keeps an input over the bound as a marker with the digest of the whole call', async () => {
        const { port, ctx } = await start();
        const input = { text: 'x'.repeat(BUILDER_DEFAULT_LIMITS.toolOutputMaxBytes + 1) };
        await port.record(ctx, {
          callId: 'big',
          tool: 'draft_save',
          decision: 'run',
          outcome: 'ok',
          code: null,
          input,
          result: {},
        });
        await expect(port.spentInputs(ctx, 'draft_save')).resolves.toEqual([
          {
            truncated: true,
            bytes: expect.any(Number) as number,
            sha256: sha256Of('draft_save', input),
          },
        ]);
      });
    });

    describe('the approval claim row', () => {
      const claim = (port: AuditPort, ctx: CallContext) =>
        port.record(ctx, {
          callId: 'approval:draft_save:abc',
          tool: 'draft_save',
          decision: 'ask',
          outcome: 'refused',
          code: 'approval_required',
          input: {},
          result: null,
        });

      it('is taken once by one of two concurrent claims, counts as one call, and replays nothing', async () => {
        const { port, ctx } = await start();
        const taken = await Promise.all([claim(port, ctx), claim(port, ctx)]);
        expect(taken.filter(Boolean)).toHaveLength(1);
        await expect(port.runCounts(ctx)).resolves.toMatchObject({ toolCalls: 1 });
        await expect(port.replay(ctx, 'approval:draft_save:abc', 'draft_save')).resolves.toBeNull();
        await expect(port.spentInputs(ctx, 'draft_save')).resolves.toEqual([]);
      });

      it('is taken separately by another run', async () => {
        const { port, ctx } = await start();
        await claim(port, ctx);
        await expect(claim(port, { ...ctx, runId: crypto.randomUUID() })).resolves.toBe(true);
      });
    });
  });
}
