'use client';

/** The new-agent form and its form/chat mode entry point. */

import { Fragment } from 'react';
import type { AgentPermissionKey, AgentPermissions } from '../../contracts/agents';
import { type RuntimeProfileOption } from './model';
import { findCatalogEntry, type CatalogModel, type ModelSelectionValue } from '../models/catalog';
import { ModelSelector, ModelUnavailableNotice } from '../models/model-selector';
import { CARD } from './agent-form-styles';
import { newAgentStrings, PERMISSION_ORDER, type AgentStepWords } from './new-agent-messages';

const EN_WORDS = newAgentStrings('en');

/** The read-mode body every step shares: labelled values as text, never inputs. */
export function ReadList({
  rows,
  className = `${CARD} p-4`,
}: Readonly<{ rows: readonly (readonly [label: string, value: string])[]; className?: string }>) {
  return (
    <dl className={`${className} grid gap-x-4 gap-y-1 text-[13px] sm:grid-cols-[max-content_1fr]`}>
      {rows.map(([label, value]) => (
        <Fragment key={label}>
          <dt className="font-semibold">{label}</dt>
          <dd className="min-w-0 break-words text-muted">{value}</dd>
        </Fragment>
      ))}
    </dl>
  );
}

/**
 * Step 2 — issue #130's reusable selector, first use. `models`/`unavailable` are the joined
 * catalog `useModelCatalog` produced; nothing here re-derives a capability or a display name.
 */
export function ModelStep({
  models,
  unavailable,
  value,
  onSelect,
  readOnly = false,
  words = EN_WORDS,
  title = words.modelTitle,
}: Readonly<{
  models: readonly CatalogModel[];
  unavailable: readonly { readonly connectionName: string; readonly reason: string }[];
  value: ModelSelectionValue;
  onSelect: (value: ModelSelectionValue) => void;
  readOnly?: boolean;
  /** The reader's words; English when the screen passes none. */
  words?: AgentStepWords;
  /** The form numbers its steps; a screen that shows them in another order names them only. */
  title?: string;
}>) {
  const selected = findCatalogEntry(models, value);
  return (
    <section className="mt-4" aria-labelledby="model-heading">
      <h2 id="model-heading" className="mb-3 text-[15px]">
        {title}
      </h2>
      {readOnly ? (
        <ReadList
          rows={[
            [words.model, selected?.displayName ?? (value?.model || words.deploymentDefault)],
            [
              words.connection,
              selected?.connectionName ?? (value?.connectionId || words.deploymentDefault),
            ],
          ]}
        />
      ) : models.length === 0 ? (
        <div className={`${CARD} p-4 text-[13px] text-muted`}>{words.noModelConnections}</div>
      ) : (
        <div className={`${CARD} p-4`}>
          <ModelSelector
            id="agent-model"
            label={words.model}
            models={models}
            value={value}
            onChange={onSelect}
            words={{ connection: words.connection, noModels: words.noModelsAvailable }}
          />
        </div>
      )}
      {readOnly ? null : (
        <ModelUnavailableNotice unavailable={unavailable} dismissLabel={words.dismiss} />
      )}
      {!readOnly && selected !== undefined && !selected.capabilities.promptCaching ? (
        <div
          role="alert"
          className="mt-3 whitespace-pre-line rounded-(--radius) border border-warn bg-warn-soft p-[14px] text-[13px] text-warn"
        >
          {words.promptCachingWarning}
        </div>
      ) : null}
    </section>
  );
}

export function RuntimeProfileStep({
  profiles,
  selectedId,
  onSelect,
  readOnly = false,
  words = EN_WORDS,
  title = words.runtimeTitle,
}: Readonly<{
  profiles: readonly RuntimeProfileOption[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  readOnly?: boolean;
  /** The reader's words; English when the screen passes none. */
  words?: AgentStepWords;
  /** The form numbers its steps; a screen that shows them in another order names them only. */
  title?: string;
}>) {
  return (
    <section className="mt-4" aria-labelledby="runtime-profile-heading">
      <h2 id="runtime-profile-heading" className="mb-3 text-[15px]">
        {title}
      </h2>
      {readOnly ? (
        <ReadList
          rows={[
            [words.runtimeProfile, profiles.find((p) => p.id === selectedId)?.name ?? words.none],
          ]}
        />
      ) : profiles.length === 0 ? (
        <div className={`${CARD} p-4 text-[13px] text-muted`}>{words.noRuntimeProfiles}</div>
      ) : (
        <div className={CARD}>
          {profiles.map((profile) => (
            <button
              key={profile.id}
              type="button"
              aria-pressed={selectedId === profile.id}
              onClick={() => onSelect(profile.id)}
              className={`flex w-full items-start gap-3 border-b border-border p-3 text-left last:border-b-0 ${
                selectedId === profile.id ? 'bg-accent-soft' : 'bg-surface'
              }`}
            >
              <span className="min-w-0 flex-1">
                <span className="block text-[13.5px] font-semibold">{profile.name}</span>
                <span className="mt-0.5 block text-[12px] text-muted">{profile.driver}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

/** Each permission's key, name and help, in the form's order, in the reader's words. */
export function permissionChoices(
  words: AgentStepWords,
): ReadonlyArray<readonly [AgentPermissionKey, string, string]> {
  return PERMISSION_ORDER.map((key) => [key, ...words.permissions[key]] as const);
}

/** The English choices, which the detail screen, projects and the approval card still read. */
export const PERMISSION_CHOICES: ReadonlyArray<readonly [AgentPermissionKey, string, string]> =
  permissionChoices(EN_WORDS);

export function PermissionsStep({
  permissions,
  onChange,
  readOnly = false,
  words = EN_WORDS,
  title = words.permissionsTitle,
}: Readonly<{
  permissions: AgentPermissions;
  onChange: (key: AgentPermissionKey, enabled: boolean) => void;
  readOnly?: boolean;
  /** The reader's words; English when the screen passes none. */
  words?: AgentStepWords;
  /** The form numbers its steps; a screen that shows them in another order names them only. */
  title?: string;
}>) {
  if (readOnly) {
    return (
      <fieldset className={`${CARD} mt-4 p-4`}>
        <legend className="px-1 text-[15px] font-semibold">{title}</legend>
        <ReadList
          className=""
          rows={permissionChoices(words).map(([key, label]) => [
            label,
            permissions[key] ? words.allowed : words.notAllowed,
          ])}
        />
      </fieldset>
    );
  }
  return (
    <fieldset className={`${CARD} mt-4 p-4`}>
      <legend className="px-1 text-[15px] font-semibold">{title}</legend>
      <p className="mb-3 text-[12px] text-muted">{words.permissionsIntro}</p>
      {permissionChoices(words).map(([key, label, help]) => (
        <label
          className="flex items-start gap-3 border-b border-border py-2 last:border-b-0"
          key={key}
        >
          <input
            className="mt-1"
            type="checkbox"
            checked={permissions[key]}
            onChange={(event) => onChange(key, event.target.checked)}
          />
          <span>
            <span className="block text-[13px] font-semibold">{label}</span>
            <span className="block text-[12px] text-muted">{help}</span>
          </span>
        </label>
      ))}
    </fieldset>
  );
}
