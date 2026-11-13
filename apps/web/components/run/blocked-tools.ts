/**
 * Tool calls the engine refused without asking anyone (issue #2091), and the words the run view
 * uses for them, in English and Japanese, in the shape of `./team-messages.ts`.
 *
 * Only the Claude Agent SDK reports such a refusal today, as its own `system/permission_denied`
 * message. No neutral `agent.*` frame carries it, so the runner forwards it as `agent.native`
 * (`packages/run-protocol/src/claude-sdk-events.ts`), and this is the one place the console reads
 * that engine's payload. The two fields it reads are the SDK's declared `tool_use_id` and
 * `tool_name`; a frame without both is not shown, never guessed at.
 */
import type { EngineId } from '@indx-workspace/contracts/engines';
import type { AgentEvent } from '@indx-workspace/sdk/events';
import type { BlockedTool } from '@indx-workspace/react/run-model';

import type { VersionsLocale } from '../agents/versions-messages';

/** The engine that reports these refusals: the Claude Agent SDK, whatever the default engine is. */
const CLAUDE_AGENT_SDK = 'claude-agent-sdk' satisfies EngineId;

/** The Claude Agent SDK's name for an auto-denied tool call, as the runner forwards it. */
const PERMISSION_DENIED_NATIVE_TYPE = 'system/permission_denied';

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/** The refused call one event reports, or `null` when the event reports none. */
export function blockedToolFromAgentEvent(event: AgentEvent): BlockedTool | null {
  if (
    event.frame !== 'agent.native' ||
    event.engine !== CLAUDE_AGENT_SDK ||
    event.type !== PERMISSION_DENIED_NATIVE_TYPE ||
    typeof event.payload !== 'object' ||
    event.payload === null
  ) {
    return null;
  }
  const payload = event.payload as Readonly<Record<string, unknown>>;
  const toolCallId = nonEmptyString(payload['tool_use_id']);
  const toolName = nonEmptyString(payload['tool_name']);
  return toolCallId === null || toolName === null ? null : { toolCallId, toolName };
}

export interface BlockedStrings {
  readonly title: string;
  /** Before the tool names: "Blocked:". */
  readonly lead: string;
  readonly explanation: string;
}

const EN: BlockedStrings = {
  title: 'Something the agent tried was blocked',
  lead: 'Did not run:',
  explanation:
    "This agent's permissions don't allow it, and nobody was asked to approve it. " +
    'The answer may describe work that did not happen. Show technical details has the full message.',
};

const JA: BlockedStrings = {
  title: 'エージェントの操作がブロックされました',
  lead: '実行されなかった操作：',
  explanation:
    'このエージェントの権限では許可されておらず、承認も求められませんでした。' +
    '回答には実際には行われていない作業が書かれている可能性があります。詳しいメッセージは「Show technical details」で確認できます。',
};

const STRINGS: Readonly<Record<VersionsLocale, BlockedStrings>> = { en: EN, ja: JA };

export function blockedStrings(locale: VersionsLocale): BlockedStrings {
  return STRINGS[locale];
}
