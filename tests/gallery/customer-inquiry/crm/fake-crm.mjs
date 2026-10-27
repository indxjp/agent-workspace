/* global URL */ // The root ESLint config declares no environment globals.
// A stand-in for the company CRM's read API, serving `data/crm/*.json` as
// `apis/crm.openapi.json` describes it, on loopback. The tests start it.
//
// The CRM, not the agent, keeps two rules, because the platform redacts nothing:
//
// 1. Whose records. Every request carries the connector's credential (`Authorization: Bearer`)
//    and the platform's identity assertion (`x-aw-identity`, ADR-0142), which this server VERIFIES
//    with `verifyIdentity`: signature, expiry, this connector as audience, this workspace. The
//    assertion's `sub` is the customer id (an `api-key` caller only: the chat backend starts the
//    run with `subject: customerId`), and only that customer's records are ever answered. A
//    missing or invalid assertion is a 401. An interaction of another customer is a 404 in the
//    same words as an id that does not exist, so the refusal does not confirm that it exists.
// 2. Personal data. Every string it returns is masked (../lib/pii.mjs): phone numbers, e-mail
//    addresses, postal codes and street addresses become ［電話番号］, ［メール］, ［郵便番号］,
//    ［住所］. The customer's own phone, e-mail and address are never returned as fields at all.
import { readdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  IDENTITY_ASSERTION_HEADER,
  verifyIdentity,
} from '@indx-workspace/contracts/identity-assertion';

import { createIndex } from '../../shared/jp-search.mjs';
import { maskDeep } from '../lib/pii.mjs';

const DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'crm');
export const BASE_PATH = '/api/v1';
/** The company's own numbers, which may appear in answers. */
const PUBLIC_NUMBERS = ['0120-555-310'];

const summary = ({ id, date, channel, subject, body, outcome }) => ({
  id,
  date,
  channel,
  subject,
  snippet: body.slice(0, 60),
  outcome,
});

/**
 * Start the fake CRM. `key` signs the identity assertions it accepts; `connectorId` and `workspace`
 * are the audience and workspace it serves. Resolves with its base URL (ending in `/api/v1`), the
 * requests it received and a `close()`.
 */
export function startFakeCrm({ token, key, connectorId, workspace, port = 0, dataDir = DATA_DIR }) {
  const customers = new Map(
    readdirSync(dataDir)
      .filter((name) => name.endsWith('.json'))
      .sort()
      .map((name) => {
        const record = JSON.parse(readFileSync(path.join(dataDir, name), 'utf8'));
        return [record.customerId, record];
      }),
  );
  const interactions = [...customers.values()].flatMap((customer) =>
    customer.interactions.map((entry) => ({
      ...entry,
      customerId: customer.customerId,
      title: entry.subject,
      text: `${entry.channel} ${entry.body} ${entry.outcome}`,
    })),
  );
  const history = createIndex(interactions);
  const requests = [];

  const server = createServer((request, response) => {
    const send = (status, body) => {
      response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify(body));
    };
    const url = new URL(request.url ?? '/', 'http://crm.invalid');
    requests.push({ method: request.method, path: url.pathname + url.search });
    handle(request, url, send).catch(() => send(500, { error: 'internal error' }));
  });

  async function handle(request, url, send) {
    if (request.headers.authorization !== `Bearer ${token}`) {
      send(401, { error: 'unauthorized' });
      return;
    }
    const assertion = request.headers[IDENTITY_ASSERTION_HEADER];
    const verified =
      typeof assertion === 'string'
        ? await verifyIdentity(assertion, key, new Date(), { audience: connectorId, workspace })
        : { ok: false, code: 'identity_assertion_invalid' };
    if (!verified.ok) {
      send(401, { error: verified.code });
      return;
    }
    if (request.method !== 'GET') {
      send(405, { error: 'this API is read-only' });
      return;
    }
    // The chat backend starts the run with its API key and `subject: customerId`; any other kind of
    // caller (a workspace member, a widget visitor) is not a signed-in customer.
    const customer =
      verified.payload.principalKind === 'api-key'
        ? customers.get(verified.payload.sub)
        : undefined;
    if (customer === undefined) {
      send(403, { error: 'no such customer' });
      return;
    }
    // The customer's own values are masked verbatim, and every pattern; the company's numbers stay.
    const masked = (value) =>
      maskDeep(value, {
        known: [customer.phone, customer.email, customer.address],
        allow: PUBLIC_NUMBERS,
      });

    const route = url.pathname.startsWith(`${BASE_PATH}/`)
      ? url.pathname.slice(BASE_PATH.length)
      : null;
    if (route === '/interactions/search') {
      const q = (url.searchParams.get('q') ?? '').trim();
      if (q === '') {
        send(400, { error: 'q is required' });
        return;
      }
      const hits = history.search(q, {
        limit: 5,
        filter: (entry) => entry.customerId === customer.customerId,
        minCoverage: 0.25,
      });
      // Mask the whole text before cutting the snippet, or a cut could split a number in two and
      // leave half of it unmasked (〒154-001…).
      send(
        200,
        hits.map((hit) => ({ ...summary(masked(hit)), score: hit.score })),
      );
      return;
    }
    const one = /^\/interactions\/([^/]+)$/u.exec(route ?? '');
    if (one) {
      const entry = interactions.find((candidate) => candidate.id === decodeURIComponent(one[1]));
      // Same words for "not yours" and "not there": the refusal must not confirm the id exists.
      if (entry?.customerId !== customer.customerId) {
        send(404, { error: "no interaction with that id in this customer's history" });
        return;
      }
      const { id, date, channel, subject, body, outcome } = entry;
      send(200, masked({ id, date, channel, subject, body, outcome }));
      return;
    }
    send(404, { error: 'no such route' });
  }

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
