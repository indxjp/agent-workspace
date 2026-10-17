/**
 * The contract-management app's backend call: have the contract-review agent review an uploaded
 * draft, parse its risk table, and refuse to call the review complete when it leaves out a finding
 * the playbook says must always be raised.
 *
 * The check runs here, independently of the agent. The backend already holds the draft's bytes
 * (it uploaded them), so it reads the .docx with the shared office-reader and runs the same
 * `clauses.mjs check` the agent is told to run. Every finding with `mustFlag: true` must appear in
 * the agent's table as a row citing the same rule (〔PB-xx〕) for the same clause, or, for an
 * absence, any row citing the rule. A model that skips a step, mis-reads a clause or simply
 * forgets a row produces an `incomplete` review with the missing findings listed, which legal sees
 * instead of a clean-looking table.
 *
 * The table is a Markdown table (format in `skills/contract-playbook/SKILL.md`) rather than fenced
 * JSON, because the same answer is what legal reads on the legal-desk page, where a Markdown table
 * renders and JSON does not. A run has no output schema (probe `run-output-schema`), so either way
 * the backend parses text; a row it cannot read is reported in `malformed`, never dropped silently.
 */
import type { AgentWorkspaceClient } from '@indx-workspace/sdk';

import { runAndRead } from '../../shared/run-answer.ts';
import { readDocx } from '../../shared/skills/office-reader/scripts/ooxml.mjs';
import {
  check,
  normalize,
  clauseNumber,
  type CheckResult,
  type Finding,
  type PlaybookRule,
  type Severity,
} from '../skills/contract-playbook/scripts/clauses.mjs';

export interface RiskRow {
  /** 「第6条」, or `null` for a row about a clause the draft lacks (「欠落」). */
  readonly clause: string | null;
  readonly topic: string;
  readonly risk: Severity;
  readonly reason: string;
  /** The playbook rules the reason cites, from its 〔PB-xx〕 marks. */
  readonly rules: readonly string[];
  readonly proposal: string;
}

export interface ContractReview {
  /** `complete` only when the table parsed and every must-flag finding is in it. */
  readonly status: 'complete' | 'incomplete';
  readonly rows: readonly RiskRow[];
  /** Must-flag findings of the deterministic check that no row covers. */
  readonly missing: readonly Finding[];
  /** Rows covering a must-flag finding at a lower risk than the playbook's: shown, not refused. */
  readonly downgraded: readonly { readonly row: RiskRow; readonly finding: Finding }[];
  /** Table lines that could not be read as a row (wrong column count, risk, or no citation). */
  readonly malformed: readonly string[];
  /** Rows citing a rule the playbook does not have. */
  readonly unknownRules: readonly string[];
  /** The backend's own check of the draft, for the reviewer's screen. */
  readonly check: CheckResult;
  readonly answer: string;
  readonly sessionId: string;
}

export interface ReviewRequest {
  /** Where the draft was uploaded in the file store, under the agent's `contracts` grant. */
  readonly path: string;
  /** The draft's bytes, as uploaded. */
  readonly docx: Buffer;
  readonly playbook: ReadonlyMap<string, PlaybookRule>;
}

const COLUMNS = ['条項', '論点', 'リスク度', '理由', '修正文案'] as const;
const RISK_ORDER: Readonly<Record<Severity, number>> = { 低: 0, 中: 1, 高: 2 };
const ABSENT = /^(欠落|なし|新設|[—–-]+)$/u;

const cells = (line: string): string[] =>
  line
    .trim()
    .replace(/^\|/u, '')
    .replace(/\|$/u, '')
    .split('|')
    .map((cell) => cell.trim());

function clauseOf(cell: string): string | null | undefined {
  const text = normalize(cell);
  if (ABSENT.test(text)) return null;
  const written = /^第\s*([0-9〇一二三四五六七八九十百]+)\s*条/u.exec(text)?.[1];
  if (written === undefined) return undefined;
  const number = clauseNumber(written);
  return Number.isNaN(number) ? undefined : `第${String(number)}条`;
}

/**
 * Parse the risk table out of an answer: the first Markdown table whose header is exactly the
 * skill's five columns. Every later line that starts with `|` is a row until the table ends.
 */
export function parseRiskTable(answer: string): {
  readonly found: boolean;
  readonly rows: RiskRow[];
  readonly malformed: string[];
} {
  const lines = answer.split('\n');
  const start = lines.findIndex(
    (line) => line.trim().startsWith('|') && cells(line).join('|') === COLUMNS.join('|'),
  );
  if (start === -1) return { found: false, rows: [], malformed: [] };
  const rows: RiskRow[] = [];
  const malformed: string[] = [];
  for (const line of lines.slice(start + 2)) {
    if (!line.trim().startsWith('|')) break;
    const [clauseCell, topic, risk, reason, proposal, ...extra] = cells(line);
    const clause = clauseOf(clauseCell ?? '');
    const rules = [...(reason ?? '').matchAll(/〔(PB-\d{2})〕/gu)].map((match) => match[1] ?? '');
    if (
      extra.length > 0 ||
      proposal === undefined ||
      clause === undefined ||
      (risk !== '高' && risk !== '中' && risk !== '低') ||
      rules.length === 0
    ) {
      malformed.push(line.trim());
      continue;
    }
    rows.push({ clause, topic: topic ?? '', risk, reason: reason ?? '', rules, proposal });
  }
  return { found: true, rows, malformed };
}

const covers = (row: RiskRow, finding: Finding): boolean =>
  row.rules.includes(finding.rule) && (finding.clause === null || row.clause === finding.clause);

/** Compare a parsed table with the deterministic check: what is missing, what is rated lower. */
export function enforceMustFlags(
  rows: readonly RiskRow[],
  result: CheckResult,
): Pick<ContractReview, 'missing' | 'downgraded'> {
  const mustFlags = result.findings.filter((finding) => finding.mustFlag);
  const missing = mustFlags.filter((finding) => !rows.some((row) => covers(row, finding)));
  const downgraded = mustFlags.flatMap((finding) => {
    const row = rows.find((candidate) => covers(candidate, finding));
    return row !== undefined && RISK_ORDER[row.risk] < RISK_ORDER[finding.severity]
      ? [{ row, finding }]
      : [];
  });
  return { missing, downgraded };
}

/** The prompt the app sends: the draft's path, nothing the agent could take as a finding. */
export const reviewPrompt = (path: string): string =>
  `次の契約書ドラフトを審査基準に照らしてレビューし、リスク表を作成してください: ${path}`;

export async function reviewContract(
  aw: AgentWorkspaceClient,
  agentId: string,
  request: ReviewRequest,
  sessionId?: string,
): Promise<ContractReview> {
  const deterministic = check(readDocx(request.docx).paragraphs, request.playbook);
  const reading = await runAndRead(aw, agentId, {
    prompt: reviewPrompt(request.path),
    sessionId: sessionId ?? null,
  });
  const table = parseRiskTable(reading.answer);
  const { missing, downgraded } = enforceMustFlags(table.rows, deterministic);
  const unknownRules = [
    ...new Set(
      table.rows.flatMap((row) => row.rules).filter((rule) => !request.playbook.has(rule)),
    ),
  ];
  return {
    status: table.found && missing.length === 0 ? 'complete' : 'incomplete',
    rows: table.rows,
    missing,
    downgraded,
    malformed: table.malformed,
    unknownRules,
    check: deterministic,
    answer: reading.answer,
    sessionId: reading.run.sessionId,
  };
}
