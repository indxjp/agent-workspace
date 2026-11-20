import { readFile } from 'node:fs/promises';
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

describe('aw generate resource output', () => {
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
});

describe('aw generate resource refusals', () => {
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
});
