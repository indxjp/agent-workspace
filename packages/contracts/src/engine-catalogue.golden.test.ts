import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { AgentPolicySchema } from './agents.js';
import input from './__golden__/agent-policy.input.schema.json' with { type: 'json' };
import output from './__golden__/agent-policy.output.schema.json' with { type: 'json' };

const GOLDEN = { input, output } as const;

// The golden files were captured before AgentPolicySchema was built from the engine catalogue
// (ADR-0136). Comparing the compact serialisation also pins key order, which is the wire order.
describe('AgentPolicySchema JSON Schema', () => {
  it.each(['input', 'output'] as const)('is unchanged for io: %s', (io) => {
    const schema = z.toJSONSchema(AgentPolicySchema, { target: 'draft-2020-12', io });

    expect(JSON.stringify(schema)).toBe(JSON.stringify(GOLDEN[io]));
  });
});
