#!/usr/bin/env node
/* global process */ // The root ESLint config declares no environment globals.
// A minimal, hand-written MCP server over stdio, for this task's own Test Connection tests. Not a
// dependency of product code — see `../classify.ts`'s header for why product code speaks the wire
// protocol directly rather than depending on the reference MCP server SDK.
//
// Env vars this fixture reads:
//   REQUIRE_TOKEN   if set, `initialize` succeeds only when MCP_TOKEN equals it exactly.
import { createInterface } from 'node:readline';

const requireToken = process.env.REQUIRE_TOKEN;
const rl = createInterface({ input: process.stdin });

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

rl.on('line', (line) => {
  if (line.trim() === '') return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.method === 'initialize') {
    if (requireToken !== undefined && process.env.MCP_TOKEN !== requireToken) {
      send({
        jsonrpc: '2.0',
        id: message.id,
        error: {
          code: -32001,
          message: `Unauthorized: environment variable MCP_TOKEN is ${
            process.env.MCP_TOKEN === undefined ? 'not set' : 'set but rejected'
          }.`,
        },
      });
      return;
    }
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        protocolVersion: '2025-11-25',
        capabilities: {},
        serverInfo: { name: 'fixture-stdio', version: '0.0.1' },
      },
    });
    return;
  }
  if (message.method === 'notifications/initialized') return;
  if (message.method === 'tools/list') {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: { tools: [{ name: 'echo' }, { name: 'ping' }, { name: 'time' }] },
    });
  }
});
