import { expect, it } from 'vitest';
import { z } from 'zod';
import { ApiProblemError, InvalidArgumentError } from '../errors.js';

import { jsonResponse as json } from '../testing.js';

import { AGENT, RUN, run, client } from './runs.fixture.test-support.js';

it('posts the wire body the route parses and reads the 202', async () => {
  const { runs, calls } = client(() =>
    json(202, { run: run('queued'), events: `/api/runs/${RUN}/events` }),
  );
  const started = await runs.start(AGENT, {
    prompt: 'Hello',
    modelOverride: { connectionId: '22222222-2222-4222-8222-222222222222', model: 'm' },
  });
  expect(started.run.status).toBe('queued');
  expect(started.events).toBe(`/api/runs/${RUN}/events`);
  const [call] = calls;
  expect(call?.url.pathname).toBe(`/api/agents/${AGENT}/runs`);
  expect(call?.json).toEqual({
    prompt: 'Hello',
    sessionId: null,
    modelConnectionId: '22222222-2222-4222-8222-222222222222',
    model: 'm',
  });
});

it('sends the version a run is targeted at, and only then (issue #697)', async () => {
  const { runs, calls } = client(() =>
    json(202, { run: run('queued'), events: `/api/runs/${RUN}/events` }),
  );
  await runs.start(AGENT, { prompt: 'Hello', version: 3 });
  await runs.start(AGENT, { prompt: 'Hello' });
  expect(calls[0]?.json).toMatchObject({ version: 3 });
  expect(calls[1]?.json).not.toHaveProperty('version');
});

it('sends the subject a run acts for, and only when given (ADR-0142 D2)', async () => {
  const { runs, calls } = client(() =>
    json(202, { run: run('queued'), events: `/api/runs/${RUN}/events` }),
  );
  await runs.start(AGENT, { prompt: 'Hello', subject: 'customer-17' });
  await runs.start(AGENT, { prompt: 'Hello' });
  expect(calls[0]?.json).toMatchObject({ subject: 'customer-17' });
  expect(calls[1]?.json).not.toHaveProperty('subject');
});

it('sends the file scope a run is narrowed to, and only when given (issue #1539)', async () => {
  const { runs, calls } = client(() =>
    json(202, { run: run('queued'), events: `/api/runs/${RUN}/events` }),
  );
  await runs.start(AGENT, { prompt: 'Hello', fileScope: ['docs/alice', 'docs/b.md'] });
  await runs.start(AGENT, { prompt: 'Hello' });
  expect(calls[0]?.json).toMatchObject({ fileScope: ['docs/alice', 'docs/b.md'] });
  expect(calls[1]?.json).not.toHaveProperty('fileScope');
});

it('sends the spend ceiling a run is narrowed to, and only when given (ADR-0162)', async () => {
  const { runs, calls } = client(() =>
    json(202, { run: run('queued'), events: `/api/runs/${RUN}/events` }),
  );
  await runs.start(AGENT, { prompt: 'Hello', spendCeilingUsd: 0.25 });
  await runs.start(AGENT, { prompt: 'Hello' });
  expect(calls[0]?.json).toMatchObject({ spendCeilingUsd: 0.25 });
  expect(calls[1]?.json).not.toHaveProperty('spendCeilingUsd');
});

it('sends idempotencyKey as the Idempotency-Key header, not in the body, and only when given (ADR-0151)', async () => {
  const { runs, calls } = client(() =>
    json(202, { run: run('queued'), events: `/api/runs/${RUN}/events` }),
  );
  await runs.start(AGENT, { prompt: 'Hello', idempotencyKey: 'order-17-reply' });
  await runs.start(AGENT, { prompt: 'Hello' });
  expect(calls[0]?.headers.get('idempotency-key')).toBe('order-17-reply');
  expect(calls[0]?.json).not.toHaveProperty('idempotencyKey');
  expect(calls[1]?.headers.has('idempotency-key')).toBe(false);
});

it('surfaces run_idempotency_conflict (409) by code (ADR-0151)', async () => {
  const { runs } = client(() =>
    json(409, { error: { code: 'run_idempotency_conflict', message: 'send a new key' } }),
  );
  const failure = await runs
    .start(AGENT, { prompt: 'x', idempotencyKey: 'k' })
    .catch((e: unknown) => e);
  expect(failure).toBeInstanceOf(ApiProblemError);
  expect((failure as ApiProblemError).code).toBe('run_idempotency_conflict');
});

it('surfaces run_subject_forbidden (403) by code (ADR-0142 D2)', async () => {
  const { runs } = client(() =>
    json(403, { error: { code: 'run_subject_forbidden', message: 'only an API key' } }),
  );
  const failure = await runs.start(AGENT, { prompt: 'x', subject: 'a' }).catch((e: unknown) => e);
  expect(failure).toBeInstanceOf(ApiProblemError);
  expect((failure as ApiProblemError).code).toBe('run_subject_forbidden');
});

it('sends attachments as file ids, and only when given (issue #1307)', async () => {
  const { runs, calls } = client(() =>
    json(202, { run: run('queued'), events: `/api/runs/${RUN}/events` }),
  );
  await runs.start(AGENT, {
    prompt: 'Hello',
    attachments: [{ fileId: 'f-1' }, { fileId: 'f-2' }],
  });
  await runs.start(AGENT, { prompt: 'Hello' });
  expect(calls[0]?.json).toMatchObject({ attachments: [{ fileId: 'f-1' }, { fileId: 'f-2' }] });
  expect(calls[1]?.json).not.toHaveProperty('attachments');
});

