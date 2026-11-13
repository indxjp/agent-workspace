/* global console */
/**
 * The apps lane's scripted model (issue #1531): the generated-project E2E's fake Anthropic API
 * (`../generated-project/fake-anthropic.mjs`, unchanged) with each app's own turns on top, so an
 * app's journeys can drive an agent through its tools with no real model and no real key.
 *
 * An app's turns live in `examples/<id>/e2e/model-script.json`, so the four reference apps never
 * edit a shared fake:
 *
 *   { "conversations": [{ "when": "<text the first user message holds>", "turns": [
 *       { "tool": "note_list", "input": {} },
 *       { "text": "There is one note." },
 *       { "structured": { "summary": "…" } } ] }] }
 *
 * A request belongs to the first conversation whose `when` its first user message contains. Its
 * turn is the one after as many turns as the request's messages carry `tool_result` answers: the
 * engine sends the result of each tool turn back, and that advances the script, so the fake holds
 * no state between requests. A `tool` turn answers `tool_use` for the offered tool whose name is
 * `tool` or ends in `__<tool>` (an MCP tool is `mcp__<app>__<tool>`); a `text` turn answers that
 * text; a `structured` turn answers the engine's `StructuredOutput` tool with that input when it
 * is offered, else the JSON as text. A request that matches no conversation, has run past its
 * turns, or is not offered the scripted tool gets the base fake's reply, byte for byte.
 *
 * A tool turn's input may name what only the run knows, as a string value that is exactly one
 * placeholder: `"{{prompt.uuid.N}}"` is the N-th distinct UUID of the first user message's text
 * block that holds the conversation's `when` (a prompt names the records it is about by id; the
 * engine's own context blocks, whose paths hold ids too, are left out), and `"{{result.<key>}}"` is the `<key>` of the
 * JSON object the latest `tool_result` holds (a record's own fields, such as the space it is in;
 * the `<system-reminder>` context the engine appends to it is left out).
 * A turn whose placeholder does not resolve is not scripted: the base fake answers it.
 *
 * {@link startFakeModel} serves it on loopback. The claude-agent-sdk engine reaches it through the
 * gateway with `ANTHROPIC_BASE_URL` and a generated `sk-ant-e2e-fake-<random>` key.
 */
import { Buffer } from 'node:buffer';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { URL } from 'node:url';

import {
  FAKE_MODELS,
  createAnthropicHandler,
  encodeSse,
  messageResponse,
  messageStreamEvents,
} from '../generated-project/fake-anthropic.mjs';
import { toolUseEvents, toolUseResponse } from '../journey/fake-anthropic-tools.mjs';

/** Every key the lane hands `aw dev` starts with this: the fake accepts it, a real API never. */
export const FAKE_KEY_PREFIX = 'sk-ant-e2e-fake-';

/** The tool the claude-agent-sdk engine offers for structured output. */
export const STRUCTURED_OUTPUT_TOOL = 'StructuredOutput';

/** A new fake key: {@link FAKE_KEY_PREFIX} and 32 random hex characters. */
export function fakeModelKey() {
  return `${FAKE_KEY_PREFIX}${randomBytes(16).toString('hex')}`;
}

/** @param {unknown} value */
const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/** A tool input's placeholder: `{{prompt.uuid.N}}` or `{{result.<key>}}`. */
const PLACEHOLDER = /^\{\{(?:prompt\.uuid\.(\d+)|result\.([A-Za-z_][A-Za-z0-9_]*))\}\}$/u;

/** Every string in `value`, an input or a part of one, that looks like a placeholder but is not. */
function badPlaceholders(value) {
  if (typeof value === 'string') {
    return value.startsWith('{{') && !PLACEHOLDER.test(value) ? [value] : [];
  }
  if (Array.isArray(value)) return value.flatMap(badPlaceholders);
  return isRecord(value) ? Object.values(value).flatMap(badPlaceholders) : [];
}

