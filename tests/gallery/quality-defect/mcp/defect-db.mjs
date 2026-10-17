/* global process */ // The root ESLint config declares no environment globals.
// defect-db: the past-trouble (過去トラ) database behind the quality-defect agent, as an MCP server.
//
// It reads one JSON file per past defect report, as a quality system exports them (不具合番号,
// 品番, 工程, 現象, 原因, 4M分類, 対策, 水平展開, 再発有無 …), and serves three tools:
//
//   search_defects { query, process?, partNo?, limit? } → similar past cases, best first,
//                                                         or { noMatch: true, message } when none
//   get_defect    { id }                               → one report in full, with its citation
//   cause_stats    { query, process?, partNo? }         → 4M counts over every matched case
//
// `cause_stats` exists so that the agent never counts. "機械 3件" in an 8D draft is a number a
// reviewer acts on; the server computes it deterministically and returns the exact line to quote,
// and the backend checks that the line in the draft is one this tool returned in the same run.
//
// The data would normally live in the quality database. Querying it directly with postgresTool()
// is not open yet (its run-time gate, #598), so this server is the supported route: export the
// table nightly, or point the loader at a read replica.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createIndex } from '../../shared/jp-search.mjs';
import { limit, refuse, serveTools, text } from '../../shared/mcp-server.mjs';

const DEFECTS_DIR =
  process.env.DEFECTS_DIR ??
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'defects');

const PROCESSES = ['プレス', '溶接', '塗装', '組立'];
const FOUR_M = ['人', '機械', '材料', '方法'];
const ID = /^Q-\d{4}$/u;
// What the agent answers, word for word, when nothing matches above the coverage threshold: the
// server says it, so the reply does not depend on the model recalling the sentence.
const NO_MATCH =
  '類似する過去トラは見つかりませんでした。品質保証課で新規不具合として登録してください。';

/** One exported report → the record the tools serve, with English keys and its citation. */
function recordOf(raw) {
  const fourM = raw['4M分類'];
  if (!FOUR_M.includes(fourM)) throw new Error(`${raw['不具合番号']}: unknown 4M ${fourM}`);
  return {
    id: raw['不具合番号'],
    partNo: raw['品番'],
    partName: raw['品名'],
    process: raw['工程'],
    phenomenon: raw['現象'],
    date: raw['発生日'],
    lot: raw['ロット'],
    count: raw['発生数'],
    outflow: raw['流出区分'],
    cause: raw['原因'],
    causeCode: raw['原因区分'],
    fourM,
    whys: raw['なぜなぜ'],
    countermeasure: raw['対策'],
    horizontalDeployment: raw['水平展開'],
    recurred: raw['再発有無'],
    related: raw['関連不具合'],
    citation: `〔過去トラ ${raw['不具合番号']}〕`,
  };
}

function loadRecords(dir) {
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => recordOf(JSON.parse(readFileSync(path.join(dir, name), 'utf8'))));
}

const records = loadRecords(DEFECTS_DIR);
const byId = new Map(records.map((record) => [record.id, record]));
// The phenomenon is the title, so it carries the most weight; the cause and its category let a
// query such as 「金型摩耗」 find cases whose phenomenon differs.
const index = createIndex(
  records.map((record) => ({
    ...record,
    title: `${record.phenomenon} ${record.phenomenon}`,
    text: `${record.partName} ${record.causeCode} ${record.cause}`,
  })),
);

/** The optional filters both search tools take, validated. */
function filtersOf(args) {
  const process = args.process;
  if (process !== undefined && !PROCESSES.includes(process)) {
    refuse(`process must be one of ${PROCESSES.join(' / ')}`);
  }
  const partNo = args.partNo;
  if (partNo !== undefined && (typeof partNo !== 'string' || partNo.trim() === '')) {
    refuse('partNo must be a non-empty string');
  }
  const prefix = typeof partNo === 'string' ? partNo.trim().toUpperCase() : null;
  return (record) =>
    (process === undefined || record.process === process) &&
    (prefix === null || record.partNo.startsWith(prefix));
}

