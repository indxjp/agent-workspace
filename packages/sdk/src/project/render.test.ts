import ts from 'typescript';
import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';

import { ENGINE_IDS } from '@indx-workspace/contracts/engines';
import { EvalCaseFileSchema } from '@indx-workspace/contracts/evaluations';
import {
  SETUP_THEMES,
  THEME_RECOMMENDATIONS,
  withRecommendedAnswers,
  type CompleteSetupAnswers,
  type SetupAnswers,
} from '@indx-workspace/contracts/setup';
import { selectAllowedOperations } from '@indx-workspace/contracts/tool-connectors';

import { ENGINE_PACKAGES } from './dependencies.js';
import { ProjectRenderError } from './errors.js';
import { parseProjectFile } from './parse.js';
import {
  projectNameFor,
  renderProjectFiles,
  renderProjectShell,
  setupSecretNames,
} from './render.js';

const recommended = withRecommendedAnswers({});

/** The recommended answers with `answers` over them, rendered for `my-project`. */
function rendered(answers: SetupAnswers): readonly { path: string; contents: string }[] {
  return renderProjectFiles(withRecommendedAnswers(answers), {
    name: 'my-project',
    version: '0.4.0',
  });
}

const ORDERS_ANSWERS = {
  'content.internalTools': ['openapi'],
  'content.openapiDocument': 'apis/orders.openapi.json',
} as const satisfies SetupAnswers;

function contentsOf(files: readonly { path: string; contents: string }[], path: string): string {
  const file = files.find((candidate) => candidate.path === path);
  if (file === undefined) throw new Error(`no ${path} was rendered`);
  return file.contents;
}

function renderError(render: () => unknown): ProjectRenderError {
  try {
    render();
  } catch (thrown) {
    if (thrown instanceof ProjectRenderError) return thrown;
    throw thrown;
  }
  throw new Error('expected a ProjectRenderError');
}

