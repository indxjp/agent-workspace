/**
 * The Agent Store catalog's contract: one entry per agent, validated with zod when its file is
 * loaded, so an invalid entry fails any build or test that imports the catalog.
 *
 * This folder imports nothing but `zod` and its own files (the No fork cell of the apps
 * benchmark): it cannot read the repository around it. What it cannot check itself (that an
 * entry's source folder and demo agent exist, that the published line counts match the apps
 * benchmark) the repository's tests check from outside: `tests/store/catalog.test.ts` and
 * `tests/apps/store-line-counts.test.ts`.
 */
import { z } from 'zod';

/**
 * The ten shelves, in the order the store shows them. `flow` is what an agent of the area looks up
 * (step two of the detail page's "How it works") and `connects` the systems it is shown to connect
 * to; an entry may override either. `connects` are also the choices of the Customize tab's
 * `connection` control.
 */
export const AREAS = [
  {
    id: 'sales',
    name: { ja: '営業・CRM', en: 'Sales & CRM' },
    flow: {
      ja: ['顧客・商談データ', '過去の見積・提案', '社内ルール'],
      en: ['customer and deal data', 'past quotes and proposals', 'company rules'],
    },
    connects: ['CRM', 'Excel', 'Mail'],
  },
  {
    id: 'support',
    name: { ja: 'カスタマーサポート', en: 'Customer support' },
    flow: {
      ja: ['問い合わせ', 'マニュアル・過去対応', '対応ルール'],
      en: ['enquiries', 'manuals and past replies', 'support rules'],
    },
    connects: ['Mail', 'Helpdesk', 'Chat'],
  },
  {
    id: 'knowledge',
    name: { ja: 'ナレッジ・文書', en: 'Knowledge & documents' },
    flow: {
      ja: ['社内文書', 'マニュアル・規程', '用語集'],
      en: ['internal documents', 'manuals and policies', 'glossary'],
    },
    connects: ['Files', 'Wiki', 'SharePoint'],
  },
  {
    id: 'mfg',
    name: { ja: '製造・品質', en: 'Manufacturing & quality' },
    flow: {
      ja: ['図面・仕様書', '不良・保全の記録', '設備マニュアル'],
      en: ['drawings and specs', 'defect and maintenance records', 'equipment manuals'],
    },
    connects: ['Files', 'Excel', 'MES'],
  },
  {
    id: 'legal',
    name: { ja: '法務・コンプライアンス', en: 'Legal & compliance' },
    flow: {
      ja: ['契約書・規約', '自社の審査基準', '法令・ガイドライン'],
      en: ['contracts and terms', 'review standards', 'laws and guidelines'],
    },
    connects: ['Files', 'Word', 'Mail'],
  },
  {
    id: 'finance',
    name: { ja: '財務・経理', en: 'Finance & accounting' },
    flow: {
      ja: ['伝票・Excel', '規程・決裁権限表', '過去の実績'],
      en: ['vouchers and spreadsheets', 'rules and approval matrix', 'past results'],
    },
    connects: ['Excel', 'Workflow', 'ERP'],
  },
  {
    id: 'hr',
    name: { ja: '人事・総務', en: 'HR & admin' },
    flow: { ja: ['人事データ', '就業規則', '申請'], en: ['HR records', 'work rules', 'requests'] },
    connects: ['HR system', 'Calendar', 'Mail'],
  },
  {
    id: 'it',
    name: { ja: 'IT・開発', en: 'IT & engineering' },
    flow: {
      ja: ['ログ・アラート', 'ソースコード', '手順書'],
      en: ['logs and alerts', 'source code', 'runbooks'],
    },
    connects: ['GitHub', 'Monitoring', 'Chat'],
  },
  {
    id: 'collab',
    name: { ja: 'コラボレーション', en: 'Collaboration' },
    flow: {
      ja: ['チャット・会議', 'タスク', '予定'],
      en: ['chat and meetings', 'tasks', 'calendars'],
    },
    connects: ['Chat', 'Calendar', 'Tasks'],
  },
  {
    id: 'analytics',
    name: { ja: '調査・分析', en: 'Research & analytics' },
    flow: {
      ja: ['社内の数字', '公開情報', '過去レポート'],
      en: ['internal figures', 'public sources', 'past reports'],
    },
    connects: ['BigQuery', 'Excel', 'Web'],
  },
] as const;

export type AreaId = (typeof AREAS)[number]['id'];

