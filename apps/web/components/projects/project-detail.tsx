'use client';

/**
 * `/projects/:id` — issue #123: `ProjectDetail` becomes an editable settings surface over the
 * existing `PATCH /api/projects/:id` contract, in place of the read-only counts view it used to
 * render. `../agents/agent-detail.tsx` is the landed precedent for "one form, submits the whole
 * editable shape, shows the server's own wording on failure" that this follows.
 *
 * Associated files and connectors are shown by **name**, resolved against the same workspace
 * catalogues the edit fields use (`../project-form.tsx`'s `useProjectCatalogs`), with an explicit
 * "no longer exists" state for an id the catalogue does not carry — never a bare count, which is
 * what the task card asks for and what `../model.ts`'s `resolveResourceNames` computes.
 *
 * ## Issue #184: the lifecycle section, and why the settings form closes with it
 *
 * `ProjectLifecycleSection` (`./project-archive.tsx`) renders the archive/restore control for a
 * caller the server said may use it — `capability` is resolved by
 * `server/projects/archive-capability.ts` in the page above this one, never by anything here.
 *
 * While a project is archived this screen stops offering edits. That is a judgement, not a server
 * rule: `PATCH /api/projects/:id` still succeeds on an archived project — only *new work* is gated
 * (`server/projects/archive-gate.ts`) — so the form is closed because offering live settings on a
 * retired project misrepresents what it is, not because the request would fail. Restoring reopens
 * it. The task ADR records this as reversible if a reviewer disagrees.
 */
import Link from 'next/link';
import { useEffect, useState, type MouseEvent } from 'react';

import { ProjectResourceSchema, type ProjectArchiveCapability } from '../../contracts/projects';
import { ShareDialog } from '../shares/share-dialog';
import {
  ARCHIVE_IMPACT_RUN_LIMIT,
  archiveImpactFromReads,
  buildProjectPatch,
  describeArchivedOn,
  describeLifecycleFailure,
  describeRequestFailure,
  draftFromProject,
  isProjectArchived,
  isProjectDirty,
  isValidProjectName,
  projectModelSaveTookEffect,
  readRunPage,
  readSessionProjectIds,
  resolveResourceNames,
  type ArchiveDialogState,
  type ArchiveImpactCounts,
  type ProjectDraft,
  type ProjectResource,
  type RequestProblem,
} from './model';
import { ProjectLifecycleSection } from './project-archive';
import {
  BTN,
  BTN_DEFAULT,
  BTN_DISABLED,
  BTN_PRIMARY,
  ProjectFields,
  ProjectProblem,
  confirmDiscard,
  useBeforeUnloadGuard,
  useProjectCatalogs,
} from './project-form';

/** A caller whose capability could not be resolved may do nothing — the page's own fail-closed
 *  answer, repeated here so a test (and a future caller) can mount this screen without one. */
const NO_CAPABILITY: ProjectArchiveCapability = {
  canArchiveOwn: false,
  canArchiveOther: false,
  viewerPrincipalId: null,
};

/**
 * Count what archiving this project makes read-only, from the two list endpoints the caller already
 * has read access to. `null` when either read failed — `archiveImpactFromReads` says why a half
 * answer is not reported as a zero.
 *
 * Both counts are "what this caller can see": `GET /api/sessions` and `GET /api/runs` narrow to the
 * caller's own rows for every role below Owner/Admin, and neither publishes a total. That is why
 * the sentence `summariseArchiveImpact` builds says so out loud.
 */
async function countArchiveImpact(id: string): Promise<ArchiveImpactCounts | null> {
  const accept = { headers: { accept: 'application/json' } };
  const [sessions, runs] = await Promise.all([
    fetch('/api/sessions', accept)
      .then(async (response) =>
        response.ok
          ? readSessionProjectIds(await response.json()).filter((one) => one === id)
          : null,
      )
      .catch(() => null),
    fetch(
      `/api/runs?project=${encodeURIComponent(id)}&limit=${String(ARCHIVE_IMPACT_RUN_LIMIT)}`,
      accept,
    )
      .then(async (response) => (response.ok ? readRunPage(await response.json()) : null))
      .catch(() => null),
  ]);
  return archiveImpactFromReads(sessions, runs);
}

