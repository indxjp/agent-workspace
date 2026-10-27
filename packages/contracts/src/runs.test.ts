import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { AGENT_VERSION_NUMBER_MAX } from './agent-versions.js';
import {
  InterruptRunResponseSchema,
  MAX_PROMPT_CHARS,
  MAX_RUN_ATTACHMENTS,
  MAX_RUN_FILE_SCOPE_PATHS,
  OUTPUT_SCHEMA_DIALECT,
  OUTPUT_SCHEMA_MAX_BYTES,
  OUTPUT_SCHEMA_MAX_DEPTH,
  OUTPUT_SCHEMA_UNSATISFIED,
  OUTPUT_SCHEMA_UNSATISFIED_MESSAGE,
  RUN_IDEMPOTENCY_PROBLEM_CODES,
  RUN_START_PROBLEM_CODES,
  RUN_LIST_MAX_LIMIT,
  RUN_PREPARATION_FAILED,
  RUN_FILE_CORRUPT,
  RUNTIME_CAPACITY_EXHAUSTED,
  RevokeRunTokensResponseSchema,
  RunApprovalRequestSchema,
  RunApprovalResponseSchema,
  RunListResponseSchema,
  RunResourceSchema,
  StartRunRequestSchema,
  StartRunResponseSchema,
  isRunStartProblemCode,
  isStoppedRunStatus,
  isTerminalRunStatus,
  outputSchemaViolation,
  parseRunFailure,
  runListSearchParams,
} from './runs.js';

const AGENT = '11111111-1111-4111-8111-111111111111';
const CONNECTION = '22222222-2222-4222-8222-222222222222';

const run = {
  id: '33333333-3333-4333-8333-333333333333',
  workspaceId: '44444444-4444-4444-8444-444444444444',
  agentId: AGENT,
  projectId: null,
  initiatingUserId: null,
  sessionId: '55555555-5555-4555-8555-555555555555',
  agentVersion: null,
  status: 'queued',
  createdAt: '2026-09-21T10:00:00.000Z',
  startedAt: null,
  endedAt: null,
  durationMs: null,
  model: null,
  provider: null,
  modelConnectionId: null,
  engine: 'claude-agent-sdk',
  engineVersion: null,
  usage: {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    totalTokens: 0,
    toolCalls: 0,
  },
  cost: { amount: '0.000000', currency: 'USD', priceTableVersion: null },
  error: null,
  output: null,
  accountingState: 'pending',
  accountingError: null,
  pendingApproval: null,
};

describe('RunResourceSchema', () => {
  it('accepts a freshly queued run and a settled one', () => {
    expect(RunResourceSchema.safeParse(run).success).toBe(true);
    expect(
      RunResourceSchema.safeParse({
        ...run,
        status: 'completed',
        startedAt: '2026-09-21T10:00:01.000Z',
        endedAt: '2026-09-21T10:00:05.000Z',
        durationMs: 4000,
        model: 'claude-sonnet-5',
        provider: 'anthropic',
        modelConnectionId: CONNECTION,
        engineVersion: 'claude-agent-sdk@0.3.278',
        accountingState: 'complete',
      }).success,
    ).toBe(true);
  });

  it('rejects an unknown status, an unknown key, and a missing usage block', () => {
    expect(RunResourceSchema.safeParse({ ...run, status: 'paused' }).success).toBe(false);
    expect(RunResourceSchema.safeParse({ ...run, extra: true }).success).toBe(false);
    const withoutUsage = Object.fromEntries(Object.entries(run).filter(([key]) => key !== 'usage'));
    expect(RunResourceSchema.safeParse(withoutUsage).success).toBe(false);
  });

  it('names the agent version the run executed, or null for a legacy session', () => {
    expect(RunResourceSchema.safeParse({ ...run, agentVersion: 3 }).success).toBe(true);
    expect(RunResourceSchema.safeParse({ ...run, agentVersion: null }).success).toBe(true);
    expect(RunResourceSchema.safeParse({ ...run, agentVersion: 0 }).success).toBe(false);
    expect(RunResourceSchema.safeParse({ ...run, agentVersion: 1.5 }).success).toBe(false);
    const withoutVersion = Object.fromEntries(
      Object.entries(run).filter(([key]) => key !== 'agentVersion'),
    );
    expect(RunResourceSchema.safeParse(withoutVersion).success).toBe(false);
  });

  it('rejects a negative token count and an epoch-number timestamp', () => {
    expect(
      RunResourceSchema.safeParse({ ...run, usage: { ...run.usage, inputTokens: -1 } }).success,
    ).toBe(false);
    expect(RunResourceSchema.safeParse({ ...run, createdAt: 1_700_000_000 }).success).toBe(false);
  });
});

