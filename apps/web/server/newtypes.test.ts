import { describe, expect, expectTypeOf, it } from 'vitest';
import { ZodError } from 'zod';
import { RunId, WorkspaceId } from './newtypes';

const WORKSPACE = '00000000-0000-4000-8000-000000000001';
const RUN = '00000000-0000-4000-8000-000000000002';

describe('parse', () => {
  it('accepts a UUID and returns the same string', () => {
    expect(WorkspaceId.parse(WORKSPACE)).toBe(WORKSPACE);
    expect(RunId.parse(RUN)).toBe(RUN);
  });

  it.each([['run-1'], [''], [`${RUN} `], [42], [null], [undefined]])(
    'refuses %j, which is not a UUID',
    (value) => {
      expect(() => RunId.parse(value)).toThrow(ZodError);
      expect(() => WorkspaceId.parse(value)).toThrow(ZodError);
    },
  );
});

describe('fromStore', () => {
  it('brands a stored value without changing it', () => {
    expect(WorkspaceId.fromStore(WORKSPACE)).toBe(WORKSPACE);
    expect(RunId.fromStore(RUN)).toBe(RUN);
  });
});

describe('the type checker tells the ids apart', () => {
  const remember = (runId: RunId, workspaceId: WorkspaceId) => ({ runId, workspaceId });
  const runId = RunId.fromStore(RUN);
  const workspaceId = WorkspaceId.fromStore(WORKSPACE);

  it('accepts them in the right order', () => {
    expect(remember(runId, workspaceId)).toEqual({ runId: RUN, workspaceId: WORKSPACE });
  });

  // Type-level: if a brand stopped working, these lines would fail `tsc`, not the test run.
  it('refuses them swapped, and refuses a bare string', () => {
    expectTypeOf<WorkspaceId>().not.toExtend<RunId>();
    expectTypeOf<RunId>().not.toExtend<WorkspaceId>();
    expectTypeOf<string>().not.toExtend<RunId>();
    expectTypeOf(remember).parameter(0).toEqualTypeOf<RunId>();
    expectTypeOf(remember).parameter(1).toEqualTypeOf<WorkspaceId>();
  });

  it('is still a string to everything that reads one', () => {
    expectTypeOf(runId).toExtend<string>();
    expectTypeOf(RunId.parse(RUN)).toEqualTypeOf<RunId>();
    expectTypeOf<RunId>().not.toEqualTypeOf<WorkspaceId>();
  });

  // Type-level: `fromStore` takes a plain string, and nothing at all for an id that has a brand.
  it('refuses to re-brand an id that already has a brand', () => {
    expectTypeOf<Parameters<typeof RunId.fromStore<WorkspaceId>>[0]>().toBeNever();
    expectTypeOf<Parameters<typeof WorkspaceId.fromStore<RunId>>[0]>().toBeNever();
    expectTypeOf<Parameters<typeof RunId.fromStore<string>>[0]>().toEqualTypeOf<string>();
  });

  it('cannot be replaced at runtime', () => {
    expect(Object.isFrozen(RunId)).toBe(true);
    expect(Object.isFrozen(WorkspaceId)).toBe(true);
  });
});
