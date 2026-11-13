/**
 * The earlier messages of a chat the home screen continues (UX-05 step 2 in #2086), read from the
 * Claude Agent SDK's own transcript, as spec §20 asks: "use Claude Agent SDK sessions rather than
 * inventing a conversation format". Nothing new is stored; this reads the stream the runner already
 * writes (`./api.ts`'s `GET …/transcript` serves the same one to the SDK).
 *
 * Only what a person reads is kept: the text the user typed and the text the agent answered. Tool
 * calls, tool results, thinking, subagent (sidechain) turns, compaction summaries and the SDK's meta
 * entries are left out, the same split the live chat makes.
 */
import { engineStreamKey } from '@agent-workspace/engine';
import type { EngineId } from '@indx-workspace/contracts/engines';

import type { SessionApiEnvironment } from './environment';
import { readWholeStream } from './read-stream';
import type { SessionRecord } from './store';

/** One message of an earlier chat: who said it, and its text as paragraphs. */
interface ChatHistoryTurn {
  readonly speaker: 'user' | 'agent';
  readonly paragraphs: readonly string[];
}

export interface ChatHistory {
  /** The most recent turns, oldest first. */
  readonly turns: readonly ChatHistoryTurn[];
  /** How many older turns were left out to keep the page small. */
  readonly earlierHidden: number;
}

/** The most turns the home page sends to the browser. */
export const MAX_HISTORY_TURNS = 40;

/** The longest one paragraph is shown; a longer one ends in "…". */
export const MAX_PARAGRAPH_CHARACTERS = 6_000;

const CLAUDE_ENGINE: EngineId = 'claude-agent-sdk';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function clipped(text: string): string {
  return text.length > MAX_PARAGRAPH_CHARACTERS
    ? `${text.slice(0, MAX_PARAGRAPH_CHARACTERS)}…`
    : text;
}

/** The text blocks of one SDK message's `content`: a plain string, or the blocks of type `text`. */
function textsOf(content: unknown): string[] {
  if (typeof content === 'string') return [content];
  if (!Array.isArray(content)) return [];
  return content.flatMap((block) =>
    isRecord(block) && block['type'] === 'text' && typeof block['text'] === 'string'
      ? [block['text']]
      : [],
  );
}

/** The turn one transcript entry adds, or `null` when it is nothing a person reads. */
function turnOf(entry: unknown): ChatHistoryTurn | null {
  if (!isRecord(entry)) return null;
  const speaker =
    entry['type'] === 'user' ? 'user' : entry['type'] === 'assistant' ? 'agent' : null;
  // Meta entries, subagent turns and the summary the SDK writes when it compacts a long chat are
  // the engine's, not something either side said.
  if (
    speaker === null ||
    entry['isMeta'] === true ||
    entry['isSidechain'] === true ||
    entry['isCompactSummary'] === true
  ) {
    return null;
  }
  const message = entry['message'];
  if (!isRecord(message)) return null;
  const paragraphs = textsOf(message['content'])
    .map((text) => text.trim())
    .filter((text) => text !== '')
    .map(clipped);
  return paragraphs.length === 0 ? null : { speaker, paragraphs };
}

/**
 * What a person reads of a transcript. The SDK writes an answer as several entries (one per content
 * block), so neighbouring agent entries join into one turn; a user entry that holds only tool
 * results adds nothing and so does not split them.
 */
export function chatHistoryFrom(entries: readonly unknown[]): ChatHistory {
  const turns: ChatHistoryTurn[] = [];
  for (const entry of entries) {
    const turn = turnOf(entry);
    if (turn === null) continue;
    const previous = turns.at(-1);
    if (previous?.speaker === 'agent' && turn.speaker === 'agent') {
      turns[turns.length - 1] = {
        speaker: 'agent',
        paragraphs: [...previous.paragraphs, ...turn.paragraphs],
      };
    } else {
      turns.push(turn);
    }
  }
  const earlierHidden = Math.max(0, turns.length - MAX_HISTORY_TURNS);
  return { turns: turns.slice(earlierHidden), earlierHidden };
}

/**
 * The earlier messages of `row`, a session the caller may continue (`./resume.ts` checked that), or
 * `null` when they cannot be read: no engine session yet, another engine's state, or no transcript.
 */
export async function chatHistoryFor(
  env: Pick<SessionApiEnvironment, 'store' | 'stateStore'>,
  row: Pick<SessionRecord, 'id' | 'workspaceId' | 'engine' | 'engineSessionId'>,
): Promise<ChatHistory | null> {
  if (row.engineSessionId === null) return null;
  if (row.engine !== null && row.engine !== CLAUDE_ENGINE) return null;
  // The workspace id is the tenant's projectKey by construction (`./environment.ts`).
  const key = { projectKey: row.workspaceId, sessionId: row.engineSessionId };
  // The engine-scoped stream first, then the pre-ENG-06 store, the order `GET …/transcript` reads.
  const entries =
    (await readWholeStream(env.stateStore, {
      workspaceId: row.workspaceId,
      sessionId: row.id,
      engine: CLAUDE_ENGINE,
      streamKey: engineStreamKey(key),
    })) ?? (await env.store.load(key));
  return entries === null ? null : chatHistoryFrom(entries);
}
