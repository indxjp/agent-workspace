/**
 * Review a ringi (稟議) the workflow system filed: `startReview` starts one run for the person who
 * filed it, with the quotes attached and the review sheet as its `outputSchema` (ADR-0143), and
 * `reviewRun` checks that sheet.
 *
 * `RINGI_TRIGGER` is the same review as a webhook trigger (ADR-0144): the platform dedupes on
 * `ringiId@revision` and types the answer (ADR-0154). A trigger's `subject` is one fixed caller
 * (ADR-0156), but the filer differs per ringi, and a trigger cannot carry the quotes as attachments
 * or a `fileScope`, so the backend starts the run itself, narrowed to the filer's departments, with
 * `ringiId@revision` as the `Idempotency-Key` (ADR-0151) so a retried filing starts no second run.
 *
 * What stays here is what a model must not be trusted to do alone:
 * - narrows the run to the filer's files (`fileScope`): the `ringi/<部門>` folders their department
 *   list allows plus the rule book, and refuses to start when they may read no department;
 * - re-derives the 決裁区分 from the same authority matrix `check_authority` uses and flags a sheet
 *   whose route differs, because a wrong route sends the ringi to the wrong approver;
 * - lists the required fields the submission lacks, deterministically, and flags any the agent
 *   left out of 記載漏れ;
 * - checks every citation against what the tools returned during the run.
 *
 * The comment is posted by the agent through the `workflow` tool (`../tools/workflow.ts`), whose one
 * admitted operation is `postComment`; `approveRequest` / `rejectRequest` are not admitted, so the
 * agent can comment but not decide. The review run does not post: `postReview` starts a second run
 * in the same session that posts exactly `commentFor`'s text, the sheet with this code's warnings.
 * `postComment` is a write, so that run pauses until a person approves the call, and `postReview`
 * answers the pause with the run id. `decidePost` drives the decision: `runs.approve` starts a
 * continuation that posts the approved call for the filer (the platform forwards the paused run's
 * subject, ADR-0157), and `runs.reject` starts one that posts nothing.
 */
import { canonicalCall } from '@indx-workspace/contracts/agents';
import type { AgentWorkspaceClient } from '@indx-workspace/sdk';

import { parseCitations } from '../../shared/citations.ts';
import {
  readRun,
  runAndRead,
  RunAwaitingApproval,
  type AwaitingApproval,
  type ToolCall,
} from '../../shared/run-answer.ts';
import {
  requiredApprover,
  type AuthorityDecision,
  type AuthorityMatrix,
} from '../mcp/authority.mjs';
import { renderReviewSheet, ReviewSheetSchema, type ReviewSheet } from './review-sheet.ts';

/**
 * The workflow system's own record of the ringi it filed. It is what the system posted to the
 * trigger, held in the system's database and typed, so nothing here parses a webhook body. Optional
 * fields may be blank: that is what 記載漏れ is for.
 */
export interface RingiSubmission {
  readonly ringiId: string;
  readonly revision: number;
  readonly title: string;
  readonly category: string;
  /** 税抜, in yen (職務権限規程 §2.1). */
  readonly amountYen: number;
  readonly department: string;
  /** Who filed it, as the workflow system's own session says; the run's `subject`. */
  readonly submittedBy: string;
  /** The 起案者 field of the form: typed text, and blank is a finding. */
  readonly applicant?: string;
  readonly purpose?: string;
  readonly effect?: string;
  readonly paymentTerms?: string;
  readonly plannedDate?: string;
  /** The quotes (見積書, 相見積) as uploaded files; the run reads them. */
  readonly quotes?: readonly { readonly fileId: string }[];
  readonly soleSourceReason?: string;
  readonly inBudget?: boolean;
}

/** The 稟議規程 §4.1 fields the backend can check without a model, with the label the sheet uses. */
const REQUIRED: readonly (readonly [keyof RingiSubmission, string])[] = [
  ['applicant', '起案者'],
  ['purpose', '目的'],
  ['effect', '期待効果'],
  ['paymentTerms', '支払条件'],
  ['plannedDate', '実施予定日'],
];

/**
 * The trigger the workflow system calls (ADR-0144): create it once, then point the system's webhook
 * at the `firePath` it returns, with the ringi as the JSON body and `ringiId@revision` as the
 * `Idempotency-Key`. The platform dedupes on that key, so a retried post starts no second run. The
 * body is untrusted text that is substituted and never parsed. `outputSchema` makes every run it
 * starts answer in the review sheet (ADR-0154); the SDK sends the Zod type as JSON Schema.
 */
export const RINGI_TRIGGER = {
  kind: 'webhook',
  name: 'ringi-review',
  prompt: [
    '次の稟議をレビューし、ringi-checklist の書式でレビューシートを書いてください。',
    'ワークフローが送った稟議（JSON。区分と金額はそのまま職務権限の判定に使う）:',
    '{{body}}',
  ].join('\n'),
  outputSchema: ReviewSheetSchema,
} as const;

const blank = (value: unknown): boolean => typeof value !== 'string' || value.trim() === '';

