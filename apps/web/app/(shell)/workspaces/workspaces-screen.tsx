'use client';

/**
 * `/workspaces` — issue #120's one route for the directory, the create form and the settings
 * form. Fetches from the browser, the same reason `apps/web/components/agents/agents-list.tsx`'s
 * header gives for `/agents`: this deployment resolves the session's workspace from a real
 * `Request`, which a Server Component does not have, so a client `fetch` reaches the same
 * `middleware.ts` → RBAC chain an operator's own tooling would.
 *
 * Three presentational pieces are exported separately from the fetch-driving screen — the same
 * split `apps/web/components/projects/project-form.tsx` uses — because this repository's component
 * tests render with `react-dom/server`'s `renderToStaticMarkup`: a piece with no `useEffect` of its
 * own renders its whole prop-driven shape in one static pass, and only the top-level screen's
 * pre-fetch render is testable that way.
 *
 * ## What is, and is not, gated on role here
 *
 * `WorkspaceSettingsPanel` hides its Save/Archive/Restore controls unless
 * `canAdministerWorkspace(workspace)` — issue #119's `role` field, read back off the exact row the
 * server sent, never guessed (unlike `docs/adr/W9-PROJ-123-no-client-side-role-gate-on-create-and-edit.md`'s
 * declared gap, which had no such field to read). `CreateWorkspaceForm` gates on nothing: `POST
 * /api/workspaces` has no role check at all — `apps/web/server/workspaces/route.ts`'s own header,
 * "#119 puts no role gate on who may create a workspace" — and hiding the button for a non-Owner
 * would tell that caller their own request would fail when it would not.
 */
import { useCallback, useEffect, useState, type FormEvent } from 'react';

import {
  canAdministerWorkspace,
  describeTransportRejection,
  describeWorkspacesFailure,
  parseWorkspaceItem,
  parseWorkspaceList,
  parseWorkspaceMutation,
  type WorkspaceMembership,
  type WorkspaceResource,
  type WorkspacesProblem,
} from '../../../components/shell/workspaces-directory';
import { recoverWorkspaceSession } from '../../../components/shell/session-recovery';
import {
  concealTenantDocument,
  notifyWorkspaceDirectoryChanged,
} from '../../../components/shell/workspace-navigation';
import {
  archiveConfirmationMatches,
  buildArchivePayload,
  buildCreatePayload,
  buildRenamePayload,
  isCreateFormValid,
  isRenameReady,
  suggestSlug,
} from './model';

type ListState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'loaded'; readonly items: readonly WorkspaceMembership[] }
  | { readonly kind: 'problem'; readonly problem: WorkspacesProblem };

const CARD = 'rounded-(--radius) border border-border bg-surface p-4 shadow-(--shadow)';
const BTN =
  'inline-flex h-8 items-center justify-center gap-[7px] whitespace-nowrap rounded-(--radius-sm) border px-[13px] text-[13px] font-medium disabled:cursor-not-allowed disabled:opacity-50';
const BTN_DEFAULT = 'border-border-strong bg-surface text-text hover:bg-surface-3';
const BTN_PRIMARY = 'border-accent bg-accent text-white dark:text-[#10131c]';
const BTN_DANGER = 'border-danger bg-danger text-white';
const INPUT =
  'w-full rounded-(--radius-sm) border border-border-strong bg-surface px-2.5 py-[7px] text-[13.5px] text-text focus:border-accent focus:outline-2 focus:-outline-offset-1 focus:outline-accent';
const BADGE = 'inline-flex items-center rounded-[999px] px-2 py-0.5 text-[11px] font-medium';

async function readJsonBody(
  response: Response,
): Promise<{ ok: true; value: unknown } | { ok: false }> {
  try {
    return { ok: true, value: await response.json() };
  } catch {
    return { ok: false };
  }
}

/** The failed-request callout every panel on this screen shows the same way, worded from the
 * server's own `detail` — issue #120's "every 403/409 is rendered as the server worded it". */
export function WorkspacesProblemView({
  problem,
}: Readonly<{ problem: WorkspacesProblem | null }>) {
  if (problem === null) return null;
  return (
    <div
      role="alert"
      className="mt-2 rounded-(--radius-sm) border border-danger bg-danger-soft p-3 text-[12.5px] text-danger"
    >
      {problem.kind === 'api' ? (
        <>
          <b className="font-semibold">
            {problem.status} {problem.code}
          </b>
          <div>{problem.detail}</div>
        </>
      ) : (
        <div>{problem.reason}</div>
      )}
    </div>
  );
}

