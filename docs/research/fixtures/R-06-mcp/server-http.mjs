// R-06 probe fixture — a minimal, hand-rolled MCP server speaking the Streamable HTTP
// transport, with bearer authentication. Hand-rolled rather than built on the MCP SDK so
// that the probe can log the exact bytes and headers a client sends, and so that the
// failure modes (401, 404, hang) are produced deliberately rather than emerging from a
// library.
//
//   node server-http.mjs --port 8931 --token s3cret [--log requests.jsonl]
//
// Behaviour:
//   POST /mcp                    the MCP endpoint. Requires Authorization: Bearer <token>.
//   POST /mcp   (bad/no token)   401 + WWW-Authenticate, JSON body.
//   POST /hang                   accepts the request and never answers.
//   anything else                404.
import http from 'node:http';
import fs from 'node:fs';

const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i === -1 ? d : process.argv[i + 1];
};
const PORT = Number(arg('port', '8931'));
const TOKEN = arg('token', 's3cret');
const LOG = arg('log', null);
const SERVER_PROTOCOL = arg('protocol', null); // if set, answer initialize with this version

const log = (o) => {
  const line = JSON.stringify({ t: new Date().toISOString(), ...o });
  if (LOG) fs.appendFileSync(LOG, line + '\n');
  else console.error(line);
};

const readBody = (req) =>
  new Promise((res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => res(b));
  });

const server = http.createServer(async (req, res) => {
  const body = await readBody(req);
  log({ kind: 'request', method: req.method, url: req.url, headers: req.headers, body });

  if (req.url === '/hang') {
    // Deliberately never respond. The socket stays open.
    return;
  }
  if (req.url === '/forbidden') {
    // A token that authenticates but does not authorise: MCP authorization §Error Handling
    // makes this 403, not 401.
    res.writeHead(403, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ error: 'insufficient_scope', error_description: 'token lacks scope mcp:tools' }));
  }
  if (req.url === '/500') {
    res.writeHead(500, { 'content-type': 'text/html' });
    return res.end('<html><body>Internal Server Error</body></html>');
  }
  if (req.url !== '/mcp') {
    res.writeHead(404, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ error: 'not found' }));
  }

  const auth = req.headers['authorization'];
  if (auth !== `Bearer ${TOKEN}`) {
    res.writeHead(401, {
      'content-type': 'application/json',
      'www-authenticate':
        'Bearer error="invalid_token", error_description="The access token is invalid", ' +
        `resource_metadata="http://127.0.0.1:${PORT}/.well-known/oauth-protected-resource"`,
    });
    return res.end(
      JSON.stringify({ error: 'invalid_token', error_description: 'The access token is invalid' }),
    );
  }

  if (req.method !== 'POST') {
    res.writeHead(405, { allow: 'POST' });
    return res.end();
  }

  let msg;
  try {
    msg = JSON.parse(body);
  } catch {
    res.writeHead(400, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }));
  }

  // Notifications and responses carry no id: acknowledge with 202 and no body.
  if (msg.id === undefined) {
    res.writeHead(202);
    return res.end();
  }

  let result;
  if (msg.method === 'initialize') {
    result = {
      protocolVersion: SERVER_PROTOCOL ?? msg.params?.protocolVersion ?? '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'r06-probe-http', version: '0.0.1' },
    };
  } else if (msg.method === 'tools/list') {
    result = { tools: [{ name: 'ping', description: 'probe tool', inputSchema: { type: 'object', properties: {} } }] };
  } else if (msg.method === 'ping') {
    result = {};
  } else {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(
      JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } }),
    );
  }

  const payload = JSON.stringify({ jsonrpc: '2.0', id: msg.id, result });
  log({ kind: 'response', for: msg.method, body: payload });
  res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'r06-probe-session' });
  res.end(payload);
});

server.listen(PORT, '127.0.0.1', () => {
  console.error(`[http] listening on http://127.0.0.1:${PORT}/mcp token=${TOKEN}`);
  if (process.send) process.send('ready');
});
