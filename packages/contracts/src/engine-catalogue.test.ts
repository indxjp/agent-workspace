import { describe, expect, it } from 'vitest';

import { AgentPolicySchema, claudeBaseToolPolicyFor, engineSettingsOf } from './agents.js';
import {
  CLAUDE_PERMISSION_TOOL_DENIALS,
  ENGINE_CATALOGUE,
  engineSettingsSchema,
  isWithholdingEngine,
  mcpToolName,
} from './engine-catalogue.js';
import { DEFAULT_ENGINE_ID, ENGINE_IDS, EngineCapabilitiesSchema, isEngineId } from './engines.js';

const BASE = { skills: { mode: 'all' }, limits: { maxTurns: null, maxBudgetUsd: null } } as const;

describe('ENGINE_CATALOGUE', () => {
  it('has one entry per engine id, in ENGINE_IDS order', () => {
    expect(Object.keys(ENGINE_CATALOGUE)).toStrictEqual([...ENGINE_IDS]);
  });

  it.each(ENGINE_IDS)('%s states capabilities the registry schema accepts', (id) => {
    expect(EngineCapabilitiesSchema.parse(ENGINE_CATALOGUE[id].capabilities)).toStrictEqual(
      ENGINE_CATALOGUE[id].capabilities,
    );
  });

  it('keeps the Claude denial table as the Claude permission tools', () => {
    expect(ENGINE_CATALOGUE['claude-agent-sdk'].permissionTools).toBe(
      CLAUDE_PERMISSION_TOOL_DENIALS,
    );
  });

  it('groups the withholding engines tools by the switch that governs them, in plan order', () => {
    expect(ENGINE_CATALOGUE['openai-agents'].permissionTools).toStrictEqual({
      readFiles: ['read_file', 'list_files', 'search_files'],
      writeFiles: ['apply_patch'],
      runCommands: ['shell'],
      unrestrictedNetwork: [],
    });
    expect(ENGINE_CATALOGUE.pi.permissionTools).toStrictEqual({
      readFiles: ['read'],
      writeFiles: ['write', 'edit'],
      runCommands: ['bash'],
      unrestrictedNetwork: [],
    });
    expect(ENGINE_CATALOGUE.mastra.permissionTools.readFiles).toHaveLength(4);
    expect(ENGINE_CATALOGUE.mastra.permissionTools.runCommands).toHaveLength(3);
  });

  it('names a withholding engine only when its arm states withheldPermissions', () => {
    expect(ENGINE_IDS.filter((id) => !isWithholdingEngine(id))).toStrictEqual(['claude-agent-sdk']);
  });

  it('shows the model an MCP tool the way each engine does', () => {
    expect(mcpToolName(ENGINE_CATALOGUE['claude-agent-sdk'].mcpToolName, 's', 't')).toBe(
      'mcp__s__t',
    );
    expect(mcpToolName(ENGINE_CATALOGUE.mastra.mcpToolName, 's', 't')).toBe('s_t');
    expect(mcpToolName(ENGINE_CATALOGUE.pi.mcpToolName, 's', 't')).toBe('t');
  });
});

describe('engineSettingsSchema', () => {
  it('accepts no settings and the engine its own', () => {
    expect(engineSettingsSchema('pi').safeParse({}).success).toBe(true);
    expect(engineSettingsSchema('pi').safeParse({ thinkingLevel: 'low' }).success).toBe(true);
  });

  it('refuses another engine key, a value out of range and a policy-only key', () => {
    expect(engineSettingsSchema('pi').safeParse({ tools: {} }).success).toBe(false);
    expect(engineSettingsSchema('pi').safeParse({ thinkingLevel: 'xhigh' }).success).toBe(false);
    expect(engineSettingsSchema('pi').safeParse({ reasoningEffort: 'high' }).success).toBe(false);
  });
});

describe('AgentPolicySchema arms', () => {
  it('lists the keys in wire order: engine, settings, narrowing, skills, limits', () => {
    for (const option of AgentPolicySchema.options) {
      const { shape } = option.unwrap();
      const id = shape.engine.value;
      const narrowing = isWithholdingEngine(id) ? 'withheldPermissions' : 'tools';

      expect(Object.keys(shape)).toStrictEqual([
        'engine',
        ...Object.keys(ENGINE_CATALOGUE[id].settings),
        narrowing,
        'skills',
        'limits',
      ]);
    }
  });
});

describe('engineSettingsOf', () => {
  it('is empty for no stored policy', () => {
    expect(engineSettingsOf(null)).toStrictEqual({});
  });

  it('returns the settings the policy carries and nothing else', () => {
    const pi = AgentPolicySchema.parse({
      ...BASE,
      engine: 'pi',
      thinkingLevel: 'low',
      withheldPermissions: ['readFiles'],
    });
    const openai = AgentPolicySchema.parse({
      ...BASE,
      engine: 'openai-agents',
      parallelToolCalls: false,
    });

    expect(engineSettingsOf(pi)).toStrictEqual({ thinkingLevel: 'low' });
    expect(engineSettingsOf(openai)).toStrictEqual({ parallelToolCalls: false });
    expect(engineSettingsOf(AgentPolicySchema.parse({ ...BASE, engine: 'mastra' }))).toStrictEqual(
      {},
    );
  });

  it('has no settings to return for the Claude arm', () => {
    const claude = AgentPolicySchema.parse({
      ...BASE,
      engine: 'claude-agent-sdk',
      tools: claudeBaseToolPolicyFor({
        readFiles: true,
        writeFiles: true,
        runCommands: true,
        unrestrictedNetwork: true,
      }),
    });

    expect(engineSettingsOf(claude)).toStrictEqual({});
  });
});

describe('engine ids', () => {
  it('defaults to the first engine and recognises only listed ids', () => {
    expect(DEFAULT_ENGINE_ID).toBe('claude-agent-sdk');
    expect(isEngineId('pi')).toBe(true);
    expect(isEngineId('langgraph')).toBe(false);
  });
});
