/* global console */

import { createServer } from 'node:http';
import process from 'node:process';
import { randomUUID } from 'node:crypto';

const port = Number.parseInt(process.env.E2E_MCP_PORT ?? '4319', 10);
const host = process.env.E2E_MCP_HOST ?? '127.0.0.1';

function send(response, status, value, headers = {}) {
  response.writeHead(status, { 'content-type': 'application/json', ...headers });
  response.end(value === null ? '' : JSON.stringify(value));
}

function result(id, value) {
  return { jsonrpc: '2.0', id, result: value };
}

const server = createServer((request, response) => {
  if (request.method === 'GET' && request.url === '/healthz') {
    send(response, 200, { ok: true });
    return;
  }
  if (request.method !== 'POST' || request.url !== '/mcp') {
    send(response, 404, { error: 'not_found' });
    return;
  }

  let source = '';
  request.setEncoding('utf8');
  request.on('data', (chunk) => {
    source += chunk;
    if (source.length > 64 * 1024) request.destroy();
  });
  request.on('end', () => {
    let frame;
    try {
      frame = JSON.parse(source);
    } catch {
      send(response, 400, { error: 'invalid_json' });
      return;
    }
    const session = request.headers['mcp-session-id'] ?? randomUUID();
    const headers = { 'mcp-session-id': String(session) };
    if (frame.method === 'notifications/initialized') {
      send(response, 202, null, headers);
      return;
    }
    if (frame.method === 'initialize') {
      send(
        response,
        200,
        result(frame.id, {
          protocolVersion: '2025-11-25',
          capabilities: { tools: {} },
          serverInfo: { name: 'agent-workspace-e2e-fixture', version: '1.0.0' },
        }),
        headers,
      );
      return;
    }
    if (frame.method === 'tools/list') {
      send(
        response,
        200,
        result(frame.id, {
          tools: [
            {
              name: 'echo',
              description: 'Return the supplied text unchanged for deterministic E2E assertions.',
              inputSchema: {
                type: 'object',
                properties: { text: { type: 'string' } },
                required: ['text'],
                additionalProperties: false,
              },
            },
          ],
        }),
        headers,
      );
      return;
    }
    if (frame.method === 'tools/call' && frame.params?.name === 'echo') {
      const text =
        typeof frame.params.arguments?.text === 'string' ? frame.params.arguments.text : '';
      send(response, 200, result(frame.id, { content: [{ type: 'text', text }] }), headers);
      return;
    }
    send(
      response,
      200,
      {
        jsonrpc: '2.0',
        id: frame.id ?? null,
        error: { code: -32601, message: 'Method not found' },
      },
      headers,
    );
  });
});

server.listen(port, host, () => {
  console.log(`deterministic MCP fixture listening at http://${host}:${String(port)}/mcp`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