export function ProjectDetail({
  id,
  capability = NO_CAPABILITY,
}: Readonly<{ id: string; capability?: ProjectArchiveCapability }>) {
  const [project, setProject] = useState<ProjectResource | null>(null);
  const [saved, setSaved] = useState<ProjectDraft | null>(null);
  const [draft, setDraft] = useState<ProjectDraft | null>(null);
  const [loadProblem, setLoadProblem] = useState<RequestProblem | null>(null);
  const [saveProblem, setSaveProblem] = useState<RequestProblem | null>(null);
  const [saving, setSaving] = useState(false);
  const [dialog, setDialog] = useState<ArchiveDialogState | null>(null);
  const catalogsState = useProjectCatalogs();

  useEffect(() => {
    let active = true;
    void fetch(`/api/projects/${encodeURIComponent(id)}`, {
      headers: { accept: 'application/json' },
    })
      .then(async (response) => {
        if (!active) return;
        if (!response.ok) {
          setLoadProblem(await describeRequestFailure(response, () => response.json()));
          return;
        }
        const body = ProjectResourceSchema.parse(await response.json());
        setProject(body);
        setSaved(draftFromProject(body));
        setDraft(draftFromProject(body));
      })
      .catch((error: unknown) => {
        if (active) {
          setLoadProblem({
            kind: 'transport',
            reason: `The project could not be loaded: ${error instanceof Error ? error.message : String(error)}`,
          });
        }
      });
    return () => {
      active = false;
    };
  }, [id]);

  const dirty = saved !== null && draft !== null && isProjectDirty(saved, draft);
  useBeforeUnloadGuard(dirty);

  const backLink = (
    <Link
      className="ml-auto text-[13px] text-accent"
      href="/projects"
      onClick={(event: MouseEvent<HTMLAnchorElement>) => {
        if (!confirmDiscard(dirty)) event.preventDefault();
      }}
    >
      Back to projects
    </Link>
  );

  if (loadProblem !== null) {
    return (
      <main className="w-full max-w-[980px] px-8 pt-[26px]" role="alert">
        {loadProblem.kind === 'api' ? loadProblem.message : loadProblem.reason}
      </main>
    );
  }
  if (project === null || draft === null || saved === null) {
    return <main className="px-8 pt-[26px] text-muted">Loading project…</main>;
  }

  const catalogs =
    catalogsState.kind === 'ready'
      ? catalogsState.catalogs
      : { agents: [], files: [], connectors: [] };
  const resolvedFiles = resolveResourceNames(project.fileIds, catalogs.files);
  const resolvedConnectors = resolveResourceNames(project.mcpServerIds, catalogs.connectors);
  const archived = isProjectArchived(project);
  const canSave = isValidProjectName(draft.name) && dirty && !saving && !archived;

  function openDialog() {
    const opened = project;
    if (opened === null) return;
    if (isProjectArchived(opened)) {
      // Restore retires nothing, so it has no impact to count and opens ready to confirm.
      setDialog({ kind: 'confirming' });
      return;
    }
    setDialog({ kind: 'counting' });
    void countArchiveImpact(id).then((impact: ArchiveImpactCounts | null) => {
      // Only replace a state this same open produced; a cancel/confirm in between owns it now.
      setDialog((current) =>
        current?.kind === 'counting'
          ? impact === null
            ? { kind: 'count-unavailable' }
            : { kind: 'counted', impact }
          : current,
      );
    });
  }

  async function applyTransition() {
    const current = project;
    if (current === null) return;
    const segment = isProjectArchived(current) ? 'restore' : 'archive';
    setDialog({ kind: 'submitting' });
    let response: Response;
    try {
      response = await fetch(`/api/projects/${encodeURIComponent(id)}/${segment}`, {
        method: 'POST',
        headers: { accept: 'application/json' },
      });
    } catch (error) {
      setDialog({
        kind: 'failed',
        problem: {
          kind: 'transport',
          reason: `The request to ${segment} this project failed: ${error instanceof Error ? error.message : String(error)}`,
        },
      });
      return;
    }
    if (!response.ok) {
      const problem = await describeRequestFailure(response, () => response.json());
      setDialog({ kind: 'failed', problem: describeLifecycleFailure(problem) });
      return;
    }
    // The transition's own response carries the whole project; local state is replaced from what
    // the server actually stored rather than from what this screen asked for — the same discipline
    // `projectModelSaveTookEffect` applies to the PATCH above.
    const parsed = ProjectResourceSchema.safeParse(await response.json().catch(() => null));
    if (!parsed.success) {
      setDialog({
        kind: 'failed',
        problem: { kind: 'transport', reason: 'The server returned an invalid project.' },
      });
      return;
    }
    setProject(parsed.data);
    setSaved(draftFromProject(parsed.data));
    setDraft(draftFromProject(parsed.data));
    setSaveProblem(null);
    setDialog(null);
  }

  async function save() {
    if (draft === null || !canSave) return;
    setSaving(true);
    setSaveProblem(null);
    let response: Response;
    try {
      response = await fetch(`/api/projects/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(buildProjectPatch(draft)),
      });
    } catch (error) {
      setSaving(false);
      setSaveProblem({
        kind: 'transport',
        reason: `The request to save this project failed: ${error instanceof Error ? error.message : String(error)}`,
      });
      return;
    }
    if (!response.ok) {
      setSaveProblem(await describeRequestFailure(response, () => response.json()));
      setSaving(false);
      return;
    }
    let responseBody: unknown;
    try {
      responseBody = await response.json();
    } catch {
      setSaveProblem({ kind: 'transport', reason: 'The server returned invalid JSON.' });
      setSaving(false);
      return;
    }
    const parsed = ProjectResourceSchema.safeParse(responseBody);
    if (!parsed.success) {
      setSaveProblem({ kind: 'transport', reason: 'The server returned an invalid project.' });
      setSaving(false);
      return;
    }
    const updated = parsed.data;
    // A 2xx from a stale or incompatible deployment is not proof this field took effect.
    const modelSaved = projectModelSaveTookEffect(draft.defaultModel, updated);
    setProject(updated);
    setSaved(draftFromProject(updated));
    setDraft(draftFromProject(updated));
    setSaveProblem(
      modelSaved
        ? null
        : {
            kind: 'transport',
            reason:
              'Every other change saved, but the default model did not match the server response. ' +
              'It has been reverted to what is actually saved.',
          },
    );
    setSaving(false);
  }

  return (
    <main className="w-full max-w-[980px] px-8 pt-[26px] pb-[90px]">
      <div className="mb-5 flex items-center gap-3">
        <div>
          <h1 className="text-[21px]">{project.name}</h1>
          <p className="text-[13px] text-muted">Project settings</p>
        </div>
        <ShareDialog subject={{ type: 'project', id: project.id, label: project.name }} />
        {backLink}
      </div>

      {archived ? (
        <p
          role="status"
          className="mb-4 rounded-(--radius) border border-border bg-surface-2 p-3 text-[13px] text-text-2"
        >
          Archived on {describeArchivedOn(project) ?? 'an unknown date'}. Its settings are read-only
          and no new sessions or runs can start in it. Completed work stays in history.
        </p>
      ) : null}

      <form
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        {/* `disabled` on the fieldset is what makes an archived project read-only: it disables every
            descendant control at once, so a field added later is covered without an edit here. */}
        <fieldset disabled={archived} className="m-0 min-w-0 border-0 p-0">
          <ProjectFields
            draft={draft}
            catalogs={catalogs}
            onChange={(patch) =>
              setDraft((current) => (current === null ? current : { ...current, ...patch }))
            }
            idPrefix="project-detail"
          />
        </fieldset>

        <section
          className="mt-4 rounded-(--radius) border border-border bg-surface p-4"
          aria-labelledby="project-resources-heading"
        >
          <h2 id="project-resources-heading" className="mb-3 text-[15px] font-semibold">
            Assigned resources
          </h2>
          <ResourceList heading="Files and folders" resources={resolvedFiles} />
          <ResourceList heading="Connectors" resources={resolvedConnectors} />
        </section>

        <ProjectProblem problem={saveProblem} />

        <div className="mt-4 flex items-center justify-end gap-2">
          <button
            type="button"
            className={`${BTN} ${BTN_DEFAULT}`}
            disabled={!dirty}
            onClick={() => {
              if (confirmDiscard(dirty)) setDraft(saved);
            }}
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!canSave}
            className={`${BTN} ${BTN_PRIMARY} ${canSave ? '' : BTN_DISABLED}`}
          >
            {saving ? 'Saving…' : 'Save changes'}
          </button>
        </div>
      </form>

      <ProjectLifecycleSection
        project={project}
        capability={capability}
        dialog={dialog}
        onOpen={openDialog}
        onCancel={() => setDialog(null)}
        onConfirm={() => void applyTransition()}
      />
    </main>
  );
}

function ResourceList({
  heading,
  resources,
}: Readonly<{ heading: string; resources: readonly { id: string; label: string | null }[] }>) {
  return (
    <div className="mb-3 last:mb-0">
      <h3 className="mb-1 text-[12.5px] font-semibold text-text-2">{heading}</h3>
      {resources.length === 0 ? (
        <p className="text-[12.5px] text-muted">None assigned.</p>
      ) : (
        <ul className="text-[13px]">
          {resources.map((resource) => (
            <li key={resource.id} className="py-0.5">
              {resource.label === null ? (
                <span className="text-danger">Deleted resource ({resource.id})</span>
              ) : (
                resource.label
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
