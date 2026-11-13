'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

import { browserClient } from '../../lib/browser-client';
import type { VersionsLocale } from '../agents/versions-messages';

import { loadConnections, testConnection } from './connections-model';
import { connectionDetail, connectionStatus, type ModelConnectionView } from './model';
import { modelsStrings } from './models-messages';
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
  locale = 'en',
}: Readonly<{
  models: readonly ModelConnectionView[];
  /** The reader's language (UX-15 in #2086); English by default. */
  locale?: VersionsLocale;
  /** Called after an edit, rotation-triggered refresh, or removal so the caller's list stays the
   * source of truth — this component never keeps its own copy of `models`. */
  onChange: (next: readonly ModelConnectionView[]) => void;
}>) {
  const [testMessage, setTestMessage] = useState<string | null>(null);
  const [managingId, setManagingId] = useState<string | null>(null);
  const strings = modelsStrings(locale);
  if (models.length === 0) {
    return (
      <div lang={locale} className={`${CARD} p-5 text-[13px] text-muted`}>
        {strings.empty}
      </div>
    );
  }
  return (
    <div lang={locale} className={CARD}>
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
                    {strings.status[status.kind]}
                  </span>
                </div>
                <div className="mt-0.5 text-[12px] text-muted">
                  {connectionDetail(model, strings)}
                </div>
                {model.hasCredential ? (
                  <div className="mt-1 text-[11px] text-muted">{strings.credentialStored}</div>
                ) : null}
              </div>
              <button
                type="button"
                className={BUTTON}
                onClick={() => {
                  setTestMessage(strings.testing(model.name));
                  void testConnection(browserClient(), model.id, strings)
                    .then(setTestMessage)
                    .catch((error: unknown) =>
                      setTestMessage(error instanceof Error ? error.message : String(error)),
                    );
                }}
              >
                {strings.test}
              </button>
              <button
                type="button"
                className={BUTTON}
                aria-expanded={managingId === model.id}
                onClick={() => setManagingId(managingId === model.id ? null : model.id)}
              >
                {managingId === model.id ? strings.hide : strings.manage}
              </button>
            </div>
            {managingId === model.id ? (
              <ProviderDetailPanel
                connection={model}
                locale={locale}
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

export function ModelsScreen({ locale = 'en' }: { readonly locale?: VersionsLocale }) {
  const strings = modelsStrings(locale);
  const [models, setModels] = useState<readonly ModelConnectionView[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    // Issue #130: `GET /api/models` was repurposed by #129 for discovered *models*
    // (`{connectionId, providerModelId, displayName, capabilities}`), not connections — this
    // screen manages connections, and reads `GET /api/model-connections` for exactly that reason.
    void loadConnections(browserClient())
      .then((connections) => {
        if (active) setModels(connections);
      })
      .catch((error: unknown) => {
        if (active) setProblem(error instanceof Error ? error.message : String(error));
      });
    return () => {
      active = false;
    };
  }, []);

  return (
    <main lang={locale} className="w-full max-w-[980px] px-8 pt-[26px] pb-[90px]">
      <div className="mb-[22px] flex flex-wrap items-start gap-4">
        <div className="min-w-0 flex-1">
          <h1 className="text-[21px]">{strings.title}</h1>
          <p className="mt-[3px] text-[13px] text-muted">{strings.intro}</p>
        </div>
        <Link
          className={`${BUTTON} border-accent bg-accent text-white no-underline`}
          href="/admin/models/new"
        >
          {strings.addProvider}
        </Link>
      </div>

      <div className="mb-4 flex gap-5 border-b border-border text-[13px] font-medium">
        <span className="border-b-2 border-accent px-1 pb-2 text-accent">
          {strings.tabProviders}
        </span>
        <span className="px-1 pb-2 text-muted">{strings.tabCompatibility}</span>
        <span className="px-1 pb-2 text-muted">{strings.tabGateway}</span>
      </div>

      {problem !== null ? (
        <div
          role="alert"
          className="rounded-(--radius) border border-danger bg-danger-soft p-4 text-[13px] text-danger"
        >
          {problem}
        </div>
      ) : models === null ? (
        <div className="text-[13px] text-muted">{strings.loading}</div>
      ) : (
        <ModelsList models={models} onChange={setModels} locale={locale} />
      )}
    </main>
  );
}
