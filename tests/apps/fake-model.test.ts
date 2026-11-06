import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { fakeReplyText } from '../generated-project/fake-anthropic.mjs';
import {
  answerOf,
  FAKE_KEY_PREFIX,
  parseModelScript,
  readModelScript,
  scriptedTurn,
  startFakeModel,
} from './fake-model.mjs';
import { EXAMPLES_DIR, loadExampleApps } from './registry.ts';

const SCRIPT = parseModelScript({
  conversations: [
    {
      when: 'e2e-fake-model',
      turns: [
        { tool: 'note_list', input: { limit: 5 } },
        { structured: { summary: 'one note' } },
        { text: 'There is one note.' },
      ],
    },
  ],
});

const NOTE_LIST = { name: 'mcp__minimal__note_list', input_schema: { type: 'object' } };
const STRUCTURED = { name: 'StructuredOutput', input_schema: { type: 'object' } };

const stops: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const stop of stops.splice(0)) await stop();
});

async function serve(): Promise<Awaited<ReturnType<typeof startFakeModel>>> {
  const fake = await startFakeModel(SCRIPT);
  stops.push(fake.close);
  return fake;
}

async function ask(
  baseUrl: string,
  body: Record<string, unknown>,
): Promise<{ content: Record<string, unknown>[]; stop_reason: string }> {
  const response = await fetch(`${baseUrl}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': `${FAKE_KEY_PREFIX}test` },
    body: JSON.stringify({ model: 'claude-sonnet-4-5', max_tokens: 64, ...body }),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as { content: Record<string, unknown>[]; stop_reason: string };
}

const opening = { role: 'user', content: 'Summarise my notes. e2e-fake-model' };
const toolTurn = {
  role: 'assistant',
  content: [{ type: 'tool_use', id: 'toolu_1', name: NOTE_LIST.name, input: {} }],
};
const toolResult = {
  role: 'user',
  content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '[{"title":"A"}]' }],
};

describe('the apps lane scripted model', () => {
  it("returns a script's tool_use turn for the offered tool whose name ends in it", async () => {
    const fake = await serve();

    const answer = await ask(fake.baseUrl, { messages: [opening], tools: [NOTE_LIST] });

    expect(answer.stop_reason).toBe('tool_use');
    expect(answer.content).toMatchObject([
      { type: 'tool_use', name: 'mcp__minimal__note_list', input: { limit: 5 } },
    ]);
    expect(fake.scripted).toHaveLength(1);
  });

  it('advances the script on each tool_result, through structured output to text', async () => {
    const fake = await serve();
    const structured = await ask(fake.baseUrl, {
      messages: [opening, toolTurn, toolResult],
      tools: [NOTE_LIST, STRUCTURED],
    });
    expect(structured.content).toMatchObject([
      { type: 'tool_use', name: 'StructuredOutput', input: { summary: 'one note' } },
    ]);

    const text = await ask(fake.baseUrl, {
      messages: [opening, toolTurn, toolResult, toolTurn, toolResult],
      tools: [NOTE_LIST],
    });
    expect(text.content).toStrictEqual([{ type: 'text', text: 'There is one note.' }]);
  });

  it('gives unscripted requests the base fake reply', async () => {
    const fake = await serve();
    const other = { role: 'user', content: 'Hello e2e-nonce-abc123' };

    const unmatched = await ask(fake.baseUrl, { messages: [other], tools: [NOTE_LIST] });
    const notOffered = await ask(fake.baseUrl, { messages: [opening], tools: [] });
    const pastTheEnd = await ask(fake.baseUrl, {
      messages: [opening, toolTurn, toolResult, toolTurn, toolResult, toolTurn, toolResult],
    });

    expect(unmatched.content).toStrictEqual([
      { type: 'text', text: fakeReplyText([null, [other]]) },
    ]);
    expect(notOffered.content).toStrictEqual([{ type: 'text', text: 'Fake Anthropic reply.' }]);
    expect(pastTheEnd.content).toStrictEqual([{ type: 'text', text: 'Fake Anthropic reply.' }]);
    expect(fake.scripted).toHaveLength(0);
    expect(fake.requests.map((request) => request.path)).toStrictEqual([
      '/v1/messages',
      '/v1/messages',
      '/v1/messages',
    ]);
  });

  it('streams a tool turn in the event shape the engine reads', async () => {
    const fake = await serve();
    const response = await fetch(`${fake.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ stream: true, messages: [opening], tools: [NOTE_LIST] }),
    });
    const events = await response.text();

    expect(response.headers.get('content-type')).toBe('text/event-stream');
    expect(events).toContain('"content_block":{"type":"tool_use"');
    expect(events).toContain('"stop_reason":"tool_use"');
  });

  it('hands out a fresh fake key each start, never a real one', async () => {
    const first = await serve();
    const second = await serve();

    expect(first.key).toMatch(/^sk-ant-e2e-fake-[0-9a-f]{32}$/u);
    expect(second.key).not.toBe(first.key);
  });

  it('refuses a script with an unknown key or a turn of two kinds', () => {
    expect(() => parseModelScript({ conversations: [], extra: 1 })).toThrow('nothing else');
    expect(() =>
      parseModelScript({ conversations: [{ when: 'x', turns: [{ text: 'a', tool: 'b' }] }] }),
    ).toThrow('exactly one of');
    expect(() => parseModelScript({ conversations: [{ when: '', turns: [] }] })).toThrow(
      'when is empty',
    );
  });

  it("resolves a tool input's placeholders from the prompt's ids and the latest tool result", () => {
    const [root, child] = [crypto.randomUUID(), crypto.randomUUID()];
    const space = crypto.randomUUID();
    const turn = {
      tool: 'page_create',
      input: {
        parent: '{{prompt.uuid.0}}',
        space: '{{result.space}}',
        tags: ['{{prompt.uuid.1}}'],
      },
    } as const;
    const prompt = { role: 'user', content: `page ${root}: read ${root}, ${child.toUpperCase()}` };
    const result = {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'toolu_1',
          content: [{ type: 'text', text: JSON.stringify({ id: child, space }) }],
        },
      ],
    };
    const tools = [{ name: 'mcp__wiki__page_create' }];

    expect(answerOf(turn, tools, [prompt, toolTurn, result])).toStrictEqual({
      toolUse: {
        name: 'mcp__wiki__page_create',
        input: { parent: root, space, tags: [child] },
      },
    });
    // A placeholder that does not resolve leaves the turn to the base fake.
    expect(answerOf(turn, tools, [prompt])).toBeUndefined();
    // The engine opens the first user message with context of its own, whose working directory
    // holds the workspace's and the session's ids: the ids come from the prompt's block only.
    const withContext = {
      role: 'user',
      content: [
        {
          type: 'text',
          text: `<system-reminder>cwd /work/${crypto.randomUUID()}</system-reminder>`,
        },
        { type: 'text', text: `page ${root}: read ${root}, ${child} into one new page` },
      ],
    };
    expect(
      answerOf(turn, tools, [withContext, toolTurn, result], 'into one new page'),
    ).toStrictEqual({
      toolUse: { name: 'mcp__wiki__page_create', input: { parent: root, space, tags: [child] } },
    });
    // The engine appends context to a tool's output too: the record is the JSON before it.
    const remindedResult = {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'toolu_1',
          content: `${JSON.stringify({ id: child, space })}\n\n<system-reminder>\n<total_tokens>9 tokens left</total_tokens>\n</system-reminder>`,
        },
      ],
    };
    expect(
      answerOf(turn, tools, [withContext, toolTurn, remindedResult], 'into one new page'),
    ).toStrictEqual({
      toolUse: { name: 'mcp__wiki__page_create', input: { parent: root, space, tags: [child] } },
    });
    expect(() =>
      parseModelScript({
        conversations: [{ when: 'x', turns: [{ tool: 'a', input: { id: '{{prompt.id}}' } }] }],
      }),
    ).toThrow('which is no placeholder');
  });

  it('matches a conversation by its first user message only', () => {
    const later = { role: 'user', content: 'e2e-fake-model' };
    expect(scriptedTurn(SCRIPT, [{ role: 'user', content: 'hi' }, later])).toBeUndefined();
    expect(scriptedTurn(SCRIPT, [opening])).toStrictEqual({
      tool: 'note_list',
      input: { limit: 5 },
    });
  });

  it("sends {{prompt.uuid.0}} as the first user message's record id, and leaves the turn to the base fake without one", () => {
    const id = '0b7c3f5e-1d2a-4c8b-9e6f-5a4b3c2d1e0f';
    const ticket = { name: 'mcp__service-desk__ticket_update', input_schema: { type: 'object' } };
    const turn = { tool: 'ticket_update', input: { id: '{{prompt.uuid.0}}', status: 'closed' } };
    const messages = [{ role: 'user', content: `ticket ${id}: close it` }];

    expect(answerOf(turn, [ticket], messages, 'close it')).toStrictEqual({
      toolUse: { name: ticket.name, input: { id, status: 'closed' } },
    });
    expect(
      answerOf(turn, [ticket], [{ role: 'user', content: 'no record here' }], 'record'),
    ).toBeUndefined();
  });

  it("reads the record from the block that holds the conversation's when, not Claude Code's own", () => {
    const id = '0b7c3f5e-1d2a-4c8b-9e6f-5a4b3c2d1e0f';
    const workspace = '9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a';
    const ticket = { name: 'mcp__service-desk__ticket_update', input_schema: { type: 'object' } };
    const turn = { tool: 'ticket_update', input: { id: '{{prompt.uuid.0}}' } };
    const messages = [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: `<system-reminder>cwd: /workspaces/${workspace}</system-reminder>`,
          },
          { type: 'text', text: `Triage ticket ${id}: assign it.` },
        ],
      },
    ];
    expect(answerOf(turn, [ticket], messages, 'Triage ticket')).toStrictEqual({
      toolUse: { name: ticket.name, input: { id } },
    });
    expect(answerOf(turn, [ticket], messages, 'not asked')).toBeUndefined();
  });

  it.each(loadExampleApps().map((app) => [app.benchmark.id] as const))(
    "examples/%s's model script parses",
    async (id) => {
      const file = path.join(EXAMPLES_DIR, id, 'e2e', 'model-script.json');
      const script = readModelScript(file);
      expect(script.conversations.length).toBeGreaterThan(0);
      expect(JSON.parse(await readFile(file, 'utf8'))).toStrictEqual(
        JSON.parse(JSON.stringify(script)),
      );
    },
  );
});
