// R-06 probe — the wire. Captures the exact `initialize` request the MCP SDK client sends
// (protocol version, client info, headers) on the HTTP transport, and the exact bytes on the
// stdio transport. Answers question 6 (protocol version negotiation) with evidence rather
// than with a grep of a bundled constant.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { LATEST_PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS } from '@modelcontextprotocol/sdk/types.js';

console.log('MCP SDK LATEST_PROTOCOL_VERSION    =', LATEST_PROTOCOL_VERSION);
console.log('MCP SDK SUPPORTED_PROTOCOL_VERSIONS=', JSON.stringify(SUPPORTED_PROTOCOL_VERSIONS));

const HTTP_LOG = 'wire-http.jsonl';
const STDIO_LOG = 'wire-stdio.jsonl';
for (const f of [HTTP_LOG, STDIO_LOG]) if (fs.existsSync(f)) fs.unlinkSync(f);

const srv = spawn(process.execPath, ['server-http.mjs', '--port', '8941', '--token', 's3cret', '--log', HTTP_LOG], {
  stdio: ['ignore', 'ignore', 'ignore'],
});
await sleep(600);

const c = new Client({ name: 'r06-probe', version: '0.0.1' }, { capabilities: {} });
await c.connect(
  new StreamableHTTPClientTransport(new URL('http://127.0.0.1:8941/mcp'), {
    requestInit: { headers: { Authorization: 'Bearer s3cret' } },
  }),
  { timeout: 5000 },
);
await c.listTools({}, { timeout: 5000 });
await c.close();
srv.kill();
await sleep(300);

console.log('\n=== HTTP wire (every request the client made) ===');
// Classify every record the server logged; do not filter. `server-http.mjs` writes `request` and
// `response` records, and this section is about requests — but a record of some third kind must
// not vanish into a `continue`, because then the section header would be a claim nothing checks.
// ADR-0027: the rule that selects the printed set ends in an explicit rejection naming the record.
for (const line of fs.readFileSync(HTTP_LOG, 'utf8').trim().split('\n')) {
  const r = JSON.parse(line);
  if (r.kind === 'request') {
    console.log(`${r.method} ${r.url}`);
    for (const [k, v] of Object.entries(r.headers)) console.log(`   ${k}: ${v}`);
    if (r.body) console.log(`   BODY ${r.body}`);
    console.log('');
  } else if (r.kind === 'response') {
    // Deliberately not printed here: this section is the client's requests. The stdio section
    // below prints both kinds.
  } else {
    throw new Error(`unclassified wire record kind "${r.kind}" in ${HTTP_LOG}: ${line.slice(0, 200)}`);
  }
}

const c2 = new Client({ name: 'r06-probe', version: '0.0.1' }, { capabilities: {} });
await c2.connect(
  new StdioClientTransport({
    command: process.execPath,
    args: ['server-stdio.mjs', '--mode', 'ok', '--log', STDIO_LOG],
    stderr: 'pipe',
  }),
  { timeout: 5000 },
);
await c2.listTools({}, { timeout: 5000 });
await c2.close();
await sleep(300);

console.log('=== stdio wire ===');
for (const line of fs.readFileSync(STDIO_LOG, 'utf8').trim().split('\n')) {
  const r = JSON.parse(line);
  console.log(`${r.kind.toUpperCase()} ${r.body}`);
}
