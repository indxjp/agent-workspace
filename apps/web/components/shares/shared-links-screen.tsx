'use client';
import type { ShareListItem } from '@indx-workspace/contracts/shares';
import { useCallback, useEffect, useState } from 'react';

import { browserClient } from '../../lib/browser-client';
import { loadSharing, revokeShare, setPublicSharing } from './shared-links-model';

export function SharedLinksScreen() {
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
    <main className="w-full max-w-[1120px] px-8 pt-[26px] pb-[90px]">
      <div className="mb-5 flex items-start justify-between">
        <div>
          <h1 className="text-[21px]">Shared links</h1>
          <p className="text-[13px] text-muted">
            Every definition, snapshot and runnable link in this workspace.
          </p>
        </div>
        <label className="flex items-center gap-2 text-[13px]">
          <input type="checkbox" checked={enabled} onChange={() => void toggle()} />
          Public sharing
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
              <div className="text-[12px] text-muted">
                {share.subjectType} · {share.mode ?? share.visibility} · {share.viewCount} views
                {share.budgetCapUsd ? ` · $${share.spentUsd} of $${share.budgetCapUsd}` : ''}
              </div>
            </div>
            <span className="rounded-full bg-surface-2 px-2 py-1 text-[11px]">
              {share.revokedAt
                ? 'Revoked'
                : share.suspendedAt
                  ? 'Suspended'
                  : share.stopped
                    ? 'Stopped'
                    : 'Active'}
            </span>
            {share.revokedAt ? (
              <span />
            ) : (
              <button
                type="button"
                onClick={() => void revoke(share.id)}
                className="rounded border border-border-strong px-3 py-1.5 text-[12px]"
              >
                {share.mode === 'runnable' ? 'Stop' : 'Revoke'}
              </button>
            )}
          </div>
        ))}
        {shares?.length === 0 ? (
          <div className="p-5 text-[13px] text-muted">No links have been shared.</div>
        ) : null}
        {shares === null ? <div className="p-5 text-[13px] text-muted">Loading…</div> : null}
      </div>
    </main>
  );
}
