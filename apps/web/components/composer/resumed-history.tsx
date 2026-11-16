import { plain, type Message, type Run, type Speaker } from '@indx-workspace/react/run-model';

import type { ResumedHistory } from './home-chat-types';

/**
 * The earlier messages of a continued chat as transcript messages (UX-05 step 2 in #2086), so they
 * stay on screen above the first new message once it is sent.
 */
export function historyMessages(
  history: ResumedHistory | undefined,
  user: Speaker,
  agent: Speaker,
): readonly Message[] {
  return (history?.turns ?? []).map((turn, index): Message => {
    const id = `history-${String(index)}`;
    return turn.speaker === 'user'
      ? { kind: 'user', id, speaker: user, paragraphs: turn.paragraphs.map(plain) }
      : {
          kind: 'agent',
          id,
          speaker: agent,
          blocks: [{ kind: 'prose', paragraphs: turn.paragraphs.map(plain) }],
        };
  });
}

/** `run` with `earlier` placed before its own messages. */
export function withEarlierMessages(run: Run, earlier: readonly Message[]): Run {
  return { ...run, messages: [...earlier, ...run.messages] as [Message, ...Message[]] };
}

/** The earlier messages, read-only, above the composer of a continued chat. */
export function ResumedHistoryList({
  history,
  userName,
  agentName,
}: Readonly<{ history: ResumedHistory; userName: string; agentName: string }>) {
  if (history.turns.length === 0) return null;
  return (
    <section
      aria-labelledby="resumed-history-heading"
      data-testid="resumed-history"
      className="mb-5 rounded-(--radius) border border-border bg-surface px-4 py-3.5"
    >
      <h2 id="resumed-history-heading" className="text-[12.5px] font-semibold text-muted">
        {history.heading}
      </h2>
      {history.earlierNote === null ? null : (
        <p className="mt-1 text-[12.5px] text-muted">{history.earlierNote}</p>
      )}
      <ol className="mt-2 flex list-none flex-col gap-4 p-0">
        {history.turns.map((turn, index) => (
          <li key={index} className="text-[14px] leading-[1.6]">
            <div className="text-[12.5px] font-semibold text-text-2">
              {turn.speaker === 'user' ? userName : agentName}
            </div>
            {turn.paragraphs.map((paragraph, at) => (
              <p key={at} className="mt-1 whitespace-pre-wrap text-text [overflow-wrap:anywhere]">
                {paragraph}
              </p>
            ))}
          </li>
        ))}
      </ol>
    </section>
  );
}
