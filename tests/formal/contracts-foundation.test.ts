/**
 * Differential conformance for the `contracts-foundation` family: the Lean shared contract
 * foundation (formal/AgentWorkspace/Prelude/{JValue,Codec,Text}.lean and
 * formal/AgentWorkspace/Contracts/{Identifiers,Problem}.lean) replayed against the REAL root
 * exports of `@indx-workspace/contracts` and the JavaScript runtime.
 *
 *   - `uuid.json`: `isUuid(input)` and `UuidSchema.safeParse(input)` answer the model's verdict,
 *     and an accepted id parses to itself.
 *   - `iso-date-time.json`: `IsoDateTimeSchema.safeParse(input)` answers the model's verdict, and
 *     an accepted instant parses to itself.
 *   - `problem-envelopes.json`: each of `ApiProblemSchema`, `ApiProblemDetailSchema` and
 *     `ApiProblemBareCodeSchema` accepts exactly the bodies the model decodes, and its parsed
 *     output deep-equals the model's decoded value. The `normalised` field (the model's
 *     `normaliseCurrent`, the SDK's unexported `readProblem`) is replayed through the REAL SDK: a
 *     client built by `createClient` over a stub `fetch` that answers 400 with the vector body, whose
 *     `ApiProblemError` must carry the model's code, message and details (or
 *     `unrecognised_error_body` when the model reads none).
 *   - `common-problem-codes.json`: `COMMON_PROBLEM_CODES`, key by key and in key order.
 *   - `codec-combinators.json`: the combinators the foundation contracts do not use (`int`,
 *     `nullable`, `array`, loose object, discriminated union), through the real schemas the Lean
 *     `Sample` transcriptions copy: the schema accepts exactly the bodies the model decodes, and its
 *     parsed output deep-equals the model's.
 *   - `text.json`: `String.prototype.length`, `trim` and the `\s` class over the whole Basic
 *     Multilingual Plane, the JavaScript semantics every Lean string predicate transcribes.
 */
import {
  ApiProblemBareCodeSchema,
  ApiProblemDetailSchema,
  ApiProblemSchema,
  COMMON_PROBLEM_CODES,
  IsoDateTimeSchema,
  isUuid,
  UuidSchema,
} from '@indx-workspace/contracts';
import { SubtreeMoveOutcomeSchema } from '@indx-workspace/contracts/files';
import {
  RelayedEventDataSchema,
  StreamResetFrameDataSchema,
} from '@indx-workspace/contracts/run-events';
import { RevokeRunTokensResponseSchema } from '@indx-workspace/contracts/runs';
import { describe, expect, it } from 'vitest';

import { ApiProblemError, createClient } from '@indx-workspace/sdk';
import { asRecord, asString, loadVectors } from './vectors.js';

const FAMILY = 'contracts-foundation';

const uuidVectors = loadVectors(FAMILY, 'uuid.json');
const isoVectors = loadVectors(FAMILY, 'iso-date-time.json');
const envelopeVectors = loadVectors(FAMILY, 'problem-envelopes.json');
const commonCodeVectors = loadVectors(FAMILY, 'common-problem-codes.json');
const textVectors = loadVectors(FAMILY, 'text.json');
const combinatorVectors = loadVectors(FAMILY, 'codec-combinators.json');

function asBoolean(value: unknown, what: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${what}: expected a boolean`);
  return value;
}

function asNumber(value: unknown, what: string): number {
  if (typeof value !== 'number') throw new Error(`${what}: expected a number`);
  return value;
}

function asNumbers(value: unknown, what: string): number[] {
  if (!Array.isArray(value)) throw new Error(`${what}: expected an array`);
  return value.map((item: unknown, index) => asNumber(item, `${what}[${String(index)}]`));
}

function asStrings(value: unknown, what: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${what}: expected an array`);
  return value.map((item: unknown, index) => asString(item, `${what}[${String(index)}]`));
}

describe('contracts-foundation: identifiers', () => {
  it.each(uuidVectors)('uuid $id', (vector) => {
    const expected = asRecord(vector.expected, vector.id);
    expect(isUuid(vector.input)).toBe(asBoolean(expected['isUuid'], 'isUuid'));
    const parsed = UuidSchema.safeParse(vector.input);
    expect(parsed.success).toBe(asBoolean(expected['uuidSchema'], 'uuidSchema'));
    if (parsed.success) expect(parsed.data).toBe(vector.input);
  });

  it.each(isoVectors)('iso date-time $id', (vector) => {
    const expected = asRecord(vector.expected, vector.id);
    const parsed = IsoDateTimeSchema.safeParse(vector.input);
    expect(parsed.success).toBe(asBoolean(expected['valid'], 'valid'));
    if (parsed.success) expect(parsed.data).toBe(vector.input);
  });
});

const ENVELOPES = [
  ['standard', ApiProblemSchema],
  ['detail', ApiProblemDetailSchema],
  ['bare', ApiProblemBareCodeSchema],
] as const;