/** `data/access.json`: for each person, the departments whose past ringi they may read. */
export type AccessList = Readonly<Record<string, { readonly departments: readonly string[] }>>;

export interface ReviewDependencies {
  readonly aw: AgentWorkspaceClient;
  /** The ringi-review agent. */
  readonly agentId: string;
  readonly matrix: AuthorityMatrix;
  readonly access: AccessList;
}

export interface AuthorityCheck {
  /** What the matrix requires for the submitted category and amount; null for an unknown category. */
  readonly expected: AuthorityDecision | null;
  /** The approver the sheet's 決裁区分 line names, or null when it names none. */
  readonly written: string | null;
  readonly matches: boolean;
  /** Whether the agent called `check_authority` at all during the run. */
  readonly toolCalled: boolean;
}

export interface Review {
  readonly sheet: ReviewSheet;
  readonly authority: AuthorityCheck;
  /** Required fields the submission leaves blank (稟議規程 §4.1), found without a model. */
  readonly missingFields: readonly string[];
  /** Of those, the ones the sheet's 記載漏れ does not mention. */
  readonly missedByAgent: readonly string[];
  /** Citations on the sheet that no tool returned during the run. */
  readonly unverified: readonly string[];
  readonly runId: string;
  readonly sessionId: string;
}

const toolIs = (name: string, tool: string): boolean => name === tool || name.endsWith(`__${tool}`);
// A rule clause and a past ringi carry their own 〔出典〕 line; the model sees it in what it reads.
const CITING_TOOLS = ['check_authority', 'search_files', 'Read'];

/**
 * The paths a review run may search and read for `subject`: the `ringi/<部門>` folder of every
 * department they may read, plus `rules` (the rule book is the same for everyone). A person who
 * may read no department gets no scope, and the caller starts no run.
 */
export function fileScopeFor(subject: string, access: AccessList): string[] {
  const departments = access[subject]?.departments ?? [];
  if (departments.length === 0) {
    throw new Error(`${subject} may read no department's ringi, so no review was started`);
  }
  return [...departments.map((department) => `ringi/${department}`), 'rules'];
}

export function commentFor(ringi: RingiSubmission, review: Review): string {
  const { authority } = review;
  const warnings: string[] = [];
  if (authority.expected === null) {
    warnings.push(
      `⚠ 区分「${ringi.category}」は職務権限規程の別表にありません。経営企画部長が決裁区分を定めます。`,
    );
  } else if (!authority.matches) {
    warnings.push(
      `⚠ 決裁区分の不一致: レビューシートは「${authority.written ?? '記載なし'}」、職務権限規程の判定は「${authority.expected.route}」${authority.expected.clause}です。規程の判定に従ってください。`,
    );
  }
  if (review.missedByAgent.length > 0) {
    warnings.push(
      `⚠ レビューシートが挙げていない記載漏れ: ${review.missedByAgent.join('、')}〔稟議規程 §4.1〕`,
    );
  }
  if (review.unverified.length > 0) {
    warnings.push(
      `⚠ 根拠を確認できない出典: ${review.unverified.map((citation) => `〔${citation}〕`).join('')}`,
    );
  }
  return [
    `【AI稟議レビュー】${ringi.ringiId} rev.${String(ringi.revision)}（参考情報です。承認・否決の判断はしていません）`,
    ...warnings,
    '',
    renderReviewSheet(review.sheet),
  ].join('\n');
}

/**
 * Start the review of `ringi`: one run for the person who filed it, narrowed to the precedents they
 * may see (`fileScope`), with the quotes attached and the sheet as its `outputSchema`. Call it once
 * per revision and keep the run id with the ringi. The `Idempotency-Key` is `ringiId@revision`, so
 * filing the same revision again, even at the same moment, answers the run already started.
 */
export async function startReview(
  ringi: RingiSubmission,
  deps: ReviewDependencies,
): Promise<string> {
  const fileScope = fileScopeFor(ringi.submittedBy, deps.access);
  const { run } = await deps.aw.runs.start(deps.agentId, {
    prompt: RINGI_TRIGGER.prompt.replace('{{body}}', () => JSON.stringify(ringi)),
    subject: ringi.submittedBy,
    fileScope,
    idempotencyKey: `${ringi.ringiId}@${String(ringi.revision)}`,
    outputSchema: ReviewSheetSchema,
    ...(ringi.quotes === undefined
      ? {}
      : { attachments: ringi.quotes.map(({ fileId }) => ({ fileId })) }),
  });
  return run.id;
}

/**
 * Read the review run started for `ringi` and check its sheet. `runId` is the id {@link startReview}
 * answered, kept with the ringi. The comment it returns is the sheet with the warnings; post it
 * with {@link postReview}.
 *
 * @throws {RunAwaitingApproval} when the review run itself tried to post: reject that call, because
 * its comment carries none of this code's warnings.
 */
