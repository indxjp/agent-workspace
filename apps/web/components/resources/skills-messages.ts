/**
 * The Skills list screen's own words in the reader's language (UX-15 in #2086), in the shape of
 * `./admin-messages.ts`.
 *
 * English is the text the screen printed before, unchanged. A skill's name is shown as it is
 * stored, and the name field's `skill-name` placeholder is the slug format itself, so it stays as
 * it is in both languages. A skill's detail screen (`/skills/:name`) is still English.
 */
import type { VersionsLocale } from '../agents/versions-messages';

export interface SkillsStrings {
  readonly title: string;
  readonly intro: string;
  readonly loading: string;
  readonly descriptionPlaceholder: string;
  readonly instructionsPlaceholder: string;
  readonly createSkill: string;
  readonly empty: string;
  readonly enabled: string;
  readonly disabled: string;
}

const EN: SkillsStrings = {
  title: 'Skills',
  intro: 'Create and manage private workspace skills.',
  loading: 'Loading skills…',
  descriptionPlaceholder: 'What this skill does',
  instructionsPlaceholder: 'Instructions',
  createSkill: 'Create skill',
  empty: 'No skills yet.',
  enabled: 'Enabled',
  disabled: 'Disabled',
};

const JA: SkillsStrings = {
  title: 'スキル',
  intro: 'このワークスペース専用のスキルを作成・管理します。',
  loading: 'スキルを読み込み中…',
  descriptionPlaceholder: 'このスキルでできること',
  instructionsPlaceholder: '指示文',
  createSkill: 'スキルを作成',
  empty: 'スキルはまだありません。',
  enabled: '有効',
  disabled: '無効',
};

const STRINGS: Readonly<Record<VersionsLocale, SkillsStrings>> = { en: EN, ja: JA };

export function skillsStrings(locale: VersionsLocale): SkillsStrings {
  return STRINGS[locale];
}
