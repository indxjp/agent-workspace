import { renderAppSpec, renderGeneratorTemplate, scriptEdit } from '@indx-workspace/sdk/project';
import { describe, expect, it } from 'vitest';

import {
  JOURNAL_FILE,
  journalEdit,
  missingScripts,
  nextJournalEntry,
  packageEdit,
  pinState,
  readJournal,
  readPackageManifest,
  revertEdit,
  serializeJournal,
  withAppConfigLines,
  withPackages,
} from './edits.js';

/** The `app.config.ts` that `aw generate app` writes. */
const CONFIG =
  renderGeneratorTemplate('app', renderAppSpec('desk')).find(
    (file) => file.path === 'app.config.ts',
  )?.contents ?? '';
const LINES = { import: "import ticket from './resources/ticket.ts';", entry: '    ticket,' };

describe('app.config.ts', () => {
  it('adds the import after the last import and the entry at the end of resources', () => {
    const added = withAppConfigLines(CONFIG, LINES) ?? '';

    expect(added).toContain(`';\n${LINES.import}\n\nexport default`);
    expect(added).toContain(`  resources: [\n${LINES.entry}\n  ],`);
    const once = revertEdit(added, { path: 'app.config.ts', added: LINES.import });
    const twice =
      once.kind === 'reverted'
        ? revertEdit(once.text, { path: 'app.config.ts', added: LINES.entry })
        : once;
    expect(twice).toEqual({ kind: 'reverted', text: CONFIG });
  });

  it('adds a recipe to recipes: [...] and reverts it to the bytes it found (#1514)', () => {
    const lines = {
      import: "import enrichContactRecipe from './recipes/enrich-contact.ts';",
      entry: '    enrichContactRecipe,',
    };
    const added = withAppConfigLines(CONFIG, lines, 'recipes') ?? '';

    expect(added).toContain(`  recipes: [\n${lines.entry}\n  ],`);
    expect(added).toContain('  resources: [\n  ],');
    const once = revertEdit(added, { path: 'app.config.ts', added: lines.import });
    const twice =
      once.kind === 'reverted'
        ? revertEdit(once.text, { path: 'app.config.ts', added: lines.entry })
        : once;
    expect(twice).toEqual({ kind: 'reverted', text: CONFIG });
    expect(
      withAppConfigLines(CONFIG.replace('  recipes: [\n  ],\n', ''), lines, 'recipes'),
    ).toBeUndefined();
  });

  it('refuses a config without a resources list of its own, or one that imports it already', () => {
    expect(withAppConfigLines('export default defineApp({ resources: [] });\n', LINES)).toBe(
      undefined,
    );
    expect(withAppConfigLines(withAppConfigLines(CONFIG, LINES) ?? '', LINES)).toBe(undefined);
  });
});

describe('package.json', () => {
  const pin = {
    section: 'devDependencies',
    name: 'dependency-cruiser',
    version: '18.7.0',
  } as const;

  it('adds a package in the file’s own indentation and removes it with the section it made', () => {
    const original = '{\n\t"name": "desk"\n}\n';
    const added = withPackages(original, [pin]) ?? '';

    expect(added).toBe(
      '{\n\t"name": "desk",\n\t"devDependencies": {\n\t\t"dependency-cruiser": "18.7.0"\n\t}\n}\n',
    );
    expect(revertEdit(added, packageEdit(pin))).toEqual({ kind: 'reverted', text: original });
  });

  it('leaves a package pinned at another version since, and tells pins apart', () => {
    const text = '{\n  "devDependencies": {\n    "dependency-cruiser": "19.0.0"\n  }\n}\n';
    const manifest = readPackageManifest(`\uFEFF${text}`);

    expect(revertEdit(text, packageEdit(pin))).toEqual({ kind: 'absent' });
    expect(manifest === undefined ? undefined : pinState(manifest, pin)).toBe('conflicting');
    expect(pinState({ dependencies: { 'dependency-cruiser': 'workspace:*' } }, pin)).toBe('pinned');
    expect(pinState({}, pin)).toBe('missing');
    expect(readPackageManifest('[1]')).toBe(undefined);
  });

  it('adds a script in the file’s own key order and removes it only while it runs that command', () => {
    const original =
      '{\n  "name": "desk",\n  "scripts": {\n    "dev": "aw dev"\n  },\n  "private": true\n}\n';
    const image = { name: 'image', command: 'docker build -t desk .' };
    const added = withPackages(original, [], [image]) ?? '';

    expect(added).toBe(
      '{\n  "name": "desk",\n  "scripts": {\n    "dev": "aw dev",\n    "image": "docker build -t desk ."\n  },\n  "private": true\n}\n',
    );
    expect(revertEdit(added, scriptEdit(image))).toEqual({ kind: 'reverted', text: original });
    expect(revertEdit(added.replace('docker build', 'podman build'), scriptEdit(image))).toEqual({
      kind: 'absent',
    });
    expect(missingScripts({ scripts: { image: 'make image' } }, [image])).toEqual([]);
    expect(missingScripts({}, [image])).toEqual([image]);
  });
});

describe('the migration journal', () => {
  const journal = readJournal(
    serializeJournal({
      version: '7',
      dialect: 'postgresql',
      entries: [{ idx: 0, version: '7', when: 1000, tag: '0000_app_kit', breakpoints: true }],
    }),
  );

  it('adds the next entry one millisecond later, and drops it while it is the last', () => {
    if (journal === undefined) throw new Error('the fixture journal must parse');
    const entry = nextJournalEntry(journal, 'tickets');
    const added = serializeJournal({ ...journal, entries: [...journal.entries, entry] });

    expect(entry).toEqual({
      idx: 1,
      version: '7',
      when: 1001,
      tag: '0001_create_tickets',
      breakpoints: true,
    });
    expect(revertEdit(added, journalEdit(entry))).toEqual({
      kind: 'reverted',
      text: serializeJournal(journal),
    });
  });

  it('refuses to drop an entry a later one follows', () => {
    if (journal === undefined) throw new Error('the fixture journal must parse');
    const first = nextJournalEntry(journal, 'tickets');
    const withFirst = { ...journal, entries: [...journal.entries, first] };
    const both = {
      ...withFirst,
      entries: [...withFirst.entries, nextJournalEntry(withFirst, 'deals')],
    };

    expect(revertEdit(serializeJournal(both), journalEdit(first))).toMatchObject({
      kind: 'refused',
      reason: expect.stringContaining('write a drop migration instead') as unknown,
    });
  });

  it('reads no journal whose entries skip an index, or that is not one', () => {
    expect(
      readJournal(
        JSON.stringify({
          version: '7',
          dialect: 'postgresql',
          entries: [{ idx: 1, version: '7', when: 1, tag: '0001_x', breakpoints: true }],
        }),
      ),
    ).toBe(undefined);
    expect(revertEdit('{', { path: JOURNAL_FILE, added: '{}' })).toMatchObject({
      kind: 'refused',
    });
  });
});
