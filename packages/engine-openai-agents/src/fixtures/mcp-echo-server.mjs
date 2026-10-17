#!/usr/bin/env node
/**
 * A minimal stdio MCP server for `boundary.test.ts` (ENG-09, #308): one tool, `echo`, which
 * answers its `text` argument. Newline-delimited JSON-RPC over stdin/stdout, which is the stdio
 * transport the MCP specification defines; nothing else is implemented.
 */
import process from 'node:process';
import { createInterface } from 'node:readline';

const lines = createInterface({ input: process.stdin });

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

lines.on('line', (line) => {
  if (line.trim() === '') return;
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  switch (request.method) {
    case 'initialize':
      send({
        jsonrpc: '2.0',
        id: request.id,
        result: {
          protocolVersion: request.params?.protocolVersion ?? '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'echo', version: '1.0.0' },
        },
      });
      return;
    case 'tools/list':
      send({
        jsonrpc: '2.0',
        id: request.id,
        result: {
          tools: [
            {
              name: 'echo',
              description: 'Answer the text it is given.',
              inputSchema: {
                type: 'object',
                properties: { text: { type: 'string' } },
                required: ['text'],
                additionalProperties: false,
              },
            },
          ],
        },
      });
      return;
    case 'tools/call':
      send({
        jsonrpc: '2.0',
        id: request.id,
        result: {
          content: [{ type: 'text', text: `echo: ${String(request.params?.arguments?.text)}` }],
        },
      });
      return;
    default:
      send({ jsonrpc: '2.0', id: request.id, result: {} });
  }
});
