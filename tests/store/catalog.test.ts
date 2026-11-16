/**
 * The Agent Store catalog (`examples/store/catalog/`), checked from the repository side.
 *
 * The catalog validates each entry with zod when its file loads and the whole list when its index
 * loads, so an invalid catalog fails any build that imports it. What the catalog cannot see from
 * inside its own folder (the No fork cell) is checked here: every entry file is in the catalog, a
 * live entry's source folder and demo agent exist, and the live entries are exactly the agents
 * already built on the SDK (the gallery's use cases and the apps benchmark's reference apps).
 */
import { existsSync, lstatSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';

import {
  AREAS,
  catalogProblems,
  countCatalog,
  defineEntry,
  WAVES,
  type CatalogEntry,
} from '../../examples/store/catalog/define.ts';
import { DEMO_SAMPLE_FILE_MAX_BYTES as SAMPLE_FILE_MAX_BYTES } from '../../apps/web/server/demo/provision/limits.ts';
import { CATALOG, COUNTS } from '../../examples/store/catalog/index.ts';
import { loadExampleApps, REPOSITORY_ROOT } from '../apps/registry.ts';
import { loadUseCases } from '../gallery/harness/registry.ts';
import { demoAgentDefinition } from './demo-agents.test-support.ts';

const CATALOG_DIR = path.join(REPOSITORY_ROOT, 'examples', 'store', 'catalog');

/** The catalog's own modules; every other `.ts` file in the folder is an entry. */
const NOT_ENTRIES = new Set([
  'define.ts',
  'index.ts',
  'line-counts.generated.ts',
  'sources.generated.ts',
  'recording.ts',
  'recordings.generated.ts',
  'verification.ts',
]);

const repositoryPath = (absolute: string): string =>
  path.relative(REPOSITORY_ROOT, absolute).split(path.sep).join('/');

/** The part of a defined agent the seed check reads: the files it is granted. */
interface DefinedAgentFiles {
  readonly files?: readonly { readonly path: string; readonly access: 'read' | 'read-write' }[];
}

const live = CATALOG.filter((entry) => entry.status === 'live');

const VALID_SOON = {
  slug: 'proposal',
  area: 'sales',
  status: 'soon',
  wave: 2,
  name: { ja: '提案書ドラフト', en: 'Proposal drafter' },
  summary: { ja: '骨子を作る。', en: 'Drafts an outline.' },
} as const;

const VALID_LIVE = {
  slug: 'ringi-review',
  area: 'finance',
  status: 'live',
  wave: 1,
  kind: 'agent',
  source: 'tests/gallery/ringi-review',
  name: { ja: '稟議レビュー', en: 'Ringi review agent' },
  summary: { ja: '稟議書を確認する。', en: 'Checks a ringi.' },
  demo: {
    agent: 'ringi-review',
    prompts: [{ ja: 'この稟議、回して大丈夫？', en: 'Is this ringi ready?' }],
    moment: { ja: '決裁ルートの誤りを指摘する。', en: 'Catches the wrong approval route.' },
    data: { ja: '決裁権限表', en: 'approval matrix' },
    seed: [{ collection: 'rules', from: 'data/rules' }],
  },
  safety: ['person', 'approval'],
} as const;

describe('the store catalog', () => {
  it('holds every entry file in the folder, each under its own slug', async () => {
    const files = (await readdir(CATALOG_DIR))
      .filter((file) => file.endsWith('.ts') && !NOT_ENTRIES.has(file))
      .sort();
    expect(CATALOG.map((entry) => `${entry.slug}.ts`).sort()).toEqual(files);
  });

  it('lives up to its own checks', () => {
    expect(catalogProblems(CATALOG)).toEqual([]);
  });

  it('is live for exactly the gallery use cases and the reference apps', () => {
    const built = [
      ...loadUseCases().map(({ dir }) => repositoryPath(dir)),
      ...loadExampleApps()
        .filter(({ benchmark }) => benchmark.reference)
        .map(({ dir }) => repositoryPath(dir)),
    ].sort();
    expect(built.length).toBeGreaterThan(0);
    expect(live.map((entry) => entry.source).sort()).toEqual(built);
  });

  it('names, for every live entry, a source folder and a demo agent that exist', () => {
    const missing = live.flatMap((entry) => {
      const source = path.join(REPOSITORY_ROOT, entry.source);
      if (!existsSync(source) || !statSync(source).isDirectory()) {
        return [`${entry.slug}: no folder ${entry.source}`];
      }
      const agent = path.join(source, 'agents', `${entry.demo.agent}.ts`);
      return existsSync(agent) ? [] : [`${entry.slug}: no agent ${repositoryPath(agent)}`];
    });
    expect(live.length).toBeGreaterThan(0);
    expect(missing).toEqual([]);
  });

  /** Every file under `folder`, with the problem each one has as a sample file (or none). */
  function sampleFileProblems(folder: string): string[] {
    const problems: string[] = [];
    const walk = (current: string, names: readonly string[]): void => {
      for (const name of names) {
        const full = path.join(current, name);
        const info = lstatSync(full);
        if (info.isSymbolicLink()) problems.push(`${repositoryPath(full)} is a symbolic link`);
        else if (info.isDirectory()) walk(full, readdirSync(full));
        else if (info.size > SAMPLE_FILE_MAX_BYTES) {
          problems.push(`${repositoryPath(full)} is larger than a sample file may be`);
        }
      }
    };
    walk(folder, readdirSync(folder));
    return problems;
  }

  it('seeds every live entry from sample-data folders that exist inside its source', () => {
    const problems = live.flatMap((entry) =>
      entry.demo.seed.flatMap(({ collection, from }) => {
        const source = realpathSync(path.join(REPOSITORY_ROOT, entry.source));
        const folder = path.join(source, from);
        if (!existsSync(folder) || !statSync(folder).isDirectory()) {
          return [`${entry.slug}: ${collection}: no folder ${entry.source}/${from}`];
        }
        // The folder, once symbolic links are resolved, is still inside the source tree.
        if (!realpathSync(folder).startsWith(`${source}${path.sep}`)) {
          return [`${entry.slug}: ${collection}: ${from} leaves ${entry.source}`];
        }
        const own = sampleFileProblems(folder).map((problem) => `${entry.slug}: ${problem}`);
        return readdirSync(folder).length === 0
          ? [`${entry.slug}: ${collection}: ${from} holds no file`, ...own]
          : own;
      }),
    );
    expect(problems).toEqual([]);
  });

  it('leaves exactly the app and tool entries with no sample files, a decision named here', () => {
    // These demos carry no sample file: an app keeps its data in its own database and a tool reads
    // through a connector, and a copied connector is a stand-in that answers a read from the entry's
    // records and a write with the demo-only reply (spec, "How Try it works", built in P6). Emptying
    // another seed, or seeding one of these, is a change to that statement and to this list.
    const unseeded = live.filter((entry) => entry.demo.seed.length === 0);
    expect(unseeded.map((e) => e.slug).sort()).toEqual(
      ['crm-sales', 'quotation', 'service-desk', 'team-chat', 'wiki'].sort(),
    );
    // Each carries its sample data as `demo.records` instead (their contents are checked by
    // `sample-data.test.ts`): a folder that exists inside the source and holds a file.
    const missing = unseeded.flatMap((entry) => {
      const folder = path.join(REPOSITORY_ROOT, entry.source, entry.demo.records ?? '');
      return entry.demo.records !== undefined &&
        existsSync(folder) &&
        statSync(folder).isDirectory()
        ? []
        : [`${entry.slug}: no records folder`];
    });
    expect(missing).toEqual([]);
  });

  it('gives every live entry its own demo agent name in a visitor workspace', () => {
    // The provisioner matches a copied agent by name, so two entries sharing one would be one agent.
    const names = live.map((entry) => entry.demo.agent);
    expect(names.filter((name, at) => names.indexOf(name) !== at)).toEqual([]);
  });

  it('names the seed collections two live entries share, a defect pinned here', () => {
    // Entries copy at their own paths, so a shared collection merges into one folder in a visitor
    // who tries both (each agent reads the other's files). Both agents address it as `manuals/…`;
    // renaming one needs its gallery source changed. Any new share is a failure; fixing this one
    // empties the list.
    const owners = new Map<string, string[]>();
    for (const entry of live) {
      for (const { collection } of entry.demo.seed) {
        owners.set(collection, [...(owners.get(collection) ?? []), entry.slug]);
      }
    }
    const shared = [...owners].filter(([, slugs]) => slugs.length > 1);
    expect(shared).toEqual([['manuals', ['manual-search', 'maintenance']]]);
  });

  it('seeds exactly the file collections its demo agent reads, and no other', () => {
    const problems: string[] = [];
    for (const entry of live) {
      const defined = demoAgentDefinition(entry) as DefinedAgentFiles;
      const declared = new Map(
        (defined.files ?? []).map((grant) => [grant.path, grant.access] as const),
      );
      const seeded = new Set(entry.demo.seed.map((folder) => folder.collection));
      for (const collection of seeded) {
        if (!declared.has(collection)) {
          problems.push(`${entry.slug}: seeds ${collection}, which the agent does not declare`);
        }
      }
      // A read-write collection is the agent's own output folder and may start empty; a
      // read-only one the agent could never read unless it is seeded.
      for (const [collection, access] of declared) {
        if (access === 'read' && !seeded.has(collection)) {
          problems.push(`${entry.slug}: the agent reads ${collection}, which is not seeded`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it('computes its counts from the entries', () => {
    const count = (keep: (entry: CatalogEntry) => boolean): number => CATALOG.filter(keep).length;
    expect(COUNTS.total).toBe(CATALOG.length);
    expect(COUNTS.live).toBe(live.length);
    expect(COUNTS.soon).toBe(count((entry) => entry.status === 'soon'));
    expect(COUNTS.areas).toBe(AREAS.length);
    for (const { id } of AREAS) {
      expect(COUNTS.byArea[id]).toEqual({
        total: count((entry) => entry.area === id),
        live: count((entry) => entry.area === id && entry.status === 'live'),
      });
    }
    for (const wave of WAVES) expect(COUNTS.byWave[wave]).toBe(count((e) => e.wave === wave));
    expect(COUNTS.byWave[1]).toBe(COUNTS.live);
  });
});

describe('a catalog entry', () => {
  it('accepts a valid live entry and a valid coming-soon entry', () => {
    expect(defineEntry(VALID_LIVE).slug).toBe('ringi-review');
    expect(defineEntry(VALID_SOON).status).toBe('soon');
  });

  it.each<[string, unknown]>([
    ['a name without its English', { ...VALID_SOON, name: { ja: '提案書ドラフト' } }],
    ['an empty summary', { ...VALID_SOON, summary: { ja: ' ', en: 'x' } }],
    ['an unknown area', { ...VALID_SOON, area: 'marketing' }],
    ['a slug that is not kebab-case', { ...VALID_SOON, slug: 'Proposal_Drafter' }],
    ['a coming-soon entry with a source', { ...VALID_SOON, source: 'tests/gallery/quotation' }],
    ['a coming-soon entry in wave 1', { ...VALID_SOON, wave: 1 }],
    ['a live entry without a source', { ...VALID_LIVE, source: undefined }],
    ['a live entry without a demo', { ...VALID_LIVE, demo: undefined }],
    ['a live entry in wave 2', { ...VALID_LIVE, wave: 2 }],
    [
      'a live entry whose source is outside the repository folders',
      { ...VALID_LIVE, source: '../x' },
    ],
    ['a live entry with no safety property', { ...VALID_LIVE, safety: [] }],
    ['a live entry claiming the audit log', { ...VALID_LIVE, safety: ['person', 'audit'] }],
    ['an unknown field', { ...VALID_SOON, price: 0 }],
    [
      'a live entry without a seed',
      { ...VALID_LIVE, demo: { ...VALID_LIVE.demo, seed: undefined } },
    ],
    ...[
      ['a seed folder that leaves the source', '../secrets'],
      ['an absolute seed folder', '/etc'],
      ['a seed folder with an empty segment', 'data//rules'],
      ['a seed folder with a dot segment', 'data/./rules'],
      ['a backslash seed folder', 'data\\rules'],
      ['an empty seed folder', ''],
    ].map(([label, from]): [string, unknown] => [
      `a live entry with ${label}`,
      { ...VALID_LIVE, demo: { ...VALID_LIVE.demo, seed: [{ collection: 'rules', from }] } },
    ]),
    [
      'a seed collection that leaves the workspace',
      {
        ...VALID_LIVE,
        demo: { ...VALID_LIVE.demo, seed: [{ collection: '../rules', from: 'data/rules' }] },
      },
    ],
    [
      'a seed with an unknown field',
      {
        ...VALID_LIVE,
        demo: { ...VALID_LIVE.demo, seed: [{ collection: 'rules', from: 'data/rules', to: 'x' }] },
      },
    ],
  ])('refuses %s', (_label, entry) => {
    expect(() => defineEntry(entry as never)).toThrow(ZodError);
  });

  it('is refused by the catalog check when its slug repeats or its kind disagrees with its source', () => {
    const live = defineEntry(VALID_LIVE);
    const asApp = defineEntry({ ...VALID_LIVE, slug: 'ringi-app', kind: 'app' });
    expect(catalogProblems([live, live, asApp])).toEqual([
      'ringi-review: the slug is used twice',
      "ringi-app: kind 'app' does not match source tests/gallery/ringi-review",
    ]);
  });

  it('is refused by the catalog check when a seed collection repeats', () => {
    const repeated = defineEntry({
      ...VALID_LIVE,
      demo: {
        ...VALID_LIVE.demo,
        seed: [
          { collection: 'rules', from: 'data/rules' },
          { collection: 'rules', from: 'data/ringi' },
        ],
      },
    });
    expect(catalogProblems([repeated])).toEqual([
      'ringi-review: a seed collection is listed twice',
    ]);
  });

  it('counts by area and wave without a typed-in number', () => {
    const soon = defineEntry(VALID_SOON);
    const later = defineEntry({ ...VALID_SOON, slug: 'later', area: 'it', wave: 3 });
    const counts = countCatalog([defineEntry(VALID_LIVE), soon, later]);
    expect(counts).toMatchObject({ total: 3, live: 1, soon: 2, areas: 3 });
    expect(counts.byWave).toEqual({ 1: 1, 2: 1, 3: 1 });
    expect(counts.byArea.finance).toEqual({ total: 1, live: 1 });
    expect(counts.byArea.legal).toEqual({ total: 0, live: 0 });
  });
});
