import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

import { ProjectRenderError } from './errors.js';
import {
  channelRouteEdits,
  parseFieldSpecs,
  refFieldsOf,
  renderAgentSpec,
  renderAppSpec,
  renderChannelSpec,
  renderGeneratorTemplate,
  renderPageSpec,
  renderRecipeSpec,
  renderResourceSpec,
  type GeneratorPageKind,
} from './generate.js';
import { APP_PRESETS } from './app-presets.js';
import { revertGeneratedEdit } from './generated-edits.js';
import { parseGeneratedManifest } from './generated-manifest.js';
import type { ProjectFile } from './template.js';
import {
  appKitPackages,
  appScripts,
  mergeTemplateLayers,
  renderAppTemplate,
  scriptEdit,
  withAppPackages,
} from './templates.js';

/** Each rendered file's path and the sha256 of its text, like the create output snapshot. */
async function digests(files: readonly ProjectFile[]): Promise<Record<string, string>> {
  const entries = await Promise.all(
    files.map(async (file) => {
      const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(file.contents));
      const hex = [...new Uint8Array(bytes)]
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('');
      return [file.path, hex] as const;
    }),
  );
  return Object.fromEntries(entries);
}

const contentsOf = (files: readonly ProjectFile[], path: string): string | undefined =>
  files.find((file) => file.path === path)?.contents;

const app = renderGeneratorTemplate('app', renderAppSpec('service-desk', ['ticket']));
const ticketValues = renderResourceSpec(
  'ticket',
  parseFieldSpecs([
    'title:text(200)',
    'description:richText',
    'estimate:number(0,100)?',
    'budget:money(JPY)',
    'urgent:bool',
    'due:date?',
    'opened_at:dateTime',
    'status:enum(new,in_progress,closed)',
    'assignee:person?',
    'parent:ref(ticket)?',
    'attachments:files',
    'labels:tags',
  ]),
  { board: 'status' },
);
const resource = renderGeneratorTemplate('resource', ticketValues);
const resourcePages = renderGeneratorTemplate('resource-pages', ticketValues);
const workItemPages = renderGeneratorTemplate(
  'resource-pages',
  renderResourceSpec('work_item', parseFieldSpecs(['title:text'])),
);
const pageOf = (name: string, kind: GeneratorPageKind, resource?: string) => {
  const spec = renderPageSpec(name, { kind, resource });
  return renderGeneratorTemplate(`page/${spec.kind}`, spec.values);
};
const pages = {
  dashboard: pageOf('dashboard', 'dashboard'),
  list: pageOf('open-tickets', 'list', 'ticket'),
  custom: pageOf('team_rota', 'custom'),
};
const agent = renderGeneratorTemplate(
  'agent',
  renderAgentSpec('triage', { appName: 'service-desk', resources: ['ticket'] }),
);

const recipes = {
  resource: renderGeneratorTemplate(
    'recipe',
    renderRecipeSpec('enrich-contact', { on: 'resource:contact.created', resources: ['contact'] })
      .values,
  ),
  schedule: renderGeneratorTemplate(
    'recipe',
    renderRecipeSpec('sla-sweep', { on: 'schedule:*/5 * * * *', resources: [] }).values,
  ),
};

const messageValues = renderResourceSpec(
  'message',
  parseFieldSpecs([
    'thread_root:ref(message)?',
    'room:ref(room)',
    'body:richText',
    'attachments:files?',
  ]),
);
const messageResource = renderGeneratorTemplate('resource', messageValues);
const channel = renderGeneratorTemplate(
  'channel',
  renderChannelSpec('message', {
    refs: refFieldsOf(contentsOf(messageResource, 'resources/message.ts') ?? ''),
  }),
);

/** The `--key` refusal of `renderChannelSpec`, or `undefined` when it renders. */
function channelRefusal(...args: Parameters<typeof renderChannelSpec>): string | undefined {
  try {
    renderChannelSpec(...args);
    return undefined;
  } catch (error) {
    if (!(error instanceof ProjectRenderError)) throw error;
    return error.issues.map((issue) => `${issue.path}: ${issue.message}`).join('\n');
  }
}

