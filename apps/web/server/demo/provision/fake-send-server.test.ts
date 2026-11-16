import { spawn } from 'node:child_process';

import { DEMO_SEND_RESULT } from '@indx-workspace/contracts/demo';
import { describe, expect, it } from 'vitest';

import { FAKE_SEND_DEFAULT_TOOL, fakeSendServerCommand } from './fake-send-server';

/** Send `requests`, one per line, to a stand-in and read one answer line per request with an id. */
async function converse(
  toolNames: readonly string[],
  requests: readonly unknown[],
): Promise<readonly Record<string, unknown>[]> {
  const { command, args } = fakeSendServerCommand(toolNames);
  // The stand-in runs with no secret and no proxy in its environment, as in a sandbox.
  expect(command).toBe('node');
  const child = spawn(process.execPath, [...args], { stdio: 'pipe', env: { NODE_ENV: 'test' } });
  const answered = requests.filter(
    (request) => (request as { id?: unknown }).id !== undefined,
  ).length;
  const lines: string[] = [];
  let buffered = '';
  const done = new Promise<void>((resolve, reject) => {
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buffered += chunk;
      const parts = buffered.split('\n');
      buffered = parts.pop() ?? '';
      lines.push(...parts.filter((part) => part !== ''));
      if (lines.length >= answered) resolve();
    });
    child.on('error', reject);
  });
  for (const request of requests) child.stdin.write(`${JSON.stringify(request)}\n`);
  await done;
  child.kill();
  return lines.map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('the demo stand-in server', () => {
  it('answers every tool call with the demo-only result, whatever the call asks', async () => {
    const [list, call, other] = await converse(
      ['createTask', 'postComment'],
      [
        { jsonrpc: '2.0', id: 1, method: 'tools/list' },
        {
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: { name: 'createTask', arguments: { to: 'someone@example.test', body: 'hi' } },
        },
        { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'postComment' } },
      ],
    );
    const offered = (list?.['result'] as { tools: { name: string }[] }).tools.map((t) => t.name);
    expect(offered).toEqual(['createTask', 'postComment']);
    for (const answer of [call, other]) {
      expect(answer?.['result']).toMatchObject({
        content: [{ type: 'text', text: DEMO_SEND_RESULT.en }],
      });
    }
  });

  it('records the call it was given, and says it delivered nothing', async () => {
    const [call, bare] = await converse(
      ['createTask'],
      [
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'createTask', arguments: { to: 'someone@example.test', body: 'hi' } },
        },
        { jsonrpc: '2.0', id: 2, method: 'tools/call' },
      ],
    );
    expect(call?.['result']).toMatchObject({
      structuredContent: {
        demoOnly: true,
        delivered: false,
        tool: 'createTask',
        arguments: { to: 'someone@example.test', body: 'hi' },
      },
    });
    expect(bare?.['result']).toMatchObject({
      structuredContent: { delivered: false, tool: null, arguments: null },
    });
  });

  it('offers one send tool when the connector it replaces names no operation', async () => {
    const [list] = await converse([], [{ jsonrpc: '2.0', id: 1, method: 'tools/list' }]);
    const tools = (list?.['result'] as { tools: { name: string }[] }).tools;
    expect(tools.map((tool) => tool.name)).toEqual([FAKE_SEND_DEFAULT_TOOL]);
  });

  it('answers a method it does not know with an error, and a notification with nothing', async () => {
    const answers = await converse(
      [],
      [
        { jsonrpc: '2.0', method: 'notifications/initialized' },
        { jsonrpc: '2.0', id: 9, method: 'resources/read' },
      ],
    );
    expect(answers).toHaveLength(1);
    expect(answers[0]?.['error']).toMatchObject({ code: -32601 });
  });

  it('has no code that could reach anything outside its own standard input and output', () => {
    const source = fakeSendServerCommand([]).args[1] ?? '';
    for (const reach of [
      'require',
      'import',
      'fetch',
      'XMLHttpRequest',
      'WebSocket',
      'child_process',
      'process.env',
      'process.binding',
      'eval',
      'Function(',
      'http',
      'net.',
      'dgram',
    ]) {
      expect(source, `the stand-in must not mention ${reach}`).not.toContain(reach);
    }
  });
});
