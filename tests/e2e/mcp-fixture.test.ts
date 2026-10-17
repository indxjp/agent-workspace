import { once } from 'node:events';
import { spawn, type ChildProcess } from 'node:child_process';

import { afterEach, describe, expect, it } from 'vitest';

const children: ChildProcess[] = [];

afterEach(() => {
  for (const child of children.splice(0)) child.kill();
});

describe('deterministic E2E MCP fixture', () => {
  it('supports initialize, tools/list, and echo calls', async () => {
    const port = 24_319;
    const child = spawn(process.execPath, ['tests/e2e/mcp-fixture.mjs'], {
      env: { ...process.env, E2E_MCP_PORT: String(port) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.push(child);
    if (child.stdout === null) throw new Error('fixture stdout pipe was not created');
    await once(child.stdout, 'data');
    const url = `http://127.0.0.1:${String(port)}/mcp`;
    const initialize = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    expect(initialize.status).toBe(200);
    expect(initialize.headers.get('mcp-session-id')).toBeTruthy();
    const listed = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
    });
    await expect(listed.json()).resolves.toMatchObject({ result: { tools: [{ name: 'echo' }] } });
    const called = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'echo', arguments: { text: 'violet-orchid-731' } },
      }),
    });
    await expect(called.json()).resolves.toMatchObject({
      result: { content: [{ type: 'text', text: 'violet-orchid-731' }] },
    });
  });
});
