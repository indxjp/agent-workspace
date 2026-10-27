import { describe, expect, it } from 'vitest';

import { MAX_PROMPT_CHARS, OUTPUT_SCHEMA_MAX_DEPTH } from './runs.js';
import {
  CreateTriggerRequestSchema,
  CreateTriggerResponseSchema,
  TRIGGER_MAX_BODY_BYTES,
  TRIGGER_MAX_CONCURRENT_RUNS,
  TRIGGER_PROBLEM_CODES,
  TRIGGER_RATE_PER_MINUTE,
  TriggerListResponseSchema,
  TriggerResourceSchema,
  TriggerSecretResponseSchema,
  UpdateTriggerRequestSchema,
  ZoomUrlValidationEventSchema,
  ZoomUrlValidationResponseSchema,
  findTriggerTemplateError,
  renderTriggerPrompt,
} from './triggers.js';

const AGENT = '11111111-1111-4111-8111-111111111111';
const TRIGGER = '22222222-2222-4222-8222-222222222222';
const OWNER = '33333333-3333-4333-8333-333333333333';

const SCHEMA = { type: 'object', properties: { verdict: { type: 'string' } } };

function nested(levels: number): Record<string, unknown> {
  let schema: Record<string, unknown> = { type: 'string' };
  for (let level = 1; level < levels; level += 1)
    schema = { type: 'object', properties: { a: schema } };
  return { type: 'object', properties: { a: schema } };
}

const resource = {
  id: TRIGGER,
  name: 'on-ringi-submitted',
  kind: 'webhook',
  agentId: AGENT,
  prompt: 'Review this request: {{body}}',
  cron: null,
  timezone: null,
  enabled: true,
  outputSchema: null,
  subject: null,
  ownerPrincipalId: OWNER,
  hasSecret: true,
  hasZoomSecretToken: false,
  lastFiredAt: null,
  createdAt: '2026-10-18T10:00:00.000Z',
  updatedAt: '2026-10-18T10:00:00.000Z',
};

describe('the trigger limits', () => {
  it('pins the numbers ADR-0144 decides', () => {
    expect(TRIGGER_MAX_BODY_BYTES).toBe(262_144);
    expect(TRIGGER_RATE_PER_MINUTE).toBe(30);
    expect(TRIGGER_MAX_CONCURRENT_RUNS).toBe(3);
  });

  it('answers every refusal under a status the ingress documents', () => {
    expect(TRIGGER_PROBLEM_CODES.trigger_not_found).toBe(404);
    expect(TRIGGER_PROBLEM_CODES.trigger_owner_not_allowed).toBe(403);
    expect(TRIGGER_PROBLEM_CODES.trigger_subject_not_allowed).toBe(403);
    expect(TRIGGER_PROBLEM_CODES.trigger_rate_limited).toBe(429);
    expect(TRIGGER_PROBLEM_CODES.trigger_concurrency_limited).toBe(429);
    expect(TRIGGER_PROBLEM_CODES.trigger_body_too_large).toBe(413);
  });
});

describe('the prompt template', () => {
  it('accepts text without a substitution and the {{body}} placeholder', () => {
    expect(findTriggerTemplateError('Summarise the inbox.')).toBeNull();
    expect(findTriggerTemplateError('Payload:\n{{body}}\n--\n{{body}}')).toBeNull();
  });

  it.each(['{{other}}', '{{ body }}', '{{}}', 'a {{body}} b {{user.name}}', '{{body}} {{\nbody}}'])(
    'refuses %j',
    (template) => {
      expect(findTriggerTemplateError(template)).toContain('is not a substitution');
    },
  );

  it('substitutes the body verbatim, including text that looks like a replacement pattern', () => {
    expect(renderTriggerPrompt('A {{body}} B', "$& $1 $` $' {{body}}")).toBe(
      "A $& $1 $` $' {{body}} B",
    );
    expect(renderTriggerPrompt('no placeholder', 'ignored')).toBe('no placeholder');
    expect(renderTriggerPrompt('{{body}}|{{body}}', 'x')).toBe('x|x');
  });
});

describe('TriggerResourceSchema', () => {
  it('accepts a trigger and refuses unknown keys, including a secret', () => {
    expect(TriggerResourceSchema.safeParse(resource).success).toBe(true);
    expect(
      TriggerResourceSchema.safeParse({ ...resource, secretHash: 'a'.repeat(64) }).success,
    ).toBe(false);
    expect(TriggerListResponseSchema.safeParse({ triggers: [resource] }).success).toBe(true);
  });

  it('refuses an id that is not a UUID', () => {
    expect(TriggerResourceSchema.safeParse({ ...resource, id: 'abc' }).success).toBe(false);
  });

  it('renders the output schema or null, and refuses a resource without the key', () => {
    expect(TriggerResourceSchema.safeParse({ ...resource, outputSchema: SCHEMA }).success).toBe(
      true,
    );
    const without = Object.fromEntries(
      Object.entries(resource).filter(([key]) => key !== 'outputSchema'),
    );
    expect(TriggerResourceSchema.safeParse(without).success).toBe(false);
  });
});