const AREA_IDS = AREAS.map((area) => area.id) as [AreaId, ...AreaId[]];

/**
 * What a live demo is shown to do. `audit` is not here: the audit log records changes, not runs
 * (spec 04 and the open item in 08), so no card may claim that every run is in it.
 */
export const SAFETY_PROPERTIES = ['person', 'approval', 'structured', 'trigger', 'files'] as const;

/** Wave 1 is the live entries at launch; waves 2 and 3 follow it. */
export const WAVES = [1, 2, 3] as const;
export type Wave = (typeof WAVES)[number];

/**
 * What a visitor can change on the "Install & customize" tab, in the order the tab shows them. An
 * entry lists the ones that apply to it (`customize`); without a list it gets all of them. The
 * enquiry the tab ends with carries the chosen values, keyed by these names.
 */
export const CUSTOMIZE_CONTROLS = [
  'companyName',
  'approvalRule',
  'tone',
  'language',
  'connection',
] as const;
export type CustomizeControl = (typeof CUSTOMIZE_CONTROLS)[number];

/** The public repository a live entry's "View source" link opens, at `<url>/tree/main/<source>`. */
export const PUBLIC_REPOSITORY_URL = 'https://github.com/indxjp/agent-workspace';

const bilingual = z.strictObject({
  ja: z.string().trim().min(1),
  en: z.string().trim().min(1),
});

/**
 * A project-relative folder: no leading or trailing slash, no empty, `.` or `..` segment and no
 * backslash, so it can name nothing outside the tree it is read from.
 */
const relativeFolder = z
  .string()
  .min(1)
  .max(1024)
  .refine(
    (value) =>
      !value.includes('\\') &&
      value.split('/').every((part) => part !== '' && part !== '.' && part !== '..'),
    'a relative folder with no empty, . or .. segment',
  );

/**
 * One sample-data folder the demo copies into the visitor's workspace. `collection` is the path
 * the demo agent is granted with `files()`; `from` is the folder of the source that holds the
 * sample data, relative to the source. Both are checked against the source by
 * `tests/store/catalog.test.ts`, which this folder cannot do (the No fork cell).
 */
const seedFolder = z.strictObject({ collection: relativeFolder, from: relativeFolder });

const slug = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u, 'a lowercase kebab-case slug');

/** A tool's own name, as an agent definition declares it (a run may report it with a prefix). */
const toolName = z.string().regex(/^[A-Za-z0-9_.-]{1,128}$/u, 'a tool name');

/**
 * The entry's moment as a machine can check it (spec, "Real-model verification gate (R1)"): the
 * tools one run of its suggested prompt must call, and the tool whose call must wait for a
 * person's approval and then run once approved (`null` when the moment has no approval). The
 * recordings and the real-model harness judge a run with the same rule, `judgeMoment`.
 */
const momentCheck = z.strictObject({
  tools: z.array(toolName).min(1).readonly(),
  approval: toolName.nullable(),
});

export type MomentCheck = z.infer<typeof momentCheck>;

/**
 * What every entry may say beyond its area's defaults (P4): the three things it looks up (`flow`,
 * replacing the area's `flow`), the systems it connects to (`connects`, replacing the area's), and
 * the Customize tab's controls that apply to it (`customize`, default all of
 * {@link CUSTOMIZE_CONTROLS}).
 */
const common = {
  slug,
  area: z.enum(AREA_IDS),
  name: bilingual,
  summary: bilingual,
  flow: z
    .strictObject({
      ja: z.array(z.string().trim().min(1)).length(3).readonly(),
      en: z.array(z.string().trim().min(1)).length(3).readonly(),
    })
    .optional(),
  connects: z.array(z.string().trim().min(1).max(40)).min(1).max(6).readonly().optional(),
  customize: z.array(z.enum(CUSTOMIZE_CONTROLS)).min(1).readonly().optional(),
};

/**
 * What makes an entry runnable: the kind of its source, the repository folder its source is in (an
 * example app under `examples/`, a gallery use case under `tests/gallery/` or a store use case under
 * `use-cases/`), the demo of that source and the safety it shows. A live entry has them all; a
 * coming-soon entry whose code is merged may carry them too, so the staging deploy seeds its
 * template and the real-model verification (R1) runs before it goes live (the Agent Store
 * 100-use-case plan, section 7).
 */
