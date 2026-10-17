import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { withSurfaceFailure, withVisitorMessage } from './surface-chat-model.js';
import { surfaceStrings } from './locale.js';
import {
  useConversation,
  type Conversation,
  type UseConversationOptions,
} from './use-conversation.js';

/**
 * The headless hook, read through one server render: this repository has no DOM in its tests (see
 * `./surface-chat-send.test.ts`), so what is asserted is the conversation a page first sees. The
 * send path the hook drives is asserted end to end in `./surface-chat-send.test.ts`.
 */
function conversationOf(options: UseConversationOptions): Conversation {
  const seen: Conversation[] = [];
  function Probe(): ReactNode {
    seen.push(useConversation(options));
    return null;
  }
  renderToStaticMarkup(<Probe />);
  const [conversation] = seen;
  if (conversation === undefined) throw new Error('the probe did not render');
  return conversation;
}

describe('useConversation (#623)', () => {
  it('starts idle and empty, talking to the surface’s own agent', () => {
    const conversation = conversationOf({
      surface: 'main',
      definition: {
        name: 'main',
        agent: 'Support triage',
        parts: { agentSwitcher: { agents: ['Billing', 'Support triage'] } },
      },
    });
    expect(conversation).toMatchObject({
      messages: [],
      status: 'idle',
      runStatus: null,
      failure: null,
      turns: [],
      agentName: 'Support triage',
      agents: ['Support triage', 'Billing'],
    });
  });

  it('names the agent after the surface when neither an agent nor a definition is given', () => {
    expect(conversationOf({ surface: 'main' }).agentName).toBe('main');
  });

  it('shows a refusal as `failure` and stays open, but ends at the turn limit', () => {
    const refused = (code: string): Conversation =>
      conversationOf({
        surface: 'main',
        agentName: 'Support triage',
        initialRun: withSurfaceFailure(
          withVisitorMessage(null, 'Support triage', 'visitor-1', 'Hello'),
          surfaceStrings('en').turnLimitReached,
          code,
        ),
      });
    const limited = refused('surface_rate_limited');
    expect(limited.status).toBe('idle');
    expect(limited.failure?.code).toBe('surface_rate_limited');
    expect(limited.messages.map((message) => message.kind)).toEqual(['user']);
    expect(refused('surface_turn_limit_reached').status).toBe('ended');
  });

  it('takes an http(s) baseUrl and refuses anything else loudly', () => {
    expect(conversationOf({ surface: 'main', baseUrl: 'https://agents.example.com' }).status).toBe(
      'idle',
    );
    for (const baseUrl of ['ftp://agents.example.com', 'not a url', '/relative']) {
      expect(() => conversationOf({ surface: 'main', baseUrl })).toThrow(/baseUrl must be/u);
    }
  });
});
