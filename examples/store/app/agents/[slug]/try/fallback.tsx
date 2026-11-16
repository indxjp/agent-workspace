/**
 * What the demo shows when a cap stops it (spec "How Try it works"): why, in words, and the
 * entry's recording, replayed with the SDK chat parts; an entry with none says "recording coming".
 * A `start` cap (no run can begin) replaces the chat; a `run` cap (one answer stopped at
 * its own turns or spend) is shown under the kept chat, in that run's words.
 */
import type { DemoFallbackReason } from '@indx-workspace/contracts/demo';

import type { Recording } from '../../../../catalog/recording';
import { pick, type Lang } from '../../../lang';
import { RecordingView } from './recording-view';
import { fallbackReasonText, runStopText, type FallbackScope } from './messages';
import { WORDS } from './words';

export function Fallback({
  reason,
  lang,
  recording,
  scope = 'start',
}: {
  readonly reason: DemoFallbackReason;
  readonly scope?: FallbackScope;
  readonly lang: Lang;
  readonly recording: Recording | null;
}) {
  return (
    <section data-testid="try-fallback" data-reason={reason} data-scope={scope}>
      <p role="status">
        {scope === 'run' ? runStopText(reason, lang) : fallbackReasonText(reason, lang)}
      </p>
      <h3>{pick(WORDS.fallbackHeading, lang)}</h3>
      <RecordingView recording={recording} lang={lang} />
    </section>
  );
}
