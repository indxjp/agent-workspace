/* global process */ // The root ESLint config declares no environment globals.
// ringi-archive: the tools behind the ringi review agent, as an MCP server. Every tool reads; none
// writes, so the agent stays read-only even through its tools.
//
//   search_ringi    { query, category?, result?, limit? } → past ringi (precedents), best first
//   get_ringi       { id }                                → one past ringi in full, with its citation
//   check_authority { category, amountYen }               → the approver the 職務権限規程 requires
//   search_rules    { query, limit? }                     → clauses of the internal rules
//   read_rule       { id }                                → one clause in full, with its citation
//
// `check_authority` is deterministic on purpose. Which approver a ringi needs is a table lookup,
// not a judgement, and the backend re-runs the same lookup to check what the agent wrote.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createIndex } from '../../shared/jp-search.mjs';
import { limit, refuse, serveTools, text } from '../../shared/mcp-server.mjs';
import { categoriesOf, parseAuthorityMatrix, requiredApprover } from './authority.mjs';

const DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');
const RULES_DIR = process.env.RULES_DIR ?? path.join(DATA_DIR, 'rules');
const RINGI_DIR = process.env.RINGI_DIR ?? path.join(DATA_DIR, 'ringi');
const RESULTS = ['承認', '差戻し', '否決'];

/** One passage per `## §` clause of a rule book, titled by its front matter. */
function clausesOf(fileName, markdown) {
  const front = /^---\n([\s\S]*?)\n---\n/u.exec(markdown);
  const source = /^title:\s*(.+)$/mu.exec(front?.[1] ?? '')?.[1]?.trim() ?? fileName;
  const clauses = [];
  let current = null;
  for (const line of markdown.slice(front?.[0].length ?? 0).split('\n')) {
    const heading = /^## §(\S+)\s+(.+)$/u.exec(line);
    if (heading) {
      current = {
        id: `${path.parse(fileName).name}#${heading[1]}`,
        source,
        section: heading[1],
        title: heading[2].trim(),
        lines: [],
      };
      clauses.push(current);
    } else if (current && line.trim() !== '') {
      current.lines.push(line.trim());
    }
  }
  return clauses.map(({ lines, ...clause }) => ({ ...clause, text: lines.join('\n') }));
}

const ruleFiles = readdirSync(RULES_DIR)
  .filter((name) => name.endsWith('.md'))
  .sort();
const clauses = ruleFiles.flatMap((name) =>
  clausesOf(name, readFileSync(path.join(RULES_DIR, name), 'utf8')),
);
const clauseById = new Map(clauses.map((clause) => [clause.id, clause]));
const ruleIndex = createIndex(clauses);

const matrix = parseAuthorityMatrix(
  readFileSync(path.join(RULES_DIR, 'authority-matrix.md'), 'utf8'),
);
const CATEGORIES = categoriesOf(matrix);

const ringi = readdirSync(RINGI_DIR)
  .filter((name) => name.endsWith('.json'))
  .sort()
  .flatMap((name) => JSON.parse(readFileSync(path.join(RINGI_DIR, name), 'utf8')));
const ringiById = new Map(ringi.map((record) => [record.id, record]));
// Search the subject and the reason: a rejected precedent is found by why it was sent back.
const ringiIndex = createIndex(
  ringi.map((record) => ({
    ...record,
    title: record.件名,
    text: `${record.理由} ${record.起案部門}`,
  })),
);

/** An optional argument that must be one of `allowed`. */
function oneOf(args, key, allowed) {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !allowed.includes(value)) {
    refuse(`${key} must be one of: ${allowed.join(', ')}`);
  }
  return value;
}

const ringiCitation = (record) => `〔稟議 ${record.id}〕`;
const clauseCitation = (clause) => `〔${clause.source} §${clause.section}〕`;

serveTools({
  name: 'ringi-archive',
  tools: [
    {
      name: 'search_ringi',
      description:
        '過去の稟議（先例）を件名・理由で全文検索する。差戻し・否決の先例も含む。category（区分）と result（承認/差戻し/否決）で絞り込める。見つからなければ空配列。',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          category: { type: 'string', enum: CATEGORIES },
          result: { type: 'string', enum: RESULTS },
          limit: { type: 'integer', minimum: 1, maximum: 10 },
        },
        required: ['query'],
      },
      handler: (args) => {
        const category = oneOf(args, 'category', CATEGORIES);
        const result = oneOf(args, 'result', RESULTS);
        return ringiIndex
          .search(text(args, 'query'), {
            limit: limit(args, 'limit', 5, 10),
            filter: (record) =>
              (category === undefined || record.区分 === category) &&
              (result === undefined || record.結果 === result),
          })
          .map((hit) => ({
            id: hit.id,
            件名: hit.件名,
            区分: hit.区分,
            金額: hit.金額,
            結果: hit.結果,
            起案日: hit.起案日,
            score: hit.score,
          }));
      },
    },
    {
      name: 'get_ringi',
      description:
        'search_ringi が返した id の稟議を全文で読む。類似案件にはこの citation を付ける。',
      inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      handler: (args) => {
        const record = ringiById.get(text(args, 'id'));
        if (record === undefined) refuse('no ringi with that id; call search_ringi first');
        return { ...record, citation: ringiCitation(record) };
      },
    },
    {
      name: 'check_authority',
      description:
        '職務権限規程の別表で、区分と金額（税抜・円）から決裁者と決裁区分を判定する。決定的な表引きで、決裁区分は必ずこの結果を写す。',
      inputSchema: {
        type: 'object',
        properties: {
          category: { type: 'string', enum: CATEGORIES },
          amountYen: { type: 'integer', minimum: 0 },
        },
        required: ['category', 'amountYen'],
      },
      handler: (args) => {
        const category = text(args, 'category');
        const decision = requiredApprover(matrix, category, args.amountYen);
        if (decision === null) {
          refuse(
            `別表に定めのない区分です（${category}）。経営企画部長が決裁区分を定める〔${matrix.source} §1.1〕。定めのある区分: ${CATEGORIES.join('、')}`,
          );
        }
        return decision;
      },
    },
    {
      name: 'search_rules',
      description:
        '社内規程（稟議規程・職務権限規程・寄付金取扱基準）を条文単位で全文検索する。見つからなければ空配列。',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          limit: { type: 'integer', minimum: 1, maximum: 10 },
        },
        required: ['query'],
      },
      handler: (args) =>
        ruleIndex
          .search(text(args, 'query'), { limit: limit(args, 'limit', 5, 10) })
          .map((hit) => ({
            id: hit.id,
            source: hit.source,
            section: hit.section,
            title: hit.title,
            score: hit.score,
          })),
    },
    {
      name: 'read_rule',
      description:
        'search_rules が返した id の条文を全文で読む。指摘にはこの citation をそのまま付ける。',
      inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      handler: (args) => {
        const clause = clauseById.get(text(args, 'id'));
        if (clause === undefined) refuse('no clause with that id; call search_rules first');
        return { ...clause, citation: clauseCitation(clause) };
      },
    },
  ],
});
