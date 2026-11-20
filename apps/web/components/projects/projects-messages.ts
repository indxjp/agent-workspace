/**
 * The Projects screens' own words in the reader's language (UX-15 in #2086), in the shape of
 * `../resources/admin-messages.ts`: the list (heading, the archived filter, New project, each row's
 * badges and summary line, the empty state, and the create form's buttons), the project form's
 * fields (`./project-form.tsx`, shared by the create form and the detail screen), the detail
 * screen (`./project-detail.tsx`) and its lifecycle section (`./project-archive.tsx`).
 *
 * English is the text the screens printed before, unchanged. A project's name, its default agent's
 * name, file, connector and model connection names, and the server's own messages are shown as
 * they are stored or sent.
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
  readonly form: ProjectFormStrings;
  readonly detail: ProjectDetailStrings;
  readonly lifecycle: ProjectLifecycleStrings;
}

/** The project form's fields (`./project-form.tsx`). */
interface ProjectFormStrings {
  readonly name: string;
  readonly namePlaceholder: string;
  readonly instructions: string;
  readonly instructionsHelp: string;
  readonly visibility: string;
  readonly visibilityOption: Readonly<Record<ProjectResource['visibility'], string>>;
  readonly defaultAgent: string;
  readonly filesAndFolders: string;
  readonly connectors: string;
  readonly noneConfigured: string;
  /** The lead of a failed options load; the error's own text follows, marked English. */
  readonly optionsFailed: string;
  readonly defaultModel: string;
  readonly loadingModels: string;
  /** The lead of a failed model catalog load; the error's own text follows, marked English. */
  readonly modelsFailed: string;
  readonly modelDefault: string;
  readonly noProjectDefault: string;
  readonly projectDefault: string;
  readonly projectDefaultNotSet: string;
  /** A saved model whose connection the catalog no longer carries. */
  readonly staleModel: (model: string, connectionId: string) => string;
  readonly connection: string;
  readonly noModelsAvailable: string;
  readonly dismiss: string;
  readonly discardChanges: string;
}

/** The project detail screen's own words (`./project-detail.tsx`). */
interface ProjectDetailStrings {
  readonly loadingProject: string;
  readonly subtitle: string;
  readonly backToProjects: string;
  readonly archivedOn: (date: string) => string;
  readonly unknownDate: string;
  readonly assignedResources: string;
  readonly noneAssigned: string;
  readonly deletedResource: (id: string) => string;
  readonly saving: string;
  readonly saveChanges: string;
  readonly modelNotSaved: string;
}

/** The archive and restore section and its confirmation (`./project-archive.tsx`). */
interface ProjectLifecycleStrings {
  readonly heading: string;
  readonly archivedHelp: string;
  readonly activeHelp: string;
  readonly archiveProject: string;
  readonly restoreProject: string;
  readonly archiveTitle: (name: string) => string;
  readonly restoreTitle: (name: string) => string;
  readonly restoreBody: string;
  readonly archiving: string;
  readonly restoring: string;
  readonly counting: string;
  readonly countUnavailable: string;
  readonly confirmBody: string;
  readonly impactNone: string;
  readonly impactSessions: (count: number, truncated?: boolean) => string;
  readonly impactRuns: (count: number, truncated?: boolean) => string;
  /** The impact sentence around the two count phrases above. */
  readonly impactSome: (sessions: string, runs: string) => string;
  readonly noLongerAvailable: string;
}

