import type { PlatformFile } from '@indx-workspace/contracts/platforms';
import { PortableProjectSchema } from '@indx-workspace/contracts/portable-agent';
import { describe, expect, it } from 'vitest';

import { compileForPlatform } from '../../compile.js';
import { SAMPLE_PORTABLE_PROJECT } from '../../testing/index.js';
import { awsAgentCoreTarget } from './index.js';
import { importAwsAgentCore } from './import.js';

const OPTIONS = {
  region: 'us-east-1',
  accountId: '123456789012',
  skillsS3Uri: 's3://acme-agent-skills/support-triage/',
};
const ARN =
  'arn:aws:bedrock-agentcore:us-east-1:123456789012:token-vault/default/apikeycredentialprovider/';

function compiledFiles(): PlatformFile[] {
  const result = compileForPlatform(
    awsAgentCoreTarget,
    PortableProjectSchema.parse(SAMPLE_PORTABLE_PROJECT),
    OPTIONS,
  );
  if (!result.ok) throw new Error(`refused: ${result.refusal.message}`);
  return [...result.files];
}

/** A one-harness project; `harness` is the content of `app/h/harness.json`. */
function projectOf(harness: unknown, extra: readonly PlatformFile[] = []): PlatformFile[] {
  return [
    {
      path: 'agentcore/agentcore.json',
      content: JSON.stringify({ name: 'P', harnesses: [{ name: 'h', path: 'app/h' }] }),
    },
    { path: 'app/h/harness.json', content: JSON.stringify(harness) },
    ...extra,
  ];
}

const PROMPT: PlatformFile = { path: 'app/h/system-prompt.md', content: 'Be brief.\n' };

function imported(files: readonly PlatformFile[]) {
  const result = importAwsAgentCore(files);
  if (!result.ok) throw new Error(`refused: ${result.refusal.code} ${result.refusal.message}`);
  const [root] = result.project.agents;
  if (root === undefined) throw new Error('no agents');
  return { ...result, root };
}

function refusalOf(files: unknown) {
  const result = importAwsAgentCore(files as PlatformFile[]);
  if (result.ok) throw new Error('expected a refusal');
  return result.refusal;
}

function verdictOf(report: ReturnType<typeof imported>['report'], path: string) {
  const entry = report.find((candidate) => candidate.path === path);
  if (entry === undefined) throw new Error(`no verdict for ${path}`);
  return entry;
}

describe('importAwsAgentCore', () => {
  it('is the import member of the target', () => {
    expect(awsAgentCoreTarget.import?.(compiledFiles())).toEqual(
      importAwsAgentCore(compiledFiles()),
    );
  });

  it('round-trips what the compiler maps', () => {
    const { root, project, report } = imported(compiledFiles());
    expect(project.root).toBe('support-triage');
    expect(root.instructions).toBe(SAMPLE_PORTABLE_PROJECT.agents[0]?.instructions);
    expect(root.model).toEqual({ provider: 'anthropic', id: 'claude-sonnet-4-6' });
    expect(root.tools).toContainEqual({
      kind: 'mcp',
      name: 'zendesk',
      transport: 'streamable-http',
      url: 'https://mcp.example.com/zendesk',
      auth: { scheme: 'bearer', secretRef: 'ZENDESK_TOKEN' },
    });
    expect(root.tools).toContainEqual({ kind: 'builtin', id: 'code_execution' });
    expect(root.limits).toEqual({ maxTurns: 20 });
    expect(root.skills).toEqual([{ name: 'refund-policy', path: 'skills/refund-policy' }]);
    expect(project.skills[0]?.files).toEqual(SAMPLE_PORTABLE_PROJECT.skills?.[0]?.files);
    expect(verdictOf(report, 'support-triage.name').verdict).toBe('mapped');
  });

  it('reports the tool endpoint server as a dropped code tool host', () => {
    const { root, report } = imported(compiledFiles());
    expect(root.tools.some((tool) => tool.kind === 'mcp' && tool.name === 'aw-tools')).toBe(false);
    expect(verdictOf(report, 'support-triage.tools.1')).toMatchObject({
      verdict: 'dropped',
      code: 'code_tool_needs_public_mcp',
    });
  });

  it('keeps the system prompt bytes except the one trailing newline', () => {
    const { root } = imported(
      projectOf({ name: 'h' }, [{ path: 'app/h/system-prompt.md', content: 'a\n\n' }]),
    );
    expect(root.instructions).toBe('a\n');
    expect(imported(projectOf({ name: 'h', systemPrompt: 'literal' })).root.instructions).toBe(
      'literal',
    );
  });
});

