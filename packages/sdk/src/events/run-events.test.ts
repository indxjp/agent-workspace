import { describe, expect, it } from 'vitest';

import { ContractViolationError } from '../errors.js';
import { classifyRunEventFrame } from './run-events.js';

const AT = '2026-10-13T10:00:00.000Z';

describe('classifyRunEventFrame at stamp', () => {
  it('carries the stamp on the durable frames', () => {
    expect(
      classifyRunEventFrame({
        event: 'run.status',
        id: '1',
        at: AT,
        data: { status: 'running', error: null },
      }),
    ).toEqual({
      kind: 'run-status',
      id: '1',
      at: AT,
      data: { status: 'running', error: null },
    });
    expect(
      classifyRunEventFrame({ event: 'agent.message', id: '2', at: AT, data: { frame: 'x' } }),
    ).toEqual({ kind: 'runtime', id: '2', at: AT, name: 'agent.message', data: { frame: 'x' } });
  });

  it('leaves the stamp off a frame from a server that sent none', () => {
    const frame = classifyRunEventFrame({ event: 'agent.message', id: '2', data: null });
    expect(frame).not.toHaveProperty('at');
  });

  it('refuses a stamp that is not an ISO-8601 instant as platform drift', () => {
    expect(() =>
      classifyRunEventFrame({ event: 'agent.message', id: '2', at: 'yesterday', data: null }),
    ).toThrow(ContractViolationError);
  });
});
