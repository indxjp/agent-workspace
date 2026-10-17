// R-06 probe — the Test Connection matrix.
//
// For each of the three transports spec §8 names, connect an MCP client under every failure
// mode a Test Connection button has to tell apart, and record verbatim what the client
// throws. The question this probe exists to answer is W2-CP-05's acceptance criterion:
// does "wrong URL" produce a *different, machine-distinguishable* error from
// "reachable but the token was rejected"?
//
//   node probe-transports.mjs > transcript.json
//
// Servers are started and stopped by this script; nothing needs to be running first.
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const HTTP_PORT = 8931;
const SSE_PORT = 8932;
const HTTP_PROTO_PORT = 8933;
const TOKEN = 's3cret';
const CONNECT_TIMEOUT_MS = 5000;

const results = [];
const record = (name, o) => {
  results.push({ case: name, ...o });
  process.stderr.write(`  ${name}: ${o.outcome}\n`);
};

// Describe an error the way an implementation would have to inspect it.
const describe = (e) => ({
  ctor: e?.constructor?.name ?? null,
  name: e?.name ?? null,
  message: String(e?.message ?? e),
  code: e?.code ?? null,
  // Node's fetch wraps a socket error; the useful discriminator is usually on `.cause`.
  causeCtor: e?.cause?.constructor?.name ?? null,
  causeMessage: e?.cause?.message ?? null,
  causeCode: e?.cause?.code ?? null,
  causeErrno: e?.cause?.errno ?? null,
  causeSyscall: e?.cause?.syscall ?? null,
  keys: e && typeof e === 'object' ? Object.keys(e) : [],
});

async function attempt(name, makeTransport, { timeout = CONNECT_TIMEOUT_MS } = {}) {
  const client = new Client({ name: 'r06-probe', version: '0.0.1' }, { capabilities: {} });
  const started = Date.now();
  let transport;
  try {
    transport = makeTransport();
    await client.connect(transport, { timeout });
    const serverInfo = client.getServerVersion();
    const proto = client.getServerCapabilities();
    let tools = null;
    try {
      tools = (await client.listTools({}, { timeout })).tools.map((t) => t.name);
    } catch (e) {
      tools = { error: describe(e) };
    }
    record(name, {
      outcome: 'connected',
      ms: Date.now() - started,
      serverInfo,
      serverCapabilities: proto,
      tools,
    });
    await client.close();
  } catch (e) {
    record(name, { outcome: 'threw', ms: Date.now() - started, error: describe(e) });
    try {
      await transport?.close?.();
    } catch {}
    try {
      await client.close();
    } catch {}
  }
}

