# R-04 executed-probe capture — OpenAI Responses API wire behavior

An **inert capture**: the exact script that was run, followed by its complete raw output, copied
from the run rather than retyped. Companion to the R-04 research note (maintained privately);
see [`README.md`](README.md) for why this is a fenced block in Markdown and not a tracked `.mjs`.

Run on 2026-09-05 against `openai@7.10.0` on Windows 11, Node v24.19.0.

**Part A reaches the real `https://api.openai.com`** with a deliberately invalid API key. That is
the point of it: an error envelope's shape has to come from the vendor or from a real error, never
from a body the probe's own author wrote. No credentials are used and no tokens are generated —
the request is rejected at authentication. **Part B is a loopback stub** and establishes only two
things: what the *client* puts on the wire, and how the *client* parses framing it is handed. It
cannot establish what OpenAI's server sends, and nothing in the note is graded on it as if it could.

## The script

```js
// R-04 probe — OpenAI Responses API wire behavior, against `openai@7.10.0`.
//
//   mkdir probe-r04 && cd probe-r04
//   npm init -y && npm install openai@7.10.0
//   node sdk-probe.mjs
//
// Part A reaches the REAL https://api.openai.com with a deliberately invalid key. It needs no
// credentials and generates no tokens; its purpose is to capture OpenAI's own error envelope
// rather than one this script authored. Round 1 of this note hand-wrote a 429 body in the stub
// below and then cited the round-trip as evidence of the envelope's shape, which proved only
// that the stub's own literal survives JSON.parse. Part A is the replacement.
//
// Part B is a loopback stub standing in for api.openai.com: it establishes what the CLIENT
// sends and how the client PARSES framing it is given. It cannot establish what OpenAI's server
// sends, and nothing derived from it is graded above "what the SDK does with these bytes".
import http from 'node:http';
import https from 'node:https';
import OpenAI, { APIError } from 'openai';

const PORT = 41941;
const line = (s) => console.log(s);
const hr = (s) => { console.log(''); console.log(`===== ${s} =====`); };

// --------------------------- Part A - the real endpoint ---------------------------

function rawPost() {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ model: 'gpt-5.6', input: 'probe' });
    const req = https.request(
      { host: 'api.openai.com', path: '/v1/responses', method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer sk-invalid-key-for-probe',
                   'content-length': Buffer.byteLength(body) } },
      (res) => { let text = ''; res.on('data', (c) => { text += c; });
                 res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text })); },
    );
    req.on('error', reject);
    req.end(body);
  });
}

async function partA() {
  hr('A1 - REAL api.openai.com, invalid key: the raw HTTP error envelope');
  let raw;
  try {
    raw = await rawPost();
  } catch (e) {
    line(`network attempt FAILED: ${e.constructor.name}: ${e.message}`);
    line('(the envelope below is therefore unestablished; do not substitute a hand-written body)');
    return;
  }
  line(`HTTP status: ${raw.status}`);
  line(`content-type: ${raw.headers['content-type']}`);
  line(`x-request-id present: ${Boolean(raw.headers['x-request-id'])}`);
  line(`response header names: ${Object.keys(raw.headers).sort().join(', ')}`);
  line('raw body, verbatim:');
  line(raw.text);
  line('parsed top-level keys: ' + JSON.stringify(Object.keys(JSON.parse(raw.text)).sort()));
  line('parsed error keys:     ' + JSON.stringify(Object.keys(JSON.parse(raw.text).error).sort()));

  hr('A2 - REAL api.openai.com, invalid key, through the SDK: exception mapping');
  const live = new OpenAI({ apiKey: 'sk-invalid-key-for-probe', maxRetries: 0 });
  try {
    await live.responses.create({ model: 'gpt-5.6', input: 'probe' });
    line('UNEXPECTED: the call succeeded');
  } catch (e) {
    line(JSON.stringify({
      ctor: e.constructor.name, isAPIError: e instanceof APIError, status: e.status,
      type: e.type, code: e.code, param: e.param, message: e.message,
      requestID: typeof e.requestID === 'string' ? '(present)' : e.requestID,
      errorKeys: e.error ? Object.keys(e.error).sort() : null,
    }, null, 2));
  }
}

// --------------------------- Part B - the loopback stub ---------------------------

const sse = (frames) => frames.map((f) => (f.event ? `event: ${f.event}\n` : '') + `data: ${f.data}\n\n`).join('');
const ev = (o) => JSON.stringify(o);

/** Every scripted stream this probe serves, by the `x-probe-case` header the client sends. */
const CASES = {
  // B2/B3 share these payloads so the only variable between them is the `event:` line.
  happy: [
    { data: ev({ type: 'response.created', sequence_number: 0, response: { id: 'resp_1', status: 'in_progress' } }) },
    { data: ev({ type: 'response.output_item.added', sequence_number: 1, output_index: 0, item: { id: 'msg_1', type: 'message', role: 'assistant', status: 'in_progress', content: [] } }) },
    { data: ev({ type: 'response.content_part.added', sequence_number: 2, item_id: 'msg_1', output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } }) },
    { data: ev({ type: 'response.output_text.delta', sequence_number: 3, item_id: 'msg_1', output_index: 0, content_index: 0, delta: 'Hi', logprobs: [] }) },
    { data: ev({ type: 'response.output_text.done', sequence_number: 4, item_id: 'msg_1', output_index: 0, content_index: 0, text: 'Hi', logprobs: [] }) },
    { data: ev({ type: 'response.content_part.done', sequence_number: 5, item_id: 'msg_1', output_index: 0, content_index: 0, part: { type: 'output_text', text: 'Hi', annotations: [] } }) },
    { data: ev({ type: 'response.output_item.done', sequence_number: 6, output_index: 0, item: { id: 'msg_1', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Hi', annotations: [] }] } }) },
    { data: ev({ type: 'response.completed', sequence_number: 7, response: { id: 'resp_1', status: 'completed', usage: { input_tokens: 11, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 }, output_tokens: 2, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 13 } } }) },
  ],
};
// The `error`-typed payload of the Responses stream union, exactly as ResponseErrorEvent declares
// it: `{ code, message, param, sequence_number, type: 'error' }` - note it has NO top-level
// `error` key of its own, which matters for which of streaming.js's two throw branches fires.
const ERROR_FRAME = ev({ type: 'error', code: 'server_error', message: 'boom', param: null, sequence_number: 1 });
CASES.eventFramed = CASES.happy.map((f) => ({ event: JSON.parse(f.data).type, data: f.data }));
CASES.errorEventFramed = [CASES.happy[0], { event: 'error', data: ERROR_FRAME }, CASES.happy[7]];
CASES.errorDataOnly = [CASES.happy[0], { data: ERROR_FRAME }, CASES.happy[7]];
CASES.doneSentinel = [CASES.happy[0], { data: '[DONE]' }, CASES.happy[7]];
CASES.responseFailed = [CASES.happy[0], { data: ev({ type: 'response.failed', sequence_number: 1, response: { id: 'resp_1', status: 'failed', error: { code: 'server_error', message: 'boom' } } }) }];
CASES.topLevelErrorKey = [CASES.happy[0], { data: ev({ error: { message: 'boom', type: 'server_error', code: null, param: null } }) }];

let captured = null;
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const probeCase = req.headers['x-probe-case'];
    if (!probeCase) {
      captured = { method: req.method, url: req.url, headers: { ...req.headers }, body };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'resp_1', object: 'response', status: 'completed', model: 'gpt-5.6',
        output: [{ id: 'msg_1', type: 'message', role: 'assistant', status: 'completed',
                   content: [{ type: 'output_text', text: 'Hi', annotations: [] }] }],
        usage: { input_tokens: 11, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
                 output_tokens: 2, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 13 } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(sse(CASES[probeCase]));
  });
});

async function drain(label, probeCase) {
  const client = new OpenAI({ apiKey: 'sk-stub-key', baseURL: `http://127.0.0.1:${PORT}/v1`, maxRetries: 0,
    defaultHeaders: { 'x-probe-case': probeCase } });
  const yielded = [];
  let thrown = null;
  try {
    const stream = await client.responses.create({ model: 'gpt-5.6', input: 'hi', stream: true });
    for await (const event of stream) yielded.push(event.type);
  } catch (e) {
    thrown = { ctor: e.constructor.name, isAPIError: e instanceof APIError, message: e.message,
               status: e.status ?? null, code: e.code ?? null };
  }
  line(`${label}`);
  line(`  yielded: ${JSON.stringify(yielded)}`);
  line(`  thrown:  ${thrown ? JSON.stringify(thrown) : 'null'}`);
}