describe('credentials', () => {
  const remote = (headers: Record<string, string>) => ({
    name: 'h',
    tools: [
      {
        type: 'remote_mcp',
        name: 'srv',
        config: { remoteMcp: { url: 'https://m.example.com/mcp', headers } },
      },
    ],
  });

  it('never copies a plaintext header value', () => {
    const result = imported(
      projectOf(remote({ Authorization: 'Bearer abc-secret', 'x-other': 'plain-secret' }), [
        PROMPT,
      ]),
    );
    const tool = result.root.tools[0];
    expect(tool).toMatchObject({ kind: 'mcp', name: 'srv' });
    expect(tool).not.toHaveProperty('auth');
    const text = JSON.stringify(result);
    expect(text).not.toContain('abc-secret');
    expect(text).not.toContain('plain-secret');
    expect(verdictOf(result.report, 'h.tools.0.headers.0').verdict).toBe('dropped');
  });

  it('reads a token-vault reference as auth for Authorization and x-api-key', () => {
    const bearer = imported(
      projectOf(remote({ Authorization: `Bearer \${${ARN}KEY_ONE}` }), [PROMPT]),
    );
    expect(bearer.root.tools[0]).toMatchObject({
      auth: { scheme: 'bearer', secretRef: 'KEY_ONE' },
    });
    const key = imported(projectOf(remote({ 'x-api-key': `\${${ARN}KEY_TWO}` }), [PROMPT]));
    expect(key.root.tools[0]).toMatchObject({ auth: { scheme: 'api-key', secretRef: 'KEY_TWO' } });
  });

  it('drops a reference that is not a portable secret name or sits in another header', () => {
    for (const headers of [
      { 'x-api-key': `\${${ARN}lower-case}` },
      { 'x-custom': `\${${ARN}KEY_ONE}` },
      { Authorization: `\${${ARN}KEY_ONE}` },
    ]) {
      const result = imported(projectOf(remote(headers), [PROMPT]));
      expect(result.root.tools[0]).not.toHaveProperty('auth');
      expect(verdictOf(result.report, 'h.tools.0.headers.0').verdict).toBe('dropped');
    }
  });

  it('never copies an apiKeyArn', () => {
    const result = imported(
      projectOf(
        {
          name: 'h',
          model: { provider: 'open_ai', modelId: 'gpt-5', apiKeyArn: `${ARN}OPENAI_KEY` },
        },
        [PROMPT],
      ),
    );
    expect(result.root.model).toEqual({ provider: 'openai', id: 'gpt-5' });
    expect(JSON.stringify(result)).not.toContain('OPENAI_KEY');
    expect(verdictOf(result.report, 'h.model.apiKeyArn').verdict).toBe('dropped');
  });
});

describe('permissions', () => {
  const permissionsOf = (allowedTools?: string[]) =>
    imported(
      projectOf({ name: 'h', ...(allowedTools === undefined ? {} : { allowedTools }) }, [PROMPT]),
    ).root.permissions;
  const all = { readFiles: true, writeFiles: true, runCommands: true, unrestrictedNetwork: true };

  it.each([
    ['absent', undefined, all],
    ['*', ['*'], all],
    ['@builtin', ['@builtin'], all],
    [
      '@builtin/shell',
      ['@builtin/shell'],
      { readFiles: false, writeFiles: false, runCommands: true, unrestrictedNetwork: true },
    ],
    [
      '@builtin/file_operations',
      ['@builtin/file_operations'],
      { readFiles: true, writeFiles: true, runCommands: false, unrestrictedNetwork: false },
    ],
    [
      'only tools',
      ['@zendesk', 'code_interpreter'],
      { readFiles: false, writeFiles: false, runCommands: false, unrestrictedNetwork: false },
    ],
    [
      'empty',
      [],
      { readFiles: false, writeFiles: false, runCommands: false, unrestrictedNetwork: false },
    ],
  ])('allowedTools %s', (_label, allowedTools, expected) => {
    expect(permissionsOf(allowedTools)).toEqual(expected);
  });

  it('says the default is wide open when allowedTools is absent', () => {
    const { report } = imported(projectOf({ name: 'h' }, [PROMPT]));
    expect(verdictOf(report, 'h.permissions.runCommands')).toMatchObject({ verdict: 'mapped' });
  });
});

