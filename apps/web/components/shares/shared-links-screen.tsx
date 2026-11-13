'use client';
import type { ShareListItem } from '@indx-workspace/contracts/shares';
import { useCallback, useEffect, useState } from 'react';

import { browserClient } from '../../lib/browser-client';
import type { VersionsLocale } from '../agents/versions-messages';
import { adminStrings, type AdminStrings } from '../resources/admin-messages';
import { loadSharing, revokeShare, setPublicSharing } from './shared-links-model';

type ShareRowFacts = Pick<
  ShareListItem,
  | 'subjectType'
  | 'mode'
  | 'visibility'
  | 'viewCount'
  | 'spentUsd'
  | 'budgetCapUsd'
  | 'revokedAt'
  | 'suspendedAt'
  | 'stopped'
>;

/** A link's state chip: revoked, then suspended, then stopped, else active. */
export function shareState(share: ShareRowFacts, strings: AdminStrings): string {
  if (share.revokedAt) return strings.shareRevoked;
  if (share.suspendedAt) return strings.shareSuspended;
  if (share.stopped) return strings.shareStopped;
  return strings.shareActive;
}

/** The line under a link's label. Its kind and mode are the server's words, shown as they come. */
export function shareMeta(share: ShareRowFacts, strings: AdminStrings): string {
  const parts = [share.subjectType, share.mode ?? share.visibility, strings.views(share.viewCount)];
  if (share.budgetCapUsd) {
    parts.push(strings.spentOf(share.spentUsd, share.budgetCapUsd));
  }
  return parts.join(' · ');
}

export function SharedLinksScreen({ locale = 'en' }: { readonly locale?: VersionsLocale }) {
  const strings = adminStrings(locale);
  const [shares, setShares] = useState<readonly ShareListItem[] | null>(null);
  const [enabled, setEnabled] = useState(true);
  const [problem, setProblem] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      const view = await loadSharing(browserClient());
      setShares(view.shares);
      setEnabled(view.publicSharing);
    } catch (e) {
      setProblem(e instanceof Error ? e.message : String(e));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  async function revoke(id: string) {
    const refused = await revokeShare(browserClient(), id);
    setProblem(refused);
    if (refused === null) await load();
  }
  async function toggle() {
    const next = !enabled;
    const refused = await setPublicSharing(browserClient(), next);
    if (refused === null) {
      setEnabled(next);
      await load();
    } else setProblem(refused);
  }
  return (
    <main lang={locale} className="w-full max-w-[1120px] px-8 pt-[26px] pb-[90px]">
      <div className="mb-5 flex items-start justify-between">
        <div>
          <h1 className="text-[21px]">{strings.sharesTitle}</h1>
          <p className="text-[13px] text-muted">{strings.sharesIntro}</p>
        </div>
        <label className="flex items-center gap-2 text-[13px]">
          <input type="checkbox" checked={enabled} onChange={() => void toggle()} />
          {strings.publicSharing}
        </label>
      </div>
      {problem ? (
        <p role="alert" className="text-danger">
          {problem}
        </p>
      ) : null}
      <div className="overflow-hidden rounded-(--radius) border border-border bg-surface">
        {shares?.map((share) => (
          <div
            key={share.id}
            className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-3 last:border-0"
          >
            <div className="min-w-[240px] flex-1">
              <div className="font-semibold">{share.subjectLabel}</div>
              <div className="text-[12px] text-muted">{shareMeta(share, strings)}</div>
            </div>
            <span className="rounded-full bg-surface-2 px-2 py-1 text-[11px]">
              {shareState(share, strings)}
            </span>
            {share.revokedAt ? (
              <span />
            ) : (
              <button
                type="button"
                onClick={() => void revoke(share.id)}
                className="rounded border border-border-strong px-3 py-1.5 text-[12px]"
              >
                {share.mode === 'runnable' ? strings.stop : strings.revoke}
              </button>
            )}
          </div>
        ))}
        {shares?.length === 0 ? (
          <div className="p-5 text-[13px] text-muted">{strings.noShares}</div>
        ) : null}
        {shares === null ? (
          <div className="p-5 text-[13px] text-muted">{strings.loading}</div>
        ) : null}
      </div>
    </main>
  );
}
