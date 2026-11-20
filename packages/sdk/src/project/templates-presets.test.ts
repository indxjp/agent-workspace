import { describe, expect, it } from 'vitest';

import { APP_PRESETS } from './app-presets.js';
import { revertGeneratedEdit } from './generated-edits.js';
import { parseGeneratedManifest } from './generated-manifest.js';
import type { ProjectFile } from './template.js';
import { mergeTemplateLayers, renderAppTemplate } from './templates.js';
import { contentsOf, digests } from './templates.test-support.js';

const presets = ['chat', 'wiki', 'crm', 'desk'] as const;
const projectFiles: readonly ProjectFile[] = [
  { path: 'package.json', contents: '{\n  "name": "team-app",\n  "private": true\n}\n' },
  { path: 'README.md', contents: '# team-app\n' },
];
const render = (template: (typeof presets)[number], appName = 'team-app') =>
  renderAppTemplate(template, { appName, version: '1.2.3', projectFiles });
type Manifest = ReturnType<typeof parseGeneratedManifest>;
const manifestOf = (files: readonly ProjectFile[]): Manifest =>
  parseGeneratedManifest(contentsOf(files, 'aw-generated.json') ?? '');

/** The text of `path` after the given resources' edits to it are reverted, in the order given. */
function revertedText(
  files: readonly ProjectFile[],
  manifest: Manifest,
  path: string,
  keys: readonly string[],
): string {
  let text = contentsOf(files, path) ?? '';
  const edits = keys.flatMap((key) => manifest.entries[key]?.edits ?? []);
  for (const edit of edits.filter((each) => each.path === path)) {
    const outcome = revertGeneratedEdit(text, edit);
    expect(outcome.kind).toBe('reverted');
    if (outcome.kind === 'reverted') text = outcome.text;
  }
  return text;
}

describe('the preset app templates (create --template chat | wiki | crm | desk, #1511): layers and README', () => {
  it('a preset that rewrites a portal path outside replaces is refused', () => {
    const portal = { name: 'the portal template', files: [{ path: 'app/nav.ts', contents: '' }] };
    const preset = { name: 'the chat preset', files: [{ path: 'app/nav.ts', contents: 'x' }] };

    expect(() =>
      mergeTemplateLayers('chat', [
        { ...portal, replaces: [] },
        { ...preset, replaces: [] },
      ]),
    ).toThrow(
      'the chat template could not be rendered: app/nav.ts: is written by the chat preset, which the portal template already wrote',
    );
    expect(
      mergeTemplateLayers('chat', [
        { ...portal, replaces: [] },
        { ...preset, replaces: ['app/nav.ts'] },
      ]),
    ).toEqual([{ path: 'app/nav.ts', contents: 'x' }]);
    // A `replaces` that names nothing earlier is stale, and refused too.
    expect(() => mergeTemplateLayers('chat', [{ ...preset, replaces: ['app/page.tsx'] }])).toThrow(
      'app/page.tsx: is replaced by the chat preset, but no earlier layer writes it',
    );
  });

  it("every preset's README quotes arguments containing parentheses, asterisks or spaces", async () => {
    for (const template of presets) {
      const readme = contentsOf((await render(template)).files, 'README.md') ?? '';
      const commands = readme.split('\n').filter((line) => /^(?:npx )?aw /u.test(line));

      expect(readme.startsWith('# team-app\n')).toBe(true);
      expect(commands.length).toBeGreaterThan(0);
      for (const command of commands) {
        expect(command.startsWith('npx aw generate ')).toBe(true);
        // Outside single quotes, sh reads ( ) * as syntax or a glob, and splits at a space.
        const unquoted = command.replace(/'[^']*'/gu, "''");
        expect(unquoted).not.toMatch(/[()*]/u);
        expect(unquoted.split(' ').every((word) => word !== '')).toBe(true);
      }
    }
    expect(contentsOf((await render('desk')).files, 'README.md')).toContain(
      'npm create @indx-workspace service-desk -- --template desk',
    );
  });
});

describe('the preset app templates (create --template chat | wiki | crm | desk, #1511): naming and recipes', () => {
  it('names the app after the directory, never the template id', async () => {
    for (const template of presets) {
      const { files } = await render(template, 'service-desk');
      const keys = Object.keys(manifestOf(files).entries);

      expect(contentsOf(files, 'app.config.ts')).toContain("  name: 'service-desk',");
      expect(contentsOf(files, 'db/migrations/0000_app_kit.sql')).toContain('"app_service_desk"');
      expect(keys).toContain('app:service-desk');
      expect(keys).toContain('project:service-desk');
      expect(keys.filter((key) => key.endsWith(`:${template}`))).toEqual([]);
    }
  });

  it('includes the recipe plumbing: the five route files and the two recipe pages', async () => {
    for (const template of presets) {
      const { files } = await render(template);
      expect(contentsOf(files, 'app/api/recipes/runs/route.ts')).toContain(
        'export const { GET } = recipeRoutes(app).list;',
      );
      expect(contentsOf(files, 'app/api/recipes/runs/[id]/route.ts')).toContain(
        'recipeRoutes(app).item;',
      );
      expect(
        contentsOf(files, 'app/api/recipes/runs/[id]/steps/[key]/decision/route.ts'),
      ).toContain('export const { POST } = recipeRoutes(app).decision;');
      expect(contentsOf(files, 'app/api/recipes/webhook/route.ts')).toContain(
        'recipeRoutes(app).webhook;',
      );
      expect(contentsOf(files, 'app/api/recipes/slots/route.ts')).toContain(
        'export const { POST } = recipeRoutes(app).slots;',
      );
      expect(contentsOf(files, 'app/recipes/page.tsx')).toContain('<RecipeRunList');
      expect(contentsOf(files, 'app/recipes/[id]/page.tsx')).toContain('<RecipeGraph');
      expect(contentsOf(files, 'app/nav.ts')).toContain(
        "{ id: 'recipes', href: '/recipes', feature: 'runs' },",
      );
      // The instrumentation that serves the recipes is the app template's, unchanged.
      expect(contentsOf(files, 'instrumentation.ts')).toContain('await serveRecipes(app);');
    }
  });
});

