import { propagation, type TextMapPropagator } from '@opentelemetry/api';
import { afterEach, describe, expect, it } from 'vitest';

import { BUILDER_PROMPT_VERSION, BUILDER_SHIPPED_SUMMARY } from '../agent/prompt-version';
import { toCallContext } from './call-context';
import type { RunCallerPrincipal, RunIdentity } from './run-caller';

const RUN: RunIdentity = {
  kind: 'run',
  workspaceId: 'ws-1',
  runId: 'run-1',
  sessionId: 'session-1',
  agentId: 'agent-1',
};
const PERSON: RunCallerPrincipal = {
  ...RUN,
  kind: 'run-caller',
  principalId: 'principal-1',
  userId: 'user-1',
  role: 'builder',
};
const ROW = {
  modelId: 'model-1',
  agentVersion: { id: 'version-1', number: 1, summary: BUILDER_SHIPPED_SUMMARY },
};
const TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';

/** An active span, as the route's instrumentation would expose it. */
const activeTrace: TextMapPropagator = {
  inject: (_context, carrier, setter) => {
    setter.set(carrier, 'traceparent', `00-${TRACE_ID}-00f067aa0ba902b7-01`);
  },
  extract: (context) => context,
  fields: () => ['traceparent'],
};

afterEach(() => {
  propagation.disable();
});

describe('toCallContext', () => {
  it('takes the run and the person from the token, model and version from the row', () => {
    expect(toCallContext(PERSON, ROW)).toStrictEqual({
      workspaceId: 'ws-1',
      door: { kind: 'run', agentId: 'agent-1', agentVersion: 1 },
      runId: 'run-1',
      traceId: expect.stringMatching(/^[0-9a-f]{32}$/) as string,
      caller: {
        kind: 'person',
        principal: {
          workspaceId: 'ws-1',
          principalId: 'principal-1',
          ownerPrincipalId: 'principal-1',
          userId: 'user-1',
          role: 'builder',
        },
      },
      modelId: 'model-1',
      promptVersion: BUILDER_PROMPT_VERSION,
    });
  });

  it('falls back to the version id when the summary records no prompt version', () => {
    const edited = {
      ...ROW,
      agentVersion: { id: 'version-2', number: 2, summary: 'Edited in the console' },
    };
    expect(toCallContext(RUN, edited).promptVersion).toBe('version-2');
  });

  it('gives a run with no person no caller', () => {
    expect(toCallContext(RUN, ROW).caller).toStrictEqual({ kind: 'none' });
  });

  it('mints a fresh 32-hex trace id per call, ignoring the active span', () => {
    propagation.setGlobalPropagator(activeTrace);
    const first = toCallContext(RUN, ROW).traceId;
    expect(first).not.toBe(TRACE_ID);
    expect(first).toMatch(/^[0-9a-f]{32}$/);
    expect(toCallContext(RUN, ROW).traceId).not.toBe(first);
  });
});
