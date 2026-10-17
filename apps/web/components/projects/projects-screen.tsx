'use client';

/**
 * `/projects` — the project list, and (issue #123) the project create form.
 *
 * The list itself predates this task; what is new is the "New project" disclosure below it. It is
 * a toggle rather than a second route, exactly as the task card requires ("No new route segment
 * and no new page file … the task writes no `ui/*.html` mockup and no
 * `tests/screen-declarations/` entry"): `FilesScreen`'s always-open create forms
 * (`../resources/resource-screens.tsx`) are the nearest precedent for building a resource on the
 * list screen itself, and a project's own form is wide enough (name, instructions, visibility,
 * default agent, files, connectors) that showing it collapsed until asked for keeps the list calm
 * (§43) the way the always-open one-line file/folder forms do not need to.
 *
 * ## Issue #184: the archived filter lives in the URL, the lifecycle control does not live here
 *
 * `GET /api/projects` defaults to active projects (`server/projects/http.ts`), which is why an
 * archived project is already absent from every new-work picker without this screen doing anything.
 * What #184 adds here is the way *back*: an explicit three-way filter, kept in `?archived=` so a
 * history view is linkable, exactly as `../run/history-screen.tsx` keeps its own filters.
 *
 * Archive and restore themselves are on `/projects/:id` (`./project-archive.tsx`), not on a row: a
 * confirmation must name what it retires, and a row cannot show the person what is inside the
 * project they are about to close.
 */
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';

import { ProjectListResponseSchema, type ProjectResource } from '../../contracts/projects';
import { fetchJson } from '../../lib/fetch-json';
import {
  PROJECT_FILTERS,
  buildCreateProjectInput,
  describeEmptyProjectList,
  describeRequestFailure,
  isProjectArchived,
  isValidProjectName,
  parseProjectFilter,
  projectsListQuery,
  readAgentOptions,
  type CatalogOption,
  type ProjectDraft,
  type ProjectFilter,
  type RequestProblem,
} from './model';
import {
  BTN,
  BTN_DEFAULT,
  BTN_DISABLED,
  BTN_PRIMARY,
  ProjectFields,
  ProjectProblem,
  confirmDiscard,
  useProjectCatalogs,
} from './project-form';

const EMPTY_DRAFT: ProjectDraft = {
  name: '',
  instructions: '',
  visibility: 'private',
  defaultAgentId: null,
  defaultModel: null,
  fileIds: [],
  mcpServerIds: [],
};

const VISIBILITY_LABEL: Readonly<Record<ProjectResource['visibility'], string>> = {
  private: 'Private',
  workspace: 'Workspace',
  public: 'Public',
};

function ProjectRow({
  project,
  agents,
}: Readonly<{ project: ProjectResource; agents: readonly CatalogOption[] }>) {
  const defaultAgent =
    project.defaultAgentId === null
      ? null
      : (agents.find((agent) => agent.id === project.defaultAgentId) ?? null);
  return (
    <Link
      href={`/projects/${project.id}`}
      className="rounded-(--radius) border border-border bg-surface p-4 no-underline shadow-(--shadow)"
    >
      <div className="flex items-center gap-2">
        <span className="font-semibold text-text">{project.name}</span>
        <span className="inline-flex items-center rounded-[999px] bg-surface-3 px-2 py-0.5 text-[11px] text-text-2">
          {VISIBILITY_LABEL[project.visibility]}
        </span>
        {isProjectArchived(project) ? (
          <span className="inline-flex items-center rounded-[999px] border border-border-strong px-2 py-0.5 text-[11px] text-muted">
            Archived
          </span>
        ) : null}
      </div>
      <div className="mt-1 text-[12px] text-muted">
        {project.defaultAgentId === null
          ? 'No default agent'
          : `Default agent: ${defaultAgent?.label ?? 'deleted agent'}`}{' '}
        · {project.fileIds.length} files · {project.mcpServerIds.length} connectors ·{' '}
        {project.instructions ? 'Project instructions' : 'No extra instructions'}
      </div>
    </Link>
  );
}

const FILTER_LABEL: Readonly<Record<ProjectFilter, string>> = {
  active: 'Active',
  archived: 'Archived',
  all: 'All',
};

