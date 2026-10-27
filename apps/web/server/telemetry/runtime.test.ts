import { propagation, type TextMapPropagator } from '@opentelemetry/api';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  activeTraceHeaders,
  configureTelemetryRuntime,
  RECENT_RUN_TELEMETRY_LIMIT,
  recentRunTelemetry,
  recordRunTelemetry,
} from './runtime';

describe('telemetry runtime', () => {
  it('is disabled unless an external collector endpoint is configured', async () => {
    await expect(configureTelemetryRuntime({})).resolves.toBe(false);
  });
  it('keeps the minimal Runs projection', () => {
    recordRunTelemetry({
      runId: 'r1',
      workspaceId: 'w1',
      agentId: 'a1',
      status: 'completed',
      durationMs: 42,
      costUsd: 0.01,
    });
    expect(recentRunTelemetry('w1')).toContainEqual(
      expect.objectContaining({ runId: 'r1', status: 'completed', durationMs: 42, costUsd: 0.01 }),
    );
  });

  // W9-SEC-116: issue #116 found `GET /api/metrics` returning every workspace's telemetry to any
  // authenticated caller. `recentRunTelemetry` now requires the caller's workspace and filters by
  // it, so this test would fail — by returning the other workspace's run — if that filter were
  // reverted.
  it('filters the projection to one workspace and never returns another workspace’s runs', () => {
    const runInA = `iso-a-${crypto.randomUUID()}`;
    const runInB = `iso-b-${crypto.randomUUID()}`;
    recordRunTelemetry({
      runId: runInA,
      workspaceId: 'workspace-a',
      agentId: 'agent-a',
      status: 'completed',
      durationMs: 10,
      costUsd: 0.1,
    });
    recordRunTelemetry({
      runId: runInB,
      workspaceId: 'workspace-b',
      agentId: 'agent-b',
      status: 'completed',
      durationMs: 20,
      costUsd: 0.2,
    });

    const forA = recentRunTelemetry('workspace-a');
    expect(forA.some((run) => run.runId === runInA)).toBe(true);
    expect(forA.some((run) => run.runId === runInB)).toBe(false);
    expect(forA.every((run) => run.workspaceId === 'workspace-a')).toBe(true);

    const forB = recentRunTelemetry('workspace-b');
    expect(forB.some((run) => run.runId === runInB)).toBe(true);
    expect(forB.some((run) => run.runId === runInA)).toBe(false);

    // A workspace that has recorded nothing gets the same empty shape as one that does not exist
    // at all — there is no third answer that would let a caller distinguish the two.
    expect(recentRunTelemetry('workspace-with-no-runs')).toEqual([]);
  });

  it('bounds the process-local projection and evicts the least recently observed run', () => {
    const prefix = `bounded-${crypto.randomUUID()}`;
    for (let index = 0; index <= RECENT_RUN_TELEMETRY_LIMIT; index += 1) {
      recordRunTelemetry({
        runId: `${prefix}-${String(index)}`,
        workspaceId: 'w1',
        agentId: 'a1',
        status: 'completed',
        durationMs: index,
        costUsd: null,
      });
    }

    const snapshot = recentRunTelemetry('w1');
    expect(snapshot).toHaveLength(RECENT_RUN_TELEMETRY_LIMIT);
    expect(snapshot.some((run) => run.runId === `${prefix}-0`)).toBe(false);
    expect(snapshot.at(-1)?.runId).toBe(`${prefix}-${String(RECENT_RUN_TELEMETRY_LIMIT)}`);
  });

  it('shares the projection across two module instances, as Next.js module graphs do', async () => {
    const first = await import('./runtime');
    vi.resetModules();
    const second = await import('./runtime');
    expect(second).not.toBe(first);

    const workspaceId = crypto.randomUUID();
    const runId = crypto.randomUUID();
    first.recordRunTelemetry({
      runId,
      workspaceId,
      agentId: 'a1',
      status: 'completed',
      durationMs: 1,
      costUsd: null,
    });

    expect(second.recentRunTelemetry(workspaceId)).toContainEqual(
      expect.objectContaining({ runId }),
    );
  });

  it('never returns telemetry from another workspace', () => {
    const runId = `isolated-${crypto.randomUUID()}`;
    recordRunTelemetry({
      runId,
      workspaceId: 'other-workspace',
      agentId: 'a1',
      status: 'completed',
      durationMs: 1,
      costUsd: null,
    });

    expect(recentRunTelemetry('w1').some((run) => run.runId === runId)).toBe(false);
    expect(recentRunTelemetry('other-workspace').some((run) => run.runId === runId)).toBe(true);
  });
});

/** A propagator that injects `traceparent` as given — the part this module owns is what it forwards. */
function injecting(traceparent: string): TextMapPropagator {
  return {
    inject: (_context, carrier, setter) => {
      setter.set(carrier, 'traceparent', traceparent);
    },
    extract: (context) => context,
    fields: () => ['traceparent'],
  };
}

describe('activeTraceHeaders', () => {
  afterEach(() => {
    propagation.disable();
  });

  it('sends nothing when telemetry is off', () => {
    expect(activeTraceHeaders()).toEqual({});
  });

  it('forwards a valid traceparent', () => {
    const traceparent = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
    propagation.setGlobalPropagator(injecting(traceparent));
    expect(activeTraceHeaders()).toEqual({ traceparent });
  });

  it('never forwards a malformed one', () => {
    propagation.setGlobalPropagator(injecting('00-not-a-trace-01\r\nx-injected: 1'));
    expect(activeTraceHeaders()).toEqual({});
  });
});
