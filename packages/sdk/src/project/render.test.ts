import { expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

import { EvalCaseFileSchema } from '@indx-workspace/contracts/evaluations';
import { SETUP_THEMES, withRecommendedAnswers } from '@indx-workspace/contracts/setup';

import { renderProjectFiles, setupSecretNames } from './render.js';
import { contentsOf, ORDERS_ANSWERS, rendered } from './render.test-support.js';

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
# To deploy to your Google Cloud project: add this under environments, then \`aw deploy production\`.
#   production: { target: gcp-cloudrun, url: https://<host>, gcp: { project: <id>, region: asia-northeast1 } }
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
