/**
 * Why a run cannot start or did not start, in the reader's language (UX-15 in #2086).
 *
 * The server sends a refusal as a stable `code` and an English sentence that names what to fix
 * (`apps/web/server/compose/run-start-refusal.ts`). English readers see that sentence as it came.
 * A Japanese reader sees the sentence below for the code, so the line under the composer and the
 * failure notice in a run are not half English. A code not listed here is shown as it came.
 *
 * Covered: every run-start code a person can meet in the console — the run-target line under the
 * composer (`run-target-description.ts`), and the failure notice of a run that was refused before
 * it was queued or as it was launched. The Japanese is the same advice without the names the
 * English carries (a connection's name, a model id, a folder); the code is still shown beside a
 * failure, and the English sentence is the source of truth. One code is left in English on
 * purpose ({@link RUN_REFUSAL_LEFT_IN_ENGLISH}).
 */
import type { RunStartProblemCode } from '@indx-workspace/contracts/runs';
import {
  SURFACE_ATTACHMENT_MAX_BYTES,
  SURFACE_ATTACHMENTS_MAX_FILES,
  SURFACE_ATTACHMENTS_MAX_TOTAL_BYTES,
} from '@indx-workspace/contracts/surfaces';
import type { VersionsLocale } from '../agents/versions-messages';

const MIB = 1024 * 1024;
const WATCH_OR_RETRY = '録画をご覧いただくか、明日もう一度お試しください。';

export const RUN_REFUSAL_JA = {
  agent_runtime_profile_missing:
    'このエージェントには使えるランタイムプロファイルがありません。既存のランタイムプロファイルをエージェントに設定するか、セットアップウィザードを完了してください。',
  model_connection_unresolved:
    '使えるモデルが決まっていません。エージェントでモデルを選ぶか、モデル画面でワークスペースの既定モデルを設定してください。',
  model_connection_failed:
    'モデルのプロバイダーに接続できませんでした。接続のベース URL とネットワークを確認してください。',
  model_unavailable:
    'この接続では選ばれたモデルを使えません。接続が提供するモデルを選んでください。',
  model_credential_rejected:
    'プロバイダーが API キーを拒否しました。この接続の API キーを入れ替えてください。',
  network_policy_unenforceable:
    'このエージェントには「無制限のネットワークを使う」の許可がないため、ネットワークを制限して実行する必要がありますが、このランタイムではその制限をかけられません。エージェントに「無制限のネットワークを使う」を許可するか、リモートのコネクタを外してください。',
  run_deadline_exceeds_host:
    'この実行は、このホストで 1 回の実行に使える時間に収まらないため、開始しませんでした。ランタイムプロファイルのタイムアウトが長すぎる場合は短くし、準備に時間がかかった場合はもう一度お試しください。',
  runtime_connection_missing:
    'このランタイムプロファイルのドライバーには、プロバイダーのキーを持つランタイム接続が必要ですが、使える接続がありません。このドライバー用のランタイム接続を、このワークスペースからプロファイルに設定してください。',
  runtime_connection_credential_unavailable:
    'ランタイム接続に、使えるプロバイダーの認証情報がありません。接続の認証情報を入れ替えてください。',
  runtime_not_verified:
    'このランタイムには、「ランタイムをテスト」に合格した有効な記録がありません。一度も合格していないか、合格の期限（24 時間）が切れたか、ランタイムのイメージが変わって再確認に失敗しました。ランタイム画面で「ランタイムをテスト」を実行してから、もう一度お試しください。',
  run_attachments_unreadable:
    'この実行にはファイルが添付されていますが、実行するエージェントに「ファイルの読み取り」の権限がありません。権限を許可するか、添付なしで実行してください。',
  run_attachments_too_large: `添付ファイルが上限を超えています。添付できるのは ${String(SURFACE_ATTACHMENTS_MAX_FILES)} ファイルまで、1 ファイル ${String(SURFACE_ATTACHMENT_MAX_BYTES / MIB)} MiB まで、合計 ${String(SURFACE_ATTACHMENTS_MAX_TOTAL_BYTES / MIB)} MiB までです（このセッションで先にアップロードしたファイルも含みます）。小さいファイルにするか、数を減らしてください。`,
  run_attachments_unsupported_runtime:
    'この実行にはファイルが添付されていますが、エージェントのランタイムプロファイルが使うローカルドライバーには、セッションのファイルを渡せません。別のランタイムを使うか、添付なしで実行してください。',
  run_attachments_untranscribable:
    'この実行には音声ファイルが添付されていますが、モデルの接続のプロバイダーでは文字起こしができません。OpenAI の接続で実行するか、文字起こしのテキストを添付してください。',
  run_files_too_large:
    'この実行に渡すファイルの合計サイズが上限を超えています。付与するファイルを減らすか、小さいファイルにしてください。',
  run_storage_grant_unavailable:
    'エージェントに付与されたストレージのフォルダーを使えません。ストレージ接続を直すか、エージェントをデプロイし直してください。',
  run_file_scope_not_granted:
    'ファイルの範囲に、この実行では絞り込めないパスが含まれています。範囲は、エージェントに付与されたファイルの中でしか絞り込めません。',
  policy_cannot_widen:
    'この実行は、環境のポリシーの上限が許す範囲を超えています。上限が認めるエンジンとモデルを選ぶか、プロジェクトの関連付けを外すか、管理者に上限の引き上げを依頼してください。',
  daily_cost_cap_reached:
    'ワークスペースの本日のモデルのコストが上限に達したか、価格のわからない使用があるためコストを上限と比べられません。上限がリセットされると、再び実行できます。',
  daily_cost_unavailable:
    'ワークスペースの本日のモデルのコストを確認できなかったため、実行を開始しませんでした。しばらくしてから、もう一度お試しください。',
  agent_archived:
    'このエージェントはアーカイブされているため、実行できません。実行するには、先に復元してください。',
  builder_model_unavailable:
    'Builder が使うモデルを提供するモデルの接続が、このワークスペースにありません。そのモデルを提供する接続を追加するか、直してください。',
  demo_person_runs_reached: `今日のデモの実行回数をすべて使いました。${WATCH_OR_RETRY}`,
  demo_client_runs_reached: `このネットワークからは、今日すでに多くのデモが実行されています。${WATCH_OR_RETRY}`,
  demo_site_cost_reached: `デモは今日の上限に達しました。${WATCH_OR_RETRY}`,
  demo_caps_unconfigured: 'ライブデモは現在ご利用いただけません。録画をご覧ください。',
  demo_expired: 'このデモは終了しました。録画をご覧ください。',
} as const satisfies Partial<Record<RunStartProblemCode, string>>;

/**
 * The run-start code with no Japanese here, and why: `run_subject_forbidden` is answered only to a
 * signed-in person who sends `subject`, which the console never does (only an API key may).
 */
export const RUN_REFUSAL_LEFT_IN_ENGLISH = [
  'run_subject_forbidden',
] as const satisfies readonly RunStartProblemCode[];

function isCovered(code: string): code is keyof typeof RUN_REFUSAL_JA {
  return Object.hasOwn(RUN_REFUSAL_JA, code);
}

/** The refusal's sentence for `locale`: the server's own in English, ours in Japanese when known. */
export function runRefusalReason(
  code: string | null,
  serverText: string,
  locale: VersionsLocale,
): string {
  if (locale === 'en' || code === null || !isCovered(code)) return serverText;
  return RUN_REFUSAL_JA[code];
}
