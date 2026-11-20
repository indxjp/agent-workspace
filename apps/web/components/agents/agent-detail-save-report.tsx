'use client';

import { type AgentDetailStrings } from './agent-detail-messages';
import { describeHalf, type RequestProblem, type SaveReport } from './model';
import type { VersionsLocale } from './versions-messages';

/** The one line a {@link RequestProblem} shows, whichever arm it is. */
export function problemText(problem: RequestProblem): string {
  return problem.kind === 'api' ? problem.message : problem.reason;
}

/** One half of a save report: its label, what happened to it, and the refusal if there was one. */
type Half = Readonly<{
  label: string;
  outcome: SaveReport['definition'];
  problem: RequestProblem | null;
}>;

/**
 * One half of the save report: saved, not attempted, or refused with the server's own reason.
 * English is `describeHalf`'s sentence, as before; another language marks the reason English.
 */
function halfLine(locale: VersionsLocale, words: AgentDetailStrings, half: Half) {
  const { label, outcome, problem } = half;
  if (locale === 'en') return describeHalf(label, outcome, problem);
  if (outcome === 'saved') return words.halfSaved(label);
  if (outcome === 'not-attempted') return words.halfNotAttempted(label);
  return (
    <>
      {words.halfNotSaved(label)}{' '}
      <span lang="en">{problem === null ? '' : problemText(problem)}</span>
    </>
  );
}

/** The alert under the form that reports the definition half and the assignments half. */
export function SaveReportPanel({
  report,
  locale,
  words,
}: Readonly<{ report: SaveReport; locale: VersionsLocale; words: AgentDetailStrings }>) {
  const allSaved = report.definition === 'saved' && report.assignments === 'saved';
  const tone = allSaved
    ? 'border-border bg-surface text-text'
    : 'border-danger bg-danger-soft text-danger';
  return (
    <div role="alert" className={`rounded border p-3 text-[13px] ${tone}`}>
      <p>
        {halfLine(locale, words, {
          label: words.definitionHalf,
          outcome: report.definition,
          problem: report.definitionProblem,
        })}
      </p>
      <p>
        {halfLine(locale, words, {
          label: words.assignmentsHalf,
          outcome: report.assignments,
          problem: report.assignmentsProblem,
        })}
      </p>
    </div>
  );
}
