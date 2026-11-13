import { describe, expect, it } from 'vitest';

import { claudeBaseToolPolicyFor } from '@indx-workspace/contracts/agents';
import { ENGINE_IDS } from '@indx-workspace/contracts/engines';

import { defineAgent } from '../define/index.js';
import { toPortableAgent } from './index.js';
import {
  claude,
  openai,
  pi,
  mastra,
  MINIMAL,
  SAMPLE_PERMISSIONS,
} from './convert.fixture.test-support.js';

describe('portableFromAgentVersionBody: policy', () => {
  it('engine: is always carried', () => {
    for (const engine of ENGINE_IDS) {
      expect(toPortableAgent(defineAgent({ ...MINIMAL, engine })).value.engine).toBe(engine);
    }
    expect(toPortableAgent(defineAgent(MINIMAL)).value.engine).toBe(claude);
  });

  it('extensions.engines: a compiled Claude policy gives none', () => {
    expect(toPortableAgent(defineAgent(MINIMAL)).value.extensions).toBeUndefined();
  });

  it('extensions.engines: a stored Claude arm carries its tools verbatim', () => {
    const { value } = toPortableAgent(
      defineAgent({ ...MINIMAL, permissions: SAMPLE_PERMISSIONS, limits: { maxTurns: 3 } }),
    );
    expect(value.extensions).toEqual({
      engines: { [claude]: { tools: claudeBaseToolPolicyFor(SAMPLE_PERMISSIONS) } },
    });
  });

  it('extensions.engines: a stored arm carries its native settings under its engine', () => {
    const agent = defineAgent({ ...MINIMAL, engine: { id: pi, thinkingLevel: 'low' } });
    expect(toPortableAgent(agent).value.extensions).toEqual({
      engines: { [pi]: { thinkingLevel: 'low' } },
    });
    const several = defineAgent({
      ...MINIMAL,
      engine: { id: openai, reasoningEffort: 'high', parallelToolCalls: false },
    });
    expect(toPortableAgent(several).value.extensions).toEqual({
      engines: { [openai]: { reasoningEffort: 'high', parallelToolCalls: false } },
    });
    const concurrent = defineAgent({ ...MINIMAL, engine: { id: mastra, toolCallConcurrency: 4 } });
    expect(toPortableAgent(concurrent).value.extensions).toEqual({
      engines: { [mastra]: { toolCallConcurrency: 4 } },
    });
  });

  it('extensions.engines: a stored arm with no native setting gives none', () => {
    expect(
      toPortableAgent(defineAgent({ ...MINIMAL, engine: pi })).value.extensions,
    ).toBeUndefined();
  });

  it('limits: carries each limit that has a value', () => {
    const both = toPortableAgent(
      defineAgent({ ...MINIMAL, limits: { maxTurns: 5, maxBudgetUsd: 0.25 } }),
    );
    expect(both.value.limits).toEqual({ maxTurns: 5, maxBudgetUsd: 0.25 });
    const one = toPortableAgent(defineAgent({ ...MINIMAL, limits: { maxBudgetUsd: 2 } }));
    expect(one.value.limits).toEqual({ maxBudgetUsd: 2 });
  });

  it('limits: are left out when both are null', () => {
    expect(toPortableAgent(defineAgent(MINIMAL)).value.limits).toBeUndefined();
    expect(toPortableAgent(defineAgent({ ...MINIMAL, limits: {} })).value.limits).toBeUndefined();
  });
});
