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
import { useEffect, useState } from 'react';

import type { AgentPermissions, AgentResourceAssignments } from '../../contracts/agents';
import { ProjectListResponseSchema, type ProjectResource } from '../../contracts/projects';
import {
  fetchFileCatalog,
  projectProvidedGroups,
  readNamedCatalog,
  resolveFileGrants,
  resolveNamedAssignments,
  type FileCatalog,
  type NamedCatalog,
} from './model';
import { FilePicker, toFileRows, type FilePickerSelection } from '../resources/resource-screens';

const CARD = 'rounded-(--radius) border border-border bg-surface p-4';
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
  | { readonly kind: 'failed'; readonly reason: string };

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
    void (async () => {
      try {
        const files = await fetchFileCatalog(async (path) => {
          const response = await fetch(`/api/files?path=${encodeURIComponent(path)}`, {
            headers: { accept: 'application/json' },
          });
          if (!response.ok) return [];
          return toFileRows((await response.json()) as Record<string, unknown>);
        });
        const [skillsResponse, connectorsResponse] = await Promise.all([
          fetch('/api/skills', { headers: { accept: 'application/json' } }),
          fetch('/api/connectors', { headers: { accept: 'application/json' } }),
        ]);
        const skills = readNamedCatalog(
          skillsResponse.ok ? await skillsResponse.json() : { skills: [] },
          'skills',
        );
        const connectors = readNamedCatalog(
          connectorsResponse.ok ? await connectorsResponse.json() : { connectors: [] },
          'connectors',
        );
        if (active) setState({ kind: 'ready', files, skills, connectors });
      } catch (error) {
        if (active) {
          setState({
            kind: 'failed',
            reason: `Resource names could not be loaded: ${error instanceof Error ? error.message : String(error)}`,
          });
        }
      }
    })();
    return () => {
      active = false;
    };
  }, []);
  return state;
}

export type ProjectsState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly projects: readonly ProjectResource[] }
  | { readonly kind: 'failed'; readonly reason: string };

/** `GET /api/projects` for the read-only "project-provided" group. See `./model.ts`'s
 *  `projectProvidedGroups` for which projects this becomes visible on. */
