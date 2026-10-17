// R-06 probe fixture — a minimal MCP server on the stdio transport: newline-delimited
// JSON-RPC on stdin/stdout, with everything human-facing on stderr.
//
//   node server-stdio.mjs [--mode ok|hang|exit|noise|slow] [--require-env NAME=VALUE]
//
//   ok     answer initialize and tools/list normally
//   hang   read stdin and never write anything (the hung-child case)
//   exit   print a line to stderr and exit(1) immediately
//   noise  write a non-JSON banner line to stdout before answering (the "server pollutes
//          stdout" case that breaks the transport)
//   slow   answer, but only after --delay ms
//
// --require-env NAME=VALUE makes the server behave as a credentialled stdio server: if the
// variable is absent or wrong it answers initialize with a JSON-RPC error rather than a result.
import fs from 'node:fs';

const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i === -1 ? d : process.argv[i + 1];
};
const MODE = arg('mode', 'ok');
const DELAY = Number(arg('delay', '0'));
const REQUIRE_ENV = arg('require-env', null);
const SERVER_PROTOCOL = arg('protocol', null);
const LOG = arg('log', null);

const log = (o) => {
  const line = JSON.stringify({ t: new Date().toISOString(), ...o });
  if (LOG) fs.appendFileSync(LOG, line + '\n');
  else process.stderr.write(line + '\n');
};

if (MODE === 'exit') {
  process.stderr.write('r06-probe-stdio: fatal: MCP_TOKEN is not set\n');
  process.exit(1);
}
if (MODE === 'noise') {
  process.stdout.write('r06-probe-stdio starting up...\n');
}

let credentialOk = true;
let credentialDetail = '';
if (REQUIRE_ENV) {
  const eq = REQUIRE_ENV.indexOf('=');
  const name = REQUIRE_ENV.slice(0, eq);
  const want = REQUIRE_ENV.slice(eq + 1);
  const got = process.env[name];
  if (got === undefined) {
    credentialOk = false;
    credentialDetail = `environment variable ${name} is not set`;
  } else if (got !== want) {
    credentialOk = false;
    credentialDetail = `environment variable ${name} is set but rejected`;
  }
}

const send = (o) => process.stdout.write(JSON.stringify(o) + '\n');

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    log({ kind: 'request', body: line });
    if (MODE === 'hang') continue; // read, never answer
    let msg;
    try {
      msg = JSON.parse(line);
    } catch (parseError) {
      // An unparseable line is a line this server could not classify, and dropping it silently
      // would make a client's resulting `timeout` look like the server's designed behaviour. It is
      // named on stderr instead, which `test-connection.mjs` captures and surfaces. The process
      // does NOT exit: a stdio server that dies on one bad line would change the very failure
      // these probes measure, from "no answer" to "process died".
      process.stderr.write(`server-stdio: unparseable line, not answered (${parseError.message}): ${line.slice(0, 200)}\n`);
      continue;
    }
    if (msg.id === undefined) continue; // notification

    const answer = () => {
      if (!credentialOk) {
        // A stdio server has no HTTP status code to return. The only channel it has is a
        // JSON-RPC error on the initialize response (or exiting). This is that case.
        const err = { jsonrpc: '2.0', id: msg.id, error: { code: -32001, message: `Unauthorized: ${credentialDetail}` } };
        log({ kind: 'response', body: JSON.stringify(err) });
        return send(err);
      }
      if (MODE === 'not-mcp') {
        // Answers JSON-RPC but does not implement `initialize` — the shape a non-MCP JSON-RPC
        // endpoint has. -32601 is JSON-RPC's pre-defined "method not found".
        const e = { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } };
        log({ kind: 'response', body: JSON.stringify(e) });
        return send(e);
      }
      let result;
      if (msg.method === 'initialize') {
        // --report-env smuggles the child's actual environment back through serverInfo.version,
        // which is the one field a client surfaces verbatim. It is how this probe reads the env
        // an MCP client gave its stdio child without needing access to that client's internals.
        const envReport = [
          'keys=' + Object.keys(process.env).length,
          'PATH=' + (process.env.PATH === undefined ? 'absent' : 'present'),
          'HOME=' + (process.env.HOME === undefined ? 'absent' : 'present'),
          'API_KEY=' + (process.env.API_KEY ?? 'absent'),
          'CANARY=' + (process.env.R06_CANARY ?? 'absent'),
        ].join(' ');
        result = {
          protocolVersion: SERVER_PROTOCOL ?? msg.params?.protocolVersion ?? '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: {
            name: 'r06-probe-stdio',
            version: process.argv.includes('--report-env') ? envReport : '0.0.1',
          },
        };
      } else if (msg.method === 'tools/list') {
        result = { tools: [{ name: 'ping', description: 'probe tool', inputSchema: { type: 'object', properties: {} } }] };
      } else if (msg.method === 'ping') {
        result = {};
      } else {
        return send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } });
      }
      const payload = { jsonrpc: '2.0', id: msg.id, result };
      log({ kind: 'response', body: JSON.stringify(payload) });
      send(payload);
    };

    if (MODE === 'slow' && DELAY > 0) setTimeout(answer, DELAY);
    else answer();
  }
});
process.stdin.on('end', () => process.exit(0));
