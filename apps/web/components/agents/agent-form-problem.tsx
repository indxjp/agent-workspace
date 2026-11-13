import { CALLOUT_DANGER } from './agent-form-styles';
import type { NewAgentStrings } from './new-agent-messages';
import type { RequestProblem } from './model';
import { ProblemDetail } from './problem-line';
import type { VersionsLocale } from './versions-messages';

/**
 * Why the New Agent form could not create the agent. Another language leads with its own sentence;
 * the server's status, code and sentence — or the browser's — follow as sent, marked English
 * (UX-15 in #2086). English shows them alone, as before.
 */
export function AgentFormProblem({
  problem,
  strings,
  locale,
}: {
  readonly problem: RequestProblem | null;
  readonly strings: NewAgentStrings;
  readonly locale: VersionsLocale;
}) {
  return (
    <>
      {' '}
      {problem === null ? null : (
        <div className={CALLOUT_DANGER}>
          <span aria-hidden="true" className="flex-none text-[14px] leading-[1.4]">
            !
          </span>
          <div className="min-w-0 flex-1">
            <ProblemDetail locale={locale} lead={strings.createFailed} problem={problem} />
          </div>
        </div>
      )}
    </>
  );
}
