import {
  PortableAgentSchema,
  type PortableAgentInput,
} from '@indx-workspace/contracts/portable-agent';
import { describe, expect, it } from 'vitest';

import { DefinitionError } from '../define/errors.js';
import { ProjectFileError, ProjectRenderError } from '../project/index.js';
import { AGENT_MARKDOWN_SUFFIX, formatAgentMarkdown, parseAgentMarkdown } from './index.js';

const permissions = {
  readFiles: true,
  writeFiles: false,
  runCommands: false,
  unrestrictedNetwork: false,
};

const base = {
  apiVersion: 'agentworkspace.dev/v1',
  kind: 'Agent',
  name: 'support-triage',
  instructions: 'Triage tickets.',
  permissions,
} as const satisfies PortableAgentInput;

const sample: PortableAgentInput = {
  ...base,
  description: 'Answers billing and refund questions.',
  model: { provider: 'anthropic', id: 'claude-sonnet-4-6' },
  engine: 'claude-agent-sdk',
  tools: [
    {
      kind: 'mcp',
      name: 'crm',
      transport: 'streamable-http',
      url: 'https://crm.example.com/mcp',
      auth: { scheme: 'bearer', secretRef: 'CRM_TOKEN' },
    },
    { kind: 'mcp', name: 'local-files', transport: 'stdio', command: 'npx', args: ['-y', 'files'] },
    {
      kind: 'code',
      name: 'lookup',
      description: 'Looks up an order.',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string', description: 'a: b # c' } },
        required: ['id'],
        additionalProperties: false,
      },
    },
    {
      kind: 'openapi',
      name: 'orders',
      specRef: 'https://api.example.com/openapi.json',
      allow: ['GET /orders/*', 'operationId:getOrder'],
      baseUrl: 'https://api.example.com',
      auth: { secretRef: 'ORDERS_KEY', header: 'X-Api-Key' },
    },
    { kind: 'builtin', id: 'web_search' },
  ],
  skills: [{ name: 'refund-policy', path: 'skills/refund-policy' }],
  knowledge: [
    { kind: 'files', paths: ['docs/faq.md'] },
    { kind: 'url', url: 'https://example.com/help' },
    { kind: 'connector', name: 'sharepoint' },
  ],
  subagents: [{ name: 'billing-specialist' }],
  limits: { maxTurns: 20, maxBudgetUsd: 1.5 },
  extensions: {
    engines: { 'claude-agent-sdk': { thinking: true } },
    platforms: { 'copilot-studio': { schemaName: 'x' } },
  },
};

const roundTrips: readonly (readonly [string, PortableAgentInput])[] = [
  ['the sample agent', sample],
  ['a minimal agent', base],
  ['instructions that start with a newline', { ...base, instructions: '\nBe brief.' }],
  ['instructions that end with a newline', { ...base, instructions: 'Be brief.\n' }],
  ['instructions that start and end with several newlines', { ...base, instructions: '\n\nx\n\n' }],
  ['instructions that are one newline', { ...base, instructions: '\n' }],
  ['empty instructions', { ...base, instructions: '' }],
  ['instructions with fence lines', { ...base, instructions: 'a\n---\nb\n---' }],
  ['instructions that are a fence', { ...base, instructions: '---' }],
  ['instructions that look like front matter', { ...base, instructions: '---\nname: x\n---\n' }],
  [
    'instructions with YAML-looking text',
    { ...base, instructions: 'key: value\n- item\n# not a comment' },
  ],
  ['instructions with a tab and non-ASCII text', { ...base, instructions: 'a\tb — ünï 日本語 🎉' }],
  ['a description that needs quoting', { ...base, description: 'yes: "no" # maybe' }],
  ['a description that looks like a boolean', { ...base, description: 'true' }],
  ['a description with a line break', { ...base, description: 'one\ntwo' }],
  ['a description that is a fence', { ...base, description: '---' }],
  [
    'a code tool with empty properties',
    {
      ...base,
      tools: [
        {
          kind: 'code',
          name: 'noop',
          description: 'Does nothing.',
          inputSchema: { type: 'object', properties: {} },
        },
      ],
    },
  ],
  [
    'a code tool with an empty input schema',
    {
      ...base,
      tools: [{ kind: 'code', name: 'noop', description: 'd', inputSchema: {} }],
    },
  ],
  ['limits with a fraction', { ...base, limits: { maxBudgetUsd: 0.000_1 } }],
  [
    'an engine extension',
    { ...base, extensions: { engines: { mastra: { a: [1, 'two', true] } } } },
  ],
  ['an empty platform extension', { ...base, extensions: { platforms: { 'copilot-studio': {} } } }],
  [
    'every builtin tool',
    {
      ...base,
      tools: ['web_search', 'web_fetch', 'code_execution', 'file_access'].map((id) => ({
        kind: 'builtin' as const,
        id: id as 'web_search',
      })),
    },
  ],
];

