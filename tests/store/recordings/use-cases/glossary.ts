/**
 * The glossary entry's recorder: the draft guide the prompt names and the company glossary read,
 * one verdict per glossary row (TERM-01 to TERM-08) with every place the draft uses a term, and the
 * report written behind the approval. A `replace` row used wrongly is NG; a `judge by context` row
 * is caution, its note's exception weighed in `Why`. The demo seeds the Japanese data only, so the
 * English report quotes the Japanese draft.
 */
import glossaryAgent from '../../../../use-cases/glossary/agents/glossary.ts';
import type { Lang, Recorder } from '../types.ts';
import { playUseCase } from '../use-case-desk.ts';
import { carries, reporting, table, type Bilingual } from '../use-case-script.ts';

const DOCUMENT = 'シギノ・リンク_かんたん操作ガイド_草稿';
const GLOSSARY = 'glossary/standards/用語集_2026-10版.csv';

const ROWS: Readonly<Record<Lang, readonly (readonly string[])[]>> = {
  ja: [
    [
      'ログイン',
      '「2. ログオンする」（見出し）、2.「ログオンします」、3.「ログオンすると」',
      'NG',
      '使わない語「ログオン」を3か所で使っている〔TERM-01〕',
      '「2. ログインする」／「…パスワードを入力してログインします。」／「ログインするとホーム画面が開き…」',
    ],
    ['管理者', '2.「管理者」、4.「管理者」', 'OK', '推奨語だけを使っている〔TERM-02〕', ''],
    [
      'ダッシュボード',
      '「3. ホーム画面を見る」（見出し）、3.「ホーム画面が開き」',
      'NG',
      '使わない語「ホーム画面」を2か所で使っている〔TERM-03〕',
      '「3. ダッシュボードを見る」／「ログオンするとダッシュボードが開き…」',
    ],
    ['センサー', '3.「センサー」、4.「センサー」', 'OK', '推奨語だけを使っている〔TERM-04〕', ''],
    [
      'アラート',
      '「4. 警報を設定する」（見出し）、4.「警報がメールで届きます」',
      '要注意',
      'メールで届く通知のことで、設備に付いた警報器ではない〔TERM-05〕',
      '「4. アラートを設定する」／「…計測値がそれを超えたときにアラートがメールで届きます。」',
    ],
    [
      'しきい値',
      '4.「閾値を決めておくと」',
      'NG',
      '使わない語「閾値」を使っている〔TERM-06〕',
      '「センサーごとにしきい値を決めておくと…」',
    ],
    [
      '利用者',
      '1.「初めて使うユーザー」',
      '要注意',
      '画面の表示名の引用ではない〔TERM-07〕',
      '「このガイドは、シギノ・リンクを初めて使う利用者のための手引きです。」',
    ],
    [
      'シギノ・リンク',
      '見出し「シギノ・リンク かんたん操作ガイド（草稿）」、1.「シギノ・リンク」、2.「シギノ・リンク」',
      'OK',
      '推奨語だけを使っている〔TERM-08〕',
      '',
    ],
  ],
  en: [
    [
      'ログイン (log in)',
      '「2. ログオンする」 (heading), 2. 「ログオンします」, 3. 「ログオンすると」',
      'NG',
      'The term to avoid 「ログオン」 is used in 3 places [TERM-01]',
      '「2. ログインする」 / 「…パスワードを入力してログインします。」 / 「ログインするとホーム画面が開き…」',
    ],
    [
      '管理者 (administrator)',
      '2. 「管理者」, 4. 「管理者」',
      'OK',
      'Only the preferred term is used [TERM-02]',
      '',
    ],
    [
      'ダッシュボード (dashboard)',
      '「3. ホーム画面を見る」 (heading), 3. 「ホーム画面が開き」',
      'NG',
      'The term to avoid 「ホーム画面」 is used in 2 places [TERM-03]',
      '「3. ダッシュボードを見る」 / 「ログオンするとダッシュボードが開き…」',
    ],
    [
      'センサー (sensor)',
      '3. 「センサー」, 4. 「センサー」',
      'OK',
      'Only the preferred term is used [TERM-04]',
      '',
    ],
    [
      'アラート (alert)',
      '「4. 警報を設定する」 (heading), 4. 「警報がメールで届きます」',
      'caution',
      'It means the email notification, not an alarm device on the equipment [TERM-05]',
      '「4. アラートを設定する」 / 「…計測値がそれを超えたときにアラートがメールで届きます。」',
    ],
    [
      'しきい値 (threshold)',
      '4. 「閾値を決めておくと」',
      'NG',
      'The term to avoid 「閾値」 is used [TERM-06]',
      '「センサーごとにしきい値を決めておくと…」',
    ],
    [
      '利用者 (user)',
      '1. 「初めて使うユーザー」',
      'caution',
      'It is not a label quoted from the screen [TERM-07]',
      '「このガイドは、シギノ・リンクを初めて使う利用者のための手引きです。」',
    ],
    [
      'シギノ・リンク (Shigino Link)',
      'Heading 「シギノ・リンク かんたん操作ガイド（草稿）」, 1. 「シギノ・リンク」, 2. 「シギノ・リンク」',
      'OK',
      'Only the preferred term is used [TERM-08]',
      '',
    ],
  ],
};

const HEADER: Readonly<Record<Lang, readonly string[]>> = {
  ja: ['用語', '箇所', '判定', '理由', '修正案'],
  en: ['Term', 'Where', 'Verdict', 'Why', 'Fix'],
};

const LEAD: Bilingual = {
  ja: `${DOCUMENT} を、用語集（2026-10版）の8項目と照合しました。NGが3件（TERM-01 ログイン、TERM-03 ダッシュボード、TERM-06 しきい値）、要注意が2件（TERM-05 アラート、TERM-07 利用者）、OKが3件です。`,
  en: `I checked ${DOCUMENT} against the eight terms of the glossary (2026-10 edition): 3 NG (TERM-01, TERM-03, TERM-06), 2 caution (TERM-05, TERM-07) and 3 OK.`,
};

const CLOSE: Bilingual = {
  ja: 'どう直すかは担当者が判断してください。',
  en: 'The writer decides what to change.',
};

export const glossary: Recorder = (ask) => {
  carries(ask, `glossary/inbox/${DOCUMENT}.md`);
  const lang = ask.lang;
  const file = `glossary-reports/${DOCUMENT}_review.md`;
  const review = table(HEADER[lang], ROWS[lang]);
  const saved =
    lang === 'ja'
      ? `承認されたレポートを ${file} に保存しました。`
      : `The approved report is saved to ${file}.`;
  return playUseCase(
    ask.slug,
    glossaryAgent,
    reporting({
      open: [`glossary/inbox/${DOCUMENT}.md`, GLOSSARY],
      queries: [],
      file,
      report: `# ${DOCUMENT} ${lang === 'ja' ? '用語チェック' : 'terminology review'}\n\n${review}\n`,
      answer: `${LEAD[lang]}\n\n${review}\n\n${saved}\n\n${CLOSE[lang]}`,
    }),
    ask,
  );
};
