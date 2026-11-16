'use client';

/**
 * Issue #133's editable file/skill/connector assignment editor, extracted from `agent-detail.tsx`
 * the same way `agent-form.tsx` extracts its own step components: a screen driven by fetch effects
 * can only be asserted in its pre-fetch state by a static render, so the actual editing behaviour
 * (`FileAssignments`, `NamedAssignments`, `ProjectProvidedResources`) is tested against these
 * components directly, with catalogs and assignments supplied as props.
 *
 * `useResourceCatalogs` resolves the id → name/path catalogs `resolveFileGrants`/
 * `resolveNamedAssignments` (`./model.ts`) need to render an assignment "by name" — see that
 * module's own header for why no route hands back a name directly. `useAgentProjects` is the
 * read-only project-association half (`docs/adr/W9-PROJ-125-project-resources-narrow-never-widen.md`).
 */
import { useEffect, useRef, useState } from 'react';

import type { AgentPermissions, AgentResourceAssignments } from '../../contracts/agents';
import type { ProjectResource } from '../../contracts/projects';
import { browserClient } from '../../lib/browser-client';
import { loadAgentProjects, loadResourceCatalogs } from './agent-requests-model';
import {
  projectProvidedGroups,
  resolveFileGrants,
  resolveNamedAssignments,
  type FileCatalog,
  type NamedCatalog,
} from './model';
import { agentDetailStrings } from './agent-detail-messages';
import { ProblemLine } from './problem-line';
import type { VersionsLocale } from './versions-messages';
import { FilePicker, type FilePickerSelection } from '../resources/resource-screens';
import {
  ConnectedStorage,
  StorageGrantList,
  useStorageConnections,
} from '../storage/connected-storage';

const CARD = 'rounded-(--radius) border border-border bg-surface p-4';
/**
 * A `<fieldset>` is as wide as its widest content by default (`min-inline-size: min-content`), so
 * the file picker's table pushed the whole tab sideways on a phone; `min-w-0` lets the table scroll
 * inside its own card instead.
 */
const FIELDSET = `${CARD} min-w-0`;
const CONTROL =
  'rounded-(--radius-sm) border border-border-strong bg-surface px-2 py-1 text-[12.5px] text-text focus:border-accent focus:outline-2 focus:-outline-offset-1 focus:outline-accent';
const ROW =
  'flex flex-wrap items-center gap-2 border-b border-border py-2 text-[13px] last:border-b-0';
const BADGE_MISSING =
  'rounded-full border border-danger bg-danger-soft px-2 py-0.5 text-[11px] font-medium text-danger';
const BADGE_DISABLED =
  'rounded-full border border-border-strong bg-surface px-2 py-0.5 text-[11px] font-medium text-muted';
const BTN_SM =
  'rounded-(--radius-sm) border border-border-strong bg-surface px-2 py-1 text-[12px] font-medium text-text disabled:pointer-events-none disabled:opacity-45';

export type CatalogsState =
  | { readonly kind: 'loading' }
  | {
      readonly kind: 'ready';
      readonly files: FileCatalog;
      readonly skills: NamedCatalog;
      readonly connectors: NamedCatalog;
    }
  | { readonly kind: 'failed'; readonly reason: string; readonly detail: string };

/**
 * Files, skills, and connectors are optional subsystems in this deployment (each answers `503`
 * when unconfigured) — the same idiom `agent-form.tsx`'s `NewAgentScreen` already applies to its
 * own Resources step — so an unconfigured one contributes an empty catalog rather than failing the
 * whole editor. A genuine transport failure on the file walk (the one request the editor cannot do
 * without) still surfaces as `failed`, because a name lookup that silently came back empty would
 * mislabel every existing file grant as missing.
 */
export function useResourceCatalogs(): CatalogsState {
  const [state, setState] = useState<CatalogsState>({ kind: 'loading' });
  useEffect(() => {
    let active = true;
    void loadResourceCatalogs(browserClient()).then(
      (catalogs) => {
        if (active) setState({ kind: 'ready', ...catalogs });
      },
      (error: unknown) => {
        if (active) {
          const detail = error instanceof Error ? error.message : String(error);
          setState({
            kind: 'failed',
            reason: `Resource names could not be loaded: ${detail}`,
            detail,
          });
        }
      },
    );
    return () => {
      active = false;
    };
  }, []);
  return state;
}

export type ProjectsState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly projects: readonly ProjectResource[] }
  | { readonly kind: 'failed'; readonly reason: string; readonly detail: string };

/** `GET /api/projects` for the read-only "project-provided" group. See `./model.ts`'s
 *  `projectProvidedGroups` for which projects this becomes visible on. */
