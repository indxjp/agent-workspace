#!/usr/bin/env node
/* global process, URL */ // The root ESLint config declares no environment globals.
// A stand-in for the company's workflow system, serving the routes `apis/workflow.openapi.json`
// declares on loopback. The tests start it; for a local demo:
//
//   WORKFLOW_TOKEN=dev-token IDENTITY_SECRET=... IDENTITY_AUDIENCE=<tool-id> IDENTITY_WORKSPACE=<workspace-id> \
//     PORT=8791 node workflow/fake-workflow.mjs
//
// and set servers[0].url in the document to http://127.0.0.1:8791/api/v1. Every request needs
// `Authorization: Bearer <token>`. `POST /requests/{id}/comments` stores the comment; approve and
// reject answer 200 and are logged, so a test can show the agent's tool never reaches them.
//
// Who is asking (ADR-0142). The tool opts in with `identity: secret(...)`, so each call carries a
// signed `x-aw-identity` header; the system verifies it with `verifyIdentity` and answers `401 { code }`
// for a missing or bad one. `data/access.json` (the archive's map) gives the departments the
// asserted `sub` covers: a ringi filed by another department is answered exactly like one that does
// not exist, so a caller cannot comment on it or learn that it is there.
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { IDENTITY_ASSERTION_HEADER, verifyIdentity } from '@indx-workspace/sdk';

export const BASE_PATH = '/api/v1';

const DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');

/** The ringi this stand-in holds open, by id, with the 起案部門 that filed each. */
const FILED = {
  'R-2026-0101': '製造本部 第3製造部',
  'R-2026-0102': '人事部 人事課',
};

const readBody = async (request) => {
  request.setEncoding('utf8');
  let text = '';
  for await (const chunk of request) text += chunk;
  return text;
};

/**
 * Start the fake workflow system. Resolves with its base URL (ending in `/api/v1`), `requests` and
 * `comments`. `identity` verifies the caller: `{ key, audience, workspace }`.
 */
export function startFakeWorkflow({
  token,
  identity,
  port = 0,
  accessFile = path.join(DATA_DIR, 'access.json'),
}) {
  const access = JSON.parse(readFileSync(accessFile, 'utf8'));
  const requests = [];
  const comments = [];

  const server = createServer(async (request, response) => {
    const send = (status, body) => {
      response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify(body));
    };
    const url = new URL(request.url ?? '/', 'http://workflow.invalid');
    requests.push({ method: request.method, path: url.pathname });
    if (request.headers.authorization !== `Bearer ${token}`) {
      send(401, { error: 'unauthorized' });
      return;
    }
    const route = /^\/api\/v1\/requests\/([^/]+)\/(comments|approve|reject)$/u.exec(url.pathname);
    if (request.method !== 'POST' || route === null) {
      send(404, { error: 'no such route' });
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
    const ringiId = decodeURIComponent(route[1]);
    const departments = Object.hasOwn(access, caller.payload.sub)
      ? access[caller.payload.sub].departments
      : [];
    const filedBy = Object.hasOwn(FILED, ringiId) ? FILED[ringiId] : null;
    if (filedBy === null || !departments.some((department) => filedBy.startsWith(department))) {
      send(404, { error: `no such ringi: ${ringiId}` });
      return;
    }
    let body;
    try {
      body = JSON.parse(await readBody(request));
    } catch {
      send(400, { error: 'the body must be JSON' });
      return;
    }
    if (route[2] !== 'comments') {
      send(200, { ok: true });
      return;
    }
    if (typeof body?.body !== 'string' || !Number.isInteger(body.revision)) {
      send(400, { error: 'revision and body are required' });
      return;
    }
    comments.push({
      ringiId,
      revision: body.revision,
      body: body.body,
      by: caller.payload.sub,
    });
    send(201, { commentId: `C-${String(comments.length).padStart(4, '0')}` });
  });

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const address = server.address();
      resolve({
        url: `http://127.0.0.1:${address.port}${BASE_PATH}`,
        requests,
        comments,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const workflow = await startFakeWorkflow({
    token: process.env.WORKFLOW_TOKEN ?? 'dev-token',
    identity: {
      key: process.env.IDENTITY_SECRET ?? '',
      audience: process.env.IDENTITY_AUDIENCE ?? '',
      workspace: process.env.IDENTITY_WORKSPACE ?? '',
    },
    port: Number(process.env.PORT ?? 8791),
  });
  process.stdout.write(`fake workflow on ${workflow.url}\n`);
}
