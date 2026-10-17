// A fake orders API, so this project needs no external service. Run it with
// `node fake-api/server.ts`; it listens on ORDERS_URL (http://127.0.0.1:4010 when unset) until you
// stop it. Replace it with your own API: see "Change these first" in README.md.
import { createServer } from 'node:http';

/** The setting this server and `delivery_estimate` both read, so a busy port moves in one place. */
const ORDERS_URL = new URL(process.env['ORDERS_URL'] ?? 'http://127.0.0.1:4010');
const PORT = Number(ORDERS_URL.port);
const DAY_MS = 24 * 60 * 60 * 1000;

/** Known orders; any other order number is "processing", due in a week. */
const ORDERS: Record<string, { status: string; days: number }> = {
  'A-1042': { status: 'shipped', days: 2 },
  'A-1043': { status: 'delayed', days: -3 },
};

createServer((request, response) => {
  const url = new URL(request.url ?? '/', ORDERS_URL);
  const orderNumber = /^\/orders\/([^/]+)$/u.exec(url.pathname)?.[1];
  if (request.method !== 'GET' || orderNumber === undefined) {
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: 'not_found' }));
    return;
  }
  const id = decodeURIComponent(orderNumber);
  const { status, days } = ORDERS[id] ?? { status: 'processing', days: 7 };
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(
    JSON.stringify({
      orderNumber: id,
      status,
      expectedDelivery: new Date(Date.now() + days * DAY_MS).toISOString().slice(0, 10),
    }),
  );
}).listen(PORT, ORDERS_URL.hostname, () => {
  console.log(`fake orders API on ${ORDERS_URL.origin}`);
});
