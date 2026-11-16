'use client';

/**
 * The one `(connection, model)` picker every layer reuses — issue #130's own instruction: "One
 * selector component that treats `(connectionId, providerModelId)` as a single value drawn from
 * `#129`'s catalog, and is reused at every layer."
 *
 * Nothing here ever stores or compares a display label: the model control carries the provider
 * model id and the connection control the connection id.
 */
import { useEffect, useState } from 'react';

import { browserClient } from '../../lib/browser-client';
import { DismissibleNotice } from '../shell/dismissible-notice';

import type { Catalog, CatalogModel, ModelSelectionValue } from './catalog';
import { loadCatalog } from './connections-model';

export type ModelCatalogState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly catalog: Catalog }
  | {
      readonly kind: 'failed';
      /** The whole English sentence, as before. */
      readonly reason: string;
      /** The error's own text, for a screen that writes its own lead in the reader's language. */
      readonly detail: string;
    };

/**
 * `GET /api/models` (discovered models) and `GET /api/model-connections` (names, readiness),
 * read by {@link loadCatalog}. Both are optional subsystems — the same idiom every other
 * workspace-scoped screen in this application already applies: a `503` (the models runtime is not
 * configured, e.g. no `MASTER_ENCRYPTION_KEY`) contributes an empty catalog rather than an error
 * this control has no room to show, because "no models are configured yet" and "the subsystem is
 * off" look the same to someone choosing a model. A genuine transport failure is not swallowed the
 * same way — it is the caller's own connectivity that is in question, not a workspace's choice not
 * to configure providers.
 */
export function useModelCatalog(): ModelCatalogState {
  const [state, setState] = useState<ModelCatalogState>({ kind: 'loading' });
  useEffect(() => {
    let active = true;
    void loadCatalog(browserClient())
      .then((catalog) => {
        if (!active) return;
        setState({ kind: 'ready', catalog });
      })
      .catch((error: unknown) => {
        if (!active) return;
        const detail = error instanceof Error ? error.message : String(error);
        setState({ kind: 'failed', reason: `Models could not be loaded: ${detail}`, detail });
      });
    return () => {
      active = false;
    };
  }, []);
  return state;
}

const CONTROL =
  'h-[27px] rounded-[999px] border border-border-strong bg-surface px-2.5 text-[12.5px] text-text-2 disabled:opacity-60';

export interface ModelSelectorProps {
  readonly id: string;
  readonly label: string;
  readonly models: readonly CatalogModel[];
  readonly unavailable?: readonly { readonly connectionName: string; readonly reason: string }[];
  readonly value: ModelSelectionValue;
  readonly onChange: (value: ModelSelectionValue) => void;
  /** When present, the top option clears the value to `null` and reads this text — "Agent default",
   *  "Inherit the workspace default", etc. Omit it where clearing has no meaning (the workspace
   *  layer itself, which has nothing below it to inherit from). */
  readonly inheritLabel?: string;
  readonly disabled?: boolean;
  readonly ariaDescribedBy?: string;
  /** The control's own words in the reader's language; English when absent. */
  readonly words?: ModelSelectorWords;
}

interface ModelSelectorWords {
  readonly connection: string;
  readonly noModels: string;
}

const EN_SELECTOR_WORDS: ModelSelectorWords = {
  connection: 'Connection',
  noModels: 'No models available',
};

/**
 * Each model is listed once, however many connections offer it (UX-22). The value is still the
 * `(connectionId, model)` pair, because two connections carry different keys and limits: when the
 * chosen model is offered by more than one connection, a second control picks the connection, and
 * changing the model keeps the current connection when it offers the new one. A connection with
 * nothing to select is named, with its reason, in `<ModelUnavailableNotice>` below the control,
 * never as a disabled option a screen reader announces without saying why.
 */
export function ModelSelector({
  id,
  label,
  models,
  value,
  onChange,
  inheritLabel,
  disabled = false,
  ariaDescribedBy,
  words = EN_SELECTOR_WORDS,
}: Readonly<ModelSelectorProps>) {
  const byModel = new Map<string, CatalogModel[]>();
  for (const entry of models) {
    const offering = byModel.get(entry.providerModelId);
    if (offering === undefined) byModel.set(entry.providerModelId, [entry]);
    else offering.push(entry);
  }
  // Without connection groups, two different models with one display name would read the same.
  const nameCounts = new Map<string, number>();
  for (const [model, entries] of byModel) {
    const name = entries[0]?.displayName ?? model;
    nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
  }
  const optionLabel = (model: string, entries: readonly CatalogModel[]): string => {
    const name = entries[0]?.displayName ?? model;
    return (nameCounts.get(name) ?? 0) > 1 ? `${name} (${model})` : name;
  };
  const offering = value === null ? [] : (byModel.get(value.model) ?? []);
  function chooseModel(model: string): void {
    const entries = model === '' ? [] : (byModel.get(model) ?? []);
    const entry =
      entries.find((candidate) => candidate.connectionId === value?.connectionId) ?? entries[0];
    onChange(
      entry === undefined
        ? null
        : { connectionId: entry.connectionId, model: entry.providerModelId },
    );
  }
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <label className="text-[12.5px] text-text-2" htmlFor={id}>
        {label}
      </label>
      <select
        id={id}
        className={CONTROL}
        value={value?.model ?? ''}
        disabled={disabled || models.length === 0}
        aria-describedby={ariaDescribedBy}
        onChange={(event) => chooseModel(event.target.value)}
      >
        {inheritLabel === undefined ? null : <option value="">{inheritLabel}</option>}
        {models.length === 0 && inheritLabel === undefined ? (
          <option value="">{words.noModels}</option>
        ) : null}
        {[...byModel.entries()].map(([model, entries]) => (
          <option key={model} value={model}>
            {optionLabel(model, entries)}
          </option>
        ))}
      </select>
      {value === null || offering.length < 2 ? null : (
        <>
          <label className="text-[12.5px] text-text-2" htmlFor={`${id}-connection`}>
            {words.connection}
          </label>
          <select
            id={`${id}-connection`}
            className={CONTROL}
            value={value.connectionId}
            disabled={disabled}
            onChange={(event) => onChange({ connectionId: event.target.value, model: value.model })}
          >
            {offering.map((entry) => (
              <option key={entry.connectionId} value={entry.connectionId}>
                {entry.connectionName}
              </option>
            ))}
          </select>
        </>
      )}
    </span>
  );
}

/** The reasons behind every connection this control cannot offer a model from — "the recovery
 *  step" the card asks a blocked state to name, in the caller's own words back. */
export function ModelUnavailableNotice({
  unavailable,
  dismissLabel,
}: Readonly<{
  unavailable: readonly { readonly connectionName: string; readonly reason: string }[];
  /** The dismiss button's name in the reader's language; the notice's own default when absent. */
  dismissLabel?: string;
}>) {
  if (unavailable.length === 0) return null;
  // Entries carry no connection id, so the name and reason together are the condition: a new
  // failure, or a different reason for the same one, shows the notice again.
  const version = unavailable
    .map((entry) => `${entry.connectionName}:${entry.reason}`)
    .sort()
    .join('\n');
  return (
    <DismissibleNotice
      id="model-unavailable"
      version={version}
      className="mt-1.5 text-[11.5px] text-warn"
      role="status"
      testId="model-unavailable-notice"
      {...(dismissLabel === undefined ? {} : { dismissLabel })}
    >
      <ul>
        {unavailable.map((entry) => (
          <li key={entry.connectionName}>
            {entry.connectionName}: {entry.reason}
          </li>
        ))}
      </ul>
    </DismissibleNotice>
  );
}
