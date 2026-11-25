/**
 * The decisions a `use-cases/<slug>` recorder scripts for the model, shared by every recorder: what
 * it checks the prompt asks, what it searches for, which files it reads, the public-source tool it
 * calls and the one gated `Write`.
 */
import { z } from 'zod';

import { AW_DEV_TOOLS_CONNECTOR } from '@indx-workspace/contracts/tool-connectors';

import type { Script, ScriptContext } from '../../gallery/harness/scripted-workspace.ts';
import type { Ask, Lang } from './types.ts';

export type Bilingual = Readonly<Record<Lang, string>>;

/** Fails with the entry's name unless the prompt carries every identifier the scripted model is fixed to. */
export function carries(ask: Ask, ...needles: readonly string[]): void {
  const missing = needles.filter((needle) => !ask.prompt.includes(needle));
  if (missing.length > 0) {
    throw new Error(
      `${ask.slug} ${ask.lang}: the scripted model does not handle this prompt (it lacks ${missing.join(', ')})`,
    );
  }
}

/**
 * Fails with the entry's name when the prompt narrows the request (names one owner, one workstream):
 * the scripted model is fixed to the full report, so a narrowed request is not the one it answers.
 */
export function unnarrowed(ask: Ask, ...narrowers: readonly string[]): void {
  const named = narrowers.filter((narrower) => ask.prompt.includes(narrower));
  if (named.length > 0) {
    throw new Error(
      `${ask.slug} ${ask.lang}: the scripted model does not handle a narrowed prompt (it names ${named.join(', ')})`,
    );
  }
}

/** Whether `prompt` is the continuation after a decision (an approval or a rejection). */
export const isContinuation = (prompt: string): boolean => /^(approved|rejected)/u.test(prompt);

const HITS = z.array(z.object({ path: z.string() }));

/** `search_files` for each query, as the model would; the paths it found, in order, once each. */
export async function search(
  context: ScriptContext,
  queries: readonly string[],
): Promise<string[]> {
  const found: string[] = [];
  for (const query of queries) {
    const result = await context.builtin('search_files', { query });
    if (result.isError) throw new Error(`search_files "${query}": ${result.text}`);
    for (const hit of HITS.parse(JSON.parse(result.text))) {
      if (!found.includes(hit.path)) found.push(hit.path);
    }
  }
  return found;
}

/** `Read` of each workspace path, as the instructions say to open a file; a missing file fails the recording. */
export async function read(context: ScriptContext, paths: readonly string[]): Promise<void> {
  for (const file of paths) {
    const result = await context.native('Read', { file_path: `/workspace/${file}` });
    if (result.isError) throw new Error(`Read ${file}: ${result.text}`);
  }
}

/**
 * A call of the entry's public-source tool (ADR-0170) on `aw-dev-tools`, parsed with `answer`; a
 * refused call fails the recording.
 */
export async function publicSource<T>(
  context: ScriptContext,
  tool: string,
  args: Record<string, unknown>,
  answer: z.ZodType<T>,
): Promise<T> {
  const result = await context.tool(AW_DEV_TOOLS_CONNECTOR, tool, args);
  if (result.isError) throw new Error(`${tool} ${JSON.stringify(args)}: ${result.text}`);
  return answer.parse(JSON.parse(result.text));
}

/** A Markdown table: the header row, its rule and one row per item. */
export function table(header: readonly string[], rows: readonly (readonly string[])[]): string {
  const line = (cells: readonly string[]): string => `| ${cells.join(' | ')} |`;
  const rule = header.map((cell) => '-'.repeat(Math.max(3, cell.length)));
  return [line(header), line(rule), ...rows.map(line)].join('\n');
}

/**
 * A report entry's run: read the files it opens, search and read what it found (bar a file already
 * opened), anything else `before` does, then the one `Write` the agent gates. The run stops there
 * for approval; the approved continuation makes that same `Write` and answers.
 */
export function reporting(plan: {
  readonly queries: readonly string[];
  /** Files to read without searching for them, such as the file the request names. */
  readonly open?: readonly string[];
  /** Files the search must find: the report is written from them, so a search that misses one fails. */
  readonly needs?: readonly string[];
  /** Anything else the model does before it writes, such as calling a public-source tool. */
  readonly before?: (context: ScriptContext) => Promise<void>;
  readonly file: string;
  readonly report: string;
  readonly answer: string;
}): Script {
  const write = { file_path: `/workspace/${plan.file}`, content: plan.report };
  return async (context) => {
    if (isContinuation(context.prompt)) {
      await context.native('Write', write);
      return plan.answer;
    }
    const opened = plan.open ?? [];
    await read(context, opened);
    const found = await search(context, plan.queries);
    const missed = (plan.needs ?? []).filter((file) => !found.includes(file));
    if (missed.length > 0) throw new Error(`search_files did not find ${missed.join(', ')}`);
    await read(
      context,
      found.filter((file) => !opened.includes(file)),
    );
    await plan.before?.(context);
    await context.native('Write', write);
    return plan.answer;
  };
}
