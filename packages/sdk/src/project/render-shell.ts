import { type EngineId } from '@indx-workspace/contracts/engines';

import { projectDependencies } from './dependencies.js';
import { parsed, ProjectShellSchema } from './render-validation.js';
import { frozenFiles, type ProjectFile } from './template.js';

/**
 * The install-script answers of the runtime's dependency tree, copied from the Agent Workspace
 * repository root's `pnpm-workspace.yaml`. `install-scripts.test.ts` walks the lockfile from
 * `@indx-workspace/embedded` and fails when an entry of the tree is missing here or differs.
 */
const RUNTIME_ALLOW_BUILDS: readonly (readonly [string, boolean])[] = [
  ['@embedded-postgres/darwin-arm64', true],
  ['@embedded-postgres/darwin-x64', true],
  ['@embedded-postgres/linux-arm', true],
  ['@embedded-postgres/linux-arm64', true],
  ['@embedded-postgres/linux-ia32', true],
  ['@embedded-postgres/linux-ppc64', true],
  ['@embedded-postgres/linux-x64', true],
  ['@embedded-postgres/windows-x64', true],
  ['esbuild', false],
  ['@google/genai', false],
  ['protobufjs', false],
];

/**
 * The security overrides of the runtime's dependency tree, copied from the Agent Workspace
 * repository root's `pnpm-workspace.yaml` (BH061-007). A dependency can pin a vulnerable version
 * exactly, and only the installing project's own root can lift it, so the starter carries them
 * for npm (`overrides`) and pnpm.
 * `install-scripts.test.ts` fails when a root override that reaches the runtime tree is missing.
 */
const RUNTIME_OVERRIDES: readonly (readonly [string, string])[] = [
  ['undici@>=7.0.0 <7.30.1', '^7.30.1'],
  ['undici@>=8.0.0 <8.12.2', '^8.12.2'],
  ['body-parser@>=2.0.0 <2.4.0', '^2.4.0'],
  ['@azure/msal-node@>=5.0.0-beta.0 <7.1.0', '^7.1.0'],
  ['@modelcontextprotocol/server@>=2.0.0 <2.3.0', '^2.3.0'],
  ['@modelcontextprotocol/client@>=2.0.0 <2.3.0', '^2.3.0'],
  ['@modelcontextprotocol/core@>=2.0.0 <2.3.0', '^2.3.0'],
  ['@modelcontextprotocol/node@>=2.0.0 <2.1.0', '2.1.1'],
  ['@hono/node-server@>=1.19.10 <2.1.3', '^2.1.3'],
  ['minimatch@>=10.0.0 <11.0.1', '^11.0.3'],
];

/**
 * Renders the files that make a directory an installable project: `package.json` (exact pins of
 * `@indx-workspace/aw`, `@indx-workspace/embedded` and `@indx-workspace/sdk` at `version` and of
 * `engine`'s packages, nothing of the engines it does not use ({@link projectDependencies}), the
 * dev dependency `@indx-workspace/cli` at `version` for `aw deploy`, and a `dev` script running
 * `aw dev`), `pnpm-workspace.yaml` (the runtime's install-script answers,
 * which pnpm 11 requires, and its security overrides) and `.gitignore`. The result is frozen.
 *
 * @throws {ProjectRenderError} when the name is not a name key or the version is not exact.
 */
export function renderProjectShell(project: {
  readonly name: string;
  readonly version: string;
  readonly engine: EngineId;
}): readonly ProjectFile[] {
  const { name, version, engine } = parsed(ProjectShellSchema, project, 'the project');

  const packageJson = {
    name,
    private: true,
    type: 'module',
    engines: { node: '>=24' },
    scripts: { dev: 'aw dev' },
    dependencies: projectDependencies(version, engine),
    // `aw deploy` imports its deploy steps from the CLI (ADR-0103); an ESM import from the
    // project's `aw` resolves only the project's own node_modules, never a global install.
    devDependencies: { '@indx-workspace/cli': version },
    // npm 11's install-script policy (name-only keys, true allows, false denies): the same
    // answers as pnpm's `allowBuilds` below, so npm prints no "not yet covered" warning.
    allowScripts: Object.fromEntries(RUNTIME_ALLOW_BUILDS),
    overrides: Object.fromEntries(RUNTIME_OVERRIDES),
  };
  const workspace = [
    '# pnpm 11 refuses to install a package whose install script has no answer, so every package',
    "# of the Agent Workspace runtime's dependency tree that ships one is answered here. The",
    '# answers are copied from the Agent Workspace repository root.',
    'allowBuilds:',
    ...RUNTIME_ALLOW_BUILDS.map(([key, allowed]) => `  '${key}': ${String(allowed)}`),
    '# Security overrides of the runtime tree, also copied from the repository root.',
    'overrides:',
    ...RUNTIME_OVERRIDES.map(([key, version]) => `  '${key}': '${version}'`),
  ];

  return frozenFiles([
    { path: 'package.json', contents: `${JSON.stringify(packageJson, null, 2)}\n` },
    { path: 'pnpm-workspace.yaml', contents: `${workspace.join('\n')}\n` },
    { path: '.gitignore', contents: 'node_modules/\n.agent-workspace/\n.aw/\n.env\n' },
  ]);
}
