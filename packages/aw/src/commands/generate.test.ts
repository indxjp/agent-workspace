import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { EXIT_CODE } from '../output.js';
import { runCli, tempDirectory } from '../testing.js';
import { AW_VERSION } from '../version.js';

const temporary: string[] = [];

afterEach(async () => {
  for (const directory of temporary.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

const PACKAGE_JSON = '{\n  "name": "desk",\n  "private": true\n}\n';

/**
 * The app kit's `aw-app` bin, stubbed: it prints a fixed SQL text naming the resource it was
 * given, so the suite never needs a built app kit.
 */
const STUB_BIN = [
  '#!/usr/bin/env node',
  'const [, , command, flag, app, spec] = process.argv;',
  "if (command !== 'sql' || flag !== '--app') { process.stderr.write('error: bad line\\n'); process.exit(2); }",
  'const { name } = JSON.parse(spec);',
  "process.stdout.write('-- fixed SQL for ' + app + '\\nCREATE TABLE \"' + name + 's\" ();\\n');",
  '',
].join('\n');

/** A project with a `package.json` and the stubbed app kit installed at `aw`'s version. */
async function project(): Promise<string> {
  const root = await tempDirectory();
  temporary.push(root);
  await writeFile(path.join(root, 'package.json'), PACKAGE_JSON);
  const kit = path.join(root, 'node_modules', '@indx-workspace', 'app');
  await mkdir(kit, { recursive: true });
  await writeFile(
    path.join(kit, 'package.json'),
    JSON.stringify({
      name: '@indx-workspace/app',
      version: AW_VERSION,
      bin: { 'aw-app': './bin.js' },
    }),
  );
  await writeFile(path.join(kit, 'bin.js'), STUB_BIN);
  return root;
}

/** Every file (with its text) and directory under `root`, `node_modules` aside. */
async function tree(root: string, prefix = ''): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const entry of await readdir(path.join(root, prefix), { withFileTypes: true })) {
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (relative === 'node_modules') continue;
    if (entry.isDirectory()) {
      result[`${relative}/`] = '';
      Object.assign(result, await tree(root, relative));
    } else {
      result[relative] = await readFile(path.join(root, relative), 'utf8');
    }
  }
  return result;
}

/** The paths that appeared or changed from `before` to `after`. */
function changed(before: Record<string, string>, after: Record<string, string>): string[] {
  return Object.keys(after)
    .filter((key) => !key.endsWith('/') && before[key] !== after[key])
    .sort();
}

function aw(cwd: string, argv: readonly string[]) {
  return runCli(argv, { cwd, env: {} });
}

const RESOURCE = ['generate', 'resource', 'ticket', 'title:text(200)', 'status:enum(new,closed)'];

async function generatedApp(): Promise<string> {
  const root = await project();
  expect((await aw(root, ['generate', 'app', 'service-desk'])).code).toBe(EXIT_CODE.ok);
  return root;
}

describe('aw generate', () => {
  it('generate app, resource and agent write exactly the listed paths', async () => {
    const root = await project();
    const empty = await tree(root);

    const app = await aw(root, ['generate', 'app', 'service-desk']);
    const afterApp = await tree(root);
    const resource = await aw(root, [...RESOURCE, '--board', 'status']);
    const afterResource = await tree(root);
    const agent = await aw(root, ['generate', 'agent', 'triage', '--tools', 'ticket']);
    const afterAgent = await tree(root);

    expect([app.code, resource.code, agent.code]).toEqual([0, 0, 0]);
    expect(changed(empty, afterApp)).toEqual([
      '.dockerignore',
      '.github/workflows/app-ci.yml',
      'Dockerfile',
      'README.md',
      'app.config.ts',
      'app/api/health/route.ts',
      'app/api/mcp/route.ts',
      'app/layout.tsx',
      'app/page.tsx',
      'aw-generated.json',
      'db/migrations/0000_app_kit.sql',
      'db/migrations/0001_app_kit_recipes.sql',
      'db/migrations/0002_app_kit_channels.sql',
      'db/migrations/meta/_journal.json',
      'dependency-cruiser.config.mjs',
      'instrumentation.ts',
      'next.config.ts',
      'package.json',
      'tsconfig.json',
    ]);
    expect(changed(afterApp, afterResource)).toEqual([
      'app.config.ts',
      'app/api/tickets/[id]/route.ts',
      'app/api/tickets/route.ts',
      'app/tickets/[id]/edit/page.tsx',
      'app/tickets/[id]/page.tsx',
      'app/tickets/new/page.tsx',
      'app/tickets/page.tsx',
      'aw-generated.json',
      'db/migrations/0003_create_tickets.sql',
      'db/migrations/meta/_journal.json',
      'resources/ticket.ts',
      'tests/ticket.test.ts',
    ]);
    expect(changed(afterResource, afterAgent)).toEqual(['agents/triage.ts', 'aw-generated.json']);
    expect(app.stderr).toContain('next: npm install');
  });

  it('pins the app kit and its peers in package.json', async () => {
    const root = await generatedApp();
    const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };

    expect(manifest.dependencies).toMatchObject({
      '@indx-workspace/app': AW_VERSION,
      next: '16.4.3',
      react: '19.3.1',
    });
    expect(Object.keys(manifest.devDependencies)).toEqual(['dependency-cruiser']);
  });

  it('adds the build and image scripts to package.json and records them', async () => {
    const root = await generatedApp();
    const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    const generated = JSON.parse(await readFile(path.join(root, 'aw-generated.json'), 'utf8')) as {
      entries: Record<string, { edits: { path: string; added: string }[] }>;
    };

    expect(manifest.scripts).toEqual({
      build: 'next build',
      image: 'docker build -t service-desk .',
    });
    expect(generated.entries['app:service-desk']?.edits).toContainEqual({
      path: 'package.json',
      added: '{"scripts":{"build":"next build"}}',
    });
    expect(generated.entries['app:service-desk']?.edits).toContainEqual({
      path: 'package.json',
      added: '{"scripts":{"image":"docker build -t service-desk ."}}',
    });
  });

  it('keeps an image script the project already has, and destroy leaves it', async () => {
    const root = await project();
    const own = '{\n  "name": "desk",\n  "scripts": {\n    "image": "make image"\n  }\n}\n';
    await writeFile(path.join(root, 'package.json'), own);

    const run = await aw(root, ['generate', 'app', 'service-desk']);
    const written = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    const generated = await readFile(path.join(root, 'aw-generated.json'), 'utf8');
    const destroy = await aw(root, ['destroy', 'app', 'service-desk', '--yes']);

    expect(run.code).toBe(EXIT_CODE.ok);
    expect(run.stdout).toContain('kept the existing package.json script image');
    expect(written.scripts).toEqual({ image: 'make image', build: 'next build' });
    expect(generated).not.toContain('docker build');
    expect(destroy.code).toBe(EXIT_CODE.ok);
    expect(await readFile(path.join(root, 'package.json'), 'utf8')).toBe(own);
  });

  it("writes the SQL aw-app printed as the migration, and the journal entry after the app kit's", async () => {
    const root = await generatedApp();
    await aw(root, RESOURCE);

    expect(await readFile(path.join(root, 'db/migrations/0003_create_tickets.sql'), 'utf8')).toBe(
      '-- fixed SQL for service-desk\nCREATE TABLE "tickets" ();\n',
    );
    const journal = JSON.parse(
      await readFile(path.join(root, 'db/migrations/meta/_journal.json'), 'utf8'),
    ) as { entries: { idx: number; tag: string; when: number }[] };
    expect(journal.entries.map((entry) => [entry.idx, entry.tag])).toEqual([
      [0, '0000_app_kit'],
      [1, '0001_app_kit_recipes'],
      [2, '0002_app_kit_channels'],
      [3, '0003_create_tickets'],
    ]);
    expect(journal.entries[3]?.when).toBe((journal.entries[2]?.when ?? 0) + 1);
    expect(await readFile(path.join(root, 'app.config.ts'), 'utf8')).toContain(
      "import ticket from './resources/ticket.ts';\n\nexport default defineApp({\n  name: 'service-desk',\n  resources: [\n    ticket,\n  ],",
    );
  });

  it('writes the same files on every run', async () => {
    const first = await generatedApp();
    const second = await generatedApp();
    await aw(first, RESOURCE);
    await aw(second, RESOURCE);

    expect(await tree(second)).toEqual(await tree(first));
  });

  it('refuses a second generate resource ticket and writes nothing', async () => {
    const root = await generatedApp();
    await aw(root, RESOURCE);
    const before = await tree(root);

    const again = await aw(root, RESOURCE);

    expect(again.code).toBe(EXIT_CODE.problem);
    expect(again.stderr).toContain('resource ticket is already generated');
    expect(await tree(root)).toEqual(before);
  });

  it('refuses generate resource without a generated app', async () => {
    const root = await project();

    const run = await aw(root, RESOURCE);

    expect(run.code).toBe(EXIT_CODE.problem);
    expect(run.stderr).toContain('fix: run aw generate app <name> first');
  });

  it('refuses a ref() to an unknown resource, and --tools naming one', async () => {
    const root = await generatedApp();
    const before = await tree(root);

    const ref = await aw(root, ['generate', 'resource', 'comment', 'ticket:ref(ticket)']);
    const agent = await aw(root, ['generate', 'agent', 'triage', '--tools', 'ticket']);

    expect(ref.code).toBe(EXIT_CODE.problem);
    expect(ref.stderr).toContain('a ref() field names no resource of this app: ticket');
    expect(agent.code).toBe(EXIT_CODE.problem);
    expect(agent.stderr).toContain('--tools names no resource of this app: ticket');
    expect(await tree(root)).toEqual(before);
  });

  it('refuses a bad field argument with every reason, as a usage error', async () => {
    const root = await generatedApp();

    const run = await aw(root, ['generate', 'resource', 'deal', 'amount:money(yen)', 'x:blob']);

    expect(run.code).toBe(EXIT_CODE.usage);
    expect(run.stderr).toContain('amount:money(yen)');
    expect(run.stderr).toContain('x:blob');
  });

  it('refuses a package.json that pins a package at another version', async () => {
    const root = await project();
    await writeFile(
      path.join(root, 'package.json'),
      '{\n  "name": "desk",\n  "dependencies": {\n    "next": "15.0.0"\n  }\n}\n',
    );
    const before = await tree(root);

    const run = await aw(root, ['generate', 'app', 'service-desk']);

    expect(run.code).toBe(EXIT_CODE.problem);
    expect(run.stderr).toContain('pins next at another version');
    expect(await tree(root)).toEqual(before);
  });

  it('keeps an existing README.md and records nothing for it', async () => {
    const root = await project();
    await writeFile(path.join(root, 'README.md'), '# Desk\n');

    const run = await aw(root, ['generate', 'app', 'service-desk']);

    expect(run.stdout).toContain('kept the existing README.md');
    expect(await readFile(path.join(root, 'README.md'), 'utf8')).toBe('# Desk\n');
    expect(await readFile(path.join(root, 'aw-generated.json'), 'utf8')).not.toContain('README');
  });

  it('--board selects ResourceBoard for the list page, and no --board ResourceList', async () => {
    const board = await generatedApp();
    const table = await generatedApp();
    await aw(board, [...RESOURCE, '--board', 'status']);
    await aw(table, RESOURCE);

    expect(await readFile(path.join(board, 'app/tickets/page.tsx'), 'utf8')).toContain(
      '<ResourceBoard resource={ticket} />',
    );
    expect(await readFile(path.join(table, 'app/tickets/page.tsx'), 'utf8')).toContain(
      '<ResourceList resource={ticket} />',
    );
  });

  it('generate page writes app/<name>/page.tsx and records it', async () => {
    const root = await generatedApp();
    await aw(root, RESOURCE);
    const before = await tree(root);

    const run = await aw(root, [
      'generate',
      'page',
      'open-tickets',
      '--kind',
      'list',
      '--resource',
      'ticket',
    ]);

    expect(run.code).toBe(EXIT_CODE.ok);
    expect(changed(before, await tree(root))).toEqual([
      'app/open-tickets/page.tsx',
      'aw-generated.json',
    ]);
    expect(await readFile(path.join(root, 'aw-generated.json'), 'utf8')).toContain(
      '"page:open-tickets"',
    );
  });

  it('refuses an unknown --kind, a list page without its resource, and a resource plural', async () => {
    const root = await generatedApp();
    await aw(root, RESOURCE);
    const before = await tree(root);

    const kind = await aw(root, ['generate', 'page', 'board', '--kind', 'kanban']);
    const noKind = await aw(root, ['generate', 'page', 'board']);
    const bare = await aw(root, ['generate', 'page', 'open', '--kind', 'list']);
    const ghost = await aw(root, [
      ...['generate', 'page', 'open', '--kind', 'list'],
      ...['--resource', 'ghost'],
    ]);
    const plural = await aw(root, ['generate', 'page', 'tickets', '--kind', 'custom']);

    expect([kind.code, noKind.code, bare.code]).toEqual([
      EXIT_CODE.usage,
      EXIT_CODE.usage,
      EXIT_CODE.usage,
    ]);
    expect(kind.stderr).toContain('--kind: must be one of dashboard, list, custom');
    expect(bare.stderr).toContain('a list page needs the resource it lists');
    expect(ghost.code).toBe(EXIT_CODE.problem);
    expect(ghost.stderr).toContain('--resource names no resource of this app: ghost');
    expect(plural.code).toBe(EXIT_CODE.problem);
    expect(plural.stderr).toContain('app/tickets/ holds the pages of the resource ticket');
    expect(await tree(root)).toEqual(before);
  });

  it('refuses generate page without a generated app, and a second page of one name', async () => {
    const bare = await project();
    const root = await generatedApp();
    const page = ['generate', 'page', 'dashboard', '--kind', 'dashboard'];

    const noApp = await aw(bare, page);
    const first = await aw(root, page);
    const again = await aw(root, page);

    expect(noApp.code).toBe(EXIT_CODE.problem);
    expect(noApp.stderr).toContain('fix: run aw generate app <name> first');
    expect(first.code).toBe(EXIT_CODE.ok);
    expect(again.code).toBe(EXIT_CODE.problem);
    expect(again.stderr).toContain('page dashboard is already generated');
  });

  it('refuses when the app kit is not installed', async () => {
    const root = await generatedApp();
    await rm(path.join(root, 'node_modules'), { recursive: true });

    const run = await aw(root, RESOURCE);

    expect(run.code).toBe(EXIT_CODE.problem);
    expect(run.stderr).toContain('app_kit_not_installed');
    expect(run.stderr).toContain('fix: npm install');
  });
});