export function useAgentProjects(): ProjectsState {
  const [state, setState] = useState<ProjectsState>({ kind: 'loading' });
  useEffect(() => {
    let active = true;
    void fetch('/api/projects', { headers: { accept: 'application/json' } })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`GET /api/projects returned ${String(response.status)}.`);
        }
        const parsed = ProjectListResponseSchema.safeParse(await response.json());
        if (!parsed.success) throw new Error('The projects response did not match its schema.');
        return parsed.data.projects;
      })
      .then((projects) => {
        if (active) setState({ kind: 'ready', projects });
      })
      .catch((error: unknown) => {
        if (active) {
          setState({
            kind: 'failed',
            reason: `Project associations could not be loaded: ${error instanceof Error ? error.message : String(error)}`,
          });
        }
      });
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
}: Readonly<{
  files: AgentResourceAssignments['files'];
  catalog: FileCatalog | null;
  writeFilesAllowed: boolean;
  onChange: (next: AgentResourceAssignments['files']) => void;
}>) {
  const [browsing, setBrowsing] = useState(false);
  const [pending, setPending] = useState<readonly FilePickerSelection[]>([]);
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
    <fieldset className={CARD} aria-labelledby="agent-files-heading">
      <legend id="agent-files-heading" className="px-1 text-[13px] font-semibold">
        Files and folders
      </legend>
      {rows.length === 0 ? (
        <p className="py-1 text-[12.5px] text-muted">No files or folders assigned.</p>
      ) : (
        <ul>
          {rows.map((row) => (
            <li className={ROW} key={row.fileId}>
              <span className="min-w-0 flex-1 truncate">
                {row.path ?? `Unresolved file (${row.fileId})`}
              </span>
              {row.missing ? <span className={BADGE_MISSING}>Missing</span> : null}
              <select
                aria-label={`Access for ${row.path ?? row.fileId}`}
                className={CONTROL}
                value={row.access}
                onChange={(event) =>
                  setAccess(row.fileId, event.target.value as 'read' | 'read-write')
                }
              >
                <option value="read">Read</option>
                <option value="read-write">Read/write</option>
              </select>
              <button type="button" className={BTN_SM} onClick={() => remove(row.fileId)}>
                Remove
              </button>
              {row.access === 'read-write' && !writeFilesAllowed ? (
                <p role="alert" className="w-full text-[12px] text-warn">
                  This agent&rsquo;s Write files permission is off, so this read/write grant will be
                  saved and enforced as read-only until Write files is turned on.
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      <div className="mt-3">
        <button
          type="button"
          className={BTN_SM}
          onClick={() => {
            setBrowsing((current) => !current);
            setPending([]);
          }}
        >
          {browsing ? 'Close browser' : 'Add files or folders'}
        </button>
        {browsing ? (
          <div className="mt-3 rounded border border-border p-3">
            <FilePicker onChange={setPending} />
            <button
              type="button"
              className={`${BTN_SM} mt-2`}
              disabled={pending.length === 0}
              onClick={addPending}
            >
              Add {pending.length} selected
            </button>
          </div>
        ) : null}
      </div>
    </fieldset>
  );
}

/** Skills or connectors: an id list with no access mode, shared between both groups. */
export function NamedAssignments({
  heading,
  ids,
  catalog,
  onChange,
}: Readonly<{
  heading: string;
  ids: readonly string[];
  catalog: NamedCatalog | null;
  onChange: (next: readonly string[]) => void;
}>) {
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

  const headingId = `agent-${heading.toLowerCase()}-heading`;
  return (
    <fieldset className={CARD} aria-labelledby={headingId}>
      <legend id={headingId} className="px-1 text-[13px] font-semibold">
        {heading}
      </legend>
      {rows.length === 0 ? (
        <p className="py-1 text-[12.5px] text-muted">No {heading.toLowerCase()} assigned.</p>
      ) : (
        <ul>
          {rows.map((row) => (
            <li className={ROW} key={row.id}>
              <span className="min-w-0 flex-1 truncate">
                {row.name ?? `Unresolved (${row.id})`}
              </span>
              {row.missing ? (
                <span className={BADGE_MISSING}>Missing</span>
              ) : row.enabled === false ? (
                <span className={BADGE_DISABLED}>Disabled</span>
              ) : null}
              <button type="button" className={BTN_SM} onClick={() => remove(row.id)}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      {options.length === 0 ? null : (
        <div className="mt-3 flex items-center gap-2">
          <select
            aria-label={`Add a ${heading.toLowerCase().replace(/s$/u, '')}`}
            className={CONTROL}
            value={selectedToAdd}
            onChange={(event) => setSelectedToAdd(event.target.value)}
          >
            <option value="">Choose one…</option>
            {options.map(([id, entry]) => (
              <option key={id} value={id}>
                {entry.name}
              </option>
            ))}
          </select>
          <button type="button" className={BTN_SM} disabled={selectedToAdd === ''} onClick={add}>
            Add
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
}: Readonly<{
  agentId: string;
  projectsState: ProjectsState;
  files: FileCatalog | null;
  connectors: NamedCatalog | null;
}>) {
  if (projectsState.kind === 'loading') return null;
  if (projectsState.kind === 'failed') {
    return (
      <p className="text-[12px] text-muted" role="status">
        {projectsState.reason}
      </p>
    );
  }
  const groups = projectProvidedGroups(projectsState.projects, agentId, files, connectors);
  if (groups.length === 0) return null;
  return (
    <section className={CARD} aria-labelledby="project-resources-heading">
      <h3 id="project-resources-heading" className="mb-1 text-[13px] font-semibold">
        Project-provided (read-only)
      </h3>
      <p className="mb-3 text-[12px] text-muted">
        Added to every run of this agent that starts from one of these projects (this agent is their
        default agent). Edit these on the project, not here.
      </p>
      {groups.map((group) => (
        <div
          key={group.projectId}
          className="border-t border-border pt-2 first:border-t-0 first:pt-0"
        >
          <p className="text-[12.5px] font-semibold">{group.projectName}</p>
          {group.files.length === 0 && group.connectors.length === 0 ? (
            <p className="text-[12px] text-muted">No files or connectors.</p>
          ) : (
            <ul className="text-[12.5px] text-muted">
              {group.files.map((file) => (
                <li key={file.id}>
                  {file.path ?? `Unresolved file (${file.id})`}
                  {file.missing ? <span className={`${BADGE_MISSING} ml-2`}>Missing</span> : null}
                </li>
              ))}
              {group.connectors.map((connector) => (
                <li key={connector.id}>
                  {connector.name ?? `Unresolved connector (${connector.id})`}
                  {connector.missing ? (
                    <span className={`${BADGE_MISSING} ml-2`}>Missing</span>
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
}: Readonly<{
  agentId: string;
  assignments: AgentResourceAssignments;
  permissions: AgentPermissions;
  catalogsState: CatalogsState;
  projectsState: ProjectsState;
  onChange: (next: AgentResourceAssignments) => void;
}>) {
  const { files, skills, connectors } = catalogsOf(catalogsState);
  return (
    <section className="space-y-4" aria-labelledby="resources-heading">
      <h2 id="resources-heading" className="text-[15px] font-semibold">
        Assigned resources
      </h2>
      {catalogsState.kind === 'failed' ? (
        <p className="text-[13px] text-danger" role="alert">
          {catalogsState.reason}
        </p>
      ) : null}
      <FileAssignments
        files={assignments.files}
        catalog={files}
        writeFilesAllowed={permissions.writeFiles}
        onChange={(next) => onChange({ ...assignments, files: next })}
      />
      <NamedAssignments
        heading="Skills"
        ids={assignments.skillIds}
        catalog={skills}
        onChange={(next) => onChange({ ...assignments, skillIds: next })}
      />
      <NamedAssignments
        heading="Connectors"
        ids={assignments.connectorIds}
        catalog={connectors}
        onChange={(next) => onChange({ ...assignments, connectorIds: next })}
      />
      <ProjectProvidedResources
        agentId={agentId}
        projectsState={projectsState}
        files={files}
        connectors={connectors}
      />
    </section>
  );
}