const runnable = {
  /**
   * `app`: an example app with agents (`examples/<id>`). `agent`: one agent (`tests/gallery/<id>`
   * or `use-cases/<slug>`).
   */
  kind: z.enum(['agent', 'app']),
  source: z
    .string()
    .regex(
      /^(?:examples|tests\/gallery|use-cases)\/[a-z0-9]+(?:-[a-z0-9]+)*$/u,
      'examples/<id>, tests/gallery/<id> or use-cases/<slug>',
    ),
  demo: z.strictObject({
    /** The agent, by file name under `<source>/agents/`, that the visitor's demo workspace gets. */
    agent: slug,
    /** What the visitor is offered to type first. */
    prompts: z.array(bilingual).min(1).readonly(),
    /** The one moment the demo must show. */
    moment: bilingual,
    /** The sample data the demo runs on. */
    data: bilingual,
    /**
     * The sample data the demo workspace is seeded with, one folder per file collection the demo
     * agent reads with `files()`. Sample data only. Empty when the agent declares no `files()`:
     * the data of an app entry lives in the app's own database, and a tool entry reads its data
     * through its tool. Those demos take their sample data from `records` below (spec, "How Try it
     * works"); `tests/store/catalog.test.ts` names the entries.
     */
    seed: z.array(seedFolder).readonly(),
    /**
     * Sample records for an entry whose demo agent reads through its app or a connector rather than
     * `files()` (so `seed` is empty): a folder, relative to the source, of fictional JA and EN
     * records in the source's own data format. The recordings run on them, and the deployment's seed
     * (`tests/store/seed/`) stores them in the template, where a visitor's copy reads them through a
     * records stand-in (built in P6). `tests/store/catalog.test.ts` checks the folder.
     */
    records: relativeFolder.optional(),
    /** The moment as a check; every live entry has one (`tests/store/catalog.test.ts`). */
    check: momentCheck.optional(),
    /**
     * The JSON Schema the demo's runs ask their answer in (ADR-0143), so the Try it section can
     * chart it with the source's surface `resultCharts`. Data, never code: a JSON object whose root
     * is `type: 'object'`. The platform's limits, and the match with the suggested eval case and the
     * charts, are checked from outside (`tests/store/result-charts.test.ts`).
     */
    outputSchema: z
      .record(z.string(), z.json())
      .refine((schema) => schema['type'] === 'object', 'a JSON Schema whose type is object')
      .readonly()
      .optional(),
  }),
  safety: z.array(z.enum(SAFETY_PROPERTIES)).min(1).readonly(),
};

/** A live entry runs for real, and the store shows its source and its Try it. */
const liveEntry = z.strictObject({
  ...common,
  status: z.literal('live'),
  /** Any wave: waves 2 and 3 go live through the promotion check (tests/store/catalog.test.ts). */
  wave: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  ...runnable,
  /**
   * A rebuild of this entry staged in `use-cases/<slug>` with its demo (the Agent Store 100-use-case
   * plan, section 7; ADR-0174): the staging deploy seeds it and R1 verifies it, while visitors,
   * production and the promotion check keep `source` and `demo`. The repoint moves both into place
   * and drops `next`, so the record R1 made for it stays current.
   */
  next: z
    .strictObject({
      source: z.string().regex(/^use-cases\/[a-z0-9]+(?:-[a-z0-9]+)*$/u, 'use-cases/<slug>'),
      demo: runnable.demo,
    })
    .optional(),
});

/**
 * A coming-soon entry: the store shows no link and no Try it, whatever it carries (`status` is the
 * switch). Once its code is merged it may carry its `kind`, `source` and `demo` (the three together,
 * {@link catalogProblems}) and its `safety`, so the flip to live changes only `status`.
 */
const soonEntry = z.strictObject({
  ...common,
  status: z.literal('soon'),
  wave: z.union([z.literal(2), z.literal(3)]),
  kind: runnable.kind.optional(),
  source: runnable.source.optional(),
  demo: runnable.demo.optional(),
  safety: runnable.safety.optional(),
});

/**
 * A quantity a page could claim without a test to prove it: a numeral (Arabic, full-width, kanji
 * or an English word) followed by a unit of time, share, multiple or count ("三割", "２倍",
 * "二十四時間", "five hours", "3x"). A numeral that names something is allowed ("ISO 27001",
 * "Step 1", "第1条", "36協定", "Excel 2019"). After kanji, 分, 日 and 人 count only as 分間, 日間
 * and 人分, and 件 not at all, so 十分, 一日, 一人 and 一件ずつ stay ordinary words.
 */
