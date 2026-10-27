/**
 * Pure logic behind `/workspaces` — issue #120's directory, create and settings surfaces, all on
 * one route. Kept out of `workspaces-screen.tsx` for the same reason
 * `apps/web/components/projects/model.ts` is kept out of `projects-screen.tsx`: this repository's
 * component tests render with `react-dom/server`'s `renderToStaticMarkup`, which never fires a DOM
 * event, so anything a test needs to drive through a click or a keystroke has to be a function a
 * test can call directly.
 *
 * The read model (`WorkspaceMembership`, `canAdministerWorkspace`, …) lives in
 * `apps/web/components/shell/workspaces-directory.ts`, and the requests (list, create, update,
 * through the SDK) in `apps/web/components/shell/workspaces-requests-model.ts`, instead of here,
 * because the sidebar switcher needs the identical read model and requests and a second copy would
 * be exactly the drift `jscpd`'s duplication gate exists to catch.
 */
import type {
  CreateWorkspaceInput,
  UpdateWorkspacePatch,
} from '@indx-workspace/contracts/workspaces';

/**
 * A lower-case, hyphenated suggestion for the slug field, derived from the name field — never sent
 * to the server as anything but a suggestion the caller can still edit. `WorkspaceRepository.create`
 * normalises and validates the slug it actually receives
 * (`docs/adr/W9-WS-119-workspace-resource-authorisation-and-lifecycle.md` decision 4); this is a
 * client-side convenience only, not a second implementation of that rule.
 */
export function suggestSlug(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 64);
}

/** `POST /api/workspaces`'s Minimum implementation needs both fields non-blank before it is worth
 * a round trip; the server is still the one authority on what a valid slug actually is. */
export function isCreateFormValid(name: string, slug: string): boolean {
  return name.trim() !== '' && slug.trim() !== '';
}

export function buildCreatePayload(name: string, slug: string): CreateWorkspaceInput {
  return { name: name.trim(), slug: slug.trim() };
}

export function buildRenamePayload(name: string): UpdateWorkspacePatch {
  return { name: name.trim() };
}

export function buildArchivePayload(archived: boolean): UpdateWorkspacePatch {
  return { archived };
}

/** Whether a rename's Save button should be enabled: a non-blank name that actually differs from
 * the workspace's current one — resubmitting the unchanged name is not a mistake the button needs
 * to prevent, but it is not a "save" either. */
export function isRenameReady(name: string, currentName: string): boolean {
  const trimmed = name.trim();
  return trimmed !== '' && trimmed !== currentName;
}

/**
 * The archive confirmation gate: the caller must type the workspace's exact, current name before
 * the "Archive workspace" button enables — issue #120's "Archive requires typed confirmation".
 * Exact, case-sensitive match, the same rule
 * `apps/web/components/models/model.ts`'s `confirmationMatches` uses for removing a model
 * connection: a fuzzy match would let a mis-typed name through, which is the one thing this
 * control exists to prevent.
 */
export function archiveConfirmationMatches(input: string, workspaceName: string): boolean {
  return input === workspaceName;
}