export function WorkspaceDirectoryTable({
  items,
  selectedId,
  onSelect,
}: Readonly<{
  items: readonly WorkspaceMembership[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}>) {
  if (items.length === 0) {
    return <p className="text-[13px] text-muted">You do not currently belong to any workspace.</p>;
  }
  return (
    <div className={`${CARD} max-w-full overflow-x-auto p-0`}>
      <table className="w-full min-w-[560px] text-[13px]">
        <thead>
          <tr className="border-b border-border text-left text-[11px] font-medium tracking-wide text-muted uppercase">
            <th className="px-4 py-2.5">Workspace</th>
            <th className="px-4 py-2.5">Your role</th>
            <th className="px-4 py-2.5">Status</th>
            <th className="px-4 py-2.5" />
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr key={item.id} className="border-b border-border last:border-0">
              <td className="px-4 py-2.5 text-text">
                <span className="block font-medium">{item.name}</span>
                <span className="block text-[11.5px] text-muted">{item.slug}</span>
              </td>
              <td className="px-4 py-2.5 text-text-2 capitalize">{item.role}</td>
              <td className="px-4 py-2.5">
                <span
                  className={`${BADGE} ${item.archivedAt !== null ? 'bg-warn-soft text-warn' : 'bg-ok-soft text-ok'}`}
                >
                  {item.archivedAt !== null ? 'Archived' : 'Active'}
                </span>
              </td>
              <td className="px-4 py-2.5 text-right">
                <button
                  type="button"
                  className={`${BTN} ${item.id === selectedId ? BTN_PRIMARY : BTN_DEFAULT}`}
                  aria-current={item.id === selectedId ? 'true' : undefined}
                  onClick={() => onSelect(item.id)}
                >
                  Manage
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function CreateWorkspaceForm({
  onCreated,
  onSessionProblem,
}: Readonly<{
  onCreated: (created: WorkspaceMembership) => void;
  onSessionProblem: (problem: WorkspacesProblem) => boolean;
}>) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [problem, setProblem] = useState<WorkspacesProblem | null>(null);

  function changeName(value: string) {
    setName(value);
    if (!slugTouched) setSlug(suggestSlug(value));
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setProblem(null);
    let response: Response;
    try {
      response = await fetch('/api/workspaces', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(buildCreatePayload(name, slug)),
      });
    } catch (error) {
      setSubmitting(false);
      setProblem(describeTransportRejection(error));
      return;
    }
    if (!response.ok) {
      setSubmitting(false);
      const nextProblem = await describeWorkspacesFailure(response, () => response.json());
      if (!onSessionProblem(nextProblem)) setProblem(nextProblem);
      return;
    }
    const body = await readJsonBody(response);
    setSubmitting(false);
    const created = body.ok ? parseWorkspaceItem(body.value) : null;
    if (created === null) {
      setProblem({
        kind: 'transport',
        reason: 'The server answered without the usual workspace body.',
      });
      return;
    }
    onCreated(created);
    setOpen(false);
    setName('');
    setSlug('');
    setSlugTouched(false);
  }

  if (!open) {
    return (
      <button type="button" className={`${BTN} ${BTN_PRIMARY}`} onClick={() => setOpen(true)}>
        Create workspace
      </button>
    );
  }

  return (
    <form
      onSubmit={(event) => void submit(event)}
      className={`${CARD} space-y-3`}
      aria-label="Create a workspace"
    >
      <h2 className="text-[14px] font-semibold">Create a workspace</h2>
      <label className="block text-[13px] font-medium">
        Name
        <input
          className={`${INPUT} mt-1`}
          value={name}
          onChange={(event) => changeName(event.target.value)}
        />
      </label>
      <label className="block text-[13px] font-medium">
        Slug
        <input
          className={`${INPUT} mt-1`}
          value={slug}
          onChange={(event) => {
            setSlug(event.target.value);
            setSlugTouched(true);
          }}
        />
        <span className="mt-1 block text-[11.5px] text-muted">
          Lower-case letters, digits and hyphens.
        </span>
      </label>
      <WorkspacesProblemView problem={problem} />
      <div className="flex gap-2">
        <button
          type="submit"
          className={`${BTN} ${BTN_PRIMARY}`}
          disabled={submitting || !isCreateFormValid(name, slug)}
        >
          {submitting ? 'Creating…' : 'Create workspace'}
        </button>
        <button type="button" className={`${BTN} ${BTN_DEFAULT}`} onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </form>
  );
}

export function WorkspaceSettingsPanel({
  workspace,
  onUpdated,
  onSessionProblem,
}: Readonly<{
  workspace: WorkspaceMembership;
  onUpdated: (updated: WorkspaceMembership) => void;
  onSessionProblem: (problem: WorkspacesProblem) => boolean;
}>) {
  const canAdminister = canAdministerWorkspace(workspace);
  const [name, setName] = useState(workspace.name);
  const [nameProblem, setNameProblem] = useState<WorkspacesProblem | null>(null);
  const [savingName, setSavingName] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  const [archiving, setArchiving] = useState(false);
  const [archiveProblem, setArchiveProblem] = useState<WorkspacesProblem | null>(null);

  // Selecting a different workspace must not keep the previous one's half-typed rename or
  // archive-confirmation text on screen — issue #120's "Zero, one and many memberships each
  // render" reaches the settings panel too: switching which one is selected is its own transition.
  useEffect(() => {
    setName(workspace.name);
    setNameProblem(null);
    setArchiveOpen(false);
    setConfirmText('');
    setArchiveProblem(null);
  }, [workspace.id, workspace.name]);

  async function patch(
    body: unknown,
    onFail: (problem: WorkspacesProblem) => void,
  ): Promise<WorkspaceResource | null> {
    let response: Response;
    try {
      response = await fetch(`/api/workspaces/${workspace.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (error) {
      onFail(describeTransportRejection(error));
      return null;
    }
    if (!response.ok) {
      const problem = await describeWorkspacesFailure(response, () => response.json());
      if (!onSessionProblem(problem)) onFail(problem);
      return null;
    }
    const parsedBody = await readJsonBody(response);
    const updated = parsedBody.ok ? parseWorkspaceMutation(parsedBody.value) : null;
    if (updated === null) {
      onFail({
        kind: 'transport',
        reason: 'The server answered without the usual workspace body.',
      });
      return null;
    }
    return updated;
  }

  async function saveName(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSavingName(true);
    setNameProblem(null);
    const updated = await patch(buildRenamePayload(name), setNameProblem);
    setSavingName(false);
    // `PATCH`'s own response carries no `role` — `apps/web/server/workspaces/handlers.ts`'s
    // `updateWorkspace` answers `serialiseWorkspace`, not the list/item shape's
    // `serialiseMembershipView` — and renaming a workspace does not change the caller's role in
    // it, so the already-known role is carried forward rather than dropped.
    if (updated !== null) onUpdated({ ...updated, role: workspace.role });
  }

  async function setArchived(archived: boolean) {
    setArchiving(true);
    setArchiveProblem(null);
    const updated = await patch(buildArchivePayload(archived), setArchiveProblem);
    setArchiving(false);
    if (updated !== null) {
      onUpdated({ ...updated, role: workspace.role });
      setArchiveOpen(false);
      setConfirmText('');
    }
  }

  return (
    <div className="space-y-4">
      <div className={CARD}>
        <h2 className="mb-3 text-[14px] font-semibold">Workspace name</h2>
        {canAdminister ? (
          <form
            onSubmit={(event) => void saveName(event)}
            className="flex flex-col items-stretch gap-2 sm:flex-row sm:items-end"
          >
            <label className="min-w-0 flex-1 text-[13px] font-medium">
              Name
              <input
                className={`${INPUT} mt-1`}
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            <button
              type="submit"
              className={`${BTN} ${BTN_PRIMARY}`}
              disabled={savingName || !isRenameReady(name, workspace.name)}
            >
              {savingName ? 'Saving…' : 'Save'}
            </button>
          </form>
        ) : (
          <>
            <p className="text-[13.5px] text-text">{workspace.name}</p>
            <p className="mt-2 text-[12px] text-muted">
              Only this workspace's Owner can rename it.
            </p>
          </>
        )}
        <WorkspacesProblemView problem={nameProblem} />
      </div>

      <div className={CARD}>
        <h2 className="mb-1 text-[14px] font-semibold">Lifecycle</h2>
        {workspace.archivedAt !== null ? (
          <>
            <p className="text-[13px] text-warn">
              Archived on {new Date(workspace.archivedAt).toLocaleDateString()}. It stays visible
              and readable, but new activity in it is blocked.
            </p>
            {canAdminister ? (
              <button
                type="button"
                className={`${BTN} ${BTN_DEFAULT} mt-2`}
                disabled={archiving}
                onClick={() => void setArchived(false)}
              >
                {archiving ? 'Restoring…' : 'Restore workspace'}
              </button>
            ) : (
              <p className="mt-2 text-[12px] text-muted">
                Only this workspace's Owner can restore it.
              </p>
            )}
          </>
        ) : (
          <>
            <p className="text-[13px] text-text-2">
              Archiving stops new activity in this workspace. It stays visible, and can be restored
              from this screen at any time.
            </p>
            {canAdminister ? (
              archiveOpen ? (
                <div className="mt-3 space-y-2 rounded-(--radius-sm) border border-danger bg-danger-soft p-3">
                  <label className="block text-[12.5px] font-medium text-danger">
                    Type &quot;{workspace.name}&quot; to confirm
                    <input
                      className={`${INPUT} mt-1`}
                      value={confirmText}
                      onChange={(event) => setConfirmText(event.target.value)}
                    />
                  </label>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      className={`${BTN} ${BTN_DANGER}`}
                      disabled={
                        archiving || !archiveConfirmationMatches(confirmText, workspace.name)
                      }
                      onClick={() => void setArchived(true)}
                    >
                      {archiving ? 'Archiving…' : 'Archive workspace'}
                    </button>
                    <button
                      type="button"
                      className={`${BTN} ${BTN_DEFAULT}`}
                      onClick={() => {
                        setArchiveOpen(false);
                        setConfirmText('');
                      }}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  className={`${BTN} ${BTN_DEFAULT} mt-2`}
                  onClick={() => setArchiveOpen(true)}
                >
                  Archive workspace…
                </button>
              )
            ) : (
              <p className="mt-2 text-[12px] text-muted">
                Only this workspace's Owner can archive it.
              </p>
            )}
          </>
        )}
        <WorkspacesProblemView problem={archiveProblem} />
      </div>
    </div>
  );
}

export function WorkspacesScreen() {
  const [state, setState] = useState<ListState>({ kind: 'loading' });
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const recoverSession = useCallback((problem: WorkspacesProblem): boolean => {
    return recoverWorkspaceSession(problem, {
      clearTenantState: () => {
        setSelectedId(null);
        setState({ kind: 'loading' });
      },
      concealTenantDocument: () => concealTenantDocument(document),
      navigate: (path) => window.location.assign(path),
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/workspaces', { headers: { accept: 'application/json' } })
      .then(async (response) => {
        if (cancelled) return;
        if (!response.ok) {
          const problem = await describeWorkspacesFailure(response, () => response.json());
          if (!recoverSession(problem)) setState({ kind: 'problem', problem });
          return;
        }
        const body = await readJsonBody(response);
        const parsed = body.ok ? parseWorkspaceList(body.value) : null;
        if (parsed === null) {
          setState({
            kind: 'problem',
            problem: {
              kind: 'transport',
              reason: 'The server answered without the usual workspaces list.',
            },
          });
          return;
        }
        setState({ kind: 'loaded', items: parsed });
        setSelectedId((current) => current ?? parsed[0]?.id ?? null);
      })
      .catch((error: unknown) => {
        if (!cancelled) setState({ kind: 'problem', problem: describeTransportRejection(error) });
      });
    return () => {
      cancelled = true;
    };
  }, [recoverSession]);

  function replace(updated: WorkspaceMembership) {
    setState((current) =>
      current.kind === 'loaded'
        ? {
            kind: 'loaded',
            items: current.items.map((item) => (item.id === updated.id ? updated : item)),
          }
        : current,
    );
    notifyWorkspaceDirectoryChanged(window);
  }

  function created(item: WorkspaceMembership) {
    setState((current) => ({
      kind: 'loaded',
      items: current.kind === 'loaded' ? [...current.items, item] : [item],
    }));
    setSelectedId(item.id);
    notifyWorkspaceDirectoryChanged(window);
  }

  const selected =
    state.kind === 'loaded' ? (state.items.find((item) => item.id === selectedId) ?? null) : null;

  return (
    <main className="space-y-6 p-4 sm:p-8">
      <div>
        <p className="text-[13px] text-muted">Directory</p>
        <h1 className="text-2xl font-semibold">Workspaces</h1>
        <p className="mt-2 text-[13px] text-text-2">
          Every workspace you currently belong to, the role you hold in it, and whether it is
          archived.
        </p>
      </div>

      {state.kind === 'loading' ? (
        <p className="text-[13px] text-muted">Loading workspaces…</p>
      ) : null}
      {state.kind === 'problem' ? <WorkspacesProblemView problem={state.problem} /> : null}

      {state.kind === 'loaded' ? (
        <>
          <WorkspaceDirectoryTable
            items={state.items}
            selectedId={selectedId}
            onSelect={setSelectedId}
          />
          <CreateWorkspaceForm onCreated={created} onSessionProblem={recoverSession} />
          {selected !== null ? (
            <WorkspaceSettingsPanel
              workspace={selected}
              onUpdated={replace}
              onSessionProblem={recoverSession}
            />
          ) : null}
        </>
      ) : null}
    </main>
  );
}