describe('StartRunRequestSchema', () => {
  it('accepts a bare prompt and a full override', () => {
    expect(StartRunRequestSchema.safeParse({ prompt: 'hello' }).success).toBe(true);
    expect(
      StartRunRequestSchema.safeParse({
        prompt: 'hello',
        sessionId: null,
        modelConnectionId: CONNECTION,
        model: 'claude-sonnet-5',
      }).success,
    ).toBe(true);
  });

  it('refuses a blank prompt, an oversized prompt, and an unknown key', () => {
    expect(StartRunRequestSchema.safeParse({ prompt: '   ' }).success).toBe(false);
    expect(
      StartRunRequestSchema.safeParse({ prompt: 'x'.repeat(MAX_PROMPT_CHARS + 1) }).success,
    ).toBe(false);
    expect(StartRunRequestSchema.safeParse({ prompt: 'hi', temperature: 1 }).success).toBe(false);
  });

  it('refuses a connection without a model and a model without a connection', () => {
    expect(
      StartRunRequestSchema.safeParse({ prompt: 'hi', modelConnectionId: CONNECTION }).success,
    ).toBe(false);
    expect(StartRunRequestSchema.safeParse({ prompt: 'hi', model: 'm' }).success).toBe(false);
  });

  it('accepts a version number on a new session and refuses a bad one (issue #697)', () => {
    expect(StartRunRequestSchema.parse({ prompt: 'hi', version: 2 }).version).toBe(2);
    for (const version of [0, -1, 1.5, '2', 2_147_483_648]) {
      expect(StartRunRequestSchema.safeParse({ prompt: 'hi', version }).success).toBe(false);
    }
  });

  it('refuses a version together with a session id', () => {
    const body = { prompt: 'hi', version: 2 };
    expect(StartRunRequestSchema.safeParse({ ...body, sessionId: CONNECTION }).success).toBe(false);
    expect(StartRunRequestSchema.safeParse({ ...body, sessionId: null }).success).toBe(true);
  });

  it('accepts one to ten attachments and refuses none, eleven, a repeat, or a malformed item', () => {
    const attach = (attachments: unknown): boolean =>
      StartRunRequestSchema.safeParse({ prompt: 'hi', attachments }).success;
    const ids = (count: number): { fileId: string }[] =>
      Array.from({ length: count }, (_, index) => ({ fileId: `file-${index}` }));
    expect(attach(ids(1))).toBe(true);
    expect(attach(ids(MAX_RUN_ATTACHMENTS))).toBe(true);
    expect(attach([])).toBe(false);
    expect(attach(ids(MAX_RUN_ATTACHMENTS + 1))).toBe(false);
    expect(attach([{ fileId: 'a' }, { fileId: 'a' }])).toBe(false);
    expect(attach([{ fileId: 'a', access: 'write' }])).toBe(false);
    expect(attach([{ fileId: '' }])).toBe(false);
    expect(attach([{}])).toBe(false);
    expect(attach('a')).toBe(false);
    expect(attach(null)).toBe(false);
  });

  it('accepts a subject of 1 to 256 characters and refuses an empty, long or non-string one', () => {
    for (const subject of ['a', 'x'.repeat(256)]) {
      expect(StartRunRequestSchema.parse({ prompt: 'hi', subject }).subject).toBe(subject);
    }
    for (const subject of ['', 'x'.repeat(257), 7, null]) {
      expect(StartRunRequestSchema.safeParse({ prompt: 'hi', subject }).success).toBe(false);
    }
  });

  it('accepts one to 100 canonical fileScope paths and refuses the rest (issue #1539)', () => {
    const scope = (fileScope: unknown): boolean =>
      StartRunRequestSchema.safeParse({ prompt: 'hi', fileScope }).success;
    const paths = (count: number): string[] =>
      Array.from({ length: count }, (_, index) => `docs/p-${index}.md`);
    expect(scope(['docs/alice'])).toBe(true);
    expect(scope(paths(MAX_RUN_FILE_SCOPE_PATHS))).toBe(true);
    expect(scope([])).toBe(false);
    expect(scope(paths(MAX_RUN_FILE_SCOPE_PATHS + 1))).toBe(false);
    expect(scope(['a', 'a'])).toBe(false);
    for (const bad of ['/a', 'a/', 'a/../b', 'a//b', '', './a', 'a\\b', 'a\0b', 'x'.repeat(1025)]) {
      expect(scope([bad])).toBe(false);
    }
    expect(scope('docs')).toBe(false);
    expect(scope([7])).toBe(false);
    expect(scope(null)).toBe(false);
  });

  it('refuses a session id that is not a UUID', () => {
    expect(StartRunRequestSchema.safeParse({ prompt: 'hi', sessionId: 'latest' }).success).toBe(
      false,
    );
  });
});

