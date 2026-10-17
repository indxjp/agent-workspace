/**
 * Differential conformance for the `release` family, application side (issues #615 and #619): the
 * rollback and promotion-gate scenarios of `formal/AgentWorkspace/Concepts/Release.lean` replayed
 * against the real `decideRollback` and `decidePromote` (`server/agent-versions/release.ts`).
 *
 * Each scenario's `ops` are folded through a reducer that keeps what the store keeps — the version
 * count, each environment's pointer and its history, newest first — and asks the real decisions
 * which move to make. After every step the pointer, the history and the problem must equal the
 * model's. A `point` is `PUT /pointers`, which decides as a promote of an explicit version. Only a
 * move of `production` is gated, as the model's `gateFor` is. The model's scores and bar are whole
 * percentages, so a score `s` replays as `s` of 100 cases passed and the bar as `bar / 100`;
 * `recordEval` keeps each version's latest score, as the store's newest evaluation is the one read.
 * The vector checks and the scenario pin are `tests/formal/release.test.ts`.
 */
import { describe, expect, it } from 'vitest';

import {
  decidePromote,
  decideRollback,
  type LatestEvaluation,
} from '../server/agent-versions/release';
import { asRecord, asString, loadVectors } from '../../../tests/formal/vectors';

/** The scenarios `docs/formal/domains/release.md` assigns to `decidePromote` and `decideRollback`. */
const REPLAYED = [
  'promote-without-a-bar-needs-no-evaluation',
  'promote-passes-the-gate',
  'promote-without-a-score-is-not-evaluated',
  'promote-below-the-bar-fails-the-gate',
  'point-production-passes-the-gate-too',
  'point-at-a-missing-version-is-refused',
  'promote-then-rollback-is-identity',
  'rollback-twice-steps-back-twice',
  'rollback-needs-a-previous-version',
];

const vectors = loadVectors('release', 'steps.json').filter(({ id }) => REPLAYED.includes(id));

type Environment = 'local' | 'production';
interface State {
  versions: number;
  pointer: Record<Environment, number | null>;
  history: Record<Environment, number[]>;
  /** Each version's latest score, out of 100. */
  scores: Map<number, number>;
}

/** The model's refusal codes, by the problem code the server answers. */
const MODEL_PROBLEM: Readonly<Record<string, string>> = {
  agent_version_not_found: 'version_not_found',
  no_pointer: 'no_pointer',
  nothing_to_roll_back: 'nothing_to_roll_back',
  promotion_not_evaluated: 'promotion_not_evaluated',
  promotion_gate_failed: 'promotion_gate_failed',
};

function environmentOf(value: unknown, what: string): Environment {
  const name = asString(value, what);
  if (name !== 'local' && name !== 'production') throw new Error(`${what}: ${name}`);
  return name;
}

function numberOf(value: unknown, what: string): number {
  if (typeof value !== 'number') throw new Error(`${what} must be a number`);
  return value;
}

/** Apply one op under `bar` (out of 100); answer the model's problem code, or `null` after a move. */
function step(
  state: State,
  bar: number | null,
  op: Record<string, unknown>,
  what: string,
): string | null {
  const exists = (number: number): boolean => number >= 1 && number <= state.versions;
  const gate = (environment: Environment) => ({
    bar: environment === 'production' && bar !== null ? bar / 100 : null,
    evaluationOf: (number: number): LatestEvaluation | null => {
      const score = state.scores.get(number);
      return score === undefined
        ? null
        : { score: score / 100, passed: score, total: 100, failing: [] };
    },
  });
  const move = (environment: Environment, to: number): null => {
    state.pointer[environment] = to;
    state.history[environment].unshift(to);
    return null;
  };
  switch (asString(op['op'], `${what}.op`)) {
    case 'push':
      state.versions += 1;
      return null;
    case 'recordEval': {
      const version = numberOf(op['version'], `${what}.version`);
      if (!exists(version)) return 'version_not_found';
      state.scores.set(version, numberOf(op['score'], `${what}.score`));
      return null;
    }
    case 'point': {
      const environment = environmentOf(op['env'], `${what}.env`);
      const decision = decidePromote({
        requested: numberOf(op['version'], `${what}.version`),
        source: null,
        exists,
        ...gate(environment),
      });
      if ('problem' in decision) return MODEL_PROBLEM[decision.problem] ?? decision.problem;
      return move(environment, decision.to);
    }
    case 'promote': {
      const environment = environmentOf(op['to'], `${what}.to`);
      const decision = decidePromote({
        requested: undefined,
        source: state.pointer[environmentOf(op['from'], `${what}.from`)],
        exists,
        ...gate(environment),
      });
      if ('problem' in decision) return MODEL_PROBLEM[decision.problem] ?? decision.problem;
      return move(environment, decision.to);
    }
    case 'rollback': {
      const environment = environmentOf(op['env'], `${what}.env`);
      const decision = decideRollback(state.history[environment]);
      if ('problem' in decision) return MODEL_PROBLEM[decision.problem] ?? decision.problem;
      // The model's `dropPointer`: the version left comes off, and the next entry is the pointer.
      state.history[environment].shift();
      state.pointer[environment] = decision.to;
      return null;
    }
    default:
      throw new Error(`${what}: an op this replay does not model`);
  }
}

describe('release: decideRollback and decidePromote replay the model (80-08, 80-12)', () => {
  it('replays exactly the scenarios docs/formal/domains/release.md assigns to 80-08 and 80-12', () => {
    expect(vectors.map(({ id }) => id)).toStrictEqual(REPLAYED);
  });

  it.each(vectors)('$id', ({ id, input, expected }) => {
    const ops = asRecord(input, id)['ops'];
    const bar = asRecord(input, id)['bar'];
    if (bar !== null && typeof bar !== 'number') throw new Error(`${id}: bar`);
    const steps = asRecord(expected, id)['steps'];
    if (!Array.isArray(ops) || !Array.isArray(steps)) throw new Error(`${id}: ops and steps`);
    const state: State = {
      versions: 0,
      pointer: { local: null, production: null },
      history: { local: [], production: [] },
      scores: new Map(),
    };
    ops.forEach((op: unknown, index) => {
      const what = `${id}.ops[${String(index)}]`;
      const problem = step(state, bar, asRecord(op, what), what);
      const want = asRecord(steps[index], `${id}.steps[${String(index)}]`);
      expect(problem, `${what}: problem`).toBe(want['problem']);
      const modelState = asRecord(want['state'], `${what}.state`);
      expect(state.versions, `${what}: versions`).toBe(modelState['versions']);
      expect(state.pointer, `${what}: pointer`).toStrictEqual(modelState['pointer']);
      expect(state.history, `${what}: history`).toStrictEqual(modelState['history']);
    });
  });
});
