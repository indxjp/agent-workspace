import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { AGENT_DEFINITION_MAX_REFERENCES } from '@indx-workspace/contracts/agents';

import { DefineAgentInputSchema } from './agent.js';
import {
  DefinitionError,
  defineAgent,
  files,
  isDefinedAgent,
  mcp,
  skill,
  type KnowledgeSource,
} from './index.js';

const MINIMAL = { name: 'assistant', instructions: 'Answer briefly.' } as const;

describe('DefineAgentInputSchema engine', () => {
  // Captured before AgentPolicySchema was built from the engine catalogue (ADR-0136); the
  // compact serialisation pins key order as well as content. The Claude arm has since gained the
  // SDK-only `autoApprove`; the catalogue-derived keys of every arm are unchanged.
  it('keeps the JSON Schema of the engine field', () => {
    const golden = readFileSync(
      new URL('../../../contracts/src/__golden__/engine-settings.schema.json', import.meta.url),
      'utf8',
    );
    const schema = z.toJSONSchema(DefineAgentInputSchema.unwrap().shape.engine, {
      target: 'draft-2020-12',
      io: 'input',
    });

    expect(JSON.stringify(schema)).toBe(JSON.stringify(JSON.parse(golden)));
  });
});

function pathsOf(run: () => unknown): readonly string[] {
  try {
    run();
  } catch (error) {
    if (error instanceof DefinitionError) return error.issues.map((issue) => issue.path);
    throw error;
  }
  throw new Error('expected a DefinitionError');
}

