import type { UserMembershipSummary } from '../rbac/directory';

function escapeHtml(value: string): string {
  return value
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;');
}

/** `?error=…&next=…` for a redirect back to the picker; `next` is already a safe path or `null`. */
export function pickerQuery(error: string | null, destination: string | null): string {
  const query = new URLSearchParams({
    ...(error === null ? {} : { error }),
    ...(destination === null ? {} : { next: destination }),
  }).toString();
  return query === '' ? '' : `?${query}`;
}

export function selectionPageHtml(
  email: string,
  memberships: readonly UserMembershipSummary[],
  error: string | null,
  destination: string | null,
): string {
  const nextField =
    destination === null
      ? ''
      : `\n      <input type="hidden" name="next" value="${escapeHtml(destination)}" />`;
  const message =
    error === 'workspace_not_available'
      ? '<p role="alert">That is not one of your current workspaces. Choose one from the list below.</p>'
      : '';
  const rows = memberships
    .map(
      (membership) => `<form action="/api/auth/workspace" method="post">
      <input type="hidden" name="workspace" value="${escapeHtml(membership.workspaceSlug)}" />${nextField}
      <button type="submit">${escapeHtml(membership.workspaceName)} — ${escapeHtml(membership.role)}</button>
    </form>`,
    )
    .join('\n');
  return `<!doctype html>
<html>
  <head><meta charset="utf-8" /><title>Choose a workspace</title></head>
  <body>
    <h1>Choose a workspace</h1>
    <p>Signed in as ${escapeHtml(email)}.</p>
    ${message}
    ${rows}
  </body>
</html>`;
}