describe('the generator templates', () => {
  it('app: the files and their digests', async () => {
    expect(await digests(app)).toMatchSnapshot();
  });

  it('resource: the files and their digests', async () => {
    expect(await digests(resource)).toMatchSnapshot();
  });

  it('resource-pages: the files and their digests', async () => {
    expect(await digests(resourcePages)).toMatchSnapshot();
  });

  it('page/*: the files and their digests', async () => {
    expect({
      dashboard: await digests(pages.dashboard),
      list: await digests(pages.list),
      custom: await digests(pages.custom),
    }).toMatchSnapshot();
  });

  it('agent: the files and their digests', async () => {
    expect(await digests(agent)).toMatchSnapshot();
  });

  it('writes the two route files as the app kit documents them', () => {
    expect(contentsOf(resource, 'app/api/tickets/route.ts')).toBe(
      [
        "import ticket from '@/resources/ticket';",
        "import { resourceRoutes } from '@indx-workspace/app/server';",
        'export const { GET, POST } = resourceRoutes(ticket);',
        '',
      ].join('\n'),
    );
    expect(contentsOf(resource, 'app/api/tickets/[id]/route.ts')).toBe(
      [
        "import ticket from '@/resources/ticket';",
        "import { resourceItemRoutes } from '@indx-workspace/app/server';",
        'export const { GET, PATCH, DELETE } = resourceItemRoutes(ticket);',
        '',
      ].join('\n'),
    );
    expect(contentsOf(app, 'app/api/mcp/route.ts')).toContain(
      'export const { POST, GET, DELETE } = mcpEndpoint(app);',
    );
  });

  it('builds the app as an image that migrates on start and answers /api/health', () => {
    const dockerfile = contentsOf(app, 'Dockerfile') ?? '';
    const from = dockerfile.split('\n').filter((line) => line.startsWith('FROM '));

    expect(from).toHaveLength(2);
    for (const line of from) {
      expect(line).toMatch(/^FROM node:24[.0-9]*-bookworm-slim@sha256:[0-9a-f]{64}( AS build)?$/u);
    }
    expect(dockerfile).toContain('RUN npm ci\n');
    expect(dockerfile).toContain('RUN npm run build');
    for (const copied of ['.next/standalone', '.next/static', 'public', 'db/migrations']) {
      expect(dockerfile).toContain(`COPY --from=build --chown=node:node /app/${copied} `);
    }
    expect(dockerfile).toContain('USER node\nEXPOSE 3000\nCMD ["node", "server.js"]\n');
    expect(contentsOf(app, '.dockerignore')?.split('\n')).toEqual(
      expect.arrayContaining(['node_modules', '.next', '.aw', '.env*']),
    );
    expect(contentsOf(app, 'next.config.ts')).toContain("output: 'standalone'");

    const instrumentation = contentsOf(app, 'instrumentation.ts') ?? '';
    expect(instrumentation).toContain(
      "if (process.env.NEXT_RUNTIME === 'nodejs' && process.env.AW_APP_MIGRATE_ON_START === '1') {",
    );
    expect(instrumentation).toContain("await import('@indx-workspace/app/db')");
    expect(instrumentation).toContain("migrationsFolder: 'db/migrations'");
    // A failed migration is not caught: it fails register(), so the container exits.
    expect(instrumentation).not.toContain('catch');

    const health = contentsOf(app, 'app/api/health/route.ts') ?? '';
    expect(health).toContain("new Response('ok', { headers: { 'cache-control': 'no-store' } })");
    expect(health).not.toContain('appRuntime');
    expect(health).not.toMatch(/^import /mu);
  });

  it('adds the build script the Dockerfile runs, and names the image script after the app', () => {
    expect(appScripts('service-desk')).toEqual([
      { name: 'build', command: 'next build' },
      { name: 'image', command: 'docker build -t service-desk .' },
    ]);
    expect(contentsOf(app, 'Dockerfile')).toContain('RUN npm run build');
    expect(scriptEdit({ name: 'image', command: 'docker build -t desk .' })).toEqual({
      path: 'package.json',
      added: '{"scripts":{"image":"docker build -t desk ."}}',
    });
  });

  it('writes the resource file from the parsed fields', () => {
    expect(contentsOf(resource, 'resources/ticket.ts')).toMatchSnapshot();
    expect(contentsOf(resource, 'tests/ticket.test.ts')).toMatchSnapshot();
  });

  it("writes the app's schema into its first migration and the resource into app.config.ts", () => {
    expect(contentsOf(app, 'db/migrations/0000_app_kit.sql')).toContain(
      'CREATE TABLE IF NOT EXISTS "app_service_desk"."app_audit_events"',
    );
    expect(contentsOf(app, 'app.config.ts')).toBe(
      [
        "import { defineApp } from '@indx-workspace/app';",
        "import ticket from './resources/ticket.ts';",
        '',
        'export default defineApp({',
        "  name: 'service-desk',",
        '  resources: [',
        '    ticket,',
        '  ],',
        '  recipes: [',
        '  ],',
        '});',
        '',
      ].join('\n'),
    );
  });

  it("writes the resource's pages a few lines each, from the app kit's parts alone", () => {
    const every = [...resourcePages, ...workItemPages, ...Object.values(pages).flat()];
    const imports = every.flatMap((file) =>
      [...file.contents.matchAll(/^import .* from '([^']+)';$/gmu)].map((match) => match[1]),
    );

    expect(resourcePages.map((file) => file.path)).toEqual([
      'app/tickets/[id]/edit/page.tsx',
      'app/tickets/[id]/page.tsx',
      'app/tickets/new/page.tsx',
      'app/tickets/page.tsx',
    ]);
    for (const file of [...resourcePages, ...workItemPages]) {
      expect(file.contents.trimEnd().split('\n').length).toBeLessThanOrEqual(10);
    }
    expect(new Set(imports)).toEqual(
      new Set([
        '@/resources/ticket',
        '@/resources/work_item',
        '@indx-workspace/app/react',
        '@indx-workspace/app/server',
        'react',
      ]),
    );
  });

  it('lists a resource with a board as a board, and one without as a table', () => {
    expect(contentsOf(resourcePages, 'app/tickets/page.tsx')).toBe(
      [
        "'use client';",
        "import ticket from '@/resources/ticket';",
        "import { ResourceBoard } from '@indx-workspace/app/react';",
        '',
        'export default function TicketsPage() {',
        '  return <ResourceBoard resource={ticket} />;',
        '}',
        '',
      ].join('\n'),
    );
    expect(contentsOf(workItemPages, 'app/work_items/page.tsx')).toContain(
      'export default function WorkItemsPage() {\n  return <ResourceList resource={work_item} />;',
    );
    expect(contentsOf(workItemPages, 'app/work_items/new/page.tsx')).toContain(
      'window.location.assign(`/work_items/${id}`);',
    );
    expect(contentsOf(resourcePages, 'app/tickets/[id]/page.tsx')).toContain(
      '<ResourceDetailLoader resource={ticket} id={id} editHref={`/tickets/${id}/edit`} />',
    );
    expect(contentsOf(resourcePages, 'app/tickets/[id]/edit/page.tsx')).toContain(
      '<ResourceFormLoader resource={ticket} id={id} cancelHref={`/tickets/${id}`} onSaved={saved} />',
    );
  });

  it('writes app/<name>/page.tsx for each page kind', () => {
    expect(pages.dashboard.map((file) => file.path)).toEqual([
      'app/dashboard/page.tsx',
      'app/api/dashboard/route.ts',
    ]);
    expect(contentsOf(pages.list, 'app/open-tickets/page.tsx')).toContain(
      'export default function OpenTicketsPage() {\n  return <ResourceList resource={ticket} />;',
    );
    expect(contentsOf(pages.custom, 'app/team_rota/page.tsx')).toContain('<h1>Team rota</h1>');
    expect(contentsOf(pages.dashboard, 'app/dashboard/page.tsx')).toContain(
      '<Dashboard platformUrl={appRuntime().awUrl} />',
    );
    expect(contentsOf(pages.dashboard, 'app/api/dashboard/route.ts')).toBe(
      [
        "import { dashboardRoutes } from '@indx-workspace/app/server';",
        '',
        'export const { GET } = dashboardRoutes();',
        '',
      ].join('\n'),
    );
  });

  it('refuses an unknown kind, a list without its resource and a reserved or bad name', () => {
    expect(() => renderPageSpec('board', { kind: 'kanban' })).toThrow(
      '--kind: must be one of dashboard, list, custom',
    );
    expect(() => renderPageSpec('open', { kind: 'list' })).toThrow(
      '--resource: a list page needs the resource it lists, --resource <name>',
    );
    expect(() => renderPageSpec('home', { kind: 'custom', resource: 'ticket' })).toThrow(
      '--resource: only a list page shows a resource',
    );
    expect(() => renderPageSpec('api', { kind: 'custom' })).toThrow(
      'name: is reserved: app/api/ holds the generated routes',
    );
    expect(() => renderPageSpec('Open Tickets', { kind: 'custom' })).toThrow(
      'name: must be lower-case words joined by - or _',
    );
  });

  it('wires the agent to the app connector', () => {
    expect(contentsOf(agent, 'agents/triage.ts')).toMatchSnapshot();
  });

  it('recipe: writes exactly the recipe and its test, for each trigger (#1514)', () => {
    expect(recipes.resource.map((file) => file.path)).toEqual([
      'recipes/enrich-contact.ts',
      'tests/recipes/enrich-contact.test.ts',
    ]);
    expect(contentsOf(recipes.resource, 'recipes/enrich-contact.ts')).toMatchSnapshot();
    expect(contentsOf(recipes.resource, 'tests/recipes/enrich-contact.test.ts')).toMatchSnapshot();
    expect(contentsOf(recipes.schedule, 'recipes/sla-sweep.ts')).toMatchSnapshot();
    expect(contentsOf(recipes.schedule, 'tests/recipes/sla-sweep.test.ts')).toMatchSnapshot();
    expect(contentsOf(recipes.schedule, 'recipes/sla-sweep.ts')).toContain(
      "on: schedule('*/5 * * * *', 'UTC'),",
    );
  });

  it('channel: writes the channel, its events route and its page, keyed on the first ref() to another resource (#1519)', () => {
    expect(channel.map((file) => file.path)).toEqual([
      'app/api/channels/message/events/route.ts',
      'app/channels/message/[key]/page.tsx',
      'channels/message.ts',
    ]);
    expect(contentsOf(channel, 'channels/message.ts')).toMatchSnapshot();
    expect(contentsOf(channel, 'app/api/channels/message/events/route.ts')).toMatchSnapshot();
    expect(contentsOf(channel, 'app/channels/message/[key]/page.tsx')).toMatchSnapshot();
    expect(contentsOf(channel, 'channels/message.ts')).toContain(
      "export default channel('message', { resource: roomResource, key: 'room' });",
    );
  });

  it("channel: edits each of the resource's route files by one line, from the line it generated", () => {
    const edits = channelRouteEdits('message');
    expect(edits).toMatchSnapshot();
    for (const edit of edits) {
      const generated = contentsOf(messageResource, edit.path) ?? '';
      expect(generated.split('\n')).toContain(edit.replaced);
    }
  });

  it('channel: refuses a resource with no ref() to key on, as channel_key_required', () => {
    const refs = refFieldsOf(contentsOf(messageResource, 'resources/message.ts') ?? '');
    expect(refs).toEqual([
      { field: 'thread_root', resource: 'message' },
      { field: 'room', resource: 'room' },
    ]);
    expect(channelRefusal('note', { refs: [] })).toMatch(/^--key: channel_key_required: /u);
    expect(channelRefusal('message', { refs, key: 'body' })).toMatch(
      /^--key: channel_key_required: body is not a ref\(\) field/u,
    );
    expect(channelRefusal('message', { refs, key: 'thread_root' })).toMatch(
      /^--key: channel_key_required: thread_root refers to the resource itself/u,
    );
    expect(channelRefusal('message', { refs, key: 'room' })).toBeUndefined();
    expect(channelRefusal('Message', { refs })).toMatch(/^name: /u);
  });

  it('renders the same bytes every time', async () => {
    const again = renderGeneratorTemplate('app', renderAppSpec('service-desk', ['ticket']));

    expect(await digests(again)).toEqual(await digests(app));
  });
});

