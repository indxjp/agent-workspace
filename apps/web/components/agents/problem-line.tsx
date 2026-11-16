import type { RequestProblem } from './model';
import type { VersionsLocale } from './versions-messages';

/**
 * A failure in the reader's language (UX-15 in #2086). English prints `english`, the sentence these
 * screens always printed. Another language leads with its own sentence and keeps `detail` — the
 * server's or the transport's own words, which the client cannot translate and an administrator
 * searches for — after it, marked English.
 */
export function ProblemLine({
  locale,
  english,
  lead,
  detail,
}: Readonly<{ locale: VersionsLocale; english: string; lead: string; detail: string }>) {
  if (locale === 'en') return <>{english}</>;
  return (
    <>
      {lead} <span lang="en">{detail}</span>
    </>
  );
}

/**
 * The body of a failure callout (`.callout.danger`) in the reader's language: another language
 * opens with this screen's own sentence; the refusal's status and code, or the transport's
 * sentence, follow as the server or the browser worded them, marked English. English shows them
 * alone, as before.
 */
export function ProblemDetail({
  locale,
  lead,
  problem,
}: Readonly<{ locale: VersionsLocale; lead: string; problem: RequestProblem }>) {
  return (
    <>
      {locale === 'en' ? null : <div className="font-semibold">{lead}</div>}
      {problem.kind === 'api' ? (
        <>
          <b className="font-semibold">
            {problem.status} {problem.code}
          </b>
          {/* The server's own sentence, as it sent it. */}
          <div lang="en">{problem.message}</div>
        </>
      ) : (
        <div lang="en">{problem.reason}</div>
      )}
    </>
  );
}