/**
 * One turn, checked: exactly one of `tool` (with an optional `input` object), `text` or
 * `structured`, and no other key.
 *
 * @param {unknown} turn @param {string} where
 */
function parseTurn(turn, where) {
  if (!isRecord(turn)) throw new Error(`${where} is not an object`);
  const keys = Object.keys(turn).sort().join(',');
  if (keys === 'tool' || keys === 'input,tool') {
    if (typeof turn['tool'] !== 'string' || turn['tool'] === '') {
      throw new Error(`${where}.tool is not a tool name`);
    }
    const input = turn['input'] ?? {};
    if (!isRecord(input)) throw new Error(`${where}.input is not an object`);
    const [bad] = badPlaceholders(input);
    if (bad !== undefined) throw new Error(`${where}.input has ${bad}, which is no placeholder`);
    return { tool: turn['tool'], input };
  }
  if (keys === 'text') {
    if (typeof turn['text'] !== 'string') throw new Error(`${where}.text is not a string`);
    return { text: turn['text'] };
  }
  if (keys === 'structured') {
    if (!isRecord(turn['structured'])) throw new Error(`${where}.structured is not an object`);
    return { structured: turn['structured'] };
  }
  throw new Error(`${where} must have exactly one of tool (and input), text or structured`);
}

/**
 * A model script, checked: `{ conversations: [{ when, turns }] }` and nothing else, each `when` a
 * non-empty string and each turn as {@link parseTurn} says. Throws naming the first offence.
 *
 * @param {unknown} value
 */
export function parseModelScript(value) {
  if (!isRecord(value) || Object.keys(value).join(',') !== 'conversations') {
    throw new Error('a model script is { "conversations": [...] } and nothing else');
  }
  const conversations = value['conversations'];
  if (!Array.isArray(conversations)) throw new Error('conversations is not an array');
  return {
    conversations: conversations.map((conversation, index) => {
      const where = `conversations[${String(index)}]`;
      if (!isRecord(conversation) || Object.keys(conversation).sort().join(',') !== 'turns,when') {
        throw new Error(`${where} is { "when": …, "turns": [...] } and nothing else`);
      }
      const { when, turns } = conversation;
      if (typeof when !== 'string' || when === '') throw new Error(`${where}.when is empty`);
      if (!Array.isArray(turns)) throw new Error(`${where}.turns is not an array`);
      return {
        when,
        turns: turns.map((turn, at) => parseTurn(turn, `${where}.turns[${String(at)}]`)),
      };
    }),
  };
}

/**
 * The script at `file`, or an empty one when the app has none.
 *
 * @param {string} file
 */
export function readModelScript(file) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return { conversations: [] };
    }
    throw error;
  }
  return parseModelScript(JSON.parse(text));
}

/** The blocks of a message's content; a plain string is one text block. */
function blocksOf(message) {
  const content = message?.content;
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return Array.isArray(content) ? content : [];
}

/**
 * The conversation a request belongs to: the first whose `when` its first user message contains.
 *
 * @param {ReturnType<typeof parseModelScript>} script @param {readonly unknown[]} messages
 */
function conversationOf(script, messages) {
  const first = messages.find((message) => isRecord(message) && message['role'] === 'user');
  const opening = JSON.stringify(blocksOf(first));
  return script.conversations.find(({ when }) => opening.includes(when));
}

/**
 * The scripted turn a request is at: its conversation's turn after as many as the request's
 * messages answer with a `tool_result`, or `undefined` when no conversation matches or it has run
 * past its turns.
 *
 * @param {ReturnType<typeof parseModelScript>} script @param {readonly unknown[]} messages
 */
export function scriptedTurn(script, messages) {
  const conversation = conversationOf(script, messages);
  if (conversation === undefined) return undefined;
  const answered = messages.filter(
    (message) =>
      isRecord(message) &&
      message['role'] === 'user' &&
      blocksOf(message).some((block) => block?.type === 'tool_result'),
  ).length;
  return conversation.turns[answered];
}

