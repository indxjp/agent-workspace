/**
 * The `release` vector `a-conversation-keeps-its-version`, replayed against `resolveSessionVersion`
 * (issue #612; `docs/formal/domains/release.md`). Each `startSession` step feeds the model's state
 * before it (has the conversation started, where does the environment point) into the TypeScript
 * decision and compares the answer with the step the model emitted: the refusal code, or the
 * version the conversation pins. Every other step must leave the pins alone
 * (`session_version_stable`), and a pin names a saved version (`pointer_targets_existing_version`).
 *
 * The server departs from the model in one place: `no_pointer` keeps a legacy session unpinned
 * (`versionToPin` answers `null`) instead of refusing it, and the replay asserts that too. A
 * disagreement with the model is a failing test, and the fix is never to edit a vector
 * (`docs/formal/00-orchestrator-prompt.md` §10).
 */
import { describe, expect, it } from 'vitest';

import type { AgentVersionPointerRecord } from '@agent-workspace/core/db';

import { resolveSessionVersion, versionToPin } from '../server/agent-versions/session-version';
import { asRecord, asString, loadVectors } from '../../../tests/formal/vectors';

const SCENARIO = 'a-conversation-keeps-its-version';
const ENVIRONMENTS = ['local', 'production'] as const;
type Environment = (typeof ENVIRONMENTS)[number];

function versionOrNull(value: unknown, what: string): number | null {
  if (value === null || typeof value === 'number') return value;
  throw new Error(`${what} must be a version number or null`);
}

function environmentOf(value: unknown): Environment {
  const environment = ENVIRONMENTS.find((each) => each === value);
  if (environment === undefined) throw new Error('op.env must be local or production');
  return environment;
}

/** The conversations a state has started, and the version each pinned. */
function pinsOf(state: Record<string, unknown>): Record<string, number> {
  const pins: Record<string, number> = {};
  for (const [session, version] of Object.entries(asRecord(state['sessions'], 'sessions'))) {
    const pinned = versionOrNull(version, `sessions.${session}`);
    if (pinned !== null) pins[session] = pinned;
  }
  return pins;
}

/** Where a state's environment points, `null` for no pointer. */
function pointerOf(state: Record<string, unknown>, environment: Environment): number | null {
  return versionOrNull(asRecord(state['pointer'], 'pointer')[environment] ?? null, environment);
}

/** The pointer rows the server would read in a state, a version numbered `n` as `version-n`. */
function pointerRowsOf(state: Record<string, unknown>): readonly AgentVersionPointerRecord[] {
  return ENVIRONMENTS.flatMap((environment) => {
    const number = pointerOf(state, environment);
    return number === null
      ? []
      : [
          {
            agentId: 'agent-a',
            environment,
            versionId: `version-${String(number)}`,
            number,
            updatedAt: new Date(0),
          },
        ];
  });
}

describe(`release: ${SCENARIO} against resolveSessionVersion`, () => {
  const vector = loadVectors('release', 'steps.json').find(({ id }) => id === SCENARIO);

  it('starts every conversation exactly as the model does, and no other step re-pins one', () => {
    if (vector === undefined) throw new Error(`the release vectors have no ${SCENARIO}`);
    const ops = asRecord(vector.input, SCENARIO)['ops'];
    const steps = asRecord(vector.expected, SCENARIO)['steps'];
    if (!Array.isArray(ops) || !Array.isArray(steps) || ops.length !== steps.length) {
      throw new Error(`${SCENARIO}: one expected step per op`);
    }
    // The state before the first step is the empty release: nothing started, nothing pointed.
    let before: Record<string, unknown> = { versions: 0, sessions: {}, pointer: {} };
    let replayed = 0;
    ops.forEach((raw: unknown, index) => {
      const op = asRecord(raw, `ops[${String(index)}]`);
      const step = asRecord(steps[index], `steps[${String(index)}]`);
      const after = asRecord(step['state'], `steps[${String(index)}].state`);
      const pinsBefore = pinsOf(before);
      const pinsAfter = pinsOf(after);
      const prior = before;
      before = after;

      if (op['op'] !== 'startSession') {
        // session_version_stable: no other operation changes a started conversation's version.
        expect(pinsAfter).toStrictEqual(pinsBefore);
        return;
      }
      replayed += 1;
      const session = asString(op['session'], 'op.session');
      const environment = environmentOf(op['env']);
      const decision = resolveSessionVersion(
        pinsBefore[session] !== undefined,
        pointerOf(prior, environment),
      );

      if (decision.kind === 'refused') {
        expect(step['problem']).toBe(decision.code);
        expect(pinsAfter).toStrictEqual(pinsBefore);
        // The server's one departure: no pointer starts a legacy session, unpinned.
        if (decision.code === 'no_pointer') {
          expect(versionToPin(pointerRowsOf(prior), environment)).toBeNull();
        }
        return;
      }
      expect(step['problem']).toBeNull();
      expect(pinsAfter).toStrictEqual({ ...pinsBefore, [session]: decision.version });
      // pointer_targets_existing_version: the pin names a saved version.
      expect(decision.version).toBeLessThanOrEqual(Number(after['versions']));
      expect(versionToPin(pointerRowsOf(prior), environment)).toBe(
        `version-${String(decision.version)}`,
      );
    });
    // start s1 (no pointer), start s1 (pins 1), start s2 (pins 2), start s1 (already started).
    expect(replayed).toBe(4);
  });
});
