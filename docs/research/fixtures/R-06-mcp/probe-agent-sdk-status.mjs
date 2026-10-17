// R-06 probe (second pass) — Query.mcpServerStatus() called from inside the message loop,
// while the session is still open. The first pass polled from a detached task and the query had
// already closed. This one reads the status the moment system/init arrives and again after the
// result, and dumps the full McpServerStatus records including the `error` field, which is the
// only place the Agent SDK could distinguish "rejected" from "unreachable".
//
// Makes ONE live model call. Costs money.
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import fs from 'node:fs';
import { query } from '@anthropic-ai/claude-agent-sdk';

const TOKEN = 's3cret';
const PORT = 8953;
const srv = spawn(process.execPath, ['server-http.mjs', '--port', String(PORT), '--token', TOKEN], {
  stdio: ['ignore', 'ignore', 'ignore'],
});
await sleep(800);

const mcpServers = {
  ok_http: { type: 'http', url: `http://127.0.0.1:${PORT}/mcp`, headers: { Authorization: `Bearer ${TOKEN}` } },
  bad_token_http: { type: 'http', url: `http://127.0.0.1:${PORT}/mcp`, headers: { Authorization: 'Bearer WRONG' } },
  unreachable_http: { type: 'http', url: 'http://127.0.0.1:8999/mcp', headers: { Authorization: `Bearer ${TOKEN}` } },
  nxdomain_http: { type: 'http', url: 'https://r06-probe-does-not-exist.invalid/mcp' },
  ok_sse: { type: 'sse', url: `http://127.0.0.1:8999/sse` },
  bad_cred_stdio: {
    command: process.execPath,
    args: [`${process.cwd()}/server-stdio.mjs`, '--mode', 'ok', '--require-env', `MCP_TOKEN=${TOKEN}`],
    env: { MCP_TOKEN: 'WRONG' },
  },
  missing_command_stdio: { command: 'r06-no-such-binary', args: [] },
  hang_stdio: { command: process.execPath, args: [`${process.cwd()}/server-stdio.mjs`, '--mode', 'hang'] },
};

let releasePrompt;
const promptHeldOpen = new Promise((r) => (releasePrompt = r));
async function* prompt() {
  yield { type: 'user', message: { role: 'user', content: 'Reply with the single word: ok' } };
  // Hold the input stream open: Query's control methods (mcpServerStatus among them) talk over
  // the same process transport, and it is torn down when the prompt generator returns.
  await promptHeldOpen;
}

const q = query({
  prompt: prompt(),
  options: { model: 'claude-haiku-4-5', maxTurns: 1, mcpServers, strictMcpConfig: true, settingSources: [], allowedTools: [] },
});

const out = { snapshots: [] };
for await (const m of q) {
  if (m.type === 'system' && m.subtype === 'init') {
    out.initMcpServers = m.mcp_servers;
    try {
      out.snapshots.push({ when: 'at-init', status: await q.mcpServerStatus() });
    } catch (e) {
      out.snapshots.push({ when: 'at-init', error: e.message });
    }
    await sleep(8000);
    try {
      out.snapshots.push({ when: 'init+8s', status: await q.mcpServerStatus() });
    } catch (e) {
      out.snapshots.push({ when: 'init+8s', error: e.message });
    }
  }
  if (m.type === 'result') {
    try {
      out.snapshots.push({ when: 'at-result', status: await q.mcpServerStatus() });
    } catch (e) {
      out.snapshots.push({ when: 'at-result', error: e.message });
    }
    out.resultSubtype = m.subtype;
    releasePrompt();
    break;
  }
}
srv.kill();
fs.writeFileSync('agent-sdk-mcp3.json', JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
process.exit(0);
