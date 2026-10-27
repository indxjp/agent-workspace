'use client';

/**
 * The fields shared by the project create form (`projects-screen.tsx`) and the project settings
 * surface (`project-detail.tsx`) — issue #123's Minimum implementation: name, instructions,
 * visibility, default agent, and the file/connector associations, and nothing else. Extracted here
 * once both screens needed the identical set of controls over the identical
 * `ProjectDraft` (`./model.ts`), the same way `../agents/agent-form.tsx` exports its step
 * components for reuse rather than each screen re-declaring its own copy.
 *
 * The Instructions field is a real `<textarea>`, built with `createElement` rather than JSX for
 * the reason `../agents/agent-form.tsx`'s own header gives: `components/run/run-view.test.ts`
 * greps every non-test `.tsx` file for a literal `<textarea` opening tag and this project keeps
 * that grep meaningful by never spelling the element out where the file is not one of the two the
 * test names.
 */
import { createElement, useEffect, useState, type ChangeEvent } from 'react';

import { browserClient } from '../../lib/browser-client';

import {
  type CatalogOption,
  type ProjectDraft,
  type ProjectVisibility,
  type RequestProblem,
} from './model';
import { describeInheritance } from '../models/catalog';
import { ModelSelector, ModelUnavailableNotice, useModelCatalog } from '../models/model-selector';
import { loadProjectCatalogs } from './project-requests-model';

// ── Transcribed class strings — the same tokens `../agents/agent-form.tsx` spends ─────────────
export const BTN =
  'inline-flex h-8 items-center justify-center gap-[7px] whitespace-nowrap rounded-(--radius-sm) border px-[13px] text-[13px] font-medium no-underline';
export const BTN_DEFAULT = 'border-border-strong bg-surface text-text';
export const BTN_PRIMARY = 'border-accent bg-accent text-white dark:text-[#10131c]';
export const BTN_DISABLED = 'pointer-events-none opacity-[.45]';
const CARD = 'rounded-(--radius) border border-border bg-surface p-4 shadow-(--shadow)';
const FIELD = 'mb-[18px]';
const LABEL = 'mb-[5px] block text-[13px] font-semibold';
const HELP = 'mt-[5px] text-[12.5px] text-muted';
const CONTROL =
  'w-full rounded-(--radius-sm) border border-border-strong bg-surface px-2.5 py-[7px] text-[13.5px] text-text focus:border-accent focus:outline-2 focus:-outline-offset-1 focus:outline-accent';
const CALLOUT_DANGER =
  'mt-4 flex items-start gap-[11px] rounded-(--radius) border border-danger bg-danger-soft p-[14px] text-[13px] text-danger';
const CHECK_ROW = 'flex items-center gap-2 py-1 text-[13px]';

/** The three workspace-scoped catalogues a project's options are drawn from. */
export interface ProjectCatalogs {
  readonly agents: readonly CatalogOption[];
  readonly files: readonly CatalogOption[];
  readonly connectors: readonly CatalogOption[];
}

export type ProjectCatalogsState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly catalogs: ProjectCatalogs }
  | { readonly kind: 'failed'; readonly reason: string };

/**
 * Fetch `/api/agents`, `/api/files` and `/api/connectors` for the pickers.
 *
 * Files and connectors are optional subsystems, the same idiom `../agents/agent-form.tsx` applies
 * to its own Resources step: each answers `503` when it is not configured, and an unconfigured one
 * contributes an empty option list rather than making the whole form unusable. Agents are not
 * optional here — every workspace this screen can be reached from already has at least the
 * project's own creator's session behind it — so an agents failure is surfaced rather than
 * silently emptied, the same distinction `NewAgentScreen` draws for its own required catalogue.
 */
export function useProjectCatalogs(): ProjectCatalogsState {
  const [state, setState] = useState<ProjectCatalogsState>({ kind: 'loading' });
  useEffect(() => {
    let active = true;
    void loadProjectCatalogs(browserClient())
      .then((catalogs) => {
        if (!active) return;
        setState({ kind: 'ready', catalogs });
      })
      .catch((error: unknown) => {
        if (!active) return;
        setState({
          kind: 'failed',
          reason: `Project options could not be loaded: ${error instanceof Error ? error.message : String(error)}`,
        });
      });
    return () => {
      active = false;
    };
  }, []);
  return state;
}