describe('the trigger subject', () => {
  const webhook = { kind: 'webhook', name: 'inbox', agentId: AGENT, prompt: 'Read {{body}}' };

  it('renders the subject or null, and refuses a resource without the key or an empty one', () => {
    expect(TriggerResourceSchema.safeParse({ ...resource, subject: 'alice' }).success).toBe(true);
    const without = Object.fromEntries(
      Object.entries(resource).filter(([key]) => key !== 'subject'),
    );
    expect(TriggerResourceSchema.safeParse(without).success).toBe(false);
    expect(TriggerResourceSchema.safeParse({ ...resource, subject: '' }).success).toBe(false);
  });

  it('accepts 1 to 256 characters on create and refuses an empty, an oversized and a null one', () => {
    for (const subject of ['a', 'a'.repeat(256)])
      expect(CreateTriggerRequestSchema.safeParse({ ...webhook, subject }).success).toBe(true);
    for (const subject of ['', 'a'.repeat(257), null])
      expect(CreateTriggerRequestSchema.safeParse({ ...webhook, subject }).success).toBe(false);
  });

  it('is accepted on a schedule trigger too', () => {
    expect(
      CreateTriggerRequestSchema.safeParse({
        kind: 'schedule',
        name: 'nightly',
        agentId: AGENT,
        prompt: 'Run.',
        cron: '0 3 * * *',
        timezone: 'UTC',
        subject: 'planner',
      }).success,
    ).toBe(true);
  });

  it('replaces on update, clears with null, and is a field of its own for the empty-patch rule', () => {
    expect(UpdateTriggerRequestSchema.safeParse({ subject: 'bob' }).success).toBe(true);
    expect(UpdateTriggerRequestSchema.safeParse({ subject: null }).success).toBe(true);
    expect(UpdateTriggerRequestSchema.safeParse({ subject: '' }).success).toBe(false);
    expect(UpdateTriggerRequestSchema.safeParse({ subject: 'a'.repeat(257) }).success).toBe(false);
    expect(UpdateTriggerRequestSchema.safeParse({ subject: 'a', extra: 1 }).success).toBe(false);
  });
});

describe('CreateTriggerRequestSchema', () => {
  const webhook = { kind: 'webhook', name: 'inbox', agentId: AGENT, prompt: 'Read {{body}}' };

  it('accepts a webhook with optional enabled and zoomSecretToken', () => {
    expect(CreateTriggerRequestSchema.safeParse(webhook).success).toBe(true);
    expect(
      CreateTriggerRequestSchema.safeParse({
        ...webhook,
        enabled: false,
        zoomSecretToken: 'zoom-token',
      }).success,
    ).toBe(true);
  });

  it('accepts a schedule with cron and timezone', () => {
    const parsed = CreateTriggerRequestSchema.safeParse({
      kind: 'schedule',
      name: 'nightly',
      agentId: AGENT,
      prompt: 'Run the nightly job.',
      cron: '0 3 * * *',
      timezone: 'Asia/Tokyo',
    });
    expect(parsed.success).toBe(true);
  });

  it('refuses unknown keys and keys of the other kind', () => {
    expect(CreateTriggerRequestSchema.safeParse({ ...webhook, extra: 1 }).success).toBe(false);
    expect(CreateTriggerRequestSchema.safeParse({ ...webhook, cron: '* * * * *' }).success).toBe(
      false,
    );
    expect(
      CreateTriggerRequestSchema.safeParse({
        kind: 'schedule',
        name: 'nightly',
        agentId: AGENT,
        prompt: 'x',
        cron: '0 3 * * *',
        timezone: 'UTC',
        zoomSecretToken: 'nope',
      }).success,
    ).toBe(false);
  });

  it('refuses a schedule without its cron, an unknown kind, a bad name and a bad agent id', () => {
    expect(CreateTriggerRequestSchema.safeParse({ ...webhook, kind: 'schedule' }).success).toBe(
      false,
    );
    expect(CreateTriggerRequestSchema.safeParse({ ...webhook, kind: 'poll' }).success).toBe(false);
    expect(CreateTriggerRequestSchema.safeParse({ ...webhook, name: 'Not Kebab' }).success).toBe(
      false,
    );
    expect(CreateTriggerRequestSchema.safeParse({ ...webhook, agentId: 'x' }).success).toBe(false);
  });

  it('accepts an output schema on either kind and refuses null on create', () => {
    expect(CreateTriggerRequestSchema.safeParse({ ...webhook, outputSchema: SCHEMA }).success).toBe(
      true,
    );
    expect(
      CreateTriggerRequestSchema.safeParse({
        kind: 'schedule',
        name: 'nightly',
        agentId: AGENT,
        prompt: 'Run.',
        cron: '0 3 * * *',
        timezone: 'UTC',
        outputSchema: SCHEMA,
      }).success,
    ).toBe(true);
    expect(CreateTriggerRequestSchema.safeParse({ ...webhook, outputSchema: null }).success).toBe(
      false,
    );
  });

  it.each([
    ['root_type', { type: 'string' }],
    ['size', { type: 'object', description: 'x'.repeat(40_000) }],
    ['dialect', { type: 'object', $schema: 'http://json-schema.org/draft-07/schema#' }],
    ['ref', { type: 'object', properties: { a: { $ref: 'https://example.com/a.json' } } }],
    ['depth', nested(OUTPUT_SCHEMA_MAX_DEPTH + 1)],
  ])('refuses an output schema that breaks the %s limit, naming it', (limit, outputSchema) => {
    const parsed = CreateTriggerRequestSchema.safeParse({ ...webhook, outputSchema });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.message).toMatch(new RegExp(`^${limit}:`, 'u'));
  });

  it('refuses a template with a substitution other than {{body}}, naming it', () => {
    const parsed = CreateTriggerRequestSchema.safeParse({ ...webhook, prompt: 'Hi {{user}}' });
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.error?.issues)).toContain('{{user}}');
  });

  it('bounds the prompt to MAX_PROMPT_CHARS and refuses an empty one', () => {
    expect(
      CreateTriggerRequestSchema.safeParse({ ...webhook, prompt: 'a'.repeat(MAX_PROMPT_CHARS) })
        .success,
    ).toBe(true);
    expect(
      CreateTriggerRequestSchema.safeParse({ ...webhook, prompt: 'a'.repeat(MAX_PROMPT_CHARS + 1) })
        .success,
    ).toBe(false);
    expect(CreateTriggerRequestSchema.safeParse({ ...webhook, prompt: '' }).success).toBe(false);
  });
});

