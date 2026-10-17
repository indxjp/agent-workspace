// R-06 probe fixture — a minimal MCP server speaking the legacy HTTP+SSE transport
// (MCP protocol revision 2024-11-05): GET /sse opens an event stream whose first event is
// `endpoint`, naming the URL the client POSTs its JSON-RPC messages to; responses come back
// down the SSE stream.
//
//   node server-sse.mjs --port 8932 --token s3cret [--log requests.jsonl]
//
//   GET  /sse                    the event stream. Requires Authorization: Bearer <token>.
//   POST /messages?sessionId=…   inbound JSON-RPC.
//   GET  /sse-blackhole          accepts the request and never writes a byte. The firewall /
//                                stalled-proxy shape: the socket is open and nothing arrives.
//   GET  /sse-no-endpoint        opens a well-formed 200 text/event-stream, writes a comment
//                                frame, and never sends the `endpoint` event the transport is
//                                waiting for.
//
// Those last two are here because `SSEClientTransport.start()` settles only on an error or on
// that `endpoint` event, and `Protocol.connect()` awaits `start()` BEFORE it issues the timed
// `initialize` request — so neither case can be bounded by the SDK's per-request timeout, and a
// reference Test Connection that relies on it never returns. See `test-connection.mjs`'s
// `deadlineFor`, and the `sse · …` rows of `classify-linux.txt` that hold it to account.
import http from 'node:http';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';

const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i === -1 ? d : process.argv[i + 1];
};
const PORT = Number(arg('port', '8932'));
const TOKEN = arg('token', 's3cret');
const LOG = arg('log', null);
const SERVER_PROTOCOL = arg('protocol', null);

const log = (o) => {
  const line = JSON.stringify({ t: new Date().toISOString(), ...o });
  if (LOG) fs.appendFileSync(LOG, line + '\n');
  else console.error(line);
};

const sessions = new Map(); // id -> res

const readBody = (req) =>
  new Promise((res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => res(b));
  });

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://127.0.0.1:${PORT}`);

  if (u.pathname === '/sse' && req.method === 'GET') {
    log({ kind: 'request', method: 'GET', url: req.url, headers: req.headers });
    if (req.headers['authorization'] !== `Bearer ${TOKEN}`) {
      res.writeHead(401, {
        'content-type': 'application/json',
        'www-authenticate': 'Bearer error="invalid_token"',
      });
      return res.end(JSON.stringify({ error: 'invalid_token' }));
    }
    const id = randomUUID();
    sessions.set(id, res);
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    res.write(`event: endpoint\ndata: /messages?sessionId=${id}\n\n`);
    req.on('close', () => sessions.delete(id));
    return;
  }

  // Accepted, and nothing is ever written. No response head, no body, no close.
  if (u.pathname === '/sse-blackhole' && req.method === 'GET') {
    log({ kind: 'request', method: 'GET', url: req.url, headers: req.headers });
    req.on('close', () => log({ kind: 'blackhole-client-gave-up' }));
    return;
  }

  // A stream that opens correctly and then says nothing the transport can use.
  if (u.pathname === '/sse-no-endpoint' && req.method === 'GET') {
    log({ kind: 'request', method: 'GET', url: req.url, headers: req.headers });
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    res.write(': open, but no endpoint event is coming\n\n');
    return;
  }

  if (u.pathname === '/messages' && req.method === 'POST') {
    const body = await readBody(req);
    log({ kind: 'request', method: 'POST', url: req.url, headers: req.headers, body });
    if (req.headers['authorization'] !== `Bearer ${TOKEN}`) {
      res.writeHead(401, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: 'invalid_token' }));
    }
    const sid = u.searchParams.get('sessionId');
    const stream = sessions.get(sid);
    if (!stream) {
      res.writeHead(404);
      return res.end('no session');
    }
    const msg = JSON.parse(body);
    res.writeHead(202);
    res.end('accepted');
    if (msg.id === undefined) return; // notification

    let result;
    if (msg.method === 'initialize') {
      result = {
        protocolVersion: SERVER_PROTOCOL ?? msg.params?.protocolVersion ?? '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'r06-probe-sse', version: '0.0.1' },
      };
    } else if (msg.method === 'tools/list') {
      result = { tools: [{ name: 'ping', description: 'probe tool', inputSchema: { type: 'object', properties: {} } }] };
    } else if (msg.method === 'ping') {
      result = {};
    } else {
      stream.write(
        `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } })}\n\n`,
      );
      return;
    }
    const payload = JSON.stringify({ jsonrpc: '2.0', id: msg.id, result });
    log({ kind: 'response', for: msg.method, body: payload });
    stream.write(`event: message\ndata: ${payload}\n\n`);
    return;
  }

  res.writeHead(404);
  res.end('not found');
});

server.listen(PORT, '127.0.0.1', () => {
  console.error(`[sse] listening on http://127.0.0.1:${PORT}/sse token=${TOKEN}`);
});
