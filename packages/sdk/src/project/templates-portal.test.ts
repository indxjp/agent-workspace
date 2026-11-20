import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

import { parseGeneratedManifest } from './generated-manifest.js';
import type { ProjectFile } from './template.js';
import { appKitPackages, appScripts, renderAppTemplate, withAppPackages } from './templates.js';
import { contentsOf, digests, importSpecifiersOf } from './templates.test-support.js';

const projectFiles: readonly ProjectFile[] = [
  { path: 'package.json', contents: '{\n  "name": "portal",\n  "private": true\n}\n' },
  { path: 'README.md', contents: '# portal\n' },
  { path: 'agents/assistant.ts', contents: 'export default {};\n' },
];
const rendered = renderAppTemplate('portal', {
  appName: 'portal',
  version: '1.2.3',
  projectFiles,
});
/** The files the app layer wrote: neither the project's own nor the manifest. */
const appFiles = async (): Promise<readonly ProjectFile[]> =>
  (await rendered).files.filter(
    (file) =>
      !projectFiles.some((own) => own.path === file.path) && file.path !== 'aw-generated.json',
  );

describe('the portal app template (create --template portal): files', () => {
  it('the files and their digests', async () => {
    expect(await digests((await rendered).files)).toMatchSnapshot();
  });

  it('writes the portal pages over the app template, and keeps the project README', async () => {
    const { files } = await rendered;
    const paths = files.map((file) => file.path);

    expect(paths).toEqual(
      expect.arrayContaining([
        'app/page.tsx',
        'app/layout.tsx',
        'app/chat/page.tsx',
        'app/files/page.tsx',
        'app/runs/page.tsx',
        'app/runs/[id]/page.tsx',
        'app/api/browser-token/route.ts',
        'app/api/mcp/route.ts',
        'app/theme.ts',
        'app/nav.ts',
        '.github/workflows/app-ci.yml',
        'dependency-cruiser.config.mjs',
      ]),
    );
    expect(paths.filter((path) => path === 'README.md')).toEqual(['README.md']);
    expect(contentsOf(files, 'README.md')).toBe('# portal\n');
    expect(paths.slice(0, 3)).toEqual(projectFiles.map((file) => file.path));
    expect(paths.at(-1)).toBe('aw-generated.json');
    expect(contentsOf(files, 'app/page.tsx')).toContain(
      'export default async function DashboardPage',
    );
    expect(contentsOf(files, 'app/layout.tsx')).toContain('<html lang={theme.locale}>');
  });
});

