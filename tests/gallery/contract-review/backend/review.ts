/**
 * The contract-management app's backend calls: have the contract-review agent review an attached
 * draft, let legal approve the redline before the Word file is made, and refuse to hand over a
 * review that leaves out a finding the playbook says must always be raised.
 *
 * One run chain. The agent reads the draft, runs the playbook check and `clauses.mjs redline`, and
 * `Write`s the redline paragraphs to `drafts/<team>/<name>_修正案.json`. That `Write` is the chain's only
 * gated call (ADR-0145), so the run pauses on it: `reviewContract` answers with the redline legal
 * reads (`awaiting_legal`) and nothing is built. Legal decides with `decideReview`: approving starts
 * a continuation that makes the same `Write`, builds the .docx and answers the risk rows; rejecting
 * with a comment sends the redline back and the revised one pauses again. The continuation keeps the
 * paused run's `outputSchema`.
 *
 * Nothing the agent wrote is trusted. The paused `Write` is untrusted JSON until it parses as
 * redline paragraphs. After the approval the must-flag check runs here, independently of the agent:
 * the backend already holds the draft's bytes (it uploaded them), so it reads the .docx with the
 * shared office-reader and runs the same `clauses.mjs check` the agent is told to run. Every finding
 * with `mustFlag: true` must appear in the agent's table as a row citing the same rule (〔PB-xx〕)
 * for the same clause, or, for an absence, any row citing the rule, and the .docx must carry a
 * 【修正案 PB-xx】 paragraph for it. A model that skips a step or forgets a row produces a refusal
 * that lists what is missing, instead of a clean-looking table.
 *
 * The redlined Word file is the agent's own: it writes `outputs/<draft>_修正案.docx` and the backend
 * collects it with `runs.outputs` and `files.download`. The backend builds no Word file.
 *
 * Who is asking decides what the run can reach. Contracts sit at `contracts/<deal-team>/<file>.docx`
 * and `data/access.json` says which teams each legal member belongs to. `reviewContract` starts the
 * run with `subject: <reviewer>` and a `fileScope` of the reviewer's `contracts/<team>` folders, the
 * playbook and the scratch folder `drafts/<team>`, so the platform shows the agent no other team's
 * contract and no other team's working files. The attachment is granted after that narrowing, so the
 * backend refuses, before any run, an attachment that is not one of this session's uploads under the
 * reviewer's own team folders. A member with no team gets no run at all.
 *
 * The rows arrive as structured output (`ContractReviewAnswerSchema`), next to the Markdown review
 * legal reads on the legal-desk page, so nothing is parsed out of the agent's prose: a row without
 * a citation or a valid risk fails the run instead of being read around.
 */
import path from 'node:path';

import type { AgentWorkspaceClient } from '@indx-workspace/sdk';
import { z } from 'zod';

import {
  pendingCall,
  readRun,
  runAndRead,
  RunAwaitingApproval,
  type AwaitingApproval,
} from '../../shared/run-answer.ts';
import { readDocx } from '@agent-workspace/skills-office/office-reader/scripts/ooxml.mjs';
import {
  check,
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

/** `data/access.json`: the deal teams (the folders under `contracts/`) each legal member may review. */
export type AccessList = Readonly<Record<string, { readonly teams: readonly string[] }>>;

/** A reviewer with no deal team, or an attachment outside their teams: no run is started. */
export class NoContractAccess extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'NoContractAccess';
  }
}

/** The deal teams `reviewer` belongs to, or a refusal before any run starts. */
function teamsOf(reviewer: string, access: AccessList): readonly string[] {
  const teams = Object.hasOwn(access, reviewer) ? (access[reviewer]?.teams ?? []) : [];
  if (teams.length === 0)
    throw new NoContractAccess(`${reviewer} は担当する案件チームがありません`);
  return teams;
}

/** The folders the reviewer may search and read: their teams' contracts and the playbook. */
export function fileScopeFor(reviewer: string, access: AccessList): string[] {
  return [...teamsOf(reviewer, access).map((team) => `contracts/${team}`), 'playbook'];
}

