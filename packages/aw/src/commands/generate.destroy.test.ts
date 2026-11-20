import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { EXIT_CODE } from '../output.js';

import {
  aw,
  generatedApp,
  project,
  removeProjectsAfterEach,
  RESOURCE,
  tree,
} from './generate.test-support.js';

removeProjectsAfterEach();

describe('aw destroy resource', () => {
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
});

describe('aw destroy app', () => {
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
});

describe('aw destroy records', () => {
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
