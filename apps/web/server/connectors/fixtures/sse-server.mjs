#!/usr/bin/env node
/* global console, process */ // The root ESLint config declares no environment globals.
// A minimal, hand-written MCP server over the legacy HTTP+SSE transport, for this task's own Test
// Connection tests. Prints "PORT=<n>" once listening.
//
// Env vars this fixture reads:
//   REQUIRE_TOKEN   if set, `initialize` succeeds only when the Authorization header equals
//                   `Bearer <REQUIRE_TOKEN>` exactly; otherwise the stream carries a JSON-RPC error.
import { createServer } from 'node:http';

const requireToken = process.env.REQUIRE_TOKEN;
let streamRes = null;

const server = createServer((req, res) => {
  if (req.method === 'GET') {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    streamRes = res;
    res.write('event: endpoint\ndata: /messages\n\n');
    req.on('close', () => {
      if (streamRes === res) streamRes = null;
    });
    return;
  }
  if (req.method === 'POST' && req.url === '/messages') {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      let message;
      try {
        message = JSON.parse(body);
      } catch {
        res.writeHead(400).end();
        return;
      }
      res.writeHead(202).end();
      if (streamRes === null) return;

      if (message.method === 'initialize') {
        if (
          requireToken !== undefined &&
          req.headers['authorization'] !== `Bearer ${requireToken}`
        ) {
          streamRes.write(
            `event: message\ndata: ${JSON.stringify({
              jsonrpc: '2.0',
              id: message.id,
              error: { code: -32001, message: 'Unauthorized: bearer token rejected' },
            })}\n\n`,
          );
          return;
        }
        streamRes.write(
          `event: message\ndata: ${JSON.stringify({
            jsonrpc: '2.0',
            id: message.id,
            result: {
              protocolVersion: '2025-11-25',
              capabilities: {},
              serverInfo: { name: 'fixture-sse', version: '0.0.1' },
            },
          })}\n\n`,
        );
        return;
      }
      if (message.method === 'notifications/initialized') return;
      if (message.method === 'tools/list') {
        streamRes.write(
          `event: message\ndata: ${JSON.stringify({
            jsonrpc: '2.0',
            id: message.id,
            result: { tools: [{ name: 'echo' }, { name: 'ping' }, { name: 'time' }] },
          })}\n\n`,
        );
      }
    });
    return;
  }
  res.writeHead(404).end();
});

server.listen(Number(process.env.PORT ?? 0), '127.0.0.1', () => {
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  console.log(`PORT=${port}`);
});