describe('defineAgent', () => {
  it('returns the input as written, frozen and branded', () => {
    const tools = [mcp('github')];
    const agent = defineAgent({ ...MINIMAL, tools, permissions: { readFiles: true } });

    expect(agent).toStrictEqual({ ...MINIMAL, tools, permissions: { readFiles: true } });
    expect(Object.isFrozen(agent)).toBe(true);
    expect(Object.isFrozen(agent.tools)).toBe(true);
    expect(Object.isFrozen(agent.permissions)).toBe(true);
    expect(agent.tools).not.toBe(tools);
    expect(isDefinedAgent(agent)).toBe(true);
    // The keys come back in the schema's order, which is the order DefineAgentInput lists them.
    expect(Object.keys(agent)).toStrictEqual(['name', 'instructions', 'permissions', 'tools']);
    expect(JSON.parse(JSON.stringify(agent))).toStrictEqual({
      ...MINIMAL,
      tools: [{ connector: 'github' }],
      permissions: { readFiles: true },
    });
  });

  it('leaves permissions out rather than inventing them', () => {
    expect(defineAgent(MINIMAL).permissions).toBeUndefined();
  });

  it('refuses an unknown key spread in from another object', () => {
    const withIcon = { ...MINIMAL, icon: 'robot' };

    expect(pathsOf(() => defineAgent(withIcon))).toStrictEqual(['(root)']);
  });

  describe('description, subagents and knowledge', () => {
    it('keeps a description and refuses an empty or over-long one', () => {
      expect(
        defineAgent({ ...MINIMAL, description: 'Answers billing questions.' }).description,
      ).toBe('Answers billing questions.');
      expect(pathsOf(() => defineAgent({ ...MINIMAL, description: '' }))).toStrictEqual([
        'description',
      ]);
      expect(
        pathsOf(() => defineAgent({ ...MINIMAL, description: 'x'.repeat(1_025) })),
      ).toStrictEqual(['description']);
    });

    it('keeps a subagent as its name, whether given as a name or as a defined agent', () => {
      const researcher = defineAgent({ ...MINIMAL, name: 'researcher' });
      const agent = defineAgent({ ...MINIMAL, subagents: [researcher, 'writer'] });
      expect(agent.subagents).toStrictEqual(['researcher', 'writer']);
    });

    it('refuses a repeated subagent, the agent itself, and a value not made by defineAgent()', () => {
      const researcher = defineAgent({ ...MINIMAL, name: 'researcher' });
      expect(
        pathsOf(() => defineAgent({ ...MINIMAL, subagents: [researcher, 'researcher'] })),
      ).toStrictEqual(['subagents.1']);
      expect(pathsOf(() => defineAgent({ ...MINIMAL, subagents: [MINIMAL.name] }))).toStrictEqual([
        'subagents.0',
      ]);
      expect(
        pathsOf(() =>
          defineAgent({ ...MINIMAL, subagents: [{ name: 'researcher' } as unknown as string] }),
        ),
      ).toStrictEqual(['subagents.0']);
    });

    it('takes files and connector knowledge, and refuses a connector that is not an mcp() tool', () => {
      const agent = defineAgent({
        ...MINIMAL,
        tools: [mcp('wiki')],
        knowledge: [
          { kind: 'files', paths: ['docs/faq.md'] },
          { kind: 'connector', name: 'wiki' },
        ],
      });
      expect(agent.knowledge).toHaveLength(2);
      expect(
        pathsOf(() =>
          defineAgent({ ...MINIMAL, knowledge: [{ kind: 'connector', name: 'wiki' }] }),
        ),
      ).toStrictEqual(['knowledge.0.name']);
      expect(
        pathsOf(() =>
          defineAgent({
            ...MINIMAL,
            tools: [mcp('wiki')],
            knowledge: [
              { kind: 'connector', name: 'wiki' },
              { kind: 'connector', name: 'wiki' },
            ],
          }),
        ),
      ).toStrictEqual(['knowledge.1']);
    });

    it('refuses a url source and an empty file list', () => {
      const url = { kind: 'url', url: 'https://example.test/' } as unknown as KnowledgeSource;
      expect(pathsOf(() => defineAgent({ ...MINIMAL, knowledge: [url] }))).toHaveLength(1);
      expect(
        pathsOf(() => defineAgent({ ...MINIMAL, knowledge: [{ kind: 'files', paths: [] }] })),
      ).toStrictEqual(['knowledge.0.paths']);
    });
  });

  it('refuses an openapiTool spread in from another object', () => {
    const withOpenApi = { ...MINIMAL, openapiTool: { url: 'https://example.test/openapi.json' } };

    expect(pathsOf(() => defineAgent(withOpenApi))).toStrictEqual(['(root)']);
  });

  it('refuses an unknown key in a nested object', () => {
    const permissions = { readFiles: true, admin: true };
    const limits = { maxTurns: 3, maxTokens: 10 };

    expect(pathsOf(() => defineAgent({ ...MINIMAL, permissions, limits }))).toStrictEqual([
      'permissions',
      'limits',
    ]);
  });

  it('refuses an engine setting on the wrong engine', () => {
    const engine = { id: 'pi', reasoningEffort: 'high' } as const;

    expect(pathsOf(() => defineAgent({ ...MINIMAL, engine }))).toStrictEqual(['engine']);
  });

  it('refuses an engine it does not know', () => {
    // An unknown id is a type error for defineAgent, so the schema it runs is asked directly.
    const result = DefineAgentInputSchema.safeParse({ ...MINIMAL, engine: { id: 'langgraph' } });

    expect(result.error?.issues.map((issue) => issue.path)).toStrictEqual([['engine']]);
  });

  it('refuses the policy-only keys as engine settings', () => {
    const engine = { id: 'openai-agents', withheldPermissions: ['readFiles'] } as const;

    expect(pathsOf(() => defineAgent({ ...MINIMAL, engine }))).toStrictEqual(['engine']);
  });

  it.each([
    'instructions.md',
    './',
    './.md',
    './notes.txt',
    '../instructions.md',
    './../instructions.md',
    './a/../instructions.md',
    './a/./instructions.md',
    './a//instructions.md',
    '.\\instructions.md',
    './a\\b.md',
    './a\u0000.md',
    './a‮dm.md',
    './x​/a.md',
    './C:x.md',
    './notes.md:stream.md',
    `./${'a'.repeat(1_022)}.md`,
  ])('refuses the instructions file %j', (file) => {
    const paths = pathsOf(() => defineAgent({ ...MINIMAL, instructions: { file } }));

    expect([...new Set(paths)]).toStrictEqual(['instructions.file']);
  });

  it.each(['./instructions.md', './prompts/support/en.md', './.hidden.md'])(
    'accepts the instructions file %j',
    (file) => {
      expect(defineAgent({ ...MINIMAL, instructions: { file } }).instructions).toStrictEqual({
        file,
      });
    },
  );

  it('keeps a string ending in .md as the text itself', () => {
    expect(defineAgent({ ...MINIMAL, instructions: './instructions.md' }).instructions).toBe(
      './instructions.md',
    );
  });

  it('refuses a repeated tool, skill or file path at the repeat', () => {
    expect(
      pathsOf(() =>
        defineAgent({
          ...MINIMAL,
          tools: [mcp('github'), mcp('linear'), mcp('github')],
          skills: [skill('triage'), skill('triage')],
          files: [files('docs'), files('docs', 'read-write')],
        }),
      ),
    ).toStrictEqual(['tools.2', 'skills.1', 'files.1']);
  });

  it('refuses more tools, skills or files than the contract allows', () => {
    const many = Array.from({ length: AGENT_DEFINITION_MAX_REFERENCES + 1 }, (_, index) =>
      skill(`s${String(index)}`),
    );

    expect(pathsOf(() => defineAgent({ ...MINIMAL, skills: many }))).toStrictEqual(['skills']);
    expect(
      defineAgent({ ...MINIMAL, skills: many.slice(0, AGENT_DEFINITION_MAX_REFERENCES) }).skills,
    ).toHaveLength(AGENT_DEFINITION_MAX_REFERENCES);
  });

  it('refuses a reference not made by mcp(), skill() or files()', () => {
    const tools = [{ ...mcp('github') }];
    const skills = [{ ...skill('triage') }];

    expect(pathsOf(() => defineAgent({ ...MINIMAL, tools, skills }))).toStrictEqual([
      'tools.0',
      'skills.0',
    ]);
  });

  it('refuses a model that is not a connection name or a connection object', () => {
    expect(pathsOf(() => defineAgent({ ...MINIMAL, model: '' }))).toStrictEqual(['model']);
    expect(
      pathsOf(() => defineAgent({ ...MINIMAL, model: { connection: 'prod', id: '' } })),
    ).toStrictEqual(['model.id']);
  });

  it('refuses a name and limits outside the contract bounds', () => {
    expect(
      pathsOf(() => defineAgent({ name: '', instructions: 'x', limits: { maxTurns: 0 } })),
    ).toStrictEqual(['name', 'limits.maxTurns']);
  });

  it('names the call in its message', () => {
    expect(() => defineAgent({ ...MINIMAL, name: '' })).toThrow(
      /^defineAgent\(\) is not a valid definition: name: /u,
    );
  });
});