describe('response envelopes', () => {
  it('reads the 202 and the list page', () => {
    expect(
      StartRunResponseSchema.safeParse({ run, events: `/api/runs/${run.id}/events` }).success,
    ).toBe(true);
    expect(RunListResponseSchema.safeParse({ runs: [run], nextCursor: null }).success).toBe(true);
    expect(RunListResponseSchema.safeParse({ runs: [run] }).success).toBe(false);
  });
});

describe('InterruptRunResponseSchema', () => {
  it('accepts the run with its new status, and refuses an unknown key or a missing field', () => {
    expect(
      InterruptRunResponseSchema.safeParse({ run: { ...run, status: 'cancelled' } }).success,
    ).toBe(true);
    expect(InterruptRunResponseSchema.safeParse({}).success).toBe(false);
    expect(InterruptRunResponseSchema.safeParse({ run, extra: 1 }).success).toBe(false);
  });
});

describe('RevokeRunTokensResponseSchema', () => {
  it('accepts every outcome the repository reports', () => {
    for (const outcome of ['revoked', 'already-revoked', 'not-found'] as const) {
      expect(RevokeRunTokensResponseSchema.safeParse({ revoked: 1, outcome }).success).toBe(true);
    }
    expect(
      RevokeRunTokensResponseSchema.safeParse({ revoked: 0, outcome: 'already-revoked' }).success,
    ).toBe(true);
  });

  it('rejects a negative count, an unknown outcome, an unknown key, and a missing field', () => {
    expect(
      RevokeRunTokensResponseSchema.safeParse({ revoked: -1, outcome: 'revoked' }).success,
    ).toBe(false);
    expect(
      RevokeRunTokensResponseSchema.safeParse({ revoked: 1, outcome: 'pending' }).success,
    ).toBe(false);
    expect(
      RevokeRunTokensResponseSchema.safeParse({ revoked: 1, outcome: 'revoked', extra: 1 }).success,
    ).toBe(false);
    expect(RevokeRunTokensResponseSchema.safeParse({ revoked: 1 }).success).toBe(false);
  });
});

