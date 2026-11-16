import { compileRunRequest } from '@agent-workspace/engine-claude-agent-sdk/testing';
import { describe, expect, it } from 'vitest';
import type { AgentPolicy } from '../../contracts/agents';
import { withStoredConnectorIds } from '../agents/policy';
import { DomainError } from '../errors';
import { type AgentRunResourceLoader } from './resource-loader';
import { assertToolNamesFit } from './run-request';
import type { createToolConnectorsFixture } from './run-request.tool-connectors.fixture.test-support';
export function registerEngineCompatibilityCases({
  ORDERS_LOW,
  ORDERS_HIGH,
  MCP_ENTRY,
  loaderWith,
  compose,
  twoWarehouses,
  openaiAgents,
  mastra,
}: ReturnType<typeof createToolConnectorsFixture>) {
  it('refuses two postgres connectors on openai-agents, whose tool names are unprefixed (C17)', async () => {
    const refusal: unknown = await compose(
      loaderWith(twoWarehouses),
      () => Promise.resolve(),
      openaiAgents,
    ).then(
      () => null,
      (error: unknown) => error,
    );
    expect(refusal).toBeInstanceOf(DomainError);
    expect(refusal).toMatchObject({
      code: 'connector_tool_name_collision',
      publicMessage: expect.stringMatching(/^connector_tool_name_collision: /u) as unknown,
    });
  });
  describe('an MCP connector keyed by its slug name (ADR-0113 SD13, #1109)', () => {
    const MCP_ID = '00000000-0000-4000-8000-00000000000d';
    const OTHER_MCP_ID = '00000000-0000-4000-8000-00000000000f';
    const legacy = (id: string, tool: string) => `mcp__connector-${id}__${tool}`;

    function slugLoader(): AgentRunResourceLoader {
      return {
        load: () =>
          Promise.resolve({
            files: [],
            skills: [],
            mcpServers: {
              'file-finder': MCP_ENTRY,
              [`connector-${OTHER_MCP_ID}`]: MCP_ENTRY,
            },
            connectorNames: {
              'file-finder': 'file-finder',
              [`connector-${OTHER_MCP_ID}`]: 'Docs',
            },
            connectorKeys: {
              [MCP_ID]: 'file-finder',
              [OTHER_MCP_ID]: `connector-${OTHER_MCP_ID}`,
            },
          }),
      };
    }

    function claudeRules(rules: {
      readonly base?: readonly string[];
      readonly autoApprove?: readonly string[];
      readonly deny?: readonly string[];
    }): AgentPolicy {
      return {
        engine: 'claude-agent-sdk',
        tools: {
          base: rules.base === undefined ? 'claude_code_preset' : [...rules.base],
          autoApprove: [...(rules.autoApprove ?? [])],
          deny: [...(rules.deny ?? [])],
          permissionMode: 'default',
          allowDangerouslySkipPermissions: false,
        },
        skills: { mode: 'all' },
        limits: { maxTurns: null, maxBudgetUsd: null },
      };
    }

    it('hands the engine the slug as the server key and approves it as mcp__<slug>__*', async () => {
      const request = await compose(slugLoader(), undefined, claudeRules({}));
      expect(Object.keys(request.portable.mcpServers)).toEqual([
        'file-finder',
        `connector-${OTHER_MCP_ID}`,
      ]);
      expect(compileRunRequest(request).allowedTools).toEqual([
        `mcp__connector-${OTHER_MCP_ID}__*`,
        'mcp__file-finder__*',
      ]);
    });

    it('rewrites a stored rule written against connector-<id> to the run key, so a deny still matches', async () => {
      const request = await compose(
        slugLoader(),
        undefined,
        claudeRules({
          autoApprove: [legacy(MCP_ID, 'find_files')],
          deny: [legacy(MCP_ID, 'delete'), `${legacy(MCP_ID, 'write')}(/tmp/**)`],
        }),
      );
      const compiled = compileRunRequest(request);
      expect(compiled.allowedTools).toContain('mcp__file-finder__find_files');
      expect(compiled.disallowedTools).toEqual(
        expect.arrayContaining(['mcp__file-finder__delete', 'mcp__file-finder__write(/tmp/**)']),
      );
      expect(JSON.stringify(compiled)).not.toContain(`connector-${MCP_ID}`);
    });

    it('rewrites a connector-<id> rule in a tools.base list to the run key', async () => {
      const request = await compose(
        slugLoader(),
        undefined,
        claudeRules({ base: ['Read', legacy(MCP_ID, 'find_files')] }),
      );
      const compiled = compileRunRequest(request);
      expect(compiled.tools).toEqual(
        expect.arrayContaining(['Read', 'mcp__file-finder__find_files']),
      );
      expect(JSON.stringify(compiled)).not.toContain(`connector-${MCP_ID}`);
    });

    it('passes a rule already written with the slug, and a rule for a UUID-keyed connector, unchanged', async () => {
      const request = await compose(
        slugLoader(),
        undefined,
        claudeRules({
          autoApprove: ['mcp__file-finder__find_files'],
          deny: [legacy(OTHER_MCP_ID, 'delete')],
        }),
      );
      const compiled = compileRunRequest(request);
      expect(compiled.allowedTools).toContain('mcp__file-finder__find_files');
      expect(compiled.disallowedTools).toContain(legacy(OTHER_MCP_ID, 'delete'));
    });

    describe('a rule written against the slug is saved by id, so it follows the connector', () => {
      /** The rules as a save stores them while `MCP_ID` is named `file-finder`. */
      function savedRules(rules: Parameters<typeof claudeRules>[0]): AgentPolicy {
        return withStoredConnectorIds(claudeRules(rules), new Map([['file-finder', MCP_ID]]));
      }

      /** A run whose connectors are keyed `keys` (connector id to run key). */
      function keyedLoader(keys: Readonly<Record<string, string>>): AgentRunResourceLoader {
        const entries = Object.entries(keys);
        return {
          load: () =>
            Promise.resolve({
              files: [],
              skills: [],
              mcpServers: Object.fromEntries(entries.map(([, key]) => [key, MCP_ENTRY])),
              connectorNames: Object.fromEntries(entries.map(([, key]) => [key, key])),
              connectorKeys: { ...keys },
            }),
        };
      }

      it('keeps a slug-form deny matching after the connector is renamed', async () => {
        const request = await compose(
          keyedLoader({ [MCP_ID]: 'file-search' }),
          undefined,
          savedRules({ deny: ['mcp__file-finder__delete'] }),
        );
        const { disallowedTools } = compileRunRequest(request);
        expect(disallowedTools).toContain('mcp__file-search__delete');
        expect(disallowedTools).not.toContain('mcp__file-finder__delete');
      });

      it('keeps a slug-form deny matching when a same-named tool connector sends it to connector-<id>', async () => {
        const request = await compose(
          keyedLoader({ [MCP_ID]: `connector-${MCP_ID}` }),
          undefined,
          savedRules({ deny: ['mcp__file-finder__delete'] }),
        );
        expect(compileRunRequest(request).disallowedTools).toContain(legacy(MCP_ID, 'delete'));
      });

      it('does not hand a slug-form autoApprove to another connector renamed to that slug', async () => {
        const request = await compose(
          keyedLoader({ [MCP_ID]: 'file-search', [OTHER_MCP_ID]: 'file-finder' }),
          undefined,
          savedRules({ autoApprove: ['mcp__file-finder__find_files'] }),
        );
        const { allowedTools } = compileRunRequest(request);
        expect(allowedTools).toContain('mcp__file-search__find_files');
        expect(allowedTools).not.toContain('mcp__file-finder__find_files');
      });
    });

    it('leaves a rule for a connector that is not in the run as it is', async () => {
      const absent = '00000000-0000-4000-8000-0000000000ee';
      const request = await compose(
        slugLoader(),
        undefined,
        claudeRules({ deny: [legacy(absent, 'delete')] }),
      );
      expect(compileRunRequest(request).disallowedTools).toContain(legacy(absent, 'delete'));
    });
  });
  it('composes the same two connectors on claude-agent-sdk and mastra, which prefix the server key', async () => {
    await expect(
      compose(loaderWith(twoWarehouses), () => Promise.resolve()),
    ).resolves.toBeDefined();
    await expect(
      compose(loaderWith(twoWarehouses), () => Promise.resolve(), mastra),
    ).resolves.toBeDefined();
  });
  it('refuses a Mastra name collision across keys, and every name over 64 characters', async () => {
    // Mastra shows `a` + `b_select` and `a_b` + `select` both as `a_b_select`.
    await expect(
      compose(
        loaderWith([
          { key: 'a', name: 'a', connectorId: ORDERS_LOW, operationNames: ['b_select'] },
          { key: 'a_b', name: 'a_b', connectorId: ORDERS_HIGH, operationNames: ['select'] },
        ]),
        () => Promise.resolve(),
        mastra,
      ),
    ).rejects.toMatchObject({ code: 'connector_tool_name_collision' });
    expect(() =>
      assertToolNamesFit(
        [
          {
            key: 'k'.repeat(16),
            name: 'k',
            connectorId: ORDERS_LOW,
            operationNames: ['o'.repeat(42)],
          },
        ],
        'openai-agents',
      ),
    ).toThrow(/longer than 64 characters/u);
    expect(() =>
      assertToolNamesFit(
        [
          {
            key: 'k'.repeat(16),
            name: 'k',
            connectorId: ORDERS_LOW,
            operationNames: ['o'.repeat(41)],
          },
        ],
        'claude-agent-sdk',
      ),
    ).not.toThrow();
  });
}