export function useAgentProjects(): ProjectsState {
  const [state, setState] = useState<ProjectsState>({ kind: 'loading' });
  useEffect(() => {
    let active = true;
    void loadAgentProjects(browserClient()).then(
      (projects) => {
        if (active) setState({ kind: 'ready', projects });
      },
      (error: unknown) => {
        if (active) {
          const detail = error instanceof Error ? error.message : String(error);
          setState({
            kind: 'failed',
            reason: `Project associations could not be loaded: ${detail}`,
            detail,
          });
        }
      },
    );
    return () => {
      active = false;
    };
  }, []);
  return state;
}

function catalogsOf(state: CatalogsState) {
  return state.kind === 'ready'
    ? { files: state.files, skills: state.skills, connectors: state.connectors }
    : { files: null, skills: null, connectors: null };
}

/**
 * Files and folders: the one group with a per-grant access mode and the nested picker. Reuses
 * `../resources/resource-screens.tsx`'s `FilePicker` verbatim (issue #132's own published mode —
 * declared gap G-3 notes it is not adopted anywhere else yet) rather than re-implementing folder
 * browsing; `FilePicker` tracks its own in-progress selection and reports the full current pick on
 * every change, so newly browsed files/folders land in a `pending` basket here and only join the
 * real assignment list once "Add selected" is clicked — the existing assignment list (with its own
 * per-row access selector and Remove button) is what actually manages what is assigned, exactly
 * the separation the card asks for between adding a resource and changing one already assigned.
 */
