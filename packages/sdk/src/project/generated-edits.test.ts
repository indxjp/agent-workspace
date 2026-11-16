import { describe, expect, it } from 'vitest';

import {
  MIGRATION_JOURNAL_FILE,
  PACKAGE_MANIFEST_FILE,
  readMigrationJournal,
  readPackageManifest,
  revertGeneratedEdit,
  serializeMigrationJournal,
} from './generated-edits.js';

const CONFIG = [
  "import { defineApp } from '@indx-workspace/app';",
  "import ticket from './resources/ticket.ts';",
  '',
  'export default defineApp({',
  '  resources: [',
  '    ticket,',
  '  ],',
  '});',
  '',
].join('\n');

const JOURNAL = {
  version: '7',
  dialect: 'postgresql' as const,
  entries: [
    { idx: 0, version: '7', when: 1, tag: '0000_app_kit', breakpoints: true },
    { idx: 1, version: '7', when: 2, tag: '0001_create_tickets', breakpoints: true },
  ],
};

describe('revertGeneratedEdit', () => {
  it('removes an added line, and leaves a line edited since alone', () => {
    const edit = { path: 'app.config.ts', added: "import ticket from './resources/ticket.ts';" };

    expect(revertGeneratedEdit(CONFIG, edit)).toEqual({
      kind: 'reverted',
      text: CONFIG.replace(`${edit.added}\n`, ''),
    });
    expect(revertGeneratedEdit(CONFIG.replace('ticket.ts', 'tickets.ts'), edit)).toEqual({
      kind: 'absent',
    });
  });

  it('puts a replaced line back while the line that replaced it is there verbatim', () => {
    const edit = {
      path: 'app/api/messages/route.ts',
      added: 'export const { GET, POST } = resourceRoutes(message, { publish });',
      replaced: 'export const { GET, POST } = resourceRoutes(message);',
    };
    const text = `import x from 'y';\n${edit.added}\n`;

    expect(revertGeneratedEdit(text, edit)).toEqual({
      kind: 'reverted',
      text: `import x from 'y';\n${edit.replaced}\n`,
    });
    expect(revertGeneratedEdit(`${edit.added.replace('POST', 'PUT')}\n`, edit)).toEqual({
      kind: 'absent',
    });
  });

  it('unpins a package.json package in its own order, with the section it created', () => {
    const original = '{\n    "name": "desk",\n    "scripts": { "dev": "aw dev" }\n}\n';
    const pinned =
      '{\n    "name": "desk",\n    "scripts": {\n        "dev": "aw dev"\n    },\n    "dependencies": {\n        "next": "16.4.3"\n    }\n}\n';
    const edit = { path: PACKAGE_MANIFEST_FILE, added: '{"dependencies":{"next":"16.4.3"}}' };

    expect(revertGeneratedEdit(pinned, edit)).toEqual({
      kind: 'reverted',
      text: '{\n    "name": "desk",\n    "scripts": {\n        "dev": "aw dev"\n    }\n}\n',
    });
    expect(revertGeneratedEdit(pinned.replace('16.4.3', '16.5.0'), edit)).toEqual({
      kind: 'absent',
    });
    expect(revertGeneratedEdit('[', edit)).toMatchObject({ kind: 'refused' });
    expect(readPackageManifest(`\uFEFF${original}`)?.['name']).toBe('desk');
  });

  it('drops the last journal entry in any key order, and refuses an earlier one', () => {
    const text = serializeMigrationJournal(JOURNAL);
    const last = { path: MIGRATION_JOURNAL_FILE, added: JSON.stringify(JOURNAL.entries[1]) };
    const reordered = {
      path: MIGRATION_JOURNAL_FILE,
      added: '{"tag":"0001_create_tickets","breakpoints":true,"when":2,"version":"7","idx":1}',
    };

    const reverted = revertGeneratedEdit(text, last);
    expect(reverted).toEqual(revertGeneratedEdit(text, reordered));
    expect(reverted.kind === 'reverted' ? readMigrationJournal(reverted.text) : undefined).toEqual({
      ...JOURNAL,
      entries: [JOURNAL.entries[0]],
    });
    const earlier = revertGeneratedEdit(text, {
      path: MIGRATION_JOURNAL_FILE,
      added: JSON.stringify(JOURNAL.entries[0]),
    });
    expect(earlier.kind).toBe('refused');
    expect(earlier.kind === 'refused' ? earlier.reason : '').toContain('0000_app_kit');
    expect(revertGeneratedEdit('{', last)).toMatchObject({ kind: 'refused' });
  });
});
