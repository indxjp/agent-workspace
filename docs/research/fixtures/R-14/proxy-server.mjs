// R-14 fixture — a standalone forward-proxy process (handles absolute-form requests and CONNECT
// tunnels), run with NO proxy env vars of its own so its own outbound relay calls never
// recurse into itself. Client probes point HTTP_PROXY/HTTPS_PROXY at this process's port.
// Port argument may be 0 (or omitted) to let the OS assign a free port — see dest-server.mjs for
// why this fixture never binds a fixed port on this machine.
//
// argv[4], if present, is `user:pass`, which puts the proxy into AUTHENTICATING mode: every
// absolute-form request and every CONNECT is answered `407 Proxy Authentication Required` unless
// it carries a matching `Proxy-Authorization: Basic <base64(user:pass)>` header. That is the small
// addition that turns proxy authentication from a declared gap into a probe. The proxy logs
// whether each request carried the header and whether it matched, so the transcript shows the
// credential actually travelling rather than only the end result.
//
// Every absolute-form log line carries the request path. CONNECT has no path by construction (it
// names only host:port), so run-all.sh snapshots this log before and after each numbered section
// and prints the delta — which makes per-section attribution a direct observation rather than the
// correlation-by-counting the first draft of this note relied on.
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';

const CRLF = '\r\n';
const requestedPort = Number(process.argv[2] ?? 0);
const portFile = process.argv[3];
const requiredCreds = process.argv[4] || null;
const expectedHeader = requiredCreds
  ? `Basic ${Buffer.from(requiredCreds).toString('base64')}`
  : null;
const log = [];

// Returns true if the request may proceed; otherwise `deny()` has already answered 407.
function authorize(req, deny) {
  const got = req.headers['proxy-authorization'];
  if (!expectedHeader) {
    console.log(`PROXY auth: not required (open proxy); header present=${got !== undefined}`);
    return true;
  }
  if (got === undefined) {
    console.log('PROXY auth: NO Proxy-Authorization header -> answering 407');
    deny();
    return false;
  }
  if (got !== expectedHeader) {
    console.log(`PROXY auth: header did NOT match -> answering 407 (got ${JSON.stringify(got)})`);
    deny();
    return false;
  }
  console.log(`PROXY auth: header matched -> allowed (${JSON.stringify(got)})`);
  return true;
}

const server = http.createServer((req, res) => {
  log.push({ kind: 'request', method: req.method, url: req.url });
  console.log(`PROXY saw request: ${req.method} ${req.url}`);
  const allowed = authorize(req, () => {
    res
      .writeHead(407, {
        'proxy-authenticate': 'Basic realm="r14-fixture"',
        'content-type': 'text/plain',
      })
      .end('proxy auth required');
  });
  if (!allowed) return;
  let target;
  try { target = new URL(req.url); } catch { target = new URL(req.url, `http://${req.headers.host}`); }
  const upstream = http.request(
    { host: target.hostname, port: target.port || 80, path: target.pathname + target.search, method: req.method, headers: req.headers },
    (uRes) => { res.writeHead(uRes.statusCode, uRes.headers); uRes.pipe(res); },
  );
  upstream.on('error', (e) => { console.log(`PROXY relay error: ${e.message}`); res.writeHead(502).end(); });
  req.pipe(upstream);
});

server.on('connect', (req, clientSocket, head) => {
  log.push({ kind: 'connect', url: req.url });
  console.log(`PROXY saw CONNECT: ${req.url}`);
  const allowed = authorize(req, () => {
    clientSocket.write(
      `HTTP/1.1 407 Proxy Authentication Required${CRLF}` +
        `Proxy-Authenticate: Basic realm="r14-fixture"${CRLF}` +
        `Connection: close${CRLF}${CRLF}`,
    );
    clientSocket.end();
  });
  if (!allowed) return;
  const [host, p] = req.url.split(':');
  const upstream = net.connect(Number(p), host, () => {
    clientSocket.write(`HTTP/1.1 200 Connection Established${CRLF}${CRLF}`);
    upstream.write(head);
    upstream.pipe(clientSocket);
    clientSocket.pipe(upstream);
  });
  upstream.on('error', (e) => { console.log(`PROXY CONNECT upstream error: ${e.message}`); clientSocket.end(); });
  clientSocket.on('error', () => {});
});

server.listen(requestedPort, '127.0.0.1', () => {
  const port = server.address().port;
  console.log(
    `PROXY listening on 127.0.0.1:${port}, pid=${process.pid}, auth=${requiredCreds ? 'REQUIRED' : 'none'}`,
  );
  if (portFile) fs.writeFileSync(portFile, String(port));
});

process.on('SIGTERM', () => process.exit(0));
