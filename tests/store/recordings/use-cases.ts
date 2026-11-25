/**
 * The recorders of the `use-cases/<slug>` entries (the scheduled-report ones in
 * `./scheduled-reports.ts`, and one module per entry in `./use-cases/`). Each plays the entry's first suggested prompt against the entry's own
 * agent definition, seeded files and skill scripts (`./use-case-desk.ts`);
 * only the model's decisions are scripted here, following the entry's instructions and skill on its
 * sample data: what it searches for, which files it reads, what it writes behind the approval and
 * what it answers. A number in an answer is one the entry's sample data holds.
 *
 * A scripted model is fixed to one request, so each recorder checks that the prompt carries that
 * request's identifiers and fails with the entry's name when it does not: a recording of a question
 * the agent was not asked would be a false one. Text a sample file plants for the safety evals (an
 * instruction addressed to the assistant) is never followed; where the entry's skill says so, the
 * report names it as what the record says.
 */
import ndaAgent from '../../../use-cases/nda/agents/nda.ts';
import policyQaAgent from '../../../use-cases/policy-qa/agents/policy-qa.ts';
import type { Script } from '../../gallery/harness/scripted-workspace.ts';
import { SCHEDULED_REPORTS } from './scheduled-reports.ts';
import type { Recorder } from './types.ts';
import { adCompliance } from './use-cases/ad-compliance.ts';
import { codeReview } from './use-cases/code-review.ts';
import { expense } from './use-cases/expense.ts';
import { faqBot } from './use-cases/faq-bot.ts';
import { inspection } from './use-cases/inspection.ts';
import { invoice } from './use-cases/invoice.ts';
import { market } from './use-cases/market.ts';
import { screeningHr } from './use-cases/screening-hr.ts';
import { screening } from './use-cases/screening.ts';
import { playUseCase } from './use-case-desk.ts';
import { carries, read, reporting, search, type Bilingual } from './use-case-script.ts';

const POLICY_QA: Bilingual = {
  ja: [
    '国内出張の宿泊費は、1泊あたり東京23区・大阪市が12,000円、その他の地域が10,000円（税込）を上限に、実費で支給されます。',
    '',
    '- 上限（1泊・税込）は、東京23区・大阪市が12,000円、その他の地域が10,000円です〔旅費・経費精算規程 第8条第1項〕',
    '- 上限を超える宿泊は、出張申請の時点で理由を記載し、部長の承認を得た場合に限り認められます〔旅費・経費精算規程 第8条第2項〕',
  ].join('\n'),
  en: [
    "A domestic trip's hotel is paid at cost up to JPY 12,000 a night in Tokyo's 23 wards and Osaka city, and JPY 10,000 everywhere else (tax included).",
    '',
    "- The limit per night, tax included, is JPY 12,000 for Tokyo's 23 wards and Osaka city and JPY 10,000 everywhere else [Travel and Expense Rules, Article 8(1)]",
    '- A hotel above the limit is allowed only when the reason is written in the trip request and the department head approves it [Travel and Expense Rules, Article 8(2)]',
  ].join('\n'),
};

const NDA_FILE = '秘密保持契約書_株式会社ツバメ技研案';
const NDA_STANDARDS = [
  'NDA-01-definition',
  'NDA-02-exceptions',
  'NDA-03-purpose',
  'NDA-04-disclosure',
  'NDA-05-term',
  'NDA-06-return',
  'NDA-07-damages',
  'NDA-08-law',
].map((name) => `nda/standards/${name}.md`);

const NDA_FIX = {
  '01': '本契約において秘密情報とは、開示者が受領者に対し、秘密である旨を明示して書面又は電磁的記録により開示した情報、及び口頭で開示した情報のうち開示の後30日以内に書面で秘密である旨を特定したものをいう。',
  '02': '次の各号のいずれかに該当する情報は、秘密情報に含まれない。（1）開示の時点で既に公知であった情報（2）開示の後に受領者の責めによらずに公知となった情報（3）開示の時点で既に受領者が保有していた情報（4）正当な権限を有する第三者から秘密保持義務を負うことなく取得した情報（5）秘密情報によらずに受領者が独自に開発した情報',
  '05': '本契約の有効期間は、本契約の締結日から2年間とする。本契約に定める秘密保持の義務は、本契約の終了後も3年間存続する。',
  '07': '受領者は、本契約に違反して開示者に損害を与えたときは、これによって開示者に現実に生じた通常の損害を賠償する。',
  '08': '本契約は日本法に準拠し、本契約に関する一切の紛争は、東京地方裁判所を第一審の専属的合意管轄裁判所とする。',
} as const;

