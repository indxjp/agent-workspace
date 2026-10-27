/**
 * The portal's backend call: ask the manual-search agent a question and get back the answer with
 * its citations, checked against what the agent actually found.
 *
 * Who may read what is decided here, not by the agent: the backend maps the signed-in person to the
 * manuals `data/access.json` lets them read and starts the run with those paths as `fileScope`, so
 * the built-in `search_files` (and the sandbox) cover only them. A person with no manual gets no
 * run at all, because a run with an empty scope is invalid and an unscoped one would see every
 * manual.
 *
 * The run is started with `ManualAnswerSchema` as its `outputSchema`, so the answer and its
 * citations arrive typed and nothing is parsed out of prose. The check matters more than the shape:
 * a model can name a page it never found; an answer is `grounded` only when every citation it makes
 * is a `path` and `page` a `search_files` call returned during this run. An ungrounded answer is
 * shown with a warning, not hidden, because the person asking may still need the text, but it is
 * never presented as sourced.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import type { AgentWorkspaceClient } from '@indx-workspace/sdk';
import { z } from 'zod';

import { runAndRead } from '../../shared/run-answer.ts';

const CitationSchema = z.object({
  source: z.string().describe('search_files が返した path（manuals/…）をそのまま写す'),
  page: z
    .number()
    .int()
    .nullable()
    .describe('search_files が返した page をそのまま写す。page のない結果（Markdown）は null'),
  section: z.string().describe('開いたページの節番号（§ の後ろ、例: 3.2）'),
});

export const ManualAnswerSchema = z.object({
  answer: z.string().describe('マニュアルの記載だけを根拠にした回答。見つからなければその旨'),
  citations: z
    .array(CitationSchema)
    .describe('回答の根拠にした箇所。search_files の結果にあったものだけを挙げる'),
});

export type Citation = z.output<typeof CitationSchema>;

export interface ManualAnswer {
  readonly answer: string;
  readonly citations: readonly Citation[];
  /** Citations the agent wrote that no `search_files` call returned during the run. */
  readonly unverified: readonly Citation[];
  /** True when the answer cites at least one place and every citation was found. */
  readonly grounded: boolean;
  /** The queries the agent wrote, in order: how it searched, for the support team's review. */
  readonly queries: readonly string[];
  readonly sessionId: string;
}

/** The person may read no manual, so no run is started for them. */
export class NoManualAccess extends Error {
  public constructor(subject: string) {
    super(`${subject} may not read any manual`);
    this.name = 'NoManualAccess';
  }
}

const AccessSchema = z.record(z.string(), z.object({ manuals: z.array(z.string()) }));
const access = AccessSchema.parse(
  JSON.parse(readFileSync(fileURLToPath(new URL('../data/access.json', import.meta.url)), 'utf8')),
);

/** The workspace paths of every manual `subject` may read: each manual's Markdown and its PDF. */
export function fileScopeFor(subject: string): string[] {
  return (access[subject]?.manuals ?? []).flatMap((id) => [
    `manuals/${id}.md`,
    `manuals/${id}.pdf`,
  ]);
}

const toolIs = (name: string, tool: string): boolean => name === tool || name.endsWith(`__${tool}`);

const keyOf = (source: string, page: number | null): string => `${source}|${String(page)}`;

const HitsSchema = z.array(z.object({ path: z.string(), page: z.number().int().nullable() }));

/** The places a `search_files` result names, or none when the tool's output is not a hit list. */
function foundIn(output: string): string[] {
  try {
    const parsed = HitsSchema.safeParse(JSON.parse(output));
    return parsed.success ? parsed.data.map((hit) => keyOf(hit.path, hit.page)) : [];
  } catch {
    return [];
  }
}

export async function askManual(
  aw: AgentWorkspaceClient,
  agentId: string,
  question: string,
  /** The signed-in person asking, from the portal's own session; it decides the run's `fileScope`. */
  subject: string,
  sessionId?: string,
): Promise<ManualAnswer> {
  const fileScope = fileScopeFor(subject);
  if (fileScope.length === 0) throw new NoManualAccess(subject);
  const reading = await runAndRead(
    aw,
    agentId,
    { prompt: question, subject, fileScope, sessionId: sessionId ?? null },
    ManualAnswerSchema,
  );
  const found = new Set(
    reading.toolCalls
      .filter((call) => toolIs(call.name, 'search_files') && !call.isError)
      .flatMap((call) => foundIn(call.output ?? '')),
  );
  const { answer, citations } = reading.output;
  const unverified = citations.filter(
    (citation) => !found.has(keyOf(citation.source, citation.page)),
  );
  const queries = reading.toolCalls
    .filter((call) => toolIs(call.name, 'search_files'))
    .map((call) => {
      const query = (call.input as { query?: unknown }).query;
      return typeof query === 'string' ? query : '';
    });
  return {
    answer,
    citations,
    unverified,
    grounded: citations.length > 0 && unverified.length === 0,
    queries,
    sessionId: reading.run.sessionId,
  };
}
