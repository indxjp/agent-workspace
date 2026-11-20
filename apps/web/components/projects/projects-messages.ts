/**
 * The Projects list screen's own words in the reader's language (UX-15 in #2086), in the shape of
 * `../resources/admin-messages.ts`: the heading, the archived filter, New project, each row's
 * badges and summary line, the empty state, and the create form's buttons.
 *
 * English is the text the screen printed before, unchanged. A project's name and its default
 * agent's name are shown as they are stored. The create form's fields (`./project-form.tsx`) are
 * shared with a project's detail screen and are still English.
 */
import type { ProjectResource } from '../../contracts/projects';
import type { VersionsLocale } from '../agents/versions-messages';

import type { ProjectFilter } from './model';

export interface ProjectsStrings {
  readonly title: string;
  readonly intro: string;
  readonly show: string;
  readonly filter: Readonly<Record<ProjectFilter, string>>;
  readonly newProject: string;
  readonly loading: string;
  readonly visibility: Readonly<Record<ProjectResource['visibility'], string>>;
  readonly archived: string;
  readonly noDefaultAgent: string;
  readonly defaultAgent: (name: string) => string;
  readonly deletedAgent: string;
  readonly files: (count: number) => string;
  readonly connectors: (count: number) => string;
  readonly projectInstructions: string;
  readonly noExtraInstructions: string;
  readonly emptyArchived: string;
  readonly emptyActive: string;
  readonly cancel: string;
  readonly creating: string;
  readonly createProject: string;
}

export const ENGLISH_PROJECTS_STRINGS: ProjectsStrings = {
  title: 'Projects',
  intro: 'Reusable instructions, files, connectors and a default agent.',
  show: 'Show',
  filter: { active: 'Active', archived: 'Archived', all: 'All' },
  newProject: 'New project',
  loading: 'Loading…',
  visibility: { private: 'Private', workspace: 'Workspace', public: 'Public' },
  archived: 'Archived',
  noDefaultAgent: 'No default agent',
  defaultAgent: (name) => `Default agent: ${name}`,
  deletedAgent: 'deleted agent',
  files: (count) => `${String(count)} files`,
  connectors: (count) => `${String(count)} connectors`,
  projectInstructions: 'Project instructions',
  noExtraInstructions: 'No extra instructions',
  emptyArchived: 'No archived projects.',
  emptyActive: 'No projects yet. Create one above.',
  cancel: 'Cancel',
  creating: 'Creating…',
  createProject: 'Create project',
};

const JA: ProjectsStrings = {
  title: 'プロジェクト',
  intro: '再利用できる指示文・ファイル・コネクタと既定のエージェントをまとめます。',
  show: '表示',
  filter: { active: '有効', archived: 'アーカイブ済み', all: 'すべて' },
  newProject: '新しいプロジェクト',
  loading: '読み込み中…',
  visibility: { private: '非公開', workspace: 'ワークスペース', public: '公開' },
  archived: 'アーカイブ済み',
  noDefaultAgent: '既定のエージェントなし',
  defaultAgent: (name) => `既定のエージェント: ${name}`,
  deletedAgent: '削除されたエージェント',
  files: (count) => `ファイル ${String(count)} 件`,
  connectors: (count) => `コネクタ ${String(count)} 件`,
  projectInstructions: 'プロジェクトの指示文あり',
  noExtraInstructions: '追加の指示文なし',
  emptyArchived: 'アーカイブ済みのプロジェクトはありません。',
  emptyActive: 'プロジェクトはまだありません。上のボタンから作成してください。',
  cancel: 'キャンセル',
  creating: '作成中…',
  createProject: 'プロジェクトを作成',
};

const STRINGS: Readonly<Record<VersionsLocale, ProjectsStrings>> = {
  en: ENGLISH_PROJECTS_STRINGS,
  ja: JA,
};

export function projectsStrings(locale: VersionsLocale): ProjectsStrings {
  return STRINGS[locale];
}
