/* global process */ // The root ESLint config declares no environment globals.
// authority-server: the one tool of the ringi review agent that is not retrieval, as an MCP server.
//
//   check_authority { category, amountYen } → the approver the 職務権限規程 requires
//
// It is deterministic on purpose. Which approver a ringi needs is a table lookup, not a judgement,
// and the backend re-runs the same lookup to check what the agent wrote. The rules and the past
// ringi are found with the platform's `search_files`, so this server holds no index and needs no
// caller identity.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { refuse, serveTools, text } from '../../shared/mcp-server.mjs';
import { categoriesOf, parseAuthorityMatrix, requiredApprover } from './authority.mjs';

const DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');
const RULES_DIR = process.env.RULES_DIR ?? path.join(DATA_DIR, 'rules');

const matrix = parseAuthorityMatrix(
  readFileSync(path.join(RULES_DIR, 'authority-matrix.md'), 'utf8'),
);
const CATEGORIES = categoriesOf(matrix);

serveTools({
  name: 'authority',
  tools: [
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
  ],
});
