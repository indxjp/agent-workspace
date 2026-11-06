import { RunRequest } from '@agent-workspace/run-protocol';

import { describe, expect, it } from 'vitest';

import { sandboxFor } from './run-request';
import { SESSION, SETTINGS, WORKSPACE } from './run-request.fixture.test-support';
export function registerSandboxTests() {
  describe('sandboxFor', () => {
    it('gives each workspace and session its own cwd (spec §25)', () => {
      const a = sandboxFor(WORKSPACE, SESSION, SETTINGS);
      const b = sandboxFor(
        '33333333-3333-4333-8333-333333333333',
        '55555555-5555-4555-8555-555555555555',
        SETTINGS,
      );
      expect(a.cwd).toBe(`/workspace/${WORKSPACE}/${SESSION}`);
      expect(a.cwd).not.toBe(b.cwd);
      expect(a.projectKey).not.toBe(b.projectKey);
    });

    it('names no engine configuration directory at all (ENG-04b, #325)', () => {
      // The `configDir` this used to return was `${cwd}/.claude` — one engine's layout, chosen by a
      // control plane that may not import an engine adapter. The adapter derives it now, so there is
      // nothing here to get wrong for a second engine.
      expect(Object.keys(sandboxFor(WORKSPACE, SESSION, SETTINGS)).toSorted()).toEqual([
        'cwd',
        'projectKey',
      ]);
    });

    it("produces a projectKey the SDK's own validator accepts", () => {
      // Checked through the schema, not against a copy of the regex: `RunProjectKey`'s superRefine is
      // what rejects a key the SDK would silently ignore (R-01 §7).
      const { projectKey } = sandboxFor(WORKSPACE, SESSION, SETTINGS);
      expect(() => RunRequest.pick({ projectKey: true }).parse({ projectKey })).not.toThrow();
    });
  });
}
