/**
 * The screening entry's recorder: the registration request the prompt names, read with the four
 * items of the screening procedure, then every name of the request checked with
 * `check_public_lists` over the shipped snapshot, several ways as the skill says. The recording
 * fails unless each query finds exactly the listed records the report names, from the snapshot of
 * the date it states. Two names are flagged for a person to review; none is called a match or
 * cleared, and the report waits for approval.
 */
import { z } from 'zod';

import screeningAgent from '../../../../use-cases/screening/agents/screening.ts';
import publicLists from '../../../../use-cases/screening/tools/lists.ts';
import type { ScriptContext } from '../../../gallery/harness/scripted-workspace.ts';
import type { Recorder } from '../types.ts';
import {
  carries,
  publicSource,
  read,
  reporting,
  table,
  type Bilingual,
} from '../use-case-script.ts';
import { playUseCase } from '../use-case-desk.ts';

const REQUEST = '取引先登録申請_株式会社ミナセ精工';
const STANDARDS = ['SCR-01-company', 'SCR-02-officers', 'SCR-03-parent', 'SCR-04-end-user'].map(
  (name) => `screening/standards/${name}.md`,
);
const AS_OF = '2026-11-16';

/** Each query the model sends, and the ids of the listed records it must find. */
const SEARCHES: readonly (readonly [query: string, found: readonly string[]])[] = [
  // SCR-01: the company, without its suffix, in romaji, and its former name.
  ['株式会社ミナセ精工', []],
  ['ミナセ精工', []],
  ['Minase Seiko', []],
  ['水無瀬ベアリング工業', []],
  // SCR-02: each officer and the beneficial owner, in full, by family name, in romaji and katakana.
  ['水無瀬 聡', []],
  ['Satoshi Minase', []],
  ['Minase', []],
  ['ミナセ', []],
  ['テオドール・ヴァシキン', []],
  ['ヴァシキン', []],
  ['ワシキン', ['FSL-2207']],
  ['Teodor Vashkin', ['FSL-2207']],
  ['Vashkin', ['FSL-2207']],
  ['鴇田 由宇', []],
  ['Yuu Tokita', []],
  ['Tokita', []],
  ['トキタ', []],
  // SCR-03: the major shareholder, in full, without its suffix and by its distinctive word.
  ['Kestrel Orbital Holdings', []],
  ['Kestrel Orbital', ['FEU-0412']],
  ['Kestrel', ['FEU-0412']],
  // SCR-04: the end user is the applicant; the ship-to city.
  ['浜松', []],
  ['Hamamatsu', []],
];

const ANSWERED = z.object({
  asOf: z.string(),
  truncated: z.boolean(),
  records: z.array(z.object({ id: z.string() })),
});

/** Every query of {@link SEARCHES}; fails unless each finds its records, untruncated, as of {@link AS_OF}. */
async function checkNames(context: ScriptContext): Promise<void> {
  for (const [query, expected] of SEARCHES) {
    const answer = await publicSource(context, publicLists.name, { query }, ANSWERED);
    const ids = answer.records.map((record) => record.id);
    const same = ids.length === expected.length && ids.every((id) => expected.includes(id));
    if (answer.asOf !== AS_OF || answer.truncated || !same) {
      throw new Error(
        `screening: "${query}" found ${ids.join(', ') || 'nothing'} as of ${answer.asOf}`,
      );
    }
  }
}

