/**
 * Differential conformance for the `engine-images` family (ENG-07, #306), replayed against
 * `@agent-workspace/runtime` through its public exports.
 *
 * * `parse.json` and `env.json` — `parseEngineImageMap` and `readEngineImageMap` return the whole
 *   map or throw `EngineImageConfigurationError` naming exactly the model's keys, in its order;
 *   the message is scanned for every configured value, which must not appear.
 * * `catalogue.json` — `engineImageInstalled` for each registered engine.
 * * `dispatch.json` — `resolveEngineImage`, and the **real** Docker driver's `create()` over a fake
 *   `docker` command: a run with an image starts one container in exactly that image, and a run
 *   without one is refused before the driver issues a single command.
 *
 * `apps/web/formal/engine-images.test.ts` replays the control plane's half (decision D-012). A
 * disagreement is a failing test, and the fix is never to edit a vector
 * (`docs/formal/00-orchestrator-prompt.md` §10).
 */
import {
  EngineImageConfigurationError,
  createDockerDriver,
  engineImageInstalled,
  parseEngineImageMap,
  readEngineImageMap,
  resolveEngineImage,
  type DockerCommand,
  type EngineImageMap,
} from '@agent-workspace/runtime';
import { describe, expect, it } from 'vitest';

import { asRecord, asString, loadVectors } from './vectors.js';

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

/** Run a parse and compare its outcome with the model's `expected`. */
function expectParsed(
  run: () => EngineImageMap,
  expected: Record<string, unknown>,
  values: readonly string[],
  id: string,
): void {
  if (expected['ok'] === true) {
    expect([...run()], id).toEqual(asPairs(expected['images'], `${id} images`));
    return;
  }
  let caught: unknown;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  expect(caught, id).toBeInstanceOf(EngineImageConfigurationError);
  const error = caught as EngineImageConfigurationError;
  expect(error.keys, id).toEqual(asStrings(expected['keys'], `${id} keys`));
  // ADR-0073 D5: the refusal names keys and never a value.
  for (const value of values) {
    if (value.length > 0) expect(error.message, `${id} leaks a value`).not.toContain(value);
  }
}

describe('engine-images parse.json replays against parseEngineImageMap', () => {
  it.each(loadVectors('engine-images', 'parse.json').map((v) => [v.id, v] as const))(
    '%s',
    (id, vector) => {
      const input = asRecord(vector.input, id);
      const entries = asPairs(input['entries'], `${id} entries`);
      expectParsed(
        () =>
          parseEngineImageMap(entries, {
            knownEngineIds: asStrings(input['knownEngineIds'], `${id} known`),
            requireDigest: input['requireDigest'] === true,
          }),
        asRecord(vector.expected, id),
        entries.map(([, value]) => value),
        id,
      );
    },
  );
});

describe('engine-images env.json replays against readEngineImageMap', () => {
  it.each(loadVectors('engine-images', 'env.json').map((v) => [v.id, v] as const))(
    '%s',
    (id, vector) => {
      const input = asRecord(vector.input, id);
      const env = Object.fromEntries(
        Object.entries(asRecord(input['env'], `${id} env`)).map(([key, value]) => [
          key,
          asString(value, `${id} env ${key}`),
        ]),
      );
      expectParsed(
        () =>
          readEngineImageMap(env, {
            knownEngineIds: asStrings(input['knownEngineIds'], `${id} known`),
            requireDigest: input['requireDigest'] === true,
          }),
        asRecord(vector.expected, id),
        Object.values(env),
        id,
      );
    },
  );
});

describe('engine-images catalogue.json replays against engineImageInstalled', () => {
  it.each(loadVectors('engine-images', 'catalogue.json').map((v) => [v.id, v] as const))(
    '%s',
    (id, vector) => {
      const input = asRecord(vector.input, id);
      const images: EngineImageMap = new Map(asPairs(input['images'], `${id} images`));
      const registered = asStrings(input['registered'], `${id} registered`);
      const expected = asRecord(vector.expected, id)['engines'];
      expect(
        registered.map((engine) => ({
          id: engine,
          installed: engineImageInstalled(images, engine),
        })),
        id,
      ).toEqual(expected);
    },
  );
});

describe('engine-images dispatch.json replays against the Docker driver', () => {
  it.each(loadVectors('engine-images', 'dispatch.json').map((v) => [v.id, v] as const))(
    '%s',
    async (id, vector) => {
      const input = asRecord(vector.input, id);
      const expected = asRecord(vector.expected, id);
      const entries = asPairs(input['images'], `${id} images`);
      const images: EngineImageMap = new Map(entries);
      const engine = asString(input['engine'], `${id} engine`);

      const commands: (readonly string[])[] = [];
      const docker: DockerCommand = (args) => {
        commands.push(args);
        return Promise.resolve({ stdout: 'container-1\n', stderr: '', exitCode: 0 });
      };
      const driver = createDockerDriver<never, never>({
        images,
        docker,
        networkPolicy: 'open',
        workspaceStorage: 'anonymous-volume',
        startAgent: () => {
          throw new Error('not used');
        },
      });
      const create = driver.create({ sessionId: 'session-1', workspacePath: '/ws/1', engine });

      if (expected['outcome'] === 'created') {
        const image = asString(expected['image'], `${id} image`);
        expect(resolveEngineImage(images, engine), id).toEqual({ ok: true, image });
        await create;
        expect(commands.length, id).toBe(expected['sandboxes']);
        expect(commands[0], id).toContain(image);
        // The one container is started in the run's engine's image and in no other configured one.
        for (const [other, reference] of entries) {
          if (other !== engine) expect(commands[0], id).not.toContain(reference);
        }
        return;
      }

      const resolved = resolveEngineImage(images, engine);
      expect(resolved.ok, id).toBe(false);
      if (!resolved.ok) expect(resolved.code, id).toBe(expected['code']);
      await expect(create, id).rejects.toThrow(/no runtime image for engine/u);
      // Refused before any sandbox: the driver issued no command at all.
      expect(commands.length, id).toBe(expected['sandboxes']);
      const refusal = await create.catch((error: unknown) => String(error));
      for (const [, reference] of entries) expect(refusal, id).not.toContain(reference);
    },
  );
});