async function partB() {
  hr('B1 - what the client SENDS: full request capture, non-streaming');
  const client = new OpenAI({ apiKey: 'sk-stub-key', organization: 'org-stub', project: 'proj-stub',
    baseURL: `http://127.0.0.1:${PORT}/v1`, maxRetries: 0 });
  await client.responses.create({
    model: 'gpt-5.6',
    instructions: 'You are terse.',
    input: [
      { role: 'user', content: [{ type: 'input_text', text: 'weather in Paris?' }] },
      { type: 'function_call', call_id: 'call_abc', name: 'get_weather', arguments: '{"city":"Paris"}' },
      { type: 'function_call_output', call_id: 'call_abc', output: 'rain, 11C' },
    ],
    tools: [{ type: 'function', name: 'get_weather', description: 'Current weather.', strict: true,
              parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'],
                            additionalProperties: false } }],
  });
  line(`request line: ${captured.method} ${captured.url}`);
  line(`header count: ${Object.keys(captured.headers).length}`);
  line('ALL request headers, every one the server received, sorted by name:');
  for (const k of Object.keys(captured.headers).sort()) line(`${k}: ${captured.headers[k]}`);
  line('request body:');
  line(JSON.stringify(JSON.parse(captured.body), null, 2));

  hr('B2-B8 - what the client PARSES: one line per framing variant');
  await drain('B2 data-only frames, happy path (no `event:` line anywhere)', 'happy');
  await drain('B3 identical payloads, each frame ALSO carrying `event: <type>`', 'eventFramed');
  await drain('B4 `event: error` + a ResponseErrorEvent payload', 'errorEventFramed');
  await drain('B5 the SAME payload with the `event:` line removed', 'errorDataOnly');
  await drain('B6 `data: [DONE]` between response.created and response.completed', 'doneSentinel');
  await drain('B7 a data-only `response.failed` event', 'responseFailed');
  await drain('B8 a data-only frame whose JSON has a top-level `error` key', 'topLevelErrorKey');
}