describe('runListSearchParams', () => {
  it('renders only the fields that were given, as the route spells them', () => {
    const params = runListSearchParams({ status: 'failed', agent: AGENT, limit: 50 });
    expect([...params.entries()]).toEqual([
      ['status', 'failed'],
      ['agent', AGENT],
      ['limit', '50'],
    ]);
    expect(runListSearchParams({}).toString()).toBe('');
  });

  it('exposes the route bounds for a caller that pages', () => {
    expect(RUN_LIST_MAX_LIMIT).toBe(200);
    expect(isTerminalRunStatus('completed')).toBe(true);
    expect(isTerminalRunStatus('running')).toBe(false);
  });
});

describe('awaiting_approval (ADR-0145)', () => {
  it('is stopped but not terminal', () => {
    expect(isTerminalRunStatus('awaiting_approval')).toBe(false);
    expect(isStoppedRunStatus('awaiting_approval')).toBe(true);
    expect(isStoppedRunStatus('completed')).toBe(true);
    expect(isStoppedRunStatus('running')).toBe(false);
  });

  it('carries the pending call on the run resource', () => {
    const pending = { toolName: 'Bash', canonicalCall: 'Bash {}' };
    expect(
      RunResourceSchema.safeParse({ ...run, status: 'awaiting_approval', pendingApproval: pending })
        .success,
    ).toBe(true);
  });

  it('validates the decision request and its response', () => {
    expect(RunApprovalRequestSchema.safeParse({ decision: 'approve' }).success).toBe(true);
    expect(RunApprovalRequestSchema.safeParse({ decision: 'reject', comment: 'no' }).success).toBe(
      true,
    );
    expect(RunApprovalRequestSchema.safeParse({ decision: 'maybe' }).success).toBe(false);
    expect(RunApprovalRequestSchema.safeParse({ decision: 'approve', extra: 1 }).success).toBe(
      false,
    );
    expect(RunApprovalResponseSchema.safeParse({}).success).toBe(false);
  });
});

describe('RUN_IDEMPOTENCY_PROBLEM_CODES (ADR-0151)', () => {
  it('declares the two refusals an Idempotency-Key can draw, snake_case', () => {
    expect(RUN_IDEMPOTENCY_PROBLEM_CODES).toEqual({
      invalid_idempotency_key: 400,
      run_idempotency_conflict: 409,
    });
  });
});

describe('RUN_START_PROBLEM_CODES (issue #393)', () => {
  it('declares one 422 per missing piece a run start can name, and 403 for the ceiling', () => {
    expect(RUN_START_PROBLEM_CODES).toEqual({
      agent_runtime_profile_missing: 422,
      model_connection_unresolved: 422,
      model_connection_failed: 422,
      model_unavailable: 422,
      model_credential_rejected: 422,
      network_policy_unenforceable: 422,
      run_deadline_exceeds_host: 422,
      runtime_connection_missing: 422,
      runtime_connection_credential_unavailable: 422,
      runtime_not_verified: 422,
      run_attachments_unreadable: 422,
      run_attachments_too_large: 422,
      run_attachments_unsupported_runtime: 422,
      run_attachments_untranscribable: 422,
      run_files_too_large: 422,
      run_storage_grant_unavailable: 422,
      run_subject_forbidden: 403,
      run_file_scope_not_granted: 403,
      policy_cannot_widen: 403,
      daily_cost_cap_reached: 429,
      daily_cost_unavailable: 503,
      builder_model_unavailable: 503,
    });
    // Issue #1539: a widening fileScope fails the run at launch with a coded refusal.
    expect(isRunStartProblemCode('run_file_scope_not_granted')).toBe(true);
    // ADR-0146 Decision 4 (issue #1307): attachments on an agent that cannot read files.
    expect(isRunStartProblemCode('run_attachments_unreadable')).toBe(true);
    expect(isRunStartProblemCode('run_attachments_too_large')).toBe(true);
    expect(isRunStartProblemCode('run_attachments_unsupported_runtime')).toBe(true);
    // Issue #1313: audio on a connection whose provider cannot transcribe it.
    expect(isRunStartProblemCode('run_attachments_untranscribable')).toBe(true);
    // BH061-002: a lapsed Test Runtime pass is a coded refusal, not an opaque preparation failure.
    expect(isRunStartProblemCode('runtime_not_verified')).toBe(true);
    // Issue #785: a lowered `open` the driver cannot enforce is a coded refusal.
    expect(isRunStartProblemCode('network_policy_unenforceable')).toBe(true);
    // Issue #830 (ADR-0120 LC7): a profile deadline longer than the host's function is refused.
    expect(isRunStartProblemCode('run_deadline_exceeds_host')).toBe(true);
    // ADR-0120 LC6: a provider run without a usable runtime connection is a coded refusal.
    expect(isRunStartProblemCode('runtime_connection_missing')).toBe(true);
    expect(isRunStartProblemCode('runtime_connection_credential_unavailable')).toBe(true);
    // Issue #524 (C14): the ceiling refusal is a run-start code.
    expect(isRunStartProblemCode('policy_cannot_widen')).toBe(true);
    // PR #403 review: nothing refuses a start because a model list could not be read.
    expect(isRunStartProblemCode('model_discovery_failed')).toBe(false);
    expect(isRunStartProblemCode('agent_runtime_profile_missing')).toBe(true);
    expect(isRunStartProblemCode('internal_error')).toBe(false);
  });
});