describe('contracts-foundation: problem envelopes', () => {
  it.each(envelopeVectors)('envelope $id', (vector) => {
    const expected = asRecord(vector.expected, vector.id);
    let accepted = 0;
    for (const [name, schema] of ENVELOPES) {
      const parsed = schema.safeParse(vector.input);
      const decoded = expected[name];
      if (decoded === null) {
        expect(parsed.success, `${name} should refuse`).toBe(false);
      } else {
        expect(parsed.success, `${name} should accept`).toBe(true);
        if (parsed.success) expect(parsed.data).toEqual(decoded);
        accepted += 1;
      }
    }
    // The envelopes are disjoint, so `readProblem` finds at most one, and finds one exactly when
    // the model normalises the body.
    expect(accepted).toBeLessThanOrEqual(1);
    expect(accepted === 1).toBe(expected['normalised'] !== null);
  });

  it.each(envelopeVectors)('readProblem $id', async (vector) => {
    const expected = asRecord(vector.expected, vector.id);
    const problem = await problemFor(vector.input);
    // `read`, not `normalised`: `readProblem` drops the keys an envelope does not know before
    // parsing it, so a field a newer server adds keeps the code (CF-2).
    const normalised = expected['read'];
    if (normalised === null) {
      expect(problem.code).toBe('unrecognised_error_body');
      return;
    }
    const body = asRecord(normalised, 'normalised');
    expect(problem.code).toBe(asString(body['code'], 'code'));
    expect(problem.message).toBe(asString(body['message'], 'message'));
    const details = body['details'];
    expect(problem.details).toEqual(details === undefined ? [] : asStrings(details, 'details'));
  });
});

/** The `ApiProblemError` the real SDK raises when the server answers 400 with `body`. */
async function problemFor(body: unknown): Promise<ApiProblemError> {
  const client = createClient({
    baseUrl: 'https://aw.example.test',
    auth: { kind: 'api-key', apiKey: 'ak_live_formal' },
    fetch: () =>
      Promise.resolve(
        new Response(JSON.stringify(body), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        }),
      ),
  });
  const outcome = await client.me().then(
    () => null,
    (error: unknown) => error,
  );
  if (!(outcome instanceof ApiProblemError)) throw new Error('expected an ApiProblemError');
  return outcome;
}

describe('contracts-foundation: COMMON_PROBLEM_CODES', () => {
  it.each(commonCodeVectors)('common code $id', (vector) => {
    const expected = asRecord(vector.expected, vector.id);
    if (vector.input === null) {
      expect(Object.keys(COMMON_PROBLEM_CODES)).toEqual(asStrings(expected['keys'], 'keys'));
      return;
    }
    const code = asString(asRecord(vector.input, vector.id)['code'], 'code');
    const table: Readonly<Record<string, number>> = COMMON_PROBLEM_CODES;
    const status = expected['status'];
    if (status === null) {
      expect(Object.hasOwn(table, code)).toBe(false);
    } else {
      expect(Object.hasOwn(table, code)).toBe(true);
      expect(table[code]).toBe(asNumber(status, 'status'));
    }
  });
});

const COMBINATOR_SCHEMAS = {
  RevokeRunTokensResponseSchema,
  StreamResetFrameDataSchema,
  RelayedEventDataSchema,
  SubtreeMoveOutcomeSchema,
} as const;

function isCombinatorSchema(name: string): name is keyof typeof COMBINATOR_SCHEMAS {
  return Object.hasOwn(COMBINATOR_SCHEMAS, name);
}

describe('contracts-foundation: codec combinators', () => {
  it.each(combinatorVectors)('combinator $id', (vector) => {
    const input = asRecord(vector.input, vector.id);
    const name = asString(input['schema'], 'schema');
    if (!isCombinatorSchema(name)) throw new Error(`${vector.id}: unknown schema ${name}`);
    const parsed = COMBINATOR_SCHEMAS[name].safeParse(input['body']);
    const output = asRecord(vector.expected, vector.id)['output'];
    if (output === null) {
      expect(parsed.success, 'should refuse').toBe(false);
    } else {
      expect(parsed.success, 'should accept').toBe(true);
      if (parsed.success) expect(parsed.data).toEqual(output);
    }
  });
});

describe('contracts-foundation: JavaScript string semantics', () => {
  it.each(textVectors)('text $id', (vector) => {
    const expected = asRecord(vector.expected, vector.id);
    if (typeof vector.input === 'string') {
      const text = vector.input;
      expect(text.length).toBe(asNumber(expected['utf16Length'], 'utf16Length'));
      expect(text.trim()).toBe(asString(expected['trim'], 'trim'));
      expect(text.trim().length === 0).toBe(asBoolean(expected['blank'], 'blank'));
      return;
    }
    const range = asRecord(vector.input, vector.id);
    const from = asNumber(range['from'], 'from');
    const to = asNumber(range['to'], 'to');
    const bySpaceClass: number[] = [];
    const byTrim: number[] = [];
    for (let codePoint = from; codePoint <= to; codePoint += 1) {
      const text = String.fromCharCode(codePoint);
      if (/^\s$/u.test(text)) bySpaceClass.push(codePoint);
      if (text.trim() === '') byTrim.push(codePoint);
    }
    const whitespace = asNumbers(expected['whitespace'], 'whitespace');
    expect(bySpaceClass).toEqual(whitespace);
    expect(byTrim).toEqual(whitespace);
  });
});
