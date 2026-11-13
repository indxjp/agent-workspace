import { engineStreamKey } from '@agent-workspace/engine';
import { describe, expect, it } from 'vitest';

import {
  MAX_HISTORY_TURNS,
  MAX_PARAGRAPH_CHARACTERS,
  chatHistoryFor,
  chatHistoryFrom,
} from './history';
import { InMemoryTranscriptStore } from './memory-store';
import { InMemorySessionStateStore } from './state-memory-store';

const WORKSPACE = 'ws_history';
const ROW_ID = '11111111-1111-4111-8111-111111111111';
const ENGINE_SESSION = '22222222-2222-4222-8222-222222222222';

const user = (content: unknown, extra: Record<string, unknown> = {}) => ({
  type: 'user',
  message: { role: 'user', content },
  ...extra,
});
const assistant = (content: unknown, extra: Record<string, unknown> = {}) => ({
  type: 'assistant',
  message: { role: 'assistant', content },
  ...extra,
});

// The shapes the Claude Agent SDK writes to its session store (one JSONL line per entry).
const TRANSCRIPT = [
  { type: 'summary', summary: 'Q3 refunds' },
  user('Summarise the Q3 refunds'),
  assistant([{ type: 'thinking', thinking: 'Look at the files first.' }]),
  assistant([{ type: 'text', text: 'I will read the files.' }]),
  assistant([{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'q3.csv' } }]),
  user([{ type: 'tool_result', tool_use_id: 't1', content: 'secret file body' }]),
  assistant([{ type: 'text', text: '  Refunds rose 12%.  ' }]),
  user('Caveat: local command output', { isMeta: true }),
  user('This session is being continued from a previous conversation.', { isCompactSummary: true }),
  assistant([{ type: 'text', text: 'A subagent turn.' }], { isSidechain: true }),
  user([
    { type: 'text', text: 'Which month was worst?' },
    { type: 'image', source: {} },
  ]),
  assistant([{ type: 'text', text: 'September.' }]),
];

describe('chatHistoryFrom', () => {
  it('keeps what a person reads: their text and the agent’s answers, in order', () => {
    expect(chatHistoryFrom(TRANSCRIPT)).toEqual({
      earlierHidden: 0,
      turns: [
        { speaker: 'user', paragraphs: ['Summarise the Q3 refunds'] },
        // Text split by a tool call and its result is still one answer.
        { speaker: 'agent', paragraphs: ['I will read the files.', 'Refunds rose 12%.'] },
        { speaker: 'user', paragraphs: ['Which month was worst?'] },
        { speaker: 'agent', paragraphs: ['September.'] },
      ],
    });
  });

  it('never shows a tool result, thinking, a meta entry or a subagent turn', () => {
    const shown = JSON.stringify(chatHistoryFrom(TRANSCRIPT));
    for (const hidden of [
      'secret file body',
      'Look at the files',
      'Caveat',
      'A subagent turn',
      'being continued',
    ]) {
      expect(shown).not.toContain(hidden);
    }
  });

  it('ignores entries it cannot read rather than failing', () => {
    expect(
      chatHistoryFrom([
        null,
        'text',
        [],
        { type: 'user' },
        { type: 'user', message: 'x' },
        user(7),
        user('   '),
        // Only blocks of type `text` are read, even when another block carries a `text` field.
        assistant([{ type: 'redacted_thinking', data: 'x', text: 'hidden reasoning' }]),
      ]),
    ).toEqual({ turns: [], earlierHidden: 0 });
  });

  it('keeps the most recent turns and counts the older ones it leaves out', () => {
    const many = Array.from({ length: MAX_HISTORY_TURNS + 3 }, (_, index) =>
      index % 2 === 0 ? user(`question ${String(index)}`) : assistant(`answer ${String(index)}`),
    );
    const history = chatHistoryFrom(many);
    expect(history.earlierHidden).toBe(3);
    expect(history.turns).toHaveLength(MAX_HISTORY_TURNS);
    expect(history.turns.at(-1)?.paragraphs).toEqual([`question ${String(MAX_HISTORY_TURNS + 2)}`]);
    expect(chatHistoryFrom(many.slice(0, MAX_HISTORY_TURNS)).earlierHidden).toBe(0);
  });

  it('shortens a very long paragraph and says so with an ellipsis', () => {
    const long = 'a'.repeat(MAX_PARAGRAPH_CHARACTERS + 10);
    const [turn] = chatHistoryFrom([user(long)]).turns;
    expect(turn?.paragraphs[0]).toBe(`${'a'.repeat(MAX_PARAGRAPH_CHARACTERS)}…`);
    const exact = 'b'.repeat(MAX_PARAGRAPH_CHARACTERS);
    expect(chatHistoryFrom([user(exact)]).turns[0]?.paragraphs[0]).toBe(exact);
  });
});

describe('chatHistoryFor', () => {
  const row = {
    id: ROW_ID,
    workspaceId: WORKSPACE,
    engine: 'claude-agent-sdk' as const,
    engineSessionId: ENGINE_SESSION,
  };
  const key = { projectKey: WORKSPACE, sessionId: ENGINE_SESSION };

  async function stores() {
    const stateStore = new InMemorySessionStateStore();
    const store = new InMemoryTranscriptStore();
    await stateStore.append(
      {
        workspaceId: WORKSPACE,
        sessionId: ROW_ID,
        engine: 'claude-agent-sdk',
        streamKey: engineStreamKey(key),
      },
      [{ entry: user('From the engine stream') }],
    );
    await store.append(key, [user('From the legacy store')]);
    return { stateStore, store };
  }

  it('reads the engine-scoped stream the runner writes', async () => {
    const history = await chatHistoryFor(await stores(), row);
    expect(history?.turns).toEqual([{ speaker: 'user', paragraphs: ['From the engine stream'] }]);
  });

  it('falls back to the pre-ENG-06 store, as the transcript route does', async () => {
    const env = { stateStore: new InMemorySessionStateStore(), store: (await stores()).store };
    const history = await chatHistoryFor(env, row);
    expect(history?.turns).toEqual([{ speaker: 'user', paragraphs: ['From the legacy store'] }]);
  });

  it('answers null when there is nothing to read', async () => {
    const env = await stores();
    expect(await chatHistoryFor(env, { ...row, engineSessionId: null })).toBeNull();
    expect(await chatHistoryFor(env, { ...row, engine: 'openai-agents' as const })).toBeNull();
    const empty = {
      stateStore: new InMemorySessionStateStore(),
      store: new InMemoryTranscriptStore(),
    };
    expect(await chatHistoryFor(empty, row)).toBeNull();
  });

  it('reads a session whose engine is not recorded yet', async () => {
    const history = await chatHistoryFor(await stores(), { ...row, engine: null });
    expect(history?.turns).toHaveLength(1);
  });
});