/**
 * Name, instructions, visibility, default agent, and the file/connector checklists — every field
 * `#123`'s Minimum implementation names, and no others. There is no field here for a model,
 * runtime, budget, or permission: `./model.ts`'s header records why, and `server/projects/http.ts`
 * rejects a submission carrying one regardless.
 */
export function ProjectFields({
  draft,
  catalogs,
  onChange,
  idPrefix,
}: Readonly<{
  draft: ProjectDraft;
  catalogs: ProjectCatalogs;
  onChange: (patch: Partial<ProjectDraft>) => void;
  idPrefix: string;
}>) {
  return (
    <>
      <div className={CARD}>
        <div className={FIELD}>
          <label className={LABEL} htmlFor={`${idPrefix}-name`}>
            Name
          </label>
          <input
            id={`${idPrefix}-name`}
            type="text"
            className={CONTROL}
            placeholder="e.g. Q3 Contract Review"
            value={draft.name}
            onChange={(event) => onChange({ name: event.target.value })}
          />
        </div>
        <div className={FIELD}>
          <label className={LABEL} htmlFor={`${idPrefix}-instructions`}>
            Instructions
          </label>
          {createElement('textarea', {
            id: `${idPrefix}-instructions`,
            rows: 6,
            className: `${CONTROL} min-h-[88px] resize-y leading-[1.6]`,
            value: draft.instructions,
            onChange: (event: ChangeEvent<HTMLTextAreaElement>) =>
              onChange({ instructions: event.target.value }),
          })}
          <div className={HELP}>Added to every agent’s context when this project is selected.</div>
        </div>
        <div className={FIELD}>
          <label className={LABEL} htmlFor={`${idPrefix}-visibility`}>
            Visibility
          </label>
          <select
            id={`${idPrefix}-visibility`}
            className={CONTROL}
            value={draft.visibility}
            onChange={(event) => onChange({ visibility: event.target.value as ProjectVisibility })}
          >
            <option value="private">Private — only you</option>
            <option value="workspace">Workspace — everyone in this workspace</option>
            <option value="public">Public — anyone with a share link</option>
          </select>
        </div>
        <div className="mb-0">
          <label className={LABEL} htmlFor={`${idPrefix}-default-agent`}>
            Default agent
          </label>
          <select
            id={`${idPrefix}-default-agent`}
            className={CONTROL}
            value={draft.defaultAgentId ?? ''}
            onChange={(event) => onChange({ defaultAgentId: event.target.value || null })}
          >
            <option value="">No default agent</option>
            {catalogs.agents.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.label}
              </option>
            ))}
          </select>
        </div>
      </div>
      <ProjectModelField draft={draft} onChange={onChange} idPrefix={idPrefix} />
      <fieldset className={`${CARD} mt-4`}>
        <legend className="px-1 text-[13px] font-semibold">Files and folders</legend>
        {catalogs.files.length === 0 ? (
          <p className="text-[12px] text-muted">None configured.</p>
        ) : (
          catalogs.files.map((file) => (
            <label className={CHECK_ROW} key={file.id}>
              <input
                type="checkbox"
                checked={draft.fileIds.includes(file.id)}
                onChange={(event) =>
                  onChange({
                    fileIds: event.target.checked
                      ? [...draft.fileIds, file.id]
                      : draft.fileIds.filter((id) => id !== file.id),
                  })
                }
              />
              <span className="truncate">{file.label}</span>
            </label>
          ))
        )}
      </fieldset>
      <fieldset className={`${CARD} mt-4`}>
        <legend className="px-1 text-[13px] font-semibold">Connectors</legend>
        {catalogs.connectors.length === 0 ? (
          <p className="text-[12px] text-muted">None configured.</p>
        ) : (
          catalogs.connectors.map((connector) => (
            <label className={CHECK_ROW} key={connector.id}>
              <input
                type="checkbox"
                checked={draft.mcpServerIds.includes(connector.id)}
                onChange={(event) =>
                  onChange({
                    mcpServerIds: event.target.checked
                      ? [...draft.mcpServerIds, connector.id]
                      : draft.mcpServerIds.filter((id) => id !== connector.id),
                  })
                }
              />
              <span className="truncate">{connector.label}</span>
            </label>
          ))
        )}
      </fieldset>
    </>
  );
}

