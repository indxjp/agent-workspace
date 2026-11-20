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

import type { ProjectResource } from '../../contracts/projects';
import { browserClient } from '../../lib/browser-client';
import {
  PROJECT_FILTERS,
  describeEmptyProjectList,
  isProjectArchived,
  isValidProjectName,
  parseProjectFilter,
  type CatalogOption,
  type ProjectDraft,
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
import { createProject, loadAgentOptions, loadProjects } from './project-requests-model';
import { ProblemLine } from '../agents/problem-line';
import type { VersionsLocale } from '../agents/versions-messages';
import { projectsStrings, type ProjectsStrings } from './projects-messages';

const EMPTY_DRAFT: ProjectDraft = {
  name: '',
  instructions: '',
  visibility: 'private',
  defaultAgentId: null,
  defaultModel: null,
  fileIds: [],
  mcpServerIds: [],
};

function ProjectRow({
  project,
  agents,
  strings,
}: Readonly<{
  project: ProjectResource;
  agents: readonly CatalogOption[];
  strings: ProjectsStrings;
}>) {
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
          {strings.visibility[project.visibility]}
        </span>
        {isProjectArchived(project) ? (
          <span className="inline-flex items-center rounded-[999px] border border-border-strong px-2 py-0.5 text-[11px] text-muted">
            {strings.archived}
          </span>
        ) : null}
      </div>
      <div className="mt-1 text-[12px] text-muted">
        {project.defaultAgentId === null
          ? strings.noDefaultAgent
          : strings.defaultAgent(defaultAgent?.label ?? strings.deletedAgent)}{' '}
        · {strings.files(project.fileIds.length)} ·{' '}
        {strings.connectors(project.mcpServerIds.length)} ·{' '}
        {project.instructions ? strings.projectInstructions : strings.noExtraInstructions}
      </div>
    </Link>
  );
}

export function ProjectsScreen({
  locale = 'en',
}: Readonly<{
  /** The reader's language (UX-15 in #2086); English by default. */
  locale?: VersionsLocale;
}>) {
  const strings = projectsStrings(locale);
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
    void loadProjects(browserClient(), filter)
      .then(setProjects)
      .catch((e: unknown) => setProblem(e instanceof Error ? e.message : String(e)));
  };
  // Refetches when the filter changes, because the filter is the URL and the URL is what is read.
  useEffect(load, [filter]);
  useEffect(() => {
    void loadAgentOptions(browserClient()).then(setAgents);
  }, []);

  return (
    <main lang={locale} className="w-full max-w-[1120px] px-8 pt-[26px] pb-[90px]">
      <div className="mb-5 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-[21px]">{strings.title}</h1>
          <p className="text-[13px] text-muted">{strings.intro}</p>
        </div>
        <div className="flex items-center gap-2">
          <label className="text-[12px] text-muted" htmlFor="projects-archived-filter">
            {strings.show}
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
                {strings.filter[option]}
              </option>
            ))}
          </select>
          {creating ? null : (
            <button
              type="button"
              className={`${BTN} ${BTN_PRIMARY}`}
              onClick={() => setCreating(true)}
            >
              {strings.newProject}
            </button>
          )}
        </div>
      </div>

      {creating ? (
        <ProjectCreateForm
          locale={locale}
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
        <p>{strings.loading}</p>
      ) : (
        <div className="mt-5 grid gap-3">
          {projects.map((project) => (
            <ProjectRow key={project.id} project={project} agents={agents} strings={strings} />
          ))}
          {projects.length === 0 && !creating ? (
            <div className="rounded border border-border p-5 text-muted">
              {describeEmptyProjectList(filter, strings)}
            </div>
          ) : null}
        </div>
      )}
    </main>
  );
}

function ProjectCreateForm({
  locale,
  onCancel,
  onCreated,
}: Readonly<{ locale: VersionsLocale; onCancel: () => void; onCreated: () => void }>) {
  const strings = projectsStrings(locale);
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
    void createProject(browserClient(), draft).then((failure) => {
      setProblem(failure);
      setSubmitting(false);
      if (failure === null) onCreated();
    });
  }

  return (
    <form className="mb-5" onSubmit={onSubmit} aria-label={strings.newProject}>
      {catalogsState.kind === 'failed' ? (
        <p className="mb-4 text-[13px] text-danger" role="alert">
          <ProblemLine
            locale={locale}
            english={catalogsState.reason}
            lead={strings.form.optionsFailed}
            detail={catalogsState.detail}
          />
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
        locale={locale}
      />
      <ProjectProblem problem={problem} />
      <div className="mt-4 flex items-center justify-end gap-2">
        <button
          type="button"
          className={`${BTN} ${BTN_DEFAULT}`}
          onClick={() => {
            const dirty = draft.name !== '' || draft.instructions !== '';
            if (confirmDiscard(dirty, strings)) onCancel();
          }}
        >
          {strings.cancel}
        </button>
        <button
          type="submit"
          disabled={!canSubmit}
          className={`${BTN} ${BTN_PRIMARY} ${canSubmit ? '' : BTN_DISABLED}`}
        >
          {submitting ? strings.creating : strings.createProject}
        </button>
      </div>
    </form>
  );
}
