#!/usr/bin/env node
/* global console */
/**
 * A fake Anthropic API for the generated-project E2E (`run.mjs`): just enough of `/v1/models`,
 * `/v1/messages` (streaming and not) and `/v1/messages/count_tokens` for the setup wizard's probe
 * and model discovery, and for the claude-agent-sdk engine to finish a turn through the gateway.
 * No real model and no real key are ever involved.
 *
 * It runs as a service of the generated Compose project (the override `project.mjs` writes), on
 * the `provider-egress` network the gateway leaves through and on `web-ingress`, which carries the
 * web service's outbound calls. On both networks it answers to the alias `api.anthropic.com`, and it
 * serves TLS with a certificate for that name signed by a CA the test generated, so the web and
 * gateway containers reach it exactly as they reach Anthropic: the provider default base URL, HTTPS,
 * and the egress policy, with `EGRESS_ALLOW_HOSTS=api.anthropic.com` as the one exemption.
 *
 * Every reply names the nonce of the prompt it answers (`e2e-nonce-…`), so a test can tell its
 * own reply from any other. A second, plain-HTTP port serves `/healthz` and `/requests` (what was
 * asked, never a header but `x-api-key`) to the test. A key starting with `REJECTED_KEY_PREFIX`
 * is refused with `401`, as Anthropic refuses a wrong key.
 *
 *   FAKE_ANTHROPIC_TLS_CERT=… FAKE_ANTHROPIC_TLS_KEY=… node fake-anthropic.mjs
 */
import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import process from 'node:process';
import { pathToFileURL, URL } from 'node:url';

/** The models `/v1/models` lists: the setup wizard requires `claude-sonnet-4-5` (ADR-0030). */
export const FAKE_MODELS = ['claude-sonnet-4-5', 'claude-haiku-4-5'];

/**
 * Every key that starts with this is refused with Anthropic's `401 authentication_error`, and every
 * other key is accepted: the E2E's "wrong key, then right key" setup (issue #415) needs one of each.
 */
export const REJECTED_KEY_PREFIX = 'sk-ant-e2e-rejected-';

/** The marker a prompt carries so that its reply can be recognised. */
const NONCE = /e2e-nonce-[a-z0-9]+/u;

/** The reply text for a request body: it names the last nonce the body mentions, if any. */
export function fakeReplyText(body) {
  const nonces = JSON.stringify(body ?? null).match(new RegExp(NONCE.source, 'gu')) ?? [];
  const nonce = nonces.at(-1);
  return nonce === undefined
    ? 'Fake Anthropic reply.'
    : `Fake Anthropic reply to ${nonce}: the generated project answered.`;
}

/** `GET /v1/models`, in the shape the gateway's Anthropic adapter validates. */
export function modelList() {
  const data = FAKE_MODELS.map((id) => ({
    type: 'model',
    id,
    display_name: id,
    created_at: '2026-01-01T00:00:00Z',
  }));
  return { data, has_more: false, first_id: data[0]?.id ?? null, last_id: data.at(-1)?.id ?? null };
}

function usage(text) {
  return { input_tokens: 12, output_tokens: Math.max(1, text.split(/\s+/u).length) };
}

/** A non-streaming `POST /v1/messages` answer. */
export function messageResponse(id, model, text) {
  return {
    id,
    type: 'message',
    role: 'assistant',
    model,
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: usage(text),
  };
}

/**
 * The events of a streaming `POST /v1/messages` answer, in Anthropic's order
 * (docs/research/fixtures/anthropic/stream-basic.json): the text arrives in two deltas so that a
 * consumer which kept only the first or the last delta would be caught.
 */
export function messageStreamEvents(id, model, text) {
  const middle = Math.ceil(text.length / 2);
  const { input_tokens, output_tokens } = usage(text);
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
        usage: { input_tokens, output_tokens: 1 },
      },
    },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'ping' },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: text.slice(0, middle) },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: text.slice(middle) },
    },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens },
    },
    { type: 'message_stop' },
  ];
}

/** Server-sent-event framing: `event: <type>` and one compact `data:` line, no terminator. */
export function encodeSse(events) {
  return events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
}

