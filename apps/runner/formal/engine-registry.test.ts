/**
 * The `engine-compose` registry and sandbox-environment vectors, replayed against the runner
 * (ENG-04, #303).
 *
 * Decision D-012: a suite that imports application code lives with the application. This one
 * drives two things the unit's T2 and T3 theorems are about:
 *
 *   * `apps/runner/src/engines.ts` — which engines this image carries, and what a request for
 *     one it does not carry is answered with. The registry's module table is stubbed, which is
 *     the same input node hands it when the package really is absent;
 *   * `@agent-workspace/engine`'s `sandboxEnvironmentVerdict` — spec A.11 as a property of the
 *     compiled environment rather than as one provider's spelling of a key.
 *
 * A disagreement with the Lean model is a failing test, and the fix is never to edit a vector
 * (`docs/formal/00-orchestrator-prompt.md` §10).
 */
import { sandboxEnvironmentVerdict } from '@agent-workspace/engine';
import type { AgentEngine } from '@agent-workspace/engine';
import { afterEach, describe, expect, it } from 'vitest';

import { loadVectors } from '../../../tests/formal/vectors.js';
import {
  configureEngineModulesForTests,
  installedEngines,
  loadEngine,
  resetEngineModules,
} from '../src/engines.js';

const FAMILY = 'engine-compose';

afterEach(() => {
  resetEngineModules();
});

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label}: expected an object, got ${JSON.stringify(value)}`);
  }
  return value as Record<string, unknown>;
}

function rows(value: unknown, label: string): readonly Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label}: expected an array, got ${JSON.stringify(value)}`);
  }
  return value.map((entry, index) => record(entry, `${label}[${String(index)}]`));
}

/** A minimal adapter that answers to one id — enough for the registry's structural check. */
function adapterFor(id: string, version: string): AgentEngine {
  return {
    id,
    version,
    capabilities: {
      mcp: true,
      skills: true,
      subagents: false,
      resume: true,
      fork: false,
      interrupt: true,
      streamingText: false,
      reasoning: true,
      maxTurns: 'native',
      maxBudget: 'native',
      wireProtocols: ['anthropic-messages'],
    },
    protectedConfigDirectory: '.claude',
    placeSkills: () => [],
    compile: () => ({ ok: false, code: 'engine_policy_invalid', reason: 'vector adapter' }),
    start: () => {
      throw new Error('the vector adapter never starts a run');
    },
  };
}

/** The factory `apps/runner/src/engines.ts` builds an adapter with, per engine id. */
const EXPORT_NAMES: Readonly<Record<string, string>> = {
  'claude-agent-sdk': 'createClaudeAgentSdkEngine',
};

describe('engine-compose: the registry this image really has', () => {
  const vectors = loadVectors(FAMILY, 'registry.json');

  it.each(vectors)('$id', async ({ id, input, expected }) => {
    const request = record(input, id);
    const answer = record(expected, id);

    // The Lean model's `loads: false` row is a package declared by this runner and absent from
    // the image. A loader that rejects is exactly what node hands the registry in that case.
    const table: Record<string, () => Promise<unknown>> = {};
    for (const row of rows(request['table'], id)) {
      const rowId = String(row['id']);
      const version = String(row['version']);
      const exportName = EXPORT_NAMES[rowId] ?? 'createClaudeAgentSdkEngine';
      table[rowId] =
        row['loads'] === true
          ? () => Promise.resolve({ [exportName]: () => adapterFor(rowId, version) })
          : () => Promise.reject(new Error(`Cannot find package for ${rowId}`));
    }
    configureEngineModulesForTests(table);

    const lookup = await loadEngine(String(request['engine']));
    const expectedCode = answer['code'];
    if (expectedCode === null) {
      expect(lookup.ok, `${id}: the model finds this engine`).toBe(true);
    } else {
      expect(lookup.ok, `${id}: the model refuses this engine`).toBe(false);
      if (!lookup.ok) expect(lookup.code).toBe(expectedCode);
    }

    // `/healthz` reports the *result of loading*, never a reading of the table.
    const installed = await installedEngines();
    expect(installed.map((engine) => ({ id: engine.id, version: engine.version }))).toEqual(
      rows(answer['installed'], id).map((row) => ({
        id: String(row['id']),
        version: String(row['version']),
      })),
    );
  });

  it('replayed the vector that proves an image with no adapter reports none', () => {
    expect(vectors.map((vector) => vector.id)).toContain('package-absent');
  });
});

describe('engine-compose: spec A.11 as a property of the compiled environment', () => {
  const vectors = loadVectors(FAMILY, 'sandbox-env.json');

  it.each(vectors)('$id', ({ id, input, expected }) => {
    const request = record(input, id);
    const answer = record(expected, id);
    const env: Record<string, string> = {};
    for (const [name, value] of Object.entries(record(request['env'], id))) {
      env[name] = String(value);
    }

    const verdict = sandboxEnvironmentVerdict(env, String(request['runToken']));
    expect(verdict.ok, `${id}: ${verdict.ok ? '' : verdict.reason}`).toBe(answer['accepted']);
    if (verdict.ok) {
      expect(verdict.checked).toBe(answer['checked']);
      expect(answer['variable']).toBeNull();
    } else {
      // The refusal names the variable, because that is the operator's next action.
      expect(verdict.variable).toBe(answer['variable']);
    }
  });

  it('replayed the vector for a credential variable nobody has heard of', () => {
    // The half a name list cannot state, and the reason the check generalises past Claude.
    expect(vectors.map((vector) => vector.id)).toContain('unheard-of-provider-key');
  });
});
