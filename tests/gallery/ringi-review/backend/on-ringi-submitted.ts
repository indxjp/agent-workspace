/**
 * The hook the workflow system calls when a ringi (稟議) is filed or revised: review it with the
 * ringi-review agent and post the review sheet back as a comment.
 *
 * Agent Workspace has no inbound trigger (probe `inbound-trigger`), so this is your own endpoint;
 * and `runs.start` takes no idempotency key (probe `run-start-idempotency`), so a webhook the
 * workflow system retries would start a second, billed run that posts a second comment. The hook
 * therefore claims `ringiId@revision` in a store you own before it starts anything.
 *
 * It then does what a model must not be trusted to do alone:
 * - re-derives the 決裁区分 from the same authority matrix `check_authority` uses and flags a sheet
 *   whose route differs, because a wrong route sends the ringi to the wrong approver;
 * - lists the required fields the submission lacks, deterministically, and flags any the agent
 *   left out of 記載漏れ;
 * - checks every citation against what the tools returned during the run.
 *
 * Posting is yours too: an `openapiTool` may only read (probe `openapi-write`), and an agent that
 * can write to the workflow system could also approve in it. The agent stays read-only; this code,
 * not the model, writes the comment.
 */
import type { AgentWorkspaceClient } from '@indx-workspace/sdk';

import { parseCitations, type Citation } from '../../shared/citations.ts';
import { runAndRead } from '../../shared/run-answer.ts';
import {
  requiredApprover,
  type AuthorityDecision,
  type AuthorityMatrix,
} from '../mcp/authority.mjs';
import { parseReviewSheet, type ReviewSheet } from './review-sheet.ts';

/** The fields the workflow system sends. Optional ones may be blank: that is what 記載漏れ is for. */
export interface RingiSubmission {
  readonly ringiId: string;
  readonly revision: number;
  readonly title: string;
  readonly category: string;
  /** 税抜, in yen (職務権限規程 §2.1). */
  readonly amountYen: number;
  readonly department: string;
  readonly applicant?: string;
  readonly purpose?: string;
  readonly effect?: string;
  readonly paymentTerms?: string;
  readonly plannedDate?: string;
  /** How many quotes are attached (相見積). */
  readonly quotes?: number;
  readonly soleSourceReason?: string;
  readonly inBudget?: boolean;
}

/** The 稟議規程 §4.1 fields the hook can check without a model, with the label the sheet uses. */
const REQUIRED: readonly (readonly [keyof RingiSubmission, string])[] = [
  ['applicant', '起案者'],
  ['purpose', '目的'],
  ['effect', '期待効果'],
  ['paymentTerms', '支払条件'],
  ['plannedDate', '実施予定日'],
];

export class InvalidSubmission extends Error {
  public constructor(public readonly fields: readonly string[]) {
    super(`invalid ringi submission: ${fields.join(', ')}`);
    this.name = 'InvalidSubmission';
  }
}

const RINGI_ID = /^R-\d{4}-\d{4}$/u;

/** Validate the webhook body. Throws `InvalidSubmission` naming the bad fields, never the values. */
export function parseSubmission(body: unknown): RingiSubmission {
  if (typeof body !== 'object' || body === null) throw new InvalidSubmission(['body']);
  const value = body as Record<string, unknown>;
  const bad: string[] = [];
  const nonBlank = (key: string): void => {
    if (typeof value[key] !== 'string' || value[key].trim() === '') bad.push(key);
  };
  if (typeof value['ringiId'] !== 'string' || !RINGI_ID.test(value['ringiId'])) bad.push('ringiId');
  if (!Number.isSafeInteger(value['revision']) || (value['revision'] as number) < 1)
    bad.push('revision');
  if (!Number.isSafeInteger(value['amountYen']) || (value['amountYen'] as number) < 0)
    bad.push('amountYen');
  nonBlank('title');
  nonBlank('category');
  nonBlank('department');
  for (const key of [
    'applicant',
    'purpose',
    'effect',
    'paymentTerms',
    'plannedDate',
    'soleSourceReason',
  ]) {
    if (value[key] !== undefined && typeof value[key] !== 'string') bad.push(key);
  }
  if (value['quotes'] !== undefined && !Number.isSafeInteger(value['quotes'])) bad.push('quotes');
  if (value['inBudget'] !== undefined && typeof value['inBudget'] !== 'boolean')
    bad.push('inBudget');
  if (bad.length > 0) throw new InvalidSubmission(bad);
  return value as unknown as RingiSubmission;
}