/** A generated app with a room and a message keyed on it, ready for `generate channel`. */
async function chatApp(): Promise<string> {
  const root = await generatedApp();
  expect((await aw(root, ['generate', 'resource', 'room', 'title:text(80)'])).code).toBe(0);
  const message = await aw(root, [
    'generate',
    'resource',
    'message',
    'thread_root:ref(message)?',
    'room:ref(room)',
    'body:text',
  ]);
  expect(message.code).toBe(0);
  return root;
}

describe('aw generate channel (#1519)', () => {
  it('writes the channel, its events route and page, and edits each route file by one line', async () => {
    const root = await chatApp();
    const before = await tree(root);

    const run = await aw(root, ['generate', 'channel', 'message']);
    const after = await tree(root);

    expect(run.code).toBe(EXIT_CODE.ok);
    expect(changed(before, after)).toEqual([
      'app/api/channels/message/events/route.ts',
      'app/api/messages/[id]/route.ts',
      'app/api/messages/route.ts',
      'app/channels/message/[key]/page.tsx',
      'aw-generated.json',
      'channels/message.ts',
    ]);
    expect(after['channels/message.ts']).toContain(
      "export default channel('message', { resource: roomResource, key: 'room' });",
    );
    // Pinned here rather than in a snapshot file: packages/aw/src/commands holds commands only.
    expect(after['app/api/messages/route.ts']).toBe(
      [
        "import message from '@/resources/message';",
        "import { resourceRoutes } from '@indx-workspace/app/server';",
        "import messageChannel from '@/channels/message';",
        'export const { GET, POST } = resourceRoutes(message, { publish: messageChannel });',
        '',
      ].join('\n'),
    );
    expect(after['app/api/messages/[id]/route.ts']).toBe(
      [
        "import message from '@/resources/message';",
        "import { resourceItemRoutes } from '@indx-workspace/app/server';",
        "import messageChannel from '@/channels/message';",
        'export const { GET, PATCH, DELETE } = resourceItemRoutes(message, { publish: messageChannel });',
        '',
      ].join('\n'),
    );
    const manifest = JSON.parse(after['aw-generated.json'] ?? '{}') as {
      entries: Record<string, { files: Record<string, string>; edits: unknown[] }>;
    };
    expect(Object.keys(manifest.entries['channel:message']?.files ?? {})).toEqual([
      'app/api/channels/message/events/route.ts',
      'app/channels/message/[key]/page.tsx',
      'channels/message.ts',
    ]);
    expect(manifest.entries['channel:message']?.edits).toHaveLength(4);
  });

  it('refuses a resource with no ref() to key on, as channel_key_required, and writes nothing', async () => {
    const root = await chatApp();
    const before = await tree(root);

    const room = await aw(root, ['generate', 'channel', 'room']);
    const wrongKey = await aw(root, ['generate', 'channel', 'message', '--key', 'thread_root']);
    const missing = await aw(root, ['generate', 'channel', 'reaction']);

    expect(room.code).toBe(EXIT_CODE.usage);
    expect(room.stderr).toContain('channel_key_required');
    expect(wrongKey.code).toBe(EXIT_CODE.usage);
    expect(wrongKey.stderr).toContain(
      'channel_key_required: thread_root refers to the resource itself',
    );
    expect(missing.code).toBe(EXIT_CODE.problem);
    expect(missing.stderr).toContain('there is no resource reaction here');
    expect(await tree(root)).toEqual(before);
  });

  it('destroy channel after editing channels/message.ts exits non-zero and names the file', async () => {
    const root = await chatApp();
    await aw(root, ['generate', 'channel', 'message']);
    await writeFile(path.join(root, 'channels/message.ts'), '// mine now\n');
    const before = await tree(root);

    const run = await aw(root, ['destroy', 'channel', 'message', '--yes']);

    expect(run.code).toBe(EXIT_CODE.problem);
    expect(run.stderr).toContain('edited since they were generated:\n  channels/message.ts');
    expect(await tree(root)).toEqual(before);
  });

  it('destroy channel restores the route files byte for byte, and the resource can go after it', async () => {
    const root = await chatApp();
    const before = await tree(root);
    await aw(root, ['generate', 'channel', 'message']);

    const refused = await aw(root, ['destroy', 'resource', 'message', '--yes']);
    const run = await aw(root, ['destroy', 'channel', 'message', '--yes']);

    expect(refused.code).toBe(EXIT_CODE.problem);
    expect(refused.stderr).toContain('app/api/messages/route.ts');
    expect(run.code).toBe(EXIT_CODE.ok);
    expect(await tree(root)).toEqual(before);
    expect((await aw(root, ['destroy', 'resource', 'message', '--yes'])).code).toBe(EXIT_CODE.ok);
  });
});

