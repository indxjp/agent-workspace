import { isValidElement, type ComponentProps } from 'react';
import { describe, expect, it, vi } from 'vitest';

import type { HomeChat } from '../../components/composer/home-chat';
import type { ResumeTarget } from '../../server/sessions/resume';
import HomePage from './page';

vi.mock('next/headers', () => ({
  cookies: () => Promise.resolve({ toString: () => '' }),
  headers: () => Promise.resolve(new Headers({ 'accept-language': 'en' })),
}));

vi.mock('../../server/auth', () => ({
  getSession: () => Promise.resolve(null),
}));

vi.mock('../../server/features/console', () => ({
  featureGate: () => Promise.resolve({ enabled: true }),
}));

const SESSION = '33333333-3333-4333-8333-333333333333';
const AGENT = '22222222-2222-4222-8222-222222222222';
const target = vi.hoisted((): { value: ResumeTarget; asked: string[] } => ({
  value: { kind: 'refused' },
  asked: [],
}));
vi.mock('../../server/sessions/resume', () => ({
  resumeTargetFor: (sessionId: string) => {
    target.asked.push(sessionId);
    return Promise.resolve(target.value);
  },
}));

async function homeProps(params: Record<string, string>): Promise<ComponentProps<typeof HomeChat>> {
  const home = await HomePage({ searchParams: Promise.resolve(params) });
  if (!isValidElement<ComponentProps<typeof HomeChat>>(home)) {
    throw new Error('HomePage did not return the HomeChat boundary');
  }
  return home.props;
}

// UX-05 in #2086: a recent chat from the sidebar opens the home chat on `/?session=<id>`.
describe('HomePage continuing an earlier chat', () => {
  it('continues the chat the server allows, locked to its agent and not to a pinned version', async () => {
    target.value = {
      kind: 'continue',
      sessionId: SESSION,
      agentId: AGENT,
      label: 'Q3 refunds',
      history: null,
    };
    const props = await homeProps({ session: SESSION, agent: AGENT, version: '3' });
    expect(target.asked.at(-1)).toBe(SESSION);
    expect(props.resume).toEqual({
      kind: 'continue',
      sessionId: SESSION,
      notice: expect.stringContaining('earlier messages cannot be shown here') as unknown,
    });
    expect(props.agent).toEqual({ id: AGENT, locked: true });
    expect(props.version).toBeUndefined();
  });

  // UX-05 step 2: the earlier messages the SDK transcript holds are shown above the composer.
  it('passes the earlier messages, and says how many older ones are left out', async () => {
    const turns = [
      { speaker: 'user' as const, paragraphs: ['Summarise the Q3 refunds'] },
      {
        speaker: 'agent' as const,
        paragraphs: ['Refunds rose 12%.', 'Most were late deliveries.'],
      },
    ];
    target.value = {
      kind: 'continue',
      sessionId: SESSION,
      agentId: AGENT,
      label: 'Q3 refunds',
      history: { turns, earlierHidden: 3 },
    };
    const props = await homeProps({ session: SESSION });
    expect(props.resume).toEqual({
      kind: 'continue',
      sessionId: SESSION,
      notice: 'Continuing “Q3 refunds”. Your next message goes on from where this chat left off.',
      history: {
        heading: 'Earlier in this chat',
        earlierNote: '3 older messages are not shown.',
        turns,
      },
    });
    target.value = { ...target.value, history: { turns, earlierHidden: 0 } };
    const all = await homeProps({ session: SESSION });
    expect(
      all.resume?.kind === 'continue' ? all.resume.history?.earlierNote : 'refused',
    ).toBeNull();
  });

  it('shows no earlier messages when the transcript holds none a person reads', async () => {
    target.value = {
      kind: 'continue',
      sessionId: SESSION,
      agentId: AGENT,
      label: 'Q3 refunds',
      history: { turns: [], earlierHidden: 0 },
    };
    const props = await homeProps({ session: SESSION });
    expect(props.resume?.kind === 'continue' ? props.resume.history : 'refused').toBeUndefined();
    expect(props.resume?.notice).toContain('earlier messages cannot be shown here');
  });

  it('says a refused chat cannot be continued, and is the new chat it always was', async () => {
    target.value = { kind: 'refused' };
    const props = await homeProps({ session: SESSION });
    expect(props.resume?.kind).toBe('refused');
    expect(props.agent).toBeUndefined();
  });

  it('asks nothing when the link names no chat, or a malformed one', async () => {
    target.asked = [];
    expect((await homeProps({})).resume).toBeUndefined();
    expect((await homeProps({ session: 'not-a-uuid' })).resume).toBeUndefined();
    expect(target.asked).toEqual([]);
  });
});