export function FileAssignments({
  files,
  catalog,
  writeFilesAllowed,
  onChange,
  storage,
  locale = 'en',
}: Readonly<{
  files: AgentResourceAssignments['files'];
  catalog: FileCatalog | null;
  writeFilesAllowed: boolean;
  onChange: (next: AgentResourceAssignments['files']) => void;
  /** Connected storage: the agent, its saved grants and the callback for a newly saved grant. */
  storage?: {
    agentId: string;
    grants: AgentResourceAssignments['storageGrants'];
    onGranted: (next: AgentResourceAssignments) => void;
  };
  /** The reader's language; English when absent. */
  locale?: VersionsLocale;
}>) {
  const words = agentDetailStrings(locale).editor;
  const [browsing, setBrowsing] = useState(false);
  const [source, setSource] = useState<'workspace' | 'storage'>('workspace');
  const [pending, setPending] = useState<readonly FilePickerSelection[]>([]);
  const grantsRef = useRef<HTMLUListElement>(null);
  const addRef = useRef<HTMLButtonElement>(null);
  const grants = storage?.grants ?? [];
  const connections = useStorageConnections(
    storage !== undefined && ((browsing && source === 'storage') || grants.length > 0),
    locale,
  );
  const rows = resolveFileGrants(files, catalog);

  const setAccess = (fileId: string, access: 'read' | 'read-write') => {
    onChange(files.map((grant) => (grant.fileId === fileId ? { ...grant, access } : grant)));
  };
  const remove = (fileId: string) => {
    onChange(files.filter((grant) => grant.fileId !== fileId));
  };
  const addPending = () => {
    const existing = new Set(files.map((grant) => grant.fileId));
    const additions = pending
      .filter((selection) => !existing.has(selection.id))
      .map((selection) => ({ fileId: selection.id, access: 'read' as const }));
    onChange([...files, ...additions]);
    setPending([]);
    setBrowsing(false);
  };

  return (
    <fieldset className={FIELDSET} aria-labelledby="agent-files-heading">
      <legend id="agent-files-heading" className="px-1 text-[13px] font-semibold">
        {words.filesAndFolders}
      </legend>
      {rows.length === 0 ? (
        <p className="py-1 text-[12.5px] text-muted">{words.noFiles}</p>
      ) : (
        <ul>
          {rows.map((row) => (
            <li className={ROW} key={row.fileId}>
              <span className="min-w-0 flex-1 truncate">
                {row.path ?? words.unresolvedFile(row.fileId)}
              </span>
              {row.missing ? <span className={BADGE_MISSING}>{words.missing}</span> : null}
              <select
                aria-label={words.accessFor(row.path ?? row.fileId)}
                className={CONTROL}
                value={row.access}
                onChange={(event) =>
                  setAccess(row.fileId, event.target.value as 'read' | 'read-write')
                }
              >
                <option value="read">{words.read}</option>
                <option value="read-write">{words.readWrite}</option>
              </select>
              <button type="button" className={BTN_SM} onClick={() => remove(row.fileId)}>
                {words.remove}
              </button>
              {row.access === 'read-write' && !writeFilesAllowed ? (
                <p role="alert" className="w-full text-[12px] text-warn">
                  {words.readOnlyUntilWriteFiles}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {storage === undefined ? null : (
        <StorageGrantList
          agentId={storage.agentId}
          grants={grants}
          connections={connections}
          listRef={grantsRef}
          focusWhenEmpty={addRef}
          onChanged={storage.onGranted}
          locale={locale}
        />
      )}
      <div className="mt-3">
        <button
          type="button"
          ref={addRef}
          className={BTN_SM}
          onClick={() => {
            setBrowsing((current) => !current);
            setPending([]);
          }}
        >
          {browsing ? words.closeBrowser : words.addFiles}
        </button>
        {browsing ? (
          <div className="mt-3 rounded border border-border p-3">
            {storage === undefined ? null : (
              <div className="mb-3 flex gap-2">
                <button
                  type="button"
                  className={BTN_SM}
                  aria-pressed={source === 'workspace'}
                  onClick={() => setSource('workspace')}
                >
                  {words.workspaceFiles}
                </button>
                <button
                  type="button"
                  className={BTN_SM}
                  aria-pressed={source === 'storage'}
                  onClick={() => setSource('storage')}
                >
                  {words.connectedStorage}
                </button>
              </div>
            )}
            {storage !== undefined && source === 'storage' ? (
              <ConnectedStorage
                agentId={storage.agentId}
                connections={connections}
                writeFilesAllowed={writeFilesAllowed}
                grantsRef={grantsRef}
                onGranted={storage.onGranted}
                locale={locale}
              />
            ) : (
              <>
                <FilePicker onChange={setPending} locale={locale} />
                <button
                  type="button"
                  className={`${BTN_SM} mt-2`}
                  disabled={pending.length === 0}
                  onClick={addPending}
                >
                  {words.addSelected(pending.length)}
                </button>
              </>
            )}
          </div>
        ) : null}
      </div>
    </fieldset>
  );
}

/** Skills or connectors: an id list with no access mode, shared between both groups. */
export function NamedAssignments({
  group,
  ids,
  catalog,
  onChange,
  locale = 'en',
}: Readonly<{
  /** Which group this is; its id, heading and labels follow from it. */
  group: 'skills' | 'connectors';
  ids: readonly string[];
  catalog: NamedCatalog | null;
  onChange: (next: readonly string[]) => void;
  /** The reader's language; English when absent. */
  locale?: VersionsLocale;
}>) {
  const words = agentDetailStrings(locale).editor;
  const heading = group === 'skills' ? words.skills : words.connectors;
  const [selectedToAdd, setSelectedToAdd] = useState('');
  const rows = resolveNamedAssignments(ids, catalog);
  const options =
    catalog === null ? [] : [...catalog.entries()].filter(([id]) => !ids.includes(id));

  const remove = (id: string) => onChange(ids.filter((existing) => existing !== id));
  const add = () => {
    if (selectedToAdd === '') return;
    onChange([...ids, selectedToAdd]);
    setSelectedToAdd('');
  };

  const headingId = `agent-${group}-heading`;
  return (
    <fieldset className={FIELDSET} aria-labelledby={headingId}>
      <legend id={headingId} className="px-1 text-[13px] font-semibold">
        {heading}
      </legend>
      {rows.length === 0 ? (
        <p className="py-1 text-[12.5px] text-muted">
          {group === 'skills' ? words.noSkills : words.noConnectors}
        </p>
      ) : (
        <ul>
          {rows.map((row) => (
            <li className={ROW} key={row.id}>
              <span className="min-w-0 flex-1 truncate">
                {row.name ?? words.unresolved(row.id)}
              </span>
              {row.missing ? (
                <span className={BADGE_MISSING}>{words.missing}</span>
              ) : row.enabled === false ? (
                <span className={BADGE_DISABLED}>{words.disabled}</span>
              ) : null}
              <button type="button" className={BTN_SM} onClick={() => remove(row.id)}>
                {words.remove}
              </button>
            </li>
          ))}
        </ul>
      )}
      {options.length === 0 ? null : (
        <div className="mt-3 flex items-center gap-2">
          <select
            aria-label={group === 'skills' ? words.addSkill : words.addConnector}
            className={CONTROL}
            value={selectedToAdd}
            onChange={(event) => setSelectedToAdd(event.target.value)}
          >
            <option value="">{words.chooseOne}</option>
            {options.map(([id, entry]) => (
              <option key={id} value={id}>
                {entry.name}
              </option>
            ))}
          </select>
          <button type="button" className={BTN_SM} disabled={selectedToAdd === ''} onClick={add}>
            {words.add}
          </button>
        </div>
      )}
    </fieldset>
  );
}

/**
 * Issue #125's project associations, read-only: `docs/adr/W9-PROJ-125-project-resources-narrow-never-widen.md`
 * still governs how these compose into a run; nothing here is editable, so a viewer is never
 * mistaken into thinking a change here would touch the project.
 */
export function ProjectProvidedResources({
  agentId,
  projectsState,
  files,
  connectors,
  locale = 'en',
}: Readonly<{
  agentId: string;
  projectsState: ProjectsState;
  files: FileCatalog | null;
  connectors: NamedCatalog | null;
  /** The reader's language; English when absent. */
  locale?: VersionsLocale;
}>) {
  const strings = agentDetailStrings(locale);
  const words = strings.editor;
  if (projectsState.kind === 'loading') return null;
  if (projectsState.kind === 'failed') {
    return (
      <p className="text-[12px] text-muted" role="status">
        <ProblemLine
          locale={locale}
          english={projectsState.reason}
          lead={strings.projectsFailed}
          detail={projectsState.detail}
        />
      </p>
    );
  }
  const groups = projectProvidedGroups(projectsState.projects, agentId, files, connectors);
  if (groups.length === 0) return null;
  return (
    <section className={CARD} aria-labelledby="project-resources-heading">
      <h3 id="project-resources-heading" className="mb-1 text-[13px] font-semibold">
        {words.projectProvided}
      </h3>
      <p className="mb-3 text-[12px] text-muted">{words.projectProvidedHelp}</p>
      {groups.map((group) => (
        <div
          key={group.projectId}
          className="border-t border-border pt-2 first:border-t-0 first:pt-0"
        >
          <p className="text-[12.5px] font-semibold">{group.projectName}</p>
          {group.files.length === 0 && group.connectors.length === 0 ? (
            <p className="text-[12px] text-muted">{words.noFilesOrConnectors}</p>
          ) : (
            <ul className="text-[12.5px] text-muted">
              {group.files.map((file) => (
                <li key={file.id}>
                  {file.path ?? words.unresolvedFile(file.id)}
                  {file.missing ? (
                    <span className={`${BADGE_MISSING} ml-2`}>{words.missing}</span>
                  ) : null}
                </li>
              ))}
              {group.connectors.map((connector) => (
                <li key={connector.id}>
                  {connector.name ?? words.unresolvedConnector(connector.id)}
                  {connector.missing ? (
                    <span className={`${BADGE_MISSING} ml-2`}>{words.missing}</span>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}
    </section>
  );
}

/**
 * The whole resources section: files/folders, skills, connectors, then the read-only
 * project-provided group — the card's four groups, in that order.
 */
export function AgentResourcesEditor({
  agentId,
  assignments,
  permissions,
  catalogsState,
  projectsState,
  onChange,
  locale = 'en',
}: Readonly<{
  agentId: string;
  assignments: AgentResourceAssignments;
  permissions: AgentPermissions;
  catalogsState: CatalogsState;
  projectsState: ProjectsState;
  onChange: (next: AgentResourceAssignments) => void;
  /** The reader's language; English when absent. */
  locale?: VersionsLocale;
}>) {
  const strings = agentDetailStrings(locale);
  const { files, skills, connectors } = catalogsOf(catalogsState);
  return (
    <section className="space-y-4" aria-labelledby="resources-heading">
      <h2 id="resources-heading" className="text-[15px] font-semibold">
        {strings.editor.heading}
      </h2>
      {catalogsState.kind === 'failed' ? (
        <p className="text-[13px] text-danger" role="alert">
          <ProblemLine
            locale={locale}
            english={catalogsState.reason}
            lead={strings.resourcesFailed}
            detail={catalogsState.detail}
          />
        </p>
      ) : null}
      <FileAssignments
        files={assignments.files}
        catalog={files}
        writeFilesAllowed={permissions.writeFiles}
        onChange={(next) => onChange({ ...assignments, files: next })}
        storage={{
          agentId,
          grants: assignments.storageGrants,
          onGranted: (next) => onChange({ ...assignments, storageGrants: next.storageGrants }),
        }}
        locale={locale}
      />
      <NamedAssignments
        group="skills"
        ids={assignments.skillIds}
        catalog={skills}
        onChange={(next) => onChange({ ...assignments, skillIds: next })}
        locale={locale}
      />
      <NamedAssignments
        group="connectors"
        ids={assignments.connectorIds}
        catalog={connectors}
        onChange={(next) => onChange({ ...assignments, connectorIds: next })}
        locale={locale}
      />
      <ProjectProvidedResources
        agentId={agentId}
        projectsState={projectsState}
        files={files}
        connectors={connectors}
        locale={locale}
      />
    </section>
  );
}