describe('aw destroy', () => {
  it('without --yes prints the plan and deletes nothing', async () => {
    const root = await generatedApp();
    await aw(root, RESOURCE);
    const before = await tree(root);

    const run = await aw(root, ['destroy', 'resource', 'ticket']);

    expect(run.code).toBe(EXIT_CODE.ok);
    expect(run.stdout).toContain('unchanged resources/ticket.ts');
    expect(run.stdout).toContain(
      "revert    app.config.ts: import ticket from './resources/ticket.ts';",
    );
    expect(run.stderr).toContain('nothing removed; run aw destroy resource ticket --yes');
    expect(await tree(root)).toEqual(before);
  });

  it('destroy refuses an edited file', async () => {
    const root = await generatedApp();
    await aw(root, RESOURCE);
    await writeFile(path.join(root, 'resources/ticket.ts'), '// mine now\n');
    const before = await tree(root);

    const run = await aw(root, ['destroy', 'resource', 'ticket', '--yes']);

    expect(run.code).toBe(EXIT_CODE.problem);
    expect(run.stderr).toContain('edited since they were generated:\n  resources/ticket.ts');
    expect(await tree(root)).toEqual(before);
  });

  it('destroy restores the tree byte for byte', async () => {
    const root = await generatedApp();
    const beforeResource = await tree(root);
    await aw(root, [...RESOURCE, '--board', 'status']);
    const beforePages = await tree(root);
    const generated = [
      await aw(root, ['generate', 'page', 'dashboard', '--kind', 'dashboard']),
      await aw(root, ['generate', 'page', 'mine', '--kind', 'list', '--resource', 'ticket']),
      await aw(root, ['generate', 'page', 'team_rota', '--kind', 'custom']),
    ];
    expect(Object.keys(await tree(root))).toEqual(
      expect.arrayContaining(['app/tickets/[id]/page.tsx', 'app/mine/page.tsx']),
    );

    const pages = [
      await aw(root, ['destroy', 'page', 'team_rota', '--yes']),
      await aw(root, ['destroy', 'page', 'mine', '--yes']),
      await aw(root, ['destroy', 'page', 'dashboard', '--yes']),
    ];
    const afterPages = await tree(root);
    const run = await aw(root, ['destroy', 'resource', 'ticket', '--yes']);

    expect([...generated, ...pages].map((each) => each.code)).toEqual([0, 0, 0, 0, 0, 0]);
    expect(afterPages).toEqual(beforePages);
    expect(run.code).toBe(EXIT_CODE.ok);
    expect(await tree(root)).toEqual(beforeResource);
  });

  it('undoes app, resource and agent back to the project as it was', async () => {
    const root = await project();
    const original = await tree(root);
    await aw(root, ['generate', 'app', 'service-desk']);
    await aw(root, RESOURCE);
    await aw(root, ['generate', 'agent', 'triage', '--tools', 'ticket']);

    const runs = [
      await aw(root, ['destroy', 'agent', 'triage', '--yes']),
      await aw(root, ['destroy', 'resource', 'ticket', '--yes']),
      await aw(root, ['destroy', 'app', 'service-desk', '--yes']),
    ];

    expect(runs.map((run) => run.code)).toEqual([0, 0, 0]);
    expect(await tree(root)).toEqual(original);
  });

  it('destroy app refuses while a resource remains', async () => {
    const root = await generatedApp();
    await aw(root, RESOURCE);
    const before = await tree(root);

    const run = await aw(root, ['destroy', 'app', 'service-desk', '--yes']);

    expect(run.code).toBe(EXIT_CODE.problem);
    expect(run.stderr).toContain('the app still has resource:ticket; destroy them first');
    expect(await tree(root)).toEqual(before);
  });

  it('refuses to drop a migration that a later one follows', async () => {
    const root = await generatedApp();
    await aw(root, RESOURCE);
    await aw(root, ['generate', 'resource', 'deal', 'amount:money(JPY)']);
    const before = await tree(root);

    const run = await aw(root, ['destroy', 'resource', 'ticket', '--yes']);

    expect(run.code).toBe(EXIT_CODE.problem);
    expect(run.stderr).toContain('write a drop migration instead');
    expect(await tree(root)).toEqual(before);
  });

  it('removes a deleted file from the record and leaves a line no longer there', async () => {
    const root = await generatedApp();
    await aw(root, RESOURCE);
    await rm(path.join(root, 'tests/ticket.test.ts'));
    const config = path.join(root, 'app.config.ts');
    await writeFile(config, (await readFile(config, 'utf8')).replace('    ticket,\n', ''));

    const run = await aw(root, ['destroy', 'resource', 'ticket', '--yes']);

    expect(run.code).toBe(EXIT_CODE.ok);
    expect(run.stdout).toContain('missing   tests/ticket.test.ts');
    expect(run.stdout).toContain('gone      app.config.ts: ticket,');
    expect(await readFile(path.join(root, 'aw-generated.json'), 'utf8')).not.toContain('ticket');
  });

  it('refuses aw destroy project by name and leaves the tree byte-identical (#1531)', async () => {
    const root = await generatedApp();
    const manifestPath = path.join(root, 'aw-generated.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
      entries: Record<string, unknown>;
    };
    manifest.entries['project:desk'] = { files: {}, edits: [] };
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const before = await tree(root);

    const run = await aw(root, ['destroy', 'project', 'desk', '--yes']);
    const app = await aw(root, ['destroy', 'app', 'service-desk']);

    expect(run.code).toBe(EXIT_CODE.problem);
    expect(run.stderr).toContain("the project's own files are not destroyed");
    expect(run.stderr).toContain('remove the directory instead');
    expect(await tree(root)).toEqual(before);
    // The project's entry is not one the app must wait for.
    expect(app.code).toBe(EXIT_CODE.ok);
    expect(app.stdout).toContain('aw destroy app service-desk would remove:');
  });

  it('refuses a name that was never generated, an unknown kind and an unreadable manifest', async () => {
    const root = await generatedApp();

    const unknown = await aw(root, ['destroy', 'resource', 'ghost']);
    const kind = await aw(root, ['destroy', 'widget', 'home']);
    await writeFile(path.join(root, 'aw-generated.json'), '{"version":1,"entries":{},"extra":1}');
    const invalid = await aw(root, ['destroy', 'app', 'service-desk']);

    expect(unknown.code).toBe(EXIT_CODE.problem);
    expect(unknown.stderr).toContain('records no resource named ghost');
    expect(kind.code).toBe(EXIT_CODE.usage);
    expect(invalid.code).toBe(EXIT_CODE.problem);
    expect(invalid.stderr).toContain('fix: restore aw-generated.json from version control');
  });
});