const blank = (value: unknown): boolean => typeof value !== 'string' || value.trim() === '';
const yen = (amount: number): string => `${amount.toLocaleString('ja-JP')}円`;

/** The run's prompt: every field, with （未記載） where the submission is blank. */
export function promptFor(ringi: RingiSubmission): string {
  const field = (value: string | number | undefined): string =>
    value === undefined || (typeof value === 'string' && value.trim() === '')
      ? '（未記載）'
      : String(value);
  return [
    `次の稟議をレビューし、ringi-checklist の書式でレビューシートを書いてください。`,
    `稟議ID: ${ringi.ringiId} rev.${String(ringi.revision)}`,
    `件名: ${ringi.title}`,
    `区分: ${ringi.category}`,
    `金額（税抜）: ${yen(ringi.amountYen)}（amountYen=${String(ringi.amountYen)}）`,
    `起案部門: ${ringi.department}`,
    `起案者: ${field(ringi.applicant)}`,
    `目的: ${field(ringi.purpose)}`,
    `期待効果: ${field(ringi.effect)}`,
    `支払条件: ${field(ringi.paymentTerms)}`,
    `実施予定日: ${field(ringi.plannedDate)}`,
    `見積社数: ${field(ringi.quotes)}`,
    `特命理由: ${field(ringi.soleSourceReason)}`,
    `予算: ${ringi.inBudget === undefined ? '（未記載）' : ringi.inBudget ? '予算内' : '予算外'}`,
  ].join('\n');
}

/**
 * Where the hook remembers which ringi revisions it has handled. In production this is a table
 * with a unique key on `key` (an INSERT that fails on conflict is the claim); the in-memory one
 * below is for tests and a single-process dev server.
 */
export type KeyState =
  | { readonly state: 'new' }
  | { readonly state: 'in-progress' }
  | { readonly state: 'reviewed'; readonly comment: string; readonly posted: boolean };

export interface ProcessedKeyStore {
  /** Atomically claim `key`. Returns `new` exactly once per key; later calls see its state. */
  claim(key: string): Promise<KeyState>;
  /** Keep the comment before posting it, so a failed post is retried without a second run. */
  saveReview(key: string, comment: string): Promise<void>;
  markPosted(key: string): Promise<void>;
  /** Forget a claim whose run failed, so the workflow system's retry can try again. */
  release(key: string): Promise<void>;
}

export function memoryKeyStore(): ProcessedKeyStore {
  const states = new Map<string, KeyState>();
  return {
    claim: (key) => {
      const found = states.get(key);
      if (found !== undefined) return Promise.resolve(found);
      states.set(key, { state: 'in-progress' });
      return Promise.resolve({ state: 'new' });
    },
    saveReview: (key, comment) => {
      states.set(key, { state: 'reviewed', comment, posted: false });
      return Promise.resolve();
    },
    markPosted: (key) => {
      const found = states.get(key);
      if (found?.state === 'reviewed') states.set(key, { ...found, posted: true });
      return Promise.resolve();
    },
    release: (key) => {
      states.delete(key);
      return Promise.resolve();
    },
  };
}

export interface HookDependencies {
  readonly aw: AgentWorkspaceClient;
  readonly agentId: string;
  readonly store: ProcessedKeyStore;
  readonly matrix: AuthorityMatrix;
  /** Your workflow system's comment API. Agent Workspace cannot call it for you. */
  readonly postComment: (ringiId: string, revision: number, body: string) => Promise<void>;
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
  readonly unverified: readonly Citation[];
  readonly runId: string;
  readonly sessionId: string;
}

