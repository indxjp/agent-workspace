/**
 * The safety invariant "demo agents touch sample data only, nothing really sent or written
 * outside", proven end to end for the provisioner: a template agent whose tools would send mail,
 * post a comment and write to a tracker is copied for a visitor; the visitor's copy has no way out
 * (no address, no secret, no network used while copying), and the stand-in it was given, run as
 * the sandbox would run it, answers every call with the demo-only result and does nothing else.
 */
import { spawn } from 'node:child_process';
import net from 'node:net';

import { DEMO_SEND_RESULT } from '@indx-workspace/contracts/demo';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { TemplateSpec } from './templates.contract';
import { createMemoryTemplatesWorld } from './templates.world.test-support';

const SPEC: TemplateSpec = {
  agent: {
    name: 'mailer-agent',
    instructions: 'Send the follow-up.',
    maxTurns: 6,
    maxBudgetUsd: 0.2,
  },
  files: [{ path: 'deals/q1.csv', text: 'id,amount\n1,100\n' }],
  assign: [{ path: 'deals', access: 'read' }],
  connectors: [
    { kind: 'mcp', name: 'mailer' },
    { kind: 'openapi-write', name: 'tracker' },
    { kind: 'openapi-read', name: 'catalogue' },
  ],
};

/** Call `tool` on the stand-in the way an MCP client would; what it answered. */
async function callStandIn(
  args: readonly string[],
  tool: string,
  input: Record<string, unknown>,
): Promise<unknown> {
  const child = spawn(process.execPath, [...args], { stdio: 'pipe', env: { NODE_ENV: 'test' } });
  const answer = new Promise<unknown>((resolve, reject) => {
    let buffered = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buffered += chunk;
      const line = buffered.split('\n')[0];
      if (buffered.includes('\n') && line !== undefined) resolve(JSON.parse(line));
    });
    child.on('error', reject);
  });
  child.stdin.write(
    `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: input } })}\n`,
  );
  const result = await answer;
  child.kill();
  return result;
}

describe('fake sends in a visitor copy', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('makes no network call while copying, and leaves the copy no way to reach outside', async () => {
    const world = createMemoryTemplatesWorld();
    const entry = world.entry('mail');
    await world.seedTemplate(entry, SPEC);
    const guest = await world.newGuest();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const connectSpy = vi.spyOn(net.Socket.prototype, 'connect');

    await world.templates.copyInto({
      entry,
      workspaceId: guest.workspaceId,
      guestUserId: guest.userId,
      limits: { maxTurns: null, maxBudgetUsd: null },
      now: new Date(),
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(connectSpy).not.toHaveBeenCalled();
    const copied = await world.connectors(guest.workspaceId);
    // The reader is not carried; the two that could send or write are stand-ins, nothing else.
    expect(copied.map((connector) => connector.name).sort()).toEqual(['mailer', 'tracker']);
    for (const connector of copied) {
      expect(connector).toMatchObject({ transport: 'stdio', url: null, hasCredential: false });
    }
  });

  it('answers every call a copied send or write tool gets with the demo-only result', async () => {
    const world = createMemoryTemplatesWorld();
    const entry = world.entry('answer');
    await world.seedTemplate(entry, SPEC);
    const guest = await world.newGuest();
    await world.templates.copyInto({
      entry,
      workspaceId: guest.workspaceId,
      guestUserId: guest.userId,
      limits: { maxTurns: null, maxBudgetUsd: null },
      now: new Date(),
    });
    const copied = await world.connectors(guest.workspaceId);
    const byName = Object.fromEntries(
      copied.map((connector) => {
        expect(connector.transport).toBe('stdio');
        if (connector.transport !== 'stdio') throw new Error(`${connector.name} is not a stand-in`);
        return [connector.name, connector.args];
      }),
    );
    const mail = await callStandIn(byName['mailer'] ?? [], 'send', {
      to: 'customer@example.com',
      body: 'hello',
    });
    const write = await callStandIn(byName['tracker'] ?? [], 'createPet', { name: 'x' });
    for (const answer of [mail, write]) {
      expect(answer).toMatchObject({
        result: { content: [{ type: 'text', text: DEMO_SEND_RESULT.en }] },
      });
    }
    // The stand-in recorded each call and delivered neither.
    expect(mail).toMatchObject({
      result: {
        structuredContent: {
          delivered: false,
          tool: 'send',
          arguments: { to: 'customer@example.com', body: 'hello' },
        },
      },
    });
    expect(write).toMatchObject({
      result: {
        structuredContent: { delivered: false, tool: 'createPet', arguments: { name: 'x' } },
      },
    });
  });
});
