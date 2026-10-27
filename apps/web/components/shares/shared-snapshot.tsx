import type { ShareSubjectType } from '@indx-workspace/contracts/shares';
import { z } from 'zod';

/** The transcript a session share stores (ADR-0158); read back, so parsed rather than trusted. */
const SessionTranscriptSchema = z.object({
  kind: z.literal('session-transcript'),
  version: z.literal(1),
  turns: z.array(z.object({ prompt: z.string().nullable(), answer: z.string().nullable() })),
});

function Json({ value }: Readonly<{ value: unknown }>) {
  return (
    <pre className="overflow-auto whitespace-pre-wrap text-[13px]">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

/**
 * What a share's visitor is shown. A transcript the server copied from the session's runs is the
 * conversation; any other session snapshot predates ADR-0158 and is client-supplied text, so it is
 * labelled as the publisher's.
 */
export function SharedSnapshot({
  subjectType,
  snapshot,
}: Readonly<{ subjectType: ShareSubjectType; snapshot: unknown }>) {
  const transcript = SessionTranscriptSchema.safeParse(snapshot);
  if (subjectType === 'session' && transcript.success) {
    return (
      <div className="mt-5 rounded-(--radius) border border-border bg-surface p-5">
        <p className="text-[12px] text-muted">
          Copied from the session&apos;s stored record when it was shared. Secret values are masked.
        </p>
        {transcript.data.turns.map((turn, index) => (
          <section key={index} className="mt-4 text-[14px]">
            <h2 className="text-[12px] font-semibold text-muted">Prompt</h2>
            <p className="mt-1 whitespace-pre-wrap">{turn.prompt ?? 'Not recorded.'}</p>
            <h2 className="mt-3 text-[12px] font-semibold text-muted">Answer</h2>
            <p className="mt-1 whitespace-pre-wrap">
              {turn.answer ?? 'The run did not finish with an answer.'}
            </p>
          </section>
        ))}
      </div>
    );
  }
  return (
    <div className="mt-5 rounded-(--radius) border border-border bg-surface p-5">
      {subjectType === 'session' && snapshot !== null ? (
        <p className="mb-3 text-[12px] text-muted">
          Provided by the person who shared it; not checked against the session&apos;s record.
        </p>
      ) : null}
      <Json value={snapshot} />
    </div>
  );
}
