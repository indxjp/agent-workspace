import { createJsonLogger } from '@agent-workspace/core/telemetry';
import { SpanKind, startTracing } from '@agent-workspace/core/tracing';
import { describe, expect, it } from 'vitest';
import { fakeConnection, runRequestBody } from './server-fixture.test-support.js';
import { createRunnerServer } from './server.js';

export function registerTraceForwardingTests(): void {
  describe('trace forwarding to the model gateway (F-04)', () => {
    const TRACEPARENT = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';

    /** The `env` the engine was started with for one `POST /run` carrying `headers`. */
    async function engineEnv(
      headers: Readonly<Record<string, string>>,
      env: Readonly<Record<string, string>> = {},
    ): Promise<Readonly<Record<string, string>>> {
      let started: Readonly<Record<string, string>> | undefined;
      const server = createRunnerServer({
        startAgent: (request) => {
          started = request.env;
          return Promise.resolve({ ok: true, connection: fakeConnection([]) });
        },
        logger: createJsonLogger({ service: 'runner', write: () => undefined }),
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      if (address === null || typeof address === 'string') throw new Error('no address');
      try {
        const body = {
          ...(runRequestBody(
            '77777777-7777-4777-8777-777777777777',
            '88888888-8888-4888-8888-888888888888',
          ) as Record<string, unknown>),
          env,
        };
        const response = await fetch(`http://127.0.0.1:${String(address.port)}/run`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...headers },
          body: JSON.stringify(body),
        });
        await response.text();
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
      if (started === undefined) throw new Error('the engine was not started');
      return started;
    }

    it("hands the engine the caller's traceparent and tracestate for its gateway calls", async () => {
      const env = await engineEnv({ traceparent: TRACEPARENT, tracestate: 'aw=1' });
      expect(env['ANTHROPIC_CUSTOM_HEADERS']).toBe(`traceparent: ${TRACEPARENT}\ntracestate: aw=1`);
    });

    it('keeps custom headers the run already sets', async () => {
      const env = await engineEnv(
        { traceparent: TRACEPARENT },
        { ANTHROPIC_CUSTOM_HEADERS: 'x-team: core' },
      );
      expect(env['ANTHROPIC_CUSTOM_HEADERS']).toBe(`x-team: core\ntraceparent: ${TRACEPARENT}`);
    });

    it('extends a differently cased custom-headers key instead of adding a second one', async () => {
      const env = await engineEnv(
        { traceparent: TRACEPARENT },
        { anthropic_custom_headers: 'x-team: core' },
      );
      expect(env).toEqual({
        anthropic_custom_headers: `x-team: core\ntraceparent: ${TRACEPARENT}`,
      });
    });

    it.each([
      ['absent', {}],
      ['malformed', { traceparent: 'not-a-traceparent', tracestate: 'aw=1' }],
    ])('forwards nothing for an %s traceparent', async (_name, headers) => {
      expect(await engineEnv(headers)).toEqual({});
    });

    it('records a server span in the adopted trace and hands the engine that span as parent', async () => {
      type Exporter = NonNullable<Parameters<typeof startTracing>[3]>;
      const spans: Parameters<Exporter['export']>[0][number][] = [];
      const exporter: Exporter = {
        export: (batch, done) => {
          spans.push(...batch);
          done({ code: 0 });
        },
        shutdown: () => Promise.resolve(),
      };
      const tracing = await startTracing(
        'runner',
        { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://otel' },
        createJsonLogger({ service: 'runner', write: () => undefined }),
        exporter,
      );
      let env: Readonly<Record<string, string>>;
      try {
        env = await engineEnv({
          traceparent: TRACEPARENT,
          authorization: 'Bearer not-a-span-attribute',
        });
      } finally {
        await tracing?.shutdown();
      }

      expect(spans).toHaveLength(1);
      const [span] = spans;
      expect(span?.kind).toBe(SpanKind.SERVER);
      expect(span?.name).toBe('POST /run');
      expect(span?.spanContext().traceId).toBe('4bf92f3577b34da6a3ce929d0e0e4736');
      expect(span?.parentSpanContext?.spanId).toBe('00f067aa0ba902b7');
      expect(span?.attributes).toEqual({
        'http.request.method': 'POST',
        'http.route': '/run',
        'http.response.status_code': 200,
      });
      expect(env['ANTHROPIC_CUSTOM_HEADERS']).toContain(
        `traceparent: 00-4bf92f3577b34da6a3ce929d0e0e4736-${span?.spanContext().spanId ?? ''}-01`,
      );
      expect(JSON.stringify([span?.attributes, span?.events])).not.toContain(
        'not-a-span-attribute',
      );
    });
  });
}