const QUANTITY = new RegExp(
  [
    String.raw`[0-9０-９][0-9０-９.,]*\s?(?:%|％|時間|分|日|割|倍|件|人|x\b|(?:hours?|minutes?|days?|times|percent)\b)`,
    String.raw`[〇一二三四五六七八九十百千万数]+(?:時間|分間|日間|割|倍|人分|%|％)`,
    String.raw`\b(?:two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|twenty|thirty|forty|fifty|hundred|thousand|half)[\s-](?:hours?|minutes?|days?|times|percent)\b`,
  ].join('|'),
  'iu',
);

/** Landing-page copy claims no quantity: the store claims only what a test proves. */
const copy = z
  .string()
  .trim()
  .min(1)
  .refine((text) => !QUANTITY.test(text), 'copy with no unmeasured number');
const copyPair = z.strictObject({ ja: copy, en: copy });
const step = z.strictObject({
  text: copyPair,
  safety: z.array(z.enum(SAFETY_PROPERTIES)).readonly(),
});

/**
 * An entry's landing page (the detail page's sections): `catalog/landing/<slug>.md`, JA first, which
 * `tests/store/landing.test.ts` turns into `landing.generated.ts`. Optional for an entry until every
 * entry has its copy.
 */
const landingSchema = z.strictObject({
  headline: copyPair,
  audience: copyPair,
  problem: copyPair,
  steps: z.tuple([step, step, step, step, step]).readonly(),
  outputs: z.array(copyPair).min(1).max(4).readonly(),
  faq: z
    .array(z.strictObject({ q: copyPair, a: copyPair }))
    .min(3)
    .max(5)
    .readonly(),
  limits: z.array(copyPair).min(1).max(4).readonly(),
});

export type Landing = z.infer<typeof landingSchema>;

/** Validate the landing copy, keyed by slug; a `ZodError` here fails whatever loads it. */
export function defineLanding(pages: unknown): Readonly<Record<string, Landing>> {
  return z.record(slug, landingSchema).readonly().parse(pages);
}

export const catalogEntrySchema = z.discriminatedUnion('status', [liveEntry, soonEntry]);

export type CatalogEntry = z.infer<typeof catalogEntrySchema>;
export type LiveEntry = Extract<CatalogEntry, { status: 'live' }>;
type SoonEntry = Extract<CatalogEntry, { status: 'soon' }>;

/**
 * An entry with code to run: a live entry, or a coming-soon one that carries its source and demo.
 * The staging deploy seeds a template for each and R1 verifies them; the store reads only `status`.
 */
export type SourcedEntry =
  LiveEntry | (SoonEntry & { [K in 'kind' | 'source' | 'demo']-?: NonNullable<SoonEntry[K]> });

/** Whether `entry` has code to run ({@link SourcedEntry}). */
export function hasSource(entry: CatalogEntry): entry is SourcedEntry {
  return entry.kind !== undefined && entry.source !== undefined && entry.demo !== undefined;
}

/** Validate one entry; a `ZodError` here fails whatever loads the entry's file. */
export function defineEntry(entry: z.input<typeof catalogEntrySchema>): CatalogEntry {
  return catalogEntrySchema.parse(entry);
}

/**
 * Why a list of valid entries is not a catalog: a slug used twice, a coming-soon entry carrying only
 * part of its source (`kind`, `source` and `demo` go together), an entry whose `kind` and `source`
 * disagree, a list of safety properties or customize controls with a repeat, a seed collection
 * listed twice, or a staged rebuild (`next`) of an app or of the source the entry already has (that
 * it is the entry's own `use-cases/<slug>` is checked with the folders, `tests/store/catalog.test.ts`).
 * Empty when it is one.
 */