server.listen(PORT, '127.0.0.1', async () => {
  try {
    await partA();
    await partB();
  } finally {
    server.close();
  }
});
```

## The output, verbatim

```text

===== A1 - REAL api.openai.com, invalid key: the raw HTTP error envelope =====
HTTP status: 401
content-type: text/plain
x-request-id present: true
response header names: access-control-expose-headers, alt-svc, cf-cache-status, cf-ray, connection, content-length, content-type, date, server, set-cookie, strict-transport-security, x-content-type-options, x-error-json, x-openai-authorization-error, x-openai-ide-error-code, x-openai-internal-caller, x-request-id
raw body, verbatim:
{
  "error": {
    "message": "Incorrect API key provided: sk-inval************robe. You can find your API key at https://platform.openai.com/account/api-keys.",
    "type": "invalid_request_error",
    "code": "invalid_api_key",
    "param": null
  },
  "status": 401
}
parsed top-level keys: ["error","status"]
parsed error keys:     ["code","message","param","type"]

===== A2 - REAL api.openai.com, invalid key, through the SDK: exception mapping =====
{
  "ctor": "AuthenticationError",
  "isAPIError": true,
  "status": 401,
  "type": "invalid_request_error",
  "code": "invalid_api_key",
  "param": null,
  "message": "401 Incorrect API key provided: sk-inval************robe. You can find your API key at https://platform.openai.com/account/api-keys.",
  "requestID": "(present)",
  "errorKeys": [
    "code",
    "message",
    "param",
    "type"
  ]
}