it.each([
  [404, 'file_not_found'],
  [422, 'run_attachments_unreadable'],
  [422, 'run_attachments_too_large'],
  [422, 'run_attachments_unsupported_runtime'],
  [422, 'run_attachments_untranscribable'],
])('surfaces the %i attachment refusal by code (issue #1307)', async (status, code) => {
  const { runs } = client(() => json(status, { error: { code, message: 'refused' } }));
  const failure = await runs
    .start(AGENT, { prompt: 'x', attachments: [{ fileId: 'f-1' }] })
    .catch((e: unknown) => e);
  expect((failure as ApiProblemError).code).toBe(code);
});

it('sends a Zod outputSchema as JSON Schema 2020-12, and a JSON Schema as it is (ADR-0143)', async () => {
  const { runs, calls } = client(() =>
    json(202, { run: run('queued'), events: `/api/runs/${RUN}/events` }),
  );
  await runs.start(AGENT, {
    prompt: 'Hello',
    outputSchema: z.object({ verdict: z.string() }),
  });
  const plain = { type: 'object', properties: { n: { type: 'number' } } };
  await runs.start(AGENT, { prompt: 'Hello', outputSchema: plain });
  await runs.start(AGENT, { prompt: 'Hello' });
  expect(calls[0]?.json).toMatchObject({
    outputSchema: {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      properties: { verdict: { type: 'string' } },
      required: ['verdict'],
    },
  });
  expect(calls[1]?.json).toMatchObject({ outputSchema: plain });
  expect(calls[2]?.json).not.toHaveProperty('outputSchema');
});

it('refuses a Zod schema with no JSON Schema form as InvalidArgumentError, keeping the cause', async () => {
  const { runs, calls } = client(() => json(202, { run: run('queued'), events: '' }));
  const refusal: unknown = await runs
    .start(AGENT, { prompt: 'x', outputSchema: z.object({ d: z.date() }) })
    .catch((error: unknown) => error);
  expect(refusal).toBeInstanceOf(InvalidArgumentError);
  expect(refusal).toMatchObject({ code: 'unconvertible_output_schema', value: null });
  expect((refusal as Error).cause).toBeInstanceOf(Error);
  expect(calls).toHaveLength(0);
});

it('surfaces engine_capability_unsupported (422) with its capability (ADR-0143)', async () => {
  const { runs } = client(() =>
    json(422, {
      error: {
        code: 'engine_capability_unsupported',
        message: 'no structured output',
        details: ['structuredOutput'],
      },
    }),
  );
  const failure = await runs
    .start(AGENT, { prompt: 'x', outputSchema: { type: 'object' } })
    .catch((e: unknown) => e);
  expect((failure as ApiProblemError).code).toBe('engine_capability_unsupported');
  expect((failure as ApiProblemError).details).toEqual(['structuredOutput']);
});

it('surfaces agent_version_not_found (404) by code (issue #697)', async () => {
  const { runs } = client(() =>
    json(404, { error: { code: 'agent_version_not_found', message: 'no version 9' } }),
  );
  const failure = await runs.start(AGENT, { prompt: 'x', version: 9 }).catch((e: unknown) => e);
  expect((failure as ApiProblemError).code).toBe('agent_version_not_found');
});

it('surfaces the route refusal by code', async () => {
  const { runs } = client(() =>
    json(409, { error: { code: 'session_not_usable', message: 'omit sessionId' } }),
  );
  const failure = await runs.start(AGENT, { prompt: 'x', sessionId: RUN }).catch((e: unknown) => e);
  expect(failure).toBeInstanceOf(ApiProblemError);
  expect((failure as ApiProblemError).code).toBe('session_not_usable');
});

it('surfaces session_engine_mismatch (409) by code, apart from session_not_usable (ADR-0065)', async () => {
  // Both are 409s on the same call, and a caller acts differently on each: `session_not_usable`
  // means "omit sessionId and this will work", while a pinned session means the *agent's* engine
  // changed. Branching on `status` alone would conflate them, which is why the code is asserted.
  const { runs } = client(() =>
    json(409, {
      error: {
        code: 'session_engine_mismatch',
        message:
          "this session runs on the engine 'claude-agent-sdk' and the agent's policy now names 'pi'.",
      },
    }),
  );
  const failure = await runs.start(AGENT, { prompt: 'x', sessionId: RUN }).catch((e: unknown) => e);
  expect(failure).toBeInstanceOf(ApiProblemError);
  expect((failure as ApiProblemError).status).toBe(409);
  expect((failure as ApiProblemError).code).toBe('session_engine_mismatch');
});

it('surfaces agent_runtime_profile_missing (422) by code, before any run exists', async () => {
  const { runs } = client(() =>
    json(422, {
      error: {
        code: 'agent_runtime_profile_missing',
        message: 'agent "General" has no runtime profile.',
      },
    }),
  );
  const failure = await runs.start(AGENT, { prompt: 'x' }).catch((e: unknown) => e);
  expect(failure).toBeInstanceOf(ApiProblemError);
  expect((failure as ApiProblemError).status).toBe(422);
  expect((failure as ApiProblemError).code).toBe('agent_runtime_profile_missing');
});