const TABLE: Bilingual = {
  ja: table(
    ['項目', '照合した名前', '判定', '掲載記録', '理由', '確認すること'],
    [
      [
        '〔SCR-01〕',
        '株式会社ミナセ精工、Minase Seiko、水無瀬ベアリング工業',
        '一致なし',
        '',
        'どの検索でも記録が見つからなかった',
        '',
      ],
      [
        '〔SCR-02〕',
        '水無瀬 聡（Satoshi Minase）、テオドール・ヴァシキン（Teodor Vashkin）、鴇田 由宇（Yuu Tokita）',
        '要確認',
        'FSL-2207（Fictional Sanctions List）VASHKIN, Teodor、別名 Teodor Vashkin',
        '取締役のローマ字表記が掲載記録の別名と同じ。リストには生年月日があり、申請書にはない',
        '取締役の生年月日（リストでは 1968-04-22）と国籍を確認し、同一人物かどうかを判断する',
      ],
      [
        '〔SCR-03〕',
        'Kestrel Orbital Holdings',
        '要確認',
        'FEU-0412（Fictional End-User List）Kestrel Orbital Components Ltd.、別名 Kestrel Orbital',
        '特徴的な語「Kestrel」と別名「Kestrel Orbital」が共通。法人格が異なり、別法人と決めつけない',
        '主要株主の所在国と所在地、掲載法人（Republic of Veloria）との資本関係を確認する',
      ],
      [
        '〔SCR-04〕',
        '申請会社（自社工場で使用）、浜松',
        '一致なし',
        '',
        '最終需要者は申請会社で、納入先の都市にも記録がなかった',
        '',
      ],
    ],
  ),
  en: table(
    ['Item', 'Names checked', 'Verdict', 'Listed record', 'Why', 'To confirm'],
    [
      [
        '[SCR-01]',
        '株式会社ミナセ精工, Minase Seiko, 水無瀬ベアリング工業',
        'no match',
        '',
        'No search found a record',
        '',
      ],
      [
        '[SCR-02]',
        '水無瀬 聡 (Satoshi Minase), テオドール・ヴァシキン (Teodor Vashkin), 鴇田 由宇 (Yuu Tokita)',
        'review',
        'FSL-2207 (Fictional Sanctions List) VASHKIN, Teodor, alias Teodor Vashkin',
        "The director's romanised name is the record's alias; the list gives a date of birth and the request none",
        "Compare the director's date of birth (the list gives 1968-04-22) and nationality to tell whether it is the same person",
      ],
      [
        '[SCR-03]',
        'Kestrel Orbital Holdings',
        'review',
        'FEU-0412 (Fictional End-User List) Kestrel Orbital Components Ltd., alias Kestrel Orbital',
        'It shares the distinctive word "Kestrel" and the alias "Kestrel Orbital"; the suffix differs, so it is not taken as another entity',
        "Confirm the shareholder's country and address, and any ownership link to the listed entity (Republic of Veloria)",
      ],
      [
        '[SCR-04]',
        'The applicant (own factory), Hamamatsu',
        'no match',
        '',
        'The end user is the applicant, and the ship-to city found no record',
        '',
      ],
    ],
  ),
};

const HEAD: Bilingual = {
  ja: `照合したリスト：Fictional Sanctions List、Fictional End-User List（${AS_OF} 時点のスナップショット）`,
  en: `Lists searched: Fictional Sanctions List and Fictional End-User List (snapshot as of ${AS_OF})`,
};

const ANSWER: Bilingual = {
  ja: `申請 VR-2026-118（株式会社ミナセ精工）の名前をすべて、${AS_OF} 時点の公開リストのスナップショットで照合しました。要確認が2件（SCR-02 取締役、SCR-03 主要株主）、一致なしが2件です。要確認は同一とも別とも決めておらず、担当者の確認が必要です。承認された報告書を screening-reports/${REQUEST}_screening.md に保存しました。\n\n${HEAD.ja}\n\n${TABLE.ja}\n\n取引するかどうかは担当者が判断してください。`,
  en: `I checked every name in request VR-2026-118 (株式会社ミナセ精工) against the snapshot of the public lists as of ${AS_OF}: 2 review (SCR-02, a director; SCR-03, a major shareholder) and 2 no match. Neither review is decided either way; a person needs to look at them. The approved report is saved to screening-reports/${REQUEST}_screening.md.\n\n${HEAD.en}\n\n${TABLE.en}\n\nA person decides whether to do business with this party.`,
};

export const screening: Recorder = (ask) => {
  carries(ask, `screening/inbox/${REQUEST}.md`);
  return playUseCase(
    ask.slug,
    screeningAgent,
    reporting({
      queries: [],
      open: [`screening/inbox/${REQUEST}.md`],
      before: async (context) => {
        await read(context, STANDARDS);
        await checkNames(context);
      },
      file: `screening-reports/${REQUEST}_screening.md`,
      report: `# ${REQUEST} ${ask.lang === 'ja' ? '照合結果' : 'screening'}\n\n${HEAD[ask.lang]}\n\n${TABLE[ask.lang]}\n`,
      answer: ANSWER[ask.lang],
    }),
    ask,
  );
};
