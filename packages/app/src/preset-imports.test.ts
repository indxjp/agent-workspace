import { readFileSync } from 'node:fs';

import { APP_TEMPLATES, renderAppTemplate } from '@indx-workspace/sdk/project';
import { describe, expect, it } from 'vitest';

import * as db from './db/index.js';
import * as root from './index.js';
import * as react from './react/index.js';
import * as server from './server/index.js';

// The app templates (issues #1510, #1511) are inert text in the SDK, rendered before the app kit
// is installed, so nothing type-checks their imports here. This holds every value they import
// from the app kit to an export the app kit has, so a renamed handler or part fails this test and
// not a customer's build. Type-only names are left to the generated app's own type check.
const MODULES: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
  '@indx-workspace/app': root,
  '@indx-workspace/app/db': db,
  '@indx-workspace/app/react': react,
  '@indx-workspace/app/server': server,
};

const packageExports = Object.keys(
  (
    JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      exports: Record<string, unknown>;
    }
  ).exports,
);

/** Each import of `text` from the app kit or one of its subpaths: the module and its value names. */
function appImports(text: string): { readonly module: string; readonly names: string[] }[] {
  const found: { module: string; names: string[] }[] = [];
  const pattern =
    /^import\s+(?:(type)\s+)?(?:\{([^}]*)\}\s+from\s+)?'(@indx-workspace\/app[^']*)';$/gmu;
  for (const match of text.matchAll(pattern)) {
    const names = match[1] === 'type' ? [] : (match[2] ?? '').split(',');
    found.push({
      module: match[3] ?? '',
      names: names
        .map((name) => name.trim())
        .filter((name) => name !== '' && !name.startsWith('type '))
        .map((name) => name.split(/\s+as\s+/u)[0] ?? name),
    });
  }
  return found;
}

describe('the app templates import only what the app kit exports', () => {
  it.each(APP_TEMPLATES)('%s', async (template) => {
    const { files } = await renderAppTemplate(template, {
      appName: 'x',
      version: '1.2.3',
    });
    const imports = files.flatMap((file) =>
      appImports(file.contents).map((entry) => ({ ...entry, file: file.path })),
    );
    const missing = imports.flatMap(({ file, module, names }) => {
      const subpath = `.${module.slice('@indx-workspace/app'.length)}`;
      if (!packageExports.includes(subpath)) return [`${file}: ${module} is not a subpath`];
      const exported = MODULES[module];
      return names
        .filter((name) => exported === undefined || !Object.hasOwn(exported, name))
        .map((name) => `${file}: ${module} has no export ${name}`);
    });

    expect(imports.length).toBeGreaterThan(0);
    expect(missing).toEqual([]);
  });

  it('reads the named imports it checks', () => {
    // Spelled in parts, so the dependency allowlist's scan does not read these fixtures as imports.
    const kit = ['@indx-workspace', 'app'].join('/');
    const quoted = (module: string): string => `'${module}'`;
    const from = (module: string): string => `from ${quoted(module)};\n`;
    expect(
      appImports(
        `import { PageTree, ResourceList } ${from(`${kit}/react`)}` +
          `import { PageView, type AgentPanelAgent } ${from(`${kit}/react`)}` +
          `import type { DefinedApp } ${from(kit)}` +
          `import ${quoted(`${kit}/react/styles.css`)};\n`,
      ),
    ).toEqual([
      { module: `${kit}/react`, names: ['PageTree', 'ResourceList'] },
      { module: `${kit}/react`, names: ['PageView'] },
      { module: kit, names: [] },
      { module: `${kit}/react/styles.css`, names: [] },
    ]);
  });
});
