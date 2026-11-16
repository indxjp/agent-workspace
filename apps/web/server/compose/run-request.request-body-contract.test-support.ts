import { RunRequest } from '@agent-workspace/run-protocol';

import { compileRunRequest } from '@agent-workspace/engine-claude-agent-sdk/testing';

import { expect, it } from 'vitest';

import { buildRunRequestFor } from './run-request';
import {
  ALL_OFF,
  ALL_ON,
  EMPTY_SHA256,
  GATEWAY,
  launchContext,
  rowRunAgent,
  RUN,
  SESSION,
  SETTINGS,
  WORKSPACE,
} from './run-request.fixture.test-support';
export function registerContractCases() {
  it('produces a body the §14.3 schema accepts', async () => {
    const { context, agents } = await launchContext();
    const request = await buildRunRequestFor({
      context,
      runAgent: await rowRunAgent(agents, context),
      settings: SETTINGS,
      gateway: GATEWAY,
    });
    // The assertion is the runner's own parse, not a field-by-field comparison with a copy of it.
    expect(() => RunRequest.parse(request)).not.toThrow();
    expect(request.runId).toBe(RUN);
    expect(request.prompt).toBe('say pong');
    expect(request.cwd).toBe(`/workspace/${WORKSPACE}/${SESSION}`);
    expect(request.session).toEqual({ kind: 'fresh', sessionId: SESSION });
    expect(request.env['ANTHROPIC_BASE_URL']).toBe('http://gateway:4000');
    expect(request.env['ANTHROPIC_AUTH_TOKEN']).toMatch(/^run-token-/u);
    expect(request.env['NODE_USE_ENV_PROXY']).toBe('1');
    expect(JSON.stringify(request)).not.toContain('ANTHROPIC_API_KEY');
  });
  it('carries no key the strict schema would reject — in particular not agentId', async () => {
    const { context, agents } = await launchContext();
    const request = await buildRunRequestFor({
      context,
      runAgent: await rowRunAgent(agents, context),
      settings: SETTINGS,
      gateway: GATEWAY,
    });
    expect(Object.keys(request).sort()).toEqual([
      'cwd',
      // ENG-04 (#303): the engine this run is addressed to, and the gateway connection handed to
      // its adapter programmatically rather than read out of `env`.
      'engine',
      'env',
      'gateway',
      // ENG-04b (#325): the private contract's v2 split. `agent` and `scope` are gone — the
      // portable core is what every engine must honour, `policy` is the arm only this run's engine
      // can read, and `projectKey` is the tenant namespace that used to travel inside `scope`
      // beside a `configDir` the engine now derives for itself.
      'policy',
      'portable',
      'projectKey',
      'prompt',
      'resources',
      'runId',
      'session',
      'sessionId',
    ]);
  });
  it('forwards the run’s outputSchema, and carries none when the run had none (ADR-0143)', async () => {
    const { context, agents } = await launchContext();
    const outputSchema = { type: 'object', properties: { verdict: { type: 'string' } } };
    const asked = await buildRunRequestFor({
      context: { ...context, outputSchema },
      runAgent: await rowRunAgent(agents, context),
      settings: SETTINGS,
      gateway: GATEWAY,
    });
    expect(RunRequest.parse(asked).outputSchema).toEqual(outputSchema);
    const plain = await buildRunRequestFor({
      context,
      runAgent: await rowRunAgent(agents, context),
      settings: SETTINGS,
      gateway: GATEWAY,
    });
    expect(plain).not.toHaveProperty('outputSchema');
  });
  it('composes the pinned configuration it is given, not the agent row (issue #612)', async () => {
    const { context, agents } = await launchContext();
    const row = await rowRunAgent(agents, context);
    const pinned = {
      ...row,
      agent: { ...row.agent, instructions: 'Version one.', permissions: ALL_ON },
    };
    const request = await buildRunRequestFor({
      context,
      runAgent: pinned,
      settings: SETTINGS,
      gateway: GATEWAY,
    });
    expect(request.portable.instructions).toBe('Version one.');
    expect(request.portable.permissions).toEqual(ALL_ON);
    expect((await rowRunAgent(agents, context)).agent.permissions).toEqual(ALL_OFF);
  });
  it('composes no subagents key without subagents, and narrows each one to its parent’s permissions', async () => {
    const { context, agents } = await launchContext();
    const row = await rowRunAgent(agents, context);
    expect(
      'subagents' in
        (await buildRunRequestFor({ context, runAgent: row, settings: SETTINGS, gateway: GATEWAY }))
          .portable,
    ).toBe(false);

    const billing = {
      name: 'billing',
      description: 'Answers billing questions.',
      instructions: 'You answer billing questions.',
      model: null,
      permissions: ALL_ON,
      policy: null,
    };
    const parent = { ...row.agent, permissions: { ...ALL_ON, runCommands: false } };
    const request = await buildRunRequestFor({
      context,
      runAgent: { ...row, agent: parent, subagents: [billing] },
      settings: SETTINGS,
      gateway: GATEWAY,
    });

    expect(() => RunRequest.parse(request)).not.toThrow();
    expect(request.portable.subagents).toEqual([
      {
        name: 'billing',
        description: 'Answers billing questions.',
        instructions: 'You answer billing questions.',
        model: null,
        permissions: { ...ALL_ON, runCommands: false },
      },
    ]);
  });
  it('carries the agent’s permissions through to the SDK-facing policy', async () => {
    const { context, agents } = await launchContext();
    const request = await buildRunRequestFor({
      context,
      runAgent: await rowRunAgent(agents, context),
      settings: SETTINGS,
      gateway: GATEWAY,
    });
    expect(request.portable.permissions).toEqual(ALL_OFF);
    // The tool names those switches remove are compiled by the engine, not by compose (ENG-04b).
    expect(compileRunRequest(request).disallowedTools).toContain('Bash');
  });
  it('compiles assigned enabled resources and makes read-only grants override write tools', async () => {
    const { context, agents } = await launchContext();
    const request = await buildRunRequestFor({
      context,
      runAgent: await rowRunAgent(agents, context),
      settings: SETTINGS,
      gateway: GATEWAY,
      permissionOverride: ALL_ON,
      resourceLoader: {
        load: () =>
          Promise.resolve({
            files: [
              {
                kind: 'file' as const,
                path: 'sources/readonly.txt',
                access: 'read' as const,
                size: 0,
                sha256: EMPTY_SHA256,
              },
            ],
            skills: [
              {
                name: 'assigned-skill',
                files: [
                  {
                    path: 'SKILL.md',
                    size: 0,
                    sha256: EMPTY_SHA256,
                  },
                ],
              },
            ],
            mcpServers: {
              assigned: { type: 'http' as const, url: 'https://mcp.example.test' },
            },
          }),
      },
    });

    expect(request.resources?.files.map((file) => file.path)).toEqual(['sources/readonly.txt']);
    expect(request.resources?.skills.map((skill) => skill.name)).toEqual(['assigned-skill']);
    expect(request.portable.skills).toEqual({ mode: 'allowlist', names: ['assigned-skill'] });
    expect(Object.keys(request.portable.mcpServers)).toEqual(['assigned']);
    const compiled = compileRunRequest(request);
    expect(compiled.skills).toEqual(['assigned-skill']);
    expect(Object.keys(compiled.mcpServers)).toEqual(['assigned']);
    expect(compiled.allowedTools).toContain('mcp__assigned__*');
    expect(compiled.disallowedTools).toContain(
      `Edit(//workspace/${WORKSPACE}/${SESSION}/sources/readonly.txt)`,
    );
    expect(compiled.disallowedTools).toContain('Bash');
  });
}
