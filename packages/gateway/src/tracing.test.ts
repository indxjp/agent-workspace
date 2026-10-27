import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createJsonLogger } from '@agent-workspace/core/telemetry';
import { SpanKind, startTracing, type Tracing } from '@agent-workspace/core/tracing';

import { createRouter } from './router.js';
import { adoptTrace, fetchInSpan } from './server.js';
import type { ModelProvider, RequestContext } from './types.js';

type Exporter = NonNullable<Parameters<typeof startTracing>[3]>;
const spans: Parameters<Exporter['export']>[0][number][] = [];
const exporter: Exporter = {
  export: (batch, done) => {
    spans.push(...batch);
    done({ code: 0 });
  },
  shutdown: () => Promise.resolve(),
};

const SECRET = 'sk-ant-span-test-0123456789abcdefghijklmnop';
const PROMPT = 'the prompt text that must stay out of traces';

const provider = {
  id: 'anthropic',
  capabilities: {},
  listModels: () => Promise.resolve([]),
  createMessage: () => Promise.resolve(Response.json({ content: 'the model reply' })),
} as unknown as ModelProvider;

const context: RequestContext = {
  providerId: 'anthropic',
  credential: SECRET,
  requestId: 'tracing-test-request',
  settings: {},
};

function message(traceparent?: string, model = 'stub-model'): Request {
  const headers = new Headers({
    'content-type': 'application/json',
    authorization: `Bearer ${SECRET}`,
    ...(traceparent === undefined ? {} : { traceparent }),
  });
  const traceId = adoptTrace(headers);
  const request = new Request(`http://gateway.invalid/v1/messages?key=${SECRET}`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ model, messages: [{ role: 'user', content: PROMPT }] }),
  });
  expect(traceId).toMatch(/^[0-9a-f]{32}$/u);
  return request;
}

const log = createJsonLogger({ service: 'gateway', write: () => undefined });
let tracing: Tracing | null = null;
beforeAll(async () => {
  tracing = await startTracing(
    'gateway',
    { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://otel' },
    log,
    exporter,
  );
});
afterAll(() => tracing?.shutdown());

describe('gateway spans (ADR-0155)', () => {
  it('records the request and its model call in the adopted trace, without sensitive values', async () => {
    const callerTrace = '0af7651916cd43dd8448eb211c80319c';
    const router = createRouter([provider]);
    const fresh = message();
    const freshTrace = fresh.headers.get('traceparent')?.split('-')[1];

    expect(
      (await fetchInSpan(router, message(`00-${callerTrace}-b7ad6b7169203331-01`), context)).status,
    ).toBe(200);
    expect((await fetchInSpan(router, fresh, context)).status).toBe(200);
    // A model name that echoes the run's credential, even a short one, is masked.
    const short = { ...context, credential: 'cred-7' };
    expect((await fetchInSpan(router, message(undefined, 'model-cred-7'), short)).status).toBe(200);
    await tracing?.shutdown();
    tracing = null;

    const server = spans.filter((span) => span.kind === SpanKind.SERVER);
    expect(server.slice(0, 2).map((span) => span.spanContext().traceId)).toEqual([
      callerTrace,
      freshTrace,
    ]);
    expect(server[0]?.name).toBe('POST /v1/messages');
    expect(server[0]?.attributes).toEqual({
      'http.request.method': 'POST',
      'http.route': '/v1/messages',
      'http.response.status_code': 200,
    });

    const models = spans.filter((span) => span.kind === SpanKind.CLIENT);
    expect(models.at(-1)?.attributes['gen_ai.request.model']).toBe('model-[redacted]');
    const model = models[0];
    expect(model?.parentSpanContext?.spanId).toBe(server[0]?.spanContext().spanId);
    expect(model?.spanContext().traceId).toBe(callerTrace);
    expect(model?.attributes).toEqual({
      'gen_ai.operation.name': 'chat',
      'gen_ai.provider.name': 'anthropic',
      'gen_ai.request.model': 'stub-model',
      'http.response.status_code': 200,
    });

    const exported = JSON.stringify(spans.map((span) => [span.name, span.attributes, span.events]));
    for (const value of [SECRET, PROMPT, 'the model reply', 'gateway.invalid', 'Bearer']) {
      expect(exported).not.toContain(value);
    }
  });
});