describe('the portal app template (create --template portal): imports', () => {
  it('imports only published packages, and calls Agent Workspace as the signed-in person', async () => {
    const { files } = await rendered;
    const packages = new Set(
      importSpecifiersOf(files)
        .filter((name) => !name.startsWith('.') && !name.startsWith('@/'))
        .map((name) =>
          name.startsWith('@') ? name.split('/').slice(0, 2).join('/') : (name.split('/')[0] ?? ''),
        ),
    );

    // Not even the two guards spell the third party's scope: the release check refuses a shipped
    // template that does (scripts/release/pack-packages.mjs).
    expect(
      files.filter((file) => file.contents.includes('@agent-workspace/')).map((file) => file.path),
    ).toEqual([]);
    // Named by their npm names without the scope, so no string here reads as a module load.
    expect(
      [...packages].map((name) => name.replace(/^@indx-workspace\//u, 'published:')).sort(),
    ).toEqual([
      'next',
      'published:app',
      'published:contracts',
      'published:react',
      'published:sdk',
      'react',
    ]);
    for (const page of [
      'app/page.tsx',
      'app/chat/page.tsx',
      'app/files/page.tsx',
      'app/runs/page.tsx',
      'app/runs/[id]/page.tsx',
    ]) {
      expect(contentsOf(files, page)).toMatch(
        /return <SignInRequired next=(?:"\/[^"]*"|\{`\/[^`]*`\}) \/>;/u,
      );
    }
    // Never the app's API key: no page names that credential.
    expect(
      files
        .filter((file) => /'api-key'|AW_APP_API_KEY|apiKey/u.test(file.contents))
        .map((file) => file.path),
    ).toEqual([]);
    expect(contentsOf(files, 'app/portal.ts')).toContain('personAuthOf(request)');
    expect(contentsOf(files, 'app/api/browser-token/route.ts')).toContain(
      "return problem('unauthenticated', 401, 'Sign in to the portal first.');",
    );
  });
});

describe('the portal app template (create --template portal): sign-in and words', () => {
  it('signs the person in at /sign-in by token exchange, each route one line over its import (#1510)', async () => {
    const { files } = await rendered;
    const routes = {
      'app/api/sign-in/route.ts': 'export const GET = signInRoutes().start;',
      'app/api/sign-in/callback/route.ts': 'export const GET = signInRoutes().callback;',
      'app/api/sign-out/route.ts': 'export const POST = signInRoutes().signOut;',
    };
    for (const [path, line] of Object.entries(routes)) {
      const code = (contentsOf(files, path) ?? '')
        .split('\n')
        .filter((text) => text !== '' && !text.startsWith('//') && !text.startsWith('import '));
      expect(code).toEqual([line]);
    }
    const page = contentsOf(files, 'app/sign-in/page.tsx') ?? '';
    expect(page).toContain('<h1>{strings.signInPageTitle}</h1>');
    expect(page).toContain('role="alert"');
    expect(page).toContain('href={`/api/sign-in?next=${encodeURIComponent(next)}`}');
    expect(contentsOf(files, 'app/notices.tsx')).toContain('href={signInHref(next)}');
    expect(contentsOf(files, 'app/nav.ts')).toContain(
      "export const account = { signIn: '/sign-in', signOut: '/api/sign-out' } as const;",
    );
    const layout = contentsOf(files, 'app/layout.tsx') ?? '';
    expect(layout).toContain('<form method="post" action={account.signOut}>');
    expect(layout).toContain('<a href={account.signIn}>{strings.signIn}</a>');
  });

  it('speaks en and ja with the same words', async () => {
    const strings = contentsOf((await rendered).files, 'app/strings.ts') ?? '';
    const keysOf = (locale: string): string[] => {
      const block =
        new RegExp(`\\n  ${locale}: \\{\\n([\\s\\S]*?)\\n  \\},`, 'u').exec(strings)?.[1] ?? '';
      return [...block.matchAll(/^ {4}([A-Za-z]+):/gmu)].map((match) => match[1] ?? '');
    };

    expect(keysOf('en').length).toBeGreaterThan(20);
    expect(keysOf('ja')).toEqual(keysOf('en'));
    // The sign-in page's messages too, one per refusal it can show (#1510).
    const errorsOf = (locale: string): string[] => {
      const block =
        new RegExp(
          `\\n  ${locale}: \\{[\\s\\S]*?\\n {4}signInErrors: \\{\\n([\\s\\S]*?)\\n {4}\\},`,
          'u',
        ).exec(strings)?.[1] ?? '';
      return [...block.matchAll(/^ {6}([A-Za-z]+):/gmu)].map((match) => match[1] ?? '');
    };
    expect(errorsOf('en')).toEqual([
      'notConfigured',
      'notMember',
      'expired',
      'rateLimited',
      'unavailable',
      'refused',
    ]);
    expect(errorsOf('ja')).toEqual(errorsOf('en'));
  });
});

describe('the portal app template (create --template portal): the manifest', () => {
  it('records every file it wrote and the package edits as the app entry', async () => {
    const { files, packages, scripts } = await rendered;
    const manifest = parseGeneratedManifest(contentsOf(files, 'aw-generated.json') ?? '');
    const entry = manifest.entries['app:portal'];

    expect(Object.keys(manifest.entries)).toEqual(['app:portal', 'project:portal']);
    expect(Object.keys(entry?.files ?? {}).sort()).toEqual(
      (await appFiles()).map((file) => file.path).sort(),
    );
    expect(packages).toEqual([
      ...appKitPackages('1.2.3'),
      { section: 'dependencies', name: '@indx-workspace/contracts', version: '1.2.3' },
      { section: 'dependencies', name: '@indx-workspace/react', version: '1.2.3' },
    ]);
    expect(entry?.edits).toContainEqual({
      path: 'package.json',
      added: '{"dependencies":{"@indx-workspace/app":"1.2.3"}}',
    });
    expect(scripts).toEqual(appScripts('portal'));
    expect(entry?.edits.at(-1)).toEqual({
      path: 'package.json',
      added: '{"scripts":{"image":"docker build -t portal ."}}',
    });
  });

  it('records the project files as project:<name>, package.json at its final text (#1531)', async () => {
    const { files, packages, scripts } = await rendered;
    const manifest = parseGeneratedManifest(contentsOf(files, 'aw-generated.json') ?? '');
    const finalPackage = withAppPackages(projectFiles[0]?.contents ?? '', packages, scripts);
    const own = files.filter((file) => projectFiles.some((each) => each.path === file.path));

    expect(contentsOf(files, 'package.json')).toBe(finalPackage);
    expect(manifest.entries['project:portal']).toEqual({
      files: await digests(own),
      edits: [],
    });
    expect(Object.keys(manifest.entries['project:portal']?.files ?? {}).sort()).toEqual([
      'README.md',
      'agents/assistant.ts',
      'package.json',
    ]);
    // Without project files there is nothing of the project's to record.
    const bare = await renderAppTemplate('portal', { appName: 'portal', version: '1.2.3' });
    expect(
      Object.keys(
        parseGeneratedManifest(contentsOf(bare.files, 'aw-generated.json') ?? '').entries,
      ),
    ).toEqual(['app:portal']);
  });
});

describe('the portal app template (create --template portal): CI and refusals', () => {
  it('writes CI whose steps are one line each, refusing a platform package that is not published', async () => {
    const workflow = parseYaml(
      contentsOf((await rendered).files, '.github/workflows/app-ci.yml') ?? '',
    ) as {
      jobs: { check: { 'runs-on': string; steps: { run?: string }[] } };
    };
    const runs = workflow.jobs.check.steps.flatMap((step) =>
      step.run === undefined ? [] : [step.run],
    );

    expect(workflow.jobs.check['runs-on']).toBe('ubuntu-latest');
    expect(runs[0]).toBe('npm ci');
    expect(runs[1]).toBe('npx --no-install depcruise --config dependency-cruiser.config.mjs .');
    expect(runs[2]).toContain('/^@agent-workspace\\//u.test(name)');
    expect(runs.every((run) => !run.includes('\n'))).toBe(true);
  });

  it('refuses a template file at a path the project already has', async () => {
    await expect(
      renderAppTemplate('portal', {
        appName: 'portal',
        version: '1.2.3',
        projectFiles: [{ path: 'app/nav.ts', contents: '' }],
      }),
    ).rejects.toThrow('app/nav.ts: is already written by the project');
    await expect(
      renderAppTemplate('portal', { appName: 'Portal', version: '1.2.3' }),
    ).rejects.toThrow('name: must be lower-case kebab');
  });
});

describe('the portal app template (create --template portal): package.json edits', () => {
  it('adds the packages to package.json, sorted, and refuses another pin of one', () => {
    const pins = [
      { section: 'dependencies', name: 'next', version: '16.4.6' },
      { section: 'devDependencies', name: 'dependency-cruiser', version: '18.7.0' },
    ] as const;

    expect(
      JSON.parse(
        withAppPackages(
          '{"name":"p","dependencies":{"zod":"4.6.7","@indx-workspace/sdk":"1.2.3"}}',
          pins,
        ),
      ),
    ).toEqual({
      name: 'p',
      dependencies: { '@indx-workspace/sdk': '1.2.3', next: '16.4.6', zod: '4.6.7' },
      devDependencies: { 'dependency-cruiser': '18.7.0' },
    });
    expect(() => withAppPackages('{"dependencies":{"next":"15.0.0"}}', pins)).toThrow(
      "dependencies.next: must be 16.4.6, the app kit's pin",
    );
    expect(() => withAppPackages('[]', pins)).toThrow('(root): is not a JSON object');
  });

  it('adds the app scripts to package.json after its own, and keeps one it has', () => {
    const scripts = appScripts('desk');

    expect(
      JSON.parse(withAppPackages('{"name":"p","scripts":{"dev":"aw dev"}}', [], scripts)),
    ).toEqual({
      name: 'p',
      scripts: { dev: 'aw dev', build: 'next build', image: 'docker build -t desk .' },
    });
    expect(JSON.parse(withAppPackages('{"scripts":{"image":"make image"}}', [], scripts))).toEqual({
      scripts: { image: 'make image', build: 'next build' },
    });
  });
});
