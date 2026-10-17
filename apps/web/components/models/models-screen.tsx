'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

import {
  connectionDetail,
  connectionStatus,
  readModelConnections,
  type ModelConnectionView,
} from './model';
import { ProviderDetailPanel } from './provider-detail';

const CARD = 'overflow-hidden rounded-(--radius) border border-border bg-surface shadow-(--shadow)';
const BUTTON =
  'inline-flex h-8 items-center justify-center rounded-(--radius-sm) border border-border-strong px-[13px] text-[13px] font-medium';
const STATUS_CLASS: Record<'ok' | 'warn' | 'danger', string> = {
  ok: 'bg-ok-soft text-ok',
  warn: 'bg-warn-soft text-warn',
  danger: 'bg-danger-soft text-danger',
};

export function ModelsList({
  models,
  onChange,
}: Readonly<{
  models: readonly ModelConnectionView[];
  /** Called after an edit, rotation-triggered refresh, or removal so the caller's list stays the
   * source of truth — this component never keeps its own copy of `models`. */
  onChange: (next: readonly ModelConnectionView[]) => void;
}>) {
  const [testMessage, setTestMessage] = useState<string | null>(null);
  const [managingId, setManagingId] = useState<string | null>(null);
  if (models.length === 0) {
    return (
      <div className={`${CARD} p-5 text-[13px] text-muted`}>
        No providers are configured yet. Add one to make a model available to agents.
      </div>
    );
  }
  return (
    <div className={CARD}>
      {models.map((model) => {
        const status = connectionStatus(model);
        return (
          <div key={model.id} className="border-b border-border last:border-b-0">
            <div className="flex flex-wrap items-center gap-4 px-4 py-[14px]">
              <div className="min-w-[260px] flex-1">
                <div className="flex flex-wrap items-center gap-2 text-[13.5px] font-semibold">
                  {model.name}
                  <span
                    className={`rounded-full px-2 py-0.5 text-[10px] ${STATUS_CLASS[status.tone]}`}
                  >
                    {status.text}
                  </span>
                </div>
                <div className="mt-0.5 text-[12px] text-muted">{connectionDetail(model)}</div>
                {model.hasCredential ? (
                  <div className="mt-1 text-[11px] text-muted">
                    Credential stored securely · write-only
                  </div>
                ) : null}
              </div>
              <button
                type="button"
                className={BUTTON}
                onClick={() => {
                  setTestMessage(`Testing ${model.name}…`);
                  void fetch(`/api/model-connections/${model.id}/test`, {
                    method: 'POST',
                    headers: { accept: 'application/json' },
                  })
                    .then(async (response) => {
                      const body = (await response.json()) as { message?: unknown };
                      if (!response.ok)
                        throw new Error(`Connection test returned ${response.status}.`);
                      setTestMessage(
                        typeof body.message === 'string'
                          ? body.message
                          : `${model.name} is connected.`,
                      );
                    })
                    .catch((error: unknown) =>
                      setTestMessage(error instanceof Error ? error.message : String(error)),
                    );
                }}
              >
                Test
              </button>
              <button
                type="button"
                className={BUTTON}
                aria-expanded={managingId === model.id}
                onClick={() => setManagingId(managingId === model.id ? null : model.id)}
              >
                {managingId === model.id ? 'Hide' : 'Manage'}
              </button>
            </div>
            {managingId === model.id ? (
              <ProviderDetailPanel
                connection={model}
                onClose={() => setManagingId(null)}
                onUpdated={(next) =>
                  onChange(models.map((entry) => (entry.id === next.id ? next : entry)))
                }
                onRemoved={(id) => {
                  setManagingId(null);
                  onChange(models.filter((entry) => entry.id !== id));
                }}
              />
            ) : null}
          </div>
        );
      })}
      {testMessage === null ? null : (
        <div role="status" className="border-t border-border bg-surface-2 px-4 py-2 text-[12px]">
          {testMessage}
        </div>
      )}
    </div>
  );
}

export function ModelsScreen() {
  const [models, setModels] = useState<readonly ModelConnectionView[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    // Issue #130: `GET /api/models` was repurposed by #129 for discovered *models*
    // (`{connectionId, providerModelId, displayName, capabilities}`), not connections — this
    // screen manages connections, and reads `GET /api/model-connections` for exactly that reason.
    void fetch('/api/model-connections', { headers: { accept: 'application/json' } })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Model connections request returned ${response.status}.`);
        return response.json() as Promise<unknown>;
      })
      .then((body) => {
        if (active) setModels(readModelConnections(body));
      })
      .catch((error: unknown) => {
        if (active) setProblem(error instanceof Error ? error.message : String(error));
      });
    return () => {
      active = false;
    };
  }, []);

  return (
    <main className="w-full max-w-[980px] px-8 pt-[26px] pb-[90px]">
      <div className="mb-[22px] flex flex-wrap items-start gap-4">
        <div className="min-w-0 flex-1">
          <h1 className="text-[21px]">Models</h1>
          <p className="mt-[3px] text-[13px] text-muted">
            Providers behind the internal gateway. Agents select a model; they never see provider
            credentials.
          </p>
        </div>
        <Link
          className={`${BUTTON} border-accent bg-accent text-white no-underline`}
          href="/admin/models/new"
        >
          + Add Provider
        </Link>
      </div>

      <div className="mb-4 flex gap-5 border-b border-border text-[13px] font-medium">
        <span className="border-b-2 border-accent px-1 pb-2 text-accent">Providers</span>
        <span className="px-1 pb-2 text-muted">Compatibility</span>
        <span className="px-1 pb-2 text-muted">Gateway</span>
      </div>

      {problem !== null ? (
        <div
          role="alert"
          className="rounded-(--radius) border border-danger bg-danger-soft p-4 text-[13px] text-danger"
        >
          {problem}
        </div>
      ) : models === null ? (
        <div className="text-[13px] text-muted">Loading model connections…</div>
      ) : (
        <ModelsList models={models} onChange={setModels} />
      )}
    </main>
  );
}
