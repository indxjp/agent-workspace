/**
 * The "Install & customize" tab's logic: the controls an entry offers, the preview those choices
 * draw, and the setup "Talk to us about this setup" carries to the enquiry form. Pure, and it reads
 * only the catalog, so `pnpm test` covers it.
 */
import {
  STORE_ENQUIRY_SETUP_MAX_LENGTH,
  StoreEnquirySetupSchema,
} from '@indx-workspace/contracts/email-link';

import {
  CUSTOMIZE_CONTROLS,
  entryView,
  type CatalogEntry,
  type CustomizeControl,
} from '../catalog/index.ts';
import { pick, type Lang } from './lang.ts';

/** What a visitor has chosen: a value for each control the entry offers. */
export type Setup = Partial<Record<CustomizeControl, string>>;

type Pair = { readonly ja: string; readonly en: string };
interface Choice {
  readonly value: string;
  readonly label: Pair;
}

export const APPROVAL_RULES: readonly Choice[] = [
  {
    value: 'always',
    label: { ja: 'すべての書き込みで承認を待つ', en: 'Every write waits for approval' },
  },
  {
    value: 'large',
    label: { ja: '高額なものだけ課長が承認する', en: 'Only large amounts wait for a manager' },
  },
];
export const TONES: readonly Choice[] = [
  { value: 'polite', label: { ja: '丁寧', en: 'Polite' } },
  { value: 'friendly', label: { ja: 'やわらかい', en: 'Friendly' } },
  { value: 'brief', label: { ja: '簡潔', en: 'Brief' } },
];
export const LANGUAGES: readonly Choice[] = [
  { value: 'ja', label: { ja: '日本語', en: 'Japanese' } },
  { value: 'en', label: { ja: '英語', en: 'English' } },
];

const SAMPLE_COMPANY: Pair = { ja: 'サンプル株式会社', en: 'Example Co.' };

/** The longest value the enquiry carries for one control (the platform refuses a longer one). */
export const SETUP_VALUE_MAX = STORE_ENQUIRY_SETUP_MAX_LENGTH;

/** The choices of each control; `connection` is the entry's own systems. */
export function choicesOf(
  entry: CatalogEntry,
  control: CustomizeControl,
): readonly Choice[] | null {
  switch (control) {
    case 'approvalRule':
      return APPROVAL_RULES;
    case 'tone':
      return TONES;
    case 'language':
      return LANGUAGES;
    case 'connection':
      return entryView(entry).connects.map((system) => ({
        value: system,
        label: { ja: system, en: system },
      }));
    case 'companyName':
      return null;
  }
}

/** The first choice of every control the entry offers (the sample company for the name). */
export function defaultSetup(entry: CatalogEntry, lang: Lang): Setup {
  const setup: Setup = {};
  for (const control of entryView(entry).customize) {
    setup[control] = choicesOf(entry, control)?.[0]?.value ?? pick(SAMPLE_COMPANY, lang);
  }
  return setup;
}

const labelOf = (
  choices: readonly Choice[] | null,
  value: string | undefined,
  lang: Lang,
): string => {
  const found = choices?.find((choice) => choice.value === value);
  return found === undefined ? (value ?? '') : pick(found.label, lang);
};

export interface Preview {
  /** A sample reply of the agent, in the chosen tone and language. */
  readonly reply: string;
  readonly facts: readonly {
    readonly control: CustomizeControl;
    readonly name: Pair;
    readonly value: string;
  }[];
}

const REPLIES: Readonly<
  Record<string, Readonly<Record<'ja' | 'en', (company: string) => string>>>
