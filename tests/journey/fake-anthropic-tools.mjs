/**
 * The slice-2 exit test's fake model (S2-08, issue #550): the slice-1 fake Anthropic API
 * (`../generated-project/fake-anthropic.mjs`, unchanged) plus one tool turn. When the last user
 * message carries a nonce (`e2e-nonce-…`) and the request offers a tool whose name ends in
 * `__getOrderByOrderNumber` (C17), it answers `tool_use` for that tool, every required string
 * input set to the nonce. When the last user message carries the tool's `tool_result`, it answers
 * `Fake Anthropic reply to <nonce>: <result>`. Every other request gets the slice-1 reply, byte
 * for byte, so the slice-1 journey sees no change.
 *
 * Files turns (STO-407): when the user message carries `e2e-files-<id>` the fake cannot read the
 * sandbox, so it asks the CLI to: a `Read` of `in/<token>.txt` (the granted file), then a `Write` of
 * `outputs/out/<token>.md` holding the first line of that `tool_result`, then a final text turn.
 * Only `<cwd>/outputs/` is collected, so the file shows as `out/<token>.md` under the run's outputs.
 * Paths are absolute when the CLI's system prompt names its `Working directory:` (or `Primary working directory:`), else relative.
 * A Read that fails (`is_error`) ends in a text turn naming the failure, with no Write.
 *
 * Each `POST /v1/messages` also records what the Claude CLI offered (`toolNames`): a tool the
 * run's permissions deny is not offered, which is how the journey reads "Bash denied at compose".
 *
 * {@link createOrdersApi} is the loopback orders API the `orders` tool calls: it serves its own
 * OpenAPI document and records each call with its `authorization` header, which the journey
 * compares and never prints.
 */
import { Buffer } from 'node:buffer';
import { Readable } from 'node:stream';
import { URL } from 'node:url';

import {
  FAKE_MODELS,
  createAnthropicHandler,
  encodeSse,
  messageResponse,
  messageStreamEvents,
} from '../generated-project/fake-anthropic.mjs';

/** The operation the orders API exposes: 21 characters, inside C17's name bound. */
export const ORDER_OPERATION_ID = 'getOrderByOrderNumber';

/** What an order's answer carries, so the widget's reply can prove the tool's data reached it. */
export function orderNote(orderNumber) {
  return `order-data-${orderNumber}`;
}

const NONCE = /e2e-nonce-[a-z0-9]+/gu;
const FILES_NONCE = /e2e-files-[a-z0-9]+/gu;
const WORKING_DIRECTORY = /working directory: ([^\\"]+)/iu;
const TOOL_SUFFIX = `__${ORDER_OPERATION_ID}`;

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

/** The blocks of a message's content; a plain string is one text block. */
function blocksOf(message) {
  const content = message?.content;
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return Array.isArray(content) ? content : [];
}

/** The text of a `tool_result` block: a string, or its text blocks joined. */
function resultText(block) {
  if (typeof block.content === 'string') return block.content;
  return blocksOf(block)
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('');
}

/** The last nonce `value` mentions, or `null`. */
function lastNonce(value) {
  return (
    JSON.stringify(value ?? null)
      .match(NONCE)
      ?.at(-1) ?? null
  );
}

/** The text of the first line of a Read result, without the CLI's `cat -n` line-number prefix. */
function firstLine(text) {
  return (text.split(/\r?\n/u)[0] ?? '').replace(/^\s*\d+[\t→]/u, '');
}

/** The name of the `tool_use` block that `id` answers, searched through the assistant turns. */
function toolNameOf(messages, id) {
  for (const message of messages) {
    if (message?.role !== 'assistant') continue;
    const use = blocksOf(message).find((block) => block?.type === 'tool_use' && block.id === id);
    if (use !== undefined) return use.name;
  }
  return null;
}

/** The tool input: every required string property of the tool's `input_schema` set to `nonce`. */
function toolInput(tool, nonce) {
  const schema = tool.input_schema ?? {};
  const properties = schema.properties ?? {};
  const required = Array.isArray(schema.required) ? schema.required : [];
  return Object.fromEntries(
    required
      .filter((name) => properties[name]?.type === undefined || properties[name].type === 'string')
      .map((name) => [name, nonce]),
  );
}

function toolUseEvents(id, model, toolUse) {
  const json = JSON.stringify(toolUse.input);
  const middle = Math.ceil(json.length / 2);
  return [
    {
      type: 'message_start',
      message: {
        id,
        type: 'message',
        role: 'assistant',
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 12, output_tokens: 1 },
      },
    },
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: toolUse.id, name: toolUse.name, input: {} },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: json.slice(0, middle) },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: json.slice(middle) },
    },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'message_delta',
      delta: { stop_reason: 'tool_use', stop_sequence: null },
      usage: { output_tokens: 8 },
    },
    { type: 'message_stop' },
  ];
}

