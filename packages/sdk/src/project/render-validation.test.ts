import { expect, it } from 'vitest';

import { ENGINE_IDS } from '@indx-workspace/contracts/engines';
import { type CompleteSetupAnswers } from '@indx-workspace/contracts/setup';

import { parseProjectFile } from './parse.js';
import { renderProjectFiles } from './render.js';
import { contentsOf, literalOf, recommended, renderError } from './render.test-support.js';

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
