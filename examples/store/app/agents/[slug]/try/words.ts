/** The chat's fixed words in both languages, and the strings the SDK chat parts take. */
import { pick, type Lang } from '../../../lang';

const bi = (ja: string, en: string) => ({ ja, en });

export const WORDS = {
  chatLabel: bi('デモのチャット', 'Demo chat'),
  promptsLabel: bi('試せる質問', 'Suggested prompts'),
  messageLabel: bi('メッセージ', 'Message'),
  send: bi('送信', 'Send'),
  checking: bi('サインイン状態を確認しています…', 'Checking your sign-in…'),
  approvalProblem: bi(
    '承認を送れませんでした。もう一度お試しください。',
    'The decision could not be sent. Please try again.',
  ),
  problems: {
    start: bi(
      'メッセージを送れませんでした。もう一度お試しください。',
      'The message could not be sent. Please try again.',
    ),
    stream: bi(
      '実行の経過を読み込めませんでした。もう一度お試しください。',
      'The run could not be followed. Please try again.',
    ),
    approval: bi('承認を送れませんでした。', 'The decision could not be sent.'),
    agent: bi(
      'デモのエージェントが見つかりません。',
      'The demo agent could not be found in your workspace.',
    ),
  },
  fallbackHeading: bi('代わりに録画をご覧ください', 'Here is the recording instead'),
  toolStrings: (lang: Lang) => ({
    toolActivity: (count: number) =>
      lang === 'ja' ? `ツールの実行（${String(count)}）` : `Tool activity (${String(count)})`,
    toolInput: pick(bi('入力', 'Input'), lang),
    toolOutput: pick(bi('出力', 'Output'), lang),
  }),
  approvalStrings: (lang: Lang) => ({
    approvalNeeded: (toolName: string) =>
      lang === 'ja'
        ? `エージェントが ${toolName} の使用について承認を待っています`
        : `The agent is waiting for your approval to use ${toolName}`,
    approve: pick(bi('承認', 'Approve'), lang),
    reject: pick(bi('却下', 'Reject'), lang),
    approvalComment: pick(bi('コメント（任意）', 'Comment (optional)'), lang),
    approvalFullCall: pick(bi('呼び出しの全文', 'Full call'), lang),
  }),
};
