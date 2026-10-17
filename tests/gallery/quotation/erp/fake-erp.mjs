#!/usr/bin/env node
/* global process, URL */ // The root ESLint config declares no environment globals.
// A stand-in for the company ERP's read API, serving `data/erp/*.json` exactly as
// `apis/erp.openapi.json` describes it, on loopback. The tests start it; for a local demo:
//
//   ERP_TOKEN=dev-token PORT=8790 node erp/fake-erp.mjs
//
// Every request needs `Authorization: Bearer <token>`, as the real ERP would, so a test can show
// the credential the tool gateway presents is the connector's, not the caller's.
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'erp');
export const BASE_PATH = '/api/v1';

const readJson = (dir, name) => JSON.parse(readFileSync(path.join(dir, name), 'utf8'));

/** Start the fake ERP. Resolves with its base URL (ending in `/api/v1`) and a `close()`. */
export function startFakeErp({ token, port = 0, dataDir = DATA_DIR }) {
  const parts = readJson(dataDir, 'parts.json');
  const orders = readJson(dataDir, 'orders.json');
  const rates = readJson(dataDir, 'rates.json');
  const requests = [];

  const server = createServer((request, response) => {
    const send = (status, body) => {
      response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify(body));
    };
    const url = new URL(request.url ?? '/', 'http://erp.invalid');
    requests.push({ method: request.method, path: url.pathname + url.search });
    if (request.headers.authorization !== `Bearer ${token}`) {
      send(401, { error: 'unauthorized' });
      return;
    }
    if (request.method !== 'GET') {
      send(405, { error: 'this API is read-only' });
      return;
    }
    const route = url.pathname.startsWith(`${BASE_PATH}/`)
      ? url.pathname.slice(BASE_PATH.length)
      : null;
    if (route === '/parts/search') {
      const q = (url.searchParams.get('q') ?? '').trim();
      const material = url.searchParams.get('material');
      if (q === '') {
        send(400, { error: 'q is required' });
        return;
      }
      send(
        200,
        parts.filter(
          (part) =>
            (material === null || part.material === material) &&
            (part.name.includes(q) || q.includes(part.kind)),
        ),
      );
      return;
    }
    const order = /^\/orders\/([^/]+)$/u.exec(route ?? '');
    if (order) {
      const found = orders.find((entry) => entry.orderNo === decodeURIComponent(order[1]));
      if (found === undefined) send(404, { error: 'no such order' });
      else send(200, found);
      return;
    }
    const rate = /^\/rates\/([^/]+)$/u.exec(route ?? '');
    if (rate) {
      const found = rates[decodeURIComponent(rate[1])];
      if (found === undefined) send(404, { error: 'no rate for that material' });
      else send(200, found);
      return;
    }
    send(404, { error: 'no such route' });
  });

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const address = server.address();
      resolve({
        url: `http://127.0.0.1:${address.port}${BASE_PATH}`,
        requests,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const erp = await startFakeErp({
    token: process.env.ERP_TOKEN ?? 'dev-token',
    port: Number(process.env.PORT ?? 8790),
  });
  process.stdout.write(`fake ERP on ${erp.url}\n`);
}