/** `7`, `1` or `200+`: a count the impact summary prints, `+` when the page was cut short. */
const countText = (count: number, truncated?: boolean): string =>
  `${String(count)}${truncated === true ? '+' : ''}`;

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
  form: {
    name: 'Name',
    namePlaceholder: 'e.g. Q3 Contract Review',
    instructions: 'Instructions',
    instructionsHelp: 'Added to every agent’s context when this project is selected.',
    visibility: 'Visibility',
    visibilityOption: {
      private: 'Private — only you',
      workspace: 'Workspace — everyone in this workspace',
      public: 'Public — anyone with a share link',
    },
    defaultAgent: 'Default agent',
    filesAndFolders: 'Files and folders',
    connectors: 'Connectors',
    noneConfigured: 'None configured.',
    optionsFailed: 'Project options could not be loaded:',
    defaultModel: 'Default model',
    loadingModels: 'Loading model connections…',
    modelsFailed: 'Models could not be loaded:',
    modelDefault: 'Default',
    noProjectDefault: 'No project default',
    projectDefault: 'Project default',
    projectDefaultNotSet: 'Project default → not set — falls back to the workspace default.',
    staleModel: (model, connectionId) =>
      `${model} (connection ${connectionId} is no longer available)`,
    connection: 'Connection',
    noModelsAvailable: 'No models available',
    dismiss: 'Dismiss',
    discardChanges: 'Discard the changes you made?',
  },
  detail: {
    loadingProject: 'Loading project…',
    subtitle: 'Project settings',
    backToProjects: 'Back to projects',
    archivedOn: (date) =>
      `Archived on ${date}. Its settings are read-only and no new sessions or runs can start in it. Completed work stays in history.`,
    unknownDate: 'an unknown date',
    assignedResources: 'Assigned resources',
    noneAssigned: 'None assigned.',
    deletedResource: (id) => `Deleted resource (${id})`,
    saving: 'Saving…',
    saveChanges: 'Save changes',
    modelNotSaved:
      'Every other change saved, but the default model did not match the server response. ' +
      'It has been reverted to what is actually saved.',
  },
  lifecycle: {
    heading: 'Project lifecycle',
    archivedHelp:
      'This project is archived. Restoring it lets new sessions and runs start in it again.',
    activeHelp:
      'Archiving keeps every completed session and run readable, and stops new ones from starting in this project.',
    archiveProject: 'Archive project',
    restoreProject: 'Restore project',
    archiveTitle: (name) => `Archive “${name}”?`,
    restoreTitle: (name) => `Restore “${name}”?`,
    restoreBody:
      'New sessions and runs will be able to start in this project again. Nothing that already ran changes.',
    archiving: 'Archiving…',
    restoring: 'Restoring…',
    counting: 'Counting the sessions and runs this affects…',
    countUnavailable:
      'The sessions and runs this affects could not be counted, so this summary is incomplete. Archiving still keeps completed work readable and stops new work from starting.',
    confirmBody:
      'Completed sessions and runs stay readable. No new sessions or runs can start in this project.',
    impactNone:
      'No sessions or runs that you can see are affected. Archiving stops new sessions and runs from starting in this project.',
    impactSessions: (count, truncated) =>
      `${countText(count, truncated)} ${count === 1 && truncated !== true ? 'session' : 'sessions'}`,
    impactRuns: (count, truncated) =>
      `${countText(count, truncated)} ${count === 1 && truncated !== true ? 'run' : 'runs'}`,
    impactSome: (sessions, runs) =>
      `${sessions} and ${runs} that you can see become read-only. Completed work stays in history, and no new sessions or runs can start in this project.`,
    noLongerAvailable: 'This project is no longer available.',
  },
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
  form: {
    name: '名前',
    namePlaceholder: '例: 第3四半期の契約レビュー',
    instructions: '指示文',
    instructionsHelp:
      'このプロジェクトを選ぶと、すべてのエージェントのコンテキストに追加されます。',
    visibility: '公開範囲',
    visibilityOption: {
      private: '非公開 — 自分のみ',
      workspace: 'ワークスペース — このワークスペースの全員',
      public: '公開 — 共有リンクを知っている人全員',
    },
    defaultAgent: '既定のエージェント',
    filesAndFolders: 'ファイルとフォルダー',
    connectors: 'コネクタ',
    noneConfigured: '設定されていません。',
    optionsFailed: 'プロジェクトの選択肢を読み込めませんでした:',
    defaultModel: '既定のモデル',
    loadingModels: 'モデルの接続を読み込み中…',
    modelsFailed: 'モデルを読み込めませんでした:',
    modelDefault: '既定',
    noProjectDefault: 'プロジェクトの既定なし',
    projectDefault: 'プロジェクトの既定',
    projectDefaultNotSet: 'プロジェクトの既定 → 未設定 — ワークスペースの既定を使います。',
    staleModel: (model, connectionId) => `${model} (接続 ${connectionId} はもう使えません)`,
    connection: '接続',
    noModelsAvailable: '使えるモデルがありません',
    dismiss: '閉じる',
    discardChanges: '変更を破棄しますか?',
  },
  detail: {
    loadingProject: 'プロジェクトを読み込み中…',
    subtitle: 'プロジェクトの設定',
    backToProjects: 'プロジェクト一覧に戻る',
    archivedOn: (date) =>
      `${date} にアーカイブされました。設定は読み取り専用で、新しいセッションや実行は開始できません。完了した作業は履歴に残ります。`,
    unknownDate: '不明な日付',
    assignedResources: '割り当てたリソース',
    noneAssigned: '割り当てはありません。',
    deletedResource: (id) => `削除されたリソース (${id})`,
    saving: '保存中…',
    saveChanges: '変更を保存',
    modelNotSaved:
      'ほかの変更は保存されましたが、既定のモデルがサーバーの応答と一致しませんでした。' +
      '実際に保存されている値に戻しました。',
  },
  lifecycle: {
    heading: 'プロジェクトのライフサイクル',
    archivedHelp:
      'このプロジェクトはアーカイブ済みです。復元すると、新しいセッションや実行を再び開始できます。',
    activeHelp:
      'アーカイブしても完了したセッションと実行はすべて読める状態で残り、このプロジェクトでは新しいセッションや実行を開始できなくなります。',
    archiveProject: 'プロジェクトをアーカイブ',
    restoreProject: 'プロジェクトを復元',
    archiveTitle: (name) => `「${name}」をアーカイブしますか?`,
    restoreTitle: (name) => `「${name}」を復元しますか?`,
    restoreBody:
      'このプロジェクトで新しいセッションや実行を再び開始できるようになります。すでに実行されたものは変わりません。',
    archiving: 'アーカイブ中…',
    restoring: '復元中…',
    counting: '影響するセッションと実行を数えています…',
    countUnavailable:
      '影響するセッションと実行を数えられなかったため、この概要は不完全です。アーカイブしても完了した作業は読める状態で残り、新しい作業は開始できなくなります。',
    confirmBody:
      '完了したセッションと実行は読める状態で残ります。このプロジェクトでは新しいセッションや実行を開始できなくなります。',
    impactNone:
      'あなたが見られるセッションや実行に影響はありません。アーカイブすると、このプロジェクトでは新しいセッションや実行を開始できなくなります。',
    impactSessions: (count, truncated) => `セッション ${countText(count, truncated)} 件`,
    impactRuns: (count, truncated) => `実行 ${countText(count, truncated)} 件`,
    impactSome: (sessions, runs) =>
      `あなたが見られる${sessions}と${runs}が読み取り専用になります。完了した作業は履歴に残り、このプロジェクトでは新しいセッションや実行を開始できなくなります。`,
    noLongerAvailable: 'このプロジェクトはもう利用できません。',
  },
};

const STRINGS: Readonly<Record<VersionsLocale, ProjectsStrings>> = {
  en: ENGLISH_PROJECTS_STRINGS,
  ja: JA,
};

export function projectsStrings(locale: VersionsLocale): ProjectsStrings {
  return STRINGS[locale];
}
