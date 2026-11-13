'use client';

import { useCallback, useEffect, useState } from 'react';
import { browserClient } from '../../lib/browser-client';
import { errorText, type ResourcesClient } from './resources-model';

export function title(name: string, description: string, action?: React.ReactNode) {
  return (
    <div className="mb-6 flex items-start justify-between gap-4">
      <div>
        <h1 className="text-2xl font-semibold text-text">{name}</h1>
        <p className="mt-1 text-sm text-muted">{description}</p>
      </div>
      {action}
    </div>
  );
}

/** A page's one read, kept until the next one arrives; `load` must be stable between renders. */
export function useJson(load: (client: ResourcesClient) => Promise<Record<string, unknown>>) {
  const [value, setValue] = useState<Record<string, unknown> | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const reload = useCallback(async () => {
    setProblem(null);
    setValue(await load(browserClient()));
  }, [load]);
  useEffect(() => {
    void reload().catch((error: unknown) => setProblem(errorText(error)));
  }, [reload]);
  return { value, problem, loading: value === null && problem === null, reload, setProblem };
}

/**
 * Sends a destructive call and reloads the list. A refusal or a network failure shows in the
 * screen's status line instead of a silent reload that looks like success.
 */
export function deleteThenReload(
  state: ReturnType<typeof useJson>,
  remove: (client: ResourcesClient) => Promise<unknown>,
): void {
  remove(browserClient())
    .then(() => state.reload())
    .catch((error: unknown) => state.setProblem(errorText(error)));
}

export function rows(
  value: Record<string, unknown> | null,
  key: string,
): Record<string, unknown>[] {
  const collection = value?.[key];
  return Array.isArray(collection)
    ? collection.filter(
        (item): item is Record<string, unknown> => typeof item === 'object' && item !== null,
      )
    : [];
}

type RowWithStrings<Key extends string> = Record<string, unknown> & Readonly<Record<Key, string>>;

/** Keep malformed successful API rows out of render paths that require named string fields. */
export function rowsWithStrings<const Key extends string>(
  value: Record<string, unknown> | null,
  collection: string,
  ...fields: readonly Key[]
): RowWithStrings<Key>[] {
  return rows(value, collection).filter((row): row is RowWithStrings<Key> =>
    fields.every((field) => typeof row[field] === 'string'),
  );
}

export function formString(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value : '';
}

export function display(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
}

export function Status({ problem }: { problem: string | null }) {
  return problem === null ? null : (
    <p className="mb-4 text-sm text-danger" role="alert">
      {problem}
    </p>
  );
}
