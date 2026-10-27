/**
 * The company site's chat backend: one call per message the signed-in customer sends.
 *
 * It does four things the platform does not:
 *
 * 1. **Says who the customer is.** The site's own session knows the signed-in customer; the agent
 *    does not. The backend starts the run with `subject: customerId`; the platform signs it into
 *    the `x-aw-identity` header of every call to the CRM connector (ADR-0142), and the CRM reads
 *    the customer from that assertion. Nothing about who is asking is in the prompt.
 * 2. **Keeps the conversation.** The first message starts a session; every later message passes
 *    the same `sessionId`, so the agent remembers what was said.
 * 3. **Routes handoffs.** The agent passes the customer to a person with `handoff_to_person`
 *    (`engine.handoff`); the run's `agent.handoff` frame becomes `{ handoff: true, reason }` for the
 *    operator queue, and nothing is read out of the reply text.
 * 4. **Checks the answer before it leaves.** No phone number, e-mail or address pattern and no
 *    refund promise may reach the customer, whatever the model wrote. A withheld answer is
 *    replaced by a handoff, never shown.
 */
import type { AgentWorkspaceClient } from '@indx-workspace/sdk';
import { z } from 'zod';

import { readRun, runAndRead, type RunReading, type ToolCall } from '../../shared/run-answer.ts';
import { findPii, type PiiFinding } from '../lib/pii.mjs';

/** The `reason` of a handoff the guard made when it withheld the agent's answer. */
export const GUARD_REASON = 'guard';

export const ChatAnswerSchema = z.object({
  reply: z
    .string()
    .describe('お客様に見せる回答。引継ぎのときは「担当者におつなぎします」を含める'),
});

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
}

export interface ChatReply {
  /** What the widget shows the customer. */
  readonly text: string;
  readonly sessionId: string;
  /** The run, for `aw runs rate` when the customer presses thumbs-down. */
  readonly runId: string;
  readonly handoff: boolean;
  /** Why the conversation goes to an operator: the agent's `handoff_to_person` reason, or {@link GUARD_REASON}. */
  readonly reason: string | null;
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

/**
 * The trigger a mail provider's inbound-parse webhook posts to (ADR-0144): the parsed message is the
 * body and its Message-ID is the `Idempotency-Key`. A mail's sender address proves nobody, so the
 * run has no `subject` and the CRM refuses its history tools: this path answers from the FAQ. `outputSchema` (ADR-0154)
 * makes the run answer in `ChatAnswerSchema`, so {@link chatFromRun} reads a typed reply from it.
 */
export const INBOUND_MAIL_TRIGGER = {
  kind: 'webhook',
  name: 'customer-inquiry-mail',
  prompt: [
    '届いたお問い合わせメールへの返信案を書いてください。',
    'メール（JSON）:',
    '{{body}}',
  ].join('\n'),
  outputSchema: ChatAnswerSchema,
} as const;

export async function chat(
  aw: AgentWorkspaceClient,
  agentId: string,
  input: ChatInput,
): Promise<ChatReply> {
  const message = input.message.trim();
  if (message === '') throw new Error('message must not be empty');
  const reading = await runAndRead(
    aw,
    agentId,
    {
      prompt: message,
      subject: input.customerId,
      sessionId: input.sessionId ?? null,
    },
    ChatAnswerSchema,
  );
  return checkedReply(reading);
}

/**
 * The reply to a mail whose run the inbound-mail trigger started: read the run's typed answer and
 * check it as {@link chat} does. `runId` is the `202 { run }` id of the firing; this starts no run.
 */
export async function chatFromRun(aw: AgentWorkspaceClient, runId: string): Promise<ChatReply> {
  return checkedReply(await readRun(aw, runId, ChatAnswerSchema));
}

function checkedReply(reading: RunReading<z.output<typeof ChatAnswerSchema>>): ChatReply {
  const { reply } = reading.output;

  const interactionsRead = reading.toolCalls
    .filter((call) => toolIs(call, 'getInteraction') && !call.isError)
    .flatMap((call) => field(call, 'id') ?? []);
  const queries = reading.toolCalls
    .filter((call) => toolIs(call, 'searchInteractions') || toolIs(call, 'search_files'))
    .flatMap((call) => field(call, 'q') ?? field(call, 'query') ?? []);
  const base = {
    sessionId: reading.run.sessionId,
    runId: reading.run.id,
    interactionsRead,
    queries,
  };

  // Defence in depth: the CRM API already masks, but the model also sees what the customer
  // typed, and a model can be talked into repeating anything it has seen.
  const pii = findPii(reply, { allow: PUBLIC_NUMBERS });
  const refundPromise = REFUND_PROMISE.test(reply);
  if (pii.length > 0 || refundPromise) {
    return {
      ...base,
      text: WITHHELD_ANSWER,
      handoff: true,
      reason: GUARD_REASON,
      withheld: { pii, refundPromise },
    };
  }

  return {
    ...base,
    text: reply.trim(),
    handoff: reading.handoff !== null,
    reason: reading.handoff,
    withheld: null,
  };
}
