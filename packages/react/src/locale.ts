/**
 * The hosted surface's own words, in each language a surface may set (ADR-0108 rung ①
 * `theme.locale`; ADR-0105; S1-18, issue #456). Every visible string the surface itself owns is
 * here: the composer, the parts, the widget launcher and the try page. Pure, with no React, so the
 * widget loader's look can read the launcher label without importing a component.
 *
 * Declared gap (slice 1): run-status labels and the server's failure messages come from the shared
 * run model and the API, and stay English in both locales — except the two visitor limits (issue
 * #622), which a visitor is expected to meet and so are said in the surface's language.
 */
import type { SurfaceLocale } from '@indx-workspace/contracts/surfaces';

/** The surface's own strings in one language. */
export interface SurfaceStrings {
  /** The composer's submit button. */
  readonly send: string;
  /** The message box's accessible name, naming the agent. */
  readonly messageLabel: (agentName: string) => string;
  /** The accessible name of the suggested-prompts group. */
  readonly suggestedPromptsLabel: string;
  /** The collapsed tool trace's summary, counting the agent's tool steps. */
  readonly toolActivity: (count: number) => string;
  /** The widget launcher's accessible name, naming the surface. */
  readonly launcherLabel: (title: string) => string;
  /** The accessible name of the disclaimer note. */
  readonly disclaimerLabel: string;
  /** The try page's heading, naming the surface. */
  readonly tryHeading: (title: string) => string;
  /** The try page's card heading when a model key is missing or rejected. */
  readonly tryKeyHeading: string;
  /** The try page's card heading when the model provider cannot be connected to. */
  readonly tryModelHeading: string;
  /** The link to the provider console where a key is made. */
  readonly tryGetKey: string;
  /** The line before the per-shell commands that set the key. */
  readonly tryKeyThenRun: string;
  /** The line after them, for a missing key only: `aw dev` asks for it when it starts. */
  readonly tryKeyOrPaste: string;
  /** The summary of the collapsed embed snippet. */
  readonly tryEmbed: string;
  /** The copy button's label, and what it says once it has copied. */
  readonly tryCopy: string;
  readonly tryCopied: string;
  /** The caption above the try page's script tag. */
  readonly trySnippetCaption: string;
  /** The try page's note while the agent has no `production` pointer (issue #612). */
  readonly tryNotPromoted: string;
  /** Under `aw dev`: a missing or rejected model key, naming the variables to set (issue #661). */
  readonly tryModelKeyFix: (secrets: readonly string[]) => string;
  /** Under `aw dev`: a model provider that could not be connected to (issue #661). */
  readonly tryModelReachFix: string;
  /** The agent switcher's accessible name. */
  readonly agentSwitcherLabel: string;
  /** The accessible name of the thumbs-up button. */
  readonly feedbackUp: string;
  /** The accessible name of the thumbs-down button. */
  readonly feedbackDown: string;
  /** Shown when a rating could not be sent. */
  readonly feedbackFailed: string;
  /** The label of a tool step's input in the full trace. */
  readonly toolInput: string;
  /** The label of a tool step's output in the full trace. */
  readonly toolOutput: string;
  /** Stands in for a visitor's earlier message, which a replay cannot show. */
  readonly earlierMessage: string;
  /** `429 surface_rate_limited`: too many messages for now, with the server's `Retry-After`. */
  readonly rateLimited: (retryAfterSeconds: number | null) => string;
  /** `429 surface_turn_limit_reached`: this conversation takes no more messages. */
  readonly turnLimitReached: string;
  /** The attach button's accessible name (the `attachments` part). */
  readonly attachFiles: string;
  /** The accessible name of the button that drops one chosen file. */
  readonly removeFile: (name: string) => string;
  /** The widget's sentence for a failure the visitor cannot fix, such as a missing model (#661). */
  readonly unavailable: string;
  /** The session request got no readable answer: the server is down or refused this origin. */
  readonly unreachable: string;
  /** Shown once the agent has handed the conversation to a person (`agent.handoff`). */
  readonly handedOff: string;
}