describe('UpdateTriggerRequestSchema', () => {
  it('accepts any one field and null to clear the Zoom token', () => {
    expect(UpdateTriggerRequestSchema.safeParse({ enabled: false }).success).toBe(true);
    expect(UpdateTriggerRequestSchema.safeParse({ zoomSecretToken: null }).success).toBe(true);
    expect(UpdateTriggerRequestSchema.safeParse({ prompt: 'new {{body}}' }).success).toBe(true);
  });

  it('replaces the output schema with an object and clears it with null', () => {
    expect(UpdateTriggerRequestSchema.safeParse({ outputSchema: SCHEMA }).success).toBe(true);
    expect(UpdateTriggerRequestSchema.safeParse({ outputSchema: null }).success).toBe(true);
    expect(UpdateTriggerRequestSchema.safeParse({ outputSchema: { type: 'array' } }).success).toBe(
      false,
    );
  });

  it('refuses an empty patch, unknown keys and a bad template', () => {
    expect(UpdateTriggerRequestSchema.safeParse({}).success).toBe(false);
    expect(UpdateTriggerRequestSchema.safeParse({ kind: 'schedule' }).success).toBe(false);
    expect(UpdateTriggerRequestSchema.safeParse({ prompt: '{{x}}' }).success).toBe(false);
  });
});

describe('the secret and handshake responses', () => {
  it('shows the secret once, with the path to call', () => {
    const parsed = TriggerSecretResponseSchema.safeParse({
      trigger: resource,
      secret: 'tsk_abc',
      firePath: `/api/triggers/${TRIGGER}/fire/tsk_abc`,
      warning: 'shown once',
    });
    expect(parsed.success).toBe(true);
  });

  it('answers a schedule creation with the trigger alone and a webhook with its secret', () => {
    expect(CreateTriggerResponseSchema.safeParse({ trigger: resource }).success).toBe(true);
    expect(
      CreateTriggerResponseSchema.safeParse({
        trigger: resource,
        secret: 'tsk_abc',
        firePath: `/api/triggers/${TRIGGER}/fire/tsk_abc`,
        warning: 'shown once',
      }).success,
    ).toBe(true);
    expect(
      CreateTriggerResponseSchema.safeParse({ trigger: resource, secret: 'tsk_abc' }).success,
    ).toBe(false);
  });

  it('reads Zoom url validation and its answer', () => {
    expect(
      ZoomUrlValidationEventSchema.safeParse({
        event: 'endpoint.url_validation',
        payload: { plainToken: 'abc' },
        event_ts: 1,
      }).success,
    ).toBe(true);
    expect(
      ZoomUrlValidationEventSchema.safeParse({ event: 'meeting.ended', payload: {} }).success,
    ).toBe(false);
    expect(
      ZoomUrlValidationResponseSchema.safeParse({ plainToken: 'abc', encryptedToken: 'def' })
        .success,
    ).toBe(true);
  });
});
