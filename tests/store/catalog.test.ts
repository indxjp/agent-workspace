/**
 * The Agent Store catalog (`examples/store/catalog/`), checked from the repository side.
 *
 * The catalog validates each entry with zod when its file loads and the whole list when its index
 * loads, so an invalid catalog fails any build that imports it. What the catalog cannot see from
 * inside its own folder (the No fork cell) is checked here: every entry file is in the catalog, a
 * live entry's source folder and demo agent exist, every use case in `use-cases/` has an entry, and
 * the live entries outside `use-cases/` are exactly the agents already built on the SDK (the
 * gallery's use cases and the apps benchmark's reference apps).
 *
 * The promotion check (the Agent Store 100-use-case plan, §7): an entry is `live` only with a source,
 * sample data (seed or records), a moment check, a JA and an EN recording that pass it, and a passing
 * R1 record for the current hash of its source (`tests/store/live-verify/source-hash.ts`). So a pull
 * request that flips an entry to live without its real-model record fails here, and so does one that
 * changes a live entry's source without verifying the new code.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';
import { z, ZodError } from 'zod';

import {
  AREAS,
  catalogProblems,
  countCatalog,
  defineEntry,
  hasSource,
  WAVES,
  type CatalogEntry,
} from '../../examples/store/catalog/define.ts';
import { DEMO_SAMPLE_FILE_MAX_BYTES as SAMPLE_FILE_MAX_BYTES } from '../../apps/web/server/demo/provision/limits.ts';
import { safetyTags } from '../../examples/store/app/labels.ts';
import { CATALOG, COUNTS } from '../../examples/store/catalog/index.ts';
import {
  judgeMoment,
  recordingFor,
  type Recording,
} from '../../examples/store/catalog/recording.ts';
import { RECORDINGS } from '../../examples/store/catalog/recordings.generated.ts';
import {
  REAL_MODEL_EVIDENCE,
  type RealModelRun,
} from '../../examples/store/catalog/verification.ts';
import { entrySourceHash, passedForSource, stagedView } from './live-verify/source-hash.ts';
import { loadExampleApps, REPOSITORY_ROOT } from '../apps/registry.ts';
import { loadUseCases } from '../gallery/harness/registry.ts';
import { demoAgentDefinition } from './demo-agents.test-support.ts';
import { seededEntries } from './seed/build.ts';

const CATALOG_DIR = path.join(REPOSITORY_ROOT, 'examples', 'store', 'catalog');

/** The catalog's own modules; every other `.ts` file in the folder is an entry. */
const NOT_ENTRIES = new Set([
  'define.ts',
  'index.ts',
  'line-counts.generated.ts',
  'sources.generated.ts',
  'source-hashes.generated.ts',
  'charts.generated.ts',
  'landing.generated.ts',
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

/**
 * The entries with a source: the live ones and the coming-soon ones whose code is merged. The staging
 * deploy seeds each, and the verification workspace holds them all, so their sources are checked
 * alike; only `status` decides what the store shows.
 */
const sourced = CATALOG.filter(hasSource);

/**
 * The entries with a source as staging seeds them (a live entry's staged rebuild, `next`, in its
 * place; ADR-0174): what the verification workspace holds and R1 verifies.
 */
const staged = seededEntries('staging');

/**
 * Every source and demo an entry with a source carries: its own, and a staged rebuild's beside it,
 * so a rebuild is checked like a source before R1 records it (a fix at the repoint would make the
 * record stale).
 */
const sourcesAndRebuilds = [...sourced, ...staged.filter((entry) => !sourced.includes(entry))];

/** Why an entry's source folder or demo agent file is missing; empty when both exist. */
function sourceProblems(entries: readonly CatalogEntry[]): string[] {
  return entries.flatMap((entry) => {
    if (!hasSource(entry)) return [];
    const source = path.join(REPOSITORY_ROOT, entry.source);
    if (!existsSync(source) || !statSync(source).isDirectory()) {
      return [`${entry.slug}: no folder ${entry.source}`];
    }
    const agent = path.join(source, 'agents', `${entry.demo.agent}.ts`);
    return existsSync(agent) ? [] : [`${entry.slug}: no agent ${repositoryPath(agent)}`];
  });
}

/** The use cases in `use-cases/`: the folders holding a project file (use-cases/README.md). */
function useCaseFolders(): string[] {
  const root = path.join(REPOSITORY_ROOT, 'use-cases');
  return readdirSync(root, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() && existsSync(path.join(root, entry.name, 'agent-workspace.yaml')),
    )
    .map((entry) => entry.name);
}

/**
 * Why a `use-cases/<name>` folder is not the source of the catalog entry under that slug: there is
 * no such entry, or it has another source (a gallery project or an app the folder would duplicate).
 * A coming-soon entry with no source yet is the one being built in its folder, and a live entry's
 * staged rebuild (`next`) names the folder it is being rebuilt in, which is its own.
 */
function useCaseFolderProblems(
  folders: readonly string[],
  entries: readonly CatalogEntry[],
): string[] {
  const bySlug = new Map(entries.map((entry) => [entry.slug, entry] as const));
  const misplaced = entries.flatMap((entry) => {
    const rebuild = entry.status === 'live' ? entry.next?.source : undefined;
    return rebuild === undefined || rebuild === `use-cases/${entry.slug}`
      ? []
      : [`${entry.slug}: its rebuild is in ${rebuild}, not use-cases/${entry.slug}`];
  });
  return [
    ...misplaced,
    ...folders.flatMap((name) => {
      const entry = bySlug.get(name);
      if (entry === undefined) return [`use-cases/${name} has no catalog entry`];
      const rebuild = entry.status === 'live' ? entry.next?.source : undefined;
      if (rebuild === `use-cases/${name}`) return [];
      if (entry.source !== undefined && entry.source !== `use-cases/${name}`) {
        return [`use-cases/${name}: the entry's source is ${entry.source}`];
      }
      return [];
    }),
  ];
}

/**
 * The live entries that went live before the R1 record existed and still wait for theirs
 * (`awaiting-r1.json`). It listed the 14 wave-1 entries, whose real-model runs were unit F4 of the
 * Agent Store 100-use-case plan (§9); their records have since been committed (the last,
 * service-desk, in flip wave 2e), so it is empty. A narrow exception documented in ENGINEERING_GUIDELINES.md ("Strictness
 * ratchets"): it may only shrink. The list's length must equal the ceiling below, so a removal
 * lowers it in the same change and a re-add shows as a raised ceiling in review; against the base
 * branch (`origin/main`, when the checkout has it) no entry may be added at all.
 */
const AWAITING_R1_FILE = 'tests/store/awaiting-r1.json';
const AWAITING_R1_CEILING = 0;
const awaitingR1Schema = z.strictObject({
  why: z.string().min(1),
  entries: z.array(z.string()).readonly(),
});
const AWAITING_R1: ReadonlySet<string> = new Set(
  awaitingR1Schema.parse(
    JSON.parse(readFileSync(path.join(REPOSITORY_ROOT, AWAITING_R1_FILE), 'utf8')),
  ).entries,
);

/** How `list` grew: a length other than `ceiling`, or an entry the base list does not hold. */
function awaitingR1Growth(
  list: ReadonlySet<string>,
  ceiling: number,
  base: ReadonlySet<string> | null,
): string[] {
  return [
    ...(list.size === ceiling
      ? []
      : [`${String(list.size)} entries against a ceiling of ${String(ceiling)}`]),
    ...[...list]
      .filter((slug) => base !== null && !base.has(slug))
      .map((slug) => `${slug} was added`),
  ];
}

/** The base branch's list, or `null` when the checkout has no `origin/main` or no list there yet. */
function baseAwaitingR1(): ReadonlySet<string> | null {
  try {
    const text = execFileSync('git', ['show', `origin/main:${AWAITING_R1_FILE}`], {
      cwd: REPOSITORY_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return new Set(awaitingR1Schema.parse(JSON.parse(text)).entries);
  } catch {
    return null;
  }
}

interface PromotionEvidence {
  readonly recordings: readonly Recording[];
  readonly runs: readonly RealModelRun[];
  readonly hashOf: (entry: CatalogEntry) => string | null;
  readonly awaitingR1: ReadonlySet<string>;
}

/** Why each live entry may not be live (the promotion check); empty when every one may. */
function promotionProblems(
  entries: readonly CatalogEntry[],
  evidence: PromotionEvidence,
): string[] {
  return entries.flatMap((entry) => {
    if (entry.status !== 'live') return [];
    const problems = sourceProblems([entry]);
    if (entry.demo.seed.length === 0 && entry.demo.records === undefined) {
      problems.push(`${entry.slug}: no sample data (seed or records)`);
    }
    const check = entry.demo.check;
    if (check === undefined) problems.push(`${entry.slug}: no moment check`);
    for (const lang of ['ja', 'en'] as const) {
      const recording = recordingFor(evidence.recordings, entry.slug, lang);
      if (recording === null) problems.push(`${entry.slug}: no ${lang} recording`);
      else if (check !== undefined && !judgeMoment(recording.turn, check).pass) {
        problems.push(`${entry.slug}: the ${lang} recording does not pass its moment check`);
      }
    }
    if (
      !evidence.awaitingR1.has(entry.slug) &&
      !passedForSource(entry.slug, evidence.hashOf(entry), evidence.runs)
    ) {
      problems.push(`${entry.slug}: no passing R1 record for its current source hash`);
    }
    return problems;
  });
}

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

  it('is live, outside use-cases/, for exactly the gallery use cases and the reference apps', () => {
    // A gallery use case whose entry was repointed to its use-cases/<slug> rebuild (ADR-0174) stays
    // as the tutorial and is no longer a store source.
    const rebuilt = new Set(
      live
        .filter((entry) => entry.source === `use-cases/${entry.slug}`)
        .map((entry) => `tests/gallery/${entry.slug}`),
    );
    const built = [
      ...loadUseCases()
        .map(({ dir }) => repositoryPath(dir))
        .filter((dir) => !rebuilt.has(dir)),
      ...loadExampleApps()
        .filter(({ benchmark }) => benchmark.reference)
        .map(({ dir }) => repositoryPath(dir)),
    ].sort();
    expect(built.length).toBeGreaterThan(0);
    const outsideUseCases = live.filter((entry) => !entry.source.startsWith('use-cases/'));
    expect(outsideUseCases.map((entry) => entry.source).sort()).toEqual(built);
  });

  it('names, for every entry with a source, a source folder and a demo agent that exist', () => {
    expect(live.length).toBeGreaterThan(0);
    expect(sourceProblems(sourcesAndRebuilds)).toEqual([]);
  });

  it('has an entry, under the folder name, for every use case in use-cases/', () => {
    expect(useCaseFolderProblems(useCaseFolders(), CATALOG)).toEqual([]);
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

  it('seeds every entry with a source from sample-data folders that exist inside its source', () => {
    const problems = sourcesAndRebuilds.flatMap((entry) =>
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
    // A records folder, wherever an entry names one, exists inside its source.
    const records = sourcesAndRebuilds.flatMap((entry) => {
      if (entry.demo.records === undefined) return [];
      const folder = path.join(REPOSITORY_ROOT, entry.source, entry.demo.records);
      return existsSync(folder) && statSync(folder).isDirectory()
        ? []
        : [`${entry.slug}: no records folder ${entry.demo.records}`];
    });
    expect(records).toEqual([]);
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

  it('gives every entry with a source its own demo agent name in a workspace', () => {
    // The provisioner matches a copied agent by name, so two entries sharing one would be one agent.
    // Checked as production seeds (current sources) and as staging seeds (rebuilds in place).
    for (const seeded of [sourced, staged]) {
      const names = seeded.map((entry) => entry.demo.agent);
      expect(names.filter((name, at) => names.indexOf(name) !== at)).toEqual([]);
    }
  });

  it('names the seed collections two entries with a source share, a defect pinned here', () => {
    // Entries copy at their own paths, so a shared collection merges into one folder in a visitor
    // who tries both (each agent reads the other's files). Both agents address it as `manuals/…`;
    // renaming one needs its gallery source changed. Any new share is a failure; fixing this one
    // empties the list.
    // Checked as production and as staging seed them, so a rebuild's collision fails before R1. The
    // rebuilds of both (`next`, ADR-0174) read their own folders, so staging no longer shares it.
    for (const [seeded, pinned] of [
      [sourced, [['manuals', ['manual-search', 'maintenance']]]],
      [staged, []],
    ] as const) {
      const owners = new Map<string, string[]>();
      for (const entry of seeded) {
        for (const { collection } of entry.demo.seed) {
          owners.set(collection, [...(owners.get(collection) ?? []), entry.slug]);
        }
      }
      const shared = [...owners].filter(([, slugs]) => slugs.length > 1);
      expect(shared).toEqual(pinned);
    }
  });

  it('seeds exactly the file collections its demo agent reads, and no other', () => {
    const problems: string[] = [];
    for (const entry of sourcesAndRebuilds) {
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
    // Every wave-1 entry is live; waves 2 and 3 go live entry by entry through the promotion check.
    expect(count((e) => e.wave === 1 && e.status === 'live')).toBe(COUNTS.byWave[1]);
  });

  it('lets an entry be live only with its evidence and a passing R1 record for its source', () => {
    expect(
      promotionProblems(CATALOG, {
        recordings: RECORDINGS,
        runs: REAL_MODEL_EVIDENCE.runs,
        hashOf: (entry) => entrySourceHash(entry),
        awaitingR1: AWAITING_R1,
      }),
    ).toEqual([]);
  });

  it('only shrinks the list of live entries still awaiting their R1 record', () => {
    expect(awaitingR1Growth(AWAITING_R1, AWAITING_R1_CEILING, baseAwaitingR1())).toEqual([]);
    for (const slug of AWAITING_R1) {
      const entry = CATALOG.find((candidate) => candidate.slug === slug);
      expect(entry?.status, `${slug} is not live: remove it from AWAITING_R1`).toBe('live');
      expect(entry?.wave, `${slug}: only wave-1 entries may wait`).toBe(1);
      expect(
        entry !== undefined &&
          passedForSource(slug, entrySourceHash(entry), REAL_MODEL_EVIDENCE.runs),
        `${slug} has its passing R1 record: remove it from AWAITING_R1 and lower the ceiling`,
      ).toBe(false);
    }
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
    [
      'a coming-soon entry with a source outside the repository folders',
      { ...VALID_SOON, source: '../x' },
    ],
    ['a coming-soon entry in wave 1', { ...VALID_SOON, wave: 1 }],
    ['a live entry without a source', { ...VALID_LIVE, source: undefined }],
    ['a live entry without a demo', { ...VALID_LIVE, demo: undefined }],
    ['a live entry in wave 4', { ...VALID_LIVE, wave: 4 }],
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

  it('takes a use-cases/<slug> source as one agent, never as an app', () => {
    const useCase = defineEntry({ ...VALID_LIVE, source: 'use-cases/ringi-review' });
    const asApp = defineEntry({
      ...VALID_LIVE,
      slug: 'ringi-app',
      kind: 'app',
      source: 'use-cases/ringi-review',
    });
    expect(catalogProblems([useCase, asApp])).toEqual([
      "ringi-app: kind 'app' does not match source use-cases/ringi-review",
    ]);
    expect(() => defineEntry({ ...VALID_LIVE, source: 'use-cases/Ringi_Review' })).toThrow(
      ZodError,
    );
    expect(() => defineEntry({ ...VALID_LIVE, source: 'use-cases/kit/ringi' })).toThrow(ZodError);
  });

  it('is reported when its source folder or demo agent is missing', () => {
    const missingFolder = defineEntry({
      ...VALID_LIVE,
      slug: 'no-such-use-case',
      source: 'use-cases/no-such-use-case',
    });
    const missingAgent = defineEntry({
      ...VALID_LIVE,
      demo: { ...VALID_LIVE.demo, agent: 'no-such-agent' },
    });
    expect(sourceProblems([missingFolder, missingAgent, defineEntry(VALID_LIVE)])).toEqual([
      'no-such-use-case: no folder use-cases/no-such-use-case',
      'ringi-review: no agent tests/gallery/ringi-review/agents/no-such-agent.ts',
    ]);
  });

  it('is the only source of a use-cases/ folder named by its slug', () => {
    const gallery = defineEntry(VALID_LIVE);
    const useCase = defineEntry({
      ...VALID_LIVE,
      slug: 'nda',
      source: 'use-cases/nda',
      demo: { ...VALID_LIVE.demo, agent: 'nda' },
    });
    const soon = defineEntry(VALID_SOON);
    expect(
      useCaseFolderProblems(['ringi-review', 'nda', 'proposal', 'stray'], [gallery, useCase, soon]),
    ).toEqual([
      "use-cases/ringi-review: the entry's source is tests/gallery/ringi-review",
      'use-cases/stray has no catalog entry',
    ]);
  });

  describe('with a staged rebuild (next)', () => {
    const NEXT = {
      source: 'use-cases/ringi-review',
      demo: { ...VALID_LIVE.demo, seed: [{ collection: 'ringi-review', from: 'data' }] },
    } as const;

    it('is a live entry with the rebuild in its own use-cases/<slug>, checked by the catalog', () => {
      const rebuilt = defineEntry({ ...VALID_LIVE, next: NEXT });
      expect(catalogProblems([rebuilt])).toEqual([]);
      const same = defineEntry({ ...VALID_LIVE, source: NEXT.source, next: NEXT });
      const app = defineEntry({ ...VALID_LIVE, kind: 'app', source: 'examples/ringi', next: NEXT });
      const repeated = defineEntry({
        ...VALID_LIVE,
        next: { ...NEXT, demo: { ...NEXT.demo, seed: [...NEXT.demo.seed, ...NEXT.demo.seed] } },
      });
      for (const wrong of [same, app]) {
        expect(catalogProblems([wrong])).toEqual([
          'ringi-review: next must be a new source of an agent entry',
        ]);
      }
      expect(catalogProblems([repeated])).toEqual([
        'ringi-review: a seed collection is listed twice',
      ]);
      const elsewhere = defineEntry({ ...VALID_LIVE, next: { ...NEXT, source: 'use-cases/nda' } });
      expect(useCaseFolderProblems(['nda'], [elsewhere])).toEqual([
        'ringi-review: its rebuild is in use-cases/nda, not use-cases/ringi-review',
        'use-cases/nda has no catalog entry',
      ]);
    });

    it('is refused on a coming-soon entry, or with a source or demo that is not one', () => {
      const soon = { ...VALID_LIVE, status: 'soon', wave: 2, next: NEXT };
      expect(() => defineEntry(soon as never)).toThrow(ZodError);
      for (const next of [
        { ...NEXT, source: '../x' },
        { ...NEXT, source: 'tests/gallery/ringi-review' },
        { source: NEXT.source },
        { ...NEXT, demo: { ...NEXT.demo, prompts: [] } },
        { ...NEXT, status: 'live' },
      ]) {
        expect(() => defineEntry({ ...VALID_LIVE, next } as never)).toThrow(ZodError);
      }
    });

    it('owns the use-cases/ folder it names, and its source and demo are checked like one', () => {
      const rebuilt = defineEntry({ ...VALID_LIVE, next: NEXT });
      if (!hasSource(rebuilt)) throw new Error('the rebuilt entry has a source');
      expect(useCaseFolderProblems(['ringi-review'], [rebuilt])).toEqual([]);
      const unbuilt = defineEntry({
        ...VALID_LIVE,
        slug: 'no-such-use-case',
        next: { ...NEXT, source: 'use-cases/no-such-use-case' },
      });
      if (!hasSource(unbuilt)) throw new Error('the unbuilt entry has a source');
      expect(sourceProblems([stagedView(unbuilt)])).toEqual([
        'no-such-use-case: no folder use-cases/no-such-use-case',
      ]);
      // The catalog as it is: every staged rebuild is among the sources checked.
      expect(sourcesAndRebuilds).toEqual(expect.arrayContaining([...sourced, ...staged]));
    });
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

  it('accepts a live entry of wave 2 or 3, which goes live through the promotion check', () => {
    expect(defineEntry({ ...VALID_LIVE, wave: 2 }).wave).toBe(2);
    expect(defineEntry({ ...VALID_LIVE, wave: 3 }).wave).toBe(3);
  });
});

describe('a coming-soon entry with its code merged', () => {
  // The batch PR merges an entry's code while it is still coming soon: the entry carries its source
  // and demo (and its safety), so the staging deploy seeds it and R1 runs before the flip.
  const SOURCED_SOON = { ...VALID_LIVE, status: 'soon', wave: 2 } as const;

  it('carries its source and demo, and passes the checks a live source passes', () => {
    const entry = defineEntry(SOURCED_SOON);
    expect(entry.status).toBe('soon');
    expect(hasSource(entry)).toBe(true);
    expect(hasSource(defineEntry(VALID_SOON))).toBe(false);
    expect(catalogProblems([entry])).toEqual([]);
    expect(sourceProblems([entry])).toEqual([]);
    // It is not live, so the promotion check asks nothing of it yet.
    expect(
      promotionProblems([entry], {
        recordings: [],
        runs: [],
        hashOf: () => null,
        awaitingR1: new Set(),
      }),
    ).toEqual([]);
  });

  it('is reported like a live entry when its source folder or demo agent is missing', () => {
    const missingFolder = defineEntry({
      ...SOURCED_SOON,
      slug: 'no-such-use-case',
      source: 'use-cases/no-such-use-case',
    });
    const missingAgent = defineEntry({
      ...SOURCED_SOON,
      demo: { ...SOURCED_SOON.demo, agent: 'no-such-agent' },
    });
    expect(sourceProblems([missingFolder, missingAgent])).toEqual([
      'no-such-use-case: no folder use-cases/no-such-use-case',
      'ringi-review: no agent tests/gallery/ringi-review/agents/no-such-agent.ts',
    ]);
  });

  it('carries kind, source and demo together, with the same rules as a live entry', () => {
    const { demo, ...noDemo } = SOURCED_SOON;
    expect(demo.agent).toBe('ringi-review');
    const { kind, source, ...demoOnly } = SOURCED_SOON;
    expect([kind, source]).toEqual(['agent', 'tests/gallery/ringi-review']);
    expect(
      catalogProblems([
        defineEntry(noDemo),
        defineEntry({ ...demoOnly, slug: 'demo-only' }),
        defineEntry({ ...SOURCED_SOON, slug: 'as-app', kind: 'app' }),
        defineEntry({ ...SOURCED_SOON, slug: 'twice', safety: ['person', 'person'] }),
        defineEntry({ ...VALID_SOON, safety: ['approval', 'approval'] }),
      ]),
    ).toEqual([
      'ringi-review: kind, source and demo go together',
      'demo-only: kind, source and demo go together',
      "as-app: kind 'app' does not match source tests/gallery/ringi-review",
      'twice: a safety property is listed twice',
      'proposal: a safety property is listed twice',
    ]);
    expect(() => defineEntry({ ...SOURCED_SOON, wave: 1 } as never)).toThrow(ZodError);
    expect(() =>
      defineEntry({ ...SOURCED_SOON, demo: { ...SOURCED_SOON.demo, prompts: [] } }),
    ).toThrow(ZodError);
  });

  it('owns its use-cases/ folder only when that is its source', () => {
    const elsewhere = defineEntry({ ...SOURCED_SOON, slug: 'nda' });
    const own = defineEntry({
      ...SOURCED_SOON,
      slug: 'incident',
      source: 'use-cases/incident',
      demo: { ...SOURCED_SOON.demo, agent: 'incident' },
    });
    expect(useCaseFolderProblems(['nda', 'incident'], [elsewhere, own])).toEqual([
      "use-cases/nda: the entry's source is tests/gallery/ringi-review",
    ]);
  });

  it('is still shown as coming soon: the store reads status, not the source', () => {
    const entry = defineEntry(SOURCED_SOON);
    expect(safetyTags(entry, 'en')).toEqual([]);
    expect(countCatalog([entry])).toMatchObject({ live: 0, soon: 1 });
  });
});

describe('the list of entries awaiting R1', () => {
  it('may not grow: its length is the ceiling, and nothing the base list lacks is added', () => {
    const base = new Set(['wiki', 'crm-sales']);
    expect(awaitingR1Growth(new Set(['wiki']), 1, base)).toEqual([]);
    expect(awaitingR1Growth(new Set(['wiki']), 1, null)).toEqual([]);
    expect(awaitingR1Growth(new Set(['wiki']), 2, base)).toEqual([
      '1 entries against a ceiling of 2',
    ]);
    expect(awaitingR1Growth(new Set(['wiki', 'nda']), 2, base)).toEqual(['nda was added']);
  });
});

describe('the promotion check', () => {
  const HASH = 'c'.repeat(64);
  const flipped = defineEntry({
    ...VALID_LIVE,
    wave: 2,
    demo: { ...VALID_LIVE.demo, check: { tools: ['search_files'], approval: null } },
  });
  const turn = {
    prompt: 'あ',
    stopReason: 'end_turn',
    steps: [
      { kind: 'tool', name: 'search_files', input: {}, output: 'ok', isError: false } as const,
    ],
  };
  const recordings: Recording[] = (['ja', 'en'] as const).map((lang) => ({
    slug: flipped.slug,
    lang,
    recordedWith: 'scripted-model',
    turn,
  }));
  const run = (over: Partial<RealModelRun> = {}): RealModelRun => ({
    entry: flipped.slug,
    runId: 'run-1',
    date: '2026-11-21T00:00:00.000Z',
    result: 'pass',
    reason: 'the moment happened',
    environment: 'staging',
    sourceHash: HASH,
    ...over,
  });
  const problems = (over: Partial<PromotionEvidence>, entry: CatalogEntry = flipped) =>
    promotionProblems([entry], {
      recordings,
      runs: [run()],
      hashOf: () => HASH,
      awaitingR1: new Set(),
      ...over,
    });

  it('passes an entry with every piece of evidence', () => {
    expect(problems({})).toEqual([]);
  });

  it('fails a soon entry flipped to live without an R1 record', () => {
    expect(problems({ runs: [] })).toEqual([
      'ringi-review: no passing R1 record for its current source hash',
    ]);
  });

  it('fails one whose record is for other code, or whose latest record for this code failed', () => {
    const stale = 'ringi-review: no passing R1 record for its current source hash';
    expect(problems({ runs: [run({ sourceHash: 'd'.repeat(64) })] })).toEqual([stale]);
    expect(problems({ hashOf: () => null })).toEqual([stale]);
    expect(
      problems({
        runs: [run(), run({ runId: 'run-2', date: '2026-11-22T00:00:00.000Z', result: 'fail' })],
      }),
    ).toEqual([stale]);
    expect(problems({ runs: [], awaitingR1: new Set([flipped.slug]) })).toEqual([]);
  });

  it('fails one without sample data, a moment check or passing recordings', () => {
    const bare = defineEntry({ ...VALID_LIVE, demo: { ...VALID_LIVE.demo, seed: [] } });
    expect(problems({ recordings: [] }, bare)).toEqual([
      'ringi-review: no sample data (seed or records)',
      'ringi-review: no moment check',
      'ringi-review: no ja recording',
      'ringi-review: no en recording',
    ]);
    const silent = recordings.map((recording) => ({
      ...recording,
      turn: { ...turn, steps: [] },
    }));
    expect(problems({ recordings: silent })).toEqual([
      'ringi-review: the ja recording does not pass its moment check',
      'ringi-review: the en recording does not pass its moment check',
    ]);
  });
});