describe('parseAgentMarkdown', () => {
  it('reads the example file', () => {
    const text = `---
apiVersion: agentworkspace.dev/v1
kind: Agent
name: billing-specialist
description: Answers billing and refund questions.
model:
  provider: anthropic
  id: claude-sonnet-4-6
permissions:
  readFiles: true
  writeFiles: false
  runCommands: false
  unrestrictedNetwork: false
skills:
  - name: refund-policy
    path: skills/refund-policy
---

You answer billing questions using the refund-policy skill.
`;
    const agent = parseAgentMarkdown(text, 'agents/billing-specialist.agent.md');
    expect(agent).toStrictEqual({
      apiVersion: 'agentworkspace.dev/v1',
      kind: 'Agent',
      name: 'billing-specialist',
      description: 'Answers billing and refund questions.',
      instructions: 'You answer billing questions using the refund-policy skill.',
      model: { provider: 'anthropic', id: 'claude-sonnet-4-6' },
      permissions,
      tools: [],
      skills: [{ name: 'refund-policy', path: 'skills/refund-policy' }],
      knowledge: [],
      subagents: [],
    });
    expect(Object.isFrozen(agent)).toBe(true);
  });

  it('reads CRLF input as LF', () => {
    const lf = formatAgentMarkdown({ ...sample, instructions: 'one\ntwo' });
    expect(parseAgentMarkdown(lf.replaceAll('\n', '\r\n'), 'x')).toStrictEqual(
      parseAgentMarkdown(lf, 'x'),
    );
  });

  it('names the suffix of an interchange file', () => {
    expect(AGENT_MARKDOWN_SUFFIX).toBe('.agent.md');
  });

  describe('refusals', () => {
    const label = 'agents/a.agent.md';
    const head = '---\napiVersion: agentworkspace.dev/v1\nkind: Agent\nname: a\n';
    const tail =
      'permissions:\n  readFiles: true\n  writeFiles: false\n  runCommands: false\n  unrestrictedNetwork: false\n---\n\nHi\n';

    function refusal(text: string): ProjectFileError {
      try {
        parseAgentMarkdown(text, label);
      } catch (error) {
        if (error instanceof ProjectFileError) return error;
        throw error;
      }
      throw new Error('expected a refusal');
    }

    it('refuses a file that does not start with a fence', () => {
      const error = refusal('name: a\n');
      expect([error.line, error.column]).toStrictEqual([1, 1]);
      expect(error.message).toBe(
        `${label} line 1, column 1: must start with a '---' front matter line`,
      );
    });

    it('refuses front matter that is not closed, at the last line', () => {
      const error = refusal('---\nname: a\nkind: Agent\n');
      expect([error.line, error.column]).toStrictEqual([3, 1]);
      expect(error.message).toBe(
        `${label} line 3, column 1: the front matter is not closed with '---'`,
      );
    });

    it('refuses an anchor at its own line and column', () => {
      const error = refusal(`${head}description: &a hi\n${tail}`);
      expect([error.line, error.column]).toStrictEqual([5, 14]);
      expect(error.message).toContain(`${label} line 5, column 14: an anchor is not accepted`);
    });

    it('refuses a duplicate key at the second one', () => {
      const error = refusal(`${head}name: b\n${tail}`);
      expect([error.line, error.column]).toStrictEqual([5, 1]);
      expect(error.message).toContain('duplicate key "name"');
    });

    it('refuses front matter that is not a mapping', () => {
      const error = refusal('---\n- a\n---\n');
      expect([error.line, error.column]).toStrictEqual([2, 1]);
      expect(error.message).toContain('the front matter must be a mapping');
    });

    it('refuses an instructions key at the key', () => {
      const error = refusal(`${head}instructions: hi\n${tail}`);
      expect([error.line, error.column]).toStrictEqual([5, 1]);
      expect(error.path).toBe('instructions');
      expect(error.message).toBe(
        `${label} line 5, column 1: the instructions are the Markdown body, not a front matter key`,
      );
    });

    it('refuses a schema violation at its field, with the dotted path', () => {
      const error = refusal(head + tail.replace('readFiles: true', 'readFiles: yes-please'));
      expect([error.line, error.column]).toStrictEqual([6, 3]);
      expect(error.path).toBe('permissions.readFiles');
      expect(error.message).toContain(`${label} line 6, column 3: permissions.readFiles `);
    });

    it('refuses an unknown key at the key', () => {
      const error = refusal(`${head}colour: red\n${tail}`);
      expect([error.line, error.column]).toStrictEqual([5, 1]);
      expect(error.path).toBe('colour');
    });

    it('refuses a missing field at the start of the front matter', () => {
      const error = refusal(`---\napiVersion: agentworkspace.dev/v1\nkind: Agent\n---\n\nHi\n`);
      expect(error.path).toBe('name');
    });

    it('refuses over-long instructions at the line after the closing fence', () => {
      const text = `${head}${tail}`.replace('Hi', 'x'.repeat(100_001));
      const error = refusal(text);
      expect([error.line, error.column]).toStrictEqual([11, 1]);
      expect(error.path).toBe('instructions');
    });
  });
});

