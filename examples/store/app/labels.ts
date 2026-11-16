/** The words for what a catalog entry says about itself: its safety tags and the features it uses. */
import { AREAS, type CatalogEntry, type LiveEntry } from '../catalog/index.ts';
import { pick, type Lang } from './lang.ts';

type Pair = { readonly ja: string; readonly en: string };

/**
 * The safety features a card may claim, each with the evidence that it holds today (spec §04, "Safe
 * to use"). The audit log and the no-internet sandbox are planned (P5), so no tag exists for them;
 * `structured`, `trigger` and `files` are features an agent uses, not safety claims.
 */
const SAFETY_TAGS = {
  person: {
    ja: '頼んだ人の権限の範囲でだけ動く',
    en: 'Acts only within the asking person’s access',
  },
  approval: { ja: '書き込みは承認を待てる', en: 'Writes can wait for approval' },
} as const satisfies Record<string, Pair>;

const FEATURES: Readonly<Record<LiveEntry['safety'][number], Pair>> = {
  person: { ja: '本人の権限で実行', en: 'Runs as the person' },
  approval: { ja: '書き込みの承認', en: 'Approval for writes' },
  structured: { ja: '構造化された出力', en: 'Structured output' },
  trigger: { ja: 'イベントで起動', en: 'Starts from an event' },
  files: { ja: 'ファイルの読み取り', en: 'Reads files' },
};

/** The safety tags `entry` shows: only the ones that hold today. */
export function safetyTags(entry: CatalogEntry, lang: Lang): string[] {
  if (entry.status !== 'live') return [];
  return entry.safety.flatMap((property) =>
    property in SAFETY_TAGS ? [pick(SAFETY_TAGS[property as keyof typeof SAFETY_TAGS], lang)] : [],
  );
}

/** Every feature `entry` uses, for the Under the hood tab. */
export function featuresUsed(entry: LiveEntry, lang: Lang): string[] {
  return entry.safety.map((property) => pick(FEATURES[property], lang));
}

export function areaName(entry: CatalogEntry, lang: Lang): string {
  const area = AREAS.find(({ id }) => id === entry.area);
  return area === undefined ? entry.area : pick(area.name, lang);
}
