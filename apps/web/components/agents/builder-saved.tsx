import Link from 'next/link';

import { pinnedChatHref } from '../composer/model';
import { builderStrings } from './builder-messages';
import type { SavedDraft } from './definition-from-run';
import type { VersionsLocale } from './versions-messages';

/** The id of the versions tab's Release section, where Promote and Roll back live. */
const RELEASE_ANCHOR = 'versions-release-heading';

/**
 * The line after an approved save: which version `local` now points at, and where to go next. The
 * Builder never promotes; Promote opens the Release section for the person to do it.
 */
export function BuilderSaved({
  saved,
  locale = 'en',
}: Readonly<{ saved: SavedDraft; locale?: VersionsLocale }>) {
  const strings = builderStrings(locale);
  const versions = `/agents/${encodeURIComponent(saved.agentId)}?tab=versions`;
  return (
    <div
      role="status"
      className="mb-3 rounded-(--radius) border border-border-strong bg-accent-soft p-3 text-[13px]"
    >
      <p className="font-semibold">{strings.savedAs(saved.version)}</p>
      <p className="mt-1 flex flex-wrap gap-3">
        <Link href={pinnedChatHref(saved)} className="text-accent">
          {strings.tryIt}
        </Link>
        <Link href={versions} className="text-accent">
          {strings.viewHistory}
        </Link>
        <Link href={`${versions}#${RELEASE_ANCHOR}`} className="text-accent">
          {strings.promote}
        </Link>
      </p>
    </div>
  );
}