const EN: SurfaceStrings = {
  send: 'Send',
  messageLabel: (agentName) => `Message ${agentName}`,
  suggestedPromptsLabel: 'Suggested prompts',
  toolActivity: (count) => (count === 1 ? '1 tool step' : `${String(count)} tool steps`),
  launcherLabel: (title) => `Open ${title}`,
  disclaimerLabel: 'Disclaimer',
  tryHeading: (title) => `Try ${title}`,
  tryKeyHeading: 'Add a model key to start chatting',
  tryModelHeading: 'The model provider cannot be reached',
  tryGetKey: 'Get an API key',
  tryKeyThenRun: 'Then set it in the shell you started aw dev from, and restart aw dev:',
  tryKeyOrPaste: 'or restart aw dev and paste it when it asks for a key.',
  tryEmbed: 'Embed',
  tryCopy: 'Copy',
  tryCopied: 'Copied',
  trySnippetCaption: 'Add this tag to a page',
  tryNotPromoted:
    'Not promoted yet: this agent has no production version, so the public page and the widget serve this working draft too.',
  tryModelKeyFix: (secrets) =>
    secrets.length === 1
      ? `Running under aw dev: set ${secrets.join('')} to a valid key and restart aw dev.`
      : `Running under aw dev: set ${secrets.join(', ')} to valid keys and restart aw dev.`,
  tryModelReachFix:
    "Running under aw dev: check the model connection's base URL and that this machine can reach the provider (network, proxy, DNS). The key is not the problem.",
  agentSwitcherLabel: 'Agent',
  feedbackUp: 'Good answer',
  feedbackDown: 'Bad answer',
  feedbackFailed: 'The rating could not be sent.',
  toolInput: 'Input',
  toolOutput: 'Output',
  earlierMessage: '(an earlier message)',
  rateLimited: (seconds) =>
    seconds === null
      ? 'Too many messages. Try again shortly.'
      : `Too many messages. Try again in ${String(seconds)} s.`,
  turnLimitReached: 'This conversation has reached its message limit.',
  attachFiles: 'Attach files',
  removeFile: (name) => `Remove ${name}`,
  unavailable: 'The assistant is not available right now. Please try again later.',
  unreachable: 'The assistant could not be reached. Please try again later.',
  handedOff: 'This conversation has been handed to a person.',
};

const JA: SurfaceStrings = {
  send: '送信',
  messageLabel: (agentName) => `${agentName}へのメッセージ`,
  suggestedPromptsLabel: 'おすすめの質問',
  toolActivity: (count) => `ツールの実行 ${String(count)} 件`,
  launcherLabel: (title) => `${title}を開く`,
  disclaimerLabel: '注意事項',
  tryHeading: (title) => `${title}を試す`,
  tryKeyHeading: 'モデルのキーを追加するとチャットを始められます',
  tryModelHeading: 'モデルのプロバイダーに接続できません',
  tryGetKey: 'API キーを取得する',
  tryKeyThenRun: '次に、aw dev を起動したシェルで設定し、aw dev を再起動してください。',
  tryKeyOrPaste: 'または、aw dev を再起動し、キーを求められたら貼り付けてください。',
  tryEmbed: '埋め込み',
  tryCopy: 'コピー',
  tryCopied: 'コピーしました',
  trySnippetCaption: 'ページに追加するタグ',
  tryNotPromoted:
    'まだ本番に昇格していません。このエージェントには本番バージョンがないため、公開ページとウィジェットもこの作業中のドラフトを表示します。',
  tryModelKeyFix: (secrets) =>
    `aw dev で実行中です。${secrets.join('、')} に有効なキーを設定し、aw dev を再起動してください。`,
  tryModelReachFix:
    'aw dev で実行中です。モデル接続のベース URL と、このマシンからプロバイダーに接続できるか（ネットワーク、プロキシ、DNS）を確認してください。キーの問題ではありません。',
  agentSwitcherLabel: 'エージェント',
  feedbackUp: '良い回答',
  feedbackDown: '良くない回答',
  feedbackFailed: '評価を送信できませんでした。',
  toolInput: '入力',
  toolOutput: '出力',
  earlierMessage: '（以前のメッセージ）',
  rateLimited: (seconds) =>
    seconds === null
      ? 'メッセージが多すぎます。しばらくしてからもう一度お試しください。'
      : `メッセージが多すぎます。${String(seconds)} 秒後にもう一度お試しください。`,
  turnLimitReached: 'この会話はメッセージの上限に達しました。',
  attachFiles: 'ファイルを添付',
  removeFile: (name) => `${name}を削除`,
  unavailable:
    'ただいまアシスタントをご利用いただけません。しばらくしてからもう一度お試しください。',
  unreachable: 'アシスタントに接続できませんでした。しばらくしてからもう一度お試しください。',
  handedOff: '担当者におつなぎします。',
};

const STRINGS: Readonly<Record<SurfaceLocale, SurfaceStrings>> = { en: EN, ja: JA };

/** The surface's strings in `locale`. */
export function surfaceStrings(locale: SurfaceLocale): SurfaceStrings {
  return STRINGS[locale];
}

/**
 * Issue #661: the fix line `aw dev` shows for a model-setup failure, or `null` for a code with
 * none. `secrets` are the `credential.secret` names of the project's model connections;
 * `ANTHROPIC_API_KEY` is the one `aw dev` makes the `default` connection from.
 */
export function awDevModelFix(
  code: string,
  strings: SurfaceStrings,
  secrets: readonly string[] = ['ANTHROPIC_API_KEY'],
): string | null {
  switch (code) {
    case 'model_connection_unresolved':
    case 'model_credential_rejected':
      return strings.tryModelKeyFix(secrets);
    case 'model_connection_failed':
      return strings.tryModelReachFix;
    default:
      return null;
  }
}