===== B1 - what the client SENDS: full request capture, non-streaming =====
request line: POST /v1/responses
header count: 19
ALL request headers, every one the server received, sorted by name:
accept: application/json
accept-encoding: gzip, deflate
accept-language: *
authorization: Bearer sk-stub-key
connection: keep-alive
content-length: 532
content-type: application/json
host: 127.0.0.1:41941
openai-organization: org-stub
openai-project: proj-stub
sec-fetch-mode: cors
user-agent: OpenAI/JS 7.10.0
x-stainless-arch: x64
x-stainless-lang: js
x-stainless-os: Windows
x-stainless-package-version: 7.10.0
x-stainless-retry-count: 0
x-stainless-runtime: node
x-stainless-runtime-version: v24.19.0
request body:
{
  "model": "gpt-5.6",
  "instructions": "You are terse.",
  "input": [
    {
      "role": "user",
      "content": [
        {
          "type": "input_text",
          "text": "weather in Paris?"
        }
      ]
    },
    {
      "type": "function_call",
      "call_id": "call_abc",
      "name": "get_weather",
      "arguments": "{\"city\":\"Paris\"}"
    },
    {
      "type": "function_call_output",
      "call_id": "call_abc",
      "output": "rain, 11C"
    }
  ],
  "tools": [
    {
      "type": "function",
      "name": "get_weather",
      "description": "Current weather.",
      "strict": true,
      "parameters": {
        "type": "object",
        "properties": {
          "city": {
            "type": "string"
          }
        },
        "required": [
          "city"
        ],
        "additionalProperties": false
      }
    }
  ]
}

===== B2-B8 - what the client PARSES: one line per framing variant =====
B2 data-only frames, happy path (no `event:` line anywhere)
  yielded: ["response.created","response.output_item.added","response.content_part.added","response.output_text.delta","response.output_text.done","response.content_part.done","response.output_item.done","response.completed"]
  thrown:  null
B3 identical payloads, each frame ALSO carrying `event: <type>`
  yielded: ["response.created","response.output_item.added","response.content_part.added","response.output_text.delta","response.output_text.done","response.content_part.done","response.output_item.done","response.completed"]
  thrown:  null
B4 `event: error` + a ResponseErrorEvent payload
  yielded: ["response.created"]
  thrown:  {"ctor":"APIError","isAPIError":true,"message":"boom","status":null,"code":"server_error"}
B5 the SAME payload with the `event:` line removed
  yielded: ["response.created","error","response.completed"]
  thrown:  null
B6 `data: [DONE]` between response.created and response.completed
  yielded: ["response.created"]
  thrown:  null
B7 a data-only `response.failed` event
  yielded: ["response.created","response.failed"]
  thrown:  null
B8 a data-only frame whose JSON has a top-level `error` key
  yielded: ["response.created"]
  thrown:  {"ctor":"APIError","isAPIError":true,"message":"boom","status":null,"code":null}
```

## Reproducing

```sh
mkdir probe-r04 && cd probe-r04
npm init -y
npm install openai@7.10.0
node sdk-probe.mjs
```

Non-deterministic bytes, and there are only these: Part A's `message` embeds the masked form of
whatever invalid key is sent and its `set-cookie`/`cf-ray`/`date`/`x-request-id` response headers
differ per request (the script prints header *names*, not values, for that reason); Part B's
`host:` header carries the fixed loopback port `41941`, so a machine already using that port must
change `PORT` in one place. Every other line reproduces exactly.
