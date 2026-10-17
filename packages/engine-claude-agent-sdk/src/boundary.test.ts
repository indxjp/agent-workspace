import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { toSdkOptions } from './boundary.js';
import { CLAUDE_DELEGATION_TOOL } from './compile.js';
import type { CompiledSdkOptions } from './options.js';

// Read as text: only `./boundary.ts` may import the SDK (§42), and the pinned tool names are not
// types (see `CLAUDE_DELEGATION_TOOL`). `toSdkAgents` in `./boundary.ts` assigns every
// `AgentDefinition` field by name, so the typecheck catches a drift in the agent shape.
const sdkDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../node_modules/@anthropic-ai/claude-agent-sdk',
);

const compiled: CompiledSdkOptions = {
  cwd: '/run/claude',
  env: {},
  settingSources: ['project'],
  strictMcpConfig: true,
  mcpServers: {},
  permissionMode: 'default',
  allowedTools: [],
  disallowedTools: [],
  tools: { type: 'preset', preset: 'claude_code' },
  skills: [],
};

describe('toSdkOptions agents', () => {
  it('passes compiled subagents through as the SDK agents option', () => {
    const options = toSdkOptions({
      ...compiled,
      agents: {
        billing: { description: 'Billing.', prompt: 'Answer.', disallowedTools: ['Write'] },
        legal: { description: 'Legal.', prompt: 'Review.', model: 'claude-haiku-4-5' },
      },
    });
    expect(options['agents']).toEqual({
      billing: { description: 'Billing.', prompt: 'Answer.', disallowedTools: ['Write'] },
      legal: { description: 'Legal.', prompt: 'Review.', model: 'claude-haiku-4-5' },
    });
  });

  it('sets no agents option without subagents', () => {
    expect('agents' in toSdkOptions(compiled)).toBe(false);
  });
});

describe('toSdkOptions run_skill_script', () => {
  const setup = {
    cwd: '/run/claude',
    skillsDirectory: '.claude/skills',
    skills: [{ name: 'review', scripts: ['check.mjs'] }],
    writable: [],
  };

  it('adds the in-process server that carries the tool, beside the connectors', () => {
    const options = toSdkOptions(compiled, { skillScript: setup });
    expect(options['mcpServers']).toMatchObject({
      'agent-workspace': { type: 'sdk', name: 'agent-workspace' },
    });
  });

  it('adds no server without a setup', () => {
    expect(toSdkOptions(compiled)['mcpServers']).toEqual({});
  });
});

describe('the delegation tool name', () => {
  it('is the tool the pinned SDK delegates to subagents through', () => {
    const tools = readFileSync(path.join(sdkDir, 'sdk-tools.d.ts'), 'utf8');
    const schemas = /export type ToolInputSchemas =([^;]*);/u.exec(tools)?.[1] ?? '';
    expect(schemas.split('|').map((member) => member.trim())).toContain(
      `${CLAUDE_DELEGATION_TOOL}Input`,
    );
    expect(readFileSync(path.join(sdkDir, 'sdk.d.ts'), 'utf8')).toContain(
      `custom subagent that can be invoked via the ${CLAUDE_DELEGATION_TOOL} tool`,
    );
  });
});
