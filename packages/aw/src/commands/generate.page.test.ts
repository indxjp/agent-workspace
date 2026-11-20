import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { EXIT_CODE } from '../output.js';

import {
  aw,
  changed,
  generatedApp,
  project,
  removeProjectsAfterEach,
  RESOURCE,
  tree,
} from './generate.test-support.js';

removeProjectsAfterEach();

describe('aw generate page', () => {
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
});

describe('aw generate page refusals', () => {
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
});