describe('parseRunFailure', () => {
  it('reads the runtime-connection codes back from a coded run error', () => {
    expect(parseRunFailure('runtime_connection_missing: attach a runtime connection.')).toEqual({
      code: 'runtime_connection_missing',
      message: 'attach a runtime connection.',
    });
    expect(
      parseRunFailure('runtime_connection_credential_unavailable: replace the credential.'),
    ).toEqual({
      code: 'runtime_connection_credential_unavailable',
      message: 'replace the credential.',
    });
  });

  it('reads the code back from a coded run error', () => {
    expect(
      parseRunFailure('model_connection_unresolved: no workspace default is configured.'),
    ).toEqual({
      code: 'model_connection_unresolved',
      message: 'no workspace default is configured.',
    });
    expect(parseRunFailure('model_connection_failed: connection refused.')).toEqual({
      code: 'model_connection_failed',
      message: 'connection refused.',
    });
    expect(parseRunFailure('engine_model_protocol_unsupported: speaks nothing')).toEqual({
      code: 'engine_model_protocol_unsupported',
      message: 'speaks nothing',
    });
  });

  it('reads policy_cannot_widen back from a run refused at compose (issue #524)', () => {
    expect(parseRunFailure('policy_cannot_widen: engine:pi')).toEqual({
      code: 'policy_cannot_widen',
      message: 'engine:pi',
    });
  });

  it('keeps an uncoded or unknown-coded error whole, with no code', () => {
    expect(parseRunFailure('The run request could not be prepared.')).toEqual({
      code: null,
      message: 'The run request could not be prepared.',
    });
    expect(parseRunFailure('made_up: text')).toEqual({ code: null, message: 'made_up: text' });
    expect(parseRunFailure(null)).toBeNull();
  });

  it('reads the run-preparation code, which is not a start refusal (issue #827)', () => {
    expect(RUN_PREPARATION_FAILED).toBe('run_preparation_failed');
    expect(
      parseRunFailure(
        `${RUN_PREPARATION_FAILED}: The run request could not be prepared at the tools step (Error).`,
      ),
    ).toEqual({
      code: 'run_preparation_failed',
      message: 'The run request could not be prepared at the tools step (Error).',
    });
    expect(isRunStartProblemCode(RUN_PREPARATION_FAILED)).toBe(false);
  });

  it('reads the retryable runtime-capacity code, which is not a start refusal (issue #557)', () => {
    expect(RUNTIME_CAPACITY_EXHAUSTED).toBe('runtime_capacity_exhausted');
    expect(parseRunFailure(`${RUNTIME_CAPACITY_EXHAUSTED}: send the message again.`)).toEqual({
      code: 'runtime_capacity_exhausted',
      message: 'send the message again.',
    });
    expect(isRunStartProblemCode(RUNTIME_CAPACITY_EXHAUSTED)).toBe(false);
    // The storage design, §04: a stored file whose bytes no longer match its row.
    expect(parseRunFailure(`${RUN_FILE_CORRUPT}: a granted file is corrupt.`)).toEqual({
      code: 'run_file_corrupt',
      message: 'a granted file is corrupt.',
    });
    expect(isRunStartProblemCode(RUN_FILE_CORRUPT)).toBe(false);
    expect(parseRunFailure('runner_capacity_exhausted: busy')).toEqual({
      code: null,
      message: 'runner_capacity_exhausted: busy',
    });
  });
});