export function ProjectsScreen() {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const filter = parseProjectFilter(searchParams.get('archived'));

  const [projects, setProjects] = useState<readonly ProjectResource[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [agents, setAgents] = useState<readonly CatalogOption[]>([]);
  const [creating, setCreating] = useState(false);

  const load = () => {
    setProjects(null);
    setProblem(null);
    void fetchJson(projectsListQuery(filter), ProjectListResponseSchema, {
      headers: { accept: 'application/json' },
    })
      .then((body) => setProjects(body.projects))
      .catch((e: unknown) => setProblem(e instanceof Error ? e.message : String(e)));
  };
  // Refetches when the filter changes, because the filter is the URL and the URL is what is read.
  useEffect(load, [filter]);
  useEffect(() => {
    void fetch('/api/agents', { headers: { accept: 'application/json' } })
      .then((r) => (r.ok ? (r.json() as Promise<unknown>) : Promise.resolve({ agents: [] })))
      .then((body) => setAgents(readAgentOptions(body)))
      .catch(() => setAgents([]));
  }, []);

  return (
    <main className="w-full max-w-[1120px] px-8 pt-[26px] pb-[90px]">
      <div className="mb-5 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-[21px]">Projects</h1>
          <p className="text-[13px] text-muted">
            Reusable instructions, files, connectors and a default agent.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <label className="text-[12px] text-muted" htmlFor="projects-archived-filter">
            Show
          </label>
          <select
            id="projects-archived-filter"
            value={filter}
            onChange={(event) => {
              const next = new URLSearchParams(searchParams.toString());
              next.set('archived', parseProjectFilter(event.target.value));
              router.replace(`${pathname}?${next.toString()}`);
            }}
            className="h-8 rounded-(--radius-sm) border border-border-strong bg-surface px-2 text-[13px] text-text"
          >
            {PROJECT_FILTERS.map((option) => (
              <option key={option} value={option}>
                {FILTER_LABEL[option]}
              </option>
            ))}
          </select>
          {creating ? null : (
            <button
              type="button"
              className={`${BTN} ${BTN_PRIMARY}`}
              onClick={() => setCreating(true)}
            >
              New project
            </button>
          )}
        </div>
      </div>

      {creating ? (
        <ProjectCreateForm
          onCancel={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            load();
          }}
        />
      ) : null}

      {problem ? (
        <p role="alert" className="text-danger">
          {problem}
        </p>
      ) : projects === null ? (
        <p>Loading…</p>
      ) : (
        <div className="mt-5 grid gap-3">
          {projects.map((project) => (
            <ProjectRow key={project.id} project={project} agents={agents} />
          ))}
          {projects.length === 0 && !creating ? (
            <div className="rounded border border-border p-5 text-muted">
              {describeEmptyProjectList(filter)}
            </div>
          ) : null}
        </div>
      )}
    </main>
  );
}

function ProjectCreateForm({
  onCancel,
  onCreated,
}: Readonly<{ onCancel: () => void; onCreated: () => void }>) {
  const catalogsState = useProjectCatalogs();
  const [draft, setDraft] = useState<ProjectDraft>(EMPTY_DRAFT);
  const [submitting, setSubmitting] = useState(false);
  const [problem, setProblem] = useState<RequestProblem | null>(null);

  const canSubmit = isValidProjectName(draft.name) && !submitting;

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setProblem(null);
    void (async () => {
      let response: Response;
      try {
        response = await fetch('/api/projects', {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify(buildCreateProjectInput(draft)),
        });
      } catch (error) {
        setSubmitting(false);
        setProblem({
          kind: 'transport',
          reason: `The request to create this project failed: ${error instanceof Error ? error.message : String(error)}`,
        });
        return;
      }
      if (!response.ok) {
        setProblem(await describeRequestFailure(response, () => response.json()));
        setSubmitting(false);
        return;
      }
      setSubmitting(false);
      onCreated();
    })();
  }

  return (
    <form className="mb-5" onSubmit={onSubmit} aria-label="New project">
      {catalogsState.kind === 'failed' ? (
        <p className="mb-4 text-[13px] text-danger" role="alert">
          {catalogsState.reason}
        </p>
      ) : null}
      <ProjectFields
        draft={draft}
        catalogs={
          catalogsState.kind === 'ready'
            ? catalogsState.catalogs
            : { agents: [], files: [], connectors: [] }
        }
        onChange={(patch) => setDraft((current) => ({ ...current, ...patch }))}
        idPrefix="project-new"
      />
      <ProjectProblem problem={problem} />
      <div className="mt-4 flex items-center justify-end gap-2">
        <button
          type="button"
          className={`${BTN} ${BTN_DEFAULT}`}
          onClick={() => {
            const dirty = draft.name !== '' || draft.instructions !== '';
            if (confirmDiscard(dirty)) onCancel();
          }}
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={!canSubmit}
          className={`${BTN} ${BTN_PRIMARY} ${canSubmit ? '' : BTN_DISABLED}`}
        >
          {submitting ? 'Creating…' : 'Create project'}
        </button>
      </div>
    </form>
  );
}
