// R-14 probe — does a raw `node:net` socket (no http/https/fetch involved at all) respect
// HTTP_PROXY / NODE_USE_ENV_PROXY? It should not: proxying is implemented inside the undici
// dispatcher stack and the http/https module's own agent, not at the socket layer, so anything
// that opens its own TCP socket is entirely outside the mechanism regardless of these env vars.
// This is the empirical basis for "HTTP_PROXY/NODE_USE_ENV_PROXY is cooperative, not a security
// boundary" in the note.
import net from 'node:net';

const destPort = Number(process.argv[2]);

console.log(`NODE_USE_ENV_PROXY=${JSON.stringify(process.env.NODE_USE_ENV_PROXY ?? null)} HTTP_PROXY=${JSON.stringify(process.env.HTTP_PROXY ?? null)}`);

await new Promise((resolve) => {
  const s = net.connect(destPort, '127.0.0.1', () => {
    s.write('GET /raw-socket-path HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n');
  });
  let data = '';
  s.on('data', (c) => (data += c));
  s.on('close', () => { console.log(`RESULT: raw net.connect got response: ${JSON.stringify(data.split('\r\n')[0])} (this proves it went DIRECT — a proxied connection could not have produced a plain HTTP response line from DEST over a bare socket)`); resolve(); });
  s.on('error', (e) => { console.log(`RESULT: raw net.connect errored: ${e.message}`); resolve(); });
});