describe('references', () => {
  it('makes frozen, branded references with a default read access', () => {
    const grant = files('docs/handbook.md');

    expect(grant).toStrictEqual({ path: 'docs/handbook.md', access: 'read' });
    expect(Object.isFrozen(grant)).toBe(true);
    expect(mcp('github')).toStrictEqual({ connector: 'github' });
    expect(skill('triage')).toStrictEqual({ name: 'triage' });
  });

  it('refuses names and paths outside the contract bounds', () => {
    expect(pathsOf(() => mcp(''))).toStrictEqual(['(root)']);
    expect(pathsOf(() => mcp('x'.repeat(201)))).toStrictEqual(['(root)']);
    expect(pathsOf(() => skill('Not A Skill'))).toStrictEqual(['(root)']);
    expect(pathsOf(() => files(''))).toStrictEqual(['path']);
    expect(pathsOf(() => files('x'.repeat(1_025)))).toStrictEqual(['path']);
  });
});

describe('defineAgent refusals say what is valid (BH061-046)', () => {
  function messagesOf(input: unknown): readonly string[] {
    try {
      defineAgent(input as Parameters<typeof defineAgent>[0]);
    } catch (error) {
      if (error instanceof DefinitionError) {
        return error.issues.map((issue) => `${issue.path}: ${issue.message}`);
      }
      throw error;
    }
    throw new Error('expected a DefinitionError');
  }

  it('names the key a misspelt one is closest to, and that instructions are required', () => {
    expect(messagesOf({ name: 'assistant', instruction: 'Hi.' })).toStrictEqual([
      "instructions: is required: the instructions as text, or { file: './instructions.md' }",
      '(root): Unrecognized key: "instruction" (did you mean "instructions"?)',
    ]);
    expect(messagesOf({ ...MINIMAL, colour: 'red' })).toStrictEqual([
      '(root): Unrecognized key: "colour"',
    ]);
  });

  it('lists the engine ids and the model forms', () => {
    const [engine] = messagesOf({ ...MINIMAL, engine: 'claude' });
    expect(engine).toContain('engine: must be an engine id ("claude-agent-sdk"');
    expect(messagesOf({ ...MINIMAL, model: { id: 'claude-haiku-4-5' } })).toStrictEqual([
      "model: must be a model connection's name, or { connection: '<connection name>', id: '<model id>' }",
    ]);
  });
});