export type HookResult =
  | {
      readonly status: 'reviewed';
      readonly key: string;
      readonly review: Review;
      readonly comment: string;
    }
  /** The review was kept but its post failed earlier; this retry posted it without a new run. */
  | { readonly status: 'reposted'; readonly key: string; readonly comment: string }
  /** Already handled or being handled: nothing was started or posted. */
  | { readonly status: 'duplicate'; readonly key: string };

const toolIs = (name: string, tool: string): boolean => name === tool || name.endsWith(`__${tool}`);
const CITING_TOOLS = ['read_rule', 'check_authority', 'get_ringi'];

export function commentFor(ringi: RingiSubmission, review: Review, sheetText: string): string {
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
      `⚠ 根拠を確認できない出典: ${review.unverified.map((c) => `〔${c.raw}〕`).join('')}`,
    );
  }
  if (review.sheet.missingSections.length > 0) {
    warnings.push(
      `⚠ レビューシートに見出しがありません: ${review.sheet.missingSections.join('、')}`,
    );
  }
  return [
    `【AI稟議レビュー】${ringi.ringiId} rev.${String(ringi.revision)}（参考情報です。承認・否決の判断はしていません）`,
    ...warnings,
    '',
    sheetText.trim(),
  ].join('\n');
}

/** Review `ringi` once per revision and post the sheet back. */
export async function onRingiSubmitted(body: unknown, deps: HookDependencies): Promise<HookResult> {
  const ringi = parseSubmission(body);
  const key = `${ringi.ringiId}@${String(ringi.revision)}`;
  const claimed = await deps.store.claim(key);
  if (claimed.state === 'in-progress') return { status: 'duplicate', key };
  if (claimed.state === 'reviewed') {
    if (claimed.posted) return { status: 'duplicate', key };
    await deps.postComment(ringi.ringiId, ringi.revision, claimed.comment);
    await deps.store.markPosted(key);
    return { status: 'reposted', key, comment: claimed.comment };
  }

  const reading = await runAndRead(deps.aw, deps.agentId, { prompt: promptFor(ringi) }).catch(
    async (error: unknown) => {
      await deps.store.release(key);
      throw error;
    },
  );

  const sheet = parseReviewSheet(reading.answer);
  const expected = requiredApprover(deps.matrix, ringi.category, ringi.amountYen);
  const authority: AuthorityCheck = {
    expected,
    written: sheet.approver,
    matches: expected !== null && sheet.approver === expected.approver,
    toolCalled: reading.toolCalls.some((call) => toolIs(call.name, 'check_authority')),
  };

  const missingFields = REQUIRED.filter(([field]) => blank(ringi[field])).map(([, label]) => label);
  const omissions = sheet.sections.記載漏れ.map((finding) => finding.text).join('\n');
  const missedByAgent = missingFields.filter((label) => !omissions.includes(label));

  const returned = new Set(
    reading.toolCalls
      .filter((call) => CITING_TOOLS.some((tool) => toolIs(call.name, tool)) && !call.isError)
      .flatMap((call) => parseCitations(call.output ?? '').map((citation) => citation.raw)),
  );
  const unverified = Object.values(sheet.sections)
    .flat()
    .flatMap((finding) => finding.citations)
    .filter((citation) => !returned.has(citation.raw));

  const review: Review = {
    sheet,
    authority,
    missingFields,
    missedByAgent,
    unverified,
    runId: reading.run.id,
    sessionId: reading.run.sessionId,
  };
  const comment = commentFor(ringi, review, reading.answer);
  await deps.store.saveReview(key, comment);
  await deps.postComment(ringi.ringiId, ringi.revision, comment);
  await deps.store.markPosted(key);
  return { status: 'reviewed', key, review, comment };
}
