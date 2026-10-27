/**
 * Differential conformance for the `engine-images` family's runner-manager half (ENG-07, #306),
 * replayed against `apps/runner/src/manager-start.ts` (decision D-012).
 *
 * * `runner-manager.json` — `engineImagesFor`, the parser the runner manager runs at start-up. It is
 *   where ADR-0073 D5's digest rule lives: a tag-only value is refused in production, by key and
 *   never by value, while the control plane (`apps/web/formal/engine-images.test.ts`) admits the
 *   same value. A manager with no image at all refuses to start, naming no key.
 *
 * A disagreement is a failing test, and the fix is never to edit a vector
 * (`docs/formal/00-orchestrator-prompt.md` §10).
 */
import { EngineImageConfigurationError } from '@agent-workspace/runtime/engine-images';
import { describe, expect, it } from 'vitest';

import { asRecord, asString, loadVectors } from '../../../tests/formal/vectors.js';
import { engineImagesFor } from '../src/manager-start.js';

function asPairs(value: unknown, what: string): (readonly [string, string])[] {
  if (!Array.isArray(value)) throw new Error(`${what}: expected an array`);
  return value.map((pair, index) => {
    if (!Array.isArray(pair) || pair.length !== 2) {
      throw new Error(`${what}[${String(index)}]: expected a pair`);
    }
    return [asString(pair[0], `${what} key`), asString(pair[1], `${what} value`)] as const;
  });
}

function asStrings(value: unknown, what: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${what}: expected an array`);
  return value.map((entry) => asString(entry, what));
}

describe('engine-images runner-manager.json replays against engineImagesFor', () => {
  it.each(loadVectors('engine-images', 'runner-manager.json').map((v) => [v.id, v] as const))(
    '%s',
    (id, vector) => {
      const env = Object.fromEntries(
        Object.entries(asRecord(asRecord(vector.input, id)['env'], `${id} env`)).map(
          ([key, value]) => [key, asString(value, `${id} env ${key}`)],
        ),
      );
      const expected = asRecord(vector.expected, id);
      if (expected['ok'] === true) {
        expect([...engineImagesFor(env)], id).toEqual(asPairs(expected['images'], `${id} images`));
        return;
      }
      let caught: unknown;
      try {
        engineImagesFor(env);
      } catch (error) {
        caught = error;
      }
      expect(caught, id).toBeInstanceOf(EngineImageConfigurationError);
      const error = caught as EngineImageConfigurationError;
      expect(error.keys, id).toEqual(asStrings(expected['keys'], `${id} keys`));
      for (const [key, value] of Object.entries(env)) {
        if (key !== 'NODE_ENV' && value.length > 0) {
          expect(error.message, `${id} leaks ${key}`).not.toContain(value);
        }
      }
    },
  );
});