function toolUseResponse(id, model, toolUse) {
  return {
    id,
    type: 'message',
    role: 'assistant',
    model,
    content: [{ type: 'tool_use', id: toolUse.id, name: toolUse.name, input: toolUse.input }],
    stop_reason: 'tool_use',
    stop_sequence: null,
    usage: { input_tokens: 12, output_tokens: 8 },
  };
}

/**
 * The tool-calling handler. `requests` gets the slice-1 record of every request (the delegate
 * writes it, or this handler for a tool turn); `toolRequests` gets one
 * `{ nonce, toolNames, toolUse, toolResult }` per `POST /v1/messages`, and `bodies` (when given)
 * that request's raw body, which the journey's secret check reads.
 */
export function createAnthropicToolsHandler(requests, toolRequests, bodies = []) {
  const delegate = createAnthropicHandler(requests);
  let sequence = 0;
  return async (request, response) => {
    const url = new URL(request.url ?? '/', 'https://api.anthropic.com');
    if (request.method !== 'POST' || url.pathname !== '/v1/messages') {
      await delegate(request, response);
      return;
    }
    const raw = await readRaw(request);
    bodies.push(raw);
    const body = parsed(raw);
    const tools = Array.isArray(body?.tools) ? body.tools : [];
    const toolNames = tools.map((tool) => tool?.name).filter((name) => typeof name === 'string');
    const messages = Array.isArray(body?.messages) ? body.messages : [];
    const last = messages.at(-1);
    const blocks = last?.role === 'user' ? blocksOf(last) : [];
    const result = blocks.find((block) => block?.type === 'tool_result');
    const nonce = lastNonce(messages);
    const tool = tools.find((candidate) => candidate?.name?.endsWith(TOOL_SUFFIX));
    const askedNow = lastNonce(blocks) !== null;

    const model = typeof body?.model === 'string' ? body.model : FAKE_MODELS[0];
    const stream = body?.stream === true;
    const record = { nonce, toolNames, toolUse: null, toolResult: null };
    toolRequests.push(record);

    const files = JSON.stringify(messages).match(FILES_NONCE)?.at(-1) ?? null;
    if (files !== null) {
      const readTool = tools.some((candidate) => candidate?.name === 'Read');
      const resultOf = result === undefined ? null : toolNameOf(messages, result.tool_use_id);
      const cwd = JSON.stringify(body?.system ?? '')
        .match(WORKING_DIRECTORY)?.[1]
        ?.trim();
      const at = (path) => (cwd === undefined ? path : `${cwd.replace(/[/]$/u, '')}/${path}`);
      const outPath = `outputs/out/${files}.md`;
      let toolUse = null;
      let text = null;
      if (result === undefined && readTool) {
        toolUse = { name: 'Read', input: { file_path: at(`in/${files}.txt`) } };
      } else if (resultOf === 'Read') {
        record.toolResult = resultText(result);
        if (result.is_error === true) {
          text = `Fake Anthropic could not read in/${files}.txt: ${record.toolResult}`;
        } else {
          toolUse = {
            name: 'Write',
            input: {
              file_path: at(outPath),
              content: `${firstLine(record.toolResult)}\n`,
            },
          };
        }
      } else if (resultOf === 'Write') {
        text = `Fake Anthropic wrote ${outPath}`;
      }
      if (toolUse !== null || text !== null) {
        sequence += 1;
        const id = `msg_fake_tools_${String(sequence).padStart(6, '0')}`;
        if (toolUse !== null) {
          record.toolUse = { name: toolUse.name, input: toolUse.input };
          toolUse.id = `toolu_fake_${String(sequence)}`;
          send(
            response,
            stream,
            toolUseResponse(id, model, toolUse),
            toolUseEvents(id, model, toolUse),
          );
          return;
        }
        requests.push({
          at: new Date().toISOString(),
          method: 'POST',
          path: url.pathname,
          model,
          stream,
          reply: text,
          apiKey: request.headers['x-api-key'] ?? null,
        });
        send(
          response,
          stream,
          messageResponse(id, model, text),
          messageStreamEvents(id, model, text),
        );
        return;
      }
    }
    if (nonce !== null && result !== undefined) {
      record.toolResult = resultText(result);
      const text = `Fake Anthropic reply to ${nonce}: ${record.toolResult}`;
      requests.push({
        at: new Date().toISOString(),
        method: 'POST',
        path: url.pathname,
        model,
        stream,
        reply: text,
        apiKey: request.headers['x-api-key'] ?? null,
      });
      sequence += 1;
      const id = `msg_fake_tools_${String(sequence).padStart(6, '0')}`;
      send(
        response,
        stream,
        messageResponse(id, model, text),
        messageStreamEvents(id, model, text),
      );
      return;
    }
    if (nonce !== null && askedNow && tool !== undefined) {
      sequence += 1;
      const id = `msg_fake_tools_${String(sequence).padStart(6, '0')}`;
      const toolUse = {
        id: `toolu_fake_${String(sequence)}`,
        name: tool.name,
        input: toolInput(tool, nonce),
      };
      record.toolUse = { name: toolUse.name, input: toolUse.input };
      send(
        response,
        stream,
        toolUseResponse(id, model, toolUse),
        toolUseEvents(id, model, toolUse),
      );
      return;
    }
    // ponytail: body re-fed to the slice-1 handler to avoid a copy; upgrade: export a body-taking
    // handler from fake-anthropic.mjs when it may change
    const replay = Object.assign(Readable.from([Buffer.from(raw, 'utf8')]), {
      method: request.method,
      url: request.url,
      headers: request.headers,
    });
    await delegate(replay, response);
  };
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

/**
 * The orders API's OpenAPI 3.1 document, its one server at `origin`: a single `GET` operation, as
 * a real read-only API declares, which setup's `allow: ['GET /**']` admits.
 */
function ordersDocument(origin) {
  return {
    openapi: '3.1.0',
    info: { title: 'Orders', version: '1.0.0' },
    servers: [{ url: origin }],
    components: { securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } } },
    security: [{ bearer: [] }],
    paths: {
      '/orders/{orderNumber}': {
        get: {
          operationId: ORDER_OPERATION_ID,
          summary: 'Look up one order by its number',
          parameters: [
            { name: 'orderNumber', in: 'path', required: true, schema: { type: 'string' } },
          ],
          responses: {
            200: {
              description: 'The order',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: { orderNumber: { type: 'string' }, note: { type: 'string' } },
                  },
                },
              },
            },
          },
        },
      },
    },
  };
}