export async function reviewRun(
  runId: string,
  ringi: RingiSubmission,
  deps: ReviewDependencies,
): Promise<{ readonly review: Review; readonly comment: string }> {
  const reading = await readRun(deps.aw, runId, ReviewSheetSchema);

  const sheet = reading.output;
  const expected = requiredApprover(deps.matrix, ringi.category, ringi.amountYen);
  const authority: AuthorityCheck = {
    expected,
    written: sheet.決裁区分.approver,
    matches: expected !== null && sheet.決裁区分.approver === expected.approver,
    toolCalled: reading.toolCalls.some((call) => toolIs(call.name, 'check_authority')),
  };

  const missingFields = REQUIRED.filter(([field]) => blank(ringi[field])).map(([, label]) => label);
  const omissions = sheet.記載漏れ.map((finding) => finding.text).join('\n');
  const missedByAgent = missingFields.filter((label) => !omissions.includes(label));

  const returned = new Set(
    reading.toolCalls
      .filter((call) => CITING_TOOLS.some((tool) => toolIs(call.name, tool)) && !call.isError)
      .flatMap((call) => parseCitations(call.output ?? '').map((citation) => citation.raw)),
  );
  // The ringi-checklist skill also writes 〔…〕 inline in each finding; those reach the approver
  // too, so they are checked like the typed ones.
  const cited = [
    ...[sheet.記載漏れ, sheet.規程との照合, sheet.類似案件]
      .flat()
      .flatMap((finding) => [
        ...finding.citations,
        ...parseCitations(finding.text).map((citation) => citation.raw),
      ]),
    sheet.決裁区分.clause,
  ];
  const unverified = cited.filter((citation) => !returned.has(citation));

  const review: Review = {
    sheet,
    authority,
    missingFields,
    missedByAgent,
    unverified,
    runId: reading.run.id,
    sessionId: reading.run.sessionId,
  };
  return { review, comment: commentFor(ringi, review) };
}

/**
 * What {@link postReview} answers: the post run paused for a person to approve the comment, with
 * `exact` saying whether the paused call is this code's comment unchanged (offer approval only
 * then); or the run settled, `posted` when a `postComment` call succeeded in it.
 */
export type PostOutcome = PostPaused | PostSettled;

export type PostPaused = AwaitingApproval & { readonly exact: boolean };
export type PostSettled = { readonly status: 'posted' | 'not_posted'; readonly runId: string };

/**
 * Post `comment` (what {@link reviewRun} answered) on the ringi: a run in the review's session, for
 * the filer, that is told to call `postComment` with exactly this body. The call is a write, so the
 * run pauses at `awaiting_approval` and nothing reaches the workflow system until a person approves.
 */
export async function postReview(
  ringi: RingiSubmission,
  posting: { readonly review: Review; readonly comment: string },
  deps: ReviewDependencies,
): Promise<PostOutcome> {
  const args = {
    requestId: ringi.ringiId,
    body: { revision: ringi.revision, body: posting.comment },
  };
  const prompt = [
    '次の JSON の requestId と body を、一字も変えずに postComment に渡し、稟議にコメントを投稿してください。',
    '```json',
    JSON.stringify(args, null, 2),
    '```',
  ].join('\n');
  try {
    const reading = await runAndRead(deps.aw, deps.agentId, {
      prompt,
      subject: ringi.submittedBy,
      fileScope: fileScopeFor(ringi.submittedBy, deps.access),
      sessionId: posting.review.sessionId,
    });
    return settledPost(reading);
  } catch (error) {
    if (!(error instanceof RunAwaitingApproval)) throw error;
    const { pending } = error;
    return {
      ...pending,
      exact: pending.call.canonicalCall === canonicalCall(pending.call.toolName, args),
    };
  }
}

/** `posted` when a `postComment` call succeeded in the run, else `not_posted`. */
function settledPost(reading: {
  run: { id: string };
  toolCalls: readonly ToolCall[];
}): PostSettled {
  const posted = reading.toolCalls.some(
    (call) => toolIs(call.name, 'postComment') && !call.isError && call.output !== null,
  );
  return { status: posted ? 'posted' : 'not_posted', runId: reading.run.id };
}

/**
 * The person decided the paused post. Approving starts the continuation that makes the approved
 * call, so it is refused when the paused call is not the checked comment (`exact` is false);
 * rejecting starts one that posts nothing, whatever the call was. Either way the result is read
 * from the continuation, never assumed.
 *
 * @throws {Error} when asked to approve a call that is not the checked comment.
 */
export async function decidePost(
  aw: AgentWorkspaceClient,
  awaiting: PostPaused,
  decision: { readonly approve: boolean; readonly comment?: string },
): Promise<PostSettled> {
  if (decision.approve && !awaiting.exact) {
    throw new Error(`run ${awaiting.runId} paused on a call that is not the checked comment`);
  }
  const input = decision.comment === undefined ? {} : { comment: decision.comment };
  const { run } = decision.approve
    ? await aw.runs.approve(awaiting.runId, input)
    : await aw.runs.reject(awaiting.runId, input);
  return settledPost(await readRun(aw, run.id));
}
