// R-06 probe — transport mis-selection, which is the most likely mistake in spec §8's wizard:
// the wizard asks for "Remote URL", the user pastes one, and nothing in the URL says whether
// the far end speaks Streamable HTTP or the legacy HTTP+SSE transport. This probe establishes
// what each wrong pairing looks like, so the note can say whether Test Connection can detect
// the transport for the user instead of making them guess.
//
// Also runs the good SSE case through the Agent SDK, which the earlier probes never did.
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { query } from '@anthropic-ai/claude-agent-sdk';

const TOKEN = 's3cret';
const HP = 8971;
const SP = 8972;
const httpSrv = spawn(process.execPath, ['server-http.mjs', '--port', String(HP), '--token', TOKEN], { stdio: 'ignore' });
const sseSrv = spawn(process.execPath, ['server-sse.mjs', '--port', String(SP), '--token', TOKEN], { stdio: 'ignore' });
await sleep(800);

const auth = { Authorization: `Bearer ${TOKEN}` };
const d = (e) => `${e?.constructor?.name} code=${JSON.stringify(e?.code ?? null)} :: ${String(e?.message).slice(0, 130)}`;

async function tryIt(label, mk) {
  const c = new Client({ name: 'r06-probe', version: '0.0.1' }, { capabilities: {} });
  try {
    await c.connect(mk(), { timeout: 4000 });
    console.log(`[mcp-sdk] ${label}: connected to ${JSON.stringify(c.getServerVersion())}`);
    await c.close();
  } catch (e) {
    console.log(`[mcp-sdk] ${label}: ${d(e)}`);
    try {
      await c.close();
    } catch {}
  }
}

console.log('== transport mis-selection, @modelcontextprotocol/sdk ==');
await tryIt('http-transport -> streamable-http endpoint (correct)', () =>
  new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${HP}/mcp`), { requestInit: { headers: auth } }),
);
await tryIt('http-transport -> legacy SSE endpoint (wrong)', () =>
  new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${SP}/sse`), { requestInit: { headers: auth } }),
);
await tryIt('sse-transport -> legacy SSE endpoint (correct)', () =>
  new SSEClientTransport(new URL(`http://127.0.0.1:${SP}/sse`), {
    eventSourceInit: { fetch: (u, i) => fetch(u, { ...i, headers: { ...(i?.headers ?? {}), ...auth } }) },
    requestInit: { headers: auth },
  }),
);
await tryIt('sse-transport -> streamable-http endpoint (wrong)', () =>
  new SSEClientTransport(new URL(`http://127.0.0.1:${HP}/mcp`), {
    eventSourceInit: { fetch: (u, i) => fetch(u, { ...i, headers: { ...(i?.headers ?? {}), ...auth } }) },
    requestInit: { headers: auth },
  }),
);

console.log('\n== the same four pairings through the Agent SDK ==');
let release;
const held = new Promise((r) => (release = r));
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
      http_to_http_ok: { type: 'http', url: `http://127.0.0.1:${HP}/mcp`, headers: auth },
      http_to_sse_wrong: { type: 'http', url: `http://127.0.0.1:${SP}/sse`, headers: auth },
      sse_to_sse_ok: { type: 'sse', url: `http://127.0.0.1:${SP}/sse`, headers: auth },
      sse_to_http_wrong: { type: 'sse', url: `http://127.0.0.1:${HP}/mcp`, headers: auth },
      sse_wrong_token: { type: 'sse', url: `http://127.0.0.1:${SP}/sse`, headers: { Authorization: 'Bearer WRONG' } },
    },
  },
});
for await (const m of q) {
  if (m.type === 'system' && m.subtype === 'init') {
    const s = await q.mcpServerStatus();
    console.log(JSON.stringify(s.map(({ name, status, error, serverInfo }) => ({ name, status, serverInfo, error })), null, 2));
  }
  if (m.type === 'result') {
    release();
    break;
  }
}
httpSrv.kill();
sseSrv.kill();
process.exit(0);