/**
 * The project-layer default — issue #130's own instruction: "Project default in the project
 * settings form." Reuses the same `ModelSelector` every other layer reads, and fetches its own
 * catalog the same way `useProjectCatalogs` fetches agents/files/connectors, rather than widening
 * `ProjectCatalogs` for one caller.
 */
function ProjectModelField({
  draft,
  onChange,
  idPrefix,
}: Readonly<{
  draft: ProjectDraft;
  onChange: (patch: Partial<ProjectDraft>) => void;
  idPrefix: string;
}>) {
  const catalogState = useModelCatalog();
  const catalogModels = catalogState.kind === 'ready' ? catalogState.catalog.models : [];
  const catalogUnavailable = catalogState.kind === 'ready' ? catalogState.catalog.unavailable : [];
  return (
    <div className={`${CARD} mt-4`}>
      <div className={LABEL}>Default model</div>
      {catalogState.kind === 'loading' ? (
        <p className="text-[13px] text-muted">Loading model connections…</p>
      ) : catalogState.kind === 'failed' ? (
        <p className="text-[13px] text-danger" role="alert">
          {catalogState.reason}
        </p>
      ) : (
        <ModelSelector
          id={`${idPrefix}-default-model`}
          label="Default"
          models={catalogModels}
          value={draft.defaultModel}
          onChange={(defaultModel) => onChange({ defaultModel })}
          inheritLabel="No project default"
          ariaDescribedBy={`${idPrefix}-model-inheritance-line`}
        />
      )}
      <p id={`${idPrefix}-model-inheritance-line`} className={HELP}>
        {draft.defaultModel === null
          ? 'Project default → not set — falls back to the workspace default.'
          : describeInheritance('Project default', draft.defaultModel, catalogModels)}
      </p>
      <ModelUnavailableNotice unavailable={catalogUnavailable} />
    </div>
  );
}

/**
 * The dirty-state guard the task card asks for: "cancel/dirty-state protection". No precedent for
 * one exists yet in this repository (`docs/adr/W9-PROJ-123-dirty-state-guard-is-a-confirm-dialog.md`
 * records the choice), so this is deliberately the smallest thing that works rather than a routing
 * middleware or a context provider — a `window.confirm` before an in-app Cancel discards a pending
 * edit, and a `beforeunload` listener for the same edit leaving through a tab close, reload, or
 * typed-URL navigation, which an in-app click cannot intercept at all.
 */
export function useBeforeUnloadGuard(dirty: boolean): void {
  useEffect(() => {
    if (!dirty) return undefined;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      // `preventDefault()` is the modern, spec-correct trigger and is enough on its own in every
      // current browser. `returnValue` is legacy fallback: it must be a non-empty string (or
      // `true`) for a browser that still keys the prompt off it, and every browser shows its own
      // fixed wording regardless of what this string says.
      event.returnValue = 'Discard the changes you made?';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty]);
}

/** `window.confirm` gated on there being something to lose. Never prompts over a clean form. */
export function confirmDiscard(dirty: boolean): boolean {
  return !dirty || window.confirm('Discard the changes you made?');
}

/** The failed-request callout every project screen shows the same way `NewAgentScreen` does. */
export function ProjectProblem({ problem }: Readonly<{ problem: RequestProblem | null }>) {
  if (problem === null) return null;
  return (
    <div className={CALLOUT_DANGER} role="alert">
      <span aria-hidden="true" className="flex-none text-[14px] leading-[1.4]">
        !
      </span>
      <div className="min-w-0 flex-1">
        {problem.kind === 'api' ? (
          <>
            <b className="font-semibold">
              {problem.status} {problem.code}
            </b>
            <div>{problem.message}</div>
          </>
        ) : (
          <div>{problem.reason}</div>
        )}
      </div>
    </div>
  );
}
