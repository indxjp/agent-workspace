// R-06 probe — the two authorization outcomes the MCP authorization spec separates (401
// "token invalid" vs 403 "insufficient scope"), and the case the connector wizard's
// "Authentication: None" option produces: an OAuth-protected server contacted with no
// Authorization header at all.
//
// Run half against @modelcontextprotocol/sdk (free) and half against the Agent SDK (one live
// model call, costs money) so both candidate implementations of Test Connection are covered.
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import fs from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { query } from '@anthropic-ai/claude-agent-sdk';

const PORT = 8961;
const TOKEN = 's3cret';
const LOG = 'authz-wire.jsonl';
if (fs.existsSync(LOG)) fs.unlinkSync(LOG);
const srv = spawn(process.execPath, ['server-http.mjs', '--port', String(PORT), '--token', TOKEN, '--log', LOG], {
  stdio: ['ignore', 'ignore', 'ignore'],
});
await sleep(800);

const describe = (e) => ({
  ctor: e?.constructor?.name,
  message: String(e?.message),
  code: e?.code ?? null,
  causeCode: e?.cause?.code ?? null,
});

async function mcpSdk(label, path, headers) {
  const c = new Client({ name: 'r06-probe', version: '0.0.1' }, { capabilities: {} });
  try {
    await c.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PORT}${path}`), { requestInit: { headers } }),
      { timeout: 4000 },
    );
    console.log(`[mcp-sdk] ${label}: connected`);
    await c.close();
  } catch (e) {
    console.log(`[mcp-sdk] ${label}: ${JSON.stringify(describe(e))}`);
    try {
      await c.close();
    } catch {}
  }
}

console.log('== @modelcontextprotocol/sdk ==');
await mcpSdk('401-invalid-token', '/mcp', { Authorization: 'Bearer WRONG' });
await mcpSdk('401-no-header-at-all', '/mcp', {});
await mcpSdk('403-insufficient-scope', '/forbidden', { Authorization: `Bearer ${TOKEN}` });
await mcpSdk('500-html-error-page', '/500', { Authorization: `Bearer ${TOKEN}` });

console.log('\n== @anthropic-ai/claude-agent-sdk ==');
let releasePrompt;
const held = new Promise((r) => (releasePrompt = r));
async function* prompt() {
  yield { type: 'user', message: { role: 'user', content: 'Reply with the single word: ok' } };
  await held;
}
const q = query({
  prompt: prompt(),
  options: {
    model: 'claude-haiku-4-5',
    maxTurns: 1,
    strictMcpConfig: true,
    settingSources: [],
    allowedTools: [],
    mcpServers: {
      oauth_no_header: { type: 'http', url: `http://127.0.0.1:${PORT}/mcp` },
      invalid_token: { type: 'http', url: `http://127.0.0.1:${PORT}/mcp`, headers: { Authorization: 'Bearer WRONG' } },
      forbidden_403: { type: 'http', url: `http://127.0.0.1:${PORT}/forbidden`, headers: { Authorization: `Bearer ${TOKEN}` } },
      html_500: { type: 'http', url: `http://127.0.0.1:${PORT}/500`, headers: { Authorization: `Bearer ${TOKEN}` } },
      good: { type: 'http', url: `http://127.0.0.1:${PORT}/mcp`, headers: { Authorization: `Bearer ${TOKEN}` } },
    },
  },
});
for await (const m of q) {
  if (m.type === 'system' && m.subtype === 'init') {
    const s = await q.mcpServerStatus();
    console.log(JSON.stringify(s.map(({ name, status, error }) => ({ name, status, error })), null, 2));
  }
  if (m.type === 'result') {
    releasePrompt();
    break;
  }
}
srv.kill();

console.log('\n== requests the Agent SDK made ==');
// Every record in the log gets a verdict here rather than only the ones this section wants.
// `request` is printed; `response` is the server's own half of the exchange and is deliberately
// not part of a request listing; anything else is a record shape this replay was not written for,
// and it stops rather than dropping it — `server-sse.mjs` already logs a third kind
// (`blackhole-client-gave-up`), so pointing `--log` at a different server is a real way to reach
// this branch.
for (const line of fs.readFileSync(LOG, 'utf8').trim().split('\n')) {
  const r = JSON.parse(line);
  if (r.kind === 'response') continue; // the server's own half of the exchange, not a request
  if (r.kind === 'request') {
    console.log(`${r.method} ${r.url} auth=${r.headers.authorization ?? '(none)'} body=${String(r.body).slice(0, 70)}`);
    continue;
  }
  console.error(`UNCLASSIFIED log record kind "${r.kind}" — this replay would have dropped it: ${line.slice(0, 200)}`);
  process.exit(3);
}
process.exit(0);