export interface ReviewRequest {
  /** The uploaded draft: its file id rides on the run, its name gives the redline's name. */
  readonly file: { readonly id: string; readonly name: string };
  /** The signed-in legal member: the run's `subject`; `access` sets their `fileScope`. */
  readonly reviewer: string;
  readonly access: AccessList;
  /** The workspace path each file id was uploaded to in this session; the browser sends only the id. */
  readonly uploads: ReadonlyMap<string, string>;
  /** The draft's bytes, as uploaded. */
  readonly docx: Buffer;
  readonly playbook: ReadonlyMap<string, PlaybookRule>;
}

/** What legal approves: the paragraphs of the redlined draft, as the agent's paused `Write` holds them. */
const RedlineSchema = z.object({
  paragraphs: z.array(z.object({ style: z.string().nullable(), text: z.string() })).min(1),
});
export type RedlineParagraphs = z.infer<typeof RedlineSchema>['paragraphs'];

/** The run paused on the redline's `Write`; decide it with {@link decideReview}. */
export interface AwaitingLegal extends Omit<AwaitingApproval, 'status'> {
  readonly status: 'awaiting_legal';
  /** The deal team of the attached draft: `drafts/<team>/` is the run's scratch folder. */
  readonly team: string;
  /** The redline in the paused `Write`, validated: what legal approves. */
  readonly redline: RedlineParagraphs;
  readonly request: ReviewRequest;
}

/** Legal approved, and the rows and the .docx cover every must-flag finding. */
export interface ContractReview {
  readonly status: 'reviewed';
  readonly rows: readonly RiskRow[];
  /** Rows covering a must-flag finding at a lower risk than the playbook's: shown, not refused. */
  readonly downgraded: readonly { readonly row: RiskRow; readonly finding: Finding }[];
  /** Rows citing a rule the playbook does not have. */
  readonly unknownRules: readonly string[];
  /** The redlined .docx the agent wrote to `outputs/`, as the run returns it. */
  readonly redline: { readonly name: string; readonly bytes: Uint8Array };
  /** The backend's own check of the draft, for the reviewer's screen. */
  readonly check: CheckResult;
  readonly answer: string;
  readonly runId: string;
  readonly sessionId: string;
}

/** A run that cannot be shown to legal, or a result that leaves out something the playbook requires. */
export interface ReviewRefused {
  readonly status: 'refused';
  readonly problems: readonly string[];
  /** Must-flag findings of the deterministic check that no row covers. */
  readonly missing: readonly Finding[];
  /** Must-flag findings the .docx has no 【修正案 PB-xx】 paragraph for. */
  readonly redlineMissing: readonly Finding[];
  readonly runId: string;
  readonly sessionId: string;
}

export type ReviewOutcome = AwaitingLegal | ContractReview | ReviewRefused;

const RISK_ORDER: Readonly<Record<Severity, number>> = { 低: 0, 中: 1, 高: 2 };

const RiskRowSchema = z.object({
  clause: z
    .string()
    .regex(/^第[0-9]+条$/u)
    .nullable()
    .describe('条項。算用数字で「第6条」の形。ドラフトに欠けている条項の行は null'),
  topic: z.string().describe('論点'),
  risk: z.enum(['高', '中', '低']).describe('リスク度'),
  reason: z.string().describe('理由。審査基準の根拠は〔PB-xx〕の形で添える'),
  rules: z
    .array(z.string().regex(/^PB-\d{2}$/u))
    .min(1)
    .describe('理由が根拠にした審査基準の番号（PB-xx）。1つ以上'),
  proposal: z.string().describe('修正文案'),
}) satisfies z.ZodType<RiskRow>;