const MAX_BODY_BYTES = 8 * 1024 * 1024;

function readBody(request) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

/** The request's JSON body: `null` when there is none, `undefined` when it is not JSON. */
function parseJsonBody(raw) {
  if (raw === '') return null;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function sendJson(response, status, value) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(value));
}

/**
 * The Anthropic-shaped request handler. `requests` collects one record per request: method, path,
 * model, whether it streamed, the nonce it answered and whether an `x-api-key` came with it.
 */
export function createAnthropicHandler(requests) {
  let sequence = 0;
  return async (request, response) => {
    const url = new URL(request.url ?? '/', 'https://api.anthropic.com');
    const raw = request.method === 'POST' ? await readBody(request) : '';
    const body = parseJsonBody(raw);
    if (body === undefined) {
      sendJson(response, 400, { type: 'error', error: { type: 'invalid_request_error' } });
      return;
    }
    const model = typeof body?.model === 'string' ? body.model : null;
    const stream = body?.stream === true;
    // The system prompt (the agent's instructions) first: a nonce in the messages always wins, and
    // a prompt with none is answered with the instructions' (the pinned-version journey, #612).
    const text = fakeReplyText([body?.system ?? null, body?.messages ?? null]);
    requests.push({
      at: new Date().toISOString(),
      method: request.method ?? 'GET',
      path: url.pathname,
      model,
      stream,
      reply: url.pathname === '/v1/messages' ? text : null,
      apiKey: request.headers['x-api-key'] ?? null,
    });
    const apiKey = request.headers['x-api-key'];
    if (typeof apiKey === 'string' && apiKey.startsWith(REJECTED_KEY_PREFIX)) {
      sendJson(response, 401, {
        type: 'error',
        error: { type: 'authentication_error', message: 'invalid x-api-key' },
      });
      return;
    }
    if (request.method === 'GET' && url.pathname === '/v1/models') {
      sendJson(response, 200, modelList());
      return;
    }
    if (request.method === 'POST' && url.pathname === '/v1/messages/count_tokens') {
      sendJson(response, 200, { input_tokens: 12 });
      return;
    }
    if (request.method === 'POST' && url.pathname === '/v1/messages') {
      sequence += 1;
      const id = `msg_fake_${String(sequence).padStart(6, '0')}`;
      const answered = model ?? FAKE_MODELS[0];
      if (!stream) {
        sendJson(response, 200, messageResponse(id, answered, text));
        return;
      }
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      response.end(encodeSse(messageStreamEvents(id, answered, text)));
      return;
    }
    sendJson(response, 404, { type: 'error', error: { type: 'not_found_error' } });
  };
}

async function main() {
  const requests = [];
  const handle = createAnthropicHandler(requests);
  const tls = {
    cert: readFileSync(process.env['FAKE_ANTHROPIC_TLS_CERT'] ?? '/e2e/api.anthropic.com.pem'),
    key: readFileSync(process.env['FAKE_ANTHROPIC_TLS_KEY'] ?? '/e2e/api.anthropic.com.key'),
  };
  const api = createHttpsServer(tls, (request, response) => {
    handle(request, response).catch((error) => {
      console.error(error);
      if (!response.headersSent) sendJson(response, 500, { type: 'error' });
      else response.destroy();
    });
  });
  const control = createHttpServer((request, response) => {
    if (request.url === '/healthz') sendJson(response, 200, { ok: true });
    else if (request.url === '/requests') sendJson(response, 200, { requests });
    else sendJson(response, 404, { error: 'not_found' });
  });
  const apiPort = Number(process.env['FAKE_ANTHROPIC_PORT'] ?? '443');
  const controlPort = Number(process.env['FAKE_ANTHROPIC_CONTROL_PORT'] ?? '8081');
  await new Promise((resolve) => api.listen(apiPort, '0.0.0.0', resolve));
  await new Promise((resolve) => control.listen(controlPort, '0.0.0.0', resolve));
  console.log(`fake Anthropic API on :${String(apiPort)}, control on :${String(controlPort)}`);
  const stop = () => {
    api.close();
    control.close();
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