describe('formatAgentMarkdown', () => {
  it.each(roundTrips)('round-trips %s', (_what, agent) => {
    const text = formatAgentMarkdown(agent);
    expect(parseAgentMarkdown(text, 'x')).toStrictEqual(PortableAgentSchema.parse(agent));
  });

  it('is deterministic', () => {
    expect(formatAgentMarkdown(sample)).toBe(formatAgentMarkdown(sample));
  });

  it('writes the example file byte for byte', () => {
    const text = formatAgentMarkdown({
      ...base,
      name: 'billing-specialist',
      description: 'Answers billing and refund questions.',
      instructions: 'You answer billing questions using the refund-policy skill.',
      model: { provider: 'anthropic', id: 'claude-sonnet-4-6' },
      skills: [{ name: 'refund-policy', path: 'skills/refund-policy' }],
    });
    expect(text).toBe(`---
apiVersion: agentworkspace.dev/v1
kind: Agent
name: billing-specialist
description: Answers billing and refund questions.
model:
  provider: anthropic
  id: claude-sonnet-4-6
permissions:
  readFiles: true
  writeFiles: false
  runCommands: false
  unrestrictedNetwork: false
skills:
  - name: refund-policy
    path: skills/refund-policy
---

You answer billing questions using the refund-policy skill.
`);
  });

  it('writes no empty list for a minimal agent', () => {
    const text = formatAgentMarkdown(base);
    for (const key of ['tools:', 'skills:', 'knowledge:', 'subagents:', 'instructions:']) {
      expect(text).not.toContain(key);
    }
  });

  it('writes an empty properties mapping as {}', () => {
    const text = formatAgentMarkdown(roundTrips[16]?.[1] ?? base);
    expect(text).toContain('properties: {}');
  });

  it('refuses an invalid agent with a DefinitionError naming the field', () => {
    const invalid = { ...base, name: 'Not Kebab' };
    expect(() => formatAgentMarkdown(invalid)).toThrow(DefinitionError);
    try {
      formatAgentMarkdown(invalid);
    } catch (error) {
      expect(error).toMatchObject({ issues: [{ path: 'name' }] });
    }
  });

  it('refuses a value the file cannot hold with a ProjectRenderError', () => {
    const tool = {
      kind: 'code',
      name: 'nested',
      description: 'd',
      inputSchema: { matrix: [[1]] },
    } as const;
    expect(() => formatAgentMarkdown({ ...base, tools: [tool] })).toThrow(ProjectRenderError);
    expect(() => formatAgentMarkdown({ ...base, tools: [tool] })).toThrow(
      /^support-triage\.agent\.md could not be rendered: /u,
    );
  });
});