/** The value of the string literal a rendered file gives a property, read by TypeScript itself. */
function literalOf(source: string, property: string): string {
  const file = ts.createSourceFile('main.ts', source, ts.ScriptTarget.ES2023, true);
  let found: string | undefined;
  const visit = (node: ts.Node): void => {
    if (
      ts.isPropertyAssignment(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === property &&
      ts.isStringLiteral(node.initializer)
    ) {
      found = node.initializer.text;
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  if (found === undefined) throw new Error(`no ${property} literal`);
  return found;
}

describe('renderProjectFiles', () => {
  it.each(SETUP_THEMES.filter((theme) => theme !== 'blank'))(
    'renders evals/<agent>.yaml with cases the eval schema accepts for theme %s',
    (theme) => {
      const answers = withRecommendedAnswers({ 'setup.theme': theme });
      const files = renderProjectFiles(answers, { name: 'my-project', version: '0.4.0' });
      const file = contentsOf(files, `evals/${answers['content.agentName']}.yaml`);
      const parsed = EvalCaseFileSchema.parse(parseYaml(file));
      expect(parsed.cases.length).toBeGreaterThanOrEqual(2);
    },
  );

  it.each([
    ['support', 'refund-policy'],
    ['knowledge', 'cite-sources'],
  ] as const)('renders one example skill the agent lists for theme %s (#694)', (theme, name) => {
    const answers = withRecommendedAnswers({ 'setup.theme': theme });
    const files = renderProjectFiles(answers, { name: 'my-project' });
    expect(files.map((file) => file.path)).toContain(`skills/${name}/SKILL.md`);
    expect(contentsOf(files, `skills/${name}/SKILL.md`)).toMatch(
      new RegExp(`^---.name: ${name}.description: .+.---.+`, 'su'),
    );
    const agent = contentsOf(files, `agents/${answers['content.agentName']}.ts`);
    expect(agent).toContain(`import { defineAgent, skill } from`);
    expect(agent).toContain(`skills: [
    skill('${name}'),
  ],`);
  });

  it('shows the files() grant only as a comment, so a fresh project grants no folder (#1132)', () => {
    const agent = contentsOf(rendered(ORDERS_ANSWERS), 'agents/assistant.ts');
    expect(agent).toContain("\n//   files: [files('uploads')],\n");
    expect(agent).not.toMatch(/^\s*files:/mu);
    expect(agent).not.toMatch(/^import .*\bfiles\b/mu);
  });

  it('leaves permissions out of the files() comment when the answers already grant readFiles (#1132)', () => {
    const agent = contentsOf(
      rendered({ ...ORDERS_ANSWERS, 'content.permissions': ['readFiles'] }),
      'agents/assistant.ts',
    );
    expect(agent).toContain("\n//   files: [files('uploads')],\n");
    expect(agent).not.toMatch(/^\/\/ {3}permissions:/mu);
    expect(agent.match(/^\s*permissions:/gmu)).toHaveLength(1);
  });

  it('renders no skill for the blank and copilot themes', () => {
    for (const theme of ['blank', 'copilot'] as const) {
      const paths = rendered({ 'setup.theme': theme }).map((file) => file.path);
      expect(paths.some((file) => file.startsWith('skills/'))).toBe(false);
    }
  });

  it('renders theme blank as the slice-1 files, byte for byte', () => {
    const files = rendered({ 'setup.theme': 'blank' });
    expect(files.map((file) => file.path)).toStrictEqual([
      'agent-workspace.yaml',
      'agents/assistant.ts',
      'surfaces/main.ts',
      'AGENTS.md',
    ]);
    expect(contentsOf(files, 'agent-workspace.yaml')).toBe(
      `# The Agent Workspace project file: what \`aw dev\` runs, and where.
# No secret belongs in this file; it is meant to be committed.
# \`aw dev\` reads the model key from ANTHROPIC_API_KEY in its own environment.
apiVersion: agentworkspace.dev/v2
kind: Project
name: my-project
environments:
  local:
    cloud: local
    identity:
      bootstrapAdmin: admin@localhost.test
`,
    );
    expect(contentsOf(files, 'agents/assistant.ts')).toBe(
      `import { defineAgent } from '@indx-workspace/sdk/define';

// To let the agent read files you upload on the Files screen, add \`files\` to the import
// above and grant a folder:
//   permissions: { readFiles: true },
//   files: [files('uploads')],
// The folder must exist in the workspace first, or \`aw dev\` reports it as missing.
export default defineAgent({
  name: 'assistant',
  instructions: 'You are a helpful assistant. Answer clearly and briefly, and say so when you are not sure.',
  engine: 'claude-agent-sdk',
  model: 'default',
});
`,
    );
    expect(contentsOf(files, 'surfaces/main.ts')).toBe(
      `import { defineSurface } from '@indx-workspace/sdk/define';

export default defineSurface({
  name: 'main',
  agent: 'assistant',
  title: 'Assistant',
  theme: {
    colour: '#2f5fd0',
  },
});
`,
    );
  });

  it('writes an AGENTS.md that names the model key variable, no key, and the background start', () => {
    const agents = contentsOf(rendered({ 'admin.modelProvider': 'openai' }), 'AGENTS.md');
    expect(agents).toContain('$env:OPENAI_API_KEY');
    expect(agents).toContain('bash/zsh');
    expect(agents).not.toContain('POSIX');
    expect(agents).toContain('lists `.env` and `.aw/`');
    expect(agents).not.toMatch(/are git-ignored/u);
    expect(agents).toContain('read -rs OPENAI_API_KEY && export OPENAI_API_KEY');
    expect(agents).not.toContain('ANTHROPIC_API_KEY');
    expect(agents).toContain('.aw/logs/runtime.log');
    expect(agents).toContain('npx aw chat -p');
    expect(agents).toContain('setsid npm run dev >> .aw/dev.out');
    expect(agents).toContain('npx aw dev stop');
    expect(agents).toContain('Start-Process');
    expect(agents).not.toMatch(/sk-/u);
  });

  it('lists the tool secrets next to the model key in AGENTS.md', () => {
    const agents = contentsOf(rendered(ORDERS_ANSWERS), 'AGENTS.md');
    for (const name of setupSecretNames(withRecommendedAnswers(ORDERS_ANSWERS))) {
      expect(agents).toContain(`\`${name}\``);
    }
    expect(agents).toContain('tool secrets');
  });

  describe('platforms (#977)', () => {
    const TWO = ['copilot-studio', 'claude-managed-agents'] as const;

    it.each(SETUP_THEMES)(
      'writes no platform file or text when none is chosen, theme %s',
      (theme) => {
        const files = rendered({ 'setup.theme': theme });
        for (const { path, contents } of files) {
          expect(contents, path).not.toContain('platforms');
        }
        expect(files.some((file) => file.path === 'README.md')).toBe(theme !== 'blank');
      },
    );

    it('writes the platforms block in PLATFORM_IDS order, and a project file that reads back', () => {
      const files = rendered({ 'setup.theme': 'support', 'admin.platforms': TWO });
      const text = contentsOf(files, 'agent-workspace.yaml');
      expect(text).toContain(
        'platforms:\n  claude-managed-agents:\n    enabled: true\n  copilot-studio:\n    enabled: true\n',
      );
      expect(parseProjectFile(text).project).toMatchObject({
        platforms: {
          'claude-managed-agents': { enabled: true },
          'copilot-studio': { enabled: true },
        },
      });
    });

    it("appends the section to the starter's README.md, with the commands of each platform", () => {
      const without = contentsOf(rendered({ 'setup.theme': 'support' }), 'README.md');
      const readme = contentsOf(
        rendered({ 'setup.theme': 'support', 'admin.platforms': TWO }),
        'README.md',
      );
      expect(readme.startsWith(`${without}\n## Publish to other agent platforms\n\n`)).toBe(true);
      expect(readme).toContain('`agents/assistant.ts` stays the one definition');
      expect(readme).toContain(
        'npx aw platforms export --platform claude-managed-agents    # writes platforms/claude-managed-agents/ and PLATFORM_REPORT.md; sends nothing\n' +
          'npx aw platforms publish --platform claude-managed-agents   # shows the plan; add --yes to publish with your own vendor login\n' +
          'npx aw platforms export --platform copilot-studio           # writes platforms/copilot-studio/ and PLATFORM_REPORT.md; sends nothing\n' +
          'npx aw platforms publish --platform copilot-studio          # shows the plan; add --yes to publish with your own vendor login\n' +
          'npx aw platforms doctor                                     # checks every enabled platform and its vendor CLI\n',
      );
      expect(readme.match(/aw platforms doctor/gu)).toHaveLength(1);
      expect(readme.endsWith('add `--strict` to `export` to fail instead.\n')).toBe(true);
    });

    it('adds a README.md for the blank theme, which has none', () => {
      const without = rendered({ 'setup.theme': 'blank' }).map((file) => file.path);
      const files = rendered({ 'setup.theme': 'blank', 'admin.platforms': ['aws-agentcore'] });
      expect(files.map((file) => file.path)).toStrictEqual([
        ...without.slice(0, 3),
        'README.md',
        'AGENTS.md',
      ]);
      expect(contentsOf(files, 'README.md')).toMatch(
        /^# assistant\n\n## Publish to other agent platforms\n\n/u,
      );
    });

    it('ends AGENTS.md with the section naming the platforms in PLATFORM_IDS order', () => {
      const agents = contentsOf(
        rendered({ 'setup.theme': 'support', 'admin.platforms': TWO }),
        'AGENTS.md',
      );
      const base = contentsOf(rendered({ 'setup.theme': 'support' }), 'AGENTS.md');
      expect(agents.startsWith(`${base}\n## Other agent platforms\n`)).toBe(true);
      expect(agents).toContain('(claude-managed-agents, copilot-studio)');
      expect(agents.endsWith('Never put a credential on the command line or in a file.\n')).toBe(
        true,
      );
    });

    it.each(SETUP_THEMES)('writes no .agent.md for theme %s', (theme) => {
      const files = rendered({ 'setup.theme': theme, 'admin.platforms': TWO });
      expect(files.some((file) => file.path.endsWith('.agent.md'))).toBe(false);
    });
  });

  it('writes a project file parseProjectFile reads back', () => {
    const files = renderProjectFiles(recommended, { name: 'my-project' });
    expect(parseProjectFile(contentsOf(files, 'agent-workspace.yaml'))).toStrictEqual({
      lifted: false,
      project: {
        apiVersion: 'agentworkspace.dev/v2',
        kind: 'Project',
        name: 'my-project',
        environments: {
          local: { cloud: 'local', identity: { bootstrapAdmin: 'admin@localhost.test' } },
        },
      },
    });
  });

  it.each(['local', 'sandbox-runtime'] as const)(
    'names the local runtime for sandbox %s, never an unimplemented driver (#818)',
    (sandbox) => {
      const files = renderProjectFiles(
        { ...recommended, 'admin.sandbox': sandbox },
        { name: 'my-project' },
      );
      const read = parseProjectFile(contentsOf(files, 'agent-workspace.yaml'));
      expect(read.project.environments.local?.runtime).toStrictEqual({ default: 'local' });
    },
  );

  it('writes the surface title and brand colour from the answers', () => {
    const answers: CompleteSetupAnswers = {
      ...recommended,
      'content.agentName': 'helper',
      'embedder.surfaceTitle': 'Acme Help',
      'embedder.brandColour': '#AA0011',
    };
    const files = renderProjectFiles(answers, { name: 'my-project' });
    const surface = contentsOf(files, 'surfaces/main.ts');
    expect(literalOf(surface, 'title')).toBe('Acme Help');
    expect(literalOf(surface, 'colour')).toBe('#AA0011');
    expect(literalOf(surface, 'agent')).toBe('helper');
    expect(files.map((file) => file.path)).toContain('agents/helper.ts');
  });

  it("keeps a title with ' and \\ intact in the TypeScript literal", () => {
    const title = "Ada's \\ desk";
    const files = renderProjectFiles(
      { ...recommended, 'embedder.surfaceTitle': title },
      { name: 'my-project' },
    );
    expect(literalOf(contentsOf(files, 'surfaces/main.ts'), 'title')).toBe(title);
  });

  it.each(ENGINE_IDS)('renders an agent on the %s engine', (engine) => {
    const files = renderProjectFiles(
      { ...recommended, 'content.engine': engine },
      { name: 'my-project' },
    );
    expect(literalOf(contentsOf(files, 'agents/assistant.ts'), 'engine')).toBe(engine);
  });

  it("pins the copilot page's packages to the project's version, and needs one", () => {
    const answers = { ...recommended, 'setup.theme': 'copilot' } as const;
    const files = renderProjectFiles(answers, { name: 'my-project', version: '1.2.3' });
    const page = JSON.parse(contentsOf(files, 'web/package.json')) as {
      dependencies: Record<string, string>;
      scripts: Record<string, string>;
    };
    expect(page.dependencies['@indx-workspace/react']).toBe('1.2.3');
    expect(page.dependencies['@indx-workspace/sdk']).toBe('1.2.3');
    // `aw deploy` builds web/ as a Vercel project and points it at the control plane (#830).
    expect(page.scripts['build']).toBe('vite build');
    expect(contentsOf(files, 'web/main.jsx')).toContain('import.meta.env.VITE_AW_BASE_URL');
    const error = renderError(() => renderProjectFiles(answers, { name: 'my-project' }));
    expect(error.issues.map((issue) => issue.path)).toStrictEqual(['version']);
    expect(files.map((file) => file.path)).toContain('web/main.jsx');
    expect(files.map((file) => file.path).some((each) => each.includes('.template'))).toBe(false);
  });

  it('refuses an invalid answer, naming it', () => {
    const answers = { ...recommended, 'embedder.brandColour': 'blue' };
    const error = renderError(() => renderProjectFiles(answers, { name: 'my-project' }));
    expect(error.issues.map((issue) => issue.path)).toStrictEqual(['embedder.brandColour']);
  });

  it('refuses a project name outside the name-key grammar', () => {
    const error = renderError(() => renderProjectFiles(recommended, { name: 'My Project' }));
    expect(error.issues.map((issue) => issue.path)).toStrictEqual(['name']);
  });

  it('refuses a missing project argument with a ProjectRenderError', () => {
    const missing: unknown = undefined;
    const error = renderError(() =>
      renderProjectFiles(recommended, missing as { readonly name: string }),
    );
    expect(error.issues.map((issue) => issue.path)).toStrictEqual(['(root)']);
  });

  it('refuses a project argument with a key it does not know', () => {
    const project = { name: 'my-project', extra: '0.3.0' };
    const error = renderError(() => renderProjectFiles(recommended, project));
    expect(error.issues.map((issue) => issue.path)).toStrictEqual(['(root)']);
  });

  it('returns frozen files', () => {
    const files = renderProjectFiles(recommended, { name: 'my-project' });
    expect(Object.isFrozen(files)).toBe(true);
    expect(files.every((file) => Object.isFrozen(file))).toBe(true);
  });

  it("writes the recommended theme support's instructions, greeting and prompts (#543)", () => {
    const files = rendered({});
    const { content } = THEME_RECOMMENDATIONS.support;
    const surface = contentsOf(files, 'surfaces/main.ts');
    expect(literalOf(contentsOf(files, 'agents/assistant.ts'), 'instructions')).toBe(
      content.instructions,
    );
    expect(literalOf(surface, 'greeting')).toBe(content.greeting);
    expect(surface).toContain(
      `  parts: {\n    greeting: 'Hi! How can I help you today?',\n    suggestedPrompts: [\n` +
        `      'I have a question about my account',\n`,
    );
    expect(contentsOf(files, 'agent-workspace.yaml')).toBe(
      contentsOf(rendered({ 'setup.theme': 'blank' }), 'agent-workspace.yaml'),
    );
  });

  it.each(SETUP_THEMES)('renders theme %s with prompts exactly when it has some', (theme) => {
    const surface = contentsOf(rendered({ 'setup.theme': theme }), 'surfaces/main.ts');
    const { content } = THEME_RECOMMENDATIONS[theme];
    expect(surface.includes('suggestedPrompts')).toBe(content.prompts.length > 0);
    expect(surface.includes('greeting')).toBe(content.greeting !== undefined);
  });

  it.each(['assistant', 'a-much-longer-agent-name'])(
    "aligns the starter README's file map once the agent is named %s (BH061-075)",
    (agentName) => {
      const readme = contentsOf(
        rendered({ 'setup.theme': 'automation', 'content.agentName': agentName }),
        'README.md',
      );
      const map = /```text\n([\s\S]*?)```/u.exec(readme)?.[1] ?? '';
      const columns = map
        .trimEnd()
        .split('\n')
        .map((line) => /^\S+ +/u.exec(line)?.[0].length);
      expect(new Set(columns).size).toBe(1);
    },
  );

  it('writes an OpenAPI tool the agent imports and lists, and names its secret (#543)', () => {
    const files = rendered(ORDERS_ANSWERS);
    expect(files.map((file) => file.path)).toStrictEqual([
      'agent-workspace.yaml',
      'agents/assistant.ts',
      'surfaces/main.ts',
      'tools/orders.ts',
      'README.md',
      'evals/assistant.yaml',
      'AGENTS.md',
      'skills/refund-policy/SKILL.md',
    ]);
    expect(contentsOf(files, 'tools/orders.ts')).toBe(
      `import { openapiTool, secret } from '@indx-workspace/sdk/define';

export default openapiTool({
  name: 'orders',
  spec: 'apis/orders.openapi.json',
  auth: secret('ORDERS_TOKEN'),
  allow: ['GET /**'],
});
`,
    );
    const agent = contentsOf(files, 'agents/assistant.ts');
    expect(agent).toContain(
      `from '@indx-workspace/sdk/define';\n\nimport ordersTool from '../tools/orders';\n\n`,
    );
    expect(agent).toContain('  tools: [\n    ordersTool,\n  ],\n');
    expect(setupSecretNames(withRecommendedAnswers(ORDERS_ANSWERS))).toStrictEqual([
      'ANTHROPIC_API_KEY',
      'ORDERS_TOKEN',
    ]);
  });

  it("admits a GET-only document's operation with every rule of the rendered allow list (#603)", () => {
    const rules = /allow: \[(.*)\],/.exec(
      contentsOf(rendered(ORDERS_ANSWERS), 'tools/orders.ts'),
    )?.[1];
    if (rules === undefined) throw new Error('tools/orders.ts renders no allow list');
    const allow = rules.split(', ').map((rule) => rule.slice(1, -1));
    const getOnly = [{ method: 'get', path: '/orders/{orderNumber}', operationId: 'getOrder' }];
    expect(selectAllowedOperations(allow, getOnly)).toStrictEqual({
      admitted: getOnly,
      refusals: [],
    });
  });

  it('names an OpenAPI tool after the last non-empty path segment of an https document', () => {
    const name = (document: string): readonly string[] =>
      setupSecretNames(
        withRecommendedAnswers({
          'content.internalTools': ['openapi'],
          'content.openapiDocument': document,
        }),
      );
    expect(name('https://api.example.com/v1/')).toContain('V1_TOKEN');
    expect(name('https://api.example.com')).toContain('API_TOKEN');
  });

  it('names an OpenAPI tool from an https document after its file name', () => {
    const answers = {
      'content.internalTools': ['openapi'],
      'content.openapiDocument': 'https://api.example.com/v1/billing.yaml?v=2',
    } as const satisfies SetupAnswers;
    expect(rendered(answers).map((file) => file.path)).toContain('tools/billing.ts');
    expect(setupSecretNames(withRecommendedAnswers(answers))).toStrictEqual([
      'ANTHROPIC_API_KEY',
      'BILLING_TOKEN',
    ]);
  });

  it('writes the PostgreSQL tool with its URL as the secret POSTGRES_URL', () => {
    const files = rendered({ ...ORDERS_ANSWERS, 'content.internalTools': ['openapi', 'postgres'] });
    expect(files.map((file) => file.path).slice(3, 5)).toStrictEqual([
      'tools/orders.ts',
      'tools/postgres.ts',
    ]);
    expect(contentsOf(files, 'tools/postgres.ts')).toContain(
      "  url: secret('POSTGRES_URL'),\n  readOnly: true,\n",
    );
    expect(contentsOf(files, 'agents/assistant.ts')).toContain(
      '  tools: [\n    ordersTool,\n    postgresTool,\n  ],\n',
    );
  });

  it.each(['aw', '2024'])('refuses the document %s.json, whose secret is refused', (name) => {
    const error = renderError(() =>
      rendered({ 'content.internalTools': ['openapi'], 'content.openapiDocument': `${name}.json` }),
    );
    expect(error.message).toContain(`tools/${name}.ts could not be rendered`);
  });

  it('switches on the permissions the answers name, in contract order', () => {
    const files = rendered({ 'content.permissions': ['runCommands', 'readFiles'] });
    expect(contentsOf(files, 'agents/assistant.ts')).toContain(
      '  permissions: {\n    readFiles: true,\n    runCommands: true,\n  },\n',
    );
  });

  it('writes no model connection for anthropic', () => {
    expect(contentsOf(rendered({}), 'agent-workspace.yaml')).not.toContain('models');
  });

  it('writes models.default for openai, with its key by secret reference', () => {
    const yaml = contentsOf(rendered({ 'admin.modelProvider': 'openai' }), 'agent-workspace.yaml');
    expect(yaml).toContain('# `aw dev` reads the model key from OPENAI_API_KEY in its own');
    // openai runs on the provider's own defaults: no endpoint, deployment or version is written.
    expect(yaml).not.toContain('your-');
    const { project } = parseProjectFile(yaml);
    expect('models' in project && project.models).toStrictEqual({
      default: { provider: 'openai', credential: { secret: 'OPENAI_API_KEY' } },
    });
    expect(setupSecretNames(withRecommendedAnswers({ 'admin.modelProvider': 'openai' }))).toEqual([
      'OPENAI_API_KEY',
    ]);
  });

  it('writes the endpoint answered with --model-base-url, not a placeholder', () => {
    const yaml = contentsOf(
      rendered({
        'admin.modelProvider': 'openai-compatible',
        'admin.modelBaseUrl': 'http://localhost:11434/v1',
      }),
      'agent-workspace.yaml',
    );
    expect(yaml).not.toContain('your-');
    const { project } = parseProjectFile(yaml);
    expect('models' in project && project.models).toStrictEqual({
      default: {
        provider: 'openai-compatible',
        credential: { secret: 'OPENAI_API_KEY' },
        baseUrl: 'http://localhost:11434/v1',
      },
    });
  });

  it('writes the endpoint for anthropic-compatible, which asks for one (BH061-044)', () => {
    const yaml = contentsOf(
      rendered({
        'admin.modelProvider': 'anthropic-compatible',
        'admin.modelBaseUrl': 'https://llm-proxy.example.com',
      }),
      'agent-workspace.yaml',
    );
    const { project } = parseProjectFile(yaml);
    expect('models' in project && project.models).toStrictEqual({
      default: {
        provider: 'anthropic-compatible',
        credential: { secret: 'ANTHROPIC_API_KEY' },
        baseUrl: 'https://llm-proxy.example.com',
      },
    });
  });

  it.each(['anthropic-compatible', 'openai-compatible', 'azure-openai'] as const)(
    'refuses %s without --model-base-url instead of writing a placeholder endpoint',
    (provider) => {
      expect(() => rendered({ 'admin.modelProvider': provider })).toThrow(
        `--model-base-url is required when --provider is ${provider}`,
      );
    },
  );

  it('writes placeholders for the settings azure-openai requires, and says so', () => {
    const yaml = contentsOf(
      rendered({
        'admin.modelProvider': 'azure-openai',
        'admin.modelBaseUrl': 'https://my-resource.openai.azure.com/',
      }),
      'agent-workspace.yaml',
    );
    expect(yaml).toContain('# Replace each `your-` value under models.default before `aw dev`.\n');
    const { project } = parseProjectFile(yaml);
    expect('models' in project && project.models).toStrictEqual({
      default: {
        provider: 'azure-openai',
        credential: { secret: 'AZURE_OPENAI_API_KEY' },
        baseUrl: 'https://my-resource.openai.azure.com/',
        apiVersion: 'your-api-version',
        deployment: 'your-deployment',
      },
    });
  });
});

describe('renderProjectShell', () => {
  it('renders the shell byte for byte', () => {
    const files = renderProjectShell({
      name: 'my-project',
      version: '0.3.0',
      engine: 'claude-agent-sdk',
    });
    expect(files.map((file) => file.path)).toStrictEqual([
      'package.json',
      'pnpm-workspace.yaml',
      '.gitignore',
    ]);
    expect(contentsOf(files, 'package.json')).toBe(
      `{
  "name": "my-project",
  "private": true,
  "type": "module",
  "engines": {
    "node": ">=24"
  },
  "scripts": {
    "dev": "aw dev"
  },
  "dependencies": {
    "@indx-workspace/aw": "0.3.0",
    "@indx-workspace/embedded": "0.3.0",
    "@indx-workspace/sdk": "0.3.0",
    "@anthropic-ai/claude-agent-sdk": "0.3.296",
    "@anthropic-ai/sdk": "0.133.0"
  },
  "devDependencies": {
    "@indx-workspace/cli": "0.3.0"
  },
  "allowScripts": {
    "@embedded-postgres/darwin-arm64": true,
    "@embedded-postgres/darwin-x64": true,
    "@embedded-postgres/linux-arm": true,
    "@embedded-postgres/linux-arm64": true,
    "@embedded-postgres/linux-ia32": true,
    "@embedded-postgres/linux-ppc64": true,
    "@embedded-postgres/linux-x64": true,
    "@embedded-postgres/windows-x64": true,
    "esbuild": false,
    "@google/genai": false,
    "protobufjs": false
  },
  "overrides": {
    "undici@>=7.0.0 <7.29.1": "^7.29.1"
  }
}
`,
    );
    expect(contentsOf(files, 'pnpm-workspace.yaml')).toBe(
      `# pnpm 11 refuses to install a package whose install script has no answer, so every package
# of the Agent Workspace runtime's dependency tree that ships one is answered here. The
# answers are copied from the Agent Workspace repository root.
allowBuilds:
  '@embedded-postgres/darwin-arm64': true
  '@embedded-postgres/darwin-x64': true
  '@embedded-postgres/linux-arm': true
  '@embedded-postgres/linux-arm64': true
  '@embedded-postgres/linux-ia32': true
  '@embedded-postgres/linux-ppc64': true
  '@embedded-postgres/linux-x64': true
  '@embedded-postgres/windows-x64': true
  'esbuild': false
  '@google/genai': false
  'protobufjs': false
# Security overrides of the runtime tree, also copied from the repository root.
overrides:
  'undici@>=7.0.0 <7.29.1': '^7.29.1'
`,
    );
    expect(contentsOf(files, '.gitignore')).toBe('node_modules/\n.agent-workspace/\n.aw/\n.env\n');
    expect(Object.isFrozen(files)).toBe(true);
  });

  it('pins the three packages at the exact version and the chosen engine only, with aw dev', () => {
    const files = renderProjectShell({ name: 'my-project', version: '1.2.3-rc.1', engine: 'pi' });
    const manifest: unknown = JSON.parse(contentsOf(files, 'package.json'));
    expect(manifest).toMatchObject({ type: 'module', scripts: { dev: 'aw dev' } });
    expect(manifest).toHaveProperty('dependencies', {
      '@indx-workspace/aw': '1.2.3-rc.1',
      '@indx-workspace/embedded': '1.2.3-rc.1',
      '@indx-workspace/sdk': '1.2.3-rc.1',
      ...ENGINE_PACKAGES.pi,
    });
    // `aw deploy` imports `@indx-workspace/cli/deploy`, so a fresh project carries it at aw's pin.
    expect(manifest).toHaveProperty('devDependencies', { '@indx-workspace/cli': '1.2.3-rc.1' });
  });

  it.each([
    '^0.3.0',
    '0.3',
    'latest',
    '0.3.0 ',
    '01.2.3',
    '1.02.3',
    '1.2.03',
    '1.2.3-..',
    '1.2.3-',
    '1.2.3-rc..1',
    '1.2.3-01',
    '1.2.3+build',
    '99999999999999999999.0.0',
  ])('refuses the version %j', (version) => {
    const error = renderError(() =>
      renderProjectShell({ name: 'my-project', version, engine: 'pi' }),
    );
    expect(error.issues.map((issue) => issue.path)).toStrictEqual(['version']);
  });

  it('refuses a project name outside the name-key grammar', () => {
    const error = renderError(() =>
      renderProjectShell({ name: '-x', version: '0.3.0', engine: 'pi' }),
    );
    expect(error.issues.map((issue) => issue.path)).toStrictEqual(['name']);
  });

  it.each(['1.2.3-0', '1.2.3--', '1.2.3-0a', '1.2.3-rc.1.x-y', '0.0.0'])(
    'accepts the semver version %j',
    (version) => {
      expect(() => renderProjectShell({ name: 'my-project', version, engine: 'pi' })).not.toThrow();
    },
  );

  it('refuses a missing project argument with a ProjectRenderError', () => {
    const missing: unknown = undefined;
    const error = renderError(() =>
      renderProjectShell(missing as Parameters<typeof renderProjectShell>[0]),
    );
    expect(error.issues.map((issue) => issue.path)).toStrictEqual(['(root)']);
  });
});

describe('projectNameFor', () => {
  it.each([
    ['my-project', 'my-project'],
    ['My Project', 'my-project'],
    ['  Acme__AI  Bot!! ', 'acme-ai-bot'],
    ['café', 'caf'],
    ['--', 'agent-workspace'],
    ['', 'agent-workspace'],
    ['日本語', 'agent-workspace'],
  ])('names %j as %j', (directory, name) => {
    expect(projectNameFor(directory)).toBe(name);
  });

  it('refuses a directory name that is not text with a ProjectRenderError', () => {
    const missing: unknown = undefined;
    const error = renderError(() => projectNameFor(missing as string));
    expect(error.issues).toStrictEqual([{ path: '(root)', message: 'must be text' }]);
  });

  it('cuts a long name to 64 characters with no hyphen at the end', () => {
    const name = projectNameFor(`${'a'.repeat(63)} b${'c'.repeat(40)}`);
    expect(name).toBe('a'.repeat(63));
    expect(name.length).toBeLessThanOrEqual(64);
    expect(projectNameFor('x'.repeat(100))).toBe('x'.repeat(64));
  });
});

describe('the automation starter beside a setup-generated OpenAPI tool', () => {
  const automation = (document: string) =>
    ({
      'setup.theme': 'automation',
      'content.internalTools': ['openapi'],
      'content.openapiDocument': document,
    }) as const satisfies SetupAnswers;

  it.each(['https://example.com/orders.json', 'apis/delivery-estimate.openapi.json'])(
    'refuses %s, whose tool would overwrite a starter file, naming the path',
    (document) => {
      const error = renderError(() => rendered(automation(document)));
      expect(error.issues[0]?.path).toBe('content.openapiDocument');
      expect(error.issues[0]?.message).toMatch(
        /would write tools\/[a-z-]+\.ts.*rename the document/u,
      );
    },
  );

  it('renders a document with another name beside the starter tools, each file once', () => {
    const files = rendered(automation('apis/billing.openapi.json'));
    const paths = files.map((file) => file.path);
    expect(new Set(paths).size).toBe(paths.length);
    const agent = contentsOf(files, 'agents/automation.ts');
    expect(agent).toContain(
      'tools: [\n    billingTool,\n    deliveryEstimateTool,\n    ordersTool,\n  ]',
    );
  });
});