> = {
  polite: {
    ja: (company) =>
      `${company}のエージェントです。内容を確認しました。承認が必要な操作は、確認をお待ちしてから進めます。`,
    en: (company) =>
      `This is the ${company} agent. I have checked it; anything that needs approval waits for a person first.`,
  },
  friendly: {
    ja: (company) =>
      `${company}のエージェントです。見ておきました。書き込む前に、ちゃんと確認をもらいますね。`,
    en: (company) =>
      `Hi, ${company} agent here. I took a look; I will ask before writing anything.`,
  },
  brief: {
    ja: (company) => `${company}：確認済み。書き込みは承認待ち。`,
    en: (company) => `${company}: checked. The write waits for approval.`,
  },
};

const CONTROL_NAMES: Record<CustomizeControl, Pair> = {
  companyName: { ja: '会社名', en: 'Company name' },
  approvalRule: { ja: '承認ルール', en: 'Approval rule' },
  tone: { ja: '口調', en: 'Tone' },
  language: { ja: '返信の言語', en: 'Reply language' },
  connection: { ja: 'つなぐシステム', en: 'System to connect' },
};

/** The name of a control, in both languages. */
export const controlName = (control: CustomizeControl, lang: Lang): string =>
  pick(CONTROL_NAMES[control], lang);

/** What the chosen setup looks like; each control the entry does not offer is left out. */
export function previewOf(entry: CatalogEntry, setup: Setup, lang: Lang): Preview {
  const offered = new Set<CustomizeControl>(entryView(entry).customize);
  const company = setup.companyName?.trim() || pick(SAMPLE_COMPANY, lang);
  const replyLanguage =
    offered.has('language') && setup.language === 'en'
      ? 'en'
      : offered.has('language')
        ? 'ja'
        : lang;
  const reply =
    (REPLIES[setup.tone ?? 'polite'] ?? REPLIES['polite'])?.[replyLanguage]?.(company) ?? '';
  const facts = CUSTOMIZE_CONTROLS.filter((control) => offered.has(control)).map((control) => ({
    control,
    name: CONTROL_NAMES[control],
    value:
      control === 'companyName'
        ? company
        : labelOf(choicesOf(entry, control), setup[control], lang),
  }));
  return { reply, facts };
}

/** The setup as the enquiry carries it: only the controls the entry offers, trimmed and bounded. */
export function setupToEnquiry(entry: CatalogEntry, setup: Setup): Record<string, string> {
  const offered = new Set<CustomizeControl>(entryView(entry).customize);
  const carried: Record<string, string> = {};
  for (const control of CUSTOMIZE_CONTROLS) {
    const value = setup[control]?.trim().slice(0, SETUP_VALUE_MAX);
    if (offered.has(control) && value) carried[control] = value;
  }
  return carried;
}

/** The enquiry form's address for "Talk to us about this setup". */
export function enquiryHref(entry: CatalogEntry, setup: Setup): string {
  const params = new URLSearchParams({ entry: entry.slug });
  const carried = setupToEnquiry(entry, setup);
  if (Object.keys(carried).length > 0) params.set('setup', JSON.stringify(carried));
  return `/contact?${params.toString()}`;
}

/** The setup a `setup` query value holds, kept to the controls `entry` offers; the rest is dropped. */
export function parseSetup(
  entry: CatalogEntry,
  raw: string | undefined,
): Record<string, string> | undefined {
  if (raw === undefined) return undefined;
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const parsed = StoreEnquirySetupSchema.safeParse(json);
  if (!parsed.success) return undefined;
  const offered = new Set<string>(entryView(entry).customize);
  const kept = Object.fromEntries(
    Object.entries(parsed.data).filter(([control, value]) => offered.has(control) && value !== ''),
  );
  return Object.keys(kept).length > 0 ? kept : undefined;
}

/** One `name: value` line for each control `setup` carries, for the enquiry form to show. */
export function setupSummary(
  entry: CatalogEntry,
  setup: Readonly<Record<string, string>>,
  lang: Lang,
): string[] {
  return previewOf(entry, setup, lang)
    .facts.filter(({ control }) => setup[control] !== undefined)
    .map((fact) => `${pick(fact.name, lang)}: ${fact.value}`);
}
