/**
 * The Skills list and skill detail (`/skills/:name`) screens' own words in the reader's language
 * (UX-15 in #2086), in the shape of `./admin-messages.ts`.
 *
 * English is the text the screens printed before, unchanged. A skill's name, its description,
 * instructions, file paths and revision numbers are shown as they are stored, and the name field's
 * `skill-name` placeholder is the slug format itself, so it stays as it is in both languages. The
 * `aw skills publish` command stays in its `<code>` element in both languages.
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
  readonly detail: SkillDetailStrings;
}

/** A skill's detail screen (`/skills/:name`). */
export interface SkillDetailStrings {
  readonly intro: string;
  readonly back: string;
  readonly loading: string;
  readonly description: string;
  readonly instructions: string;
  readonly enabled: string;
  readonly supportingFiles: string;
  /** The revisions line; the publish command between the two halves stays in a `<code>` element. */
  readonly revisionsBefore: string;
  readonly revisionsAfter: string;
  /** Printed when a list the server sent is missing. */
  readonly none: string;
  readonly saveChanges: string;
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
  detail: {
    intro: 'Skill manifest and installed files.',
    back: 'Back',
    loading: 'Loading skill…',
    description: 'Description',
    instructions: 'Instructions',
    enabled: 'Enabled',
    supportingFiles: 'Supporting files:',
    revisionsBefore: 'Published revisions (newest first; publish with ',
    revisionsAfter: '):',
    none: 'none',
    saveChanges: 'Save changes',
  },
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
  detail: {
    intro: 'スキルのマニフェストとインストール済みのファイル。',
    back: 'スキル一覧に戻る',
    loading: 'スキルを読み込み中…',
    description: '説明',
    instructions: '指示文',
    enabled: '有効',
    supportingFiles: '補助ファイル:',
    revisionsBefore: '公開済みのリビジョン (新しい順。公開するには ',
    revisionsAfter: ' を使います):',
    none: 'なし',
    saveChanges: '変更を保存',
  },
};

const STRINGS: Readonly<Record<VersionsLocale, SkillsStrings>> = { en: EN, ja: JA };

export function skillsStrings(locale: VersionsLocale): SkillsStrings {
  return STRINGS[locale];
}
