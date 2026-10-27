/**
 * Property tests for the project file reader and writer (F-21 property 8): reading what
 * {@link writeProjectFileText} wrote gives back the mapping it was handed, and
 * {@link parseProjectFile} answers arbitrary YAML with a project or a typed
 * {@link ProjectFileError} — never another exception. On a failure fast-check prints the seed and
 * path that reproduce it.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { parseProjectFile } from './parse.js';
import { ProjectFileError, readProjectFileText } from './reader.js';
import { writeProjectFileText } from './writer.js';

/** Text that YAML likes to reinterpret: booleans, numbers, nulls, indicators and quotes. */
const tricky = fc.constantFrom(
  '',
  'true',
  'no',
  'null',
  '~',
  '0x1f',
  '1e3',
  '-',
  '- a',
  ': x',
  '#c',
  "it's",
  '"q"',
  '&a',
  '*a',
  '!tag',
  '{a: 1}',
  '[1]',
  ' lead',
  'trail ',
  'multi\nline',
  'tab\there',
  'é😀',
);

const text = fc.oneof(tricky, fc.string({ maxLength: 12 }));
const key = fc.oneof(tricky, fc.string({ maxLength: 8 }));

const scalar = fc.oneof(
  text,
  fc.boolean(),
  fc.integer(),
  // `-0` is written as `0` and read back as `0`; the two are one value in a project file.
  // The writer refuses an integer beyond 2^53 by contract; every other finite double is in range.
  fc
    .double({ noNaN: true, noDefaultInfinity: true })
    .filter(
      (value) => !Object.is(value, -0) && (!Number.isInteger(value) || Number.isSafeInteger(value)),
    ),
);

const { mapping } = fc.letrec<{ mapping: Record<string, unknown>; value: unknown }>((tie) => ({
  mapping: fc.dictionary(key, tie('value'), { minKeys: 1, maxKeys: 4 }),
  value: fc.oneof(
    { depthSize: 'small', withCrossShrink: true },
    scalar,
    fc.array(fc.oneof(scalar, tie('mapping')), { maxLength: 3 }),
    tie('mapping'),
    fc.constant({}),
  ),
}));

/** YAML-shaped fragments, so arbitrary input reaches the reader's refusals and not only the parser's. */
const yamlish = fc
  .array(
    fc.oneof(
      fc.constantFrom(
        'apiVersion: agentworkspace.dev/v2\n',
        'kind: Project\n',
        'name: p\n',
        'environments:\n',
        '  local:\n',
        '    cloud: local\n',
        'a: &x 1\n',
        'b: *x\n',
        '%YAML 1.2\n---\n',
        'c: !custom v\n',
        'a: 1\na: 2\n',
        '? [k]\n: v\n',
        '- item\n',
        '\t',
        '"',
        '[',
        '{',
      ),
      fc.string({ maxLength: 10 }),
    ),
    { maxLength: 10 },
  )
  .map((parts) => parts.join(''));

describe('project file reader and writer (property)', () => {
  it('reads back exactly the mapping the writer wrote', () => {
    fc.assert(
      fc.property(mapping, (document) => {
        const written = writeProjectFileText(document);
        expect(readProjectFileText(written).value).toEqual(document);
      }),
      { numRuns: 300 },
    );
  });

  it('answers arbitrary YAML with a project or a ProjectFileError, never another error', () => {
    fc.assert(
      fc.property(fc.oneof(yamlish, fc.string({ maxLength: 80 })), (input) => {
        try {
          parseProjectFile(input);
        } catch (error) {
          expect(error).toBeInstanceOf(ProjectFileError);
        }
      }),
      { numRuns: 500 },
    );
  });
});
