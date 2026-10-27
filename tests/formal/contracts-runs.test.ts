import {
  ACCOUNTING_STATES,
  InterruptRunResponseSchema,
  isTerminalRunStatus,
  MAX_PROMPT_CHARS,
  MODEL_PROVIDERS,
  RevokeRunTokensResponseSchema,
  RunApprovalRequestSchema,
  RunApprovalResponseSchema,
  RUN_LIST_DEFAULT_LIMIT,
  RUN_LIST_MAX_LIMIT,
  RUN_STATUSES,
  RunCostSchema,
  RunListResponseSchema,
  RunResourceSchema,
  RunResponseSchema,
  RunUsageSchema,
  StartRunRequestSchema,
  StartRunResponseSchema,
  TERMINAL_RUN_STATUSES,
  runListSearchParams,
} from '@indx-workspace/contracts/runs';
import {
  SessionListResponseSchema,
  SessionResourceSchema,
  SessionResponseSchema,
} from '@indx-workspace/contracts/sessions';
import { describe, expect, it } from 'vitest';

import { asRecord, asString, loadVectors } from './vectors.js';

const vectors = loadVectors('contracts-runs', 'schemas.json');
const queryVectors = loadVectors('contracts-runs', 'query.json');
const schemas = {
  RunUsageSchema,
  RunCostSchema,
  RunResourceSchema,
  StartRunRequestSchema,
  StartRunResponseSchema,
  RunResponseSchema,
  InterruptRunResponseSchema,
  RevokeRunTokensResponseSchema,
  RunApprovalRequestSchema,
  RunApprovalResponseSchema,
  RunListResponseSchema,
  SessionResourceSchema,
  SessionResponseSchema,
  SessionListResponseSchema,
} as const;

function isSchemaName(name: string): name is keyof typeof schemas {
  return Object.hasOwn(schemas, name);
}

describe('contracts-runs: real Zod exports', () => {
  it.each(vectors)('$id', ({ id, input, expected }) => {
    const payload = asRecord(input, id);
    const name = asString(payload['schema'], 'schema');
    if (!isSchemaName(name)) throw new Error(`${id}: unknown schema ${name}`);
    const output = asRecord(expected, id)['output'];
    const parsed = schemas[name].safeParse(payload['body']);
    if (output === null) {
      expect(parsed.success).toBe(false);
    } else {
      expect(parsed.success).toBe(true);
      if (parsed.success) expect(parsed.data).toEqual(output);
    }
  });

  it('pins the enumerations, terminal subset and pagination limits', () => {
    expect(RUN_STATUSES).toEqual([
      'queued',
      'running',
      'awaiting_approval',
      'completed',
      'failed',
      'cancelled',
    ]);
    expect(TERMINAL_RUN_STATUSES).toEqual(['completed', 'failed', 'cancelled']);
    expect(RUN_STATUSES.map(isTerminalRunStatus)).toEqual([false, false, false, true, true, true]);
    expect(MODEL_PROVIDERS).toEqual([
      'anthropic',
      'anthropic-compatible',
      'openai',
      'azure-openai',
      'openai-compatible',
    ]);
    expect(ACCOUNTING_STATES).toEqual(['pending', 'complete', 'partial', 'failed', 'unavailable']);
    expect([MAX_PROMPT_CHARS, RUN_LIST_DEFAULT_LIMIT, RUN_LIST_MAX_LIMIT]).toEqual([
      100_000, 20, 200,
    ]);
  });

  it.each(queryVectors)('query $id', ({ id, input, expected }) => {
    const cases = {
      empty: {},
      sparse: { status: 'running', agent: 'a', limit: 20, cursor: 'x' },
      all: {
        status: 'running',
        agent: 'a',
        project: 'p',
        provider: 'openai',
        model: 'm',
        from: '2026-01-01T00:00:00Z',
        to: '2026-01-02T00:00:00Z',
        user: 'u',
        limit: 200,
        cursor: 'a+/=',
      },
    } as const;
    if (!(id in cases)) throw new Error(`${id}: unknown query case`);
    const selected = queryVectors.find((vector) => vector.id === id);
    expect(selected?.input).toEqual(input);
    const query = id === 'empty' ? cases.empty : id === 'sparse' ? cases.sparse : cases.all;
    expect([...runListSearchParams(query).entries()]).toEqual(expected);
  });
});