describe('StartRunRequestSchema version range', () => {
  it('matches AgentVersionResource.number (the inlined max has not drifted)', () => {
    const accepts = (version: number): boolean =>
      StartRunRequestSchema.safeParse({ prompt: 'hi', version }).success;
    expect(accepts(AGENT_VERSION_NUMBER_MAX)).toBe(true);
    expect(accepts(AGENT_VERSION_NUMBER_MAX + 1)).toBe(false);
  });
});

describe('RunResourceSchema.output (ADR-0143)', () => {
  it('requires the key and accepts null or an answer with its structured value', () => {
    const withoutOutput: Record<string, unknown> = { ...run };
    delete withoutOutput['output'];
    expect(RunResourceSchema.safeParse(withoutOutput).success).toBe(false);
    expect(RunResourceSchema.safeParse({ ...run, output: null }).success).toBe(true);
    const answered = RunResourceSchema.safeParse({
      ...run,
      status: 'completed',
      output: { text: 'done', structured: { total: 3 } },
    });
    expect(answered.success).toBe(true);
    expect(
      RunResourceSchema.safeParse({ ...run, output: { text: 'done', structured: null } }).success,
    ).toBe(true);
  });

  it('rejects an unknown key inside output and a missing text', () => {
    expect(
      RunResourceSchema.safeParse({ ...run, output: { text: 'a', structured: 1, extra: 1 } })
        .success,
    ).toBe(false);
    expect(RunResourceSchema.safeParse({ ...run, output: { structured: 1 } }).success).toBe(false);
  });
});

