/**
 * The portal's backend call: ask the manual-search agent a question and get back the answer with
 * its citations, checked against what the agent actually read.
 *
 * The check matters more than the parse. A model can write a plausible 〔…〕 for a page it never
 * opened; an answer is `grounded` only when every citation it makes is one `read_section` returned
 * during this run. An ungrounded answer is shown with a warning, not hidden, because the person
 * asking may still need the text, but it is never presented as sourced.
 */
import type { AgentWorkspaceClient } from '@indx-workspace/sdk';

import { parseCitations, type Citation } from '../../shared/citations.ts';
import { runAndRead } from '../../shared/run-answer.ts';

export interface ManualAnswer {
  readonly answer: string;
  readonly citations: readonly Citation[];
  /** Citations the agent wrote that no `read_section` call returned during the run. */
  readonly unverified: readonly Citation[];
  /** True when the answer cites at least one section and every citation was read. */
  readonly grounded: boolean;
  /** The queries the agent wrote, in order: how it searched, for the support team's review. */
  readonly queries: readonly string[];
  readonly sessionId: string;
}

const toolIs = (name: string, tool: string): boolean => name === tool || name.endsWith(`__${tool}`);

export async function askManual(
  aw: AgentWorkspaceClient,
  agentId: string,
  question: string,
  sessionId?: string,
): Promise<ManualAnswer> {
  const reading = await runAndRead(aw, agentId, { prompt: question, sessionId: sessionId ?? null });
  const read = new Set(
    reading.toolCalls
      .filter((call) => toolIs(call.name, 'read_section') && !call.isError && call.output !== null)
      .flatMap((call) => parseCitations(call.output ?? '').map((citation) => citation.raw)),
  );
  const citations = parseCitations(reading.answer);
  const unverified = citations.filter((citation) => !read.has(citation.raw));
  const queries = reading.toolCalls
    .filter((call) => toolIs(call.name, 'search_manual'))
    .map((call) => {
      const query = (call.input as { query?: unknown }).query;
      return typeof query === 'string' ? query : '';
    });
  return {
    answer: reading.answer,
    citations,
    unverified,
    grounded: citations.length > 0 && unverified.length === 0,
    queries,
    sessionId: reading.run.sessionId,
  };
}
