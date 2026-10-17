/**
 * Browser-history safeguards for a full workspace navigation.
 *
 * A form POST leaves the React and Next.js caches behind, but a browser may retain the old
 * document in its back/forward cache. Concealing the document before submission means that cached
 * snapshot contains no tenant records. When the browser later restores that document, the
 * `pageshow` event's positive `persisted` signal causes a network reload under the current session
 * cookie before anything is made visible again.
 */

export interface ConcealableTenantDocument {
  readonly body: {
    readonly style: { visibility: string };
    setAttribute(name: string, value: string): void;
  };
}

export const WORKSPACE_DIRECTORY_CHANGED_EVENT = 'aw:workspace-directory-changed';

export interface WorkspaceDirectoryEventTarget {
  dispatchEvent(event: Event): boolean;
}

export function concealTenantDocument(document: ConcealableTenantDocument): void {
  document.body.setAttribute('aria-busy', 'true');
  document.body.style.visibility = 'hidden';
}

export function shouldReloadRestoredTenantPage(
  event: Pick<PageTransitionEvent, 'persisted'>,
): boolean {
  return event.persisted;
}

/** Tell other workspace UI in the same document to re-read the server-authoritative directory. */
export function notifyWorkspaceDirectoryChanged(target: WorkspaceDirectoryEventTarget): void {
  target.dispatchEvent(new Event(WORKSPACE_DIRECTORY_CHANGED_EVENT));
}