describe('outputSchema limits (ADR-0143)', () => {
  const valid = { type: 'object', properties: { total: { type: 'number' } } };
  const limitOf = (schema: unknown): string | undefined => outputSchemaViolation(schema)?.limit;

  function nested(
    levels: number,
    leaf: Record<string, unknown> = { type: 'string' },
  ): Record<string, unknown> {
    let schema = leaf;
    for (let level = 1; level < levels; level += 1) {
      schema = { type: 'object', properties: { next: schema } };
    }
    return schema;
  }

  it('accepts a plain schema, a 2020-12 declaration, local $defs and a z.toJSONSchema output', () => {
    expect(outputSchemaViolation(valid)).toBeNull();
    expect(outputSchemaViolation({ ...valid, $schema: OUTPUT_SCHEMA_DIALECT })).toBeNull();
    expect(
      outputSchemaViolation({
        type: 'object',
        properties: { line: { $ref: '#/$defs/line' } },
        $defs: { line: { type: 'object', properties: { sku: { type: 'string' } } } },
      }),
    ).toBeNull();
    const generated = z.toJSONSchema(
      z.object({
        email: z.email(),
        id: z.uuid(),
        at: z.iso.datetime(),
        code: z.string().regex(/^A/u),
      }),
      { target: 'draft-2020-12' },
    );
    expect(generated['type']).toBe('object');
    expect(outputSchemaViolation(generated)).toBeNull();
  });

  it('refuses a root that is not an object schema (root_type)', () => {
    expect(limitOf({ type: 'string' })).toBe('root_type');
    expect(limitOf({ properties: {} })).toBe('root_type');
    expect(limitOf({ type: ['object', 'null'] })).toBe('root_type');
    expect(limitOf([])).toBe('root_type');
    expect(limitOf(null)).toBe('root_type');
    expect(outputSchemaViolation({ type: 'array' })?.message.startsWith('root_type:')).toBe(true);
  });

  it('refuses a schema over 32 KiB and accepts one exactly at the bound (size)', () => {
    const at = (bytes: number): Record<string, unknown> => {
      const base = { type: 'object', description: '' };
      const overhead = new TextEncoder().encode(JSON.stringify(base)).length;
      return { ...base, description: 'x'.repeat(bytes - overhead) };
    };
    expect(outputSchemaViolation(at(OUTPUT_SCHEMA_MAX_BYTES))).toBeNull();
    expect(limitOf(at(OUTPUT_SCHEMA_MAX_BYTES + 1))).toBe('size');
    expect(limitOf({ type: 'object', n: 1n })).toBe('size');
  });

  it('counts bytes, not characters', () => {
    const wide = { type: 'object', description: 'あ'.repeat(OUTPUT_SCHEMA_MAX_BYTES / 3) };
    expect(limitOf(wide)).toBe('size');
  });

  it('refuses another dialect (dialect)', () => {
    expect(limitOf({ ...valid, $schema: 'http://json-schema.org/draft-07/schema#' })).toBe(
      'dialect',
    );
  });

  it('refuses a remote, unresolved or non-$defs $ref and any $dynamicRef (ref)', () => {
    const withRef = (ref: unknown): unknown => ({
      type: 'object',
      properties: { a: { $ref: ref } },
      $defs: { known: { type: 'string' } },
    });
    expect(limitOf(withRef('https://example.com/schema.json'))).toBe('ref');
    expect(limitOf(withRef('#/properties/other'))).toBe('ref');
    expect(limitOf(withRef('#'))).toBe('ref');
    expect(limitOf(withRef('#/$defs/missing'))).toBe('ref');
    expect(limitOf(withRef('#/$defs/known/extra'))).toBe('ref');
    expect(limitOf(withRef(7))).toBe('ref');
    expect(outputSchemaViolation(withRef('#/$defs/known'))).toBeNull();
    expect(limitOf({ type: 'object', properties: { a: { $dynamicRef: '#node' } } })).toBe('ref');
  });

  it('does not read $ref text inside const, enum or default data', () => {
    expect(
      outputSchemaViolation({
        type: 'object',
        properties: { a: { const: { $ref: 'https://example.com' } } },
        default: { $ref: 'x' },
      }),
    ).toBeNull();
  });

  it('allows 16 nested levels and refuses 17 (depth)', () => {
    expect(outputSchemaViolation(nested(OUTPUT_SCHEMA_MAX_DEPTH))).toBeNull();
    expect(limitOf(nested(OUTPUT_SCHEMA_MAX_DEPTH + 1))).toBe('depth');
    expect(
      limitOf({
        type: 'object',
        properties: {
          a: { items: { anyOf: [nested(OUTPUT_SCHEMA_MAX_DEPTH - 2)] } },
        },
      }),
    ).toBe('depth');
  });

  it('refuses a recursive $ref, directly or through another definition (ref)', () => {
    expect(
      limitOf({
        type: 'object',
        properties: { root: { $ref: '#/$defs/node' } },
        $defs: {
          node: { type: 'object', properties: { children: { items: { $ref: '#/$defs/node' } } } },
        },
      }),
    ).toBe('ref');
    expect(limitOf({ type: 'object', $defs: { a: { $ref: '#/$defs/a' } } })).toBe('ref');
    expect(
      limitOf({
        type: 'object',
        properties: { a: { $ref: '#/$defs/a' } },
        $defs: {
          a: { type: 'object', properties: { b: { $ref: '#/$defs/b' } } },
          b: { anyOf: [{ $ref: '#/$defs/a' }] },
        },
      }),
    ).toBe('ref');
  });

  it('measures a referenced definition at the level that uses it (depth)', () => {
    // The root is level 1, `a` stands at level 2 and reaches its reference at level 9, so `b`
    // starts at level 9: 8 levels of `b` end at 16, 9 levels end at 17.
    const chain = (levelsOfB: number): unknown => ({
      type: 'object',
      properties: { a: { $ref: '#/$defs/a' } },
      $defs: { a: nested(8, { $ref: '#/$defs/b' }), b: nested(levelsOfB) },
    });
    expect(outputSchemaViolation(chain(8))).toBeNull();
    expect(limitOf(chain(9))).toBe('depth');
  });

  it('accepts a definition shared by several references', () => {
    const line = { type: 'object', properties: { sku: { type: 'string' } } };
    expect(
      outputSchemaViolation({
        type: 'object',
        properties: {
          first: { $ref: '#/$defs/line' },
          rest: { type: 'array', items: { $ref: '#/$defs/line' } },
          pair: { allOf: [{ $ref: '#/$defs/line' }, { $ref: '#/$defs/line' }] },
        },
        $defs: { line },
      }),
    ).toBeNull();
  });

  it('follows a definition shared by many references only once per level', () => {
    // 15 definitions, each referencing the next 64 times: walking every reference would take
    // 64^14 steps.
    const defs: Record<string, unknown> = { d14: { type: 'string' } };
    for (let index = 13; index >= 0; index -= 1) {
      defs[`d${index}`] = {
        anyOf: Array.from({ length: 64 }, () => ({ $ref: `#/$defs/d${index + 1}` })),
      };
    }
    expect(
      outputSchemaViolation({
        type: 'object',
        properties: { a: { $ref: '#/$defs/d0' } },
        $defs: defs,
      }),
    ).toBeNull();
  });

  it('is applied by StartRunRequestSchema, naming the limit', () => {
    expect(StartRunRequestSchema.safeParse({ prompt: 'go', outputSchema: valid }).success).toBe(
      true,
    );
    for (const [schema, limit] of [
      [{ type: 'string' }, 'root_type'],
      [{ ...valid, $schema: 'https://example.com/other' }, 'dialect'],
      [{ ...valid, properties: { a: { $ref: 'https://example.com/a' } } }, 'ref'],
      [nested(OUTPUT_SCHEMA_MAX_DEPTH + 1), 'depth'],
      [{ type: 'object', description: 'x'.repeat(OUTPUT_SCHEMA_MAX_BYTES) }, 'size'],
    ] as const) {
      const parsed = StartRunRequestSchema.safeParse({ prompt: 'go', outputSchema: schema });
      expect(parsed.success).toBe(false);
      expect(parsed.error?.issues[0]?.message.startsWith(`${limit}:`)).toBe(true);
    }
    expect(StartRunRequestSchema.safeParse({ prompt: 'go', outputSchema: [] }).success).toBe(false);
  });

  it('still refuses an unknown key beside outputSchema', () => {
    expect(
      StartRunRequestSchema.safeParse({ prompt: 'go', outputSchema: valid, schema: valid }).success,
    ).toBe(false);
  });
});

describe('parseRunFailure output_schema_unsatisfied (ADR-0143)', () => {
  it('reads the code back without matching prose', () => {
    expect(
      parseRunFailure(`${OUTPUT_SCHEMA_UNSATISFIED}: ${OUTPUT_SCHEMA_UNSATISFIED_MESSAGE}`),
    ).toEqual({ code: 'output_schema_unsatisfied', message: OUTPUT_SCHEMA_UNSATISFIED_MESSAGE });
  });
});