describe('model', () => {
  const modelOf = (model: unknown) => imported(projectOf({ name: 'h', model }, [PROMPT]));

  it('keeps an unknown Bedrock id without a provider and says so', () => {
    const result = modelOf({ provider: 'bedrock', modelId: 'us.meta.llama4' });
    expect(result.root.model).toEqual({ id: 'us.meta.llama4' });
    expect(verdictOf(result.report, 'h.model').verdict).toBe('mapped');
  });

  it('reverses every confirmed Claude id', () => {
    expect(
      modelOf({ provider: 'bedrock', modelId: 'us.anthropic.claude-opus-4-7' }).root.model,
    ).toEqual({
      provider: 'anthropic',
      id: 'claude-opus-4-7',
    });
  });

  it('keeps gemini and lite_llm ids without a provider', () => {
    for (const provider of ['gemini', 'lite_llm']) {
      expect(modelOf({ provider, modelId: 'm-1' }).root.model).toEqual({ id: 'm-1' });
    }
  });

  it('has no model when the harness has none', () => {
    expect(imported(projectOf({ name: 'h' }, [PROMPT])).root.model).toBeUndefined();
  });
});

describe('tools and drops', () => {
  it('maps the code interpreter and the browser once each', () => {
    const { root } = imported(
      projectOf(
        {
          name: 'h',
          tools: [
            { type: 'agentcore_code_interpreter', name: 'code_interpreter' },
            { type: 'agentcore_browser', name: 'browser' },
            { type: 'agentcore_browser', name: 'browser2' },
          ],
        },
        [PROMPT],
      ),
    );
    expect(root.tools).toEqual([
      { kind: 'builtin', id: 'code_execution' },
      { kind: 'builtin', id: 'web_fetch' },
    ]);
  });

  it('drops what has no portable form and never refuses the project', () => {
    const result = imported(
      projectOf(
        {
          name: 'h',
          tools: [
            {
              type: 'agentcore_gateway',
              name: 'gw',
              config: { agentCoreGateway: { gatewayArn: 'arn:x' } },
            },
            { type: 'inline_function', name: 'fn' },
          ],
          skills: [
            { gitUrl: 'https://git.example.com/s.git' },
            { s3Uri: 's3://bucket/skills/missing/' },
            { awsSkills: {} },
          ],
          maxTokens: 4000,
          timeoutSeconds: 60,
          memory: { mode: 'managed' },
          surprise: true,
        },
        [PROMPT],
      ),
    );
    const dropped = result.report.filter((entry) => entry.verdict === 'dropped');
    expect(dropped.map((entry) => [entry.path, entry.code])).toEqual([
      ['h.tools.0', 'field_unsupported'],
      ['h.tools.1', 'field_unsupported'],
      ['h.skills.0', 'skills_unsupported'],
      ['h.skills.1', 'skills_unsupported'],
      ['h.skills.2', 'skills_unsupported'],
      ['h.maxTokens', 'limits_unsupported'],
      ['h.timeoutSeconds', 'limits_unsupported'],
      ['h.memory', 'field_unsupported'],
      ['h.surprise', 'field_unsupported'],
    ]);
    expect(result.root.limits).toBeUndefined();
  });

  it('drops a tool that allowedTools withholds instead of granting it', () => {
    const tools = [
      {
        type: 'remote_mcp',
        name: 'zendesk',
        config: { remoteMcp: { url: 'https://mcp.example.com/zendesk' } },
      },
      { type: 'agentcore_code_interpreter', name: 'code_interpreter' },
    ];
    for (const allowedTools of [[], ['@github'], ['@zendesk/search']]) {
      const result = imported(projectOf({ name: 'h', tools, allowedTools }, [PROMPT]));
      expect(result.root.tools).toEqual([]);
      for (const path of ['h.tools.0', 'h.tools.1']) {
        expect(verdictOf(result.report, path)).toMatchObject({
          verdict: 'dropped',
          code: 'field_unsupported',
        });
      }
    }
    expect(
      imported(
        projectOf({ name: 'h', tools, allowedTools: ['@zendesk/*', 'code_interpreter'] }, [PROMPT]),
      ).root.tools,
    ).toHaveLength(2);
  });

  it('drops only the tool whose URL carries a credential, without copying it', () => {
    const result = imported(
      projectOf(
        {
          name: 'h',
          tools: [
            {
              type: 'remote_mcp',
              name: 'good',
              config: { remoteMcp: { url: 'https://m.example.com/mcp' } },
            },
            {
              type: 'remote_mcp',
              name: 'bad',
              config: { remoteMcp: { url: 'https://user:pw-do-not-leak@m.example.com/mcp' } },
            },
          ],
        },
        [PROMPT],
      ),
    );
    expect(result.root.tools.map((tool) => (tool.kind === 'mcp' ? tool.name : tool.kind))).toEqual([
      'good',
    ]);
    expect(verdictOf(result.report, 'h.tools.1').verdict).toBe('dropped');
    expect(JSON.stringify(result)).not.toContain('pw-do-not-leak');
  });

  it('drops memory and limits of any shape instead of refusing', () => {
    const result = imported(
      projectOf({ name: 'h', memory: { strategy: 'x' }, maxTokens: '4000', timeoutSeconds: null }, [
        PROMPT,
      ]),
    );
    expect(verdictOf(result.report, 'h.memory').verdict).toBe('dropped');
    expect(verdictOf(result.report, 'h.maxTokens').verdict).toBe('dropped');
    expect(
      imported(projectOf({ name: 'h', memory: { mode: 'disabled' } }, [PROMPT])).report.some(
        (entry) => entry.path === 'h.memory',
      ),
    ).toBe(false);
  });

  it('imports a path skill that is in the files', () => {
    const { root, project } = imported(
      projectOf({ name: 'h', skills: [{ path: 'skills/local' }] }, [
        PROMPT,
        { path: 'app/h/skills/local/SKILL.md', content: '---\nname: local\n---\n' },
      ]),
    );
    expect(root.skills).toEqual([{ name: 'local', path: 'skills/local' }]);
    expect(project.skills.map((skill) => skill.name)).toEqual(['local']);
  });
});

