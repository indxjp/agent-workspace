vi.mock('@indx-workspace/sdk/portable', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@indx-workspace/sdk/portable')>();
  return { ...actual, diffBodies: vi.fn(actual.diffBodies) };
});

import { describe, expect, it, vi } from 'vitest';
import { InterruptedError } from '../io.js';
import { EXIT_CODE } from '../output.js';
import { IDS, runCli } from '../testing.js';
import {
  ARGV,
  DISABLED,
  TERMINAL,
  NEXT_RUN,
  SAVE,
  CHAT,
  bodyOf,
  call,
  answered,
  builder,
  ask,
  decisions,
} from './agents-new.fixture.test-support.js';

describe('Builder cancellation', () => {
  it('drops typed-ahead input before the question, and Y approves', async () => {
    const log: string[] = [];
    const run = await runCli(ARGV, {
      ...TERMINAL,
      discardInput: () => {
        log.push('discard');
        return Promise.resolve();
      },
      prompt: (question) => {
        log.push(question);
        return Promise.resolve(question === CHAT ? '' : 'Y');
      },
      route: builder(call('draft_save', { body: bodyOf('x') })),
    });
    expect(log).toEqual(['discard', SAVE, 'discard', CHAT]);
    expect(decisions(run)).toEqual([{ decision: 'approve' }]);
  });

  it.each([
    ['end of input (Ctrl-D)', false],
    ['Ctrl-C', true],
  ])('interrupts the run and sends no approval on %s at the prompt', async (_name, signalled) => {
    const controller = new AbortController();
    const run = await runCli(ARGV, {
      ...TERMINAL,
      signal: controller.signal,
      prompt: () => {
        if (signalled) controller.abort();
        return Promise.reject(new InterruptedError());
      },
      route: builder(call('draft_save', { body: bodyOf('x') })),
    });
    expect(run.code).toBe(EXIT_CODE.interrupted);
    expect(decisions(run)).toEqual([]);
    expect(
      run.calls.some((request) => request.url.pathname === `/api/runs/${IDS.run}/interrupt`),
    ).toBe(true);
  });

  it('interrupts the run on Ctrl-C while it streams', async () => {
    const controller = new AbortController();
    const base = builder(call('draft_save', { body: bodyOf('x') }));
    const run = await runCli(ARGV, {
      ...TERMINAL,
      signal: controller.signal,
      prompt: () => Promise.resolve('y'),
      route: (request) => {
        if (request.url.pathname === `/api/runs/${IDS.run}/events`) {
          controller.abort();
          throw new DOMException('aborted', 'AbortError');
        }
        return base(request);
      },
    });
    expect(run.code).toBe(EXIT_CODE.interrupted);
    expect(decisions(run)).toEqual([]);
    expect(run.calls.some((r) => r.url.pathname === `/api/runs/${IDS.run}/interrupt`)).toBe(true);
  });

  it('[US-BLD-06][api][cli] interrupts the run when a tool answers builder_disabled', async () => {
    const refusal = { ok: false, code: 'builder_disabled', message: 'off', fix: 'enable it' };
    const { run } = await ask(call('draft_save', { body: bodyOf('x') }), ['y'], {
      after: answered(refusal),
    });
    expect(
      run.calls.some((request) => request.url.pathname === `/api/runs/${NEXT_RUN}/interrupt`),
    ).toBe(true);
  });

  it('[US-BLD-06][api][cli] maps a refused tool call to the same message', async () => {
    const refusal = { ok: false, code: 'builder_disabled', message: 'off', fix: 'enable it' };
    const { run } = await ask(call('draft_save', { body: bodyOf('x') }), ['y'], {
      after: answered(refusal),
    });
    expect(run.code).toBe(EXIT_CODE.problem);
    expect(run.stderr).toContain(DISABLED);
  });
});
