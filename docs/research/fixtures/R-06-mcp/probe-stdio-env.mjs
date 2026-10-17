// R-06 probe — what environment a stdio MCP server actually receives, on BOTH clients.
//
// The question W2-CP-05 has to answer: if a connector declares `env: { API_KEY: … }`, does the
// server process still get PATH, HOME, HTTPS_PROXY, NODE_EXTRA_CA_CERTS and the rest, or does the
// declaration replace the environment? The two clients answer differently, and getting it wrong
// gives a Test Connection that passes and a run that fails (or vice versa).
//
// The server reports its own env through serverInfo.version, which both clients surface verbatim.
//
// Makes ONE live model call for the Agent SDK half. Costs money.
import fs from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, DEFAULT_INHERITED_ENV_VARS } from '@modelcontextprotocol/sdk/client/stdio.js';
import { query } from '@anthropic-ai/claude-agent-sdk';

process.env.R06_CANARY = 'inherited-from-parent';
const server = `${process.cwd()}/server-stdio.mjs`;
const args = [server, '--mode', 'ok', '--report-env'];

console.log(`platform=${process.platform} node=${process.version}`);
console.log(`DEFAULT_INHERITED_ENV_VARS (${DEFAULT_INHERITED_ENV_VARS.length}) = ${JSON.stringify(DEFAULT_INHERITED_ENV_VARS)}`);
console.log(`this process has ${Object.keys(process.env).length} environment variables\n`);

console.log('== @modelcontextprotocol/sdk ==');
for (const [label, env] of [
  ['no env declared', undefined],
  ['env: { API_KEY } only', { API_KEY: 'k' }],
  ['env: { ...process.env, API_KEY }', { ...process.env, API_KEY: 'k' }],
]) {
  const c = new Client({ name: 'p', version: '1' }, { capabilities: {} });
  try {
    await c.connect(new StdioClientTransport({ command: process.execPath, args, env, stderr: 'pipe' }), { timeout: 4000 });
    console.log(`  [${label}] -> ${c.getServerVersion().version}`);
  } catch (e) {
    console.log(`  [${label}] -> threw ${e.message}`);
  }
  try {
    await c.close();
  } catch {}
}

console.log('\n== @anthropic-ai/claude-agent-sdk ==');
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
      no_env: { command: process.execPath, args },
      api_key_only: { command: process.execPath, args, env: { API_KEY: 'k' } },
      spread_env: { command: process.execPath, args, env: { ...process.env, API_KEY: 'k' } },
    },
  },
});
for await (const m of q) {
  if (m.type === 'system' && m.subtype === 'init') {
    const s = await q.mcpServerStatus();
    for (const r of s) console.log(`  [${r.name}] ${r.status} -> ${r.serverInfo?.version ?? r.error}`);
  }
  if (m.type === 'result') {
    release();
    break;
  }
}
process.exit(0);
