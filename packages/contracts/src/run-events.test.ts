import { describe, expect, it } from 'vitest';

import {
  AGENT_FRAME_NAMES,
  CONTROL_FRAME_NAMES,
  EVENT_NAME_PATTERN,
  RELAYED_EVENT_NAMES,
  RUN_STATUS_EVENT,
  RelayedEventDataSchema,
  RunFailedFrameDataSchema,
  RunStatusEventDataSchema,
  StreamResetFrameDataSchema,
} from './run-events.js';

describe('the run event vocabulary', () => {
  it('never names a frame `error`, and keeps every name inside the SSE grammar', () => {
    const names = [
      ...CONTROL_FRAME_NAMES,
      RUN_STATUS_EVENT,
      ...RELAYED_EVENT_NAMES,
      ...AGENT_FRAME_NAMES,
    ];
    expect(names).not.toContain('error');
    for (const name of names) expect(name).toMatch(EVENT_NAME_PATTERN);
  });

  it('reads the platform lifecycle payload and refuses a status it does not know', () => {
    expect(RunStatusEventDataSchema.safeParse({ status: 'running', error: null }).success).toBe(
      true,
    );
    expect(
      RunStatusEventDataSchema.safeParse({ status: 'failed', error: 'The runtime exited.' })
        .success,
    ).toBe(true);
    expect(RunStatusEventDataSchema.safeParse({ status: 'exploded', error: null }).success).toBe(
      false,
    );
    expect(RunStatusEventDataSchema.safeParse({ status: 'running' }).success).toBe(false);
  });

  it('reads run-failed with a terminal status or the literal unknown', () => {
    expect(RunFailedFrameDataSchema.safeParse({ status: 'failed', message: 'x' }).success).toBe(
      true,
    );
    expect(RunFailedFrameDataSchema.safeParse({ status: 'unknown', message: 'x' }).success).toBe(
      true,
    );
    expect(RunFailedFrameDataSchema.safeParse({ status: 'lost', message: 'x' }).success).toBe(
      false,
    );
  });

  it('reads stream-reset and a relayed envelope, passing unknown envelope keys through', () => {
    expect(
      StreamResetFrameDataSchema.safeParse({ reason: 'retention', resumedAfter: '41' }).success,
    ).toBe(true);
    const relayed = RelayedEventDataSchema.safeParse({
      kind: 'event',
      type: 'assistant',
      event: { type: 'assistant', message: { id: 'msg_1', content: [] } },
    });
    expect(relayed.success).toBe(true);
    expect(relayed.success && relayed.data['type']).toBe('assistant');
    expect(RelayedEventDataSchema.safeParse({ type: 'assistant' }).success).toBe(false);
  });
});
