import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ApplicationContext } from '../application-context';
import { RECENT_CHAT_LIMIT, recentChatsFor } from './recent';
import { resumeTargetFor } from './resume';
import { InMemoryTranscriptStore } from './memory-store';
import { InMemorySessionStateStore } from './state-memory-store';

const context = vi.hoisted((): { value: unknown } => ({ value: null }));
vi.mock('../application-context', () => ({
  applicationContext: () => context.value as ApplicationContext | null,
}));
const logError = vi.hoisted(() => vi.fn());
vi.mock('../telemetry/logger', () => ({ log: { error: logError, info: vi.fn(), warn: vi.fn() } }));

const WS = '11111111-1111-4111-8111-111111111111';
const ME = 'principal-me';
const OTHER = 'principal-other';
const AGENT = '22222222-2222-4222-8222-222222222222';
const SESSION = '33333333-3333-4333-8333-333333333333';
const BUILDER = '55555555-5555-4555-8555-555555555555';

interface Row {
  readonly id: string;
  readonly agentId: string;
  readonly ownerPrincipalId: string;
  readonly title: string | null;
  readonly status: 'active' | 'archived';
  readonly engineSessionId: string | null;
  readonly workspaceId: string;
  readonly engine: 'claude-agent-sdk' | null;
}

const row = (patch: Partial<Row> = {}): Row => ({
  id: SESSION,
  agentId: AGENT,
  ownerPrincipalId: ME,
  title: null,
  status: 'active',
  engineSessionId: 'engine-1',
  workspaceId: WS,
  engine: 'claude-agent-sdk',
  ...patch,
});

function install(
  rows: readonly Row[],
  options: {
    readonly listFails?: boolean;
    readonly store?: InMemoryTranscriptStore;
    readonly stateStore?: InMemorySessionStateStore;
  } = {},
) {
  const list = vi.fn((input: unknown) =>
    options.listFails === true
      ? Promise.reject(new Error('database down'))
      : Promise.resolve({ items: rows, nextCursor: null, input }),
  );
  const get = vi.fn((id: string) => Promise.resolve(rows.find((r) => r.id === id) ?? null));
  context.value = {
    sessions: {
      authenticate: () =>
        Promise.resolve({
          kind: 'user',
          principalId: ME,
          ownerPrincipalId: ME,
          userId: 'user-me',
          workspaceId: WS,
          role: 'owner',
        }),
      sessions: { forWorkspaceId: () => Promise.resolve({ list, get }) },
      store: options.store ?? new InMemoryTranscriptStore(),
      stateStore: options.stateStore ?? new InMemorySessionStateStore(),
    },
    agents: {
      agents: {
        forWorkspace: () => ({
          get: (id: string) =>
            Promise.resolve(
              id === AGENT
                ? { id, name: 'Report writer' }
                : id === BUILDER
                  ? { id, name: 'Builder', builtin: 'builder' }
                  : null,
            ),
        }),
      },
    },
  };
  return { list, get };
}

beforeEach(() => {
  context.value = null;
});

describe('recentChatsFor (spec §44, UX-05)', () => {
  it("lists only the person's own active chats, about ten, newest first as the store returns them", async () => {
    const { list } = install([row({ title: 'Q3 refunds' }), row({ id: 'second' })]);
    const chats = await recentChatsFor({ workspaceId: WS, principalId: ME });
    expect(list).toHaveBeenCalledWith({
      visibility: { kind: 'owner', principalId: ME },
      status: 'active',
      limit: RECENT_CHAT_LIMIT,
      cursor: null,
    });
    expect(RECENT_CHAT_LIMIT).toBe(10);
    expect(chats).toEqual([
      { id: SESSION, label: 'Q3 refunds' },
      { id: 'second', label: 'Report writer' },
    ]);
  });

  it("leaves out a built-in agent's sessions, which the composer cannot continue", async () => {
    install([row({ id: 'builder-session', agentId: BUILDER }), row({ title: 'Q3 refunds' })]);
    expect(await recentChatsFor({ workspaceId: WS, principalId: ME })).toEqual([
      { id: SESSION, label: 'Q3 refunds' },
    ]);
  });

  it('labels a chat with no title and an unknown agent with null, for the sidebar to word', async () => {
    install([row({ agentId: 'gone' })]);
    expect(await recentChatsFor({ workspaceId: WS, principalId: ME })).toEqual([
      { id: SESSION, label: null },
    ]);
  });

  it('is empty when nothing is wired or the read fails, so the sidebar still renders', async () => {
    expect(await recentChatsFor({ workspaceId: WS, principalId: ME })).toEqual([]);
    install([row()], { listFails: true });
    expect(await recentChatsFor({ workspaceId: WS, principalId: ME })).toEqual([]);
  });
});

describe('resumeTargetFor (UX-05)', () => {
  const offered = new Map([[AGENT, 'Report writer']]);
  const request = new Request('http://localhost/');

  it("continues the person's own active, started chat on an offered agent", async () => {
    install([row({ title: 'Q3 refunds' })]);
    expect(await resumeTargetFor(SESSION, request, offered)).toEqual({
      kind: 'continue',
      sessionId: SESSION,
      agentId: AGENT,
      label: 'Q3 refunds',
      history: null,
    });
    install([row()]);
    expect(await resumeTargetFor(SESSION, request, offered)).toMatchObject({
      label: 'Report writer',
    });
  });

  it.each([
    ["someone else's chat, even for an Owner", row({ ownerPrincipalId: OTHER })],
    ['an archived chat', row({ status: 'archived' })],
    ['a chat its engine never started', row({ engineSessionId: null })],
    ['a chat on an agent this person is not offered', row({ agentId: 'not-offered' })],
  ])('refuses %s', async (_case, stored) => {
    install([stored]);
    expect(await resumeTargetFor(SESSION, request, offered)).toEqual({ kind: 'refused' });
  });

  // UX-05 step 2: the earlier messages come from the SDK transcript of the chat being continued.
  it('reads the earlier messages of the chat it continues', async () => {
    const store = new InMemoryTranscriptStore();
    await store.append({ projectKey: WS, sessionId: 'engine-1' }, [
      { type: 'user', message: { role: 'user', content: 'Summarise the Q3 refunds' } },
      {
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Up 12%.' }] },
      },
    ]);
    install([row()], { store });
    expect(await resumeTargetFor(SESSION, request, offered)).toMatchObject({
      kind: 'continue',
      history: {
        earlierHidden: 0,
        turns: [
          { speaker: 'user', paragraphs: ['Summarise the Q3 refunds'] },
          { speaker: 'agent', paragraphs: ['Up 12%.'] },
        ],
      },
    });
  });

  it('still continues the chat when its transcript cannot be read', async () => {
    const stateStore = new InMemorySessionStateStore();
    vi.spyOn(stateStore, 'list').mockRejectedValue(new Error('database down'));
    install([row()], { stateStore });
    expect(await resumeTargetFor(SESSION, request, offered)).toMatchObject({
      kind: 'continue',
      history: null,
    });
    expect(logError).toHaveBeenCalledWith(
      expect.stringContaining(SESSION),
      expect.objectContaining({ error: expect.any(Error) as unknown }),
    );
  });

  it('refuses an unknown chat, and refuses when nothing is wired', async () => {
    install([]);
    expect(await resumeTargetFor(SESSION, request, offered)).toEqual({ kind: 'refused' });
    context.value = null;
    expect(await resumeTargetFor(SESSION, request, offered)).toEqual({ kind: 'refused' });
  });
});
