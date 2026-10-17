'use client';
import { useCallback, useEffect, useState } from 'react';
type Share = {
  id: string;
  subjectLabel: string;
  subjectType: string;
  visibility: string;
  mode: string | null;
  viewCount: number;
  spentUsd: string;
  budgetCapUsd: string | null;
  revokedAt: string | null;
  suspendedAt: string | null;
  stopped: boolean;
};
export function SharedLinksScreen() {
  const [shares, setShares] = useState<readonly Share[] | null>(null);
  const [enabled, setEnabled] = useState(true);
  const [problem, setProblem] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      const [shareResponse, policyResponse] = await Promise.all([
        fetch('/api/shares'),
        fetch('/api/sharing-policies'),
      ]);
      if (!shareResponse.ok || !policyResponse.ok)
        throw new Error(
          `Sharing request returned ${shareResponse.status}/${policyResponse.status}`,
        );
      setShares(((await shareResponse.json()) as { shares: Share[] }).shares);
      setEnabled(((await policyResponse.json()) as { publicSharing: boolean }).publicSharing);
    } catch (e) {
      setProblem(e instanceof Error ? e.message : String(e));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  async function revoke(id: string) {
    try {
      const response = await fetch(`/api/shares/${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (!response.ok) {
        setProblem(`Revoke returned ${response.status}`);
        return;
      }
      setProblem(null);
      await load();
    } catch (e) {
      setProblem(e instanceof Error ? e.message : String(e));
    }
  }
  async function toggle() {
    const next = !enabled;
    const response = await fetch('/api/sharing-policies', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ publicSharing: next }),
    });
    if (response.ok) {
      setEnabled(next);
      await load();
    } else setProblem(`Policy update returned ${response.status}`);
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