const NDA_TABLE: Bilingual = {
  ja: [
    '| 項目 | 条項 | 判定 | 理由 | 修正案 |',
    '| ---- | ---- | ---- | ---- | ------ |',
    `| 秘密情報の定義 | 第1条 | 要注意 | 「開示したすべての情報」と、秘密の表示のない情報まで含めている〔NDA-01〕 | ${NDA_FIX['01']} |`,
    `| 秘密情報の例外 | 第2条 | NG | 例外が（1）〜（3）の三つで、第三者から正当に取得した情報と独自に開発した情報の例外がない〔NDA-02〕 | ${NDA_FIX['02']} |`,
    '| 目的外使用の禁止 | 第3条 | OK | 「本目的のためにのみ使用」と目的に限っている〔NDA-03〕 | |',
    '| 第三者への開示 | 第4条 | OK | 事前の書面による承諾を要し、知る必要のある役員及び従業員への開示を認めている〔NDA-04〕 | |',
    `| 有効期間と義務の存続 | 第5条 | 要注意 | 有効期間は2年間だが、秘密保持の義務が契約の終了後も「無期限に存続」する〔NDA-05〕 | ${NDA_FIX['05']} |`,
    '| 返還と破棄 | 第6条 | OK | 終了時又は求めがあったときの返還又は破棄と、求めに応じた破棄の証明書面を定めている〔NDA-06〕 | |',
    `| 損害賠償 | 第7条 | NG | 「違約金として金1,000万円」に加え、これを超える損害の賠償も請求できる〔NDA-07〕 | ${NDA_FIX['07']} |`,
    `| 準拠法と管轄 | 第8条 | 要注意 | 準拠法は日本法だが、管轄が「大阪地方裁判所」になっている〔NDA-08〕 | ${NDA_FIX['08']} |`,
  ].join('\n'),
  en: [
    '| Item | Article | Verdict | Why | Suggested fix |',
    '| ---- | ------- | ------- | --- | ------------- |',
    `| Definition of confidential information | Article 1 | caution | It covers 「開示したすべての情報」 (all information disclosed), including information not marked confidential [NDA-01] | ${NDA_FIX['01']} |`,
    `| Exceptions | Article 2 | NG | It has three exceptions, (1) to (3); information lawfully obtained from a third party and information developed independently are not excepted [NDA-02] | ${NDA_FIX['02']} |`,
    '| Use beyond the purpose | Article 3 | OK | Use is limited to 「本目的のためにのみ」 (the Purpose only) [NDA-03] | |',
    '| Disclosure to third parties | Article 4 | OK | Prior written consent is required, and disclosure to officers and employees who need to know is allowed [NDA-04] | |',
    `| Term and survival | Article 5 | caution | The term is two years, but the duty of confidentiality survives 「無期限に」 (indefinitely) after it ends [NDA-05] | ${NDA_FIX['05']} |`,
    '| Return and destruction | Article 6 | OK | Return or destruction at the end or on request, and a certificate of destruction on request [NDA-06] | |',
    `| Damages | Article 7 | NG | A penalty of 「金1,000万円」 (JPY 10 million) plus damages beyond it [NDA-07] | ${NDA_FIX['07']} |`,
    `| Governing law and jurisdiction | Article 8 | caution | Japanese law, but the court is 「大阪地方裁判所」 (Osaka District Court) [NDA-08] | ${NDA_FIX['08']} |`,
  ].join('\n'),
};

const NDA_ANSWER: Bilingual = {
  ja: `株式会社ツバメ技研案のNDAを、NDA審査基準の8項目と照合しました。NGが2件（第2条 例外、第7条 損害賠償）、要注意が3件（第1条 定義、第5条 存続期間、第8条 管轄）、OKが3件です。承認されたレポートを nda-reports/${NDA_FILE}_review.md に保存しました。\n\n${NDA_TABLE.ja}\n\n署名するかどうかは担当者が判断してください。`,
  en: `I checked the 株式会社ツバメ技研 NDA against the eight items of the NDA standard: 2 NG (Article 2, exceptions; Article 7, damages), 3 caution (Article 1, definition; Article 5, survival; Article 8, jurisdiction) and 3 OK. The approved report is saved to nda-reports/${NDA_FILE}_review.md.\n\n${NDA_TABLE.en}\n\nA person decides whether to sign.`,
};

export const USE_CASES: Readonly<Record<string, Recorder>> = {
  ...SCHEDULED_REPORTS,
  'ad-compliance': adCompliance,
  'code-review': codeReview,
  expense,
  'faq-bot': faqBot,
  inspection,
  invoice,
  market,
  screening,
  'screening-hr': screeningHr,

  nda: (ask) => {
    carries(ask, `nda/inbox/${NDA_FILE}.md`);
    return playUseCase(
      ask.slug,
      ndaAgent,
      reporting({
        queries: [],
        open: [`nda/inbox/${NDA_FILE}.md`, ...NDA_STANDARDS],
        file: `nda-reports/${NDA_FILE}_review.md`,
        report: `# ${NDA_FILE} ${ask.lang === 'ja' ? 'レビュー' : 'review'}\n\n${NDA_TABLE[ask.lang]}\n`,
        answer: NDA_ANSWER[ask.lang],
      }),
      ask,
    );
  },

  'policy-qa': (ask) => {
    carries(ask, ask.lang === 'ja' ? '宿泊費' : 'hotel');
    const model: Script = async (context) => {
      const found = await search(context, [ask.lang === 'ja' ? '宿泊費 上限' : 'hotel limit']);
      const rules = found.filter((file) => file.includes('travel-expense-rules'));
      if (rules.length === 0)
        throw new Error(`${ask.slug}: search found no travel and expense rules`);
      await read(context, rules);
      return POLICY_QA[ask.lang];
    };
    return playUseCase(ask.slug, policyQaAgent, model, ask);
  },
};
