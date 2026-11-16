/**
 * The Schedules tab's own words in English and Japanese (UX-18 in #2086), in the shape of
 * `versions-messages.ts`, whose locale the agent page already chooses.
 */
import type { SchedulePresetId, ScheduleProblem } from './schedules-model';
import type { VersionsLocale } from './versions-messages';

export interface SchedulesStrings {
  readonly heading: string;
  readonly intro: string;
  readonly loading: string;
  readonly loadFailed: string;
  readonly notAllowed: string;
  readonly empty: string;
  readonly listLabel: string;
  readonly columnRepeats: string;
  readonly columnNext: string;
  readonly on: string;
  readonly off: string;
  readonly never: string;
  readonly paused: string;
  readonly pauseButton: string;
  readonly resumeButton: string;
  readonly pause: (name: string) => string;
  readonly resume: (name: string) => string;
  readonly remove: (name: string) => string;
  readonly confirmRemove: (name: string) => string;
  readonly confirmYes: string;
  readonly confirmNo: string;
  readonly working: string;
  readonly addHeading: string;
  readonly nameLabel: string;
  readonly nameHint: string;
  readonly promptLabel: string;
  readonly promptHint: string;
  readonly repeatLabel: string;
  readonly presets: Readonly<Record<SchedulePresetId, string>>;
  readonly cronLabel: string;
  readonly cronHint: string;
  readonly timezoneLabel: string;
  readonly timezoneHint: string;
  readonly nextPreview: (when: string) => string;
  readonly problems: Readonly<Record<ScheduleProblem, string>>;
  readonly add: string;
  readonly adding: string;
  readonly added: (name: string) => string;
  readonly changeTimeButton: string;
  readonly changeTime: (name: string) => string;
  readonly saveTime: string;
  readonly cancel: string;
  readonly nextAfterChange: (when: string) => string;
  readonly timeChanged: (name: string) => string;
  readonly refusals: Readonly<Record<string, string>>;
  readonly failed: string;
}

const EN: SchedulesStrings = {
  heading: 'Schedules',
  intro: 'A schedule starts a run of this agent at set times, with the same prompt each time.',
  loading: 'Loading schedules…',
  loadFailed: 'The schedules could not be loaded. Reload the page to try again.',
  notAllowed: 'Only an Owner, an Admin or a Builder can see and change schedules.',
  empty: 'This agent has no schedules yet.',
  listLabel: 'Schedules of this agent',
  columnRepeats: 'Repeats',
  columnNext: 'Next run',
  on: 'On',
  off: 'Paused',
  never: 'Never',
  paused: '— (paused)',
  pauseButton: 'Pause',
  resumeButton: 'Resume',
  pause: (name) => `Pause ${name}`,
  resume: (name) => `Resume ${name}`,
  remove: (name) => `Delete ${name}`,
  confirmRemove: (name) => `Delete the schedule ${name}? Runs it already started are kept.`,
  confirmYes: 'Delete',
  confirmNo: 'Keep',
  working: 'Saving…',
  addHeading: 'Add a schedule',
  nameLabel: 'Name',
  nameHint: 'Lower-case letters, numbers and dashes, for example daily-report.',
  promptLabel: 'Prompt',
  promptHint: 'What the agent is asked each time the schedule runs.',
  repeatLabel: 'Repeats',
  presets: {
    hourly: 'Every hour, on the hour',
    daily: 'Every day at 09:00',
    weekdays: 'Every weekday (Mon–Fri) at 09:00',
    weekly: 'Every Monday at 09:00',
    custom: 'Custom (cron expression)',
  },
  cronLabel: 'Cron expression',
  cronHint: 'Five fields: minute hour day-of-month month day-of-week, for example 30 8 * * 1-5.',
  timezoneLabel: 'Time zone',
  timezoneHint: 'The times above are read in this zone, for example Asia/Tokyo.',
  nextPreview: (when) => `First run: ${when}`,
  problems: {
    fields: 'A cron expression has exactly five fields.',
    timezone: 'Enter a time zone, for example Asia/Tokyo.',
    invalid: 'This cron expression or time zone is not valid.',
    never: 'This cron expression never matches a date.',
  },
  add: 'Add schedule',
  adding: 'Adding…',
  added: (name) => `Schedule ${name} added.`,
  changeTimeButton: 'Change time',
  changeTime: (name) => `Change when ${name} runs`,
  saveTime: 'Save time',
  cancel: 'Cancel',
  nextAfterChange: (when) => `Next run after this change: ${when}`,
  timeChanged: (name) => `Schedule ${name} now runs at the new time.`,
  refusals: {
    trigger_name_taken:
      'A trigger with this name already exists in this workspace. Pick another name.',
    trigger_agent_not_runnable: 'You cannot run this agent, so you cannot schedule it.',
    trigger_not_found: 'This schedule no longer exists. Reload the page.',
    forbidden: 'Your role cannot change this schedule.',
    feature_disabled: 'Schedules are switched off for this workspace.',
    invalid_field:
      'The server did not accept this schedule. Check the name, the prompt (a schedule cannot use {{body}}), the cron expression and the time zone.',
  },
  failed: 'That did not work. Check your connection and try again.',
};

