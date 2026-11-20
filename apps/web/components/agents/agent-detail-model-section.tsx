'use client';

import { ProblemLine } from './problem-line';
import { agentDetailStrings, type AgentDetailStrings } from './agent-detail-messages';
import { describeInheritance, type ModelSelectionValue } from '../models/catalog';
import { ModelSelector, ModelUnavailableNotice, useModelCatalog } from '../models/model-selector';
import type { VersionsLocale } from './versions-messages';

type CatalogState = ReturnType<typeof useModelCatalog>;

/** The picker and its "clear" button, or the loading / failure line standing in for them. */
function ModelPicker({
  catalogState,
  value,
  onChange,
  locale,
  words,
}: Readonly<{
  catalogState: CatalogState;
  value: ModelSelectionValue;
  onChange: (value: ModelSelectionValue) => void;
  locale: VersionsLocale;
  words: AgentDetailStrings;
}>) {
  if (catalogState.kind === 'loading') {
    return <p className="text-[13px] text-muted">{words.loadingModels}</p>;
  }
  if (catalogState.kind === 'failed') {
    return (
      <p className="text-[13px] text-danger" role="alert">
        <ProblemLine
          locale={locale}
          english={catalogState.reason}
          lead={words.modelsFailed}
          detail={catalogState.detail}
        />
      </p>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-2">
      <ModelSelector
        id="agent-detail-model"
        label={words.override}
        models={catalogState.catalog.models}
        value={value}
        onChange={onChange}
        inheritLabel={words.noOverride}
        ariaDescribedBy="model-inheritance-line"
        words={{ connection: words.connection, noModels: words.noModelsAvailable }}
      />
      <button
        type="button"
        className="text-[12px] text-accent underline disabled:pointer-events-none disabled:opacity-45"
        disabled={value === null}
        onClick={() => onChange(null)}
      >
        {words.clearOverride}
      </button>
    </div>
  );
}

/**
 * Issue #130's Acceptance Criteria: "Agent detail can change or clear an override." Extracted from
 * `AgentDetailScreen` for the same reason `agent-form.tsx` exports `ModelStep` separately — a
 * screen driven entirely by two `useEffect` fetches can only ever be asserted in its pre-fetch
 * "Loading…" state by a static render, so the actual editing behaviour is tested against this
 * component directly, with `catalogState` and `value` supplied by the test rather than by a mock
 * `fetch`.
 */
export function AgentModelSection({
  catalogState,
  value,
  onChange,
  locale = 'en',
}: Readonly<{
  catalogState: CatalogState;
  value: ModelSelectionValue;
  onChange: (value: ModelSelectionValue) => void;
  /** The reader's language; English when absent. */
  locale?: VersionsLocale;
}>) {
  const words = agentDetailStrings(locale);
  const catalogModels = catalogState.kind === 'ready' ? catalogState.catalog.models : [];
  const catalogUnavailable = catalogState.kind === 'ready' ? catalogState.catalog.unavailable : [];
  return (
    <section
      className="rounded-(--radius) border border-border bg-surface p-4"
      aria-labelledby="model-heading"
    >
      <h2 id="model-heading" className="mb-1 text-[15px] font-semibold">
        {words.model}
      </h2>
      <p className="mb-3 text-[12.5px] text-muted">{words.modelHelp}</p>
      <ModelPicker
        catalogState={catalogState}
        value={value}
        onChange={onChange}
        locale={locale}
        words={words}
      />
      <p id="model-inheritance-line" className="mt-1.5 text-[12px] text-muted">
        {value === null
          ? words.overrideNotSet
          : describeInheritance(words.agentOverride, value, catalogModels, words.staleModel)}
      </p>
      <ModelUnavailableNotice unavailable={catalogUnavailable} dismissLabel={words.dismiss} />
    </section>
  );
}
