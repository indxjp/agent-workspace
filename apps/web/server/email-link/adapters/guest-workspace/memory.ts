/**
 * `GuestWorkspaceBinder` over the in-memory directory, for tests that need no database. It shares
 * the production adapter's code; what differs is the directory underneath, and the contract test
 * runs against both so the two cannot drift.
 */
import { counterIds, type IdGenerator } from '../../../ids';
import { createMemoryDirectory, type MemoryDirectory } from '../../../rbac/memory-directory';
import type { GuestWorkspaceBinder } from '../../ports';
import { createGuestWorkspaceBinder } from './production';

export interface MemoryGuestWorkspace {
  readonly binder: GuestWorkspaceBinder;
  /** The directory the binder writes, for a test that reads the rows back. */
  readonly directory: MemoryDirectory;
}

export function createMemoryGuestWorkspaceBinder(
  options: {
    readonly ids?: IdGenerator;
    readonly directory?: MemoryDirectory;
  } = {},
): MemoryGuestWorkspace {
  const ids = options.ids ?? counterIds();
  const directory = options.directory ?? createMemoryDirectory({ newId: () => ids.newId() });
  return { binder: createGuestWorkspaceBinder({ directory, ids }), directory };
}
