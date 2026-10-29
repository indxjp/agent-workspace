// @vitest-environment happy-dom
import type { StorageConnectionResource } from '@indx-workspace/sdk';
import { act, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentResourceAssignments } from '../../contracts/agents';
import { StorageGrantList } from './connected-storage';
import { removeStorageGrant } from './storage-grants-model';

/**
 * Where focus goes once a storage grant is removed (#1835, STO-508): to the grant that takes the
 * removed row's place, to the one above when the last row went, and to the add control when none
 * is left. A refused removal leaves focus on the button that was pressed.
 */
vi.mock('../../lib/browser-client', () => ({ browserClient: () => ({}) }));
vi.mock('./storage-grants-model', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./storage-grants-model')>()),
  removeStorageGrant: vi.fn(),
}));
const remove = vi.mocked(removeStorageGrant);

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type StorageGrants = AgentResourceAssignments['storageGrants'];

const CONNECTION: StorageConnectionResource = {
  id: '3f2b6c1e-8a4d-4f0e-9b57-2d1c0a9e7b11',
  name: 'acme-data',
  provider: 'file',
  url: 'file:///srv/acme',
  allowedPrefixes: ['a', 'b', 'c'],
  writeAllowed: false,
  hasCredential: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};
const grant = (prefix: string) => ({
  connectionId: CONNECTION.id,
  prefix,
  access: 'read' as const,
});
const assignments = (storageGrants: StorageGrants): AgentResourceAssignments => ({
  files: [],
  skillIds: [],
  connectorIds: [],
  storageGrants,
});

/** The grant list beside the add control, as the agent's files editor lays them out. */
function Editor({ initial }: Readonly<{ initial: StorageGrants }>) {
  const [grants, setGrants] = useState(initial);
  const addRef = useRef<HTMLButtonElement>(null);
  return (
    <>
      <StorageGrantList
        agentId="agent-1"
        grants={grants}
        connections={{ kind: 'ready', connections: [CONNECTION] }}
        focusWhenEmpty={addRef}
        onChanged={(next) => setGrants(next.storageGrants)}
      />
      <button type="button">Next control</button>
      <button type="button" ref={addRef}>
        Add files or folders
      </button>
    </>
  );
}

let unmount: (() => void) | undefined;
beforeEach(() => {
  remove.mockReset();
});
afterEach(() => {
  unmount?.();
  unmount = undefined;
  document.body.replaceChildren();
});

function mount(initial: StorageGrants) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  act(() => {
    root.render(<Editor initial={initial} />);
  });
  unmount = () => {
    act(() => {
      root.unmount();
    });
  };
}

const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

function removeButton(prefix: string): HTMLButtonElement {
  const found = document.querySelector<HTMLButtonElement>(
    `button[aria-label="Remove acme-data/${prefix}/"]`,
  );
  if (found === null) throw new Error(`No Remove button for ${prefix}`);
  return found;
}

async function press(target: HTMLButtonElement) {
  act(() => {
    target.focus();
    target.click();
  });
  await settle();
}

describe('focus after a storage grant is removed', () => {
  it('moves to the grant that takes the removed row’s place', async () => {
    remove.mockResolvedValue(assignments([grant('a'), grant('c')]));
    mount([grant('a'), grant('b'), grant('c')]);

    await press(removeButton('b'));
    expect(document.activeElement).toBe(removeButton('c'));
  });

  it('moves to the grant above when the last row was removed', async () => {
    remove.mockResolvedValue(assignments([grant('a')]));
    mount([grant('a'), grant('b')]);

    await press(removeButton('b'));
    expect(document.activeElement).toBe(removeButton('a'));
  });

  it('moves to the add control when no grant is left', async () => {
    remove.mockResolvedValue(assignments([]));
    mount([grant('a')]);

    await press(removeButton('a'));
    expect(document.querySelector('ul')).toBeNull();
    expect(document.activeElement?.textContent).toBe('Add files or folders');
  });

  it('stays on the pressed button, with the reason announced, when the removal is refused', async () => {
    remove.mockRejectedValue(new Error('refused'));
    mount([grant('a'), grant('b')]);

    await press(removeButton('a'));
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(
      'The grant could not be removed.',
    );
    expect(document.activeElement).toBe(removeButton('a'));
  });

  it('keeps the pressed button focusable while the removal is in flight', async () => {
    let finish: (next: AgentResourceAssignments) => void = () => undefined;
    remove.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    mount([grant('a'), grant('b')]);

    await press(removeButton('a'));
    expect(document.activeElement).toBe(removeButton('a'));
    expect(removeButton('a').getAttribute('aria-disabled')).toBe('true');
    await act(async () => {
      finish(assignments([grant('b')]));
      await Promise.resolve();
    });
    await settle();
    expect(document.activeElement).toBe(removeButton('b'));
  });
});