/** What legal reads (`review`, the Markdown with the risk table) and what the backend checks (`rows`). */
export const ContractReviewAnswerSchema = z.object({
  review: z.string().describe('法務担当者が読むレビュー本文（リスク表を含む Markdown）'),
  rows: z.array(RiskRowSchema).describe('リスク表の各行。レビュー本文の表と同じ内容'),
});

const covers = (row: RiskRow, finding: Finding): boolean =>
  row.rules.includes(finding.rule) && (finding.clause === null || row.clause === finding.clause);

/** Compare the rows with the deterministic check: what is missing, what is rated lower. */
function enforceMustFlags(
  rows: readonly RiskRow[],
  result: CheckResult,
): { missing: Finding[]; downgraded: ContractReview['downgraded'] } {
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

/**
 * Must-flag findings the redlined .docx carries no 【修正案 PB-xx】 paragraph for. The redline is the
 * agent's file, so one that does not open as a .docx carries none of them.
 */
function redlineGaps(docx: Buffer, result: CheckResult): Finding[] {
  let text: string[];
  try {
    text = readDocx(docx).paragraphs.map((paragraph) => paragraph.text);
  } catch {
    text = [];
  }
  return result.findings.filter(
    (finding) =>
      finding.mustFlag && !text.some((line) => line.startsWith(`【修正案 ${finding.rule}】`)),
  );
}

/** The prompt the app sends: the draft is attached, and nothing here is a finding the agent could take. */
const reviewPrompt = (team: string): string =>
  `添付の契約書ドラフトを審査基準に照らしてレビューし、リスク表を作成してください。\n作業フォルダ: drafts/${team}/`;

/**
 * The deal team of the attached draft, or a refusal. Attachments are granted after `fileScope`
 * narrows, so the scope alone would let a reviewer attach another team's contract by its id: the id
 * must be one this session uploaded, into a folder of the reviewer's own teams.
 */
function teamOfAttachment(request: ReviewRequest): string {
  const teams = teamsOf(request.reviewer, request.access);
  const uploaded = request.uploads.get(request.file.id);
  const team =
    uploaded !== undefined && path.posix.normalize(uploaded) === uploaded
      ? teams.find((name) => uploaded.startsWith(`contracts/${name}/`))
      : undefined;
  if (team === undefined) {
    throw new NoContractAccess(`${request.reviewer} はこの添付ファイルを審査できません`);
  }
  return team;
}

const redlineName = (request: ReviewRequest): string =>
  `${path.basename(request.file.name, '.docx')}_修正案`;

const refusal = (
  run: { readonly id: string; readonly sessionId: string },
  problems: readonly string[],
): ReviewRefused => ({
  status: 'refused',
  problems,
  missing: [],
  redlineMissing: [],
  runId: run.id,
  sessionId: run.sessionId,
});

/**
 * The redline in the call the run is paused on, checked before legal is asked to approve it: it
 * must be the redline's file and parse as paragraphs.
 */
function awaitingFrom(
  paused: AwaitingApproval,
  request: ReviewRequest,
  team: string,
): AwaitingLegal | ReviewRefused {
  const file = `drafts/${team}/${redlineName(request)}.json`;
  const run = { id: paused.runId, sessionId: paused.sessionId };
  const { name, input } = pendingCall(paused.call);
  const content = input['content'];
  if (name !== 'Write' || input['file_path'] !== file || typeof content !== 'string') {
    return refusal(run, [`${name} が ${file} 以外を書こうとして止まった`]);
  }
  let json: unknown;
  try {
    json = JSON.parse(content);
  } catch {
    return refusal(run, [`${file} が JSON ではない`]);
  }
  const parsed = RedlineSchema.safeParse(json);
  if (!parsed.success) {
    return refusal(
      run,
      parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
    );
  }
  return { ...paused, status: 'awaiting_legal', team, redline: parsed.data.paragraphs, request };
}

/** Read a run that should pause on the redline: the next redline for legal, or a refusal. */
async function untilLegal(
  reading: ReturnType<typeof readRun>,
  request: ReviewRequest,
  team: string,
): Promise<AwaitingLegal | ReviewRefused> {
  try {
    const { run } = await reading;
    return refusal(run, ['エージェントが修正案を書かずに終わりました']);
  } catch (error) {
    if (!(error instanceof RunAwaitingApproval)) throw error;
    return awaitingFrom(error.pending, request, team);
  }
}

/**
 * Ask `agentId` to review the attached draft. The agent's `Write` of the redline is gated, so the
 * answer is the pause with the validated redline, to be decided with {@link decideReview}; no Word
 * file exists yet. A run that ends without a redline, or pauses on something else, comes back
 * `refused`.
 *
 * @throws {NoContractAccess} before any run, when `access` gives the reviewer no team or the
 *   attachment is not an upload of this session under one of their teams' folders.
 */
export async function reviewContract(
  aw: AgentWorkspaceClient,
  agentId: string,
  request: ReviewRequest,
  sessionId?: string,
): Promise<AwaitingLegal | ReviewRefused> {
  const team = teamOfAttachment(request);
  return untilLegal(
    runAndRead(
      aw,
      agentId,
      {
        subject: request.reviewer,
        fileScope: [...fileScopeFor(request.reviewer, request.access), `drafts/${team}`],
        prompt: reviewPrompt(team),
        attachments: [{ fileId: request.file.id }],
        sessionId: sessionId ?? null,
      },
      ContractReviewAnswerSchema,
    ),
    request,
    team,
  );
}

/**
 * Legal decided the paused redline. Rejecting (with a comment saying what to change) starts a
 * continuation that revises it, so the answer is the next pause. Approving starts the continuation
 * that builds the Word file and answers the rows; they are returned only when the must-flag check
 * passes, otherwise the refusal lists what is missing. The continuation keeps the paused run's
 * `subject` and `fileScope` on the server (ADR-0157), so the reviewer's scope is not asked for again.
 */
export async function decideReview(
  aw: AgentWorkspaceClient,
  awaiting: AwaitingLegal,
  decision: { readonly approve: boolean; readonly comment?: string },
): Promise<ReviewOutcome> {
  const input = decision.comment === undefined ? {} : { comment: decision.comment };
  const { run } = decision.approve
    ? await aw.runs.approve(awaiting.runId, input)
    : await aw.runs.reject(awaiting.runId, input);
  const { request } = awaiting;
  const reading = readRun(aw, run.id, ContractReviewAnswerSchema);
  if (!decision.approve) return untilLegal(reading, request, awaiting.team);

  const { run: settled, output } = await reading;
  const deterministic = check(readDocx(request.docx).paragraphs, request.playbook);
  const { missing, downgraded } = enforceMustFlags(output.rows, deterministic);
  const unknownRules = [
    ...new Set(
      output.rows.flatMap((row) => row.rules).filter((rule) => !request.playbook.has(rule)),
    ),
  ];
  const name = `${redlineName(request)}.docx`;
  const written = (await aw.runs.outputs(settled.id)).find((file) => file.name === name);
  const downloaded = written === undefined ? null : await aw.files.download(written.path);
  const bytes = downloaded?.kind === 'file' ? downloaded.bytes : null;
  const redlineMissing = bytes === null ? [] : redlineGaps(Buffer.from(bytes), deterministic);

  const problems = [
    ...missing.map(
      (finding) => `〔${finding.rule}〕${finding.clause ?? '欠落'} のリスク表の行がありません`,
    ),
    ...(bytes === null ? [`outputs/${name} を書いていません`] : []),
    ...redlineMissing.map((finding) => `${name} に 【修正案 ${finding.rule}】 がありません`),
  ];
  if (bytes === null || problems.length > 0) {
    return { ...refusal(settled, problems), missing, redlineMissing };
  }
  return {
    status: 'reviewed',
    rows: output.rows,
    downgraded,
    unknownRules,
    redline: { name, bytes },
    check: deterministic,
    answer: output.review,
    runId: settled.id,
    sessionId: settled.sessionId,
  };
}
