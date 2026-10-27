'use client';

/**
 * The one `(connection, model)` picker every layer reuses — issue #130's own instruction: "One
 * selector component that treats `(connectionId, providerModelId)` as a single value drawn from
 * `#129`'s catalog, and is reused at every layer."
 *
 * A value is encoded onto the `<select>` element as `${connectionId}::${providerModelId}` — the
 * DOM has no way to carry a pair natively — and decoded back on every change; nothing here ever
 * stores or compares a display label.
 */
import { useEffect, useState } from 'react';

import { browserClient } from '../../lib/browser-client';
import { DismissibleNotice } from '../shell/dismissible-notice';

import type { Catalog, CatalogModel, ModelSelectionValue } from './catalog';
import { loadCatalog } from './connections-model';

export type ModelCatalogState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly catalog: Catalog }
  | { readonly kind: 'failed'; readonly reason: string };

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
        setState({
          kind: 'failed',
          reason: `Models could not be loaded: ${error instanceof Error ? error.message : String(error)}`,
        });
      });
    return () => {
      active = false;
    };
  }, []);
  return state;
}

const CONTROL =
  'h-[27px] rounded-[999px] border border-border-strong bg-surface px-2.5 text-[12.5px] text-text-2 disabled:opacity-60';

function encode(entry: Pick<CatalogModel, 'connectionId' | 'providerModelId'>): string {
  return `${entry.connectionId}::${entry.providerModelId}`;
}

function decode(raw: string): ModelSelectionValue {
  if (raw === '') return null;
  const separator = raw.indexOf('::');
  if (separator < 0) return null;
  return { connectionId: raw.slice(0, separator), model: raw.slice(separator + 2) };
}

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
}

/**
 * Grouped by connection (`<optgroup>`), so two connections offering a model of the same display
 * name are never ambiguous in the list. A connection with nothing to select is never rendered as a
 * choosable group — it is named, with its reason, in the unavailable notice beneath the control
 * (see `<ModelUnavailableNotice>` below) instead of as a disabled option a screen reader announces
 * without saying why.
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
}: Readonly<ModelSelectorProps>) {
  const byConnection = new Map<string, { name: string; entries: CatalogModel[] }>();
  for (const entry of models) {
    const group = byConnection.get(entry.connectionId);
    if (group === undefined) {
      byConnection.set(entry.connectionId, { name: entry.connectionName, entries: [entry] });
    } else {
      group.entries.push(entry);
    }
  }
  const selectedValue =
    value === null
      ? ''
      : encode({ connectionId: value.connectionId, providerModelId: value.model });
  return (
    <label className="inline-flex items-center gap-1.5" htmlFor={id}>
      <span className="text-[12.5px] text-text-2">{label}</span>
      <select
        id={id}
        className={CONTROL}
        value={selectedValue}
        disabled={disabled || models.length === 0}
        aria-describedby={ariaDescribedBy}
        onChange={(event) => onChange(decode(event.target.value))}
      >
        {inheritLabel === undefined ? null : <option value="">{inheritLabel}</option>}
        {models.length === 0 && inheritLabel === undefined ? (
          <option value="">No models available</option>
        ) : null}
        {[...byConnection.entries()].map(([connectionId, group]) => (
          <optgroup key={connectionId} label={group.name}>
            {group.entries.map((entry) => (
              <option key={encode(entry)} value={encode(entry)}>
                {entry.displayName}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
    </label>
  );
}

/** The reasons behind every connection this control cannot offer a model from — "the recovery
 *  step" the card asks a blocked state to name, in the caller's own words back. */
export function ModelUnavailableNotice({
  unavailable,
}: Readonly<{
  unavailable: readonly { readonly connectionName: string; readonly reason: string }[];
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
