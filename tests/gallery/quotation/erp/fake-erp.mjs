#!/usr/bin/env node
/* global process, URL */ // The root ESLint config declares no environment globals.
// A stand-in for the company ERP's API, serving `data/erp/*.json` exactly as
// `apis/erp.openapi.json` describes it, on loopback. The tests start it; for a local demo:
//
//   ERP_TOKEN=dev-token ERP_IDENTITY_SECRET=... IDENTITY_AUDIENCE=<tool-id> IDENTITY_WORKSPACE=<workspace-id> \
//     PORT=8790 node erp/fake-erp.mjs
//
// Every request needs `Authorization: Bearer <token>`, as the real ERP would, so a test can show
// the credential the tool gateway presents is the connector's, not the caller's.
//
// Who is asking (ADR-0142). The tool opts in with `identity: secret(...)`, so each call also carries
// a signed `x-aw-identity` header; the ERP verifies it with `verifyIdentity` and answers `401 { code }`
// for a missing or bad one. `data/erp/access.json` maps the asserted `sub` to the customers that
// salesperson may see: other customers' parts and orders are not listed, and reading one of their
// orders is answered exactly like an order that does not exist. Rates are the same for everyone.
//
// The one write is `POST /quotes` (`createQuote`): it books a quote for a customer the caller may see
// and answers 201 with the new quote number. It is logged in `requests` with its parsed body, so a
// test can show what reached the ERP and, as important, that nothing did before an approval.
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { IDENTITY_ASSERTION_HEADER, verifyIdentity } from '@indx-workspace/sdk';

const DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'erp');
export const BASE_PATH = '/api/v1';

const readBody = async (request) => {
  request.setEncoding('utf8');
  let text = '';
  for await (const chunk of request) text += chunk;
  return text;
};

const readJson = (dir, name) => JSON.parse(readFileSync(path.join(dir, name), 'utf8'));

/**
 * Start the fake ERP. Resolves with its base URL (ending in `/api/v1`) and a `close()`. `identity` is
 * what verifies the caller: `{ key, audience, workspace }`, `key` a string or a list while it rotates.
 */
export function startFakeErp({ token, identity, port = 0, dataDir = DATA_DIR }) {
  const parts = readJson(dataDir, 'parts.json');
  const orders = readJson(dataDir, 'orders.json');
  const rates = readJson(dataDir, 'rates.json');
  const access = readJson(dataDir, 'access.json');
  const requests = [];
  let booked = 0;

  const server = createServer(async (request, response) => {
    const send = (status, body) => {
      response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify(body));
    };
    const url = new URL(request.url ?? '/', 'http://erp.invalid');
    const entry = { method: request.method, path: url.pathname + url.search };
    requests.push(entry);
    if (request.headers.authorization !== `Bearer ${token}`) {
      send(401, { error: 'unauthorized' });
      return;
    }
    if (
      request.method !== 'GET' &&
      !(request.method === 'POST' && url.pathname === `${BASE_PATH}/quotes`)
    ) {
      send(405, { error: 'method not allowed' });
      return;
    }
    const caller = await verifyIdentity(
      request.headers[IDENTITY_ASSERTION_HEADER] ?? '',
      identity.key,
      new Date(),
      { audience: identity.audience, workspace: identity.workspace },
    );
    if (!caller.ok) {
      send(401, { code: caller.code });
      return;
    }
    if (!Object.hasOwn(access, caller.payload.sub)) {
      send(403, { error: 'no access: this caller is not registered for this API' });
      return;
    }
    const { customers } = access[caller.payload.sub];
    if (request.method === 'POST') {
      let quote;
      try {
        quote = JSON.parse(await readBody(request));
      } catch {
        send(400, { error: 'the body must be JSON' });
        return;
      }
      entry.body = quote;
      entry.by = caller.payload.sub;
      if (typeof quote !== 'object' || quote === null || typeof quote.customer !== 'string') {
        send(400, { error: 'customer is required' });
        return;
      }
      if (!customers.includes(quote.customer)) {
        send(403, { error: 'no access: this caller does not handle that customer' });
        return;
      }
      booked += 1;
      send(201, { quoteNo: `QT-${String(booked).padStart(4, '0')}` });
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
            customers.includes(part.customer) &&
            (material === null || part.material === material) &&
            (part.name.includes(q) || q.includes(part.kind)),
        ),
      );
      return;
    }
    const order = /^\/orders\/([^/]+)$/u.exec(route ?? '');
    if (order) {
      const found = orders.find((entry) => entry.orderNo === decodeURIComponent(order[1]));
      if (found === undefined || !customers.includes(found.customer)) {
        send(404, { error: 'no such order' });
      } else send(200, found);
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
    identity: {
      key: (process.env.ERP_IDENTITY_SECRET ?? '').split(','),
      audience: process.env.IDENTITY_AUDIENCE ?? '',
      workspace: process.env.IDENTITY_WORKSPACE ?? '',
    },
    port: Number(process.env.PORT ?? 8790),
  });
  process.stdout.write(`fake ERP on ${erp.url}\n`);
}
