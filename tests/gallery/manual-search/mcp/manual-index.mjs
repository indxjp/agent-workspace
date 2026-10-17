/* global process */ // The root ESLint config declares no environment globals.
// manual-index: the search tool behind the manual-search agent, as an MCP server.
//
// It indexes Markdown manuals whose pages are marked `<!-- page N -->` and whose sections are
// `## §N.N title` headings, one passage per section, and serves two tools:
//
//   search_manual { query, limit? }  → the best passages: id, source, page, section, snippet
//   read_section  { id }             → the passage in full, with the citation to copy
//
// Real manuals arrive as PDF. Agent Workspace stores uploaded files as bytes and parses nothing,
// so turning a PDF into this page-marked text is the indexer's job (pdftotext -layout, or your
// document-AI service), done once when a manual is published, not on every question.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createIndex } from '../../shared/jp-search.mjs';
import { limit, refuse, serveTools, text } from '../../shared/mcp-server.mjs';

const MANUALS_DIR =
  process.env.MANUALS_DIR ??
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'manuals');

/** Split one manual into passages: one per `## §` section, carrying the page it starts on. */
function passagesOf(fileName, markdown) {
  const front = /^---\n([\s\S]*?)\n---\n/u.exec(markdown);
  const meta = Object.fromEntries(
    (front?.[1] ?? '').split('\n').map((line) => {
      const at = line.indexOf(':');
      return [line.slice(0, at).trim(), line.slice(at + 1).trim()];
    }),
  );
  const source = meta.title ?? fileName;
  const passages = [];
  let page = null;
  let current = null;
  for (const line of markdown.slice(front?.[0].length ?? 0).split('\n')) {
    const pageMark = /^<!-- page (\d+) -->$/u.exec(line.trim());
    if (pageMark) {
      page = Number(pageMark[1]);
      continue;
    }
    const heading = /^## §(\S+)\s+(.+)$/u.exec(line);
    if (heading) {
      current = {
        id: `${path.parse(fileName).name}#${heading[1]}`,
        source,
        revised: meta.revised ?? null,
        page,
        section: heading[1],
        title: heading[2],
        lines: [],
      };
      passages.push(current);
      continue;
    }
    if (current && line.trim() !== '') current.lines.push(line.trim());
  }
  // The manual's title and code are indexed with every passage, so 「HU-200 …」 or the manual's
  // name in a question ranks that manual first.
  const keywords = `${source} ${meta.code ?? ''}`;
  return passages.map(({ lines, ...passage }) => ({ ...passage, keywords, text: lines.join('') }));
}

function loadPassages(dir) {
  return readdirSync(dir)
    .filter((name) => name.endsWith('.md'))
    .sort()
    .flatMap((name) => passagesOf(name, readFileSync(path.join(dir, name), 'utf8')));
}

const citationOf = (passage) => `〔${passage.source} p.${passage.page} §${passage.section}〕`;

const passages = loadPassages(MANUALS_DIR);
const index = createIndex(passages);
const byId = new Map(passages.map((passage) => [passage.id, passage]));

serveTools({
  name: 'manual-index',
  tools: [
    {
      name: 'search_manual',
      description:
        '社内マニュアルを全文検索する。日本語の質問文や語句をそのまま渡してよい。結果は関連度順。見つからなければ空配列。',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          limit: { type: 'integer', minimum: 1, maximum: 10 },
        },
        required: ['query'],
      },
      handler: (args) =>
        index.search(text(args, 'query'), { limit: limit(args, 'limit', 5, 10) }).map((hit) => ({
          id: hit.id,
          source: hit.source,
          page: hit.page,
          section: hit.section,
          title: hit.title,
          snippet: hit.text.slice(0, 80),
          score: hit.score,
        })),
    },
    {
      name: 'read_section',
      description:
        'search_manual が返した id の節を全文で読む。回答にはこの citation をそのまま使う。',
      inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      handler: (args) => {
        const passage = byId.get(text(args, 'id'));
        if (passage === undefined) refuse('no section with that id; call search_manual first');
        return { ...passage, citation: citationOf(passage) };
      },
    },
  ],
});
