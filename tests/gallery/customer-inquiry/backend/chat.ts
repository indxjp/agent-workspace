/**
 * The company site's chat backend: one call per message the signed-in customer sends.
 *
 * It does four things the platform does not:
 *
 * 1. **Says who the customer is.** The site's own session knows the signed-in customer; the agent
 *    and its connector do not (a connector's credential is the agent's, RF-102). The backend mints
 *    a short-lived signed token for that customer and puts it in the prompt; the CRM server
 *    refuses any history call whose token does not verify or names someone else.
 * 2. **Keeps the conversation.** The first message starts a session; every later message passes
 *    the same `sessionId`, so the agent remembers what was said.
 * 3. **Routes handoffs.** A run has no handoff event, so the backend reads the answer: the skill's
 *    phrase 「担当者におつなぎします」 and its 〔引継ぎ: 理由〕 tag become `{ handoff: true, reason }`
 *    for the operator queue.
 * 4. **Checks the answer before it leaves.** No phone number, e-mail or address pattern and no
 *    refund promise may reach the customer, whatever the model wrote. A withheld answer is
 *    replaced by a handoff, never shown.
 */
import type { AgentWorkspaceClient } from '@indx-workspace/sdk';

import { runAndRead, type ToolCall } from '../../shared/run-answer.ts';
import { mintCustomerToken } from '../lib/customer-token.mjs';
import { findPii, type PiiFinding } from '../lib/pii.mjs';

export const HANDOFF_PHRASE = '担当者におつなぎします';

export const HANDOFF_REASONS = ['identity', 'refund', 'complaint', 'other', 'guard'] as const;
export type HandoffReason = (typeof HANDOFF_REASONS)[number];

const REASON_TAGS: Readonly<Record<string, HandoffReason>> = {
  本人確認: 'identity',
  返金: 'refund',
  苦情: 'complaint',
  その他: 'other',
};

/** Promises only an operator may make (the skill bans them; the backend enforces it). */
const REFUND_PROMISE = /返金(?:いた|致)?します|返金させていただきます|全額お返し|補償いたします/u;

/** The company's own numbers, which an answer may give. */
const PUBLIC_NUMBERS = ['0120-555-310'];

const WITHHELD_ANSWER =
  '恐れ入りますが、このご質問はチャットではお答えできません。担当者におつなぎします。少々お待ちください。';

export interface ChatInput {
  /** The signed-in customer, from the site's own session. Never from the chat text. */
  readonly customerId: string;
  readonly message: string;
  /** The conversation's session; omit on the first message. */
  readonly sessionId?: string;
  /** The HMAC secret shared with the CRM server, at least 32 characters. */
  readonly tokenSecret: string;
  /** Seconds since the epoch; tests pin it. */
  readonly now?: number;
}

export interface ChatReply {
  /** What the widget shows the customer. */
  readonly text: string;
  readonly sessionId: string;
  /** The run, for `aw runs rate` when the customer presses thumbs-down. */
  readonly runId: string;
  readonly handoff: boolean;
  /** Why the conversation goes to an operator; null when it does not. */
  readonly reason: HandoffReason | null;
  /** Set when the guard replaced the agent's answer: what it found (never shown to the customer). */
  readonly withheld: {
    readonly pii: readonly PiiFinding[];
    readonly refundPromise: boolean;
  } | null;
  /** The interactions the agent read, so the operator opens the same records. */
  readonly interactionsRead: readonly string[];
  /** The searches the agent wrote, in order, for reviewing how it looked. */
  readonly queries: readonly string[];
}

const toolIs = (call: ToolCall, tool: string): boolean =>
  call.name === tool || call.name.endsWith(`__${tool}`);

function field(call: ToolCall, key: string): string | null {
  const value = (call.input as Record<string, unknown> | null)?.[key];
  return typeof value === 'string' ? value : null;
}

/** The prompt one turn sends: the backend's session header, then the customer's words. */
export function composePrompt(customerId: string, token: string, message: string): string {
  return [
    '【顧客セッション】',
    `customerId: ${customerId}`,
    `token: ${token}`,
    '',
    '【お客様のメッセージ】',
    message,
  ].join('\n');
}

/** Read `〔引継ぎ: 理由〕` from an answer that hands off; `other` when the tag is missing. */
export function handoffReason(answer: string): HandoffReason | null {
  if (!answer.includes(HANDOFF_PHRASE)) return null;
  const tag = /〔引継ぎ[:：]\s*([^〕]+)〕/u.exec(answer)?.[1]?.trim();
  return (tag === undefined ? undefined : REASON_TAGS[tag]) ?? 'other';
}

/** Remove the routing tag before the customer sees the answer. */
const withoutTag = (answer: string): string =>
  answer.replace(/\s*〔引継ぎ[:：][^〕]*〕/gu, '').trim();

export async function chat(
  aw: AgentWorkspaceClient,
  agentId: string,
  input: ChatInput,
): Promise<ChatReply> {
  const message = input.message.trim();
  if (message === '') throw new Error('message must not be empty');
  const token = mintCustomerToken(input.tokenSecret, input.customerId, {
    ...(input.now === undefined ? {} : { now: input.now }),
  });
  const reading = await runAndRead(aw, agentId, {
    prompt: composePrompt(input.customerId, token, message),
    sessionId: input.sessionId ?? null,
  });

  const interactionsRead = reading.toolCalls
    .filter((call) => toolIs(call, 'get_interaction') && !call.isError)
    .flatMap((call) => field(call, 'id') ?? []);
  const queries = reading.toolCalls
    .filter((call) => toolIs(call, 'search_history') || toolIs(call, 'search_faq'))
    .flatMap((call) => field(call, 'query') ?? []);
  const base = {
    sessionId: reading.run.sessionId,
    runId: reading.run.id,
    interactionsRead,
    queries,
  };

  // Defence in depth: the CRM server already masks, but the model also sees what the customer
  // typed, and a model can be talked into repeating anything it has seen.
  const pii = findPii(reading.answer, { allow: PUBLIC_NUMBERS });
  const refundPromise = REFUND_PROMISE.test(reading.answer);
  if (pii.length > 0 || refundPromise) {
    return {
      ...base,
      text: WITHHELD_ANSWER,
      handoff: true,
      reason: 'guard',
      withheld: { pii, refundPromise },
    };
  }

  const reason = handoffReason(reading.answer);
  return {
    ...base,
    text: withoutTag(reading.answer),
    handoff: reason !== null,
    reason,
    withheld: null,
  };
}
