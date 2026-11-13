import { expect, it } from 'vitest';
import { EXPECTED_PACKAGE_JSON, EXPECTED_WORKSPACE_YAML } from './render-shell.test-support.js';

import { ENGINE_PACKAGES } from './dependencies.js';
import { renderProjectShell } from './render.js';
import { contentsOf, renderError } from './render.test-support.js';

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
  expect(contentsOf(files, 'package.json')).toBe(EXPECTED_PACKAGE_JSON);
  expect(contentsOf(files, 'pnpm-workspace.yaml')).toBe(EXPECTED_WORKSPACE_YAML);
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