export function catalogProblems(entries: readonly CatalogEntry[]): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.slug)) problems.push(`${entry.slug}: the slug is used twice`);
    seen.add(entry.slug);
    if (entry.customize !== undefined && new Set(entry.customize).size !== entry.customize.length) {
      problems.push(`${entry.slug}: a customize control is listed twice`);
    }
    if (!hasSource(entry)) {
      if (entry.kind !== undefined || entry.source !== undefined || entry.demo !== undefined) {
        problems.push(`${entry.slug}: kind, source and demo go together`);
      }
    } else {
      const isApp = entry.source.startsWith('examples/');
      if (isApp !== (entry.kind === 'app')) {
        problems.push(`${entry.slug}: kind '${entry.kind}' does not match source ${entry.source}`);
      }
      const next = entry.status === 'live' ? entry.next : undefined;
      for (const demo of next === undefined ? [entry.demo] : [entry.demo, next.demo]) {
        const collections = demo.seed.map((folder) => folder.collection);
        if (new Set(collections).size !== collections.length) {
          problems.push(`${entry.slug}: a seed collection is listed twice`);
        }
      }
      if (next !== undefined && (entry.kind !== 'agent' || entry.source === next.source)) {
        problems.push(`${entry.slug}: next must be a new source of an agent entry`);
      }
    }
    if (entry.safety !== undefined && new Set(entry.safety).size !== entry.safety.length) {
      problems.push(`${entry.slug}: a safety property is listed twice`);
    }
  }
  return problems;
}

/** Throw when {@link catalogProblems} finds any, so a bad catalog fails the build that loads it. */
export function assertCatalog(entries: readonly CatalogEntry[]): readonly CatalogEntry[] {
  const problems = catalogProblems(entries);
  if (problems.length > 0) throw new Error(`invalid store catalog:\n${problems.join('\n')}`);
  return entries;
}

/** The numbers the store shows, all computed from the entries. */
export interface CatalogCounts {
  readonly total: number;
  readonly live: number;
  readonly soon: number;
  /** Distinct areas that hold at least one entry. */
  readonly areas: number;
  readonly byArea: Readonly<Record<AreaId, { readonly total: number; readonly live: number }>>;
  readonly byWave: Readonly<Record<Wave, number>>;
}

export function countCatalog(entries: readonly CatalogEntry[]): CatalogCounts {
  const byArea = Object.fromEntries(
    AREAS.map(({ id }) => {
      const inArea = entries.filter((entry) => entry.area === id);
      const live = inArea.filter((entry) => entry.status === 'live').length;
      return [id, { total: inArea.length, live }];
    }),
  ) as Record<AreaId, { total: number; live: number }>;
  const byWave = Object.fromEntries(
    WAVES.map((wave) => [wave, entries.filter((entry) => entry.wave === wave).length]),
  ) as Record<Wave, number>;
  const live = entries.filter((entry) => entry.status === 'live').length;
  return {
    total: entries.length,
    live,
    soon: entries.length - live,
    areas: new Set(entries.map((entry) => entry.area)).size,
    byArea,
    byWave,
  };
}

/**
 * One example app's handwritten lines and budget, as the apps benchmark measures them. The
 * values live in `line-counts.generated.ts`, which a repository generator writes; never by hand.
 */
export interface LineCount {
  readonly handwritten: number;
  readonly budget: number;
}

/**
 * What the Under the hood tab shows of a live entry's real source: a bounded excerpt of its demo
 * agent file and the layout of its source folder. The values live in `sources.generated.ts`, which a
 * repository generator reads from the source folders; never by hand.
 */
export interface SourceView {
  /** The demo agent's file, relative to the repository. */
  readonly agentFile: string;
  /** The first lines of that file. */
  readonly excerpt: string;
  /** Whether the file has more lines than the excerpt holds. */
  readonly truncated: boolean;
  /** The source folder's entries, a directory's first entries indented under it. */
  readonly layout: readonly string[];
}

/** What the detail page shows for an entry once its area's defaults are applied. */
export interface EntryView {
  readonly flow: { readonly ja: readonly string[]; readonly en: readonly string[] };
  readonly connects: readonly string[];
  readonly customize: readonly CustomizeControl[];
}

/** `entry`'s flow, connections and Customize controls: its own, else its area's, else all. */
export function entryView(entry: CatalogEntry): EntryView {
  const area = AREAS.find(({ id }) => id === entry.area);
  if (area === undefined) throw new Error(`${entry.slug}: no area ${entry.area}`);
  return {
    flow: entry.flow ?? area.flow,
    connects: entry.connects ?? area.connects,
    customize: entry.customize ?? CUSTOMIZE_CONTROLS,
  };
}

/** The live entry `slug` names, for the home page's featured slot; throws when there is none. */
export function featuredEntry(entries: readonly CatalogEntry[], slug: string): LiveEntry {
  const entry = entries.find((candidate) => candidate.slug === slug);
  if (entry?.status !== 'live')
    throw new Error(`invalid store catalog: featured ${slug} is not live`);
  return entry;
}
