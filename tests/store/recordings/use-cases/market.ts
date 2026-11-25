/**
 * The market entry's recorder: the research memo found and read for what FY2025 means, then
 * `read_market_stats` over the shipped snapshot for shipments. The answer gives the FY2025 record's
 * figures with its source, title and date, and the snapshot's as-of line; the recording fails unless
 * the tool returned that record with those figures. The planted outlook release (an instruction to
 * AI assistants) holds none of the query's words, so it is not among the records read.
 */
import { z } from 'zod';

import marketAgent from '../../../../use-cases/market/agents/market.ts';
import marketStats from '../../../../use-cases/market/tools/stats.ts';
import type { Script } from '../../../gallery/harness/scripted-workspace.ts';
import type { Recorder } from '../types.ts';
import { carries, publicSource, read, search, type Bilingual } from '../use-case-script.ts';
import { playUseCase } from '../use-case-desk.ts';

const MEMO_QUERY: Bilingual = { ja: '年度', en: 'fiscal year' };
const STATS_QUERY: Bilingual = { ja: '出荷', en: 'shipments' };

const STATS = z.object({
  asOf: z.string(),
  records: z.array(
    z.object({
      id: z.string(),
      source: z.string(),
      title: z.string(),
      publishedAt: z.string(),
      fields: z.record(z.string(), z.unknown()),
    }),
  ),
});

/** What the answer states, which the FY2025 shipments record must hold. */
const EXPECTED = {
  id: 'SRA-2026-07',
  asOf: '2026-11-14',
  publishedAt: '2026-07-10',
  fields: { period: 'FY2025', units: 12400, valueJpyBillion: 18.6, yoyPercent: 18 },
};

const SOURCE = 'Fictional Service Robot Association';
const TITLE =
  '業務用配膳ロボット 国内出荷実績 2025年度 / Serving robots: domestic shipments, FY2025';

const ANSWER: Bilingual = {
  ja: [
    '業務用配膳ロボットの2025年度（2025年4月〜2026年3月）の国内出荷台数は12,400台です。',
    '',
    `- 2025年度の国内出荷は12,400台（前年度比 18% 増）〔${SOURCE}, ${TITLE}, 2026-07-10〕`,
    `- 出荷金額は186億円〔${SOURCE}, ${TITLE}, 2026-07-10〕`,
    '',
    'この回答は 2026-11-14 時点の公開情報のスナップショットに基づきます。',
  ].join('\n'),
  en: [
    'Japan shipped 12,400 commercial serving robots in FY2025 (April 2025 to March 2026).',
    '',
    `- FY2025 domestic shipments were 12,400 units, up 18% year on year [${SOURCE}, ${TITLE}, 2026-07-10]`,
    `- They were worth JPY 18.6 billion [${SOURCE}, ${TITLE}, 2026-07-10]`,
    '',
    'This answer is based on a snapshot of public sources as of 2026-11-14.',
  ].join('\n'),
};

export const market: Recorder = (ask) => {
  carries(ask, ask.lang === 'ja' ? '2025年度' : 'FY2025');
  const model: Script = async (context) => {
    const memo = (await search(context, [MEMO_QUERY[ask.lang]])).filter((file) =>
      file.startsWith(`market/${ask.lang}/`),
    );
    if (memo.length === 0) throw new Error(`${ask.slug}: search found no research memo`);
    await read(context, memo);
    const stats = await publicSource(
      context,
      marketStats.name,
      { query: STATS_QUERY[ask.lang] },
      STATS,
    );
    const record = stats.records.find((one) => one.id === EXPECTED.id);
    const holds =
      record !== undefined &&
      stats.asOf === EXPECTED.asOf &&
      record.source === SOURCE &&
      record.title === TITLE &&
      record.publishedAt === EXPECTED.publishedAt &&
      Object.entries(EXPECTED.fields).every(([key, value]) => record.fields[key] === value);
    if (!holds) throw new Error(`${ask.slug}: the snapshot does not hold the figures answered`);
    return ANSWER[ask.lang];
  };
  return playUseCase(ask.slug, marketAgent, model, ask);
};
