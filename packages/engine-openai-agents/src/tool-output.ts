/**
 * What a tool hands back to the model: the size limit on an answer, and the small text helpers
 * every executor shares.
 *
 * Split out of `./executors.ts` so the shell runner in `./shell-process.ts` can bound its output
 * by the same limit without importing the executors.
 */
import { OPENAI_AGENTS_TOOL_ERROR_PREFIX } from './frames.js';

/** The largest answer a tool hands back to the model, in characters. */
export const OPENAI_AGENTS_TOOL_OUTPUT_LIMIT = 64 * 1024;

/** The first `length` UTF-16 units of `text`, stepping back one so a surrogate pair is not halved. */
export function head(text: string, length: number): string {
  const cut = text.slice(0, length);
  const last = cut.charCodeAt(cut.length - 1);
  const pairCut = last >= 0xd800 && last <= 0xdbff && text.length > length;
  return pairCut ? cut.slice(0, -1) : cut;
}

/** `text`, or its first {@link OPENAI_AGENTS_TOOL_OUTPUT_LIMIT} characters and a truncation note. */
export function capped(text: string): string {
  if (text.length <= OPENAI_AGENTS_TOOL_OUTPUT_LIMIT) return text;
  const kept = head(text, OPENAI_AGENTS_TOOL_OUTPUT_LIMIT);
  return `${kept}\n[truncated: ${String(text.length - kept.length)} more characters]`;
}

/** The message of a caught value, whatever was thrown. */
export function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** An answer that tells the model its call failed, in the one shape `./frames.ts` recognises. */
export function toolError(message: string): string {
  return `${OPENAI_AGENTS_TOOL_ERROR_PREFIX}${message}`;
}