describe('vendor project shape', () => {
  it('imports every harness of the project, the first as the root', () => {
    const files: PlatformFile[] = [
      {
        path: 'agentcore/agentcore.json',
        content: JSON.stringify({
          harnesses: [
            { name: 'PRReviewer', path: 'app/PRReviewer' },
            { name: 'second_one', path: 'app/second_one' },
          ],
        }),
      },
      { path: 'app/PRReviewer/harness.json', content: JSON.stringify({ name: 'PRReviewer' }) },
      { path: 'app/PRReviewer/system-prompt.md', content: 'one\n' },
      { path: 'app/second_one/harness.json', content: JSON.stringify({ name: 'second_one' }) },
      { path: 'app/second_one/system-prompt.md', content: 'two\n' },
    ];
    const { project, report } = imported(files);
    expect(project.root).toBe('prreviewer');
    expect(project.agents.map((agent) => agent.name)).toEqual(['prreviewer', 'second-one']);
    expect(verdictOf(report, 'prreviewer.name').verdict).toBe('mapped');
  });
});

describe('refusals', () => {
  const secret = 'sk-live-do-not-leak';
  const cases: [string, unknown, string][] = [
    [
      'invalid JSON',
      [{ path: 'agentcore/agentcore.json', content: `{ ${secret}` }],
      'platform_options_invalid',
    ],
    [
      'a missing project file',
      [{ path: 'app/h/harness.json', content: '{}' }],
      'platform_agent_not_found',
    ],
    [
      'a missing harness file',
      [
        {
          path: 'agentcore/agentcore.json',
          content: JSON.stringify({ harnesses: [{ name: 'h', path: 'app/h' }] }),
        },
      ],
      'platform_agent_not_found',
    ],
    [
      'a project with no harness',
      [{ path: 'agentcore/agentcore.json', content: '{"harnesses":[]}' }],
      'platform_agent_not_found',
    ],
    ['a harness with no prompt', projectOf({ name: 'h' }), 'platform_options_invalid'],
    [
      'non-UTF-8 bytes',
      projectOf({ name: 'h' }, [
        { path: 'app/h/system-prompt.md', content: new Uint8Array([0xff, 0xfe]) },
      ]),
      'platform_options_invalid',
    ],
    [
      'a harness name that is no agent name',
      projectOf({ name: '9_x!' }, [PROMPT]),
      'platform_options_invalid',
    ],
    ['a file list that is not an array', { files: secret }, 'platform_options_invalid'],
    [
      'a duplicated file',
      [...projectOf({ name: 'h' }, [PROMPT]), PROMPT],
      'platform_options_invalid',
    ],
  ];

  it.each(cases)('refuses %s with a typed code and no input text', (_label, files, code) => {
    const refusal = refusalOf(files);
    expect(refusal.code).toBe(code);
    expect(JSON.stringify(refusal)).not.toContain(secret);
  });

  it('refuses two harnesses that collapse to one agent name', () => {
    const files: PlatformFile[] = [
      {
        path: 'agentcore/agentcore.json',
        content: JSON.stringify({
          harnesses: [
            { name: 'A_b', path: 'app/one' },
            { name: 'a_B', path: 'app/two' },
          ],
        }),
      },
      { path: 'app/one/harness.json', content: JSON.stringify({ name: 'A_b' }) },
      { path: 'app/two/harness.json', content: JSON.stringify({ name: 'a_B' }) },
    ];
    expect(refusalOf(files)).toMatchObject({ code: 'platform_options_invalid' });
  });

  it('does not forward the parser text of a harness file that holds a secret', () => {
    const refusal = refusalOf(
      projectOf({ name: 'h', tools: [{ type: 'remote_mcp', name: secret, config: 7 }] }, [PROMPT]),
    );
    expect(JSON.stringify(refusal)).not.toContain(secret);
  });
});
