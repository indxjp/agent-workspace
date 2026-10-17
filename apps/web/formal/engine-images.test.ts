/**
 * Differential conformance for the `engine-images` family's control-plane half (ENG-07, #306),
 * replayed against `apps/web/server/engines/*` (decision D-012).
 *
 * * `control-plane.json` — `readConfiguredEngineImages`, the parser the control plane runs when
 *   `server/engines/images.ts` loads: the reference's shape and never its digest, in production or
 *   out (the digest rule is the runner manager's, `apps/runner/formal/engine-images.test.ts`), the
 *   development default when nothing is configured outside production, and a start-up refusal that
 *   names engine ids and no value.
 * * `catalogue.json` — `registeredEngines()`' `installed`, with the vector's map installed as this
 *   deployment's configuration, so the assertion is ADR-0073 D2 itself: the catalogue is the map.
 *
 * `tests/formal/engine-images.test.ts` replays the package half. A disagreement is a failing test,
 * and the fix is never to edit a vector (`docs/formal/00-orchestrator-prompt.md` §10).
 */
import { EngineImageConfigurationError, type EngineImageMap } from '@agent-workspace/runtime';
import { afterEach, describe, expect, it } from 'vitest';

import { asRecord, asString, loadVectors } from '../../../tests/formal/vectors';
import {
  clearEngineImagesConfiguredForTests,
  configureEngineImagesForTests,
  readConfiguredEngineImages,
} from '../server/engines/images';
import {
  clearEnginesRegisteredForTests,
  registerEngineForTests,
  registeredEngines,
} from '../server/engines/registry';

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

describe('engine-images control-plane.json replays against readConfiguredEngineImages', () => {
  it.each(loadVectors('engine-images', 'control-plane.json').map((v) => [v.id, v] as const))(
    '%s',
    (id, vector) => {
      const env = Object.fromEntries(
        Object.entries(asRecord(asRecord(vector.input, id)['env'], `${id} env`)).map(
          ([key, value]) => [key, asString(value, `${id} env ${key}`)],
        ),
      );
      const expected = asRecord(vector.expected, id);
      if (expected['ok'] === true) {
        expect([...readConfiguredEngineImages(env)], id).toEqual(
          asPairs(expected['images'], `${id} images`),
        );
        return;
      }
      let caught: unknown;
      try {
        readConfiguredEngineImages(env);
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

describe('engine-images catalogue.json replays against registeredEngines', () => {
  afterEach(() => {
    clearEnginesRegisteredForTests();
    clearEngineImagesConfiguredForTests();
  });

  it.each(loadVectors('engine-images', 'catalogue.json').map((v) => [v.id, v] as const))(
    '%s',
    (id, vector) => {
      const input = asRecord(vector.input, id);
      const images: EngineImageMap = new Map(asPairs(input['images'], `${id} images`));
      const registered = asStrings(input['registered'], `${id} registered`);
      // Every registered engine other than the built-in one is registered as a test descriptor;
      // none of them states `installed`, because since ENG-07 no descriptor can.
      for (const engine of registered) {
        if (engine === 'claude-agent-sdk') continue;
        registerEngineForTests({
          id: engine,
          displayName: engine,
          version: '1.0.0',
          capabilities: {
            mcp: false,
            skills: false,
            subagents: false,
            resume: false,
            fork: false,
            interrupt: false,
            streamingText: false,
            reasoning: false,
            maxTurns: 'adapter',
            maxBudget: 'adapter',
            wireProtocols: ['anthropic-messages'],
          },
        });
      }
      configureEngineImagesForTests(images);

      const catalogue = registeredEngines()
        .filter((engine) => registered.includes(engine.id))
        .map((engine) => ({ id: engine.id, installed: engine.installed }));
      expect(catalogue, id).toEqual(asRecord(vector.expected, id)['engines']);
    },
  );
});
