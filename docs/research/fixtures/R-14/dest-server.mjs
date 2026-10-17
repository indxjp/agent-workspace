// R-14 fixture — a standalone plain-HTTP "destination" process, run separately from the client
// and the proxy so none of the three share a process (and therefore none share env vars).
// Port argument may be 0 (or omitted) to let the OS assign a free port — the actual bound port
// is then written to the file named by argv[3], if given, once listening. This machine has an
// unrelated large range of high ports permanently EADDRINUSE (Hyper-V / WSL2 / Docker Desktop
// dynamic reservations that neither `netstat` nor `Get-NetTCPConnection` show — `netsh interface
// ipv4 show excludedportrange` doesn't list them either), so every fixture here binds port 0
// rather than a fixed number.
import http from 'node:http';
import fs from 'node:fs';
const requestedPort = Number(process.argv[2] ?? 0);
const portFile = process.argv[3];
const server = http.createServer((req, res) => {
  console.log(`DEST saw request: ${req.method} ${req.url}`);
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('hello from DEST');
});
server.listen(requestedPort, '127.0.0.1', () => {
  const port = server.address().port;
  console.log(`DEST listening on 127.0.0.1:${port}, pid=${process.pid}`);
  if (portFile) fs.writeFileSync(portFile, String(port));
});
process.on('SIGTERM', () => process.exit(0));