describe('the portal app template (create --template portal)', () => {
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

  it('imports only published packages, and calls Agent Workspace as the signed-in person', async () => {
    const { files } = await rendered;
    const imports = files.flatMap((file) =>
      [...file.contents.matchAll(/^import .* from '([^']+)';$/gmu)].map((match) => match[1] ?? ''),
    );
    const packages = new Set(
      imports
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

  it('adds the packages to package.json, sorted, and refuses another pin of one', () => {
    const pins = [
      { section: 'dependencies', name: 'next', version: '16.4.3' },
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
      dependencies: { '@indx-workspace/sdk': '1.2.3', next: '16.4.3', zod: '4.6.7' },
      devDependencies: { 'dependency-cruiser': '18.7.0' },
    });
    expect(() => withAppPackages('{"dependencies":{"next":"15.0.0"}}', pins)).toThrow(
      "dependencies.next: must be 16.4.3, the app kit's pin",
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

describe('the preset app templates (create --template chat | wiki | crm | desk, #1511)', () => {
  const presets = ['chat', 'wiki', 'crm', 'desk'] as const;
  const projectFiles: readonly ProjectFile[] = [
    { path: 'package.json', contents: '{\n  "name": "team-app",\n  "private": true\n}\n' },
    { path: 'README.md', contents: '# team-app\n' },
  ];
  const render = (template: (typeof presets)[number], appName = 'team-app') =>
    renderAppTemplate(template, { appName, version: '1.2.3', projectFiles });
  const manifestOf = (files: readonly ProjectFile[]) =>
    parseGeneratedManifest(contentsOf(files, 'aw-generated.json') ?? '');

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
      let text = contentsOf(files, path) ?? '';
      for (const key of ['resource:page', 'resource:space']) {
        for (const edit of manifest.entries[key]?.edits ?? []) {
          if (edit.path !== path) continue;
          const outcome = revertGeneratedEdit(text, edit);
          expect(outcome.kind).toBe('reverted');
          if (outcome.kind === 'reverted') text = outcome.text;
        }
      }
      expect((await digests([{ path, contents: text }]))[path]).toBe(app?.files[path]);
    }
  });

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