function matches(args, max) {
  return index.search(text(args, 'query'), {
    limit: max,
    filter: filtersOf(args),
    minCoverage: 0.5,
  });
}

const summaryOf = (hit) => ({
  id: hit.id,
  partNo: hit.partNo,
  process: hit.process,
  phenomenon: hit.phenomenon,
  date: hit.date,
  causeCode: hit.causeCode,
  fourM: hit.fourM,
  recurred: hit.recurred,
  cause: hit.cause,
  citation: hit.citation,
  score: hit.score,
});

/** 4M counts over the matched cases, in a fixed key order, and the line the draft must quote. */
function causeStatsOf(hits) {
  const fourM = Object.fromEntries(FOUR_M.map((key) => [key, 0]));
  const causes = new Map();
  for (const hit of hits) {
    fourM[hit.fourM] += 1;
    const entry = causes.get(hit.causeCode) ?? {
      causeCode: hit.causeCode,
      fourM: hit.fourM,
      count: 0,
      recurred: 0,
      ids: [],
    };
    entry.count += 1;
    if (hit.recurred === '有') entry.recurred += 1;
    entry.ids.push(hit.id);
    causes.set(hit.causeCode, entry);
  }
  const ids = hits.map((hit) => hit.id).sort();
  for (const entry of causes.values()) entry.ids.sort();
  const byCause = [...causes.values()].sort(
    (left, right) => right.count - left.count || (left.causeCode < right.causeCode ? -1 : 1),
  );
  const counts = FOUR_M.map((key) => `${key} ${String(fourM[key])}件`).join(' / ');
  return {
    matched: hits.length,
    fourM,
    byCause,
    ids,
    line: `4M集計: ${counts}（類似 ${String(hits.length)}件）`,
  };
}

serveTools({
  name: 'defect-db',
  tools: [
    {
      name: 'search_defects',
      description:
        '過去トラ（過去の不具合報告）を検索する。query は現象や原因の語（例: バリ、塗装ムラ、金型摩耗）。process（プレス/溶接/塗装/組立）と partNo（品番、前方一致）で絞り込める。見つかれば類似の高い順の配列。見つからなければ { noMatch: true, message }（類似なし。8D を作らず message をそのまま回答する）。',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          process: { type: 'string', enum: PROCESSES },
          partNo: { type: 'string' },
          limit: { type: 'integer', minimum: 1, maximum: 20 },
        },
        required: ['query'],
      },
      handler: (args) => {
        const hits = matches(args, limit(args, 'limit', 8, 20));
        return hits.length === 0 ? { noMatch: true, message: NO_MATCH } : hits.map(summaryOf);
      },
    },
    {
      name: 'get_defect',
      description:
        '不具合番号（Q-xxxx）の報告を全文で読む。なぜなぜ・対策・水平展開を含む。引用にはこの citation をそのまま使う。',
      inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      handler: (args) => {
        const id = text(args, 'id').toUpperCase();
        if (!ID.test(id)) refuse('id must look like Q-1234');
        const record = byId.get(id);
        if (record === undefined) refuse(`no past defect ${id}; call search_defects first`);
        return record;
      },
    },
    {
      name: 'cause_stats',
      description:
        'search_defects と同じ条件で一致した全件について、4M（人・機械・材料・方法）と原因区分の件数を数える。8D に書く件数は必ずこの line をそのまま写す。',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          process: { type: 'string', enum: PROCESSES },
          partNo: { type: 'string' },
        },
        required: ['query'],
      },
      handler: (args) => ({
        query: text(args, 'query'),
        process: args.process ?? null,
        partNo: args.partNo ?? null,
        ...causeStatsOf(matches(args, records.length)),
      }),
    },
  ],
});
