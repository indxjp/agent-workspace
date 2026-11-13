import { describe, expect, expectTypeOf, it } from 'vitest';
import { ZodError } from 'zod';
import { Bytes, Milliseconds, RunId, Usd, WorkspaceId } from './newtypes';

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

describe('units', () => {
  it('accepts a whole, non-negative number and returns the same number', () => {
    expect(Bytes.parse(0)).toBe(0);
    expect(Bytes.parse(4096)).toBe(4096);
    expect(Milliseconds.parse(60_000)).toBe(60_000);
  });

  it.each([[-1], [1.5], [Number.NaN], [Number.POSITIVE_INFINITY], [2 ** 53], ['10'], [null]])(
    'refuses %j',
    (value) => {
      expect(() => Bytes.parse(value)).toThrow(ZodError);
      expect(() => Milliseconds.parse(value)).toThrow(ZodError);
    },
  );

  // Type-level: if a brand stopped working, these lines would fail `tsc`, not the test run.
  it('refuses a size where a duration is expected, and a bare number', () => {
    const wait = (timeout: Milliseconds, limit: Bytes) => ({ timeout, limit });
    expectTypeOf<Bytes>().not.toExtend<Milliseconds>();
    expectTypeOf<Milliseconds>().not.toExtend<Bytes>();
    expectTypeOf<number>().not.toExtend<Milliseconds>();
    expectTypeOf(wait).parameter(0).toEqualTypeOf<Milliseconds>();
    expectTypeOf(wait).parameter(1).toEqualTypeOf<Bytes>();
    expectTypeOf(Bytes.parse(1)).toExtend<number>();
  });

  it('cannot be replaced at runtime', () => {
    expect(Object.isFrozen(Bytes)).toBe(true);
    expect(Object.isFrozen(Milliseconds)).toBe(true);
  });
});

describe('Usd: one form for money (part 02 step 4)', () => {
  it('parses a decimal string into the six-place form numeric(14,6) prints', () => {
    expect(Usd.parse('0.25')).toBe('0.250000');
    expect(Usd.parse('3')).toBe('3.000000');
    expect(Usd.parse('0.000001')).toBe('0.000001');
    expect(Usd.parse('007.5')).toBe('7.500000');
    expect(Usd.parse('99999999.999999')).toBe('99999999.999999');
  });

  it.each<{ value: unknown; why: string }>([
    { value: 0.25, why: 'a number, which may already have lost precision' },
    { value: '-1', why: 'a negative amount' },
    { value: '1.0000001', why: 'more than six places' },
    { value: '100000000', why: 'more than the column holds' },
    { value: '1e3', why: 'exponent notation' },
    { value: '', why: 'an empty string' },
    { value: '.5', why: 'no whole part' },
    { value: '1.', why: 'a trailing point' },
    { value: ' 1', why: 'surrounding space' },
  ])('refuses $value: $why', ({ value }) => {
    expect(() => Usd.parse(value)).toThrow(ZodError);
  });

  it('converts to and from whole micro-dollars exactly', () => {
    expect(Usd.toMicros(Usd.parse('0.1'))).toBe(100_000n);
    expect(Usd.toMicros(Usd.parse('0.1')) + Usd.toMicros(Usd.parse('0.2'))).toBe(
      Usd.toMicros(Usd.parse('0.3')),
    );
    expect(Usd.fromMicros(1n)).toBe('0.000001');
    expect(Usd.fromMicros(0n)).toBe('0.000000');
    expect(Usd.fromMicros(1_234_567_890n)).toBe('1234.567890');
    expect(Usd.fromMicros(99_999_999_999_999n)).toBe('99999999.999999');
    expect(Usd.toMicros(Usd.fromMicros(99_999_999_999_999n))).toBe(99_999_999_999_999n);
  });

  it('refuses micro-dollars outside the column', () => {
    expect(() => Usd.fromMicros(-1n)).toThrow(RangeError);
    expect(() => Usd.fromMicros(100_000_000_000_000n)).toThrow(RangeError);
  });

  it('is a string the type checker tells from a plain one', () => {
    expectTypeOf(Usd.parse('1')).toExtend<string>();
    expectTypeOf<string>().not.toExtend<Usd>();
    expectTypeOf<Usd>().not.toExtend<RunId>();
  });
});
