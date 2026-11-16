import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, describe, expect, it } from 'vitest';

import { StackClient, assistantText, parseSseFrames, terminalStatus } from './stack-api.mjs';

/**
 * An HTTP/1.1 server in its own process that answers 200 and, like an edge or NAT that dropped an
 * idle flow, resets a kept-alive connection whose next bytes come more than 300 ms after its last
 * answer.
 */
const FORGETFUL_SERVER = `
const net = require('node:net');
const server = net.createServer((socket) => {
  let last = Date.now();
  let buffered = '';
  socket.on('data', (chunk) => {
    if (Date.now() - last > 300) return socket.resetAndDestroy();
    buffered += chunk;
    for (;;) {
      const end = buffered.indexOf('\\r\\n\\r\\n');
      if (end < 0) return;
      const head = buffered.slice(0, end + 4);
      const length = Number(/content-length: *(\\d+)/iu.exec(head)?.[1] ?? 0);
      if (buffered.length < end + 4 + length) return;
      buffered = buffered.slice(end + 4 + length);
      const close = /connection: *close/iu.test(head);
      socket.write('HTTP/1.1 200 OK\\r\\ncontent-type: application/json\\r\\ncontent-length: 2\\r\\n' +
        (close ? 'connection: close\\r\\n' : '') + '\\r\\n{}');
      if (close) socket.end();
      last = Date.now();
    }
  });
});
// Written, not console.log'd: under FORCE_COLOR (CI sets it) console.log colours a number.
server.listen(0, '127.0.0.1', () => process.stdout.write(String(server.address().port) + '\\n'));
`;

const servers: ChildProcess[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.kill();
});

/** A run's event stream as `apps/web/server/runs/sse.ts` writes it. */
const STREAM = [
  'retry: 2000',
  '',
  ': keep-alive',
  '',
  'event: run.status',
  'id: 1',
  'data: {"status":"running","error":null}',
  '',
  'event: agent.message',
  'id: 2',
  'data: {"frame":"agent.message","role":"user","messageId":"u1","blocks":[{"type":"text","text":"hi e2e-nonce-a"}]}',
  '',
  'event: agent.message',
  'id: 3',
  'data: {"frame":"agent.message","role":"assistant","messageId":"m1","blocks":[{"type":"reasoning","text":"thinking"},{"type":"text","text":"Fake Anthropic reply."}]}',
  '',
  'event: run.status',
  'id: 4',
  'data: {"status":"completed","error":null}',
  '',
  'event: done',
  'data: {}',
  '',
  '',
].join('\n');

describe('the generated-project E2E reads a run’s event stream', () => {
  it('splits frames and skips retry and comment lines', () => {
    expect(parseSseFrames(STREAM).map(({ event, id }) => [event, id])).toEqual([
      ['run.status', '1'],
      ['agent.message', '2'],
      ['agent.message', '3'],
      ['run.status', '4'],
      ['done', null],
    ]);
  });

  it('keeps only the assistant’s text blocks', () => {
    expect(assistantText(parseSseFrames(STREAM))).toBe('Fake Anthropic reply.');
  });

  it('reports the terminal status, including a run-failed frame', () => {
    expect(terminalStatus(parseSseFrames(STREAM))).toBe('completed');
    const failed = `${STREAM}event: run-failed\ndata: {"status":"failed","message":"x"}\n\n`;
    expect(terminalStatus(parseSseFrames(failed))).toBe('failed');
    expect(terminalStatus([])).toBeNull();
  });
});

describe('the stack client', () => {
  it('survives a synchronous child that blocks the event loop while the server drops the connection', async () => {
    const server = spawn(process.execPath, ['-e', FORGETFUL_SERVER], {
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    servers.push(server);
    const [line] = (await once(server.stdout, 'data')) as [Buffer];
    const port = String(line).trim();
    expect(port).toMatch(/^\d+$/u);
    const client = new StackClient(`http://127.0.0.1:${port}`);

    expect((await client.request('/api/agents')).status).toBe(200);
    await delay(50);
    // As the journeys' `aw` children do: undici's keep-alive timer cannot run meanwhile.
    spawnSync('sleep', ['0.6']);
    const started = await client.request('/api/agents/a/runs', { method: 'POST', body: {} });

    expect(started.status).toBe(200);
  });
});