/**
 * The offered tool a `tool` turn names: `tool` itself, or one ending in `__<tool>`.
 *
 * @param {readonly { name?: unknown }[]} tools @param {string} tool
 */
export function offeredTool(tools, tool) {
  return tools.find(
    (candidate) =>
      typeof candidate?.name === 'string' &&
      (candidate.name === tool || candidate.name.endsWith(`__${tool}`)),
  )?.name;
}

function readRaw(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

function parsed(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function send(response, stream, message, events) {
  if (!stream) {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(message));
    return;
  }
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  response.end(encodeSse(events));
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/giu;

/** The context the engine wraps in `<system-reminder>` and adds to a message of its own. */
const SYSTEM_REMINDER = /\s*<system-reminder>[\s\S]*?<\/system-reminder>\s*/gu;

/**
 * The text of a `tool_result` block: its string, or its text blocks joined, without the
 * `<system-reminder>` context the engine appends to a tool's output.
 */
function resultText(block) {
  const content = block?.content;
  const text =
    typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content.map((part) => (typeof part?.text === 'string' ? part.text : '')).join('')
        : '';
  return text.replace(SYSTEM_REMINDER, '');
}

/**
 * What the placeholders of a tool input resolve to in `messages`: the distinct UUIDs, in order, of
 * the first user message's text blocks that hold `when` (every text block when `when` is not
 * given), and the JSON object of the latest `tool_result` (`{}` when it is none). The engine opens
 * that message with context blocks of its own, such as its working directory, whose path holds
 * the workspace's and the session's ids: only the prompt's block names the records it is about.
 *
 * @param {readonly unknown[]} messages @param {string} [when]
 */
function placeholderSources(messages, when) {
  const users = messages.filter((message) => isRecord(message) && message['role'] === 'user');
  const opening = blocksOf(users[0])
    .map((block) => (typeof block?.text === 'string' ? block.text : ''))
    .filter((text) => when === undefined || text.includes(when))
    .join('\n');
  const uuids = [...new Set((opening.match(UUID) ?? []).map((id) => id.toLowerCase()))];
  const results = users.flatMap((message) =>
    blocksOf(message).filter((block) => block?.type === 'tool_result'),
  );
  const latest = results.length === 0 ? null : parsed(resultText(results.at(-1)));
  return { uuids, result: isRecord(latest) ? latest : {} };
}

/**
 * `value` with each placeholder resolved from `sources`, or `undefined` when one does not resolve.
 *
 * @param {unknown} value @param {ReturnType<typeof placeholderSources>} sources
 */
function resolvePlaceholders(value, sources) {
  if (typeof value === 'string') {
    const match = PLACEHOLDER.exec(value);
    if (match === null) return value;
    const [, index, key] = match;
    return index === undefined ? sources.result[key ?? ''] : sources.uuids[Number(index)];
  }
  if (Array.isArray(value)) {
    const items = value.map((item) => resolvePlaceholders(item, sources));
    return items.includes(undefined) ? undefined : items;
  }
  if (!isRecord(value)) return value;
  const entries = Object.entries(value).map(([key, item]) => [
    key,
    resolvePlaceholders(item, sources),
  ]);
  return entries.some(([, item]) => item === undefined) ? undefined : Object.fromEntries(entries);
}

/**
 * The answer a scripted turn gives a request offering `tools`: a `tool_use` or a text, or
 * `undefined` when the turn's tool is not offered or a placeholder of its input does not resolve
 * in `messages` (the base fake answers then).
 *
 * `when` is the conversation's: the prompt's ids are taken from the text that holds it.
 *
 * @param {ReturnType<typeof parseTurn>} turn @param {readonly { name?: unknown }[]} tools
 * @param {readonly unknown[]} [messages] @param {string} [when]
 * @returns {{ toolUse: { name: string, input: Record<string, unknown> } } | { text: string } | undefined}
 */
export function answerOf(turn, tools, messages = [], when = undefined) {
  if ('tool' in turn) {
    const name = offeredTool(tools, turn.tool);
    const input = resolvePlaceholders(turn.input, placeholderSources(messages, when));
    return name === undefined || !isRecord(input) ? undefined : { toolUse: { name, input } };
  }
  if ('text' in turn) return { text: turn.text };
  return offeredTool(tools, STRUCTURED_OUTPUT_TOOL) === STRUCTURED_OUTPUT_TOOL
    ? { toolUse: { name: STRUCTURED_OUTPUT_TOOL, input: turn.structured } }
    : { text: JSON.stringify(turn.structured) };
}

/**
 * The scripted handler. `requests` gets the base fake's record of every request; `scripted` one
 * `{ turn, toolNames }` per `POST /v1/messages` the script answered.
 *
 * @param {ReturnType<typeof parseModelScript>} script
 * @param {import('../generated-project/fake-anthropic.mjs').FakeRequestRecord[]} requests
 * @param {{ answer: unknown, toolNames: string[] }[]} [scripted]
 */
export function createScriptedModelHandler(script, requests, scripted = []) {
  const delegate = createAnthropicHandler(requests);
  let sequence = 0;
  return async (request, response) => {
    const url = new URL(request.url ?? '/', 'https://api.anthropic.com');
    if (request.method !== 'POST' || url.pathname !== '/v1/messages') {
      await delegate(request, response);
      return;
    }
    const raw = await readRaw(request);
    const body = parsed(raw);
    const tools = Array.isArray(body?.tools) ? body.tools : [];
    const messages = Array.isArray(body?.messages) ? body.messages : [];
    const turn = scriptedTurn(script, messages);
    const when = conversationOf(script, messages)?.when;
    const answer = turn === undefined ? undefined : answerOf(turn, tools, messages, when);
    if (answer !== undefined) {
      sequence += 1;
      const id = `msg_fake_script_${String(sequence).padStart(6, '0')}`;
      const model = typeof body?.model === 'string' ? body.model : (FAKE_MODELS[0] ?? 'fake');
      const stream = body?.stream === true;
      scripted.push({ answer, toolNames: tools.map((tool) => String(tool?.name)) });
      if ('toolUse' in answer) {
        const toolUse = { id: `toolu_fake_script_${String(sequence)}`, ...answer.toolUse };
        send(
          response,
          stream,
          toolUseResponse(id, model, toolUse),
          toolUseEvents(id, model, toolUse),
        );
        return;
      }
      send(
        response,
        stream,
        messageResponse(id, model, answer.text),
        messageStreamEvents(id, model, answer.text),
      );
      return;
    }
    // The body is read already, so the base fake gets it again from a stream of its own.
    const replay = Object.assign(Readable.from([Buffer.from(raw, 'utf8')]), {
      method: request.method,
      url: request.url,
      headers: request.headers,
    });
    await delegate(replay, response);
  };
}

/**
 * Serve `script` on `127.0.0.1`, on a free port: its base URL (`ANTHROPIC_BASE_URL`), a new fake
 * key (`ANTHROPIC_API_KEY`), what it answered, and `close()`.
 *
 * @param {ReturnType<typeof parseModelScript>} script
 */
export async function startFakeModel(script) {
  /** @type {import('../generated-project/fake-anthropic.mjs').FakeRequestRecord[]} */
  const requests = [];
  /** @type {{ answer: unknown, toolNames: string[] }[]} */
  const scripted = [];
  const handle = createScriptedModelHandler(script, requests, scripted);
  const server = createServer((request, response) => {
    handle(request, response).catch((error) => {
      console.error(error);
      if (!response.headersSent) response.writeHead(500).end();
      else response.destroy();
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return {
    baseUrl: `http://127.0.0.1:${String(port)}`,
    key: fakeModelKey(),
    requests,
    scripted,
    close: () => new Promise((resolve) => server.close(() => resolve(undefined))),
  };
}
