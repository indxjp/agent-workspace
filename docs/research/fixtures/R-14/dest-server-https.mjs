// R-14 fixture — self-signed HTTPS "destination" process, for HTTPS_PROXY / CONNECT-tunnel
// probing. Pair with NODE_TLS_REJECT_UNAUTHORIZED=0 on the CLIENT process only (never do this
// against a real network target — it is only safe here because both ends are fixtures on
// 127.0.0.1 created for this probe).
// Port argument may be 0 (or omitted) to let the OS assign a free port — see dest-server.mjs for
// why this fixture never binds a fixed port on this machine.
// The cert/key directory is argv[4] (default: this file's own directory) — run-all.sh generates a
// throwaway cert into a temp dir rather than committing one; see run-all.sh for why a committed
// `.pem` file is not an option here.
import https from 'node:https';
import fs from 'node:fs';
const requestedPort = Number(process.argv[2] ?? 0);
const portFile = process.argv[3];
const certDir = process.argv[4] ? new URL(`file://${process.argv[4].replace(/\\/g, '/')}/`) : new URL('./', import.meta.url);
const server = https.createServer(
  { key: fs.readFileSync(new URL('key.pem', certDir)), cert: fs.readFileSync(new URL('cert.pem', certDir)) },
  (req, res) => {
    console.log(`DEST(https) saw request: ${req.method} ${req.url}`);
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('hello from HTTPS DEST');
  },
);
server.listen(requestedPort, '127.0.0.1', () => {
  const port = server.address().port;
  console.log(`DEST(https) listening on 127.0.0.1:${port}, pid=${process.pid}`);
  if (portFile) fs.writeFileSync(portFile, String(port));
});
process.on('SIGTERM', () => process.exit(0));
