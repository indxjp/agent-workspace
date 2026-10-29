import { describe, expect, it } from 'vitest';

import { LoadedMessageSchema, LoadMessageSchema } from './protocol.js';

const definition = {
  apiVersion: 'agentworkspace.dev/v1',
  kind: 'AgentDefinition',
  agent: {
    name: 'assistant',
    instructions: 'Help people.',
    permissions: {
      readFiles: false,
      writeFiles: false,
      runCommands: false,
      unrestrictedNetwork: false,
    },
    modelConnectionName: 'default',
    model: null,
    runtimeProfileName: null,
  },
  policy: {
    engine: 'claude-agent-sdk',
    tools: {
      base: 'claude_code_preset',
      autoApprove: [],
      deny: [],
      permissionMode: 'default',
      allowDangerouslySkipPermissions: false,
    },
    skills: { mode: 'allowlist', names: [] },
    limits: { maxTurns: null, maxBudgetUsd: null },
  },
  policySource: 'compiled',
  resources: { files: [], skills: [], connectors: [] },
};

const loaded = {
  type: 'loaded',
  files: [
    {
      file: 'agents/assistant.ts',
      kind: 'agent',
      name: 'assistant',
      body: { definition, surfaces: [] },
      secrets: ['ORDERS_TOKEN'],
      tools: [],
    },
    { file: 'surfaces/main.ts', kind: 'surface', surface: { name: 'main', agent: 'assistant' } },
    {
      file: 'surfaces/broken.ts',
      kind: 'surface',
      problem: { status: null, code: 'import_refused', details: ['node:fs'] },
    },
    {
      file: 'agents/bad.ts',
      kind: 'agent',
      problem: { status: 400, code: 'invalid_agent_version', details: ['agent.name: too long'] },
    },
  ],
};

describe('the loader protocol', () => {
  it("accepts the child's answer, parsing bodies and surfaces with the contracts", () => {
    const parsed = LoadedMessageSchema.parse(loaded);
    expect(parsed.files).toHaveLength(4);
  });

  it('refuses a malformed child message', () => {
    const malformed: readonly unknown[] = [
      null,
      'loaded',
      { type: 'loaded' },
      { ...loaded, extra: true },
      // A body that is not an agent version.
      { type: 'loaded', files: [{ file: 'agents/a.ts', kind: 'agent', name: 'a', body: {} }] },
      // A surface key the contract does not have.
      {
        type: 'loaded',
        files: [
          {
            file: 'surfaces/a.ts',
            kind: 'surface',
            surface: { name: 'a', agent: 'b', script: 'x' },
          },
        ],
      },
      // A path outside the two definition directories.
      {
        type: 'loaded',
        files: [{ file: '../etc/a.ts', kind: 'surface', surface: { name: 'a', agent: 'b' } }],
      },
      // A server status the child never gives, and a code it does not know.
      {
        type: 'loaded',
        files: [
          {
            file: 'agents/a.ts',
            kind: 'agent',
            problem: { status: 403, code: 'forbidden', details: [] },
          },
        ],
      },
      {
        type: 'loaded',
        files: [
          {
            file: 'agents/a.ts',
            kind: 'agent',
            problem: { status: null, code: 'made_up', details: [] },
          },
        ],
      },
    ];
    for (const message of malformed) {
      expect(LoadedMessageSchema.safeParse(message).success, JSON.stringify(message)).toBe(false);
    }
  });

  it('names only files directly in agents/ and surfaces/ in a load request', () => {
    const request = {
      type: 'load',
      root: '/p',
      agents: ['agents/a.ts'],
      surfaces: ['surfaces/b.ts'],
    };
    expect(LoadMessageSchema.safeParse(request).success).toBe(true);
    for (const agents of [
      ['agents/x/a.ts'],
      ['agents\\a.ts'],
      ['surfaces/a.ts'],
      ['agents/a.js'],
    ]) {
      expect(LoadMessageSchema.safeParse({ ...request, agents }).success, agents[0]).toBe(false);
    }
  });

  it('takes an optional default engine and refuses one it does not know (C12)', () => {
    const request = { type: 'load', root: '/p', agents: ['agents/a.ts'], surfaces: [] };
    expect(LoadMessageSchema.safeParse(request).success).toBe(true);
    expect(LoadMessageSchema.safeParse({ ...request, defaultEngine: 'pi' }).success).toBe(true);
    expect(LoadMessageSchema.safeParse({ ...request, defaultEngine: 'acp' }).success).toBe(false);
  });

  it("refuses an agent's secret name that is lower-case, reserved, or one of more than 256", () => {
    const [agent] = loaded.files;
    const withSecrets = (secrets: readonly string[]): unknown => ({
      type: 'loaded',
      files: [{ ...agent, secrets }],
    });
    expect(LoadedMessageSchema.safeParse(withSecrets(['ORDERS_TOKEN'])).success).toBe(true);
    const tooMany = Array.from({ length: 257 }, (_, index) => `S_${String(index)}`);
    for (const secrets of [['orders_token'], ['PATH'], ['AW_TOKEN'], tooMany]) {
      expect(LoadedMessageSchema.safeParse(withSecrets(secrets)).success, secrets[0]).toBe(false);
    }
  });

  it("carries an agent's tools with their files, and refuses a path or kind it cannot be", () => {
    const [agent] = loaded.files;
    const orders = {
      file: 'tools/orders.ts',
      kind: 'openapi',
      tool: {
        name: 'orders',
        spec: 'apis/orders.openapi.json',
        allow: ['GET /orders/*'],
        auth: { secret: 'ORDERS_TOKEN' },
      },
    };
    const withTools = (tools: readonly unknown[]): unknown => ({
      type: 'loaded',
      files: [{ ...agent, tools }],
    });
    expect(LoadedMessageSchema.safeParse(withTools([])).success).toBe(true);
    expect(LoadedMessageSchema.safeParse(withTools([orders])).success).toBe(true);
    const refused: readonly unknown[] = [
      { ...orders, file: '../x.ts' },
      { ...orders, file: 'tools/a\\b.ts' },
      { ...orders, file: 'tools/./a.ts' },
      { ...orders, file: 'tools/orders.js' },
      { ...orders, kind: 'mcp' },
      { ...orders, tool: { ...orders.tool, extra: true } },
      // A value, never only a name, where a secret belongs.
      { ...orders, tool: { ...orders.tool, auth: 'sk-live-value' } },
    ];
    for (const tool of refused) {
      expect(LoadedMessageSchema.safeParse(withTools([tool])).success, JSON.stringify(tool)).toBe(
        false,
      );
    }
  });
  // @story US-STO-12
  it('[US-STO-12][unit][cli] refuses to push a code tool that declares a storage connection credential', () => {
    const [agent] = loaded.files;
    const code = (secrets: readonly string[]): unknown => ({
      type: 'loaded',
      files: [
        {
          ...agent,
          tools: [
            {
              file: 'tools/lookup.ts',
              kind: 'code',
              tool: {
                name: 'lookup',
                run: 'run',
                description: 'Look an order up.',
                inputSchema: { type: 'object' },
                limits: { timeoutMs: 5000 },
                secrets,
              },
            },
          ],
        },
      ],
    });
    expect(LoadedMessageSchema.safeParse(code(['LOOKUP_TOKEN'])).success).toBe(true);
    expect(
      LoadedMessageSchema.safeParse(code(['STORAGE_CONNECTION_77777777777747778777777777777777']))
        .success,
    ).toBe(false);
  });
});
