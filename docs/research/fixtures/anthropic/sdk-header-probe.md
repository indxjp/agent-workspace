# SDK header probe — executed 2026-09-03

The only **executed** probe behind R-03. Everything else in that note is a documentation quote or a
read of a shipped `.d.ts` / bundle. This one ran code and recorded what actually went over a socket.

## What it establishes

* the default `baseURL` when `ANTHROPIC_BASE_URL` is unset
* that `ANTHROPIC_BASE_URL` sets `baseURL`, and that a trailing slash does not double the path separator
* the exact header set the TypeScript SDK emits, including `anthropic-version`, `user-agent` and `accept`
* that `x-api-key` and `authorization` are **both** sent when both env vars are set
* the exact error thrown when no credential resolves

## What it does NOT establish

No real API was contacted — the server is a local stub returning a canned 200. Nothing here says
anything about response bodies, SSE framing, status codes, response headers, retries, redirects or
timeouts. One SDK (`@anthropic-ai/sdk@0.123.0`), one runtime (Node v24.19.0), one OS
(Windows 11, MINGW64_NT-10.0-26200), plain HTTP on `127.0.0.1`. **Claude Code's own user-agent was
never observed and will differ from the TypeScript SDK's.**

## Script

```js
// probe.mjs — run with: npm i @anthropic-ai/sdk@0.123.0 && node probe.mjs
import http from 'node:http';
import Anthropic from '@anthropic-ai/sdk';

const captured = [];
const server = http.createServer((req, res) => {
  captured.push({ method: req.method, url: req.url, headers: req.headers });
  res.writeHead(200, {'content-type':'application/json'});
  res.end(JSON.stringify({id:'msg_x',type:'message',role:'assistant',model:'m',content:[],
    stop_reason:'end_turn',stop_sequence:null,usage:{input_tokens:1,output_tokens:1}}));
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

delete process.env.ANTHROPIC_BASE_URL;
console.log('DEFAULT_BASE_URL =', new Anthropic({ apiKey: 'k' }).baseURL);

process.env.ANTHROPIC_BASE_URL  = `http://127.0.0.1:${port}`;
process.env.ANTHROPIC_API_KEY   = 'sk-test-apikey';
process.env.ANTHROPIC_AUTH_TOKEN = 'tok-test-authtoken';
const c = new Anthropic();
console.log('ENV_BASE_URL =', c.baseURL);
await c.messages.create({model:'claude-opus-5', max_tokens:1, messages:[{role:'user',content:'hi'}]});
await c.messages.countTokens({model:'claude-opus-5', messages:[{role:'user',content:'hi'}]});

// trailing-slash base URL
process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${port}/`;
await new Anthropic().messages.create({model:'claude-opus-5', max_tokens:1,
  messages:[{role:'user',content:'hi'}]});

// no credential at all
delete process.env.ANTHROPIC_API_KEY; delete process.env.ANTHROPIC_AUTH_TOKEN;
try { await new Anthropic().messages.create({model:'m',max_tokens:1,
        messages:[{role:'user',content:'hi'}]}); }
catch (e) { console.log('NO_CREDENTIAL =', e.constructor.name + ': ' + e.message); }

for (const c of captured) {
  console.log(`\n${c.method} ${c.url}`);
  for (const k of ['host','x-api-key','authorization','anthropic-version','content-type',
                   'user-agent','accept'])
    if (c.headers[k] !== undefined) console.log(`   ${k}: ${c.headers[k]}`);
}
server.close();
```

## Raw output

```text
DEFAULT_BASE_URL = https://api.anthropic.com
ENV_BASE_URL = http://127.0.0.1:62694
NO_CREDENTIAL = Error: Could not resolve authentication method. Expected one of apiKey, authToken, credentials, config, or profile to be set. Or for one of the "X-Api-Key" or "Authorization" headers to be explicitly omitted

POST /v1/messages
   host: 127.0.0.1:62694
   x-api-key: sk-test-apikey
   authorization: Bearer tok-test-authtoken
   anthropic-version: 2023-06-01
   content-type: application/json
   user-agent: Anthropic/JS 0.123.0
   accept: application/json

POST /v1/messages/count_tokens
   host: 127.0.0.1:62694
   x-api-key: sk-test-apikey
   authorization: Bearer tok-test-authtoken
   anthropic-version: 2023-06-01
   content-type: application/json
   user-agent: Anthropic/JS 0.123.0
   accept: application/json

POST /v1/messages
   host: 127.0.0.1:62694
   x-api-key: sk-test-apikey
   authorization: Bearer tok-test-authtoken
   anthropic-version: 2023-06-01
   content-type: application/json
   user-agent: Anthropic/JS 0.123.0
   accept: application/json
```

The third request is the trailing-slash base URL: the path is `POST /v1/messages`, not
`POST //v1/messages`, so the join is single-slash and both base-URL forms work.
