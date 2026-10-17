import { describe, expect, it, vi } from 'vitest';

import {
  concealTenantDocument,
  notifyWorkspaceDirectoryChanged,
  shouldReloadRestoredTenantPage,
  WORKSPACE_DIRECTORY_CHANGED_EVENT,
} from './workspace-navigation';

describe('concealTenantDocument', () => {
  it('conceals tenant records before the full-navigation form leaves the page', () => {
    const setAttribute = vi.fn();
    const document = { body: { style: { visibility: 'visible' }, setAttribute } };

    concealTenantDocument(document);

    expect(setAttribute).toHaveBeenCalledWith('aria-busy', 'true');
    expect(document.body.style.visibility).toBe('hidden');
  });
});

describe('shouldReloadRestoredTenantPage', () => {
  it('reloads only a document restored from the browser back/forward cache', () => {
    expect(shouldReloadRestoredTenantPage({ persisted: true })).toBe(true);
    expect(shouldReloadRestoredTenantPage({ persisted: false })).toBe(false);
  });
});

describe('notifyWorkspaceDirectoryChanged', () => {
  it('emits the one event the shell uses to refresh server-returned role and archive state', () => {
    const dispatched: Event[] = [];
    notifyWorkspaceDirectoryChanged({
      dispatchEvent(event) {
        dispatched.push(event);
        return true;
      },
    });
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]?.type).toBe(WORKSPACE_DIRECTORY_CHANGED_EVENT);
  });
});
