'use client';
/**
 * A recording replayed with the SDK chat's own parts (`ToolTrace`, `ApprovalPrompt`,
 * `AssistantProse`), under the label that says how it was made. An approval is shown as it was
 * decided, its buttons off: a recording is not a chat.
 */
import { ApprovalPrompt, AssistantProse, ToolTrace } from '@indx-workspace/react';

import type { Recording } from '../../../../catalog/recording';
import { pick, type Lang } from '../../../lang';
import { DECISION_WORDS, fallbackContent } from './replay';
import { WORDS } from './words';

export function RecordingView({
  recording,
  lang,
}: {
  readonly recording: Recording | null;
  readonly lang: Lang;
}) {
  const content = fallbackContent(recording, lang);
  if (content.kind === 'coming') return <p data-testid="try-recording-coming">{content.text}</p>;
  return (
    <article data-testid="try-recording" aria-label={content.label}>
      <p className="aw-app-hint">{content.label}</p>
      <p>{content.prompt}</p>
      {content.parts.map((part, index) => {
        if (part.kind === 'tools') {
          return (
            <ToolTrace
              key={index}
              mode="full"
              steps={part.steps}
              strings={WORDS.toolStrings(lang)}
            />
          );
        }
        if (part.kind === 'answer') return <AssistantProse key={index} text={part.text} />;
        return (
          <div key={index}>
            <ApprovalPrompt
              call={part.call}
              strings={WORDS.approvalStrings(lang)}
              pending
              onDecide={() => undefined}
            />
            <p role="status">{pick(DECISION_WORDS[part.decision ?? 'waiting'], lang)}</p>
          </div>
        );
      })}
    </article>
  );
}
