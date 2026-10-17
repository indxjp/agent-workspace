/**
 * The runtime half of `scope.ts`'s promise.
 *
 * The compile-time half cannot be tested by code that compiles, so it lives in
 * `scope-forgery.test.ts`, which runs `tsc` over a fixture. What is testable at runtime is
 * everything the type system does not reach: that a scope exists only because a lookup found a
 * workspace, that it is frozen, and that the guard answers about the object rather than the shape.
 */
import { describe, expect, it } from 'vitest';

import {
  createInMemoryWorkspaceScopeResolver,
  UnknownWorkspaceError,
  WorkspaceScope,
} from './scope.js';

const WORKSPACE_A = '11111111-1111-4111-8111-111111111111';
const WORKSPACE_B = '22222222-2222-4222-8222-222222222222';

const resolver = (): ReturnType<typeof createInMemoryWorkspaceScopeResolver> =>
  createInMemoryWorkspaceScopeResolver([
    { id: WORKSPACE_A, slug: 'acme' },
    { id: WORKSPACE_B, slug: 'globex' },
  ]);

/** Resolve a scope or fail the test — a set-up line that silently produced null would assert over nothing. */
async function scopeFor(id: string): Promise<WorkspaceScope> {
  const scope = await resolver().forWorkspaceId(id);
  if (scope === null) throw new Error(`the resolver produced no scope for ${id}`);
  return scope;
}

describe('the in-memory workspace scope resolver', () => {
  it('produces a scope carrying the workspace id it looked up', async () => {
    const scope = await scopeFor(WORKSPACE_A);
    expect(scope.workspaceId).toBe(WORKSPACE_A);
  });

  it('resolves the same workspace by slug, because that is what a session token carries', async () => {
    const scope = await resolver().forWorkspaceSlug('globex');
    expect(scope?.workspaceId).toBe(WORKSPACE_B);
  });

  it('answers null for an id it does not have, rather than a scope for it', async () => {
    expect(await resolver().forWorkspaceId('33333333-3333-4333-8333-333333333333')).toBeNull();
  });

  it('answers null for a slug it does not have', async () => {
    expect(await resolver().forWorkspaceSlug('nobody')).toBeNull();
  });

  it('answers null for every lookup when it knows no workspaces at all', async () => {
    // The empty case explicitly: a resolver with nothing in it must refuse, not wave everything
    // through. This is the arm that fails open if the lookup is ever written as "unless known bad".
    const empty = createInMemoryWorkspaceScopeResolver([]);
    expect(await empty.forWorkspaceId(WORKSPACE_A)).toBeNull();
    expect(await empty.forWorkspaceSlug('acme')).toBeNull();
  });

  it('does not see workspaces added to the argument after it was built', async () => {
    const rows = [{ id: WORKSPACE_A, slug: 'acme' }];
    const built = createInMemoryWorkspaceScopeResolver(rows);
    rows.push({ id: WORKSPACE_B, slug: 'globex' });
    expect(await built.forWorkspaceId(WORKSPACE_B)).toBeNull();
  });
});

describe('a WorkspaceScope at run time', () => {
  it('is frozen, so Object.assign onto it throws instead of replacing the tenant', async () => {
    const scope = await scopeFor(WORKSPACE_A);
    expect(Object.isFrozen(scope)).toBe(true);
    expect(() => Object.assign(scope, { workspaceId: WORKSPACE_B })).toThrow(TypeError);
    expect(scope.workspaceId).toBe(WORKSPACE_A);
  });

  it('cannot have its tenant redefined', async () => {
    const scope = await scopeFor(WORKSPACE_A);
    expect(() => Object.defineProperty(scope, 'workspaceId', { value: WORKSPACE_B })).toThrow(
      TypeError,
    );
    expect(scope.workspaceId).toBe(WORKSPACE_A);
  });

  it('recognises itself', async () => {
    expect(WorkspaceScope.isWorkspaceScope(await scopeFor(WORKSPACE_A))).toBe(true);
  });

  it('does not recognise a spread copy, because the spread drops the private field', async () => {
    const scope = await scopeFor(WORKSPACE_A);
    const copy = { ...scope, workspaceId: WORKSPACE_B };
    expect(WorkspaceScope.isWorkspaceScope(copy)).toBe(false);
  });

  it('does not recognise an object literal of the same shape', () => {
    expect(WorkspaceScope.isWorkspaceScope({ workspaceId: WORKSPACE_A })).toBe(false);
  });

  it('does not recognise an instance conjured from the prototype', () => {
    // The escape `scope.ts` declares it does not close at compile time. It IS closed at run time,
    // and this is what says so: the object has the right prototype and no private field.
    const conjured: unknown = Object.create(WorkspaceScope.prototype);
    expect(WorkspaceScope.isWorkspaceScope(conjured)).toBe(false);
  });

  it('does not recognise a JSON round trip, null, or a primitive', async () => {
    const scope = await scopeFor(WORKSPACE_A);
    expect(WorkspaceScope.isWorkspaceScope(JSON.parse(JSON.stringify(scope)))).toBe(false);
    expect(WorkspaceScope.isWorkspaceScope(null)).toBe(false);
    expect(WorkspaceScope.isWorkspaceScope(WORKSPACE_A)).toBe(false);
    expect(WorkspaceScope.isWorkspaceScope(undefined)).toBe(false);
  });

  it('serialises to exactly its one public field', async () => {
    const scope = await scopeFor(WORKSPACE_A);
    expect(JSON.parse(JSON.stringify(scope))).toEqual({ workspaceId: WORKSPACE_A });
  });
});

describe('UnknownWorkspaceError', () => {
  it('names the workspace it refused, so the log line is actionable', () => {
    const error = new UnknownWorkspaceError(WORKSPACE_A);
    expect(error.workspaceId).toBe(WORKSPACE_A);
    expect(error.name).toBe('UnknownWorkspaceError');
    expect(error.message).toContain(WORKSPACE_A);
  });
});
