#!/usr/bin/env node
/* global console, process */ // The root ESLint config declares no environment globals.
// A minimal, hand-written MCP server over Streamable HTTP, for this task's own Test Connection
// tests. Prints "PORT=<n>" once listening, on a random port when process.env.PORT is 0/unset.
//
// Env vars this fixture reads:
//   REQUIRE_TOKEN   if set, `initialize` succeeds only when the Authorization header equals
//                   `Bearer <REQUIRE_TOKEN>` exactly; otherwise answers 401.
import { createServer } from 'node:http';

const requireToken = process.env.REQUIRE_TOKEN;

const server = createServer((req, res) => {
  if (req.method !== 'POST') {
    res.writeHead(405).end();
    return;
  }
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
    if (message.method === 'initialize') {
      if (requireToken !== undefined && req.headers['authorization'] !== `Bearer ${requireToken}`) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: message.id,
            error: { code: -32001, message: 'Unauthorized: bearer token rejected' },
          }),
        );
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: message.id,
          result: {
            protocolVersion: '2025-11-25',
            capabilities: {},
            serverInfo: { name: 'fixture-http', version: '0.0.1' },
          },
        }),
      );
      return;
    }
    if (message.method === 'notifications/initialized') {
      res.writeHead(202).end();
      return;
    }
    if (message.method === 'tools/list') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: message.id,
          result: { tools: [{ name: 'echo' }, { name: 'ping' }, { name: 'time' }] },
        }),
      );
      return;
    }
    res.writeHead(404).end();
  });
});

server.listen(Number(process.env.PORT ?? 0), '127.0.0.1', () => {
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  console.log(`PORT=${port}`);
});
