/**
 * The faq-bot entry's recorder: a search of the help-center articles for the question's words, the
 * subscription article it finds read whole, and the answer that cites it, with the deadline and the
 * conditions of the same section, as the skill says.
 */
import faqBotAgent from '../../../../use-cases/faq-bot/agents/faq-bot.ts';
import type { Script } from '../../../gallery/harness/scripted-workspace.ts';
import type { Recorder } from '../types.ts';
import { carries, read, search, type Bilingual } from '../use-case-script.ts';
import { playUseCase } from '../use-case-desk.ts';

const QUERY: Bilingual = { ja: 'スキップ', en: 'skip' };

const ANSWER: Bilingual = {
  ja: [
    'はい、定期便は次回だけお休み（スキップ）できます。次回の発送予定日の5日前の23:59までに、マイページで手続きしてください。',
    '',
    '- マイページの「定期便」から「次回をスキップ」を選びます〔定期便の変更・スキップ・解約 HC-103〕',
    '- スキップは連続2回まで選べます。スキップに手数料はかかりません〔定期便の変更・スキップ・解約 HC-103〕',
    '- 締め切りは次回の発送予定日の5日前の23:59です。締め切りを過ぎると、次回分は発送の準備に入るため変更できません〔定期便の変更・スキップ・解約 HC-103〕',
  ].join('\n'),
  en: [
    'Yes, you can skip just the next delivery. Do it on My Page by 23:59, 5 days before the next shipping date.',
    '',
    '- On My Page, open "Subscription" and choose "Skip next delivery" [Changing, skipping or cancelling a subscription HC-103]',
    '- You can skip up to 2 deliveries in a row. Skipping is free [Changing, skipping or cancelling a subscription HC-103]',
    '- The deadline is 23:59, 5 days before the next shipping date. After it, the next delivery is being prepared and cannot be changed [Changing, skipping or cancelling a subscription HC-103]',
  ].join('\n'),
};

export const faqBot: Recorder = (ask) => {
  carries(ask, ask.lang === 'ja' ? '次回だけお休み' : 'skip just the next delivery');
  const model: Script = async (context) => {
    const found = await search(context, [QUERY[ask.lang]]);
    const article = found.filter((file) => file.includes(`/${ask.lang}/HC-103_`));
    if (article.length === 0) throw new Error(`${ask.slug}: search found no HC-103 article`);
    await read(context, article);
    return ANSWER[ask.lang];
  };
  return playUseCase(ask.slug, faqBotAgent, model, ask);
};