/**
 * The loopback orders API: `GET /openapi.json` serves {@link ordersDocument} for the origin the
 * request reached, and `GET /orders/<n>` records `{ method, path, authorization }` into `calls`
 * and answers `{ orderNumber, note }`. Anything else is `404`.
 */
export function createOrdersApi(calls) {
  const handler = (request, response) => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`);
    const json = (status, value) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(value));
    };
    if (request.method === 'GET' && url.pathname === '/openapi.json') {
      json(200, ordersDocument(url.origin));
      return;
    }
    // A nonce is `[a-z0-9-]`, so the segment is the order number as it was sent.
    const orderNumber = /^\/orders\/([A-Za-z0-9_-]+)$/u.exec(url.pathname)?.[1];
    if (request.method === 'GET' && orderNumber !== undefined) {
      calls.push({
        method: request.method,
        path: url.pathname,
        authorization: request.headers.authorization ?? null,
      });
      json(200, { orderNumber, note: orderNote(orderNumber) });
      return;
    }
    if (request.method === 'HEAD' && orderNumber !== undefined) {
      response.writeHead(200);
      response.end();
      return;
    }
    json(404, { error: 'not_found' });
  };
  return { handler, document: (origin) => `${JSON.stringify(ordersDocument(origin), null, 2)}\n` };
}