function startServer(file, args) {
  const p = spawn(process.execPath, [file, ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
  p.stderr.on('data', () => {});
  return p;
}

const httpSrv = startServer('server-http.mjs', ['--port', String(HTTP_PORT), '--token', TOKEN]);
const sseSrv = startServer('server-sse.mjs', ['--port', String(SSE_PORT), '--token', TOKEN]);
const protoSrv = startServer('server-http.mjs', [
  '--port',
  String(HTTP_PROTO_PORT),
  '--token',
  TOKEN,
  '--protocol',
  '2024-11-05',
]);
await sleep(800);

process.stderr.write('\n== HTTP (Streamable HTTP) ==\n');
const httpURL = (p = '/mcp', port = HTTP_PORT) => new URL(`http://127.0.0.1:${port}${p}`);
const bearer = (t) => ({ requestInit: { headers: { Authorization: `Bearer ${t}` } } });

await attempt('http/ok-bearer', () => new StreamableHTTPClientTransport(httpURL(), bearer(TOKEN)));
await attempt('http/wrong-token', () => new StreamableHTTPClientTransport(httpURL(), bearer('WRONG')));
await attempt('http/no-token', () => new StreamableHTTPClientTransport(httpURL()));
await attempt('http/wrong-path-404', () => new StreamableHTTPClientTransport(httpURL('/nope'), bearer(TOKEN)));
await attempt('http/port-closed', () => new StreamableHTTPClientTransport(new URL('http://127.0.0.1:8999/mcp'), bearer(TOKEN)));
await attempt('http/dns-nxdomain', () =>
  new StreamableHTTPClientTransport(new URL('https://r06-probe-does-not-exist.invalid/mcp'), bearer(TOKEN)),
);
await attempt('http/tls-to-plain-port', () =>
  new StreamableHTTPClientTransport(new URL(`https://127.0.0.1:${HTTP_PORT}/mcp`), bearer(TOKEN)),
);
await attempt('http/hangs-forever', () => new StreamableHTTPClientTransport(httpURL('/hang'), bearer(TOKEN)), {
  timeout: 3000,
});
await attempt('http/protocol-2024-11-05-server', () =>
  new StreamableHTTPClientTransport(httpURL('/mcp', HTTP_PROTO_PORT), bearer(TOKEN)),
);

process.stderr.write('\n== SSE (legacy HTTP+SSE) ==\n');
const sseURL = (p = '/sse', port = SSE_PORT) => new URL(`http://127.0.0.1:${port}${p}`);
const sseAuth = (t) => ({
  eventSourceInit: {
    fetch: (url, init) =>
      fetch(url, { ...init, headers: { ...(init?.headers ?? {}), Authorization: `Bearer ${t}` } }),
  },
  requestInit: { headers: { Authorization: `Bearer ${t}` } },
});

await attempt('sse/ok-bearer', () => new SSEClientTransport(sseURL(), sseAuth(TOKEN)));
await attempt('sse/wrong-token', () => new SSEClientTransport(sseURL(), sseAuth('WRONG')));
await attempt('sse/no-token', () => new SSEClientTransport(sseURL()));
await attempt('sse/wrong-path-404', () => new SSEClientTransport(sseURL('/nope'), sseAuth(TOKEN)));
await attempt('sse/port-closed', () => new SSEClientTransport(new URL('http://127.0.0.1:8999/sse'), sseAuth(TOKEN)));
await attempt('sse/dns-nxdomain', () =>
  new SSEClientTransport(new URL('https://r06-probe-does-not-exist.invalid/sse'), sseAuth(TOKEN)),
);
await attempt('sse/http-endpoint-not-sse', () =>
  new SSEClientTransport(httpURL('/mcp'), sseAuth(TOKEN)),
);

process.stderr.write('\n== stdio ==\n');
const stdio = (args, env) =>
  new StdioClientTransport({ command: process.execPath, args: ['server-stdio.mjs', ...args], env, stderr: 'pipe' });

await attempt('stdio/ok', () => stdio(['--mode', 'ok']));
await attempt('stdio/env-credential-ok', () =>
  stdio(['--mode', 'ok', '--require-env', 'MCP_TOKEN=' + TOKEN], { ...process.env, MCP_TOKEN: TOKEN }),
);
await attempt('stdio/env-credential-wrong', () =>
  stdio(['--mode', 'ok', '--require-env', 'MCP_TOKEN=' + TOKEN], { ...process.env, MCP_TOKEN: 'WRONG' }),
);
await attempt('stdio/env-credential-missing', () =>
  stdio(['--mode', 'ok', '--require-env', 'MCP_TOKEN=' + TOKEN], { ...process.env }),
);
await attempt('stdio/command-not-found', () =>
  new StdioClientTransport({ command: 'r06-no-such-binary', args: [], stderr: 'pipe' }),
);
await attempt('stdio/exits-immediately', () => stdio(['--mode', 'exit']));
await attempt('stdio/stdout-noise', () => stdio(['--mode', 'noise']));
await attempt('stdio/hangs-forever', () => stdio(['--mode', 'hang']), { timeout: 3000 });
await attempt('stdio/slow-but-answers', () => stdio(['--mode', 'slow', '--delay', '1500']), { timeout: 3000 });
await attempt('stdio/protocol-2024-11-05-server', () => stdio(['--mode', 'ok', '--protocol', '2024-11-05']));
await attempt('stdio/protocol-unknown-server', () => stdio(['--mode', 'ok', '--protocol', '1999-01-01']));

httpSrv.kill();
sseSrv.kill();
protoSrv.kill();

process.stdout.write(JSON.stringify({ node: process.version, platform: process.platform, at: new Date().toISOString(), results }, null, 2));
