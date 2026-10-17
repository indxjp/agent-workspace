/* global console, process */
/**
 * The fake model of the tool-sandbox E2E (`tool-sandbox.e2e.mjs`, issue #847), run in a container
 * on the compose stack's network as `api.anthropic.com`: the journey's tool-calling fake
 * (`../journey/fake-anthropic-tools.mjs`) behind TLS, with a plain-HTTP control port.
 *
 * `GET /healthz` answers when it is up; `GET /requests` lists what it was asked
 * (`toolRequests[].toolNames` is what the run offered the model, so the E2E can read that the code
 * tool arrived through the gateway's tool sandbox route).
 */
import { readFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';

import { createAnthropicToolsHandler } from '../journey/fake-anthropic-tools.mjs';

const requests = [];
const toolRequests = [];
const handle = createAnthropicToolsHandler(requests, toolRequests);

function sendJson(response, status, value) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(value));
}

const api = createHttpsServer(
  {
    cert: readFileSync(process.env['FAKE_ANTHROPIC_TLS_CERT'] ?? '/e2e/api.anthropic.com.pem'),
    key: readFileSync(process.env['FAKE_ANTHROPIC_TLS_KEY'] ?? '/e2e/api.anthropic.com.key'),
  },
  (request, response) => {
    handle(request, response).catch((error) => {
      console.error(error);
      if (!response.headersSent) sendJson(response, 500, { type: 'error' });
      else response.destroy();
    });
  },
);
const control = createHttpServer((request, response) => {
  if (request.url === '/healthz') sendJson(response, 200, { ok: true });
  else if (request.url === '/requests') sendJson(response, 200, { requests, toolRequests });
  else sendJson(response, 404, { error: 'not_found' });
});

await new Promise((resolve) => api.listen(443, '0.0.0.0', resolve));
await new Promise((resolve) => control.listen(8081, '0.0.0.0', resolve));
console.log('fake Anthropic API with tools on :443, control on :8081');
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.once(signal, () => {
    api.close();
    control.close();
  });
}
