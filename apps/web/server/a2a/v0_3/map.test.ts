import { describe, expect, it } from 'vitest';

import { counterIds } from '../../ids';
import { agentMessage } from './map';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

describe('agentMessage', () => {
  it('carries the context, task, text and role, with a fresh UUID message id each call', () => {
    const first = agentMessage('context-1', 'task-1', 'hello');
    const second = agentMessage('context-1', 'task-1', 'hello', 'user');

    const { messageId, ...rest } = first;
    expect(messageId).toMatch(UUID_V4);
    expect(rest).toEqual({
      kind: 'message',
      role: 'agent',
      parts: [{ kind: 'text', text: 'hello' }],
      contextId: 'context-1',
      taskId: 'task-1',
    });
    expect(second.role).toBe('user');
    expect(second.messageId).toMatch(UUID_V4);
    expect(second.messageId).not.toBe(first.messageId);
  });

  it('takes the message id from the id generator it is given', () => {
    const ids = counterIds();
    expect(agentMessage('c', 't', 'one', 'agent', ids).messageId).toBe(
      '00000000-0000-4000-8000-000000000001',
    );
    expect(agentMessage('c', 't', 'two', 'agent', ids).messageId).toBe(
      '00000000-0000-4000-8000-000000000002',
    );
  });
});
