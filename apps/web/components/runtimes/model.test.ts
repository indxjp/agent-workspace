import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  RUNTIME_OPTIONS,
  SWITCH_COMPARISON,
  draftRuntimeNetworkPolicy,
  runtimeConnectionIdFor,
  testRuntime,
  testSelectedRuntime,
} from './model';

const spec = readFileSync(path.resolve('docs/spec.md'), 'utf8');
const mockup = readFileSync(path.resolve('ui/runtimes.html'), 'utf8');

describe('runtime picker transcription', () => {
  it('has exactly the option labels and order printed by section 14.8', () => {
    const block = spec.match(/## 14\.8[\s\S]*?```text\s*([\s\S]*?)```/u)?.[1] ?? '';
    const parsed = block
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => /^[○●]/u.test(line))
      .map((line) =>
        line
          .replace(/^[○●]\s*/u, '')
          .split(/\s{2,}/u)[0]
          ?.replace(' (development only)', ''),
      )
      .filter((label): label is string => label !== undefined && label !== 'Managed sandbox');
    expect(RUNTIME_OPTIONS.map((option) => option.label)).toEqual(parsed);
  });

  it('uses the two disabled reasons from the mockup, not shortened spec variants', () => {
    const agentCore = RUNTIME_OPTIONS.find((option) => option.id === 'aws-agentcore');
    const ecs = RUNTIME_OPTIONS.find((option) => option.id === 'aws-ecs');
    expect(agentCore?.defaultReason).toBe(
      'Image not published to ECR for this account (arm64 required).',
    );
    expect(ecs?.defaultReason).toBe('Not configured — no task definition registered.');
    expect(mockup).toContain(agentCore?.defaultReason);
    expect(mockup).toContain(ecs?.defaultReason);
  });

  it('transcribes the switch comparison character for character from section 14.9', () => {
    const block = spec.match(/```text\s*(Changing runtime:[\s\S]*?)```/u)?.[1] ?? '';
    const lines = block.split(/\r?\n/u).filter((line) => line.trim().length > 0);
    expect([
      SWITCH_COMPARISON.heading,
      ...SWITCH_COMPARISON.warnings,
      ...SWITCH_COMPARISON.blockers,
    ]).toEqual(lines.map((line) => line.trim()));
    expect(SWITCH_COMPARISON.warnings[1]).toContain('"Restricted"');
  });
});

describe('the Save draft policy', () => {
  it('asks for the policy the ACA pool enforces, not the driver-wide default', () => {
    expect(draftRuntimeNetworkPolicy('aca-sessions', ['open'])).toBe('open');
  });

  it('keeps the strongest default for a runtime the registry does not restrict', () => {
    expect(draftRuntimeNetworkPolicy('aca-sessions', null)).toBe('none');
    expect(draftRuntimeNetworkPolicy('docker', null)).toBe('none');
    expect(draftRuntimeNetworkPolicy('kubernetes', null)).toBe('restricted');
    expect(draftRuntimeNetworkPolicy('local', null)).toBe('open');
  });

  it('prefers the default when the reported set still contains it', () => {
    expect(draftRuntimeNetworkPolicy('kubernetes', ['open', 'restricted'])).toBe('restricted');
  });
});

describe('Test Runtime client request', () => {
  it('posts the selected driver and returns the transcript', async () => {
    let call: { input: string | URL | Request; init?: RequestInit } | undefined;
    const request: typeof fetch = (input, init) => {
      call = { input, ...(init === undefined ? {} : { init }) };
      return Promise.resolve(
        new Response(
          JSON.stringify({ driverId: 'docker', transcript: ['echo ok'], destroyed: true }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      );
    };
    await expect(testRuntime(request, 'docker')).resolves.toEqual({
      driverId: 'docker',
      transcript: ['echo ok'],
      destroyed: true,
    });
    expect(call?.input).toBe('/api/runtimes/test');
    expect(call?.init?.method).toBe('POST');
    expect(call?.init?.body).toContain('"driver":"docker"');
  });
});

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

describe('Test Runtime on a provider sandbox', () => {
  const connections = {
    runtimeConnections: [
      { id: 'c-docker', name: 'DOCKER__A', driver: 'docker', createdAt: '2026-10-08T00:00:00Z' },
      { id: 'c-e2b', name: 'EXTERNAL__E2B', driver: 'external', createdAt: '2026-10-08T00:00:00Z' },
    ],
  };

  it("finds the workspace's connection for the selected driver", async () => {
    const request: typeof fetch = () => Promise.resolve(json(200, connections));
    await expect(runtimeConnectionIdFor(request, 'external')).resolves.toBe('c-e2b');
    await expect(runtimeConnectionIdFor(request, 'vercel-sandbox')).resolves.toBeUndefined();
  });

  it('refuses a connection list that is not the contract', async () => {
    const request: typeof fetch = () => Promise.resolve(json(200, { runtimeConnections: [{}] }));
    await expect(runtimeConnectionIdFor(request, 'external')).rejects.toThrow(/invalid list/u);
  });

  it('posts the connection id, and omits it when there is none', async () => {
    const bodies: unknown[] = [];
    const request: typeof fetch = (_input, init) => {
      bodies.push(typeof init?.body === 'string' ? JSON.parse(init.body) : undefined);
      return Promise.resolve(json(200, { driverId: 'external', transcript: [], destroyed: true }));
    };
    await testRuntime(request, 'external', 'c-e2b');
    await testRuntime(request, 'docker');
    expect(bodies).toEqual([
      { driver: 'external', echo: 'agent-workspace runtime test', runtimeConnectionId: 'c-e2b' },
      { driver: 'docker', echo: 'agent-workspace runtime test' },
    ]);
  });

  it('still tests a driver that needs no connection when the connection list fails', async () => {
    const bodies: unknown[] = [];
    const request: typeof fetch = (input, init) => {
      if (input === '/api/runtime-connections') {
        return Promise.resolve(
          json(503, { error: { code: 'runtimes_runtime_not_configured', message: 'x' } }),
        );
      }
      bodies.push(typeof init?.body === 'string' ? JSON.parse(init.body) : undefined);
      return Promise.resolve(json(200, { driverId: 'docker', transcript: [], destroyed: true }));
    };
    await expect(testSelectedRuntime(request, 'docker')).resolves.toMatchObject({
      driverId: 'docker',
    });
    expect(bodies).toEqual([{ driver: 'docker', echo: 'agent-workspace runtime test' }]);
  });

  it("shows the server's sentence for a refusal, and a status line when there is none", async () => {
    const refusal = json(422, {
      error: {
        code: 'runtime_connection_missing',
        message: 'runtime_connection_missing: Create an external runtime connection.',
      },
    });
    await expect(testRuntime(() => Promise.resolve(refusal), 'external')).rejects.toThrow(
      'runtime_connection_missing: Create an external runtime connection.',
    );
    await expect(
      testRuntime(() => Promise.resolve(new Response('nope', { status: 502 })), 'external'),
    ).rejects.toThrow('Test Runtime failed with HTTP 502.');
  });
});
