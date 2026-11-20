/** pi against the fake gateway: sessions, turn limits, interrupts and pi's own defaults. */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { createFakeSessionStore } from '@agent-workspace/engine/testing';
import { describe, expect, it, vi } from 'vitest';

import { installedPiDefaultAnthropicModel, piRunSettings } from './boundary.js';
import { PI_DEFAULT_ANTHROPIC_MODEL } from './compile.js';
import { SESSION_ID, result, run, useFakeGateways } from './boundary.test-support.js';

const g = useFakeGateways();

describe('pi through the adapter: sessions', () => {
  it('continues a session on a second run, and forks it under a new id', async () => {
    const store = createFakeSessionStore('accept');
    const cwd = g.workspace();
    g.gateway.script([{ text: 'FIRST ANSWER' }]);
    await run(g.baseRequest(cwd, { prompt: 'FIRST PROMPT' }), store);

    g.gateway.script([{ text: 'SECOND ANSWER' }]);
    const resumed = await run(
      g.baseRequest(cwd, {
        prompt: 'SECOND PROMPT',
        session: { mode: 'resume', engineSessionId: SESSION_ID },
      }),
      store,
    );
    const messages = JSON.stringify(g.gateway.requests[0]?.body['messages']);
    expect(messages).toContain('FIRST PROMPT');
    expect(messages).toContain('FIRST ANSWER');
    expect(messages).toContain('SECOND PROMPT');
    expect(resumed[0]).toMatchObject({ frame: 'agent.session', engineSessionId: SESSION_ID });

    const forkId = '0f1e2d3c-4b5a-4968-8776-a5b4c3d2e1f0';
    g.gateway.script([{ text: 'FORKED ANSWER' }]);
    const forked = await run(
      g.baseRequest(cwd, {
        sessionId: forkId,
        prompt: 'FORK PROMPT',
        session: { mode: 'fork', engineSessionId: SESSION_ID },
      }),
      store,
    );
    expect(forked[0]).toMatchObject({ frame: 'agent.session', engineSessionId: forkId });
    expect(JSON.stringify(g.gateway.requests[0]?.body['messages'])).toContain('SECOND ANSWER');
    const forkStream = await store.load({ projectKey: 'pi-tenant', sessionId: forkId });
    expect(forkStream?.[0]).toMatchObject({
      type: 'session',
      id: forkId,
      parentSession: SESSION_ID,
    });
    const parentStream = await store.load({ projectKey: 'pi-tenant', sessionId: SESSION_ID });
    expect(JSON.stringify(parentStream)).not.toContain('FORK PROMPT');
  });
});

describe('pi through the adapter: turn limits', () => {
  it('stops a looping agent at maxTurns with max_turns', async () => {
    const cwd = g.workspace();
    writeFileSync(path.join(cwd, 'a.md'), 'loop');
    g.gateway.script(
      Array.from({ length: 6 }, () => ({ call: { name: 'read', args: { path: 'a.md' } } })),
    );
    const request = g.baseRequest(cwd);
    const frames = await run({
      ...request,
      portable: { ...request.portable, limits: { maxTurns: 2, maxBudgetUsd: null } },
    });
    expect(result(frames)).toMatchObject({ stopReason: 'max_turns', turns: 2 });
    // No request for a third turn is ever sent.
    expect(g.gateway.requests).toHaveLength(2);
  });

  // ADR-0162 (#342): the spend ceiling is the gateway's. 10 in + 5 out a response is past a 0.0002
  // USD cap on any price within two responses, and the adapter still runs to its turn limit.
  it('has no budget stop of its own: a spent cap runs on to maxTurns', async () => {
    const cwd = g.workspace();
    writeFileSync(path.join(cwd, 'a.md'), 'loop');
    g.gateway.script(
      Array.from({ length: 6 }, () => ({
        call: { name: 'read', args: { path: 'a.md' } },
        cacheWrite: 100,
      })),
    );
    const request = g.baseRequest(cwd);
    const frames = await run({
      ...request,
      portable: { ...request.portable, limits: { maxTurns: 3, maxBudgetUsd: 0.0002 } },
    });
    expect(result(frames)).toMatchObject({ stopReason: 'max_turns', turns: 3 });
    expect(g.gateway.requests).toHaveLength(3);
  });
});

describe('pi through the adapter: interrupts', () => {
  it('ends an interrupted bash run cancelled, promptly', async () => {
    const cwd = g.workspace();
    g.gateway.script([{ call: { name: 'bash', args: { command: 'sleep 30' } } }]);
    const started = Date.now();
    const frames = await run(g.baseRequest(cwd), undefined, (frame, interrupt) => {
      if (frame.frame === 'agent.tool.call') void interrupt();
    });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(result(frames)).toMatchObject({ stopReason: 'cancelled' });
  });

  it('fails the run, without an unhandled rejection, when pi refuses an abort', async () => {
    const cwd = g.workspace();
    writeFileSync(path.join(cwd, 'a.md'), 'x');
    g.gateway.script([{ call: { name: 'read', args: { path: 'a.md' } } }]);
    const unhandled: unknown[] = [];
    const record = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', record);
    const { AgentSession } = await vi.importActual<{
      AgentSession: { prototype: { abort: () => Promise<void> } };
    }>('@earendil-works/pi-coding-agent');
    const abort = vi
      .spyOn(AgentSession.prototype, 'abort')
      .mockRejectedValue(new Error('abort failed'));
    try {
      const failure = await run(g.baseRequest(cwd), undefined, (frame, interrupt) => {
        if (frame.frame === 'agent.tool.call') void interrupt();
      }).then(
        () => null,
        (error: unknown) => error,
      );
      await new Promise((resolve) => setImmediate(resolve));
      expect(abort).toHaveBeenCalled();
      expect(failure).toMatchObject({ message: 'abort failed' });
      expect(unhandled).toEqual([]);
    } finally {
      abort.mockRestore();
      process.off('unhandledRejection', record);
    }
  });
});

describe('pi through the adapter: defaults', () => {
  it("restates pi's own default Anthropic model", async () => {
    expect(await installedPiDefaultAnthropicModel()).toBe(PI_DEFAULT_ANTHROPIC_MODEL);
  });

  it('starts every run with cache warming and install telemetry off', () => {
    expect(piRunSettings()).toEqual({ cacheWarming: 'off', installTelemetry: false });
  });
});
