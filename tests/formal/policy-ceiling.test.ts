/**
 * The `policy-ceiling` vectors, replayed against the contracts' `policyWidenings` and
 * `meetPolicyCeiling` (S2-04b, issue #535, ADR-0102 SD6, C14).
 *
 * Every write path and the compose step judge the ceiling through these two functions, so a
 * disagreement with `formal/AgentWorkspace/Concepts/PolicyCeiling.lean` is a failing test, and the
 * fix is never to edit a vector (`docs/formal/00-orchestrator-prompt.md` §10).
 */
import { AgentPermissionsSchema, AgentPolicyLimitsSchema } from '@indx-workspace/contracts/agents';
import { EngineIdSchema } from '@indx-workspace/contracts/engines';
import {
  type EffectivePolicyConfiguration,
  meetPolicyCeiling,
  policyWidenings,
  ProjectPolicySchema,
  type ProjectPolicy,
} from '@indx-workspace/contracts/policy-ceiling';
import { describe, expect, it } from 'vitest';

import { asRecord, asString, loadVectors } from './vectors.js';

const FAMILY = 'policy-ceiling';

function effectiveOf(value: unknown, what: string): EffectivePolicyConfiguration {
  const record = asRecord(value, what);
  const { model, tools } = record;
  if (!Array.isArray(tools)) throw new Error(`${what}: tools must be an array`);
  return {
    permissions: AgentPermissionsSchema.parse(record['permissions']),
    limits: AgentPolicyLimitsSchema.parse(record['limits']),
    engine: EngineIdSchema.parse(record['engine']),
    model: model === null ? null : asString(model, `${what}.model`),
    tools: tools.map((tool, index) => asString(tool, `${what}.tools[${String(index)}]`)),
  };
}

function ceilingOf(value: unknown): ProjectPolicy | null {
  // Every vector ceiling must be a policy the contracts accept, so a vector cannot test a shape
  // no deployment could configure.
  return value === null ? null : ProjectPolicySchema.parse(value);
}

describe('policy-ceiling: policyWidenings', () => {
  const vectors = loadVectors(FAMILY, 'violations.json');

  it.each(vectors)('$id', ({ id, input, expected }) => {
    const request = asRecord(input, id);
    const widenings = policyWidenings(
      effectiveOf(request['effective'], id),
      ceilingOf(request['ceiling']),
    );
    expect(widenings).toStrictEqual(asRecord(expected, id)['widenings']);
  });

  it('replayed every field at once and a null limit', () => {
    const ids = vectors.map((vector) => vector.id);
    expect(ids).toContain('all-fields');
    expect(ids).toContain('null-limit');
  });
});

describe('policy-ceiling: meetPolicyCeiling', () => {
  const vectors = loadVectors(FAMILY, 'meet.json');

  it.each(vectors)('$id', ({ id, input, expected }) => {
    const request = asRecord(input, id);
    const met = meetPolicyCeiling(
      effectiveOf(request['effective'], id),
      ceilingOf(request['ceiling']),
    );
    expect(met).toStrictEqual(effectiveOf(asRecord(expected, id)['meet'], id));
  });

  it('replayed every field at once and a null limit', () => {
    const ids = vectors.map((vector) => vector.id);
    expect(ids).toContain('all-fields');
    expect(ids).toContain('null-limit');
  });
});