describe('the preset app templates (create --template chat | wiki | crm | desk, #1511): the manifest', () => {
  it('records every file it wrote in exactly one entry, the shell as project:<name>', async () => {
    for (const template of presets) {
      const { files } = await render(template);
      const manifest = manifestOf(files);
      const recorded = Object.values(manifest.entries).flatMap((entry) => Object.keys(entry.files));

      expect([...recorded].sort()).toEqual(
        files
          .map((file) => file.path)
          .filter((path) => path !== 'aw-generated.json')
          .sort(),
      );
      expect(Object.keys(manifest.entries['project:team-app']?.files ?? {}).sort()).toEqual([
        'README.md',
        'package.json',
      ]);
    }
  });

  it('wiki: records space and page as resources whose edits revert to what the app recorded', async () => {
    const { files } = await render('wiki');
    const manifest = manifestOf(files);
    const app = manifest.entries['app:team-app'];

    expect(Object.keys(manifest.entries['resource:space']?.files ?? {}).sort()).toEqual([
      'app/api/spaces/[id]/route.ts',
      'app/api/spaces/route.ts',
      'app/spaces/[id]/edit/page.tsx',
      'app/spaces/[id]/page.tsx',
      'app/spaces/new/page.tsx',
      'app/spaces/page.tsx',
      'resources/space.ts',
    ]);
    expect(Object.keys(manifest.entries['resource:page']?.files ?? {})).toEqual(
      expect.arrayContaining([
        'app/api/pages/children/route.ts',
        'app/api/pages/[id]/revisions/route.ts',
        'app/api/pages/[id]/restore/route.ts',
        'app/api/pages/[id]/move/route.ts',
        'app/wiki/page.tsx',
        'app/wiki/[id]/page.tsx',
        'db/migrations/0003_wiki.sql',
        'resources/page.ts',
      ]),
    );
    expect(contentsOf(files, 'app.config.ts')).toContain(
      "import space from './resources/space.ts';\nimport page from './resources/page.ts';",
    );
    expect(contentsOf(files, 'app.config.ts')).toContain(
      '  resources: [\n    space,\n    page,\n  ],',
    );
    // Destroying both resources, newest first, leaves the files exactly as the app entry recorded.
    for (const path of ['app.config.ts', 'db/migrations/meta/_journal.json']) {
      const text = revertedText(files, manifest, path, ['resource:page', 'resource:space']);
      expect((await digests([{ path, contents: text }]))[path]).toBe(app?.files[path]);
    }
  });
});

describe('the preset app templates (create --template chat | wiki | crm | desk, #1511): each preset', () => {
  it('desk: renders the dashboard page as page:dashboard and opens on it', async () => {
    const { files } = await render('desk');
    const dashboard = ['app/dashboard/page.tsx', 'app/api/dashboard/route.ts'];

    expect(manifestOf(files).entries['page:dashboard']).toEqual({
      files: await digests(files.filter((file) => dashboard.includes(file.path))),
      edits: [],
    });
    expect(contentsOf(files, 'app/dashboard/page.tsx')).toContain('<Dashboard platformUrl=');
    expect(contentsOf(files, 'app/page.tsx')).toContain(`redirect('${APP_PRESETS.desk.home}');`);
  });

  it('chat: the home page builds without a channel resource, and names the command that adds it', async () => {
    const page = contentsOf((await render('chat')).files, 'app/page.tsx') ?? '';

    expect(page).not.toContain('@/resources/');
    expect(page).toContain("resource.name === 'channel'");
    expect(page).toContain('npx aw generate resource channel name:text');
  });

  it('crm: adds only its theme tokens to what chat, which shares its parts, writes', async () => {
    const crm = (await render('crm')).files;
    const chat = (await render('chat')).files;
    const differs = crm
      .filter((file) => file.path !== 'aw-generated.json' && file.path !== 'README.md')
      .filter((file) => contentsOf(chat, file.path) !== file.contents)
      .map((file) => file.path);

    // The home page is chat's own; crm keeps the portal's.
    expect(differs.sort()).toEqual(['app/page.tsx', 'app/theme.ts']);
    expect(contentsOf(crm, 'app/theme.ts')).toContain("  colour: '#0f766e',\n");
  });
});

describe('the preset app templates (create --template chat | wiki | crm | desk, #1511): scope and theme', () => {
  it('never names the platform scope', async () => {
    for (const template of presets) {
      const { files } = await render(template);
      expect(
        files
          .filter((file) => file.contents.includes('@agent-workspace/'))
          .map((file) => file.path),
      ).toEqual([]);
    }
  });

  it('starts every preset from the blank setup theme', () => {
    expect(Object.values(APP_PRESETS).map((preset) => preset.theme)).toEqual([
      'blank',
      'blank',
      'blank',
      'blank',
    ]);
  });
});