const JA: SchedulesStrings = {
  heading: 'スケジュール',
  intro: 'スケジュールは、決まった時刻に同じプロンプトでこのエージェントのランを開始します。',
  loading: 'スケジュールを読み込んでいます…',
  loadFailed: 'スケジュールを読み込めませんでした。ページを再読み込みしてください。',
  notAllowed: 'スケジュールを表示・変更できるのはオーナー・管理者・ビルダーだけです。',
  empty: 'このエージェントにはまだスケジュールがありません。',
  listLabel: 'このエージェントのスケジュール',
  columnRepeats: '繰り返し',
  columnNext: '次のラン',
  on: 'オン',
  off: '一時停止中',
  never: 'なし',
  paused: '—（一時停止中）',
  pauseButton: '一時停止',
  resumeButton: '再開',
  pause: (name) => `${name} を一時停止`,
  resume: (name) => `${name} を再開`,
  remove: (name) => `${name} を削除`,
  confirmRemove: (name) => `スケジュール ${name} を削除しますか？開始済みのランは残ります。`,
  confirmYes: '削除',
  confirmNo: '残す',
  working: '保存しています…',
  addHeading: 'スケジュールを追加',
  nameLabel: '名前',
  nameHint: '小文字・数字・ダッシュ。例：daily-report',
  promptLabel: 'プロンプト',
  promptHint: 'スケジュールが動くたびにエージェントに渡す内容です。',
  repeatLabel: '繰り返し',
  presets: {
    hourly: '毎時0分',
    daily: '毎日 09:00',
    weekdays: '平日（月〜金）09:00',
    weekly: '毎週月曜 09:00',
    custom: 'カスタム（cron 式）',
  },
  cronLabel: 'cron 式',
  cronHint: '5つの項目：分 時 日 月 曜日。例：30 8 * * 1-5',
  timezoneLabel: 'タイムゾーン',
  timezoneHint: '上の時刻はこのタイムゾーンで読みます。例：Asia/Tokyo',
  nextPreview: (when) => `最初のラン：${when}`,
  problems: {
    fields: 'cron 式はちょうど5つの項目です。',
    timezone: 'タイムゾーンを入力してください。例：Asia/Tokyo',
    invalid: 'この cron 式またはタイムゾーンは正しくありません。',
    never: 'この cron 式に一致する日付がありません。',
  },
  add: 'スケジュールを追加',
  adding: '追加しています…',
  added: (name) => `スケジュール ${name} を追加しました。`,
  changeTimeButton: '時刻を変更',
  changeTime: (name) => `${name} の実行時刻を変更`,
  saveTime: '時刻を保存',
  cancel: 'キャンセル',
  nextAfterChange: (when) => `変更後の次のラン：${when}`,
  timeChanged: (name) => `スケジュール ${name} は新しい時刻で動きます。`,
  refusals: {
    trigger_name_taken:
      'この名前のトリガーはこのワークスペースにすでにあります。別の名前にしてください。',
    trigger_agent_not_runnable:
      'このエージェントを実行できないため、スケジュールも設定できません。',
    trigger_not_found: 'このスケジュールはもうありません。ページを再読み込みしてください。',
    forbidden: 'あなたのロールではこのスケジュールを変更できません。',
    feature_disabled: 'このワークスペースではスケジュールがオフになっています。',
    invalid_field:
      'サーバーがこのスケジュールを受け付けませんでした。名前・プロンプト（スケジュールでは {{body}} は使えません）・cron 式・タイムゾーンを確認してください。',
  },
  failed: 'うまくいきませんでした。接続を確認して、もう一度お試しください。',
};

const STRINGS: Readonly<Record<VersionsLocale, SchedulesStrings>> = { en: EN, ja: JA };

export function schedulesStrings(locale: VersionsLocale): SchedulesStrings {
  return STRINGS[locale];
}

/** The sentence for a refusal code; a code this tab has no words for gets the generic one. */
export function scheduleRefusalText(code: string | null, strings: SchedulesStrings): string {
  return (code === null ? undefined : strings.refusals[code]) ?? strings.failed;
}
